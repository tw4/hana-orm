---
title: Indexes and constraints
sidebar:
  order: 5
---

## Block attributes

| attribute | meaning |
|---|---|
| `@@id([a, b], map: "PK")` | composite primary key |
| `@@unique([a, b], name: "a_b", map: "UQ")` | composite unique constraint; `name` is its key in `findUnique` |
| `@@index([a, b], map: "IX")` | index |
| `@@fulltext([a, b])` | one full-text index per field |
| `@@check("SQL", map: "CK")` | check constraint |
| `@@map("TABLE")` | table name |
| `@@schema("SCHEMA")` | database schema of the table |
| `@@ignore` | keep the table for migrations, hide the model from the client |

## Primary keys

Every model needs a primary key: `@id` on one field or `@@id([…])` over several. Views do
not. The constraint is named `PK_<TABLE>` unless `map:` says otherwise.

## Unique constraints

```hana
model Membership {
  id     Int @id @default(autoincrement())
  teamId Int
  userId Int

  @@unique([teamId, userId], name: "member")
}
```

```ts
await db.membership.findUnique({ where: { member: { teamId: 1, userId: 7 } } });
await db.membership.upsert({ where: { member: { teamId: 1, userId: 7 } }, create: { teamId: 1, userId: 7 }, update: {} });
```

Without `name`, the key is the field names joined with `_` (`teamId_userId`). Constraints are
named `UQ_<TABLE>_<COLUMNS>`.

A violation fails with `DatabaseError` and `code: "UNIQUE_CONSTRAINT"`.

## Indexes

```hana
@@index([customerId])
@@index([status, orderedAt], map: "IX_ORDERS_STATUS_DATE")
```

Index names default to `IX_<TABLE>_<COLUMNS>`. Names longer than HANA's 127 characters are
shortened with a hash.

:::tip
HANA's column store keeps every column in an in-memory dictionary, so many lookups are fast
even without an index. Indexes still help selective filters on large tables and foreign keys
used in joins. Measure with `EXPLAIN PLAN` before adding many.
:::

## Full-text indexes

```hana
model Article {
  id    Int     @id
  title String
  body  String? @db.NClob

  @@fulltext([title, body])
}
```

```ts
await db.article.findMany({ where: { body: { search: '"query builder" OR orm -legacy' } } });
// WHERE CONTAINS("body", ?)
```

- HANA indexes one column per full-text index, so `@@fulltext([title, body])` creates two
  indexes, `FTI_<TABLE>_title` and `FTI_<TABLE>_body`. With `map:` it takes a single field.
- Only `String` fields can have a full-text index.
- The `search` filter takes HANA's `CONTAINS` syntax: words are combined with AND, `OR`
  between words, `-word` excludes, `"…"` is a phrase. The text is bound as a parameter.
- Migrations create and drop the indexes; `db pull` writes `@@fulltext`.

## Check constraints

```hana
model Order {
  id     Int     @id @default(autoincrement())
  total  Decimal @map("TOTAL") @db.Decimal(15, 2)
  status String  @default("open") @map("STATUS") @db.NVarChar(20)

  @@check("TOTAL >= 0")
  @@check("STATUS IN ('open', 'paid')", map: "CK_ORDERS_STATUS")
  @@map("ORDERS")
}
```

- The condition is raw SQL and uses **column** names, not field names.
- Without `map:` the constraint is named `CK_<TABLE>_<n>` by its position.
- Adding a check runs a pre-check: the migration fails, before changing anything, when existing
  rows violate it. A changed condition is dropped and added again.
- Conditions are compared ignoring case, spacing and outer parentheses, so reformatting one does
  not create a migration.

## Sequences

```hana
model Invoice {
  no     Int    @id @default(sequence("INVOICE_NO", start: 1000)) @map("NO")
  ref    BigInt @default(sequence("INVOICE_REF", increment: 10))
  amount Decimal
}
```

- `sequence("NAME", start: 1, increment: 1)` on an `Int` or `BigInt` field creates the sequence
  in the model's schema.
- HANA has no sequence column defaults, so the client inserts `"NAME".NEXTVAL` and reads the
  value back with `CURRVAL`. Rows inserted by other tools must use the sequence themselves.
- Several fields may share a sequence when they use the same options.
- `start` only applies when the sequence is created. A changed `increment` becomes
  `ALTER SEQUENCE`.
- `db pull` cannot see which column uses a sequence. It keeps `sequence()` defaults that are
  already in the schema but does not add new ones.
- Drift checks only look at the sequences the schema defines.

Prefer `autoincrement()` (identity columns) unless several tables share a number range or the
numbers must be known before inserting.

## Comments

`///` doc comments on models and fields become `COMMENT ON TABLE` / `COMMENT ON COLUMN`:

```hana
/// Customer orders.
model Order {
  /// Order number shown to customers.
  no Int @id
}
```

`db pull` writes table and column comments back as `///`. Comments do not change the contract
hash, but migrations keep them in sync.

## Constraint names

| object | default name |
|---|---|
| primary key | `PK_<TABLE>` |
| unique | `UQ_<TABLE>_<COLUMNS>` |
| index | `IX_<TABLE>_<COLUMNS>` |
| foreign key | `FK_<TABLE>_<COLUMNS>` |
| full-text index | `FTI_<TABLE>_<COLUMN>` |
| check | `CK_<TABLE>_<n>` |

Columns are joined with `_`. Names over 127 characters are cut and end with a hash. A changed
index name becomes `RENAME INDEX` in the next migration. HANA cannot rename constraints, so a
changed primary key, unique, foreign key or check name drops the constraint and adds it again.
