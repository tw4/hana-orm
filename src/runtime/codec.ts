import type { ColumnFieldDef, Contract } from "../schema/contract.ts";
import { ValidationError } from "./errors.ts";

/**
 * Converts between JavaScript values and what `@sap/hana-client` expects/returns.
 * Verified driver behaviour: BIGINT and DECIMAL come back as strings, TIMESTAMP/SECONDDATE as
 * `YYYY-MM-DD HH:MM:SS[.fffffffff]` strings, DATE as `YYYY-MM-DD`, BOOLEAN as boolean,
 * binary as Buffer. JS `Date` parameters are sent as ISO strings, so dates are formatted here.
 * All DateTime values are treated as UTC.
 */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatTimestamp(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatTime(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function parseHanaDateTime(v: string): Date {
  if (/^\d{2}:\d{2}:\d{2}/.test(v)) return new Date(`1970-01-01T${v.slice(0, 8)}Z`);
  const [date, time = "00:00:00"] = v.split(" ");
  const [hms, frac = ""] = time.split(".");
  const ms = frac.padEnd(3, "0").slice(0, 3);
  return new Date(`${date}T${hms}.${ms}Z`);
}

function toDate(field: ColumnFieldDef, value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValidationError(`Invalid Date for field '${field.name}'`);
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new ValidationError(`Field '${field.name}' expects a Date, got ${describe(value)}`);
}

function describe(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/** JS value → driver parameter. `null`/`undefined` → null. */
export function encodeValue(contract: Contract, field: ColumnFieldDef, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field.kind === "enum") {
    const e = contract.enums[field.type]!;
    const v = e.values.find((x) => x.name === value);
    if (!v) throw new ValidationError(`Invalid value ${JSON.stringify(value)} for enum '${e.name}' (field '${field.name}')`);
    return v.dbName;
  }
  switch (field.type) {
    case "String":
      if (typeof value !== "string") throw new ValidationError(`Field '${field.name}' expects a string, got ${describe(value)}`);
      return value;
    case "Int":
      if (typeof value !== "number" || !Number.isInteger(value)) throw new ValidationError(`Field '${field.name}' expects an integer, got ${describe(value)}`);
      return value;
    case "Float":
      if (typeof value !== "number") throw new ValidationError(`Field '${field.name}' expects a number, got ${describe(value)}`);
      return value;
    case "BigInt":
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number" && Number.isInteger(value)) return String(value);
      if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
      throw new ValidationError(`Field '${field.name}' expects a bigint, got ${describe(value)}`);
    case "Decimal":
      if (typeof value === "number" || typeof value === "bigint") return String(value);
      if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
      if (typeof value === "object" && value && "toFixed" in value) return String(value);
      throw new ValidationError(`Field '${field.name}' expects a decimal (string or number), got ${describe(value)}`);
    case "Boolean":
      if (typeof value !== "boolean") throw new ValidationError(`Field '${field.name}' expects a boolean, got ${describe(value)}`);
      return value;
    case "DateTime": {
      const d = toDate(field, value);
      const native = field.nativeType?.name;
      if (native === "Date") return formatDate(d);
      if (native === "Time") return formatTime(d);
      return formatTimestamp(d);
    }
    case "Bytes":
      if (value instanceof Uint8Array) return Buffer.from(value);
      throw new ValidationError(`Field '${field.name}' expects a Buffer/Uint8Array, got ${describe(value)}`);
    case "Json":
      return JSON.stringify(value);
  }
}

/** Driver value → JS value. */
export function decodeValue(contract: Contract, field: ColumnFieldDef, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field.kind === "enum") {
    const e = contract.enums[field.type]!;
    return e.values.find((x) => x.dbName === value)?.name ?? value;
  }
  switch (field.type) {
    case "Int":
    case "Float":
      return typeof value === "number" ? value : Number(value);
    case "BigInt":
      return typeof value === "bigint" ? value : BigInt(value as string | number);
    case "Decimal":
      return String(value);
    case "Boolean":
      return value === true || value === 1 || value === "1" || value === "TRUE" || value === "true";
    case "DateTime":
      if (value instanceof Date) return value;
      return parseHanaDateTime(String(value));
    case "Bytes":
      return Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    case "Json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "String":
      return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  }
}
