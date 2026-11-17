// Compile-time checks of generated types. Checked by `npm run typecheck`, never executed.
import { HanaClient, Role, type User } from "../generated/blog/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}
declare const db: HanaClient;

async function checks() {
  const users = await db.user.findMany({ where: { email: { contains: "@x" }, posts: { some: { published: true } } } });
  expectType<Equal<typeof users, User[]>>();

  const picked = await db.user.findMany({ select: { id: true, email: true, posts: { select: { title: true } } } });
  expectType<Equal<typeof picked, { id: number; email: string; posts: { title: string }[] }[]>>();

  const withRel = await db.post.findFirst({ include: { author: true, tags: true } });
  if (withRel) {
    expectType<Equal<typeof withRel.author, User | null>>();
    expectType<Equal<typeof withRel.title, string>>();
  }

  const profile = await db.profile.findUniqueOrThrow({ where: { userId: 1 }, include: { user: { select: { email: true } } } });
  expectType<Equal<typeof profile.user, { email: string }>>();

  const counted = await db.user.findMany({ select: { id: true, _count: { select: { posts: true } } } });
  expectType<Equal<(typeof counted)[number]["_count"], { posts: number }>>();

  const u = await db.user.create({ data: { email: "a@b.c", role: Role.ADMIN, posts: { create: [{ title: "x" }] } } });
  expectType<Equal<typeof u.role, Role>>();
  expectType<Equal<typeof u.visits, bigint>>();
  expectType<Equal<typeof u.balance, string>>();

  await db.user.update({ where: { id: 1 }, data: { visits: { increment: 1 }, posts: { updateMany: { where: { published: false }, data: { published: true } } } } });
  await db.postTag.findUnique({ where: { postId_tagName: { postId: 1, tagName: "x" } } });

  const n = await db.user.count({ where: { active: true } });
  expectType<Equal<typeof n, number>>();

  const agg = await db.user.aggregate({ _count: true, _sum: { visits: true }, _avg: { balance: true }, _max: { createdAt: true } });
  expectType<Equal<typeof agg, { _count: number; _sum: { visits: bigint | null }; _avg: { balance: number | null }; _max: { createdAt: Date | null } }>>();

  const groups = await db.post.groupBy({ by: ["authorId"], _count: { _all: true } });
  expectType<Equal<(typeof groups)[number]["authorId"], number | null>>();

  const total = await db.$transaction(async (tx) => {
    await tx.tag.create({ data: { name: "ts" } });
    return tx.tag.count();
  });
  expectType<Equal<typeof total, number>>();

  const [tagCount, firstUser] = await db.$transaction([db.tag.count(), db.user.findFirst()], { timeout: 1000, maxWait: 500 });
  expectType<Equal<typeof tagCount, number>>();
  expectType<Equal<typeof firstUser, User | null>>();

  const ext = db.$extends({ model: { user: { byEmail(email: string) { return db.user.findUnique({ where: { email } }); } } } });
  const viaExt = await ext.user.byEmail("x");
  expectType<Equal<typeof viaExt, User | null>>();

  // @ts-expect-error unknown field in where
  await db.user.findMany({ where: { nope: 1 } });
  // @ts-expect-error email is required on create
  await db.user.create({ data: { name: "x" } });
  // @ts-expect-error findUnique needs a unique field
  await db.user.findUnique({ where: { name: "x" } });
}
void checks;
