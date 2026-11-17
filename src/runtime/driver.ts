/** Minimal database access used by the query runtime, migrations and introspection. */

export type SqlParam = null | number | bigint | boolean | string | Buffer | Date;

export interface Queryable {
  /** Runs a statement that returns rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs DML/DDL and returns the affected row count. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
  /** Runs one statement for many parameter rows (batch insert). Returns the total affected rows. */
  executeBatch(sql: string, rows: readonly (readonly unknown[])[]): Promise<number>;
}

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /**
   * Run DDL inside the transaction (`SET TRANSACTION AUTOCOMMIT DDL OFF`), so CREATE/ALTER
   * statements are rolled back on failure. Used by migrations.
   */
  transactionalDdl?: boolean;
  /**
   * Milliseconds to wait for a free pooled connection before failing with
   * `TransactionError` (`TRANSACTION_MAX_WAIT`). Default: wait until one is free.
   */
  maxWait?: number;
}

export interface Driver extends Queryable {
  /** Runs `fn` on one connection inside a transaction; commits on success, rolls back on error. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

export interface QueryEvent {
  sql: string;
  params: readonly unknown[];
  durationMs: number;
}
