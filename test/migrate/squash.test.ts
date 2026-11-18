import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeStatus, deployBlockers } from "../../src/migrate/apply.ts";
import { runDbOrMigrateCommand } from "../../src/migrate/cli.ts";
import { migratePlan } from "../../src/migrate/commands.ts";
import type { LoadedMigration } from "../../src/migrate/files.ts";
import { readMigrationDir, readMigrations, readSnapshot, verifyGraph } from "../../src/migrate/files.ts";
import type { HistoryRecord } from "../../src/migrate/history.ts";
import type { MigrationOp, ReplacedMigration } from "../../src/migrate/ops.ts";
import { intermediateHash, splitPoints } from "../../src/migrate/squash.ts";
import { args, withCtx } from "./cli-ctx.ts";
import type { TestCtx } from "./cli-ctx.ts";
import { blogContract, col, contract, model } from "./fixtures.ts";

let clock = Date.UTC(2026, 10, 18, 9, 0, 0);
const tick = (): Date => new Date((clock += 60_000));

const tag = model("Tag", [col("id", "Int", { id: true, map: "ID" }), col("label", "String", { map: "LABEL" })], { map: "TAGS" });
const note = model("Note", [col("id", "Int", { id: true, map: "ID" }), col("body", "String", { map: "BODY" })], { map: "NOTES" });

/** Plans init → tags → notes; returns the migrations. */
async function threeMigrations(ctx: TestCtx): Promise<LoadedMigration[]> {
  const blog = blogContract();
  const models = Object.values(blog.models);
  assert.equal(await migratePlan(args({ name: "init" }), ctx, tick), 0);
  ctx.contract = contract([...models, tag]);
  assert.equal(await migratePlan(args({ name: "tags" }), ctx, tick), 0);
  ctx.contract = contract([...models, tag, note]);
  assert.equal(await migratePlan(args({ name: "notes" }), ctx, tick), 0);
  return readMigrations(ctx.migrationsDir);
}

function rec(m: Pick<LoadedMigration, "id" | "checksum" | "ops">, status: HistoryRecord["status"] = "applied"): HistoryRecord {
  return { id: m.id, name: m.id.slice(15), checksum: m.checksum, fromHash: m.ops.from, toHash: m.ops.to, startedAt: new Date(0), finishedAt: new Date(0), status, log: null };
}

/** Makes the fake database answer with these history rows. */
function history(ctx: TestCtx, records: HistoryRecord[]): void {
  ctx.driver.onQuery = (sql) => {
    if (sql.includes("FROM SYS.TABLES WHERE")) return records.length ? [{ X: 1 }] : [];
    if (sql.includes('FROM "_HANA_ORM_MIGRATIONS"')) {
      return records.map((r) => ({ ID: r.id, NAME: r.name, CHECKSUM: r.checksum, FROM_HASH: r.fromHash, TO_HASH: r.toHash, STARTED_AT: r.startedAt, FINISHED_AT: r.finishedAt, STATUS: r.status, LOG: r.log }));
    }
    return [];
  };
}

const allOps = (ms: readonly LoadedMigration[]): MigrationOp[] => ms.flatMap((m) => m.ops.ops);

// ---- squash -------------------------------------------------------------------------

test("migrate squash combines a range into one migration with the same contract chain", () =>
  withCtx(async (ctx) => {
    const before = await threeMigrations(ctx);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: before[0]!.id, to: before[2]!.id.slice(0, 14) }), ctx), 0, ctx.warns.join("\n"));
    const after = await readMigrations(ctx.migrationsDir);
    assert.equal(after.length, 1);
    const s = after[0]!;
    assert.equal(s.id, `${before[2]!.id.slice(0, 14)}_init_to_notes`);
    assert.equal(s.ops.from, null);
    assert.equal(s.ops.to, before[2]!.ops.to);
    assert.deepEqual(s.ops.ops, allOps(before));
    assert.deepEqual(s.ops.replaces, before.map((m) => ({ id: m.id, checksum: m.checksum })));
    assert.deepEqual(verifyGraph(after), []);
    assert.equal((await readSnapshot(s)).hash, ctx.contract.hash);
    for (const m of before) assert.ok(!existsSync(m.dir), `${m.id} removed`);
    // the checksum is stable when read back
    assert.equal((await readMigrationDir(s.dir, s.id)).checksum, s.checksum);
    // nothing left to plan
    ctx.logs.length = 0;
    assert.equal(await migratePlan(args({ name: "again" }), ctx, tick), 0);
    assert.match(ctx.logs.join("\n"), /No changes/);
  }));

