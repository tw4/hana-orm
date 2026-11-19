---
title: Deploying to production
description: "Run migrate deploy in CI/CD, keep changes backward compatible and know the housekeeping tables."
sidebar:
  order: 7
---

## The deploy step

```sh
npx hana-orm migrate deploy
```

- Applies pending migrations in order, each in its own transaction.
- Needs only the `migrations/` folder, the schema and the connection, not the application.
- Exits with 1 when a migration fails (that migration is rolled back; earlier ones in the same
  run stay applied) or when the history blocks the deploy.
- Prints `No pending migrations. The database is up to date.` when there is nothing to do, so it
  is safe to run on every deploy.

Run it **before** the new application version starts, as its own step: a CI job, a Kubernetes
`Job` or init container, or a release phase. Use a database user that may change the schema; the
application itself can run with a user that only reads and writes data.

## Several instances at once

Deploys take a lock in `_HANA_ORM_LOCK`. A second `migrate deploy` started at the same time
stops right away, or waits when you pass `--wait`:

```sh
npx hana-orm migrate deploy --wait 120   # wait up to 120 s for a running deploy
```

A running deploy refreshes the lock every 20 seconds. A lock without a heartbeat for 2 minutes
belongs to a crashed deploy and is taken over automatically. `migrate unlock` releases it by
hand.

## A CI/CD pipeline

```yaml
# .github/workflows/deploy.yml (excerpt)
jobs:
  migrate:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx hana-orm migrate deploy --wait 120
        env:
          HANA_HOST: ${{ secrets.HANA_HOST }}
          HANA_PORT: "443"
          HANA_USER: ${{ secrets.HANA_MIGRATION_USER }}
          HANA_PASSWORD: ${{ secrets.HANA_MIGRATION_PASSWORD }}
          HANA_ENCRYPT: "true"
  app:
    needs: migrate
    # … deploy the application
```

On pull requests, check that the schema and the migrations agree, without a database:

```yaml
      - run: npx hana-orm validate
      - run: npx hana-orm format --check
      - run: npx hana-orm migrate diff --from migrations --to schema --exit-code
```

The last command exits with 2 when the schema has changes without a migration.

## Review before deploying

```sh
npx hana-orm migrate show                 # SQL of every pending migration
npx hana-orm migrate show 20261121080000  # SQL of one migration
```

Without an id, `migrate show` connects to find the pending migrations; with an id (or a prefix
of one) it only reads the folder. Review especially:

- operations marked `!` in the plan output (destructive);
- `ALTER … NOT NULL` on large tables;
- index creation on large tables, which takes time and resources.

## Backward-compatible changes

The new schema and the old application version run side by side for a moment (during a rolling
deploy, or when a rollback is needed). Keep each migration compatible with the application
version before it:

| change | safe sequence |
|---|---|
| add a column | add it optional or with a default → deploy the app that writes it → make it required later |
| drop a column | deploy the app that no longer uses it (`@ignore` it first) → drop it in a later migration |
| rename a column | add the new column → write both → backfill → read the new one → drop the old one; or keep the column name with `@map` |
| change a type | add a new column, migrate data, switch, drop the old one |

## Rolling back

hana-orm has no down migrations. A failed migration rolls itself back. To undo a migration that
succeeded, write a new migration that reverses it (`migrate plan` after reverting the schema
change in Git). Restore from a backup for data you dropped.

## Housekeeping tables

All in the datasource's default schema:

| table | contents |
|---|---|
| `_HANA_ORM_MIGRATIONS` | one row per applied (or failed) migration: id, checksum, contract hashes, timestamps, log |
| `_HANA_ORM_LOCK` | the deploy lock with its owner and heartbeat |
| `_HANA_ORM_MARKER` | the contract hash the database was last brought to, and by which migration |

They are created on first use. Do not edit them by hand; use `migrate resolve` and
`migrate unlock`.
