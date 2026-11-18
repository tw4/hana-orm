/**
 * Define the schema in TypeScript (issue #29). The definitions are turned into the same syntax
 * tree the `.hana` parser produces and go through `buildContract`, so a TypeScript schema and
 * the equivalent `.hana` file give identical contracts (and contract hashes).
 *
 * ```ts
 * const Role = hanaEnum("Role", ["USER", { name: "ADMIN", map: "admin" }]);
 * const User = hanaTable("User", {
 *   id: int().primaryKey().autoincrement(),
 *   email: string().db("NVarChar", 320).unique(),
 *   role: enumColumn(Role).default("USER"),
 * }, { map: "USERS" });
 * const Post = hanaTable("Post", { id: int().primaryKey(), authorId: int().optional() });
 * export const schema = hanaSchema({
 *   enums: [Role],
 *   tables: [User, Post],
 *   relations: [
 *     relations(User, { posts: many(Post) }),
 *     relations(Post, { author: one(User, { optional: true, fields: ["authorId"], references: ["id"] }) }),
 *   ],
 * });
 * type UserRow = typeof User.$inferSelect;
 * ```
 */

import type { Arg, Attribute, ConfigBlock, ConfigProperty, Declaration, EnumDecl, FieldDecl, ModelDecl, Position, SchemaAst, Value } from "./ast.ts";
import { buildContract } from "./build.ts";
import type { Contract, ReferentialAction } from "./contract.ts";
import { createTables, type Column, type Table } from "../runtime/builder/core.ts";
import { createClientClass, type BaseClient, type ClientOptions } from "../runtime/client.ts";

const POS: Position = { line: 0, col: 0, file: "<typescript schema>" };

const str = (value: string): Value => ({ kind: "string", value, pos: POS });
const num = (value: number): Value => ({ kind: "number", value, pos: POS });
const ident = (name: string): Value => ({ kind: "ident", name, pos: POS });
const call = (name: string, args: Arg[] = []): Value => ({ kind: "call", name, args, pos: POS });
const list = (names: readonly string[]): Value => ({ kind: "array", items: names.map(ident), pos: POS });
const attr = (name: string, args: Arg[] = []): Attribute => ({ name, args, pos: POS });
const literal = (v: string | number | boolean): Value => (typeof v === "string" ? str(v) : typeof v === "number" ? num(v) : { kind: "boolean", value: v, pos: POS });

// ---- columns ----------------------------------------------------------------------------------

interface ColumnState {
  type: string;
  optional: boolean;
  attrs: Attribute[];
  doc?: string;
  /** Enum column: defaults are written as enum value names. */
  isEnum?: boolean;
}

/**
 * Literal accepted by `default()`: Decimal (string) and BigInt columns also take numbers, as in
 * `.hana` (`@default(0)`); enum columns take their value names.
 */
export type DefaultValue<T> = string extends T ? string | number : T extends bigint ? number | string : T extends string | number | boolean ? T : never;

/**
 * A column definition. `T` is its TypeScript value type, `Opt` whether it is optional (NULL),
 * `Def` whether inserts may leave it out (default, autoincrement, @updatedAt).
 */
export class ColumnBuilder<T, Opt extends boolean = false, Def extends boolean = false> {
  readonly #s: ColumnState;
  declare readonly _type: T;
  declare readonly _optional: Opt;
  declare readonly _default: Def;

  constructor(state: ColumnState) {
    this.#s = state;
  }

