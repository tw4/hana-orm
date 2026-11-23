import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/json/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { ValidationError } from "../../src/runtime/errors.ts";
import { jsonPath, jsonScalarRegex } from "../../src/runtime/where.ts";

function setup() {
  const driver = new FakeDriver();
  const db = new HanaClient({ driver });
  /** WHERE clause and params of the last SELECT. */
  const where = () => {
    const c = driver.calls.filter((x) => x.sql.startsWith("SELECT")).at(-1)!;
    return { sql: c.sql.slice(c.sql.indexOf(" WHERE ") + 7).replace(/ ORDER BY .*$/, "").replace(/ LIMIT .*$/, ""), params: c.params };
  };
  return { driver, db, where };
}

test("jsonPath builds HANA path literals and validates strings", () => {
  assert.equal(jsonPath(undefined, "f"), "$");
  assert.equal(jsonPath(["address", "city"], "f"), "$.address.city");
  assert.equal(jsonPath(["tags", 0], "f"), "$.tags[0]");
  assert.equal(jsonPath(["my key", 'q"uote'], "f"), '$."my key"."q\\"uote"');
  assert.equal(jsonPath("$.a[2].b", "f"), "$.a[2].b");
  assert.throws(() => jsonPath("a.b", "f"), ValidationError);
  assert.throws(() => jsonPath("$.a' OR 1=1 --", "f"), /Invalid JSON path/);
  assert.throws(() => jsonPath([-1], "f"), /Invalid path segment/);
  assert.throws(() => jsonPath({}, "f"), /must be a string or an array/);
});

test("jsonScalarRegex escapes regex characters of the JSON text", () => {
  assert.equal(jsonScalarRegex("a.b"), '"a\\.b"');
  assert.equal(jsonScalarRegex(1.5), "1\\.5");
  assert.equal(jsonScalarRegex(null), "null");
  assert.equal(jsonScalarRegex("[x]"), '"\\[x\\]"');
});

test("equals / not / comparisons with a path use JSON_VALUE; numbers compare as DOUBLE", async () => {
  const { db, where } = setup();
  await db.doc.findMany({ where: { data: { path: ["address", "city"], equals: "Berlin" } } });
  assert.deepEqual(where(), { sql: `JSON_VALUE(t0."data", '$.address.city') = ?`, params: ["Berlin"] });

  await db.doc.findMany({ where: { data: { path: "$.age", gte: 18, lt: 65 } } });
  assert.deepEqual(where(), { sql: `(JSON_VALUE(t0."data", '$.age' RETURNING DECIMAL) >= ?) AND (JSON_VALUE(t0."data", '$.age' RETURNING DECIMAL) < ?)`, params: [18, 65] });

  await db.doc.findMany({ where: { data: { path: ["active"], equals: true } } });
  assert.deepEqual(where(), { sql: `JSON_VALUE(t0."data", '$.active') = ?`, params: ["true"] });

  await db.doc.findMany({ where: { data: { path: ["deletedAt"], equals: null } } });
  assert.deepEqual(where(), { sql: `JSON_VALUE(t0."data", '$.deletedAt') IS NULL`, params: [] });

  await db.doc.findMany({ where: { data: { path: ["status"], not: "closed" } } });
  assert.deepEqual(where(), { sql: `NOT (JSON_VALUE(t0."data", '$.status') = ?)`, params: ["closed"] });
});

test("string filters match the string at the path, optionally case-insensitive, with LIKE escaping", async () => {
  const { db, where } = setup();
  await db.doc.findMany({ where: { data: { path: ["name"], string_contains: "50%_off" } } });
  assert.deepEqual(where(), { sql: `JSON_VALUE(t0."data", '$.name') LIKE ? ESCAPE '\\'`, params: ["%50\\%\\_off%"] });
  await db.doc.findMany({ where: { data: { path: ["name"], string_starts_with: "Ab", mode: "insensitive" } } });
  assert.deepEqual(where(), { sql: `LOWER(JSON_VALUE(t0."data", '$.name')) LIKE LOWER(?) || '' ESCAPE '\\'`, params: ["Ab%"] });
  await db.doc.findMany({ where: { data: { string_ends_with: "z" } } });
  assert.deepEqual(where(), { sql: `JSON_VALUE(t0."data", '$') LIKE ? ESCAPE '\\'`, params: ["%z"] }, "without a path: the document itself");
});

test("array filters test scalar elements of the array at the path", async () => {
  const { db, where } = setup();
  await db.doc.findMany({ where: { data: { path: ["tags"], array_contains: ["a", 2] } } });
  const w = where();
  assert.equal(
    w.sql,
    `(JSON_QUERY(t0."data", '$.tags') LIKE '[%') AND (JSON_QUERY(t0."data", '$.tags') LIKE_REGEXPR ? FLAG 's') AND (JSON_QUERY(t0."data", '$.tags') LIKE_REGEXPR ? FLAG 's')`,
  );
  const [ra, r2] = w.params.map((p) => new RegExp(p as string, "s"));
  assert.ok(ra!.test('["a",2]') && ra!.test('["x","a"]') && ra!.test('[ "a" ]'));
  assert.ok(!ra!.test('["ab"]') && !ra!.test('["b","xa"]'));
  assert.ok(r2!.test("[1,2,3]") && !r2!.test("[12]") && !r2!.test('["2"]'));

  await db.doc.findMany({ where: { data: { path: ["tags"], array_starts_with: "x", array_ends_with: null } } });
  const [s, e] = where().params.map((p) => new RegExp(p as string, "s"));
  assert.ok(s!.test('["x","y"]') && s!.test('["x"]') && !s!.test('["y","x"]'));
  assert.ok(e!.test("[1,null]") && !e!.test("[null,1]"));
});

test("a Json filter without operators-only keys is a whole-document value", async () => {
  const { db, where } = setup();
  await db.doc.findMany({ where: { data: { equals: { a: 1 } } } });
  assert.deepEqual(where(), { sql: `TO_NVARCHAR(t0."data") = ?`, params: ['{"a":1}'] });
  await db.doc.findMany({ where: { meta: { equals: null } } });
  assert.deepEqual(where(), { sql: `t0."meta" IS NULL`, params: [] });
  // an object whose keys are not filter keys is the value itself
  await db.doc.findMany({ where: { data: { kind: "x" } as never } });
  assert.deepEqual(where(), { sql: `TO_NVARCHAR(t0."data") = ?`, params: ['{"kind":"x"}'] });
});

test("invalid Json filters are rejected", async () => {
  const { db } = setup();
  await assert.rejects(db.doc.findMany({ where: { data: { path: ["a"], array_contains: [{ x: 1 }] as never } } }), /takes strings, numbers, booleans or null/);
  await assert.rejects(db.doc.findMany({ where: { data: { path: ["a"], gt: true as never } } }), /compares a string, number or null/);
  await assert.rejects(db.doc.findMany({ where: { data: { path: ["a"], lt: null as never } } }), /cannot compare with null/);
  await assert.rejects(db.doc.findMany({ where: { data: { path: ["a"], string_contains: 1 as never } } }), /expects a string/);
  await assert.rejects(db.doc.findMany({ where: { data: { path: "no-dollar" } } }), /Invalid JSON path/);
});
