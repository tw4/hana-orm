import { join } from "node:path";
import { pathToFileURL } from "node:url";
/** Running operations, migration status and `migrate deploy`. */

import type { Driver, Queryable } from "../runtime/driver.ts";
import type { GraphProblem, LoadedMigration } from "./files.ts";
import { readSqlFile, short, verifyGraph } from "./files.ts";
import type { HistoryRecord, HistoryStore } from "./history.ts";
import { LOCK_HEARTBEAT_MS, lockOwner } from "./history.ts";
import type { Check, MigrationOp, ReplacedMigration } from "./ops.ts";
import { splitSqlStatements } from "./sql-split.ts";

export class CheckFailedError extends Error {
  readonly op: MigrationOp;
  readonly check: Check;
  constructor(phase: "Pre-check" | "Post-check", op: MigrationOp, check: Check) {
    super(`${phase} failed for "${op.description}": expected ${check.description}`);
    this.name = "CheckFailedError";
    this.op = op;
    this.check = check;
  }
}

async function runCheck(q: Queryable, check: Check): Promise<boolean> {
  const rows = await q.query(check.sql, check.params ?? []);
  return check.expect === "empty" ? rows.length === 0 : rows.length > 0;
}

export interface RunOpsOptions {
  /** Reads a file referenced by a `sqlFile` op. */
  loadFile?: (name: string) => Promise<string>;
  /** Receives one line per executed statement. */
  onStatement?: (sql: string) => void;
  /** Runs a `script` op's file with the transaction. */
  runScript?: (file: string, q: Queryable) => Promise<void>;
}

/** What a data migration script (`migration.ts`) receives. Everything runs in the migration's transaction. */
export interface MigrationScriptContext {
  /** The migration's transaction. */
  tx: Queryable;
  /** Runs a SELECT with bound `?` parameters. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs DML/DDL with bound `?` parameters; returns the affected row count. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
  /** Prints a line during `migrate deploy`. */
  log(message: string): void;
}

/** Default export of a `migration.ts` file. */
export type MigrationScript = (ctx: MigrationScriptContext) => Promise<void> | void;

/** Imports a migration script and runs its default export (or a named `up`). */
export async function runMigrationScript(path: string, q: Queryable, log: (message: string) => void, cacheKey = ""): Promise<void> {
  const url = `${pathToFileURL(path).href}${cacheKey ? `?v=${cacheKey}` : ""}`;
  const mod = (await import(url)) as { default?: unknown; up?: unknown };
  const fn = typeof mod.default === "function" ? mod.default : typeof mod.up === "function" ? mod.up : undefined;
  if (!fn) throw new Error(`${path} must export a default function (or a function named 'up')`);
  const ctx: MigrationScriptContext = {
    tx: q,
    query: (sql, params) => q.query(sql, params),
    execute: (sql, params) => q.execute(sql, params),
    log,
  };
  await (fn as MigrationScript)(ctx);
}

/** Runs ops in order: pre-check → statements → post-check. Throws on the first failure. */
export async function runOps(q: Queryable, ops: readonly MigrationOp[], options: RunOpsOptions = {}): Promise<void> {
  for (const op of ops) {
    if (op.precheck && !(await runCheck(q, op.precheck))) throw new CheckFailedError("Pre-check", op, op.precheck);
    let statements = op.sql;
    if (op.kind === "sqlFile") {
      if (!op.file || !options.loadFile) throw new Error(`Operation "${op.description}" needs its SQL file`);
      statements = [...op.sql, ...splitSqlStatements(await options.loadFile(op.file))];
    }
    if (op.kind === "script") {
      if (!op.file || !options.runScript) throw new Error(`Operation "${op.description}" needs its script file`);
      options.onStatement?.(`-- script ${op.file}`);
      await options.runScript(op.file, q);
    }
    for (const s of statements) {
      options.onStatement?.(s);
      await q.execute(s);
    }
    if (op.postcheck && !(await runCheck(q, op.postcheck))) throw new CheckFailedError("Post-check", op, op.postcheck);
  }
}

// ---- status ---------------------------------------------------------------------

export type MigrationState = "applied" | "pending" | "failed" | "rolled_back" | "modified";

export interface MigrationStatusEntry {
  id: string;
  state: MigrationState;
  migration: LoadedMigration;
  record?: HistoryRecord;
}

export interface StatusReport {
  entries: MigrationStatusEntry[];
  /** Applied in the database but missing on disk. */
  missing: HistoryRecord[];
  graph: GraphProblem[];
  /** Not-yet-applied migrations that sort before an applied one. */
  outOfOrder: string[];
  /** Squashed or split migrations of which the database has only part applied. */
  partiallyReplaced: string[];
  pending: LoadedMigration[];
  lastApplied: HistoryRecord | null;
}

