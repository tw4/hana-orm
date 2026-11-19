/** `hana-orm studio` (issue #37): the HTTP API over a fake driver. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { compileSchema } from "../../src/schema/build.ts";
import { createClientClass } from "../../src/runtime/client.ts";
import { createStudio, filtersToWhere, fromWire, studioModels, toWire, type StudioClient } from "../../src/studio/server.ts";
import { STUDIO_JS } from "../../src/studio/ui.ts";
import { FakeDriver } from "../runtime/fake-driver.ts";

const contract = compileSchema(readFileSync(new URL("../fixtures/blog.hana", import.meta.url), "utf8"), { file: "blog.hana" });
const TOKEN = "test-token";

const USER_ROW = { id: 1, email: "a@x", name: null, role: "admin", balance: "12.50", visits: "7", active: true, createdAt: "2026-01-01 00:00:00", updatedAt: "2026-01-02 00:00:00" };

async function start(opts: { readOnly?: boolean; respond?: (sql: string, params: unknown[]) => unknown } = {}) {
  const driver = new FakeDriver();
  driver.respond = opts.respond ?? ((sql) => (sql.includes("COUNT(") ? [{ _all: 1 }] : sql.startsWith("SELECT") ? [USER_ROW] : 1));
  const Client = createClientClass(contract);
  const client = new Client({ driver });
  const studio = createStudio({ contract, client: client as unknown as StudioClient, token: TOKEN, label: "hana.local", ...(opts.readOnly ? { readOnly: true } : {}) });
  const url = await studio.listen(0);
  const base = new URL(url);
  return { driver, studio, url, base };
}

/** A raw request so tests can set the Host header (fetch does not allow it). */
function send(base: URL, method: string, path: string, opts: { body?: unknown; token?: string | null; host?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: opts.host ?? base.host };
    if (opts.token !== null) headers["x-studio-token"] = opts.token ?? TOKEN;
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = request({ host: "127.0.0.1", port: base.port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("metadata: models with their row key, columns, enum values and relations", () => {
  const models = studioModels(contract);
  const user = models.find((m) => m.name === "User")!;
  assert.deepEqual(user.key, ["id"]);
  const role = user.fields.find((f) => f.name === "role")!;
  assert.deepEqual(role.enumValues, ["USER", "ADMIN"]);
  assert.equal(role.generated, true, "has a default");
  assert.equal(user.fields.find((f) => f.name === "email")!.generated, false);
  const post = models.find((m) => m.name === "Post")!;
  assert.deepEqual(post.fields.find((f) => f.name === "author")!.relation, { model: "User", list: false, owner: true, localFields: ["authorId"], targetFields: ["id"] });
  assert.equal(models.find((m) => m.name === "User")!.fields.find((f) => f.name === "posts")!.relation!.owner, false);
  assert.deepEqual(models.find((m) => m.name === "Tag")!.key, ["name"]);
});

test("values: client values go out as JSON-safe text and come back typed per column", () => {
  assert.equal(toWire(new Date("2026-01-01T00:00:00Z")), "2026-01-01T00:00:00.000Z");
  assert.equal(toWire(5n), "5");
  assert.equal(toWire(Buffer.from("hi")), "aGk=");
  const user = contract.models.User!;
  const col = (n: string) => user.fields.find((f) => f.name === n) as never;
  assert.equal(fromWire(col("visits"), "9007199254740993"), 9007199254740993n);
  assert.equal(fromWire(col("id"), "42"), 42);
  assert.throws(() => fromWire(col("id"), "4.5"), /expects Int/);
  assert.equal(fromWire(col("balance"), " 1.20 "), "1.20");
  assert.throws(() => fromWire(col("balance"), "1e5"), /expects Decimal/);
  assert.equal(fromWire(col("active"), "false"), false);
  assert.deepEqual(fromWire(col("createdAt"), "2026-03-01T10:00:00Z"), new Date("2026-03-01T10:00:00Z"));
  assert.throws(() => fromWire(col("createdAt"), "yesterday"), /expects DateTime/);
  assert.equal(fromWire(col("name"), null), null);
});

test("filters become an object-API where; unknown columns and operators are refused", () => {
  const user = contract.models.User!;
  assert.deepEqual(filtersToWhere(user, []), {});
  assert.deepEqual(
    filtersToWhere(user, [
      { field: "email", op: "contains", value: "@x" },
      { field: "visits", op: "gt", value: "10" },
      { field: "name", op: "isNull" },
      { field: "role", op: "equals", value: "ADMIN" },
    ]),
    { AND: [{ email: { contains: "@x", mode: "insensitive" } }, { visits: { gt: 10n } }, { name: null }, { role: { equals: "ADMIN" } }] },
  );
  assert.throws(() => filtersToWhere(user, [{ field: "posts", op: "equals", value: 1 }]), /no column 'posts'/);
  assert.throws(() => filtersToWhere(user, [{ field: "id", op: "contains", value: "1" }]), /needs a String column/);
  assert.throws(() => filtersToWhere(user, [{ field: "id", op: "drop" as never }]), /Unknown filter/);
});

test("the page needs the token, is served with a strict CSP, and rejects other Host headers", async () => {
  const { studio, base } = await start();
  try {
    assert.equal((await send(base, "GET", "/", { token: null })).status, 403);
    const page = await send(base, "GET", `/?token=${TOKEN}`, { token: null });
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
    assert.match(page.text, /<script src="\/app\.js"/);
    assert.equal((await send(base, "GET", "/app.js", { token: null })).text, STUDIO_JS);
    // DNS rebinding: the right port under another name
    assert.equal((await send(base, "GET", `/?token=${TOKEN}`, { host: `evil.example:${base.port}` })).status, 421);
    assert.equal((await send(base, "GET", "/api/meta", { host: `evil.example:${base.port}` })).status, 421);
    assert.equal((await send(base, "GET", "/api/meta", { host: `localhost:${base.port}` })).status, 200);
  } finally {
    await studio.close();
  }
});

test("the API needs the token header", async () => {
  const { studio, base } = await start();
  try {
    assert.equal((await send(base, "GET", "/api/meta", { token: null })).status, 403);
    assert.equal((await send(base, "GET", "/api/meta", { token: "wrong" })).status, 403);
    const meta = await send(base, "GET", "/api/meta");
    assert.equal(meta.status, 200);
    assert.equal(meta.json.label, "hana.local");
    assert.equal(meta.json.readOnly, false);
    assert.ok(meta.json.models.some((m: { name: string }) => m.name === "PostTag"));
  } finally {
    await studio.close();
  }
});

test("rows: paged, sorted with the key as tiebreaker, filtered, decoded and counted", async () => {
  const { studio, base, driver } = await start();
  try {
    const filters = encodeURIComponent(JSON.stringify([{ field: "email", op: "contains", value: "@x" }]));
    const res = await send(base, "GET", `/api/rows?model=User&skip=50&take=25&sort=email&dir=desc&filters=${filters}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.total, 1);
    assert.deepEqual(res.json.rows[0], {
      id: 1, email: "a@x", name: null, role: "ADMIN", balance: "12.50", visits: "7", active: true,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const select = driver.calls.find((c) => c.sql.startsWith("SELECT") && !c.sql.includes("COUNT("))!;
    assert.match(select.sql, /ORDER BY .*"email" DESC.*"id" ASC/);
    assert.match(select.sql, /LIMIT 25 OFFSET 50/);
    assert.ok(select.params.includes("%@x%"), JSON.stringify(select.params));

    // take is capped, bad input is a 400
    await send(base, "GET", "/api/rows?model=User&take=100000");
    const capped = driver.calls.filter((c) => c.sql.startsWith("SELECT") && !c.sql.includes("COUNT(")).at(-1)!;
    assert.match(capped.sql, /LIMIT 500$/);
    assert.equal((await send(base, "GET", "/api/rows?model=Nope")).status, 400);
    assert.equal((await send(base, "GET", "/api/rows?model=User&filters=%5B")).status, 400);
    assert.equal((await send(base, "GET", "/api/rows?model=User&sort=posts")).status, 400);
  } finally {
    await studio.close();
  }
});

test("create, update by key and delete by key go through the client", async () => {
  const { studio, base, driver } = await start();
  try {
    const created = await send(base, "POST", "/api/rows", { body: { model: "User", data: { email: "b@x", visits: "3", createdAt: "2026-02-01T00:00:00Z" } } });
    assert.equal(created.status, 200, created.text);
    const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
    assert.match(insert.sql, /INSERT INTO "APP"\."USERS"/);
    assert.ok(insert.params.includes("b@x") && insert.params.includes("3"));

    const updated = await send(base, "PATCH", "/api/rows", { body: { model: "User", key: { id: "1" }, data: { name: "Ada" } } });
    assert.equal(updated.status, 200, updated.text);
    const upd = driver.calls.find((c) => c.sql.startsWith("UPDATE"))!;
    assert.match(upd.sql, /WHERE .*"id" = \?/);
    assert.deepEqual(upd.params.slice(0, 1), ["Ada"]);
    assert.equal(upd.params.at(-1), 1);

    const deleted = await send(base, "DELETE", "/api/rows", { body: { model: "User", key: { id: 1 } } });
    assert.equal(deleted.status, 200, deleted.text);
    assert.ok(driver.calls.some((c) => c.sql.startsWith("DELETE") && c.params.includes(1)));

    // the key is required, and it is the only way to address rows
    assert.equal((await send(base, "DELETE", "/api/rows", { body: { model: "User", key: {} } })).status, 400);
    assert.equal((await send(base, "PATCH", "/api/rows", { body: { model: "User", key: { id: 1 }, data: { posts: [] } } })).status, 400);
    assert.equal((await send(base, "PATCH", "/api/rows", { body: { model: "User", key: { id: 1 }, data: { visits: "many" } } })).status, 400);
    assert.equal((await send(base, "POST", "/api/rows", { body: "[1]" })).status, 400);
  } finally {
    await studio.close();
  }
});

test("database errors come back as messages; read-only mode refuses writes", async () => {
  const failing = await start({ respond: (sql) => {
    if (sql.startsWith("INSERT")) throw Object.assign(new Error("unique constraint violated"), { code: 301 });
    return sql.includes("COUNT(") ? [{ _all: 0 }] : [];
  } });
  try {
    const res = await send(failing.base, "POST", "/api/rows", { body: { model: "Tag", data: { name: "x" } } });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /unique constraint violated/);
  } finally {
    await failing.studio.close();
  }

  const ro = await start({ readOnly: true });
  try {
    assert.equal((await send(ro.base, "GET", "/api/meta")).json.readOnly, true);
    assert.equal((await send(ro.base, "GET", "/api/rows?model=User")).status, 200);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const res = await send(ro.base, method, "/api/rows", { body: { model: "User", key: { id: 1 }, data: { name: "x" } } });
      assert.equal(res.status, 400);
      assert.match(res.json.error, /read-only/);
    }
    assert.ok(!ro.driver.calls.some((c) => !c.sql.startsWith("SELECT")));
  } finally {
    await ro.studio.close();
  }
});

test("the page script is valid JavaScript and renders values only as text", () => {
  assert.doesNotThrow(() => new Function(STUDIO_JS));
  assert.doesNotMatch(STUDIO_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("cli: studio checks --port before connecting", async () => {
  const { main } = await import("../../src/cli/index.ts");
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => errors.push(String(m));
  try {
    assert.equal(await main(["studio", "--port", "http"]), 1);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join("\n"), /--port expects a port number/);
});
