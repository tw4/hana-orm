/** `select` / `insert` / `update` / `delete` builders. */

import type { Contract, ModelDef } from "../../schema/contract.ts";
import { columnFields } from "../../schema/contract.ts";
import type { Queryable } from "../driver.ts";
import { ValidationError } from "../errors.ts";
import { quoteIdent, tableRef } from "../sql.ts";
import type { Simplify } from "../types.ts";
import { Column, Param, SQL, TABLE, decodeColumn, isTable, type InsertOf, type Renderable, type RenderContext, type RowOf, type SourceMeta } from "./core.ts";
import type { SubqueryLike } from "./ops.ts";
import { fillParams, Prepared, slotNames } from "../prepared.ts";

/** What a builder needs from the client that runs it. */
export interface BuilderHost {
  contract: Contract;
  defaultSchema: string | undefined;
  run<T>(write: boolean, fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** The object API's createMany (client defaults, batching, validation). */
  createMany(model: ModelDef, rows: Record<string, unknown>[], q: Queryable): Promise<number>;
}

type AnySource = { readonly [TABLE]: SourceMeta };
type AliasOf<S> = S extends { readonly [TABLE]: { alias: infer A extends string } } ? A : never;
type SelectedValue = Column<any, string> | SQL<any> | AnySource;
export type Selection = Record<string, SelectedValue>;

type FieldResult<V, N extends string> =
  V extends Column<infer T, infer A>
    ? A extends N
      ? T | null
      : T
    : V extends SQL<infer T>
      ? T
      : V extends AnySource
        ? AliasOf<V> extends N
          ? RowOf<V> | null
          : RowOf<V>
        : never;

/** Row type of a select: the selection's values, with columns of outer-joined sources nullable. */
export type SelectResult<Sel, N extends string> = Simplify<{ [K in keyof Sel]: FieldResult<Sel[K], N> }>;
type AllResult<Sources, N extends string, Joined extends boolean> = Joined extends false
  ? Simplify<RowOf<Sources[keyof Sources]>>
  : Simplify<{ [A in keyof Sources]: A extends N ? RowOf<Sources[A]> | null : RowOf<Sources[A]> }>;
export type ResultOf<Sel, Sources, N extends string, Joined extends boolean> = Sel extends "all" ? AllResult<Sources, N, Joined> : SelectResult<Sel, N>;

/** One selected value: where it goes in the result row and how to decode it. */
interface Entry {
  path: [string] | [string, string];
  expr: Renderable;
  decode: (raw: unknown, contract: Contract) => unknown;
  /** Nested source alias: the nested object becomes null when all its columns are null (outer join). */
  group?: string;
}

function entriesOf(sel: Selection): Entry[] {
  const out: Entry[] = [];
  for (const [key, v] of Object.entries(sel)) {
    if (v instanceof Column) out.push({ path: [key], expr: v, decode: (raw, c) => decodeColumn(c, v, raw) });
    else if (v instanceof SQL) out.push({ path: [key], expr: v, decode: (raw, c) => (v.decoder ? v.decoder(raw, c) : raw) });
    else if (isTable(v)) {
      for (const [ck, col] of Object.entries(v[TABLE].columns)) {
        out.push({ path: [key, ck], expr: col, decode: (raw, c) => decodeColumn(c, col, raw), group: key });
      }
    } else throw new ValidationError(`select: '${key}' must be a column, a table or an sql expression`);
  }
  return out;
}

interface Join {
  type: "INNER" | "LEFT OUTER" | "RIGHT OUTER" | "FULL OUTER";
  source: AnySource;
  on: SQL<unknown> | undefined;
}

interface SelectState {
  fields: Selection | undefined;
  distinct: boolean;
  from: AnySource | undefined;
  joins: Join[];
  where: SQL<unknown> | undefined;
  groupBy: Renderable[];
  having: SQL<unknown> | undefined;
  orderBy: Renderable[];
  limit: number | undefined;
  offset: number | undefined;
  withs: Cte<string, Record<string, unknown>>[];
}

const clone = (s: SelectState, changes: Partial<SelectState>): SelectState => ({ ...s, ...changes });

/** Common part: rendering and running. */
abstract class Runnable<R> implements PromiseLike<R> {
  protected readonly host: BuilderHost;
  constructor(host: BuilderHost) {
    this.host = host;
  }
  abstract render(ctx: RenderContext): string;
  protected abstract run(q: Queryable, sql: string, params: unknown[]): Promise<R>;
  protected abstract readonly write: boolean;

