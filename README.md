# hana-orm

A type-safe TypeScript ORM for **SAP HANA**: a declarative schema, a generated client whose
result types follow your `select`/`include`, and a migrations CLI that produces reviewable SQL.

> Status: **alpha** (`0.1.0-alpha`). APIs may still change. See [ROADMAP.md](ROADMAP.md).

**Documentation: <https://tw4.github.io/hana-orm/>** (getting started, schema and client
reference, migrations, HANA type mapping, guides for moving from Prisma, TypeORM and the raw
driver).

- Pure TypeScript, no native query engine. The only native piece is SAP's own `@sap/hana-client`.
- Familiar query API: `findMany`, `include`, nested writes, `$transaction`, `$extends`.
- HANA-aware: identity columns, `@db.*` native types, schemas, MDC tenant databases,
  `BIGINT` → `bigint`, `DECIMAL` → `string`, `TIMESTAMP` → `Date` (UTC).
- Migrations are plain files with literal HANA SQL, applied in transactions; no shadow database.

## Install

```sh
npm install hana-orm @sap/hana-client
```

Node.js 22.12 or newer.

## Quick start

```sh
npx hana-orm init        # creates schema.hana and .env.example
cp .env.example .env     # fill in HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD
npx hana-orm db pull     # optional: read an existing database into the schema
npx hana-orm generate    # writes the typed client
```

### Schema

```hana
datasource db {
  provider = "hana"
  host     = env("HANA_HOST")
  port     = env("HANA_PORT")
  user     = env("HANA_USER")
  password = env("HANA_PASSWORD")
  schema   = "APP"                   // default schema for tables
}

generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.NVarChar(320)
  name      String?
  role      Role     @default(USER)
  balance   Decimal  @default(0) @db.Decimal(15, 2)
  createdAt DateTime @default(now()) @map("CREATED_AT")
  updatedAt DateTime @updatedAt @map("UPDATED_AT")
  posts     Post[]

  @@map("USERS")
}

model Post {
  id       Int     @id @default(autoincrement())
  title    String
  authorId Int?
  author   User?   @relation(fields: [authorId], references: [id], onDelete: SetNull)

  @@index([authorId])
}
```

Instead of separate fields the datasource also accepts
`url = env("DATABASE_URL")` with `hana://user:password@host:port/?databaseName=DB&currentSchema=APP&encrypt=true`.

#### Decimal values

`Decimal` fields come back as strings by default, so no digit is lost. The generator option
`decimal` changes that for one generated client:

```
generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
  decimal  = "decimal.js"   // "string" (default) | "number" | "decimal.js"
}
```

