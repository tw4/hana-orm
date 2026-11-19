---
title: Aggregation
sidebar:
  order: 5
---

## count

```ts
await db.post.count();                                      // number
await db.post.count({ where: { published: true } });        // number
await db.user.count({ select: { _all: true, name: true } }); // { _all: number; name: number }
```

With `select`, `_all` counts rows and a field counts its non-null values.

## aggregate

```ts
const stats = await db.order.aggregate({
  where: { status: "PAID" },
  _count: { _all: true },
  _sum: { total: true },
  _avg: { total: true },
  _min: { createdAt: true },
  _max: { createdAt: true },
});
// {
//   _count: { _all: number };
//   _sum: { total: string | null };
//   _avg: { total: number | null };
//   _min: { createdAt: Date | null };
//   _max: { createdAt: Date | null };
// }
```

| aggregate | fields | result type |
|---|---|---|
| `_count` | any field, or `_all` | `number` |
| `_sum` | numeric fields | the field's type, or `null` when no rows match |
| `_avg` | numeric fields | `number \| null` |
| `_min`, `_max` | numbers, strings, dates | the field's type, or `null` |

`aggregate` also accepts `orderBy`, `cursor`, `take` and `skip`; the aggregates are then computed
over that window of rows.

`Decimal` sums keep full precision as strings (or `Decimal` objects, depending on the
[decimal mode](/hana-orm/client/values/#decimal)). `_avg` is always a JavaScript number.

## groupBy

```ts
const perAuthor = await db.post.groupBy({
  by: ["authorId"],
  where: { published: true },
  _count: { _all: true },
  _sum: { views: true },
  having: { _count: { _all: { gt: 5 } } },
  orderBy: { _count: { authorId: "desc" } },
  take: 10,
});
// { authorId: number; _count: { _all: number }; _sum: { views: number | null } }[]
```

- `by` lists the grouping fields (one or several).
- `having` filters groups by aggregates or by the grouping fields.
- `orderBy` sorts by grouping fields or by aggregates.
- `take` / `skip` page through the groups.

## Counting related rows

To count relations together with the rows, use `_count` in `select` or `include`:

```ts
await db.user.findMany({ select: { email: true, _count: { select: { posts: true } } } });
```

For anything more involved (window functions, `CASE`, several tables), use the
[query builder](/hana-orm/client/query-builder/) or [raw SQL](/hana-orm/client/raw-sql/).
