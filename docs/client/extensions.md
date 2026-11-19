---
title: Extensions
parent: Client
nav_order: 10
---

# Extensions
{: .no_toc }

1. TOC
{:toc}

`$extends` returns a new client with extra behavior. The original client is unchanged, and both
share the same connection pool.

```ts
const xdb = db.$extends({
  model: { … },   // extra methods on model delegates
  query: { … },   // hooks around operations
  client: { … },  // extra methods on the client
  result: { … },  // computed fields
});
```

Extensions can be chained: `db.$extends(a).$extends(b)`. Types follow: methods and computed
fields you add show up in autocompletion and result types.

## Model methods

```ts
const xdb = db.$extends({
  model: {
    user: {
      byEmail(email: string) {
        return db.user.findUnique({ where: { email } });
      },
    },
    $allModels: {
      async exists(this: { count(args: object): Promise<number> }, where: object) {
        return (await this.count({ where })) > 0;
      },
    },
  },
});

await xdb.user.byEmail("ada@example.com");
await xdb.post.exists({ published: true });
```

`$allModels` adds a method to every delegate. Inside a method, `this` is the delegate it was
called on.

## Query hooks

Query hooks wrap operations. They receive the model name, the operation, the arguments and a
`query` function that runs the operation (or the next hook):

```ts
const xdb = db.$extends({
  query: {
    post: {
      findMany({ args, query }) {
        args.where = { ...args.where, deletedAt: null };   // soft delete
        return query(args);
      },
    },
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const start = performance.now();
        try {
          return await query(args);
        } finally {
          metrics.observe(`${model}.${operation}`, performance.now() - start);
        }
      },
    },
  },
});
```

Hook keys: an operation name (`findMany`, `create`, …) or `$allOperations`, under a model key
(camelCase) or `$allModels`.

- Hooks run when an operation is called on the extended client, including inside
  `$transaction` on `tx`.
- Hooks of a later `$extends` wrap those of an earlier one.
- Hooks do not run for raw SQL, the query builder or [prepared queries](query-builder.html#prepared-queries).
- Nested reads and writes (an `include`, a nested `create`) are part of the outer operation; they
  do not call hooks of the related model.

## Client methods

```ts
const xdb = db.$extends({
  client: {
    async ping() {
      await db.$queryRaw`SELECT 1 FROM DUMMY`;
      return true;
    },
  },
});

await xdb.ping();
```

## Computed fields

```ts
const xdb = db.$extends({
  result: {
    user: {
      displayName: {
        needs: { name: true, email: true },
        compute: (u) => u.name ?? u.email.split("@")[0],
      },
    },
  },
});

const users = await xdb.user.findMany({ select: { id: true, displayName: true } });
// { id: number; displayName: string }[]
```

- `needs` lists the fields `compute` reads. They are fetched even when `select` or `omit` (also
  the client-wide `omit`) leave them out, and removed from the result again.
- Without `select`, every computed field is added. `select: { displayName: true }` picks it,
  `omit: { displayName: true }` leaves it out.
- Computed fields apply to the rows an operation returns (`find*`, `create`, `update`, `upsert`,
  `delete`, `createManyAndReturn`), not to related rows loaded with `include`.
- A later `$extends` can add fields or replace one with the same name.
- Computing happens in your process after the query; you cannot filter or sort by a computed
  field. For that, use a database column or a view.

## Recipes

### Soft delete

```hana
model Post {
  id        Int       @id @default(autoincrement())
  title     String
  deletedAt DateTime?
}
```

```ts
const xdb = db.$extends({
  model: {
    post: {
      softDelete(id: number) {
        return db.post.update({ where: { id }, data: { deletedAt: new Date() } });
      },
    },
  },
  query: {
    post: {
      findMany: ({ args, query }) => query({ ...args, where: { ...args.where, deletedAt: null } }),
      findFirst: ({ args, query }) => query({ ...args, where: { ...args.where, deletedAt: null } }),
      count: ({ args, query }) => query({ ...args, where: { ...args.where, deletedAt: null } }),
    },
  },
});
```

### Audit log

```ts
const xdb = db.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);
        if (["create", "update", "delete", "upsert"].includes(operation)) {
          await db.auditLog.create({ data: { model, operation, at: new Date() } });
        }
        return result;
      },
    },
  },
});
```

This writes the audit row in its own transaction. To write it in the same transaction as the
change, do both inside `$transaction` on `tx`.
