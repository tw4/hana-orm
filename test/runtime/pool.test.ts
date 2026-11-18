/** HanaDriver pool: idle checks, dropped connections, statement timeouts and shutdown (issue #15). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaDriver, isConnectionLost } from "../../src/runtime/hana-driver.ts";
import type { HanaDriverOptions } from "../../src/runtime/hana-driver.ts";
import { DatabaseError, QueryTimeoutError } from "../../src/runtime/errors.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Conn {
  id: number;
  /** false: every exec fails with "connection down" (-10807), like after a database restart. */
  alive: boolean;
  disconnected: boolean;
  execs: string[];
  rolledBack: number;
  committed: number;
}

/**
 * Fake `@sap/hana-client`. `behave(sql, conn)` decides per statement: a number delays the answer,
 * "hang" never answers, "lost" fails with -10807 and kills the connection.
 */
function fakeHana(behave: (sql: string, conn: Conn) => number | "hang" | "lost" | void = () => {}) {
  const conns: Conn[] = [];
  const module = {
    createConnection() {
      const c: Conn = { id: conns.length + 1, alive: true, disconnected: false, execs: [], rolledBack: 0, committed: 0 };
      conns.push(c);
      return {
        connect: (_o: unknown, cb: (e: Error | null) => void) => cb(null),
        exec: (sql: string, _p: unknown, cb: (e: Error | null, r: unknown) => void) => {
          c.execs.push(sql);
          const lost = () => cb(Object.assign(new Error("Connection down"), { code: -10807 }), undefined);
          if (!c.alive || c.disconnected) return void setImmediate(lost);
          const b = behave(sql, c);
          if (b === "hang") return;
          if (b === "lost") {
            c.alive = false;
            return void setImmediate(lost);
          }
          setTimeout(() => cb(null, [{ CONN: c.id }]), typeof b === "number" ? b : 0);
        },
        prepare: () => {},
        setAutoCommit: () => {},
        commit: (cb: (e: Error | null) => void) => (c.committed++, cb(null)),
        rollback: (cb: (e: Error | null) => void) => (c.rolledBack++, cb(null)),
        disconnect: (cb: (e: Error | null) => void) => ((c.disconnected = true), cb(null)),
      };
    },
  };
  return { conns, module };
}

function driver(module: unknown, options: HanaDriverOptions = {}) {
  return new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, hanaModule: module, ...options });
}

const userSql = (c: Conn) => c.execs.filter((s) => s !== "SELECT 1 FROM DUMMY");

test("an idle connection that died is detected by the check and replaced", async () => {
  const { conns, module } = fakeHana();
  const d = driver(module, { idleCheckAfter: 0 });
  assert.deepEqual(await d.query("SELECT A FROM T"), [{ CONN: 1 }]);
  conns[0]!.alive = false; // e.g. the database restarted while the connection was idle
  assert.deepEqual(await d.query("SELECT A FROM T"), [{ CONN: 2 }]);
  assert.ok(conns[0]!.disconnected, "the dead connection is closed");
  assert.deepEqual(userSql(conns[0]!), ["SELECT A FROM T"], "the statement never ran on the dead connection");
  assert.equal(d.size, 1);
  await d.close();
});

test("a recently used connection is not checked", async () => {
  const { conns, module } = fakeHana();
  const d = driver(module, { idleCheckAfter: 60_000 });
  await d.query("SELECT 1 FROM T");
  await d.query("SELECT 2 FROM T");
  assert.deepEqual(conns[0]!.execs, ["SELECT 1 FROM T", "SELECT 2 FROM T"]);
  await d.close();
});

test("query is retried once on a new connection when its connection is lost", async () => {
  let first = true;
  const { conns, module } = fakeHana((sql) => {
    if (sql === "SELECT A FROM T" && first) {
      first = false;
      return "lost";
    }
  });
  const d = driver(module, { idleCheckAfter: 60_000 });
  assert.deepEqual(await d.query("SELECT A FROM T"), [{ CONN: 2 }]);
  assert.ok(conns[0]!.disconnected);
  assert.equal(d.size, 1, "the lost connection freed its slot");
  await d.close();
});

test("a lost connection fails execute and transactions without a retry, and is not reused", async () => {
  const { conns, module } = fakeHana((sql) => (sql.startsWith("UPDATE") ? "lost" : undefined));
  const d = driver(module, { idleCheckAfter: 60_000 });
  await assert.rejects(d.execute("UPDATE T SET A = 1"), (e: unknown) => e instanceof DatabaseError && e.hanaCode === -10807 && isConnectionLost(e));
  assert.equal(conns.length, 1, "no retry for writes");
  assert.ok(conns[0]!.disconnected);
  await assert.rejects(d.transaction((tx) => tx.execute("UPDATE T SET A = 2")), DatabaseError);
  assert.equal(conns.length, 2);
  assert.ok(conns[1]!.disconnected);
  assert.deepEqual(await d.query("SELECT 1 FROM T"), [{ CONN: 3 }], "the pool recovers");
  await d.close();
});

