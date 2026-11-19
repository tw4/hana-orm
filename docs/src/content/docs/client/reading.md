---
title: Reading data
sidebar:
  order: 1
---

The examples use the schema from [Your first project](/hana-orm/getting-started/first-project/):
`User` has many `Post`s, `Post` has many `Tag`s.

## findMany

```ts
const users = await db.user.findMany({
  where: { role: "AUTHOR" },
  orderBy: { createdAt: "desc" },
  take: 20,
});
// User[]
```

All arguments are optional: `db.user.findMany()` returns every row.

| argument | |
|---|---|
| `where` | filter, see [Filtering](/hana-orm/client/filtering/) |
| `select` | fields and relations to return |
| `include` | relations to add to all fields |
| `omit` | fields to leave out |
| `orderBy` | sort order |
| `take`, `skip` | page size and offset |
| `cursor` | start at a row identified by a unique field |
| `distinct` | one row per distinct combination of fields |

## findFirst and findUnique

```ts
const latest = await db.post.findFirst({ where: { published: true }, orderBy: { id: "desc" } });
// Post | null

const ada = await db.user.findUnique({ where: { email: "ada@example.com" } });
// User | null

const sure = await db.user.findUniqueOrThrow({ where: { id: 1 } });
// User, or throws NotFoundError
```

- `findFirst` takes the same arguments as `findMany` and returns the first row or `null`.
- `findUnique` takes a `where` with a unique field (`@id`, `@unique`) or a composite key
  (`{ orderId_lineNo: { orderId: 1, lineNo: 2 } }`). Other filters can be added next to it.
- The `…OrThrow` variants throw `NotFoundError` (`code: "NOT_FOUND"`) instead of returning
  `null`.

## Choosing fields

### select

```ts
const rows = await db.user.findMany({
  select: { id: true, email: true },
});
// { id: number; email: string }[]
```

Only the selected fields are read from the database, and the result type has exactly those
fields.

### include

```ts
const withPosts = await db.user.findMany({ include: { posts: true } });
// (User & { posts: Post[] })[]
```

`include` returns all scalar fields plus the listed relations. `select` and `include` cannot be
used at the same level, but `select` can contain relations, and relations can have their own
`select` / `include`:

```ts
const rows = await db.user.findMany({
  select: {
    email: true,
    posts: {
      select: { title: true, tags: { select: { name: true } } },
      where: { published: true },
      orderBy: { id: "desc" },
      take: 3,
    },
  },
});
// { email: string; posts: { title: string; tags: { name: string }[] }[] }[]
```

### omit

```ts
const safe = await db.user.findMany({ omit: { passwordHash: true } });
```

`omit` leaves fields out. To leave a field out everywhere, set it on the client:

```ts
const db = new HanaClient({ omit: { user: { passwordHash: true } } });

await db.user.findFirst();                                   // without passwordHash
await db.user.findFirst({ omit: { passwordHash: false } });  // with it
await db.user.findFirst({ select: { passwordHash: true } }); // with it
```

## Relations

Relations are loaded with one extra query per relation level, batched with `IN (…)`. Loading
100 users with their posts is two queries, not 101.

```ts
await db.post.findMany({ include: { author: true, tags: true } });
```

A to-one relation is `T | null` when it is optional. A to-many relation is always an array.

### Counting relations

```ts
const users = await db.user.findMany({
  select: { email: true, _count: { select: { posts: true } } },
});
// { email: string; _count: { posts: number } }[]

await db.user.findMany({ include: { _count: true } }); // counts of every to-many relation
```

## Ordering

```ts
await db.user.findMany({ orderBy: { createdAt: "desc" } });
await db.user.findMany({ orderBy: [{ role: "asc" }, { email: "asc" }] });
await db.user.findMany({ orderBy: { name: { sort: "asc", nulls: "last" } } });
await db.post.findMany({ orderBy: { author: { email: "asc" } } });   // by a to-one relation's field
await db.user.findMany({ orderBy: { posts: { _count: "desc" } } });  // by the number of related rows
```

Without `orderBy`, HANA returns rows in no particular order, and the order can change between
runs. Always order when you page.

## Pagination

### Offset

```ts
const page = 3;
const pageSize = 25;
await db.post.findMany({ orderBy: { id: "asc" }, skip: (page - 1) * pageSize, take: pageSize });
```

### Cursor

```ts
const first = await db.post.findMany({ orderBy: { id: "asc" }, take: 25 });
const next = await db.post.findMany({
  orderBy: { id: "asc" },
  cursor: { id: first.at(-1)!.id },
  skip: 1,  // skip the cursor row itself
  take: 25,
});
```

A cursor is a unique field (or composite key) of the row to start at. Cursor pagination stays
correct while rows are inserted, and stays fast on deep pages. A negative `take` reads
backwards from the cursor. Cursors also work inside `include` and `select` on relations.

## distinct

```ts
const authors = await db.post.findMany({ distinct: ["authorId"], orderBy: { id: "desc" } });
```

Returns one row per distinct combination of the listed fields, the first one in `orderBy`
order.

## Counting

```ts
const n = await db.post.count({ where: { published: true } });   // number
const c = await db.user.count({ select: { _all: true, name: true } }); // { _all: number; name: number }
```

`count` with `select` counts non-null values per field. For sums, averages and grouping see
[Aggregation](/hana-orm/client/aggregation/).

## Result types

The generated file exports a type per model (`User`, `Post`) and the argument types
(`UserFindManyArgs`, `UserWhereInput`, …). To name the type of a particular query result, use
`Awaited<ReturnType<…>>`:

```ts
function postsWithAuthor() {
  return db.post.findMany({ include: { author: { select: { name: true } } } });
}
type PostWithAuthor = Awaited<ReturnType<typeof postsWithAuthor>>[number];
```
