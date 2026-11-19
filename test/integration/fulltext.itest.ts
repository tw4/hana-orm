// Reads a real full-text index through the catalog queries. SYS.FULLTEXT_INDEXES has no column
// name, so a wrong query only shows up against HANA: the unit tests feed hand-written rows.
//
// Runs DDL, so it only runs when HANA_ORM_ALLOW_DDL=1. It creates a fresh schema and drops it
// (CASCADE) at the end.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";
import { resolveConnectionConfig } from "../../src/runtime/config.ts";
import { buildPhysicalFromCatalog, readCatalog } from "../../src/introspect/catalog.ts";

if (process.env.HANA_ORM_ENV_FILE) process.loadEnvFile(process.env.HANA_ORM_ENV_FILE);
const enabled = process.env.HANA_ORM_ALLOW_DDL === "1" && Boolean(process.env.HANA_HOST);
const skip = enabled ? false : "set HANA_ORM_ALLOW_DDL=1 with a local/test HANA to run";

const schemaName = `HANA_ORM_FT_${Date.now().toString(36).toUpperCase()}`;
let admin: HanaDriver;

before(async () => {
  if (!enabled) return;
  admin = new HanaDriver(resolveConnectionConfig(undefined, { currentSchema: undefined }), { poolSize: 1 });
  await admin.execute(`CREATE SCHEMA "${schemaName}"`);
  await admin.execute(`CREATE COLUMN TABLE "${schemaName}"."ARTICLES" ("ID" INTEGER PRIMARY KEY, "TITLE" NVARCHAR(500) NOT NULL, "BODY" NVARCHAR(5000))`);
  await admin.execute(`CREATE FULLTEXT INDEX "FTI_ARTICLES_TITLE" ON "${schemaName}"."ARTICLES" ("TITLE")`);
  await admin.execute(`CREATE INDEX "IX_ARTICLES_BODY" ON "${schemaName}"."ARTICLES" ("BODY")`);
});

after(async () => {
  if (!enabled) return;
  await admin.execute(`DROP SCHEMA "${schemaName}" CASCADE`).catch(() => {});
  await admin.close();
});

test("introspection reads full-text indexes with their column and keeps them out of plain indexes", { skip }, async () => {
  const rows = await readCatalog(admin, schemaName, false);
  const live = buildPhysicalFromCatalog(rows, { schema: schemaName, defaultSchema: schemaName });
  const t = live.tables.ARTICLES!;
  assert.deepEqual(t.fulltext, [{ name: "FTI_ARTICLES_TITLE", column: "TITLE" }]);
  assert.deepEqual(t.indexes, [{ name: "IX_ARTICLES_BODY", columns: ["BODY"] }]);
});
