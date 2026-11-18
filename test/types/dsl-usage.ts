// Compile-time checks for TypeScript schemas (issue #29). Checked by `npm run typecheck`, never executed.
import type { blogSchema } from "../schema/dsl.test.ts";
import { tablesOf, createClient } from "../../src/schema/dsl.ts";
import { eq } from "../../src/runtime/builder/ops.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}
type Blog = ReturnType<typeof blogSchema>;
declare const blog: Blog;

async function dslChecks() {
  type UserRow = typeof blog.User.$inferSelect;
  expectType<
    Equal<UserRow, { id: number; email: string; name: string | null; role: "USER" | "ADMIN"; balance: string; visits: bigint; active: boolean; createdAt: Date; updatedAt: Date }>
  >();
  type UserInsert = typeof blog.User.$inferInsert;
  // only email is required: everything else is optional or has a default
  expectType<Equal<keyof UserInsert, "id" | "email" | "name" | "role" | "balance" | "visits" | "active" | "createdAt" | "updatedAt">>();
  const ok: UserInsert = { email: "a@example.com" };
  void ok;
  // @ts-expect-error email is required
  const missing: UserInsert = { name: "x" };
  void missing;
  type PostInsert = typeof blog.Post.$inferInsert;
  expectType<Equal<PostInsert, { title: string; id?: number; published?: boolean; authorId?: number | null }>>();

  const t = tablesOf(blog.schema);
  const db = createClient(blog.schema);
  const rows = await db.select({ email: t.user.email, title: t.post.title }).from(t.user).leftJoin(t.post, eq(t.post.authorId, t.user.id));
  expectType<Equal<(typeof rows)[number], { email: string; title: string | null }>>();
  // @ts-expect-error role takes the enum's values only
  eq(t.user.role, "OWNER");
}
void dslChecks;
