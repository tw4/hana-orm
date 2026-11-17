/**
 * The diff engine: (from, to, renames) → ordered, deterministic operations.
 *
 * Order: renames, drop foreign keys, drop indexes/uniques/primary keys, drop tables,
 * create tables, add/alter/drop columns, add primary keys/uniques/indexes, add foreign keys.
 * Inside each group ops are sorted by table key and object name.
 */

import { quoteIdent } from "../runtime/sql.ts";
import {
  addColumnSql,
  addForeignKeySql,
  addPrimaryKeySql,
  addUniqueSql,
  alterColumnSql,
  cmp,
  columnExistsCheck,
  createIndexSql,
  createTableSql,
  dropColumnSql,
  dropConstraintSql,
  dropIndexSql,
  dropPrimaryKeySql,
  dropTableSql,
  noDuplicatesCheck,
  noNullsCheck,
  physicalTableRef,
  renameColumnSql,
  renameTableSql,
  tableEmptyCheck,
  tableExistsCheck,
} from "./ddl.ts";
import type { MigrationOp } from "./ops.ts";
import type { PhysicalColumn, PhysicalForeignKey, PhysicalPrimaryKey, PhysicalSchema, PhysicalTable } from "./physical.ts";
import { clonePhysical, keyOf, refKeyOf, sameColumns, tableKey } from "./physical.ts";
import { classifyTypeChange, normalizeDefaultSql, normalizeType } from "./types.ts";

export interface Renames {
  /** from table key → to table key (same schema only). */
  tables: Record<string, string>;
  /** to table key → { from column → to column }. */
  columns: Record<string, Record<string, string>>;
}

export function emptyRenames(): Renames {
  return { tables: {}, columns: {} };
}

const GROUPS = [
  "renameTable",
  "renameColumn",
  "dropForeignKey",
  "dropIndex",
  "dropUnique",
  "dropPrimaryKey",
  "dropTable",
  "createTable",
  "addColumn",
  "alterColumn",
  "dropColumn",
  "addPrimaryKey",
  "addUnique",
  "createIndex",
  "addForeignKey",
] as const;

interface Pending {
  op: MigrationOp;
  sortKey: string;
}

/** Applies table and column renames to a copy of `from`, including references in foreign keys. */
export function applyRenames(from: PhysicalSchema, renames: Renames): PhysicalSchema {
  const out: PhysicalSchema = { tables: {} };
  const colMapFor = (toKey: string): Record<string, string> => renames.columns[toKey] ?? {};
  const mapCol = (toKey: string, c: string): string => colMapFor(toKey)[c] ?? c;
  const newKey = (key: string): string => renames.tables[key] ?? key;

  for (const [key, t0] of Object.entries(from.tables)) {
    const t = clonePhysical(t0);
    const k = newKey(key);
    if (k !== key) {
      const target = splitKey(k);
      t.name = target.name;
    }
    const cm = (c: string): string => mapCol(k, c);
    t.columns = t.columns.map((c) => ({ ...c, name: cm(c.name) }));
    if (t.primaryKey) t.primaryKey = { ...t.primaryKey, columns: t.primaryKey.columns.map(cm) };
    t.uniques = t.uniques.map((u) => ({ ...u, columns: u.columns.map(cm) }));
    t.indexes = t.indexes.map((i) => ({ ...i, columns: i.columns.map(cm) }));
    t.foreignKeys = t.foreignKeys.map((fk) => {
      const refK = newKey(refKeyOf(fk));
      const ref = splitKey(refK);
      const nfk: PhysicalForeignKey = { ...fk, columns: fk.columns.map(cm), refTable: ref.name, refColumns: fk.refColumns.map((c) => mapCol(refK, c)) };
      if (ref.schema) nfk.refSchema = ref.schema;
      else delete nfk.refSchema;
      return nfk;
    });
    out.tables[k] = t;
  }
  return out;
}

