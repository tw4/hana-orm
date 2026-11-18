import { createRequire } from "node:module";
import type { Driver, QueryEvent, Queryable, TransactionOptions } from "./driver.ts";
import { DatabaseError, QueryTimeoutError, TransactionError } from "./errors.ts";
import type { PoolStats } from "./events.ts";
import { describeFromHanaMetadata, type StatementDescription } from "./typed-sql.ts";

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
  /** Prepared statements kept per connection and reused for the same SQL (default 0: off). */
  statementCacheSize?: number;
  /**
   * Milliseconds a statement may run. On timeout the connection is closed, which stops the
   * statement on the server, and a `QueryTimeoutError` is thrown. Default: no limit.
   */
  statementTimeout?: number;
  /** Idle connections are closed after this many milliseconds (default 5 minutes; 0 keeps them). */
  idleTimeout?: number;
  /**
   * A connection idle for at least this many milliseconds is checked with `SELECT 1 FROM DUMMY`
   * before it is handed out; a dead one is replaced (default 30 seconds; 0 checks every time).
   */
  idleCheckAfter?: number;
  /** How long `close()` waits for running statements before closing their connections (default 10 s). */
  closeTimeout?: number;
  onQuery?: (e: QueryEvent) => void;
  /** @internal Replaces `@sap/hana-client` (tests). */
  hanaModule?: unknown;
}

// Minimal shape of @sap/hana-client we rely on.
interface HanaStatement {
  exec(params: unknown, cb: (err: Error | null, result: unknown) => void): void;
  execBatch(rows: unknown, cb: (err: Error | null, result: unknown) => void): void;
  getColumnInfo?(): unknown;
  getParameterInfo?(): unknown;
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
  private readonly cacheSize: number;
  /** Prepared statements by SQL text, least recently used first. */
  private readonly statements = new Map<string, HanaStatement>();
  private readonly statementTimeout: number | undefined;
  /** Set when the connection must not be reused (timed out, lost, failed a check). */
  broken = false;
  /** When it went back to the idle list (performance.now()). */
  idleSince = 0;

  constructor(conn: HanaConnection, onQuery?: (e: QueryEvent) => void, statementTimeout?: number, statementCacheSize = 0) {
    this.conn = conn;
    this.onQuery = onQuery;
    this.statementTimeout = statementTimeout && statementTimeout > 0 ? statementTimeout : undefined;
    this.cacheSize = Math.max(0, statementCacheSize);
  }

