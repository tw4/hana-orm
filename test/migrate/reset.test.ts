import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DB_MIGRATE_HELP, runDbOrMigrateCommand } from "../../src/migrate/cli.ts";
import { migratePlan } from "../../src/migrate/commands.ts";
import { dropSql, isLocalHost } from "../../src/migrate/reset.ts";
import { args, withCtx } from "./cli-ctx.ts";
import type { TestCtx } from "./cli-ctx.ts";

let clock = Date.UTC(2026, 10, 17, 12, 0, 0);
const tick = (): Date => new Date((clock += 1000));

/** Live database: USERS, POSTS, the history table and an unrelated table, one view, one sequence. */
function fakeDatabase(ctx: TestCtx): void {
  const live = ["USERS", "POSTS", "_HANA_ORM_MIGRATIONS", "UNRELATED"];
  ctx.driver.onQuery = (sql, params) => {
    if (sql.includes("CURRENT_SCHEMA AS S")) return [{ S: "APP" }];
    if (sql.startsWith("SELECT TABLE_NAME, COMMENTS FROM SYS.TABLES")) return live.map((t) => ({ TABLE_NAME: t }));
    if (sql.startsWith("SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND IS_USER_DEFINED_TYPE")) return live.map((t) => ({ TABLE_NAME: t }));
    if (sql.includes("AND TABLE_NAME IN (")) return live.filter((t) => params.includes(t)).map((t) => ({ TABLE_NAME: t }));
    if (sql.startsWith("SELECT VIEW_NAME FROM SYS.VIEWS")) return [{ VIEW_NAME: "ACTIVE_USERS" }];
    if (sql.startsWith("SELECT SEQUENCE_NAME FROM SYS.SEQUENCES")) return [{ SEQUENCE_NAME: "INVOICE_NO" }];
    if (sql.includes("FROM SYS.TABLES WHERE")) {
      // existence checks during deploy: a table exists once it was (re)created
      const name = params.at(-1) as string;
      return ctx.driver.sql().some((s) => s.startsWith(`CREATE COLUMN TABLE "${name}"`)) ? [{ X: 1 }] : [];
    }
    return [];
  };
}

async function withMigration(fn: (ctx: TestCtx) => Promise<void>): Promise<void> {
  return withCtx(async (ctx) => {
    assert.equal(await migratePlan(args({ name: "init" }), ctx, tick), 0);
    fakeDatabase(ctx);
    await fn(ctx);
  });
}

test("isLocalHost accepts only loopback names", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]", " localhost "]) assert.ok(isLocalHost(h), h);
  for (const h of ["db.example.com", "10.0.0.5", "127.0.0.2", "localhost.example.com", ""]) assert.ok(!isLocalHost(h), h);
  assert.equal(dropSql({ kind: "TABLE", schema: "APP", name: "USERS" }), 'DROP TABLE "APP"."USERS" CASCADE');
  assert.equal(dropSql({ kind: "SEQUENCE", schema: "APP", name: "S" }), 'DROP SEQUENCE "APP"."S"');
});

test("migrate reset refuses a non-local host without --allow-remote, before connecting", () =>
  withMigration(async (ctx) => {
    ctx.host = "hana.example.com";
    assert.equal(await runDbOrMigrateCommand("migrate", "reset", args({ force: true }), ctx), 1);
    assert.match(ctx.warns.join("\n"), /refuses to run against 'hana\.example\.com'.*--allow-remote/);
    assert.equal(ctx.connects, 0);
    assert.deepEqual(ctx.driver.sql(), []);
  }));

test("migrate reset asks for confirmation and does nothing when the answer is no", () =>
  withMigration(async (ctx) => {
    assert.equal(await runDbOrMigrateCommand("migrate", "reset", args(), ctx), 1);
    assert.equal(ctx.questions.length, 1);
    assert.match(ctx.warns.join("\n"), /Reset cancelled.*--force/);
    assert.deepEqual(ctx.driver.sql(), []);
  }));

test("migrate reset drops the project's tables, re-applies migrations and seeds", () =>
  withMigration(async (ctx) => {
    await writeFile(join(ctx.cwd, "package.json"), JSON.stringify({ "hana-orm": { seed: "node ./seed.js" } }));
    ctx.answers = [true];
    const code = await runDbOrMigrateCommand("migrate", "reset", args(), ctx);
    assert.equal(code, 0, ctx.warns.join("\n"));
    const sql = ctx.driver.sql();
    const drops = sql.filter((s) => s.startsWith("DROP"));
    assert.deepEqual(drops.sort(), ['DROP TABLE "APP"."POSTS" CASCADE', 'DROP TABLE "APP"."USERS" CASCADE', 'DROP TABLE "APP"."_HANA_ORM_MIGRATIONS" CASCADE']);
    assert.ok(!sql.some((s) => s.includes("UNRELATED")), "tables the project does not own are kept");
    const lastDrop = sql.findLastIndex((s) => s.startsWith("DROP"));
    assert.ok(sql.findIndex((s) => s.startsWith('CREATE COLUMN TABLE "USERS"')) > lastDrop, "migrations run after the drops");
    assert.ok(sql.some((s) => s.startsWith('UPSERT "_HANA_ORM_MIGRATIONS"')));
    assert.deepEqual(ctx.commands.map((c) => c.command), ["node ./seed.js"]);
    assert.ok(ctx.logs.some((l) => l.includes("Applied 1 migration(s)")));
  }));

test("migrate reset --force --skip-seed on an allowed remote host", () =>
  withMigration(async (ctx) => {
    await writeFile(join(ctx.cwd, "package.json"), JSON.stringify({ "hana-orm": { seed: "node ./seed.js" } }));
    ctx.host = "dev-db.example.com";
    assert.equal(await runDbOrMigrateCommand("migrate", "reset", args({ force: true, "allow-remote": true, "skip-seed": true }), ctx), 0);
    assert.equal(ctx.questions.length, 0);
    assert.equal(ctx.commands.length, 0);
    assert.ok(ctx.driver.sql().some((s) => s.startsWith("DROP TABLE")));
  }));

test("migrate reset --schema-drop drops every table, view and sequence of the schema", () =>
  withMigration(async (ctx) => {
    assert.equal(await runDbOrMigrateCommand("migrate", "reset", args({ force: true, "schema-drop": true }), ctx), 0, ctx.warns.join("\n"));
    const drops = ctx.driver.sql().filter((s) => s.startsWith("DROP"));
    assert.equal(drops[0], 'DROP VIEW "APP"."ACTIVE_USERS" CASCADE', "views first");
    assert.ok(drops.includes('DROP TABLE "APP"."UNRELATED" CASCADE'));
    assert.equal(drops.at(-1), 'DROP SEQUENCE "APP"."INVOICE_NO"');
    assert.equal(drops.length, 6);
  }));

test("migrate reset is in the help text", () => {
  assert.match(DB_MIGRATE_HELP, /migrate reset \[--force\] \[--schema-drop\] \[--skip-seed\] \[--allow-remote\]/);
});
