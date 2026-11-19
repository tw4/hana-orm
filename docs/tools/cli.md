---
title: CLI reference
parent: Tools
nav_order: 1
---

# CLI reference
{: .no_toc }

1. TOC
{:toc}

```sh
npx hana-orm <command> [options]
```

The CLI loads `.env` from the current folder before it runs a command (variables that are
already set win). Commands that need the database connect with the schema's `datasource`
settings.

## Global options

| option | |
|---|---|
| `--schema <path>` | schema file, or a folder whose `*.hana` files are merged. Default: `./schema.hana`, then `./hana/schema.hana`, then `./schema/` |
| `--help` | print help |

## Project

| command | |
|---|---|
| `init` | create `schema.hana` and `.env.example` in the current folder (existing files are kept) |
| `generate` | generate the typed client into each generator's `output` |
| `generate --watch` | regenerate when the schema changes |
| `generate --sql [dir]` | also turn `<schema dir>/sql/*.sql` (or `dir/*.sql`) into typed functions in `<output>/sql.ts`; needs a connection, see [typed SQL](../client/raw-sql.html#typed-sql-from-sql-files) |
| `validate` | check the schema; exit 1 on errors |
| `format` | format the schema file(s) in place |
| `format --check` | list files that are not formatted; exit 1 if any |
| `studio [--port 5555] [--host 127.0.0.1] [--read-only]` | start the [data browser](studio.html) |
| `version` | print the version |

## Database

| command | |
|---|---|
| `db pull` | read the database into the schema file |
| `db pull --tables A,B` / `--exclude X` | only these tables / all but these; comma-separated, `*` and `?` allowed |
| `db pull --db-schema S` | read another database schema (models get `@@schema`) |
| `db pull --views` | also read views |
| `db pull --print` | print the schema instead of writing it |
| `db push [--dry-run] [--allow-destructive]` | apply the schema directly, without migration history |
| `db sign` | write the schema's contract hash into the database marker |
| `db verify` | check the marker and compare the tables with the schema; exit 1 on a mismatch |
| `db seed` | run the seed command with `.env` loaded |
| `db execute --file <script.sql>` / `--stdin` | run a SQL script in one transaction |

## Migrations

| command | |
|---|---|
| `migrate plan --name <name>` | write the next migration from the schema change; no connection needed |
| `  --allow-destructive` | allow drops and narrowing changes |
| `  --empty` | a migration with a hand-written `migration.sql` |
| `  --script` | add a `migration.ts` data migration |
| `migrate show [id]` | print the SQL of pending migrations, or of one (id or prefix) |
| `migrate deploy [--wait <seconds>]` | apply pending migrations; wait for a running deploy |
| `migrate status` | applied / pending / failed / modified migrations, drift, unplanned changes; exit 1 if anything needs attention |
| `migrate resolve --applied <id>` | record a migration as applied without running it |
| `migrate resolve --rolled-back <id>` | record a failed migration as rolled back |
| `migrate baseline [--name init]` | first migration from the schema, recorded as applied (existing databases) |
| `migrate unlock` | release a stale deploy lock |
| `migrate diff --from <src> --to <src>` | compare two states: `empty`, `schema`, `migrations`, `migrations:<id>`, `db` |
| `  --script` | print SQL instead of a list |
| `  --exit-code` | exit 2 when there are differences |
| `migrate squash --from <id> --to <id> [--name <name>] [--baseline]` | combine a range of migrations into one |
| `migrate split <id> [--at <op>,<op>…] [--baseline]` | cut a migration into several |
| `migrate reset` | development only: drop the project's tables, re-apply all migrations, seed |
| `  --force` | do not ask |
| `  --schema-drop` | drop every table, view and sequence of the project's schemas |
| `  --skip-seed` | do not run the seed command |
| `  --allow-remote` | allow a host other than `localhost`, `127.0.0.1`, `::1` |

## Exit codes

| code | meaning |
|---|---|
| `0` | success |
| `1` | an error, or a check failed (`validate`, `format --check`, `migrate status`, `db verify`) |
| `2` | `migrate diff --exit-code` found differences |

## Environment variables

| variable | |
|---|---|
| `HANA_HOST`, `HANA_PORT`, `HANA_USER`, `HANA_PASSWORD` | connection, when the datasource does not set them |
| `HANA_DATABASE`, `HANA_SCHEMA` | tenant database and default schema |
| `HANA_ENCRYPT`, `HANA_SSL_VALIDATE_CERTIFICATE` | TLS settings |
| `HANA_ORM_DEBUG=1` | print stack traces of CLI errors |

See [Environment variables](../reference/environment.html) for the full list.
