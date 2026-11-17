import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileSchema } from "../../src/schema/build.ts";
import { clientContract, type RelationFieldDef } from "../../src/schema/contract.ts";
import { SchemaError } from "../../src/schema/errors.ts";
import { generateClient } from "../../src/generator/client.ts";
import { contractToPhysical } from "../../src/migrate/contract-to-physical.ts";
import { diffSchemas } from "../../src/migrate/diff.ts";
import { renderSchema } from "../../src/introspect/render.ts";

const source = readFileSync(new URL("../fixtures/m2m.hana", import.meta.url), "utf8");
const rel = (model: { fields: readonly { name: string }[] }, name: string) => model.fields.find((f) => f.name === name) as RelationFieldDef;

test("two list fields without a foreign key side form an implicit many-to-many relation", () => {
  const c = compileSchema(source, { file: "m2m.hana" });
  const join = c.models._ArticleToCategory!;
  assert.equal(join.implicit, true);
  assert.equal(join.dbName, "_ArticleToCategory");
  assert.equal(join.schema, undefined);
  // A references the model whose name sorts first; the key types are copied
  const [a, b] = join.fields;
  assert.deepEqual([a!.name, a!.kind === "scalar" && a.type], ["A", "Int"]);
  assert.deepEqual([b!.name, b!.kind === "scalar" && b.type, b!.kind === "scalar" && b.nativeType], ["B", "String", { name: "NVarChar", args: [20] }]);
  assert.deepEqual(join.primaryKey, { name: "A_B", dbName: "PK__ArticleToCategory", fields: ["A", "B"] });
  assert.deepEqual(join.indexes, [{ dbName: "IX__ArticleToCategory_B", fields: ["B"] }]);

  const categories = rel(c.models.Article!, "categories");
  assert.deepEqual(
    { owner: categories.owner, list: categories.list, relationName: categories.relationName, local: categories.localFields, target: categories.targetFields },
    { owner: false, list: true, relationName: "ArticleToCategory", local: ["id"], target: ["id"] },
  );
  assert.deepEqual(categories.through, { model: "_ArticleToCategory", dbName: "_ArticleToCategory", localColumns: ["A"], targetColumns: ["B"] });
  assert.deepEqual(rel(c.models.Category!, "articles").through?.localColumns, ["B"]);
});

test("a self many-to-many relation uses the field name order for A and B", () => {
  const c = compileSchema(source, { file: "m2m.hana" });
  assert.ok(c.models._Follows);
  assert.deepEqual(rel(c.models.Member!, "followers").through?.localColumns, ["A"]);
  assert.deepEqual(rel(c.models.Member!, "following").through?.localColumns, ["B"]);
});

