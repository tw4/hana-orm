/** Query plan cache and prepared statement reuse (issue #14). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { planKey } from "../../src/runtime/plan-cache.ts";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";
import type { BaseClient } from "../../src/runtime/client.ts";

const stats = (db: unknown) => (db as BaseClient)._engine().planCacheStats();
const model = (db: unknown, name: string) => (db as BaseClient)._shared.contract.models[name]!;

/** Queries whose SQL must not change with the cache. */
const QUERIES: [string, (db: HanaClient) => Promise<unknown>][] = [
  ["findUnique by id", (db) => db.user.findUnique({ where: { id: 7 } })],
  ["findUnique by email", (db) => db.user.findUnique({ where: { email: "a@example.com" } })],
  ["findMany equality + order + take", (db) => db.user.findMany({ where: { active: true, role: "ADMIN" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 10, skip: 20 })],
  ["findMany select", (db) => db.user.findMany({ select: { id: true, email: true } })],
  ["findMany omit", (db) => db.user.findMany({ omit: { balance: true } })],
  ["findFirst date", (db) => db.user.findFirst({ where: { createdAt: new Date("2026-01-01T00:00:00Z") } })],
  ["findMany bigint", (db) => db.user.findMany({ where: { visits: 5n } })],
  ["negative take", (db) => db.user.findMany({ take: -3 })],
  ["filter (not cached)", (db) => db.user.findMany({ where: { email: { contains: "x" } } })],
  ["null (not cached)", (db) => db.user.findMany({ where: { name: null } })],
  ["include (not cached)", (db) => db.user.findMany({ include: { posts: true } })],
];

test("cached plans produce exactly the SQL and parameters of the builder", async () => {
  const plain = new FakeDriver();
  const cached = new FakeDriver();
  const a = new HanaClient({ driver: plain, planCacheSize: 0 });
  const b = new HanaClient({ driver: cached });
  for (const [, run] of QUERIES) {
    await run(a);
    await run(b); // compiles and caches
    await run(b); // served from the cache
  }
  const sqlOf = (d: FakeDriver) => d.calls.map((c) => [c.sql, JSON.stringify(c.params, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))]);
  assert.equal(cached.calls.length, plain.calls.length * 2);
  // compare query by query: the cached client's statements are the plain ones, each twice
  const perQuery = (d: FakeDriver, runs: number) => {
    const out: string[][] = [];
    let k = 0;
    for (let q = 0; q < QUERIES.length; q++) {
      for (let r = 0; r < runs; r++) {
        const stmts: string[] = [];
        // one statement each (no rows come back, so include loads nothing more)
        stmts.push(JSON.stringify(sqlOf(d)[k++]));
        out.push(stmts);
      }
    }
    return out;
  };
  const plainRuns = perQuery(plain, 1);
  const cachedRuns = perQuery(cached, 2);
  for (let q = 0; q < QUERIES.length; q++) {
    assert.deepEqual(cachedRuns[q * 2], plainRuns[q], `${QUERIES[q]![0]}: first run`);
    assert.deepEqual(cachedRuns[q * 2 + 1], plainRuns[q], `${QUERIES[q]![0]}: cached run`);
  }
  const s = stats(b);
  assert.equal(s.hits, 8, "the 8 cacheable shapes were served from the cache the second time");
  assert.equal(s.size, 8);
  assert.ok(s.uncacheable >= 6);
});

