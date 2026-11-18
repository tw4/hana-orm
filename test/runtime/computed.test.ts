/** Result extensions: computed fields in `$extends` (issue #7). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";

const ROW = { id: 1, email: "ada@example.com", name: "Ada", role: "USER", balance: "10.00", visits: "3", active: true, CREATED_AT: "2026-01-01 00:00:00", UPDATED_AT: "2026-01-01 00:00:00" };

function setup(options: Record<string, unknown> = {}) {
  const driver = new FakeDriver();
  driver.respond = (sql) => {
    if (!sql.startsWith("SELECT")) return undefined;
    // answer only the columns the SELECT asks for, like the database would
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ROW)) {
      const alias = k === "CREATED_AT" ? "createdAt" : k === "UPDATED_AT" ? "updatedAt" : k;
      if (sql.includes(`"${k}"`)) row[alias] = v;
    }
    return [row];
  };
  const base = new HanaClient({ driver, ...options });
  const db = base.$extends({
    result: {
      user: {
        label: { needs: { name: true, email: true }, compute: (u) => `${u.name} <${u.email}>` },
        isRich: { needs: { balance: true }, compute: (u) => Number(u.balance) > 5 },
      },
    },
  });
  const selectSql = () => driver.calls.filter((c) => c.sql.startsWith("SELECT")).at(-1)!.sql;
  return { driver, base, db, selectSql };
}

test("computed fields are added to every row by default", async () => {
  const { db } = setup();
  const [u] = await db.user.findMany();
  assert.equal(u!.label, "Ada <ada@example.com>");
  assert.equal(u!.isRich, true);
  assert.equal(u!.email, "ada@example.com");
});

test("with select, only selected computed fields are computed and helper fields are dropped", async () => {
  const { db, selectSql } = setup();
  const u = await db.user.findFirst({ select: { id: true, label: true } });
  assert.deepEqual(u, { id: 1, label: "Ada <ada@example.com>" });
  assert.match(selectSql(), /"name"/, "needed fields are fetched");
  assert.doesNotMatch(selectSql(), /"balance"/, "fields of unselected computed fields are not");
  // a needed field that is also selected stays
  const v = await db.user.findFirst({ select: { email: true, label: true } });
  assert.deepEqual(v, { email: "ada@example.com", label: "Ada <ada@example.com>" });
});

test("omit leaves out computed fields; omitting a needed field still computes and then drops it", async () => {
  const { db } = setup();
  const u = await db.user.findFirst({ omit: { isRich: true, email: true } });
  assert.ok(u);
  assert.equal("isRich" in u, false);
  assert.equal(u.label, "Ada <ada@example.com>");
  assert.equal("email" in u, false, "email was fetched only for the computation");
});

test("a field omitted client-wide is fetched for a computation and removed again", async () => {
  const { db, selectSql } = setup({ omit: { user: { name: true } } });
  const u = await db.user.findFirst();
  assert.ok(u);
  assert.match(selectSql(), /"name"/);
  assert.equal(u.label, "Ada <ada@example.com>");
  assert.equal("name" in u, false);
});

test("writes return computed fields; batch operations are unchanged", async () => {
  const { db } = setup();
  const u = await db.user.update({ where: { id: 1 }, data: { name: "Ada" }, select: { id: true, isRich: true } });
  assert.deepEqual(u, { id: 1, isRich: true });
  const r = await db.user.updateMany({ where: { id: 1 }, data: { active: false } });
  assert.equal(typeof r.count, "number");
});

test("query hooks see arguments without computed names", async () => {
  const { db } = setup();
  let seen: unknown;
  const hooked = db.$extends({
    query: {
      user: {
        async findFirst({ args, query }) {
          seen = args;
          return query(args);
        },
      },
    },
  });
  await hooked.user.findFirst({ select: { id: true, label: true } });
  assert.deepEqual(seen, { select: { id: true, name: true, email: true } });
});

test("later extensions add and override computed fields; the base client is unchanged", async () => {
  const { base, db } = setup();
  const more = db.$extends({ result: { user: { label: { needs: { id: true }, compute: (u) => `#${u.id}` }, initial: { needs: { name: true }, compute: (u) => u.name?.[0] ?? "" } } } });
  const u = await more.user.findFirstOrThrow();
  assert.equal(u.label, "#1");
  assert.equal(u.initial, "A");
  assert.equal(u.isRich, true);
  const plain = await base.user.findFirstOrThrow();
  assert.equal("label" in plain, false);
});

test("result extensions are validated when the client is extended", () => {
  const { base } = setup();
  assert.throws(() => base.$extends({ result: { user: { x: { needs: { nope: true }, compute: () => 1 } } } } as never), /names 'nope', which is not a scalar field/);
  assert.throws(() => base.$extends({ result: { user: { email: { compute: () => 1 } } } } as never), /has the name of a model field/);
  assert.throws(() => base.$extends({ result: { user: { x: { needs: {} } } } } as never), /needs a compute\(row\) function/);
});