test("the join table gets cascading foreign keys and the client never sees it", () => {
  const c = compileSchema(source, { file: "m2m.hana" });
  const table = contractToPhysical(c).tables["_ArticleToCategory"]!;
  assert.deepEqual(
    table.foreignKeys.map((fk) => [fk.name, fk.columns, fk.refTable, fk.refColumns, fk.onDelete, fk.onUpdate]),
    [
      ["FK__ArticleToCategory_A", ["A"], "ARTICLES", ["id"], "CASCADE", "CASCADE"],
      ["FK__ArticleToCategory_B", ["B"], "Category", ["id"], "CASCADE", "CASCADE"],
    ],
  );
  assert.deepEqual(Object.keys(clientContract(c).models), ["Article", "Category", "Member"]);
  const generated = generateClient(c);
  assert.doesNotMatch(generated, /_ArticleToCategory\b(?!")/);
  assert.match(generated, /categories\?: \{ create\?: CategoryCreateInput \| CategoryCreateInput\[\]; connect\?/, "no createMany on many-to-many");
});

test("adding a many-to-many relation is a migration that only creates the join table", () => {
  const before = compileSchema(source.replace("  categories Category[]\n", "").replace("  articles Article[]\n", ""), { file: "a.hana" });
  const after = compileSchema(source, { file: "b.hana" });
  assert.notEqual(before.hash, after.hash);
  const ops = diffSchemas(contractToPhysical(before), contractToPhysical(after));
  assert.deepEqual(
    ops.map((o) => o.description),
    [`Create table "_ArticleToCategory"`, `Create index "IX__ArticleToCategory_B" on "_ArticleToCategory" ("B")`, `Add foreign key "FK__ArticleToCategory_A" on "_ArticleToCategory" ("A") → "ARTICLES"`, `Add foreign key "FK__ArticleToCategory_B" on "_ArticleToCategory" ("B") → "Category"`],
  );
});

test("db pull turns join tables back into many-to-many fields", () => {
  const c = compileSchema(source, { file: "m2m.hana" });
  const physical = contractToPhysical(c);
  const result = renderSchema(physical, { defaultSchema: "APP", existingSource: source, existingFile: "m2m.hana" });
  assert.doesNotMatch(result.source, /model _/);
  assert.deepEqual(result.warnings, []);
  // field names from the existing schema are kept, and the round trip gives the same tables
  assert.match(result.source, /categories +Category\[\]/);
  assert.match(result.source, /followers +Member\[\] +@relation\("Follows"\)/);
  assert.deepEqual(contractToPhysical(compileSchema(result.source, { file: "pulled.hana" })), physical);

  // without an existing schema: generated names, and @relation when the name is not the default
  const fresh = renderSchema(physical, { defaultSchema: "APP" });
  assert.match(fresh.source, /model Articles \{[^}]*categories +Category\[\] +@relation\("ArticleToCategory"\)/s);
  assert.match(fresh.source, /model Category \{[^}]*articles +Articles\[\] +@relation\("ArticleToCategory"\)/s);
  assert.match(fresh.source, /followsA +Member\[\] +@relation\("Follows"\)\n +followsB +Member\[\] +@relation\("Follows"\)/);
  assert.deepEqual(contractToPhysical(compileSchema(fresh.source, { file: "fresh.hana" })), physical);
});

test("db pull keeps a join-like table whose A column does not reference the first model as a model", () => {
  const physical = contractToPhysical(compileSchema(source, { file: "m2m.hana" }));
  const t = physical.tables["_ArticleToCategory"]!;
  // swap the roles of A and B
  t.foreignKeys = t.foreignKeys.map((fk) => ({ ...fk, columns: fk.columns[0] === "A" ? ["B"] : ["A"] }));
  const result = renderSchema(physical, { defaultSchema: "APP" });
  assert.match(result.source, /model ArticleToCategory \{/);
  assert.match(result.warnings.join("\n"), /looks like a many-to-many join table/);
});

test("many-to-many errors", () => {
  const errors = (src: string) => {
    try {
      compileSchema(src, { file: "x.hana" });
      return [];
    } catch (e) {
      assert.ok(e instanceof SchemaError);
      return e.diagnostics.map((d) => d.message);
    }
  };
  assert.match(
    errors(`model A { x Int\n y Int\n bs B[]\n @@id([x, y]) }\nmodel B { id Int @id\n as A[] }`).join("\n"),
    /needs a single-field @id on 'A'; use an explicit join model/,
  );
  assert.match(errors(`model A { id Int @id\n bs B[]\n cs B[] }\nmodel B { id Int @id\n as A[] }`).join("\n"), /ambiguous/);
  assert.match(errors(`model A { id Int @id\n bs B[] }\nmodel B { id Int @id }`).join("\n"), /has no matching side: .*for a many-to-many relation/);
  assert.match(errors(`model A { id Int @id\n bs B[] @relation("X", map: "J") }\nmodel B { id Int @id\n as A[] @relation("X") }`).join("\n"), /map: \.\.\.\) is not supported on implicit many-to-many/);
  // named relations pair by name
  assert.deepEqual(errors(`model A { id Int @id\n liked B[] @relation("Likes")\n saved B[] @relation("Saves") }\nmodel B { id Int @id\n likedBy A[] @relation("Likes")\n savedBy A[] @relation("Saves") }`), []);
});
