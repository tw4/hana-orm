/** `$on` events, `$metrics` and the `log` option (issue #12). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import type { LogEvent, QueryLogEvent } from "../../src/runtime/events.ts";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";

function setup(options: Record<string, unknown> = {}) {
  const driver = new FakeDriver();
  const db = new HanaClient({ driver, ...options });
  const queries: QueryLogEvent[] = [];
  const logs: (LogEvent & { level: string })[] = [];
  db.$on("query", (e) => queries.push(e));
  for (const level of ["info", "warn", "error"] as const) db.$on(level, (e) => logs.push({ ...e, level }));
  return { driver, db, queries, logs };
}

test("query events carry SQL and duration but no parameter values by default", async () => {
  const { db, queries } = setup();
  await db.user.findMany({ where: { email: "secret@example.com" } });
  assert.equal(queries.length, 1);
  const q = queries[0]!;
  assert.match(q.sql, /^SELECT .* WHERE t0\."email" = \?/);
  assert.deepEqual(q.params, []);
  assert.equal(typeof q.durationMs, "number");
  assert.ok(q.timestamp instanceof Date);
  assert.equal(q.inTransaction, false);
  assert.equal(q.error, undefined);
});

test("logParams: true includes the values", async () => {
  const { db, queries } = setup({ logParams: true });
  await db.user.findMany({ where: { email: "a@example.com" } });
  assert.deepEqual(queries[0]!.params, ["a@example.com"]);
});

test("statements inside a transaction are reported with inTransaction", async () => {
  const { db, queries } = setup();
  await db.user.createMany({ data: [{ email: "a@example.com" }] });
  assert.ok(queries.length >= 1);
  assert.ok(queries.every((q) => q.inTransaction), "writes run in a transaction");
});

test("a failing statement is a query event with error, and the operation an error event", async () => {
  const { driver, db, queries, logs } = setup();
  driver.respond = (sql) => {
    if (sql.startsWith("SELECT")) throw new Error("boom");
    return undefined;
  };
  await assert.rejects(db.user.findMany(), /boom/);
  assert.equal(queries.at(-1)!.error, "boom");
  const err = logs.find((l) => l.level === "error")!;
  assert.equal(err.target, "User.findMany");
  assert.equal(err.message, "boom");
  await assert.rejects(db.$queryRawUnsafe("SELECT 1 FROM DUMMY"), /boom/);
  assert.equal(logs.filter((l) => l.level === "error").at(-1)!.target, "$queryRaw");
});

test("slowQueryThreshold emits warn events", async () => {
  const { db, logs } = setup({ slowQueryThreshold: 0 });
  await db.user.count();
  const warn = logs.find((l) => l.level === "warn")!;
  assert.equal(warn.target, "query");
  assert.match(warn.message, /^Slow query \(\d+\.\d ms\): SELECT COUNT/);
});

test("$on returns an unsubscribe function; a throwing listener does not break the query", async () => {
  const { db } = setup();
  let n = 0;
  const off = db.$on("query", () => n++);
  db.$on("query", () => {
    throw new Error("listener bug");
  });
  await db.user.count();
  off();
  await db.user.count();
  assert.equal(n, 1);
  assert.throws(() => db.$on("nope" as never, () => {}), /Unknown event 'nope'/);
});

test("$disconnect emits info", async () => {
  const { db, logs } = setup();
  await db.$connect();
  await db.$disconnect();
  assert.deepEqual(logs.filter((l) => l.level === "info").map((l) => l.message), ["Connected", "Disconnected; the connection pool is closed"]);
});

test("$metrics counts queries, failures, durations and transactions", async () => {
  const { driver, db } = setup();
  await db.user.findMany();
  await db.user.createMany({ data: [{ email: "a@example.com" }] });
  driver.batchCount = () => {
    throw new Error("dup");
  };
  await assert.rejects(db.user.createMany({ data: [{ email: "b@example.com" }] }), /dup/);
  const m = db.$metrics();
  assert.ok(m.queries.total >= 3);
  assert.equal(m.queries.failed, 1);
  assert.equal(m.queries.histogram.reduce((a, b) => a + b.count, 0), m.queries.total);
  assert.equal(m.queries.histogram.at(-1)!.le, Infinity);
  assert.ok(m.queries.durationMs.max >= 0 && m.queries.durationMs.avg >= 0);
  assert.deepEqual(m.transactions, { total: 2, committed: 1, rolledBack: 1 });
  assert.equal(m.pool, null, "the fake driver has no pool statistics");
});

test("the log option accepts levels and keeps the query-callback form without values", async () => {
  const seen: unknown[] = [];
  const db = new HanaClient({ driver: new FakeDriver(), log: (e) => seen.push(e) });
  await db.user.findMany({ where: { email: "x@example.com" } });
  assert.equal(seen.length, 1);
  assert.deepEqual((seen[0] as { params: unknown[] }).params, []);

  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (s: string) => void lines.push(s);
  console.warn = (s: string) => void lines.push(s);
  try {
    const db2 = new HanaClient({ driver: new FakeDriver(), log: ["query", "warn"], slowQueryThreshold: 0 });
    await db2.user.count();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
  }
  assert.ok(lines.some((l) => /^hana-orm:query SELECT COUNT/.test(l)));
  assert.ok(lines.some((l) => /^hana-orm:warn \[query\] Slow query/.test(l)));
});

test("HanaDriver.stats reports the pool", async () => {
  const module = {
    createConnection: () => ({
      connect: (_o: unknown, cb: (e: Error | null) => void) => cb(null),
      exec: (_s: string, _p: unknown, cb: (e: Error | null, r: unknown) => void) => setTimeout(() => cb(null, []), 5),
      prepare: () => {},
      setAutoCommit: () => {},
      commit: (cb: (e: Error | null) => void) => cb(null),
      rollback: (cb: (e: Error | null) => void) => cb(null),
      disconnect: (cb: (e: Error | null) => void) => cb(null),
    }),
  };
  const d = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 2, hanaModule: module });
  assert.deepEqual(d.stats(), { size: 2, open: 0, idle: 0, busy: 0, waiting: 0 });
  const a = d.query("A");
  const b = d.query("B");
  const c = d.query("C");
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(d.stats(), { size: 2, open: 2, idle: 0, busy: 2, waiting: 1 });
  await Promise.all([a, b, c]);
  assert.deepEqual(d.stats(), { size: 2, open: 2, idle: 2, busy: 0, waiting: 0 });
  await d.close();
});
