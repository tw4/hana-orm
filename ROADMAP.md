# hana-orm Roadmap

A type-safe TypeScript ORM for SAP HANA: a declarative schema, a generated typed client and
a migrations CLI whose output is plain, reviewable HANA SQL.

## Design principles

1. **Pure TypeScript, no native engine.** The only native piece is SAP's own
   `@sap/hana-client` driver, used as a peer dependency. ESM-first, and usable through
   `require(esm)` on Node 22+; the generated client needs no top-level `await`.
2. **Contract first.** A schema file (`schema.hana`) is compiled into a contract plus
   generated TypeScript types. The contract has a stable hash that the database records
   (`db sign` / `db verify`).
3. **Object query API.** `findMany`, `create`, `include`, nested writes
   (`create`, `connect`, `connectOrCreate`, ...), `$transaction` and `$extends`. An SQL-like
   builder may be added next to it, never instead of it.
4. **Migrations are data.** Each migration is a list of operations with literal HANA SQL
   that can be reviewed (`migrate show`), plus pre-checks and post-checks. Planning and
   applying are separate steps (`migrate plan`, `migrate deploy`).
5. **No shadow database.** The planner compares contract with contract; drift is checked by
   reading the live catalog, in any environment (`migrate status`, `db verify`).
6. **Migrations form a chain.** Each migration records the contract hash it starts from and
   ends at, so out-of-order or diverged migrations after a branch merge are reported, not
   applied.
7. **Predictable types.** One codec per type, covered by tests: `DateTime` → `Date` (UTC),
   `BigInt` → `bigint`, `Decimal` → string. Paginated queries always emit `LIMIT`/`OFFSET`;
   parameters are always bound, never inlined.
8. **HANA-native.** Column tables, schemas, identity columns, `NVARCHAR` limits, MDC tenant
   databases and HANA type behaviour are first-class.
9. **Safe on existing databases.** Large existing schemas with hundreds of tables can be
   introspected and baselined without touching data.
10. **Stable releases.** Semver; pre-releases are published only under the npm `next` tag,
    and every breaking change ships with an upgrade note.
11. **No private data in the repository.** Connection details come only from the
    environment; tests, fixtures and examples use synthetic schemas and data.

## Architecture

```
schema.hana ──► parser ──► contract (json + hash) ──► generator ──► typed client (.ts)
                                   │
                                   ├──► migration planner ──► migrations/<id>/ops.json + migration.sql
                                   │
live HANA ◄── introspector ────────┘ (db pull, drift detection)

typed client ──► query compiler (cached plans) ──► driver (pool, tx, codecs) ──► @sap/hana-client
```

Package layout (single package first, split later if needed):

- `hana-orm` – CLI (`hana-orm ...`)
- `hana-orm/runtime` – client runtime used by generated code
- `hana-orm/schema` – parser and contract builder (usable programmatically)
- `hana-orm/migrate` – planner, applier, introspector

## Milestones

### M0 – Foundations
- Repository, TypeScript 7, ESM build, `node:test` setup, lint, CI.
- Driver wrapper over `@sap/hana-client`: promises, connection pool, transactions,
  logging, connection config from `.env` (`HANA_HOST`, `HANA_PORT`, `HANA_USER`, …) or URL.
- Integration test harness: local temporary tables (`#TABLE`), or a dedicated test schema,
  so tests never write to production tables.
- Open source hygiene: Apache 2.0 license, contributing and security guides, secret scanning in
  CI, `.env` never committed, no real host names, users or business data in fixtures.

### M1 – Schema language and contract
- Declarative syntax: `datasource`, `generator`, `model`, `enum`, `@id`, `@@id`, `@unique`,
  `@@unique`, `@@index`, `@default`, `@map`, `@@map`, `@@schema`, `@relation`, `@updatedAt`,
  `@db.*` native types (`@db.NVarChar(255)`, `@db.Decimal(15,2)`, `@db.SecondDate`, …).
- Validation with line/column error messages.
- `contract.json` with a stable hash.
- `hana-orm format` and `hana-orm validate`.

