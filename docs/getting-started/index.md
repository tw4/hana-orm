---
title: Getting started
nav_order: 2
has_children: true
permalink: /getting-started/
---

# Getting started

This section takes you from an empty folder to a typed query against SAP HANA.

1. [Installation](installation.html): Node.js, the package and SAP's driver.
2. [Connecting to HANA](connecting.html): the `datasource` block, `.env`, tenant databases,
   HANA Cloud.
3. [Your first project](first-project.html): write a schema, create the tables, generate the
   client, run queries.
4. [Starting from an existing database](existing-database.html): read the tables you already
   have into a schema and keep migrating from there.
5. [Project layout](project-layout.html): which files hana-orm reads and writes, and which to
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
