---
title: Filtering
sidebar:
  order: 2
---

`where` is accepted by `findMany`, `findFirst`, `count`, `aggregate`, `groupBy`, `updateMany`,
`deleteMany`, inside relation filters, and in `select` / `include` of to-many relations.
Every value is sent as a bound parameter.

## Equality

```ts
await db.user.findMany({ where: { role: "ADMIN", name: "Ada" } });  // AND of both
await db.user.findMany({ where: { name: null } });                   // IS NULL
await db.user.findMany({ where: { name: { not: null } } });          // IS NOT NULL
```

## Operators

| operator | types | SQL |
|---|---|---|
| `equals` | all | `=` (or `IS NULL` for `null`) |
| `not` | all | `<>`, or a negated nested filter: `{ not: { in: [1, 2] } }` |
| `in`, `notIn` | all | `IN (…)`, `NOT IN (…)` |
| `lt`, `lte`, `gt`, `gte` | numbers, strings, dates | `<`, `<=`, `>`, `>=` |
| `contains`, `startsWith`, `endsWith` | `String` | `LIKE` with escaped wildcards |
| `mode: "insensitive"` | `String` | compares `LOWER(…)` |
| `search` | `String` | `CONTAINS(column, ?)`, see [full-text search](#full-text-search) |

```ts
await db.post.findMany({
  where: {
    id: { in: [1, 2, 3] },
    title: { contains: "hana", mode: "insensitive" },
    views: { gt: 100 },
    author: { createdAt: { gte: new Date("2026-01-01"), lt: new Date("2027-01-01") } },
  },
});
```

`contains`, `startsWith` and `endsWith` escape `%` and `_` in the value, so
`{ contains: "50%" }` matches the text `50%`.

## AND, OR, NOT

```ts
await db.post.findMany({
  where: {
    OR: [{ title: { startsWith: "HANA" } }, { title: { startsWith: "SAP" } }],
    NOT: { authorId: null },
    AND: [{ published: true }, { views: { gt: 10 } }],
  },
});
```

`AND` and `NOT` take one filter or a list; `OR` takes a list. Fields next to each other are
combined with AND.

## Relation filters

### To-many relations

```ts
// users with at least one published post
await db.user.findMany({ where: { posts: { some: { published: true } } } });

// users whose posts are all published (also users without posts)
await db.user.findMany({ where: { posts: { every: { published: true } } } });

// users without any post
await db.user.findMany({ where: { posts: { none: {} } } });
```

### To-one relations

```ts
await db.post.findMany({ where: { author: { email: { endsWith: "@example.com" } } } });
await db.post.findMany({ where: { author: { is: { role: "ADMIN" } } } });
await db.post.findMany({ where: { author: { isNot: { role: "ADMIN" } } } });
await db.post.findMany({ where: { author: null } }); // posts without an author
```

Relation filters become `EXISTS (…)` subqueries and can be nested to any depth.

## Json filters

```ts
await db.event.findMany({
  where: {
    payload: { path: ["user", "country"], equals: "DE" },     // JSON_VALUE(…) = ?
    meta: { path: "$.score", gte: 0.5 },                       // JSON_VALUE(… RETURNING DOUBLE)
    tags: { array_contains: ["urgent", 3] },                  // the array has both elements
  },
});
```

- `path` is an array of keys and indexes (`["items", 0, "sku"]`) or a JSON path
  (`"$.items[0].sku"`). Without it the operators apply to the whole document.
- `equals` / `not` / `lt` / `lte` / `gt` / `gte` with a path compare a scalar: numbers as
  numbers, booleans as `true` / `false`. `equals: null` matches JSON `null` and a missing key.
- Without a path, `equals` compares the stored JSON text, so it only finds documents written in
  the same form. hana-orm writes compact `JSON.stringify` output.
- `string_contains`, `string_starts_with`, `string_ends_with` match the string at the path
  (`mode: "insensitive"` works).
- `array_contains` (one element, or a list of elements that must all be present),
  `array_starts_with` and `array_ends_with` take scalar elements. They match the array's JSON
  text, so an element of a nested array can also match.

## Full-text search

With a [full-text index](/hana-orm/schema/indexes-constraints/#full-text-indexes) on the column:

```ts
await db.article.findMany({ where: { body: { search: '"query builder" OR orm -legacy' } } });
await db.article.findMany({ where: { title: { not: { search: "draft" } } } });
```

The text uses HANA's `CONTAINS` syntax: words are combined with AND, `OR` between words, a
leading `-` excludes a word, `"…"` is a phrase. An empty search string is rejected.

## SQL in where

When a condition cannot be written with the operators, embed SQL with the `sql` tag. Columns of
the queried table render as qualified identifiers; every other value is bound:

```ts
import { sql, tables } from "./generated/hana/index.ts";

await db.user.findMany({
  where: { role: "AUTHOR", AND: [sql`LOWER(${tables.user.email}) = LOWER(${email})`] },
});

await db.user.findMany({
  where: { posts: { some: sql`LENGTH(${tables.post.title}) > ${50}` } },
});
```

A fragment can be the whole `where`, an item of `AND` / `OR` / `NOT`, or the filter of a
relation (then it refers to the related table). See [Query builder](/hana-orm/client/query-builder/#sql-fragments)
for `sql.identifier` and `sql.raw`.

## Validation

Filters are checked against the schema before anything is sent: an unknown field, a value of
the wrong type or an operator that does not fit the field type fails with a
`ValidationError`. The generated types catch most of these at compile time already.
