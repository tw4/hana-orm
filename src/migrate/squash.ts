/**
 * `migrate squash` and `migrate split`.
 *
 * Migrations are lists of operations, so they combine mechanically:
 *
 * - squash concatenates the operations of a range of migrations into one migration that goes
 *   from the first one's `from` contract to the last one's `to` contract;
 * - split cuts one migration's operations into several migrations chained through generated
 *   intermediate contract hashes.
 *
 * The contract-hash chain stays intact: the migrations before and after the range keep their
 * `from`/`to`. The new `ops.json` lists what it replaces (`replaces`, with checksums), so a
 * database that already has the old migrations treats the new ones as applied.
 */

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CliContext, ParsedArgs } from "../cli/context.ts";
import { computeStatus } from "./apply.ts";
import type { MigrationState } from "./apply.ts";
import type { ContractSnapshot, LoadedMigration, NewMigration } from "./files.ts";
import { readMigrations, readSnapshot, referencedFiles, sanitizeMigrationName, short, timestampId, verifyGraph, writeMigration } from "./files.ts";
import type { Driver } from "../runtime/driver.ts";
import type { HistoryStore } from "./history.ts";
import { SqlHistoryStore } from "./history.ts";
import type { MigrationOp, ReplacedMigration } from "./ops.ts";

function stringFlag(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const n of names) if (typeof args.flags[n] === "string") return args.flags[n] as string;
  return undefined;
}

function boolFlag(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((n) => args.flags[n] === true || args.flags[n] === "true");
}

function relPath(ctx: CliContext, p: string): string {
  return relative(ctx.cwd, p) || p;
}

/** Finds a migration by full id or unique id prefix. */
export function findMigration(migrations: readonly LoadedMigration[], ref: string): LoadedMigration {
  const exact = migrations.find((m) => m.id === ref);
  if (exact) return exact;
  const matches = migrations.filter((m) => m.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length ? `'${ref}' matches several migrations: ${matches.map((m) => m.id).join(", ")}` : `No migration matches '${ref}'.`);
}

function replacedEntry(m: LoadedMigration): ReplacedMigration {
  return { id: m.id, checksum: m.checksum, ...(m.ops.replaces?.length ? { replaces: m.ops.replaces } : {}) };
}

function stampToDate(stamp: string): Date {
  return new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12), +stamp.slice(12, 14)));
}

async function readFiles(m: LoadedMigration, ops: readonly MigrationOp[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of referencedFiles(ops)) out[f] = await readFile(join(m.dir, f), "utf8");
  return out;
}

// ---- database check ---------------------------------------------------------------

interface DatabaseCheck {
  /** States of the affected migrations in the configured database; null when it could not be read. */
  states: Map<string, MigrationState> | null;
  db?: Driver;
  store?: HistoryStore;
}

/**
 * Reads the history of the configured database. A project without a reachable database can
 * still squash: databases elsewhere recognize the old migrations through `replaces`.
 */
async function checkDatabase(ctx: CliContext, migrations: readonly LoadedMigration[]): Promise<DatabaseCheck> {
  let db;
  try {
    db = await ctx.connect();
  } catch (e) {
    ctx.warn(`Could not check the database (${(e as Error).message}). Databases that already applied these migrations will treat the new ones as applied.`);
    return { states: null };
  }
  const store = new SqlHistoryStore(db, await ctx.defaultSchema());
  const report = computeStatus(migrations, await store.list());
  return { states: new Map(report.entries.map((e) => [e.id, e.state])), db, store };
}

/**
 * Applies the "refuse unless --baseline" rule. Returns an error message, or null to go on;
 * `baseline` is true when the new migrations must be recorded as applied.
 */
function appliedRule(affected: readonly LoadedMigration[], states: Map<string, MigrationState> | null, baselineFlag: boolean, verb: string): { error: string | null; baseline: boolean } {
  if (!states) return { error: null, baseline: false };
  const bad = affected.filter((m) => states.get(m.id) === "modified" || states.get(m.id) === "failed");
  if (bad.length) return { error: `Cannot ${verb}: ${bad.map((m) => `${m.id} is ${states.get(m.id)}`).join(", ")} in the database. Fix it first (migrate status).`, baseline: false };
  const applied = affected.filter((m) => states.get(m.id) === "applied");
  if (!applied.length) return { error: null, baseline: false };
  if (applied.length < affected.length) {
    return {
      error: `Cannot ${verb}: only part of it is applied in the database (${applied.map((m) => m.id).join(", ")}). Deploy the rest first, or choose a range that is entirely applied or entirely pending.`,
      baseline: false,
    };
  }
  if (!baselineFlag) {
    return {
      error:
        `Cannot ${verb}: ${applied.length === 1 ? `${applied[0]!.id} is` : "these migrations are"} already applied in the database. ` +
        "Pass --baseline to record the result as applied here; other databases with the same history recognize it automatically.",
      baseline: false,
    };
  }
  return { error: null, baseline: true };
}