test("migrate squash of a middle range keeps the links to the neighbours", () =>
  withCtx(async (ctx) => {
    const before = await threeMigrations(ctx);
    const blog = blogContract();
    ctx.contract = contract([...Object.values(blog.models), tag, note, model("Pin", [col("id", "Int", { id: true, map: "ID" })], { map: "PINS" })]);
    assert.equal(await migratePlan(args({ name: "pins" }), ctx, tick), 0);
    const four = await readMigrations(ctx.migrationsDir);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: before[1]!.id, to: before[2]!.id, name: "Tags and notes" }), ctx), 0, ctx.warns.join("\n"));
    const after = await readMigrations(ctx.migrationsDir);
    assert.deepEqual(after.map((m) => m.id), [four[0]!.id, `${before[2]!.id.slice(0, 14)}_tags_and_notes`, four[3]!.id]);
    assert.deepEqual(verifyGraph(after), []);
    assert.equal(after[1]!.ops.from, before[0]!.ops.to);
    assert.equal(after[1]!.ops.to, four[3]!.ops.from);
  }));

test("migrate squash copies hand-written SQL and scripts under prefixed names", () =>
  withCtx(async (ctx) => {
    const [init] = await threeMigrations(ctx);
    assert.equal(await migratePlan(args({ name: "backfill", empty: true }), ctx, tick), 0);
    assert.equal(await migratePlan(args({ name: "fix", empty: true, script: true }), ctx, tick), 0);
    const ms = await readMigrations(ctx.migrationsDir);
    const [sqlMig, tsMig] = ms.slice(-2) as [LoadedMigration, LoadedMigration];
    await writeFile(join(sqlMig.dir, "migration.sql"), "UPDATE \"TAGS\" SET \"LABEL\" = 'x';\n", "utf8");
    const sqlMigReloaded = await readMigrationDir(sqlMig.dir, sqlMig.id);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[1]!.id, to: tsMig.id }), ctx), 0, ctx.warns.join("\n"));
    const after = await readMigrations(ctx.migrationsDir);
    assert.equal(after.length, 2);
    assert.equal(after[0]!.id, init!.id);
    const s = after[1]!;
    const files = s.ops.ops.filter((o) => o.file).map((o) => [o.kind, o.file]);
    assert.deepEqual(files, [
      ["sqlFile", `${sqlMig.id}_migration.sql`],
      ["script", `${tsMig.id}_migration.ts`],
    ]);
    assert.match(await readFile(join(s.dir, `${sqlMig.id}_migration.sql`), "utf8"), /UPDATE "TAGS"/);
    assert.match(await readFile(join(s.dir, `${tsMig.id}_migration.ts`), "utf8"), /MigrationScript/);
    // migration.sql of the squashed folder is the generated review file again
    assert.match(await readFile(join(s.dir, "migration.sql"), "utf8"), /Generated from ops\.json/);
    assert.equal(s.ops.replaces!.find((r) => r.id === sqlMig.id)!.checksum, sqlMigReloaded.checksum);
  }));

test("migrate squash validates its arguments", () =>
  withCtx(async (ctx) => {
    const ms = await threeMigrations(ctx);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[0]!.id }), ctx), 1);
    assert.match(ctx.warns.pop()!, /Usage/);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[2]!.id, to: ms[0]!.id }), ctx), 1);
    assert.match(ctx.warns.pop()!, /comes after/);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[1]!.id, to: ms[1]!.id }), ctx), 1);
    assert.match(ctx.warns.pop()!, /single migration/);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: "2026", to: ms[1]!.id }), ctx), 1);
    assert.match(ctx.warns.pop()!, /matches several/);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: "1999", to: ms[1]!.id }), ctx), 1);
    assert.match(ctx.warns.pop()!, /No migration matches/);
    assert.equal((await readMigrations(ctx.migrationsDir)).length, 3);
  }));

