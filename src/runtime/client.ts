import type { DecimalConstructor, DecimalMode } from "./codec.ts";
import type { Contract, ModelDef } from "../schema/contract.ts";
import { clientContract } from "../schema/contract.ts";
import { formatTimestamp } from "./codec.ts";
import { resolveConnectionConfig, resolveDefaultSchema } from "./config.ts";
import type { Driver, IsolationLevel, QueryEvent, Queryable } from "./driver.ts";
import { Engine } from "./engine.ts";
import { NotFoundError, TransactionError, ValidationError } from "./errors.ts";
import { HanaDriver, type ConnectionConfig } from "./hana-driver.ts";

export type LogOption = boolean | "query" | ((event: QueryEvent) => void);

/** Options of `$transaction`; client-wide defaults go into `ClientOptions.transactionOptions`. */
export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /**
   * Milliseconds the transaction may run once it has a connection (default 5000). When it
   * runs longer, `$transaction` rejects with `TransactionError` (`TRANSACTION_TIMEOUT`), later
   * queries of the transaction fail, and the transaction is rolled back and its connection
   * released as soon as the statement that is running has finished. `0` or `Infinity`
   * disables the limit.
   */
  timeout?: number;
  /** Milliseconds to wait for a free pooled connection (default 2000); `Infinity` waits. */
  maxWait?: number;
}

export const DEFAULT_TRANSACTION_TIMEOUT = 5000;
export const DEFAULT_TRANSACTION_MAX_WAIT = 2000;

/**
 * Result of a model or raw query method. It runs when it is awaited (or `then` is called),
 * so it can also be handed to `$transaction([...])` to run inside one transaction.
 */
export class QueryPromise<T> implements Promise<T> {
  readonly [Symbol.toStringTag] = "QueryPromise";
  #run: (client: BaseClient | undefined) => PromiseLike<T>;
  #started: Promise<T> | undefined;

  /** @internal */
  constructor(run: (client: BaseClient | undefined) => PromiseLike<T>) {
    this.#run = run;
  }

  #start(): Promise<T> {
    this.#started ??= Promise.resolve().then(() => this.#run(undefined));
    return this.#started;
  }

  /** @internal Runs the query on `client` (a transaction client). */
  _runOn(client: BaseClient): Promise<T> {
    if (this.#started) throw new ValidationError("A query passed to $transaction([...]) was already awaited; pass it without awaiting it.");
    this.#started = Promise.resolve().then(() => this.#run(client));
    return this.#started;
  }

  then<A = T, B = never>(onfulfilled?: ((value: T) => A | PromiseLike<A>) | null, onrejected?: ((reason: any) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.#start().then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: any) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.#start().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#start().finally(onfinally);
  }
}

/**
 * The connection of one `$transaction` as its queries see it: it refuses new statements once
 * the transaction has ended or timed out, and tracks running statements so the rollback
 * waits for them.
 */
class TransactionScope implements Queryable {
  #q: Queryable;
  #closed: TransactionError | undefined;
  #running = new Set<Promise<unknown>>();

  constructor(q: Queryable) {
    this.#q = q;
  }

  #track<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const p = run();
    this.#running.add(p);
    const done = (): void => void this.#running.delete(p);
    p.then(done, done);
    return p;
  }

  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.#track(() => this.#q.query<T>(sql, params));
  }

  execute(sql: string, params?: readonly unknown[]): Promise<number> {
    return this.#track(() => this.#q.execute(sql, params));
  }

  executeBatch(sql: string, rows: readonly (readonly unknown[])[]): Promise<number> {
    return this.#track(() => this.#q.executeBatch(sql, rows));
  }

  close(reason: TransactionError): void {
    this.#closed ??= reason;
  }

  /** Waits until no statement is running. */
  async settle(): Promise<void> {
    while (this.#running.size) await Promise.allSettled([...this.#running]);
  }
}