async function recordApplied(check: DatabaseCheck, written: readonly LoadedMigration[], log: string): Promise<void> {
  const { db, store } = check;
  if (!db || !store) return;
  const at = new Date();
  for (const m of written) {
    await store.record(db, { id: m.id, name: m.name, checksum: m.checksum, fromHash: m.ops.from, toHash: m.ops.to, startedAt: at, finishedAt: at, status: "applied", log });
  }
  const last = written.at(-1)!;
  await store.writeMarker(db, last.ops.to, last.id);
}

// ---- squash -------------------------------------------------------------------------

export async function migrateSquash(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const fromRef = stringFlag(args, "from");
  const toRef = stringFlag(args, "to");
  if (!fromRef || !toRef) {
    ctx.warn("Usage: hana-orm migrate squash --from <id> --to <id> [--name <name>] [--baseline]");
    return 1;
  }
  const migrations = await readMigrations(ctx.migrationsDir);
  const graph = verifyGraph(migrations);
  if (graph.length) {
    for (const g of graph) ctx.warn(g.message);
    return 1;
  }
  const first = findMigration(migrations, fromRef);
  const last = findMigration(migrations, toRef);
  const i = migrations.indexOf(first);
  const j = migrations.indexOf(last);
  if (j < i) {
    ctx.warn(`--from ${first.id} comes after --to ${last.id}.`);
    return 1;
  }
  if (i === j) {
    ctx.warn("The range holds a single migration; there is nothing to squash.");
    return 1;
  }
  const range = migrations.slice(i, j + 1);
  const name = sanitizeMigrationName(stringFlag(args, "name") ?? `${first.name}_to_${last.name}`);
  const id = `${last.id.slice(0, 14)}_${name}`;
  const next = migrations[j + 1];
  if (migrations.some((m) => m.id === id)) {
    ctx.warn(`A migration ${id} already exists. Pass another --name.`);
    return 1;
  }
  if (next && id >= next.id) {
    ctx.warn(`The squashed migration ${id} would sort after ${next.id}. Pass another --name.`);
    return 1;
  }

  const check = await checkDatabase(ctx, migrations);
  try {
    const rule = appliedRule(range, check.states, boolFlag(args, "baseline"), `squash ${first.id}..${last.id}`);
    if (rule.error) {
      ctx.warn(rule.error);
      return 1;
    }

    // Files of sqlFile/script ops are prefixed with their migration id so they cannot collide.
    const ops: MigrationOp[] = [];
    const extraFiles: Record<string, string> = {};
    for (const m of range) {
      const files = await readFiles(m, m.ops.ops);
      for (const op of m.ops.ops) {
        if (op.file && (op.kind === "sqlFile" || op.kind === "script")) {
          const file = `${m.id}_${op.file}`;
          extraFiles[file] = files[op.file]!;
          ops.push({ ...op, file, description: op.description.replace(op.file, file) });
        } else ops.push(op);
      }
    }
    const snapshotText = await readFile(join(last.dir, "contract.json"), "utf8");
    const written = await writeMigration(ctx.migrationsDir, {
      id,
      name,
      from: first.ops.from,
      to: last.ops.to,
      ops,
      snapshot: JSON.parse(snapshotText) as ContractSnapshot,
      replaces: range.map(replacedEntry),
      ...(Object.keys(extraFiles).length ? { extraFiles } : {}),
    });
    for (const m of range) await rm(m.dir, { recursive: true, force: true });
    if (rule.baseline) await recordApplied(check, [written], `squash of ${range.map((m) => m.id).join(", ")}; recorded without running`);

    ctx.log(`Squashed ${range.length} migrations into ${relPath(ctx, written.dir)} (${ops.length} operation(s), ${short(written.ops.from)} → ${short(written.ops.to)}).`);
    if (rule.baseline) ctx.log("Recorded it as applied in the database without running it.");
    ctx.log("Databases that applied the old migrations treat it as applied; the others run it as one migration.");
    return 0;
  } finally {
    await check.db?.close();
  }
}

