/**
 * Migration folders on disk:
 *
 * ```
 * migrations/
 *   20261117093000_init/
 *     ops.json        ← source of truth (checksummed)
 *     migration.sql   ← generated for review; for `--empty` migrations it holds the SQL to run
 *     contract.json   ← snapshot of the data model after this migration
 * ```
 *
 * The checksum is sha256 over `ops.json` (line endings normalized to LF, so a Git
 * `autocrlf` checkout does not look like an edit) plus every file referenced by a `sqlFile` op.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Contract } from "../schema/contract.ts";
import { CONTRACT_VERSION } from "../schema/contract.ts";
import type { MigrationOp, OpsFile } from "./ops.ts";
import { OPS_FORMAT_VERSION, opsToSql } from "./ops.ts";

export const OPS_FILE = "ops.json";
export const SQL_FILE = "migration.sql";
export const SCRIPT_FILE = "migration.ts";
export const CONTRACT_FILE = "contract.json";

const ID_PATTERN = /^(\d{14})_([A-Za-z0-9_]+)$/;

export interface LoadedMigration {
  id: string;
  name: string;
  dir: string;
  ops: OpsFile;
  checksum: string;
}

/** Data-model part of a contract stored with each migration. Connection settings are never stored. */
export interface ContractSnapshot {
  version: typeof CONTRACT_VERSION;
  hash: string;
  models: Contract["models"];
  enums: Contract["enums"];
}

export function toSnapshot(contract: Pick<Contract, "hash" | "models" | "enums">): ContractSnapshot {
  return { version: CONTRACT_VERSION, hash: contract.hash, models: contract.models, enums: contract.enums };
}

