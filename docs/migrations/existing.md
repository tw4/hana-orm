---
title: Existing databases
parent: Migrations
nav_order: 3
---

# Existing databases

When the tables already exist, start from them instead of from an empty database.

## 1. Pull and tidy the schema

```sh
npx hana-orm db pull
npx hana-orm format
```

See [Starting from an existing database](../getting-started/existing-database.html) for the
options of `db pull` and what to tidy up.

## 2. Create the baseline

```sh
npx hana-orm migrate baseline            # migrations/<timestamp>_init
npx hana-orm migrate baseline --name v1  # another name
```

`baseline` writes a first migration with the SQL that would create the schema's tables, and
records it as applied in the configured database **without running it**.

- It only works in a project without migrations.
- Before recording, it compares the database with the schema. If they differ, it lists the
  differences and asks whether to continue: the baseline records the schema, not the database.
  Fix the schema (or the database) first, so that the baseline describes reality.

## 3. Mark it on the other environments

Every other database that already has these tables (staging, production) needs the baseline
recorded too, without running it:

```sh
npx hana-orm migrate resolve --applied 20261119093000_init
```

From then on, plan and deploy migrations as usual. `migrate deploy` on an environment where the
baseline is not recorded would try to create the tables and fail on the pre-check
("table already exists"), before changing anything.

## Shared schemas

A schema often contains tables of several applications. hana-orm only manages the tables your
schema defines:

- `db pull --tables` / `--exclude` choose what to read.
- Migrations only create, change and drop tables of your schema.
- Drift checks compare only the tables your schema defines.
- `migrate reset` drops only your project's tables (unless `--schema-drop`).

The housekeeping tables (`_HANA_ORM_MIGRATIONS`, `_HANA_ORM_LOCK`, `_HANA_ORM_MARKER`) are created
in the default schema. Two projects that share a default schema would share them; give each
project its own default schema, and reach shared tables with `@@schema`.
