<div align="center">

<img src="https://raw.githubusercontent.com/tw4/hana-orm/main/docs/src/assets/logo.svg" width="72" height="72" alt="">

# hana-orm

**A type-safe TypeScript ORM for SAP HANA.**

Describe your data once in a schema, get a client whose types follow every query, and ship
migrations as plain, reviewable SQL.

[![npm](https://img.shields.io/npm/v/hana-orm/next?label=npm&color=0f766e)](https://www.npmjs.com/package/hana-orm)
[![CI](https://github.com/tw4/hana-orm/actions/workflows/ci.yml/badge.svg)](https://github.com/tw4/hana-orm/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-0f766e)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-tw4.github.io%2Fhana--orm-0f766e)](https://tw4.github.io/hana-orm/)

[Documentation](https://tw4.github.io/hana-orm/) ·
[Getting started](https://tw4.github.io/hana-orm/getting-started/) ·
[Changelog](CHANGELOG.md) ·
[Roadmap](ROADMAP.md)

</div>

---

```prisma
// schema.hana
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.NVarChar(320)
  name      String?
  createdAt DateTime @default(now())
  posts     Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int?
  author   User?  @relation(fields: [authorId], references: [id])
}
```

```ts
import { HanaClient } from "./generated/hana/index.ts";

const db = new HanaClient();

const users = await db.user.findMany({
  where: { email: { endsWith: "@example.com" } },
  select: { id: true, email: true, posts: { select: { title: true }, take: 3 } },
  orderBy: { createdAt: "desc" },
});
// users: { id: number; email: string; posts: { title: string }[] }[]
```

## Why hana-orm

- **Pure TypeScript, no query engine.** Queries are compiled to SQL in your process and run
  through SAP's own `@sap/hana-client`. There is no binary to ship.
- **Types follow the query.** `select`, `include` and `omit` shape the result type, down to
  nested relations and computed fields.
- **Made for HANA.** Identity columns, `@db.*` native types, several schemas, tenant databases,
  full-text indexes, sequences, check constraints, HANA Cloud over TLS. `BIGINT` stays exact,
  `DECIMAL` loses no digit, timestamps are UTC.
- **Migrations you can read.** Each migration is a folder with the literal SQL that runs.
  Planning needs no database; deploying runs each migration in one transaction, behind a lock.
- **Two query styles.** An object API (`findMany`, nested writes, `$transaction`) and a SQL-like
  builder (`db.select().from().leftJoin()`), sharing one client.
- **Tools around it.** `db pull` for existing databases, a local data browser
  (`hana-orm studio`), a formatter, typed SQL from `.sql` files and a VS Code extension.

## Quick start

```sh
npm install hana-orm@next @sap/hana-client
npx hana-orm init                       # schema.hana and .env.example
cp .env.example .env                    # fill in the HANA connection
npx hana-orm migrate plan --name init   # or `npx hana-orm db pull` for an existing database
npx hana-orm migrate deploy
npx hana-orm generate
```

Requires Node.js 22.12+ and SAP HANA 2.0, SAP HANA Cloud or HANA Express. Continue with
[Getting started](https://tw4.github.io/hana-orm/getting-started/).

## Documentation

| | |
|---|---|
| [Getting started](https://tw4.github.io/hana-orm/getting-started/) | install, connect, first schema, first query, existing databases |
| [Schema](https://tw4.github.io/hana-orm/schema/) | models, relations, enums, views, indexes, constraints, type mapping |
| [Client](https://tw4.github.io/hana-orm/client/) | reading, filtering, writing, transactions, raw SQL, query builder, performance |
| [Migrations](https://tw4.github.io/hana-orm/migrations/) | plan, deploy, drift, data migrations, production |
| [Tools](https://tw4.github.io/hana-orm/tools/) | CLI reference, studio, VS Code extension |
| [Guides](https://tw4.github.io/hana-orm/guides/) | coming from Prisma, TypeORM or `@sap/hana-client`; testing; several schemas |

## Status

hana-orm is a **release candidate** (`1.0.0-rc.1`, published under the `next` tag). The API is
meant to be stable for 1.0; breaking changes until then are listed in the
[changelog](CHANGELOG.md). Every release is tested against HANA Express; see
[ROADMAP.md](ROADMAP.md) for what comes next.

## Contributing

Contributions are welcome: bug reports, documentation fixes, features. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and the ground rules (no private
data in code, tests or issues), and open an issue before starting on a larger change.

Found a security problem? Please report it privately, see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). SAP and SAP HANA are trademarks of SAP SE; hana-orm is an
independent project and is not affiliated with or endorsed by SAP.
