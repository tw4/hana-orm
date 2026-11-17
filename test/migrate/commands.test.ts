import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext, ParsedArgs } from "../../src/cli/context.ts";
import type { Contract } from "../../src/schema/contract.ts";
import { DB_MIGRATE_HELP, runDbOrMigrateCommand } from "../../src/migrate/cli.ts";
import { migrateBaseline, migratePlan } from "../../src/migrate/commands.ts";
import { readMigrations } from "../../src/migrate/files.ts";
import { blogContract, col, contract, FakeDriver, model } from "./fixtures.ts";

interface TestCtx extends CliContext {
  logs: string[];
  warns: string[];
  contract: Contract;
  driver: FakeDriver;
  answers: boolean[];
}

async function makeCtx(): Promise<TestCtx> {
  const dir = await mkdtemp(join(tmpdir(), "hana-orm-cmd-"));
  const ctx: TestCtx = {
    cwd: dir,
    schemaPath: join(dir, "schema.hana"),
    migrationsDir: join(dir, "migrations"),
    logs: [],
    warns: [],
    contract: blogContract(),
    driver: new FakeDriver(),
    answers: [],
    async loadContract() {
      return ctx.contract;
    },
    async connect() {
      return ctx.driver;
    },
    async defaultSchema() {
      return undefined;
    },
    async connectionHost() {
      return "localhost";
    },
    log(m) {
      ctx.logs.push(m);
    },
    warn(m) {
      ctx.warns.push(m);
    },
    async confirm(_q, d) {
      return ctx.answers.length ? ctx.answers.shift()! : d;
    },
  };
  return ctx;
}

const args = (flags: Record<string, string | boolean> = {}, positional: string[] = []): ParsedArgs => ({ flags, positional });

let clock = Date.UTC(2026, 10, 17, 9, 0, 0);
const tick = (): Date => new Date((clock += 1000));

