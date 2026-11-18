// Compile-time checks for the SQL-like builder (issue #28). Checked by `npm run typecheck`, never executed.
import { HanaClient, tables, alias, count, eq, sql, sum, type Role } from "../generated/blog/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}
declare const db: HanaClient;
const { user, post } = tables;

async function builderChecks() {
  // selected columns keep their types; optional fields are nullable
  const a = await db.select({ id: user.id, name: user.name, role: user.role }).from(user);
  expectType<Equal<(typeof a)[number], { id: number; name: string | null; role: Role }>>();

  // inner join: both sides required
  const b = await db.select({ email: user.email, title: post.title }).from(user).innerJoin(post, eq(post.authorId, user.id));
  expectType<Equal<(typeof b)[number], { email: string; title: string }>>();

  // left join: columns of the joined table become nullable
  const c = await db.select({ email: user.email, title: post.title }).from(user).leftJoin(post, eq(post.authorId, user.id));
  expectType<Equal<(typeof c)[number], { email: string; title: string | null }>>();

  // right join: the earlier sources become nullable
  const d = await db.select({ email: user.email, title: post.title }).from(user).rightJoin(post, eq(post.authorId, user.id));
  expectType<Equal<(typeof d)[number], { email: string | null; title: string }>>();

  // select() without fields: one source → its row; joins → nested rows, outer ones nullable
  const e = await db.select().from(post);
  expectType<Equal<(typeof e)[number], { id: number; title: string; published: boolean; authorId: number | null }>>();
  const f = await db.select().from(user).leftJoin(post, eq(post.authorId, user.id));
  expectType<Equal<(typeof f)[number]["post"], { id: number; title: string; published: boolean; authorId: number | null } | null>>();
  expectType<Equal<(typeof f)[number]["user"]["visits"], bigint>>();

  // aggregates and sql expressions
  const g = await db.select({ n: count(), total: sum(user.balance), x: sql<number>`1` }).from(user);
  expectType<Equal<(typeof g)[number], { n: number; total: string | null; x: number }>>();

  // aliases and subqueries carry their own names
  const author = alias(user, "author");
  const h = await db.select({ title: post.title, by: author.email }).from(post).leftJoin(author, eq(author.id, post.authorId));
  expectType<Equal<(typeof h)[number], { title: string; by: string | null }>>();
  const sq = db.select({ authorId: post.authorId, n: count() }).from(post).groupBy(post.authorId).as("sq");
  const i = await db.select({ email: user.email, n: sq.n }).from(user).leftJoin(sq, eq(sq.authorId, user.id));
  expectType<Equal<(typeof i)[number], { email: string; n: number | null }>>();

  // writes resolve with the row count; insert takes the create-many row type
  const inserted = await db.insert(user).values({ email: "a@example.com" });
  expectType<Equal<typeof inserted, number>>();
  // @ts-expect-error email is required
  await db.insert(user).values({ name: "x" });
  await db.update(user).set({ name: null, visits: sql`${user.visits} + 1` }).where(eq(user.id, 1));
  // @ts-expect-error not a column
  await db.update(user).set({ nope: 1 });
  // @ts-expect-error a string column cannot be compared with a number
  eq(user.email, 1);
}
void builderChecks;
