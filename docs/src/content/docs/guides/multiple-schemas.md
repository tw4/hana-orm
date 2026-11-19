---
title: Several schemas
sidebar:
  order: 5
---

HANA databases often spread tables over several schemas: one per application, a shared master
data schema, a staging schema for imports. hana-orm works with all of them from one client.

## The default schema and @@schema

```hana
datasource db {
  provider = "hana"
  url      = env("DATABASE_URL")
  schema   = "SHOP"               // models without @@schema live here
}

model Order {
  id         Int      @id @default(autoincrement())
  customerId Int
  customer   Customer @relation(fields: [customerId], references: [id])
}

model Customer {
  id     Int     @id
  name   String
  orders Order[]

  @@map("CUSTOMERS")
  @@schema("MASTERDATA")
}
```

- `Order` is `"SHOP"."Order"`, `Customer` is `"MASTERDATA"."CUSTOMERS"`.
- Relations across schemas work like any other: joins, `include`, nested writes and the foreign
  key constraint.
- Generated SQL always qualifies tables of `@@schema` models, so queries work regardless of the
  session's current schema.

## Reading tables of another schema

To bring tables of another schema into your schema file:

```sh
npx hana-orm db pull --db-schema MASTERDATA --tables 'CUSTOMERS,COUNTRIES'
```

The models get `@@schema("MASTERDATA")`. If a model name collides with one you already have, the
pulled model gets the schema as a prefix (`MasterdataAuditLog`).

## Migrations across schemas

- Migrations create, change and drop tables in every schema your models use; changing
  `@@schema` moves a table and keeps its data.
- Migrations do not create schemas. Create them beforehand and give the migration user the
  needed privileges on each.
- The history tables live in the default schema only.

If another team owns a schema, you usually do not want your migrations to change its tables.
Then either:

- mark the models with `@@ignore` and query them with [raw SQL](/hana-orm/client/raw-sql/) (they
  stay known to drift checks but are hidden from the client), or
- keep them in the schema as normal models for querying, and never plan changes to them; review
  migrations for operations on that schema.

A model that only reads a view or a table you do not own can also be a
[`view` block](/hana-orm/schema/enums-views/#views): never touched by migrations.

## One database, several applications

Give each application its own default schema. It then has its own migration history, lock and
marker, and `migrate reset` only drops that application's tables. Shared tables are referenced
with `@@schema`.

## Per-tenant schemas

For a schema per customer with identical tables, create one client per tenant with the `schema`
option:

```ts
const clients = new Map<string, HanaClient>();

function dbFor(tenant: string) {
  let c = clients.get(tenant);
  if (!c) clients.set(tenant, (c = new HanaClient({ schema: `TENANT_${tenant}`, poolSize: 3 })));
  return c;
}
```

Each client has its own pool, so keep `poolSize` small. Apply migrations to each tenant schema by
running `migrate deploy` with `HANA_SCHEMA` set per tenant (with no `schema` in the datasource
block); every tenant schema then has its own history.
