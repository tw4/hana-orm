import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/m2m/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { NotFoundError, ValidationError } from "../../src/runtime/errors.ts";

function setup() {
  const driver = new FakeDriver();
  const db = new HanaClient({ driver });
  return { driver, db };
}

const JOIN = `"APP"."_ArticleToCategory"`;

test("relation filters, _count and orderBy _count go through the join table", async () => {
  const { driver, db } = setup();
  await db.article.findMany({ where: { categories: { some: { label: "x" } } }, select: { id: true, _count: { select: { categories: true } } }, orderBy: { categories: { _count: "desc" } } });
  const { sql, params } = driver.calls[0]!;
  assert.match(sql, /\(SELECT COUNT\(\*\) FROM "APP"\."Category" t\d+ WHERE EXISTS \(SELECT 1 FROM "APP"\."_ArticleToCategory" t\d+j WHERE t\d+j\."A" = t0\."id" AND t\d+j\."B" = t\d+\."id"\)\) AS "_count\.categories"/);
  assert.match(sql, /WHERE \(EXISTS \(SELECT 1 FROM "APP"\."Category" (t\d+) WHERE EXISTS \(SELECT 1 FROM "APP"\."_ArticleToCategory" \1j WHERE \1j\."A" = t0\."id" AND \1j\."B" = \1\."id"\) AND \(\1\."label" = \?\)\)\)/);
  assert.match(sql, /ORDER BY \(SELECT COUNT\(\*\) FROM "APP"\."Category" t\d+ WHERE EXISTS/);
  assert.deepEqual(params, ["x"]);
});

test("include reads the links, then the linked rows once, and gives each parent its rows in order", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.startsWith(`SELECT t0."id" AS "id", t0."title"`)) return [{ id: 1, title: "a" }, { id: 2, title: "b" }, { id: 3, title: "c" }];
    if (sql.includes(`FROM ${JOIN} WHERE "A" IN`)) return [{ l: 1, t: "x" }, { l: 1, t: "y" }, { l: 2, t: "y" }];
    if (sql.includes(`FROM "APP"."Category"`)) return [{ id: "y", label: "Y" }, { id: "x", label: "X" }];
    return [];
  };
  const rows = await db.article.findMany({ include: { categories: { orderBy: { label: "desc" } } } });
  assert.deepEqual(
    rows.map((r) => [r.id, r.categories.map((c) => c.id)]),
    [
      [1, ["y", "x"]],
      [2, ["y"]],
      [3, []],
    ],
  );
  assert.notEqual(rows[0]!.categories[0], rows[1]!.categories[0], "parents get separate objects");
  const links = driver.calls[1]!;
  assert.equal(links.sql, `SELECT "A" AS "l", "B" AS "t" FROM ${JOIN} WHERE "A" IN (?, ?, ?)`);
  assert.deepEqual(links.params, [1, 2, 3]);
  // the linked rows are filtered through the other side of the relation
  assert.match(driver.calls[2]!.sql, /FROM "APP"\."Category" t0 WHERE \(EXISTS \(SELECT 1 FROM "APP"\."ARTICLES" (t\d+) WHERE EXISTS \(SELECT 1 FROM "APP"\."_ArticleToCategory" \1j WHERE \1j\."B" = t0\."id" AND \1j\."A" = \1\."id"\) AND \(\1\."id" IN \(\?, \?, \?\)\)\)\) ORDER BY t0\."label" DESC/);
  assert.equal(driver.calls.length, 3);
});

test("include with take pages per parent and skips the second query when nothing is linked", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.startsWith(`SELECT t0."id" AS "id", t0."title"`)) return [{ id: 1, title: "a" }];
    if (sql.includes(`FROM ${JOIN}`)) return [];
    return [];
  };
  const rows = await db.article.findMany({ include: { categories: { take: 1 } } });
  assert.deepEqual(rows[0]!.categories, []);
  assert.equal(driver.calls.length, 2);
  await assert.rejects(db.article.findMany({ include: { categories: { distinct: ["label"] } } }), /'distinct' is not supported/);
});