/** Ids of every migration `replaces` names, recursively. */
export function replacedIds(replaces: readonly ReplacedMigration[] | undefined, out: Set<string> = new Set()): Set<string> {
  for (const r of replaces ?? []) {
    out.add(r.id);
    replacedIds(r.replaces, out);
  }
  return out;
}

type ReplacedState = "applied" | "partial" | "none";

/**
 * Whether the migrations a squashed or split migration replaces are applied: all of them
 * (recursively through earlier squashes), some of them, or none.
 */
function replacedState(replaces: readonly ReplacedMigration[], applied: ReadonlyMap<string, HistoryRecord>): ReplacedState {
  const one = (r: ReplacedMigration): ReplacedState => {
    const rec = applied.get(r.id);
    if (rec) return rec.checksum === r.checksum ? "applied" : "partial";
    return r.replaces?.length ? replacedState(r.replaces, applied) : "none";
  };
  const states = replaces.map(one);
  if (states.length && states.every((s) => s === "applied")) return "applied";
  return states.some((s) => s !== "none") ? "partial" : "none";
}

const byIdOrder = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function computeStatus(migrations: readonly LoadedMigration[], history: readonly HistoryRecord[]): StatusReport {
  const byId = new Map(history.map((h) => [h.id, h]));
  const appliedById = new Map(history.filter((h) => h.status === "applied").map((h) => [h.id, h]));
  const partiallyReplaced: string[] = [];
  /** Applied through the migrations they replace; they have no history record of their own. */
  const virtual: HistoryRecord[] = [];
  const entries: MigrationStatusEntry[] = migrations.map((m) => {
    const record = byId.get(m.id);
    let state: MigrationState = "pending";
    if (record?.status === "applied") state = record.checksum === m.checksum ? "applied" : "modified";
    else if (m.ops.replaces?.length && replacedState(m.ops.replaces, appliedById) !== "none") {
      if (replacedState(m.ops.replaces, appliedById) === "applied") {
        state = "applied";
        const last = [...replacedIds(m.ops.replaces)].map((id) => appliedById.get(id)).filter((r) => r !== undefined).sort(byIdOrder).at(-1)!;
        virtual.push({ ...last, id: m.id, name: m.name, checksum: m.checksum, fromHash: m.ops.from, toHash: m.ops.to, log: "applied as the migrations it replaces" });
      } else partiallyReplaced.push(m.id);
    } else if (record) state = record.status;
    return { id: m.id, state, migration: m, ...(record ? { record } : {}) };
  });
  const onDisk = new Set(migrations.map((m) => m.id));
  const replaced = new Set<string>();
  for (const m of migrations) replacedIds(m.ops.replaces, replaced);
  const missing = history.filter((h) => h.status === "applied" && !onDisk.has(h.id) && !replaced.has(h.id));
  // Records of replaced migrations stand for the migrations that replaced them.
  const applied = [...history.filter((h) => h.status === "applied" && !(replaced.has(h.id) && !onDisk.has(h.id))), ...virtual].sort(byIdOrder);
  const lastApplied = applied.at(-1) ?? null;
  const notApplied = entries.filter((e) => (e.state === "pending" || e.state === "failed" || e.state === "rolled_back") && !partiallyReplaced.includes(e.id));
  const outOfOrder = lastApplied ? notApplied.filter((e) => e.id < lastApplied.id).map((e) => e.id) : [];
  return {
    entries,
    missing,
    graph: verifyGraph(migrations),
    outOfOrder,
    partiallyReplaced,
    pending: notApplied.filter((e) => !outOfOrder.includes(e.id)).map((e) => e.migration),
    lastApplied,
  };
}

