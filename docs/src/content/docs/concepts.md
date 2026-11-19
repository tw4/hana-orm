---
title: How it works
sidebar:
  order: 3
---

## The pieces

```
                ┌────────────────────┐
 schema.hana ──▶│  schema compiler   │──▶ contract (JSON, with a hash)
 (or a TS DSL)  └────────────────────┘          │
                                                ├──▶ hana-orm generate ──▶ src/generated/hana/index.ts
                                                │                              │
                                                │                              ▼
                                                │                     hana-orm/runtime ──▶ @sap/hana-client ──▶ HANA
                                                │
                                                └──▶ hana-orm migrate plan ──▶ migrations/<id>/ (ops.json, migration.sql)
                                                                                       │
                                                                     hana-orm migrate deploy ──▶ HANA
```

### Schema and contract

The `.hana` schema (or a schema written in [TypeScript](/hana-orm/schema/typescript/)) is compiled
into a **contract**: a JSON description of models, fields, relations, enums and their database
names. The contract has a **hash**. Formatting, comments and `///` docs do not change it; any
change that matters to the client or the database does.

Everything else works from the contract:

- the generator turns it into a typed client;
- the migration planner compares two contracts;
- the runtime uses it to map fields to columns and to encode and decode values.

### The generated client

`hana-orm generate` writes one TypeScript file per generator. It contains the contract, a type
per model, input types for every operation, typed `tables` for the query builder and a
`HanaClient` class. The class is thin: queries are compiled and run by `hana-orm/runtime`, which
is a normal npm dependency. Upgrading hana-orm updates the runtime; regenerate when the
changelog says so.

There is no query engine binary. A query like `db.user.findMany({ include: { posts: true } })`
becomes one `SELECT` for users and one batched `SELECT … WHERE "authorId" IN (…)` for posts,
built in your process and sent through `@sap/hana-client`.

### Migrations

`hana-orm migrate plan` compares the contract of the latest migration (`contract.json` in its
folder) with the current schema and writes the difference as operations with literal HANA SQL.
It needs no database connection and no shadow database.

`hana-orm migrate deploy` applies the pending migrations in order, each in one transaction, and
records them in `_HANA_ORM_MIGRATIONS` with a checksum. Migrations chain by contract hash: each
one records the hash it starts from and the hash it ends at, so a migration planned on an
outdated branch is detected.

### The database marker

After a deploy (or `db push`, or `db sign`), hana-orm writes the contract hash into
`_HANA_ORM_MARKER`. `db verify` and `migrate status` use it to tell whether the database matches
the schema the application was built with.

## Types and values

The runtime converts values both ways:

| HANA | TypeScript |
|---|---|
| `BIGINT` | `bigint` (never rounded) |
| `DECIMAL` | `string` by default, or `number` / `decimal.js` |
| `TIMESTAMP`, `SECONDDATE`, `DATE`, `TIME` | `Date` in UTC |
| `BOOLEAN` | `boolean` |
| `NCLOB` with a `Json` field | parsed JSON |
| `BLOB`, `VARBINARY` | `Buffer` |

See [Type mapping](/hana-orm/schema/types/) and [Decimal, BigInt, Json and dates](/hana-orm/client/values/).

## Connections and transactions

The client keeps a pool of connections (10 by default). Each model operation takes a
connection, runs its statements, and gives it back. Operations that write more than one
statement, like a `create` with nested writes, run in a transaction. `$transaction` keeps one
connection for the whole callback or batch. See [Transactions](/hana-orm/client/transactions/) and
[Performance](/hana-orm/client/performance/).

## What hana-orm does not do

- **It does not create schemas or users.** Create the database schema before the first
  migration.
- **It does not manage HANA calculation views or graph workspaces.** Plain SQL views can be read
  with `view` blocks.
- **It does not support other databases.** Everything is written for HANA's SQL dialect and
  catalog.
