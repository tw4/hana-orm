---
title: Schema reference
nav_order: 3
---

# Schema reference
{: .no_toc }

1. TOC
{:toc}

A schema is one `.hana` file, or a folder whose `*.hana` files are merged (sorted by name; one
`datasource` block in total). `hana-orm format` lays it out canonically; `hana-orm validate`
checks it.

## datasource

```
datasource db {
  provider = "hana"
  host     = env("HANA_HOST")
  port     = env("HANA_PORT")
  user     = env("HANA_USER")
  password = env("HANA_PASSWORD")
  databaseName = "HXE"          // tenant database when connecting through the SYSTEMDB port
  schema   = "APP"              // default schema of models without @@schema
  encrypt  = true               // TLS, required for HANA Cloud
}
```

`url = env("DATABASE_URL")` (`hana://user:password@host:port/?databaseName=DB&currentSchema=APP&encrypt=true`)
can replace the separate fields. Values are literals or `env("NAME")`.

## generator

```
generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"   // relative to the schema
  seed     = "node ./seed.ts"         // used by `hana-orm db seed`
}
```

## model

```
/// Shown in the generated types
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  posts Post[]

  @@map("USERS")
}
```

A field is `name Type` with `?` for optional (nullable) and `[]` for a list (relations only).
Scalar types: `String`, `Int`, `BigInt`, `Float`, `Decimal`, `Boolean`, `DateTime`, `Bytes`,
`Json`, an enum name, or `Unsupported("HANA_TYPE")` for columns the client should not see. See
[HANA type mapping](types.md).

### Field attributes

| attribute | meaning |
|---|---|
| `@id` / `@id(map: "PK")` | single-field primary key |
| `@unique` / `@unique(map: "UQ")` | unique constraint |
| `@default(…)` | `autoincrement()` (identity), `now()`, `uuid()`, `cuid()`, `dbgenerated("SQL")`, or a literal / enum value |
| `@updatedAt` | set to the current time on every write |
| `@map("COLUMN")` | column name |
| `@db.NVarChar(320)`, `@db.Decimal(15, 2)`, `@db.NClob`, … | native HANA type |
| `@relation(…)` | relation details, see below |
| `@ignore` | keep the column for migrations, hide it from the client |

### Block attributes

| attribute | meaning |
|---|---|
| `@@id([a, b], map: "PK")` | compound primary key |
| `@@unique([a, b], name: "a_b", map: "UQ")` | compound unique; `name` is the key in `findUnique` |
| `@@index([a, b], map: "IX")` | index |
| `@@map("TABLE")` | table name |
| `@@schema("OTHER")` | database schema of the table |
| `@@ignore` | keep the table for migrations, hide the model from the client |

Constraint names default to `PK_<TABLE>`, `UQ_<TABLE>_<COLUMNS>`, `IX_<TABLE>_<COLUMNS>`,
`FK_<TABLE>_<COLUMNS>` (trimmed with a hash beyond 127 characters).

## view

`view Name { … }` declares a read-only model over an existing database view. Views are not
created or changed by migrations.

## enum

```
enum Role {
  USER
  ADMIN @map("admin")   // stored value
}
```

Enums are stored as `NVARCHAR(255)` (or the field's `@db.*` type).

## Relations

One side holds the foreign key:

```
model Post {
  authorId Int?
  author   User? @relation(fields: [authorId], references: [id], onDelete: SetNull, onUpdate: Cascade, map: "FK_POST_AUTHOR")
}

model User {
  posts Post[]
}
```

- `onDelete` / `onUpdate`: `Cascade`, `Restrict`, `NoAction` (= `RESTRICT` in HANA), `SetNull`, `SetDefault`.
- Two relations between the same models need names: `@relation("written")` on both sides.
- **Implicit many-to-many**: two list fields pointing at each other with no `fields` side create a
  join table `_AToB` with columns `A` and `B` (the Prisma layout). Both models need a single-field `@id`.
- One-to-one: the foreign key field is `@unique`, the other side is optional (`Profile?`).

## Ignoring parts of a database

`@ignore` / `@@ignore` keep columns and tables in the schema so migrations and drift checks know
them, while the client does not expose them. A relation to an ignored model must be ignored too.
A required ignored column needs a database default for `create` to work.
