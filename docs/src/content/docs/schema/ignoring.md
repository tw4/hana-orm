---
title: Ignoring fields and models
description: "Keep columns and tables known to migrations while hiding them from the client."
sidebar:
  order: 6
---

`@ignore` on a field and `@@ignore` on a model keep a column or table in the schema, so
migrations and drift checks still know about it, but hide it from the generated client.

```hana
model User {
  id        Int     @id
  email     String  @unique
  legacyKey String? @ignore @map("LEGACY_KEY")
  audits    Audit[] @ignore
}

model Audit {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id])

  @@ignore
}
```

Typical uses:

- Columns that another application still needs but yours should not touch.
- Tables that belong to a batch job or an ETL process in the same schema.
- Columns of types the client cannot handle well yet.

## Rules

- A primary key field cannot be ignored; ignore the whole model instead.
- A relation that points to an ignored model, or that uses an ignored foreign key field, must
  be ignored too, and both sides of a relation are ignored together.
- Unique constraints that use an ignored field are not offered in `where` of `findUnique`.
- The client cannot write an ignored column, so a required ignored column needs a database
  default for `create` to work.
- `Unsupported("TYPE")` fields are always hidden from the client, with or without `@ignore`.
- `db pull` keeps `@ignore` and `@@ignore` when it updates an existing schema.

## Ignoring vs. leaving out

A table that is not in the schema at all is invisible to hana-orm: migrations neither create nor
drop it, and drift checks ignore it. Use `@@ignore` when the table belongs to your project and
should be created by your migrations, and leave it out when it belongs to someone else.
