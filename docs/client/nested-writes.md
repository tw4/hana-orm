---
title: Nested writes
parent: Client
nav_order: 4
---

# Nested writes
{: .no_toc }

1. TOC
{:toc}

`create`, `update` and `upsert` can change related rows in the same call. The whole call runs in
one transaction: if any part fails, nothing is written.

## In create

```ts
const user = await db.user.create({
  data: {
    email: "ada@example.com",
    profile: { create: { bio: "Mathematician" } },                 // to-one
    posts: {
      create: [{ title: "First" }, { title: "Second" }],           // to-many
    },
  },
  include: { profile: true, posts: true },
});
```

Operations available in `create`:

| operation | to-one | to-many | |
|---|---|---|---|
| `create` | ✓ | ✓ (one or a list) | insert related rows |
| `createMany` | | ✓ | insert a list in a batch, with `skipDuplicates` (not for implicit many-to-many) |
| `connect` | ✓ | ✓ | link existing rows by a unique field |
| `connectOrCreate` | ✓ | ✓ | link a row, or create it if it does not exist |

```ts
await db.post.create({
  data: {
    title: "Tagged",
    author: { connect: { email: "ada@example.com" } },
    tags: {
      connectOrCreate: [
        { where: { name: "hana" }, create: { name: "hana" } },
        { where: { name: "orm" }, create: { name: "orm" } },
      ],
    },
  },
});
```

Instead of `author: { connect: { id } }` you can set the foreign key directly:
`authorId: 1`.

## In update

```ts
await db.user.update({
  where: { id: 1 },
  data: {
    name: "Ada Lovelace",
    profile: { upsert: { create: { bio: "New" }, update: { bio: "Updated" } } },
    posts: {
      updateMany: { where: { published: false }, data: { published: true } },
      deleteMany: { title: { startsWith: "Draft" } },
      create: { title: "Another one" },
    },
  },
});
```

| operation | to-one | to-many | |
|---|---|---|---|
| `create`, `createMany`, `connect`, `connectOrCreate` | ✓ | ✓ | as in `create` |
| `set` | | ✓ | replace all links with exactly these rows |
| `disconnect` | `true` | list of unique filters | remove the link (sets the foreign key to `NULL`, or deletes the join row) |
| `update` | data | `{ where, data }` (one or a list) | update related rows |
| `updateMany` | | `{ where, data }` | update related rows matching a filter |
| `upsert` | `{ create, update }` | `{ where, create, update }` | update or create |
| `delete` | `true` | list of unique filters | delete related rows |
| `deleteMany` | | a filter | delete related rows matching a filter |

Only related rows are affected: `posts: { deleteMany: {} }` deletes the user's posts, not every
post.

### Order of operations

Within one relation, operations run in this order: `set`, `disconnect`, `delete`, `deleteMany`,
`update`, `updateMany`, `upsert`, `create`, `createMany`, `connect`, `connectOrCreate`. So
`{ set: [], create: [...] }` first removes all links and then creates the new rows.

## Many-to-many

For [implicit many-to-many](../schema/relations.html#implicit) relations, `connect`,
`disconnect` and `set` write the join table:

```ts
await db.post.update({
  where: { id: 1 },
  data: { tags: { set: [{ name: "hana" }, { name: "orm" }] } },
});

await db.post.update({
  where: { id: 1 },
  data: { tags: { disconnect: [{ name: "orm" }] } },
});
```

`connect` of a row that is already linked does nothing.

## Required relations

- Disconnecting a required to-one relation is not possible; the foreign key cannot be `NULL`.
  Delete the row or connect it to another one.
- Creating a row with a required relation needs either the foreign key, `connect`, or
  `create` for that relation.

## Errors

- `connect` to a row that does not exist throws `NotFoundError`.
- Constraint violations in any nested step throw `DatabaseError` and roll back the whole call.
