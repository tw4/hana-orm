/** Typed raw SQL from .sql files (issue #11). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { functionName, generateTypedSqlModule, parseSqlFile } from "../../src/generator/typed-sql.ts";
import { describeFromHanaMetadata, decodeTypedRow, sqlColumnKind, typedSql } from "../../src/runtime/typed-sql.ts";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";
import { HanaClient } from "../generated/blog/index.ts";
import { FakeDriver } from "./fake-driver.ts";
import { withCtx } from "../migrate/cli-ctx.ts";

test("parseSqlFile turns :name parameters into ? and keeps strings, identifiers and comments", () => {
  const f = parseSqlFile(
    "get-active-users.sql",
    `-- active users older than :minAge (not a parameter)
SELECT "ID", ':notParam' AS "S", "NAME" FROM "USERS" /* :nor */ WHERE "AGE" >= :minAge AND "TEAM" = :team OR "BOSS_AGE" >= :minAge;`,
  );
  assert.equal(f.name, "getActiveUsers");
  assert.deepEqual(f.placeholders, ["minAge", "team", "minAge"]);
  assert.deepEqual(f.args, ["minAge", "team"]);
  assert.match(f.sql, /':notParam' AS "S"/);
  assert.match(f.sql, /\/\* :nor \*\//);
  assert.match(f.sql, /"AGE" >= \? AND "TEAM" = \? OR "BOSS_AGE" >= \?$/);
  assert.doesNotMatch(f.sql, /^--/, "a leading comment is not part of the statement");

  const p = parseSqlFile("by_id.sql", 'SELECT * FROM "T" WHERE "A" = ? AND "B" = ?');
  assert.deepEqual(p.args, ["p1", "p2"]);
  assert.equal(p.name, "byId");
  assert.deepEqual(parseSqlFile("cast.sql", "SELECT CAST(x AS INT)::text FROM DUMMY").placeholders, [], "a :: cast is not a parameter");

  assert.throws(() => parseSqlFile("two.sql", "SELECT 1 FROM DUMMY; SELECT 2 FROM DUMMY;"), /exactly one SQL statement, found 2/);
  assert.throws(() => parseSqlFile("mix.sql", "SELECT 1 FROM T WHERE A = ? AND B = :b"), /either \? or :name/);
  assert.throws(() => functionName("1st.sql"), /cannot derive a function name/);
  assert.equal(functionName("Monthly Report.sql"), "monthlyReport");
});

test("HANA type names and codes map to decoding kinds", () => {
  assert.equal(sqlColumnKind("NVARCHAR"), "string");
  assert.equal(sqlColumnKind("decimal(15,2)"), "decimal");
  assert.equal(sqlColumnKind("SECONDDATE"), "timestamp");
  assert.equal(sqlColumnKind("BIGINT"), "bigint");
  assert.equal(sqlColumnKind("ST_GEOMETRY"), "unknown");
  const d = describeFromHanaMetadata(
    [
      { columnName: "ID", typeName: "INTEGER", nullable: 0 },
      { columnName: "AT", type: 16, nullable: 1 },
    ],
    [
      { name: "P1", nativeTypeName: "INTEGER", direction: 1 },
      { name: "OUT", nativeTypeName: "INTEGER", direction: 4 },
    ],
  );
  assert.deepEqual(d, {
    columns: [
      { name: "ID", typeName: "INTEGER", nullable: false },
      { name: "AT", typeName: "TIMESTAMP", nullable: true },
    ],
    params: [{ name: "P1", typeName: "INTEGER" }],
  });
});

test("the generated module types arguments and rows", () => {
  const file = parseSqlFile("get-active-users.sql", 'SELECT "ID", "NAME", "BALANCE", "CREATED_AT", "VISITS" FROM "USERS" WHERE "AGE" >= :minAge AND "TEAM" = :team');
  const src = generateTypedSqlModule(
    [
      {
        file,
        description: {
          columns: [
            { name: "ID", typeName: "INTEGER", nullable: false },
            { name: "NAME", typeName: "NVARCHAR", nullable: true },
            { name: "BALANCE", typeName: "DECIMAL", nullable: false },
            { name: "CREATED_AT", typeName: "TIMESTAMP", nullable: false },
            { name: "VISITS", typeName: "BIGINT", nullable: false },
          ],
          params: [{ typeName: "INTEGER" }, { typeName: "NVARCHAR" }],
        },
      },
    ],
    "../../../src/runtime/index.ts",
  );
  assert.match(src, /export type GetActiveUsersRow = \{ "ID": number; "NAME": string \| null; "BALANCE": string; "CREATED_AT": Date; "VISITS": bigint \};/);
  assert.match(src, /export function getActiveUsers\(minAge: number \| null, team: string \| null\): \$r\.TypedSql<GetActiveUsersRow> \{/);
  assert.match(src, /\[minAge, team\], \{"ID":"int","NAME":"string","BALANCE":"decimal","CREATED_AT":"timestamp","VISITS":"bigint"\}/);
  assert.throws(
    () => generateTypedSqlModule([{ file, description: { columns: [], params: [{ typeName: "INTEGER" }] } }]),
    /HANA reports 1 parameter\(s\), the file has 2/,
  );
  assert.throws(
    () =>
      generateTypedSqlModule([
        { file: parseSqlFile("x.sql", "SELECT 1 AS A, 2 AS A FROM DUMMY"), description: { columns: [{ name: "A", typeName: "INTEGER", nullable: false }, { name: "A", typeName: "INTEGER", nullable: false }], params: [] } },
      ]),
    /two columns named 'A'/,
  );
});

test("$queryRawTyped binds the arguments and decodes the rows", async () => {
  const driver = new FakeDriver();
  driver.respond = () => [{ ID: 1, AT: "2026-11-18 10:00:00.0000000", N: "12", D: "1.50", X: "keep" }];
  const db = new HanaClient({ driver });
  const q = typedSql<{ ID: number; AT: Date; N: bigint; D: string; X: string }>('SELECT * FROM "T" WHERE "A" = ? AND "B" = ?', [new Date("2026-01-01T00:00:00Z"), 5n], {
    ID: "int",
    AT: "timestamp",
    N: "bigint",
    D: "decimal",
  });
  const [row] = await db.$queryRawTyped(q);
  assert.deepEqual(row, { ID: 1, AT: new Date("2026-11-18T10:00:00Z"), N: 12n, D: "1.50", X: "keep" });
  assert.deepEqual(driver.calls[0]!.params, ["2026-01-01 00:00:00.000", "5"]);
  // also inside a transaction and in $transaction([...])
  await db.$transaction(async (tx) => tx.$queryRawTyped(q));
  const [rows] = await db.$transaction([db.$queryRawTyped(q)]);
  assert.equal(rows!.length, 1);
  assert.deepEqual(decodeTypedRow({ A: null }, { A: "int" }), { A: null });
});

test("HanaDriver.describe prepares without executing and drops the statement", async () => {
  const log: string[] = [];
  const module = {
    createConnection: () => ({
      connect: (_o: unknown, cb: (e: Error | null) => void) => cb(null),
      exec: (sql: string, _p: unknown, cb: (e: Error | null, r: unknown) => void) => (log.push(`exec ${sql}`), cb(null, [])),
      prepare: (sql: string, cb: (e: Error | null, s: unknown) => void) => {
        log.push(`prepare ${sql}`);
        if (sql.includes("NOPE")) return cb(Object.assign(new Error("invalid table name: NOPE"), { code: 259 }), undefined);
        cb(null, {
          getColumnInfo: () => [{ columnName: "ID", typeName: "INTEGER", nullable: 0 }],
          getParameterInfo: () => [{ name: "P1", nativeTypeName: "NVARCHAR", direction: 1 }],
          execBatch: () => {},
          drop: (cb2: (e: Error | null) => void) => (log.push("drop"), cb2(null)),
        });
      },
      setAutoCommit: () => {},
      commit: (cb: (e: Error | null) => void) => cb(null),
      rollback: (cb: (e: Error | null) => void) => cb(null),
      disconnect: (cb: (e: Error | null) => void) => cb(null),
    }),
  };
  const d = new HanaDriver({ host: "h", port: 1, user: "u", password: "p" }, { poolSize: 1, hanaModule: module });
  assert.deepEqual(await d.describe('SELECT "ID" FROM "T" WHERE "N" = ?'), { columns: [{ name: "ID", typeName: "INTEGER", nullable: false }], params: [{ name: "P1", typeName: "NVARCHAR" }] });
  assert.deepEqual(log, ['prepare SELECT "ID" FROM "T" WHERE "N" = ?', "drop"], "nothing is executed");
  await assert.rejects(d.describe("SELECT * FROM NOPE"), /invalid table name/);
  await d.close();
});

test("hana-orm generate --sql writes sql.ts next to the client", () =>
  withCtx(async (ctx) => {
    // the CLI resolves sql/ next to the schema; write a schema with a generator output
    writeFileSync(ctx.schemaPath, 'datasource db {\n  provider = "hana"\n}\n\ngenerator client {\n  provider = "hana-orm"\n  output   = "./out"\n}\n\nmodel T {\n  id Int @id\n}\n');
    mkdirSync(join(ctx.cwd, "sql"));
    writeFileSync(join(ctx.cwd, "sql", "by-id.sql"), 'SELECT "id" FROM "T" WHERE "id" = :id');
    const described: string[] = [];
    ctx.connect = async () =>
      Object.assign(new FakeDriver(), {
        describe: async (sql: string) => {
          described.push(sql);
          return { columns: [{ name: "id", typeName: "INTEGER", nullable: false }], params: [{ typeName: "INTEGER" }] };
        },
      });
    const { cmdGenerate } = await import("../../src/cli/index.ts");
    assert.equal(await cmdGenerate(ctx, { positional: [], flags: { sql: true } }), 0, ctx.warns.join("\n"));
    assert.deepEqual(described, ['SELECT "id" FROM "T" WHERE "id" = ?']);
    const out = readFileSync(join(ctx.cwd, "out", "sql.ts"), "utf8");
    assert.match(out, /export function byId\(id: number \| null\): \$r\.TypedSql<ByIdRow>/);
  }));
