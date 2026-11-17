import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { ValidationError } from "../../src/runtime/errors.ts";

function setup(options: ConstructorParameters<typeof HanaClient>[0] = {}) {
  const driver = new FakeDriver();
  const db = new HanaClient({ ...options, driver });
  return { driver, db };
}

// ---------------------------------------------------------------------------
// omit (#4)
// ---------------------------------------------------------------------------

test("omit leaves fields out of the SELECT list", async () => {
  const { driver, db } = setup();
  await db.user.findMany({ omit: { balance: true, visits: true, createdAt: true, updatedAt: true } });
  assert.equal(driver.calls[0]!.sql, `SELECT t0."id" AS "id", t0."email" AS "email", t0."name" AS "name", t0."role" AS "role", t0."active" AS "active" FROM "APP"."USERS" t0`);
});

test("client-wide omit applies to every query and can be re-included per query", async () => {
  const { driver, db } = setup({ omit: { user: { email: true, balance: true } } });
  await db.user.findMany();
  assert.doesNotMatch(driver.calls[0]!.sql, /"email"|"balance"/);
  await db.user.findMany({ omit: { email: false } });
  assert.match(driver.calls[1]!.sql, /t0\."email" AS "email"/);
  assert.doesNotMatch(driver.calls[1]!.sql, /"balance"/);
  await db.user.findMany({ select: { email: true } });
  assert.equal(driver.calls[2]!.sql, `SELECT t0."email" AS "email" FROM "APP"."USERS" t0`);
});

test("omitted keys needed to load relations are fetched and then removed", async () => {
  const { driver, db } = setup({ omit: { post: { authorId: true } } });
  driver.respond = (sql) => {
    if (sql.includes(`FROM "APP"."USERS"`)) return [{ id: 1, email: "a" }];
    if (sql.includes(`FROM "APP"."Post"`)) return [{ id: 5, title: "p", published: true, authorId: 1 }];
    return [];
  };
  const users = await db.user.findMany({ omit: { id: true }, include: { posts: true } });
  assert.match(driver.calls[0]!.sql, /t0\."id" AS "id"/);
  assert.match(driver.calls[1]!.sql, /t0\."authorId" AS "authorId"/);
  assert.equal("id" in users[0]!, false);
  assert.equal(users[0]!.email, "a");
  assert.deepEqual(users[0]!.posts, [{ id: 5, title: "p", published: true }]);
});

test("omit is applied to the row read back after a write", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.includes("CURRENT_IDENTITY_VALUE")) return [{ id: 3 }];
    if (sql.startsWith("SELECT")) return [{ id: 3, email: "a@b.c" }];
    return 1;
  };
  await db.user.create({ data: { email: "a@b.c" }, omit: { balance: true } });
  const reread = driver.calls.filter((c) => c.sql.startsWith(`SELECT t0."id"`)).at(-1)!;
  assert.doesNotMatch(reread.sql, /"balance"/);
});

test("aggregates are not affected by client-wide omit", async () => {
  const { driver, db } = setup({ omit: { user: { visits: true } } });
  await db.user.aggregate({ _sum: { visits: true }, take: 5 });
  assert.match(driver.calls[0]!.sql, /SUM\("a"\."visits"\)/);
  assert.match(driver.calls[0]!.sql, /t0\."visits" AS "visits"/);
});

test("omit validation", async () => {
  const { db } = setup();
  await assert.rejects(db.user.findMany({ omit: { nope: true } as never }), /Unknown field 'nope' in omit of 'User'/);
  await assert.rejects(db.user.findMany({ omit: { posts: true } as never }), /only scalar fields can be omitted/);
  await assert.rejects(db.user.findMany({ omit: { email: true }, select: { id: true } }), /either 'select' or 'omit'/);
  await assert.rejects(db.tag.findMany({ omit: { name: true } }), /leaves no fields/);
  assert.throws(() => new HanaClient({ driver: new FakeDriver(), omit: { nope: { x: true } } as never }), ValidationError);
});

// ---------------------------------------------------------------------------
// groupBy having (#1)
// ---------------------------------------------------------------------------