export interface ClientOptions {
  /** Overrides connection settings from the schema's datasource block / env vars. */
  datasource?: Partial<ConnectionConfig>;
  /** Default schema for tables of models without `@@schema` (overrides the datasource). */
  schema?: string;
  /** Use your own driver (tests, custom pooling). */
  driver?: Driver;
  /** Max pooled connections (default 10). */
  poolSize?: number;
  /** `true`/"query" prints each SQL statement with its duration; a function receives the events. */
  log?: LogOption;
  /** Fields left out of every result unless a query asks for them: `{ user: { passwordHash: true } }`. */
  omit?: Record<string, Record<string, boolean | undefined> | undefined>;
  /** Defaults for every `$transaction` (`timeout`, `maxWait`, `isolationLevel`). */
  transactionOptions?: TransactionOptions;
}

export const OPERATIONS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;
export type Operation = (typeof OPERATIONS)[number];

const WRITES = new Set<Operation>(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);

type AnyFn = (...args: any[]) => any;

export interface QueryExtensionParams {
  model: string;
  operation: Operation;
  args: any;
  query: (args: any) => Promise<any>;
}

export interface ExtensionArgs {
  name?: string;
  /** Extra methods on model delegates: `{ user: { findByEmail(email) {...} }, $allModels: {...} }`. */
  model?: Record<string, Record<string, AnyFn>>;
  /** Wrap operations: `{ user: { findMany({ args, query }) {...} }, $allModels: { $allOperations(...) {...} } }`. */
  query?: Record<string, Record<string, (params: QueryExtensionParams) => Promise<any>>>;
  /** Extra methods on the client itself. */
  client?: Record<string, AnyFn>;
}

export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Settings the generator bakes into a client class (they shape its types). */
export interface GeneratedConfig {
  /** How Decimal fields are returned (generator option `decimal`, default "string"). */
  decimal?: DecimalMode;
  /** decimal.js' class, passed by clients generated with `decimal = "decimal.js"`. */
  Decimal?: DecimalConstructor;
}

interface Shared {
  contract: Contract;
  options: ClientOptions;
  config: GeneratedConfig;
  engine: Engine | undefined;
  driver: Driver | undefined;
}

/** Runtime base of every generated client. Generated code only adds types on top of it. */
export class BaseClient {
  /** @internal */ _shared: Shared;
  /** @internal */ _tx: Queryable | undefined;
  /** @internal */ _extensions: ExtensionArgs[];

  constructor(contract: Contract, options: ClientOptions = {}, config: GeneratedConfig = {}) {
    this._shared = { contract: clientContract(contract), options, config, engine: undefined, driver: options.driver };
    this._tx = undefined;
    this._extensions = [];
    this._install();
    // Validate the client-wide omit config up front instead of on the first query.
    if (options.omit) this._engine();
  }

  /** @internal */
  _engine(): Engine {
    const s = this._shared;
    s.engine ??= new Engine(s.contract, s.options.schema ?? resolveDefaultSchema(s.contract.datasource), {
      omit: s.options.omit,
      decode: { ...(s.config.decimal ? { decimal: s.config.decimal } : {}), ...(s.config.Decimal ? { Decimal: s.config.Decimal } : {}) },
    });
    return s.engine;
  }

  /** @internal */
  _driver(): Driver {
    const s = this._shared;
    if (!s.driver) {
      const config = resolveConnectionConfig(s.contract.datasource, s.options.datasource);
      s.driver = new HanaDriver(config, { poolSize: s.options.poolSize, onQuery: makeLogger(s.options.log) });
    }
    return s.driver;
  }

  /** @internal Runs reads directly and writes in a transaction (unless already inside one). */
  _run<T>(write: boolean, fn: (q: Queryable) => Promise<T>): Promise<T> {
    if (this._tx) return fn(this._tx);
    if (!write) return fn(this._driver());
    return this._driver().transaction(fn);
  }

  /** @internal */
  _install(): void {
    const self = this as unknown as Record<string, unknown>;
    for (const model of Object.values(this._shared.contract.models)) self[lowerFirst(model.name)] = this._delegate(model);
    for (const ext of this._extensions) {
      for (const [name, fn] of Object.entries(ext.client ?? {})) self[name] = fn.bind(this);
    }
  }

