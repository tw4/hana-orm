// Compile-time checks for result extensions (issue #7). Checked by `npm run typecheck`, never executed.
import { HanaClient } from "../generated/blog/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}
declare const base: HanaClient;

async function computedChecks() {
  const db = base.$extends({
    result: {
      user: {
        label: { needs: { name: true }, compute: (u) => `${u.name ?? ""} (${u.id})` },
        score: { needs: { visits: true }, compute: (u) => Number(u.visits) * 2 },
      },
    },
  });
  const all = await db.user.findFirstOrThrow();
  expectType<Equal<typeof all.label, string>>();
  expectType<Equal<typeof all.score, number>>();

  const picked = await db.user.findMany({ select: { id: true, label: true } });
  expectType<Equal<(typeof picked)[number], { id: number; label: string }>>();

  const omitted = await db.user.findUniqueOrThrow({ where: { id: 1 }, omit: { score: true } });
  expectType<Equal<"score" extends keyof typeof omitted ? true : false, false>>();
  expectType<Equal<typeof omitted.label, string>>();

  const created = await db.user.create({ data: { email: "a@example.com" }, select: { score: true } });
  expectType<Equal<typeof created, { score: number }>>();

  // chained extensions keep earlier computed fields
  const more = db.$extends({ result: { user: { flag: { needs: { active: true }, compute: (u) => u.active } } } });
  const m = await more.user.findFirstOrThrow({ select: { label: true, flag: true } });
  expectType<Equal<typeof m, { label: string; flag: boolean }>>();

  // the base client has no computed fields
  const plain = await base.user.findFirstOrThrow();
  expectType<Equal<"label" extends keyof typeof plain ? true : false, false>>();

  // @ts-expect-error needs only takes fields of the model
  base.$extends({ result: { user: { bad: { needs: { nope: true }, compute: () => 1 } } } });
}
void computedChecks;
