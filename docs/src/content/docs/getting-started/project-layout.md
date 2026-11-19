---
title: Project layout
description: "Which files hana-orm reads and writes, what to commit and how to share one client."
sidebar:
  order: 5
---

A typical project:

```
my-app/
├── schema.hana                 # the schema (or a schema/ folder with several .hana files)
├── migrations/                 # one folder per migration, next to the schema
│   ├── 20261119093000_init/
│   │   ├── ops.json            # operations with their SQL: what deploy runs
│   │   ├── migration.sql       # the same SQL to read in review
│   │   └── contract.json       # the data model after this migration
│   └── 20261120101500_post_views/
├── sql/                        # optional: .sql files for typed raw queries
│   └── top-authors.sql
├── seed.ts                     # optional: seed script for `hana-orm db seed`
├── src/
│   ├── generated/hana/         # written by `hana-orm generate`
│   │   ├── index.ts            # the client, model types, tables
│   │   └── sql.ts              # typed queries from sql/ (with `generate --sql`)
│   └── db.ts                   # your client instance
├── .env                        # connection; never commit
└── .env.example                # template; commit
```

## Where hana-orm looks for the schema

Every command takes `--schema <path>`. Without it the CLI tries, in order:

1. `./schema.hana`
2. `./hana/schema.hana`
3. `./schema/` (a folder of `.hana` files)

Paths in the schema (the generator `output`, `migrations/`, `sql/`) are relative to the schema
file, or to the folder for a schema folder.

## What to commit

| path | commit? |
|---|---|
| `schema.hana` / `schema/` | yes |
| `migrations/` | yes, all of it, and never edit a migration that has been deployed |
| `sql/` | yes |
| `src/generated/hana/` | your choice. Committing it avoids a generate step in CI; ignoring it avoids noisy diffs. If you ignore it, run `hana-orm generate` in `postinstall` or before the build. |
| `.env` | **never** |
| `.env.example` | yes |

## One client per process

Create the client once and share it. It holds the connection pool:

```ts
// src/db.ts
import { HanaClient } from "./generated/hana/index.ts";

export const db = new HanaClient({ poolSize: 10 });

process.once("SIGTERM", () => void db.$disconnect());
```

## Scripts

```json
{
  "scripts": {
    "db:generate": "hana-orm generate",
    "db:migrate": "hana-orm migrate deploy",
    "db:status": "hana-orm migrate status",
    "db:seed": "hana-orm db seed",
    "db:studio": "hana-orm studio"
  }
}
```
