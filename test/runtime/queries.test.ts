import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { NotFoundError, ValidationError } from "../../src/runtime/errors.ts";

function setup() {
  const driver = new FakeDriver();
  const db = new HanaClient({ driver });
  return { driver, db };
}

test("findMany builds a parameterized select with filters, order and limit", async () => {
  const { driver, db } = setup();
  await db.user.findMany({
    where: { email: { contains: "50%_off", mode: "insensitive" }, role: "ADMIN", name: null, OR: [{ active: true }, { visits: { gt: 10n } }] },
    orderBy: [{ createdAt: "desc" }, { name: { sort: "asc", nulls: "last" } }],
    take: 20,
    skip: 40,
  });
  const { sql, params } = driver.calls[0]!;
  assert.equal(
    sql,
    `SELECT t0."id" AS "id", t0."email" AS "email", t0."name" AS "name", t0."role" AS "role", t0."balance" AS "balance", t0."visits" AS "visits", t0."active" AS "active", t0."CREATED_AT" AS "createdAt", t0."UPDATED_AT" AS "updatedAt" FROM "APP"."USERS" t0 WHERE (LOWER(t0."email") LIKE LOWER(?) || '' ESCAPE '\\') AND (t0."role" = ?) AND (t0."name" IS NULL) AND ((t0."active" = ?) OR (t0."visits" > ?)) ORDER BY t0."CREATED_AT" DESC, t0."name" ASC NULLS LAST, t0."id" ASC LIMIT 20 OFFSET 40`,
  );
  assert.deepEqual(params, ["%50\\%\\_off%", "admin", true, "10"]);
});

test("case-insensitive filters lower the value as LOWER(?) || '' so HANA keeps İ = i (#83)", async () => {
  const { driver, db } = setup();
  await db.user.findMany({ where: { name: { equals: "İLKER", mode: "insensitive" } }, select: { id: true } });
  await db.user.findMany({ where: { name: { in: ["A", "B"], mode: "insensitive" } }, select: { id: true } });
  await db.user.findMany({ where: { name: { not: "A", mode: "insensitive" } }, select: { id: true } });
  await db.user.findMany({ where: { name: { not: { startsWith: "A" }, mode: "insensitive" } }, select: { id: true } });
  const where = driver.calls.map((c) => c.sql.slice(c.sql.indexOf(" WHERE ") + 7));
  assert.deepEqual(where, [
    `LOWER(t0."name") = LOWER(?) || ''`,
    `LOWER(t0."name") IN (LOWER(?) || '', LOWER(?) || '')`,
    `LOWER(t0."name") <> LOWER(?) || ''`,
    `NOT (LOWER(t0."name") LIKE LOWER(?) || '' ESCAPE '\\')`,
  ]);
  assert.deepEqual(driver.calls[0]!.params, ["İLKER"], "the value is lower-cased by HANA, not by the client");
});

test("decodes driver values into JS types", async () => {
  const { driver, db } = setup();
  driver.respond = () => [
    { id: 1, email: "a", name: null, role: "admin", balance: "1.50", visits: "9007199254740993", active: true, createdAt: "2026-01-02 03:04:05.678000000", updatedAt: "2026-01-02 03:04:05.000000000" },
  ];
  const [u] = await db.user.findMany({ where: { role: { in: ["ADMIN"] } } });
  assert.deepEqual(driver.calls[0]!.params, ["admin"]);
  assert.equal(u!.role, "ADMIN");
  assert.equal(u!.visits, 9007199254740993n);
  assert.equal(u!.balance, "1.50");
  assert.deepEqual(u!.createdAt, new Date("2026-01-02T03:04:05.678Z"));
});

