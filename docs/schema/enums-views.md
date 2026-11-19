---
title: Enums and views
parent: Schema
nav_order: 4
---

# Enums and views
{: .no_toc }

1. TOC
{:toc}

## Enums

```hana
enum OrderStatus {
  OPEN
  PAID
  SHIPPED
  CANCELLED @map("cancelled")
}

model Order {
  id     Int         @id @default(autoincrement())
  status OrderStatus @default(OPEN)
}
```

- HANA has no enum type. The column is `NVARCHAR(255)` (or the field's `@db.*` type) and stores
  the value's name, or its `@map` name.
- The client validates values: writing or filtering with a value that is not in the enum fails
  with a `ValidationError` before anything is sent.
- The generated file exports the enum as a constant and a type:

```ts
import { OrderStatus } from "./generated/hana/index.ts";

await db.order.findMany({ where: { status: OrderStatus.PAID } });
await db.order.findMany({ where: { status: { in: ["OPEN", "PAID"] } } });   // plain strings work too
// OrderStatus is "OPEN" | "PAID" | "SHIPPED" | "CANCELLED"
```

`@map` changes only what is stored: code always sees `CANCELLED`, the column holds
`cancelled`. This is useful when the values already exist in a legacy table.

Adding a value is a schema change without a database change. Removing or renaming a value
does not touch existing rows; update them in a [data migration](../migrations/custom.html).

Use `@@map("NAME")` on an enum to give it a database name (shown by `db pull`); it does not
create anything in HANA.

## Views

A `view` block describes an existing database view. The client can read from it like from a
model; migrations never create, change or drop it.

```sql
CREATE VIEW "APP"."ACTIVE_CUSTOMERS" AS
  SELECT "ID", "EMAIL", "NAME" FROM "APP"."CUSTOMERS" WHERE "ACTIVE" = TRUE;
```

```hana
view ActiveCustomer {
  id    Int     @map("ID")
  email String  @map("EMAIL")
  name  String? @map("NAME")

  @@map("ACTIVE_CUSTOMERS")
}
```

```ts
const active = await db.activeCustomer.findMany({ where: { email: { endsWith: "@example.com" } }, take: 50 });
const n = await db.activeCustomer.count();
```

- Reads work: `findMany`, `findFirst`, `count`, `aggregate`, `groupBy`, filters, ordering,
  pagination. `findUnique` needs a unique field; mark one with `@unique` if the view has a
  natural key.
- Writes are not generated for views.
- Create and change the view with a [hand-written migration](../migrations/custom.html), or
  outside hana-orm.
- `db pull --views` reads existing views into `view` blocks.
- [Studio](../tools/studio.html) shows views read-only.
