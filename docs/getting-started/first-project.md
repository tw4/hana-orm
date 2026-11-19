---
title: Your first project
parent: Getting started
nav_order: 3
---

# Your first project
{: .no_toc }

1. TOC
{:toc}

This page builds a small blog: users, posts and tags.

## 1. Create the schema file

```sh
mkdir blog && cd blog
npm init -y
npm install hana-orm @sap/hana-client
npx hana-orm init
cp .env.example .env    # fill in the connection, see Connecting to HANA
```

`init` writes `schema.hana` with a `datasource` block, a `generator` block and an example
model. Replace the model with these:

```hana
datasource db {
  provider = "hana"
  host     = env("HANA_HOST")
  port     = env("HANA_PORT")
  user     = env("HANA_USER")
  password = env("HANA_PASSWORD")
  schema   = "BLOG"
}

generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
}

enum Role {
  READER
  AUTHOR
  ADMIN
}

/// A registered user
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.NVarChar(320)
  name      String?
  role      Role     @default(READER)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  posts     Post[]
}

model Post {
  id        Int     @id @default(autoincrement())
  title     String  @db.NVarChar(200)
  body      String? @db.NClob
  published Boolean @default(false)
  authorId  Int
  author    User    @relation(fields: [authorId], references: [id], onDelete: Cascade)
  tags      Tag[]

  @@index([authorId])
}

model Tag {
  name  String @id @db.NVarChar(50)
  posts Post[]
}
```

- `Post.author` holds the foreign key (`authorId`); `User.posts` is the other side.
- `Post.tags` and `Tag.posts` point at each other with no foreign key fields, so they form an
  implicit many-to-many relation with a join table.
- `///` comments end up in the generated types and as database comments.

Check the schema and lay it out:

```sh
npx hana-orm validate
npx hana-orm format
```

## 2. Create the tables

Make sure the schema `BLOG` exists (`CREATE SCHEMA BLOG`), then plan the first migration:

```sh
npx hana-orm migrate plan --name init
```

```
Created migration migrations/20261119093000_init with 10 operation(s):
  - Create table "Post"
  - Create table "Tag"
  - Create table "User"
  - Create table "_PostToTag"
  - Create index "IX_Post_authorId" on "Post" ("authorId")
  - Create index "IX__PostToTag_B" on "_PostToTag" ("B")
  - Add foreign key "FK_Post_authorId" on "Post" ("authorId") → "User"
  - Add foreign key "FK__PostToTag_A" on "_PostToTag" ("A") → "Post"
  - Add foreign key "FK__PostToTag_B" on "_PostToTag" ("B") → "Tag"
  - Set the comment of "User"
Review migration.sql, then run `hana-orm migrate deploy`.
```

Planning does not touch the database. Open `migrations/<id>_init/migration.sql`; it is the
literal SQL that will run. Then apply it:

```sh
npx hana-orm migrate deploy
npx hana-orm migrate status
```

{: .tip }
While you are still sketching the schema, `npx hana-orm db push` applies it directly without
writing migrations. Switch to `migrate plan` once the schema is shared with others.

## 3. Generate the client

```sh
npx hana-orm generate
```

This writes `src/generated/hana/index.ts`: a `HanaClient` class, a type per model (`User`,
`Post`, `Tag`), the `Role` enum, input types for every operation and typed `tables` for the
query builder. Run it again after each schema change, or keep `npx hana-orm generate --watch`
running.

## 4. Write and read data

```ts
// src/main.ts
import { HanaClient, Role } from "./generated/hana/index.ts";

const db = new HanaClient();

const ada = await db.user.create({
  data: {
    email: "ada@example.com",
    name: "Ada",
    role: Role.AUTHOR,
    posts: {
      create: [
        { title: "Hello HANA", published: true, tags: { connectOrCreate: [{ where: { name: "hana" }, create: { name: "hana" } }] } },
        { title: "Draft" },
      ],
    },
  },
  include: { posts: true },
});
// ada: User & { posts: Post[] }

const published = await db.post.findMany({
  where: { published: true, author: { role: Role.AUTHOR } },
  select: { title: true, author: { select: { name: true } }, tags: { select: { name: true } } },
  orderBy: { id: "desc" },
  take: 10,
});
// published: { title: string; author: { name: string | null }; tags: { name: string }[] }[]

await db.post.updateMany({ where: { authorId: ada.id, published: false }, data: { published: true } });

const perAuthor = await db.post.groupBy({ by: ["authorId"], _count: { _all: true } });

await db.$disconnect();
```

```sh
node src/main.ts
```

## 5. Change the schema

Add a field:

```hana
model Post {
  // …
  views Int @default(0)
}
```

```sh
npx hana-orm migrate plan --name post_views   # ALTER TABLE "Post" ADD ("views" INTEGER DEFAULT 0 NOT NULL)
npx hana-orm migrate deploy
npx hana-orm generate
```

Commit the schema and the `migrations/` folder together. Your colleagues and your deployment
run `migrate deploy` to catch up.

## Where to go from here

- [Schema](../schema/): every attribute, relation type and native HANA type.
- [Client](../client/): filters, nested writes, transactions, raw SQL, the query builder.
- [Migrations](../migrations/): renames, data migrations, drift, production deploys.
