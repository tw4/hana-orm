/**
 * HANA column types: normalization, contract-type → DDL mapping, defaults and
 * narrowing detection.
 *
 * Default DDL types when a field has no `@db.*` native type:
 *
 * | Contract type | HANA type          |
 * | ------------- | ------------------ |
 * | String        | NVARCHAR(5000)     |
 * | Int           | INTEGER            |
 * | BigInt        | BIGINT             |
 * | Float         | DOUBLE             |
 * | Decimal       | DECIMAL(38,10)     |
 * | Boolean       | BOOLEAN            |
 * | DateTime      | TIMESTAMP          |
 * | Bytes         | BLOB               |
 * | Json          | NCLOB              |
 * | enum          | NVARCHAR(255)      |
 *
 * `DECIMAL(38,10)` is HANA's maximum precision with ten fractional digits: wide enough for
 * money and measurements while staying a fixed-point type (a bare `DECIMAL` in HANA is a
 * floating decimal, which compares and rounds differently).
 */

import type { DefaultDef, EnumDef, ScalarType } from "../schema/contract.ts";

export const DEFAULT_SCALAR_TYPES: Record<ScalarType, string> = {
  String: "NVARCHAR(5000)",
  Int: "INTEGER",
  BigInt: "BIGINT",
  Float: "DOUBLE",
  Decimal: "DECIMAL(38,10)",
  Boolean: "BOOLEAN",
  DateTime: "TIMESTAMP",
  Bytes: "BLOB",
  Json: "NCLOB",
};

export const DEFAULT_ENUM_TYPE = "NVARCHAR(255)";

const ALIASES: Record<string, string> = {
  INT: "INTEGER",
  DEC: "DECIMAL",
  NUMERIC: "DECIMAL",
  "DOUBLE PRECISION": "DOUBLE",
  FLOAT: "DOUBLE",
  SHORTTEXT: "NVARCHAR",
  CHARACTER: "CHAR",
  BOOL: "BOOLEAN",
};

/** Types that carry a length argument. */
const LENGTH_TYPES = new Set(["NVARCHAR", "VARCHAR", "NCHAR", "CHAR", "ALPHANUM", "VARBINARY", "BINARY"]);

/**
 * Normalizes a HANA type: upper case, canonical name, canonical arguments.
 * `nvarchar( 255 )` → `NVARCHAR(255)`, `DECIMAL(15)` → `DECIMAL(15,0)`, `INT` → `INTEGER`.
 */
export function normalizeType(type: string): string {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_ ]*?)\s*(?:\(\s*([^)]*)\))?\s*$/.exec(type);
  if (!m) return type.trim().toUpperCase();
  let name = m[1]!.toUpperCase().replace(/\s+/g, " ");
  name = ALIASES[name] ?? name;
  const args = m[2] !== undefined && m[2].trim() !== "" ? m[2].split(",").map((x) => Number(x.trim())) : [];
  return formatType(name, args);
}

export function formatType(name: string, args: readonly number[]): string {
  if (name === "DECIMAL") {
    if (args.length === 0) return "DECIMAL";
    return `DECIMAL(${args[0]},${args[1] ?? 0})`;
  }
  if (LENGTH_TYPES.has(name)) return args.length ? `${name}(${args[0]})` : name;
  if (name === "DOUBLE" || name === "REAL") return name;
  return args.length ? `${name}(${args.join(",")})` : name;
}

export interface ParsedType {
  name: string;
  args: number[];
}

export function parseType(type: string): ParsedType {
  const n = normalizeType(type);
  const m = /^([A-Z_][A-Z0-9_ ]*?)(?:\(([^)]*)\))?$/.exec(n);
  if (!m) return { name: n, args: [] };
  return { name: m[1]!, args: m[2] ? m[2].split(",").map(Number) : [] };
}

/** DDL type for a `@db.X(args)` native type, e.g. `NVarChar(255)` → `NVARCHAR(255)`. */
export function nativeTypeToDdl(name: string, args: readonly number[]): string {
  return normalizeType(args.length ? `${name}(${args.join(",")})` : name);
}

// ---- type families and narrowing ----------------------------------------------

const INT_RANK: Record<string, number> = { TINYINT: 1, SMALLINT: 2, INTEGER: 3, BIGINT: 4 };
const STRING_RANK: Record<string, number> = { CHAR: 1, VARCHAR: 2, NCHAR: 3, NVARCHAR: 4, ALPHANUM: 2 };
const LOB_TYPES = new Set(["NCLOB", "CLOB", "BLOB", "TEXT", "BINTEXT"]);

export type TypeChange = "same" | "widening" | "narrowing" | "incompatible";

/**
 * Classifies a type change. `narrowing` and `incompatible` changes can fail or lose data and
 * are treated as destructive.
 */
