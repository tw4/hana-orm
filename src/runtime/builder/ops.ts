/** Operators of the query builder. Values are bound, encoded with the column's codec. */

import type { Contract } from "../../schema/contract.ts";
import { decodeValue } from "../codec.ts";
import { ValidationError } from "../errors.ts";
import { Column, Param, SQL, type Renderable } from "./core.ts";

/** A column or SQL expression of type `T`. */
export type Expr<T> = Column<T, string> | SQL<T>;

/** The right side of a comparison: a value of the column's type, another column or an expression. */
export type Operand<T> = NonNullable<T> | Column<T, string> | Column<T | null, string> | SQL<T> | SQL<unknown>;

const operand = (left: Expr<unknown>, v: unknown): Renderable =>
  v instanceof Column || v instanceof SQL || (typeof v === "object" && v !== null && typeof (v as Renderable).render === "function")
    ? (v as Renderable)
    : new Param(v, left instanceof Column ? left.field : undefined);

const cmp = (op: string) => <T>(left: Expr<T>, right: Operand<T>): SQL<boolean> => {
  if (right === null || right === undefined) throw new ValidationError(`Compare with null using isNull() / isNotNull()`);
  return new SQL<boolean>([left, ` ${op} `, operand(left, right)]);
};

export const eq = cmp("=");
export const ne = cmp("<>");
export const gt = cmp(">");
export const gte = cmp(">=");
export const lt = cmp("<");
export const lte = cmp("<=");

export function like(left: Expr<string | null>, pattern: string | SQL<unknown>): SQL<boolean> {
  return new SQL<boolean>([left, " LIKE ", operand(left, pattern)]);
}
export function notLike(left: Expr<string | null>, pattern: string | SQL<unknown>): SQL<boolean> {
  return new SQL<boolean>([left, " NOT LIKE ", operand(left, pattern)]);
}
/** Case-insensitive LIKE: `LOWER(x) LIKE LOWER(?)`. */
export function ilike(left: Expr<string | null>, pattern: string | SQL<unknown>): SQL<boolean> {
  return new SQL<boolean>(["LOWER(", left, ") LIKE LOWER(", operand(left, pattern), ")"]);
}

/** A subquery usable as a set: `inArray(users.id, db.select({ id: posts.authorId }).from(posts))`. */
export interface SubqueryLike extends Renderable {
  readonly _subquery: true;
}

function inList<T>(left: Expr<T>, values: readonly NonNullable<T>[] | SubqueryLike, negate: boolean): SQL<boolean> {
  const op = negate ? " NOT IN " : " IN ";
  if (!Array.isArray(values)) return new SQL<boolean>([left, op, "(", values as SubqueryLike, ")"]);
  // an empty list matches nothing (IN) or everything (NOT IN), as in the object API
  if (!values.length) return new SQL<boolean>([negate ? "1 = 1" : "1 = 0"]);
  const chunks: (string | Renderable)[] = [left, `${op}(`];
  values.forEach((v, i) => {
    if (i) chunks.push(", ");
    chunks.push(operand(left, v));
  });
  chunks.push(")");
  return new SQL<boolean>(chunks);
}
export const inArray = <T>(left: Expr<T>, values: readonly NonNullable<T>[] | SubqueryLike): SQL<boolean> => inList(left, values, false);
export const notInArray = <T>(left: Expr<T>, values: readonly NonNullable<T>[] | SubqueryLike): SQL<boolean> => inList(left, values, true);

export const isNull = (e: Expr<unknown>): SQL<boolean> => new SQL<boolean>([e, " IS NULL"]);
export const isNotNull = (e: Expr<unknown>): SQL<boolean> => new SQL<boolean>([e, " IS NOT NULL"]);

export function between<T>(e: Expr<T>, low: Operand<T>, high: Operand<T>): SQL<boolean> {
  return new SQL<boolean>([e, " BETWEEN ", operand(e, low), " AND ", operand(e, high)]);
}

function combine(op: " AND " | " OR ", conds: readonly (SQL<unknown> | undefined)[]): SQL<boolean> | undefined {
  const list = conds.filter((c): c is SQL<unknown> => c !== undefined);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0] as SQL<boolean>;
  const chunks: (string | Renderable)[] = [];
  list.forEach((c, i) => {
    if (i) chunks.push(op);
    chunks.push("(", c, ")");
  });
  return new SQL<boolean>(chunks);
}
/** `undefined` conditions are skipped, so optional filters can be passed directly. */
export const and = (...conds: (SQL<unknown> | undefined)[]): SQL<boolean> | undefined => combine(" AND ", conds);
export const or = (...conds: (SQL<unknown> | undefined)[]): SQL<boolean> | undefined => combine(" OR ", conds);
export const not = (cond: SQL<unknown>): SQL<boolean> => new SQL<boolean>(["NOT (", cond, ")"]);

export const exists = (sub: SubqueryLike): SQL<boolean> => new SQL<boolean>(["EXISTS (", sub, ")"]);
export const notExists = (sub: SubqueryLike): SQL<boolean> => new SQL<boolean>(["NOT EXISTS (", sub, ")"]);

// ---- ordering ----------------------------------------------------------------------------

export const asc = (e: Expr<unknown>): SQL<unknown> => new SQL([e, " ASC"]);
export const desc = (e: Expr<unknown>): SQL<unknown> => new SQL([e, " DESC"]);

// ---- aggregates --------------------------------------------------------------------------

const toNumber = (raw: unknown): number => Number(raw ?? 0);
const toNullableNumber = (raw: unknown): number | null => (raw === null || raw === undefined ? null : Number(raw));
const asColumn = (e: Expr<unknown>) =>
  e instanceof Column && e.field ? (raw: unknown, contract: Contract) => (raw === null || raw === undefined ? null : decodeValue(contract, e.field!, raw)) : undefined;

export const count = (e?: Expr<unknown>): SQL<number> => new SQL<number>(e ? ["COUNT(", e, ")"] : ["COUNT(*)"], toNumber);
export const countDistinct = (e: Expr<unknown>): SQL<number> => new SQL<number>(["COUNT(DISTINCT ", e, ")"], toNumber);
/** Decoded like the column (Decimal stays a string, BigInt a bigint); null for no rows. */
export const sum = <T>(e: Expr<T>): SQL<NonNullable<T> | null> => new SQL(["SUM(", e, ")"], asColumn(e) ?? toNullableNumber);
export const avg = (e: Expr<unknown>): SQL<number | null> => new SQL<number | null>(["AVG(", e, ")"], toNullableNumber);
export const min = <T>(e: Expr<T>): SQL<NonNullable<T> | null> => new SQL(["MIN(", e, ")"], asColumn(e));
export const max = <T>(e: Expr<T>): SQL<NonNullable<T> | null> => new SQL(["MAX(", e, ")"], asColumn(e));
