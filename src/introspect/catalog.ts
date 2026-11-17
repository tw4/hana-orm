/**
 * Reads the HANA catalog (SYS.TABLES, SYS.TABLE_COLUMNS, SYS.CONSTRAINTS,
 * SYS.REFERENTIAL_CONSTRAINTS, SYS.INDEXES/SYS.INDEX_COLUMNS, SYS.VIEWS/SYS.VIEW_COLUMNS)
 * into a `PhysicalSchema`. Each catalog view is read once per schema and filtered in memory,
 * which keeps the number of round trips constant for schemas with hundreds of tables.
 *
 * In HANA a unique constraint and a unique index are the same object: both show up in
 * SYS.CONSTRAINTS (IS_UNIQUE_KEY = 'TRUE'). SYS.INDEXES is only used for plain indexes
 * (CONSTRAINT IS NULL).
 */

import type { Queryable } from "../runtime/driver.ts";
import { HOUSEKEEPING_TABLES } from "../migrate/history.ts";
import type { FkAction, PhysicalColumn, PhysicalSchema, PhysicalTable, PhysicalView } from "../migrate/physical.ts";
import { tableKey } from "../migrate/physical.ts";
import { catalogDefaultToSql, formatType } from "../migrate/types.ts";

export interface CatalogTableRow {
  TABLE_NAME: string;
  COMMENTS?: string | null;
}

export interface CatalogColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  POSITION: number;
  DATA_TYPE_NAME: string;
  LENGTH: number | null;
  SCALE: number | null;
  IS_NULLABLE: string;
  DEFAULT_VALUE: string | null;
  GENERATION_TYPE?: string | null;
}

export interface CatalogConstraintRow {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  POSITION: number;
  IS_PRIMARY_KEY: string;
  IS_UNIQUE_KEY: string;
}

export interface CatalogFkRow {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  POSITION: number;
  REFERENCED_SCHEMA_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  DELETE_RULE: string | null;
  UPDATE_RULE: string | null;
}

export interface CatalogIndexRow {
  TABLE_NAME: string;
  INDEX_NAME: string;
  COLUMN_NAME: string;
  POSITION: number;
}

export interface CatalogViewRow {
  VIEW_NAME: string;
}

export interface CatalogViewColumnRow {
  VIEW_NAME: string;
  COLUMN_NAME: string;
  POSITION: number;
  DATA_TYPE_NAME: string;
  LENGTH: number | null;
  SCALE: number | null;
  IS_NULLABLE: string;
}

export interface CatalogRows {
  tables: CatalogTableRow[];
  columns: CatalogColumnRow[];
  constraints: CatalogConstraintRow[];
  foreignKeys: CatalogFkRow[];
  indexes: CatalogIndexRow[];
  views?: CatalogViewRow[];
  viewColumns?: CatalogViewColumnRow[];
}

export const CATALOG_SQL = {
  tables:
    "SELECT TABLE_NAME, COMMENTS FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND IS_TEMPORARY = 'FALSE' AND IS_USER_DEFINED_TYPE = 'FALSE' ORDER BY TABLE_NAME",
  columns:
    "SELECT TABLE_NAME, COLUMN_NAME, POSITION, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE, DEFAULT_VALUE, GENERATION_TYPE " +
    "FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME, POSITION",
  constraints:
    "SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, POSITION, IS_PRIMARY_KEY, IS_UNIQUE_KEY " +
    "FROM SYS.CONSTRAINTS WHERE SCHEMA_NAME = ? AND CHECK_CONDITION IS NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, POSITION",
  foreignKeys:
    "SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, POSITION, REFERENCED_SCHEMA_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, DELETE_RULE, UPDATE_RULE " +
    "FROM SYS.REFERENTIAL_CONSTRAINTS WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME, CONSTRAINT_NAME, POSITION",
  indexes:
    "SELECT i.TABLE_NAME, i.INDEX_NAME, c.COLUMN_NAME, c.POSITION FROM SYS.INDEXES i " +
    "JOIN SYS.INDEX_COLUMNS c ON c.INDEX_OID = i.INDEX_OID " +
    "WHERE i.SCHEMA_NAME = ? AND i.CONSTRAINT IS NULL ORDER BY i.TABLE_NAME, i.INDEX_NAME, c.POSITION",
  views: "SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME",
  viewColumns:
    "SELECT VIEW_NAME, COLUMN_NAME, POSITION, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE FROM SYS.VIEW_COLUMNS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME, POSITION",
} as const;

