/**
 * Cache of compiled SELECTs per query shape (issue #14).
 *
 * Only shapes whose SQL provably does not depend on the values are cached: `where` with plain
 * equality on scalar columns (no null, filters, relations or AND/OR), boolean `select` / `omit`
 * on columns, `orderBy` on columns with "asc"/"desc", integer `take` / `skip` (they are part of
 * the SQL text), and no `include`, `distinct` or `cursor`. For those the parameters are exactly
 * the `where` values in key order, so a hit skips the SQL builder. The first compilation of a
 * shape is checked against the builder's own parameters and is not cached if they differ.
 */

import type { ColumnFieldDef, ModelDef } from "../schema/contract.ts";
import { isPlainObject } from "./where.ts";

export interface CachedPlan<S> {
  sql: string;
  sel: S;
  reverse: boolean;
  /** Fields whose `where` values are the parameters, in order. */
  whereFields: ColumnFieldDef[];
}

export interface PlanCacheStats {
  size: number;
  hits: number;
  misses: number;
  /** Queries whose shape cannot be cached. */
  uncacheable: number;
}

const SIMPLE_VALUE = (v: unknown): boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || v instanceof Date;

function columnOf(model: ModelDef, name: string): ColumnFieldDef | undefined {
  const f = model.fields.find((x) => x.name === name);
  return f && f.kind !== "relation" ? f : undefined;
}

function booleanColumns(model: ModelDef, v: unknown): string | null {
  if (v === undefined || v === null) return "";
  if (!isPlainObject(v)) return null;
  const parts: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    if (typeof x !== "boolean" || !columnOf(model, k)) return null;
    parts.push(`${k}:${x ? 1 : 0}`);
  }
  return parts.join(",");
}

function orderKey(model: ModelDef, orderBy: unknown): string | null {
  if (orderBy === undefined) return "";
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];
  for (const o of items) {
    if (!isPlainObject(o)) return null;
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if ((v !== "asc" && v !== "desc") || !columnOf(model, k)) return null;
      parts.push(`${k}:${v}`);
    }
    parts.push("|");
  }
  return parts.join(",");
}

/**
 * The shape key of `args` and the fields that supply its parameters, or null when the
 * shape is not cacheable.
 */
export function planKey(model: ModelDef, args: Record<string, unknown>): { key: string; whereFields: ColumnFieldDef[] } | null {
  for (const k of Object.keys(args)) {
    if (args[k] === undefined) continue;
    if (!["where", "select", "omit", "orderBy", "take", "skip"].includes(k)) return null;
  }
  const whereFields: ColumnFieldDef[] = [];
  if (args.where !== undefined) {
    if (!isPlainObject(args.where)) return null;
    for (const [k, v] of Object.entries(args.where)) {
      if (v === undefined) continue;
      const f = columnOf(model, k);
      if (!f || !SIMPLE_VALUE(v) || (f.kind === "scalar" && (f.type === "Json" || f.type === "Bytes"))) return null;
      whereFields.push(f);
    }
  }
  const select = booleanColumns(model, args.select);
  const omit = booleanColumns(model, args.omit);
  const order = orderKey(model, args.orderBy);
  if (select === null || omit === null || order === null) return null;
  for (const n of [args.take, args.skip]) if (n !== undefined && !(typeof n === "number" && Number.isInteger(n))) return null;
  const key = `${model.name}\u0000w:${whereFields.map((f) => f.name).join(",")}\u0000s:${select}\u0000o:${omit}\u0000b:${order}\u0000t:${String(args.take)}\u0000k:${String(args.skip)}`;
  return { key, whereFields };
}

/** A small LRU map. */
export class PlanCache<S> {
  readonly #max: number;
  readonly #plans = new Map<string, CachedPlan<S>>();
  hits = 0;
  misses = 0;
  uncacheable = 0;

  constructor(max: number) {
    this.#max = Math.max(0, max);
  }

  get enabled(): boolean {
    return this.#max > 0;
  }

  get(key: string): CachedPlan<S> | undefined {
    const p = this.#plans.get(key);
    if (p) {
      this.#plans.delete(key);
      this.#plans.set(key, p);
      this.hits++;
    } else this.misses++;
    return p;
  }

  set(key: string, plan: CachedPlan<S>): void {
    this.#plans.set(key, plan);
    if (this.#plans.size > this.#max) this.#plans.delete(this.#plans.keys().next().value!);
  }

  stats(): PlanCacheStats {
    return { size: this.#plans.size, hits: this.hits, misses: this.misses, uncacheable: this.uncacheable };
  }
}
