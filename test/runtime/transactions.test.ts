import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient, type HanaClientTransaction } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";
import { TransactionError, ValidationError } from "../../src/runtime/errors.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FakeDriver whose statements can be slowed down. */
class SlowDriver extends FakeDriver {
  delay = 0;
  constructor() {
    super();
    const respond = this.respond;
    this.respond = (sql, params) => respond(sql, params);
  }
  override async transaction<T>(fn: Parameters<FakeDriver["transaction"]>[0] extends (tx: infer Q) => Promise<unknown> ? (tx: Q) => Promise<T> : never): Promise<T> {
    return super.transaction(async (q) =>
      fn({
        query: async (sql, params) => (await sleep(this.delay), q.query(sql, params)),
        execute: async (sql, params) => (await sleep(this.delay), q.execute(sql, params)),
        executeBatch: (sql, rows) => q.executeBatch(sql, rows),
      } as typeof q),
    );
  }
}

function setup(driver = new FakeDriver(), options: ConstructorParameters<typeof HanaClient>[0] = {}) {
  driver.respond = (sql) => (sql.includes("CURRENT_IDENTITY_VALUE") ? [{ ID: 7 }] : sql.startsWith("SELECT") ? [{ id: 7, email: "a@x" }] : 1);
  return { driver, db: new HanaClient({ ...options, driver }) };
}

test("model methods are lazy: nothing runs until the result is awaited", async () => {
  const { driver, db } = setup();
  const p = db.user.findMany();
  await sleep(5);
  assert.equal(driver.calls.length, 0);
  await p;
  assert.equal(driver.calls.length, 1);
  await p; // awaiting again does not run it again
  assert.equal(driver.calls.length, 1);
});

test("$transaction([...]) runs the queries in order in one transaction and returns their results", async () => {
  const { driver, db } = setup();
  const [users, n, raw] = await db.$transaction([db.user.findMany(), db.user.count(), db.$executeRaw`UPDATE "APP"."USERS" SET "visits" = ${1}`]);
  assert.equal(driver.transactions, 1);
  assert.ok(driver.calls.every((c) => c.tx), "every statement ran in the transaction");
  assert.deepEqual(users.map((u) => [u.id, u.email]), [[7, "a@x"]]);
  assert.equal(typeof n, "number");
  assert.equal(raw, 1);
  assert.match(driver.calls.at(-1)!.sql, /^UPDATE "APP"."USERS"/);
});

test("$transaction([...]) rolls back when one query fails and rejects foreign or started items", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.startsWith("DELETE")) throw new Error("boom");
    return sql.startsWith("SELECT") ? [] : 1;
  };
  await assert.rejects(db.$transaction([db.user.findMany(), db.user.deleteMany({}), db.user.count()]), /boom/);
  assert.equal(driver.rolledBack, 1);
  assert.equal(driver.calls.filter((c) => c.sql.includes("COUNT")).length, 0, "queries after the failing one do not run");

  await assert.rejects(db.$transaction([Promise.resolve(1)]), ValidationError);
  const started = db.user.findMany();
  await started;
  await assert.rejects(db.$transaction([started]), /already awaited/);
});

test("a transaction that runs longer than timeout rejects, refuses further queries and rolls back", async () => {
  const driver = new SlowDriver();
  const { db } = setup(driver);
  driver.delay = 30;
  let later: unknown;
  const started = Date.now();
  await assert.rejects(
    db.$transaction(
      async (tx) => {
        await tx.user.findMany();
        await tx.user.findMany();
        try {
          await tx.user.findMany();
        } catch (e) {
          later = e;
        }
      },
      { timeout: 40 },
    ),
    (e: unknown) => e instanceof TransactionError && e.code === "TRANSACTION_TIMEOUT",
  );
  assert.ok(Date.now() - started < 60, "rejects at the timeout, not when the running statement ends");
  await sleep(80);
  assert.equal(driver.rolledBack, 1, "rolled back after the running statement finished");
  assert.ok(later instanceof TransactionError && later.code === "TRANSACTION_TIMEOUT", "queries after the timeout fail");
  assert.equal(driver.calls.length, 2);
});

