---
title: Getting started
sidebar:
  label: Overview
  order: 0
---

This section takes you from an empty folder to a typed query against SAP HANA.

1. [Installation](/hana-orm/getting-started/installation/): Node.js, the package and SAP's driver.
2. [Connecting to HANA](/hana-orm/getting-started/connecting/): the `datasource` block, `.env`, tenant databases,
   HANA Cloud.
3. [Your first project](/hana-orm/getting-started/first-project/): write a schema, create the tables, generate the
   client, run queries.
4. [Starting from an existing database](/hana-orm/getting-started/existing-database/): read the tables you already
   have into a schema and keep migrating from there.
5. [Project layout](/hana-orm/getting-started/project-layout/): which files hana-orm reads and writes, and which to
   commit.

The short version:

```sh
npm install hana-orm @sap/hana-client
npx hana-orm init                       # schema.hana and .env.example
cp .env.example .env                    # fill in the connection
npx hana-orm migrate plan --name init   # or: npx hana-orm db pull (existing database)
npx hana-orm migrate deploy
npx hana-orm generate
```

```ts
import { HanaClient } from "./src/generated/hana/index.ts";

const db = new HanaClient();
console.log(await db.user.findMany({ take: 10 }));
await db.$disconnect();
```
