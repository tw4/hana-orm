import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/objects/index.ts";
import { FakeDriver } from "./fake-driver.ts";

function setup() {
  const driver = new FakeDriver();
  let no = 999;
  driver.respond = (sql) => {
    if (sql.includes('"ORDER_NO".CURRVAL')) return [{ v: no }];
    if (sql.includes('"ORDER_REF".CURRVAL')) return [{ v: "77" }];
    if (sql.startsWith("SELECT") && sql.includes('FROM "APP"."ORDERS"')) return [{ no, ref: "77", total: "10.00", status: "open" }];
    return undefined;
  };
  const db = new HanaClient({ driver });
  return { driver, db, next: () => ++no };
}

test("create fills sequence fields with NEXTVAL and reads the values back with CURRVAL", async () => {
  const { driver, db, next } = setup();
  next();
  const row = await db.order.create({ data: { total: 10 } });
  const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.match(insert.sql, /^INSERT INTO "APP"\."ORDERS" \(.*"TOTAL".*, "NO", "REF"\) VALUES \(\?(, \?)*, "APP"\."ORDER_NO"\.NEXTVAL, "APP"\."ORDER_REF"\.NEXTVAL\)$/);
  assert.ok(!insert.params.includes(undefined));
  const i = driver.calls.indexOf(insert);
  assert.deepEqual(
    driver.calls.slice(i + 1, i + 3).map((c) => c.sql),
    ['SELECT "APP"."ORDER_NO".CURRVAL AS "v" FROM DUMMY', 'SELECT "APP"."ORDER_REF".CURRVAL AS "v" FROM DUMMY'],
  );
  assert.equal(row.no, 1000);
});

test("an explicit value skips the sequence", async () => {
  const { driver, db } = setup();
  await db.order.create({ data: { no: 5, ref: 6n, total: 1 } });
  const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.doesNotMatch(insert.sql, /NEXTVAL/);
  assert.ok(!driver.calls.some((c) => c.sql.includes("CURRVAL")));
});

test("createMany puts NEXTVAL into the batched INSERT", async () => {
  const { driver, db } = setup();
  await db.order.createMany({ data: [{ total: 1 }, { total: 2 }] });
  const inserts = driver.calls.filter((c) => c.sql.startsWith("INSERT"));
  assert.ok(inserts.length >= 1);
  assert.ok(inserts.every((c) => /VALUES \(\?(, \?)*, "APP"\."ORDER_NO"\.NEXTVAL, "APP"\."ORDER_REF"\.NEXTVAL\)$/.test(c.sql)), inserts.map((c) => c.sql).join("\n"));
  assert.ok(!driver.calls.some((c) => c.sql.includes("CURRVAL")), "createMany does not read values back");
});

test("createMany with skipDuplicates selects NEXTVAL from DUMMY", async () => {
  const { driver, db } = setup();
  await db.order.createMany({ skipDuplicates: true, data: [{ no: 1, total: 1 }] });
  const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.match(insert.sql, /SELECT \?(, \?)*, "APP"\."ORDER_REF"\.NEXTVAL FROM DUMMY WHERE NOT EXISTS/);
});
