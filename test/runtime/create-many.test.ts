import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { ValidationError } from "../../src/runtime/errors.ts";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";

function setup() {
  const driver = new FakeDriver();
  const db = new HanaClient({ driver });
  return { driver, db };
}

test("createMany with skipDuplicates inserts only rows that match no primary key or unique", async () => {
  const { driver, db } = setup();
  await db.user.createMany({ skipDuplicates: true, data: [{ email: "a@example.com" }, { email: "b@example.com" }] });
  const inserts = driver.calls.filter((c) => c.sql.startsWith("INSERT"));
  assert.equal(inserts.length, 2);
  // the identity column is not set, so only the email unique is checked
  assert.match(
    inserts[0]!.sql,
    /^INSERT INTO "APP"\."USERS" \(.*"email".*\) SELECT \?(, \?)* FROM DUMMY WHERE NOT EXISTS \(SELECT 1 FROM "APP"\."USERS" WHERE \("email" = \?\)\)$/,
  );
  assert.equal(inserts[0]!.params.at(-1), "a@example.com");
  assert.ok(inserts.every((c) => c.tx), "runs in a transaction");
});

test("skipDuplicates checks the primary key and every unique whose fields are all set", async () => {
  const { driver, db } = setup();
  await db.user.createMany({ skipDuplicates: true, data: [{ id: 7, email: "a@example.com" }] });
  const sql = driver.calls.find((c) => c.sql.startsWith("INSERT"))!.sql;
  assert.match(sql, /WHERE \("id" = \?\) OR \("email" = \?\)\)$/);
  driver.calls = [];
  await db.postTag.createMany({ skipDuplicates: true, data: { postId: 1, tagName: "x" } });
  assert.match(driver.calls[0]!.sql, /WHERE \("postId" = \? AND "tagName" = \?\)\)$/);
  assert.deepEqual(driver.calls[0]!.params, [1, "x", 1, "x"]);
});

test("skipDuplicates on a model without a usable unique is a plain insert", async () => {
  const { driver, db } = setup();
  await db.post.createMany({ skipDuplicates: true, data: [{ title: "t" }] });
  assert.match(driver.calls[0]!.sql, /^INSERT INTO "APP"\."Post" \(.*\) VALUES \(.*\)$/);
});

test("createMany returns the count reported by the database", async () => {
  const { driver, db } = setup();
  driver.batchCount = () => 1;
  assert.deepEqual(await db.tag.createMany({ skipDuplicates: true, data: [{ name: "a" }, { name: "a" }] }), { count: 1 });
});

test("createManyAndReturn inserts row by row, reads identity values and returns rows in input order", async () => {
  const { driver, db } = setup();
  let nextId = 10;
  driver.respond = (sql, params) => {
    if (sql.startsWith("SELECT CURRENT_IDENTITY_VALUE()")) return [{ id: nextId++ }];
    if (sql.startsWith("SELECT")) {
      // the database returns rows in its own order
      return [{ id: 11, email: "b@example.com" }, { id: 10, email: "a@example.com" }].filter((r) => params.includes(r.id));
    }
    return 1;
  };
  const rows = await db.user.createManyAndReturn({ data: [{ email: "a@example.com" }, { email: "b@example.com" }], select: { email: true } });
  assert.deepEqual(rows, [{ email: "a@example.com" }, { email: "b@example.com" }], "key fields added for the read are removed again");
  const read = driver.calls.at(-1)!;
  assert.match(read.sql, /WHERE \(t0\."id" = \?\) OR \(t0\."id" = \?\)$/);
  assert.deepEqual(read.params, [10, 11]);
  assert.ok(driver.calls.every((c) => c.tx));
});

test("createManyAndReturn with skipDuplicates skips rows the database did not insert", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.startsWith("INSERT")) return sql.includes("NOT EXISTS") ? 0 : 1;
    return [];
  };
  assert.deepEqual(await db.tag.createManyAndReturn({ skipDuplicates: true, data: [{ name: "a" }] }), []);
  assert.equal(driver.calls.filter((c) => c.sql.startsWith("SELECT")).length, 0, "nothing to read back");
});

test("createMany and createManyAndReturn reject relation fields and missing data", async () => {
  const { db } = setup();
  await assert.rejects(db.post.createManyAndReturn({ data: [{ title: "t", author: { connect: { id: 1 } } } as never] }), /does not support relation 'author'/);
  await assert.rejects(db.user.createManyAndReturn({} as never), ValidationError);
  await assert.rejects(db.user.createMany({} as never), /needs 'data'/);
  await assert.rejects(db.user.createManyAndReturn({ data: [{ name: "x" } as never] }), /Missing required field 'email' in createManyAndReturn/);
});

test("nested createMany passes skipDuplicates through", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => (sql.startsWith("SELECT CURRENT_IDENTITY_VALUE()") ? [{ id: 1 }] : sql.startsWith("SELECT") ? [{ id: 1 }] : 1);
  await db.user.create({ data: { email: "a@example.com", posts: { createMany: { skipDuplicates: true, data: [{ id: 5, title: "t" }] } } } });
  const nested = driver.calls.find((c) => c.sql.startsWith(`INSERT INTO "APP"."Post"`))!;
  assert.match(nested.sql, /WHERE NOT EXISTS \(SELECT 1 FROM "APP"\."Post" WHERE \("id" = \?\)\)$/);
});

test("HanaDriver.executeBatch counts rows with 0 as not written", async () => {
  const module = {
    createConnection() {
      return {
        connect: (_o: unknown, cb: (e: Error | null) => void) => cb(null),
        prepare: (_sql: string, cb: (e: Error | null, s: unknown) => void) =>
          cb(null, { execBatch: (_rows: unknown, done: (e: Error | null, r: unknown) => void) => done(null, [1, 0, -2, 1]), drop: (d: (e: Error | null) => void) => d(null) }),
        setAutoCommit: () => {},
        disconnect: (cb: (e: Error | null) => void) => cb(null),
      };
    },
  };
  const driver = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, hanaModule: module });
  assert.equal(await driver.executeBatch("INSERT", [[1], [2], [3], [4]]), 3);
  await driver.close();
});