### M2 – Generator and typed client
- `hana-orm generate` writes a TypeScript client to the configured output folder.
- Model types, `WhereInput`, `WhereUniqueInput`, `Select`, `Include`, `OrderBy`,
  `CreateInput`, `UpdateInput`, and result types inferred from `select`/`include`.
- Enums as `as const` objects plus union types (HANA has no native enums).

### M3 – Query engine
- Reads: `findMany`, `findFirst`, `findUnique`, `…OrThrow`, `count`, `aggregate`, `groupBy`.
- Filters: equality, comparisons, `in`/`notIn`, `contains`/`startsWith`/`endsWith`,
  case-insensitive mode, `AND`/`OR`/`NOT`, relation filters (`some`/`every`/`none`/`is`/`isNot`).
- `select`/`include` with nested relations (batched queries, no N+1), `orderBy`,
  `take`/`skip`, cursor pagination.
- Writes: `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`,
  atomic number operations, nested writes (`create`, `connect`, `connectOrCreate`,
  `disconnect`, `update`, `delete`).
- Identity values via `CURRENT_IDENTITY_VALUE()` (HANA has no `RETURNING`).
- Interactive transactions (`$transaction(async tx => …)`) with isolation levels.
- Raw SQL: `$queryRaw`, `$executeRaw` (tagged templates, always parameterized).
- `$extends` for query, model and result extensions.

### M4 – Introspection (`hana-orm db pull`)
- Reads `SYS.TABLES`, `SYS.TABLE_COLUMNS`, `SYS.CONSTRAINTS`,
  `SYS.REFERENTIAL_CONSTRAINTS`, `SYS.INDEXES`, `SYS.VIEWS`.
- Table filters (`--tables`, `--exclude`) for very large schemas.
- Naming: `PascalCase` models and `camelCase` fields with `@@map`/`@map` to the real
  uppercase names.
- Views and tables without a primary key as read-only models.
- Re-running keeps manual changes (relation names, renamed fields).

### M5 – Migrations CLI
- `hana-orm migrate plan --name <name>`: diff the previous contract against the current one
  and write `migrations/<timestamp>_<name>/ops.json` + `migration.sql`.
- `hana-orm migrate show`: print the SQL of pending migrations.
- `hana-orm migrate deploy`: apply pending migrations in order.
- `hana-orm migrate status`: applied, pending and drift (live database vs contract).
- `hana-orm migrate resolve --applied|--rolled-back <id>`: fix history manually.
- `hana-orm migrate baseline`: create an initial migration for an existing database
  without running it.
- `hana-orm db sign` / `hana-orm db verify`: write and check the contract hash marker.
- `hana-orm db push`: apply the contract directly for prototyping, with no history.
- Safety:
  - History table `_HANA_ORM_MIGRATIONS` with checksums; edited migrations are detected.
  - Lock table to stop two deploys running at once.
  - DDL runs with `SET TRANSACTION AUTOCOMMIT DDL OFF`, so a failed migration rolls back.
  - Destructive operations (drop table/column, type narrowing) need `--allow-destructive`
    and print a warning that names each object.
  - Rename detection asks before treating it as drop and create.
  - Migrations linked by contract hash; diverged branches are reported, not applied
    silently.
- Hand-written TypeScript migrations (`migration.ts`) for data migrations.

### M6 – Developer experience
- `hana-orm init` scaffolds `schema.hana`, `.env.example` and a client file.
- `generate --watch`.
- Documentation site and examples, including a read-only example on a large existing
  schema.
- Editor syntax highlighting for `.hana` files.

### M7 – Hardening and release
- Integration test suite against a real HANA instance in CI (test schema only).
- Performance: plan cache, batched relation loading, statement reuse benchmarks.
- `1.0.0` release, published as a private package or installed from GitHub.

## Out of scope for now
- Studio / GUI.
- Databases other than SAP HANA.
- HANA calculation views and graph workspaces (may come later as read-only models).