test("migrate squash refuses an applied range unless --baseline, and always a partly applied one", () =>
  withCtx(async (ctx) => {
    const ms = await threeMigrations(ctx);
    history(ctx, [rec(ms[0]!), rec(ms[1]!)]);
    // partly applied
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[1]!.id, to: ms[2]!.id, baseline: true }), ctx), 1);
    assert.match(ctx.warns.pop()!, /only part of it is applied/);
    // fully applied without --baseline
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[0]!.id, to: ms[1]!.id }), ctx), 1);
    assert.match(ctx.warns.pop()!, /already applied.*--baseline/);
    assert.equal((await readMigrations(ctx.migrationsDir)).length, 3);
    assert.deepEqual(ctx.driver.sql(), []);
    // with --baseline the result is recorded as applied
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[0]!.id, to: ms[1]!.id, baseline: true }), ctx), 0, ctx.warns.join("\n"));
    const after = await readMigrations(ctx.migrationsDir);
    const upserts = ctx.driver.executed.filter((e) => e.sql.startsWith('UPSERT "_HANA_ORM_MIGRATIONS"'));
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0]!.params[0], after[0]!.id);
    assert.equal(upserts[0]!.params[2], after[0]!.checksum);
    assert.ok(ctx.driver.sql().some((s) => s.startsWith('UPSERT "_HANA_ORM_MARKER"')));
    assert.ok(ctx.driver.closed);
  }));

test("migrate squash goes on with a warning when the database cannot be reached", () =>
  withCtx(async (ctx) => {
    const ms = await threeMigrations(ctx);
    ctx.connect = async () => {
      throw new Error("no datasource url");
    };
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: ms[0]!.id, to: ms[2]!.id }), ctx), 0);
    assert.match(ctx.warns.join("\n"), /Could not check the database \(no datasource url\)/);
    assert.equal((await readMigrations(ctx.migrationsDir)).length, 1);
  }));

// ---- status after squash / split ----------------------------------------------------------

test("computeStatus treats a squash as applied where all it replaces is applied", () =>
  withCtx(async (ctx) => {
    const before = await threeMigrations(ctx);
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: before[0]!.id, to: before[1]!.id }), ctx), 0);
    const after = await readMigrations(ctx.migrationsDir);
    const [squash, notes] = after as [LoadedMigration, LoadedMigration];

    // database that applied the old two: squash applied, notes pending, nothing missing
    let report = computeStatus(after, [rec(before[0]!), rec(before[1]!)]);
    assert.deepEqual(report.entries.map((e) => e.state), ["applied", "pending"]);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.pending.map((m) => m.id), [notes.id]);
    assert.equal(report.lastApplied?.id, squash.id);
    assert.equal(report.lastApplied?.toHash, squash.ops.to);
    assert.deepEqual(deployBlockers(report), []);

    // fresh database: both pending
    report = computeStatus(after, []);
    assert.deepEqual(report.pending.map((m) => m.id), [squash.id, notes.id]);

    // database that applied the old three
    report = computeStatus(after, before.map((m) => rec(m)));
    assert.deepEqual(report.entries.map((e) => e.state), ["applied", "applied"]);
    assert.deepEqual(report.pending, []);
    assert.deepEqual(deployBlockers(report), []);

    // only the first of the squashed pair: blocked, nothing to run
    report = computeStatus(after, [rec(before[0]!)]);
    assert.deepEqual(report.partiallyReplaced, [squash.id]);
    assert.deepEqual(report.pending.map((m) => m.id), [notes.id]);
    assert.match(deployBlockers(report).join("\n"), /replaces .* only some of them applied/);

    // applied with other contents than the squashed ones
    report = computeStatus(after, [rec(before[0]!), { ...rec(before[1]!), checksum: "other" }]);
    assert.deepEqual(report.partiallyReplaced, [squash.id]);
  }));

