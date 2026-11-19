---
title: Type mapping
parent: Schema
nav_order: 9
---

# Type mapping
{: .no_toc }

1. TOC
{:toc}

## Schema type → HANA column → TypeScript

| schema type | HANA column (default) | TypeScript (read) | TypeScript (write) |
|---|---|---|---|
| `String` | `NVARCHAR(5000)` | `string` | `string` |
| `Int` | `INTEGER` | `number` | `number` (integer) |
| `BigInt` | `BIGINT` | `bigint` | `bigint \| number` |
| `Float` | `DOUBLE` | `number` | `number` |
| `Decimal` | `DECIMAL(38,10)` | `string` (default), `number` or `Decimal` | `string \| number` (and `Decimal`) |
| `Boolean` | `BOOLEAN` | `boolean` | `boolean` |
| `DateTime` | `TIMESTAMP` | `Date` (UTC) | `Date \| string` |
| `Bytes` | `BLOB` | `Buffer` | `Buffer \| Uint8Array` |
| `Json` | `NCLOB` | JSON value | JSON value |
| enum | `NVARCHAR(255)` | the enum's value names | value names |

`DECIMAL(38,10)` is HANA's maximum precision with ten fractional digits. A bare `DECIMAL` would
be a floating-point decimal, which compares and rounds differently, so hana-orm never uses it
as a default. Give money columns their real precision, for example `@db.Decimal(15, 2)`.

## Native types (`@db.*`)

A `@db.*` attribute picks another HANA type for the column. Common ones:

| schema type | native types |
|---|---|
| `String` | `@db.NVarChar(n)`, `@db.VarChar(n)`, `@db.NChar(n)`, `@db.Char(n)`, `@db.Alphanum(n)`, `@db.NClob`, `@db.Clob`, `@db.Text` |
| `Int` | `@db.Integer` (default), `@db.SmallInt`, `@db.TinyInt` |
| `BigInt` | `@db.BigInt` (default) |
| `Decimal` | `@db.Decimal(p, s)`, `@db.SmallDecimal` |
| `Float` | `@db.Double` (default), `@db.Real` |
| `DateTime` | `@db.Timestamp` (default), `@db.SecondDate`, `@db.Date`, `@db.Time` |
| `Bytes` | `@db.Blob` (default), `@db.VarBinary(n)`, `@db.Binary(n)` |
| `Json` | `@db.NClob` (default) |

The name after `@db.` is passed to HANA in upper case with its arguments, so other HANA types
work as well.

### Dates and times

- All `DateTime` values are UTC. hana-orm writes `Date` objects as UTC timestamps and reads them
  back as `Date` objects in UTC; the server's time zone is not used.
- `@db.Date` values are read as midnight UTC (`2026-11-19T00:00:00.000Z`).
- `@db.Time` values are read as `1970-01-01T…Z`.
- `@db.SecondDate` has no fractional seconds; `TIMESTAMP` keeps 100 ns precision, of which
  JavaScript `Date` keeps milliseconds.

### Strings

- Prefer `NVARCHAR` (Unicode) over `VARCHAR`.
- The default `NVARCHAR(5000)` is the longest non-LOB string. Set a realistic length
  (`@db.NVarChar(200)`), or use `@db.NClob` for long text.
- LOB columns (`NCLOB`, `BLOB`) cannot be compared with `=` or used in `ORDER BY` or
  `GROUP BY` in HANA. hana-orm compares `Json` documents through `TO_NVARCHAR`, see
  [Json filters](../client/filtering.html#json-filters).

## `db pull`: HANA column → schema type

| HANA | schema |
|---|---|
| `NVARCHAR(5000)` | `String` |
| `NVARCHAR(n)`, `VARCHAR`, `NCHAR`, `CHAR`, `ALPHANUM`, `NCLOB`, `CLOB`, `TEXT` | `String` with the `@db.*` type |
| `SHORTTEXT(n)` | `String @db.NVarChar(n)` |
| `INTEGER` / `SMALLINT` / `TINYINT` | `Int` (with `@db.*` for the small ones) |
| `BIGINT` | `BigInt` |
| `DECIMAL(38,10)` / other `DECIMAL`, `SMALLDECIMAL` | `Decimal` (with `@db.*` when not the default) |
| `DOUBLE` / `REAL` | `Float` |
| `BOOLEAN` | `Boolean` |
| `TIMESTAMP` / `SECONDDATE` / `DATE` / `TIME` | `DateTime` |
| `BLOB`, `VARBINARY`, `BINARY` | `Bytes` |
| identity columns | `@default(autoincrement())` |
| anything else (e.g. `ST_GEOMETRY`) | `Unsupported("TYPE")`, hidden from the client |

## Changing a column type

Migrations classify a type change:

| change | examples | migration |
|---|---|---|
| widening | `INTEGER` → `BIGINT`, `NVARCHAR(50)` → `NVARCHAR(200)`, `DECIMAL(10,2)` → `DECIMAL(15,2)`, `DATE` → `TIMESTAMP`, `REAL` → `DOUBLE` | `ALTER TABLE … ALTER` |
| narrowing | the reverse of the above | destructive: needs `--allow-destructive`, can fail on existing data |
| incompatible | `NVARCHAR` → `INTEGER`, anything → LOB | destructive |

Adding or removing an identity (`autoincrement()`) re-creates the column. To convert data
between incompatible types safely, add a new column, copy the data in a
[data migration](../migrations/custom.html), then drop the old one.
