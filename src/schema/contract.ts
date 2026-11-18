/**
 * The resolved, validated form of a schema. Everything downstream (generator, query
 * runtime, migration planner, introspection) works on this structure, never on the AST.
 * It is serialisable to JSON (`contract.json`).
 */

export const CONTRACT_VERSION = 1;

export type ScalarType = "String" | "Int" | "BigInt" | "Float" | "Decimal" | "Boolean" | "DateTime" | "Bytes" | "Json";

export const SCALAR_TYPES: readonly ScalarType[] = [
  "String",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "Boolean",
  "DateTime",
  "Bytes",
  "Json",
];

/** A value that is either literal or read from an environment variable at runtime. */
export type ConfigValue = string | number | boolean | { env: string };

export interface DatasourceDef {
  name: string;
  provider: "hana";
  /** `hana://user:password@host:port/?databaseName=X&currentSchema=Y&encrypt=true` */
  url?: ConfigValue;
  host?: ConfigValue;
  port?: ConfigValue;
  user?: ConfigValue;
  password?: ConfigValue;
  databaseName?: ConfigValue;
  /** Default schema: tables of models without `@@schema` are created/read here. */
  schema?: ConfigValue;
  encrypt?: ConfigValue;
  sslValidateCertificate?: ConfigValue;
}

export interface GeneratorDef {
  name: string;
  provider: string;
  /** Output folder, already resolved relative to the schema file when produced by the CLI. */
  output?: string;
  [key: string]: unknown;
}

export interface NativeType {
  /** e.g. `NVarChar`, `Decimal`, `SecondDate` (without the `db.` prefix). */
  name: string;
  args: number[];
}

export type DefaultDef =
  | { kind: "autoincrement" }
  | { kind: "now" }
  | { kind: "uuid" }
  | { kind: "cuid" }
  | { kind: "value"; value: string | number | boolean }
  /** Raw SQL expression used in DDL; the runtime leaves the column out of INSERTs. */
  | { kind: "dbgenerated"; sql: string }
  /**
   * `sequence("SEQ", start: 1, increment: 1)`: INSERTs take `"SEQ".NEXTVAL`. The sequence lives
   * in the model's schema and is created by migrations (HANA has no sequence column defaults).
   */
  | { kind: "sequence"; name: string; start?: number; increment?: number };

export interface ScalarFieldDef {
  kind: "scalar";
  name: string;
  /** Column name in the database (`@map`, defaults to `name`). */
  dbName: string;
  type: ScalarType;
  optional: boolean;
  /** True when this field alone is the primary key (`@id`). */
  id: boolean;
  /** True when this field alone is unique (`@unique`). */
  unique: boolean;
  default?: DefaultDef;
  updatedAt: boolean;
  nativeType?: NativeType;
  /** `@ignore`: kept for migrations, hidden from the client. */
  ignored?: boolean;
  doc?: string;
}

export interface EnumFieldDef {
  kind: "enum";
  name: string;
  dbName: string;
  /** Enum name; stored as NVARCHAR in HANA. */
  type: string;
  optional: boolean;
  id: boolean;
  unique: boolean;
  default?: DefaultDef;
  updatedAt: false;
  nativeType?: NativeType;
  /** `@ignore`: kept for migrations, hidden from the client. */
  ignored?: boolean;
  doc?: string;
}

export type ReferentialAction = "Cascade" | "Restrict" | "NoAction" | "SetNull" | "SetDefault";

export interface RelationFieldDef {
  kind: "relation";
  name: string;
  /** Target model name. */
  model: string;
  list: boolean;
  optional: boolean;
  relationName: string;
  /** True on the side that holds the foreign key (`@relation(fields: ..., references: ...)`). */
  owner: boolean;
  /** Field names on this model that join to `targetFields` (same order). */
  localFields: string[];
  /** Field names on the target model. */
  targetFields: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  /** Foreign key constraint name (owner side only). */
  fkName?: string;
  /** `@ignore`: the foreign key is kept for migrations, the field is hidden from the client. */
  ignored?: boolean;
  /**
   * Set on both sides of an implicit many-to-many relation (two list fields without
   * `@relation(fields, references)`). The rows are linked through a join table;
   * `localFields` / `targetFields` are the primary keys of this model and the target.
   */
  through?: JoinTableDef;
  doc?: string;
}

/** Join table of an implicit many-to-many relation, as seen from one relation field. */
export interface JoinTableDef {
  /** Name of the hidden join model in `contract.models`, e.g. `_PostToTag`. */
  model: string;
  /** Table name. */
  dbName: string;
  /** Database schema; undefined means the datasource default schema. */
  schema?: string;
  /** Join table columns that hold this model's key (same order as `localFields`). */
  localColumns: string[];
  /** Join table columns that hold the target's key (same order as `targetFields`). */
  targetColumns: string[];
}

