/** `sql` fragments inside object-API where (issue #31). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient, tables, sql, alias } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { ValidationError } from "../../src/runtime/errors.ts";

const { user, post } = tables;

function setup() {
  const driver = new FakeDriver();
  const db = new HanaClient({ driver });
  const last = () => driver.calls.at(-1)!;
  return { db, driver, last };
}

test("an sql fragment in AND maps the table's columns to the query alias and binds values", async () => {
  const { db, last } = setup();
  const email = "Ada@Example.com";
  await db.user.findMany({ where: { active: true, AND: [sql`LOWER(${user.email}) = LOWER(${email})`] } });
  assert.match(last().sql, /WHERE \(t0\."active" = \?\) AND \(\(\(LOWER\(t0\."email"\) = LOWER\(\?\)\)\)\)$/);
  assert.deepEqual(last().params, [true, email]);
});

test("a fragment can be the whole where, and appear in OR / NOT", async () => {
  const { db, last } = setup();
  await db.user.count({ where: sql`${user.visits} > ${10}` });
  assert.match(last().sql, /WHERE \(t0\."visits" > \?\)/);
  assert.deepEqual(last().params, [10]);
  await db.user.findMany({ where: { OR: [{ name: "x" }, sql`${user.email} LIKE ${"%@x"}`], NOT: sql`${user.role} = ${"ADMIN"}` } });
  assert.match(last().sql, /\(t0\."name" = \?\) OR \(\(t0\."email" LIKE \?\)\)/);
  assert.match(last().sql, /AND \(NOT \(\(\(t0\."role" = \?\)\)\)\)$/);
  assert.deepEqual(last().params, ["x", "%@x", "ADMIN"], "raw sql values are bound as given");
});

test("inside a relation filter the fragment refers to the related table", async () => {
  const { db, last } = setup();
  await db.user.findMany({ where: { posts: { some: sql`LENGTH(${post.title}) > ${50}` } } });
  assert.match(last().sql, /EXISTS \(SELECT 1 FROM "APP"\."Post" t1 WHERE t1\."authorId" = t0\."id" AND \(\(LENGTH\(t1\."title"\) > \?\)\)\)/);
  assert.deepEqual(last().params, [50]);
  await db.post.findMany({ where: { author: sql`${user.email} = ${"a@x"}` } });
  assert.match(last().sql, /WHERE EXISTS \(SELECT 1 FROM "APP"\."USERS" t1 WHERE t1\."id" = t0\."authorId" AND \(\(t1\."email" = \?\)\)\)$/);
});

test("values are always bound; identifiers come from columns or sql.identifier", async () => {
  const { db, last } = setup();
  const evil = "x' OR 1=1 --";
  await db.user.findMany({ where: sql`${user.name} = ${evil} AND ${sql.identifier("CUSTOM_COL")} IS NOT NULL` });
  assert.ok(!last().sql.includes(evil));
  assert.match(last().sql, /t0\."name" = \? AND "CUSTOM_COL" IS NOT NULL/);
  assert.deepEqual(last().params, [evil]);
  assert.equal(sql.identifier("A", 'b"c').render({} as never), '"A"."b""c"');
  assert.throws(() => sql.identifier(""), /non-empty names/);
});

test("columns of other tables are rejected in object-API where", async () => {
  const { db } = setup();
  await assert.rejects(db.user.findMany({ where: sql`${post.title} = ${"x"}` }), (e: unknown) => e instanceof ValidationError && /Column 'post\.title' cannot be used here; only columns of 'user'/.test(e.message));
  const author = alias(user, "author");
  await assert.rejects(db.user.findMany({ where: sql`${author.id} = ${1}` }), /Column 'author\.id' cannot be used here/);
});

test("the same fragment works in the builder", () => {
  const { db } = setup();
  const cond = sql`LOWER(${user.email}) = ${"a"}`;
  assert.deepEqual(db.select({ id: user.id }).from(user).where(cond).toSQL(), {
    sql: 'SELECT "user"."id" AS "id" FROM "APP"."USERS" "user" WHERE LOWER("user"."email") = ?',
    params: ["a"],
  });
});
