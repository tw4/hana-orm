---
title: Starting from an existing database
parent: Getting started
nav_order: 4
---

# Starting from an existing database
{: .no_toc }

1. TOC
{:toc}

If the tables already exist, let hana-orm read them instead of writing the schema by hand.

## 1. Pull the schema

```sh
npx hana-orm init               # if you have no schema.hana yet
npx hana-orm db pull
```

`db pull` reads the default schema's catalog (tables, columns, primary keys, unique
constraints, foreign keys, indexes, full-text indexes, check constraints, comments) and writes
a model per table into `schema.hana`:

- Table and column names become model and field names (`ORDER_ITEMS` → `OrderItems` with
  `@@map("ORDER_ITEMS")`, `CREATED_AT` → `createdAt` with `@map("CREATED_AT")`).
- Foreign keys become relations on both sides. When two foreign keys point at the same table,
  the relation fields are named after the key columns: `CREATED_BY` and `UPDATED_BY` become
  `createdByUser` / `updatedByUser`, and `createdOrderItems` / `updatedOrderItems` on the other
  side.
- Join tables in the `_AToB` layout become implicit many-to-many fields.
- Column types become schema types with `@db.*` where the type is not the default (see
  [Type mapping](../schema/types.html)). Types hana-orm does not support become
  `Unsupported("TYPE")` and are hidden from the client.
- Identity columns get `@default(autoincrement())`; table and column comments become `///` docs.

For example, a table `ORDER_ITEMS` with two foreign keys to `USERS` becomes:

```hana
model OrderItems {
  id            Int      @id @default(autoincrement()) @map("ID")
  createdBy     Int      @map("CREATED_BY")
  updatedBy     Int?     @map("UPDATED_BY")
  qty           Int?     @map("QTY") @db.SmallInt
  price         Decimal? @map("PRICE") @db.Decimal(15, 2)
  createdByUser Users    @relation("OrderItems_createdByUser", fields: [createdBy], references: [id])
  updatedByUser Users?   @relation("OrderItems_updatedByUser", fields: [updatedBy], references: [id])

  @@map("ORDER_ITEMS")
}

/// People
model Users {
  id                Int          @id @map("ID")
  email             String       @unique @map("EMAIL") @db.NVarChar(320)
  createdAt         DateTime?    @map("CREATED_AT")
  createdOrderItems OrderItems[] @relation("OrderItems_createdByUser")
  updatedOrderItems OrderItems[] @relation("OrderItems_updatedByUser")

  @@map("USERS")
}
```

Choose what to read:

```sh
npx hana-orm db pull --tables 'ORDER*,CUSTOMERS'   # only these (patterns with * and ?)
npx hana-orm db pull --exclude 'TMP_*'             # everything except these
npx hana-orm db pull --db-schema SALES             # another schema (models get @@schema("SALES"))
npx hana-orm db pull --views                       # also read views as `view` blocks
npx hana-orm db pull --print                       # print instead of writing the file
```

Running `db pull` again updates the schema: models are kept in place, and your renames
(`@map` / `@@map`), `@ignore`, `@@ignore` and `sequence()` defaults survive.

## 2. Tidy up

Review the result before generating a client:

- Rename models and fields to what you want to see in code; keep `@map` / `@@map` so they still
  point at the same columns.
- Give relations clearer names.
- Hide columns or tables the application should not use with `@ignore` / `@@ignore`.

```sh
npx hana-orm format
npx hana-orm validate
npx hana-orm generate
```

## 3. Baseline the migrations

To manage future changes with migrations, record the current state as the first migration
without running it:

```sh
npx hana-orm migrate baseline
```

This writes `migrations/<timestamp>_init/` with the SQL that would create today's tables and
marks it as applied in this database. From now on use `migrate plan` and `migrate deploy` as
usual. On every other environment that already has the tables (staging, production), mark the
same migration as applied:

```sh
npx hana-orm migrate resolve --applied <timestamp>_init
```

## 4. Check for drift

```sh
npx hana-orm migrate status   # compares the database with the baseline
npx hana-orm db verify        # compares the database with the schema
```

Both report tables and columns that differ. Tables the schema does not define are ignored, so
a shared schema with tables that belong to other applications is fine.

{: .note }
If you only want to read data and never change the tables, you can skip migrations entirely:
pull, generate and query. See [Several schemas](../guides/multiple-schemas.html) for reading
tables from more than one schema.