  /** The SQL text and parameters, without running it. */
  toSQL(): { sql: string; params: unknown[] } {
    const ctx: RenderContext = { contract: this.host.contract, defaultSchema: this.host.defaultSchema, params: [] };
    const text = this.render(ctx);
    return { sql: text, params: ctx.params };
  }

  /**
   * Compiles the statement once; `execute({ name: value })` runs it with the values of its
   * `placeholder("name")`s.
   */
  prepare(): Prepared<R> {
    const { sql, params } = this.toSQL();
    const contract = this.host.contract;
    return new Prepared<R>((w, fn) => this.host.run(w, fn), this.write, sql, slotNames(params), (values, q) => this.run(q, sql, fillParams(contract, params, values)));
  }

  /** Runs the statement (also on `await`). */
  execute(): Promise<R> {
    const { sql, params } = this.toSQL();
    return this.host.run(this.write, (q) => this.run(q, sql, params));
  }

  then<A = R, B = never>(onfulfilled?: ((value: R) => A | PromiseLike<A>) | null, onrejected?: ((reason: any) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/** `db.select(...)`: chooses the selection; `.from()` starts the query. */
export class SelectStart<Sel> {
  readonly #host: BuilderHost;
  readonly #fields: Selection | undefined;
  readonly #distinct: boolean;
  readonly #withs: Cte<string, Record<string, unknown>>[];
  constructor(host: BuilderHost, fields: Selection | undefined, distinct: boolean, withs: Cte<string, Record<string, unknown>>[] = []) {
    this.#host = host;
    this.#fields = fields;
    this.#distinct = distinct;
    this.#withs = withs;
  }
  from<S extends AnySource>(source: S): SelectBuilder<Sel, { [K in AliasOf<S>]: S }, never, false> {
    if (!isTable(source)) throw new ValidationError("from() takes a table, an alias, a subquery or a CTE");
    return new SelectBuilder(this.#host, {
      fields: this.#fields,
      distinct: this.#distinct,
      from: source,
      joins: [],
      where: undefined,
      groupBy: [],
      having: undefined,
      orderBy: [],
      limit: undefined,
      offset: undefined,
      withs: this.#withs,
    });
  }
}

export class SelectBuilder<Sel, Sources, N extends string, Joined extends boolean> extends Runnable<ResultOf<Sel, Sources, N, Joined>[]> implements SubqueryLike {
  readonly _subquery = true as const;
  protected readonly write = false;
  readonly #s: SelectState;
  #entries: Entry[] | undefined;

  constructor(host: BuilderHost, state: SelectState) {
    super(host);
    this.#s = state;
  }

  #next<S2, N2 extends string, J2 extends boolean>(changes: Partial<SelectState>): SelectBuilder<Sel, S2, N2, J2> {
    return new SelectBuilder<Sel, S2, N2, J2>(this.host, clone(this.#s, changes));
  }

  #join(type: Join["type"], source: AnySource, on: SQL<unknown> | undefined) {
    if (!isTable(source)) throw new ValidationError("join() takes a table, an alias, a subquery or a CTE");
    const alias = source[TABLE].alias;
    if ([this.#s.from!, ...this.#s.joins.map((j) => j.source)].some((s) => s[TABLE].alias === alias)) {
      throw new ValidationError(`'${alias}' is already in this query; join it again with alias(table, "otherName")`);
    }
    return this.#next<never, never, true>({ joins: [...this.#s.joins, { type, source, on }] });
  }

  innerJoin<S extends AnySource>(source: S, on: SQL<unknown> | undefined): SelectBuilder<Sel, Sources & { [K in AliasOf<S>]: S }, N, true> {
    return this.#join("INNER", source, on) as never;
  }
  /** Columns of `source` are `| null` in the result. */
  leftJoin<S extends AnySource>(source: S, on: SQL<unknown> | undefined): SelectBuilder<Sel, Sources & { [K in AliasOf<S>]: S }, N | AliasOf<S>, true> {
    return this.#join("LEFT OUTER", source, on) as never;
  }
  /** Columns of the sources joined so far are `| null` in the result. */
  rightJoin<S extends AnySource>(source: S, on: SQL<unknown> | undefined): SelectBuilder<Sel, Sources & { [K in AliasOf<S>]: S }, N | (keyof Sources & string), true> {
    return this.#join("RIGHT OUTER", source, on) as never;
  }
  fullJoin<S extends AnySource>(source: S, on: SQL<unknown> | undefined): SelectBuilder<Sel, Sources & { [K in AliasOf<S>]: S }, N | (keyof Sources & string) | AliasOf<S>, true> {
    return this.#join("FULL OUTER", source, on) as never;
  }

  /** `undefined` means no condition (handy with `and(...)` of optional filters). */
  where(cond: SQL<unknown> | undefined): this {
    return this.#next({ where: cond }) as this;
  }
  groupBy(...exprs: Renderable[]): this {
    return this.#next({ groupBy: exprs }) as this;
  }
  having(cond: SQL<unknown> | undefined): this {
    return this.#next({ having: cond }) as this;
  }
  /** Columns or `asc(x)` / `desc(x)`. */
  orderBy(...exprs: Renderable[]): this {
    return this.#next({ orderBy: exprs }) as this;
  }
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) throw new ValidationError("limit() takes a non-negative integer");
    return this.#next({ limit: n }) as this;
  }
  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) throw new ValidationError("offset() takes a non-negative integer");
    return this.#next({ offset: n }) as this;
  }

