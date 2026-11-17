import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckFailedError, computeStatus, deploy, deployBlockers, runOps } from "../../src/migrate/apply.ts";
import type { LoadedMigration } from "../../src/migrate/files.ts";
import type { HistoryRecord, HistoryStore, LockInfo, MarkerRecord } from "../../src/migrate/history.ts";
import { LockError, SqlHistoryStore } from "../../src/migrate/history.ts";
import type { Queryable } from "../../src/runtime/driver.ts";
import type { MigrationOp } from "../../src/migrate/ops.ts";
import { FakeDriver } from "./fixtures.ts";

/** In-memory store; writes made through a transaction are dropped if that transaction rolls back. */
class MemoryStore implements HistoryStore {
  records = new Map<string, HistoryRecord>();
  marker: MarkerRecord | null = null;
  lock: LockInfo | null = null;
  ensured = 0;
  locksTaken: string[] = [];
  private driver: FakeDriver;
  constructor(driver: FakeDriver) {
    this.driver = driver;
  }
  async ensureTables(): Promise<void> {
    this.ensured++;
  }
  async hasHistory(): Promise<boolean> {
    return true;
  }
  async acquireLock(owner: string): Promise<void> {
    if (this.lock) throw new LockError(this.lock);
    this.lock = { owner, lockedAt: new Date() };
    this.locksTaken.push(owner);
  }
  async releaseLock(owner: string): Promise<void> {
    if (this.lock?.owner === owner) this.lock = null;
  }
  async forceUnlock(): Promise<boolean> {
    const had = !!this.lock;
    this.lock = null;
    return had;
  }
  async list(): Promise<HistoryRecord[]> {
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  async record(q: Queryable, rec: HistoryRecord): Promise<void> {
    // route through the queryable so rollbacks discard it
    await q.execute(`-- history ${rec.id} ${rec.status}`);
    this.records.set(rec.id, rec);
  }
  async readMarker(): Promise<MarkerRecord | null> {
    return this.marker;
  }
  async writeMarker(q: Queryable, contractHash: string, migrationId: string | null): Promise<void> {
    await q.execute(`-- marker ${contractHash}`);
    this.marker = { contractHash, migrationId, updatedAt: new Date() };
  }
}

function op(sql: string, extra: Partial<MigrationOp> = {}): MigrationOp {
  return { kind: "createTable", description: sql, sql: [sql], ...extra };
}

function mig(id: string, from: string | null, to: string, ops: MigrationOp[], checksum = `sum-${id}`): LoadedMigration {
  return { id, name: id.split("_").slice(1).join("_"), dir: "/nonexistent", checksum, ops: { formatVersion: 1, id, name: id, from, to, ops } };
}

const chain = (): LoadedMigration[] => [
  mig("20260101000000_init", null, "A", [op('CREATE COLUMN TABLE "USERS" ("ID" INTEGER)')]),
  mig("20260102000000_posts", "A", "B", [op('CREATE COLUMN TABLE "POSTS" ("ID" INTEGER)'), op('CREATE INDEX "IX" ON "POSTS" ("ID")')]),
];

test("runOps runs pre-check, statements and post-check in order", async () => {
  const d = new FakeDriver();
  const queries: string[] = [];
  d.onQuery = (sql) => {
    queries.push(sql);
    return sql.includes("post") ? [{ X: 1 }] : [];
  };
  await runOps(d, [
    op("S1", { precheck: { description: "pre", sql: "pre", expect: "empty" }, postcheck: { description: "post", sql: "post", expect: "nonEmpty" } }),
    op("S2"),
  ]);
  assert.deepEqual(queries, ["pre", "post"]);
  assert.deepEqual(d.sql(), ["S1", "S2"]);
});

test("runOps stops on a failed pre-check without running SQL", async () => {
  const d = new FakeDriver();
  d.onQuery = () => [{ X: 1 }];
  await assert.rejects(runOps(d, [op("S1", { precheck: { description: "table T is empty", sql: "q", expect: "empty" } })]), (e: unknown) => {
    assert.ok(e instanceof CheckFailedError);
    assert.match((e as Error).message, /Pre-check failed for "S1": expected table T is empty/);
    return true;
  });
  assert.deepEqual(d.sql(), []);
});

test("runOps reports a failed post-check", async () => {
  const d = new FakeDriver();
  await assert.rejects(runOps(d, [op("S1", { postcheck: { description: "exists", sql: "q", expect: "nonEmpty" } })]), /Post-check failed/);
});

test("deploy applies pending migrations, each in its own transactional-DDL transaction", async () => {
  const d = new FakeDriver();
  const store = new MemoryStore(d);
  const logs: string[] = [];
  const r = await deploy(d, store, chain(), { log: (m) => logs.push(m) });
  assert.deepEqual(r, { applied: ["20260101000000_init", "20260102000000_posts"], failed: null, blockers: [] });
  assert.deepEqual(d.committed, [1, 2]);
  assert.deepEqual(d.txOptions, [{ transactionalDdl: true }, { transactionalDdl: true }]);
  assert.deepEqual(
    d.executed.map((e) => [e.tx, e.sql]),
    [
      [1, 'CREATE COLUMN TABLE "USERS" ("ID" INTEGER)'],
      [1, "-- history 20260101000000_init applied"],
      [1, "-- marker A"],
      [2, 'CREATE COLUMN TABLE "POSTS" ("ID" INTEGER)'],
      [2, 'CREATE INDEX "IX" ON "POSTS" ("ID")'],
      [2, "-- history 20260102000000_posts applied"],
      [2, "-- marker B"],
    ],
  );
  assert.equal(store.marker?.contractHash, "B");
  assert.equal(store.lock, null, "lock released");
  assert.equal(logs.length, 2);

  const again = await deploy(d, store, chain());
  assert.deepEqual(again.applied, []);
});

test("deploy rolls back a failed migration, records it as failed and stops", async () => {
  const d = new FakeDriver();
  const store = new MemoryStore(d);
  d.failOn = /CREATE INDEX/;
  const r = await deploy(d, store, [...chain(), mig("20260103000000_more", "B", "C", [op("S3")])]);
  assert.deepEqual(r.applied, ["20260101000000_init"]);
  assert.equal(r.failed?.id, "20260102000000_posts");
  assert.match(r.failed!.error, /fake failure/);
  assert.deepEqual(d.rolledBack, [2]);
  assert.ok(!d.sql().includes('CREATE COLUMN TABLE "POSTS" ("ID" INTEGER)'), "statements of the failed migration are rolled back");
  const failed = store.records.get("20260102000000_posts")!;
  assert.equal(failed.status, "failed");
  assert.match(failed.log!, /last statement:\nCREATE INDEX/);
  assert.equal(store.marker?.contractHash, "A");
  assert.equal(store.lock, null, "lock released after failure");

  // fixed: retry applies the failed one and the rest
  d.failOn = undefined;
  const retry = await deploy(d, store, [...chain(), mig("20260103000000_more", "B", "C", [op("S3")])]);
  assert.deepEqual(retry.applied, ["20260102000000_posts", "20260103000000_more"]);
  assert.equal(store.records.get("20260102000000_posts")!.status, "applied");
});

test("deploy refuses when an applied migration was modified (checksum mismatch)", async () => {
  const d = new FakeDriver();
  const store = new MemoryStore(d);
  await deploy(d, store, chain().slice(0, 1));
  const edited = chain();
  edited[0] = { ...edited[0]!, checksum: "changed" };
  const r = await deploy(d, store, edited);
  assert.deepEqual(r.applied, []);
  assert.equal(r.blockers.length, 1);
  assert.match(r.blockers[0]!, /20260101000000_init was changed after it was applied/);
});

test("deploy refuses diverged branches", async () => {
  const d = new FakeDriver();
  const store = new MemoryStore(d);
  const r = await deploy(d, store, [...chain(), mig("20260103000000_other_branch", "A", "X", [op("S")])]);
  assert.deepEqual(r.applied, []);
  assert.match(r.blockers.join("\n"), /20260103000000_other_branch starts from contract A but the previous migration 20260102000000_posts ends at B/);
  assert.deepEqual(d.sql(), []);
});

test("deploy reports a held lock with an unlock hint and does not release someone else's lock", async () => {
  const d = new FakeDriver();
  const store = new MemoryStore(d);
  store.lock = { owner: "other-host:1:ab", lockedAt: new Date(Date.now() - 60 * 60 * 1000) };
  await assert.rejects(deploy(d, store, chain()), (e: unknown) => {
    assert.ok(e instanceof LockError);
    assert.match((e as Error).message, /other-host:1:ab/);
    assert.match((e as Error).message, /looks stale/);
    assert.match((e as Error).message, /migrate unlock/);
    return true;
  });
  assert.equal(store.lock?.owner, "other-host:1:ab");
});

function rec(id: string, status: HistoryRecord["status"], checksum = `sum-${id}`, toHash = "?"): HistoryRecord {
  return { id, name: id, checksum, fromHash: null, toHash, startedAt: new Date(0), finishedAt: new Date(0), status, log: null };
}

test("computeStatus: applied, pending, failed, rolled back, modified, missing, out of order", () => {
  const ms = [
    mig("1_a", null, "A", []),
    mig("2_b", "A", "B", []),
    mig("3_c", "B", "C", []),
    mig("4_d", "C", "D", []),
    mig("5_e", "D", "E", []),
  ];
  const report = computeStatus(ms, [rec("1_a", "applied"), rec("2_b", "applied", "other", "B"), rec("3_c", "failed"), rec("4_d", "rolled_back"), rec("0_gone", "applied")]);
  assert.deepEqual(report.entries.map((e) => [e.id, e.state]), [
    ["1_a", "applied"],
    ["2_b", "modified"],
    ["3_c", "failed"],
    ["4_d", "rolled_back"],
    ["5_e", "pending"],
  ]);
  assert.deepEqual(report.missing.map((h) => h.id), ["0_gone"]);
  assert.deepEqual(report.pending.map((m) => m.id), ["3_c", "4_d", "5_e"]);
  const blockers = deployBlockers(report);
  assert.equal(blockers.length, 2);

  const ooo = computeStatus(ms.slice(0, 3), [rec("1_a", "applied"), rec("3_c", "applied", "sum-3_c", "C")]);
  assert.deepEqual(ooo.outOfOrder, ["2_b"]);
  assert.match(deployBlockers(ooo).join("\n"), /2_b is not applied but is older than the last applied migration 3_c/);
});

// ---- SqlHistoryStore -------------------------------------------------------------

test("SqlHistoryStore creates missing housekeeping tables in the given schema", async () => {
  const d = new FakeDriver();
  d.onQuery = (sql, params) => (sql.includes("SYS.TABLES") && params[1] === "_HANA_ORM_LOCK" ? [{ X: 1 }] : []);
  await new SqlHistoryStore(d, "APP").ensureTables();
  const sql = d.sql();
  assert.equal(sql.length, 2);
  assert.match(sql[0]!, /^CREATE COLUMN TABLE "APP"."_HANA_ORM_MIGRATIONS" \("ID" NVARCHAR\(255\) NOT NULL PRIMARY KEY/);
  assert.match(sql[1]!, /^CREATE COLUMN TABLE "APP"."_HANA_ORM_MARKER"/);
});

test("SqlHistoryStore writes history and marker with bound parameters", async () => {
  const d = new FakeDriver();
  const store = new SqlHistoryStore(d);
  const r = rec("20260101000000_init", "applied");
  await store.record(d, r);
  await store.writeMarker(d, "abc", "20260101000000_init");
  assert.equal(
    d.executed[0]!.sql,
    'UPSERT "_HANA_ORM_MIGRATIONS" ("ID", "NAME", "CHECKSUM", "FROM_HASH", "TO_HASH", "STARTED_AT", "FINISHED_AT", "STATUS", "LOG") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY',
  );
  assert.deepEqual(d.executed[0]!.params, [r.id, r.name, r.checksum, null, "?", r.startedAt, r.finishedAt, "applied", null]);
  assert.match(d.executed[1]!.sql, /^UPSERT "_HANA_ORM_MARKER" .* WITH PRIMARY KEY$/);
  assert.deepEqual(d.executed[1]!.params, ["abc", "20260101000000_init"]);
});

test("SqlHistoryStore lock: insert conflict becomes LockError; list parses rows", async () => {
  const d = new FakeDriver();
  d.failOn = /INSERT INTO "_HANA_ORM_LOCK"/;
  d.onQuery = (sql) => {
    if (sql.includes('FROM "_HANA_ORM_LOCK"')) return [{ LOCKED_BY: "h:1:x", LOCKED_AT: "2026-01-01 10:00:00.0000000" }];
    if (sql.includes("SYS.TABLES")) return [{ X: 1 }];
    if (sql.includes('FROM "_HANA_ORM_MIGRATIONS"'))
      return [{ ID: "1_a", NAME: "a", CHECKSUM: "c", FROM_HASH: null, TO_HASH: "A", STARTED_AT: "2026-01-01 10:00:00.1230000", FINISHED_AT: null, STATUS: "applied", LOG: null }];
    return [];
  };
  const store = new SqlHistoryStore(d);
  await assert.rejects(store.acquireLock("me"), (e: unknown) => {
    assert.ok(e instanceof LockError);
    assert.equal((e as LockError).lock.lockedAt.toISOString(), "2026-01-01T10:00:00.000Z");
    return true;
  });
  const list = await store.list();
  assert.equal(list[0]!.startedAt.toISOString(), "2026-01-01T10:00:00.123Z");
  assert.equal(list[0]!.finishedAt, null);
});
