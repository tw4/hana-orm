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

const JSON_FILTER_KEYS = new Set([
  "path",
  "equals",
  "not",
  "lt",
  "lte",
  "gt",
  "gte",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "mode",
  "array_contains",
  "array_starts_with",
  "array_ends_with",
]);

const isJsonField = (field: ColumnFieldDef): boolean => field.kind === "scalar" && field.type === "Json";

function isFilterObject(field: ColumnFieldDef, value: unknown): value is AnyRecord {
  if (!isPlainObject(value)) return false;
  // a Json value may itself be an object: it is a filter only when every key is a filter key
  if (isJsonField(field)) return Object.keys(value).length > 0 && Object.keys(value).every((k) => JSON_FILTER_KEYS.has(k));
  return true;
}

export function scalarCondition(engine: Engine, field: ColumnFieldDef, col: string, filter: unknown, ctx: SqlContext): string | null {
  const enc = (v: unknown) => encodeValue(engine.contract, field, v);
  if (filter === null) return `${col} IS NULL`;
  if (isJsonField(field)) {
    if (isFilterObject(field, filter)) return jsonCondition(engine, field, col, filter, ctx);
    // HANA cannot compare an NCLOB with '='; compare the stored text
    return `TO_NVARCHAR(${col}) = ${ctx.bind(enc(filter))}`;
  }
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
      case "search": {
        if (field.kind !== "scalar" || field.type !== "String") throw new ValidationError(`'search' needs a String field; '${field.name}' is not one`);
        if (typeof v !== "string" || !v.trim()) throw new ValidationError(`'search' on field '${field.name}' expects a non-empty search string`);
        parts.push(`CONTAINS(${col}, ${ctx.bind(v)})`);
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

// ---- Json ------------------------------------------------------------------------

/**
 * JSON path literal for `JSON_VALUE` / `JSON_QUERY` (HANA takes the path only as a literal).
 * `["a", 0, "my key"]` → `$.a[0]."my key"`; a string must already be a path starting with `$`.
 */
export function jsonPath(path: unknown, fieldName: string): string {
  if (path === undefined) return "$";
  if (typeof path === "string") {
    if (!/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\."(?:[^"\\]|\\.)*")*$/.test(path)) {
      throw new ValidationError(`Invalid JSON path '${path}' on field '${fieldName}'; use e.g. "$.address.city", "$.tags[0]" or an array of keys`);
    }
    return path;
  }
  if (!Array.isArray(path)) throw new ValidationError(`'path' on field '${fieldName}' must be a string or an array of keys`);
  let out = "$";
  for (const seg of path) {
    if (typeof seg === "number" && Number.isInteger(seg) && seg >= 0) out += `[${seg}]`;
    else if (typeof seg === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) out += `.${seg}`;
    else if (typeof seg === "string") out += `."${seg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    else throw new ValidationError(`Invalid path segment ${JSON.stringify(seg)} on field '${fieldName}'`);
  }
  return out;
}

const sqlLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function isJsonScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** Regex source matching `value` as compact JSON text (`"a"`, `1`, `true`, `null`). */
export function jsonScalarRegex(v: string | number | boolean | null): string {
  return JSON.stringify(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonCondition(engine: Engine, field: ColumnFieldDef, col: string, filter: AnyRecord, ctx: SqlContext): string | null {
  const name = field.name;
  const path = sqlLiteral(jsonPath(filter.path, name));
  const value = `JSON_VALUE(${col}, ${path})`;
  const number = `JSON_VALUE(${col}, ${path} RETURNING DOUBLE)`;
  const query = `JSON_QUERY(${col}, ${path})`;
  const hasPath = filter.path !== undefined;
  const insensitive = filter.mode === "insensitive";
  const parts: string[] = [];

  /** `JSON_VALUE` comparison of a scalar; numbers compare as numbers, booleans as `true`/`false`. */
  const compare = (op: string, v: unknown, key: string): string => {
    if (v === null) {
      if (op !== "=") throw new ValidationError(`'${key}' on field '${name}' cannot compare with null`);
      return `${value} IS NULL`;
    }
    if (typeof v === "number" && Number.isFinite(v)) return `${number} ${op} ${ctx.bind(v)}`;
    if (typeof v === "string") return `${value} ${op} ${ctx.bind(v)}`;
    if (typeof v === "boolean" && op === "=") return `${value} = ${ctx.bind(v ? "true" : "false")}`;
    throw new ValidationError(`'${key}' on field '${name}' with a path compares a string, number${op === "=" ? ", boolean" : ""} or null, got ${JSON.stringify(v)}`);
  };
  const like = (pattern: string): string =>
    insensitive ? `LOWER(${value}) LIKE LOWER(${ctx.bind(pattern)}) ESCAPE '\\'` : `${value} LIKE ${ctx.bind(pattern)} ESCAPE '\\'`;
  const element = (v: unknown, key: string): string => {
    if (!isJsonScalar(v)) throw new ValidationError(`'${key}' on field '${name}' takes strings, numbers, booleans or null, got ${JSON.stringify(v)}`);
    return jsonScalarRegex(v);
  };

  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined || op === "path" || op === "mode") continue;
    switch (op) {
      case "equals":
      case "not": {
        let cond: string;
        if (!hasPath) {
          // the whole document, compared as the stored (compact) JSON text
          cond = v === null ? `${col} IS NULL` : `TO_NVARCHAR(${col}) = ${ctx.bind(encodeValue(engine.contract, field, v))}`;
        } else cond = compare("=", v, op);
        parts.push(op === "equals" ? cond : `NOT (${cond})`);
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        parts.push(compare({ lt: "<", lte: "<=", gt: ">", gte: ">=" }[op], v, op));
        break;
      case "string_contains":
      case "string_starts_with":
      case "string_ends_with": {
        if (typeof v !== "string") throw new ValidationError(`'${op}' on field '${name}' expects a string`);
        const e = escapeLike(v);
        parts.push(like(op === "string_contains" ? `%${e}%` : op === "string_starts_with" ? `${e}%` : `%${e}`));
        break;
      }
      case "array_contains": {
        const items = Array.isArray(v) ? v : [v];
        // JSON_QUERY returns the array text; it is NULL when the value there is a scalar
        parts.push(`${query} LIKE '[%'`);
        for (const item of items) parts.push(`${query} LIKE_REGEXPR ${ctx.bind(`^\\[(.*,)?\\s*${element(item, op)}\\s*(,.*)?\\]$`)} FLAG 's'`);
        break;
      }
      case "array_starts_with":
        parts.push(`${query} LIKE_REGEXPR ${ctx.bind(`^\\[\\s*${element(v, op)}\\s*[,\\]]`)} FLAG 's'`);
        break;
      case "array_ends_with":
        parts.push(`${query} LIKE_REGEXPR ${ctx.bind(`[\\[,]\\s*${element(v, op)}\\s*\\]$`)} FLAG 's'`);
        break;
      default:
        throw new ValidationError(`Unknown filter '${op}' on Json field '${name}'`);
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
