# hana-orm

A type-safe TypeScript ORM for **SAP HANA**: a declarative schema, a generated client whose
result types follow your `select`/`include`, and a migrations CLI that produces reviewable SQL.

> Status: **alpha** (`0.1.0-alpha`). APIs may still change. See [ROADMAP.md](ROADMAP.md).

- Pure TypeScript, no native query engine. The only native piece is SAP's own `@sap/hana-client`.
- Familiar query API: `findMany`, `include`, nested writes, `$transaction`, `$extends`.
- HANA-aware: identity columns, `@db.*` native types, schemas, MDC tenant databases,
  `BIGINT` → `bigint`, `DECIMAL` → `string`, `TIMESTAMP` → `Date` (UTC).
- Migrations are plain files with literal HANA SQL, applied in transactions; no shadow database.

## Install

```sh
npm install hana-orm @sap/hana-client
```

Node.js 22.12 or newer.

## Quick start

```sh
npx hana-orm init        # creates schema.hana and .env.example
cp .env.example .env     # fill in HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD
npx hana-orm db pull     # optional: read an existing database into the schema
npx hana-orm generate    # writes the typed client
```

### Schema

```hana
datasource db {
  provider = "hana"
  host     = env("HANA_HOST")
  port     = env("HANA_PORT")
  user     = env("HANA_USER")
  password = env("HANA_PASSWORD")
  schema   = "APP"                   // default schema for tables
}

generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.NVarChar(320)
  name      String?
  role      Role     @default(USER)
  balance   Decimal  @default(0) @db.Decimal(15, 2)
  createdAt DateTime @default(now()) @map("CREATED_AT")
  updatedAt DateTime @updatedAt @map("UPDATED_AT")
  posts     Post[]

  @@map("USERS")
}

model Post {
  id       Int     @id @default(autoincrement())
  title    String
  authorId Int?
  author   User?   @relation(fields: [authorId], references: [id], onDelete: SetNull)

  @@index([authorId])
}
```

Instead of separate fields the datasource also accepts
`url = env("DATABASE_URL")` with `hana://user:password@host:port/?databaseName=DB&currentSchema=APP&encrypt=true`.

### Queries

```ts
import { HanaClient } from "./generated/hana/index.ts";

const db = new HanaClient();

const users = await db.user.findMany({
  where: { email: { endsWith: "@example.com" }, posts: { some: { title: { contains: "hana" } } } },
  select: { id: true, email: true, posts: { select: { title: true }, take: 3 } },
  orderBy: { createdAt: "desc" },
  take: 20,
});
// users: { id: number; email: string; posts: { title: string }[] }[]

const user = await db.user.create({
  data: { email: "ada@example.com", posts: { create: [{ title: "Hello HANA" }] } },
  include: { posts: true },
});

await db.user.update({ where: { id: user.id }, data: { balance: { increment: 10 } } });

await db.$transaction(async (tx) => {
  const u = await tx.user.findUniqueOrThrow({ where: { email: "ada@example.com" } });
  await tx.post.deleteMany({ where: { authorId: u.id } });
});

const stats = await db.post.groupBy({ by: ["authorId"], _count: { _all: true } });
const rows = await db.$queryRaw`SELECT COUNT(*) AS "n" FROM "APP"."USERS" WHERE "role" = ${"ADMIN"}`;
```

Supported: `findMany`, `findFirst(OrThrow)`, `findUnique(OrThrow)`, `count`, `aggregate`, `groupBy`,
`create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`; filters
(`equals`, `not`, `in`, `notIn`, `lt/lte/gt/gte`, `contains/startsWith/endsWith`, `mode: "insensitive"`,
`AND/OR/NOT`, relation filters `some/every/none/is/isNot`); nested writes (`create`, `createMany`,
`connect`, `connectOrCreate`, `disconnect`, `set`, `update`, `updateMany`, `upsert`, `delete`,
`deleteMany`); cursor pagination; `_count`; `$extends` (model methods and query hooks).

Client options: `new HanaClient({ log: true, poolSize: 10, schema: "APP", datasource: { host: "..." } })`.

### Migrations

```sh
npx hana-orm migrate plan --name add_posts   # writes migrations/<timestamp>_add_posts/{ops.json,migration.sql}
npx hana-orm migrate show                    # print the pending SQL
npx hana-orm migrate deploy                  # apply pending migrations
npx hana-orm migrate status                  # applied / pending / drift
```

- Planning compares the previous migration's contract with the current schema; it does not
  need a database or a shadow database.
- Each migration runs in its own transaction with transactional DDL, behind a lock, and is
  recorded with a checksum. Edited or out-of-order migrations are reported, not applied.
- Destructive changes (dropping tables or columns, narrowing types) need `--allow-destructive`.
- For an existing database: `hana-orm db pull`, then `hana-orm migrate baseline`.
- For prototyping: `hana-orm db push` applies the schema directly without history.

## Development

```sh
npm install
npm run typecheck
npm test                    # unit + type tests, no database needed
npm run test:integration    # needs HANA_* env vars; writes only to temporary tables
```

## License

[Apache License 2.0](LICENSE)
