// Compile-time checks for implicit many-to-many relations. Checked by `npm run typecheck`, never executed.
import { HanaClient } from "../generated/m2m/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}
declare const db: HanaClient;

async function checks() {
  const a = await db.article.findFirstOrThrow({ include: { categories: { select: { label: true } } } });
  expectType<Equal<typeof a.categories, { label: string }[]>>();
  const counted = await db.category.findMany({ select: { id: true, _count: { select: { articles: true } } } });
  expectType<Equal<(typeof counted)[number]["_count"], { articles: number }>>();
  await db.article.findMany({ where: { categories: { some: { label: "x" } } }, orderBy: { categories: { _count: "desc" } } });
  await db.article.create({ data: { title: "t", categories: { connect: [{ id: "x" }], create: { id: "y", label: "Y" }, connectOrCreate: { where: { id: "z" }, create: { id: "z", label: "Z" } } } } });
  await db.article.update({ where: { id: 1 }, data: { categories: { set: [{ id: "x" }], disconnect: { id: "y" }, deleteMany: { label: "old" }, updateMany: { where: {}, data: { label: "n" } } } } });
  await db.member.update({ where: { id: 1 }, data: { following: { connect: { id: 2 } } } });
  // @ts-expect-error many-to-many relations have no nested createMany
  await db.article.create({ data: { title: "t", categories: { createMany: { data: [{ id: "x", label: "X" }] } } } });
  // @ts-expect-error the join table is not a model of the client
  db._ArticleToCategory;
}
void checks;