  /** The selection, resolved (all columns when `select()` had no fields). */
  #resolve(): Entry[] {
    if (this.#entries) return this.#entries;
    const s = this.#s;
    let fields = s.fields;
    if (!fields) {
      const sources = [s.from!, ...s.joins.map((j) => j.source)];
      fields = s.joins.length ? Object.fromEntries(sources.map((src) => [src[TABLE].alias, src])) : { ...s.from![TABLE].columns };
    }
    this.#entries = entriesOf(fields);
    return this.#entries;
  }

  /** Output column name of entry `i`: the key path, so subqueries can refer to it. */
  static columnName(e: { path: string[] }): string {
    return e.path.join(".");
  }

  render(ctx: RenderContext): string {
    const s = this.#s;
    const entries = this.#resolve();
    let out = "";
    if (s.withs.length) out += `WITH ${s.withs.map((w) => w.renderDefinition(ctx)).join(", ")} `;
    out += `SELECT ${s.distinct ? "DISTINCT " : ""}${entries.map((e) => `${e.expr.render(ctx)} AS ${quoteIdent(SelectBuilder.columnName(e))}`).join(", ")}`;
    out += ` FROM ${s.from![TABLE].source.render(ctx)}`;
    for (const j of s.joins) out += ` ${j.type} JOIN ${j.source[TABLE].source.render(ctx)} ON ${j.on ? j.on.render(ctx) : "1 = 1"}`;
    if (s.where) out += ` WHERE ${s.where.render(ctx)}`;
    if (s.groupBy.length) out += ` GROUP BY ${s.groupBy.map((g) => g.render(ctx)).join(", ")}`;
    if (s.having) out += ` HAVING ${s.having.render(ctx)}`;
    if (s.orderBy.length) out += ` ORDER BY ${s.orderBy.map((o) => o.render(ctx)).join(", ")}`;
    if (s.limit !== undefined || s.offset !== undefined) out += ` LIMIT ${s.limit ?? 2147483647}${s.offset ? ` OFFSET ${s.offset}` : ""}`;
    return out;
  }

