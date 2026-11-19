---
title: Hand-written and data migrations
sidebar:
  order: 2
---

## Hand-written SQL

```sh
npx hana-orm migrate plan --name active_customers_view --empty
```

This creates a migration whose `migration.sql` is yours to write:

```sql
-- Hand-written migration. Statements are separated by ';' and run in order
-- inside one transaction by `hana-orm migrate deploy`.

CREATE VIEW "ACTIVE_CUSTOMERS" AS
  SELECT "ID", "EMAIL", "NAME" FROM "CUSTOMERS" WHERE "ACTIVE" = TRUE;
```

- The statements run in order, inside the migration's transaction, with DDL auto-commit off: a
  failing statement rolls back all of them.
- The file is checksummed once it is deployed, like `ops.json`.
- An `--empty` migration does not change the contract. Use it for things the schema cannot
  describe: views, procedures, grants, synonyms, data fixes.

## Data migrations in TypeScript

```sh
npx hana-orm migrate plan --name backfill_display_name --script
```

`--script` adds a `migration.ts` that runs inside the migration's transaction, after the
schema changes of the same migration. Combine it with a schema change, or with `--empty` for a
script on its own.

```ts
// migrations/20261121080000_backfill_display_name/migration.ts
import type { MigrationScript } from "hana-orm/migrate";

const migration: MigrationScript = async ({ query, execute, log }) => {
  const rows = await query<{ ID: number; EMAIL: string }>(
    'SELECT "ID", "EMAIL" FROM "USERS" WHERE "DISPLAY_NAME" IS NULL',
  );
  for (const r of rows) {
    await execute('UPDATE "USERS" SET "DISPLAY_NAME" = ? WHERE "ID" = ?', [r.EMAIL.split("@")[0], r.ID]);
  }
  log(`${rows.length} users updated`);
};

export default migration;
```

| argument | |
|---|---|
| `query(sql, params?)` | runs a `SELECT` with `?` parameters, returns rows |
| `execute(sql, params?)` | runs DML or DDL with `?` parameters, returns the affected row count |
| `log(message)` | prints a line during `migrate deploy` |
| `tx` | the underlying transaction (`query`, `execute`, `executeBatch`) |

Throwing rolls back the whole migration, including its schema changes.

:::note
Data migrations use plain SQL on purpose. A generated client describes the schema as it is
**now**; a migration has to work against the schema as it was **then**, also years later.
:::

### Large tables

- Update with one set-based statement where possible
  (`UPDATE … SET "DISPLAY_NAME" = SUBSTR_BEFORE("EMAIL", '@') WHERE …`); it is far faster than a
  loop.
- The whole migration is one transaction. For very large backfills, consider running them
  outside migrations in batches, and only adding the constraint in a migration afterwards.

## Example: a new required column

Adding a required column to a table with rows takes three steps:

1. Add the field as optional and plan: `migrate plan --name add_slug`.
2. Fill it: `migrate plan --name fill_slug --empty --script`, with
   `execute('UPDATE "Post" SET "slug" = LOWER(REPLACE("title", \' \', \'-\')) WHERE "slug" IS NULL')`.
3. Make it required and plan: `migrate plan --name require_slug --allow-destructive`.

Keep steps 2 and 3 in separate migrations. In one migration the script would run after the
`ALTER … NOT NULL`, which fails while the column still contains `NULL`s.
