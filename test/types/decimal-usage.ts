// Compile-time checks for decimal = "number" (issue #16). Checked by `npm run typecheck`, never executed.
import { HanaClient, type Member } from "../generated/decimal-number/index.ts";
import type { Member as StringMember } from "../generated/constraints/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}
declare const db: HanaClient;

async function decimalChecks() {
  expectType<Equal<Member["credit"], number>>();
  expectType<Equal<StringMember["credit"], string>>();
  await db.member.findMany({ where: { credit: { gte: 10 } } });
  await db.member.update({ where: { id: 1 }, data: { credit: "10.25" } });
  // @ts-expect-error a boolean is not a decimal
  await db.member.findMany({ where: { credit: true } });
}
void decimalChecks;