  /** The cached prepared statement for `sql`, preparing (and caching) it when needed. */
  private async statement(sql: string): Promise<HanaStatement> {
    const cached = this.statements.get(sql);
    if (cached) {
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    const stmt = await promisify<HanaStatement>((cb) => this.conn.prepare(sql, cb as (err: Error | null, s: unknown) => void));
    this.statements.set(sql, stmt);
    if (this.statements.size > this.cacheSize) {
      const [oldSql, old] = this.statements.entries().next().value!;
      this.statements.delete(oldSql);
      old.drop(() => {});
    }
    return stmt;
  }

  private async exec<T>(sql: string, params: unknown): Promise<T> {
    if (!this.cacheSize) return promisify<T>((cb) => this.conn.exec(sql, params, cb as (err: Error | null, r: unknown) => void));
    const stmt = await this.statement(sql);
    try {
      return await promisify<T>((cb) => stmt.exec(params, cb as (err: Error | null, r: unknown) => void));
    } catch (e) {
      // a failed statement may be invalid now (e.g. a dropped table): prepare it again next time
      if (this.statements.get(sql) === stmt) {
        this.statements.delete(sql);
        stmt.drop(() => {});
      }
      throw e;
    }
  }

  /** Closes the connection; the server ends the session and with it a running statement. */
  kill(): void {
    this.broken = true;
    try {
      this.conn.disconnect(() => {});
    } catch {
      // already gone
    }
  }

  /** Races `p` against `timeoutMs`; on timeout the connection is killed. */
  private async limit<T>(p: Promise<T>, sql: string, timeoutMs = this.statementTimeout): Promise<T> {
    if (!timeoutMs) return p;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.kill();
        reject(new QueryTimeoutError(timeoutMs, sql));
      }, timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run<T>(sql: string, params: unknown): Promise<T> {
    const started = performance.now();
    try {
      return await this.limit(this.exec<T>(sql, params), sql);
    } catch (e) {
      if (e instanceof QueryTimeoutError) throw e;
      throw new DatabaseError(e, sql);
    } finally {
      this.onQuery?.({ sql, params: Array.isArray(params) ? params : [], durationMs: performance.now() - started });
    }
  }

  /** True when the connection answers `SELECT 1 FROM DUMMY` within `timeoutMs`. */
  async ping(timeoutMs: number): Promise<boolean> {
    try {
      const p = promisify<unknown>((cb) => this.conn.exec("SELECT 1 FROM DUMMY", [], cb as (err: Error | null, r: unknown) => void));
      await this.limit(p, "SELECT 1 FROM DUMMY", timeoutMs);
      return true;
    } catch {
      return false;
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
      return await this.limit(this.batch(sql, rows), sql);
    } catch (e) {
      if (e instanceof QueryTimeoutError) throw e;
      throw new DatabaseError(e, sql);
    } finally {
      this.onQuery?.({ sql, params: [], durationMs: performance.now() - started });
    }
  }

  private async batch(sql: string, rows: readonly (readonly unknown[])[]): Promise<number | number[] | undefined> {
    const stmt = await promisify<HanaStatement>((cb) => this.conn.prepare(sql, cb as (err: Error | null, s: unknown) => void));
    try {
      return await promisify<number | number[] | undefined>((cb) => stmt.execBatch(rows, cb as (err: Error | null, r: unknown) => void));
    } finally {
      await promisify<void>((cb) => stmt.drop(cb)).catch(() => {});
    }
  }
}

interface Waiter {
  resolve: (c: ConnectionQueryable) => void;
  reject: (e: Error) => void;
}

/** Timeout of the `SELECT 1 FROM DUMMY` check of an idle connection. */
const PING_TIMEOUT_MS = 5000;

const disconnectedError = (): Error => new Error("The client has been disconnected");

/**
 * Pooled driver for SAP HANA on top of `@sap/hana-client`.
 *
 * - Idle connections are checked before reuse once they were idle for `idleCheckAfter`, and
 *   closed after `idleTimeout`.
 * - A connection that fails with a "connection lost" error or times out is closed instead of
 *   returned to the pool. `query` is retried once on a fresh connection when its connection
 *   was lost; writes and transactions are not retried (the server may have applied them).
 * - `close()` stops new work, fails queued requests and waits up to `closeTimeout` for running ones.
 */
export class HanaDriver implements Driver {
  private readonly config: ConnectionConfig;
  private readonly poolSize: number;
  private readonly statementCacheSize: number;
  private readonly onQuery: ((e: QueryEvent) => void) | undefined;
  private readonly statementTimeout: number | undefined;
  private readonly idleTimeout: number;
  private readonly idleCheckAfter: number;
  private readonly closeTimeout: number;
  private readonly idle: ConnectionQueryable[] = [];
  private readonly all = new Set<ConnectionQueryable>();
  private readonly waiters: Waiter[] = [];
  private readonly hana: HanaModule | undefined;
  private open = 0;
  private closed = false;
  private sweeper: NodeJS.Timeout | undefined;
  private drained: (() => void) | undefined;

  constructor(config: ConnectionConfig, options: HanaDriverOptions = {}) {
    this.config = config;
    this.poolSize = Math.max(1, options.poolSize ?? 10);
    this.statementCacheSize = options.statementCacheSize ?? 0;
    this.onQuery = options.onQuery;
    this.statementTimeout = options.statementTimeout;
    this.idleTimeout = Math.max(0, options.idleTimeout ?? 5 * 60 * 1000);
    this.idleCheckAfter = Math.max(0, options.idleCheckAfter ?? 30 * 1000);
    this.closeTimeout = Math.max(0, options.closeTimeout ?? 10 * 1000);
    this.hana = options.hanaModule as HanaModule | undefined;
  }

  /** Open connections, idle and in use. */
  get size(): number {
    return this.open;
  }

  /** Idle connections in the pool. */
  get idleCount(): number {
    return this.idle.length;
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
    const q = new ConnectionQueryable(conn, this.onQuery, this.statementTimeout, this.statementCacheSize);
    this.all.add(q);
    this.startSweeper();
    return q;
  }

  /** Closes a connection that is not in the idle list and frees its pool slot. */
  private discard(c: ConnectionQueryable): void {
    if (!this.all.delete(c)) return;
    this.open--;
    c.kill();
    if (this.closed && !this.all.size) this.drained?.();
  }

  /** Closes connections that have been idle for `idleTimeout`. */
  private sweep(): void {
    if (!this.idleTimeout) return;
    const now = performance.now();
    for (let i = this.idle.length - 1; i >= 0; i--) {
      const c = this.idle[i]!;
      if (now - c.idleSince >= this.idleTimeout) {
        this.idle.splice(i, 1);
        this.discard(c);
      }
    }
  }

