---
title: Troubleshooting
parent: Reference
nav_order: 3
---

# Troubleshooting
{: .no_toc }

1. TOC
{:toc}

## Connecting

### Missing HANA connection settings

```
Missing HANA connection settings: host, user, password. Set them in the datasource block or via HANA_HOST / HANA_USER / HANA_PASSWORD …
```

The datasource block uses `env("…")` for a variable that is not set, and the fallback variable
is not set either. Check that `.env` is in the folder you run the command from, and that the
variable names match.

### Connection refused / timed out

- Check host and port. A tenant's SQL port is usually `3<instance>41` (HANA Express: `39041`);
  `30015` is the single-container default.
- For HANA Cloud: port `443`, `encrypt = true`, and your IP address must be allowed in the
  instance's settings.
- For HANA Express in Docker: wait for `Startup finished!` in `docker logs`.

### authentication failed (`AUTHENTICATION`)

Wrong user or password, or the user has to change the initial password: log in once with
HANA's tools and set it.

### invalid schema name

The default schema does not exist. Migrations do not create schemas:

```sql
CREATE SCHEMA APP;
```

## Generating

### Cannot find module './generated/hana/index.ts'

Run `npx hana-orm generate`. The `output` path in the generator block is relative to the schema
file.

### TypeScript: An import path can only end with a '.ts' extension when …

Enable `allowImportingTsExtensions` (with `noEmit` or a bundler), or
`rewriteRelativeImportExtensions` (TypeScript 5.7+). See
[Running the generated client](../getting-started/installation.html#running-the-generated-client).

### The types do not match the schema

Run `hana-orm generate` again after every schema change, or keep `generate --watch` running.

## Migrations

### The migration contains destructive operations

Drops and narrowing changes need `--allow-destructive`. If you renamed a field, plan in an
interactive terminal and answer the rename question, or keep the column with `@map`. See
[Renames](../migrations/files.html#renames).

### … starts from contract … but the previous migration ends at …

Two branches planned migrations from the same starting point. Delete your branch's unmerged
migration folder and run `migrate plan` again. See
[Branches and conflicts](../migrations/files.html#branches-and-conflicts).

### … was changed after it was applied

A deployed migration's files were edited. Restore them from Git. Plan a new migration for further
changes.

### The migration lock is held

Another deploy is running, or one crashed. A lock without heartbeat for 2 minutes is taken over
automatically; `migrate deploy --wait 180` waits for it. `migrate unlock` releases it by hand.

### A migration fails with "cannot add a NOT NULL column"

The table has rows and the new required column has no default. Add a default, or add the column
as optional, fill it, and make it required later. See
[Changes that need data](../migrations/files.html#changes-that-need-data).

## Queries

### unique constraint violated (`UNIQUE_CONSTRAINT`)

A row with the same primary key or unique value exists. Use `upsert`, `skipDuplicates`, or catch
`DatabaseError` with `code === "UNIQUE_CONSTRAINT"`.

### foreign key constraint violation (`FOREIGN_KEY_CONSTRAINT`)

On insert or update: the referenced row does not exist. On delete: other rows still reference
this one; delete them first, or use `onDelete: Cascade` / `SetNull` in the schema.

### TRANSACTION_TIMEOUT

The `$transaction` took longer than `timeout` (5 s by default). Make the transaction shorter,
or raise the timeout: `$transaction(fn, { timeout: 30_000 })`.

### TRANSACTION_MAX_WAIT

All pooled connections were busy for `maxWait`. Raise `poolSize`, shorten transactions, or look
for transactions that are never finished.

### Wrong times (shifted by hours)

hana-orm treats `TIMESTAMP` values as UTC. If existing data was stored in local time by another
tool, convert it at the edges of your application. See
[Dates and times](../client/values.html#dates-and-times).

### Decimal values are strings

That is the default, to avoid losing digits. Use `decimal = "number"` or
`decimal = "decimal.js"` in the generator block. See [Decimal](../client/values.html#decimal).

### Do not know how to serialize a BigInt

`JSON.stringify` cannot handle `bigint`. Convert with a replacer, see
[BigInt](../client/values.html#bigint).

## Studio

### Misdirected request (421)

The page was opened under a host name other than the one studio listens on. Use the URL that
studio prints.

### Forbidden (403)

The token is missing or wrong. Open the full URL that studio printed; a new run creates a new
token.

## Getting more information

- `new HanaClient({ log: true })` prints every statement; add `logParams: true` locally to see the
  values.
- `HANA_ORM_DEBUG=1 npx hana-orm …` prints stack traces of CLI errors.
- `DatabaseError` has `hanaCode` (HANA's error number) and `sql` (the failing statement).

If you think you found a bug, open an issue at
<https://github.com/tw4/hana-orm/issues> with the hana-orm version, the HANA version, the schema
excerpt and the generated SQL.