test("computeStatus follows nested replaces through squashes of squashes", () => {
  const leaf = (id: string): ReplacedMigration => ({ id, checksum: `sum-${id}` });
  const inner: ReplacedMigration = { id: "20260102000000_ab", checksum: "sum-ab", replaces: [leaf("20260101000000_a"), leaf("20260102000000_b")] };
  const outer: LoadedMigration = {
    id: "20260103000000_abc",
    name: "abc",
    dir: "/nonexistent",
    checksum: "sum-abc",
    ops: { formatVersion: 1, id: "20260103000000_abc", name: "abc", from: null, to: "C", ops: [], replaces: [inner, leaf("20260103000000_c")] },
  };
  const h = (id: string): HistoryRecord => ({ id, name: id, checksum: `sum-${id}`, fromHash: null, toHash: "x", startedAt: new Date(0), finishedAt: new Date(0), status: "applied", log: null });
  // applied as the original three
  assert.equal(computeStatus([outer], [h("20260101000000_a"), h("20260102000000_b"), h("20260103000000_c")]).entries[0]!.state, "applied");
  // applied as the inner squash plus c
  assert.equal(computeStatus([outer], [{ ...h("20260102000000_ab"), checksum: "sum-ab" }, h("20260103000000_c")]).entries[0]!.state, "applied");
  // missing c
  assert.deepEqual(computeStatus([outer], [h("20260101000000_a"), h("20260102000000_b")]).partiallyReplaced, [outer.id]);
  // old records are not reported missing
  assert.deepEqual(computeStatus([outer], [h("20260101000000_a")]).missing, []);
});

// ---- split ------------------------------------------------------------------------------

test("splitPoints parses --at and defaults to one part per operation", () => {
  assert.deepEqual(splitPoints(undefined, 3), [1, 2]);
  assert.deepEqual(splitPoints("3,2,3", 4), [1, 2]);
  assert.throws(() => splitPoints("1", 4), /between 2 and 4/);
  assert.throws(() => splitPoints("5", 4), /between 2 and 4/);
  assert.throws(() => splitPoints("x", 4), /between 2 and 4/);
});

test("migrate split cuts a migration into chained parts", () =>
  withCtx(async (ctx) => {
    const before = await threeMigrations(ctx);
    const init = before[0]!;
    const n = init.ops.ops.length;
    assert.ok(n >= 3, `init has ${n} ops`);
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({ at: "2" }, ["split", init.id.slice(0, 14)]), ctx), 0, ctx.warns.join("\n"));
    const after = await readMigrations(ctx.migrationsDir);
    assert.equal(after.length, 4);
    const [p1, p2] = after as [LoadedMigration, LoadedMigration];
    assert.equal(p1.id, `${init.id.slice(0, 14)}_init_part1`);
    assert.equal(p2.id.slice(15), "init_part2");
    assert.ok(p2.id > p1.id && p2.id < before[1]!.id);
    assert.equal(p1.ops.from, null);
    assert.equal(p1.ops.to, intermediateHash(init, 1));
    assert.equal(p2.ops.from, p1.ops.to);
    assert.equal(p2.ops.to, init.ops.to);
    assert.deepEqual([...p1.ops.ops, ...p2.ops.ops], init.ops.ops);
    assert.equal(p1.ops.ops.length, 1);
    for (const p of [p1, p2]) assert.deepEqual(p.ops.replaces, [{ id: init.id, checksum: init.checksum }]);
    assert.deepEqual(verifyGraph(after), []);
    assert.ok(!existsSync(init.dir));

    // a database with the original applied treats both parts as applied
    const report = computeStatus(after, [rec(init)]);
    assert.deepEqual(report.entries.slice(0, 2).map((e) => e.state), ["applied", "applied"]);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(deployBlockers(report), []);
    assert.equal(report.pending[0]!.id, before[1]!.id);

    // squashing the parts again gives back the original operations
    assert.equal(await runDbOrMigrateCommand("migrate", "squash", args({ from: p1.id, to: p2.id, name: "init again" }), ctx), 0, ctx.warns.join("\n"));
    const again = await readMigrations(ctx.migrationsDir);
    assert.deepEqual(again[0]!.ops.ops, init.ops.ops);
    assert.deepEqual(verifyGraph(again), []);
    assert.equal(computeStatus(again, [rec(init)]).entries[0]!.state, "applied");
  }));

