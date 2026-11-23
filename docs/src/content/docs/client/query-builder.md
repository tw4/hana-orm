---
title: Query builder
description: "Write joins, aggregates, subqueries and WITH queries with typed tables, plus prepared queries and SQL fragments."
sidebar:
  order: 8
---

Next to the object API, the generated client exports typed `tables` and operators for queries
written the way SQL reads. Both share the same connection pool, codecs and transactions.

```ts
import { HanaClient, tables, eq, and, gt, desc, count, sql } from "./generated/hana/index.ts";

const db = new HanaClient();
const { user, post } = tables;

const rows = await db
  .select({ email: user.email, title: post.title })
  .from(user)
  .leftJoin(post, eq(post.authorId, user.id))
  .where(and(eq(user.role, "AUTHOR"), gt(post.views, 100)))
  .orderBy(desc(post.views))
  .limit(20);
// { email: string; title: string | null }[]
```

Use it for joins, aggregates over several tables, subqueries and `WITH` queries, while keeping
typed results and decoded values.

## Tables and columns

`tables` has one entry per model (camelCase), with one column per scalar field:
`tables.user.email`, `tables.orderItem.qty`. Columns know their database name and type, so
values compared with them are encoded the same way as in the object API (enums, dates,
`bigint`, `Decimal`).

## select

```ts
await db.select().from(user);                                   // whole rows: User[]
await db.select({ id: user.id, email: user.email }).from(user); // { id: number; email: string }[]
await db.selectDistinct({ role: user.role }).from(user);        // SELECT DISTINCT
```