export async function readCatalog(db: Queryable, schema: string, includeViews: boolean): Promise<CatalogRows> {
  const p = [schema];
  const rows: CatalogRows = {
    tables: await db.query<CatalogTableRow>(CATALOG_SQL.tables, p),
    columns: await db.query<CatalogColumnRow>(CATALOG_SQL.columns, p),
    constraints: await db.query<CatalogConstraintRow>(CATALOG_SQL.constraints, p),
    foreignKeys: await db.query<CatalogFkRow>(CATALOG_SQL.foreignKeys, p),
    indexes: await db.query<CatalogIndexRow>(CATALOG_SQL.indexes, p),
  };
  if (includeViews) {
    rows.views = await db.query<CatalogViewRow>(CATALOG_SQL.views, p);
    rows.viewColumns = await db.query<CatalogViewColumnRow>(CATALOG_SQL.viewColumns, p);
  }
  return rows;
}

const LENGTH_TYPES = new Set(["NVARCHAR", "VARCHAR", "NCHAR", "CHAR", "ALPHANUM", "SHORTTEXT", "VARBINARY", "BINARY"]);

/** Builds the normalized type string from catalog columns. */
export function catalogType(dataType: string, length: number | null, scale: number | null): string {
  const name = dataType.toUpperCase();
  if (LENGTH_TYPES.has(name)) return formatType(name === "SHORTTEXT" ? "NVARCHAR" : name, length !== null && length !== undefined ? [Number(length)] : []);
  if (name === "DECIMAL") return scale === null || scale === undefined ? "DECIMAL" : formatType("DECIMAL", [Number(length), Number(scale)]);
  return name;
}

function fkAction(rule: string | null): FkAction {
  const r = (rule ?? "RESTRICT").toUpperCase();
  if (r === "CASCADE" || r === "SET NULL" || r === "SET DEFAULT") return r;
  return "RESTRICT";
}

export interface BuildOptions {
  /** Schema the rows were read from. */
  schema: string;
  /** Default schema; tables in it are keyed without a schema. */
  defaultSchema: string;
  /** Keeps a table or view when it returns true (receives the database name). */
  filter?: (name: string) => boolean;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    let list = m.get(k);
    if (!list) m.set(k, (list = []));
    list.push(r);
  }
  return m;
}

const byPos = <T extends { POSITION: number }>(a: T, b: T): number => Number(a.POSITION) - Number(b.POSITION);

