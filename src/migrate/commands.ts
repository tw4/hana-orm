/** Implementations of the `db` and `migrate` CLI commands. */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import type { CliContext, ParsedArgs } from "../cli/context.ts";
import type { Driver } from "../runtime/driver.ts";
import type { Contract } from "../schema/contract.ts";
import { currentSchema, introspect } from "../introspect/catalog.ts";
import { makeTableFilter, parsePatternList } from "../introspect/filter.ts";
import { renderSchema } from "../introspect/render.ts";
import { computeStatus, deploy, deployBlockers, runOps } from "./apply.ts";
import { contractToPhysical } from "./contract-to-physical.ts";
import { diffSchemas, emptyRenames } from "./diff.ts";
import { compareWithLive } from "./drift.ts";
import type { ContractSnapshot, LoadedMigration } from "./files.ts";
import {
  EMPTY_MIGRATION_SQL,
  SQL_FILE,
  readMigrations,
  readSnapshot,
  readSqlFile,
  sanitizeMigrationName,
  short,
  timestampId,
  toSnapshot,
  verifyGraph,
  writeMigration,
} from "./files.ts";
import type { HistoryRecord } from "./history.ts";
import { SqlHistoryStore } from "./history.ts";
import type { MigrationOp } from "./ops.ts";
import { destructiveMessage, destructiveOps, opsToSql } from "./ops.ts";
import { emptyPhysical, tableKey } from "./physical.ts";
import { findRenameCandidates, renamesFromContracts, withRenames } from "./renames.ts";
import type { RenameCandidates } from "./renames.ts";

/** Hash used for the model of an empty database (first empty migration). */
export const EMPTY_CONTRACT_HASH = createHash("sha256").update("hana-orm:empty-contract").digest("hex");

const MAX_WARNINGS = 50;

function flag(args: ParsedArgs, ...names: string[]): string | boolean | undefined {
  for (const n of names) if (args.flags[n] !== undefined) return args.flags[n];
  return undefined;
}

function stringFlag(args: ParsedArgs, ...names: string[]): string | undefined {
  const v = flag(args, ...names);
  return typeof v === "string" ? v : undefined;
}

function boolFlag(args: ParsedArgs, ...names: string[]): boolean {
  const v = flag(args, ...names);
  return v === true || v === "true";
}