test("a waiter gets a fresh connection when the busy one breaks", async () => {
  const { conns, module } = fakeHana((sql) => (sql === "BREAK" ? "lost" : 5));
  const d = driver(module, { idleCheckAfter: 60_000 });
  const breaking = d.execute("BREAK").catch((e) => e);
  const waiting = d.query("SELECT 1 FROM T");
  assert.ok((await breaking) instanceof DatabaseError);
  assert.deepEqual(await waiting, [{ CONN: 2 }]);
  assert.equal(conns.length, 2);
  await d.close();
});

test("statementTimeout fails the statement, closes its connection and the pool goes on", async () => {
  const { conns, module } = fakeHana((sql) => (sql.startsWith("SLOW") ? "hang" : undefined));
  const d = driver(module, { statementTimeout: 20, idleCheckAfter: 60_000 });
  const started = performance.now();
  await assert.rejects(d.query("SLOW SELECT"), (e: unknown) => e instanceof QueryTimeoutError && e.code === "QUERY_TIMEOUT" && e.timeoutMs === 20 && e.sql === "SLOW SELECT");
  assert.ok(performance.now() - started < 1000);
  assert.ok(conns[0]!.disconnected, "closing the connection stops the statement on the server");
  assert.equal(conns.length, 1, "a timed-out read is not retried");
  assert.deepEqual(await d.query("SELECT 1 FROM T"), [{ CONN: 2 }]);
  await d.close();
});

test("statementTimeout inside a transaction ends it without using the killed connection", async () => {
  const { conns, module } = fakeHana((sql) => (sql.startsWith("SLOW") ? "hang" : undefined));
  const d = driver(module, { statementTimeout: 20 });
  await assert.rejects(
    d.transaction(async (tx) => {
      await tx.execute("INSERT INTO T VALUES (1)");
      await tx.execute("SLOW UPDATE");
    }),
    QueryTimeoutError,
  );
  assert.equal(conns[0]!.committed, 0);
  assert.equal(conns[0]!.rolledBack, 0, "the server rolls back when the session ends");
  assert.ok(conns[0]!.disconnected);
  assert.equal(d.size, 0);
  await d.close();
});

test("statementTimeout also limits batches", async () => {
  const { module } = fakeHana();
  const conns: { disconnected: boolean }[] = [];
  const hanging = {
    createConnection() {
      const real = module.createConnection();
      const state = { disconnected: false };
      conns.push(state);
      return { ...real, prepare: (_sql: string, cb: (e: Error | null, s: unknown) => void) => cb(null, { execBatch: () => {}, drop: (cb2: (e: Error | null) => void) => cb2(null) }), disconnect: (cb: (e: Error | null) => void) => ((state.disconnected = true), cb(null)) };
    },
  };
  const d = driver(hanging, { statementTimeout: 20 });
  await assert.rejects(d.executeBatch("INSERT INTO T VALUES (?)", [[1], [2]]), QueryTimeoutError);
  assert.ok(conns[0]!.disconnected);
  await d.close();
});

test("connections idle longer than idleTimeout are closed", async () => {
  const { conns, module } = fakeHana();
  const d = driver(module, { idleTimeout: 20, idleCheckAfter: 60_000 });
  await d.query("SELECT 1 FROM T");
  assert.equal(d.idleCount, 1);
  await sleep(40);
  assert.deepEqual(await d.query("SELECT 1 FROM T"), [{ CONN: 2 }]);
  assert.ok(conns[0]!.disconnected);
  assert.equal(d.size, 1);
  await d.close();
});

test("close waits for running statements, fails queued requests and refuses new ones", async () => {
  const { conns, module } = fakeHana(() => 30);
  const d = driver(module);
  const running = d.query("SELECT 1 FROM T");
  const queued = d.query("SELECT 2 FROM T").catch((e: Error) => e);
  await sleep(1);
  await d.close();
  assert.deepEqual(await running, [{ CONN: 1 }], "the running statement finished");
  assert.match(String(await queued), /disconnected/);
  assert.ok(conns[0]!.disconnected);
  assert.equal(d.size, 0);
  await assert.rejects(d.query("SELECT 3 FROM T"), /disconnected/);
  await d.close(); // idempotent
});

test("close cuts off statements still running after closeTimeout", async () => {
  const { conns, module } = fakeHana(() => "hang");
  const d = driver(module, { closeTimeout: 20 });
  const running = d.query("SELECT 1 FROM T").catch((e: Error) => e);
  await sleep(1);
  const started = performance.now();
  await d.close();
  assert.ok(performance.now() - started < 1000);
  assert.ok(conns[0]!.disconnected);
  assert.equal(d.size, 0);
  void running; // never answered by the fake; the connection is closed
});
