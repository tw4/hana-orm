---
title: Coming from @sap/hana-client
sidebar:
  order: 3
---

hana-orm uses `@sap/hana-client` underneath, so you keep SAP's driver and connection options and
can still run any SQL.

| raw driver | hana-orm |
|---|---|
| `hana.createConnection().connect({ serverNode, uid, pwd })` | the `datasource` block / `.env`; a pool is managed for you (`poolSize`) |
| `conn.exec(sql, params, cb)` | `await db.$queryRawUnsafe(sql, ...params)` or the typed model API |
| `conn.setAutoCommit(false)` … `commit` / `rollback` | `await db.$transaction(async (tx) => …)` |
| `stmt.execBatch(rows)` | `db.model.createMany({ data })` (batched per column set), or builder updates in `$batch` |
| `conn.prepare(sql)` reused | prepared queries (`.prepare()`) and `statementCacheSize` |
| converting `BIGINT`/`DECIMAL` strings, `TIMESTAMP` strings | done by the client: `bigint`, decimal strings, `Date` (UTC) |
| hand-written DDL scripts | the schema + `hana-orm migrate plan` / `deploy` |

Raw SQL remains available everywhere:

```ts
const rows = await db.$queryRaw`SELECT "ID", "NAME" FROM "APP"."USERS" WHERE "AGE" > ${18}`;
await db.$executeRaw`MERGE DELTA OF "APP"."EVENTS"`;
```

Pass connection options the client does not model (e.g. `communicationTimeout`) through
`new HanaClient({ datasource: { extra: { … } } })`.
