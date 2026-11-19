---
title: Schema
nav_order: 4
has_children: true
permalink: /schema/
---

# Schema

The schema describes your database connection, where the client is generated and your data
model. It is written in `.hana` files (a language close to Prisma's schema language) or in
[TypeScript](typescript.html).

```hana
// schema.hana
datasource db {
  provider = "hana"
  url      = env("DATABASE_URL")
  schema   = "APP"
}

generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
}

/// A customer of the shop
model Customer {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.NVarChar(320)
  name      String?
  createdAt DateTime @default(now()) @map("CREATED_AT")
  orders    Order[]

  @@map("CUSTOMERS")
}
```

## Building blocks

| block | purpose | page |
|---|---|---|
| `datasource` | the HANA connection and default schema | [Datasource and generator](datasource-generator.html) |
| `generator` | where and how the client is generated | [Datasource and generator](datasource-generator.html) |
| `model` | a table | [Models and fields](models.html) |
| `view` | a read-only model over a database view | [Enums and views](enums-views.html) |
| `enum` | a fixed set of values | [Enums and views](enums-views.html) |

## Syntax

- One declaration per block; fields one per line: `name Type attributes…`.
- `?` after a type makes the field optional (nullable column), `[]` makes it a list (only for
  relations).
- Field attributes start with `@`, block attributes with `@@`.
- `//` is a comment. `///` is a doc comment: it is shown in the generated types and becomes the
  table or column comment in the database.
- Strings use double quotes; lists use brackets: `@@index([a, b])`.
- Values in `datasource` and `generator` are literals or `env("NAME")`.

## Pages in this section

- [Datasource and generator](datasource-generator.html)
- [Models and fields](models.html): scalar types, field attributes, defaults, names
- [Relations](relations.html): one-to-one, one-to-many, many-to-many, self relations,
  referential actions
- [Enums and views](enums-views.html)
- [Indexes and constraints](indexes-constraints.html): primary keys, unique, indexes,
  full-text indexes, check constraints, sequences, comments
- [Ignoring fields and models](ignoring.html)
- [Several files and formatting](multi-file.html)
- [Schema in TypeScript](typescript.html)
- [Type mapping](types.html): schema types, HANA columns and TypeScript types

## Checking the schema

```sh
npx hana-orm validate   # errors with file, line and column
npx hana-orm format     # canonical layout
```

The [VS Code extension](../tools/vscode.html) shows the same errors while you type.
