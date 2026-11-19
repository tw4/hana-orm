---
title: Fixing the history
description: "Unblock a deploy, resolve failed migrations, release locks, and squash or split migrations."
sidebar:
  order: 5
---

The migration history lives in `_HANA_ORM_MIGRATIONS` in the default schema: one row per
applied migration, with its checksum and contract hashes. These commands change it.

## When a deploy is blocked

`migrate deploy` checks the history before it applies anything and stops when something is off:

```
warning: migrate deploy stopped before applying anything:
warning:   - Migration 20261120101500_add_post_views was changed after it was applied (checksum 1a2b3c4d5e6f in the database, 7a8b9c0d1e2f on disk). Restore the original files.
```

| message | cause | fix |
|---|---|---|
| changed after it was applied | the folder was edited | restore the files from Git |
| applied in the database but its folder is missing | a migration was deleted or not merged | restore the folder |
| not applied but older than the last applied migration | merged from another branch after a later one was deployed | re-plan it on top, or `resolve --applied` if its change is already there |
| starts from contract … but the database is at … | the chain does not fit this database | find the missing migration |

## A migration failed

A failed migration is rolled back completely and recorded as `failed`:

```
warning: Migration 20261121080000_backfill failed and was rolled back: unique constraint violated: …
```

Fix the cause (the data, or the migration if it has not been applied anywhere else) and run
`migrate deploy` again; a failed migration is retried.

## migrate resolve

```sh
npx hana-orm migrate resolve --applied 20261121080000_backfill
npx hana-orm migrate resolve --rolled-back 20261121080000_backfill
```

- `--applied` records a migration as applied without running it: its change was made by hand,
  or the database is a copy of one where it ran.
- `--rolled-back` records that a failed migration was cleaned up; `deploy` will try it again.

## migrate unlock

```sh
npx hana-orm migrate unlock
```

Deploys take a lock in `_HANA_ORM_LOCK` and refresh it every 20 seconds. A lock without a
heartbeat for 2 minutes is taken over automatically, so `unlock` is only needed when you are
sure no deploy is running and do not want to wait.

## Squashing migrations

Many small migrations can be combined into one:

```sh
npx hana-orm migrate squash --from 20261101 --to 20261115 --name q4_schema   # ids may be prefixes
```

- The new migration contains the operations of the whole range. It keeps the first one's
  starting hash and the last one's ending hash, so the migrations around it still chain.
- Hand-written SQL and data scripts are copied along as `<old id>_migration.sql` /
  `<old id>_migration.ts`.
- Its `ops.json` lists the migrations it replaces, with their checksums. A database that applied
  all of them treats the new migration as applied; their history rows are not reported as
  missing. A database that applied only some of them is reported, and `deploy` stops.
- Squash refuses when the configured database has the range applied, unless you pass
  `--baseline`, which records the new migration there as applied without running it.

## Splitting a migration

```sh
npx hana-orm migrate split 20261117093000_init --at 3      # a new part starts at operation 3
npx hana-orm migrate split 20261117093000_init --at 3,7
npx hana-orm migrate split 20261117093000_init             # one migration per operation
```

Operation numbers start at 1, in `ops.json` order. The parts are chained through generated
contract hashes; parts before the last carry the final `contract.json`. The same rules for
applied migrations and `--baseline` apply as for squash.

Splitting helps when one part of a large migration must be deployed separately, or to find which
operation of a failing migration is the problem.
