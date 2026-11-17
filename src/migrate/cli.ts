/** Entry point for `hana-orm db …` and `hana-orm migrate …`. */

import type { CliContext, ParsedArgs } from "../cli/context.ts";
import {
  dbPull,
  dbPush,
  dbSign,
  dbVerify,
  migrateBaseline,
  migrateDeploy,
  migratePlan,
  migrateResolve,
  migrateShow,
  migrateStatus,
  migrateUnlock,
} from "./commands.ts";

export const DB_MIGRATE_HELP = `Database commands:
  db pull [--tables A,B] [--exclude X] [--db-schema S] [--views] [--print]
                              Introspect the database and write models into the schema file.
                              Patterns are comma separated and may use * and ?.
  db push [--allow-destructive] [--dry-run]
                              Apply the schema directly to the database (no migration history).
  db sign                     Write the schema's contract hash into the database marker.
  db verify                   Check the marker hash and compare tables with the schema (drift).

Migration commands:
  migrate plan --name <name> [--allow-destructive] [--empty] [--script]
                              Write migrations/<timestamp>_<name>/ (ops.json, migration.sql,
                              contract.json) from the change since the latest migration.
                              No database connection is needed.
  migrate show [id]           Print the SQL of pending migrations, or of one migration.
  migrate deploy [--wait <seconds>]
                              Apply pending migrations in order, each in its own transaction.
                              Waits for a running deploy when --wait is given; a lock without
                              heartbeat for 2 minutes is taken over automatically.
  migrate status              Show applied, pending, failed and modified migrations and drift.
  migrate resolve --applied <id> | --rolled-back <id>
                              Fix the migration history by hand.
  migrate baseline [--name init]
                              Create the first migration from the schema and record it as
                              applied without running it (for existing databases).
  migrate unlock              Release a stale migration lock.
`;

type Command = (args: ParsedArgs, ctx: CliContext) => Promise<number>;

const COMMANDS: Record<"db" | "migrate", Record<string, Command>> = {
  db: { pull: dbPull, push: dbPush, sign: dbSign, verify: dbVerify },
  migrate: {
    plan: (a, c) => migratePlan(a, c),
    show: migrateShow,
    deploy: migrateDeploy,
    status: migrateStatus,
    resolve: migrateResolve,
    baseline: (a, c) => migrateBaseline(a, c),
    unlock: migrateUnlock,
  },
};

export async function runDbOrMigrateCommand(group: "db" | "migrate", sub: string, args: ParsedArgs, ctx: CliContext): Promise<number> {
  const cmd = COMMANDS[group][sub];
  if (!cmd) {
    ctx.warn(sub ? `Unknown command '${group} ${sub}'.` : `Missing ${group} subcommand.`);
    ctx.log(DB_MIGRATE_HELP);
    return 1;
  }
  try {
    return await cmd(args, ctx);
  } catch (e) {
    ctx.warn(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