  /** @internal */
  _delegate(model: ModelDef): Record<string, AnyFn> {
    const delegate: Record<string, AnyFn> = {};
    const key = lowerFirst(model.name);
    for (const op of OPERATIONS) {
      const base = (args: any) => this._execute(model, op, args);
      // Wrap with query extensions, innermost = first registered.
      let call: (args: any) => Promise<any> = base;
      for (const ext of this._extensions) {
        const hooks = [ext.query?.[key]?.[op], ext.query?.[key]?.$allOperations, ext.query?.$allModels?.[op], ext.query?.$allModels?.$allOperations].filter(Boolean) as ((p: QueryExtensionParams) => Promise<any>)[];
        for (const hook of hooks) {
          const next = call;
          call = (args: any) => hook({ model: model.name, operation: op, args, query: next });
        }
      }
      // Lazy: runs when awaited, or inside $transaction([...]) on the transaction client.
      delegate[op] = (args?: any) =>
        new QueryPromise((client) => (client ? (client as unknown as Record<string, Record<string, AnyFn>>)[key]![op]!(args) : call(args ?? {})));
    }
    for (const ext of this._extensions) {
      for (const [name, fn] of Object.entries({ ...ext.model?.$allModels, ...ext.model?.[key] })) delegate[name] = fn.bind(delegate);
    }
    Object.defineProperty(delegate, "$name", { value: model.name });
    return delegate;
  }

  /** @internal */
  async _execute(model: ModelDef, op: Operation, args: any): Promise<any> {
    const e = this._engine();
    switch (op) {
      case "findMany":
        return this._run(false, (q) => e.findMany(model, args, q));
      case "findFirst":
        return this._run(false, (q) => e.findFirst(model, args, q));
      case "findFirstOrThrow": {
        const r = await this._run(false, (q) => e.findFirst(model, args, q));
        if (!r) throw new NotFoundError(model.name);
        return r;
      }
      case "findUnique":
        return this._run(false, (q) => e.findUnique(model, args, q));
      case "findUniqueOrThrow": {
        const r = await this._run(false, (q) => e.findUnique(model, args, q));
        if (!r) throw new NotFoundError(model.name);
        return r;
      }
      case "count":
        return this._run(false, (q) => e.count(model, args, q));
      case "aggregate":
        return this._run(false, (q) => e.aggregate(model, args, q));
      case "groupBy":
        return this._run(false, (q) => e.groupBy(model, args, q));
      default: {
        if (!WRITES.has(op)) throw new Error(`Unknown operation ${op}`);
        return this._run(true, (q) => (e[op as "create"] as (m: ModelDef, a: any, q: Queryable) => Promise<unknown>).call(e, model, args, q));
      }
    }
  }

