---
title: Writing data
description: "create, update, upsert and delete, atomic number updates and fast bulk inserts."
sidebar:
  order: 3
---

## create

```ts
const user = await db.user.create({
  data: { email: "ada@example.com", name: "Ada" },
});
// User, with id, defaults and @updatedAt filled in
```

- Fields with a default, `@updatedAt`, or `?` can be left out.
- HANA has no `RETURNING`. After the insert, hana-orm reads the row back (identity values with
  `CURRENT_IDENTITY_VALUE()`, sequence values with `CURRVAL`), so the result contains the
  values the database generated.
- `select`, `include` and `omit` shape the returned row like in `findMany`.

```ts
const u = await db.user.create({
  data: { email: "bob@example.com", posts: { create: { title: "Hi" } } },
  select: { id: true, posts: { select: { id: true } } },
});
```

Related rows can be created, connected or both in the same call: see
[Nested writes](/hana-orm/client/nested-writes/).

## update

```ts
await db.user.update({
  where: { id: 1 },
  data: { name: "Ada Lovelace" },
});
```

`where` must identify one row by a unique field or composite key. If no row matches, `update`
throws `NotFoundError`. The updated row is returned.

### Atomic number operations

```ts
await db.post.update({ where: { id: 7 }, data: { views: { increment: 1 } } });
```

| operation | SQL |
|---|---|
| `{ increment: n }` | `"views" = "views" + ?` |
| `{ decrement: n }` | `"views" = "views" - ?` |
| `{ multiply: n }` | `"views" = "views" * ?` |
| `{ divide: n }` | `"views" = "views" / ?` |
| `{ set: n }` or `n` | `"views" = ?` |

They run in SQL, so concurrent updates do not overwrite each other. They work on `Int`,
`BigInt`, `Float` and `Decimal` fields.

## updateMany

```ts
const { count } = await db.post.updateMany({
  where: { authorId: 1, published: false },
  data: { published: true },
});
```

Returns the number of updated rows. `@updatedAt` fields are set on all of them.

## upsert

```ts
const tag = await db.tag.upsert({
  where: { name: "hana" },
  create: { name: "hana" },
  update: {},
});
```

Updates the row that matches `where`, or creates it. Both happen in one transaction. Two
concurrent upserts of a new key can still both try to insert; one of them then fails with a
`UNIQUE_CONSTRAINT` error, which you can retry.

## delete

```ts
const removed = await db.post.delete({ where: { id: 7 } });   // returns the deleted row
const { count } = await db.post.deleteMany({ where: { published: false } });
```

`delete` throws `NotFoundError` when the row does not exist. Foreign keys decide what happens to
related rows (`onDelete: Cascade`, `SetNull`, or a `FOREIGN_KEY_CONSTRAINT` error for
`Restrict`).

:::caution
`deleteMany()` and `updateMany()` without `where` affect every row of the table.
:::

## createMany

```ts
const { count } = await db.user.createMany({
  data: [
    { email: "a@example.com" },
    { email: "b@example.com", name: "B" },
  ],
});
```

Rows are sent in batches with the driver's `execBatch`, one batch per set of columns, in one
transaction. It does not return the rows; use `createManyAndReturn` for that.

### skipDuplicates

```ts
await db.user.createMany({ data: rows, skipDuplicates: true });
```

Rows that match an existing row (or an earlier row of the same call) on the primary key or any
unique constraint are skipped. Each insert becomes
`INSERT … SELECT … FROM DUMMY WHERE NOT EXISTS (…)` over the primary key and every unique whose
fields are set in the row. Two transactions inserting the same key at the same moment can still
fail with a unique violation.

## createManyAndReturn

```ts
const created = await db.user.createManyAndReturn({
  data: rows,
  skipDuplicates: true,
  select: { id: true, email: true },
});
// { id: number; email: string }[], in the order of `data`
```

Inserts row by row (to read each identity value) and returns the rows it inserted. It accepts
`select`, `omit` and `include`, but no nested writes in `data`. For large imports without a
result, `createMany` is much faster.

## Bulk imports

- Use `createMany` in chunks of a few thousand rows.
- Wrap several chunks in a [transaction](/hana-orm/client/transactions/) if they must succeed together.
- For very large loads, HANA's `IMPORT FROM` or the query builder's `insert` with
  [`$batch`](/hana-orm/client/performance/#batches) are alternatives.

## Values

How strings, numbers, `BigInt`, `Decimal`, dates, `Bytes` and Json are written is described on
[Decimal, BigInt, Json and dates](/hana-orm/client/values/).