  #with<T2 = T, O2 extends boolean = Opt, D2 extends boolean = Def>(changes: Partial<ColumnState>, extra?: Attribute): ColumnBuilder<T2, O2, D2> {
    return new ColumnBuilder<T2, O2, D2>({ ...this.#s, ...changes, attrs: extra ? [...this.#s.attrs, extra] : this.#s.attrs });
  }

  /** Nullable column (`Type?`). */
  optional(): ColumnBuilder<T, true, Def> {
    return this.#with({ optional: true });
  }
  /** `@id`; `map` names the primary key constraint. */
  primaryKey(map?: string): ColumnBuilder<T, Opt, Def> {
    return this.#with({}, attr("id", map ? [{ name: "map", value: str(map) }] : []));
  }
  /** `@unique`; `map` names the constraint. */
  unique(map?: string): ColumnBuilder<T, Opt, Def> {
    return this.#with({}, attr("unique", map ? [{ name: "map", value: str(map) }] : []));
  }
  /** Column name in the database (`@map`). */
  map(name: string): ColumnBuilder<T, Opt, Def> {
    return this.#with({}, attr("map", [{ value: str(name) }]));
  }
  /** Native HANA type (`@db.NVarChar(320)`). */
  db(name: string, ...args: number[]): ColumnBuilder<T, Opt, Def> {
    return this.#with({}, attr(`db.${name}`, args.map((a) => ({ value: num(a) }))));
  }
  /** `@default(value)`: a literal, or an enum value name for enum columns. */
  default(value: DefaultValue<T>): ColumnBuilder<T, Opt, true> {
    const v = this.#s.isEnum ? ident(String(value)) : literal(value as string | number | boolean);
    return this.#with({}, attr("default", [{ value: v }]));
  }
  /** `@default(now())`. */
  defaultNow(): ColumnBuilder<T, Opt, true> {
    return this.#with({}, attr("default", [{ value: call("now") }]));
  }
  /** `@default(autoincrement())`: an identity column. */
  autoincrement(): ColumnBuilder<T, Opt, true> {
    return this.#with({}, attr("default", [{ value: call("autoincrement") }]));
  }
  /** `@default(uuid())`. */
  uuid(): ColumnBuilder<T, Opt, true> {
    return this.#with({}, attr("default", [{ value: call("uuid") }]));
  }
  /** `@default(cuid())`. */
  cuid(): ColumnBuilder<T, Opt, true> {
    return this.#with({}, attr("default", [{ value: call("cuid") }]));
  }
  /** `@default(dbgenerated("SQL"))`. */
  dbGenerated(sql: string): ColumnBuilder<T, Opt, true> {
    return this.#with({}, attr("default", [{ value: call("dbgenerated", [{ value: str(sql) }]) }]));
  }
  /** `@updatedAt`: set on every write. */
  updatedAt(): ColumnBuilder<T, Opt, true> {
    return this.#with({}, attr("updatedAt"));
  }
  /** `@ignore`: kept for migrations, hidden from clients. */
  ignore(): ColumnBuilder<T, Opt, Def> {
    return this.#with({}, attr("ignore"));
  }
  /** `///` documentation (also the column comment). */
  doc(text: string): ColumnBuilder<T, Opt, Def> {
    return this.#with({ doc: text });
  }

  /** @internal */
  _decl(name: string): FieldDecl {
    const s = this.#s;
    return { name, type: s.type, optional: s.optional, list: false, attributes: s.attrs, ...(s.doc ? { doc: s.doc } : {}), pos: POS };
  }
}

const column = <T>(type: string, native?: [string, ...number[]]): ColumnBuilder<T> => {
  const c = new ColumnBuilder<T>({ type, optional: false, attrs: [] });
  return native ? c.db(native[0], ...(native.slice(1) as number[])) : c;
};

export const int = (): ColumnBuilder<number> => column("Int");
export const bigint = (): ColumnBuilder<bigint> => column("BigInt");
export const float = (): ColumnBuilder<number> => column("Float");
/** `Decimal`; values are strings so no digit is lost. With precision/scale: `@db.Decimal(p, s)`. */
export const decimal = (precision?: number, scale?: number): ColumnBuilder<string> =>
  precision === undefined ? column("Decimal") : column("Decimal", scale === undefined ? ["Decimal", precision] : ["Decimal", precision, scale]);
export const boolean = (): ColumnBuilder<boolean> => column("Boolean");
/** `String`; with a length `@db.NVarChar(length)`. */
export const string = (length?: number): ColumnBuilder<string> => (length === undefined ? column("String") : column("String", ["NVarChar", length]));
/** `String @db.NClob`. */
export const text = (): ColumnBuilder<string> => column("String", ["NClob"]);
export const dateTime = (): ColumnBuilder<Date> => column("DateTime");
/** `DateTime @db.Date`. */
export const date = (): ColumnBuilder<Date> => column("DateTime", ["Date"]);
export const json = <T = unknown>(): ColumnBuilder<T> => column("Json");
export const bytes = (): ColumnBuilder<Buffer> => column("Bytes");

// ---- enums -----------------------------------------------------------------------------------

export interface EnumDefinition<Values extends string> {
  readonly name: string;
  readonly values: readonly Values[];
  /** @internal */ readonly _decl: EnumDecl;
}

type EnumValueSpec = string | { name: string; map?: string };
type ValueName<V> = V extends string ? V : V extends { name: infer N extends string } ? N : never;

/** `enum Role { USER  ADMIN @map("admin") }`. */
export function hanaEnum<const V extends readonly EnumValueSpec[]>(name: string, values: V, options: { map?: string; doc?: string } = {}): EnumDefinition<ValueName<V[number]>> {
  const decl: EnumDecl = {
    kind: "enum",
    name,
    values: values.map((v) => {
      const spec = typeof v === "string" ? { name: v } : v;
      return { name: spec.name, attributes: spec.map ? [attr("map", [{ value: str(spec.map) }])] : [], pos: POS };
    }),
    attributes: options.map ? [attr("map", [{ value: str(options.map) }])] : [],
    ...(options.doc ? { doc: options.doc } : {}),
    pos: POS,
  };
  return { name, values: values.map((v) => (typeof v === "string" ? v : v.name)) as never, _decl: decl };
}

/** A column holding a value of `e`. */
export function enumColumn<V extends string>(e: EnumDefinition<V>): ColumnBuilder<V> {
  return new ColumnBuilder<V>({ type: e.name, optional: false, attrs: [], isEnum: true });
}

// ---- relations ------------------------------------------------------------------------------

export interface RelationOptions {
  /** Relation name, needed when two relations connect the same models. */
  name?: string;
  fields?: string[];
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  /** Foreign key constraint name. */
  map?: string;
}

export class RelationBuilder {
  readonly #target: TableDefinition<string, any>;
  readonly #list: boolean;
  readonly #optional: boolean;
  readonly #options: RelationOptions;
  constructor(target: TableDefinition<string, any>, list: boolean, optional: boolean, options: RelationOptions) {
    this.#target = target;
    this.#list = list;
    this.#optional = optional;
    this.#options = options;
  }
  /** @internal */
  _decl(name: string): FieldDecl {
    const o = this.#options;
    const args: Arg[] = [];
    if (o.name) args.push({ value: str(o.name) });
    if (o.fields) args.push({ name: "fields", value: list(o.fields) });
    if (o.references) args.push({ name: "references", value: list(o.references) });
    if (o.onDelete) args.push({ name: "onDelete", value: ident(o.onDelete) });
    if (o.onUpdate) args.push({ name: "onUpdate", value: ident(o.onUpdate) });
    if (o.map) args.push({ name: "map", value: str(o.map) });
    return { name, type: this.#target.name, optional: this.#optional, list: this.#list, attributes: args.length ? [attr("relation", args)] : [], pos: POS };
  }
}

/** A to-one relation (`author User? @relation(fields: [authorId], references: [id])`). */
export const one = (target: TableDefinition<string, any>, options: RelationOptions & { optional?: boolean } = {}): RelationBuilder =>
  new RelationBuilder(target, false, options.optional ?? false, options);
/** A to-many relation (`posts Post[]`). */
export const many = (target: TableDefinition<string, any>, options: { name?: string } = {}): RelationBuilder => new RelationBuilder(target, true, false, options);

/** The relation fields of one table, defined after all tables so they can refer to each other. */
export interface RelationsDefinition {
  readonly table: TableDefinition<string, any>;
  readonly fields: Readonly<Record<string, RelationBuilder>>;
}

export function relations(table: TableDefinition<string, any>, fields: Record<string, RelationBuilder>): RelationsDefinition {
  return { table, fields };
}

// ---- tables ---------------------------------------------------------------------------------

type AnyColumn = ColumnBuilder<any, boolean, boolean>;

export interface TableOptions {
  /** Table name (`@@map`). */
  map?: string;
  /** Database schema (`@@schema`). */
  schema?: string;
  /** Compound primary key (`@@id([a, b])`). */
  id?: { fields: string[]; map?: string };
  uniques?: { fields: string[]; name?: string; map?: string }[];
  indexes?: { fields: string[]; map?: string }[];
  /** A database view: read-only in clients, not managed by migrations. */
  view?: boolean;
  ignore?: boolean;
  doc?: string;
}

/** Row type a table returns. */
export type SelectRow<C> = { [K in keyof C]: C[K] extends ColumnBuilder<infer T, infer O, boolean> ? (O extends true ? T | null : T) : never };
type RequiredKeys<C> = { [K in keyof C]: C[K] extends ColumnBuilder<infer _T, infer O, infer D> ? (O extends true ? never : D extends true ? never : K) : never }[keyof C];
/** Row type an insert takes: optional and defaulted columns may be left out. */
export type InsertRow<C> = { [K in RequiredKeys<C>]: SelectRow<C>[K] } & { [K in Exclude<keyof C, RequiredKeys<C>>]?: SelectRow<C>[K] };

export class TableDefinition<Name extends string, C extends Record<string, AnyColumn>> {
  readonly name: Name;
  readonly columns: C;
  readonly options: TableOptions;
  /** Type-only: `typeof User.$inferSelect`. */
  declare readonly $inferSelect: { [K in keyof SelectRow<C>]: SelectRow<C>[K] };
  /** Type-only: `typeof User.$inferInsert`. */
  declare readonly $inferInsert: { [K in keyof InsertRow<C>]: InsertRow<C>[K] };

