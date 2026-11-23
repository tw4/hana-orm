import { randomBytes, randomUUID } from "node:crypto";
import {
  columnFields,
  getField,
  relationFields,
  type ColumnFieldDef,
  type Contract,
  type ModelDef,
  type RelationFieldDef,
} from "../schema/contract.ts";
import { decodeValue, encodeValue, type DecodeOptions } from "./codec.ts";
import { fillParams, slotNames, type PlaceholderValues } from "./prepared.ts";
import { collectPlaceholders, substitutePlaceholders } from "./placeholder.ts";
import type { Queryable } from "./driver.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { quoteIdent, tableRef } from "./sql.ts";
import { buildWhere, compoundKey, isPlainObject, joinCondition, scalarCondition, SqlContext } from "./where.ts";
import { PlanCache, planKey, type PlanCacheStats } from "./plan-cache.ts";

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

const MAX_LIMIT = 2147483647;
const IN_CHUNK = 500;

interface Selection {
  columns: ColumnFieldDef[];
  relations: { field: RelationFieldDef; args: Args }[];
  counts: RelationFieldDef[];
  /** Columns fetched only to load relations; removed from the result. */
  hidden: Set<string>;
}

interface SelectOptions {
  /** Apply take/skip/cursor (false when loading relations in batches). */
  paging?: boolean;
  /** Columns fetched in addition to the selection and hidden from the result. */
  extraColumns?: string[];
  /** Ignore `omit` defaults (inner selects of aggregates). */
  allColumns?: boolean;
  /** Fields added to `distinct` (the relation key, so nested `distinct` works per parent). */
  distinctScope?: string[];
  /** Apply `cursor` without paging (nested loads): rows from the cursor on ("after") or up to it ("before", negative take). */
  nestedCursor?: "after" | "before";
}

interface OrderSpec {
  /** Set when ordering by a column of the model itself (not through a relation or aggregate). */
  field?: ColumnFieldDef;
  /** Renders the ORDER BY expression for rows aliased as `alias`. */
  expr: (alias: string) => string;
  desc: boolean;
  nulls?: "first" | "last";
}

interface OrderItem extends OrderSpec {
  sql: string;
}

function sortSpec(v: unknown, key: string): { desc: boolean; nulls?: "first" | "last" } {
  const spec = typeof v === "string" ? { sort: v } : isPlainObject(v) ? (v as { sort?: unknown; nulls?: unknown }) : {};
  if (spec.sort !== "asc" && spec.sort !== "desc") throw new ValidationError(`orderBy.${key} must be 'asc' or 'desc'`);
  if (spec.nulls !== undefined && spec.nulls !== "first" && spec.nulls !== "last") throw new ValidationError(`orderBy.${key}.nulls must be 'first' or 'last'`);
  return { desc: spec.sort === "desc", ...(spec.nulls ? { nulls: spec.nulls as "first" | "last" } : {}) };
}

function reverseItem(o: OrderItem): OrderItem {
  return { ...o, desc: !o.desc, ...(o.nulls ? { nulls: o.nulls === "first" ? "last" : "first" } : {}) };
}

function columnOrder(f: ColumnFieldDef, alias: string, desc = false): OrderItem {
  const expr = (a: string) => `${a}.${quoteIdent(f.dbName)}`;
  return { field: f, expr, sql: expr(alias), desc };
}

function orderSql(items: OrderItem[]): string {
  return items.map((o) => `${o.sql} ${o.desc ? "DESC" : "ASC"}${o.nulls ? ` NULLS ${o.nulls.toUpperCase()}` : ""}`).join(", ");
}

function toArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function keyString(values: unknown[]): string | null {
  const parts: string[] = [];
  for (const v of values) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) parts.push(`d:${v.getTime()}`);
    else if (Buffer.isBuffer(v)) parts.push(`b:${v.toString("hex")}`);
    else parts.push(`${typeof v === "bigint" || typeof v === "number" ? "n" : typeof v}:${String(v)}`);
  }
  return parts.join("\u0001");
}

function isNumericField(f: ColumnFieldDef): boolean {
  return f.kind === "scalar" && ["Int", "BigInt", "Float", "Decimal"].includes(f.type);
}

function cuid(): string {
  return `c${Date.now().toString(36)}${randomBytes(10).toString("hex").slice(0, 16)}`;
}

function nonNegativeInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ValidationError(`'${name}' must be a non-negative integer`);
  return v;
}

/** Turns query arguments into SQL and results back into objects. Stateless apart from the contract. */
export interface EngineOptions {
  /** Client-wide `omit`, keyed by delegate name (`user`, `post`, ...). */
  omit?: Record<string, Record<string, boolean | undefined> | undefined>;
  /** Compiled SELECTs kept per query shape (default 500; 0 disables the cache). */
  planCacheSize?: number;
  /** How Decimal values are returned. */
  decode?: DecodeOptions;
}

/** Default number of cached query plans. */
export const DEFAULT_PLAN_CACHE_SIZE = 500;

export class Engine {
  readonly contract: Contract;
  readonly defaultSchema: string | undefined;
  /** Client-wide omitted fields per model name. */
  readonly globalOmit: Map<string, Record<string, boolean | undefined>>;
  readonly #plans: PlanCache<Selection>;
  readonly decode: DecodeOptions;

  constructor(contract: Contract, defaultSchema?: string, options: EngineOptions = {}) {
    this.contract = contract;
    this.defaultSchema = defaultSchema;
    this.globalOmit = new Map();
    this.#plans = new PlanCache(options.planCacheSize ?? DEFAULT_PLAN_CACHE_SIZE);
    this.decode = options.decode ?? {};
    for (const [key, value] of Object.entries(options.omit ?? {})) {
      if (value === undefined) continue;
      const model = Object.values(contract.models).find((m) => m.name.charAt(0).toLowerCase() + m.name.slice(1) === key);
      if (!model) throw new ValidationError(`Unknown model '${key}' in the client 'omit' option`);
      this.validateOmit(model, value);
      this.globalOmit.set(model.name, value);
    }
  }

  private validateOmit(model: ModelDef, omit: unknown): asserts omit is Record<string, boolean | undefined> {
    if (!isPlainObject(omit)) throw new ValidationError(`'omit' on '${model.name}' must be an object of fields`);
    for (const [key, v] of Object.entries(omit)) {
      const f = getField(model, key);
      if (!f || f.kind === "relation") throw new ValidationError(`Unknown field '${key}' in omit of '${model.name}'; only scalar fields can be omitted`);
      if (v !== undefined && typeof v !== "boolean") throw new ValidationError(`omit.${key} on '${model.name}' must be true or false`);
    }
  }

  /** Fields left out of results: the client-wide default plus the query's `omit` (`false` re-includes a field). */
  private omittedFields(model: ModelDef, omit: unknown): Set<string> {
    const out = new Set<string>();
    for (const [k, v] of Object.entries(this.globalOmit.get(model.name) ?? {})) if (v) out.add(k);
    if (omit !== undefined && omit !== null) {
      this.validateOmit(model, omit);
      for (const [k, v] of Object.entries(omit)) {
        if (v === true) out.add(k);
        else if (v === false) out.delete(k);
      }
    }
    return out;
  }

  model(name: string): ModelDef {
    const m = this.contract.models[name];
    if (!m) throw new ValidationError(`Unknown model '${name}'`);
    return m;
  }

  table(model: ModelDef): string {
    return tableRef(model, this.defaultSchema);
  }

  /** Join table of an implicit many-to-many relation. */
  joinTable(rel: RelationFieldDef): string {
    if (!rel.through) throw new ValidationError(`'${rel.name}' is not a many-to-many relation`);
    return tableRef(rel.through, this.defaultSchema);
  }

  column(model: ModelDef, name: string): ColumnFieldDef {
    const f = getField(model, name);
    if (!f || f.kind === "relation") throw new ValidationError(`Unknown field '${name}' on model '${model.name}'`);
    return f;
  }

  // =====================================================================
  // Reads
  // =====================================================================

  async findMany(model: ModelDef, args: Args = {}, q: Queryable): Promise<Row[]> {
    const { rows, hidden } = await this.readMany(model, args, q);
    return strip(rows, hidden);
  }

  async findFirst(model: ModelDef, args: Args = {}, q: Queryable): Promise<Row | null> {
    const rows = await this.findMany(model, { ...args, take: args.take === undefined ? 1 : args.take }, q);
    return rows[0] ?? null;
  }

  /**
   * Compiles a read once for a prepared query. Without relations to load, executions only fill
   * the placeholders; with `include` / relation selects the arguments get the values and the
   * read runs as usual.
   */
  prepareRead(model: ModelDef, op: string, args: Args = {}): { sql: string; placeholders: Set<string>; run: (values: PlaceholderValues, q: Queryable) => Promise<unknown> } {
    let a: Args = args;
    const unique = op === "findUnique" || op === "findUniqueOrThrow";
    if (unique) {
      if (!isPlainObject(args?.where)) throw new ValidationError(`${op} on '${model.name}' needs a 'where' with a unique field`);
      this.assertUniqueWhere(model, args.where);
      a = { where: args.where, select: args.select, include: args.include, omit: args.omit };
    }
    if (unique || op === "findFirst" || op === "findFirstOrThrow") a = { ...a, take: a.take === undefined ? 1 : a.take };
    else if (op !== "findMany") throw new ValidationError(`prepare() supports findMany, findFirst(OrThrow) and findUnique(OrThrow), not ${op}`);
    const built = this.buildSelect(model, a);
    // nested reads (include) may have placeholders that are not in the top-level SQL
    const placeholders = collectPlaceholders(a, slotNames(built.params));
    const reusable = !built.sel.relations.length;
    const shape = (rows: Row[]): unknown => {
      if (op === "findMany") return rows;
      const row = rows[0] ?? null;
      if (!row && op.endsWith("OrThrow")) throw new NotFoundError(model.name);
      return row;
    };
    return {
      sql: built.sql,
      placeholders,
      run: async (values, q) => {
        const res = reusable
          ? await this.execSelect(model, { ...built, params: fillParams(this.contract, built.params, values) }, a, q)
          : await this.readMany(model, substitutePlaceholders(a, values) as Args, q);
        return shape(strip(res.rows, res.hidden));
      },
    };
  }

