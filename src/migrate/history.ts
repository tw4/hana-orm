/**
 * Housekeeping tables in the datasource default schema:
 *
 * - `_HANA_ORM_MIGRATIONS` – one row per migration (applied, failed, rolled back).
 * - `_HANA_ORM_LOCK`       – a single row while a deploy runs; the owner refreshes
 *                            `HEARTBEAT_AT` and a lock without heartbeat is taken over.
 * - `_HANA_ORM_MARKER`     – the contract hash the database was last brought to.
 *
 * The planner and applier talk to a `HistoryStore`; `SqlHistoryStore` is the HANA one.
 */

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { Driver, Queryable } from "../runtime/driver.ts";
import { quoteIdent } from "../runtime/sql.ts";

export const MIGRATIONS_TABLE = "_HANA_ORM_MIGRATIONS";
export const LOCK_TABLE = "_HANA_ORM_LOCK";
export const MARKER_TABLE = "_HANA_ORM_MARKER";
export const HOUSEKEEPING_TABLES = [MIGRATIONS_TABLE, LOCK_TABLE, MARKER_TABLE] as const;

/** How often a running deploy refreshes its lock. */
export const LOCK_HEARTBEAT_MS = 20 * 1000;
/** A lock whose heartbeat is older than this is stale: its owner crashed or hung, so it is taken over. */
export const STALE_LOCK_MS = 2 * 60 * 1000;

export type HistoryStatus = "applied" | "failed" | "rolled_back";

export interface HistoryRecord {
  id: string;
  name: string;
  checksum: string;
  fromHash: string | null;
  toHash: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: HistoryStatus;
  log: string | null;
}

export interface MarkerRecord {
  contractHash: string;
  migrationId: string | null;
  updatedAt: Date;
}

export interface LockInfo {
  owner: string;
  lockedAt: Date;
  /** Last heartbeat of the owner; absent for locks written by older versions. */
  heartbeatAt?: Date;
}

export interface AcquireLockOptions {
  /** Keep retrying this long while another deploy holds a live lock (default 0: fail at once). */
  waitMs?: number;
  /** A lock without heartbeat for this long is taken over (default STALE_LOCK_MS). */
  staleMs?: number;
  /** Delay between retries while waiting (default 2s). */
  pollMs?: number;
}

export interface AcquiredLock {
  /** Set when a stale lock of a crashed deploy was taken over. */
  tookOverFrom?: LockInfo;
}

export class LockError extends Error {
  readonly lock: LockInfo;
  constructor(lock: LockInfo, now: Date = new Date()) {
    const age = Math.round((now.getTime() - lock.lockedAt.getTime()) / 1000);
    const stale = now.getTime() - (lock.heartbeatAt ?? lock.lockedAt).getTime() > STALE_LOCK_MS;
    super(
      `Another migration is running (lock held by ${lock.owner} since ${lock.lockedAt.toISOString()}, ${age}s ago).` +
        (stale
          ? " The lock looks stale (the process may have crashed). If no deploy is running, release it with `hana-orm migrate unlock`."
          : " Wait for it to finish (or pass --wait <seconds>), or run `hana-orm migrate unlock` if you are sure no deploy is running."),
    );
    this.name = "LockError";
    this.lock = lock;
  }
}

export interface HistoryStore {
  /** Creates the housekeeping tables when missing. */
  ensureTables(): Promise<void>;
  /** True when the migrations table exists (read-only commands do not create it). */
  hasHistory(): Promise<boolean>;
  /** Takes the deploy lock, taking over a stale one; throws `LockError` while a live lock remains. */
  acquireLock(owner: string, options?: AcquireLockOptions): Promise<AcquiredLock>;
  /** Refreshes the lock; returns false when `owner` no longer holds it. */
  heartbeat(owner: string): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  /** Removes any lock; returns true when one was held. */
  forceUnlock(): Promise<boolean>;
  list(): Promise<HistoryRecord[]>;
  /** Inserts or replaces the record with the same id. */
  record(q: Queryable, rec: HistoryRecord): Promise<void>;
  readMarker(): Promise<MarkerRecord | null>;
  writeMarker(q: Queryable, contractHash: string, migrationId: string | null): Promise<void>;
}

