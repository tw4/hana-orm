---
title: HANA type mapping
nav_order: 7
---

# HANA type mapping

## Schema type → HANA column → TypeScript

| schema type | HANA column (default) | TypeScript (read) | TypeScript (write) |
|---|---|---|---|
| `String` | `NVARCHAR(5000)` | `string` | `string` |
| `Int` | `INTEGER` | `number` | `number` (integer) |
| `BigInt` | `BIGINT` | `bigint` | `bigint \| number` |
| `Float` | `DOUBLE` | `number` | `number` |
| `Decimal` | `DECIMAL(38,10)` | `string` (no precision loss) | `string \| number` |
| `Boolean` | `BOOLEAN` | `boolean` | `boolean` |
| `DateTime` | `TIMESTAMP` | `Date` (UTC) | `Date \| string` |
| `Bytes` | `BLOB` | `Buffer` | `Buffer \| Uint8Array` |
| `Json` | `NCLOB` | JSON value | JSON value |
| enum | `NVARCHAR(255)` | the enum's value names | value names |

`DECIMAL(38,10)` is HANA's maximum precision with ten fractional digits; a bare `DECIMAL` would be
a floating decimal, which compares and rounds differently.

## Native types (`@db.*`)

A `@db.*` attribute picks another HANA type for the column:

| schema type | native types |
|---|---|
| `String` | `@db.NVarChar(n)`, `@db.VarChar(n)`, `@db.NChar(n)`, `@db.Char(n)`, `@db.Alphanum(n)`, `@db.NClob`, `@db.Clob`, `@db.Text` |
| `Int` | `@db.Integer` (default), `@db.SmallInt`, `@db.TinyInt` |
| `Decimal` | `@db.Decimal(p, s)`, `@db.SmallDecimal` |
| `Float` | `@db.Double` (default), `@db.Real` |
| `DateTime` | `@db.Timestamp` (default), `@db.SecondDate`, `@db.Date`, `@db.Time` |
| `Bytes` | `@db.Blob` (default), `@db.VarBinary(n)`, `@db.Binary(n)` |

`DATE` values are read as midnight UTC; `TIME` as `1970-01-01T…Z`.

## `db pull`: HANA column → schema type

| HANA | schema |
|---|---|
| `NVARCHAR(5000)` | `String` |
| `NVARCHAR(n)`, `VARCHAR`, `NCHAR`, `CHAR`, `ALPHANUM`, `NCLOB`, `CLOB`, `TEXT` | `String` with the `@db.*` type |
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

Migrations classify type changes: widening (e.g. `INTEGER` → `BIGINT`, longer `NVARCHAR`) runs
as `ALTER TABLE … ALTER`; narrowing or incompatible changes are destructive and need
`--allow-destructive`. Adding or removing an identity re-creates the column.
