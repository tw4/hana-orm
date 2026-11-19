# Benchmarks

## Against SAP HANA (`bench/hana/run.ts`)

Compares hana-orm with the same work done by hand through `@sap/hana-client`:

| scenario | hana-orm | raw driver |
|---|---|---|
| `findUnique` by primary key | `db.user.findUnique({ where: { id } })` | one prepared statement, `stmt.exec([id])` |
| page of 50 users with their 500 posts | `findMany({ take: 50, skip, include: { posts: true } })` | two queries (`LIMIT/OFFSET`, `authorId IN (…)`) grouped in JS |
| insert 1000 rows | `createMany({ data })` | one `execBatch` |

It reports the median and p95 per operation, the ratio of the medians, and the plan cache hit
rate when the client has a plan cache.

```sh
HANA_ORM_ENV_FILE=.env.test HANA_ORM_ALLOW_DDL=1 npm run bench:hana -- --out results.json --md results.md
```

It creates the schema `HANA_ORM_BENCH` (1000 users, 10000 posts) and drops it at the end, so
use a test database. The numbers depend on the machine and network; compare runs from the same
environment.

### Tracking per release

- `npm run ci:local -- --bench` runs the benchmark after the integration tests and writes
  `.local/ci/bench-results.json` / `.md`.
- For each release, run it on the release commit and copy the results to
  `bench/results/<version>.md` (and `.json`), so changes between releases stay visible in the
  repository.

## Client CPU (no database)

`bench/plan-cache.ts` and `bench/prepared.ts` (when present) measure the client's own work with
an instant fake driver.
