/** `$batch` (issue #32). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient, tables, eq } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";
import type { Queryable, TransactionOptions } from "../../src/runtime/driver.ts";

const { user, post } = tables;

/** FakeDriver plus per-row batch counts. */
class CountingDriver extends FakeDriver {
  batches: { sql: string; rows: unknown[][] }[] = [];
  async executeBatchCounts(sql: string, rows: readonly (readonly unknown[])[]): Promise<number[]> {
    this.batches.push({ sql, rows: rows.map((r) => [...r]) });
    return rows.map((r) => Number(r.at(-1)) % 2); // pretend: odd ids match one row
  }
  // like HanaDriver: the transaction's connection can run batches with per-row counts
  override transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T> {
    void options;
    return super.transaction((tx) => fn({ ...tx, executeBatchCounts: (sql, rows) => this.executeBatchCounts(sql, rows) }));
  }
}

test("$batch runs items in one transaction and returns a typed tuple", async () => {
  const driver = new CountingDriver();
  driver.respond = (sql) => (sql.startsWith("SELECT COUNT") ? [{ _count: 3 }] : sql.startsWith("SELECT") ? [{ id: 1 }] : 1);
  const db = new HanaClient({ driver });
  const [n, rows, updated, raw] = await db.$batch([
    db.user.count(),
    db.select({ id: user.id }).from(user),
    db.update(post).set({ published: true }).where(eq(post.id, 1)),
    db.$executeRawUnsafe("UPDATE X SET Y = 1"),
  ]);
  const typed: [number, { id: number }[], number, number] = [n, rows, updated, raw];
  void typed;
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(updated, 1);
  assert.equal(raw, 1);
  assert.equal(driver.transactions, 1);
  assert.ok(driver.calls.every((c) => c.tx), "everything ran on the transaction's connection");
});

test("consecutive identical builder updates go as one batch with per-item counts", async () => {
  const driver = new CountingDriver();
  const db = new HanaClient({ driver });
  const ids = [1, 2, 3, 4];
  const results = await db.$batch([
    ...ids.map((id) => db.update(post).set({ title: `t${id}` }).where(eq(post.id, id))),
    db.delete(post).where(eq(post.id, 9)),
    db.delete(post).where(eq(post.id, 11)),
  ]);
  assert.equal(driver.batches.length, 2, "one batch for the updates, one for the deletes");
  assert.match(driver.batches[0]!.sql, /^UPDATE "APP"\."Post" "post" SET "title" = \? WHERE "post"\."id" = \?$/);
  assert.deepEqual(driver.batches[0]!.rows, [["t1", 1], ["t2", 2], ["t3", 3], ["t4", 4]]);
  assert.deepEqual(driver.batches[1]!.rows, [[9], [11]]);
  assert.deepEqual(results, [1, 0, 1, 0, 1, 1]);
  assert.equal(driver.calls.filter((c) => c.sql.startsWith("UPDATE") || c.sql.startsWith("DELETE")).length, 0, "no single statements");
});

test("different statements, or a driver without per-row counts, run one by one", async () => {
  const driver = new FakeDriver();
  driver.respond = () => 2;
  const db = new HanaClient({ driver });
  const results = await db.$batch([
    db.update(post).set({ title: "a" }).where(eq(post.id, 1)),
    db.update(post).set({ title: "b" }).where(eq(post.id, 2)),
    db.update(post).set({ published: true }).where(eq(post.id, 3)),
    db.insert(user).values({ email: "a@x" }),
  ]);
  assert.deepEqual(results, [2, 2, 2, 1]);
  assert.equal(driver.calls.filter((c) => c.sql.startsWith("UPDATE")).length, 3);
});

test("a failing item rolls the whole batch back", async () => {
  const driver = new FakeDriver();
  driver.respond = (sql) => {
    if (sql.startsWith("DELETE")) throw new Error("boom");
    return 1;
  };
  const db = new HanaClient({ driver });
  await assert.rejects(db.$batch([db.update(post).set({ title: "a" }).where(eq(post.id, 1)), db.delete(post).where(eq(post.id, 2))]), /boom/);
  assert.equal(driver.rolledBack, 1);
});

test("$batch rejects items that are not queries of the client", async () => {
  const db = new HanaClient({ driver: new FakeDriver() });
  await assert.rejects(db.$batch([Promise.resolve(1)]), /item 0 is not one/);
});

test("HanaDriver.executeBatchCounts returns the per-row counts of execBatch", async () => {
  const module = {
    createConnection: () => ({
      connect: (_o: unknown, cb: (e: Error | null) => void) => cb(null),
      exec: () => {},
      prepare: (_sql: string, cb: (e: Error | null, s: unknown) => void) =>
        cb(null, { execBatch: (rows: unknown[][], cb2: (e: Error | null, r: unknown) => void) => cb2(null, rows.map((_, i) => (i === 1 ? -2 : i))), drop: (cb2: (e: Error | null) => void) => cb2(null) }),
      setAutoCommit: () => {},
      commit: (cb: (e: Error | null) => void) => cb(null),
      rollback: (cb: (e: Error | null) => void) => cb(null),
      disconnect: (cb: (e: Error | null) => void) => cb(null),
    }),
  };
  const d = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, hanaModule: module });
  assert.deepEqual(await d.executeBatchCounts("UPDATE T SET A = ? WHERE B = ?", [[1, 1], [2, 2], [3, 3]]), [0, -1, 2]);
  assert.equal(await d.executeBatch("UPDATE T SET A = ? WHERE B = ?", [[1, 1], [2, 2], [3, 3]]), 3, "the total still counts unknown rows as one");
  await d.close();
});