  async findUnique(model: ModelDef, args: Args, q: Queryable): Promise<Row | null> {
    if (!isPlainObject(args?.where)) throw new ValidationError(`findUnique on '${model.name}' needs a 'where' with a unique field`);
    this.assertUniqueWhere(model, args.where);
    return this.findFirst(model, { where: args.where, select: args.select, include: args.include, omit: args.omit }, q);
  }

  private assertUniqueWhere(model: ModelDef, where: Row): void {
    const isEquality = (v: unknown) => v !== undefined && v !== null && (!isPlainObject(v) || (v.equals !== undefined && v.equals !== null));
    const satisfied = (fields: string[]) => fields.every((f) => isEquality(where[f]));
    const candidates: string[][] = [];
    if (model.primaryKey) candidates.push(model.primaryKey.fields);
    for (const u of model.uniques) candidates.push(u.fields);
    const ok =
      candidates.some((fields) => satisfied(fields)) ||
      Object.keys(where).some((k) => where[k] !== undefined && compoundKey(model, k) !== undefined);
    if (!ok) {
      const names = [model.primaryKey?.name, ...model.uniques.map((u) => u.name)].filter(Boolean).join(", ");
      throw new ValidationError(`'where' of a unique query on '${model.name}' must contain a unique field (${names || "none defined"})`);
    }
  }

  private resolveSelection(model: ModelDef, args: Args, options: SelectOptions = {}): Selection {
    if (args.select && args.include) throw new ValidationError(`Use either 'select' or 'include' on '${model.name}', not both`);
    if (args.select && args.omit) throw new ValidationError(`Use either 'select' or 'omit' on '${model.name}', not both`);
    const sel: Selection = { columns: [], relations: [], counts: [], hidden: new Set() };
    const addRelation = (key: string, value: unknown) => {
      if (key === "_count") {
        sel.counts = this.resolveCount(model, value);
        return;
      }
      const f = getField(model, key);
      if (!f) throw new ValidationError(`Unknown field '${key}' in select/include of '${model.name}'`);
      if (f.kind !== "relation") throw new ValidationError(`'${key}' on '${model.name}' is not a relation; it cannot be used in include`);
      sel.relations.push({ field: f, args: value === true ? {} : (value as Args) });
    };

    if (isPlainObject(args.select)) {
      for (const [key, value] of Object.entries(args.select)) {
        if (!value) continue;
        const f = getField(model, key);
        if (f && f.kind !== "relation") {
          if (value !== true) throw new ValidationError(`select.${key} on '${model.name}' must be true or false`);
          sel.columns.push(f);
        } else addRelation(key, value);
      }
      if (!sel.columns.length && !sel.relations.length && !sel.counts.length) throw new ValidationError(`'select' on '${model.name}' selects nothing`);
    } else {
      const omitted = options.allColumns ? new Set<string>() : this.omittedFields(model, args.omit);
      sel.columns = columnFields(model).filter((f) => !omitted.has(f.name));
      if (!sel.columns.length) throw new ValidationError(`'omit' on '${model.name}' leaves no fields to return`);
      if (isPlainObject(args.include)) for (const [key, value] of Object.entries(args.include)) if (value) addRelation(key, value);
    }
    // Columns needed to stitch relations together are fetched even when not selected, then removed.
    const needed = [...sel.relations.flatMap((r) => r.field.localFields), ...(options.extraColumns ?? [])];
    for (const name of needed) {
      if (!sel.columns.some((c) => c.name === name)) {
        sel.columns.push(this.column(model, name));
        sel.hidden.add(name);
      }
    }
    return sel;
  }

  private resolveCount(model: ModelDef, value: unknown): RelationFieldDef[] {
    const lists = relationFields(model).filter((r) => r.list);
    if (value === true) return lists;
    if (isPlainObject(value) && isPlainObject(value.select)) {
      return Object.entries(value.select)
        .filter(([, v]) => v)
        .map(([k]) => {
          const r = lists.find((x) => x.name === k);
          if (!r) throw new ValidationError(`_count.select.${k}: '${k}' is not a list relation of '${model.name}'`);
          return r;
        });
    }
    throw new ValidationError(`_count must be true or { select: { ... } }`);
  }

  private distinctFields(model: ModelDef, distinct: unknown): ColumnFieldDef[] {
    if (distinct === undefined || distinct === null) return [];
    const names = toArray(distinct as string | string[]);
    if (!names.every((n) => typeof n === "string")) throw new ValidationError(`'distinct' on '${model.name}' must be a field name or an array of field names`);
    return [...new Set(names)].map((n) => this.column(model, n));
  }

  /** ORDER BY items of `orderBy` for rows of `model` aliased as `alias`. */
  private orderItems(model: ModelDef, orderBy: unknown, alias: string, ctx: SqlContext): OrderItem[] {
    return this.orderSpecs(model, orderBy, ctx).map((s) => ({ ...s, sql: s.expr(alias) }));
  }

  /**
   * Parses `orderBy` into expressions that can be rendered for any alias (the cursor condition
   * renders them again against the cursor row). Relation entries become correlated subqueries:
   * to-one relations order by a field of the related row, list relations by their `_count`.
   */
  private orderSpecs(model: ModelDef, orderBy: unknown, ctx: SqlContext, path = ""): OrderSpec[] {
    const items: OrderSpec[] = [];
    for (const o of toArray(orderBy as Row | Row[])) {
      if (!isPlainObject(o)) throw new ValidationError(`orderBy on '${model.name}' must be an object or array of objects`);
      for (const [key, v] of Object.entries(o)) {
        if (v === undefined) continue;
        const f = getField(model, key);
        if (!f) throw new ValidationError(`Unknown field '${key}' in orderBy of '${model.name}'`);
        if (f.kind === "relation") {
          items.push(...this.relationOrderSpecs(model, f, v, ctx, `${path}${key}.`));
          continue;
        }
        items.push({ field: path ? undefined : f, expr: (a) => `${a}.${quoteIdent(f.dbName)}`, ...sortSpec(v, `${path}${key}`) });
      }
    }
    return items;
  }

