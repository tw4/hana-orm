import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileSchema } from "../../src/schema/build.ts";
import { SchemaError } from "../../src/schema/errors.ts";

const blog = readFileSync(new URL("../fixtures/blog.hana", import.meta.url), "utf8");

test("compiles the blog schema", () => {
  const c = compileSchema(blog, { file: "blog.hana" });
  assert.deepEqual(Object.keys(c.models), ["User", "Profile", "Post", "Tag", "PostTag"]);
  const user = c.models.User!;
  assert.equal(user.dbName, "USERS");
  assert.deepEqual(user.primaryKey, { name: "id", dbName: "PK_USERS", fields: ["id"] });
  assert.deepEqual(user.uniques.map((u) => u.name), ["email"]);
  const createdAt = user.fields.find((f) => f.name === "createdAt")!;
  assert.equal(createdAt.kind === "scalar" && createdAt.dbName, "CREATED_AT");
  const posts = user.fields.find((f) => f.name === "posts")!;
  assert.equal(posts.kind, "relation");
  if (posts.kind === "relation") {
    assert.equal(posts.owner, false);
    assert.deepEqual(posts.localFields, ["id"]);
    assert.deepEqual(posts.targetFields, ["authorId"]);
    assert.equal(posts.relationName, "PostToUser");
  }
  const author = c.models.Post!.fields.find((f) => f.name === "author")!;
  if (author.kind === "relation") {
    assert.equal(author.owner, true);
    assert.equal(author.fkName, "FK_Post_authorId");
  }
  assert.deepEqual(c.models.PostTag!.primaryKey?.fields, ["postId", "tagName"]);
  assert.equal(c.enums.Role!.values[1]!.dbName, "admin");
  assert.deepEqual(c.datasource.host, { env: "HANA_HOST" });
  assert.equal(c.datasource.schema, "APP");
  assert.match(c.hash, /^[0-9a-f]{64}$/);
});

test("hash is stable and ignores comments and generator changes", () => {
  const a = compileSchema(blog).hash;
  const b = compileSchema(blog.replace('output   = "./generated"', 'output = "./other"').replace("/// A registered user", "/// changed")).hash;
  assert.equal(a, b);
  const c = compileSchema(blog.replace("name      String?", "name      String")).hash;
  assert.notEqual(a, c);
});

function errors(src: string): string {
  try {
    compileSchema(src, { file: "s.hana" });
  } catch (e) {
    assert.ok(e instanceof SchemaError);
    return e.message;
  }
  assert.fail("expected SchemaError");
}

test("reports errors with positions", () => {
  assert.match(errors("model A {\n  id Int @id\n  x Strin\n}"), /s\.hana:3:3 - Unknown type 'Strin'/);
  assert.match(errors("model A {\n  id Int @id\n  b B\n}\nmodel B {\n  id Int @id\n}"), /no matching side/);
  assert.match(errors("model A {\n  id Int @id @default(now())\n}"), /now\(\) is only valid/);
  assert.match(errors("model A {\n  id Int @id\n  tags String[]\n}"), /Scalar lists are not supported/);
  assert.match(errors("model A {\n  id Int @id\n  x Int @map(\"ID\")\n  y Int @map(\"ID\")\n}"), /same column/);
  assert.match(errors("model A {\n  id Int @id\n  @@foo\n}"), /Unknown block attribute '@@foo'/);
  assert.match(errors("model A {\n  id Int @id\n"), /Missing '}'/);
});

test("requires matching optionality on foreign keys", () => {
  const src = `model U {\n id Int @id\n p P[]\n}\nmodel P {\n id Int @id\n uId Int?\n u U @relation(fields: [uId], references: [id])\n}`;
  assert.match(errors(src), /is required but a foreign key field is optional/);
});

test("disambiguates multiple relations by name", () => {
  const src = `model U {
  id Int @id
  written P[] @relation("Writer")
  edited  P[] @relation("Editor")
}
model P {
  id Int @id
  wId Int
  eId Int
  writer U @relation("Writer", fields: [wId], references: [id])
  editor U @relation("Editor", fields: [eId], references: [id])
}`;
  const c = compileSchema(src);
  const edited = c.models.U!.fields.find((f) => f.name === "edited")!;
  assert.ok(edited.kind === "relation" && edited.targetFields[0] === "eId");
});
