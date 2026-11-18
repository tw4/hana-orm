/**
 * Typed raw SQL (issue #11). `hana-orm generate --sql` turns `sql/*.sql` into functions that
 * return a `TypedSql`; `db.$queryRawTyped(query)` runs it and decodes the rows by the column
 * types HANA reported when the statement was prepared.
 */

import { parseHanaDateTime } from "./codec.ts";

/** How a result column is decoded. */
export type SqlColumnKind = "int" | "bigint" | "decimal" | "float" | "string" | "boolean" | "date" | "timestamp" | "time" | "binary" | "unknown";

export interface TypedSql<R> {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly columns: Readonly<Record<string, SqlColumnKind>>;
  /** Type-only: the row type. */
  readonly __row?: R;
}

/** Used by generated code. */
export function typedSql<R>(sql: string, params: readonly unknown[], columns: Readonly<Record<string, SqlColumnKind>>): TypedSql<R> {
  return { sql, params, columns };
}

/** HANA type name (`NVARCHAR`, `DECIMAL`, `SECONDDATE`, …) → decoding kind. */
export function sqlColumnKind(typeName: string): SqlColumnKind {
  const t = typeName.toUpperCase().replace(/\(.*$/, "").trim();
  switch (t) {
    case "TINYINT":
    case "SMALLINT":
    case "INTEGER":
    case "INT":
      return "int";
    case "BIGINT":
      return "bigint";
    case "DECIMAL":
    case "SMALLDECIMAL":
    case "NUMERIC":
      return "decimal";
    case "REAL":
    case "DOUBLE":
    case "FLOAT":
      return "float";
    case "VARCHAR":
    case "NVARCHAR":
    case "CHAR":
    case "NCHAR":
    case "ALPHANUM":
    case "SHORTTEXT":
    case "CLOB":
    case "NCLOB":
    case "TEXT":
    case "STRING":
    case "NSTRING":
      return "string";
    case "BOOLEAN":
      return "boolean";
    case "DATE":
    case "DAYDATE":
      return "date";
    case "TIMESTAMP":
    case "SECONDDATE":
    case "LONGDATE":
      return "timestamp";
    case "TIME":
    case "SECONDTIME":
      return "time";
    case "VARBINARY":
    case "BINARY":
    case "BLOB":
      return "binary";
    default:
      return "unknown";
  }
}

/** TypeScript type of a result column of `kind`. */
export function sqlColumnTsType(kind: SqlColumnKind): string {
  switch (kind) {
    case "int":
    case "float":
      return "number";
    case "bigint":
      return "bigint";
    case "decimal":
    case "string":
    case "time":
      return "string";
    case "boolean":
      return "boolean";
    case "date":
    case "timestamp":
      return "Date";
    case "binary":
      return "Buffer";
    case "unknown":
      return "unknown";
  }
}

/** TypeScript type accepted for a parameter of `kind`. */
export function sqlParamTsType(kind: SqlColumnKind): string {
  switch (kind) {
    case "int":
    case "float":
      return "number";
    case "bigint":
      return "bigint | number";
    case "decimal":
      return "string | number";
    case "date":
    case "timestamp":
      return "Date | string";
    case "binary":
      return "Buffer | Uint8Array";
    default:
      return sqlColumnTsType(kind);
  }
}

function decodeValue(kind: SqlColumnKind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "int":
    case "float":
      return typeof v === "number" ? v : Number(v);
    case "bigint":
      return typeof v === "bigint" ? v : BigInt(v as string | number);
    case "decimal":
    case "time":
      return String(v);
    case "string":
      return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
    case "boolean":
      return v === true || v === 1 || v === "1" || v === "TRUE" || v === "true";
    case "date":
    case "timestamp":
      return v instanceof Date ? v : parseHanaDateTime(String(v));
    case "binary":
      return Buffer.isBuffer(v) ? v : Buffer.from(v as string);
    case "unknown":
      return v;
  }
}

/** Decodes one driver row by the statement's column kinds; unknown columns are kept as they are. */
export function decodeTypedRow(row: Record<string, unknown>, columns: Readonly<Record<string, SqlColumnKind>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = k in columns ? decodeValue(columns[k]!, v) : v;
  return out;
}

// ---- statement metadata ----------------------------------------------------------

/** What a driver reports for a prepared statement. */
export interface StatementDescription {
  columns: { name: string; typeName: string; nullable: boolean }[];
  params: { name?: string; typeName: string }[];
}

/** A driver that can describe a statement without running it (the built-in `HanaDriver`). */
export interface DescribingDriver {
  describe(sql: string): Promise<StatementDescription>;
}

/** SQLDBC type codes, for metadata that carries only the numeric `type`. */
const TYPE_CODES: Record<number, string> = {
  1: "TINYINT", 2: "SMALLINT", 3: "INTEGER", 4: "BIGINT", 5: "DECIMAL", 6: "REAL", 7: "DOUBLE",
  8: "CHAR", 9: "VARCHAR", 10: "NCHAR", 11: "NVARCHAR", 12: "BINARY", 13: "VARBINARY",
  14: "DATE", 15: "TIME", 16: "TIMESTAMP", 25: "CLOB", 26: "NCLOB", 27: "BLOB", 28: "BOOLEAN",
  29: "STRING", 30: "NSTRING", 51: "TEXT", 52: "SHORTTEXT", 61: "LONGDATE", 62: "SECONDDATE", 63: "DAYDATE", 64: "SECONDTIME",
};

/** Normalizes `@sap/hana-client` metadata (`getColumnInfo()` / `getParameterInfo()`). */
export function describeFromHanaMetadata(columnInfo: unknown, parameterInfo: unknown): StatementDescription {
  const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
  const typeName = (o: Record<string, unknown>): string => {
    const named = o.typeName ?? o.nativeTypeName ?? o.dataTypeName;
    if (typeof named === "string" && named) return named;
    const code = o.type ?? o.nativeType;
    return typeof code === "number" ? (TYPE_CODES[code] ?? "unknown") : "unknown";
  };
  return {
    columns: list(columnInfo).map((c) => ({
      name: String(c.columnName ?? c.name ?? ""),
      typeName: typeName(c),
      nullable: c.nullable === undefined ? true : c.nullable === true || c.nullable === 1,
    })),
    params: list(parameterInfo)
      // only input parameters (direction 1 = IN, 3 = IN OUT)
      .filter((p) => p.direction === undefined || p.direction === 1 || p.direction === 3)
      .map((p) => ({ ...(p.name ? { name: String(p.name) } : {}), typeName: typeName(p) })),
  };
}
