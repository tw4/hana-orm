---
title: HANA specifics
description: "How hana-orm handles identifiers, column tables, RETURNING, DDL, LOBs and time zones on HANA."
sidebar:
  order: 2
---

How hana-orm deals with the parts of SAP HANA that differ from other databases.

## Identifiers

HANA folds unquoted identifiers to upper case: `SELECT id FROM users` reads `"ID"` from
`"USERS"`. hana-orm quotes every identifier, so names are used exactly as written in the schema
(`@map` / `@@map`, or the field and model names). If people or tools write SQL against your
tables, map them to upper-case names so quoting is not needed.

Identifiers can be up to 127 characters. Generated constraint and index names that would be
longer are shortened and end with a hash.

## Column tables

Migrations create **column-store** tables (`CREATE COLUMN TABLE`), HANA's default for
application data. Every column is stored and compressed separately, so:

- reading fewer columns is cheaper: `select` what you need;
- many lookups are fast without an index; add indexes for selective filters and joins on large
  tables.

Tables created outside hana-orm can be row-store; the client does not care.

## No RETURNING

HANA has no `INSERT … RETURNING`. After an insert, hana-orm reads the row back in the same
transaction: identity values with `CURRENT_IDENTITY_VALUE()`, sequence values with `CURRVAL`,
everything else by the primary key. The builder's `insert` / `update` / `delete` resolve with
the affected row count.

## DDL and transactions

By default HANA commits each DDL statement immediately. Migrations, `db push` and
`db execute` switch this off (`SET TRANSACTION AUTOCOMMIT DDL OFF`) for their transaction, so a
failing migration is rolled back completely. DDL you run yourself through `$executeRaw` inside
`$transaction` is committed right away.

## Paging

`take` / `skip` become `LIMIT n OFFSET m`. `skip` without `take` uses the largest possible
`LIMIT`.

## LOBs

`NCLOB`, `CLOB` and `BLOB` columns cannot be compared with `=`, sorted, grouped or used in
`DISTINCT`. hana-orm:

- stores `Json` in `NCLOB` and compares whole documents through `TO_NVARCHAR(…)`;
- uses `JSON_VALUE` / `JSON_QUERY` for Json filters with a path;
- rejects `orderBy` and `distinct` on LOB fields only when HANA does: the error comes from the
  database.

Use `NVARCHAR(n)` instead of `NCLOB` for text you sort or compare.

## Booleans

HANA has a real `BOOLEAN` type, which `Boolean` fields use.

## Dates and time zones

`TIMESTAMP` has no time zone. hana-orm treats every timestamp as UTC, both ways, and uses
`CURRENT_UTCTIMESTAMP` for `now()` defaults. See [Dates and times](/hana-orm/client/values/#dates-and-times).

## DUMMY

HANA's one-row table is `DUMMY` (`SELECT 1 FROM DUMMY`). hana-orm uses it for connection checks
and for `skipDuplicates` inserts (`INSERT … SELECT … FROM DUMMY WHERE NOT EXISTS (…)`).

## Sequences

HANA cannot use a sequence as a column default. `@default(sequence(…))` is therefore filled in
by the client (`"SEQ".NEXTVAL` in the `INSERT`). Rows inserted by other tools must call the
sequence themselves. See [Sequences](/hana-orm/schema/indexes-constraints/#sequences).

## Constraint renames

HANA can rename indexes but not constraints. A changed primary key, unique, foreign key or check
constraint name drops the constraint and adds it again.

## Tenant databases

A HANA system can host several tenant databases (MDC). Connect to a tenant's own SQL port, or to
the system database's port with `databaseName`. HANA Express's tenant is `HXE` on port `39041`.

## HANA Cloud

HANA Cloud requires TLS (`encrypt = true`) on port `443` and an allow-listed client IP address.
See [Connecting to HANA](/hana-orm/getting-started/connecting/#sap-hana-cloud).
