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
import { dbSeed } from "./seed.ts";
import { migrateReset } from "./reset.ts";
import { dbExecute, migrateDiff } from "./diff-command.ts";

export const DB_MIGRATE_HELP = `Database commands:
  db pull [--tables A,B] [--exclude X] [--db-schema S] [--views] [--print]
                              Introspect the database and write models into the schema file.
                              Patterns are comma separated and may use * and ?.
  db push [--allow-destructive] [--dry-run]
                              Apply the schema directly to the database (no migration history).
  db sign                     Write the schema's contract hash into the database marker.
  db verify                   Check the marker hash and compare tables with the schema (drift).
  db seed                     Run the seed command with the .env loaded. Configure it as
                              seed = "node ./seed.ts" in the generator block, or as
                              "hana-orm": { "seed": "..." } in package.json.
  db execute --file <script.sql> | --stdin
                              Run a SQL script with the configured connection. All statements
                              run in one transaction (DDL included); nothing is committed when
                              one fails.

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
  migrate diff --from <source> --to <source> [--script] [--exit-code]
                              Show the changes that turn one state into another. A source is
                              empty, schema, migrations (the latest migration), migrations:<id>
                              or db (the live database; only the tables the other side defines
                              are compared). --script prints SQL; --exit-code exits with 2 when
                              there are changes. A connection is needed only for db.
  migrate reset [--force] [--schema-drop] [--skip-seed] [--allow-remote]
                              Development only: drop the project's tables (every table of every
                              migration and the schema, plus the _HANA_ORM_* tables), re-apply all
                              migrations and run the seed command. --schema-drop drops every table,
                              view and sequence of the schemas the project uses instead. Asks for
                              confirmation unless --force; refuses non-local hosts (anything but
                              localhost, 127.0.0.1, ::1) unless --allow-remote.
`;

type Command = (args: ParsedArgs, ctx: CliContext) => Promise<number>;

const COMMANDS: Record<"db" | "migrate", Record<string, Command>> = {
  db: { pull: dbPull, push: dbPush, sign: dbSign, verify: dbVerify, seed: dbSeed, execute: (a, c) => dbExecute(a, c) },
  migrate: {
    plan: (a, c) => migratePlan(a, c),
    show: migrateShow,
    deploy: migrateDeploy,
    status: migrateStatus,
    resolve: migrateResolve,
    baseline: (a, c) => migrateBaseline(a, c),
    unlock: migrateUnlock,
    reset: migrateReset,
    diff: migrateDiff,
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
