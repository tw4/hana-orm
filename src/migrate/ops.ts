/** Operations stored in `ops.json`. Every op carries the literal HANA SQL it runs. */

export type OpKind =
  | "renameTable"
  | "renameColumn"
  | "renameIndex"
  | "dropForeignKey"
  | "dropIndex"
  | "dropUnique"
  | "dropPrimaryKey"
  | "dropTable"
  | "createTable"
  | "addColumn"
  | "alterColumn"
  | "dropColumn"
  | "addPrimaryKey"
  | "addUnique"
  | "createIndex"
  | "addForeignKey"
  | "dropCheck"
  | "addCheck"
  | "createSequence"
  | "alterSequence"
  | "dropSequence"
  /** `COMMENT ON TABLE` / `COMMENT ON COLUMN` (from `///` doc comments). */
  | "setComment"
  /** Hand-written SQL read from a file in the migration folder (`migrate plan --empty`). */
  | "sqlFile"
  /** A TypeScript/JavaScript data migration in the migration folder (`migrate plan --script`). */
  | "script";

/**
 * A query run before (precheck) or after (postcheck) an op. `expect: "empty"` passes when
 * the query returns no rows, `"nonEmpty"` when it returns at least one.
 */
export interface Check {
  description: string;
  sql: string;
  params?: (string | number | boolean | null)[];
  expect: "empty" | "nonEmpty";
}

export interface MigrationOp {
  kind: OpKind;
  description: string;
  /** Statements without trailing `;`, run in order. */
  sql: string[];
  /** Can lose data or fail on existing data; needs `--allow-destructive`. */
  destructive?: boolean;
  precheck?: Check;
  postcheck?: Check;
  /** Table key the op works on (for grouping and messages). */
  table?: string;
  /** For `sqlFile` and `script`: file name relative to the migration folder. */
  file?: string;
}

export const OPS_FORMAT_VERSION = 1;

export interface OpsFile {
  formatVersion: typeof OPS_FORMAT_VERSION;
  id: string;
  name: string;
  /** Contract hash before the migration; null for the first migration. */
  from: string | null;
  /** Contract hash after the migration. */
  to: string;
  ops: MigrationOp[];
}

export function destructiveOps(ops: readonly MigrationOp[]): MigrationOp[] {
  return ops.filter((o) => o.destructive);
}

/** Message listing destructive operations, one per line. */
export function destructiveMessage(ops: readonly MigrationOp[]): string {
  const list = destructiveOps(ops).map((o) => `  - ${o.description}`);
  return [
    `The migration contains ${list.length} destructive operation(s) that can lose data or fail on existing rows:`,
    ...list,
    "Re-run with --allow-destructive to accept them.",
  ].join("\n");
}

/** SQL script for review (`migration.sql`, `migrate show`). */
export function opsToSql(ops: readonly MigrationOp[]): string {
  const out: string[] = [];
  for (const op of ops) {
    out.push(`-- ${op.description}${op.destructive ? " [destructive]" : ""}`);
    if (op.kind === "sqlFile") {
      out.push(`-- (statements from ${op.file})`);
    }
    if (op.kind === "script") {
      out.push(`-- (runs ${op.file} in the same transaction)`);
    }
    for (const s of op.sql) out.push(`${s};`);
    out.push("");
  }
  return out.join("\n");
}
