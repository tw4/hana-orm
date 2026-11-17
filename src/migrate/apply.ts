/** Running operations, migration status and `migrate deploy`. */

import type { Driver, Queryable } from "../runtime/driver.ts";
import type { GraphProblem, LoadedMigration } from "./files.ts";
import { readSqlFile, short, verifyGraph } from "./files.ts";
import type { HistoryRecord, HistoryStore } from "./history.ts";
import { lockOwner } from "./history.ts";
import type { Check, MigrationOp } from "./ops.ts";
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
  pending: LoadedMigration[];
  lastApplied: HistoryRecord | null;
}

export function computeStatus(migrations: readonly LoadedMigration[], history: readonly HistoryRecord[]): StatusReport {
  const byId = new Map(history.map((h) => [h.id, h]));
  const entries: MigrationStatusEntry[] = migrations.map((m) => {
    const record = byId.get(m.id);
    let state: MigrationState = "pending";
    if (record) {
      if (record.status === "applied") state = record.checksum === m.checksum ? "applied" : "modified";
      else state = record.status;
    }
    return { id: m.id, state, migration: m, ...(record ? { record } : {}) };
  });
  const onDisk = new Set(migrations.map((m) => m.id));
  const missing = history.filter((h) => h.status === "applied" && !onDisk.has(h.id));
  const applied = history.filter((h) => h.status === "applied").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lastApplied = applied.at(-1) ?? null;
  const notApplied = entries.filter((e) => e.state === "pending" || e.state === "failed" || e.state === "rolled_back");
  const outOfOrder = lastApplied ? notApplied.filter((e) => e.id < lastApplied.id).map((e) => e.id) : [];
  return {
    entries,
    missing,
    graph: verifyGraph(migrations),
    outOfOrder,
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
        await runOps(tx, m.ops.ops, { loadFile: (f) => readSqlFile(m, f), onStatement: (s) => statements.push(s) });
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
  await store.acquireLock(owner);
  try {
    const report = computeStatus(migrations, await store.list());
    const blockers = deployBlockers(report);
    if (blockers.length) return { applied: [], failed: null, blockers };
    const applied: string[] = [];
    for (const m of report.pending) {
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
    await store.releaseLock(owner);
  }
}
