---
title: Raw SQL
description: "Run hand-written SQL safely with tagged templates, and get typed results from .sql files."
sidebar:
  order: 7
---

## Tagged templates

```ts
const rows = await db.$queryRaw<{ ID: number; EMAIL: string }>`
  SELECT "id" AS "ID", "email" AS "EMAIL" FROM "APP"."User" WHERE "role" = ${role} AND "createdAt" > ${since}
`;

const changed = await db.$executeRaw`UPDATE "APP"."User" SET "name" = ${name} WHERE "id" = ${id}`;
// number of affected rows
```

Every `${…}` is a bound parameter (`?`), never pasted into the SQL text, so these are safe with
user input. `Date` values are sent as UTC timestamps and `bigint` values as strings.

- `$queryRaw` returns the rows as the driver gives them, keyed by the column names (or aliases)
  of the result. Values are **not** decoded: `BIGINT` and `DECIMAL` arrive as the driver returns
  them, `TIMESTAMP` as a string. Use [typed SQL](#typed-sql-from-sql-files) or the
  [query builder](/hana-orm/client/query-builder/) when you want decoded, typed results.
- `$executeRaw` returns the number of affected rows.
- The type parameter (`$queryRaw<Row>`) is only an assertion; nothing checks it.

Table and column names in raw SQL are the database names: what `@@map` / `@map` say, or the
model and field names when there is no mapping. Quote them; they are case-sensitive.

## Unsafe variants

```ts
await db.$queryRawUnsafe('SELECT * FROM "APP"."User" WHERE "id" = ?', id);
await db.$executeRawUnsafe(`ALTER TABLE "APP"."${table}" …`);
```

The SQL text is used as given, with `?` placeholders for the remaining arguments. Use them for
SQL that cannot be a template, such as dynamic identifiers you have validated yourself.

:::danger
Never build the SQL string of `$queryRawUnsafe` / `$executeRawUnsafe` from user input. Pass
values as parameters.
:::

## Typed SQL from .sql files

For queries you want to keep as SQL but use with types, put one statement per file in a `sql/`
folder next to the schema:

```sql
-- sql/active-users.sql
SELECT "ID", "NAME", "CREATED_AT"
FROM "APP"."USERS"
WHERE "ACTIVE" = TRUE AND "AGE" >= :minAge AND "TEAM" = :team
```

```sh
npx hana-orm generate --sql
```

`generate --sql` connects to the database and asks HANA to describe each statement **without
running it**: its result columns with their types and nullability, and its parameters. It
writes `<output>/sql.ts` with one function per file:

```ts
import { activeUsers } from "./generated/hana/sql.ts";

const users = await db.$queryRawTyped(activeUsers(18, "core"));
// { ID: number; NAME: string | null; CREATED_AT: Date }[]
```

- Function names come from file names: `active-users.sql` → `activeUsers`.
- Parameters are `:name` (one function argument per name, even when a name is used twice) or
  `?` (arguments `p1`, `p2`, …). Do not mix both in one file.
- Rows are decoded by the column types HANA reported: `BIGINT` → `bigint`, `DECIMAL` → string,
  dates → `Date`. Nullable columns are typed `| null`.
- Give computed columns an alias (`COUNT(*) AS "N"`) so they have a usable name.
- `--sql <dir>` reads another folder. Run `generate --sql` again after changing a file or the
  tables it reads.
- `$queryRawTyped` works on `tx` inside transactions.

## Inside transactions

All raw methods are available on the transaction client and take part in the transaction:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`DELETE FROM "APP"."Session" WHERE "userId" = ${id}`;
  await tx.user.delete({ where: { id } });
});
```

They are lazy like model operations, so they can also go into `$transaction([…])` and
`$batch([…])` without `await`.

## When to use what

| need | use |
|---|---|
| typed CRUD with relations | the object API |
| joins, aggregates, subqueries, `WITH`, typed results | the [query builder](/hana-orm/client/query-builder/) |
| a fixed, hand-tuned SQL statement with typed results | typed SQL (`.sql` files) |
| a one-off statement, HANA-specific syntax, DDL | `$queryRaw` / `$executeRaw` |
