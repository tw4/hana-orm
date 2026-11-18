/**
 * Client events (`$on`) and metrics (`$metrics`). Every statement goes through an
 * `InstrumentedDriver`, so custom drivers are observed the same way as the built-in pool.
 * Parameter values never reach events unless the client is created with `logParams: true`.
 */

import type { Driver, Queryable, TransactionOptions } from "./driver.ts";

export type ClientEventName = "query" | "info" | "warn" | "error";

export interface QueryLogEvent {
  timestamp: Date;
  sql: string;
  /** Bound values; empty unless the client was created with `logParams: true`. */
  params: readonly unknown[];
  durationMs: number;
  /** Set when the statement failed. */
  error?: string;
  /** True for statements inside `$transaction`. */
  inTransaction: boolean;
}

export interface LogEvent {
  timestamp: Date;
  message: string;
  /** Where it comes from: `client`, `query`, `transaction`, or `<Model>.<operation>`. */
  target: string;
}

export interface ClientEvents {
  query: QueryLogEvent;
  info: LogEvent;
  warn: LogEvent;
  error: LogEvent;
}

/** Durations (ms) bounding the histogram buckets; the last bucket is everything above. */
export const DURATION_BUCKETS_MS = [1, 5, 10, 50, 100, 500, 1000, 5000] as const;

export interface PoolStats {
  /** Configured maximum. */
  size: number;
  /** Open connections, idle and busy. */
  open: number;
  idle: number;
  busy: number;
  /** Requests waiting for a connection. */
  waiting: number;
}

export interface ClientMetrics {
  queries: {
    total: number;
    failed: number;
    durationMs: { total: number; max: number; avg: number };
    /** `le` = upper bound in ms (`Infinity` for the last bucket); counts are not cumulative. */
    histogram: { le: number; count: number }[];
  };
  transactions: { total: number; committed: number; rolledBack: number };
  /** Null when the driver does not report pool statistics. */
  pool: PoolStats | null;
}

export interface ObserverOptions {
  logParams?: boolean;
  /** Statements that take at least this many ms also emit a `warn` event. */
  slowQueryThreshold?: number;
}

type Handler<E extends ClientEventName> = (event: ClientEvents[E]) => void;

export class Observer {
  readonly #handlers: { [E in ClientEventName]: Set<Handler<E>> } = { query: new Set(), info: new Set(), warn: new Set(), error: new Set() };
  readonly #logParams: boolean;
  readonly #slow: number | undefined;
  #queries = 0;
  #failed = 0;
  #durationTotal = 0;
  #durationMax = 0;
  #buckets = new Array<number>(DURATION_BUCKETS_MS.length + 1).fill(0);
  #tx = { total: 0, committed: 0, rolledBack: 0 };

  constructor(options: ObserverOptions = {}) {
    this.#logParams = options.logParams === true;
    this.#slow = options.slowQueryThreshold !== undefined && options.slowQueryThreshold >= 0 ? options.slowQueryThreshold : undefined;
  }

  on<E extends ClientEventName>(event: E, handler: Handler<E>): () => void {
    const set = this.#handlers[event] as Set<Handler<E>> | undefined;
    if (!set) throw new Error(`Unknown event '${String(event)}'; use query, info, warn or error`);
    set.add(handler);
    return () => void set.delete(handler);
  }

  /** True when someone listens; lets callers skip building events. */
  listens(event: ClientEventName): boolean {
    return this.#handlers[event].size > 0;
  }

  emit<E extends ClientEventName>(event: E, payload: ClientEvents[E]): void {
    for (const h of this.#handlers[event] as Set<Handler<E>>) {
      try {
        h(payload);
      } catch {
        // a failing listener must not break the query
      }
    }
  }