- `"string"`: `"12345678901234.25"`; inputs may be strings or numbers.
- `"number"`: JavaScript numbers. Values beyond about 15 significant digits are rounded.
- `"decimal.js"`: [decimal.js](https://mikemcl.github.io/decimal.js/) `Decimal` instances; install
  `decimal.js` in your project. Inputs may be `Decimal`, string or number.

The generated types follow the mode. `_avg` is always a number.

#### Ignoring fields and models

`@ignore` on a field and `@@ignore` on a model keep the column or table in the schema, so
migrations and drift checks still know about it, but hide it from the generated client:

```
model User {
  id        Int     @id
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

- A primary key field cannot be ignored; ignore the whole model instead.
- A relation that points to an ignored model, or uses an ignored foreign key field, must be
  ignored too, and both sides of a relation are ignored together.
- Unique constraints that use an ignored field are not offered in `where` of `findUnique`.
- The client cannot write an ignored column, so a required ignored column needs a database
  default for `create` to work.
- `Unsupported("TYPE")` fields are always hidden from the client. `db pull` keeps `@ignore`
  and `@@ignore` when it updates an existing schema.

#### Check constraints, sequences and comments

```
/// Customer orders.
model Order {
  /// Order number shown to customers.
  no     Int     @id @default(sequence("ORDER_NO", start: 1000)) @map("NO")
  total  Decimal @map("TOTAL") @db.Decimal(15, 2)
  status String  @default("open") @map("STATUS")

  @@check("TOTAL >= 0")
  @@check("STATUS IN ('open', 'paid')", map: "CK_ORDERS_STATUS")
  @@map("ORDERS")
}
```

- `@@check("SQL")` adds a check constraint with a raw SQL condition (it uses column names, not
  field names). Without `map:` it is named `CK_<TABLE>_<n>` by its position. Adding one runs a
  pre-check that fails the migration when existing rows violate it; a changed condition is
  dropped and re-added. Conditions are compared ignoring case, spacing and outer parentheses.
- `@default(sequence("NAME", start: 1, increment: 1))` on an `Int` or `BigInt` field creates the
  sequence in the model's schema. HANA has no sequence column defaults, so the client inserts
  `"NAME".NEXTVAL` and reads the value back with `CURRVAL`. Several fields may share a sequence
  when they use the same options. `start` only applies when the sequence is created; a changed
  `increment` becomes `ALTER SEQUENCE`. `db pull` cannot see which column uses a sequence, so it
  keeps `sequence()` defaults of an existing schema but does not add new ones.
- `///` doc comments on models and fields become `COMMENT ON TABLE` / `COMMENT ON COLUMN`, and
  `db pull` writes table and column comments back as `///`. They do not change the contract
  hash. In a project whose migrations predate comment support, `migrate status` reports the
  docs as unplanned changes and the next `migrate plan` creates a migration that sets them;
  database comments are not reported as drift against those older migrations.
- Drift checks only look at sequences the schema defines; other sequences are left alone.

### Queries

```ts
import { HanaClient } from "./generated/hana/index.ts";

const db = new HanaClient();

const users = await db.user.findMany({
  where: { email: { endsWith: "@example.com" }, posts: { some: { title: { contains: "hana" } } } },
  select: { id: true, email: true, posts: { select: { title: true }, take: 3 } },
  orderBy: { createdAt: "desc" },
  take: 20,
});
// users: { id: number; email: string; posts: { title: string }[] }[]

const user = await db.user.create({
  data: { email: "ada@example.com", posts: { create: [{ title: "Hello HANA" }] } },
  include: { posts: true },
});

await db.user.update({ where: { id: user.id }, data: { balance: { increment: 10 } } });

await db.$transaction(async (tx) => {
  const u = await tx.user.findUniqueOrThrow({ where: { email: "ada@example.com" } });
  await tx.post.deleteMany({ where: { authorId: u.id } });
});

const stats = await db.post.groupBy({ by: ["authorId"], _count: { _all: true } });
const rows = await db.$queryRaw`SELECT COUNT(*) AS "n" FROM "APP"."USERS" WHERE "role" = ${"ADMIN"}`;
```

Supported: `findMany`, `findFirst(OrThrow)`, `findUnique(OrThrow)`, `count`, `aggregate`, `groupBy`,
`create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`; filters
(`equals`, `not`, `in`, `notIn`, `lt/lte/gt/gte`, `contains/startsWith/endsWith`, `mode: "insensitive"`,
`AND/OR/NOT`, relation filters `some/every/none/is/isNot`); nested writes (`create`, `createMany`,
`connect`, `connectOrCreate`, `disconnect`, `set`, `update`, `updateMany`, `upsert`, `delete`,
`deleteMany`); cursor pagination; `_count`; `$extends` (model methods and query hooks).

Client options: `new HanaClient({ log: true, poolSize: 10, schema: "APP", datasource: { host: "..." } })`.

#### Events, logging and metrics

```ts
const db = new HanaClient({ log: ["warn", "error"], slowQueryThreshold: 500 });

const off = db.$on("query", (e) => metrics.observe(e.durationMs)); // { sql, params, durationMs, inTransaction, error? }
db.$on("error", (e) => report(e.target, e.message));               // e.g. target "User.create"
off();                                                             // unsubscribe

db.$metrics();
// { queries: { total, failed, durationMs: { total, max, avg }, histogram: [{ le: 1, count }, …] },
//   transactions: { total, committed, rolledBack }, pool: { size, open, idle, busy, waiting } }
```

- Events: `query` (every statement, also inside transactions), `info` (connect/disconnect),
  `warn` (statements slower than `slowQueryThreshold` ms) and `error` (a failed model
  operation, raw query or transaction).
- Parameter values are **not** included in events or logs unless the client is created with
  `logParams: true`; they may contain personal data.
- `log: true` prints every statement; `log: ["query", "info", "warn", "error"]` prints those
  events; `log: (e) => …` receives every statement.
- A listener that throws is ignored, so it cannot break a query.

#### Json filters

```ts
await db.event.findMany({
  where: {
    payload: { path: ["user", "country"], equals: "DE" },        // JSON_VALUE(...) = ?
    meta: { path: "$.score", gte: 0.5 },                          // JSON_VALUE(... RETURNING DOUBLE)
    tags: { array_contains: ["urgent", 3] },                     // the array has both elements
  },
});
```

- `path` is an array of keys and indexes (`["items", 0, "sku"]`) or a JSON path (`"$.items[0].sku"`).
  Without it the operators apply to the whole document.
- `equals` / `not` / `lt` / `lte` / `gt` / `gte` with a path compare a scalar: numbers as numbers,
  booleans as `true`/`false`; `equals: null` matches JSON null and a missing key. Without a path,
  `equals` compares the stored JSON text, so it only finds documents written in the same form
  (hana-orm writes compact `JSON.stringify` output).
- `string_contains` / `string_starts_with` / `string_ends_with` match the string at the path
  (`mode: "insensitive"` is supported).
- `array_contains` (an element or a list of elements, all required), `array_starts_with` and
  `array_ends_with` take scalar elements. They match the array's JSON text, so an element of a
  nested array can also match.

#### Connection pool

```ts
const db = new HanaClient({
  poolSize: 10,             // max open connections
  statementTimeout: 30_000, // ms per statement; default no limit
  idleTimeout: 300_000,     // close connections idle this long (default 5 min, 0 = keep)
  idleCheckAfter: 30_000,   // SELECT 1 FROM DUMMY before reusing a connection idle this long
});
```

- A connection idle for `idleCheckAfter` is checked before it is handed out; a dead one (for
  example after a database restart or a firewall dropping idle sockets) is closed and replaced.
- A connection that fails with a "connection lost" error is closed instead of going back to the
  pool. Reads (`query`, i.e. every `find*`, `count`, `aggregate`, `$queryRaw`) are retried once on
  a new connection; writes and transactions are not, because the server may have applied them.
- When a statement runs longer than `statementTimeout` its connection is closed, which stops the
  statement on the server and rolls back its transaction, and it fails with `QueryTimeoutError`
  (`code: "QUERY_TIMEOUT"`). A timed-out read is not retried.
- `$disconnect()` refuses new work, fails requests waiting for a connection and waits up to
  10 seconds for running statements before closing their connections.

#### Many-to-many relations

Two list fields that point at each other, with no `@relation(fields, references)` side, form an
implicit many-to-many relation:

```prisma
model Post {
  id   Int   @id @default(autoincrement())
  tags Tag[]
}

model Tag {
  name  String @id
  posts Post[]
}
```

- Migrations create a join table `_PostToTag` (or `_<Name>` for `@relation("Name")`) with the
  columns `A` and `B`, a primary key on both, an index on `B` and cascading foreign keys. `A`
  references the model whose name sorts first (for a self-relation, the field whose name sorts
  first). This is the same layout Prisma uses, and `db pull` turns such tables back into list fields.
- Both models need a single-field `@id`. For extra columns on the link, use an explicit join model.
- Filters (`some`/`every`/`none`), `include`, `_count`, `orderBy: { tags: { _count } }` and the nested
  writes `create`, `connect`, `connectOrCreate`, `disconnect`, `set`, `update`, `updateMany`,
  `upsert`, `delete`, `deleteMany` work through the join table. `connect` of a row that is already
  linked does nothing. There is no nested `createMany`.

#### Bulk inserts

```ts
// skip rows that match an existing row (or an earlier row of the batch) on the primary key or any unique
const { count } = await db.user.createMany({ data: users, skipDuplicates: true });

// insert and read the rows back (with identity values), in the order of `data`
const created = await db.user.createManyAndReturn({ data: users, skipDuplicates: true, select: { id: true, email: true } });
```

- `skipDuplicates` turns each insert into `INSERT ... SELECT ... FROM DUMMY WHERE NOT EXISTS (...)`,
  checking the primary key and every unique whose fields are set in the row. Duplicates are
  checked when the row is inserted; two transactions inserting the same key at the same time can
  still fail with a unique violation.
- `createManyAndReturn` inserts row by row (to read identity values) and returns only the rows it
  inserted. It accepts `select`, `omit` and `include`, but no nested writes in `data`.
- Nested `createMany` accepts `skipDuplicates` too.


#### Transactions

```ts
// interactive: everything in the callback runs on one connection
await db.$transaction(async (tx) => { /* ... */ }, { timeout: 10_000, maxWait: 5_000, isolationLevel: "SERIALIZABLE" });

// batch: the queries run in order in one transaction; pass them without `await`
const [post, count] = await db.$transaction([
  db.post.create({ data: { title: "Hello", authorId: 1 } }),
  db.post.count(),
]);
```

- `timeout` (default 5000 ms) limits how long the transaction runs once it has a connection.
  When it is exceeded, `$transaction` rejects with `TransactionError` (`code: "TRANSACTION_TIMEOUT"`),
  further queries of the transaction fail, and the transaction is rolled back and its connection
  returned to the pool once the running statement has finished. `timeout: 0` disables it.
- `maxWait` (default 2000 ms) limits the wait for a free pooled connection (`TRANSACTION_MAX_WAIT`).
- Client-wide defaults: `new HanaClient({ transactionOptions: { timeout: 10_000 } })`.
- Model and raw query methods are lazy: they run when awaited, so an un-awaited
  `db.user.create(...)` does nothing.

### Migrations

```sh
npx hana-orm migrate plan --name add_posts   # writes migrations/<timestamp>_add_posts/{ops.json,migration.sql}
npx hana-orm migrate show                    # print the pending SQL
npx hana-orm migrate deploy                  # apply pending migrations
npx hana-orm migrate status                  # applied / pending / drift
```

- Planning compares the previous migration's contract with the current schema; it does not
  need a database or a shadow database.
- Each migration runs in its own transaction with transactional DDL, behind a lock, and is
  recorded with a checksum. Edited or out-of-order migrations are reported, not applied.
- Destructive changes (dropping tables or columns, narrowing types) need `--allow-destructive`.
- For an existing database: `hana-orm db pull`, then `hana-orm migrate baseline`.
- For prototyping: `hana-orm db push` applies the schema directly without history.

### Comparing states and running SQL

```sh
npx hana-orm migrate diff --from migrations --to schema            # what the next migration would do
npx hana-orm migrate diff --from db --to schema --script           # SQL that brings the database to the schema
npx hana-orm migrate diff --from empty --to schema --script > init.sql
npx hana-orm migrate diff --from migrations --to db --exit-code    # exit 2 when the database drifted
npx hana-orm db execute --file fix.sql                             # run a script in one transaction
```

A source is `empty`, `schema`, `migrations` (the latest migration), `migrations:<id>` or `db`.
Against `db`, only the tables the other side defines are compared, so other tables in a shared
schema are not reported. `migrate diff` never changes the database.

### Squashing and splitting migrations

```sh
npx hana-orm migrate squash --from 20261101 --to 20261115 --name q4_schema   # ids may be prefixes
npx hana-orm migrate split 20261117093000_init --at 3                        # new part from op 3
npx hana-orm migrate split 20261117093000_init                               # one migration per op
```

`squash` concatenates the operations of a range of migrations into one migration that keeps the
first one's `from` and the last one's `to` contract hash, so the migrations around it still chain.
Hand-written SQL and data-migration scripts are copied as `<old id>_migration.sql` /
`<old id>_migration.ts`. `split` cuts a migration into parts chained through generated contract
hashes; parts before the last carry the final `contract.json`.

The new `ops.json` lists the migrations it replaces with their checksums. A database that
applied them treats the new migration as applied, and their history rows are not reported as
missing; a database that applied only some of them is reported by `migrate status` and `deploy`
stops. Both commands refuse when the configured database has the affected migrations applied,
unless `--baseline` is passed, which records the result there as applied without running it.

### Seeding

`hana-orm db seed` runs your seed command with the `.env` file loaded (the schema path is
passed as `HANA_ORM_SCHEMA`). Configure the command in a generator block:

```
generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
  seed     = "node ./seed.ts"
}
```

or in `package.json` as `"hana-orm": { "seed": "node ./seed.ts" }`. A seed script is plain code
that uses the generated client:

```ts
// seed.ts
import { HanaClient } from "./src/generated/hana/index.ts";

const db = new HanaClient();
await db.user.upsert({
  where: { email: "demo@example.com" },
  create: { email: "demo@example.com", name: "Demo" },
  update: {},
});
await db.$disconnect();
```

### Resetting a development database

```sh
npx hana-orm migrate reset            # asks before dropping anything
npx hana-orm migrate reset --force    # no question (CI, scripts)
```

`migrate reset` drops the project's tables (every table of every migration and of the schema,
plus the `_HANA_ORM_*` housekeeping tables), re-applies all migrations and runs the seed command
(`--skip-seed` to skip it). Tables the project does not know are kept; `--schema-drop` drops
every table, view and sequence of the schemas the project uses instead.

