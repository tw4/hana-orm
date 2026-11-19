---
title: CLI
nav_order: 6
---

# CLI

`npx hana-orm <command> [options]`. The `.env` file in the current folder is loaded first.

## Global options

| option | |
|---|---|
| `--schema <path>` | schema file, or a folder whose `*.hana` files are merged (default: `./schema.hana`, then `./hana/schema.hana`, then `./schema/`) |
| `--help` | help |

## Project

| command | |
|---|---|
| `init` | create `schema.hana` and `.env.example` |
| `generate [--watch]` | generate the typed client into each generator's `output` |
| `validate` | check the schema |
| `format [--check]` | format the schema files; `--check` lists unformatted files and exits 1 |
| `studio [--port 5555] [--host 127.0.0.1] [--read-only]` | browse and edit data in a local web page (URL with an access token) |
| `version` | print the version |

## Database

| command | |
|---|---|
| `db pull [--tables A,B] [--exclude X] [--db-schema S] [--views] [--print]` | introspect into the schema (patterns may use `*` and `?`) |
| `db push [--allow-destructive] [--dry-run]` | apply the schema directly, without migration history |
| `db sign` | write the schema's contract hash into the database marker |
| `db verify` | check the marker and compare tables with the schema |
| `db seed` | run the seed command with `.env` loaded |
| `db execute --file <script.sql> \| --stdin` | run a SQL script in one transaction |

## Migrations

| command | |
|---|---|
| `migrate plan --name <name> [--allow-destructive] [--empty] [--script]` | write the next migration |
| `migrate show [id]` | print the SQL of pending migrations, or of one |
| `migrate deploy [--wait <seconds>]` | apply pending migrations |
| `migrate status` | applied / pending / failed / modified migrations and drift |
| `migrate resolve --applied <id> \| --rolled-back <id>` | fix the history by hand |
| `migrate baseline [--name init]` | first migration from the schema, recorded as applied |
| `migrate unlock` | release a stale migration lock |
| `migrate diff --from <source> --to <source> [--script] [--exit-code]` | compare states |
| `migrate reset [--force] [--schema-drop] [--skip-seed] [--allow-remote]` | development only: drop, re-apply, seed |

## Environment

| variable | |
|---|---|
| `HANA_HOST`, `HANA_PORT`, `HANA_USER`, `HANA_PASSWORD`, `HANA_DATABASE`, `HANA_SCHEMA` | connection when the datasource uses `env(…)` or has no fields |
| `HANA_ORM_DEBUG=1` | print stack traces of CLI errors |
