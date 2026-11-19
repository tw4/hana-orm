---
title: Environment variables
description: "Every environment variable hana-orm reads, and how .env files are loaded."
sidebar:
  order: 1
---

## Connection

Used when the schema's `datasource` block does not set the value (a value in the block, literal
or `env(…)`, always wins).

| variable | setting | default |
|---|---|---|
| `HANA_HOST` | host | |
| `HANA_PORT` | SQL port | `30015` |
| `HANA_USER` | user | |
| `HANA_PASSWORD` | password | |
| `HANA_DATABASE` | tenant database name | |
| `HANA_SCHEMA` | default schema | the user's schema |
| `HANA_ENCRYPT` | TLS (`true` / `false`) | |
| `HANA_SSL_VALIDATE_CERTIFICATE` | validate the server certificate | |

Variables named in `env("…")` in the datasource block (for example `DATABASE_URL`) are read the
same way.

## .env files

- The CLI loads `.env` from the current folder before running a command.
- The generated client loads `.env` from the working directory the first time it needs a
  variable that is not set.
- Variables that are already set in the environment are never overridden.

## CLI

| variable | |
|---|---|
| `HANA_ORM_DEBUG=1` | print stack traces of errors |

## Set by the CLI

| variable | |
|---|---|
| `HANA_ORM_SCHEMA` | passed to the seed command by `db seed` / `migrate reset`: the path of the schema |