  private startSweeper(): void {
    if (this.sweeper || !this.idleTimeout || this.closed) return;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.min(60_000, this.idleTimeout / 2)));
    this.sweeper.unref?.();
  }

  /** Takes a healthy idle connection, opens a new one, or waits for one (at most `maxWait` ms). */
  private async acquire(maxWait?: number): Promise<ConnectionQueryable> {
    if (this.closed) throw disconnectedError();
    this.sweep();
    for (let c = this.idle.pop(); c; c = this.idle.pop()) {
      if (performance.now() - c.idleSince >= this.idleCheckAfter && !(await c.ping(PING_TIMEOUT_MS))) {
        this.discard(c);
        continue;
      }
      if (this.closed) {
        this.discard(c);
        throw disconnectedError();
      }
      return c;
    }
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
      const waiter: Waiter = {
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
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
    if (broken || c.broken || this.closed) {
      this.discard(c);
      // the freed slot lets the next waiter open a new connection
      const waiter = this.closed ? undefined : this.waiters.shift();
      if (waiter) this.acquire().then(waiter.resolve, waiter.reject);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(c);
    else {
      c.idleSince = performance.now();
      this.idle.push(c);
    }
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

  async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    try {
      return await this.withConnection((c) => c.query<T>(sql, params));
    } catch (e) {
      // The connection died under a read (e.g. a database restart): try once more on a new one.
      // A timeout is not retried; it would only time out again.
      if (!isConnectionLost(e) || e instanceof QueryTimeoutError || this.closed) throw e;
      return this.withConnection((c) => c.query<T>(sql, params));
    }
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
        // a killed connection rolls back on the server when its session ends
        if (!c.broken) await promisify<void>((cb) => c.conn.rollback(cb)).catch(() => {});
        throw e;
      } finally {
        if (!c.broken) {
          if (options.transactionalDdl) await c.execute("SET TRANSACTION AUTOCOMMIT DDL ON").catch(() => {});
          try {
            c.conn.setAutoCommit(true);
          } catch {
            c.broken = true;
          }
        }
      }
    }, options.maxWait);
  }

  /**
   * Prepares `sql` without running it and returns its result columns and parameters
   * (`hana-orm generate --sql`).
   */
  describe(sql: string): Promise<StatementDescription> {
    return this.withConnection(async (c) => {
      let stmt: HanaStatement;
      try {
        stmt = await promisify<HanaStatement>((cb) => c.conn.prepare(sql, cb as (err: Error | null, s: unknown) => void));
      } catch (e) {
        throw new DatabaseError(e, sql);
      }
      try {
        if (typeof stmt.getColumnInfo !== "function") throw new Error("This @sap/hana-client version cannot describe statements (no getColumnInfo)");
        return describeFromHanaMetadata(stmt.getColumnInfo(), typeof stmt.getParameterInfo === "function" ? stmt.getParameterInfo() : []);
      } finally {
        await promisify<void>((cb) => stmt.drop(cb)).catch(() => {});
      }
    });
  }

  /** Pool usage right now (`$metrics().pool`). */
  stats(): PoolStats {
    return { size: this.poolSize, open: this.open, idle: this.idle.length, busy: this.open - this.idle.length, waiting: this.waiters.length };
  }

  /**
   * Stops the pool: queued requests fail, idle connections are closed, and running statements
   * get up to `closeTimeout` to finish before their connections are closed too.
   */
  async close(): Promise<void> {
    if (this.closed && !this.all.size) return;
    this.closed = true;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const w of this.waiters.splice(0)) w.reject(disconnectedError());
    const idle = this.idle.splice(0);
    for (const c of idle) {
      this.all.delete(c);
      this.open--;
    }
    await Promise.all(idle.map((c) => promisify<void>((cb) => c.conn.disconnect(cb)).catch(() => {})));
    if (!this.all.size) return;
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve) => {
      this.drained = resolve;
      timer = setTimeout(resolve, this.closeTimeout);
    });
    clearTimeout(timer);
    this.drained = undefined;
    // whatever still runs after closeTimeout is cut off
    for (const c of [...this.all]) this.discard(c);
  }
}

/**
 * `@sap/hana-client` codes for a connection that is gone: -10807 connection down, -10108
 * reconnect/session error, -10709 connection failed, -10821 session not connected. A statement
 * timeout also ends its connection.
 */
const CONNECTION_LOST_CODES = new Set([-10807, -10108, -10709, -10821]);

export function isConnectionLost(e: unknown): boolean {
  if (e instanceof QueryTimeoutError) return true;
  const code = (e as { hanaCode?: number } | null)?.hanaCode;
  return code !== undefined && CONNECTION_LOST_CODES.has(code);
}
