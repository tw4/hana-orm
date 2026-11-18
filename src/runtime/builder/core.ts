/**
 * Building blocks of the SQL-like query builder (issue #28): SQL fragments with bound
 * parameters, typed columns, tables (and aliases), subqueries.
 *
 * Every value that is not an identifier is bound as a `?` parameter. Values compared with a
 * column are encoded with that column's codec, so enums, dates, decimals and bigints behave
 * as in the object API.
 */

import type { ColumnFieldDef, Contract, ModelDef } from "../../schema/contract.ts";
import { columnFields } from "../../schema/contract.ts";
import { decodeValue, encodeValue, formatTimestamp } from "../codec.ts";
import { ValidationError } from "../errors.ts";
import { quoteIdent, tableRef } from "../sql.ts";

/** What rendering needs from the client. */
export interface RenderContext {
  contract: Contract;
  defaultSchema: string | undefined;
  params: unknown[];
  /**
   * Set when an `sql` fragment is embedded in an object-API query: table name → the alias the
   * query uses for it. Columns of other tables are rejected.
   */
  aliases?: ReadonlyMap<string, string>;
}

/** Anything that renders to SQL text. */
export interface Renderable {
  render(ctx: RenderContext): string;
}

const isRenderable = (v: unknown): v is Renderable => typeof v === "object" && v !== null && typeof (v as Renderable).render === "function";

/** A bound value, encoded with `field`'s codec when it is compared with a column. */
export class Param implements Renderable {
  readonly value: unknown;
  readonly field: ColumnFieldDef | undefined;
  constructor(value: unknown, field?: ColumnFieldDef) {
    this.value = value;
    this.field = field;
  }
  render(ctx: RenderContext): string {
    ctx.params.push(this.field ? encodeValue(ctx.contract, this.field, this.value) : rawValue(this.value));
    return "?";
  }
}

/** Driver value for an untyped parameter (same rules as `$queryRaw`). */
export function rawValue(v: unknown): unknown {
  if (v instanceof Date) return formatTimestamp(v);
  if (typeof v === "bigint") return v.toString();
  return v;
}

/** Decodes a selected value. */
export type Decoder = (raw: unknown, contract: Contract) => unknown;

/**
 * A SQL expression of type `T`: a list of text chunks and renderables. Built by the `sql`
 * template tag and by the operators.
 */
export class SQL<T = unknown> implements Renderable {
  readonly chunks: readonly (string | Renderable)[];
  decoder: Decoder | undefined;
  /** Type-only. */
  declare readonly _type: T;
  constructor(chunks: readonly (string | Renderable)[], decoder?: Decoder) {
    this.chunks = chunks;
    this.decoder = decoder;
  }
  render(ctx: RenderContext): string {
    return this.chunks.map((c) => (typeof c === "string" ? c : c.render(ctx))).join("");
  }
  /** Decodes the selected value with `fn` (or as `column` would be decoded). */
  mapWith<U>(fn: ((raw: unknown) => U) | Column<U, string>): SQL<U> {
    const decoder: Decoder = fn instanceof Column ? (raw, contract) => decodeColumn(contract, fn, raw) : (raw) => fn(raw);
    return new SQL<U>(this.chunks, decoder);
  }
  /** Names the expression; useful in `orderBy` of a select that returns it. */
  as(name: string): SQL<T> {
    return new SQL<T>([...this.chunks, ` AS ${quoteIdent(name)}`], this.decoder);
  }
}

/** Interpolated into `sql`: columns and tables render as identifiers, SQL as SQL, the rest is bound. */
export function toRenderable(v: unknown): Renderable {
  if (isRenderable(v)) return v;
  if (isTable(v)) return v[TABLE].source;
  return new Param(v);
}

/**
 * `sql\`LOWER(${users.email}) = ${email}\``: columns and tables become identifiers, values
 * are bound parameters. `sql.raw(text)` inserts text as is (never pass user input).
 */
export function sql<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): SQL<T> {
  const chunks: (string | Renderable)[] = [];
  strings.forEach((s, i) => {
    if (s) chunks.push(s);
    if (i < values.length) chunks.push(toRenderable(values[i]));
  });
  return new SQL<T>(chunks);
}
sql.raw = (text: string): SQL<unknown> => new SQL([text]);
/** A quoted identifier (`"MY_COLUMN"`, `"SCHEMA"."TABLE"` for several parts); quotes inside are escaped. */
sql.identifier = (...parts: string[]): SQL<unknown> => {
  if (!parts.length || parts.some((p) => typeof p !== "string" || !p)) throw new ValidationError("sql.identifier() takes non-empty names");
  return new SQL([parts.map(quoteIdent).join(".")]);
};
/** Joins fragments with a separator: `sql.join([a, b], sql\`, \`)`. */
sql.join = (parts: readonly unknown[], separator: SQL | string = ", "): SQL<unknown> => {
  const chunks: (string | Renderable)[] = [];
  parts.forEach((p, i) => {
    if (i) chunks.push(typeof separator === "string" ? separator : separator);
    chunks.push(toRenderable(p));
  });
  return new SQL(chunks);
};

// ---- tables and columns ------------------------------------------------------------------

export const TABLE = Symbol.for("hana-orm.table");

