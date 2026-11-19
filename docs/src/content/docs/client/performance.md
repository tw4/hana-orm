---
title: Performance
sidebar:
  order: 12
---

## Connection pool

```ts
const db = new HanaClient({
  poolSize: 10,             // max open connections
  idleTimeout: 300_000,     // close connections idle for 5 minutes (0 keeps them)
  idleCheckAfter: 30_000,   // SELECT 1 FROM DUMMY before reusing a connection idle this long
  statementTimeout: 30_000, // ms per statement; default no limit
});
```

- Each model operation borrows a connection for as long as it runs. A transaction holds one
  for its whole duration.
- When all connections are busy, requests wait in line. Transactions give up after `maxWait`;
  see [Transactions](/hana-orm/client/transactions/#options).
- A connection idle for `idleCheckAfter` is checked before it is handed out. A dead one (after a
  database restart, or a firewall that dropped idle sockets) is closed and replaced.
- A connection that fails with a "connection lost" error is closed instead of going back to the
  pool. **Reads** (`find*`, `count`, `aggregate`, `groupBy`, `$queryRaw`) are retried once on a
  new connection. Writes and transactions are not retried, because the server may have applied
  them.
- `$metrics().pool` shows `open`, `idle`, `busy` and `waiting`; see [Metrics](/hana-orm/client/logging/#metrics).

### Sizing the pool

Start with the number of queries you expect to run at the same time, not the number of users.
A web server on one Node.js process rarely needs more than 10–20. Remember that every process
(and every serverless instance) has its own pool, and HANA limits connections per user and
system.

## Statement timeout

```ts
const db = new HanaClient({ statementTimeout: 30_000 });
```

When a statement runs longer, its connection is closed. That stops the statement on the server
and rolls back its transaction. The call fails with `QueryTimeoutError`
(`code: "QUERY_TIMEOUT"`). A timed-out read is not retried.

## Plan cache

The client remembers the SQL it compiled for a query **shape**: the model, the operation and the
keys of `where`, `select`, `omit`, `orderBy`, `take` and `skip`, but not the values. A repeated
`findUnique({ where: { id } })` reuses the compiled SQL and only binds the new id, which roughly
halves the client's CPU time per simple lookup.

Only shapes whose SQL does not depend on the values are cached: plain equality in `where`, no
`null`, no operators, relations, `include`, `distinct` or `cursor`. Everything else is compiled
each time. `planCacheSize` (default 500, `0` turns it off) bounds the cache.

## Statement cache

```ts
const db = new HanaClient({ statementCacheSize: 64 });
```

Keeps up to 64 prepared statements per pooled connection and reuses them for the same SQL text,
so HANA does not parse the statement again. Off by default. It pays off when the same queries
run very often; combine it with [prepared queries](/hana-orm/client/query-builder/#prepared-queries), whose
SQL text never changes.

## Prepared queries

`db.user.findMany({ where: { role: placeholder("role") } }).prepare()` compiles once and
executes many times, for about 5–9× less client time per query. See
[Prepared queries](/hana-orm/client/query-builder/#prepared-queries).

## Batches

```ts
import { tables, eq, desc } from "./generated/hana/index.ts";
const { post } = tables;

const [count, recent, ...updated] = await db.$batch([
  db.user.count(),
  db.select({ id: post.id }).from(post).orderBy(desc(post.id)).limit(10),
  ...changes.map((c) => db.update(post).set({ title: c.title }).where(eq(post.id, c.id))),
]);
// [number, { id: number }[], ...number[]]
```

`$batch` runs the items in order on one connection, in one transaction (a failure rolls
everything back), and resolves with a typed tuple. Consecutive builder `update`s or `delete`s
with the same SQL text, like the ones above, are sent as **one** batch: one round trip, with
each item's affected row count (`-1` if HANA does not report it). Pass the items without
awaiting them.

## Avoiding N+1

`include` and nested `select` load relations with one batched query per relation level, never
one query per row. Prefer them over loops:

```ts
// one query per user: slow
for (const u of users) u.posts = await db.post.findMany({ where: { authorId: u.id } });

// two queries in total
const users = await db.user.findMany({ include: { posts: true } });
```

## Selecting less

`select` only the fields you need. HANA is a column store: every column read costs, and LOB
columns (`NCLOB`, `BLOB`, `Json`) are expensive to fetch. Use the client-wide `omit` for large
fields that are rarely needed.

## Bulk writes

- `createMany` sends rows in batches; it is much faster than `create` in a loop.
- `updateMany` / `deleteMany` run one statement for all matching rows.
- For many different updates, use builder updates in `$batch`.

## Indexes

Filter and join columns on large tables benefit from indexes, foreign keys in particular; HANA
does not index them automatically. See [Indexes](/hana-orm/schema/indexes-constraints/#indexes).

## Measuring

```ts
const db = new HanaClient({ slowQueryThreshold: 200, log: ["warn"] });
```

Then run the slow statement with `EXPLAIN PLAN` or in HANA's SQL analyzer. `log: true` shows the
exact SQL hana-orm sends.

The repository contains benchmarks against the raw driver (`bench/`): on HANA Express, a
`findUnique` takes about 0.6 ms with hana-orm and 0.25 ms with a hand-prepared raw statement; a
page of 50 users with 500 posts about 2.8 ms vs. 1.8 ms; inserting 1000 rows with `createMany`
about 5.7 ms vs. 4.3 ms.
