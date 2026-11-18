/** Prepared queries and placeholders (issue #30). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient, tables, eq, and, gt, inArray, sql } from "../generated/blog/index.ts";
import { placeholder } from "../../src/runtime/placeholder.ts";
import { FakeDriver } from "./fake-driver.ts";
import { ValidationError } from "../../src/runtime/errors.ts";

const { user, post } = tables;

function setup(rows: Record<string, unknown>[] = []) {
  const driver = new FakeDriver();
  driver.respond = (q) => (q.startsWith("SELECT") ? rows : undefined);
  return { driver, db: new HanaClient({ driver }) };
}

test("builder: prepare once, execute with values encoded like the column", async () => {
  const { db, driver } = setup([{ id: 1, email: "a@x" }]);
  const p = db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(and(eq(user.role, placeholder("role")), gt(user.createdAt, placeholder("since")), inArray(user.id, [placeholder("a"), placeholder("b")])))
    .limit(5)
    .prepare();
  assert.deepEqual([...p.placeholders].sort(), ["a", "b", "role", "since"]);
  const rows = await p.execute({ role: "ADMIN", since: new Date("2026-01-01T00:00:00Z"), a: 1, b: 2 });
  assert.deepEqual(rows, [{ id: 1, email: "a@x" }]);
  await p.execute({ role: "USER", since: new Date("2026-02-01T00:00:00Z"), a: 3, b: 4 });
  const [c1, c2] = driver.calls;
  assert.equal(c1!.sql, c2!.sql, "the same SQL text every time");
  assert.equal(c1!.sql, p.sql);
  assert.deepEqual(c1!.params, ["admin", "2026-01-01 00:00:00.000", 1, 2]);
  assert.deepEqual(c2!.params, ["USER", "2026-02-01 00:00:00.000", 3, 4]);
});

test("builder: placeholders in raw sql are bound as given; update and delete can be prepared", async () => {
  const { db, driver } = setup();
  const q = db.select({ id: user.id }).from(user).where(sql`${user.visits} > ${placeholder("n")}`).prepare();
  await q.execute({ n: 10n });
  assert.deepEqual(driver.calls.at(-1)!.params, ["10"]);
  const upd = db.update(user).set({ name: placeholder("name") as never }).where(eq(user.id, placeholder("id"))).prepare();
  driver.respond = () => 1;
  assert.equal(await upd.execute({ name: "Ada", id: 7 }), 1);
  assert.equal(driver.calls.at(-1)!.params[0], "Ada");
  assert.equal(driver.calls.at(-1)!.params.at(-1), 7);
  const del = db.delete(post).where(eq(post.authorId, placeholder("author"))).prepare();
  await del.execute({ author: 3 });
  assert.deepEqual(driver.calls.at(-1)!.params, [3]);
});

test("object API: findMany / findFirst / findUnique(OrThrow) can be prepared", async () => {
  const { db, driver } = setup([{ id: 1, email: "a@x", name: null, role: "USER", balance: "0", visits: "0", active: true, createdAt: "2026-01-01 00:00:00", updatedAt: "2026-01-01 00:00:00" }]);
  const many = db.user.findMany({ where: { role: placeholder("role"), visits: { gt: placeholder("min") } }, orderBy: { id: "asc" }, take: 10 }).prepare();
  const r = await many.execute({ role: "ADMIN", min: 5n });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.role, "USER", "decoded back to the enum name");
  assert.deepEqual(driver.calls.at(-1)!.params, ["admin", "5"]);

  const one = db.user.findUnique({ where: { id: placeholder("id") } }).prepare();
  assert.equal((await one.execute({ id: 1 }))!.email, "a@x");
  assert.match(driver.calls.at(-1)!.sql, /LIMIT 1$/);

  driver.respond = () => [];
  const orThrow = db.user.findFirstOrThrow({ where: { email: placeholder("email") } }).prepare();
  await assert.rejects(orThrow.execute({ email: "nobody@x" }), /No 'User' record|not found/i);
});

test("object API with include falls back to filling the arguments", async () => {
  const { db, driver } = setup([{ id: 1, email: "a@x", name: null, role: "USER", balance: "0", visits: "0", active: true, createdAt: "2026-01-01 00:00:00", updatedAt: "2026-01-01 00:00:00" }]);
  const p = db.user.findMany({ where: { id: placeholder("id") }, include: { posts: { where: { published: placeholder("pub") } } } }).prepare();
  await p.execute({ id: 1, pub: true });
  const postQuery = driver.calls.find((c) => /FROM "APP"\."Post"/.test(c.sql))!;
  assert.ok(postQuery.params.includes(true), "the nested placeholder got its value");
});

test("missing, null and unknown placeholder values are rejected", async () => {
  const { db } = setup();
  const p = db.select({ id: user.id }).from(user).where(eq(user.id, placeholder("id"))).prepare();
  await assert.rejects(p.execute({}), (e: unknown) => e instanceof ValidationError && /Placeholder 'id' needs a value/.test(e.message));
  await assert.rejects(p.execute({ id: null }), /null is not allowed/);
  await assert.rejects(p.execute({ id: 1, other: 2 }), /Unknown placeholder 'other'; this query has 'id'/);
});

test("a placeholder outside a prepared query is refused before it reaches the database", async () => {
  const { db, driver } = setup();
  await assert.rejects(db.user.findMany({ where: { id: placeholder("id") } }), /only be used in a prepared query/);
  await assert.rejects(db.select({ id: user.id }).from(user).where(eq(user.id, placeholder("id"))).execute(), /only be used in a prepared query/);
  assert.equal(driver.calls.length, 0);
  assert.throws(() => db.user.count({ where: { id: 1 } }).then.call(undefined as never), TypeError);
  assert.equal((db.user.count({}) as unknown as { prepare?: unknown }).prepare, undefined, "only reads are preparable");
});
