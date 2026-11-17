import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DB_MIGRATE_HELP, runDbOrMigrateCommand } from "../../src/migrate/cli.ts";
import { migratePlan } from "../../src/migrate/commands.ts";
import { dbExecute, DIFF_EXIT_CODE, parseDiffSource } from "../../src/migrate/diff-command.ts";
import { readMigrations } from "../../src/migrate/files.ts";
import { args, withCtx } from "./cli-ctx.ts";
import type { TestCtx } from "./cli-ctx.ts";
import { col, contract, model } from "./fixtures.ts";

let clock = Date.UTC(2026, 10, 18, 9, 0, 0);
const tick = (): Date => new Date((clock += 1000));

const diff = (ctx: TestCtx, flags: Record<string, string | boolean>) => runDbOrMigrateCommand("migrate", "diff", args(flags), ctx);

/** Live database with a USERS table (ID, LEGACY) and an unrelated table. */
function liveUsers(ctx: TestCtx): void {
  ctx.driver.onQuery = (sql, params) => {
    if (sql.includes("CURRENT_SCHEMA AS S")) return [{ S: "APP" }];
    if (sql.startsWith("SELECT TABLE_NAME, COMMENTS FROM SYS.TABLES")) return [{ TABLE_NAME: "USERS" }, { TABLE_NAME: "UNRELATED" }, { TABLE_NAME: "_HANA_ORM_MIGRATIONS" }].filter((t) => !params.length || params.includes(t.TABLE_NAME) || !sql.includes(" IN ("));
    if (sql.includes("FROM SYS.TABLE_COLUMNS"))
      return [
        { TABLE_NAME: "USERS", COLUMN_NAME: "ID", POSITION: 1, DATA_TYPE_NAME: "INTEGER", LENGTH: 10, SCALE: 0, IS_NULLABLE: "FALSE", DEFAULT_VALUE: null, GENERATION_TYPE: "BY DEFAULT AS IDENTITY" },
        { TABLE_NAME: "USERS", COLUMN_NAME: "LEGACY", POSITION: 2, DATA_TYPE_NAME: "INTEGER", LENGTH: 10, SCALE: 0, IS_NULLABLE: "TRUE", DEFAULT_VALUE: null },
        { TABLE_NAME: "UNRELATED", COLUMN_NAME: "ID", POSITION: 1, DATA_TYPE_NAME: "INTEGER", LENGTH: 10, SCALE: 0, IS_NULLABLE: "FALSE", DEFAULT_VALUE: null },
        { TABLE_NAME: "_HANA_ORM_MIGRATIONS", COLUMN_NAME: "ID", POSITION: 1, DATA_TYPE_NAME: "NVARCHAR", LENGTH: 255, SCALE: 0, IS_NULLABLE: "FALSE", DEFAULT_VALUE: null },
      ].filter((r) => !sql.includes(" IN (") || params.includes(r.TABLE_NAME));
    return [];
  };
}

test("parseDiffSource accepts the documented sources only", () => {
  assert.deepEqual(parseDiffSource("schema"), { kind: "schema" });
  assert.deepEqual(parseDiffSource("db"), { kind: "db" });
  assert.deepEqual(parseDiffSource("empty"), { kind: "empty" });
  assert.deepEqual(parseDiffSource("migrations"), { kind: "migrations" });
  assert.deepEqual(parseDiffSource("migrations:2026"), { kind: "migrations", id: "2026" });
  for (const bad of [undefined, true, "", "database", "migrations:"]) assert.equal(typeof parseDiffSource(bad), "string", String(bad));
});

test("migrate diff between files needs no connection", () =>
  withCtx(async (ctx) => {
    assert.equal(await diff(ctx, { from: "empty", to: "schema", script: true }), 0);
    assert.match(ctx.logs.join("\n"), /CREATE COLUMN TABLE "USERS"/);
    assert.equal(ctx.connects, 0);

    ctx.logs.length = 0;
    assert.equal(await diff(ctx, { from: "migrations", to: "schema", "exit-code": true }), DIFF_EXIT_CODE, "no migration yet: everything is new");
    assert.match(ctx.logs[0]!, /change\(s\) from the latest migration to the schema/);

    assert.equal(await migratePlan(args({ name: "init" }), ctx, tick), 0);
    ctx.logs.length = 0;
    assert.equal(await diff(ctx, { from: "migrations", to: "schema", "exit-code": true }), 0);
    assert.deepEqual(ctx.logs, ["No difference between the latest migration and the schema."]);
    assert.equal(ctx.connects, 0);
  }));