/** Problems that stop `migrate deploy`. */
export function deployBlockers(report: StatusReport): string[] {
  const out: string[] = [];
  for (const e of report.entries) {
    if (e.state === "modified") {
      out.push(`Migration ${e.id} was changed after it was applied (checksum ${short(e.record?.checksum)} in the database, ${short(e.migration.checksum)} on disk). Restore the original files.`);
    }
  }
  for (const h of report.missing) out.push(`Migration ${h.id} is applied in the database but its folder is missing.`);
  for (const id of report.partiallyReplaced) {
    const m = report.entries.find((e) => e.id === id)?.migration;
    const ids = [...replacedIds(m?.ops.replaces)].join(", ");
    out.push(
      `Migration ${id} replaces ${ids}, but the database has only some of them applied (or applied with other contents). ` +
        "Deploy the original migrations here first (check out the commit before the squash or split), or fix the history with `migrate resolve`.",
    );
  }
  for (const g of report.graph) out.push(g.message);
  for (const id of report.outOfOrder) {
    out.push(`Migration ${id} is not applied but is older than the last applied migration ${report.lastApplied?.id}. It was probably merged from another branch; re-plan it, or mark it with \`migrate resolve --applied ${id}\`.`);
  }
  const first = report.pending[0];
  if (first && report.lastApplied && first.ops.from !== report.lastApplied.toHash && !report.graph.length) {
    out.push(`Migration ${first.id} starts from contract ${short(first.ops.from)} but the database is at ${short(report.lastApplied.toHash)}.`);
  }
  return out;
}

// ---- deploy ---------------------------------------------------------------------

export interface DeployOptions {
  /** Wait this long for another deploy's live lock (default 0). */
  waitMs?: number;
  /** Lock heartbeat interval (default LOCK_HEARTBEAT_MS). */
  heartbeatMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
  owner?: string;
}

export interface DeployResult {
  applied: string[];
  failed: { id: string; error: string } | null;
  blockers: string[];
}

/** Applies one migration in its own transaction with transactional DDL. */
export async function applyMigration(driver: Driver, store: HistoryStore, m: LoadedMigration, options: DeployOptions = {}): Promise<void> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const statements: string[] = [];
  try {
    await driver.transaction(
      async (tx) => {
        await runOps(tx, m.ops.ops, {
          loadFile: (f) => readSqlFile(m, f),
          onStatement: (s) => statements.push(s),
          runScript: (f, q) => runMigrationScript(join(m.dir, f), q, (msg) => options.log?.(`  ${m.id}: ${msg}`), m.checksum.slice(0, 12)),
        });
        await store.record(tx, {
          id: m.id,
          name: m.name,
          checksum: m.checksum,
          fromHash: m.ops.from,
          toHash: m.ops.to,
          startedAt,
          finishedAt: now(),
          status: "applied",
          log: `${statements.length} statement(s)`,
        });
        await store.writeMarker(tx, m.ops.to, m.id);
      },
      { transactionalDdl: true },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const lastSql = statements.at(-1);
    await store.record(driver, {
      id: m.id,
      name: m.name,
      checksum: m.checksum,
      fromHash: m.ops.from,
      toHash: m.ops.to,
      startedAt,
      finishedAt: now(),
      status: "failed",
      log: lastSql ? `${error}\n-- last statement:\n${lastSql}` : error,
    });
    throw e;
  }
}

export async function deploy(driver: Driver, store: HistoryStore, migrations: readonly LoadedMigration[], options: DeployOptions = {}): Promise<DeployResult> {
  const log = options.log ?? (() => {});
  await store.ensureTables();
  const owner = options.owner ?? lockOwner();
  const acquired = await store.acquireLock(owner, { waitMs: options.waitMs ?? 0 });
  if (acquired.tookOverFrom) {
    const t = acquired.tookOverFrom;
    log(`Took over a stale migration lock held by ${t.owner} (no heartbeat since ${(t.heartbeatAt ?? t.lockedAt).toISOString()}).`);
  }
  // Keep the lock alive while migrations run; if another process takes it over, stop before the next migration.
  let lost = false;
  const timer = setInterval(() => {
    store.heartbeat(owner).then(
      (held) => {
        if (!held) lost = true;
      },
      () => {},
    );
  }, options.heartbeatMs ?? LOCK_HEARTBEAT_MS);
  timer.unref?.();
  try {
    const report = computeStatus(migrations, await store.list());
    const blockers = deployBlockers(report);
    if (blockers.length) return { applied: [], failed: null, blockers };
    const applied: string[] = [];
    for (const m of report.pending) {
      if (lost || !(await store.heartbeat(owner))) {
        return { applied, failed: null, blockers: [`Lost the migration lock before applying ${m.id}: another deploy took it over. Check \`hana-orm migrate status\` and deploy again.`] };
      }
      log(`Applying ${m.id} (${m.ops.ops.length} operation(s))`);
      try {
        await applyMigration(driver, store, m, options);
      } catch (e) {
        return { applied, failed: { id: m.id, error: e instanceof Error ? e.message : String(e) }, blockers: [] };
      }
      applied.push(m.id);
    }
    return { applied, failed: null, blockers: [] };
  } finally {
    clearInterval(timer);
    await store.releaseLock(owner);
  }
}