test("groupBy having filters on aggregates with bound parameters", async () => {
  const { driver, db } = setup();
  await db.user.groupBy({
    by: ["role"],
    where: { active: true },
    _count: { _all: true },
    having: { role: { not: "ADMIN" }, _count: { _all: { gt: 2 } }, _sum: { visits: { gte: 100n } }, _avg: { balance: { lt: 9.5 } } },
    orderBy: { role: "asc" },
  });
  const { sql, params } = driver.calls[0]!;
  assert.equal(
    sql,
    `SELECT t0."role" AS "role", COUNT(*) AS "_count._all" FROM "APP"."USERS" t0 WHERE t0."active" = ? GROUP BY t0."role" HAVING (t0."role" <> ?) AND (COUNT(*) > ?) AND (SUM(t0."visits") >= ?) AND (AVG(t0."balance") < ?) ORDER BY t0."role" ASC`,
  );
  assert.deepEqual(params, [true, "admin", 2, "100", 9.5]);
});

test("groupBy having supports OR / NOT, field counts and min/max", async () => {
  const { driver, db } = setup();
  await db.post.groupBy({
    by: ["authorId"],
    having: { OR: [{ _count: { id: 1 } }, { _max: { title: { startsWith: "a" } } }], NOT: { authorId: null } },
  });
  assert.match(
    driver.calls[0]!.sql,
    / HAVING \(\(\(COUNT\(t0\."id"\) = \?\) OR \(MAX\(t0\."title"\) LIKE \? ESCAPE '\\'\)\)\) AND \(NOT \(\(t0\."authorId" IS NULL\)\)\)$/,
  );
  assert.deepEqual(driver.calls[0]!.params, [1, "a%"]);
});

test("groupBy having validation", async () => {
  const { db } = setup();
  await assert.rejects(db.post.groupBy({ by: ["authorId"], having: { title: "x" } }), /must be one of the 'by' fields or use an aggregate/);
  await assert.rejects(db.post.groupBy({ by: ["authorId"], having: { _sum: { title: { gt: 1 } } } as never }), /needs numeric fields/);
  await assert.rejects(db.post.groupBy({ by: ["authorId"], having: { _count: { _all: { gt: "x" } } } as never }), /expects an integer/);
});

// ---------------------------------------------------------------------------
// distinct (#3)
// ---------------------------------------------------------------------------

test("distinct uses SELECT DISTINCT when only distinct fields are returned", async () => {
  const { driver, db } = setup();
  await db.user.findMany({ distinct: ["role"], select: { role: true }, orderBy: { role: "desc" }, take: 2 });
  assert.equal(driver.calls[0]!.sql, `SELECT DISTINCT t0."role" AS "role" FROM "APP"."USERS" t0 ORDER BY t0."role" DESC LIMIT 2`);
});

test("distinct keeps the first row per group with ROW_NUMBER() otherwise", async () => {
  const { driver, db } = setup();
  await db.post.findMany({ distinct: "authorId", where: { published: true }, orderBy: { title: "asc" }, select: { title: true, authorId: true }, skip: 1 });
  const { sql, params } = driver.calls[0]!;
  assert.equal(
    sql,
    `SELECT t0."title" AS "title", t0."authorId" AS "authorId" FROM (SELECT t0.*, ROW_NUMBER() OVER (PARTITION BY t0."authorId" ORDER BY t0."title" ASC) AS "__rn" FROM "APP"."Post" t0 WHERE t0."published" = ?) t0 WHERE t0."__rn" = 1 ORDER BY t0."title" ASC, t0."authorId" ASC LIMIT 2147483647 OFFSET 1`,
  );
  assert.deepEqual(params, [true]);
});