  private relationOrderSpecs(model: ModelDef, rel: RelationFieldDef, value: unknown, ctx: SqlContext, path: string): OrderSpec[] {
    const target = this.model(rel.model);
    if (!isPlainObject(value)) throw new ValidationError(`orderBy.${path.slice(0, -1)} must be an object`);
    if (rel.list) {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined);
      if (keys.length !== 1 || keys[0] !== "_count") throw new ValidationError(`orderBy.${path.slice(0, -1)} is a list relation; order it by { _count: 'asc' | 'desc' }`);
      const expr = (a: string) => {
        const ta = ctx.alias();
        return `(SELECT COUNT(*) FROM ${this.table(target)} ${ta} WHERE ${joinCondition(this, model, rel, a, ta)})`;
      };
      return [{ expr, ...sortSpec(value._count, `${path}_count`) }];
    }
    return this.orderSpecs(target, value, ctx, path).map((inner) => ({
      ...inner,
      field: undefined,
      expr: (a: string) => {
        const ta = ctx.alias();
        return `(SELECT ${inner.expr(ta)} FROM ${this.table(target)} ${ta} WHERE ${joinCondition(this, model, rel, a, ta)})`;
      },
    }));
  }

  /**
   * Builds `SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT` for one model.
   * Returns the SQL, its parameters and the selection.
   */
  buildSelect(model: ModelDef, args: Args, options: SelectOptions = {}): { sql: string; params: unknown[]; sel: Selection; reverse: boolean } {
    const ctx = new SqlContext();
    const alias = ctx.alias();
    const sel = this.resolveSelection(model, args, options);
    const paging = options.paging ?? true;

    const cols = sel.columns.map((f) => `${alias}.${quoteIdent(f.dbName)} AS ${quoteIdent(f.name)}`);
    for (const r of sel.counts) {
      const target = this.model(r.model);
      const ca = ctx.alias();
      cols.push(`(SELECT COUNT(*) FROM ${this.table(target)} ${ca} WHERE ${joinCondition(this, model, r, alias, ca)}) AS ${quoteIdent(`_count.${r.name}`)}`);
    }

    let take = args.take === undefined || !paging ? undefined : (args.take as number);
    if (take !== undefined && (typeof take !== "number" || !Number.isInteger(take))) throw new ValidationError(`'take' must be an integer`);
    const skip = args.skip === undefined || !paging ? undefined : nonNegativeInt(args.skip, "skip");
    const reverse = take !== undefined && take < 0;
    if (reverse) take = -take!;

    // distinct: one row per combination of these fields (plus the relation key when loading a relation).
    const distinct = this.distinctFields(model, args.distinct);
    if (distinct.length) for (const name of options.distinctScope ?? []) if (!distinct.some((d) => d.name === name)) distinct.push(this.column(model, name));

    let order = this.orderItems(model, args.orderBy, alias, ctx);
    const requestedOrder = [...order];
    // Nested relation loads page in memory per parent, but still need a deterministic order and the cursor condition.
    const pages = take !== undefined || skip !== undefined || args.cursor !== undefined || (!paging && (args.take !== undefined || args.skip !== undefined));
    const applyCursor = args.cursor !== undefined && (paging || options.nestedCursor !== undefined);
    const needsStableOrder = pages || applyCursor;
    // After `distinct` the distinct fields identify a row, so they make the order total; otherwise the primary key does.
    const tieBreakers = distinct.length ? distinct : (model.primaryKey?.fields ?? []).map((pk) => this.column(model, pk));
    if (needsStableOrder) {
      for (const f of tieBreakers) if (!order.some((o) => o.field?.name === f.name)) order.push(columnOrder(f, alias));
    }
    if (reverse) order = order.map(reverseItem);

    const conds: string[] = [];
    const where = buildWhere(this, model, args.where, alias, ctx);
    let from = `${this.table(model)} ${alias}`;
    let selectDistinct = false;
    if (distinct.length) {
      const names = new Set(distinct.map((d) => d.name));
      const plain = !sel.counts.length && sel.columns.every((c) => names.has(c.name)) && order.every((o) => o.field && names.has(o.field.name));
      if (plain) {
        // Every returned column is a distinct field: SELECT DISTINCT is enough.
        selectDistinct = true;
        if (where) conds.push(where);
      } else {
        // Keep the first row of each group in the requested order; the outer query reuses the alias,
        // so ORDER BY, cursor and _count expressions work unchanged on the numbered rows.
        const partition = distinct.map((d) => `${alias}.${quoteIdent(d.dbName)}`).join(", ");
        const windowOrder = requestedOrder.length ? requestedOrder : (model.primaryKey?.fields ?? []).map((pk) => columnOrder(this.column(model, pk), alias));
        const over = `PARTITION BY ${partition}${windowOrder.length ? ` ORDER BY ${orderSql(windowOrder)}` : ""}`;
        from = `(SELECT ${alias}.*, ROW_NUMBER() OVER (${over}) AS "__rn" FROM ${this.table(model)} ${alias}${where ? ` WHERE ${where}` : ""}) ${alias}`;
        conds.push(`${alias}."__rn" = 1`);
      }
    } else if (where) conds.push(where);
    if (applyCursor) {
      // A nested negative `take` keeps rows up to the cursor; the rows stay in the requested order for slicing.
      const cursorOrder = options.nestedCursor === "before" ? order.map(reverseItem) : order;
      conds.push(this.cursorCondition(model, args.cursor, cursorOrder, ctx));
    }

    let sql = `SELECT ${selectDistinct ? "DISTINCT " : ""}${cols.join(", ")} FROM ${from}`;
    if (conds.length) sql += ` WHERE ${conds.length === 1 ? conds[0] : conds.map((c) => `(${c})`).join(" AND ")}`;
    if (order.length) sql += ` ORDER BY ${orderSql(order)}`;
    if (take !== undefined || skip !== undefined) sql += ` LIMIT ${take ?? MAX_LIMIT}${skip ? ` OFFSET ${skip}` : ""}`;
    return { sql, params: ctx.params, sel, reverse };
  }

  /** Rows at or after the cursor row in the given ordering (lexicographic comparison). */
  private cursorCondition(model: ModelDef, cursor: unknown, order: OrderItem[], ctx: SqlContext): string {
    if (!isPlainObject(cursor)) throw new ValidationError(`'cursor' must be a unique where object`);
    this.assertUniqueWhere(model, cursor);
    if (!order.length) throw new ValidationError(`Cursor pagination on '${model.name}' needs an orderBy or a primary key`);
    // The order expression evaluated for the cursor row (also works for relation and _count orderings).
    const cursorValue = (o: OrderItem) => {
      const ca = ctx.alias();
      const w = buildWhere(this, model, cursor, ca, ctx);
      return `(SELECT ${o.expr(ca)} FROM ${this.table(model)} ${ca} WHERE ${w})`;
    };
    const ors: string[] = [];
    for (let i = 0; i <= order.length; i++) {
      const ands: string[] = [];
      for (let j = 0; j < Math.min(i, order.length); j++) ands.push(`${order[j]!.sql} = ${cursorValue(order[j]!)}`);
      if (i < order.length) ands.push(`${order[i]!.sql} ${order[i]!.desc ? "<" : ">"} ${cursorValue(order[i]!)}`);
      ors.push(ands.join(" AND "));
    }
    return ors.map((s) => `(${s})`).join(" OR ");
  }

  private decodeRow(model: ModelDef, sel: Selection, raw: Row): Row {
    const row: Row = {};
    for (const f of sel.columns) row[f.name] = decodeValue(this.contract, f, raw[f.name], this.decode);
    if (sel.counts.length) {
      const counts: Row = {};
      for (const r of sel.counts) counts[r.name] = Number(raw[`_count.${r.name}`] ?? 0);
      row._count = counts;
    }
    return row;
  }

  private async readMany(model: ModelDef, args: Args, q: Queryable, options: SelectOptions = {}): Promise<{ rows: Row[]; hidden: Set<string> }> {
    const top = Object.keys(options).length === 0;
    return this.execSelect(model, top ? this.cachedSelect(model, args) : this.buildSelect(model, args, options), args, q);
  }

  /** `buildSelect` through the plan cache (top-level reads only). */
  cachedSelect(model: ModelDef, args: Args): { sql: string; params: unknown[]; sel: Selection; reverse: boolean } {
    const cache = this.#plans;
    if (!cache.enabled) return this.buildSelect(model, args);
    const shape = planKey(model, args);
    if (!shape) {
      cache.uncacheable++;
      return this.buildSelect(model, args);
    }
    const where = (args.where ?? {}) as Row;
    const params = (fields: ColumnFieldDef[]) => fields.map((f) => encodeValue(this.contract, f, where[f.name]));
    const hit = cache.get(shape.key);
    if (hit) return { sql: hit.sql, params: params(hit.whereFields), sel: hit.sel, reverse: hit.reverse };
    const built = this.buildSelect(model, args);
    // cache only when the shape really yields the where values as its parameters, in order
    const extracted = params(shape.whereFields);
    if (sameParams(extracted, built.params)) cache.set(shape.key, { sql: built.sql, sel: built.sel, reverse: built.reverse, whereFields: shape.whereFields });
    else cache.uncacheable++;
    return built;
  }

  /** Plan cache counters (`$metrics`, benchmarks). */
  planCacheStats(): PlanCacheStats {
    return this.#plans.stats();
  }

  private async execSelect(
    model: ModelDef,
    built: { sql: string; params: unknown[]; sel: Selection; reverse: boolean },
    args: Args,
    q: Queryable,
  ): Promise<{ rows: Row[]; hidden: Set<string> }> {
    const raw = await q.query<Row>(built.sql, built.params);
    const rows = raw.map((r) => this.decodeRow(model, built.sel, r));
    if (built.reverse) rows.reverse();
    for (const rel of built.sel.relations) await this.loadRelation(model, rows, rel.field, rel.args, q);
    void args;
    return { rows, hidden: built.sel.hidden };
  }

  /** Loads a relation for many parent rows with batched `IN` queries (no N+1). */
  private async loadRelation(model: ModelDef, parents: Row[], rel: RelationFieldDef, args: Args, q: Queryable): Promise<void> {
    const target = this.model(rel.model);
    if (args.cursor !== undefined && !rel.list) throw new ValidationError(`'cursor' is only allowed on list relations ('${rel.name}')`);
    if (args.take !== undefined && (typeof args.take !== "number" || !Number.isInteger(args.take))) throw new ValidationError(`'take' must be an integer`);
    if (rel.through) return this.loadManyToMany(model, parents, rel, args, q);
    // The cursor condition is value based, so one batched query applies it to every parent; take/skip are applied per parent below.
    const nestedCursor = args.cursor === undefined ? undefined : (args.take as number) < 0 ? "before" : "after";
    const groups = new Map<string, unknown[]>();
    for (const p of parents) {
      const values = rel.localFields.map((f) => p[f]);
      const key = keyString(values);
      if (key !== null && !groups.has(key)) groups.set(key, values);
    }
    const byKey = new Map<string, Row[]>();
    let hidden = new Set<string>();
    const keys = [...groups.values()];
    const { take, skip, ...childArgs } = args;
    for (let i = 0; i < keys.length; i += IN_CHUNK) {
      const chunk = keys.slice(i, i + IN_CHUNK);
      const keyWhere =
        rel.targetFields.length === 1
          ? { [rel.targetFields[0]!]: { in: chunk.map((v) => v[0]) } }
          : { OR: chunk.map((v) => Object.fromEntries(rel.targetFields.map((f, j) => [f, v[j]]))) };
      const where = childArgs.where ? { AND: [childArgs.where, keyWhere] } : keyWhere;
      const res = await this.readMany(target, { ...childArgs, where }, q, { paging: false, extraColumns: rel.targetFields, distinctScope: rel.targetFields, nestedCursor });
      hidden = res.hidden;
      for (const row of res.rows) {
        const key = keyString(rel.targetFields.map((f) => row[f]))!;
        const list = byKey.get(key);
        if (list) list.push(row);
        else byKey.set(key, [row]);
      }
    }
    const from = skip === undefined ? 0 : nonNegativeInt(skip, "skip");
    for (const p of parents) {
      const key = keyString(rel.localFields.map((f) => p[f]));
      let children = key === null ? [] : (byKey.get(key) ?? []);
      if (rel.list) {
        if (take !== undefined) {
          const n = take as number;
          children = n >= 0 ? children.slice(from, from + n) : children.slice(Math.max(0, children.length - from + n), children.length - from);
        } else if (from) children = children.slice(from);
        p[rel.name] = strip(children, hidden);
      } else {
        p[rel.name] = children[0] ? strip([children[0]], hidden)[0] : null;
      }
    }
  }

  /**
   * Loads an implicit many-to-many relation. Per chunk of parents it reads the links from the
   * join table and the linked rows in one ordered query (filtered through the other side of
   * the relation), then hands each parent its rows in that order.
   */
  private async loadManyToMany(model: ModelDef, parents: Row[], rel: RelationFieldDef, args: Args, q: Queryable): Promise<void> {
    const target = this.model(rel.model);
    const t = rel.through!;
    if (args.distinct !== undefined) throw new ValidationError(`'distinct' is not supported when loading the many-to-many relation '${rel.name}'`);
    const ownKey = this.column(model, rel.localFields[0]!);
    const targetKey = this.column(target, rel.targetFields[0]!);
    const back = this.otherSide(model, rel);
    const nestedCursor = args.cursor === undefined ? undefined : (args.take as number) < 0 ? "before" : "after";

    const parentKeys = new Map<string, unknown>();
    for (const p of parents) {
      const key = keyString([p[ownKey.name]]);
      if (key !== null) parentKeys.set(key, p[ownKey.name]);
    }
    const byParent = new Map<string, Row[]>();
    let hidden = new Set<string>();
    const { take, skip, ...childArgs } = args;
    const ownValues = [...parentKeys.values()];
    for (let i = 0; i < ownValues.length; i += IN_CHUNK) {
      const chunk = ownValues.slice(i, i + IN_CHUNK);
      // target key -> parent keys linked to it
      const links = new Map<string, string[]>();
      const pairs = await q.query<Row>(
        `SELECT ${quoteIdent(t.localColumns[0]!)} AS "l", ${quoteIdent(t.targetColumns[0]!)} AS "t" FROM ${this.joinTable(rel)} WHERE ${quoteIdent(t.localColumns[0]!)} IN (${chunk.map(() => "?").join(", ")})`,
        chunk.map((v) => encodeValue(this.contract, ownKey, v)),
      );
      if (!pairs.length) continue;
      for (const r of pairs) {
        const tk = keyString([decodeValue(this.contract, targetKey, r.t)])!;
        const pk = keyString([decodeValue(this.contract, ownKey, r.l)])!;
        const list = links.get(tk);
        if (list) list.push(pk);
        else links.set(tk, [pk]);
      }
      const linked = { [back.name]: { some: { [ownKey.name]: { in: chunk } } } };
      const where = childArgs.where ? { AND: [childArgs.where, linked] } : linked;
      const res = await this.readMany(target, { ...childArgs, where }, q, { paging: false, extraColumns: [targetKey.name], nestedCursor });
      hidden = res.hidden;
      for (const row of res.rows) {
        for (const pk of links.get(keyString([row[targetKey.name]])!) ?? []) {
          // each parent gets its own copy: one row can be linked to several parents
          const list = byParent.get(pk);
          if (list) list.push({ ...row });
          else byParent.set(pk, [{ ...row }]);
        }
      }
    }
    const from = skip === undefined ? 0 : nonNegativeInt(skip, "skip");
    for (const p of parents) {
      const key = keyString([p[ownKey.name]]);
      let children = key === null ? [] : (byParent.get(key) ?? []);
      if (take !== undefined) {
        const n = take as number;
        children = n >= 0 ? children.slice(from, from + n) : children.slice(Math.max(0, children.length - from + n), children.length - from);
      } else if (from) children = children.slice(from);
      p[rel.name] = strip(children, hidden);
    }
  }

  /** The relation field on the target model that is the other side of `rel`. */
  private otherSide(model: ModelDef, rel: RelationFieldDef): RelationFieldDef {
    const target = this.model(rel.model);
    const other = target.fields.find(
      (f): f is RelationFieldDef =>
        f.kind === "relation" && f.relationName === rel.relationName && f.model === model.name && !(target === model && f.name === rel.name) && (rel.through ? f.through?.model === rel.through.model : !f.through),
    );
    if (!other) throw new ValidationError(`The other side of relation '${model.name}.${rel.name}' is not available`);
    return other;
  }

  async count(model: ModelDef, args: Args = {}, q: Queryable): Promise<number | Row> {
    const ctx = new SqlContext();
    const alias = ctx.alias();
    const select = args.select;
    const counts: string[] = [];
    const names: string[] = [];
    if (isPlainObject(select)) {
      for (const [k, v] of Object.entries(select)) {
        if (!v) continue;
        names.push(k);
        counts.push(k === "_all" ? `COUNT(*) AS ${quoteIdent(k)}` : `COUNT(${quoteIdent(this.column(model, k).dbName)}) AS ${quoteIdent(k)}`);
      }
    } else {
      names.push("_all");
      counts.push(`COUNT(*) AS "_all"`);
    }
    const paged = args.take !== undefined || args.skip !== undefined || args.cursor !== undefined;
    let sql: string;
    let params: unknown[];
    if (paged) {
      const inner = this.buildSelect(model, { where: args.where, orderBy: args.orderBy, take: args.take, skip: args.skip, cursor: args.cursor }, { allColumns: true });
      sql = `SELECT ${counts.join(", ")} FROM (${inner.sql}) ${alias}`;
      params = inner.params;
    } else {
      const where = buildWhere(this, model, args.where, alias, ctx);
      sql = `SELECT ${counts.join(", ")} FROM ${this.table(model)} ${alias}${where ? ` WHERE ${where}` : ""}`;
      params = ctx.params;
    }
    const [row] = await q.query<Row>(sql, params);
    if (!isPlainObject(select)) return Number(row?._all ?? 0);
    return Object.fromEntries(names.map((n) => [n, Number(row?.[n] ?? 0)]));
  }

  async aggregate(model: ModelDef, args: Args, q: Queryable): Promise<Row> {
    const { exprs, decode } = this.aggregateExprs(model, args, "a");
    if (!exprs.length) throw new ValidationError(`aggregate on '${model.name}' needs at least one of _count, _sum, _avg, _min, _max`);
    const inner = this.buildSelect(model, { where: args.where, orderBy: args.orderBy, take: args.take, skip: args.skip, cursor: args.cursor }, { allColumns: true });
    const sql = `SELECT ${exprs.join(", ")} FROM (${inner.sql}) "a"`;
    const [row] = await q.query<Row>(sql, inner.params);
    return decode(row ?? {});
  }

  async groupBy(model: ModelDef, args: Args, q: Queryable): Promise<Row[]> {
    const by = toArray(args.by as string | string[]);
    if (!by.length) throw new ValidationError(`groupBy on '${model.name}' needs 'by'`);
    const ctx = new SqlContext();
    const alias = ctx.alias();
    const byFields = by.map((b) => this.column(model, b));
    const { exprs, decode } = this.aggregateExprs(model, args, alias);
    const cols = [...byFields.map((f) => `${alias}.${quoteIdent(f.dbName)} AS ${quoteIdent(f.name)}`), ...exprs];
    const where = buildWhere(this, model, args.where, alias, ctx);
    const having = this.buildHaving(model, args.having, by, alias, ctx);
    const order = this.groupOrderItems(model, args.orderBy, by, alias, ctx);
    let sql = `SELECT ${cols.join(", ")} FROM ${this.table(model)} ${alias}${where ? ` WHERE ${where}` : ""} GROUP BY ${byFields.map((f) => `${alias}.${quoteIdent(f.dbName)}`).join(", ")}`;
    if (having) sql += ` HAVING ${having}`;
    if (order.length) sql += ` ORDER BY ${orderSql(order)}`;
    if (args.take !== undefined || args.skip !== undefined) sql += ` LIMIT ${args.take === undefined ? MAX_LIMIT : nonNegativeInt(args.take, "take")}${args.skip ? ` OFFSET ${nonNegativeInt(args.skip, "skip")}` : ""}`;
    const rows = await q.query<Row>(sql, ctx.params);
    return rows.map((r) => {
      const out: Row = {};
      for (const f of byFields) out[f.name] = decodeValue(this.contract, f, r[f.name], this.decode);
      return { ...out, ...decode(r) };
    });
  }

  /** ORDER BY of a groupBy: `by` fields and aggregates (`{ _count: { id: 'desc' } }`, `{ _sum: { total: 'asc' } }`, ...). */
  private groupOrderItems(model: ModelDef, orderBy: unknown, by: string[], alias: string, ctx: SqlContext): OrderItem[] {
    const items: OrderItem[] = [];
    for (const o of toArray(orderBy as Row | Row[])) {
      if (!isPlainObject(o)) throw new ValidationError(`orderBy on '${model.name}' must be an object or array of objects`);
      for (const [key, v] of Object.entries(o)) {
        if (v === undefined) continue;
        if (key === "_count" || key === "_sum" || key === "_avg" || key === "_min" || key === "_max") {
          if (!isPlainObject(v)) throw new ValidationError(`orderBy.${key} on '${model.name}' must be an object of fields`);
          for (const [name, dir] of Object.entries(v)) {
            if (dir === undefined) continue;
            let expr: string;
            if (key === "_count" && name === "_all") expr = "COUNT(*)";
            else {
              const f = this.column(model, name);
              if ((key === "_sum" || key === "_avg") && !isNumericField(f)) throw new ValidationError(`orderBy.${key} needs numeric fields; '${f.name}' is not numeric`);
              expr = `${key.slice(1).toUpperCase()}(${alias}.${quoteIdent(f.dbName)})`;
            }
            items.push({ expr: () => expr, sql: expr, ...sortSpec(dir, `${key}.${name}`) });
          }
          continue;
        }
        const f = this.column(model, key);
        if (!by.includes(f.name)) throw new ValidationError(`orderBy '${f.name}' must be one of the 'by' fields or an aggregate`);
        items.push(...this.orderItems(model, { [key]: v }, alias, ctx));
      }
    }
    return items;
  }

  /**
   * `HAVING` condition of a groupBy: filters on `by` fields plus aggregate filters
   * (`_count: { _all: { gt: 1 } }`, `_sum: { total: { gte: 10 } }`, ...), combined with AND/OR/NOT.
   */
  private buildHaving(model: ModelDef, having: unknown, by: string[], alias: string, ctx: SqlContext): string | null {
    if (having === undefined || having === null) return null;
    if (!isPlainObject(having)) throw new ValidationError(`'having' on '${model.name}' must be an object`);
    const parts: string[] = [];
    const nested = (v: unknown) => toArray(v as Row | Row[]).map((h) => this.buildHaving(model, h, by, alias, ctx));
    for (const [key, value] of Object.entries(having)) {
      if (value === undefined) continue;
      if (key === "AND" || key === "NOT") {
        const sub = nested(value).filter((s): s is string => s !== null);
        if (sub.length) parts.push(`${key === "NOT" ? "NOT " : ""}(${sub.map((s) => `(${s})`).join(" AND ")})`);
      } else if (key === "OR") {
        const sub = nested(value);
        parts.push(sub.length ? `(${sub.map((s) => `(${s ?? "1 = 1"})`).join(" OR ")})` : "1 = 0");
      } else if (key === "_count" || key === "_sum" || key === "_avg" || key === "_min" || key === "_max") {
        if (!isPlainObject(value)) throw new ValidationError(`having.${key} on '${model.name}' must be an object of field filters`);
        for (const [name, filter] of Object.entries(value)) {
          if (filter === undefined) continue;
          const cond = this.aggregateCondition(model, key, name, filter, alias, ctx);
          if (cond) parts.push(cond);
        }
      } else {
        const f = this.column(model, key);
        if (!by.includes(f.name)) throw new ValidationError(`having.${key} on '${model.name}' must be one of the 'by' fields or use an aggregate (_count, _sum, _avg, _min, _max)`);
        const cond = scalarCondition(this, f, `${alias}.${quoteIdent(f.dbName)}`, value, ctx);
        if (cond) parts.push(cond);
      }
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" AND ");
  }

  private aggregateCondition(model: ModelDef, op: "_count" | "_sum" | "_avg" | "_min" | "_max", name: string, filter: unknown, alias: string, ctx: SqlContext): string | null {
    const synthetic = (type: "Int" | "Float"): ColumnFieldDef => ({ kind: "scalar", name: `${op}.${name}`, dbName: "", type, optional: true, id: false, unique: false, updatedAt: false });
    if (op === "_count") {
      if (name === "_all") return scalarCondition(this, synthetic("Int"), "COUNT(*)", filter, ctx);
      const f = this.column(model, name);
      return scalarCondition(this, synthetic("Int"), `COUNT(${alias}.${quoteIdent(f.dbName)})`, filter, ctx);
    }
    const f = this.column(model, name);
    if ((op === "_sum" || op === "_avg") && !isNumericField(f)) throw new ValidationError(`having.${op} needs numeric fields; '${f.name}' is not numeric`);
    const expr = `${op.slice(1).toUpperCase()}(${alias}.${quoteIdent(f.dbName)})`;
    return scalarCondition(this, op === "_avg" ? synthetic("Float") : f, expr, filter, ctx);
  }

  private aggregateExprs(model: ModelDef, args: Args, alias: string): { exprs: string[]; decode: (r: Row) => Row } {
    const exprs: string[] = [];
    const decoders: ((r: Row, out: Row) => void)[] = [];
    // Inner selects alias columns by field name; groupBy reads the table directly.
    const col = (f: ColumnFieldDef) => (alias === "a" ? `"a".${quoteIdent(f.name)}` : `${alias}.${quoteIdent(f.dbName)}`);
    const c = args._count;
    if (c === true) {
      exprs.push(`COUNT(*) AS "_count._all"`);
      decoders.push((r, out) => (out._count = Number(r["_count._all"] ?? 0)));
    } else if (isPlainObject(c)) {
      const keys = Object.keys(c).filter((k) => c[k]);
      for (const k of keys) exprs.push(k === "_all" ? `COUNT(*) AS "_count._all"` : `COUNT(${col(this.column(model, k))}) AS ${quoteIdent(`_count.${k}`)}`);
      decoders.push((r, out) => (out._count = Object.fromEntries(keys.map((k) => [k, Number(r[`_count.${k}`] ?? 0)]))));
    }
    for (const op of ["_sum", "_avg", "_min", "_max"] as const) {
      const spec = args[op];
      if (spec === undefined) continue;
      if (!isPlainObject(spec)) throw new ValidationError(`${op} must be an object of fields`);
      const fields = Object.keys(spec).filter((k) => spec[k]).map((k) => this.column(model, k));
      const fn = op.slice(1).toUpperCase();
      for (const f of fields) {
        if ((op === "_sum" || op === "_avg") && !(f.kind === "scalar" && ["Int", "BigInt", "Float", "Decimal"].includes(f.type))) {
          throw new ValidationError(`${op} needs numeric fields; '${f.name}' is not numeric`);
        }
        exprs.push(`${fn}(${col(f)}) AS ${quoteIdent(`${op}.${f.name}`)}`);
      }
      decoders.push((r, out) => {
        out[op] = Object.fromEntries(
          fields.map((f) => {
            const v = r[`${op}.${f.name}`];
            if (v === null || v === undefined) return [f.name, null];
            if (op === "_avg") return [f.name, Number(v)];
            return [f.name, decodeValue(this.contract, f, v, this.decode)];
          }),
        );
      });
    }
    return {
      exprs,
      decode: (r) => {
        const out: Row = {};
        for (const d of decoders) d(r, out);
        return out;
      },
    };
  }

  // =====================================================================
  // Writes (callers run these inside a transaction)
  // =====================================================================

  /** Fields with a `sequence()` default that the row does not set. */
  private pendingSequences(model: ModelDef, values: Row): ColumnFieldDef[] {
    return columnFields(model).filter((f) => f.default?.kind === "sequence" && values[f.name] === undefined);
  }

  private sequenceRef(model: ModelDef, f: ColumnFieldDef): string {
    if (f.default?.kind !== "sequence") throw new Error(`'${f.name}' has no sequence default`);
    return tableRef({ dbName: f.default.name, schema: model.schema }, this.defaultSchema);
  }

  private nextval(model: ModelDef, f: ColumnFieldDef): string {
    return `${this.sequenceRef(model, f)}.NEXTVAL`;
  }

  /** Reads the values the last INSERT took from its sequences (CURRVAL is per session). */
  private async readSequences(model: ModelDef, seqFields: readonly ColumnFieldDef[], values: Row, q: Queryable): Promise<void> {
    for (const f of seqFields) {
      const [r] = await q.query<Row>(`SELECT ${this.sequenceRef(model, f)}.CURRVAL AS "v" FROM DUMMY`);
      values[f.name] = decodeValue(this.contract, f, r?.v);
    }
  }

  private assertWritable(model: ModelDef): void {
    if (model.kind === "view") throw new ValidationError(`'${model.name}' is a view and cannot be written`);
  }

  /** Values that identify one row: primary key, or the first unique whose values are all known. */
  identity(model: ModelDef, row: Row): Row {
    const candidates = [model.primaryKey?.fields, ...model.uniques.map((u) => u.fields)].filter((x): x is string[] => !!x);
    for (const fields of candidates) {
      if (fields.every((f) => row[f] !== undefined && row[f] !== null)) return Object.fromEntries(fields.map((f) => [f, row[f]]));
    }
    throw new ValidationError(`Cannot identify a '${model.name}' row: the model has no primary key or unique values; use updateMany/deleteMany`);
  }

  private identityFields(model: ModelDef): string[] {
    const fields = new Set<string>(model.primaryKey?.fields ?? []);
    for (const u of model.uniques) for (const f of u.fields) fields.add(f);
    return [...fields];
  }

  /** Finds one row by a where input and returns its identifying fields (plus `extra` fields). */
  private async locate(model: ModelDef, where: unknown, q: Queryable, extra: string[] = []): Promise<Row | null> {
    const fields = [...new Set([...this.identityFields(model), ...extra])];
    if (!fields.length) throw new ValidationError(`'${model.name}' has no primary key or unique fields`);
    return this.findFirst(model, { where, select: Object.fromEntries(fields.map((f) => [f, true])) }, q);
  }

  async create(model: ModelDef, args: Args, q: Queryable): Promise<Row> {
    if (!isPlainObject(args.data)) throw new ValidationError(`create on '${model.name}' needs 'data'`);
    const values = await this.insertRecord(model, args.data, q);
    return this.reread(model, values, args, q);
  }

  private async reread(model: ModelDef, values: Row, args: Args, q: Queryable): Promise<Row> {
    const where = this.identity(model, values);
    const row = await this.findFirst(model, { where, select: args.select, include: args.include, omit: args.omit }, q);
    if (!row) throw new NotFoundError(model.name, `The '${model.name}' record was written but could not be read back`);
    return row;
  }

  /** Default value computed in the client for a column, or undefined when the database supplies it. */
  private clientDefault(f: ColumnFieldDef): unknown {
    if (f.kind === "scalar" && f.updatedAt) return new Date();
    const d = f.default;
    if (!d) return undefined;
    switch (d.kind) {
      case "uuid":
        return randomUUID();
      case "cuid":
        return cuid();
      case "now":
        return new Date();
      case "value":
        return d.value;
      default:
        return undefined;
    }
  }

  async insertRecord(model: ModelDef, data: Row, q: Queryable): Promise<Row> {
    this.assertWritable(model);
    const values: Row = {};
    const backSide: [RelationFieldDef, Row][] = [];

    for (const [key, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = getField(model, key);
      if (!f) throw new ValidationError(`Unknown field '${key}' in data for '${model.name}'`);
      if (f.kind !== "relation") {
        values[key] = v;
        continue;
      }
      if (!isPlainObject(v)) throw new ValidationError(`Relation '${key}' in data for '${model.name}' needs create/connect/connectOrCreate`);
      if (f.owner) {
        const target = await this.resolveOwnerTarget(f, v, q);
        f.localFields.forEach((lf, i) => (values[lf] = target[f.targetFields[i]!]));
      } else backSide.push([f, v]);
    }

    const cols = columnFields(model);
    for (const f of cols) {
      if (values[f.name] !== undefined) continue;
      const d = this.clientDefault(f);
      if (d !== undefined) values[f.name] = d;
    }
    for (const f of cols) {
      const generated = f.default?.kind === "autoincrement" || f.default?.kind === "dbgenerated" || f.default?.kind === "sequence";
      if (values[f.name] === undefined && !f.optional && !generated) {
        throw new ValidationError(`Missing required field '${f.name}' in create of '${model.name}'`);
      }
    }

    const names = Object.keys(values);
    const fields = names.map((n) => this.column(model, n));
    const seqFields = this.pendingSequences(model, values);
    const colList = [...fields, ...seqFields].map((f) => quoteIdent(f.dbName)).join(", ");
    const marks = [...fields.map(() => "?"), ...seqFields.map((f) => this.nextval(model, f))].join(", ");
    await q.execute(`INSERT INTO ${this.table(model)} (${colList}) VALUES (${marks})`, fields.map((f) => encodeValue(this.contract, f, values[f.name])));
    await this.readSequences(model, seqFields, values, q);

    const identityCol = cols.find((f) => f.default?.kind === "autoincrement" && values[f.name] === undefined);
    if (identityCol) {
      const [r] = await q.query<Row>(`SELECT CURRENT_IDENTITY_VALUE() AS "id" FROM DUMMY`);
      values[identityCol.name] = decodeValue(this.contract, identityCol, r?.id);
    }

    for (const [rel, v] of backSide) await this.nestedBackSide(model, values, rel, v, q, "create");
    return values;
  }

  /** Resolves `create` / `connect` / `connectOrCreate` on the foreign-key side; returns the target row's key values. */
  private async resolveOwnerTarget(rel: RelationFieldDef, v: Row, q: Queryable): Promise<Row> {
    const target = this.model(rel.model);
    const ops = Object.keys(v).filter((k) => v[k] !== undefined);
    if (ops.length !== 1) throw new ValidationError(`Relation '${rel.name}' needs exactly one of create, connect, connectOrCreate`);
    const op = ops[0]!;
    if (op === "connect") {
      const row = await this.locate(target, v.connect, q, rel.targetFields);
      if (!row) throw new NotFoundError(target.name, `No '${target.name}' record found to connect to '${rel.name}'`);
      return row;
    }
    if (op === "create") return this.insertAndKey(target, v.create as Row, rel.targetFields, q);
    if (op === "connectOrCreate") {
      const spec = v.connectOrCreate as Row;
      const row = await this.locate(target, spec.where, q, rel.targetFields);
      return row ?? this.insertAndKey(target, spec.create as Row, rel.targetFields, q);
    }
    throw new ValidationError(`Unsupported operation '${op}' on relation '${rel.name}' in create`);
  }

  private async insertAndKey(model: ModelDef, data: Row, needed: string[], q: Queryable): Promise<Row> {
    const values = await this.insertRecord(model, data, q);
    if (needed.every((f) => values[f] !== undefined)) return values;
    const row = await this.locate(model, this.identity(model, values), q, needed);
    return row!;
  }

  /** Nested writes on the side without the foreign key (children of `parent`). */
  private async nestedBackSide(model: ModelDef, parent: Row, rel: RelationFieldDef, v: Row, q: Queryable, mode: "create" | "update"): Promise<void> {
    if (rel.through) return this.nestedManyToMany(model, parent, rel, v, q, mode);
    const target = this.model(rel.model);
    const fk: Row = Object.fromEntries(rel.targetFields.map((tf, i) => [tf, parent[rel.localFields[i]!]]));
    if (Object.values(fk).some((x) => x === undefined)) throw new ValidationError(`Cannot write '${rel.name}': parent key of '${model.name}' is unknown`);
    const fkWhere = fk;
    const nullFk = Object.fromEntries(rel.targetFields.map((tf) => [tf, null]));
    const childWhere = (w: unknown) => (w === undefined || w === true ? fkWhere : { AND: [w, fkWhere] });

    const order = ["set", "disconnect", "delete", "deleteMany", "update", "updateMany", "upsert", "create", "createMany", "connect", "connectOrCreate"];
    const ops = Object.keys(v).filter((k) => v[k] !== undefined);
    for (const op of ops) if (!order.includes(op)) throw new ValidationError(`Unknown nested operation '${op}' on '${rel.name}'`);
    if (mode === "create") for (const op of ops) if (!["create", "createMany", "connect", "connectOrCreate"].includes(op)) throw new ValidationError(`'${op}' is only allowed in update`);
    const requireList = (op: string) => {
      if (!rel.list) throw new ValidationError(`'${op}' is only allowed on list relations ('${rel.name}')`);
    };

    for (const op of order) {
      const val = v[op];
      if (val === undefined) continue;
      switch (op) {
        case "set":
          requireList(op);
          await this.updateManyRaw(target, fkWhere, nullFk, q);
          for (const w of toArray(val as Row | Row[])) await this.connectChild(target, w, fk, q, rel);
          break;
        case "disconnect":
          if (rel.list) for (const w of toArray(val as Row | Row[])) await this.updateManyRaw(target, childWhere(w), nullFk, q);
          else if (val === true) await this.updateManyRaw(target, fkWhere, nullFk, q);
          break;
        case "delete":
          if (rel.list) {
            for (const w of toArray(val as Row | Row[])) {
              const n = await this.deleteManyRaw(target, childWhere(w), q);
              if (!n) throw new NotFoundError(target.name, `No related '${target.name}' record found to delete in '${rel.name}'`);
            }
          } else if (val === true) await this.deleteManyRaw(target, fkWhere, q);
          break;
        case "deleteMany":
          requireList(op);
          for (const w of toArray(val as Row | Row[])) await this.deleteManyRaw(target, childWhere(w), q);
          break;
        case "update":
          if (rel.list) {
            for (const u of toArray(val as Row | Row[])) {
              const row = await this.locate(target, childWhere(u.where), q);
              if (!row) throw new NotFoundError(target.name, `No related '${target.name}' record found to update in '${rel.name}'`);
              await this.updateRecord(target, this.identity(target, row), u.data as Row, q);
            }
          } else {
            const row = await this.locate(target, fkWhere, q);
            if (!row) throw new NotFoundError(target.name, `No related '${target.name}' record to update in '${rel.name}'`);
            const data = isPlainObject(val) && "data" in val ? (val.data as Row) : (val as Row);
            await this.updateRecord(target, this.identity(target, row), data, q);
          }
          break;
        case "updateMany":
          requireList(op);
          for (const u of toArray(val as Row | Row[])) await this.updateManyRaw(target, childWhere(u.where), u.data as Row, q);
          break;
        case "upsert":
          for (const u of toArray(val as Row | Row[])) {
            const row = await this.locate(target, rel.list ? childWhere(u.where) : fkWhere, q);
            if (row) await this.updateRecord(target, this.identity(target, row), u.update as Row, q);
            else await this.insertRecord(target, { ...(u.create as Row), ...fk }, q);
          }
          break;
        case "create":
          if (!rel.list && Array.isArray(val)) throw new ValidationError(`'${rel.name}' is a single relation; create expects an object`);
          for (const d of toArray(val as Row | Row[])) await this.insertRecord(target, { ...d, ...fk }, q);
          break;
        case "createMany": {
          requireList(op);
          const spec = val as { data: Row | Row[]; skipDuplicates?: boolean };
          await this.createManyRaw(target, toArray(spec.data).map((d) => ({ ...d, ...fk })), q, spec.skipDuplicates === true);
          break;
        }
        case "connect":
          for (const w of toArray(val as Row | Row[])) await this.connectChild(target, w, fk, q, rel);
          break;
        case "connectOrCreate":
          for (const c of toArray(val as Row | Row[])) {
            const row = await this.locate(target, c.where, q);
            if (row) await this.updateRecord(target, this.identity(target, row), fk, q);
            else await this.insertRecord(target, { ...(c.create as Row), ...fk }, q);
          }
          break;
      }
    }
  }

  /** Nested writes on an implicit many-to-many relation: rows are linked through the join table. */
  private async nestedManyToMany(model: ModelDef, parent: Row, rel: RelationFieldDef, v: Row, q: Queryable, mode: "create" | "update"): Promise<void> {
    const target = this.model(rel.model);
    const t = rel.through!;
    const ownKey = this.column(model, rel.localFields[0]!);
    const targetKey = this.column(target, rel.targetFields[0]!);
    const ownValue = parent[ownKey.name];
    if (ownValue === undefined || ownValue === null) throw new ValidationError(`Cannot write '${rel.name}': parent key of '${model.name}' is unknown`);
    const join = this.joinTable(rel);
    const own = quoteIdent(t.localColumns[0]!);
    const other = quoteIdent(t.targetColumns[0]!);
    const ownParam = encodeValue(this.contract, ownKey, ownValue);
    const targetParam = (row: Row) => encodeValue(this.contract, targetKey, row[targetKey.name]);
    // rows of the target that are linked to this parent
    const linked = { [this.otherSide(model, rel).name]: { some: { [ownKey.name]: ownValue } } };
    const childWhere = (w: unknown) => (w === undefined || w === true ? linked : { AND: [w, linked] });
    const link = (row: Row) =>
      q.execute(`INSERT INTO ${join} (${own}, ${other}) SELECT ?, ? FROM DUMMY WHERE NOT EXISTS (SELECT 1 FROM ${join} WHERE ${own} = ? AND ${other} = ?)`, [
        ownParam,
        targetParam(row),
        ownParam,
        targetParam(row),
      ]);
    const unlink = (row: Row) => q.execute(`DELETE FROM ${join} WHERE ${own} = ? AND ${other} = ?`, [ownParam, targetParam(row)]);
    const keysOf = (where: unknown) => this.findMany(target, { where, select: { [targetKey.name]: true } }, q);
    const deleteTargets = async (rows: Row[]) => {
      for (let i = 0; i < rows.length; i += IN_CHUNK) {
        const chunk = rows.slice(i, i + IN_CHUNK);
        // remove the links first, so the delete does not depend on the foreign key's ON DELETE action
        await q.execute(`DELETE FROM ${join} WHERE ${other} IN (${chunk.map(() => "?").join(", ")})`, chunk.map(targetParam));
        await this.deleteManyRaw(target, { [targetKey.name]: { in: chunk.map((r) => r[targetKey.name]) } }, q);
      }
    };
    const find = async (where: unknown, what: string) => {
      const row = await this.locate(target, where, q);
      if (!row) throw new NotFoundError(target.name, `No '${target.name}' record found to ${what} in '${rel.name}'`);
      return row;
    };

    const order = ["set", "disconnect", "delete", "deleteMany", "update", "updateMany", "upsert", "create", "createMany", "connect", "connectOrCreate"];
    const ops = Object.keys(v).filter((k) => v[k] !== undefined);
    for (const op of ops) if (!order.includes(op)) throw new ValidationError(`Unknown nested operation '${op}' on '${rel.name}'`);
    if (mode === "create") for (const op of ops) if (!["create", "connect", "connectOrCreate"].includes(op)) throw new ValidationError(`'${op}' is only allowed in update`);

    for (const op of order) {
      const val = v[op];
      if (val === undefined) continue;
      switch (op) {
        case "set":
          await q.execute(`DELETE FROM ${join} WHERE ${own} = ?`, [ownParam]);
          for (const w of toArray(val as Row | Row[])) await link(await find(w, "connect"));
          break;
        case "disconnect":
          for (const w of toArray(val as Row | Row[])) {
            const row = await this.locate(target, w, q);
            if (row) await unlink(row);
          }
          break;
        case "delete":
          for (const w of toArray(val as Row | Row[])) await deleteTargets([await find(childWhere(w), "delete")]);
          break;
        case "deleteMany":
          for (const w of toArray(val as Row | Row[])) await deleteTargets(await keysOf(childWhere(w)));
          break;
        case "update":
          for (const u of toArray(val as Row | Row[])) {
            const row = await find(childWhere(u.where), "update");
            await this.updateRecord(target, this.identity(target, row), u.data as Row, q);
          }
          break;
        case "updateMany":
          for (const u of toArray(val as Row | Row[])) await this.updateManyRaw(target, childWhere(u.where), u.data as Row, q);
          break;
        case "upsert":
          for (const u of toArray(val as Row | Row[])) {
            const row = await this.locate(target, childWhere(u.where), q);
            if (row) await this.updateRecord(target, this.identity(target, row), u.update as Row, q);
            else await link(await this.insertRecord(target, u.create as Row, q));
          }
          break;
        case "create":
          for (const d of toArray(val as Row | Row[])) await link(await this.insertRecord(target, d, q));
          break;
        case "createMany":
          throw new ValidationError(`createMany is not available on the many-to-many relation '${rel.name}'; use create`);
        case "connect":
          for (const w of toArray(val as Row | Row[])) await link(await find(w, "connect"));
          break;
        case "connectOrCreate":
          for (const c of toArray(val as Row | Row[])) {
            const row = await this.locate(target, c.where, q);
            await link(row ?? (await this.insertRecord(target, c.create as Row, q)));
          }
          break;
      }
    }
  }

  private async connectChild(target: ModelDef, where: Row, fk: Row, q: Queryable, rel: RelationFieldDef): Promise<void> {
    const row = await this.locate(target, where, q);
    if (!row) throw new NotFoundError(target.name, `No '${target.name}' record found to connect to '${rel.name}'`);
    await this.updateRecord(target, this.identity(target, row), fk, q);
  }

  async update(model: ModelDef, args: Args, q: Queryable): Promise<Row> {
    if (!isPlainObject(args.where)) throw new ValidationError(`update on '${model.name}' needs 'where'`);
    if (!isPlainObject(args.data)) throw new ValidationError(`update on '${model.name}' needs 'data'`);
    this.assertUniqueWhere(model, args.where);
    const row = await this.locate(model, args.where, q);
    if (!row) throw new NotFoundError(model.name, `No '${model.name}' record found to update`);
    const key = await this.updateRecord(model, this.identity(model, row), args.data, q);
    return this.reread(model, key, args, q);
  }

  /** Applies `data` to the row identified by `key`; returns the (possibly changed) key. */
  async updateRecord(model: ModelDef, key: Row, data: Row, q: Queryable): Promise<Row> {
    this.assertWritable(model);
    const sets: { field: ColumnFieldDef; op: string; value: unknown }[] = [];
    const backSide: [RelationFieldDef, Row][] = [];
    let current: Row | null = null;
    const currentRow = async () => (current ??= await this.locate(model, key, q, model.fields.filter((f) => f.kind !== "relation").map((f) => f.name)));

    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = getField(model, k);
      if (!f) throw new ValidationError(`Unknown field '${k}' in data for '${model.name}'`);
      if (f.kind !== "relation") {
        sets.push(...this.scalarSets(f, v));
        continue;
      }
      if (!isPlainObject(v)) throw new ValidationError(`Relation '${k}' in update of '${model.name}' needs a nested operation`);
      if (!f.owner) {
        backSide.push([f, v]);
        continue;
      }
      const target = this.model(f.model);
      for (const [op, val] of Object.entries(v)) {
        if (val === undefined) continue;
        const setFk = (row: Row | null) => f.localFields.forEach((lf, i) => sets.push({ field: this.column(model, lf), op: "set", value: row ? row[f.targetFields[i]!] : null }));
        switch (op) {
          case "connect":
          case "create":
          case "connectOrCreate":
            setFk(await this.resolveOwnerTarget(f, { [op]: val }, q));
            break;
          case "disconnect":
            if (val !== true) break;
            if (!f.optional) throw new ValidationError(`Relation '${f.name}' is required and cannot be disconnected`);
            setFk(null);
            break;
          case "update":
          case "delete":
          case "upsert": {
            const cur = (await currentRow())!;
            const targetKey = Object.fromEntries(f.targetFields.map((tf, i) => [tf, cur[f.localFields[i]!]]));
            const hasTarget = Object.values(targetKey).every((x) => x !== null && x !== undefined);
            if (op === "update") {
              if (!hasTarget) throw new NotFoundError(target.name, `'${f.name}' is not connected; nothing to update`);
              const tRow = await this.locate(target, targetKey, q);
              const d = isPlainObject(val) && "data" in val ? (val.data as Row) : (val as Row);
              await this.updateRecord(target, this.identity(target, tRow!), d, q);
            } else if (op === "upsert") {
              const spec = val as Row;
              if (hasTarget) {
                const tRow = await this.locate(target, targetKey, q);
                await this.updateRecord(target, this.identity(target, tRow!), spec.update as Row, q);
              } else setFk(await this.insertAndKey(target, spec.create as Row, f.targetFields, q));
            } else if (val === true && hasTarget) {
              if (f.optional) {
                setFk(null);
                await this.flushSets(model, key, sets.splice(0), q);
              }
              await this.deleteManyRaw(target, targetKey, q);
            }
            break;
          }
          default:
            throw new ValidationError(`Unknown nested operation '${op}' on '${f.name}'`);
        }
      }
    }

    for (const f of columnFields(model)) {
      if (f.kind === "scalar" && f.updatedAt && !(f.name in data)) sets.push({ field: f, op: "set", value: new Date() });
    }

    const parentBefore = backSide.length ? { ...((await currentRow()) ?? key) } : key;
    await this.flushSets(model, key, sets, q);

    const newKey = { ...key };
    for (const s of sets) if (s.op === "set" && s.field.name in newKey) newKey[s.field.name] = s.value;
    const parentAfter = { ...parentBefore };
    for (const s of sets) if (s.op === "set") parentAfter[s.field.name] = s.value;
    for (const [rel, v] of backSide) await this.nestedBackSide(model, parentAfter, rel, v, q, "update");
    return newKey;
  }

  private scalarSets(f: ColumnFieldDef, v: unknown): { field: ColumnFieldDef; op: string; value: unknown }[] {
    if (isPlainObject(v) && !(f.kind === "scalar" && f.type === "Json")) {
      const out: { field: ColumnFieldDef; op: string; value: unknown }[] = [];
      for (const [op, val] of Object.entries(v)) {
        if (val === undefined) continue;
        if (!["set", "increment", "decrement", "multiply", "divide"].includes(op)) throw new ValidationError(`Unknown update operation '${op}' on '${f.name}'`);
        if (op !== "set" && !(f.kind === "scalar" && ["Int", "BigInt", "Float", "Decimal"].includes(f.type))) {
          throw new ValidationError(`'${op}' is only valid on numeric fields ('${f.name}')`);
        }
        out.push({ field: f, op, value: val });
      }
      return out;
    }
    return [{ field: f, op: "set", value: v }];
  }

  private async flushSets(model: ModelDef, key: Row, sets: { field: ColumnFieldDef; op: string; value: unknown }[], q: Queryable): Promise<number> {
    if (!sets.length) return 0;
    const ctx = new SqlContext();
    const assignments = sets.map((s) => this.assignment(s, ctx));
    const where = buildWhere(this, model, key, this.table(model), ctx);
    return q.execute(`UPDATE ${this.table(model)} SET ${assignments.join(", ")} WHERE ${where}`, ctx.params);
  }

  private assignment(s: { field: ColumnFieldDef; op: string; value: unknown }, ctx: SqlContext): string {
    const col = quoteIdent(s.field.dbName);
    const sym = { increment: "+", decrement: "-", multiply: "*", divide: "/" }[s.op as "increment"];
    const val = ctx.bind(encodeValue(this.contract, s.field, s.value));
    if (s.op === "set") return `${col} = ${val}`;
    return `${col} = ${col} ${sym} ${val}`;
  }

  async updateMany(model: ModelDef, args: Args, q: Queryable): Promise<{ count: number }> {
    if (!isPlainObject(args.data)) throw new ValidationError(`updateMany on '${model.name}' needs 'data'`);
    return { count: await this.updateManyRaw(model, args.where, args.data, q) };
  }

  private async updateManyRaw(model: ModelDef, where: unknown, data: Row, q: Queryable): Promise<number> {
    this.assertWritable(model);
    const sets: { field: ColumnFieldDef; op: string; value: unknown }[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = getField(model, k);
      if (!f) throw new ValidationError(`Unknown field '${k}' in data for '${model.name}'`);
      if (f.kind === "relation") throw new ValidationError(`updateMany cannot change relation '${k}'; set its foreign key fields instead`);
      sets.push(...this.scalarSets(f, v));
    }
    for (const f of columnFields(model)) if (f.kind === "scalar" && f.updatedAt && !(f.name in data)) sets.push({ field: f, op: "set", value: new Date() });
    if (!sets.length) return 0;
    const ctx = new SqlContext();
    const assignments = sets.map((s) => this.assignment(s, ctx));
    const cond = buildWhere(this, model, where, this.table(model), ctx);
    return q.execute(`UPDATE ${this.table(model)} SET ${assignments.join(", ")}${cond ? ` WHERE ${cond}` : ""}`, ctx.params);
  }

  async upsert(model: ModelDef, args: Args, q: Queryable): Promise<Row> {
    if (!isPlainObject(args.where)) throw new ValidationError(`upsert on '${model.name}' needs 'where'`);
    this.assertUniqueWhere(model, args.where);
    const row = await this.locate(model, args.where, q);
    if (row) {
      const key = await this.updateRecord(model, this.identity(model, row), (args.update as Row) ?? {}, q);
      return this.reread(model, key, args, q);
    }
    const values = await this.insertRecord(model, (args.create as Row) ?? {}, q);
    return this.reread(model, values, args, q);
  }

  async delete(model: ModelDef, args: Args, q: Queryable): Promise<Row> {
    if (!isPlainObject(args.where)) throw new ValidationError(`delete on '${model.name}' needs 'where'`);
    this.assertUniqueWhere(model, args.where);
    const row = await this.findFirst(model, { where: args.where, select: args.select, include: args.include, omit: args.omit }, q);
    const key = await this.locate(model, args.where, q);
    if (!row || !key) throw new NotFoundError(model.name, `No '${model.name}' record found to delete`);
    await this.deleteManyRaw(model, this.identity(model, key), q);
    return row;
  }

  async deleteMany(model: ModelDef, args: Args = {}, q: Queryable): Promise<{ count: number }> {
    return { count: await this.deleteManyRaw(model, args.where, q) };
  }

  private async deleteManyRaw(model: ModelDef, where: unknown, q: Queryable): Promise<number> {
    this.assertWritable(model);
    const ctx = new SqlContext();
    const cond = buildWhere(this, model, where, this.table(model), ctx);
    return q.execute(`DELETE FROM ${this.table(model)}${cond ? ` WHERE ${cond}` : ""}`, ctx.params);
  }

  async createMany(model: ModelDef, args: Args, q: Queryable): Promise<{ count: number }> {
    if (args.data === undefined) throw new ValidationError(`createMany on '${model.name}' needs 'data'`);
    return { count: await this.createManyRaw(model, toArray(args.data as Row | Row[]), q, args.skipDuplicates === true) };
  }

  /**
   * Inserts the rows and reads them back. With `skipDuplicates`, only the rows that were
   * inserted are returned. Rows come back in the order of `data`.
   */
  async createManyAndReturn(model: ModelDef, args: Args, q: Queryable): Promise<Row[]> {
    if (args.data === undefined) throw new ValidationError(`createManyAndReturn on '${model.name}' needs 'data'`);
    const skip = args.skipDuplicates === true;
    const keys: Row[] = [];
    for (const data of toArray(args.data as Row | Row[])) {
      const values = this.createManyValues(model, data, "createManyAndReturn");
      const fields = columnFields(model).filter((f) => values[f.name] !== undefined);
      const seqFields = this.pendingSequences(model, values);
      const insert = this.createManyInsert(model, fields, skip, seqFields);
      const inserted = await q.execute(insert.sql, insert.params(values));
      if (!inserted) continue;
      await this.readSequences(model, seqFields, values, q);
      const identityCol = columnFields(model).find((f) => f.default?.kind === "autoincrement" && values[f.name] === undefined);
      if (identityCol) {
        const [r] = await q.query<Row>(`SELECT CURRENT_IDENTITY_VALUE() AS "id" FROM DUMMY`);
        values[identityCol.name] = decodeValue(this.contract, identityCol, r?.id);
      }
      keys.push(this.identity(model, values));
    }
    if (!keys.length) return [];
    // Read back in chunks; the extra key fields are needed to restore the input order.
    const keyFields = Object.keys(keys[0]!);
    const hidden = new Set<string>();
    let select = args.select as Row | undefined;
    if (select) {
      select = { ...select };
      for (const f of keyFields) if (!select[f]) (select[f] = true), hidden.add(f);
    }
    let omit = args.omit as Row | undefined;
    if (omit) {
      omit = { ...omit };
      for (const f of keyFields) if (omit[f]) (delete omit[f], hidden.add(f));
    }
    const byKey = new Map<string, Row>();
    const keyOf = (r: Row) => JSON.stringify(keyFields.map((f) => normalizeKey(r[f])));
    for (let i = 0; i < keys.length; i += CREATE_MANY_READ_CHUNK) {
      const chunk = keys.slice(i, i + CREATE_MANY_READ_CHUNK);
      const rows = await this.findMany(model, { where: { OR: chunk }, select, include: args.include, omit }, q);
      for (const r of rows) byKey.set(keyOf(r), r);
    }
    const out: Row[] = [];
    for (const k of keys) {
      const row = byKey.get(keyOf(k));
      if (!row) throw new NotFoundError(model.name, `A '${model.name}' record was written but could not be read back`);
      out.push(row);
    }
    return strip(out, hidden);
  }

  private async createManyRaw(model: ModelDef, rows: Row[], q: Queryable, skipDuplicates = false): Promise<number> {
    let count = 0;
    for (const s of this.createManyStatements(model, rows, skipDuplicates)) count += await q.executeBatch(s.sql, s.params);
    return count;
  }

  /**
   * The statements createMany runs for `rows`, without running them: one INSERT per set of
   * fields the rows give, with the parameters of each row of that set (sent as one batch).
   */
  createManyStatements(model: ModelDef, rows: Row[], skipDuplicates = false): { sql: string; params: unknown[][] }[] {
    this.assertWritable(model);
    const cols = columnFields(model);
    const groups = new Map<string, { fields: ColumnFieldDef[]; rows: Row[] }>();
    for (const data of rows) {
      const values = this.createManyValues(model, data, "createMany");
      const fields = cols.filter((f) => values[f.name] !== undefined);
      const sig = fields.map((f) => f.name).join(",");
      const group = groups.get(sig) ?? { fields, rows: [] };
      group.rows.push(values);
      groups.set(sig, group);
    }
    return [...groups.values()].map((g) => {
      // rows of a group set the same fields, so they leave the same sequence fields to fill
      const insert = this.createManyInsert(model, g.fields, skipDuplicates, this.pendingSequences(model, g.rows[0]!));
      return { sql: insert.sql, params: g.rows.map(insert.params) };
    });
  }

  /** Validated column values of one createMany row, with client-side defaults applied. */
  private createManyValues(model: ModelDef, data: Row, op: string): Row {
    this.assertWritable(model);
    if (!isPlainObject(data)) throw new ValidationError(`${op} on '${model.name}' needs 'data' objects`);
    const values: Row = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = getField(model, k);
      if (!f) throw new ValidationError(`Unknown field '${k}' in data for '${model.name}'`);
      if (f.kind === "relation") throw new ValidationError(`${op} does not support relation '${k}'; set its foreign key fields`);
      values[k] = v;
    }
    for (const f of columnFields(model)) {
      if (values[f.name] === undefined) {
        const d = this.clientDefault(f);
        if (d !== undefined) values[f.name] = d;
      }
      const generated = f.default?.kind === "autoincrement" || f.default?.kind === "dbgenerated" || f.default?.kind === "sequence";
      if (values[f.name] === undefined && !f.optional && !generated) throw new ValidationError(`Missing required field '${f.name}' in ${op} of '${model.name}'`);
    }
    return values;
  }

  /**
   * INSERT statement for rows that set exactly `fields`. With `skipDuplicates` it becomes
   * `INSERT ... SELECT ... FROM DUMMY WHERE NOT EXISTS (...)` over the primary key and every
   * unique whose fields are all set, so a row that matches an existing row (or one inserted
   * earlier in the same batch) is skipped instead of failing.
   */
  private createManyInsert(
    model: ModelDef,
    fields: ColumnFieldDef[],
    skipDuplicates: boolean,
    seqFields: ColumnFieldDef[] = [],
  ): { sql: string; params: (values: Row) => unknown[] } {
    const table = this.table(model);
    const cols = [...fields, ...seqFields].map((f) => quoteIdent(f.dbName)).join(", ");
    const marks = [...fields.map(() => "?"), ...seqFields.map((f) => this.nextval(model, f))].join(", ");
    const encode = (values: Row) => fields.map((f) => encodeValue(this.contract, f, values[f.name]));
    const set = new Set(fields.map((f) => f.name));
    const keys = skipDuplicates
      ? [model.primaryKey?.fields, ...model.uniques.map((u) => u.fields)].filter((k): k is string[] => !!k?.length && k.every((f) => set.has(f)))
      : [];
    if (!keys.length) return { sql: `INSERT INTO ${table} (${cols}) VALUES (${marks})`, params: encode };
    const keyFields = keys.map((k) => k.map((name) => this.column(model, name)));
    const cond = keyFields.map((k) => `(${k.map((f) => `${quoteIdent(f.dbName)} = ?`).join(" AND ")})`).join(" OR ");
    return {
      sql: `INSERT INTO ${table} (${cols}) SELECT ${marks} FROM DUMMY WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${cond})`,
      params: (values) => [...encode(values), ...keyFields.flat().map((f) => encodeValue(this.contract, f, values[f.name]))],
    };
  }
}

/** Rows are read back in chunks of this many keys (one OR condition per key). */
const CREATE_MANY_READ_CHUNK = 500;

function normalizeKey(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return v;
}

function strip(rows: Row[], hidden: Set<string>): Row[] {
  if (!hidden.size) return rows;
  for (const r of rows) for (const h of hidden) delete r[h];
  return rows;
}

function sameParams(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (Buffer.isBuffer(x) && Buffer.isBuffer(y)) return x.equals(y);
    return Object.is(x, y);
  });
}