test("migrate diff --script between two migrations prints the SQL of the change, renames included", () =>
  withCtx(async (ctx) => {
    ctx.contract = contract([model("User", [col("id", "Int", { id: true, map: "ID" }), col("name", "String", { optional: true })], { map: "USERS" })]);
    assert.equal(await migratePlan(args({ name: "init" }), ctx, tick), 0);
    ctx.contract = contract([model("User", [col("id", "Int", { id: true, map: "ID" }), col("fullName", "String", { optional: true, map: "name" }), col("age", "Int", { optional: true, map: "AGE" })], { map: "USERS" })]);
    assert.equal(await migratePlan(args({ name: "age" }), ctx, tick), 0);
    const [first, second] = (await readMigrations(ctx.migrationsDir)).map((m) => m.id);

    ctx.logs.length = 0;
    assert.equal(await diff(ctx, { from: `migrations:${first}`, to: `migrations:${second}`, script: true }), 0);
    const sql = ctx.logs.join("\n");
    assert.match(sql, /ALTER TABLE "USERS" ADD \("AGE" INTEGER/);
    assert.doesNotMatch(sql, /DROP/);

    // backwards: the column goes away again
    ctx.logs.length = 0;
    assert.equal(await diff(ctx, { from: `migrations:${second}`, to: `migrations:${first}` }), 0);
    assert.match(ctx.logs.join("\n"), /! Drop column "AGE" of "USERS"/);
  }));

test("migrate diff against the database compares only the tables of the other side", () =>
  withCtx(async (ctx) => {
    ctx.contract = contract([model("User", [col("id", "Int", { id: true, map: "ID" })], { map: "USERS" })]);
    liveUsers(ctx);
    assert.equal(await diff(ctx, { from: "db", to: "schema", script: true, "exit-code": true }), DIFF_EXIT_CODE);
    const sql = ctx.logs.join("\n");
    assert.match(sql, /ALTER TABLE "USERS" DROP \("LEGACY"\)/);
    assert.doesNotMatch(sql, /UNRELATED/);
    assert.deepEqual(ctx.driver.sql(), [], "diff never changes the database");

    // against an empty model the whole schema is read, except the _HANA_ORM_* tables
    ctx.logs.length = 0;
    assert.equal(await diff(ctx, { from: "db", to: "empty" }), 0);
    const out = ctx.logs.join("\n");
    assert.match(out, /Drop table "UNRELATED"/);
    assert.match(out, /Drop table "USERS"/);
    assert.doesNotMatch(out, /_HANA_ORM_/);
  }));

test("migrate diff rejects bad sources and db on both sides", () =>
  withCtx(async (ctx) => {
    assert.equal(await diff(ctx, { from: "nope", to: "schema" }), 1);
    assert.match(ctx.warns.join("\n"), /--from 'nope' is not one of/);
    assert.equal(await diff(ctx, { from: "db", to: "db" }), 1);
    assert.match(ctx.warns.join("\n"), /compare the database with itself/);
    assert.equal(await diff(ctx, { from: "migrations:1999", to: "schema" }), 1, "no migrations yet → none matches");
    assert.equal(ctx.connects, 0);
  }));

test("db execute runs a script in one transaction", () =>
  withCtx(async (ctx) => {
    const file = join(ctx.cwd, "fix.sql");
    await writeFile(file, `-- fix data\nUPDATE "USERS" SET "NAME" = 'a;b';\n/* second */ DELETE FROM "POSTS";\n`);
    assert.equal(await runDbOrMigrateCommand("db", "execute", args({ file: "fix.sql" }), ctx), 0);
    assert.deepEqual(ctx.driver.sql(), [`UPDATE "USERS" SET "NAME" = 'a;b'`, `/* second */ DELETE FROM "POSTS"`]);
    assert.equal(ctx.driver.committed.length, 1);
    assert.deepEqual(ctx.logs, ["Executed 2 statement(s)."]);
  }));

test("db execute rolls everything back when a statement fails", () =>
  withCtx(async (ctx) => {
    ctx.driver.failOn = /DELETE/;
    assert.equal(await dbExecute(args({ stdin: true }), ctx, async () => "INSERT INTO T VALUES (1); DELETE FROM T; INSERT INTO T VALUES (2);"), 1);
    assert.deepEqual(ctx.driver.sql(), []);
    assert.equal(ctx.driver.rolledBack.length, 1);
    assert.match(ctx.warns[0]!, /Statement 2 of 3 failed, nothing was committed: fake failure/);
    assert.match(ctx.warns[1]!, /DELETE FROM T/);
  }));

test("db execute needs exactly one of --file and --stdin, and some SQL", () =>
  withCtx(async (ctx) => {
    assert.equal(await dbExecute(args(), ctx), 1);
    assert.equal(await dbExecute(args({ file: "x.sql", stdin: true }), ctx, async () => ""), 1);
    assert.equal(await dbExecute(args({ stdin: true }), ctx, async () => "-- only a comment\n"), 1);
    assert.match(ctx.warns.join("\n"), /no SQL statements/);
    assert.equal(ctx.connects, 0);
    assert.match(DB_MIGRATE_HELP, /db execute --file/);
    assert.match(DB_MIGRATE_HELP, /migrate diff --from <source> --to <source>/);
  }));
