---
title: Connecting to HANA
parent: Getting started
nav_order: 2
---

# Connecting to HANA
{: .no_toc }

1. TOC
{:toc}

hana-orm reads the connection from the `datasource` block of the schema. The CLI and the
generated client use the same settings.

## The datasource block

```hana
datasource db {
  provider = "hana"
  host     = env("HANA_HOST")
  port     = env("HANA_PORT")
  user     = env("HANA_USER")
  password = env("HANA_PASSWORD")
  schema   = "APP"               // default schema for tables
}
```

Each value is a literal or `env("NAME")`. Keep passwords in environment variables, never in the
schema.

| field | meaning |
|---|---|
| `host`, `port` | SQL endpoint. A tenant database's SQL port is usually `3<instance>41` (e.g. `39041` for instance 90) or `3<instance>15` for a single-container system. |
| `user`, `password` | database user |
| `databaseName` | tenant database name, when you connect through the SYSTEMDB port |
| `schema` | default schema for tables of models without `@@schema` (also the session's current schema) |
| `encrypt` | `true` for TLS. Required for HANA Cloud. |
| `sslValidateCertificate` | `false` to accept a self-signed certificate (development only) |
| `url` | everything in one URL, see below |

## The .env file

`hana-orm init` writes a `.env.example`. Copy it to `.env` and fill it in:

```sh
HANA_HOST=localhost
HANA_PORT=39041
HANA_USER=APP_USER
HANA_PASSWORD=…
HANA_DATABASE=HXE
```

The CLI loads `.env` from the current folder before it runs a command. The generated client
loads it the first time it needs a value that is not already in the environment. Variables that
are already set always win. Never commit `.env`.

## Fallback environment variables

Anything the datasource block does not set is taken from these variables, so a block with only
`provider = "hana"` works too:

| variable | setting |
|---|---|
| `HANA_HOST` | host |
| `HANA_PORT` | port (default `30015`) |
| `HANA_USER`, `HANA_PASSWORD` | credentials |
| `HANA_DATABASE` | tenant database name |
| `HANA_SCHEMA` | default schema |
| `HANA_ENCRYPT` | `true` / `false` |
| `HANA_SSL_VALIDATE_CERTIFICATE` | `true` / `false` |

## A connection URL

Instead of separate fields:

```hana
datasource db {
  provider = "hana"
  url      = env("DATABASE_URL")
}
```

```sh
DATABASE_URL="hana://APP_USER:secret@hana.example.com:443/?currentSchema=APP&encrypt=true"
```

Query parameters: `databaseName`, `currentSchema`, `encrypt`, `sslValidateCertificate`. Encode
special characters in the user and password (`%40` for `@`). Separate fields and the fallback
variables override the URL's parts.

## SAP HANA Cloud

HANA Cloud listens on port `443` and requires TLS:

```hana
datasource db {
  provider = "hana"
  host     = env("HANA_HOST")      // <instance-id>.hana.<region>.hanacloud.ondemand.com
  port     = 443
  user     = env("HANA_USER")
  password = env("HANA_PASSWORD")
  encrypt  = true
  schema   = "APP"
}
```

Allow your machine's IP address in the instance's connection settings.

## Tenant databases (MDC)

On a multi-tenant system you can connect to the tenant's own SQL port, or to the SYSTEMDB port
with `databaseName` set to the tenant. HANA Express uses tenant `HXE` on port `39041`.

## Overriding the connection in code

The client accepts overrides, for example to read secrets from a vault:

```ts
const db = new HanaClient({
  datasource: { host: cfg.host, port: 443, user: cfg.user, password: await vault.get("hana"), encrypt: true },
  schema: "APP",
});
```

See [Creating the client](../client/#client-options) for every option.

## Check the connection

```sh
npx hana-orm migrate status   # connects, reads the migration history
npx hana-orm db pull --print  # connects, prints the schema without writing anything
```

A failed login is reported with HANA's message. In code, errors carry `code: "AUTHENTICATION"`
(see [Errors](../client/errors.html)).

## Database user and privileges

For day-to-day queries the user needs `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the schema. For
migrations it also needs `CREATE ANY` on the schema (or to own it). Migrations do not create
schemas: create every schema the project uses (the default one and any `@@schema`) beforehand,
for example with `CREATE SCHEMA APP OWNED BY APP_ADMIN`. A common setup is one user that owns the
schema and runs migrations, and a second user with only DML privileges for the application.

Next: [Your first project](first-project.html).
