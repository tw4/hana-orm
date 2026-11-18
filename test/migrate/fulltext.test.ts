/** Full-text indexes and the `search` filter (issue #10). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSchema } from "../../src/schema/build.ts";
import { SchemaError } from "../../src/schema/errors.ts";
import { formatSchema } from "../../src/schema/format.ts";
import { contractToPhysical } from "../../src/migrate/contract-to-physical.ts";
import { diffSchemas, emptyRenames } from "../../src/migrate/diff.ts";
import { clonePhysical } from "../../src/migrate/physical.ts";
import { buildPhysicalFromCatalog } from "../../src/introspect/catalog.ts";
import type { CatalogRows } from "../../src/introspect/catalog.ts";
import { renderSchema } from "../../src/introspect/render.ts";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "../runtime/fake-driver.ts";

const SRC = `model Article {
  id    Int     @id
  title String  @map("TITLE")
  body  String? @map("BODY") @db.NClob
  views Int     @default(0)

  @@fulltext([title, body])
  @@map("ARTICLES")
}
`;

const physical = (src = SRC) => contractToPhysical(compileSchema(src));

function schemaError(src: string): string {
  try {
    compileSchema(src);
  } catch (e) {
    if (e instanceof SchemaError) return e.message;
    throw e;
  }
  assert.fail("expected a schema error");
}

test("@@fulltext creates one index per column with default names", () => {
  const m = compileSchema(SRC).models.Article!;
  assert.deepEqual(m.fulltext, [
    { dbName: "FTI_ARTICLES_TITLE", field: "title" },
    { dbName: "FTI_ARTICLES_BODY", field: "body" },
  ]);
  assert.deepEqual(physical().tables.ARTICLES!.fulltext, [
    { name: "FTI_ARTICLES_TITLE", column: "TITLE" },
    { name: "FTI_ARTICLES_BODY", column: "BODY" },
  ]);
  const named = compileSchema(SRC.replace("@@fulltext([title, body])", '@@fulltext([title], map: "FT_T")'));
  assert.deepEqual(named.models.Article!.fulltext, [{ dbName: "FT_T", field: "title" }]);
});

test("@@fulltext errors", () => {
  assert.match(schemaError(SRC.replace("@@fulltext([title, body])", "@@fulltext([views])")), /@@fulltext field 'views' of 'Article' must be a String field/);
  assert.match(schemaError(SRC.replace("@@fulltext([title, body])", '@@fulltext([title, body], map: "X")')), /takes one field/);
  assert.match(schemaError(SRC.replace("@@fulltext([title, body])", "@@fulltext([title])\n  @@fulltext([title])")), /more than one @@fulltext index/);
  assert.match(schemaError(SRC.replace("@@fulltext([title, body])", "@@fulltext([nope])")), /Unknown field 'nope'/);
});

test("the formatter orders @@fulltext after @@index", () => {
  const out = formatSchema('model A {\n  id Int @id\n  t String\n  @@map("A")\n  @@fulltext([t])\n  @@index([t])\n}\n');
  assert.match(out, /@@index\(\[t\]\)\n  @@fulltext\(\[t\]\)\n  @@map\("A"\)/);
});

test("diff creates, drops and re-creates full-text indexes", () => {
  const created = diffSchemas({ tables: {} }, physical());
  assert.deepEqual(
    created.filter((o) => o.kind === "createFulltextIndex").map((o) => o.sql[0]),
    ['CREATE FULLTEXT INDEX "FTI_ARTICLES_BODY" ON "ARTICLES" ("BODY")', 'CREATE FULLTEXT INDEX "FTI_ARTICLES_TITLE" ON "ARTICLES" ("TITLE")'],
  );
  assert.ok(created.findIndex((o) => o.kind === "createTable") < created.findIndex((o) => o.kind === "createFulltextIndex"));
  assert.deepEqual(diffSchemas(physical(), physical()), []);

  const to = clonePhysical(physical());
  to.tables.ARTICLES!.fulltext = [{ name: "FT_TITLE", column: "TITLE" }];
  assert.deepEqual(
    diffSchemas(physical(), to).map((o) => o.sql[0]),
    ['DROP FULLTEXT INDEX "FTI_ARTICLES_BODY"', 'DROP FULLTEXT INDEX "FTI_ARTICLES_TITLE"', 'CREATE FULLTEXT INDEX "FT_TITLE" ON "ARTICLES" ("TITLE")'],
  );
});

test("a renamed column keeps its full-text index", () => {
  const from = physical();
  const to = physical(SRC.replace('@map("TITLE")', '@map("HEADLINE")'));
  const renames = emptyRenames();
  renames.columns.ARTICLES = { TITLE: "HEADLINE" };
  // the index name follows the column in the schema, so it is re-created under the new name
  const ops = diffSchemas(from, to, { renames });
  assert.deepEqual(
    ops.map((o) => o.kind),
    ["renameColumn", "dropFulltextIndex", "createFulltextIndex"],
  );
  // with an explicit name it stays untouched
  const keep = (s: string) => s.replace("@@fulltext([title, body])", '@@fulltext([title], map: "FT_T")');
  assert.deepEqual(diffSchemas(physical(keep(SRC)), physical(keep(SRC).replace('@map("TITLE")', '@map("HEADLINE")')), { renames }).map((o) => o.kind), ["renameColumn"]);
});

test("introspection reads SYS.FULLTEXT_INDEXES and keeps them out of plain indexes; db pull round-trips", () => {
  const rows: CatalogRows = {
    tables: [{ TABLE_NAME: "ARTICLES" }],
    columns: [
      { TABLE_NAME: "ARTICLES", COLUMN_NAME: "ID", POSITION: 1, DATA_TYPE_NAME: "INTEGER", LENGTH: null, SCALE: null, IS_NULLABLE: "FALSE", DEFAULT_VALUE: null },
      { TABLE_NAME: "ARTICLES", COLUMN_NAME: "TITLE", POSITION: 2, DATA_TYPE_NAME: "NVARCHAR", LENGTH: 5000, SCALE: null, IS_NULLABLE: "FALSE", DEFAULT_VALUE: null },
    ],
    constraints: [{ TABLE_NAME: "ARTICLES", CONSTRAINT_NAME: "PK_ARTICLES", COLUMN_NAME: "ID", POSITION: 1, IS_PRIMARY_KEY: "TRUE", IS_UNIQUE_KEY: "TRUE" }],
    foreignKeys: [],
    indexes: [{ TABLE_NAME: "ARTICLES", INDEX_NAME: "FTI_ARTICLES_TITLE", COLUMN_NAME: "TITLE", POSITION: 1 }],
    fulltext: [{ TABLE_NAME: "ARTICLES", INDEX_NAME: "FTI_ARTICLES_TITLE", COLUMN_NAME: "TITLE" }],
  };
  const live = buildPhysicalFromCatalog(rows, { schema: "APP", defaultSchema: "APP" });
  assert.deepEqual(live.tables.ARTICLES!.indexes, []);
  assert.deepEqual(live.tables.ARTICLES!.fulltext, [{ name: "FTI_ARTICLES_TITLE", column: "TITLE" }]);
  const src = renderSchema(live, { defaultSchema: "APP", inScope: () => true }).source;
  assert.match(src, /@@fulltext\(\[title\]\)/);
  assert.deepEqual(diffSchemas(live, contractToPhysical(compileSchema(src), { defaultSchema: "APP" })), []);
});

test("the search filter becomes CONTAINS with a bound search string", async () => {
  const driver = new FakeDriver();
  const db = new HanaClient({ driver });
  await db.post.findMany({ where: { title: { search: '"query builder" OR orm' } } });
  const c = driver.calls.at(-1)!;
  assert.match(c.sql, /WHERE CONTAINS\(t0\."title", \?\)/);
  assert.deepEqual(c.params, ['"query builder" OR orm']);
  await db.post.findMany({ where: { title: { not: { search: "draft" } } } });
  assert.match(driver.calls.at(-1)!.sql, /WHERE NOT \(CONTAINS\(t0\."title", \?\)\)/);
  await assert.rejects(db.post.findMany({ where: { title: { search: "  " } } }), /non-empty search string/);
  await assert.rejects(db.post.findMany({ where: { id: { search: "x" } as never } }), /needs a String field/);
});
