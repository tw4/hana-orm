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