test("relation filters use EXISTS subqueries", async () => {
  const { driver, db } = setup();
  await db.user.findMany({ where: { posts: { some: { published: true }, none: { title: "x" } }, profile: null }, select: { id: true } });
  const sql = driver.calls[0]!.sql;
  assert.match(sql, /EXISTS \(SELECT 1 FROM "APP"\."Post" t1 WHERE t1\."authorId" = t0\."id" AND \(t1\."published" = \?\)\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "APP"\."Post" t2 WHERE t2\."authorId" = t0\."id" AND \(t2\."title" = \?\)\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "APP"\."Profile" t3 WHERE t3\."userId" = t0\."id"\)/);
  await db.post.findMany({ where: { author: { is: null } } });
  assert.match(driver.calls[1]!.sql, /WHERE \(t0\."authorId" IS NULL\)$/);
});

test("include loads relations with one batched IN query and hides helper keys", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.includes(`FROM "APP"."USERS"`)) return [{ email: "a", id: 1 }, { email: "b", id: 2 }];
    if (sql.includes(`FROM "APP"."Post"`)) return [{ title: "p1", authorId: 1 }, { title: "p2", authorId: 1 }, { title: "p3", authorId: 2 }];
    return [];
  };
  const users = await db.user.findMany({ select: { email: true, posts: { select: { title: true }, take: 1 } } });
  assert.equal(driver.calls.length, 2);
  assert.match(driver.calls[1]!.sql, /WHERE t0\."authorId" IN \(\?, \?\)/);
  assert.doesNotMatch(driver.calls[1]!.sql, /LIMIT/);
  assert.deepEqual(users, [
    { email: "a", posts: [{ title: "p1" }] },
    { email: "b", posts: [{ title: "p3" }] },
  ]);
});

test("_count uses correlated subqueries", async () => {
  const { driver, db } = setup();
  driver.respond = () => [{ id: 1, "_count.posts": 3 }];
  const rows = await db.user.findMany({ select: { id: true, _count: { select: { posts: true } } } });
  assert.match(driver.calls[0]!.sql, /\(SELECT COUNT\(\*\) FROM "APP"\."Post" t1 WHERE t1\."authorId" = t0\."id"\) AS "_count\.posts"/);
  assert.deepEqual(rows, [{ id: 1, _count: { posts: 3 } }]);
});

test("cursor pagination keeps LIMIT and compares against the cursor row", async () => {
  const { driver, db } = setup();
  await db.post.findMany({ cursor: { id: 10 }, take: 5, orderBy: { title: "asc" } });
  const sql = driver.calls[0]!.sql;
  assert.match(sql, /LIMIT 5$/);
  assert.match(sql, /\(t0\."title" > \(SELECT t1\."title" FROM "APP"\."Post" t1 WHERE t1\."id" = \?\)\)/);
  assert.match(sql, /ORDER BY t0\."title" ASC, t0\."id" ASC/);
});

test("create inserts, reads the identity value and re-selects in one transaction", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.includes("CURRENT_IDENTITY_VALUE")) return [{ id: "7" }];
    if (sql.startsWith("SELECT") && sql.includes(`"APP"."USERS"`)) return [{ id: 7, email: "a@b.c" }];
    return 1;
  };
  const u = await db.user.create({ data: { email: "a@b.c", posts: { create: [{ title: "hello" }] } }, select: { id: true, email: true } });
  assert.deepEqual(u, { id: 7, email: "a@b.c" });
  assert.equal(driver.transactions, 1);
  assert.ok(driver.calls.every((c) => c.tx));
  const insert = driver.calls[0]!;
  assert.match(insert.sql, /^INSERT INTO "APP"\."USERS" \("email", "role", "balance", "visits", "active", "CREATED_AT", "UPDATED_AT"\) VALUES/);
  assert.deepEqual(insert.params.slice(0, 5), ["a@b.c", "USER", "0", "0", true]);
  const childInsert = driver.calls.find((c) => c.sql.startsWith(`INSERT INTO "APP"."Post"`))!;
  assert.match(childInsert.sql, /\("title", "authorId", "published"\)/);
  assert.deepEqual(childInsert.params, ["hello", 7, false]);
});