test("migrate plan writes a migration, then reports no changes", async () => {
  const ctx = await makeCtx();
  try {
    assert.equal(await migratePlan(args({ name: "Init" }), ctx, tick), 0);
    const [m] = await readMigrations(ctx.migrationsDir);
    assert.ok(m);
    assert.match(m.id, /^\d{14}_init$/);
    assert.equal(m.ops.from, null);
    assert.equal(m.ops.to, ctx.contract.hash);
    assert.deepEqual(m.ops.ops.map((o) => o.kind), ["createTable", "createTable", "createIndex", "addForeignKey"]);
    assert.ok(ctx.logs.some((l) => l.includes("Created migration")));

    assert.equal(await migratePlan(args({ name: "again" }), ctx, tick), 0);
    assert.ok(ctx.logs.at(-1)!.startsWith("No changes"));
    assert.equal((await readMigrations(ctx.migrationsDir)).length, 1);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("migrate plan refuses destructive changes without --allow-destructive and names each object", async () => {
  const ctx = await makeCtx();
  try {
    ctx.contract = contract([model("User", [col("id", "Int", { id: true }), col("age", "Int", { optional: true })], { map: "USERS" }), model("Tmp", [col("id", "Int", { id: true })], { map: "TMP" })]);
    await migratePlan(args({ name: "init" }), ctx, tick);
    ctx.contract = contract([model("User", [col("id", "Int", { id: true })], { map: "USERS" })]);
    assert.equal(await migratePlan(args({ name: "cleanup" }), ctx, tick), 1);
    const msg = ctx.warns.join("\n");
    assert.match(msg, /Drop table "TMP"/);
    assert.match(msg, /Drop column "age" of "USERS"/);
    assert.match(msg, /--allow-destructive/);
    assert.equal((await readMigrations(ctx.migrationsDir)).length, 1);

    assert.equal(await migratePlan(args({ name: "cleanup", "allow-destructive": true }), ctx, tick), 0);
    const ms = await readMigrations(ctx.migrationsDir);
    assert.equal(ms.length, 2);
    assert.equal(ms[1]!.ops.from, ms[0]!.ops.to);
    assert.ok(ms[1]!.ops.ops.every((o) => o.destructive));
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("migrate plan --empty creates a hand-written SQL migration that keeps the contract hash", async () => {
  const ctx = await makeCtx();
  try {
    await migratePlan(args({ name: "init" }), ctx, tick);
    assert.equal(await migratePlan(args({ name: "backfill", empty: true }), ctx, tick), 0);
    const ms = await readMigrations(ctx.migrationsDir);
    assert.equal(ms[1]!.ops.from, ms[1]!.ops.to);
    assert.deepEqual(ms[1]!.ops.ops, [{ kind: "sqlFile", description: "Hand-written SQL from migration.sql", sql: [], file: "migration.sql" }]);
    const sqlPath = join(ms[1]!.dir, "migration.sql");
    const before = ms[1]!.checksum;
    await writeFile(sqlPath, (await readFile(sqlPath, "utf8")) + "UPDATE \"USERS\" SET \"NAME\" = 'x';\n");
    assert.notEqual((await readMigrations(ctx.migrationsDir))[1]!.checksum, before, "editing the SQL changes the checksum");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("migrate plan refuses to build on a diverged history", async () => {
  const ctx = await makeCtx();
  try {
    await migratePlan(args({ name: "init" }), ctx, tick);
    const [m] = await readMigrations(ctx.migrationsDir);
    const opsPath = join(m!.dir, "ops.json");
    await writeFile(opsPath, (await readFile(opsPath, "utf8")).replace('"from": null', '"from": "abc"'));
    assert.equal(await migratePlan(args({ name: "next" }), ctx, tick), 1);
    assert.match(ctx.warns.join("\n"), /first migration but starts from contract abc/);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("migrate plan asks before treating drop + add as a rename", async () => {
  const ctx = await makeCtx();
  try {
    ctx.contract = contract([model("User", [col("id", "Int", { id: true }), col("mail", "String", { map: "MAIL" })], { map: "USERS" })]);
    await migratePlan(args({ name: "init" }), ctx, tick);
    ctx.contract = contract([model("User", [col("id", "Int", { id: true }), col("email", "String", { map: "EMAIL" })], { map: "USERS" })]);
    ctx.answers = [true];
    assert.equal(await migratePlan(args({ name: "rename" }), ctx, tick), 0);
    const ms = await readMigrations(ctx.migrationsDir);
    assert.deepEqual(ms[1]!.ops.ops.map((o) => o.sql[0]), ['RENAME COLUMN "USERS"."MAIL" TO "EMAIL"']);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("migrate deploy end to end with the SQL history store", async () => {
  const ctx = await makeCtx();
  try {
    await migratePlan(args({ name: "init" }), ctx, tick);
    // tables "exist" once a CREATE for them was executed
    ctx.driver.onQuery = (sql, params) => {
      if (!sql.includes("FROM SYS.TABLES WHERE")) return [];
      const name = params.at(-1) as string;
      return ctx.driver.sql().some((s) => s.startsWith(`CREATE COLUMN TABLE "${name}"`)) ? [{ X: 1 }] : [];
    };
    const code = await runDbOrMigrateCommand("migrate", "deploy", args(), ctx);
    assert.equal(code, 0, ctx.warns.join("\n"));
    const sql = ctx.driver.sql();
    assert.ok(sql[0]!.startsWith('CREATE COLUMN TABLE "_HANA_ORM_MIGRATIONS"'));
    assert.ok(sql.some((s) => s.startsWith('INSERT INTO "_HANA_ORM_LOCK"')));
    assert.ok(sql.some((s) => s.startsWith('CREATE COLUMN TABLE "USERS"')));
    assert.ok(sql.some((s) => s.startsWith('UPSERT "_HANA_ORM_MIGRATIONS"')));
    assert.ok(sql.some((s) => s.startsWith('UPSERT "_HANA_ORM_MARKER"')));
    assert.ok(sql.at(-1)!.startsWith('DELETE FROM "_HANA_ORM_LOCK"'), "lock released last");
    assert.deepEqual(ctx.driver.txOptions, [{ transactionalDdl: true }]);
    assert.ok(ctx.driver.closed);
    assert.ok(ctx.logs.some((l) => l.includes("Applied 1 migration(s)")));
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("db push --dry-run prints SQL and changes nothing; refuses destructive changes", async () => {
  const ctx = await makeCtx();
  try {
    ctx.driver.onQuery = (sql) => (sql.includes("CURRENT_SCHEMA AS S") ? [{ S: "APP" }] : []);
    assert.equal(await runDbOrMigrateCommand("db", "push", args({ "dry-run": true }), ctx), 0);
    assert.deepEqual(ctx.driver.sql(), []);
    assert.ok(ctx.logs.some((l) => l.includes('CREATE COLUMN TABLE "USERS"')));

    // live table has an extra column → push would drop it
    ctx.driver.onQuery = (sql) => {
      if (sql.includes("CURRENT_SCHEMA AS S")) return [{ S: "APP" }];
      if (sql.startsWith("SELECT TABLE_NAME, COMMENTS FROM SYS.TABLES")) return [{ TABLE_NAME: "USERS" }];
      if (sql.includes("FROM SYS.TABLE_COLUMNS"))
        return [
          { TABLE_NAME: "USERS", COLUMN_NAME: "ID", POSITION: 1, DATA_TYPE_NAME: "INTEGER", LENGTH: 10, SCALE: 0, IS_NULLABLE: "FALSE", DEFAULT_VALUE: null, GENERATION_TYPE: "BY DEFAULT AS IDENTITY" },
          { TABLE_NAME: "USERS", COLUMN_NAME: "LEGACY", POSITION: 2, DATA_TYPE_NAME: "INTEGER", LENGTH: 10, SCALE: 0, IS_NULLABLE: "TRUE", DEFAULT_VALUE: null },
        ];
      return [];
    };
    assert.equal(await runDbOrMigrateCommand("db", "push", args(), ctx), 1);
    assert.match(ctx.warns.join("\n"), /Drop column "LEGACY" of "USERS"/);
    assert.deepEqual(ctx.driver.sql(), []);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("migrate baseline writes the first migration and records it without running it", async () => {
  const ctx = await makeCtx();
  try {
    ctx.driver.onQuery = (sql) => (sql.includes("CURRENT_SCHEMA AS S") ? [{ S: "APP" }] : []);
    ctx.answers = [true]; // database is empty in the fake → confirm the drift prompt
    assert.equal(await migrateBaseline(args(), ctx, tick), 0);
    const [m] = await readMigrations(ctx.migrationsDir);
    assert.match(m!.id, /_init$/);
    const sql = ctx.driver.sql();
    assert.ok(!sql.some((s) => s.startsWith('CREATE COLUMN TABLE "USERS"')), "model DDL is not executed");
    const upsert = ctx.driver.executed.find((e) => e.sql.startsWith('UPSERT "_HANA_ORM_MIGRATIONS"'))!;
    assert.equal(upsert.params[0], m!.id);
    assert.equal(upsert.params[7], "applied");
    assert.equal(await migrateBaseline(args(), ctx, tick), 1, "only once");
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});

test("unknown subcommands print help", async () => {
  const ctx = await makeCtx();
  try {
    assert.equal(await runDbOrMigrateCommand("migrate", "nope", args(), ctx), 1);
    assert.ok(ctx.logs.includes(DB_MIGRATE_HELP));
    assert.match(DB_MIGRATE_HELP, /migrate plan --name <name>/);
    assert.equal((await readdir(ctx.cwd)).length, 0);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
});
