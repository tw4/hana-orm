/** Prepared queries (issue #30): compiled once, executed many times with placeholder values. */

import type { Contract } from "../schema/contract.ts";
import { encodeValue } from "./codec.ts";
import type { Queryable } from "./driver.ts";
import { ValidationError } from "./errors.ts";
import { rawValue } from "./builder/core.ts";
import { missingValue, PlaceholderSlot, slotNames } from "./placeholder.ts";

/** Values for the placeholders of a prepared query, by name. */
export type PlaceholderValues = Readonly<Record<string, unknown>>;

/** The parameter list with every slot filled (encoded like its column). */
export function fillParams(contract: Contract, params: readonly unknown[], values: PlaceholderValues): unknown[] {
  return params.map((p) => {
    if (!(p instanceof PlaceholderSlot)) return p;
    const v = values[p.name];
    if (v === undefined || v === null) throw new ValidationError(missingValue(p.name).message);
    if (!p.field) return rawValue(v);
    return encodeValue(contract, p.field, v);
  });
}

/** Checks that `values` names no placeholder the query does not have. */
export function checkValueNames(known: ReadonlySet<string>, values: PlaceholderValues): void {
  for (const k of Object.keys(values)) if (!known.has(k)) throw new ValidationError(`Unknown placeholder '${k}'; this query has ${known.size ? [...known].map((n) => `'${n}'`).join(", ") : "none"}`);
}

/** A compiled query; `execute(values)` runs it with the given placeholder values. */
export class Prepared<R> {
  readonly #run: <T>(write: boolean, fn: (q: Queryable) => Promise<T>) => Promise<T>;
  readonly #exec: (values: PlaceholderValues, q: Queryable) => Promise<R>;
  readonly #write: boolean;
  /** Placeholder names the query expects. */
  readonly placeholders: ReadonlySet<string>;
  /** The SQL text, for inspection (stable across executions). */
  readonly sql: string;

  constructor(
    run: <T>(write: boolean, fn: (q: Queryable) => Promise<T>) => Promise<T>,
    write: boolean,
    sqlText: string,
    placeholders: ReadonlySet<string>,
    exec: (values: PlaceholderValues, q: Queryable) => Promise<R>,
  ) {
    this.#run = run;
    this.#write = write;
    this.sql = sqlText;
    this.placeholders = placeholders;
    this.#exec = exec;
  }

  async execute(values: PlaceholderValues = {}): Promise<R> {
    checkValueNames(this.placeholders, values);
    return this.#run(this.#write, (q) => this.#exec(values, q));
  }
}

export { slotNames };