/** Pure part of introspection: catalog rows of one schema → physical tables/views. */
export function buildPhysicalFromCatalog(rows: CatalogRows, options: BuildOptions, into: PhysicalSchema = { tables: {} }): PhysicalSchema {
  const schema = options.schema === options.defaultSchema ? undefined : options.schema;
  const keep = (name: string): boolean => !(HOUSEKEEPING_TABLES as readonly string[]).includes(name) && (options.filter ? options.filter(name) : true);
  const columns = groupBy(rows.columns, (r) => r.TABLE_NAME);
  const constraints = groupBy(rows.constraints, (r) => r.TABLE_NAME);
  const fks = groupBy(rows.foreignKeys, (r) => r.TABLE_NAME);
  const indexes = groupBy(rows.indexes, (r) => r.TABLE_NAME);

  for (const t of rows.tables) {
    if (!keep(t.TABLE_NAME)) continue;
    const cols: PhysicalColumn[] = (columns.get(t.TABLE_NAME) ?? []).sort(byPos).map((c) => {
      const type = catalogType(c.DATA_TYPE_NAME, c.LENGTH, c.SCALE);
      const col: PhysicalColumn = { name: c.COLUMN_NAME, type, nullable: c.IS_NULLABLE === "TRUE" };
      const identity = (c.GENERATION_TYPE ?? "").toUpperCase().includes("IDENTITY");
      if (identity) col.identity = true;
      else {
        const d = catalogDefaultToSql(c.DEFAULT_VALUE, type);
        if (d !== undefined) col.default = d;
      }
      return col;
    });
    const table: PhysicalTable = { name: t.TABLE_NAME, columns: cols, primaryKey: null, uniques: [], indexes: [], foreignKeys: [] };
    if (schema) table.schema = schema;
    if (t.COMMENTS) table.comment = t.COMMENTS;

    for (const [name, list] of groupBy(constraints.get(t.TABLE_NAME) ?? [], (r) => r.CONSTRAINT_NAME)) {
      const cs = list.sort(byPos).map((r) => r.COLUMN_NAME);
      if (list[0]!.IS_PRIMARY_KEY === "TRUE") table.primaryKey = { name, columns: cs };
      else if (list[0]!.IS_UNIQUE_KEY === "TRUE") table.uniques.push({ name, columns: cs });
    }
    for (const [name, list] of groupBy(indexes.get(t.TABLE_NAME) ?? [], (r) => r.INDEX_NAME)) {
      table.indexes.push({ name, columns: list.sort(byPos).map((r) => r.COLUMN_NAME) });
    }
    for (const [name, list] of groupBy(fks.get(t.TABLE_NAME) ?? [], (r) => r.CONSTRAINT_NAME)) {
      const sorted = list.sort(byPos);
      const first = sorted[0]!;
      const refSchema = first.REFERENCED_SCHEMA_NAME === options.defaultSchema ? undefined : first.REFERENCED_SCHEMA_NAME;
      table.foreignKeys.push({
        name,
        columns: sorted.map((r) => r.COLUMN_NAME),
        ...(refSchema ? { refSchema } : {}),
        refTable: first.REFERENCED_TABLE_NAME,
        refColumns: sorted.map((r) => r.REFERENCED_COLUMN_NAME),
        onDelete: fkAction(first.DELETE_RULE),
        onUpdate: fkAction(first.UPDATE_RULE),
      });
    }
    into.tables[tableKey(schema, t.TABLE_NAME)] = table;
  }

  if (rows.views) {
    const vcols = groupBy(rows.viewColumns ?? [], (r) => r.VIEW_NAME);
    into.views ??= {};
    for (const v of rows.views) {
      if (!keep(v.VIEW_NAME)) continue;
      const view: PhysicalView = {
        name: v.VIEW_NAME,
        columns: (vcols.get(v.VIEW_NAME) ?? []).sort(byPos).map((c) => ({
          name: c.COLUMN_NAME,
          type: catalogType(c.DATA_TYPE_NAME, c.LENGTH, c.SCALE),
          nullable: c.IS_NULLABLE === "TRUE",
        })),
      };
      if (schema) view.schema = schema;
      into.views[tableKey(schema, v.VIEW_NAME)] = view;
    }
  }
  return into;
}

export interface IntrospectOptions {
  /** Schemas to read; default: [defaultSchema]. */
  schemas?: string[];
  /** Default schema; resolved with `SELECT CURRENT_SCHEMA FROM DUMMY` when omitted. */
  defaultSchema?: string;
  filter?: (name: string) => boolean;
  /** Restrict to these table keys (relative to the default schema). Used for drift checks. */
  onlyTables?: ReadonlySet<string>;
  views?: boolean;
}

export async function currentSchema(db: Queryable): Promise<string> {
  const rows = await db.query<{ S: string }>("SELECT CURRENT_SCHEMA AS S FROM DUMMY");
  return rows[0]!.S;
}

/** Introspects the live database. */
export async function introspect(db: Queryable, options: IntrospectOptions = {}): Promise<PhysicalSchema> {
  const defaultSchema = options.defaultSchema ?? (await currentSchema(db));
  const schemas = [...new Set(options.schemas?.length ? options.schemas : [defaultSchema])].sort();
  const out: PhysicalSchema = { tables: {} };
  for (const schema of schemas) {
    const rows = await readCatalog(db, schema, options.views ?? false);
    const only = options.onlyTables;
    const filter = (name: string): boolean =>
      (options.filter ? options.filter(name) : true) && (only ? only.has(tableKey(schema === defaultSchema ? undefined : schema, name)) : true);
    buildPhysicalFromCatalog(rows, { schema, defaultSchema, filter }, out);
  }
  return out;
}
