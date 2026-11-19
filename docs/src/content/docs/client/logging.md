---
title: Logging, events and metrics
sidebar:
  order: 11
---

## Logging to the console

```ts
const db = new HanaClient({ log: true });                      // every statement
const db2 = new HanaClient({ log: ["warn", "error"] });        // only these events
const db3 = new HanaClient({ log: (e) => logger.debug(e) });   // { sql, params, durationMs } per statement
```

Output with `log: true`:

```
hana-orm:query SELECT t0."id" AS "id", t0."email" AS "email", … FROM "APP"."User" t0 WHERE t0."id" = ? ORDER BY t0."id" ASC LIMIT 1 (1.8 ms)
```

With `log: ["query", "info", "warn", "error"]` each event goes to `console.log` / `info` /
`warn` / `error`:

```
hana-orm:warn [query] Slow query (812.4 ms): SELECT …
hana-orm:error [User.create] unique constraint violated: …
```

## Events

`$on` subscribes to events and returns a function that unsubscribes:

```ts
const off = db.$on("query", (e) => {
  histogram.observe(e.durationMs);
});
db.$on("error", (e) => reportError(e.target, e.message));
off();
```

| event | when | payload |
|---|---|---|
| `query` | every statement, also inside transactions | `{ timestamp, sql, params, durationMs, inTransaction, error? }` |
| `info` | `$connect()`, `$disconnect()` | `{ timestamp, message, target }` |
| `warn` | statements slower than `slowQueryThreshold` | `{ timestamp, message, target }` |
| `error` | a failed model operation, raw query or transaction | `{ timestamp, message, target }` |

`target` is `client`, `query`, `transaction`, `$queryRaw`, `$executeRaw`, or
`<Model>.<operation>` such as `User.create`.

A listener that throws is ignored, so it cannot break a query.

### Slow queries

```ts
const db = new HanaClient({ slowQueryThreshold: 500, log: ["warn"] });
```

Statements that take at least 500 ms also emit a `warn` event.

### Parameter values

Bound values are **not** included in events and logs by default: they may contain personal
data or secrets. Turn them on for local debugging only:

```ts
const db = new HanaClient({ log: true, logParams: true });
```

## Metrics

```ts
db.$metrics();
```

```ts
{
  queries: {
    total: 1532,
    failed: 3,
    durationMs: { total: 4120.5, max: 812.4, avg: 2.69 },
    histogram: [{ le: 1, count: 640 }, { le: 5, count: 801 }, …, { le: Infinity, count: 0 }],
  },
  transactions: { total: 210, committed: 207, rolledBack: 3 },
  pool: { size: 10, open: 4, idle: 3, busy: 1, waiting: 0 },
}
```

- The histogram buckets are 1, 5, 10, 50, 100, 500, 1000 and 5000 ms, plus everything above.
  Counts are per bucket, not cumulative.
- `pool` is `null` with a custom driver that does not report pool statistics.

### Exporting to Prometheus

```ts
import client from "prom-client";

const queries = new client.Histogram({
  name: "hana_query_duration_seconds",
  help: "hana-orm statement duration",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
});
db.$on("query", (e) => queries.observe(e.durationMs / 1000));

new client.Gauge({
  name: "hana_pool_busy",
  help: "busy pooled connections",
  collect() { this.set(db.$metrics().pool?.busy ?? 0); },
});
```

## Tracing

`$on("query")` and [query hooks](/hana-orm/client/extensions/#query-hooks) are the places to start spans: a
hook sees the model and operation, the `query` event sees each SQL statement with its duration.
