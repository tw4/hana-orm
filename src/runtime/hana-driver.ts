import { createRequire } from "node:module";
import type { Driver, QueryEvent, Queryable, TransactionOptions } from "./driver.ts";
import { DatabaseError, TransactionError } from "./errors.ts";

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Tenant database name when connecting through the SYSTEMDB port. */
  databaseName?: string;
  /** Sets CURRENT_SCHEMA for each connection. */
  currentSchema?: string;
  /** TLS; required for HANA Cloud. */
  encrypt?: boolean;
  sslValidateCertificate?: boolean;
  /** Extra options passed to `@sap/hana-client` connect(). */
  extra?: Record<string, unknown>;
}

export interface HanaDriverOptions {
  /** Maximum open connections (default 10). */
  poolSize?: number;
  onQuery?: (e: QueryEvent) => void;
  /** @internal Replaces `@sap/hana-client` (tests). */
  hanaModule?: unknown;
}

// Minimal shape of @sap/hana-client we rely on.
interface HanaStatement {
  execBatch(rows: unknown, cb: (err: Error | null, result: unknown) => void): void;
  drop(cb: (err: Error | null) => void): void;
}
interface HanaConnection {
  connect(options: Record<string, unknown>, cb: (err: Error | null) => void): void;
  exec(sql: string, params: unknown, cb: (err: Error | null, result: unknown) => void): void;
  prepare(sql: string, cb: (err: Error | null, stmt: unknown) => void): void;
  setAutoCommit(flag: boolean): void;
  commit(cb: (err: Error | null) => void): void;
  rollback(cb: (err: Error | null) => void): void;
  disconnect(cb: (err: Error | null) => void): void;
}
export interface HanaModule {
  createConnection(): HanaConnection;
}

let hanaModule: HanaModule | undefined;
function loadHana(): HanaModule {
  if (hanaModule) return hanaModule;
  const require = createRequire(import.meta.url);
  try {
    // Resolve from the application first so a project-local driver is used.
    const fromCwd = createRequire(`${process.cwd()}/package.json`);
    hanaModule = fromCwd("@sap/hana-client") as HanaModule;
  } catch {
    try {
      hanaModule = require("@sap/hana-client") as HanaModule;
    } catch (e) {
      throw new Error("hana-orm needs the SAP HANA driver. Install it with: npm install @sap/hana-client", { cause: e });
    }
  }
  return hanaModule;
}

function promisify<T>(fn: (cb: (err: Error | null, r?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, r) => (err ? reject(err) : resolve(r as T))));
}

/** One physical connection wrapped as a `Queryable`. */
class ConnectionQueryable implements Queryable {
  readonly conn: HanaConnection;
  private readonly onQuery: ((e: QueryEvent) => void) | undefined;

  constructor(conn: HanaConnection, onQuery?: (e: QueryEvent) => void) {
    this.conn = conn;
    this.onQuery = onQuery;
  }

  private async run<T>(sql: string, params: unknown): Promise<T> {
    const started = performance.now();
    try {
      return await promisify<T>((cb) => this.conn.exec(sql, params, cb as (err: Error | null, r: unknown) => void));
    } catch (e) {
      throw new DatabaseError(e, sql);
    } finally {
      this.onQuery?.({ sql, params: Array.isArray(params) ? params : [], durationMs: performance.now() - started });
    }
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = await this.run<T[] | undefined>(sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const r = await this.run<number | undefined>(sql, params);
    return typeof r === "number" ? r : 0;
  }

  async executeBatch(sql: string, rows: readonly (readonly unknown[])[]): Promise<number> {
    if (!rows.length) return 0;
    const r = await this.batchRaw(sql, rows);
    // Per-row counts: a negative value means "succeeded, count unknown"; 0 means no row was written.
    if (Array.isArray(r)) return r.reduce((a, b) => a + (b >= 0 ? b : 1), 0);
    return typeof r === "number" ? r : rows.length;
  }

  async executeBatchCounts(sql: string, rows: readonly (readonly unknown[])[]): Promise<number[]> {
    if (!rows.length) return [];
    const r = await this.batchRaw(sql, rows);
    if (Array.isArray(r) && r.length === rows.length) return r.map((n) => (n >= 0 ? n : -1));
    // the driver gave only a total: per-row counts are unknown
    return rows.map(() => -1);
  }

  /** One prepared statement executed for all rows (one round trip). */
  private async batchRaw(sql: string, rows: readonly (readonly unknown[])[]): Promise<number | number[] | undefined> {
    const started = performance.now();
    try {
      const stmt = await promisify<HanaStatement>((cb) => this.conn.prepare(sql, cb as (err: Error | null, s: unknown) => void));
      try {
        return await promisify<number | number[] | undefined>((cb) => stmt.execBatch(rows, cb as (err: Error | null, r: unknown) => void));
      } finally {
        await promisify<void>((cb) => stmt.drop(cb)).catch(() => {});
      }
    } catch (e) {
      throw new DatabaseError(e, sql);
    } finally {
      this.onQuery?.({ sql, params: [], durationMs: performance.now() - started });
    }
  }
}

/** Pooled driver for SAP HANA on top of `@sap/hana-client`. */
export class HanaDriver implements Driver {
  private readonly config: ConnectionConfig;
  private readonly poolSize: number;
  private readonly onQuery: ((e: QueryEvent) => void) | undefined;
  private readonly idle: ConnectionQueryable[] = [];
  private readonly waiters: ((c: ConnectionQueryable) => void)[] = [];
  private readonly hana: HanaModule | undefined;
  private open = 0;
  private closed = false;

