---
title: Migration files
sidebar:
  order: 1
---

## A migration folder

```
migrations/
└── 20261120101500_add_post_views/
    ├── ops.json        # the operations with their SQL: what deploy runs (checksummed)
    ├── migration.sql   # the same SQL, for review
    └── contract.json   # the data model after this migration
```

- The folder name is `<UTC timestamp>_<name>`. Migrations run in name order.
- **`ops.json` is what runs.** It lists the operations with a description, the literal SQL,
  and pre- and post-checks.
- **`migration.sql` is for review.** For a generated migration it is written from `ops.json`;
  changing it has no effect. For an [`--empty` migration](/hana-orm/migrations/custom/) it is the file you write,
  and it is what runs.
- **`contract.json`** is the data model after the migration. The next `migrate plan` compares
  the schema with it, which is why planning needs no database.

`migration.sql` of the example:

```sql
-- Migration 20261120101500_add_post_views
-- from contract 8a7169b4eb7849bd186a298e1ae856175f7f3c642e49fd92cd4c6660ba2dcf82
-- to   contract 245765533562bb121657ba038878d1c475ff9a028f38337a4e570f5b841dc881
-- Generated from ops.json for review. Edits here are ignored; ops.json is what runs.
-- Add column "views" to "Post"
ALTER TABLE "Post" ADD ("views" INTEGER DEFAULT 0 NOT NULL);

-- Create index "IX_Post_views" on "Post" ("views")
CREATE INDEX "IX_Post_views" ON "Post" ("views");
```

Tables in the datasource's default schema are not qualified: migrations run with that schema as
the current schema. Tables of models with `@@schema` are qualified (`"SALES"."ORDERS"`).

Commit the whole folder. Never edit or delete a migration that has been deployed anywhere; plan
a new one instead.

## What planning detects

| schema change | migration |
|---|---|
| new model | `CREATE TABLE` with primary key, uniques, foreign keys, indexes, comments |
| removed model | `DROP TABLE` (destructive) |
| new field | `ALTER TABLE … ADD` |
| removed field | `ALTER TABLE … DROP` (destructive) |
| changed type | `ALTER TABLE … ALTER`; narrowing or incompatible changes are destructive |
| optional → required | `ALTER … NOT NULL`; destructive, because it fails when rows contain `NULL` |
| changed default | `ALTER … DEFAULT` |
| `@map` / `@@map` changed | `RENAME COLUMN` / `RENAME TABLE` |
| `@@schema` changed | the table is moved to the other schema |
| new / removed index, unique, foreign key, check, full-text index | `CREATE` / `DROP` / `ALTER TABLE … ADD CONSTRAINT` |
| changed `///` docs | `COMMENT ON` |
| new / changed sequence | `CREATE SEQUENCE` / `ALTER SEQUENCE` |
| implicit many-to-many | the `_AToB` join table |

Changes that only affect the client (a relation field's name, `@ignore`, an enum value, a
generator option) produce no migration: `migrate plan` says the schema changed but no database
change is needed.

## Renames

hana-orm cannot always tell a rename from a drop plus an add, so it works like this:

- **Changing `@map` or `@@map`** while the field or model keeps its name is a certain rename:
  `RENAME COLUMN` / `RENAME TABLE`. The data is kept.
- **Renaming a field or model** while the column type stays the same looks like "drop one, add
  one with the same type". `migrate plan` asks:

```
Column "title" of "Post" is dropped and "headline" is added with the same type. Is it a rename?
```

  Answer `y` to get a `RENAME COLUMN`. In a non-interactive shell the answer is "no": the change
  is then a drop plus an add, which is destructive and refused without `--allow-destructive`.
  Plan renames in an interactive terminal.

:::tip
The safest way to rename a field in code without touching the database is to keep the column
name: `headline String @map("title")`. No migration is needed at all.
:::

## Destructive changes

Dropping tables or columns and narrowing types can lose data. `migrate plan` refuses them unless
you pass `--allow-destructive`:

```
warning: The migration contains 1 destructive operation(s) that can lose data or fail on existing rows:
  - Drop column "legacyKey" of "User"
Re-run with --allow-destructive to accept them.
```

```sh
npx hana-orm migrate plan --name drop_legacy_key --allow-destructive
```

Review these migrations carefully, and think about the order of deploys: drop a column only
after the application version that stopped using it is live everywhere.

## Changes that need data

Some changes cannot be made by DDL alone:

- **A new required field without a default** on a table with rows: HANA cannot add a
  `NOT NULL` column without a value. Add it as optional, fill it in a
  [data migration](/hana-orm/migrations/custom/), then make it required in a later migration. Or give it a
  default.
- **Splitting or merging columns, changing value formats**: add the new column, copy the data in
  a data migration, drop the old column later.

## Branches and conflicts

When two branches each plan a migration from the same starting point, the second one to merge
starts from a hash that is no longer the latest. `migrate plan` and `migrate deploy` report it:

```
warning: Migration 20261120093000_branch_b starts from contract 1eaa2c38ecd5 but the previous
migration 20261120091500_branch_a ends at 4ca27ed0521f. It was probably planned on another
branch. Delete its folder and run `migrate plan` again on top of the latest migration.
```

Delete your branch's migration folder (it has not been deployed anywhere shared), merge, and run
`migrate plan` again: the new migration then contains your change on top of the other one.