test("nested writes link and unlink rows in the join table", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => {
    if (sql.startsWith("SELECT CURRENT_IDENTITY_VALUE()")) return [{ id: 7 }];
    if (sql.includes(`FROM "APP"."Category"`)) return [{ id: "x" }];
    if (sql.includes(`FROM "APP"."ARTICLES"`)) return [{ id: 7, title: "t" }];
    return 1;
  };
  await db.article.create({ data: { title: "t", categories: { connect: [{ id: "x" }], create: { id: "n", label: "N" } } } });
  const writes = driver.calls.filter((c) => !c.sql.startsWith("SELECT"));
  assert.deepEqual(
    writes.map((c) => [c.sql, c.params]),
    [
      [`INSERT INTO "APP"."ARTICLES" ("title") VALUES (?)`, ["t"]],
      [`INSERT INTO "APP"."Category" ("id", "label") VALUES (?, ?)`, ["n", "N"]],
      [`INSERT INTO ${JOIN} ("A", "B") SELECT ?, ? FROM DUMMY WHERE NOT EXISTS (SELECT 1 FROM ${JOIN} WHERE "A" = ? AND "B" = ?)`, [7, "n", 7, "n"]],
      [`INSERT INTO ${JOIN} ("A", "B") SELECT ?, ? FROM DUMMY WHERE NOT EXISTS (SELECT 1 FROM ${JOIN} WHERE "A" = ? AND "B" = ?)`, [7, "x", 7, "x"]],
    ],
  );

  driver.calls = [];
  await db.article.update({ where: { id: 7 }, data: { categories: { set: [{ id: "x" }], disconnect: { id: "x" } } } });
  const updates = driver.calls.filter((c) => !c.sql.startsWith("SELECT")).map((c) => [c.sql, c.params]);
  assert.deepEqual(updates, [
    [`DELETE FROM ${JOIN} WHERE "A" = ?`, [7]],
    [`INSERT INTO ${JOIN} ("A", "B") SELECT ?, ? FROM DUMMY WHERE NOT EXISTS (SELECT 1 FROM ${JOIN} WHERE "A" = ? AND "B" = ?)`, [7, "x", 7, "x"]],
    [`DELETE FROM ${JOIN} WHERE "A" = ? AND "B" = ?`, [7, "x"]],
  ]);
  assert.ok(driver.calls.every((c) => c.tx));
});

test("a self relation links from the side of the field", async () => {
  const { driver, db } = setup();
  driver.respond = (sql, params) => (sql.includes(`FROM "APP"."Member"`) ? [{ id: params[0] }] : 1);
  await db.member.update({ where: { id: 1 }, data: { following: { connect: { id: 2 } } } });
  const link = driver.calls.find((c) => c.sql.startsWith(`INSERT INTO "APP"."_Follows"`))!;
  // following is the B side: B = this member, A = the followed one
  assert.equal(link.sql, `INSERT INTO "APP"."_Follows" ("B", "A") SELECT ?, ? FROM DUMMY WHERE NOT EXISTS (SELECT 1 FROM "APP"."_Follows" WHERE "B" = ? AND "A" = ?)`);
  assert.deepEqual(link.params, [1, 2, 1, 2]);
});

test("nested many-to-many errors", async () => {
  const { driver, db } = setup();
  driver.respond = (sql) => (sql.includes(`FROM "APP"."ARTICLES"`) ? [{ id: 1, title: "t" }] : sql.startsWith("SELECT CURRENT_IDENTITY_VALUE()") ? [{ id: 1 }] : []);
  await assert.rejects(db.article.create({ data: { title: "t", categories: { createMany: { data: [] } } as never } }), /'createMany' is only allowed in update|createMany is not available/);
  await assert.rejects(db.article.update({ where: { id: 1 }, data: { categories: { createMany: { data: [] } } as never } }), /createMany is not available on the many-to-many relation 'categories'/);
  await assert.rejects(db.article.create({ data: { title: "t", categories: { disconnect: { id: "x" } } as never } }), ValidationError);
  await assert.rejects(db.article.update({ where: { id: 1 }, data: { categories: { connect: { id: "missing" } } } }), NotFoundError);
});