test("distinct works with cursor and _count on the numbered rows", async () => {
  const { driver, db } = setup();
  await db.user.findMany({ distinct: ["role"], cursor: { id: 3 }, take: 10, select: { id: true, _count: true } });
  const { sql, params } = driver.calls[0]!;
  assert.match(sql, /^SELECT t0\."id" AS "id", \(SELECT COUNT\(\*\) FROM "APP"\."Post" t1 WHERE t1\."authorId" = t0\."id"\) AS "_count\.posts" FROM \(SELECT t0\.\*, ROW_NUMBER\(\) OVER \(PARTITION BY t0\."role" ORDER BY t0\."id" ASC\) AS "__rn" FROM "APP"\."USERS" t0\) t0 WHERE \(t0\."__rn" = 1\) AND \(/);
  assert.match(sql, /ORDER BY t0\."role" ASC LIMIT 10$/);
  assert.deepEqual(params, [3, 3]);
});

test("distinct inside include is applied per parent", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => (sql.includes(`"APP"."USERS"`) ? [{ id: 1 }] : []);
  await db.user.findMany({ select: { id: true, posts: { distinct: ["published"], select: { published: true } } } });
  assert.match(driver.calls[1]!.sql, /^SELECT DISTINCT t0\."published" AS "published", t0\."authorId" AS "authorId" FROM/);
  await db.user.findMany({ select: { id: true, posts: { distinct: ["published"], select: { title: true } } } });
  assert.match(driver.calls[3]!.sql, /PARTITION BY t0\."published", t0\."authorId"/);
  await assert.rejects(db.user.findMany({ distinct: ["nope" as "id"] }), /Unknown field 'nope'/);
});

// ---------------------------------------------------------------------------
// orderBy relations and aggregates (#2)
// ---------------------------------------------------------------------------

test("orderBy a to-one relation field uses a correlated subquery", async () => {
  const { driver, db } = setup();
  await db.post.findMany({ orderBy: [{ author: { name: { sort: "asc", nulls: "last" } } }, { title: "desc" }], select: { id: true } });
  assert.equal(
    driver.calls[0]!.sql,
    `SELECT t0."id" AS "id" FROM "APP"."Post" t0 ORDER BY (SELECT t1."name" FROM "APP"."USERS" t1 WHERE t1."id" = t0."authorId") ASC NULLS LAST, t0."title" DESC`,
  );
});

test("orderBy follows nested to-one relations and back-side relations", async () => {
  const { driver, db } = setup();
  await db.profile.findMany({ orderBy: { user: { email: "asc" } }, select: { id: true } });
  assert.match(driver.calls[0]!.sql, /ORDER BY \(SELECT t1\."email" FROM "APP"\."USERS" t1 WHERE t1\."id" = t0\."userId"\) ASC$/);
  await db.user.findMany({ orderBy: { profile: { bio: "desc" } }, select: { id: true } });
  assert.match(driver.calls[1]!.sql, /ORDER BY \(SELECT t1\."bio" FROM "APP"\."Profile" t1 WHERE t1\."userId" = t0\."id"\) DESC$/);
  await db.postTag.findMany({ orderBy: { post: { author: { email: "asc" } } } });
  assert.match(driver.calls[2]!.sql, /ORDER BY \(SELECT \(SELECT t2\."email" FROM "APP"\."USERS" t2 WHERE t2\."id" = t1\."authorId"\) FROM "APP"\."Post" t1 WHERE t1\."id" = t0\."postId"\) ASC$/);
});

test("orderBy relation _count uses a COUNT(*) subquery", async () => {
  const { driver, db } = setup();
  await db.user.findMany({ orderBy: { posts: { _count: "desc" } }, select: { id: true } });
  assert.equal(driver.calls[0]!.sql, `SELECT t0."id" AS "id" FROM "APP"."USERS" t0 ORDER BY (SELECT COUNT(*) FROM "APP"."Post" t1 WHERE t1."authorId" = t0."id") DESC`);
});

test("relation orderBy works with cursor pagination", async () => {
  const { driver, db } = setup();
  await db.user.findMany({ orderBy: { posts: { _count: "desc" } }, cursor: { id: 7 }, take: 3, select: { id: true } });
  const { sql, params } = driver.calls[0]!;
  // the cursor row's post count is computed with the same expression
  assert.match(sql, /\(\(SELECT COUNT\(\*\) FROM "APP"\."Post" t1 WHERE t1\."authorId" = t0\."id"\) < \(SELECT \(SELECT COUNT\(\*\) FROM "APP"\."Post" t\d+ WHERE t\d+\."authorId" = t(\d+)\."id"\) FROM "APP"\."USERS" t\1 WHERE t\1\."id" = \?\)\)/);
  assert.match(sql, /ORDER BY \(SELECT COUNT\(\*\) FROM "APP"\."Post" t1 WHERE t1\."authorId" = t0\."id"\) DESC, t0\."id" ASC LIMIT 3$/);
  assert.deepEqual(params, [7, 7, 7, 7, 7]);
});