  protected async run(q: Queryable, text: string, params: unknown[]): Promise<ResultOf<Sel, Sources, N, Joined>[]> {
    const entries = this.#resolve();
    const contract = this.host.contract;
    const raw = await q.query<Record<string, unknown>>(text, params);
    return raw.map((r) => {
      const row: Record<string, unknown> = {};
      const groups = new Map<string, boolean>();
      for (const e of entries) {
        const v = r[SelectBuilder.columnName(e)];
        const value = v === null || v === undefined ? null : e.decode(v, contract);
        if (e.path.length === 1) row[e.path[0]] = value;
        else {
          const [g, k] = e.path;
          ((row[g] ??= {}) as Record<string, unknown>)[k] = value;
          if (value !== null) groups.set(g, true);
          else if (!groups.has(g)) groups.set(g, false);
        }
      }
      // a nested source that matched no row (outer join) is null, not an object of nulls
      for (const [g, any] of groups) if (!any && this.#isOuter(g)) row[g] = null;
      return row as ResultOf<Sel, Sources, N, Joined>;
    });
  }

  #isOuter(alias: string): boolean {
    const s = this.#s;
    const idx = s.joins.findIndex((j) => j.source[TABLE].alias === alias);
    const outerAfter = (from: number) => s.joins.slice(from).some((j) => j.type === "RIGHT OUTER" || j.type === "FULL OUTER");
    if (idx < 0) return outerAfter(0); // the FROM source
    const j = s.joins[idx]!;
    return j.type === "LEFT OUTER" || j.type === "FULL OUTER" || outerAfter(idx + 1);
  }

  /** Uses the query as a subquery: `.from(sq)`, `.leftJoin(sq, …)`, `sq.someField`. */
  as<A extends string>(name: A): Subquery<A, SubqueryColumns<Sel, A>> {
    return makeSubquery(this, name, false) as never;
  }

  /** @internal Selected entries, for subqueries. */
  _entries(): Entry[] {
    return this.#resolve();
  }
}

// ---- subqueries and CTEs -----------------------------------------------------------------

/** Columns a subquery exposes, re-qualified with its name. */
export type SubqueryColumns<Sel, A extends string> = {
  [K in keyof Sel]: Sel[K] extends Column<infer T, string> ? Column<T, A> : Sel[K] extends SQL<infer T> ? Column<T, A> : never;
};

export type Subquery<A extends string, Cols extends Record<string, unknown>> = Cols & { readonly [TABLE]: SourceMeta & { alias: A } };
export type Cte<A extends string, Cols extends Record<string, unknown>> = Subquery<A, Cols> & { renderDefinition(ctx: RenderContext): string };

function makeSubquery(qb: SelectBuilder<unknown, unknown, string, boolean>, name: string, cte: boolean): Subquery<string, Record<string, unknown>> {
  const columns: Record<string, Column<unknown, string>> = {};
  for (const e of qb._entries()) {
    if (e.path.length !== 1) throw new ValidationError(`A subquery needs a flat selection; select columns, not whole tables`);
    const key = e.path[0];
    const out = SelectBuilder.columnName(e);
    if (e.expr instanceof Column) columns[key] = new Column(name, key, out, e.expr.field, e.expr.decoder);
    // an expression column keeps the expression's decoder; values compared with it are bound as is
    else columns[key] = new Column(name, key, out, undefined, (e.expr as SQL<unknown>).decoder);
  }
  const source: Renderable = cte ? { render: () => quoteIdent(name) } : { render: (ctx) => `(${qb.render(ctx)}) ${quoteIdent(name)}` };
  const meta: SourceMeta = { alias: name, source, columns };
  const sub = Object.assign(Object.create(null), columns, { [TABLE]: meta });
  if (cte) Object.defineProperty(sub, "renderDefinition", { value: (ctx: RenderContext) => `${quoteIdent(name)} AS (${qb.render(ctx)})` });
  return sub;
}

