import type { Contract, ModelDef } from "../schema/contract.ts";
import { clientContract } from "../schema/contract.ts";
import { formatTimestamp } from "./codec.ts";
import { resolveConnectionConfig, resolveDefaultSchema } from "./config.ts";
import type { Driver, QueryEvent, Queryable, TransactionOptions } from "./driver.ts";
import { Engine } from "./engine.ts";
import { NotFoundError } from "./errors.ts";
import { HanaDriver, type ConnectionConfig } from "./hana-driver.ts";

export type LogOption = boolean | "query" | ((event: QueryEvent) => void);

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
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;
export type Operation = (typeof OPERATIONS)[number];

const WRITES = new Set<Operation>(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);

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

interface Shared {
  contract: Contract;
  options: ClientOptions;
  engine: Engine | undefined;
  driver: Driver | undefined;
}

/** Runtime base of every generated client. Generated code only adds types on top of it. */
export class BaseClient {
  /** @internal */ _shared: Shared;
  /** @internal */ _tx: Queryable | undefined;
  /** @internal */ _extensions: ExtensionArgs[];

  constructor(contract: Contract, options: ClientOptions = {}) {
    this._shared = { contract: clientContract(contract), options, engine: undefined, driver: options.driver };
    this._tx = undefined;
    this._extensions = [];
    this._install();
    // Validate the client-wide omit config up front instead of on the first query.
    if (options.omit) this._engine();
  }

  /** @internal */
  _engine(): Engine {
    const s = this._shared;
    s.engine ??= new Engine(s.contract, s.options.schema ?? resolveDefaultSchema(s.contract.datasource), { omit: s.options.omit });
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
      delegate[op] = (args?: any) => call(args ?? {});
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

  /** Runs `fn` in one transaction. Throwing rolls everything back. Nested calls reuse the outer transaction. */
  $transaction<R>(fn: (tx: this) => Promise<R>, options?: TransactionOptions): Promise<R> {
    if (this._tx) return fn(this);
    return this._driver().transaction((q) => fn(this._clone({ tx: q })), options);
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
    return this._run(false, (q) => q.query<T>(sql, params.map(rawParam)));
  }

  /** Raw DML/DDL with `?` placeholders. Never build `sql` from user input. */
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
    return this._run(false, (q) => q.execute(sql, params.map(rawParam)));
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
export function createClientClass(contract: Contract): new (options?: ClientOptions) => BaseClient {
  return class HanaClient extends BaseClient {
    constructor(options?: ClientOptions) {
      super(contract, options);
    }
  };
}