| method | |
|---|---|
| `.from(table \| subquery \| cte)` | the source |
| `.innerJoin(src, on)`, `.leftJoin`, `.rightJoin`, `.fullJoin` | joins; columns of outer-joined sources become `\| null` |
| `.where(cond)` | filter |
| `.groupBy(...exprs)`, `.having(cond)` | grouping |
| `.orderBy(...exprs)` | `asc(col)`, `desc(col)`, or a column (ascending) |
| `.limit(n)`, `.offset(n)` | paging |
| `.as("name")` | use as a subquery |
| `.toSQL()` | `{ sql, params }` without running (for `insert`, see [below](#insert-update-delete)) |
| `.prepare()` | a [prepared query](#prepared-queries) |

`select()` without fields on a join returns one nested object per table:

```ts
const rows = await db.select().from(user).leftJoin(post, eq(post.authorId, user.id));
// { user: User; post: Post | null }[]
```

## Operators

| group | operators |
|---|---|
| comparison | `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between` |
| text | `like`, `notLike`, `ilike` (case-insensitive) |
| lists | `inArray`, `notInArray` (an empty list matches nothing) |
| null | `isNull`, `isNotNull` |
| logic | `and`, `or`, `not` (`and` / `or` skip `undefined` items, handy for optional filters) |
| subqueries | `exists`, `notExists` |
| sorting | `asc`, `desc` |
| aggregates | `count()`, `count(col)`, `countDistinct`, `sum`, `avg`, `min`, `max` |

```ts
const filters = and(
  role ? eq(user.role, role) : undefined,
  search ? ilike(user.email, `%${search}%`) : undefined,
);
await db.select().from(user).where(filters);
```

## Aggregates and grouping

```ts
const perAuthor = await db
  .select({ authorId: post.authorId, posts: count(), views: sum(post.views) })
  .from(post)
  .groupBy(post.authorId)
  .having(gt(count(), 5))
  .orderBy(desc(count()));
```

## Self joins with alias

```ts
import { alias } from "./generated/hana/index.ts";

const manager = alias(tables.employee, "manager");
await db
  .select({ name: tables.employee.name, manager: manager.name })
  .from(tables.employee)
  .leftJoin(manager, eq(manager.id, tables.employee.managerId));
```

## Subqueries and WITH

```ts
const counts = db.select({ authorId: post.authorId, n: count() }).from(post).groupBy(post.authorId).as("counts");

await db
  .select({ email: user.email, posts: counts.n })
  .from(user)
  .innerJoin(counts, eq(counts.authorId, user.id))
  .where(gt(counts.n, 5));

const active = db.$with("active").as(db.select({ id: user.id, email: user.email }).from(user).where(eq(user.role, "AUTHOR")));
await db.with(active).select({ email: active.email }).from(active);

const published = db.select({ id: post.id }).from(post).where(and(eq(post.authorId, user.id), eq(post.published, true)));
await db.select({ email: user.email }).from(user).where(exists(published));
```

## insert, update, delete

```ts
await db.insert(user).values([{ email: "a@example.com" }, { email: "b@example.com" }]); // row count
await db.update(post).set({ views: sql`${post.views} + 1` }).where(eq(post.id, 1));     // row count
await db.delete(post).where(eq(post.published, false));                                  // row count
```

- `insert` applies the same defaults and validation as `createMany` (uuid, `now()`,
  `@updatedAt`).
- `insert` runs as one batch per set of fields the rows give. Its `toSQL()` returns the
  statement with `params` of the first row and `rows` with the parameters of every row; when the
  rows give different sets of fields it throws, and `toSQLStatements()` returns every statement.
  An insert cannot be `prepare()`d.
- HANA has no `RETURNING`, so all three resolve with the number of affected rows.
- `update` without `.where()` updates every row; so does `delete`.

## SQL fragments

The `sql` tag embeds SQL anywhere an expression is expected:

```ts
await db
  .select({ email: user.email, domain: sql<string>`SUBSTR_AFTER(${user.email}, '@')` })
  .from(user)
  .where(sql`${user.createdAt} > ADD_DAYS(CURRENT_UTCDATE, ${-30})`);
```

- Columns and tables render as quoted identifiers; every other value is a bound parameter.
- `sql<T>` sets the result type; `.mapWith(fn)` decodes the value
  (`` sql`COUNT(*)`.mapWith(Number) ``).
- `sql.identifier("SCHEMA", "TABLE")` renders a quoted identifier.
- `sql.join([a, b], sql`, `)` joins fragments.
- `sql.raw(text)` inserts text as is. Only for trusted text.

The same fragments can be used in the object API's `where`, see
[Filtering](/hana-orm/client/filtering/#sql-in-where).

## Prepared queries

A prepared query compiles its SQL once. Each `execute` only fills in the placeholders:

```ts
import { placeholder } from "hana-orm/runtime";

const byRole = db.user.findMany({ where: { role: placeholder("role") }, take: 20 }).prepare();
await byRole.execute({ role: "ADMIN" });
await byRole.execute({ role: "AUTHOR" });

const recent = db.select({ id: post.id }).from(post).where(gt(post.id, placeholder("after"))).prepare();
await recent.execute({ after: 1000 });
```

- Works for `findMany`, `findFirst(OrThrow)`, `findUnique(OrThrow)` and the builder's `select`,
  `update` and `delete`. With `include`, nested reads get the values and run as usual.
- Values are encoded like the column they stand for.
- About 5–9× less client CPU per query than compiling each time. Combined with
  `statementCacheSize`, HANA reuses its prepared statement too.
- A placeholder value cannot be `null` (a bound `NULL` never compares equal; use
  `equals: null` or `isNull()`). Missing and unknown names are errors.
- [Query extensions](/hana-orm/client/extensions/#query-hooks) are not applied to prepared queries.

## Transactions and batches

Builders run on the client they come from. Inside a transaction use `tx`:

```ts
await db.$transaction(async (tx) => {
  await tx.update(post).set({ published: true }).where(eq(post.authorId, 1));
  return tx.select({ n: count() }).from(post);
});
```

They are lazy, so they can be passed to `$transaction([…])` and
[`$batch([…])`](/hana-orm/client/performance/#batches) without `await`.