function splitKey(key: string): { schema?: string; name: string } {
  // Table keys are built by tableKey(); a key holds a schema only when a '.' precedes the
  // table name. Table names with dots in the default schema are not supported here.
  const i = key.indexOf(".");
  return i < 0 ? { name: key } : { schema: key.slice(0, i), name: key.slice(i + 1) };
}

export interface DiffOptions {
  renames?: Renames;
}

export function diffSchemas(from: PhysicalSchema, to: PhysicalSchema, options: DiffOptions = {}): MigrationOp[] {
  const renames = sanitizeRenames(from, to, options.renames ?? emptyRenames());
  const pending: Pending[] = [];
  const add = (op: MigrationOp, ...sortParts: string[]): void => {
    pending.push({ op, sortKey: sortParts.join("\u0000") });
  };

  // ---- renames --------------------------------------------------------------
  for (const [fromKey, toKey] of Object.entries(renames.tables)) {
    const t = from.tables[fromKey]!;
    const target = to.tables[toKey]!;
    add(
      {
        kind: "renameTable",
        description: `Rename table ${physicalTableRef(t)} to ${quoteIdent(target.name)}`,
        sql: [renameTableSql(t, target.name)],
        table: toKey,
        precheck: tableExistsCheck(target, false, `table ${physicalTableRef(target)} does not exist yet`),
        postcheck: tableExistsCheck(target, true, `table ${physicalTableRef(target)} exists`),
      },
      toKey,
    );
  }
  for (const [toKey, cols] of Object.entries(renames.columns)) {
    const t = to.tables[toKey]!;
    for (const [fromCol, toCol] of Object.entries(cols)) {
      add(
        {
          kind: "renameColumn",
          description: `Rename column ${quoteIdent(fromCol)} of ${physicalTableRef(t)} to ${quoteIdent(toCol)}`,
          sql: [renameColumnSql(t, fromCol, toCol)],
          table: toKey,
          postcheck: columnExistsCheck(t, toCol, true, `column ${quoteIdent(toCol)} exists`),
        },
        toKey,
        fromCol,
      );
    }
  }

  const a = applyRenames(from, renames);
  const b = to;

  // Columns whose type changes: foreign keys that use them are dropped and re-created.
  const retypedColumns = new Set<string>();
  for (const [key, tb] of Object.entries(b.tables)) {
    const ta = a.tables[key];
    if (!ta) continue;
    for (const cb of tb.columns) {
      const ca = ta.columns.find((c) => c.name === cb.name);
      if (ca && normalizeType(ca.type) !== normalizeType(cb.type)) retypedColumns.add(`${key}\u0000${cb.name}`);
    }
  }
  const fkTouchesRetyped = (ownerKey: string, fk: PhysicalForeignKey): boolean =>
    fk.columns.some((c) => retypedColumns.has(`${ownerKey}\u0000${c}`)) || fk.refColumns.some((c) => retypedColumns.has(`${refKeyOf(fk)}\u0000${c}`));

  // ---- dropped tables ---------------------------------------------------------
  for (const [key, t] of Object.entries(a.tables)) {
    if (b.tables[key]) continue;
    for (const fk of t.foreignKeys) add(dropFkOp(key, t, fk), key, fk.name);
    add(
      {
        kind: "dropTable",
        description: `Drop table ${physicalTableRef(t)}`,
        sql: [dropTableSql(t)],
        destructive: true,
        table: key,
        postcheck: tableExistsCheck(t, false, `table ${physicalTableRef(t)} no longer exists`),
      },
      key,
    );
  }

  // ---- created tables ---------------------------------------------------------
  for (const [key, t] of Object.entries(b.tables)) {
    if (a.tables[key]) continue;
    add(
      {
        kind: "createTable",
        description: `Create table ${physicalTableRef(t)}`,
        sql: [createTableSql(t)],
        table: key,
        precheck: tableExistsCheck(t, false, `table ${physicalTableRef(t)} does not exist yet`),
        postcheck: tableExistsCheck(t, true, `table ${physicalTableRef(t)} exists`),
      },
      key,
    );
    for (const i of t.indexes) add(createIndexOp(key, t, i.name, i.columns), key, i.name);
    for (const fk of t.foreignKeys) add(addFkOp(key, t, fk), key, fk.name);
  }

  // ---- changed tables ---------------------------------------------------------
  for (const [key, tb] of Object.entries(b.tables)) {
    const ta = a.tables[key];
    if (!ta) continue;

    // columns
    for (const cb of tb.columns) {
      const ca = ta.columns.find((c) => c.name === cb.name);
      if (!ca) {
        const needsEmpty = !cb.nullable && cb.default === undefined && !cb.identity;
        add(
          {
            kind: "addColumn",
            description: `Add column ${quoteIdent(cb.name)} to ${physicalTableRef(tb)}`,
            sql: [addColumnSql(tb, cb)],
            table: key,
            ...(needsEmpty ? { precheck: tableEmptyCheck(tb) } : {}),
            postcheck: columnExistsCheck(tb, cb.name, true, `column ${quoteIdent(cb.name)} exists`),
          },
          key,
          cb.name,
        );
        continue;
      }
      for (const op of alterColumnOps(key, tb, ca, cb)) add(op, key, cb.name);
    }
    for (const ca of ta.columns) {
      if (tb.columns.some((c) => c.name === ca.name)) continue;
      add(
        {
          kind: "dropColumn",
          description: `Drop column ${quoteIdent(ca.name)} of ${physicalTableRef(tb)}`,
          sql: [dropColumnSql(tb, ca.name)],
          destructive: true,
          table: key,
          postcheck: columnExistsCheck(tb, ca.name, false, `column ${quoteIdent(ca.name)} no longer exists`),
        },
        key,
        ca.name,
      );
    }

    // primary key
    if (!samePrimaryKey(ta.primaryKey, tb.primaryKey)) {
      if (ta.primaryKey) {
        add(
          {
            kind: "dropPrimaryKey",
            description: `Drop primary key of ${physicalTableRef(tb)}`,
            sql: [dropPrimaryKeySql(tb)],
            table: key,
          },
          key,
        );
      }
      if (tb.primaryKey) {
        add(
          {
            kind: "addPrimaryKey",
            description: `Add primary key (${tb.primaryKey.columns.map(quoteIdent).join(", ")}) to ${physicalTableRef(tb)}`,
            sql: [addPrimaryKeySql(tb, tb.primaryKey.name, tb.primaryKey.columns)],
            table: key,
            precheck: noDuplicatesCheck(tb, tb.primaryKey.columns),
          },
          key,
        );
      }
    }

    // uniques
    const u = matchNamed(ta.uniques, tb.uniques, (x, y) => sameColumns(x.columns, y.columns));
    for (const x of u.removed) {
      add({ kind: "dropUnique", description: `Drop unique constraint ${quoteIdent(x.name)} of ${physicalTableRef(tb)}`, sql: [dropConstraintSql(tb, x.name)], table: key }, key, x.name);
    }
    for (const y of u.added) {
      add(
        {
          kind: "addUnique",
          description: `Add unique constraint ${quoteIdent(y.name)} on ${physicalTableRef(tb)} (${y.columns.map(quoteIdent).join(", ")})`,
          sql: [addUniqueSql(tb, y.name, y.columns)],
          table: key,
          precheck: noDuplicatesCheck(tb, y.columns),
        },
        key,
        y.name,
      );
    }

    // indexes
    const ix = matchNamed(ta.indexes, tb.indexes, (x, y) => sameColumns(x.columns, y.columns));
    for (const x of ix.removed) {
      add({ kind: "dropIndex", description: `Drop index ${quoteIdent(x.name)} of ${physicalTableRef(tb)}`, sql: [dropIndexSql(tb.schema, x.name)], table: key }, key, x.name);
    }
    for (const y of ix.added) add(createIndexOp(key, tb, y.name, y.columns), key, y.name);

    // foreign keys
    const fks = matchNamed(ta.foreignKeys, tb.foreignKeys, sameForeignKey);
    const recreate = fks.kept.filter(([, y]) => fkTouchesRetyped(key, y));
    for (const x of [...fks.removed, ...recreate.map(([x]) => x)]) add(dropFkOp(key, tb, x), key, x.name);
    for (const y of [...fks.added, ...recreate.map(([, y]) => y)]) add(addFkOp(key, tb, y), key, y.name);
  }

  // dropped FKs of dropped tables were added above; sort into the final order
  const groupIndex = (k: string): number => GROUPS.indexOf(k as (typeof GROUPS)[number]);
  pending.sort((x, y) => groupIndex(x.op.kind) - groupIndex(y.op.kind) || cmp(x.sortKey, y.sortKey));
  return pending.map((p) => p.op);
}

