---
title: Testing with HANA Express
sidebar:
  order: 4
---

The most reliable tests for database code run against a real HANA. SAP HANA Express is free for
development and runs in Docker.

## Running HANA Express in Docker

```yaml
# docker-compose.hana.yml
services:
  hana:
    image: saplabs/hanaexpress:latest
    container_name: hxe
    hostname: hxehost
    command: ["--passwords-url", "file:///hana/mounts/password.json", "--agree-to-sap-license"]
    ports:
      - "39013:39013" # SYSTEMDB SQL
      - "39017:39017"
      - "39041:39041" # tenant HXE SQL
    platform: linux/amd64
    ulimits:
      nofile: 1048576
    sysctls:
      kernel.shmmax: 1073741824
      net.ipv4.ip_local_port_range: "40000 60999"
      kernel.shmmni: 4096
      kernel.shmall: 8388608
    volumes:
      - ./.local/hxe:/hana/mounts
```

1. Create `.local/hxe/password.json` with a master password (8+ characters, upper case, lower
   case and a digit):

   ```json
   {"master_password":"…"}
   ```

2. Start it: `docker compose -f docker-compose.hana.yml up -d`. The first start takes several
   minutes; later starts about a minute. `docker logs -f hxe` prints `Startup finished!` when it
   is ready.
3. Connect to tenant `HXE` on port `39041` as `SYSTEM` with the master password:

   ```sh
   # .env.test
   HANA_HOST=localhost
   HANA_PORT=39041
   HANA_USER=SYSTEM
   HANA_PASSWORD=…
   HANA_DATABASE=HXE
   ```

Notes:

- Starting the container accepts the
  [SAP HANA Express license](https://www.sap.com/about/legal/agreements.html).
- It needs about 10 GB of free disk and 8 GB of memory for Docker.
- HANA deletes `password.json` after the first start. To start from scratch, empty `.local/hxe`
  and create the file again.
- The image is amd64 only. On Apple Silicon it runs under emulation in Docker Desktop. If the
  tenant database does not start, run the container on an amd64 machine and point `HANA_HOST`
  at it.
- `SYSTEM` is fine for a local test database. Create a dedicated user for anything else.

## A test schema per run

Give every test run its own schema and drop it at the end, so runs do not see each other's data:

```ts
// test/setup.ts
import { HanaClient } from "../src/generated/hana/index.ts";

export const schema = `TEST_${process.pid}_${Date.now().toString(36).toUpperCase()}`;
export const db = new HanaClient({ schema, poolSize: 2 });

export async function setup() {
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  // create the tables: run the migrations' SQL, or `hana-orm db push` with HANA_SCHEMA set
}

export async function teardown() {
  await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await db.$disconnect();
}
```

To create the tables, the simplest way is to run the CLI with the schema overridden:

```sh
HANA_SCHEMA=TEST_123 npx hana-orm db push
```

This works when the `datasource` block does not set `schema` itself (the fallback variable is
only used when the block leaves it out).

## Isolating tests with transactions

Inside a test schema, tests can still affect each other. Wrap each test in a transaction that is
always rolled back:

```ts
class Rollback extends Error {}

async function inRollback(fn: (tx: typeof db) => Promise<void>) {
  try {
    await db.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

test("creates a user", () =>
  inRollback(async (tx) => {
    await tx.user.create({ data: { email: "t@example.com" } });
    assert.equal(await tx.user.count(), 1);
  }));
```

The code under test must accept the transaction client (`tx`) instead of importing `db`
directly.

## Unit tests without a database

The client accepts a custom `driver`. A fake driver records statements and returns canned rows,
which is enough to test which queries your code sends:

```ts
import type { Driver } from "hana-orm/runtime";

class FakeDriver implements Driver {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];
  async query(sql: string, params: readonly unknown[] = []) { this.calls.push({ sql, params }); return this.rows as any; }
  async execute(sql: string, params: readonly unknown[] = []) { this.calls.push({ sql, params }); return 1; }
  async executeBatch(sql: string, rows: readonly (readonly unknown[])[]) { rows.forEach((params) => this.calls.push({ sql, params })); return rows.length; }
  async transaction<T>(fn: (tx: this) => Promise<T>) { return fn(this); }
  async close() {}
}

const driver = new FakeDriver();
const db = new HanaClient({ driver });
await db.user.findMany({ where: { role: "ADMIN" } });
assert.match(driver.calls[0]!.sql, /WHERE .*"role" = \?/);
```

Use this for query shapes; use HANA for behavior (constraints, defaults, transactions).

## In CI

HANA Express needs more disk and memory than hosted CI runners have by default, and takes
minutes to start. Common setups:

- a self-hosted runner with HANA Express running permanently, each job using its own schema;
- a shared HANA (Express or Cloud trial) that CI reaches over the network, again with a schema
  per job;
- running the database tests locally before merging, and only unit tests in hosted CI.

hana-orm itself uses the last approach: `npm run ci:local` runs the full suite against a local
HANA Express before changes are merged.