/** The FROM side of a table, alias or subquery. */
export interface SourceMeta {
  /** Name used to qualify its columns (`"user"."EMAIL"`), and the key of its row in joined results. */
  alias: string;
  /** `FROM` text: `"APP"."USERS" "user"` or `(SELECT …) "sq"`. */
  source: Renderable;
  /** Columns by key, in select order. */
  columns: Record<string, Column<unknown, string>>;
  model?: ModelDef;
}

/** A column of `TableName` holding `T` (`| null` already included for optional fields). */
export class Column<T, TableName extends string = string> implements Renderable {
  readonly sourceAlias: TableName;
  readonly name: string;
  /** Identifier rendered after the alias. */
  readonly dbName: string;
  /** The model field; undefined for an expression column of a subquery. */
  readonly field: ColumnFieldDef | undefined;
  /** Decoder of an expression column of a subquery. */
  readonly decoder: Decoder | undefined;
  declare readonly _type: T;
  constructor(sourceAlias: TableName, name: string, dbName: string, field: ColumnFieldDef | undefined, decoder?: Decoder) {
    this.sourceAlias = sourceAlias;
    this.name = name;
    this.dbName = dbName;
    this.field = field;
    this.decoder = decoder;
  }
  render(ctx?: RenderContext): string {
    if (ctx?.aliases) {
      const a = ctx.aliases.get(this.sourceAlias);
      if (a === undefined) {
        throw new ValidationError(`Column '${this.sourceAlias}.${this.name}' cannot be used here; only columns of ${[...ctx.aliases.keys()].map((k) => `'${k}'`).join(", ")} are in this query`);
      }
      return `${a}.${quoteIdent(this.dbName)}`;
    }
    return `${quoteIdent(this.sourceAlias)}.${quoteIdent(this.dbName)}`;
  }
}

/** Type-only key carrying a table's insert row type. */
export declare const INSERT_TYPE: unique symbol;

export type Table<Name extends string, Cols extends Record<string, unknown>, Insert = unknown> = Cols & {
  readonly [TABLE]: SourceMeta & { alias: Name };
  readonly [INSERT_TYPE]?: Insert;
};

/** Row accepted by `db.insert(table).values(...)`. */
export type InsertOf<T> = T extends { readonly [INSERT_TYPE]?: infer I } ? (unknown extends I ? Partial<RowOf<T>> : I) : never;

export const isTable = (v: unknown): v is Table<string, Record<string, unknown>> => typeof v === "object" && v !== null && TABLE in v;

class TableSource implements Renderable {
  readonly model: ModelDef;
  readonly alias: string;
  constructor(model: ModelDef, alias: string) {
    this.model = model;
    this.alias = alias;
  }
  render(ctx: RenderContext): string {
    return `${tableRef(this.model, ctx.defaultSchema)} ${quoteIdent(this.alias)}`;
  }
}

function makeTable(model: ModelDef, alias: string): Table<string, Record<string, Column<unknown, string>>> {
  const columns: Record<string, Column<unknown, string>> = {};
  for (const f of columnFields(model)) columns[f.name] = new Column(alias, f.name, f.dbName, f);
  const meta: SourceMeta = { alias, source: new TableSource(model, alias), columns, model };
  return Object.assign(Object.create(null), columns, { [TABLE]: meta }) as Table<string, Record<string, Column<unknown, string>>>;
}

/** Table objects for every model: `tables.user.email`. Aliased by the delegate name (`user`). */
export function createTables(contract: Contract): Record<string, Table<string, Record<string, Column<unknown, string>>>> {
  const out: Record<string, Table<string, Record<string, Column<unknown, string>>>> = {};
  for (const m of Object.values(contract.models)) {
    if (m.implicit) continue;
    const key = m.name.charAt(0).toLowerCase() + m.name.slice(1);
    out[key] = makeTable(m, key);
  }
  return out;
}

/** The same table under another name, for self-joins: `const author = alias(tables.user, "author")`. */
export function alias<T extends Table<string, Record<string, unknown>>, A extends string>(table: T, name: A): AliasOf<T, A> {
  const meta = table[TABLE];
  if (!meta.model) throw new ValidationError("alias() takes a table; give a subquery its name with .as()");
  return makeTable(meta.model, name) as unknown as AliasOf<T, A>;
}

type ColumnsOf<T> = Omit<T, typeof TABLE | typeof INSERT_TYPE>;
export type AliasOf<T, A extends string> = { [K in keyof ColumnsOf<T>]: ColumnsOf<T>[K] extends Column<infer V, string> ? Column<V, A> : never } & {
  readonly [TABLE]: SourceMeta & { alias: A };
  readonly [INSERT_TYPE]?: InsertOf<T>;
};

/** Row type of a table or subquery. */
export type RowOf<T> = { -readonly [K in keyof ColumnsOf<T>]: ColumnsOf<T>[K] extends Column<infer V, string> ? V : never };

/** `table.$inferSelect`-style helper: `type User = InferRow<typeof tables.user>`. */
export type InferRow<T> = RowOf<T>;

export function decodeColumn(contract: Contract, c: Column<unknown, string>, raw: unknown): unknown {
  if (c.decoder) return c.decoder(raw, contract);
  return c.field ? decodeValue(contract, c.field, raw) : raw;
}
