---
title: Drift and diffs
parent: Migrations
nav_order: 4
---

# Drift and diffs
{: .no_toc }

1. TOC
{:toc}

**Drift** is a difference between what the database looks like and what it should look like:
someone added an index by hand, a hotfix changed a column, a migration was skipped.

## migrate status

```sh
npx hana-orm migrate status
```

```
  applied     20261119093000_init
  applied     20261120101500_add_post_views
  pending     20261121080000_backfill_display_name
Database marker: contract 245765533562 (migration 20261120101500_add_post_views).
warning: Drift: the database differs from migration 20261120101500_add_post_views in 1 place(s):
warning:   - Drop index "IX_POST_MANUAL" on "Post"
warning: The schema has 1 change(s) without a migration; run `hana-orm migrate plan --name <name>`.
```

`migrate status` shows:

- every migration with its state: `applied`, `pending`, `failed`, `rolled_back` (marked with
  `resolve --rolled-back`) or `modified` (edited after it was applied);
- problems that would stop a deploy, such as applied migrations whose folders are missing or
  migrations out of order;
- the database marker;
- drift: the database compared with the last applied migration's contract;
- unplanned changes: the schema compared with the latest migration.

It exits with 1 when anything needs attention, including pending migrations, so it can guard a
CI pipeline after the deploy step:

```yaml
- run: npx hana-orm migrate status
```

## db verify

```sh
npx hana-orm db verify
```

Compares the database with the **schema** (not with the migrations) and checks the marker:

```
Contract marker matches (245765533562).
No drift: tables match the schema.
```

Use it where the schema is the source of truth, for example in a project that uses `db push`, or
to check that a database fits the client an application was built with. It exits with 1 on a
mismatch.

## migrate diff

`migrate diff` compares any two states and never changes the database:

```sh
npx hana-orm migrate diff --from migrations --to schema            # what the next migration would do
npx hana-orm migrate diff --from db --to schema --script           # SQL that brings the database to the schema
npx hana-orm migrate diff --from empty --to schema --script > init.sql
npx hana-orm migrate diff --from migrations --to db --exit-code    # exit 2 when the database drifted
npx hana-orm migrate diff --from migrations:20261120101500 --to migrations
```

| source | state |
|---|---|
| `empty` | an empty database |
| `schema` | the current schema |
| `migrations` | the contract of the latest migration |
| `migrations:<id>` | the contract of one migration (id or prefix) |
| `db` | the live database |

- Without `--script` it lists the operations; with `--script` it prints the SQL.
- `--exit-code` exits with 2 when there are differences (0 when there are none).
- A connection is only needed when one side is `db`. Against `db`, only the tables the other
  side defines are compared, so other tables in a shared schema are not reported.

## Fixing drift

| situation | fix |
|---|---|
| a change made by hand should stay | add it to the schema and plan a migration; if the database already has it, `migrate resolve --applied` that migration on that database |
| a change made by hand should go | undo it in the database (`db execute --file fix.sql`) |
| a migration was skipped | `migrate deploy` |
| the schema has changes without a migration | `migrate plan` |