async function withDb<T>(ctx: CliContext, fn: (db: Driver) => Promise<T>): Promise<T> {
  const db = await ctx.connect();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function resolveDefaultSchema(ctx: CliContext, db: Driver): Promise<string> {
  return (await ctx.defaultSchema()) ?? (await currentSchema(db));
}

async function historyStore(ctx: CliContext, db: Driver): Promise<SqlHistoryStore> {
  return new SqlHistoryStore(db, await ctx.defaultSchema());
}

function printOps(ctx: CliContext, ops: readonly MigrationOp[]): void {
  for (const op of ops) ctx.log(`  ${op.destructive ? "!" : "-"} ${op.description}`);
}

function warnAll(ctx: CliContext, warnings: readonly string[]): void {
  for (const w of warnings.slice(0, MAX_WARNINGS)) ctx.warn(w);
  if (warnings.length > MAX_WARNINGS) ctx.warn(`… and ${warnings.length - MAX_WARNINGS} more warning(s).`);
}

function relPath(ctx: CliContext, p: string): string {
  return relative(ctx.cwd, p) || p;
}

// ---- db pull --------------------------------------------------------------------

export async function dbPull(args: ParsedArgs, ctx: CliContext): Promise<number> {
  return withDb(ctx, async (db) => {
    const defaultSchema = await resolveDefaultSchema(ctx, db);
    const schema = stringFlag(args, "db-schema", "dbSchema") ?? defaultSchema;
    const filter = makeTableFilter(parsePatternList(flag(args, "tables")), parsePatternList(flag(args, "exclude")));
    const views = boolFlag(args, "views");
    const physical = await introspect(db, { schemas: [schema], defaultSchema, ...(filter ? { filter } : {}), views });
    const existingSource = existsSync(ctx.schemaPath) ? await readFile(ctx.schemaPath, "utf8") : undefined;
    const scopeKey = (name: string): string => tableKey(schema === defaultSchema ? undefined : schema, name);
    const inScope = (key: string): boolean => {
      const dot = key.indexOf(".");
      const s = dot < 0 ? defaultSchema : key.slice(0, dot);
      const name = dot < 0 ? key : key.slice(dot + 1);
      return s === schema && scopeKey(name) === key && (filter ? filter(name) : true);
    };
    const result = renderSchema(physical, { ...(existingSource !== undefined ? { existingSource, existingFile: ctx.schemaPath } : {}), defaultSchema, inScope });
    warnAll(ctx, result.warnings);
    const tableCount = Object.keys(physical.tables).length;
    const viewCount = Object.keys(physical.views ?? {}).length;
    if (boolFlag(args, "print")) {
      ctx.log(result.source);
      return 0;
    }
    await writeFile(ctx.schemaPath, result.source, "utf8");
    ctx.log(
      `Introspected ${tableCount} table(s)${views ? ` and ${viewCount} view(s)` : ""} from schema "${schema}" into ${relPath(ctx, ctx.schemaPath)}: ` +
        `${result.added.length} new model(s), ${result.updated.length} updated.`,
    );
    return 0;
  });
}

// ---- db push / sign / verify --------------------------------------------------------

export async function dbPush(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const contract = await ctx.loadContract();
  return withDb(ctx, async (db) => {
    const defaultSchema = await resolveDefaultSchema(ctx, db);
    const { ops } = await compareWithLive(db, contract, defaultSchema);
    const store = await historyStore(ctx, db);
    if (!ops.length) {
      ctx.log("The database is already in sync with the schema.");
      if (!boolFlag(args, "dry-run", "dryRun")) {
        await store.ensureTables();
        await store.writeMarker(db, contract.hash, null);
      }
      return 0;
    }
    ctx.log(`db push will run ${ops.length} operation(s):`);
    printOps(ctx, ops);
    if (destructiveOps(ops).length && !boolFlag(args, "allow-destructive", "allowDestructive")) {
      ctx.warn(destructiveMessage(ops));
      return 1;
    }
    if (boolFlag(args, "dry-run", "dryRun")) {
      ctx.log(opsToSql(ops));
      return 0;
    }
    await db.transaction((tx) => runOps(tx, ops), { transactionalDdl: true });
    await store.ensureTables();
    await store.writeMarker(db, contract.hash, null);
    ctx.log("The database is now in sync with the schema (no migration history was written).");
    return 0;
  });
}

export async function dbSign(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  const contract = await ctx.loadContract();
  return withDb(ctx, async (db) => {
    const store = await historyStore(ctx, db);
    await store.ensureTables();
    await store.writeMarker(db, contract.hash, null);
    ctx.log(`Signed the database with contract ${short(contract.hash)}.`);
    return 0;
  });
}

export async function dbVerify(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  const contract = await ctx.loadContract();
  return withDb(ctx, async (db) => {
    const store = await historyStore(ctx, db);
    const marker = await store.readMarker();
    let ok = true;
    if (!marker) {
      ctx.warn("The database has no contract marker. Run `hana-orm migrate deploy`, `hana-orm db push` or `hana-orm db sign`.");
      ok = false;
    } else if (marker.contractHash !== contract.hash) {
      ctx.warn(`Contract mismatch: the database is marked with ${short(marker.contractHash)}${marker.migrationId ? ` (migration ${marker.migrationId})` : ""}, the schema is ${short(contract.hash)}.`);
      ok = false;
    } else ctx.log(`Contract marker matches (${short(contract.hash)}).`);
    const { ops } = await compareWithLive(db, contract, await resolveDefaultSchema(ctx, db));
    if (ops.length) {
      ctx.warn(`Drift: the database differs from the schema in ${ops.length} place(s):`);
      for (const op of ops) ctx.warn(`  - ${op.description}`);
      ok = false;
    } else ctx.log("No drift: tables match the schema.");
    return ok ? 0 : 1;
  });
}

// ---- migrate plan ---------------------------------------------------------------------

async function lastSnapshot(migrations: readonly LoadedMigration[]): Promise<ContractSnapshot | null> {
  const last = migrations.at(-1);
  return last ? readSnapshot(last) : null;
}

async function confirmCandidates(ctx: CliContext, c: RenameCandidates): Promise<RenameCandidates> {
  const accepted: RenameCandidates = { tables: [], columns: [] };
  for (const t of c.tables) {
    if (await ctx.confirm(`Table "${t.from}" is dropped and "${t.to}" is created with the same columns. Is it a rename?`, false)) accepted.tables.push(t);
  }
  for (const col of c.columns) {
    if (await ctx.confirm(`Column "${col.from}" of "${col.table}" is dropped and "${col.to}" is added with the same type. Is it a rename?`, false)) accepted.columns.push(col);
  }
  return accepted;
}

export interface PlanResult {
  ops: MigrationOp[];
  from: string | null;
  to: string;
}

/** Diff between two contract snapshots, including certain renames and confirmed candidate renames. */
export async function planBetween(
  prev: Pick<Contract, "models" | "enums"> | null,
  next: Pick<Contract, "models" | "enums">,
  defaultSchema: string | undefined,
  confirm?: (c: RenameCandidates) => Promise<RenameCandidates>,
): Promise<MigrationOp[]> {
  const opts = defaultSchema ? { defaultSchema } : {};
  const fromPhys = prev ? contractToPhysical(prev, opts) : emptyPhysical();
  const toPhys = contractToPhysical(next, opts);
  let renames = prev ? renamesFromContracts(prev, next, defaultSchema) : emptyRenames();
  if (confirm) {
    const candidates = findRenameCandidates(fromPhys, toPhys, renames);
    if (candidates.tables.length || candidates.columns.length) renames = withRenames(renames, await confirm(candidates));
  }
  return diffSchemas(fromPhys, toPhys, { renames });
}

export async function migratePlan(args: ParsedArgs, ctx: CliContext, now: () => Date = () => new Date()): Promise<number> {
  const rawName = stringFlag(args, "name");
  if (!rawName) {
    ctx.warn("Missing --name. Usage: hana-orm migrate plan --name <name> [--allow-destructive] [--empty]");
    return 1;
  }
  const contract = await ctx.loadContract();
  const migrations = await readMigrations(ctx.migrationsDir);
  const graph = verifyGraph(migrations);
  if (graph.length) {
    for (const g of graph) ctx.warn(g.message);
    return 1;
  }
  const prev = await lastSnapshot(migrations);
  const id = `${timestampId(now())}_${sanitizeMigrationName(rawName)}`;
  if (migrations.some((m) => m.id >= id)) {
    ctx.warn(`A migration with an id at or after ${id} already exists; wait a second and retry.`);
    return 1;
  }

  if (boolFlag(args, "empty")) {
    const base = prev ?? { version: 1 as const, hash: EMPTY_CONTRACT_HASH, models: {}, enums: {} };
    const written = await writeMigration(ctx.migrationsDir, {
      id,
      name: sanitizeMigrationName(rawName),
      from: prev ? prev.hash : null,
      to: base.hash,
      ops: [{ kind: "sqlFile", description: `Hand-written SQL from ${SQL_FILE}`, sql: [], file: SQL_FILE }],
      snapshot: base,
      handWrittenSql: EMPTY_MIGRATION_SQL,
    });
    ctx.log(`Created empty migration ${relPath(ctx, written.dir)}. Write your SQL in ${SQL_FILE}.`);
    return 0;
  }

  const defaultSchema = await ctx.defaultSchema();
  const ops = await planBetween(prev, contract, defaultSchema, (c) => confirmCandidates(ctx, c));
  if (!ops.length) {
    ctx.log(prev && prev.hash !== contract.hash ? "The schema changed, but not in a way that needs database changes. No migration was created." : "No changes. The schema matches the latest migration.");
    return 0;
  }
  if (destructiveOps(ops).length && !boolFlag(args, "allow-destructive", "allowDestructive")) {
    ctx.warn(destructiveMessage(ops));
    return 1;
  }
  const written = await writeMigration(ctx.migrationsDir, {
    id,
    name: sanitizeMigrationName(rawName),
    from: prev ? prev.hash : null,
    to: contract.hash,
    ops,
    snapshot: toSnapshot(contract),
  });
  ctx.log(`Created migration ${relPath(ctx, written.dir)} with ${ops.length} operation(s):`);
  printOps(ctx, ops);
  ctx.log("Review migration.sql, then run `hana-orm migrate deploy`.");
  return 0;
}

// ---- migrate show / deploy / status ---------------------------------------------------

async function migrationSql(m: LoadedMigration): Promise<string> {
  const parts = [`-- ${m.id}  (${short(m.ops.from)} → ${short(m.ops.to)})`];
  for (const op of m.ops.ops) {
    if (op.kind === "sqlFile" && op.file) {
      parts.push(`-- ${op.description}`, (await readSqlFile(m, op.file)).trim(), "");
    } else parts.push(opsToSql([op]));
  }
  return parts.join("\n");
}

export async function migrateShow(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const migrations = await readMigrations(ctx.migrationsDir);
  // Migration ids start with a timestamp; other positionals (e.g. the subcommand) are ignored.
  const requested = args.positional.filter((p) => /^d/.test(p));
  const wanted = requested.find((p) => migrations.some((m) => m.id === p || m.id.startsWith(p)));
  if (requested.length && !wanted) {
    ctx.warn(`No migration matches '${requested.join(" ")}'.`);
    return 1;
  }
  let list: LoadedMigration[];
  if (wanted) list = migrations.filter((m) => m.id === wanted || m.id.startsWith(wanted)).slice(0, 1);
  else {
    list = await withDb(ctx, async (db) => computeStatus(migrations, await (await historyStore(ctx, db)).list()).pending);
    if (!list.length) {
      ctx.log("No pending migrations.");
      return 0;
    }
  }
  for (const m of list) ctx.log(await migrationSql(m));
  return 0;
}

export async function migrateDeploy(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  const migrations = await readMigrations(ctx.migrationsDir);
  return withDb(ctx, async (db) => {
    const store = await historyStore(ctx, db);
    const result = await deploy(db, store, migrations, { log: (m) => ctx.log(m) });
    if (result.blockers.length) {
      ctx.warn("migrate deploy stopped before applying anything:");
      for (const b of result.blockers) ctx.warn(`  - ${b}`);
      return 1;
    }
    if (result.failed) {
      ctx.warn(`Migration ${result.failed.id} failed and was rolled back: ${result.failed.error}`);
      if (result.applied.length) ctx.log(`Applied before the failure: ${result.applied.join(", ")}`);
      return 1;
    }
    ctx.log(result.applied.length ? `Applied ${result.applied.length} migration(s).` : "No pending migrations. The database is up to date.");
    return 0;
  });
}

export async function migrateStatus(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  const migrations = await readMigrations(ctx.migrationsDir);
  return withDb(ctx, async (db) => {
    const store = await historyStore(ctx, db);
    const history = await store.list();
    const report = computeStatus(migrations, history);
    let ok = true;
    if (!migrations.length) ctx.log(`No migrations in ${relPath(ctx, ctx.migrationsDir)}.`);
    for (const e of report.entries) {
      const extra = e.state === "failed" && e.record?.log ? ` — ${e.record.log.split("\n")[0]}` : "";
      ctx.log(`  ${e.state.padEnd(11)} ${e.id}${extra}`);
      if (e.state !== "applied") ok = false;
    }
    for (const b of deployBlockers(report)) {
      ctx.warn(b);
      ok = false;
    }
    const marker = await store.readMarker();
    if (marker) ctx.log(`Database marker: contract ${short(marker.contractHash)}${marker.migrationId ? ` (migration ${marker.migrationId})` : ""}.`);

    // drift against the state the last applied migration should have produced
    const defaultSchema = await resolveDefaultSchema(ctx, db);
    const lastApplied = report.lastApplied ? migrations.find((m) => m.id === report.lastApplied!.id) : undefined;
    if (lastApplied) {
      const snap = await readSnapshot(lastApplied);
      const { ops } = await compareWithLive(db, snap, defaultSchema);
      if (ops.length) {
        ok = false;
        ctx.warn(`Drift: the database differs from migration ${lastApplied.id} in ${ops.length} place(s):`);
        for (const op of ops) ctx.warn(`  - ${op.description}`);
      } else ctx.log(`No drift against ${lastApplied.id}.`);
    }

    // schema changes that have no migration yet
    try {
      const contract = await ctx.loadContract();
      const latest = migrations.at(-1);
      const unplanned = await planBetween(latest ? await readSnapshot(latest) : null, contract, await ctx.defaultSchema());
      if (unplanned.length) {
        // Fail so CI notices a schema change that was committed without its migration.
        ok = false;
        ctx.warn(`The schema has ${unplanned.length} change(s) without a migration; run \`hana-orm migrate plan --name <name>\`.`);
      }
    } catch (e) {
      ctx.warn(`Could not load the schema: ${(e as Error).message}`);
    }
    return ok ? 0 : 1;
  });
}

// ---- migrate resolve / baseline / unlock ------------------------------------------------

export async function migrateResolve(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const appliedId = stringFlag(args, "applied");
  const rolledBackId = stringFlag(args, "rolled-back", "rolledBack");
  const id = appliedId ?? rolledBackId;
  if (!id || (appliedId && rolledBackId)) {
    ctx.warn("Usage: hana-orm migrate resolve --applied <id> | --rolled-back <id>");
    return 1;
  }
  const migrations = await readMigrations(ctx.migrationsDir);
  const m = migrations.find((x) => x.id === id);
  if (!m) {
    ctx.warn(`Migration ${id} does not exist in ${relPath(ctx, ctx.migrationsDir)}.`);
    return 1;
  }
  return withDb(ctx, async (db) => {
    const store = await historyStore(ctx, db);
    await store.ensureTables();
    const history = await store.list();
    const existing = history.find((h) => h.id === id);
    const rec: HistoryRecord = {
      id: m.id,
      name: m.name,
      checksum: m.checksum,
      fromHash: m.ops.from,
      toHash: m.ops.to,
      startedAt: existing?.startedAt ?? new Date(),
      finishedAt: new Date(),
      status: appliedId ? "applied" : "rolled_back",
      log: appliedId ? "marked as applied with migrate resolve" : "marked as rolled back with migrate resolve",
    };
    await store.record(db, rec);
    if (appliedId) {
      const newest = history.filter((h) => h.status === "applied" && h.id > id);
      if (!newest.length) await store.writeMarker(db, m.ops.to, m.id);
    }
    ctx.log(`Marked ${id} as ${appliedId ? "applied" : "rolled back"}.`);
    return 0;
  });
}

export async function migrateBaseline(args: ParsedArgs, ctx: CliContext, now: () => Date = () => new Date()): Promise<number> {
  const name = sanitizeMigrationName(stringFlag(args, "name") ?? "init");
  const contract = await ctx.loadContract();
  const migrations = await readMigrations(ctx.migrationsDir);
  if (migrations.length) {
    ctx.warn(`${relPath(ctx, ctx.migrationsDir)} already contains migrations; baseline only works on a project without migrations.`);
    return 1;
  }
  const ops = await planBetween(null, contract, await ctx.defaultSchema());
  return withDb(ctx, async (db) => {
    const defaultSchema = await resolveDefaultSchema(ctx, db);
    const drift = await compareWithLive(db, contract, defaultSchema);
    if (drift.ops.length) {
      ctx.warn(`The database differs from the schema in ${drift.ops.length} place(s); the baseline records the schema, not the database:`);
      for (const op of drift.ops) ctx.warn(`  - ${op.description}`);
      if (!(await ctx.confirm("Create the baseline anyway?", false))) return 1;
    }
    const id = `${timestampId(now())}_${name}`;
    const written = await writeMigration(ctx.migrationsDir, { id, name, from: null, to: contract.hash, ops, snapshot: toSnapshot(contract) });
    const store = await historyStore(ctx, db);
    await store.ensureTables();
    const at = now();
    await store.record(db, {
      id,
      name,
      checksum: written.checksum,
      fromHash: null,
      toHash: contract.hash,
      startedAt: at,
      finishedAt: at,
      status: "applied",
      log: "baseline: recorded without running",
    });
    await store.writeMarker(db, contract.hash, id);
    ctx.log(`Created baseline ${relPath(ctx, written.dir)} (${ops.length} operation(s)) and recorded it as applied without running it.`);
    return 0;
  });
}

export async function migrateUnlock(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  return withDb(ctx, async (db) => {
    const removed = await (await historyStore(ctx, db)).forceUnlock();
    ctx.log(removed ? "Released the migration lock." : "No migration lock was held.");
    return 0;
  });
}

