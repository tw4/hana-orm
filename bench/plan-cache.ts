// CPU cost per query with and without the plan cache (issue #14).
// Run: node test/setup.ts && node bench/plan-cache.ts
// The driver answers instantly, so the numbers are the client's own work: building SQL and
// parameters, decoding (no rows here) and promise plumbing.
import { HanaClient } from "../test/generated/blog/index.ts";
import type { Driver } from "../src/runtime/driver.ts";

const driver: Driver = {
  query: async () => [],
  execute: async () => 0,
  executeBatch: async () => 0,
  transaction: async (fn) => fn(driver),
  close: async () => {},
};

const SHAPES: [string, (db: HanaClient, i: number) => Promise<unknown>][] = [
  ["findUnique({ where: { id } })", (db, i) => db.user.findUnique({ where: { id: i } })],
  ["findMany(where + orderBy + take)", (db, i) => db.user.findMany({ where: { active: true, role: "USER", visits: BigInt(i) }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 20 })],
  ["findFirst({ where: { email } , select })", (db, i) => db.user.findFirst({ where: { email: `u${i}@example.com` }, select: { id: true, name: true } })],
];

async function measure(planCacheSize: number, run: (db: HanaClient, i: number) => Promise<unknown>, n: number): Promise<number> {
  const db = new HanaClient({ driver, planCacheSize });
  for (let i = 0; i < 2000; i++) await run(db, i); // warm up the JIT (and the cache)
  const start = performance.now();
  for (let i = 0; i < n; i++) await run(db, i);
  const used = (performance.now() - start) * 1000;
  return used / n; // µs per query (the driver is instant, so this is client CPU)
}

const N = Number(process.argv[2] ?? 50_000);
console.log(`${N} queries per shape; µs per query (lower is better)\n`);
console.log(`${"shape".padEnd(44)} ${"no cache".padStart(9)} ${"cache".padStart(9)} ${"saved".padStart(7)}`);
for (const [name, run] of SHAPES) {
  const off = await measure(0, run, N);
  const on = await measure(500, run, N);
  console.log(`${name.padEnd(44)} ${off.toFixed(2).padStart(9)} ${on.toFixed(2).padStart(9)} ${`${Math.round((1 - on / off) * 100)}%`.padStart(7)}`);
}