test("a callback that ignores the timeout and returns later still does not commit", async () => {
  const driver = new SlowDriver();
  const { db } = setup(driver);
  const p = db.$transaction(async () => {
    await sleep(40);
    return "done";
  }, { timeout: 10 });
  await assert.rejects(p, /timed out after 10 ms/);
  await sleep(50);
  assert.equal(driver.rolledBack, 1);
});

test("timeout defaults come from the client options; 0 disables the limit; a tx client cannot be used after the end", async () => {
  const driver = new SlowDriver();
  const { db } = setup(driver, { transactionOptions: { timeout: 10 } });
  driver.delay = 20;
  await assert.rejects(db.$transaction((tx) => tx.user.findMany()), TransactionError);
  await sleep(30);
  assert.equal((await db.$transaction((tx) => tx.user.findMany(), { timeout: 0 }))[0]!.id, 7);

  let leaked: HanaClientTransaction | undefined;
  await db.$transaction(async (tx) => void (leaked = tx), { timeout: 0 });
  await assert.rejects(leaked!.user.findMany(), (e: unknown) => e instanceof TransactionError && e.code === "TRANSACTION_CLOSED");
});

test("nested $transaction reuses the outer transaction, also with an array", async () => {
  const { driver, db } = setup();
  // nested $transaction is not in the transaction client's type, but works at runtime
  const r = await db.$transaction(async (tx) => (tx as unknown as typeof db).$transaction([tx.user.count(), tx.user.findMany()]));
  assert.equal(driver.transactions, 1);
  assert.equal(r.length, 2);
});

// ---- HanaDriver pool: maxWait and connection release -----------------------------------

interface FakeConn {
  id: number;
  rolledBack: number;
  committed: number;
  disconnected: boolean;
}

function fakeHana(execDelay = 0) {
  const conns: FakeConn[] = [];
  const module = {
    createConnection() {
      const state: FakeConn = { id: conns.length + 1, rolledBack: 0, committed: 0, disconnected: false };
      conns.push(state);
      return {
        connect: (_o: unknown, cb: (e: Error | null) => void) => cb(null),
        exec: (_sql: string, _p: unknown, cb: (e: Error | null, r: unknown) => void) => void setTimeout(() => cb(null, [{ X: state.id }]), execDelay),
        prepare: () => {},
        setAutoCommit: () => {},
        commit: (cb: (e: Error | null) => void) => (state.committed++, cb(null)),
        rollback: (cb: (e: Error | null) => void) => (state.rolledBack++, cb(null)),
        disconnect: (cb: (e: Error | null) => void) => ((state.disconnected = true), cb(null)),
      };
    },
  };
  return { conns, module };
}

test("HanaDriver: maxWait fails a transaction when the pool stays busy, and the waiting queue recovers", async () => {
  const { conns, module } = fakeHana();
  const driver = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, hanaModule: module });
  let release!: () => void;
  const holding = driver.transaction(() => new Promise<void>((r) => (release = r)));
  await sleep(1);
  await assert.rejects(driver.transaction(async () => 1, { maxWait: 20 }), (e: unknown) => e instanceof TransactionError && e.code === "TRANSACTION_MAX_WAIT");
  const waiting = driver.transaction(async (tx) => tx.query("SELECT 1 FROM DUMMY"), { maxWait: 1000 });
  release();
  await holding;
  assert.deepEqual(await waiting, [{ X: 1 }], "the released connection goes to the next waiter");
  assert.equal(conns.length, 1);
  await driver.close();
});

test("HanaDriver + client: a timed-out transaction is rolled back and its connection is reused", async () => {
  const { conns, module } = fakeHana(30);
  const driver = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, hanaModule: module });
  const db = new HanaClient({ driver });
  await assert.rejects(db.$transaction((tx) => tx.$queryRawUnsafe("SELECT 1 FROM DUMMY"), { timeout: 10 }), TransactionError);
  assert.deepEqual(await db.$queryRawUnsafe("SELECT 1 FROM DUMMY"), [{ X: 1 }], "the same connection serves the next query");
  assert.equal(conns.length, 1);
  assert.equal(conns[0]!.rolledBack, 1);
  assert.equal(conns[0]!.committed, 0);
  await driver.close();
});
