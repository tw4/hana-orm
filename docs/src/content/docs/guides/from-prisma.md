---
title: Coming from Prisma
sidebar:
  order: 1
---

hana-orm's schema language and client API follow Prisma closely, so most knowledge carries over.
Prisma has no SAP HANA connector; hana-orm is built for HANA only.

## Schema

- Rename `schema.prisma` to `schema.hana` and set `provider = "hana"` in the datasource; the
  generator provider is `"hana-orm"`.
- Models, fields, `@id`, `@unique`, `@default`, `@updatedAt`, `@map`, `@@map`, `@@id`,
  `@@unique`, `@@index`, `@relation`, `@ignore`, `@@ignore`, enums and implicit many-to-many
  relations work the same way.
- Native types use HANA names: `@db.NVarChar(320)`, `@db.Decimal(15, 2)`, `@db.NClob`,
  `@db.SecondDate`. See [Type mapping](/hana-orm/schema/types/).
- `Decimal` values are strings (not `Prisma.Decimal`), `BigInt` values are `bigint`.

## Client

| Prisma | hana-orm |
|---|---|
| `new PrismaClient()` | `new HanaClient()` (from your generated folder) |
| `prisma.user.findMany(…)` | `db.user.findMany(…)`, same arguments |
| `prisma.$transaction(…)` | `db.$transaction(…)`: callback and array forms, `timeout`, `maxWait`, `isolationLevel` |
| `prisma.$queryRawTyped(…)` (TypedSQL) | `db.$queryRawTyped(…)` with `hana-orm generate --sql` |
| `prisma.$queryRaw\`…\`` | `db.$queryRaw\`…\`` |
| `prisma.$extends(…)` | `db.$extends(…)`: `model`, `query`, `client`, `result` |
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

## Differences to keep in mind

- **Identifiers are case-sensitive.** HANA folds unquoted names to upper case; hana-orm quotes
  everything. Map to upper-case names if other tools query the tables.
- **Implicit many-to-many tables** use Prisma's layout (`_AToB` with `A` and `B`), so an existing
  Prisma-created schema keeps working.
- **No `RETURNING` in HANA.** Writes read the row back in the same transaction; the result is the
  same as in Prisma.
- **`Json` is stored as `NCLOB`.** Json filters use HANA's JSON functions; see
  [Json filters](/hana-orm/client/filtering/#json-filters).
- **Extra in hana-orm:** a [query builder](/hana-orm/client/query-builder/), prepared queries,
  `$batch`, full-text `search`, check constraints and sequences in the schema.
