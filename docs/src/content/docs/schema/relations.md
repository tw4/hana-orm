---
title: Relations
sidebar:
  order: 3
---

A relation connects two models. One side holds the foreign key and declares
`@relation(fields: […], references: […])`; the other side is a plain field of the related type.
Migrations create the foreign key constraint.

## One-to-many

```hana
model User {
  id    Int    @id @default(autoincrement())
  posts Post[]
}

model Post {
  id       Int  @id @default(autoincrement())
  authorId Int
  author   User @relation(fields: [authorId], references: [id])

  @@index([authorId])
}
```

- `Post.authorId` is the foreign key column; `Post.author` is the relation field (no column).
- `User.posts` is the back relation (no column).
- HANA does not index foreign keys automatically. Add `@@index([authorId])` when you filter or
  join by it, which is almost always.

An optional relation uses an optional foreign key: `authorId Int?` and `author User?`.

## One-to-one

Make the foreign key unique; the other side is optional:

```hana
model User {
  id      Int      @id @default(autoincrement())
  profile Profile?
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String @db.NClob
  userId Int    @unique
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

## Many-to-many

### Implicit

Two list fields that point at each other, with no `fields` / `references`, form an implicit
many-to-many relation:

```hana
model Post {
  id   Int   @id @default(autoincrement())
  tags Tag[]
}

model Tag {
  name  String @id
  posts Post[]
}
```

Migrations create a join table `_PostToTag` with columns `A` and `B`, a primary key on both,
an index on `B` and cascading foreign keys. `A` references the model whose name sorts first.
This is the same layout Prisma uses, so existing Prisma databases keep working, and `db pull`
turns such tables back into list fields. With `@relation("Name")` on both sides the table is
called `_Name`.

- Both models need a single-field `@id`.
- Filters (`some` / `every` / `none`), `include`, `_count`, ordering by count and the nested
  writes `create`, `connect`, `connectOrCreate`, `disconnect`, `set`, `update`, `updateMany`,
  `upsert`, `delete`, `deleteMany` work through the join table. There is no nested
  `createMany`.

### Explicit

When the link needs its own columns (a date, a role, a position), model the join table:

```hana
model Post {
  id   Int       @id @default(autoincrement())
  tags PostTag[]
}

model Tag {
  name  String    @id
  posts PostTag[]
}

model PostTag {
  postId    Int
  tagName   String
  addedAt   DateTime @default(now())
  post      Post     @relation(fields: [postId], references: [id], onDelete: Cascade)
  tag       Tag      @relation(fields: [tagName], references: [name], onDelete: Cascade)

  @@id([postId, tagName])
  @@index([tagName])
}
```

## Self relations

A model can refer to itself. Name the relation so both fields belong together:

```hana
model Employee {
  id        Int        @id @default(autoincrement())
  managerId Int?
  manager   Employee?  @relation("Reports", fields: [managerId], references: [id])
  reports   Employee[] @relation("Reports")
}
```

An implicit many-to-many self relation works too (`followers User[] @relation("Follows")` and
`following User[] @relation("Follows")`).

## Several relations between the same models

Give each relation a name and use it on both sides:

```hana
model User {
  id            Int     @id @default(autoincrement())
  writtenPosts  Post[]  @relation("written")
  reviewedPosts Post[]  @relation("reviewed")
}

model Post {
  id         Int   @id @default(autoincrement())
  authorId   Int
  reviewerId Int?
  author     User  @relation("written", fields: [authorId], references: [id])
  reviewer   User? @relation("reviewed", fields: [reviewerId], references: [id])
}
```

## Composite foreign keys

`fields` and `references` take lists of the same length:

```hana
model Shipment {
  id      Int       @id @default(autoincrement())
  orderId Int
  lineNo  Int
  item    OrderItem @relation(fields: [orderId, lineNo], references: [orderId, lineNo])
}
```

`references` must point at the primary key or a unique constraint of the other model.

## Referential actions

```hana
author User @relation(fields: [authorId], references: [id], onDelete: Cascade, onUpdate: Cascade)
```

| action | effect when the referenced row is deleted / its key updated |
|---|---|
| `Cascade` | delete / update the referencing rows too |
| `Restrict` | refuse (the default) |
| `NoAction` | same as `Restrict` in HANA |
| `SetNull` | set the foreign key to `NULL` (the field must be optional) |
| `SetDefault` | set the foreign key to its default |

These are database constraints: they apply to deletes made by raw SQL and other tools as well.

## Naming the constraint

Foreign keys are named `FK_<TABLE>_<COLUMNS>`. Give your own name with `map`:

```hana
author User @relation(fields: [authorId], references: [id], map: "FK_POST_AUTHOR")
```

## Relations across schemas

A model with `@@schema("SALES")` can reference a model in the default schema and the other way
round; the foreign key is created with qualified names. See
[Several schemas](/hana-orm/guides/multiple-schemas/).

## Querying relations

See [Reading data](/hana-orm/client/reading/#relations), [Filtering](/hana-orm/client/filtering/#relation-filters)
and [Nested writes](/hana-orm/client/nested-writes/).