/** `YYYYMMDDHHmmss` in UTC. */
export function timestampId(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

/**
 * Timestamp for a new migration id: now, or one second after the newest existing migration
 * when that is not earlier (two plans in the same second, or a clock behind a teammate's).
 */
export function nextMigrationStamp(date: Date, existingIds: readonly string[]): string {
  let stamp = timestampId(date);
  const latest = existingIds.map((id) => id.slice(0, 14)).filter((x) => /^\d{14}$/.test(x)).sort().at(-1);
  if (latest && stamp <= latest) {
    const t = new Date(Date.UTC(+latest.slice(0, 4), +latest.slice(4, 6) - 1, +latest.slice(6, 8), +latest.slice(8, 10), +latest.slice(10, 12), +latest.slice(12, 14)) + 1000);
    stamp = timestampId(t);
  }
  return stamp;
}

/** `Add users table!` → `add_users_table`. */
export function sanitizeMigrationName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.slice(0, 80) || "migration";
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function computeChecksum(opsJson: string, files: Record<string, string> = {}): string {
  const h = createHash("sha256").update(normalizeNewlines(opsJson));
  for (const name of Object.keys(files).sort()) {
    h.update(`\n\u0000file:${name}\n`).update(normalizeNewlines(files[name]!));
  }
  return h.digest("hex");
}

function referencedFiles(ops: readonly MigrationOp[]): string[] {
  return [...new Set(ops.filter((o) => (o.kind === "sqlFile" || o.kind === "script") && o.file).map((o) => o.file!))];
}

export async function readMigrationDir(dir: string, id: string): Promise<LoadedMigration> {
  const opsJson = await readFile(join(dir, OPS_FILE), "utf8");
  let ops: OpsFile;
  try {
    ops = JSON.parse(opsJson) as OpsFile;
  } catch (e) {
    throw new Error(`Migration ${id}: ${OPS_FILE} is not valid JSON (${(e as Error).message})`);
  }
  if (ops.formatVersion !== OPS_FORMAT_VERSION) throw new Error(`Migration ${id}: unsupported ops.json formatVersion ${String(ops.formatVersion)}`);
  if (ops.id !== id) throw new Error(`Migration ${id}: ops.json has id '${ops.id}' but the folder is named '${id}'`);
  const files: Record<string, string> = {};
  for (const f of referencedFiles(ops.ops)) {
    if (f.includes("/") || f.includes("\\") || f.startsWith(".")) throw new Error(`Migration ${id}: invalid file reference '${f}'`);
    files[f] = await readFile(join(dir, f), "utf8");
  }
  const m = ID_PATTERN.exec(id)!;
  return { id, name: m[2]!, dir, ops, checksum: computeChecksum(opsJson, files) };
}

/** All migrations in `migrationsDir`, sorted by id (= creation time). */
export async function readMigrations(migrationsDir: string): Promise<LoadedMigration[]> {
  if (!existsSync(migrationsDir)) return [];
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const ids = entries
    .filter((e) => e.isDirectory() && ID_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
  const out: LoadedMigration[] = [];
  for (const id of ids) out.push(await readMigrationDir(join(migrationsDir, id), id));
  return out;
}

export async function readSnapshot(m: Pick<LoadedMigration, "dir" | "id">): Promise<ContractSnapshot> {
  const text = await readFile(join(m.dir, CONTRACT_FILE), "utf8");
  const snap = JSON.parse(text) as ContractSnapshot;
  if (!snap || typeof snap !== "object" || !snap.models) throw new Error(`Migration ${m.id}: ${CONTRACT_FILE} is not a contract snapshot`);
  return snap;
}

/** Reads the SQL statements of a `sqlFile` op. */
export async function readSqlFile(m: Pick<LoadedMigration, "dir">, file: string): Promise<string> {
  return readFile(join(m.dir, file), "utf8");
}

export interface NewMigration {
  id: string;
  name: string;
  from: string | null;
  to: string;
  ops: MigrationOp[];
  snapshot: ContractSnapshot;
  /** Contents for `migration.sql` when it is the executable file of an empty migration. */
  handWrittenSql?: string;
  /** More files to write into the folder, e.g. `migration.ts`. */
  extraFiles?: Record<string, string>;
}

export function buildOpsFile(m: Pick<NewMigration, "id" | "name" | "from" | "to" | "ops">): OpsFile {
  return { formatVersion: OPS_FORMAT_VERSION, id: m.id, name: m.name, from: m.from, to: m.to, ops: m.ops };
}

export function serializeOps(ops: OpsFile): string {
  return `${JSON.stringify(ops, null, 2)}\n`;
}

export function reviewSql(ops: OpsFile): string {
  const header = [
    `-- Migration ${ops.id}`,
    `-- from contract ${ops.from ?? "(empty database)"}`,
    `-- to   contract ${ops.to}`,
    "-- Generated from ops.json for review. Edits here are ignored; ops.json is what runs.",
    "",
  ];
  return header.join("\n") + opsToSql(ops.ops);
}

export const SCRIPT_TEMPLATE = `import type { MigrationScript } from "hana-orm/migrate";

// Data migration. Runs inside this migration's transaction, at its place in ops.json
// (after the schema changes listed before it). Throwing rolls the whole migration back.
const migration: MigrationScript = async ({ query, execute, log }) => {
  // const rows = await query<{ ID: number }>('SELECT "ID" FROM "USERS" WHERE "DISPLAY_NAME" IS NULL');
  // for (const row of rows) {
  //   await execute('UPDATE "USERS" SET "DISPLAY_NAME" = ? WHERE "ID" = ?', [\`user-\${row.ID}\`, row.ID]);
  // }
  log("nothing to do yet");
};

export default migration;
`;

export const EMPTY_MIGRATION_SQL = [
  "-- Hand-written migration. Statements are separated by ';' and run in order",
  "-- inside one transaction by `hana-orm migrate deploy`.",
  "",
  "",
].join("\n");

/** Writes a migration folder and returns it loaded (with checksum). */
export async function writeMigration(migrationsDir: string, m: NewMigration): Promise<LoadedMigration> {
  const dir = join(migrationsDir, m.id);
  if (existsSync(dir)) throw new Error(`Migration folder ${m.id} already exists`);
  await mkdir(dir, { recursive: true });
  const ops = buildOpsFile(m);
  await writeFile(join(dir, OPS_FILE), serializeOps(ops), "utf8");
  await writeFile(join(dir, SQL_FILE), m.handWrittenSql ?? reviewSql(ops), "utf8");
  await writeFile(join(dir, CONTRACT_FILE), `${JSON.stringify(m.snapshot, null, 2)}\n`, "utf8");
  for (const [name, content] of Object.entries(m.extraFiles ?? {})) await writeFile(join(dir, name), content, "utf8");
  return readMigrationDir(dir, m.id);
}

// ---- graph ----------------------------------------------------------------------

export interface GraphProblem {
  id: string;
  previousId: string | null;
  expectedFrom: string | null;
  actualFrom: string | null;
  message: string;
}

/**
 * Migrations form a chain by contract hash: each migration's `from` must equal the previous
 * migration's `to` (the first one starts from `null`).
 * A break means two branches each planned a migration from the same contract and both were
 * merged; the later one must be re-planned.
 */
export function verifyGraph(migrations: readonly Pick<LoadedMigration, "id" | "ops">[]): GraphProblem[] {
  const problems: GraphProblem[] = [];
  let prev: Pick<LoadedMigration, "id" | "ops"> | null = null;
  for (const m of migrations) {
    const expected = prev ? prev.ops.to : null;
    if (m.ops.from !== expected) {
      problems.push({
        id: m.id,
        previousId: prev?.id ?? null,
        expectedFrom: expected,
        actualFrom: m.ops.from,
        message: prev
          ? `Migration ${m.id} starts from contract ${short(m.ops.from)} but the previous migration ${prev.id} ends at ${short(expected)}. ` +
            "It was probably planned on another branch. Delete its folder and run `migrate plan` again on top of the latest migration."
          : `Migration ${m.id} is the first migration but starts from contract ${short(m.ops.from)} instead of an empty database.`,
      });
    }
    prev = m;
  }
  return problems;
}

export function short(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 12) : "(none)";
}
