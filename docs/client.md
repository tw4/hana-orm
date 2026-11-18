---
title: Client API
nav_order: 4
---

# Client API
{: .no_toc }

1. TOC
{:toc}

```ts
import { HanaClient } from "./generated/hana/index.ts";
const db = new HanaClient({ log: true, poolSize: 10 });
```

Every model has a delegate (`db.user`, `db.post`, …). Results are typed from the arguments.

## Client options

| option | |
|---|---|
| `datasource` | overrides connection settings of the schema (`{ host, port, user, password, databaseName, currentSchema, encrypt }`) |
| `schema` | default schema for tables of models without `@@schema` |
| `poolSize` | max pooled connections (default 10) |
| `log` | `true` prints every statement; a function receives `{ sql, params, durationMs }` |
| `omit` | fields left out of every result: `{ user: { passwordHash: true } }` |
| `transactionOptions` | defaults for `$transaction` |
| `driver` | your own `Driver` (tests, custom pooling) |

## Reading

```ts
await db.user.findMany({ where, select, include, omit, orderBy, cursor, take, skip, distinct });
await db.user.findFirst({ … });          // findFirstOrThrow throws NotFoundError
await db.user.findUnique({ where: { id: 1 } });   // a unique field or compound key; findUniqueOrThrow
await db.user.count({ where });
await db.user.aggregate({ _count: true, _avg: { balance: true }, _max: { createdAt: true } });
await db.post.groupBy({ by: ["authorId"], _count: { _all: true }, having: { _count: { _all: { gt: 5 } } } });
```

- `select` picks fields and relations (nested `select` / `where` / `orderBy` / `take` per relation),
  `include` adds relations, `omit` removes fields; `_count` counts relations.
- `orderBy` accepts fields, relation fields (`{ author: { name: "asc" } }`), relation counts
  (`{ posts: { _count: "desc" } }`) and `{ sort, nulls }`.
- `cursor` + `take`/`skip` paginate (also inside `include`); negative `take` reads backwards.
- Relations are loaded with batched `IN` queries: no N+1.

### Filters

| field type | operators |
|---|---|
| all scalars | `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte` |
| `String` | `contains`, `startsWith`, `endsWith`, `mode: "insensitive"` |
| relations (list) | `some`, `every`, `none` |
| relations (single) | `is`, `isNot`, or a nested where |
| combinators | `AND`, `OR`, `NOT` |

## Writing

```ts
await db.user.create({ data: { email, posts: { create: [{ title: "Hi" }] } }, include: { posts: true } });
await db.user.createMany({ data: rows, skipDuplicates: true });
await db.user.createManyAndReturn({ data: rows, select: { id: true } });
await db.user.update({ where: { id }, data: { visits: { increment: 1 } } });
await db.user.updateMany({ where, data });
await db.user.upsert({ where: { email }, create: { email }, update: { name } });
await db.user.delete({ where: { id } });
await db.user.deleteMany({ where });
```

- Nested writes: `create`, `createMany`, `connect`, `connectOrCreate`, `disconnect`, `set`,
  `update`, `updateMany`, `upsert`, `delete`, `deleteMany`.
- Numbers: `increment`, `decrement`, `multiply`, `divide`, `set`.
- Writes run in a transaction. `createMany` sends one batch per column set.
- `skipDuplicates` turns inserts into `INSERT … SELECT … FROM DUMMY WHERE NOT EXISTS (…)` over the
  primary key and every unique whose fields are set.

## Transactions

```ts
await db.$transaction(async (tx) => {
  const u = await tx.user.findUniqueOrThrow({ where: { email } });
  await tx.post.deleteMany({ where: { authorId: u.id } });
}, { timeout: 10_000, maxWait: 5_000, isolationLevel: "SERIALIZABLE" });

const [post, count] = await db.$transaction([db.post.create({ data }), db.post.count()]);
```

- `timeout` (default 5000 ms): the transaction is rolled back and `$transaction` rejects with
  `TransactionError` (`TRANSACTION_TIMEOUT`).
- `maxWait` (default 2000 ms): wait for a pooled connection (`TRANSACTION_MAX_WAIT`).
- Query methods are lazy: they run when awaited, so pass them to the array form without `await`.

## Raw SQL

```ts
const rows = await db.$queryRaw`SELECT "ID" FROM "APP"."USERS" WHERE "ROLE" = ${role}`;
const n = await db.$executeRaw`UPDATE "APP"."USERS" SET "ACTIVE" = FALSE WHERE "ID" = ${id}`;
await db.$queryRawUnsafe('SELECT * FROM "T" WHERE "A" = ?', a);   // never build the SQL from user input
```

Template values are always bound parameters.

## Extensions

```ts
const xdb = db.$extends({
  model: { user: { byEmail(email: string) { return db.user.findUnique({ where: { email } }); } } },
  query: { $allModels: { async $allOperations({ model, operation, args, query }) { return query(args); } } },
  client: { async ping() { return db.$queryRaw`SELECT 1 FROM DUMMY`; } },
});
```

## Errors

All errors extend `HanaOrmError` with a stable `code`: `ValidationError` (`VALIDATION`),
`NotFoundError` (`NOT_FOUND`), `DatabaseError` (`UNIQUE_CONSTRAINT`, `FOREIGN_KEY_CONSTRAINT`,
`NOT_NULL_CONSTRAINT`, `AUTHENTICATION`, `DATABASE`; `hanaCode` holds HANA's error number),
`TransactionError` (`TRANSACTION_TIMEOUT`, `TRANSACTION_MAX_WAIT`, `TRANSACTION_CLOSED`).
