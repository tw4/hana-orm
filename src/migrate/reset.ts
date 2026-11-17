/**
 * `hana-orm migrate reset`: drop what the migrations own, re-apply every migration, seed.
 *
 * Meant for development databases only:
 * - refuses outright when the connection host is not local (localhost, 127.0.0.1, ::1)
 *   unless `--allow-remote` is passed;
 * - asks for confirmation unless `--force` is passed (and refuses when it cannot ask).
 *
 * By default only tables known to the project are dropped: every table of every migration
 * snapshot and of the current schema, plus the `_HANA_ORM_*` housekeeping tables. With
 * `--schema-drop` every table, view and sequence of the schemas the project uses is dropped.
 */

import type { CliContext, ParsedArgs } from "../cli/context.ts";
import type { Driver } from "../runtime/driver.ts";
import { quoteIdent } from "../runtime/sql.ts";
import { currentSchema, introspect } from "../introspect/catalog.ts";
import { contractToPhysical } from "./contract-to-physical.ts";
import { contractSchemas } from "./drift.ts";
import type { LoadedMigration } from "./files.ts";
import { readMigrations, readSnapshot, verifyGraph } from "./files.ts";
import { HOUSEKEEPING_TABLES } from "./history.ts";
import { migrateDeploy } from "./commands.ts";
import { runSeed } from "./seed.ts";
import type { Contract } from "../schema/contract.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.trim().toLowerCase());
}

export interface DropTarget {
  kind: "TABLE" | "VIEW" | "SEQUENCE";
  schema: string;
  name: string;
}

function ref(t: DropTarget): string {
  return `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
}

export function dropSql(t: DropTarget): string {
  return t.kind === "SEQUENCE" ? `DROP SEQUENCE ${ref(t)}` : `DROP ${t.kind} ${ref(t)} CASCADE`;
}

function flagSet(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  return v === true || v === "true";
}

/** Tables the project owns: all migration snapshots, the current schema and housekeeping. */
async function ownedTables(db: Driver, migrations: readonly LoadedMigration[], contract: Contract | undefined, defaultSchema: string): Promise<DropTarget[]> {
  const keys = new Set<string>();
  const schemas = new Set<string>([defaultSchema]);
  const add = (c: Pick<Contract, "models" | "enums">) => {
    for (const k of Object.keys(contractToPhysical(c, { defaultSchema }).tables)) keys.add(k);
    for (const s of contractSchemas(c, defaultSchema)) schemas.add(s);
  };
  for (const m of migrations) add(await readSnapshot(m));
  if (contract) add(contract);
  const live = await introspect(db, { schemas: [...schemas], defaultSchema, onlyTables: keys });
  const out: DropTarget[] = Object.values(live.tables).map((t) => ({ kind: "TABLE" as const, schema: t.schema ?? defaultSchema, name: t.name }));
  // introspection hides the housekeeping tables, so look them up directly
  const housekeeping = await db.query<{ TABLE_NAME: string }>(
    `SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME IN (${HOUSEKEEPING_TABLES.map(() => "?").join(", ")}) ORDER BY TABLE_NAME`,
    [defaultSchema, ...HOUSEKEEPING_TABLES],
  );
  for (const r of housekeeping) out.push({ kind: "TABLE", schema: defaultSchema, name: r.TABLE_NAME });
  return out;
}

/** Every table, view and (non-identity) sequence in the given schemas. */
async function everything(db: Driver, schemas: readonly string[]): Promise<DropTarget[]> {
  const out: DropTarget[] = [];
  for (const schema of schemas) {
    for (const r of await db.query<{ VIEW_NAME: string }>("SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME", [schema])) {
      out.push({ kind: "VIEW", schema, name: r.VIEW_NAME });
    }
    for (const r of await db.query<{ TABLE_NAME: string }>(
      "SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND IS_USER_DEFINED_TYPE = 'FALSE' ORDER BY TABLE_NAME",
      [schema],
    )) {
      out.push({ kind: "TABLE", schema, name: r.TABLE_NAME });
    }
    for (const r of await db.query<{ SEQUENCE_NAME: string }>(
      "SELECT SEQUENCE_NAME FROM SYS.SEQUENCES WHERE SCHEMA_NAME = ? AND SEQUENCE_NAME NOT LIKE '\\_SYS\\_%' ESCAPE '\\' ORDER BY SEQUENCE_NAME",
      [schema],
    )) {
      out.push({ kind: "SEQUENCE", schema, name: r.SEQUENCE_NAME });
    }
  }
  return out;
}

const MAX_LISTED = 20;

export async function migrateReset(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const host = await ctx.connectionHost();
  if (!isLocalHost(host) && !flagSet(args, "allow-remote")) {
    ctx.warn(
      `migrate reset refuses to run against '${host}': it drops tables and is meant for local development databases ` +
        "(localhost, 127.0.0.1, ::1). Pass --allow-remote if this really is a disposable database.",
    );
    return 1;
  }
  const migrations = await readMigrations(ctx.migrationsDir);
  const graph = verifyGraph(migrations);
  if (graph.length) {
    for (const g of graph) ctx.warn(g.message);
    return 1;
  }
  let contract: Contract | undefined;
  try {
    contract = await ctx.loadContract();
  } catch (e) {
    ctx.warn(`Could not load the schema; only tables from migrations are dropped: ${(e as Error).message}`);
  }
  const schemaDrop = flagSet(args, "schema-drop");

  const db = await ctx.connect();
  let dropped: DropTarget[];
  try {
    const defaultSchema = (await ctx.defaultSchema()) ?? (await currentSchema(db));
    let targets: DropTarget[];
    if (schemaDrop) {
      const schemas = new Set([defaultSchema]);
      for (const m of migrations) for (const s of contractSchemas(await readSnapshot(m), defaultSchema)) schemas.add(s);
      if (contract) for (const s of contractSchemas(contract, defaultSchema)) schemas.add(s);
      targets = await everything(db, [...schemas].sort());
    } else targets = await ownedTables(db, migrations, contract, defaultSchema);

    const what = schemaDrop ? "every table, view and sequence" : "the project's tables";
    ctx.log(`migrate reset on ${host} drops ${what} (${targets.length} object(s)), then re-applies ${migrations.length} migration(s):`);
    for (const t of targets.slice(0, MAX_LISTED)) ctx.log(`  - ${t.kind.toLowerCase()} ${t.schema}.${t.name}`);
    if (targets.length > MAX_LISTED) ctx.log(`  … and ${targets.length - MAX_LISTED} more`);

    if (!flagSet(args, "force") && !(await ctx.confirm("All data in these objects will be lost. Reset the database?", false))) {
      ctx.warn("Reset cancelled. In non-interactive shells pass --force.");
      return 1;
    }
    for (const t of targets) await db.execute(dropSql(t));
    dropped = targets;
  } finally {
    await db.close();
  }
  ctx.log(`Dropped ${dropped.length} object(s).`);

  if (!migrations.length) ctx.log(`No migrations in ${ctx.migrationsDir}; nothing to re-apply.`);
  else {
    const code = await migrateDeploy(args, ctx);
    if (code !== 0) return code;
  }
  if (flagSet(args, "skip-seed")) return 0;
  return runSeed(ctx, { required: false });
}
