---
title: Transactions
description: "Interactive and batch transactions, timeouts, isolation levels and retries on SAP HANA."
sidebar:
  order: 6
---

Every single write operation already runs in its own transaction, including all its nested
writes. Use `$transaction` when several operations must succeed or fail together.

## Interactive transactions

```ts
const order = await db.$transaction(async (tx) => {
  const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
  if (product.stock < qty) throw new Error("Out of stock");

  await tx.product.update({ where: { id: productId }, data: { stock: { decrement: qty } } });
  return tx.order.create({ data: { productId, qty } });
});
```

- `tx` is a client bound to one connection. Use it, not `db`, inside the callback; queries on
  `db` run outside the transaction.
- When the callback returns, the transaction is committed and `$transaction` resolves with the
  return value.
- When it throws, the transaction is rolled back and `$transaction` rejects with that error.
- Raw SQL and the query builder on `tx` (`tx.$queryRaw`, `tx.select()…`) take part too.
- Keep transactions short: the connection is held for the whole callback.

## Batch transactions

```ts
const [post, count] = await db.$transaction([
  db.post.create({ data: { title: "Hello", authorId: 1 } }),
  db.post.count(),
]);
// [Post, number]
```

The operations run in order on one connection in one transaction. Pass them **without**
`await`: model operations are lazy and only run when `$transaction` runs them.

## Options

```ts
await db.$transaction(fn, { timeout: 10_000, maxWait: 5_000, isolationLevel: "SERIALIZABLE" });
```

| option | default | |
|---|---|---|
| `timeout` | `5000` ms | how long the transaction may run once it has a connection; `0` disables it |
| `maxWait` | `2000` ms | how long to wait for a free pooled connection |
| `isolationLevel` | HANA's default (`READ COMMITTED`) | `"READ COMMITTED"`, `"REPEATABLE READ"` or `"SERIALIZABLE"` |

Set defaults for the whole client:

```ts
const db = new HanaClient({ transactionOptions: { timeout: 10_000, maxWait: 5_000 } });
```

### When the timeout is exceeded

`$transaction` rejects with `TransactionError` (`code: "TRANSACTION_TIMEOUT"`). Further queries on
`tx` fail with `TRANSACTION_CLOSED`. The transaction is rolled back and its connection goes back
to the pool once the statement that is running has finished. To stop long statements on the
server too, set [`statementTimeout`](/hana-orm/client/performance/#statement-timeout).

When no connection becomes free within `maxWait`, it rejects with
`TransactionError` (`code: "TRANSACTION_MAX_WAIT"`). Increase `poolSize` or shorten your
transactions.

## Isolation levels in HANA

HANA uses multi-version concurrency control. Under `READ COMMITTED` each statement sees the data
committed when it started; under `REPEATABLE READ` / `SERIALIZABLE` the whole transaction sees
one snapshot. Writers still lock the rows they change: two transactions updating the same row
wait for each other. Code that reads, decides and writes should either use an atomic update
(`{ decrement: qty }` with a check) or a stricter isolation level, and be ready to retry.

## Retrying

Deadlocks, serialization conflicts and lost connections surface as `DatabaseError`. A simple
retry wrapper:

```ts
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !(e instanceof DatabaseError)) throw e;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}

await withRetry(() => db.$transaction(async (tx) => { /* … */ }));
```

## Nested transactions

The transaction client has no `$transaction`, and there are no savepoints. Write functions that
take the client as a parameter, so they can run inside a caller's transaction or on their own:

```ts
async function archiveUser(client: Pick<typeof db, "user" | "post">, id: number) {
  await client.post.updateMany({ where: { authorId: id }, data: { published: false } });
  await client.user.update({ where: { id }, data: { role: "READER" } });
}

await archiveUser(db, 1);                                         // each statement on its own
await db.$transaction((tx) => archiveUser(tx, 1));                // both in one transaction
```

## DDL in transactions

:::caution
By default HANA commits DDL immediately. A `CREATE` / `ALTER` / `DROP` run through
`tx.$executeRaw` inside `$transaction` commits what the transaction has done so far, and a later
rollback cannot undo it. Keep schema changes in [migrations](/hana-orm/migrations/): they run with
`SET TRANSACTION AUTOCOMMIT DDL OFF`, so a failed migration is rolled back completely.
:::
