---
title: Coming from Prisma
parent: Guides
nav_order: 1
---

# Coming from Prisma

hana-orm's schema language and client API follow Prisma closely, so most knowledge carries over.
Prisma has no SAP HANA connector; hana-orm is built for HANA only.

## Schema

- Rename `schema.prisma` to `schema.hana` and set `provider = "hana"` in the datasource; the
  generator provider is `"hana-orm"`.
- Models, fields, `@id`, `@unique`, `@default`, `@updatedAt`, `@map`, `@@map`, `@@id`,
  `@@unique`, `@@index`, `@relation`, `@ignore`, `@@ignore`, enums and implicit many-to-many
  relations work the same way.
- Native types use HANA names: `@db.NVarChar(320)`, `@db.Decimal(15, 2)`, `@db.NClob`,
  `@db.SecondDate`. See [type mapping](../types.md).
- `Decimal` values are strings (not `Prisma.Decimal`), `BigInt` values are `bigint`.

## Client

| Prisma | hana-orm |
|---|---|
| `new PrismaClient()` | `new HanaClient()` (from your generated folder) |
| `prisma.user.findMany(…)` | `db.user.findMany(…)` — same arguments |
| `prisma.$transaction(…)` | `db.$transaction(…)` — callback and array forms, `timeout`, `maxWait`, `isolationLevel` |
| `prisma.$queryRaw\`…\`` | `db.$queryRaw\`…\`` |
| `prisma.$extends(…)` | `db.$extends(…)` — `model`, `query`, `client` |
| `Prisma.PrismaClientKnownRequestError` `P2002` | `DatabaseError` with `code: "UNIQUE_CONSTRAINT"` |

## Migrations

| Prisma | hana-orm |
|---|---|
| `prisma migrate dev` | `hana-orm migrate plan --name …` then `migrate deploy` |
| `prisma migrate deploy` | `hana-orm migrate deploy` |
| `prisma migrate resolve` | `hana-orm migrate resolve` |
| `prisma migrate diff` | `hana-orm migrate diff` |
| `prisma db pull` / `db push` / `db seed` | same commands |
| shadow database | not needed: planning compares the stored `contract.json` with the schema |

Migration folders contain `ops.json` (what runs) next to `migration.sql` (for review), and each
migration runs in a transaction with transactional DDL.
