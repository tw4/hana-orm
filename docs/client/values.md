---
title: Decimal, BigInt, Json and dates
parent: Client
nav_order: 9
---

# Decimal, BigInt, Json and dates
{: .no_toc }

1. TOC
{:toc}

hana-orm converts values between HANA and JavaScript so that nothing is lost on the way. This
page describes each conversion. The short table is on [Type mapping](../schema/types.html).

## Decimal

`DECIMAL` columns can hold more digits than a JavaScript `number`. By default they are read as
**strings**:

```ts
const order = await db.order.findUniqueOrThrow({ where: { id: 1 } });
order.total; // "12345678901234.25"
```

Writes accept strings or numbers:

```ts
await db.order.update({ where: { id: 1 }, data: { total: "19.99" } });
await db.order.update({ where: { id: 1 }, data: { total: { increment: 5 } } });
```

The generator option `decimal` changes the representation for one generated client:

```hana
generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
  decimal  = "decimal.js"   // "string" (default) | "number" | "decimal.js"
}
```

| mode | read as | write accepts | note |
|---|---|---|---|
| `"string"` | `"12345678901234.25"` | `string \| number` | lossless; do arithmetic with a decimal library |
| `"number"` | `12345678901234.25` | `number \| string` | values beyond about 15 significant digits are rounded |
| `"decimal.js"` | `Decimal` instance | `Decimal \| string \| number` | install `decimal.js` in your project |

The generated types follow the mode. `_avg` is always a `number`.

{: .tip }
For money, use `@db.Decimal(15, 2)` (or the precision your domain needs) and the `"decimal.js"`
mode, so amounts are exact from the database to your calculations.

## BigInt

`BigInt` fields are read as JavaScript `bigint`, so values beyond `Number.MAX_SAFE_INTEGER`
stay exact. Writes accept `bigint` or `number`:

```ts
await db.counter.update({ where: { id: 1 }, data: { value: { increment: 1n } } });
const c = await db.counter.findUniqueOrThrow({ where: { id: 1 } });
c.value; // 9007199254740993n
```

`JSON.stringify` cannot serialize `bigint`. Convert before sending to a browser:

```ts
JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
```

## Dates and times

- `DateTime` fields are read as `Date` objects. Writes accept `Date` or an ISO string.
- Everything is **UTC**: `Date` values are written as UTC timestamps, and timestamps are read
  as UTC. The time zone of the server or of your process does not matter.
- `now()` defaults and `@updatedAt` use the client's clock in UTC (and `CURRENT_UTCTIMESTAMP`
  as the column default for other tools).
- `@db.Date` columns are read as midnight UTC; `@db.Time` columns as `1970-01-01T…Z`.
- JavaScript `Date` has millisecond precision; HANA `TIMESTAMP` keeps up to 100 ns. Finer
  digits written by other tools are cut when read.

If your existing data stores local times in `TIMESTAMP` columns, convert at the edges of your
application; hana-orm does not shift times.

## Json

`Json` fields are stored as `NCLOB` and read as parsed JSON values:

```ts
await db.event.create({ data: { payload: { user: { id: 7, country: "DE" }, tags: ["a", "b"] } } });
const e = await db.event.findFirstOrThrow();
e.payload; // { user: { id: 7, country: "DE" }, tags: ["a", "b"] }
```

- Objects, arrays, strings, numbers and booleans can be stored.
- `null` is stored as a database `NULL`, so only an optional `Json?` field can hold it. Reading a
  `NULL` gives `null`.
- Values are written with `JSON.stringify`. `bigint`s, `Date`s and `undefined` behave as they do
  in `JSON.stringify`.
- In the generated types `Json` is `JsonValue`. To give a field a precise type, use the
  TypeScript schema's `json<T>()` or cast where you read it.
- See [Json filters](filtering.html#json-filters) for querying inside documents.

## Bytes

`Bytes` fields (`BLOB`, `VARBINARY`) are read as `Buffer` and accept `Buffer` or `Uint8Array`.

## Strings and booleans

`String` fields are JavaScript strings, `Boolean` fields JavaScript booleans. HANA's `NVARCHAR`
lengths count characters; the client does not check lengths, HANA rejects values that are too
long with a `DatabaseError`.

## Raw SQL

Values in `$queryRaw` results are not decoded; see [Raw SQL](raw-sql.html). Typed SQL and the
query builder decode like the object API.
