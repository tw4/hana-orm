/** Hand-built contracts and a fake driver for migration tests (synthetic names only). */

import { createHash } from "node:crypto";
import type {
  ColumnFieldDef,
  Contract,
  DefaultDef,
  EnumDef,
  FieldDef,
  ModelDef,
  NativeType,
  ReferentialAction,
  RelationFieldDef,
  ScalarType,
} from "../../src/schema/contract.ts";
import { CONTRACT_VERSION } from "../../src/schema/contract.ts";
import type { Driver, Queryable, TransactionOptions } from "../../src/runtime/driver.ts";

export interface ColOpts {
  map?: string;
  optional?: boolean;
  id?: boolean;
  unique?: boolean;
  default?: DefaultDef;
  native?: NativeType;
  updatedAt?: boolean;
}

export function col(name: string, type: ScalarType, opts: ColOpts = {}): ColumnFieldDef {
  return {
    kind: "scalar",
    name,
    dbName: opts.map ?? name,
    type,
    optional: opts.optional ?? false,
    id: opts.id ?? false,
    unique: opts.unique ?? false,
    updatedAt: opts.updatedAt ?? false,
    ...(opts.default ? { default: opts.default } : {}),
    ...(opts.native ? { nativeType: opts.native } : {}),
  };
}

export function enumCol(name: string, enumName: string, opts: ColOpts = {}): ColumnFieldDef {
  return {
    kind: "enum",
    name,
    dbName: opts.map ?? name,
    type: enumName,
    optional: opts.optional ?? false,
    id: false,
    unique: opts.unique ?? false,
    updatedAt: false,
    ...(opts.default ? { default: opts.default } : {}),
    ...(opts.native ? { nativeType: opts.native } : {}),
  };
}

export interface RelOpts {
  fields?: string[];
  references?: string[];
  list?: boolean;
  optional?: boolean;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  fkName?: string;
  relationName?: string;
}

export function rel(name: string, model: string, opts: RelOpts = {}): RelationFieldDef {
  const owner = !!opts.fields;
  return {
    kind: "relation",
    name,
    model,
    list: opts.list ?? false,
    optional: opts.optional ?? false,
    relationName: opts.relationName ?? "R",
    owner,
    localFields: opts.fields ?? [],
    targetFields: opts.references ?? [],
    ...(opts.onDelete ? { onDelete: opts.onDelete } : {}),
    ...(opts.onUpdate ? { onUpdate: opts.onUpdate } : {}),
    ...(opts.fkName ? { fkName: opts.fkName } : {}),
  };
}

export interface ModelOpts {
  map?: string;
  schema?: string;
  id?: string[];
  pkName?: string;
  uniques?: { fields: string[]; dbName?: string }[];
  indexes?: { fields: string[]; dbName?: string }[];
  kind?: "model" | "view";
}

export function model(name: string, fields: FieldDef[], opts: ModelOpts = {}): ModelDef {
  const dbName = opts.map ?? name;
  const colName = (f: string): string => (fields.find((x) => x.name === f) as ColumnFieldDef | undefined)?.dbName ?? f;
  const idFields = opts.id ?? fields.filter((f) => f.kind !== "relation" && f.id).map((f) => f.name);
  const uniques = [
    ...fields.filter((f) => f.kind !== "relation" && f.unique).map((f) => ({ name: f.name, dbName: `UQ_${dbName}_${colName(f.name)}`, fields: [f.name] })),
    ...(opts.uniques ?? []).map((u) => ({ name: u.fields.join("_"), dbName: u.dbName ?? `UQ_${dbName}_${u.fields.map(colName).join("_")}`, fields: u.fields })),
  ];
  return {
    name,
    dbName,
    ...(opts.schema ? { schema: opts.schema } : {}),
    kind: opts.kind ?? "model",
    fields,
    primaryKey: idFields.length ? { name: idFields.join("_"), dbName: opts.pkName ?? `PK_${dbName}`, fields: idFields } : null,
    uniques,
    indexes: (opts.indexes ?? []).map((i) => ({ dbName: i.dbName ?? `IX_${dbName}_${i.fields.map(colName).join("_")}`, fields: i.fields })),
  };
}