test("migrate split without --at makes one migration per operation", () =>
  withCtx(async (ctx) => {
    const [init] = await threeMigrations(ctx);
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({}, [init!.id]), ctx), 0, ctx.warns.join("\n"));
    const parts = (await readMigrations(ctx.migrationsDir)).filter((m) => m.id.includes("_init_part"));
    assert.equal(parts.length, init!.ops.ops.length);
    assert.ok(parts.every((p) => p.ops.ops.length === 1));
  }));

test("migrate split refuses an applied migration unless --baseline, and when ids do not fit", () =>
  withCtx(async (ctx) => {
    const ms = await threeMigrations(ctx);
    history(ctx, [rec(ms[0]!)]);
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({}, [ms[0]!.id]), ctx), 1);
    assert.match(ctx.warns.pop()!, /already applied.*--baseline/);
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({ baseline: true, at: "2" }, [ms[0]!.id]), ctx), 0, ctx.warns.join("\n"));
    const upserts = ctx.driver.executed.filter((e) => e.sql.startsWith('UPSERT "_HANA_ORM_MIGRATIONS"')).map((e) => e.params[0]);
    const parts = (await readMigrations(ctx.migrationsDir)).filter((m) => m.id.includes("_init_part")).map((m) => m.id);
    assert.equal(parts.length, 2);
    assert.deepEqual(upserts, parts);
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({}, ["nope"]), ctx), 1);
    assert.match(ctx.warns.pop()!, /Usage/);
  }));

test("migrate split refuses when the parts' ids would sort after the next migration", () =>
  withCtx(async (ctx) => {
    const t = new Date(Date.UTC(2026, 10, 18, 12, 0, 0));
    assert.equal(await migratePlan(args({ name: "init" }), ctx, () => t), 0);
    ctx.contract = contract([...Object.values(blogContract().models), tag]);
    // planned in the same second: gets the next second
    assert.equal(await migratePlan(args({ name: "tags" }), ctx, () => t), 0);
    const [init, tags] = (await readMigrations(ctx.migrationsDir)) as [LoadedMigration, LoadedMigration];
    assert.ok(init.ops.ops.length >= 3);
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({}, [init.id]), ctx), 1);
    assert.match(ctx.warns.pop()!, new RegExp(`sort after the next migration ${tags.id}`));
    // two parts still fit: ..._init_part2 sorts before ..._tags in the same second
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({ at: "2" }, [init.id]), ctx), 0, ctx.warns.join("\n"));
    assert.deepEqual(verifyGraph(await readMigrations(ctx.migrationsDir)), []);
  }));

test("migrate split refuses a single-operation migration", () =>
  withCtx(async (ctx) => {
    await threeMigrations(ctx);
    assert.equal(await migratePlan(args({ name: "empty", empty: true }), ctx, tick), 0);
    const last = (await readMigrations(ctx.migrationsDir)).at(-1)!;
    assert.equal(await runDbOrMigrateCommand("migrate", "split", args({}, [last.id]), ctx), 1);
    assert.match(ctx.warns.pop()!, /nothing to split/);
  }));

// ---- migrate show ---------------------------------------------------------------------------

test("migrate show <id> prints one migration without connecting", () =>
  withCtx(async (ctx) => {
    const ms = await threeMigrations(ctx);
    ctx.logs.length = 0;
    assert.equal(await runDbOrMigrateCommand("migrate", "show", args({}, ["show", ms[1]!.id.slice(0, 14)]), ctx), 0, ctx.warns.join("\n"));
    assert.equal(ctx.connects, 0);
    assert.match(ctx.logs.join("\n"), /CREATE COLUMN TABLE "TAGS"/);
    assert.doesNotMatch(ctx.logs.join("\n"), /"NOTES"/);
  }));
