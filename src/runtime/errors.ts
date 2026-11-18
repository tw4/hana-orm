/** Base class for errors raised by the hana-orm runtime. `code` is stable across versions. */
export class HanaOrmError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HanaOrmError";
    this.code = code;
  }
}

/** Invalid query arguments (unknown field, wrong value type, missing required field...). */
export class ValidationError extends HanaOrmError {
  constructor(message: string) {
    super("VALIDATION", message);
    this.name = "ValidationError";
  }
}

/** `...OrThrow`, `update`, `delete` and nested `connect` found no record. */
export class NotFoundError extends HanaOrmError {
  readonly model: string;
  constructor(model: string, message = `No '${model}' record found`) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
    this.model = model;
  }
}

/** A database error, with the HANA error code when available (e.g. 301 = unique constraint violated). */
export class DatabaseError extends HanaOrmError {
  readonly hanaCode: number | undefined;
  readonly sql: string;
  constructor(cause: unknown, sql: string) {
    const e = cause as { code?: number; message?: string };
    super(DatabaseError.codeFor(e.code), e.message ?? String(cause), { cause });
    this.name = "DatabaseError";
    this.hanaCode = typeof e.code === "number" ? e.code : undefined;
    this.sql = sql;
  }

  static codeFor(code: number | undefined): string {
    switch (code) {
      case 301:
        return "UNIQUE_CONSTRAINT";
      case 461:
      case 462:
        return "FOREIGN_KEY_CONSTRAINT";
      case 287:
        return "NOT_NULL_CONSTRAINT";
      case 10:
      case 414:
        return "AUTHENTICATION";
      default:
        return "DATABASE";
    }
  }
}

/**
 * A statement ran longer than `statementTimeout`. Its connection was closed (which also stops
 * the statement on the server) and is not reused; an open transaction on it is rolled back.
 */
export class QueryTimeoutError extends HanaOrmError {
  readonly sql: string;
  readonly timeoutMs: number;
  constructor(timeoutMs: number, sql: string) {
    super("QUERY_TIMEOUT", `The statement did not finish within statementTimeout (${timeoutMs} ms): ${sql.split("\n")[0]!.slice(0, 200)}`);
    this.name = "QueryTimeoutError";
    this.sql = sql;
    this.timeoutMs = timeoutMs;
  }
}

export type TransactionErrorCode = "TRANSACTION_TIMEOUT" | "TRANSACTION_MAX_WAIT" | "TRANSACTION_CLOSED";

/**
 * A transaction ran longer than `timeout`, no connection was free within `maxWait`, or a
 * query used a transaction client after its transaction had ended.
 */
export class TransactionError extends HanaOrmError {
  declare readonly code: TransactionErrorCode;
  constructor(code: TransactionErrorCode, message: string) {
    super(code, message);
    this.name = "TransactionError";
  }
}