  constructor(name: Name, columns: C, options: TableOptions) {
    this.name = name;
    this.columns = columns;
    this.options = options;
  }

  /** @internal */
  _decl(relationFields: Readonly<Record<string, RelationBuilder>> = {}): ModelDecl {
    const o = this.options;
    const fields = [...Object.entries(this.columns).map(([k, c]) => c._decl(k)), ...Object.entries(relationFields).map(([k, r]) => r._decl(k))];
    const attributes: Attribute[] = [];
    if (o.id) attributes.push(attr("id", [{ value: list(o.id.fields) }, ...(o.id.map ? [{ name: "map", value: str(o.id.map) }] : [])]));
    for (const u of o.uniques ?? []) {
      attributes.push(attr("unique", [{ value: list(u.fields) }, ...(u.name ? [{ name: "name", value: str(u.name) }] : []), ...(u.map ? [{ name: "map", value: str(u.map) }] : [])]));
    }
    for (const i of o.indexes ?? []) attributes.push(attr("index", [{ value: list(i.fields) }, ...(i.map ? [{ name: "map", value: str(i.map) }] : [])]));
    if (o.map) attributes.push(attr("map", [{ value: str(o.map) }]));
    if (o.schema) attributes.push(attr("schema", [{ value: str(o.schema) }]));
    if (o.ignore) attributes.push(attr("ignore"));
    return { kind: o.view ? "view" : "model", name: this.name, fields, attributes, ...(o.doc ? { doc: o.doc } : {}), pos: POS };
  }
}

/** A model (`model Name { ... }`). */
export function hanaTable<const Name extends string, C extends Record<string, AnyColumn>>(name: Name, columns: C, options: TableOptions = {}): TableDefinition<Name, C> {
  return new TableDefinition(name, columns, options);
}

// ---- schema ---------------------------------------------------------------------------------

/** `env("DATABASE_URL")` in the datasource. */
export const env = (name: string): { env: string } => ({ env: name });
type ConfigInput = string | number | boolean | { env: string };

export interface SchemaInput<Tables extends readonly TableDefinition<string, any>[]> {
  datasource?: Record<string, ConfigInput>;
  generators?: Record<string, Record<string, ConfigInput>>;
  tables: Tables;
  enums?: readonly EnumDefinition<string>[];
  relations?: readonly RelationsDefinition[];
}

export interface HanaSchema<Tables extends readonly TableDefinition<string, any>[]> {
  /** The syntax tree, as if parsed from a `.hana` file. */
  readonly ast: SchemaAst;
  readonly contract: Contract;
  readonly tables: Tables;
}

function config(kind: "datasource" | "generator", name: string, props: Record<string, ConfigInput>): ConfigBlock {
  const properties: ConfigProperty[] = Object.entries(props).map(([key, v]) => ({
    key,
    value: typeof v === "object" ? call("env", [{ value: str(v.env) }]) : literal(v),
    pos: POS,
  }));
  if (kind === "datasource" && !("provider" in props)) properties.unshift({ key: "provider", value: str("hana"), pos: POS });
  return { kind, name, properties, pos: POS };
}

/** Builds the contract of a TypeScript schema. Throws `SchemaError` like a `.hana` file would. */
export function hanaSchema<const Tables extends readonly TableDefinition<string, any>[]>(input: SchemaInput<Tables>): HanaSchema<Tables> {
  const declarations: Declaration[] = [];
  if (input.datasource) declarations.push(config("datasource", "db", input.datasource));
  for (const [name, props] of Object.entries(input.generators ?? {})) declarations.push(config("generator", name, { provider: "hana-orm", ...props }));
  for (const e of input.enums ?? []) declarations.push(e._decl);
  const rels = new Map<TableDefinition<string, any>, Record<string, RelationBuilder>>();
  for (const r of input.relations ?? []) {
    if (!input.tables.includes(r.table)) throw new Error(`relations(): table '${r.table.name}' is not in this schema's tables`);
    rels.set(r.table, { ...rels.get(r.table), ...r.fields });
  }
  for (const t of input.tables) declarations.push(t._decl(rels.get(t)));
  const ast: SchemaAst = { declarations };
  return { ast, contract: buildContract(ast, { file: "<typescript schema>" }), tables: input.tables };
}

// ---- without a generator ------------------------------------------------------------------------

/** Builder tables of a TypeScript schema, typed from the definitions: `tablesOf(schema).user.email`. */
export type TablesOf<Tables extends readonly TableDefinition<string, any>[]> = {
  readonly [T in Tables[number] as Uncapitalize<T["name"]>]: T extends TableDefinition<infer N, infer C>
    ? Table<Uncapitalize<N>, { readonly [K in keyof C]: Column<SelectRow<C>[K], Uncapitalize<N>> }, InsertRow<C>>
    : never;
};

export function tablesOf<Tables extends readonly TableDefinition<string, any>[]>(schema: HanaSchema<Tables>): TablesOf<Tables> {
  return createTables(schema.contract) as unknown as TablesOf<Tables>;
}

/**
 * A client for a TypeScript schema, without `hana-orm generate`. The SQL-like builder is fully
 * typed through `tablesOf(schema)`; the object API (`db.user.findMany`) works but is untyped.
 */
export function createClient<Tables extends readonly TableDefinition<string, any>[]>(schema: HanaSchema<Tables>, options?: ClientOptions): BaseClient & Record<string, any> {
  const Client = createClientClass(schema.contract);
  return new Client(options) as BaseClient & Record<string, any>;
}