export function contract(models: ModelDef[], enums: EnumDef[] = []): Contract {
  const c: Contract = {
    version: CONTRACT_VERSION,
    hash: "",
    datasource: { name: "db", provider: "hana" },
    generators: [],
    models: Object.fromEntries(models.map((m) => [m.name, m])),
    enums: Object.fromEntries(enums.map((e) => [e.name, e])),
  };
  c.hash = createHash("sha256").update(JSON.stringify({ models: c.models, enums: c.enums })).digest("hex");
  return c;
}

/** A small blog-like schema used by many tests. */
export function blogContract(): Contract {
  const user = model("User", [
    col("id", "Int", { id: true, default: { kind: "autoincrement" }, map: "ID" }),
    col("email", "String", { unique: true, map: "EMAIL", native: { name: "NVarChar", args: [255] } }),
    col("name", "String", { optional: true, map: "NAME" }),
    col("createdAt", "DateTime", { default: { kind: "now" }, map: "CREATED_AT" }),
    rel("posts", "Post", { list: true }),
  ], { map: "USERS" });
  const post = model(
    "Post",
    [
      col("id", "Int", { id: true, default: { kind: "autoincrement" }, map: "ID" }),
      col("title", "String", { map: "TITLE", native: { name: "NVarChar", args: [200] } }),
      col("published", "Boolean", { default: { kind: "value", value: false }, map: "PUBLISHED" }),
      col("authorId", "Int", { map: "AUTHOR_ID" }),
      rel("author", "User", { fields: ["authorId"], references: ["id"], onDelete: "Cascade", fkName: "FK_POSTS_AUTHOR_ID" }),
    ],
    { map: "POSTS", indexes: [{ fields: ["authorId"] }] },
  );
  return contract([user, post]);
}

// ---- fake driver ------------------------------------------------------------------

export interface Executed {
  sql: string;
  params: readonly unknown[];
  /** Transaction number, or 0 outside a transaction. */
  tx: number;
}

export type QueryHandler = (sql: string, params: readonly unknown[]) => Record<string, unknown>[] | undefined;

/** Records statements; queries are answered by `onQuery` (default: no rows). */
export class FakeDriver implements Driver {
  executed: Executed[] = [];
  committed: number[] = [];
  rolledBack: number[] = [];
  txOptions: (TransactionOptions | undefined)[] = [];
  onQuery: QueryHandler = () => [];
  /** Throws when a statement matches. */
  failOn: RegExp | undefined;
  /** Optional affected-row count for execute(); default 1. */
  onExecute: ((sql: string, params: readonly unknown[]) => number | undefined) | undefined;
  closed = false;
  private txCounter = 0;

  private queryable(tx: number): Queryable {
    return {
      query: async <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> => (this.onQuery(sql, params) ?? []) as T[],
      execute: async (sql: string, params: readonly unknown[] = []): Promise<number> => {
        if (this.failOn?.test(sql)) throw new Error(`fake failure on: ${sql.split("\n")[0]}`);
        this.executed.push({ sql, params, tx });
        return this.onExecute?.(sql, params) ?? 1;
      },
      executeBatch: async (sql: string, rows: readonly (readonly unknown[])[]): Promise<number> => {
        for (const r of rows) this.executed.push({ sql, params: r, tx });
        return rows.length;
      },
    };
  }

  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.queryable(0).query<T>(sql, params);
  }
  execute(sql: string, params?: readonly unknown[]): Promise<number> {
    return this.queryable(0).execute(sql, params);
  }
  executeBatch(sql: string, rows: readonly (readonly unknown[])[]): Promise<number> {
    return this.queryable(0).executeBatch(sql, rows);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const id = ++this.txCounter;
    this.txOptions.push(options);
    try {
      const r = await fn(this.queryable(id));
      this.committed.push(id);
      return r;
    } catch (e) {
      this.rolledBack.push(id);
      this.executed = this.executed.filter((x) => x.tx !== id);
      throw e;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** Statements that survived (committed or autocommitted). */
  sql(): string[] {
    return this.executed.map((e) => e.sql);
  }
}
