---
title: Coming from TypeORM
sidebar:
  order: 2
---

TypeORM describes tables with decorated classes and returns entity instances; hana-orm describes
them in a schema file and returns plain objects whose types follow each query.

## Entities → models

```ts
@Entity("USERS")
class User {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true, length: 320 }) email: string;
  @Column({ nullable: true }) name: string | null;
  @OneToMany(() => Post, (p) => p.author) posts: Post[];
}
```

```hana
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique @db.NVarChar(320)
  name  String?
  posts Post[]

  @@map("USERS")
}
```

`@ManyToOne` + `@JoinColumn` become a scalar foreign key field plus
`@relation(fields: [authorId], references: [id])`. With an existing database, `hana-orm db pull`
writes the models for you.

## Repositories → delegates

| TypeORM | hana-orm |
|---|---|
| `repo.find({ where, relations: ["posts"] })` | `db.user.findMany({ where, include: { posts: true } })` |
| `repo.findOneBy({ id })` | `db.user.findUnique({ where: { id } })` |
| `repo.save(entity)` | `db.user.create` / `update` / `upsert` |
| `repo.delete({ id })` | `db.user.delete({ where: { id } })` |
| `Like("%x%")`, `In([…])`, `MoreThan(n)` | `{ contains: "x" }`, `{ in: […] }`, `{ gt: n }` |
| `dataSource.transaction(async (m) => …)` | `db.$transaction(async (tx) => …)` |
| `createQueryBuilder()` | the [query builder](/hana-orm/client/query-builder/): `db.select().from(user).leftJoin(…)` |

## Migrations

TypeORM migrations are TypeScript classes; hana-orm plans them from the schema and stores the
literal SQL (`hana-orm migrate plan`). Data migrations can still be TypeScript
(`migrate plan --empty --script`). `synchronize: true` corresponds to `hana-orm db push`.
