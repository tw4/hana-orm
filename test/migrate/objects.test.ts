/** Check constraints, sequences and comments (issue #24): schema → physical → diff → catalog → db pull. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileSchema } from "../../src/schema/build.ts";
import { SchemaError } from "../../src/schema/errors.ts";
import { contractToPhysical } from "../../src/migrate/contract-to-physical.ts";
import { createTableSql, normalizeCheckSql } from "../../src/migrate/ddl.ts";
import { diffSchemas } from "../../src/migrate/diff.ts";
import type { PhysicalSchema, PhysicalTable } from "../../src/migrate/physical.ts";
import { clonePhysical } from "../../src/migrate/physical.ts";
import { buildPhysicalFromCatalog } from "../../src/introspect/catalog.ts";
import type { CatalogRows } from "../../src/introspect/catalog.ts";
import { renderSchema } from "../../src/introspect/render.ts";

const SOURCE = readFileSync(new URL("../fixtures/objects.hana", import.meta.url), "utf8");
const contract = () => compileSchema(SOURCE);
const physical = () => contractToPhysical(contract(), { defaultSchema: "APP" });

function compileError(src: string): string {
  try {
    compileSchema(src);
  } catch (e) {
    if (e instanceof SchemaError) return e.message;
    throw e;
  }
  assert.fail("expected a schema error");
}

// ---- schema ---------------------------------------------------------------------------

test("@@check and sequence() compile into the contract", () => {
  const order = contract().models.Order!;
  assert.deepEqual(order.checks, [
    { dbName: "CK_ORDERS_1", sql: "TOTAL >= 0" },
    { dbName: "CK_ORDERS_STATUS", sql: "STATUS IN ('open', 'paid')" },
  ]);
  assert.deepEqual(order.fields.find((f) => f.name === "no")!.kind !== "relation" && (order.fields.find((f) => f.name === "no") as { default?: unknown }).default, { kind: "sequence", name: "ORDER_NO", start: 1000 });
});

test("schema errors for @@check and sequence()", () => {
  const model = (body: string) => `model T {\n  id Int @id\n${body}\n}\n`;
  assert.match(compileError(model('  @@check("")')), /@@check expects a SQL condition string/);
  assert.match(compileError(model('  @@check("A > 0", name: "X")')), /Unknown argument 'name' in @@check/);
  assert.match(compileError('model T {\n  id String @id @default(sequence("S"))\n}\n'), /sequence\(\) is only valid on Int and BigInt/);
  assert.match(compileError('model T {\n  id Int @id @default(sequence())\n}\n'), /expects the sequence name/);
  assert.match(compileError('model T {\n  id Int @id @default(sequence("S", step: 2))\n}\n'), /Unknown or invalid argument 'step'/);
  assert.match(compileError('model T {\n  id Int @id @default(sequence("S", increment: 0))\n}\n'), /increment cannot be 0/);
  assert.match(
    compileError('model A {\n  id Int @id @default(sequence("S", start: 1))\n}\nmodel B {\n  id Int @id @default(sequence("S", start: 5))\n}\n'),
    /Sequence 'S' is used by A\.id and B\.id with different start\/increment/,
  );
  // the same sequence with the same options is fine
  compileSchema('model A {\n  id Int @id @default(sequence("S"))\n}\nmodel B {\n  id Int @id @default(sequence("S"))\n}\n');
});

test("/// docs do not change the contract hash", () => {
  const a = compileSchema("model T {\n  id Int @id\n}\n");
  const b = compileSchema("/// Things.\nmodel T {\n  /// The key.\n  id Int @id\n}\n");
  assert.equal(a.hash, b.hash);
});

// ---- physical and DDL -----------------------------------------------------------------------

test("contractToPhysical carries checks, comments and sequences", () => {
  const p = physical();
  const t = p.tables.ORDERS!;
  assert.deepEqual(t.checks, [
    { name: "CK_ORDERS_1", sql: "TOTAL >= 0" },
    { name: "CK_ORDERS_STATUS", sql: "STATUS IN ('open', 'paid')" },
  ]);
  assert.equal(t.comment, "Customer orders.");
  assert.equal(t.columns.find((c) => c.name === "NO")!.comment, "Order number, drawn from a sequence.");
  assert.equal(t.columns.find((c) => c.name === "NO")!.default, undefined, "HANA has no sequence column default");
  assert.deepEqual(p.sequences, { ORDER_NO: { name: "ORDER_NO", start: 1000 }, ORDER_REF: { name: "ORDER_REF" } });
  assert.match(createTableSql(t), /CONSTRAINT "CK_ORDERS_1" CHECK \(TOTAL >= 0\),\n  CONSTRAINT "CK_ORDERS_STATUS" CHECK \(STATUS IN \('open', 'paid'\)\)\n\)$/);
});

test("sequences of a model in another schema are keyed and created there", () => {
  const c = compileSchema('model T {\n  id Int @id @default(sequence("S", increment: 5))\n  @@schema("OTHER")\n}\n');
  const p = contractToPhysical(c, { defaultSchema: "APP" });
  assert.deepEqual(p.sequences, { "OTHER.S": { schema: "OTHER", name: "S", increment: 5 } });
  const ops = diffSchemas({ tables: {} }, p);
  assert.deepEqual(ops.find((o) => o.kind === "createSequence")!.sql, ['CREATE SEQUENCE "OTHER"."S" INCREMENT BY 5']);
});

test("normalizeCheckSql ignores case, spacing and wrapping parentheses but not literals", () => {
  assert.equal(normalizeCheckSql("total >= 0"), normalizeCheckSql("(TOTAL>=0)"));
  assert.equal(normalizeCheckSql("((a  >  0) and (b < 1))"), "(A>0)AND(B<1)");
  assert.equal(normalizeCheckSql("STATUS IN ('open', 'paid')"), "STATUS IN('open','paid')");
  assert.notEqual(normalizeCheckSql("S = 'Open'"), normalizeCheckSql("S = 'open'"));
  assert.notEqual(normalizeCheckSql("S = 'a  b'"), normalizeCheckSql("S = 'a b'"));
  assert.equal(normalizeCheckSql('"Total" > 0'), '"Total">0');
  assert.equal(normalizeCheckSql("(a > 0) or (b > 0)"), "(A>0)OR(B>0)", "parentheses that do not wrap everything stay");
});

// ---- diff ------------------------------------------------------------------------------------

test("a new table gets its checks in CREATE TABLE, then comments; sequences are created first", () => {
  const ops = diffSchemas({ tables: {} }, physical());
  assert.deepEqual(
    ops.map((o) => o.kind),
    ["createSequence", "createSequence", "createTable", "setComment", "setComment"],
  );
  assert.deepEqual(ops[0]!.sql, ['CREATE SEQUENCE "ORDER_NO" START WITH 1000']);
  assert.deepEqual(ops[1]!.sql, ['CREATE SEQUENCE "ORDER_REF"']);
  assert.equal(ops[0]!.precheck!.sql, "SELECT 1 FROM SYS.SEQUENCES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND SEQUENCE_NAME = ?");
  assert.deepEqual(ops[3]!.sql, ["COMMENT ON TABLE \"ORDERS\" IS 'Customer orders.'"]);
  assert.deepEqual(ops[4]!.sql, ["COMMENT ON COLUMN \"ORDERS\".\"NO\" IS 'Order number, drawn from a sequence.'"]);
  assert.deepEqual(diffSchemas(physical(), physical()), [], "no changes against itself");
});

test("check constraints are added with a pre-check, dropped, and re-created when the condition changes", () => {
  const from = physical();
  const to = clonePhysical(from);
  const t = to.tables.ORDERS!;
  t.checks = [
    { name: "CK_ORDERS_1", sql: "TOTAL > 0" },
    { name: "CK_ORDERS_POSITIVE_NO", sql: "NO > 0" },
  ];
  const ops = diffSchemas(from, to);
  assert.deepEqual(
    ops.map((o) => `${o.kind} ${o.sql.join("; ")}`),
    [
      'dropCheck ALTER TABLE "ORDERS" DROP CONSTRAINT "CK_ORDERS_1"',
      'dropCheck ALTER TABLE "ORDERS" DROP CONSTRAINT "CK_ORDERS_STATUS"',
      'addCheck ALTER TABLE "ORDERS" ADD CONSTRAINT "CK_ORDERS_1" CHECK (TOTAL > 0)',
      'addCheck ALTER TABLE "ORDERS" ADD CONSTRAINT "CK_ORDERS_POSITIVE_NO" CHECK (NO > 0)',
    ],
  );
  const add = ops.find((o) => o.kind === "addCheck")!;
  assert.equal(add.precheck!.sql, 'SELECT 1 FROM "ORDERS" WHERE NOT (TOTAL > 0) LIMIT 1');
  assert.equal(add.precheck!.expect, "empty");
});

test("checks are compared by normalized condition; an unnamed live check matches by condition", () => {
  const expected = physical();
  const live = clonePhysical(expected);
  live.tables.ORDERS!.checks = [
    { name: "_SYS_CONSTRAINT_1", sql: "(total>=0)" },
    { name: "CK_ORDERS_STATUS", sql: "status in ('open','paid')" },
  ];
  assert.deepEqual(diffSchemas(live, expected), []);
  // a renamed named check is re-created under its new name
  live.tables.ORDERS!.checks[1]!.name = "CK_OLD";
  assert.deepEqual(
    diffSchemas(live, expected).map((o) => o.kind),
    ["dropCheck", "addCheck"],
  );
});

test("comments are set, changed and removed", () => {
  const from = physical();
  const to = clonePhysical(from);
  const t = to.tables.ORDERS!;
  delete t.comment;
  t.columns.find((c) => c.name === "NO")!.comment = "It's the number.";
  t.columns.find((c) => c.name === "TOTAL")!.comment = "Gross.";
  const ops = diffSchemas(from, to);
  assert.deepEqual(
    ops.map((o) => o.sql[0]),
    ['COMMENT ON TABLE "ORDERS" IS NULL', "COMMENT ON COLUMN \"ORDERS\".\"NO\" IS 'It''s the number.'", "COMMENT ON COLUMN \"ORDERS\".\"TOTAL\" IS 'Gross.'"],
  );
  assert.ok(ops.every((o) => o.kind === "setComment" && !o.destructive));
});

test("sequences: dropped (destructive), increment changed, start ignored for existing ones", () => {
  const from = physical();
  const to = clonePhysical(from);
  delete to.sequences!.ORDER_REF;
  to.sequences!.ORDER_NO = { name: "ORDER_NO", start: 1, increment: 10 };
  const ops = diffSchemas(from, to);
  assert.deepEqual(
    ops.map((o) => `${o.kind}${o.destructive ? "!" : ""} ${o.sql[0]}`),
    ['dropSequence! DROP SEQUENCE "ORDER_REF"', 'alterSequence ALTER SEQUENCE "ORDER_NO" INCREMENT BY 10'],
  );
  // a live sequence reports its current start; that is not a change
  const live = clonePhysical(from);
  live.sequences!.ORDER_NO = { name: "ORDER_NO", start: 1000, increment: 1 };
  live.sequences!.ORDER_REF = { name: "ORDER_REF", start: 1, increment: 1 };
  assert.deepEqual(diffSchemas(live, from), []);
});

// ---- introspection and db pull ------------------------------------------------------------

function catalog(): CatalogRows {
  const col = (COLUMN_NAME: string, POSITION: number, DATA_TYPE_NAME: string, extra: Record<string, unknown> = {}) => ({
    TABLE_NAME: "ORDERS",
    COLUMN_NAME,
    POSITION,
    DATA_TYPE_NAME,
    LENGTH: null,
    SCALE: null,
    IS_NULLABLE: "FALSE",
    DEFAULT_VALUE: null,
    ...extra,
  });
  return {
    tables: [{ TABLE_NAME: "ORDERS", COMMENTS: "Customer orders." }],
    columns: [
      col("NO", 1, "INTEGER", { COMMENTS: "Order number, drawn from a sequence." }),
      col("REF", 2, "BIGINT"),
      col("TOTAL", 3, "DECIMAL", { LENGTH: 15, SCALE: 2 }),
      col("STATUS", 4, "NVARCHAR", { LENGTH: 20, DEFAULT_VALUE: "open" }),
    ],
    constraints: [{ TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "_SYS_TREE_CS_#1_#0_#P0", COLUMN_NAME: "NO", POSITION: 1, IS_PRIMARY_KEY: "TRUE", IS_UNIQUE_KEY: "TRUE" }],
    foreignKeys: [],
    indexes: [],
    // HANA lists a check once per column it uses
    checks: [
      { TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "_SYS_CONSTRAINT_12345", CHECK_CONDITION: "TOTAL >= 0" },
      { TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "CK_ORDERS_STATUS", CHECK_CONDITION: "STATUS IN ('open', 'paid')" },
      { TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "CK_ORDERS_STATUS", CHECK_CONDITION: "STATUS IN ('open', 'paid')" },
    ],
    sequences: [
      { SEQUENCE_NAME: "ORDER_NO", START_NUMBER: 1000, INCREMENT_BY: 1 },
      { SEQUENCE_NAME: "ORDER_REF", START_NUMBER: "1", INCREMENT_BY: "1" },
      { SEQUENCE_NAME: "_SYS_SEQUENCE_123_#0_#", START_NUMBER: 1, INCREMENT_BY: 1 },
    ],
  };
}

function live(): PhysicalSchema {
  return buildPhysicalFromCatalog(catalog(), { schema: "APP", defaultSchema: "APP" });
}

test("buildPhysicalFromCatalog reads column comments, checks and user sequences", () => {
  const p = live();
  const t: PhysicalTable = p.tables.ORDERS!;
  assert.equal(t.comment, "Customer orders.");
  assert.equal(t.columns[0]!.comment, "Order number, drawn from a sequence.");
  assert.equal(t.columns[1]!.comment, undefined);
  assert.deepEqual(t.checks, [
    { name: "_SYS_CONSTRAINT_12345", sql: "TOTAL >= 0" },
    { name: "CK_ORDERS_STATUS", sql: "STATUS IN ('open', 'paid')" },
  ]);
  assert.deepEqual(p.sequences, { ORDER_NO: { name: "ORDER_NO", start: 1000, increment: 1 }, ORDER_REF: { name: "ORDER_REF", start: 1, increment: 1 } });
  const filtered = buildPhysicalFromCatalog(catalog(), { schema: "APP", defaultSchema: "APP", sequenceFilter: (n) => n === "ORDER_REF" });
  assert.deepEqual(Object.keys(filtered.sequences!), ["ORDER_REF"]);
});

test("db pull writes @@check and column comments; an existing sequence() default is kept", () => {
  const existing = 'datasource db {\n  provider = "hana"\n  schema   = "APP"\n}\n\nmodel Order {\n  no Int @id @default(sequence("ORDER_NO", start: 1000)) @map("NO")\n  @@map("ORDERS")\n}\n';
  const src = renderSchema(live(), { existingSource: existing, defaultSchema: "APP", inScope: () => true }).source;
  assert.match(src, /\/\/\/ Customer orders\.\nmodel Order \{/);
  assert.match(src, /  \/\/\/ Order number, drawn from a sequence\.\n  no +Int +@id @default\(sequence\("ORDER_NO", start: 1000\)\) @map\("NO"\)/);
  assert.match(src, /  @@check\("TOTAL >= 0"\)\n/, "a system-named check gets the default name");
  assert.match(src, /  @@check\("STATUS IN \('open', 'paid'\)", map: "CK_ORDERS_STATUS"\)\n/);
  assert.doesNotMatch(src, /_SYS_/);
});

test("round trip: db pull, then the drift check finds no differences", () => {
  const db = live();
  const existing = 'datasource db {\n  provider = "hana"\n  schema   = "APP"\n}\n\nmodel Order {\n  no  Int    @id @default(sequence("ORDER_NO", start: 1000)) @map("NO")\n  ref BigInt @default(sequence("ORDER_REF")) @map("REF")\n  @@map("ORDERS")\n}\n';
  const src = renderSchema(db, { existingSource: existing, defaultSchema: "APP", inScope: () => true }).source;
  const pulled = compileSchema(src);
  const expected = contractToPhysical(pulled, { defaultSchema: "APP" });
  // what compareWithLive does: the live side holds only the objects the schema defines
  const liveSide = clonePhysical(db);
  liveSide.sequences = Object.fromEntries(Object.entries(db.sequences ?? {}).filter(([k]) => expected.sequences?.[k]));
  assert.deepEqual(diffSchemas(liveSide, expected), []);
  // and a fresh pull without an existing schema has no drift for tables, checks and comments
  const fresh = compileSchema(renderSchema(db, { defaultSchema: "APP", inScope: () => true }).source);
  const freshExpected = contractToPhysical(fresh, { defaultSchema: "APP" });
  assert.deepEqual(diffSchemas({ tables: db.tables }, freshExpected), []);
});

// ---- projects that used /// before comments were managed ----------------------------------

test("a migration snapshot from before comment support makes the next plan set the comments", async () => {
  const { withCtx, args } = await import("./cli-ctx.ts");
  const { migratePlan } = await import("../../src/migrate/commands.ts");
  const { readMigrations } = await import("../../src/migrate/files.ts");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { managesComments } = await import("../../src/migrate/contract-to-physical.ts");
  await withCtx(async (ctx) => {
    ctx.contract = compileSchema("/// Things.\nmodel T {\n  /// The key.\n  id Int @id @map(\"ID\")\n  @@map(\"T\")\n}\n");
    const clock = (s: number) => () => new Date(Date.UTC(2026, 10, 18, 10, 0, s));
    assert.equal(await migratePlan(args({ name: "init" }), ctx, clock(0)), 0);
    const [init] = await readMigrations(ctx.migrationsDir);
    // turn it into a snapshot as older versions wrote it
    const file = join(init!.dir, "contract.json");
    const snap = JSON.parse(await readFile(file, "utf8"));
    assert.equal(snap.comments, true);
    delete snap.comments;
    await writeFile(file, JSON.stringify(snap), "utf8");
    assert.equal(managesComments(snap), false);
    assert.equal(managesComments(ctx.contract), true);
    assert.deepEqual(contractToPhysical(snap).tables.T!.comment, undefined);

    ctx.logs.length = 0;
    assert.equal(await migratePlan(args({ name: "comments" }), ctx, clock(1)), 0);
    const ms = await readMigrations(ctx.migrationsDir);
    assert.equal(ms.length, 2);
    assert.deepEqual(ms[1]!.ops.ops.map((o) => o.sql[0]), ["COMMENT ON TABLE \"T\" IS 'Things.'", "COMMENT ON COLUMN \"T\".\"ID\" IS 'The key.'"]);
    assert.equal(ms[1]!.ops.from, ms[1]!.ops.to, "docs do not change the contract hash");
    ctx.logs.length = 0;
    assert.equal(await migratePlan(args({ name: "again" }), ctx, clock(2)), 0);
    assert.match(ctx.logs.join("\n"), /No changes/);
  });
});