export type ColumnFieldDef = ScalarFieldDef | EnumFieldDef;
export type FieldDef = ColumnFieldDef | RelationFieldDef;

export interface UniqueDef {
  /** Name used in `WhereUniqueInput` for compound keys, e.g. `firstName_lastName`. */
  name: string;
  /** Constraint name in the database. */
  dbName: string;
  fields: string[];
}

export interface IndexDef {
  dbName: string;
  fields: string[];
}

/** `@@check("SQL", map: "NAME")`: a table check constraint with a raw SQL condition. */
export interface CheckDef {
  dbName: string;
  sql: string;
}

export interface ModelDef {
  name: string;
  /** Table (or view) name (`@@map`, defaults to `name`). */
  dbName: string;
  /** Database schema (`@@schema`); undefined means the datasource default schema. */
  schema?: string;
  /** Views and tables without a primary key are read-only. */
  kind: "model" | "view";
  fields: FieldDef[];
  /** Primary key field names (from `@id` or `@@id`); null when the table has none. */
  primaryKey: { name: string; dbName: string; fields: string[] } | null;
  uniques: UniqueDef[];
  indexes: IndexDef[];
  /** `@@check` constraints. */
  checks?: CheckDef[];
  /**
   * Columns declared as `Unsupported("TYPE")`: not exposed in the client, but kept so
   * migrations and drift detection know the column exists.
   */
  ignoredColumns?: IgnoredColumnDef[];
  /** `@@ignore`: the table is kept for migrations, the model is hidden from the client. */
  ignored?: boolean;
  /**
   * Join table of an implicit many-to-many relation (`_PostToTag` with columns `A`, `B`).
   * Created by migrations, hidden from the client; the relation fields carry `through`.
   */
  implicit?: boolean;
  doc?: string;
}

export interface IgnoredColumnDef {
  name: string;
  dbName: string;
  /** Raw HANA type from `Unsupported("...")`, e.g. `ST_GEOMETRY`. */
  type: string;
  optional: boolean;
}

export interface EnumDef {
  name: string;
  dbName: string;
  values: { name: string; dbName: string }[];
  doc?: string;
}

export interface Contract {
  version: typeof CONTRACT_VERSION;
  /** sha256 over models and enums (canonical JSON). Changes iff the data model changes. */
  hash: string;
  datasource: DatasourceDef;
  generators: GeneratorDef[];
  models: Record<string, ModelDef>;
  enums: Record<string, EnumDef>;
}

// ---- helpers shared by runtime, generator and migrations --------------------

export function columnFields(model: ModelDef): ColumnFieldDef[] {
  return model.fields.filter((f): f is ColumnFieldDef => f.kind !== "relation");
}

export function relationFields(model: ModelDef): RelationFieldDef[] {
  return model.fields.filter((f): f is RelationFieldDef => f.kind === "relation");
}

export function getField(model: ModelDef, name: string): FieldDef | undefined {
  return model.fields.find((f) => f.name === name);
}

export function getColumn(model: ModelDef, name: string): ColumnFieldDef {
  const f = model.fields.find((x) => x.name === name);
  if (!f || f.kind === "relation") throw new Error(`Unknown column field '${name}' on model '${model.name}'`);
  return f;
}

/**
 * The part of a contract the client sees: models with `@@ignore`, implicit many-to-many join
 * tables and fields with `@ignore` are removed, and so are unique constraints and indexes that
 * use an ignored field. The hash is kept, so it still identifies the full data model. Returns
 * `contract` itself when nothing is hidden.
 */
export function clientContract(contract: Contract): Contract {
  const anyIgnored = Object.values(contract.models).some((m) => m.ignored || m.implicit || m.fields.some((f) => f.ignored));
  if (!anyIgnored) return contract;
  const models: Record<string, ModelDef> = {};
  for (const [name, m] of Object.entries(contract.models)) {
    if (m.ignored || m.implicit) continue;
    const hidden = new Set(m.fields.filter((f) => f.ignored).map((f) => f.name));
    const visible = (fields: readonly string[]): boolean => fields.every((f) => !hidden.has(f));
    models[name] = {
      ...m,
      fields: m.fields.filter((f) => !f.ignored),
      uniques: m.uniques.filter((u) => visible(u.fields)),
      indexes: m.indexes.filter((i) => visible(i.fields)),
    };
  }
  return { ...contract, models };
}
