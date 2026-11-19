---
title: Errors
parent: Client
nav_order: 13
---

# Errors
{: .no_toc }

1. TOC
{:toc}

Every error thrown by the runtime extends `HanaOrmError` and has a stable `code`. Check the code,
not the message: messages may be improved between versions, codes do not change.

```ts
import { HanaOrmError, DatabaseError, NotFoundError, ValidationError, TransactionError, QueryTimeoutError } from "hana-orm/runtime";

try {
  await db.user.create({ data: { email } });
} catch (e) {
  if (e instanceof DatabaseError && e.code === "UNIQUE_CONSTRAINT") {
    return { error: "This email is already registered" };
  }
  throw e;
}
```

## Error classes

| class | code | when |
|---|---|---|
| `ValidationError` | `VALIDATION` | invalid arguments: unknown field, wrong value type, missing required field, invalid enum value, a placeholder outside a prepared query |
| `NotFoundError` | `NOT_FOUND` | `findFirstOrThrow` / `findUniqueOrThrow` found nothing; `update`, `delete` or a nested `connect` found no row |
| `DatabaseError` | see below | HANA rejected a statement |
| `TransactionError` | `TRANSACTION_TIMEOUT` | a `$transaction` ran longer than `timeout` |
| | `TRANSACTION_MAX_WAIT` | no connection became free within `maxWait` |
| | `TRANSACTION_CLOSED` | a query used `tx` after its transaction had ended |
| `QueryTimeoutError` | `QUERY_TIMEOUT` | a statement ran longer than `statementTimeout` |

## DatabaseError

| code | HANA error | meaning |
|---|---|---|
| `UNIQUE_CONSTRAINT` | 301 | a primary key or unique constraint was violated |
| `FOREIGN_KEY_CONSTRAINT` | 461, 462 | a foreign key was violated: the referenced row does not exist, or rows still reference it |
| `NOT_NULL_CONSTRAINT` | 287 | `NULL` into a `NOT NULL` column |
| `AUTHENTICATION` | 10, 414 | authentication failed, or the user must change the password first |
| `DATABASE` | anything else | see `hanaCode` and `message` |

Extra properties:

- `hanaCode`: HANA's error number, when the driver reported one.
- `sql`: the statement that failed.
- `cause`: the original driver error.

```ts
catch (e) {
  if (e instanceof DatabaseError) {
    log.error({ code: e.code, hanaCode: e.hanaCode, sql: e.sql }, e.message);
  }
}
```

HANA's message is passed through unchanged, so it names the table and constraint:

```
unique constraint violated: Table(USERS), Index(UQ_USERS_email) …
```

## NotFoundError

`NotFoundError` has a `model` property with the model name:

```ts
try {
  await db.post.update({ where: { id }, data });
} catch (e) {
  if (e instanceof NotFoundError) return res.status(404).end();
  throw e;
}
```

## Mapping errors in an API

```ts
function toHttp(e: unknown): { status: number; message: string } {
  if (e instanceof NotFoundError) return { status: 404, message: "Not found" };
  if (e instanceof ValidationError) return { status: 400, message: e.message };
  if (e instanceof DatabaseError) {
    if (e.code === "UNIQUE_CONSTRAINT") return { status: 409, message: "Already exists" };
    if (e.code === "FOREIGN_KEY_CONSTRAINT") return { status: 409, message: "Still referenced" };
  }
  if (e instanceof QueryTimeoutError || e instanceof TransactionError) return { status: 503, message: "Try again" };
  return { status: 500, message: "Internal error" };
}
```

Do not send `DatabaseError` messages to clients as they are: they contain table and constraint
names.

## CLI errors

The CLI prints the message and exits with code 1. Set `HANA_ORM_DEBUG=1` to print stack traces.
