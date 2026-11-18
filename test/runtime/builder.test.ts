/** SQL-like query builder (issue #28): SQL snapshots and decoding. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient, tables, and, asc, avg, count, desc, eq, exists, gt, ilike, inArray, isNull, like, or, sql, sum, alias, max } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { ValidationError } from "../../src/runtime/errors.ts";

const { user, post } = tables;

function setup(rows: Record<string, unknown>[] = []) {
  const driver = new FakeDriver();
  driver.respond = (q) => (q.startsWith("SELECT") || q.startsWith("WITH") ? rows : undefined);
  return { driver, db: new HanaClient({ driver }) };
}

test("select with columns, where, order, limit", () => {
  const { db } = setup();
  const q = db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(and(eq(user.active, true), gt(user.visits, 10n), like(user.email, "%@example.com")))
    .orderBy(desc(user.createdAt), asc(user.id))
    .limit(10)
    .offset(20);
  assert.deepEqual(q.toSQL(), {
    sql:
      'SELECT "user"."id" AS "id", "user"."email" AS "email" FROM "APP"."USERS" "user" ' +
      'WHERE ("user"."active" = ?) AND ("user"."visits" > ?) AND ("user"."email" LIKE ?) ' +
      'ORDER BY "user"."CREATED_AT" DESC, "user"."id" ASC LIMIT 10 OFFSET 20',
    params: [true, "10", "%@example.com"],
  });
});

test("values are encoded with the column's codec (enums, dates)", () => {
  const { db } = setup();
  const q = db.select({ id: user.id }).from(user).where(or(eq(user.role, "ADMIN"), gt(user.createdAt, new Date("2026-01-01T00:00:00Z")), isNull(user.name)));
  // Role.ADMIN is stored as "admin" (@map)
  assert.deepEqual(q.toSQL().params, ["admin", "2026-01-01 00:00:00.000"]);
  assert.match(q.toSQL().sql, /WHERE \("user"\."role" = \?\) OR \("user"\."CREATED_AT" > \?\) OR \("user"\."name" IS NULL\)$/);
});

test("joins: whole tables nest per source; an outer-joined source without a match is null", async () => {
  const { db, driver } = setup([
    { "user.id": 1, "user.email": "a@x", "user.name": null, "user.role": "USER", "user.balance": "1.00", "user.visits": "2", "user.active": true, "user.createdAt": "2026-01-01 00:00:00", "user.updatedAt": "2026-01-01 00:00:00", "post.id": null, "post.title": null, "post.published": null, "post.authorId": null },
  ]);
  const rows = await db.select().from(user).leftJoin(post, eq(post.authorId, user.id));
  assert.match(driver.calls[0]!.sql, /^SELECT "user"\."id" AS "user\.id", .* FROM "APP"\."USERS" "user" LEFT OUTER JOIN "APP"\."Post" "post" ON "post"\."authorId" = "user"\."id"$/);
  assert.equal(rows[0]!.user.visits, 2n);
  assert.equal(rows[0]!.post, null);
});

test("selected columns of joined tables, aggregates, group by and having", async () => {
  const { db, driver } = setup([{ email: "a@x", posts: "3", lastTitle: "z", total: "6" }]);
  const rows = await db
    .select({ email: user.email, posts: count(post.id), lastTitle: max(post.title), total: sum(post.id) })
    .from(user)
    .innerJoin(post, eq(post.authorId, user.id))
    .groupBy(user.email)
    .having(gt(count(post.id), 2));
  assert.equal(
    driver.calls[0]!.sql,
    'SELECT "user"."email" AS "email", COUNT("post"."id") AS "posts", MAX("post"."title") AS "lastTitle", SUM("post"."id") AS "total" FROM "APP"."USERS" "user" INNER JOIN "APP"."Post" "post" ON "post"."authorId" = "user"."id" GROUP BY "user"."email" HAVING COUNT("post"."id") > ?',
  );
  assert.deepEqual(driver.calls[0]!.params, [2]);
  assert.deepEqual(rows, [{ email: "a@x", posts: 3, lastTitle: "z", total: 6 }]);
});

test("self-join with alias, subqueries, exists and inArray", () => {
  const { db } = setup();
  const author = alias(user, "author");
  const q1 = db.select({ title: post.title, author: author.email }).from(post).leftJoin(author, eq(author.id, post.authorId));
  assert.match(q1.toSQL().sql, /LEFT OUTER JOIN "APP"\."USERS" "author" ON "author"\."id" = "post"\."authorId"$/);

  const counts = db.select({ authorId: post.authorId, n: count() }).from(post).groupBy(post.authorId).as("counts");
  const q2 = db.select({ email: user.email, n: counts.n }).from(user).innerJoin(counts, eq(counts.authorId, user.id)).where(gt(counts.n, 5));
  assert.equal(
    q2.toSQL().sql,
    'SELECT "user"."email" AS "email", "counts"."n" AS "n" FROM "APP"."USERS" "user" INNER JOIN (SELECT "post"."authorId" AS "authorId", COUNT(*) AS "n" FROM "APP"."Post" "post" GROUP BY "post"."authorId") "counts" ON "counts"."authorId" = "user"."id" WHERE "counts"."n" > ?',
  );
  assert.deepEqual(q2.toSQL().params, [5]);

  const published = db.select({ id: post.id }).from(post).where(and(eq(post.authorId, user.id), eq(post.published, true)));
  const q3 = db.select({ id: user.id }).from(user).where(and(exists(published), inArray(user.id, [1, 2]), ilike(user.email, "%A%")));
  assert.deepEqual(q3.toSQL(), {
    sql: 'SELECT "user"."id" AS "id" FROM "APP"."USERS" "user" WHERE (EXISTS (SELECT "post"."id" AS "id" FROM "APP"."Post" "post" WHERE ("post"."authorId" = "user"."id") AND ("post"."published" = ?))) AND ("user"."id" IN (?, ?)) AND (LOWER("user"."email") LIKE LOWER(?))',
    params: [true, 1, 2, "%A%"],
  });
  assert.equal(db.select({ id: user.id }).from(user).where(inArray(user.id, [])).toSQL().sql.endsWith("WHERE 1 = 0"), true);
});

test("CTEs and the sql template", async () => {
  const { db, driver } = setup([{ email: "a@x", lower: "a@x" }]);
  const active = db.$with("active").as(db.select({ id: user.id, email: user.email }).from(user).where(eq(user.active, true)));
  const rows = await db
    .with(active)
    .select({ email: active.email, lower: sql<string>`LOWER(${active.email})` })
    .from(active)
    .where(sql`${active.email} <> ${"x"}`);
  assert.equal(
    driver.calls[0]!.sql,
    'WITH "active" AS (SELECT "user"."id" AS "id", "user"."email" AS "email" FROM "APP"."USERS" "user" WHERE "user"."active" = ?) SELECT "active"."email" AS "email", LOWER("active"."email") AS "lower" FROM "active" WHERE "active"."email" <> ?',
  );
  assert.deepEqual(driver.calls[0]!.params, [true, "x"]);
  assert.deepEqual(rows, [{ email: "a@x", lower: "a@x" }]);
  assert.deepEqual(db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(user).toSQL().sql, 'SELECT COUNT(*) AS "n" FROM "APP"."USERS" "user"');
});

test("insert uses createMany (defaults, batching); update and delete render with bound values", async () => {
  const { db, driver } = setup();
  assert.equal(await db.insert(user).values([{ email: "a@x" }, { email: "b@x" }]), 2);
  const batch = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.match(batch.sql, /^INSERT INTO "APP"\."USERS" \(/);

  const upd = db.update(user).set({ name: "N", visits: sql`${user.visits} + 1` }).where(eq(user.id, 7));
  const u = upd.toSQL();
  assert.match(u.sql, /^UPDATE "APP"\."USERS" "user" SET "name" = \?, "visits" = "user"\."visits" \+ 1, "UPDATED_AT" = \? WHERE "user"\."id" = \?$/);
  assert.equal(u.params[0], "N");
  assert.equal(u.params[2], 7);
  driver.respond = () => 3;
  assert.equal(await upd, 3);

  assert.deepEqual(db.delete(post).where(eq(post.published, false)).toSQL(), { sql: 'DELETE FROM "APP"."Post" "post" WHERE "post"."published" = ?', params: [false] });
});

test("builder errors", () => {
  const { db } = setup();
  assert.throws(() => db.select().from(user).innerJoin(user, undefined), /already in this query/);
  assert.throws(() => eq(user.name, null as never), /isNull/);
  assert.throws(() => db.update(user).set({}).toSQL(), /sets no column/);
  assert.throws(() => db.select().from(user).limit(-1), ValidationError);
});

test("builders run inside $transaction on the transaction's connection", async () => {
  const { db, driver } = setup([{ id: 1 }]);
  await db.$transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user);
    await tx.update(user).set({ active: false }).where(eq(user.id, 1));
  });
  assert.ok(driver.calls.every((c) => c.tx));
});