  log(level: "info" | "warn" | "error", message: string, target: string): void {
    if (this.#handlers[level].size) this.emit(level, { timestamp: new Date(), message, target });
  }

  /** @internal Records one statement. */
  recordQuery(sql: string, params: readonly unknown[], durationMs: number, inTransaction: boolean, error?: unknown): void {
    this.#queries++;
    if (error !== undefined) this.#failed++;
    this.#durationTotal += durationMs;
    if (durationMs > this.#durationMax) this.#durationMax = durationMs;
    let i = DURATION_BUCKETS_MS.findIndex((b) => durationMs <= b);
    if (i < 0) i = DURATION_BUCKETS_MS.length;
    this.#buckets[i]!++;
    if (this.#handlers.query.size) {
      this.emit("query", {
        timestamp: new Date(),
        sql,
        params: this.#logParams ? params : [],
        durationMs,
        inTransaction,
        ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
      });
    }
    if (this.#slow !== undefined && durationMs >= this.#slow) {
      this.log("warn", `Slow query (${durationMs.toFixed(1)} ms): ${sql.split("\n")[0]!.slice(0, 200)}`, "query");
    }
  }

  /** @internal */
  recordTransaction(committed: boolean): void {
    this.#tx.total++;
    if (committed) this.#tx.committed++;
    else this.#tx.rolledBack++;
  }

  metrics(pool: PoolStats | null): ClientMetrics {
    return {
      queries: {
        total: this.#queries,
        failed: this.#failed,
        durationMs: { total: this.#durationTotal, max: this.#durationMax, avg: this.#queries ? this.#durationTotal / this.#queries : 0 },
        histogram: this.#buckets.map((count, i) => ({ le: DURATION_BUCKETS_MS[i] ?? Infinity, count })),
      },
      transactions: { ...this.#tx },
      pool,
    };
  }
}

/** A driver that may report pool statistics (the built-in `HanaDriver` does). */
export interface StatsDriver extends Driver {
  stats?(): PoolStats;
}

/** Times every statement of `inner` (also inside transactions) and reports it to `observer`. */
export class InstrumentedDriver implements StatsDriver {
  readonly inner: StatsDriver;
  readonly #observer: Observer;

  constructor(inner: StatsDriver, observer: Observer) {
    this.inner = inner;
    this.#observer = observer;
  }

  async #time<T>(q: Queryable, inTx: boolean, sql: string, params: readonly unknown[], run: (q: Queryable) => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const r = await run(q);
      this.#observer.recordQuery(sql, params, performance.now() - started, inTx);
      return r;
    } catch (e) {
      this.#observer.recordQuery(sql, params, performance.now() - started, inTx, e);
      throw e;
    }
  }

  #wrap(q: Queryable, inTx: boolean): Queryable {
    return {
      query: <T>(sql: string, params: readonly unknown[] = []) => this.#time(q, inTx, sql, params, (x) => x.query<T>(sql, params)),
      execute: (sql: string, params: readonly unknown[] = []) => this.#time(q, inTx, sql, params, (x) => x.execute(sql, params)),
      executeBatch: (sql: string, rows: readonly (readonly unknown[])[]) => this.#time(q, inTx, sql, rows, (x) => x.executeBatch(sql, rows)),
    };
  }

  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.#wrap(this.inner, false).query<T>(sql, params);
  }

  execute(sql: string, params?: readonly unknown[]): Promise<number> {
    return this.#wrap(this.inner, false).execute(sql, params);
  }

  executeBatch(sql: string, rows: readonly (readonly unknown[])[]): Promise<number> {
    return this.#wrap(this.inner, false).executeBatch(sql, rows);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T> {
    let started = false;
    try {
      const r = await this.inner.transaction((tx) => {
        started = true;
        return fn(this.#wrap(tx, true));
      }, options);
      this.#observer.recordTransaction(true);
      return r;
    } catch (e) {
      // a transaction that never got a connection (maxWait) is not counted
      if (started) this.#observer.recordTransaction(false);
      throw e;
    }
  }

  stats(): PoolStats {
    return this.inner.stats!();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