test("groupBy orders by aggregates", async () => {
  const { driver, db } = setup();
  await db.user.groupBy({ by: ["role"], _count: { _all: true }, orderBy: [{ _count: { _all: "desc" } }, { _sum: { visits: { sort: "asc", nulls: "first" } } }, { role: "asc" }] });
  assert.match(driver.calls[0]!.sql, /GROUP BY t0\."role" ORDER BY COUNT\(\*\) DESC, SUM\(t0\."visits"\) ASC NULLS FIRST, t0\."role" ASC$/);
  await assert.rejects(db.user.groupBy({ by: ["role"], orderBy: { email: "asc" } }), /must be one of the 'by' fields or an aggregate/);
  await assert.rejects(db.user.findMany({ orderBy: { posts: { title: "asc" } } as never }), /order it by \{ _count/);
});

// ---------------------------------------------------------------------------
// cursor inside include/select (#6)
// ---------------------------------------------------------------------------

test("nested cursor is applied in the batched query and paged per parent", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.includes(`FROM "APP"."USERS"`)) return [{ id: 1 }, { id: 2 }];
    if (sql.includes(`FROM "APP"."Post"`)) {
      return [
        { id: 10, title: "b", authorId: 1 },
        { id: 11, title: "c", authorId: 1 },
        { id: 12, title: "d", authorId: 1 },
        { id: 20, title: "b", authorId: 2 },
        { id: 21, title: "e", authorId: 2 },
      ];
    }
    return [];
  };
  const users = await db.user.findMany({ select: { id: true, posts: { cursor: { id: 10 }, skip: 1, take: 1, orderBy: { title: "asc" }, select: { id: true } } } });
  const { sql, params } = driver.calls[1]!;
  assert.equal(
    sql,
    `SELECT t0."id" AS "id", t0."authorId" AS "authorId" FROM "APP"."Post" t0 WHERE (t0."authorId" IN (?, ?)) AND ((t0."title" > (SELECT t1."title" FROM "APP"."Post" t1 WHERE t1."id" = ?)) OR (t0."title" = (SELECT t2."title" FROM "APP"."Post" t2 WHERE t2."id" = ?) AND t0."id" > (SELECT t3."id" FROM "APP"."Post" t3 WHERE t3."id" = ?)) OR (t0."title" = (SELECT t4."title" FROM "APP"."Post" t4 WHERE t4."id" = ?) AND t0."id" = (SELECT t5."id" FROM "APP"."Post" t5 WHERE t5."id" = ?))) ORDER BY t0."title" ASC, t0."id" ASC`,
  );
  assert.deepEqual(params, [1, 2, 10, 10, 10, 10, 10]);
  assert.deepEqual(users, [
    { id: 1, posts: [{ id: 11 }] },
    { id: 2, posts: [{ id: 21 }] },
  ]);
});

test("nested cursor with a negative take keeps rows up to the cursor", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.includes(`FROM "APP"."USERS"`)) return [{ id: 1 }];
    if (sql.includes(`FROM "APP"."Post"`)) return [{ id: 10, authorId: 1 }, { id: 11, authorId: 1 }, { id: 12, authorId: 1 }];
    return [];
  };
  const users = await db.user.findMany({ select: { id: true, posts: { cursor: { id: 12 }, take: -2, select: { id: true } } } });
  assert.match(driver.calls[1]!.sql, /\(t0\."id" < \(SELECT t1\."id" FROM "APP"\."Post" t1 WHERE t1\."id" = \?\)\)/);
  assert.match(driver.calls[1]!.sql, /ORDER BY t0\."id" ASC$/);
  assert.deepEqual(users, [{ id: 1, posts: [{ id: 11 }, { id: 12 }] }]);
  await assert.rejects(db.post.findMany({ include: { author: { cursor: { id: 1 } } as never } }), /only allowed on list relations/);
});
