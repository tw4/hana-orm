/**
 * Placeholders for prepared queries (issue #30). A `placeholder("id")` stands for a value that
 * is supplied when the prepared query runs; compiling turns it into a `PlaceholderSlot` that
 * remembers how to encode the value.
 */

import type { ColumnFieldDef } from "../schema/contract.ts";

export class Placeholder<Name extends string = string> {
  readonly name: Name;
  constructor(name: Name) {
    this.name = name;
  }
}

/** `placeholder("id")`: a value supplied when a prepared query is executed. */
export function placeholder<Name extends string>(name: Name): Placeholder<Name> {
  if (typeof name !== "string" || !name) throw new Error("placeholder() needs a name");
  return new Placeholder(name);
}

/** A compiled placeholder in a parameter list: filled (and encoded) at execution. */
export class PlaceholderSlot {
  readonly name: string;
  /** Encodes like this field; undefined = bound as given (raw sql). */
  readonly field: ColumnFieldDef | undefined;
  constructor(name: string, field: ColumnFieldDef | undefined) {
    this.name = name;
    this.field = field;
  }
}

/** Names of the placeholders in `params`. */
export function slotNames(params: readonly unknown[]): Set<string> {
  return new Set(params.filter((p): p is PlaceholderSlot => p instanceof PlaceholderSlot).map((p) => p.name));
}

/** Thrown for a missing or null placeholder value (a bound NULL never compares equal). */
export function missingValue(name: string): Error {
  return new Error(`Placeholder '${name}' needs a value; null is not allowed (compare with null using equals: null / isNull())`);
}

/** Names of the placeholders anywhere in `args`. */
export function collectPlaceholders(args: unknown, out: Set<string> = new Set()): Set<string> {
  if (args instanceof Placeholder) out.add(args.name);
  else if (Array.isArray(args)) for (const x of args) collectPlaceholders(x, out);
  else if (args && typeof args === "object" && Object.getPrototypeOf(args) === Object.prototype) for (const v of Object.values(args)) collectPlaceholders(v, out);
  return out;
}

/** Deep copy of `args` with every placeholder replaced by its value. */
export function substitutePlaceholders(args: unknown, values: Readonly<Record<string, unknown>>): unknown {
  if (args instanceof Placeholder) {
    const v = values[args.name];
    if (v === undefined || v === null) throw missingValue(args.name);
    return v;
  }
  if (Array.isArray(args)) return args.map((x) => substitutePlaceholders(x, values));
  if (args && typeof args === "object" && Object.getPrototypeOf(args) === Object.prototype) {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, substitutePlaceholders(v, values)]));
  }
  return args;
}