test("planKey accepts only value-independent shapes", () => {
  const db = new HanaClient({ driver: new FakeDriver() });
  const user = model(db, "User");
  assert.ok(planKey(user, { where: { id: 1 } }));
  assert.equal(planKey(user, { where: { id: 1 } })!.key, planKey(user, { where: { id: 2 } })!.key, "values are not part of the key");
  assert.notEqual(planKey(user, { where: { id: 1 }, take: 1 })!.key, planKey(user, { where: { id: 1 }, take: 2 })!.key, "take is in the SQL text");
  assert.notEqual(planKey(user, { where: { id: 1, email: "a" } })!.key, planKey(user, { where: { email: "a", id: 1 } })!.key, "key order is parameter order");
  for (const args of [
    { where: { id: null } },
    { where: { id: { gt: 1 } } },
    { where: { OR: [{ id: 1 }] } },
    { where: { posts: { some: {} } } },
    { include: { posts: true } },
    { select: { posts: true } },
    { select: { _count: true } },
    { orderBy: { posts: { _count: "desc" } } },
    { orderBy: { id: { sort: "asc", nulls: "last" } } },
    { cursor: { id: 1 } },
    { distinct: ["email"] },
    { take: 1.5 },
  ]) {
    assert.equal(planKey(user, args as never), null, JSON.stringify(args));
  }
});

test("the cache is an LRU of the configured size and can be turned off", async () => {
  const db = new HanaClient({ driver: new FakeDriver(), planCacheSize: 2 });
  await db.user.findMany({ where: { id: 1 } });
  await db.user.findMany({ where: { email: "a" } });
  await db.user.findMany({ where: { id: 2 } }); // hit, now most recent
  await db.user.findMany({ where: { name: "x" } }); // evicts the email shape
  await db.user.findMany({ where: { email: "b" } }); // miss again
  assert.deepEqual(stats(db), { size: 2, hits: 1, misses: 4, uncacheable: 0 });
  const off = new HanaClient({ driver: new FakeDriver(), planCacheSize: 0 });
  await off.user.findMany({ where: { id: 1 } });
  await off.user.findMany({ where: { id: 1 } });
  assert.deepEqual(stats(off), { size: 0, hits: 0, misses: 0, uncacheable: 0 });
});

test("statementCacheSize reuses prepared statements per connection", async () => {
  const log: string[] = [];
  let failNext = false;
  const module = {
    createConnection: () => ({
      connect: (_o: unknown, cb: (e: Error | null) => void) => cb(null),
      exec: (sql: string, _p: unknown, cb: (e: Error | null, r: unknown) => void) => (log.push(`exec ${sql}`), cb(null, [])),
      prepare: (sql: string, cb: (e: Error | null, s: unknown) => void) => {
        log.push(`prepare ${sql}`);
        cb(null, {
          exec: (params: unknown[], cb2: (e: Error | null, r: unknown) => void) => {
            log.push(`run ${sql} ${JSON.stringify(params)}`);
            if (failNext) {
              failNext = false;
              return cb2(Object.assign(new Error("invalid table name"), { code: 259 }), undefined);
            }
            cb2(null, [{ X: 1 }]);
          },
          execBatch: () => {},
          drop: (cb2: (e: Error | null) => void) => (log.push(`drop ${sql}`), cb2(null)),
        });
      },
      setAutoCommit: () => {},
      commit: (cb: (e: Error | null) => void) => cb(null),
      rollback: (cb: (e: Error | null) => void) => cb(null),
      disconnect: (cb: (e: Error | null) => void) => cb(null),
    }),
  };
  const d = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, statementCacheSize: 2, hanaModule: module });
  await d.query("A", [1]);
  await d.query("A", [2]);
  await d.query("B");
  await d.query("C"); // evicts A
  await d.query("A", [3]);
  assert.deepEqual(log, ["prepare A", "run A [1]", "run A [2]", "prepare B", "run B []", "prepare C", "drop A", "run C []", "prepare A", "drop B", "run A [3]"]);
  log.length = 0;
  failNext = true;
  await assert.rejects(d.query("A", [4]), /invalid table name/);
  await d.query("A", [5]);
  assert.deepEqual(log, ["run A [4]", "drop A", "prepare A", "run A [5]"], "a failed statement is prepared again");
  await d.close();

  // off by default: plain exec
  log.length = 0;
  const plain = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, hanaModule: module });
  await plain.query("A", [1]);
  assert.deepEqual(log, ["exec A"]);
  await plain.close();
});
