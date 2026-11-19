---
title: Development databases
sidebar:
  order: 6
---

## db push

```sh
npx hana-orm db push              # apply the schema directly
npx hana-orm db push --dry-run    # print the SQL without running it
npx hana-orm db push --allow-destructive
```

`db push` compares the live database with the schema and applies the difference, without
writing a migration. It runs in one transaction and writes the database marker.

Use it while you are still sketching a schema, for prototypes, and for throwaway databases in
tests. Switch to `migrate plan` / `deploy` once the schema is shared: a database changed with
`db push` has no history, so the first migration afterwards needs a
[baseline](/hana-orm/migrations/existing/).

## migrate reset

```sh
npx hana-orm migrate reset            # asks before dropping anything
npx hana-orm migrate reset --force    # no question (scripts, CI)
```

`migrate reset`:

1. drops the project's tables: every table of every migration and of the schema, plus the
   `_HANA_ORM_*` housekeeping tables;
2. applies all migrations again;
3. runs the seed command (`--skip-seed` to skip it).

Tables the project does not know are kept. `--schema-drop` drops every table, view and sequence
of the schemas the project uses instead.

:::danger
`migrate reset` deletes data. It refuses to run when the connection host is not `localhost`,
`127.0.0.1` or `::1` unless you pass `--allow-remote`, and without `--force` it asks for
confirmation (and refuses when it cannot ask, for example in a non-interactive shell).
:::

## db seed

`hana-orm db seed` runs your seed command with the `.env` file loaded. Configure the command in a
generator block:

```hana
generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
  seed     = "node ./seed.ts"
}
```

or in `package.json`:

```json
{ "hana-orm": { "seed": "node ./seed.ts" } }
```

A seed script is plain code using the generated client. Write it so it can run more than once:

```ts
// seed.ts
import { HanaClient } from "./src/generated/hana/index.ts";

const db = new HanaClient();

await db.user.upsert({
  where: { email: "demo@example.com" },
  create: { email: "demo@example.com", name: "Demo", role: "ADMIN" },
  update: {},
});

await db.tag.createMany({
  data: [{ name: "hana" }, { name: "orm" }, { name: "typescript" }],
  skipDuplicates: true,
});

await db.$disconnect();
```

The schema path is passed to the command as `HANA_ORM_SCHEMA`. A failing seed command makes
`db seed` (and `migrate reset`) exit with an error.

## db execute

```sh
npx hana-orm db execute --file fix.sql
cat fix.sql | npx hana-orm db execute --stdin
```

Runs a SQL script with the configured connection. All statements run in one transaction, DDL
included; nothing is committed when one fails. Useful for fixes and for scripts that
`migrate diff --script` printed.

## A local HANA

See [Testing with HANA Express](/hana-orm/guides/testing/) for running HANA Express in Docker.
