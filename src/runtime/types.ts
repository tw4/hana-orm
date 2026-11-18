/** Type helpers referenced by generated clients. */

export type SortOrder = "asc" | "desc";
export type QueryMode = "default" | "insensitive";
export interface SortOrderInput {
  sort: SortOrder;
  nulls?: "first" | "last";
}

export type Decimal = string;

export interface Filter<T> {
  equals?: T;
  in?: T[];
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  not?: T | Filter<T>;
}

export interface NullableFilter<T> {
  equals?: T | null;
  in?: T[];
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  not?: T | null | NullableFilter<T>;
}

export interface StringFilter extends Omit<Filter<string>, "not"> {
  /** Full-text search, `CONTAINS(column, search)` in HANA's search syntax (`hana orm`, `"exact phrase"`, `hana OR orm`, `-legacy`). */
  search?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  mode?: QueryMode;
  not?: string | StringFilter;
}

export interface StringNullableFilter extends Omit<NullableFilter<string>, "not"> {
  /** Full-text search, `CONTAINS(column, search)` in HANA's search syntax. */
  search?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  mode?: QueryMode;
  not?: string | null | StringNullableFilter;
}

export interface BoolFilter {
  equals?: boolean;
  not?: boolean | BoolFilter;
}
export interface BoolNullableFilter {
  equals?: boolean | null;
  not?: boolean | null | BoolNullableFilter;
}

export interface JsonFilter {
  equals?: JsonValue;
  not?: JsonValue;
}
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Atomic number updates. */
export type NumberUpdate<T> = T | { set?: T; increment?: T; decrement?: T; multiply?: T; divide?: T };
export type NullableNumberUpdate<T> = T | null | { set?: T | null; increment?: T; decrement?: T; multiply?: T; divide?: T };
export type SetUpdate<T> = T | { set?: T };
/** `T` with the keys `K` made optional (nested createMany rows, whose foreign key the runtime fills in). */
export type OptionalKeys<T, K extends keyof T> = Simplify<Omit<T, K> & Partial<Pick<T, K>>>;

export type Truthy<V> = V extends false | undefined | null ? false : true;
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Keys of `S` whose value is selected (not false/undefined/null). */
export type SelectedKeys<S> = { [K in keyof S]-?: Truthy<S[K]> extends true ? K : never }[keyof S];

type TrueKeys<T> = T extends object ? { [K in keyof T]-?: T[K] extends true ? K : never }[keyof T] : never;
type FalseKeys<T> = T extends object ? { [K in keyof T]-?: T[K] extends false ? K : never }[keyof T] : never;

/** The client-wide omit config of one model (`G` is the client's `omit` option, `K` the delegate name). */
export type ModelOmit<G, K extends string> = G extends { [P in K]?: infer O } ? (O extends object ? O : {}) : {};

/** Keys removed by the query's `omit` (in `A`) on top of the model's client-wide omit `MO`; `false` in the query re-includes. */
export type OmittedKeys<A, MO> = A extends { omit: infer O } ? TrueKeys<O> | Exclude<TrueKeys<MO>, FalseKeys<O>> : TrueKeys<MO>;

/** Model type `M` without the omitted fields. */
export type OmitFields<M, A, MO> = [OmittedKeys<A, MO>] extends [never] ? M : Simplify<Omit<M, OmittedKeys<A, MO>>>;

/** Result of `_count: true | { select: {...} }` given the full set of countable relations. */
export type CountPayload<V, All> = V extends { select: infer C }
  ? { [K in SelectedKeys<C> & keyof All]: number }
  : V extends true
    ? { [K in keyof All]: number }
    : never;

type AggregateOps = "_count" | "_sum" | "_avg" | "_min" | "_max";

/** Result type of `aggregate(args)` for model `M`. */
export type AggregatePayload<M, A> = Simplify<{
  [K in keyof A & AggregateOps]: K extends "_count"
    ? A[K] extends true
      ? number
      : { [F in SelectedKeys<A[K]>]: number }
    : K extends "_avg"
      ? { [F in SelectedKeys<A[K]>]: number | null }
      : { [F in SelectedKeys<A[K]> & keyof M]: M[F] | null };
}>;

/** Result row of `groupBy(args)` for model `M`. */
export type GroupByPayload<M, A> = A extends { by: infer B }
  ? Simplify<Pick<M, (B extends readonly (infer E)[] ? E : B) & keyof M> & AggregatePayload<M, A>>
  : never;

export interface BatchPayload {
  count: number;
}
