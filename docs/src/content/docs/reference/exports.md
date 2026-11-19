---
title: Package exports
sidebar:
  order: 4
---

## Generated client

Most code imports from the generated file, not from the package:

```ts
import { HanaClient, tables, Role, type User, type UserWhereInput, eq, and, desc, sql, alias } from "./generated/hana/index.ts";
```

| export | |
|---|---|
| `HanaClient` (or the `clientName` you chose) | the client class |
| a type per model (`User`, `Post`) | row types |
| `<Model>WhereInput`, `<Model>CreateInput`, `<Model>FindManyArgs`, … | argument types |
| an object and a type per enum (`Role`) | enum values |
| `tables` | typed tables for the query builder |
| `eq`, `and`, `desc`, `count`, `sql`, `alias`, … | query builder operators, re-exported |
| `contract` | the compiled schema |

## hana-orm/runtime

The runtime the generated client uses. Import from it for errors, placeholders and types:

| export | |
|---|---|
| `HanaOrmError`, `ValidationError`, `NotFoundError`, `DatabaseError`, `TransactionError`, `QueryTimeoutError` | [errors](/hana-orm/client/errors/) |
| `placeholder` | placeholders for [prepared queries](/hana-orm/client/query-builder/#prepared-queries) |
| `sql`, operators (`eq`, `and`, …), `alias` | query builder |
| `HanaDriver`, `resolveConnectionConfig`, `parseHanaUrl` | the built-in driver and connection settings |
| `createClientClass`, `BaseClient` | build a client class from a contract at runtime |
| types: `ClientOptions`, `TransactionOptions`, `Driver`, `Queryable`, `QueryEvent`, `ClientMetrics`, `IsolationLevel`, … | |

## hana-orm

Schema tooling and the TypeScript schema DSL:

| export | |
|---|---|
| `hanaSchema`, `hanaTable`, `hanaEnum`, `relations`, `one`, `many`, column helpers, `tablesOf`, `createClient` | [Schema in TypeScript](/hana-orm/schema/typescript/) |
| `compileSchema`, `parseSchema`, `buildContract`, `contractHash` | compile `.hana` source to a contract |
| `formatSchema` | the formatter |
| `generateClient` | the client generator |
| `SchemaError` | schema errors with file, line and column |

## hana-orm/migrate

The migration engine, for tools that want to plan or inspect migrations programmatically:
`diffSchemas`, `contractToPhysical`, DDL builders and the `MigrationScript` type used by data
migrations.

```ts
import type { MigrationScript } from "hana-orm/migrate";
```
