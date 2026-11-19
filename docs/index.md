---
title: Home
nav_order: 1
description: "hana-orm is a type-safe TypeScript ORM for SAP HANA: a declarative schema, a generated client and reviewable SQL migrations."
permalink: /
---

# hana-orm
{: .fs-9 }

A type-safe TypeScript ORM for **SAP HANA**: a declarative schema, a generated client whose
result types follow your `select` / `include`, and a migrations CLI that produces reviewable SQL.
{: .fs-6 .fw-300 }

[Get started](getting-started/){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/tw4/hana-orm){: .btn .fs-5 .mb-4 .mb-md-0 }

---

{: .note }
hana-orm is a **release candidate** (`1.0.0-rc.1`, `npm install hana-orm@next`). The API is meant
to be stable for 1.0; breaking changes until then are listed in the
[changelog](https://github.com/tw4/hana-orm/blob/main/CHANGELOG.md).

## At a glance

```hana
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.NVarChar(320)
  name      String?
  createdAt DateTime @default(now())
  posts     Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int?
  author   User?  @relation(fields: [authorId], references: [id])
}
```

```ts
import { HanaClient } from "./generated/hana/index.ts";

const db = new HanaClient();

const users = await db.user.findMany({
  where: { email: { endsWith: "@example.com" } },
  select: { id: true, email: true, posts: { select: { title: true }, take: 3 } },
  orderBy: { createdAt: "desc" },
});
// users: { id: number; email: string; posts: { title: string }[] }[]
```

```sh
npx hana-orm migrate plan --name init   # writes migrations/<timestamp>_init/migration.sql
npx hana-orm migrate deploy             # applies it in one transaction
```

## Why hana-orm

- **Pure TypeScript, no query engine.** The only native piece is SAP's own `@sap/hana-client`.
  Queries are compiled to SQL in your process; there is no sidecar binary.
- **Types that follow the query.** `select`, `include` and `omit` shape the result type, down to
  nested relations and computed fields.
- **Made for HANA.** Identity columns, `@db.*` native types, several schemas, MDC tenant
  databases, full-text indexes, sequences, check constraints, column comments, HANA Cloud over
  TLS. `BIGINT` comes back as `bigint`, `DECIMAL` as a lossless string, `TIMESTAMP` as a UTC
  `Date`.
- **Migrations you can read.** Each migration is a folder with the literal HANA SQL that runs.
  Planning needs no database and no shadow database; deploying runs each migration in one
  transaction with transactional DDL, behind a lock.
- **Two query styles.** An object API (`findMany`, nested writes, `$transaction`) and a SQL-like
  builder (`db.select().from().leftJoin().where()`) share the same client, codecs and
  transactions.
- **Tools around it.** `db pull` for existing databases, a local data browser (`hana-orm
  studio`), a formatter, typed raw SQL from `.sql` files, a VS Code extension.

## Where to go next

| | |
|---|---|
| [Getting started](getting-started/) | install, connect, first schema, first query |
| [How it works](concepts.html) | schema, contract, client and migrations, and how they fit together |
| [Schema](schema/) | models, fields, attributes, relations, enums, views, type mapping |
| [Client](client/) | reading, filtering, writing, transactions, raw SQL, the query builder |
| [Migrations](migrations/) | plan, deploy, drift, existing databases, production |
| [Tools](tools/) | CLI reference, studio, VS Code extension |
| [Guides](guides/) | moving from Prisma, TypeORM or the raw driver; testing; several schemas |
| [Reference](reference/) | environment variables, HANA specifics, troubleshooting |