function sanitizeRenames(from: PhysicalSchema, to: PhysicalSchema, renames: Renames): Renames {
  const out = emptyRenames();
  const targets = new Set<string>();
  for (const [fromKey, toKey] of Object.entries(renames.tables).sort(([x], [y]) => cmp(x, y))) {
    const t = from.tables[fromKey];
    const target = to.tables[toKey];
    if (!t || !target || fromKey === toKey || targets.has(toKey)) continue;
    if ((t.schema ?? "") !== (target.schema ?? "")) continue; // RENAME TABLE cannot move schemas
    if (from.tables[toKey] && !renames.tables[toKey]) continue; // target name still taken
    if (to.tables[fromKey]) continue; // source still wanted under its old name
    out.tables[fromKey] = toKey;
    targets.add(toKey);
  }
  const reverse = new Map(Object.entries(out.tables).map(([f, t]) => [t, f]));
  for (const [toKey, cols] of Object.entries(renames.columns).sort(([x], [y]) => cmp(x, y))) {
    const target = to.tables[toKey];
    const source = from.tables[reverse.get(toKey) ?? toKey];
    if (!target || !source) continue;
    const m: Record<string, string> = {};
    for (const [fc, tc] of Object.entries(cols).sort(([x], [y]) => cmp(x, y))) {
      if (fc === tc) continue;
      if (!source.columns.some((c) => c.name === fc)) continue;
      if (!target.columns.some((c) => c.name === tc)) continue;
      if (source.columns.some((c) => c.name === tc) && !cols[tc]) continue;
      if (target.columns.some((c) => c.name === fc)) continue;
      m[fc] = tc;
    }
    if (Object.keys(m).length) out.columns[toKey] = m;
  }
  return out;
}