// ---- split ----------------------------------------------------------------------------

/** Parses `--at 2,4` (1-based op numbers that start a new part) against `count` ops. */
export function splitPoints(at: string | undefined, count: number): number[] {
  if (at === undefined) return Array.from({ length: count - 1 }, (_, k) => k + 1);
  const points = at.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  for (const p of points) {
    if (!Number.isInteger(p) || p < 2 || p > count) throw new Error(`--at expects operation numbers between 2 and ${count}; got '${at}'.`);
  }
  const sorted = [...new Set(points)].sort((a, b) => a - b);
  return sorted.map((p) => p - 1);
}

/** Contract hash between two parts of a split migration (no schema file produces it). */
export function intermediateHash(m: Pick<LoadedMigration, "id" | "checksum">, part: number): string {
  return createHash("sha256").update(`hana-orm:split:${m.id}:${m.checksum}:${part}`).digest("hex");
}

export async function migrateSplit(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const ref = args.positional.find((p) => /^\d/.test(p));
  if (!ref) {
    ctx.warn("Usage: hana-orm migrate split <id> [--at <op>,<op>…] [--baseline]");
    return 1;
  }
  const migrations = await readMigrations(ctx.migrationsDir);
  const graph = verifyGraph(migrations);
  if (graph.length) {
    for (const g of graph) ctx.warn(g.message);
    return 1;
  }
  const m = findMigration(migrations, ref);
  const count = m.ops.ops.length;
  if (count < 2) {
    ctx.warn(`Migration ${m.id} has ${count} operation(s); there is nothing to split.`);
    return 1;
  }
  const atFlag = args.flags.at;
  const cuts = splitPoints(typeof atFlag === "string" ? atFlag : atFlag === undefined ? undefined : "", count);
  if (!cuts.length) {
    ctx.warn("--at names no split point.");
    return 1;
  }
  const bounds = [0, ...cuts, count];
  const parts = bounds.slice(0, -1).map((start, k) => m.ops.ops.slice(start, bounds[k + 1]));

  const start = stampToDate(m.id.slice(0, 14)).getTime();
  const ids = parts.map((_, k) => `${timestampId(new Date(start + k * 1000))}_${sanitizeMigrationName(`${m.name}_part${k + 1}`)}`);
  const idx = migrations.indexOf(m);
  const next = migrations[idx + 1];
  if (next && ids.at(-1)! >= next.id) {
    ctx.warn(`The parts need ids up to ${ids.at(-1)}, which would sort after the next migration ${next.id}. Split it into fewer parts.`);
    return 1;
  }
  const clash = ids.find((id) => migrations.some((x) => x.id === id));
  if (clash) {
    ctx.warn(`A migration ${clash} already exists.`);
    return 1;
  }

  const check = await checkDatabase(ctx, migrations);
  try {
    const rule = appliedRule([m], check.states, boolFlag(args, "baseline"), `split ${m.id}`);
    if (rule.error) {
      ctx.warn(rule.error);
      return 1;
    }
    const snapshot = await readSnapshot(m);
    const replaces = [replacedEntry(m)];
    const planned: NewMigration[] = [];
    for (const [k, ops] of parts.entries()) {
      const files = await readFiles(m, ops);
      planned.push({
        id: ids[k]!,
        name: ids[k]!.slice(15),
        from: k === 0 ? m.ops.from : intermediateHash(m, k),
        to: k === parts.length - 1 ? m.ops.to : intermediateHash(m, k + 1),
        ops,
        // Parts before the last cannot know their data model; they carry the final one.
        snapshot,
        replaces,
        ...(Object.keys(files).length ? { extraFiles: files } : {}),
      });
    }
    // Write the parts next to the original, then remove it.
    const written: LoadedMigration[] = [];
    for (const p of planned) written.push(await writeMigration(ctx.migrationsDir, p));
    await rm(m.dir, { recursive: true, force: true });
    if (rule.baseline) await recordApplied(check, written, `split of ${m.id}; recorded without running`);

    ctx.log(`Split ${m.id} into ${written.length} migrations:`);
    for (const w of written) ctx.log(`  - ${w.id} (${w.ops.ops.length} operation(s))`);
    if (rule.baseline) ctx.log("Recorded them as applied in the database without running them.");
    return 0;
  } finally {
    await check.db?.close();
  }
}