export function classifyTypeChange(fromType: string, toType: string): TypeChange {
  const a = parseType(fromType);
  const b = parseType(toType);
  if (normalizeType(fromType) === normalizeType(toType)) return "same";
  if (a.name in INT_RANK && b.name in INT_RANK) return INT_RANK[b.name]! >= INT_RANK[a.name]! ? "widening" : "narrowing";
  if (a.name in INT_RANK && b.name === "DECIMAL") {
    const digits = { TINYINT: 3, SMALLINT: 5, INTEGER: 10, BIGINT: 19 }[a.name]!;
    if (b.args.length === 0) return "widening";
    return b.args[0]! - (b.args[1] ?? 0) >= digits ? "widening" : "narrowing";
  }
  if (a.name in STRING_RANK && b.name in STRING_RANK) {
    const rankOk = STRING_RANK[b.name]! >= STRING_RANK[a.name]!;
    const lenOk = (b.args[0] ?? 1) >= (a.args[0] ?? 1);
    return rankOk && lenOk ? "widening" : "narrowing";
  }
  if ((a.name === "VARBINARY" || a.name === "BINARY") && (b.name === "VARBINARY" || b.name === "BINARY")) {
    return (b.args[0] ?? 1) >= (a.args[0] ?? 1) ? "widening" : "narrowing";
  }
  if (a.name === "DECIMAL" && b.name === "DECIMAL") {
    if (b.args.length === 0) return "widening";
    if (a.args.length === 0) return "narrowing";
    const [ap, as] = [a.args[0]!, a.args[1] ?? 0];
    const [bp, bs] = [b.args[0]!, b.args[1] ?? 0];
    return bs >= as && bp - bs >= ap - as ? "widening" : "narrowing";
  }
  if (a.name === "REAL" && b.name === "DOUBLE") return "widening";
  if (a.name === "DOUBLE" && b.name === "REAL") return "narrowing";
  if (a.name === "DATE" && (b.name === "TIMESTAMP" || b.name === "SECONDDATE")) return "widening";
  if (a.name === "SECONDDATE" && b.name === "TIMESTAMP") return "widening";
  if (a.name === "TIMESTAMP" && (b.name === "SECONDDATE" || b.name === "DATE")) return "narrowing";
  if (a.name === "SECONDDATE" && b.name === "DATE") return "narrowing";
  if (a.name === "NCLOB" && b.name === "NCLOB") return "same";
  return "incompatible";
}

export function isStringType(type: string): boolean {
  const n = parseType(type).name;
  return n in STRING_RANK || n === "NCLOB" || n === "CLOB" || n === "TEXT" || n === "SHORTTEXT";
}

export function isNumericType(type: string): boolean {
  const n = parseType(type).name;
  return n in INT_RANK || n === "DECIMAL" || n === "SMALLDECIMAL" || n === "DOUBLE" || n === "REAL";
}

export function isLobType(type: string): boolean {
  return LOB_TYPES.has(parseType(type).name);
}

// ---- defaults -----------------------------------------------------------------

/** Quotes a string as a SQL literal: `'it''s'`. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const SQL_FUNCTION_DEFAULTS = new Set([
  "CURRENT_TIMESTAMP",
  "CURRENT_UTCTIMESTAMP",
  "CURRENT_DATE",
  "CURRENT_UTCDATE",
  "CURRENT_TIME",
  "CURRENT_UTCTIME",
  "CURRENT_USER",
  "CURRENT_SCHEMA",
  "NULL",
]);

function canonicalNumber(raw: string): string {
  const s = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return s;
  if (/^[+-]?\d+$/.test(s)) return BigInt(s).toString();
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

/**
 * SQL default for a contract default; `undefined` when the database has no default
 * (`autoincrement()` is an identity column, `uuid()`/`cuid()` are generated by the runtime).
 */
export function contractDefaultToSql(def: DefaultDef | undefined, columnType: string, enumDef?: EnumDef): string | undefined {
  if (!def) return undefined;
  switch (def.kind) {
    case "autoincrement":
    case "uuid":
    case "cuid":
      return undefined;
    case "now":
      return "CURRENT_UTCTIMESTAMP";
    case "dbgenerated":
      return def.sql.trim();
    case "value": {
      const v = def.value;
      if (enumDef && typeof v === "string") {
        const ev = enumDef.values.find((x) => x.name === v);
        return sqlString(ev ? ev.dbName : v);
      }
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      if (typeof v === "number") return canonicalNumber(String(v));
      if (isNumericType(columnType)) return canonicalNumber(v);
      return sqlString(v);
    }
  }
}

/**
 * Normalizes a `DEFAULT_VALUE` from `SYS.TABLE_COLUMNS`. HANA stores literal defaults
 * without quotes (`abc`, `1`, `0.0`) and expressions as written (`CURRENT_UTCTIMESTAMP`).
 */
export function catalogDefaultToSql(raw: string | null | undefined, columnType: string): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const t = parseType(columnType).name;
  const upper = raw.trim().toUpperCase();
  if (SQL_FUNCTION_DEFAULTS.has(upper)) return upper === "NULL" ? undefined : upper;
  if (t === "BOOLEAN") {
    if (upper === "1" || upper === "TRUE") return "TRUE";
    if (upper === "0" || upper === "FALSE") return "FALSE";
    return raw.trim();
  }
  if (isNumericType(columnType)) return canonicalNumber(raw);
  if (t === "VARBINARY" || t === "BINARY") return raw.trim();
  if (/^'.*'$/s.test(raw)) return raw; // already a literal
  return sqlString(raw);
}

/** Canonical form of a default for comparison. */
export function normalizeDefaultSql(sql: string | undefined): string | undefined {
  if (sql === undefined) return undefined;
  const t = sql.trim();
  if (/^'.*'$/s.test(t)) return t;
  if (/^[+-]?[\d.]+([eE][+-]?\d+)?$/.test(t)) return canonicalNumber(t);
  return t.replace(/\s+/g, " ");
}