  constructor(config: ConnectionConfig, options: HanaDriverOptions = {}) {
    this.config = config;
    this.poolSize = Math.max(1, options.poolSize ?? 10);
    this.onQuery = options.onQuery;
    this.hana = options.hanaModule as HanaModule | undefined;
  }

  private async connectOne(): Promise<ConnectionQueryable> {
    const hana = this.hana ?? loadHana();
    const conn = hana.createConnection();
    const c = this.config;
    const options: Record<string, unknown> = {
      serverNode: `${c.host}:${c.port}`,
      uid: c.user,
      pwd: c.password,
      encrypt: c.encrypt ?? false,
      sslValidateCertificate: c.sslValidateCertificate ?? true,
      ...c.extra,
    };
    if (c.databaseName) options.databaseName = c.databaseName;
    if (c.currentSchema) options.currentSchema = c.currentSchema;
    try {
      await promisify<void>((cb) => conn.connect(options, cb));
    } catch (e) {
      throw new DatabaseError(e, "<connect>");
    }
    return new ConnectionQueryable(conn, this.onQuery);
  }

  /** Takes an idle connection, opens a new one, or waits for one (at most `maxWait` ms). */
  private async acquire(maxWait?: number): Promise<ConnectionQueryable> {
    if (this.closed) throw new Error("The client has been disconnected");
    const idle = this.idle.pop();
    if (idle) return idle;
    if (this.open < this.poolSize) {
      this.open++;
      try {
        return await this.connectOne();
      } catch (e) {
        this.open--;
        throw e;
      }
    }
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (c: ConnectionQueryable): void => {
        clearTimeout(timer);
        resolve(c);
      };
      this.waiters.push(waiter);
      if (maxWait !== undefined && Number.isFinite(maxWait)) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new TransactionError("TRANSACTION_MAX_WAIT", `No connection was free within maxWait (${maxWait} ms); all ${this.poolSize} pooled connections are in use.`));
        }, Math.max(0, maxWait));
      }
    });
  }

  private release(c: ConnectionQueryable, broken = false): void {
    if (broken || this.closed) {
      this.open--;
      c.conn.disconnect(() => {});
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(c);
    else this.idle.push(c);
  }

  private async withConnection<T>(fn: (c: ConnectionQueryable) => Promise<T>, maxWait?: number): Promise<T> {
    const c = await this.acquire(maxWait);
    let broken = false;
    try {
      return await fn(c);
    } catch (e) {
      broken = isConnectionLost(e);
      throw e;
    } finally {
      this.release(c, broken);
    }
  }

  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.withConnection((c) => c.query<T>(sql, params));
  }

  execute(sql: string, params?: readonly unknown[]): Promise<number> {
    return this.withConnection((c) => c.execute(sql, params));
  }

  executeBatch(sql: string, rows: readonly (readonly unknown[])[]): Promise<number> {
    return this.withConnection((c) => c.executeBatch(sql, rows));
  }

  executeBatchCounts(sql: string, rows: readonly (readonly unknown[])[]): Promise<number[]> {
    return this.withConnection((c) => c.executeBatchCounts(sql, rows));
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return this.withConnection(async (c) => {
      c.conn.setAutoCommit(false);
      try {
        if (options.transactionalDdl) await c.execute("SET TRANSACTION AUTOCOMMIT DDL OFF");
        if (options.isolationLevel) await c.execute(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
        const result = await fn(c);
        await promisify<void>((cb) => c.conn.commit(cb));
        return result;
      } catch (e) {
        await promisify<void>((cb) => c.conn.rollback(cb)).catch(() => {});
        throw e;
      } finally {
        if (options.transactionalDdl) await c.execute("SET TRANSACTION AUTOCOMMIT DDL ON").catch(() => {});
        c.conn.setAutoCommit(true);
      }
    }, options.maxWait);
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = this.idle.splice(0);
    this.open -= all.length;
    await Promise.all(all.map((c) => promisify<void>((cb) => c.conn.disconnect(cb)).catch(() => {})));
  }
}

function isConnectionLost(e: unknown): boolean {
  const code = (e as { hanaCode?: number }).hanaCode;
  return code === -10807 || code === -10108 || code === -10709;
}
