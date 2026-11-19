---
title: Schema in TypeScript
parent: Schema
nav_order: 8
---

# Schema in TypeScript
{: .no_toc }

1. TOC
{:toc}

A schema can also be written in TypeScript. It produces the same contract as the equivalent
`.hana` file: same validation, same error messages, same contract hash.

```ts
// schema.ts
import { hanaSchema, hanaTable, hanaEnum, enumColumn, relations, one, many, env, int, string, decimal, dateTime } from "hana-orm";

export const Role = hanaEnum("Role", ["USER", { name: "ADMIN", map: "admin" }]);

export const User = hanaTable(
  "User",
  {
    id: int().primaryKey().autoincrement(),
    email: string(320).unique(),
    name: string().optional(),
    role: enumColumn(Role).default("USER"),
    balance: decimal(15, 2).default(0),
    createdAt: dateTime().defaultNow().map("CREATED_AT"),
  },
  { map: "USERS", doc: "A registered user" },
);

export const Post = hanaTable(
  "Post",
  { id: int().primaryKey().autoincrement(), title: string(), authorId: int().optional() },
  { indexes: [{ fields: ["authorId"] }] },
);

export const schema = hanaSchema({
  datasource: { host: env("HANA_HOST"), port: env("HANA_PORT"), user: env("HANA_USER"), password: env("HANA_PASSWORD"), schema: "APP" },
  enums: [Role],
  tables: [User, Post],
  relations: [
    relations(User, { posts: many(Post) }),
    relations(Post, { author: one(User, { optional: true, fields: ["authorId"], references: ["id"] }) }),
  ],
});

export type UserRow = typeof User.$inferSelect; // { id: number; email: string; name: string | null; … }
export type NewUser = typeof User.$inferInsert; // { email: string; id?: number; name?: string | null; … }
```

Relations are declared after the tables, so tables can refer to each other in any order.

## Using it without the generator

```ts
import { tablesOf, createClient, eq, desc } from "hana-orm";
import { schema } from "./schema.ts";

const db = createClient(schema, { poolSize: 5 });
const { user, post } = tablesOf(schema);

const rows = await db
  .select({ email: user.email, title: post.title })
  .from(user)
  .leftJoin(post, eq(post.authorId, user.id))
  .orderBy(desc(user.createdAt))
  .limit(20);
// { email: string; title: string | null }[]
```

- `tablesOf(schema)` gives typed tables for the [query builder](../client/query-builder.html),
  inferred directly from the definitions.
- `createClient(schema, options)` returns a client. Its object API (`db.user.findMany`) works,
  but it is **untyped**. For typed `findMany`, `include` and nested writes, generate a client.

## Using it with the CLI

The CLI reads `.hana` files. If you want migrations, `db pull` or studio, keep the schema as a
`.hana` file. A TypeScript schema with the same content has the same contract hash, so a test
can check that both stay in sync:

```ts
import { compileSchema } from "hana-orm";
import { readFileSync } from "node:fs";
import { schema } from "./schema.ts";

assert.equal(schema.contract.hash, compileSchema(readFileSync("schema.hana", "utf8")).hash);
```

## Column helpers

| helper | schema type |
|---|---|
| `int()` | `Int` |
| `bigint()` | `BigInt` |
| `float()` | `Float` |
| `decimal(p?, s?)` | `Decimal` (`@db.Decimal(p, s)` when given) |
| `boolean()` | `Boolean` |
| `string(length?)` | `String` (`@db.NVarChar(length)` when given) |
| `text()` | `String @db.NClob` |
| `dateTime()` | `DateTime` |
| `date()` | `DateTime @db.Date` |
| `json<T>()` | `Json`, typed as `T` |
| `bytes()` | `Bytes` |
| `enumColumn(e)` | an enum field |

Modifiers:

| modifier | `.hana` equivalent |
|---|---|
| `.optional()` | `?` |
| `.primaryKey()` | `@id` |
| `.unique()` | `@unique` |
| `.default(value)` | `@default(value)` |
| `.defaultNow()` | `@default(now())` |
| `.autoincrement()` | `@default(autoincrement())` |
| `.uuid()` / `.cuid()` | `@default(uuid())` / `@default(cuid())` |
| `.dbGenerated(sql)` | `@default(dbgenerated("sql"))` |
| `.updatedAt()` | `@updatedAt` |
| `.map(name)` | `@map("name")` |
| `.db(type, ...args)` | `@db.Type(args)` |
| `.ignore()` | `@ignore` |
| `.doc(text)` | `/// text` |

Table options (third argument of `hanaTable`): `map`, `schema`, `id` (composite primary key),
`uniques`, `indexes`, `view`, `ignore`, `doc`.

Relation helpers: `one(Table, { optional, fields, references, onDelete, onUpdate, name, map })`
and `many(Table, { name })`.