It is meant for development only: it refuses to run when the connection host is not
`localhost`, `127.0.0.1` or `::1` unless `--allow-remote` is passed, and without `--force` it
asks for confirmation (and refuses when it cannot ask, e.g. in a non-interactive shell).

### Formatting and multi-file schemas

```sh
npx hana-orm format           # rewrite schema files in the canonical layout
npx hana-orm format --check   # CI: exit 1 and list files that are not formatted
```

`format` aligns field names, types and attributes in columns, orders attributes
(`@id @default @unique @updatedAt @ignore @relation @map @db.*`, then
`@@id @@unique @@index @@check @@map @@schema @@ignore`; `@@check` lines keep their order), normalizes spacing and blank lines and keeps
all comments. It is idempotent and refuses to touch a file with syntax errors.

A schema can also be a folder: `--schema schema/` (or a `./schema/` folder found by default)
merges every `*.hana` file directly inside it into one schema, sorted by file name. Models may
reference models in other files; there is one `datasource` block in the whole folder.
Migrations then live in `schema/migrations/` and generator outputs are relative to the folder.
`db pull` writes a single file, so point it at one file of the folder (`--schema schema/legacy.hana`)
or use `--print`.

## Development

```sh
npm install
npm run typecheck
npm test                    # unit + type tests, no database needed
npm run test:integration    # needs HANA_* env vars; writes only to temporary tables
```

`docker-compose.hana.yml` starts a local SAP HANA Express for the integration tests (see the
comments in the file). The **HANA integration** workflow does the same in CI every night and
on demand (Actions → HANA integration → Run workflow, optionally on a larger or self-hosted
runner): it starts HANA Express, checks the connection with `node scripts/check-hana.ts` and
runs `npm run test:integration` with `HANA_ORM_ALLOW_DDL=1`, failing if any test was skipped.

## License

[Apache License 2.0](LICENSE)
