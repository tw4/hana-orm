---
title: Client
sidebar:
  label: Overview
  order: 0
---

`hana-orm generate` writes a client class for your schema. Create one instance per process and
share it; it holds the connection pool.

```ts
import { HanaClient } from "./generated/hana/index.ts";

export const db = new HanaClient();
```

Every model has a delegate named after the model in camelCase: `db.user`, `db.orderItem`. Each
delegate has the same operations, typed for its model:

| reading | writing |
|---|---|
| `findMany`, `findFirst`, `findFirstOrThrow`, `findUnique`, `findUniqueOrThrow` | `create`, `createMany`, `createManyAndReturn` |
| `count`, `aggregate`, `groupBy` | `update`, `updateMany`, `upsert` |
| | `delete`, `deleteMany` |

Views only have the reading operations.

## Client options

```ts
const db = new HanaClient({
  poolSize: 10,
  statementTimeout: 30_000,
  log: ["warn", "error"],
  slowQueryThreshold: 500,
  omit: { user: { passwordHash: true } },
  transactionOptions: { timeout: 10_000 },
});
```

| option | default | |
|---|---|---|
| `datasource` | from the schema | overrides connection settings: `{ host, port, user, password, databaseName, currentSchema, encrypt, sslValidateCertificate, extra }`; `extra` is passed to `@sap/hana-client`'s `connect()` |
| `schema` | datasource `schema` | default schema for tables of models without `@@schema` |
| `poolSize` | `10` | maximum open connections |
| `statementTimeout` | none | ms a single statement may run; see [Performance](/hana-orm/client/performance/#statement-timeout) |
| `idleTimeout` | `300000` | close connections idle this long (ms; `0` keeps them) |
| `idleCheckAfter` | `30000` | check a connection with `SELECT 1 FROM DUMMY` before reuse when it was idle this long |
| `log` | off | `true`, a list of event names, or a function; see [Logging](/hana-orm/client/logging/) |
| `logParams` | `false` | include bound values in events and logs |
| `slowQueryThreshold` | none | statements slower than this (ms) emit a `warn` event |
| `omit` | none | fields left out of every result unless a query asks for them |
| `planCacheSize` | `500` | compiled query shapes kept; `0` turns the plan cache off |
| `statementCacheSize` | `0` | prepared statements kept per connection |
| `transactionOptions` | | defaults for `$transaction`: `timeout`, `maxWait`, `isolationLevel` |
| `driver` | | your own `Driver` implementation (tests, custom pooling) |

## Lifecycle

The client connects lazily: the first query opens the first connection. Call `$connect()` to
connect at startup instead, so a wrong password or an unreachable host fails right away:

```ts
await db.$connect();      // runs SELECT 1 FROM DUMMY
// …
await db.$disconnect();
```

`$disconnect()` refuses new work, fails requests that are waiting for a connection, waits up to
10 seconds for running statements and then closes all connections. Call it on shutdown:

```ts
process.once("SIGTERM", async () => {
  await server.close();
  await db.$disconnect();
});
```

## Queries are lazy

Model operations return a promise-like object that runs when it is awaited (or `.then` is
called). This is what lets you pass queries to `$transaction([…])` and `$batch([…])` without
running them first:

```ts
const q = db.user.findMany();   // nothing has run yet
const users = await q;           // runs now
```

An operation that is never awaited never runs.

## Client methods

| method | |
|---|---|
| `$transaction(fn \| queries, options?)` | [Transactions](/hana-orm/client/transactions/) |
| `$batch(queries)` | [Performance](/hana-orm/client/performance/#batches) |
| `$queryRaw`, `$executeRaw`, `$queryRawUnsafe`, `$executeRawUnsafe`, `$queryRawTyped` | [Raw SQL](/hana-orm/client/raw-sql/) |
| `select`, `insert`, `update`, `delete`, `$with`, `with` | [Query builder](/hana-orm/client/query-builder/) |
| `$extends(extension)` | [Extensions](/hana-orm/client/extensions/) |
| `$on(event, listener)`, `$metrics()` | [Logging, events and metrics](/hana-orm/client/logging/) |
| `$connect()`, `$disconnect()` | above |

## Pages in this section

- [Reading data](/hana-orm/client/reading/): `find*`, `select` / `include` / `omit`, ordering, pagination,
  `distinct`
- [Filtering](/hana-orm/client/filtering/): operators, relation filters, Json filters, full-text search
- [Writing data](/hana-orm/client/writing/): `create`, `update`, `upsert`, `delete`, bulk operations
- [Nested writes](/hana-orm/client/nested-writes/)
- [Aggregation](/hana-orm/client/aggregation/): `count`, `aggregate`, `groupBy`
- [Transactions](/hana-orm/client/transactions/)
- [Raw SQL](/hana-orm/client/raw-sql/), including typed SQL from `.sql` files
- [Query builder](/hana-orm/client/query-builder/), prepared queries and `sql` fragments
- [Decimal, BigInt, Json and dates](/hana-orm/client/values/)
- [Extensions](/hana-orm/client/extensions/): custom methods, query hooks, computed fields
- [Logging, events and metrics](/hana-orm/client/logging/)
- [Performance](/hana-orm/client/performance/): pool, plan cache, statement cache, batches
- [Errors](/hana-orm/client/errors/)