/** `db.$with("name").as(query)`: a CTE for `db.with(cte).select()…`. */
export class WithStart<A extends string> {
  readonly #name: A;
  constructor(name: A) {
    this.#name = name;
  }
  as<Sel>(qb: SelectBuilder<Sel, unknown, string, boolean>): Cte<A, SubqueryColumns<Sel, A>> {
    return makeSubquery(qb as never, this.#name, true) as never;
  }
}

// ---- insert / update / delete ----------------------------------------------------------------

type TableOf = AnySource & Record<string, unknown>;

function modelOf(table: AnySource, op: string): ModelDef {
  const m = table[TABLE].model;
  if (!m) throw new ValidationError(`${op} needs a table, not a subquery`);
  if (m.kind === "view") throw new ValidationError(`'${m.name}' is a view and cannot be written`);
  return m;
}

export type { InsertOf };

/** `db.insert(table).values(rows)`: same defaults and validation as `createMany`; resolves with the row count. */
export class InsertBuilder<Row> {
  readonly #host: BuilderHost;
  readonly #model: ModelDef;
  constructor(host: BuilderHost, table: TableOf) {
    this.#host = host;
    this.#model = modelOf(table, "insert()");
  }
  values(rows: Row | Row[]): PromiseLike<number> {
    const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
    const host = this.#host;
    const model = this.#model;
    return { then: (ok, fail) => host.run(true, (q) => host.createMany(model, list, q)).then(ok, fail) };
  }
}

/** Values of `set()`: a value of the column's type, `null` for nullable columns, or an SQL expression. */
export type SetValues<T> = { [K in keyof RowOf<T>]?: RowOf<T>[K] | SQL<unknown> };

export class UpdateStart<T> {
  readonly #host: BuilderHost;
  readonly #table: TableOf;
  constructor(host: BuilderHost, table: TableOf) {
    this.#host = host;
    this.#table = table;
  }
  set(values: SetValues<T>): UpdateBuilder {
    return new UpdateBuilder(this.#host, this.#table, values as Record<string, unknown>, undefined);
  }
}

export class UpdateBuilder extends Runnable<number> {
  protected readonly write = true;
  readonly #table: TableOf;
  readonly #values: Record<string, unknown>;
  readonly #where: SQL<unknown> | undefined;
  constructor(host: BuilderHost, table: TableOf, values: Record<string, unknown>, where: SQL<unknown> | undefined) {
    super(host);
    this.#table = table;
    this.#values = values;
    this.#where = where;
  }
  where(cond: SQL<unknown> | undefined): UpdateBuilder {
    return new UpdateBuilder(this.host, this.#table, this.#values, cond);
  }
  render(ctx: RenderContext): string {
    const model = modelOf(this.#table, "update()");
    const meta = this.#table[TABLE];
    if (!Object.values(this.#values).some((v) => v !== undefined)) throw new ValidationError(`update() of '${model.name}' sets no column`);
    const values = { ...this.#values };
    // @updatedAt fields are kept current, as in the object API
    for (const f of columnFields(model)) if (f.kind === "scalar" && f.updatedAt && values[f.name] === undefined) values[f.name] = new Date();
    const sets: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      const col = meta.columns[k];
      if (!col) throw new ValidationError(`Unknown column '${k}' in update of '${model.name}'`);
      const rhs = v instanceof SQL ? v.render(ctx) : v === null ? "NULL" : new Param(v, col.field).render(ctx);
      sets.push(`${quoteIdent(col.dbName)} = ${rhs}`);
    }
    return `UPDATE ${tableRef(model, ctx.defaultSchema)} ${quoteIdent(meta.alias)} SET ${sets.join(", ")}${this.#where ? ` WHERE ${this.#where.render(ctx)}` : ""}`;
  }
  protected run(q: Queryable, text: string, params: unknown[]): Promise<number> {
    return q.execute(text, params);
  }
}

export class DeleteBuilder extends Runnable<number> {
  protected readonly write = true;
  readonly #table: TableOf;
  readonly #where: SQL<unknown> | undefined;
  constructor(host: BuilderHost, table: TableOf, where: SQL<unknown> | undefined = undefined) {
    super(host);
    this.#table = table;
    this.#where = where;
  }
  where(cond: SQL<unknown> | undefined): DeleteBuilder {
    return new DeleteBuilder(this.host, this.#table, cond);
  }
  render(ctx: RenderContext): string {
    const model = modelOf(this.#table, "delete()");
    return `DELETE FROM ${tableRef(model, ctx.defaultSchema)} ${quoteIdent(this.#table[TABLE].alias)}${this.#where ? ` WHERE ${this.#where.render(ctx)}` : ""}`;
  }
  protected run(q: Queryable, text: string, params: unknown[]): Promise<number> {
    return q.execute(text, params);
  }
}
