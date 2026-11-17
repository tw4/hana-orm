/** `hana-orm migrate diff` and `hana-orm db execute`. */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CliContext, ParsedArgs } from "../cli/context.ts";
import type { Driver } from "../runtime/driver.ts";
import type { Contract } from "../schema/contract.ts";
import { currentSchema, introspect } from "../introspect/catalog.ts";
import { contractToPhysical } from "./contract-to-physical.ts";
import { diffSchemas } from "./diff.ts";
import { contractSchemas } from "./drift.ts";
import { readMigrations, readSnapshot } from "./files.ts";
import type { MigrationOp } from "./ops.ts";
import { opsToSql } from "./ops.ts";
import { emptyPhysical } from "./physical.ts";
import type { PhysicalSchema } from "./physical.ts";
import { renamesFromContracts } from "./renames.ts";
import { splitSqlStatements } from "./sql-split.ts";

type Model = Pick<Contract, "models" | "enums">;

/** One side of `migrate diff`, as given on the command line. */
export type DiffSource = { kind: "empty" } | { kind: "schema" } | { kind: "migrations"; id?: string } | { kind: "db" };

export const DIFF_SOURCES = "empty, schema, migrations, migrations:<id> or db";

export function parseDiffSource(value: string | boolean | undefined): DiffSource | string {
  if (typeof value !== "string" || !value) return `expects one of ${DIFF_SOURCES}`;
  if (value === "empty" || value === "schema" || value === "db") return { kind: value };
  if (value === "migrations") return { kind: "migrations" };
  if (value.startsWith("migrations:") && value.length > "migrations:".length) return { kind: "migrations", id: value.slice("migrations:".length) };
  return `'${value}' is not one of ${DIFF_SOURCES}`;
}

function describe(s: DiffSource): string {
  return s.kind === "migrations" ? (s.id ? `migration ${s.id}` : "the latest migration") : s.kind === "db" ? "the database" : s.kind === "schema" ? "the schema" : "an empty database";
}

/** Resolves a non-database source to a contract model (`null` for an empty database). */
async function loadModel(ctx: CliContext, s: Exclude<DiffSource, { kind: "db" }>): Promise<Model | null> {
  if (s.kind === "empty") return null;
  if (s.kind === "schema") return ctx.loadContract();
  const migrations = await readMigrations(ctx.migrationsDir);
  if (!s.id) return migrations.length ? readSnapshot(migrations.at(-1)!) : null;
  const matches = migrations.filter((m) => m.id === s.id || m.id.startsWith(s.id!));
  const exact = matches.find((m) => m.id === s.id);
  if (!exact && matches.length !== 1) throw new Error(matches.length ? `'${s.id}' matches ${matches.length} migrations; use a longer prefix.` : `No migration matches '${s.id}'.`);
  return readSnapshot(exact ?? matches[0]!);
}

const INTERNAL_TABLE = /^_HANA_ORM_/;

/**
 * Introspects the live side. Only the schemas and tables the other side knows are read, so
 * unrelated tables in a shared schema are not reported. Against an empty model every table
 * of the default schema (except the `_HANA_ORM_*` bookkeeping tables) is read.
 */
async function introspectFor(db: Driver, other: Model | null, otherPhys: PhysicalSchema, defaultSchema: string): Promise<PhysicalSchema> {
  if (!other || !Object.keys(otherPhys.tables).length) {
    return introspect(db, { schemas: [defaultSchema], defaultSchema, filter: (name) => !INTERNAL_TABLE.test(name) });
  }
  return introspect(db, { schemas: contractSchemas(other, defaultSchema), defaultSchema, onlyTables: new Set(Object.keys(otherPhys.tables)) });
}

export interface DiffOutcome {
  ops: MigrationOp[];
}

