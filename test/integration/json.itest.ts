// Json filters against a real HANA. The unit tests only check the generated SQL; whether HANA
// accepts it (JSON_VALUE ... RETURNING <type>, JSON_QUERY) shows up only here.
//
// Runs DDL, so it only runs when HANA_ORM_ALLOW_DDL=1. It creates a fresh schema and drops it
// (CASCADE) at the end.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/json/index.ts";

if (process.env.HANA_ORM_ENV_FILE) process.loadEnvFile(process.env.HANA_ORM_ENV_FILE);
const enabled = process.env.HANA_ORM_ALLOW_DDL === "1" && Boolean(process.env.HANA_HOST);
const skip = enabled ? false : "set HANA_ORM_ALLOW_DDL=1 with a local/test HANA to run";

const schemaName = `HANA_ORM_IT_${Date.now().toString(36).toUpperCase()}_JSON`;
// The fixture names schema APP; the connection must not try to use it as its current schema.
const db = new HanaClient({ schema: schemaName, datasource: { currentSchema: "SYS" }, poolSize: 1 });

before(async () => {
  if (!enabled) return;
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
  await db.$executeRawUnsafe(`CREATE COLUMN TABLE "${schemaName}"."Doc" ("id" INTEGER PRIMARY KEY, "data" NCLOB NOT NULL, "meta" NCLOB)`);
  await db.doc.createMany({
    data: [
      { id: 1, data: { user: { country: "DE", age: 34 }, tags: ["urgent", 3, "x"] }, meta: { score: 0.75 } },
      { id: 2, data: { user: { country: "fr", age: 17 }, tags: ["x"] }, meta: { score: "n/a" } },
      { id: 3, data: { user: { country: "DE" }, tags: [] }, meta: null },
    ],
  });
});

after(async () => {
  if (!enabled) return;
  await db.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`).catch(() => {});
  await db.$disconnect();
});

const ids = async (where: object) => (await db.doc.findMany({ where, select: { id: true }, orderBy: { id: "asc" } })).map((d) => d.id);

test("numeric comparisons with a path", { skip }, async () => {
  assert.deepEqual(await ids({ data: { path: ["user", "age"], gte: 18 } }), [1]);
  assert.deepEqual(await ids({ data: { path: "$.user.age", lt: 18 } }), [2]);
  // fractional values, and a non-numeric string at the path does not fail the query
  assert.deepEqual(await ids({ meta: { path: "$.score", gt: 0.5 } }), [1]);
  assert.deepEqual(await ids({ data: { path: ["user", "age"], equals: 34 } }), [1]);
});

test("string, null and array filters", { skip }, async () => {
  assert.deepEqual(await ids({ data: { path: ["user", "country"], equals: "DE" } }), [1, 3]);
  assert.deepEqual(await ids({ data: { path: ["user", "country"], string_starts_with: "F", mode: "insensitive" } }), [2]);
  assert.deepEqual(await ids({ data: { path: ["user", "age"], equals: null } }), [3]);
  assert.deepEqual(await ids({ data: { path: ["tags"], array_contains: ["urgent", 3] } }), [1]);
  assert.deepEqual(await ids({ data: { path: ["tags"], array_starts_with: "x" } }), [2]);
  assert.deepEqual(await ids({ meta: { equals: null } }), [3]);
});
