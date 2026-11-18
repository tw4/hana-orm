import { getField, type ColumnFieldDef, type ModelDef, type RelationFieldDef } from "../schema/contract.ts";
import { encodeValue } from "./codec.ts";
import type { Engine } from "./engine.ts";
import { ValidationError } from "./errors.ts";
import { escapeLike, quoteIdent } from "./sql.ts";
import { SQL } from "./builder/core.ts";

/** Collects bound parameters in the order their `?` placeholders appear in the SQL text. */
export class SqlContext {
  readonly params: unknown[] = [];
  private n = 0;
  alias(): string {
    return `t${this.n++}`;
  }
  bind(value: unknown): string {
    this.params.push(value);
    return "?";
  }
}

type AnyRecord = Record<string, unknown>;

export function isPlainObject(v: unknown): v is AnyRecord {
  if (v === null || typeof v !== "object") return false;
  if (v instanceof Date || v instanceof Uint8Array || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

const paren = (s: string) => `(${s})`;

/**
 * Renders an `sql` fragment inside an object-API query: columns of `model`'s table
 * (`tables.user.email`) become `alias."EMAIL"`, values are bound in order.
 */
function sqlFragment(engine: Engine, model: ModelDef, fragment: SQL<unknown>, alias: string, ctx: SqlContext): string {
  const key = model.name.charAt(0).toLowerCase() + model.name.slice(1);
  const text = fragment.render({ contract: engine.contract, defaultSchema: engine.defaultSchema, params: ctx.params, aliases: new Map([[key, alias]]) });
  return `(${text})`;
}

/** Builds a SQL condition for a `WhereInput`; returns null when it does not restrict anything. */
export function buildWhere(engine: Engine, model: ModelDef, where: unknown, alias: string, ctx: SqlContext): string | null {
  if (where === undefined || where === null) return null;
  if (where instanceof SQL) return sqlFragment(engine, model, where, alias, ctx);
  if (!isPlainObject(where)) throw new ValidationError(`'where' for model '${model.name}' must be an object`);
  const parts: string[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND") {
      const sub = toArray(value).map((w) => buildWhere(engine, model, w, alias, ctx)).filter((s): s is string => s !== null);
      if (sub.length) parts.push(sub.map(paren).join(" AND "));
      continue;
    }
    if (key === "OR") {
      const items = toArray(value);
      if (!items.length) parts.push("1 = 0");
      else parts.push(items.map((w) => paren(buildWhere(engine, model, w, alias, ctx) ?? "1 = 1")).join(" OR "));
      continue;
    }
    if (key === "NOT") {
      const sub = toArray(value).map((w) => buildWhere(engine, model, w, alias, ctx)).filter((s): s is string => s !== null);
      if (sub.length) parts.push(`NOT (${sub.map(paren).join(" AND ")})`);
      continue;
    }

    const field = getField(model, key);
    if (!field) {
      const compound = compoundKey(model, key);
      if (compound && isPlainObject(value)) {
        const sub = buildWhere(engine, model, Object.fromEntries(compound.map((f) => [f, value[f]])), alias, ctx);
        if (sub) parts.push(sub);
        continue;
      }
      throw new ValidationError(`Unknown field '${key}' in where of model '${model.name}'`);
    }
    if (field.kind === "relation") {
      parts.push(relationCondition(engine, model, field, value, alias, ctx));
    } else {
      const cond = scalarCondition(engine, field, `${alias}.${quoteIdent(field.dbName)}`, value, ctx);
      if (cond) parts.push(cond);
    }
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : parts.map(paren).join(" AND ");
}

/** Field names of a compound primary key or compound unique named `key` (e.g. `firstName_lastName`). */
export function compoundKey(model: ModelDef, key: string): string[] | undefined {
  if (model.primaryKey && model.primaryKey.fields.length > 1 && model.primaryKey.name === key) return model.primaryKey.fields;
  return model.uniques.find((u) => u.fields.length > 1 && u.name === key)?.fields;
}

const FILTER_KEYS = new Set(["equals", "not", "in", "notIn", "lt", "lte", "gt", "gte", "contains", "startsWith", "endsWith", "mode"]);

function isFilterObject(field: ColumnFieldDef, value: unknown): value is AnyRecord {
  if (!isPlainObject(value)) return false;
  if (field.kind === "scalar" && field.type === "Json") return Object.keys(value).every((k) => FILTER_KEYS.has(k));
  return true;
}

export function scalarCondition(engine: Engine, field: ColumnFieldDef, col: string, filter: unknown, ctx: SqlContext): string | null {
  const enc = (v: unknown) => encodeValue(engine.contract, field, v);
  if (filter === null) return `${col} IS NULL`;
  if (!isFilterObject(field, filter)) return `${col} = ${ctx.bind(enc(filter))}`;

  const insensitive = filter.mode === "insensitive";
  const lhs = insensitive ? `LOWER(${col})` : col;
  const rhs = (v: unknown) => (insensitive ? `LOWER(${ctx.bind(enc(v))})` : ctx.bind(enc(v)));
  const parts: string[] = [];

  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined || op === "mode") continue;
    switch (op) {
      case "equals":
        parts.push(v === null ? `${col} IS NULL` : `${lhs} = ${rhs(v)}`);
        break;
      case "not":
        if (v === null) parts.push(`${col} IS NOT NULL`);
        else if (isFilterObject(field, v)) {
          const inner = scalarCondition(engine, field, col, { ...v, ...(insensitive && v.mode === undefined ? { mode: "insensitive" } : {}) }, ctx);
          if (inner) parts.push(`NOT (${inner})`);
        } else parts.push(`${lhs} <> ${rhs(v)}`);
        break;
      case "in":
      case "notIn": {
        if (!Array.isArray(v)) throw new ValidationError(`'${op}' on field '${field.name}' expects an array`);
        const values = v.filter((x) => x !== null);
        if (!values.length) parts.push(op === "in" ? "1 = 0" : "1 = 1");
        else parts.push(`${lhs} ${op === "in" ? "IN" : "NOT IN"} (${values.map(rhs).join(", ")})`);
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const sym = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[op];
        parts.push(`${lhs} ${sym} ${rhs(v)}`);
        break;
      }
      case "contains":
      case "startsWith":
      case "endsWith": {
        if (typeof v !== "string") throw new ValidationError(`'${op}' on field '${field.name}' expects a string`);
        const pattern = op === "contains" ? `%${escapeLike(v)}%` : op === "startsWith" ? `${escapeLike(v)}%` : `%${escapeLike(v)}`;
        const bound = insensitive ? `LOWER(${ctx.bind(pattern)})` : ctx.bind(pattern);
        parts.push(`${lhs} LIKE ${bound} ESCAPE '\\'`);
        break;
      }
      default:
        throw new ValidationError(`Unknown filter '${op}' on field '${field.name}'`);
    }
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : parts.map(paren).join(" AND ");
}

/**
 * `alias.local = targetAlias.target` join condition for a relation. For an implicit
 * many-to-many relation it is an `EXISTS` over the join table.
 */
export function joinCondition(engine: Engine, model: ModelDef, rel: RelationFieldDef, alias: string, targetAlias: string): string {
  const target = engine.model(rel.model);
  if (rel.through) {
    const t = rel.through;
    const ja = `${targetAlias}j`;
    const own = rel.localFields.map((lf, i) => `${ja}.${quoteIdent(t.localColumns[i]!)} = ${alias}.${quoteIdent(engine.column(model, lf).dbName)}`);
    const other = rel.targetFields.map((tf, i) => `${ja}.${quoteIdent(t.targetColumns[i]!)} = ${targetAlias}.${quoteIdent(engine.column(target, tf).dbName)}`);
    return `EXISTS (SELECT 1 FROM ${engine.joinTable(rel)} ${ja} WHERE ${[...own, ...other].join(" AND ")})`;
  }
  return rel.localFields
    .map((lf, i) => {
      const l = engine.column(model, lf);
      const t = engine.column(target, rel.targetFields[i]!);
      return `${targetAlias}.${quoteIdent(t.dbName)} = ${alias}.${quoteIdent(l.dbName)}`;
    })
    .join(" AND ");
}

function relationCondition(engine: Engine, model: ModelDef, rel: RelationFieldDef, filter: unknown, alias: string, ctx: SqlContext): string {
  const target = engine.model(rel.model);
  const exists = (sub: unknown, negateSub = false): string => {
    const ta = ctx.alias();
    const join = joinCondition(engine, model, rel, alias, ta);
    const cond = buildWhere(engine, target, sub, ta, ctx);
    const extra = cond ? ` AND ${negateSub ? `NOT (${cond})` : `(${cond})`}` : negateSub ? " AND 1 = 0" : "";
    return `EXISTS (SELECT 1 FROM ${engine.table(target)} ${ta} WHERE ${join}${extra})`;
  };
  const isNull = (): string =>
    rel.owner ? rel.localFields.map((f) => `${alias}.${quoteIdent(engine.column(model, f).dbName)} IS NULL`).join(" AND ") : `NOT ${exists(undefined)}`;

  if (rel.list) {
    if (!isPlainObject(filter)) throw new ValidationError(`Filter on list relation '${rel.name}' must use some, every or none`);
    const parts: string[] = [];
    for (const [op, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      if (op === "some") parts.push(exists(v));
      else if (op === "none") parts.push(`NOT ${exists(v)}`);
      else if (op === "every") parts.push(`NOT ${exists(v, true)}`);
      else throw new ValidationError(`Unknown list relation filter '${op}' on '${rel.name}'; use some, every or none`);
    }
    return parts.length ? parts.map(paren).join(" AND ") : "1 = 1";
  }

  if (filter === null) return isNull();
  if (filter instanceof SQL) return exists(filter);
  if (!isPlainObject(filter)) throw new ValidationError(`Filter on relation '${rel.name}' must be an object or null`);
  const keys = Object.keys(filter);
  if (keys.length && keys.every((k) => k === "is" || k === "isNot")) {
    const parts: string[] = [];
    if (filter.is !== undefined) parts.push(filter.is === null ? isNull() : exists(filter.is));
    if (filter.isNot !== undefined) parts.push(filter.isNot === null ? `NOT (${isNull()})` : `NOT ${exists(filter.isNot)}`);
    return parts.map(paren).join(" AND ");
  }
  return exists(filter);
}