function alterColumnOps(key: string, t: PhysicalTable, ca: PhysicalColumn, cb: PhysicalColumn): MigrationOp[] {
  const ref = physicalTableRef(t);
  const col = quoteIdent(cb.name);
  if (!!ca.identity !== !!cb.identity) {
    // HANA cannot add or remove IDENTITY with ALTER; the column has to be re-created.
    return [
      {
        kind: "alterColumn",
        description: `Re-create column ${col} of ${ref} (${cb.identity ? "now an identity column" : "no longer an identity column"}; existing values are lost)`,
        sql: [dropColumnSql(t, ca.name), addColumnSql(t, cb)],
        destructive: true,
        table: key,
        postcheck: columnExistsCheck(t, cb.name, true, `column ${col} exists`),
      },
    ];
  }
  const changes: string[] = [];
  let destructive = false;
  const typeChange = classifyTypeChange(ca.type, cb.type);
  if (typeChange !== "same") {
    changes.push(`type ${normalizeType(ca.type)} → ${normalizeType(cb.type)}${typeChange === "widening" ? "" : ` (${typeChange})`}`);
    if (typeChange !== "widening") destructive = true;
  }
  if (ca.nullable !== cb.nullable) {
    changes.push(cb.nullable ? "now nullable" : "now required (NOT NULL)");
    if (!cb.nullable) destructive = true;
  }
  if (normalizeDefaultSql(ca.default) !== normalizeDefaultSql(cb.default)) {
    changes.push(cb.default === undefined ? "default removed" : `default ${cb.default}`);
  }
  if (!changes.length) return [];
  const op: MigrationOp = {
    kind: "alterColumn",
    description: `Alter column ${col} of ${ref}: ${changes.join(", ")}`,
    sql: [alterColumnSql(t, cb)],
    table: key,
  };
  if (destructive) op.destructive = true;
  if (ca.nullable && !cb.nullable) op.precheck = noNullsCheck(t, cb.name);
  return [op];
}

