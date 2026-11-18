# hana-orm

A type-safe TypeScript ORM for **SAP HANA**: a declarative schema, a generated client whose
result types follow your `select`/`include`, and a migrations CLI that produces reviewable SQL.

> Status: **alpha** (`0.1.0-alpha`). APIs may still change. See [ROADMAP.md](ROADMAP.md).

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
`@@id @@unique @@index @@map @@schema @@ignore`), normalizes spacing and blank lines and keeps
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

## License

[Apache License 2.0](LICENSE)
