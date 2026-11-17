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
