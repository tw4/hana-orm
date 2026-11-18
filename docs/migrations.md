---
title: Migrations
nav_order: 5
---

# Migrations
{: .no_toc }

1. TOC
{:toc}

## The workflow

```sh
npx hana-orm migrate plan --name add_posts   # writes migrations/<timestamp>_add_posts/
npx hana-orm migrate show                    # prints the pending SQL
npx hana-orm migrate deploy                  # applies pending migrations
npx hana-orm migrate status                  # applied / pending / failed / drift
```

A migration folder holds:

| file | |
|---|---|
| `ops.json` | the operations with their literal HANA SQL — **what runs**, checksummed |
| `migration.sql` | the same SQL for review (or your hand-written SQL for `--empty`) |
| `contract.json` | the data model after this migration |

- **Planning needs no database**: it compares the previous migration's `contract.json` with the
  schema. Renames are detected (and asked for when ambiguous).
- **Each migration runs in one transaction with transactional DDL** (`SET TRANSACTION AUTOCOMMIT DDL OFF`),
  so a failure rolls the whole migration back. Each operation has pre- and post-checks (e.g. a
  table must not exist before `CREATE TABLE`).
- A lock (`_HANA_ORM_LOCK`) keeps two deploys apart; a running deploy refreshes it every 20 s and
  a lock without heartbeat for 2 minutes is taken over. `--wait <seconds>` waits for a live lock.
- Destructive changes (dropping tables or columns, narrowing types) need `--allow-destructive`.
- Migrations chain by contract hash: a migration planned on another branch is reported and must
  be re-planned on top of the latest one.

## Hand-written and data migrations

```sh
npx hana-orm migrate plan --name backfill --empty            # migration.sql is yours to write
npx hana-orm migrate plan --name backfill --empty --script   # migration.ts runs in the transaction
```

```ts
// migration.ts
import type { MigrationScript } from "hana-orm/migrate";
const migration: MigrationScript = async ({ query, execute, log }) => {
  const rows = await query<{ ID: number }>('SELECT "ID" FROM "USERS" WHERE "DISPLAY_NAME" IS NULL');
  for (const r of rows) await execute('UPDATE "USERS" SET "DISPLAY_NAME" = ? WHERE "ID" = ?', [`user-${r.ID}`, r.ID]);
  log(`${rows.length} users updated`);
};
export default migration;
```

## Existing databases

```sh
npx hana-orm db pull            # models for the existing tables (--tables, --exclude, --db-schema, --views)
npx hana-orm migrate baseline   # the first migration, recorded as applied without running it
```

## Drift and comparisons

`migrate status` compares the database with the last applied migration and fails when the schema
has changes without a migration (useful in CI). `db verify` compares it with the schema.

```sh
npx hana-orm migrate diff --from migrations --to schema            # what the next migration would do
npx hana-orm migrate diff --from db --to schema --script           # SQL to bring the database to the schema
npx hana-orm migrate diff --from migrations --to db --exit-code    # exit 2 on drift
```

Sources: `empty`, `schema`, `migrations`, `migrations:<id>`, `db`. Against `db`, only tables the
other side defines are compared, so unrelated tables in a shared schema are ignored.

## Fixing the history

```sh
npx hana-orm migrate resolve --applied <id>       # the change was made by hand
npx hana-orm migrate resolve --rolled-back <id>   # a failed migration was cleaned up
npx hana-orm migrate unlock                       # release a stale lock
```

## Prototyping and development databases

- `db push` applies the schema directly, without migration history.
- `migrate reset` drops the project's tables, re-applies every migration and runs the seed
  command. It refuses non-local hosts unless `--allow-remote` and asks for confirmation unless
  `--force`.
- `db seed` runs the seed command (`seed = "…"` in the generator block) with `.env` loaded.

## Housekeeping tables

In the default schema: `_HANA_ORM_MIGRATIONS` (history with checksums), `_HANA_ORM_LOCK`,
`_HANA_ORM_MARKER` (the contract hash the database was last brought to).
