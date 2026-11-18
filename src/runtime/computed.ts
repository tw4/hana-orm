/**
 * Result extensions (`$extends({ result: { user: { fullName: { needs, compute } } } })`).
 *
 * Before a query its arguments are rewritten: computed keys leave `select`/`omit`, the fields
 * they `need` are added to `select` or brought back from `omit`. After the query each row gets
 * the computed values and loses the fields that were only fetched for them. Only top-level
 * rows are computed; rows loaded through `include` / nested `select` are left as they are.
 */

import type { ModelDef } from "../schema/contract.ts";
import { ValidationError } from "./errors.ts";
import { isPlainObject } from "./where.ts";

export interface ComputedField {
  /** Model fields the computation reads, e.g. `{ firstName: true, lastName: true }`. */
  needs: Record<string, boolean | undefined>;
  compute: (row: any) => unknown;
}

/** Computed fields of one model, in definition order (a later extension overrides an earlier one). */
export type ComputedFields = Map<string, ComputedField>;

/** Operations that return model rows. */
export const ROW_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "create",
  "createManyAndReturn",
  "update",
  "upsert",
  "delete",
]);

export function validateComputed(model: ModelDef, name: string, def: unknown): ComputedField {
  if (!isPlainObject(def) || typeof def.compute !== "function") {
    throw new ValidationError(`result.${name} on '${model.name}' needs a compute(row) function`);
  }
  const needs = def.needs === undefined ? {} : def.needs;
  if (!isPlainObject(needs)) throw new ValidationError(`result.${name}.needs on '${model.name}' must be an object of fields`);
  for (const f of Object.keys(needs)) {
    const field = model.fields.find((x) => x.name === f);
    if (!field || field.kind === "relation") throw new ValidationError(`result.${name}.needs on '${model.name}' names '${f}', which is not a scalar field`);
  }
  if (model.fields.some((f) => f.name === name)) throw new ValidationError(`result.${name} on '${model.name}' has the name of a model field`);
  return { needs: needs as Record<string, boolean | undefined>, compute: def.compute as (row: any) => unknown };
}

export interface PreparedArgs {
  args: Record<string, unknown>;
  /** Computed fields to add to each row. */
  compute: [string, ComputedField][];
  /** Fields fetched only for the computations, removed afterwards. */
  strip: string[];
}

/**
 * Rewrites `args` for `fields`. `globallyOmitted` are the model's fields the client omits by
 * default (a needed one is brought back with `omit: { f: false }`).
 */
export function prepareArgs(args: Record<string, unknown>, fields: ComputedFields, globallyOmitted: ReadonlySet<string>): PreparedArgs {
  const select = isPlainObject(args.select) ? args.select : undefined;
  const omit = isPlainObject(args.omit) ? args.omit : undefined;
  const isOn = (v: unknown): boolean => v === true || isPlainObject(v);

  const wanted: [string, ComputedField][] = [];
  for (const [name, def] of fields) {
    if (select ? isOn(select[name]) : !(omit && omit[name] === true)) wanted.push([name, def]);
  }
  const needed = new Set(wanted.flatMap(([, d]) => Object.keys(d.needs).filter((k) => d.needs[k])));
  const out: Record<string, unknown> = { ...args };
  const strip: string[] = [];

  if (select) {
    const s: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(select)) if (!fields.has(k)) s[k] = v;
    for (const n of needed) {
      if (!isOn(s[n])) {
        s[n] = true;
        strip.push(n);
      }
    }
    out.select = s;
  } else {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(omit ?? {})) if (!fields.has(k)) o[k] = v;
    for (const n of needed) {
      const omittedHere = o[n] === true;
      const omittedGlobally = globallyOmitted.has(n) && o[n] !== false;
      if (omittedHere || omittedGlobally) {
        o[n] = false;
        strip.push(n);
      }
    }
    if (omit || Object.keys(o).length) out.omit = o;
  }
  return { args: out, compute: wanted, strip };
}

/** Adds computed values to a result (row, rows or null) and removes helper fields. */
export function applyComputed(result: unknown, prepared: PreparedArgs): unknown {
  if (!prepared.compute.length && !prepared.strip.length) return result;
  const one = (row: unknown): unknown => {
    if (!isPlainObject(row)) return row;
    for (const [name, def] of prepared.compute) row[name] = def.compute(row);
    for (const f of prepared.strip) delete row[f];
    return row;
  };
  return Array.isArray(result) ? result.map(one) : one(result);
}
