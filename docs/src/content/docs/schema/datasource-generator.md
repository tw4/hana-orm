---
title: Datasource and generator
sidebar:
  order: 1
---

## datasource

Exactly one `datasource` block per schema (also per schema folder).

```hana
datasource db {
  provider               = "hana"
  host                   = env("HANA_HOST")
  port                   = env("HANA_PORT")
  user                   = env("HANA_USER")
  password               = env("HANA_PASSWORD")
  databaseName           = env("HANA_DATABASE")
  schema                 = "APP"
  encrypt                = true
  sslValidateCertificate = true
}
```

| field | type | meaning |
|---|---|---|
| `provider` | `"hana"` | required |
| `url` | string | `hana://user:password@host:port/?databaseName=…&currentSchema=…&encrypt=true`; other fields override its parts |
| `host` | string | host name |
| `port` | number | SQL port (default `30015`) |
| `user`, `password` | string | credentials |
| `databaseName` | string | tenant database when connecting through SYSTEMDB |
| `schema` | string | default schema: models without `@@schema` live here, and it is the session's current schema |
| `encrypt` | boolean | TLS (required for HANA Cloud) |
| `sslValidateCertificate` | boolean | validate the server certificate (default `true`) |

Every value can be a literal or `env("NAME")`. Settings that are not given fall back to the
`HANA_*` environment variables; see [Connecting to HANA](/hana-orm/getting-started/connecting/).

### The default schema

`schema` matters in three places:

- Tables of models without `@@schema` are created and queried in it.
- The migration history (`_HANA_ORM_MIGRATIONS`) and lock tables live in it.
- Generated SQL qualifies table names with the schema, so queries do not depend on the
  session's current schema.

Without `schema` (and without `HANA_SCHEMA`), tables are created in the user's own schema.

## generator

```hana
generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
  decimal  = "string"
  seed     = "node ./seed.ts"
}
```

| field | default | meaning |
|---|---|---|
| `provider` | | `"hana-orm"` |
| `output` | `./generated/hana` | folder for `index.ts` (and `sql.ts`), relative to the schema |
| `decimal` | `"string"` | how `Decimal` values are represented: `"string"`, `"number"` or `"decimal.js"`; see [values](/hana-orm/client/values/#decimal) |
| `clientName` | `HanaClient` | name of the generated client class |
| `runtimeImport` | `hana-orm/runtime` | module the generated file imports the runtime from |
| `seed` | | command run by `hana-orm db seed` |

### Several generators

A schema may have more than one generator, for example to generate the client into two
packages of a monorepo, or once with `decimal = "string"` and once with
`decimal = "decimal.js"`:

```hana
generator api {
  provider = "hana-orm"
  output   = "../api/src/generated/hana"
}

generator jobs {
  provider   = "hana-orm"
  output     = "../jobs/src/generated/hana"
  decimal    = "decimal.js"
  clientName = "JobsDb"
}
```

`hana-orm generate` writes every one of them. Without a generator block, it writes
`./generated/hana/index.ts`.