function samePrimaryKey(a: PhysicalPrimaryKey | null, b: PhysicalPrimaryKey | null): boolean {
  if (!a || !b) return a === b;
  if (!sameColumns(a.columns, b.columns)) return false;
  // System-generated names (`_SYS_...`) are not compared.
  if (a.name && b.name && !a.name.startsWith("_SYS_") && !b.name.startsWith("_SYS_")) return a.name === b.name;
  return true;
}

function sameForeignKey(x: PhysicalForeignKey, y: PhysicalForeignKey): boolean {
  return (
    sameColumns(x.columns, y.columns) &&
    refKeyOf(x) === refKeyOf(y) &&
    sameColumns(x.refColumns, y.refColumns) &&
    x.onDelete === y.onDelete &&
    x.onUpdate === y.onUpdate
  );
}

/**
 * Matches objects by name first, then (leftovers) by structure. Objects matched by name but
 * structurally different are reported as removed + added. Objects matched only by structure
 * are kept (a renamed constraint alone is not migrated).
 */
function matchNamed<T extends { name: string }>(
  from: readonly T[],
  to: readonly T[],
  same: (x: T, y: T) => boolean,
): { removed: T[]; added: T[]; kept: [T, T][] } {
  const removed: T[] = [];
  const added: T[] = [];
  const kept: [T, T][] = [];
  const restFrom: T[] = [];
  const usedTo = new Set<T>();
  for (const x of from) {
    const y = to.find((t) => t.name === x.name);
    if (!y) {
      restFrom.push(x);
      continue;
    }
    usedTo.add(y);
    if (same(x, y)) kept.push([x, y]);
    else {
      removed.push(x);
      added.push(y);
    }
  }
  for (const x of restFrom) {
    const y = to.find((t) => !usedTo.has(t) && !from.some((f) => f.name === t.name) && same(x, t));
    if (y) {
      usedTo.add(y);
      kept.push([x, y]);
    } else removed.push(x);
  }
  for (const y of to) if (!usedTo.has(y) && !added.includes(y)) added.push(y);
  return { removed, added, kept };
}

function dropFkOp(key: string, t: { schema?: string; name: string }, fk: PhysicalForeignKey): MigrationOp {
  return {
    kind: "dropForeignKey",
    description: `Drop foreign key ${quoteIdent(fk.name)} of ${physicalTableRef(t)}`,
    sql: [dropConstraintSql(t, fk.name)],
    table: key,
  };
}

function addFkOp(key: string, t: { schema?: string; name: string }, fk: PhysicalForeignKey): MigrationOp {
  return {
    kind: "addForeignKey",
    description: `Add foreign key ${quoteIdent(fk.name)} on ${physicalTableRef(t)} (${fk.columns.map(quoteIdent).join(", ")}) → ${physicalTableRef({ schema: fk.refSchema, name: fk.refTable })}`,
    sql: [addForeignKeySql(t, fk)],
    table: key,
  };
}

function createIndexOp(key: string, t: { schema?: string; name: string }, name: string, columns: readonly string[]): MigrationOp {
  return {
    kind: "createIndex",
    description: `Create index ${quoteIdent(name)} on ${physicalTableRef(t)} (${columns.map(quoteIdent).join(", ")})`,
    sql: [createIndexSql(t, name, columns)],
    table: key,
  };
}

/** Exposed for callers that need the same key logic. */
export { keyOf, tableKey };