/** Computes the ops that turn `from` into `to`. Opens a connection only when a side is `db`. */
export async function computeDiff(ctx: CliContext, from: DiffSource, to: DiffSource): Promise<DiffOutcome> {
  if (from.kind === "db" && to.kind === "db") throw new Error("--from db and --to db compare the database with itself.");
  const fromModel = from.kind === "db" ? null : await loadModel(ctx, from);
  const toModel = to.kind === "db" ? null : await loadModel(ctx, to);
  const configured = await ctx.defaultSchema();

  const physical = (m: Model | null, defaultSchema: string | undefined): PhysicalSchema =>
    m ? contractToPhysical(m, defaultSchema ? { defaultSchema } : {}) : emptyPhysical();

  if (from.kind !== "db" && to.kind !== "db") {
    const renames = fromModel && toModel ? renamesFromContracts(fromModel, toModel, configured) : undefined;
    const opts = configured ? { defaultSchema: configured } : {};
    return { ops: diffSchemas(physical(fromModel, configured), physical(toModel, configured), { ...(renames ? { renames } : {}), ...opts }) };
  }

  const db = await ctx.connect();
  try {
    const defaultSchema = configured ?? (await currentSchema(db));
    const opts = { defaultSchema };
    if (from.kind === "db") {
      const toPhys = physical(toModel, defaultSchema);
      return { ops: diffSchemas(await introspectFor(db, toModel, toPhys, defaultSchema), toPhys, opts) };
    }
    const fromPhys = physical(fromModel, defaultSchema);
    return { ops: diffSchemas(fromPhys, await introspectFor(db, fromModel, fromPhys, defaultSchema), opts) };
  } finally {
    await db.close();
  }
}

function flagValue(args: ParsedArgs, name: string): string | boolean | undefined {
  return args.flags[name];
}

function isSet(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((n) => args.flags[n] === true || args.flags[n] === "true");
}

/** Exit code of `migrate diff --exit-code` when the two sides differ. */
export const DIFF_EXIT_CODE = 2;

export async function migrateDiff(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const from = parseDiffSource(flagValue(args, "from"));
  const to = parseDiffSource(flagValue(args, "to"));
  if (typeof from === "string" || typeof to === "string") {
    if (typeof from === "string") ctx.warn(`--from ${from}.`);
    if (typeof to === "string") ctx.warn(`--to ${to}.`);
    ctx.warn("Usage: hana-orm migrate diff --from <source> --to <source> [--script] [--exit-code]");
    return 1;
  }
  const { ops } = await computeDiff(ctx, from, to);
  const exit = ops.length && isSet(args, "exit-code", "exitCode") ? DIFF_EXIT_CODE : 0;
  if (isSet(args, "script")) {
    ctx.log(ops.length ? opsToSql(ops) : "-- No difference.");
    return exit;
  }
  if (!ops.length) {
    ctx.log(`No difference between ${describe(from)} and ${describe(to)}.`);
    return 0;
  }
  ctx.log(`${ops.length} change(s) from ${describe(from)} to ${describe(to)}:`);
  for (const op of ops) ctx.log(`  ${op.destructive ? "!" : "-"} ${op.description}`);
  return exit;
}

/** Reads all of stdin. Separate so tests can replace `process.stdin`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function dbExecute(args: ParsedArgs, ctx: CliContext, stdin: () => Promise<string> = readStdin): Promise<number> {
  const file = flagValue(args, "file");
  const fromStdin = isSet(args, "stdin");
  if ((typeof file !== "string" || !file) === !fromStdin) {
    ctx.warn("Usage: hana-orm db execute --file <script.sql> | --stdin");
    return 1;
  }
  const script = fromStdin ? await stdin() : await readFile(isAbsolute(file as string) ? (file as string) : resolve(ctx.cwd, file as string), "utf8");
  const statements = splitSqlStatements(script);
  if (!statements.length) {
    ctx.warn("The script contains no SQL statements.");
    return 1;
  }
  const db = await ctx.connect();
  try {
    let failedAt = -1;
    try {
      await db.transaction(
        async (tx) => {
          for (const [i, sql] of statements.entries()) {
            failedAt = i;
            await tx.execute(sql);
          }
          failedAt = -1;
        },
        { transactionalDdl: true },
      );
    } catch (e) {
      const message = (e as Error).message;
      if (failedAt < 0) {
        ctx.warn(`The commit failed, nothing was committed: ${message}`);
        return 1;
      }
      const sql = statements[failedAt]!;
      ctx.warn(`Statement ${failedAt + 1} of ${statements.length} failed, nothing was committed: ${message}`);
      ctx.warn(`  ${sql.length > 200 ? sql.slice(0, 200) + "…" : sql}`);
      return 1;
    }
    ctx.log(`Executed ${statements.length} statement(s).`);
    return 0;
  } finally {
    await db.close();
  }
}