export function lockOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface HistoryRow {
  ID: string;
  NAME: string;
  CHECKSUM: string;
  FROM_HASH: string | null;
  TO_HASH: string;
  STARTED_AT: Date | string;
  FINISHED_AT: Date | string | null;
  STATUS: string;
  LOG: string | null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  // HANA returns TIMESTAMP as 'YYYY-MM-DD HH:MM:SS.fffffff' when no codec converts it; stored in UTC.
  const s = String(v).trim().replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.slice(0, 23)}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class SqlHistoryStore implements HistoryStore {
  readonly db: Driver;
  readonly schema: string | undefined;

  constructor(db: Driver, schema?: string) {
    this.db = db;
    this.schema = schema;
  }

  ref(table: string): string {
    return this.schema ? `${quoteIdent(this.schema)}.${quoteIdent(table)}` : quoteIdent(table);
  }

  private async exists(table: string): Promise<boolean> {
    const rows = this.schema
      ? await this.db.query("SELECT 1 FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?", [this.schema, table])
      : await this.db.query("SELECT 1 FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?", [table]);
    return rows.length > 0;
  }

  private async hasColumn(table: string, column: string): Promise<boolean> {
    const rows = this.schema
      ? await this.db.query("SELECT 1 FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?", [this.schema, table, column])
      : await this.db.query("SELECT 1 FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, column]);
    return rows.length > 0;
  }

  async hasHistory(): Promise<boolean> {
    return this.exists(MIGRATIONS_TABLE);
  }

  async ensureTables(): Promise<void> {
    if (!(await this.exists(MIGRATIONS_TABLE))) {
      await this.db.execute(
        `CREATE COLUMN TABLE ${this.ref(MIGRATIONS_TABLE)} (` +
          `"ID" NVARCHAR(255) NOT NULL PRIMARY KEY, "NAME" NVARCHAR(255) NOT NULL, "CHECKSUM" NVARCHAR(64) NOT NULL, ` +
          `"FROM_HASH" NVARCHAR(64), "TO_HASH" NVARCHAR(64) NOT NULL, "STARTED_AT" TIMESTAMP NOT NULL, "FINISHED_AT" TIMESTAMP, ` +
          `"STATUS" NVARCHAR(20) NOT NULL, "LOG" NCLOB)`,
      );
    }
    if (!(await this.exists(LOCK_TABLE))) {
      await this.db.execute(
        `CREATE COLUMN TABLE ${this.ref(LOCK_TABLE)} ("ID" INTEGER NOT NULL PRIMARY KEY, "LOCKED_BY" NVARCHAR(255) NOT NULL, "LOCKED_AT" TIMESTAMP NOT NULL, "HEARTBEAT_AT" TIMESTAMP)`,
      );
    } else if (!(await this.hasColumn(LOCK_TABLE, "HEARTBEAT_AT"))) {
      // lock table created by an earlier version
      await this.db.execute(`ALTER TABLE ${this.ref(LOCK_TABLE)} ADD ("HEARTBEAT_AT" TIMESTAMP)`);
    }
    if (!(await this.exists(MARKER_TABLE))) {
      await this.db.execute(
        `CREATE COLUMN TABLE ${this.ref(MARKER_TABLE)} ("ID" INTEGER NOT NULL PRIMARY KEY, "CONTRACT_HASH" NVARCHAR(64) NOT NULL, "MIGRATION_ID" NVARCHAR(255), "UPDATED_AT" TIMESTAMP NOT NULL)`,
      );
    }
  }

  async readLock(): Promise<LockInfo | null> {
    const rows = await this.db.query<{ LOCKED_BY: string; LOCKED_AT: Date | string; HEARTBEAT_AT?: Date | string | null }>(
      `SELECT "LOCKED_BY", "LOCKED_AT", "HEARTBEAT_AT" FROM ${this.ref(LOCK_TABLE)} WHERE "ID" = 1`,
    );
    const r = rows[0];
    if (!r) return null;
    const info: LockInfo = { owner: r.LOCKED_BY, lockedAt: toDate(r.LOCKED_AT) ?? new Date(0) };
    const beat = toDate(r.HEARTBEAT_AT);
    if (beat) info.heartbeatAt = beat;
    return info;
  }

  async acquireLock(owner: string, options: AcquireLockOptions = {}): Promise<AcquiredLock> {
    const staleSeconds = Math.max(1, Math.round((options.staleMs ?? STALE_LOCK_MS) / 1000));
    const deadline = Date.now() + (options.waitMs ?? 0);
    const pollMs = options.pollMs ?? 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.execute(
          `INSERT INTO ${this.ref(LOCK_TABLE)} ("ID", "LOCKED_BY", "LOCKED_AT", "HEARTBEAT_AT") VALUES (1, ?, CURRENT_UTCTIMESTAMP, CURRENT_UTCTIMESTAMP)`,
          [owner],
        );
        return {};
      } catch (e) {
        const lock = await this.readLock();
        if (!lock) {
          // released between our insert and our read: try again a few times
          if (attempt < 3) continue;
          throw e;
        }
        // Take over a lock whose owner stopped sending heartbeats. Matching on the old owner makes
        // the takeover atomic: when two deploys race, only one UPDATE changes the row.
        const taken = await this.db.execute(
          `UPDATE ${this.ref(LOCK_TABLE)} SET "LOCKED_BY" = ?, "LOCKED_AT" = CURRENT_UTCTIMESTAMP, "HEARTBEAT_AT" = CURRENT_UTCTIMESTAMP ` +
            `WHERE "ID" = 1 AND "LOCKED_BY" = ? AND COALESCE("HEARTBEAT_AT", "LOCKED_AT") < ADD_SECONDS(CURRENT_UTCTIMESTAMP, ?)`,
          [owner, lock.owner, -staleSeconds],
        );
        if (taken === 1) return { tookOverFrom: lock };
        if (Date.now() >= deadline) throw new LockError(lock);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  async heartbeat(owner: string): Promise<boolean> {
    const n = await this.db.execute(`UPDATE ${this.ref(LOCK_TABLE)} SET "HEARTBEAT_AT" = CURRENT_UTCTIMESTAMP WHERE "ID" = 1 AND "LOCKED_BY" = ?`, [owner]);
    return n === 1;
  }

  async releaseLock(owner: string): Promise<void> {
    await this.db.execute(`DELETE FROM ${this.ref(LOCK_TABLE)} WHERE "ID" = 1 AND "LOCKED_BY" = ?`, [owner]);
  }

  async forceUnlock(): Promise<boolean> {
    if (!(await this.exists(LOCK_TABLE))) return false;
    return (await this.db.execute(`DELETE FROM ${this.ref(LOCK_TABLE)}`)) > 0;
  }

  async list(): Promise<HistoryRecord[]> {
    if (!(await this.exists(MIGRATIONS_TABLE))) return [];
    const rows = await this.db.query<HistoryRow>(
      `SELECT "ID", "NAME", "CHECKSUM", "FROM_HASH", "TO_HASH", "STARTED_AT", "FINISHED_AT", "STATUS", "LOG" FROM ${this.ref(MIGRATIONS_TABLE)} ORDER BY "ID"`,
    );
    return rows.map((r) => ({
      id: r.ID,
      name: r.NAME,
      checksum: r.CHECKSUM,
      fromHash: r.FROM_HASH ?? null,
      toHash: r.TO_HASH,
      startedAt: toDate(r.STARTED_AT) ?? new Date(0),
      finishedAt: toDate(r.FINISHED_AT),
      status: r.STATUS as HistoryStatus,
      log: r.LOG ?? null,
    }));
  }

  async record(q: Queryable, rec: HistoryRecord): Promise<void> {
    await q.execute(
      `UPSERT ${this.ref(MIGRATIONS_TABLE)} ("ID", "NAME", "CHECKSUM", "FROM_HASH", "TO_HASH", "STARTED_AT", "FINISHED_AT", "STATUS", "LOG") ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY`,
      [rec.id, rec.name, rec.checksum, rec.fromHash, rec.toHash, rec.startedAt, rec.finishedAt, rec.status, rec.log],
    );
  }

  async readMarker(): Promise<MarkerRecord | null> {
    if (!(await this.exists(MARKER_TABLE))) return null;
    const rows = await this.db.query<{ CONTRACT_HASH: string; MIGRATION_ID: string | null; UPDATED_AT: Date | string }>(
      `SELECT "CONTRACT_HASH", "MIGRATION_ID", "UPDATED_AT" FROM ${this.ref(MARKER_TABLE)} WHERE "ID" = 1`,
    );
    const r = rows[0];
    return r ? { contractHash: r.CONTRACT_HASH, migrationId: r.MIGRATION_ID ?? null, updatedAt: toDate(r.UPDATED_AT) ?? new Date(0) } : null;
  }

  async writeMarker(q: Queryable, contractHash: string, migrationId: string | null): Promise<void> {
    await q.execute(
      `UPSERT ${this.ref(MARKER_TABLE)} ("ID", "CONTRACT_HASH", "MIGRATION_ID", "UPDATED_AT") VALUES (1, ?, ?, CURRENT_UTCTIMESTAMP) WITH PRIMARY KEY`,
      [contractHash, migrationId],
    );
  }
}
