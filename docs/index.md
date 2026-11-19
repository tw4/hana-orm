---
title: Home
nav_order: 1
---

# hana-orm

A type-safe TypeScript ORM for **SAP HANA**: a declarative schema, a generated client whose
result types follow your `select` / `include`, and a migrations CLI that produces reviewable SQL.

{: .warning }
hana-orm is a **release candidate** (`1.0.0-rc.1`, `npm install hana-orm@next`). The API is meant
to be stable for 1.0; breaking changes until then are listed in the
[changelog](https://github.com/tw4/hana-orm/blob/main/CHANGELOG.md).

- **Pure TypeScript**, no native query engine. The only native piece is SAP's own `@sap/hana-client`.
- **Familiar query API**: `findMany`, `include`, nested writes, `$transaction`, `$extends`.
- **HANA-aware**: identity columns, `@db.*` native types, schemas, MDC tenant databases,
  `BIGINT` → `bigint`, `DECIMAL` → `string`, `TIMESTAMP` → `Date` (UTC).
- **Migrations are plain files** with literal HANA SQL, applied in transactions; no shadow database.

```ts
const users = await db.user.findMany({
  where: { email: { endsWith: "@example.com" } },
  select: { id: true, email: true, posts: { select: { title: true }, take: 3 } },
  orderBy: { createdAt: "desc" },
});
// { id: number; email: string; posts: { title: string }[] }[]
```

## Where to go next

| | |
|---|---|
| [Getting started](getting-started.md) | install, connect, first schema, first query |
| [Schema reference](schema.md) | models, fields, attributes, relations, enums |
| [Client API](client.md) | queries, filters, writes, transactions, raw SQL, extensions |
| [Migrations](migrations.md) | plan, deploy, status, drift, baseline, reset |
| [CLI](cli.md) | every command and option |
| [HANA type mapping](types.md) | schema types ↔ HANA column types ↔ TypeScript |
| [Guides](guides/index.md) | moving from Prisma, TypeORM or the raw driver |
