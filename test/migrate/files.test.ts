import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpsFile,
  computeChecksum,
  readMigrations,
  readSnapshot,
  sanitizeMigrationName,
  serializeOps,
  timestampId,
  toSnapshot,
  verifyGraph,
  writeMigration,
} from "../../src/migrate/files.ts";
import type { LoadedMigration } from "../../src/migrate/files.ts";
import { blogContract } from "./fixtures.ts";
import { splitSqlStatements } from "../../src/migrate/sql-split.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hana-orm-files-"));
}

test("timestampId and sanitizeMigrationName", () => {
  assert.equal(timestampId(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "20260102030405");
  assert.equal(sanitizeMigrationName("Add users table!"), "add_users_table");
  assert.equal(sanitizeMigrationName("  "), "migration");
});

test("ops.json round trip: write, read back, snapshot excludes datasource", async () => {
  const dir = await tmp();
  try {
    const c = blogContract();
    c.datasource.url = "hana://example-user:example-secret@db.invalid:30015";
    const written = await writeMigration(dir, {
      id: "20260101000000_init",
      name: "init",
      from: null,
      to: c.hash,
      ops: [{ kind: "createTable", description: "Create table", sql: ["CREATE COLUMN TABLE \"T\" (\"ID\" INTEGER)"] }],
      snapshot: toSnapshot(c),
    });
    const [loaded] = await readMigrations(dir);
    assert.ok(loaded);
    assert.deepEqual(loaded.ops, buildOpsFile({ id: "20260101000000_init", name: "init", from: null, to: c.hash, ops: written.ops.ops }));
    assert.equal(loaded.checksum, written.checksum);
    assert.equal(loaded.name, "init");
    const snap = await readSnapshot(loaded);
    assert.equal(snap.hash, c.hash);
    assert.deepEqual(snap.models, c.models);
    const raw = await readFile(join(dir, "20260101000000_init", "contract.json"), "utf8");
    assert.ok(!raw.includes("example-secret") && !raw.includes("datasource"));
    const sql = await readFile(join(dir, "20260101000000_init", "migration.sql"), "utf8");
    assert.match(sql, /CREATE COLUMN TABLE "T" \("ID" INTEGER\);/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checksum detects edits but ignores CRLF line endings", async () => {
  const dir = await tmp();
  try {
    const m = await writeMigration(dir, { id: "20260101000000_a", name: "a", from: null, to: "h1", ops: [], snapshot: { version: 1, hash: "h1", models: {}, enums: {} } });
    const file = join(dir, "20260101000000_a", "ops.json");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/\n/g, "\r\n"));
    assert.equal((await readMigrations(dir))[0]!.checksum, m.checksum);
    await writeFile(file, text.replace('"to": "h1"', '"to": "h2"'));
    assert.notEqual((await readMigrations(dir))[0]!.checksum, m.checksum);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checksum covers hand-written SQL files", () => {
  const ops = serializeOps(buildOpsFile({ id: "x", name: "x", from: null, to: "h", ops: [{ kind: "sqlFile", description: "d", sql: [], file: "migration.sql" }] }));
  assert.notEqual(computeChecksum(ops, { "migration.sql": "SELECT 1 FROM DUMMY;" }), computeChecksum(ops, { "migration.sql": "SELECT 2 FROM DUMMY;" }));
});

test("folder name must match ops.json id", async () => {
  const dir = await tmp();
  try {
    await writeMigration(dir, { id: "20260101000000_a", name: "a", from: null, to: "h1", ops: [], snapshot: { version: 1, hash: "h1", models: {}, enums: {} } });
    const file = join(dir, "20260101000000_a", "ops.json");
    await writeFile(file, (await readFile(file, "utf8")).replace('"id": "20260101000000_a"', '"id": "other"'));
    await assert.rejects(readMigrations(dir), /has id 'other'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function mig(id: string, from: string | null, to: string): Pick<LoadedMigration, "id" | "ops"> {
  return { id, ops: { formatVersion: 1, id, name: id, from, to, ops: [] } };
}

test("graph: linear chain is valid, including empty migrations (from == to)", () => {
  assert.deepEqual(verifyGraph([mig("1_a", null, "A"), mig("2_b", "A", "A"), mig("3_c", "A", "B")]), []);
});

test("graph: diverged branches are reported", () => {
  const problems = verifyGraph([mig("1_a", null, "A"), mig("2_feature_x", "A", "B"), mig("3_feature_y", "A", "C")]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.id, "3_feature_y");
  assert.equal(problems[0]!.previousId, "2_feature_x");
  assert.equal(problems[0]!.expectedFrom, "B");
  assert.match(problems[0]!.message, /planned on another branch/);
});

test("graph: first migration must start from an empty database", () => {
  assert.equal(verifyGraph([mig("1_a", "X", "A")]).length, 1);
});

test("splitSqlStatements handles strings, comments and quoted identifiers", () => {
  const script = [
    "-- header comment; with semicolon",
    "UPDATE \"T;1\" SET \"A\" = 'x;y' WHERE \"B\" = 'it''s';",
    "/* block; comment */ INSERT INTO \"T\" VALUES (1)",
    ";",
    "  -- only a comment;",
  ].join("\n");
  assert.deepEqual(splitSqlStatements(script), [
    "UPDATE \"T;1\" SET \"A\" = 'x;y' WHERE \"B\" = 'it''s'",
    '/* block; comment */ INSERT INTO "T" VALUES (1)',
  ]);
});
