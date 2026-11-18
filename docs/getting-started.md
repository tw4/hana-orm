---
title: Getting started
nav_order: 2
---

# Getting started

## Install

```sh
npm install hana-orm @sap/hana-client
```

Node.js 22.12 or newer. `@sap/hana-client` is SAP's driver; hana-orm loads it from your project.

## Create a schema

```sh
npx hana-orm init        # creates schema.hana and .env.example
cp .env.example .env     # fill in HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD
```

`schema.hana` describes the connection, where the client is generated and your models:

```
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

The datasource also accepts a single URL:
`url = env("DATABASE_URL")` with `hana://user:password@host:port/?databaseName=DB&currentSchema=APP&encrypt=true`.
For HANA Cloud set `encrypt = true`.

### Already have a database?

```sh
npx hana-orm db pull           # writes models for the existing tables into schema.hana
npx hana-orm migrate baseline  # records the current state as the first migration
```

## Create the tables

```sh
npx hana-orm migrate plan --name init   # writes migrations/<timestamp>_init/
npx hana-orm migrate deploy             # applies it
```

Review `migration.sql` before deploying: it is the literal SQL that runs. See
[Migrations](migrations.md).

## Generate the client and query

```sh
npx hana-orm generate
```

```ts
import { HanaClient } from "./generated/hana/index.ts";

const db = new HanaClient();

const ada = await db.user.create({
  data: { email: "ada@example.com", posts: { create: [{ title: "Hello HANA" }] } },
  include: { posts: true },
});

const recent = await db.post.findMany({
  where: { author: { email: "ada@example.com" } },
  orderBy: { id: "desc" },
  take: 10,
});

await db.$disconnect();
```

Re-run `hana-orm generate` (or keep `hana-orm generate --watch` running) after changing the
schema. Continue with the [Client API](client.md).