test("update locates the row, applies atomic operations and @updatedAt", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => (sql.startsWith("SELECT") ? [{ id: 1, email: "a" }] : 1);
  await db.user.update({ where: { email: "a" }, data: { visits: { increment: 5 }, name: "N" } });
  const upd = driver.calls.find((c) => c.sql.startsWith("UPDATE"))!;
  assert.match(upd.sql, /^UPDATE "APP"\."USERS" SET "visits" = "visits" \+ \?, "name" = \?, "UPDATED_AT" = \? WHERE "APP"\."USERS"\."id" = \?$/);
  assert.equal(upd.params[0], "5");
  assert.equal(upd.params[3], 1);
});

test("update of a missing record throws NotFoundError and rolls back", async () => {
  const { driver, db } = setup();
  await assert.rejects(db.user.update({ where: { id: 99 }, data: { name: "x" } }), NotFoundError);
  assert.equal(driver.rolledBack, 1);
});

test("validation errors are clear", async () => {
  const { db } = setup();
  await assert.rejects(db.user.findMany({ where: { nope: 1 } as never }), /Unknown field 'nope' in where of model 'User'/);
  await assert.rejects(db.user.create({ data: { name: "x" } as never }), /Missing required field 'email'/);
  await assert.rejects(db.user.findUnique({ where: { name: "x" } as never }), ValidationError);
  await assert.rejects(db.user.findMany({ where: { visits: 1.5 } }), /expects a bigint/);
});

test("compound unique where and createMany batching", async () => {
  const { driver, db } = setup();
  await db.postTag.findUnique({ where: { postId_tagName: { postId: 1, tagName: "x" } } });
  assert.match(driver.calls[0]!.sql, /WHERE \(t0\."postId" = \?\) AND \(t0\."tagName" = \?\)/);
  const r = await db.tag.createMany({ data: [{ name: "a" }, { name: "b" }] });
  assert.deepEqual(r, { count: 2 });
  assert.equal(driver.calls.filter((c) => c.sql.startsWith(`INSERT INTO "APP"."Tag"`)).length, 2);
});

test("aggregate and groupBy", async () => {
  const { driver, db } = setup();
  driver.respond = () => [{ "_count._all": 4, "_sum.visits": "10", "_avg.balance": "2.5" }];
  const a = await db.user.aggregate({ _count: true, _sum: { visits: true }, _avg: { balance: true } });
  assert.deepEqual(a, { _count: 4, _sum: { visits: 10n }, _avg: { balance: 2.5 } });
  driver.respond = () => [{ authorId: 1, "_count._all": 2 }];
  const g = await db.post.groupBy({ by: ["authorId"], _count: { _all: true }, orderBy: { authorId: "asc" } });
  assert.deepEqual(g, [{ authorId: 1, _count: { _all: 2 } }]);
  assert.match(driver.calls[1]!.sql, /GROUP BY t0\."authorId" ORDER BY t0\."authorId" ASC$/);
});

test("$extends adds model methods and wraps queries", async () => {
  const { driver, db } = setup();
  const seen: string[] = [];
  const x = db.$extends({
    model: {
      user: {
        async byEmail(email: string) {
          return db.user.findUnique({ where: { email } });
        },
      },
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          seen.push(`${model}.${operation}`);
          return query(args);
        },
      },
    },
  });
  await x.user.byEmail("a");
  await x.post.count();
  assert.deepEqual(seen, ["Post.count"]);
  assert.equal(driver.calls.length, 2);
});

test("raw queries bind parameters", async () => {
  const { driver, db } = setup();
  await db.$queryRaw`SELECT * FROM X WHERE A = ${1} AND B = ${new Date("2026-01-01T00:00:00Z")}`;
  assert.equal(driver.calls[0]!.sql, "SELECT * FROM X WHERE A = ? AND B = ?");
  assert.deepEqual(driver.calls[0]!.params, [1, "2026-01-01 00:00:00.000"]);
});
