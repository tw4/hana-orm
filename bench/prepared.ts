// Client time per query: building the SQL every call vs a prepared query (issue #30).
// Run: node test/setup.ts && node bench/prepared.ts [iterations]
// The driver answers instantly, so the numbers are the client's own work.
import { HanaClient, tables, eq, and, gt } from "../test/generated/blog/index.ts";
import { placeholder } from "../src/runtime/placeholder.ts";
import type { Driver } from "../src/runtime/driver.ts";

const driver: Driver = { query: async () => [], execute: async () => 0, executeBatch: async () => 0, transaction: async (fn) => fn(driver), close: async () => {} };
const db = new HanaClient({ driver });
const { user } = tables;
const N = Number(process.argv[2] ?? 100_000);

async function time(run: (i: number) => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 2000; i++) await run(i);
  const start = performance.now();
  for (let i = 0; i < N; i++) await run(i);
  return ((performance.now() - start) * 1000) / N;
}

const builderEach = (i: number) => db.select({ id: user.id, email: user.email }).from(user).where(and(eq(user.active, true), gt(user.visits, BigInt(i)))).limit(20).execute();
const builderPrepared = db.select({ id: user.id, email: user.email }).from(user).where(and(eq(user.active, true), gt(user.visits, placeholder("v")))).limit(20).prepare();
const objectEach = (i: number) => db.user.findMany({ where: { active: true, visits: { gt: BigInt(i) } }, orderBy: { id: "asc" }, take: 20 });
const objectPrepared = db.user.findMany({ where: { active: true, visits: { gt: placeholder("v") } }, orderBy: { id: "asc" }, take: 20 }).prepare();

const rows: [string, number, number][] = [
  ["builder select (join-free, 2 conditions)", await time(builderEach), await time((i) => builderPrepared.execute({ v: BigInt(i) }))],
  ["object findMany (filter + order + take)", await time(objectEach), await time((i) => objectPrepared.execute({ v: BigInt(i) }))],
];
console.log(`${N} queries each; µs per query (lower is better)\n`);
console.log(`${"query".padEnd(42)} ${"each call".padStart(10)} ${"prepared".padStart(9)} ${"saved".padStart(7)}`);
for (const [name, each, prep] of rows) console.log(`${name.padEnd(42)} ${each.toFixed(2).padStart(10)} ${prep.toFixed(2).padStart(9)} ${`${Math.round((1 - prep / each) * 100)}%`.padStart(7)}`);