  /** @internal Clone sharing driver/engine with a different transaction or extensions. */
  _clone(changes: { tx?: Queryable; extensions?: ExtensionArgs[] }): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    c._shared = this._shared;
    c._tx = changes.tx ?? this._tx;
    c._extensions = changes.extensions ?? this._extensions;
    c._install();
    return c;
  }

  /** Opens a connection eagerly (otherwise the first query connects). */
  async $connect(): Promise<void> {
    await this._driver().query(`SELECT 1 AS "ok" FROM DUMMY`);
  }

  /** Closes all pooled connections. */
  async $disconnect(): Promise<void> {
    await this._shared.driver?.close();
    this._shared.driver = undefined;
  }

  /**
   * Runs `fn` in one transaction, or runs the given queries in order in one transaction and
   * resolves with their results. Throwing (or a failing query) rolls everything back. Nested
   * calls reuse the outer transaction (and its timeout).
   */
  $transaction<R>(fn: (tx: this) => Promise<R>, options?: TransactionOptions): Promise<R>;
  $transaction<const P extends readonly PromiseLike<unknown>[]>(queries: P, options?: TransactionOptions): Promise<{ -readonly [K in keyof P]: Awaited<P[K]> }>;
  $transaction(arg: ((tx: this) => Promise<unknown>) | readonly PromiseLike<unknown>[], options?: TransactionOptions): Promise<unknown> {
    let body: (tx: this) => Promise<unknown>;
    if (Array.isArray(arg)) {
      const queries = arg as readonly PromiseLike<unknown>[];
      const bad = queries.findIndex((q) => !(q instanceof QueryPromise));
      if (bad >= 0) return Promise.reject(new ValidationError(`$transaction([...]) expects queries of this client; item ${bad} is not one (pass db.model.method(...) or a raw query without awaiting it).`));
      body = async (tx) => {
        const results: unknown[] = [];
        for (const q of queries as readonly QueryPromise<unknown>[]) results.push(await q._runOn(tx));
        return results;
      };
    } else if (typeof arg === "function") body = arg;
    else return Promise.reject(new ValidationError("$transaction expects a function or an array of queries."));

    if (this._tx) return body(this);
    const opts = { ...this._shared.options.transactionOptions, ...options };
    const timeout = opts.timeout ?? DEFAULT_TRANSACTION_TIMEOUT;
    const maxWait = opts.maxWait ?? DEFAULT_TRANSACTION_MAX_WAIT;
    const limited = timeout > 0 && Number.isFinite(timeout);

    let rejectTimeout: (e: TransactionError) => void = () => {};
    const timedOut = new Promise<never>((_, reject) => (rejectTimeout = reject));
    const run = this._driver().transaction(
      async (q) => {
        const scope = new TransactionScope(q);
        let expired: TransactionError | undefined;
        const timer = limited
          ? setTimeout(() => {
              expired = new TransactionError("TRANSACTION_TIMEOUT", `Transaction timed out after ${timeout} ms and was rolled back.`);
              scope.close(expired);
              rejectTimeout(expired);
            }, timeout)
          : undefined;
        try {
          const result = await body(this._clone({ tx: scope }));
          await scope.settle();
          // a callback that finished after the timeout must not commit
          if (expired) throw expired;
          return result;
        } catch (e) {
          await scope.settle();
          throw expired ?? e;
        } finally {
          clearTimeout(timer);
          scope.close(new TransactionError("TRANSACTION_CLOSED", "This transaction has already finished; run the query on the client or in a new $transaction."));
        }
      },
      { ...(opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : {}), ...(Number.isFinite(maxWait) ? { maxWait } : {}) },
    );
    if (!limited) return run;
    // Reject at the timeout without waiting for a running statement; the rollback follows.
    run.catch(() => {});
    timedOut.catch(() => {});
    return Promise.race([run, timedOut]);
  }

  /** Raw SELECT as a tagged template; values are bound as parameters. Rows are returned as the driver gives them. */
  $queryRaw<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
    return this.$queryRawUnsafe<T>(strings.join("?"), ...values);
  }

  /** Raw DML/DDL as a tagged template; returns the affected row count. */
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    return this.$executeRawUnsafe(strings.join("?"), ...values);
  }

  /** Raw SELECT with `?` placeholders. Never build `sql` from user input. */
  $queryRawUnsafe<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return new QueryPromise((client) => (client ? client.$queryRawUnsafe<T>(sql, ...params) : this._run(false, (q) => q.query<T>(sql, params.map(rawParam)))));
  }

  /** Raw DML/DDL with `?` placeholders. Never build `sql` from user input. */
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
    return new QueryPromise((client) => (client ? client.$executeRawUnsafe(sql, ...params) : this._run(false, (q) => q.execute(sql, params.map(rawParam)))));
  }

  /** Returns a new client with the extension applied; the original is unchanged. */
  $extends(extension: ExtensionArgs): this {
    return this._clone({ extensions: [...this._extensions, extension] });
  }
}

function rawParam(v: unknown): unknown {
  if (v instanceof Date) return formatTimestamp(v);
  if (typeof v === "bigint") return v.toString();
  return v;
}

function makeLogger(log: LogOption | undefined): ((e: QueryEvent) => void) | undefined {
  if (!log) return undefined;
  if (typeof log === "function") return log;
  return (e) => console.log(`hana-orm:query ${e.sql} (${e.durationMs.toFixed(1)} ms)`);
}

/** Used by generated code: `export const HanaClient = createClientClass(contract)`. */
export function createClientClass(contract: Contract, config: GeneratedConfig = {}): new (options?: ClientOptions) => BaseClient {
  if (config.decimal === "decimal.js" && !config.Decimal) throw new Error('createClientClass: decimal "decimal.js" needs the Decimal class');
  return class HanaClient extends BaseClient {
    constructor(options?: ClientOptions) {
      super(contract, options, config);
    }
  };
}
