// Compile-time checks for query options (omit, having, distinct, relation orderBy, ...).
// Checked by `npm run typecheck`, never executed.
import { HanaClient, type User } from "../generated/blog/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}
declare const db: HanaClient;

async function omitChecks() {
  const users = await db.user.findMany({ omit: { balance: true, visits: true } });
  expectType<Equal<(typeof users)[number], Omit<User, "balance" | "visits">>>();

  const one = await db.user.findUnique({ where: { id: 1 }, omit: { email: true }, include: { posts: { omit: { published: true } } } });
  if (one) {
    expectType<Equal<keyof typeof one, Exclude<keyof User, "email"> | "posts">>();
    expectType<Equal<(typeof one.posts)[number], { id: number; title: string; authorId: number | null }>>();
  }

  const nothingOmitted = await db.user.findFirstOrThrow({ omit: { email: false } });
  expectType<Equal<typeof nothingOmitted, User>>();

  const created = await db.user.create({ data: { email: "a@b.c" }, omit: { balance: true } });
  expectType<Equal<"balance" extends keyof typeof created ? true : false, false>>();

  // Client-wide omit removes fields everywhere, also inside include and transactions.
  const safe = new HanaClient({ omit: { user: { email: true }, post: { published: true } } });
  const u = await safe.user.findFirstOrThrow();
  expectType<Equal<"email" extends keyof typeof u ? true : false, false>>();
  const withEmail = await safe.user.findFirstOrThrow({ omit: { email: false } });
  expectType<Equal<typeof withEmail.email, string>>();
  const p = await safe.post.findFirstOrThrow({ include: { author: true } });
  expectType<Equal<"published" extends keyof typeof p ? true : false, false>>();
  if (p.author) expectType<Equal<"email" extends keyof typeof p.author ? true : false, false>>();
  const selected = await safe.user.findFirstOrThrow({ select: { email: true } });
  expectType<Equal<typeof selected, { email: string }>>();
  await safe.$transaction(async (tx) => {
    const t = await tx.user.findFirstOrThrow();
    expectType<Equal<"email" extends keyof typeof t ? true : false, false>>();
  });

  // @ts-expect-error relations cannot be omitted
  await db.user.findMany({ omit: { posts: true } });
  // @ts-expect-error unknown field in client-wide omit
  new HanaClient({ omit: { user: { nope: true } } });
}
void omitChecks;

async function havingChecks() {
  const groups = await db.user.groupBy({
    by: ["role"],
    _count: { _all: true },
    having: { role: "ADMIN", _count: { _all: { gt: 1 } }, _sum: { visits: { gte: 10n } }, _avg: { balance: { lt: 2 } }, _max: { createdAt: { gt: new Date() } } },
  });
  expectType<Equal<(typeof groups)[number], { role: User["role"]; _count: { _all: number } }>>();
  await db.post.groupBy({ by: ["authorId"], having: { OR: [{ _count: { id: 2 } }, { NOT: { _min: { title: "a" } } }] } });

  // @ts-expect-error _sum only takes numeric fields
  await db.user.groupBy({ by: ["role"], having: { _sum: { email: { gt: "a" } } } });
  // @ts-expect-error counts compare with numbers
  await db.user.groupBy({ by: ["role"], having: { _count: { _all: { gt: "1" } } } });
}
void havingChecks;

async function distinctChecks() {
  const roles = await db.user.findMany({ distinct: ["role"], select: { role: true } });
  expectType<Equal<typeof roles, { role: User["role"] }[]>>();
  await db.post.findFirst({ distinct: "authorId", include: { tags: { distinct: ["tagName"] } } });

  // @ts-expect-error distinct takes scalar field names
  await db.user.findMany({ distinct: ["posts"] });
}
void distinctChecks;

async function relationOrderChecks() {
  await db.post.findMany({ orderBy: [{ author: { name: { sort: "asc", nulls: "last" } } }, { tags: { _count: "desc" } }] });
  await db.user.findMany({ orderBy: { profile: { bio: "asc" } }, cursor: { id: 1 }, take: 10 });
  await db.postTag.findMany({ orderBy: { post: { author: { email: "desc" } } } });
  await db.user.groupBy({ by: ["role"], orderBy: [{ _count: { _all: "desc" } }, { _avg: { balance: "asc" } }, { role: "asc" }] });

  // @ts-expect-error list relations are ordered by _count only
  await db.user.findMany({ orderBy: { posts: { title: "asc" } } });
  // @ts-expect-error _sum ordering takes numeric fields
  await db.user.groupBy({ by: ["role"], orderBy: { _sum: { email: "asc" } } });
}
void relationOrderChecks;

async function nestedCursorChecks() {
  const users = await db.user.findMany({ select: { id: true, posts: { cursor: { id: 10 }, take: 5, skip: 1, select: { title: true } } } });
  expectType<Equal<typeof users, { id: number; posts: { title: string }[] }[]>>();

  // @ts-expect-error the cursor must be a unique where input
  await db.user.findMany({ include: { posts: { cursor: { title: "x" } } } });
}
void nestedCursorChecks;
