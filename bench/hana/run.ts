// Benchmarks against a real SAP HANA (issue #39): hana-orm vs raw @sap/hana-client.
//
//   HANA_ORM_ENV_FILE=.env.test HANA_ORM_ALLOW_DDL=1 node bench/hana/run.ts [--out results.json] [--md results.md]
//
// Creates the schema HANA_ORM_BENCH (dropped again at the end), seeds it, then times:
//   - findUnique by primary key (the plan-cache hot path)
//   - findMany with include (two queries) vs the same two queries by hand
//   - createMany of 1000 rows vs one execBatch
// Each scenario reports the median and p95 per operation. Needs DDL rights.
import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { compileSchema } from "../../src/schema/build.ts";
import { createClientClass } from "../../src/runtime/client.ts";

if (process.env.HANA_ORM_ENV_FILE) process.loadEnvFile(process.env.HANA_ORM_ENV_FILE);
const { HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD, HANA_DATABASE } = process.env;
if (!HANA_HOST || !HANA_PORT || !HANA_USER || !HANA_PASSWORD) {
  console.error("Set HANA_HOST, HANA_PORT, HANA_USER and HANA_PASSWORD (or HANA_ORM_ENV_FILE)");
  process.exit(1);
}
if (process.env.HANA_ORM_ALLOW_DDL !== "1") {
  console.error("The benchmark creates and drops the schema HANA_ORM_BENCH; set HANA_ORM_ALLOW_DDL=1 for a test database");
  process.exit(1);
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SCHEMA = "HANA_ORM_BENCH";
const USERS = 1000;
const POSTS_PER_USER = 10;

const contract = compileSchema(`
datasource db {
  provider = "hana"
  schema   = "${SCHEMA}"
}
model User {
  id    Int    @id
  email String @db.NVarChar(200)
  name  String @db.NVarChar(200)
  posts Post[]
  @@map("USERS")
}
model Post {
  id       Int    @id
  title    String @db.NVarChar(200)
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
  @@index([authorId])
  @@map("POSTS")
}
model Event {
  id    Int    @id
  kind  String @db.NVarChar(40)
  value Int
  @@map("EVENTS")
}
`);

const connection = { host: HANA_HOST, port: Number(HANA_PORT), user: HANA_USER, password: HANA_PASSWORD, ...(HANA_DATABASE ? { databaseName: HANA_DATABASE } : {}) };
const Client = createClientClass(contract);
const db = new Client({ datasource: connection, poolSize: 1 }) as any;

// ---- raw @sap/hana-client ------------------------------------------------------------------
const require = createRequire(import.meta.url);
const hana = require("@sap/hana-client");
const conn = hana.createConnection();
const p = <T>(fn: (cb: (e: Error | null, r?: T) => void) => void) => new Promise<T>((ok, fail) => fn((e, r) => (e ? fail(e) : ok(r as T))));
await p((cb) => conn.connect({ serverNode: `${HANA_HOST}:${HANA_PORT}`, uid: HANA_USER, pwd: HANA_PASSWORD, ...(HANA_DATABASE ? { databaseName: HANA_DATABASE } : {}) }, cb));
const rawExec = <T = unknown>(sql: string, params: unknown[] = []) => p<T>((cb) => conn.exec(sql, params, cb));
const rawPrepare = (sql: string) => p<any>((cb) => conn.prepare(sql, cb));

// ---- setup -----------------------------------------------------------------------------------
async function setup(): Promise<void> {
  await rawExec(`DROP SCHEMA "${SCHEMA}" CASCADE`).catch(() => {});
  await rawExec(`CREATE SCHEMA "${SCHEMA}"`);
  await rawExec(`CREATE COLUMN TABLE "${SCHEMA}"."USERS" ("id" INTEGER PRIMARY KEY, "email" NVARCHAR(200) NOT NULL, "name" NVARCHAR(200) NOT NULL)`);
  await rawExec(`CREATE COLUMN TABLE "${SCHEMA}"."POSTS" ("id" INTEGER PRIMARY KEY, "title" NVARCHAR(200) NOT NULL, "authorId" INTEGER NOT NULL)`);
  await rawExec(`CREATE INDEX "${SCHEMA}"."IX_POSTS_authorId" ON "${SCHEMA}"."POSTS" ("authorId")`);
  await rawExec(`CREATE COLUMN TABLE "${SCHEMA}"."EVENTS" ("id" INTEGER PRIMARY KEY, "kind" NVARCHAR(40) NOT NULL, "value" INTEGER NOT NULL)`);
  const users = Array.from({ length: USERS }, (_, i) => [i + 1, `user${i + 1}@example.com`, `User ${i + 1}`]);
  const posts = Array.from({ length: USERS * POSTS_PER_USER }, (_, i) => [i + 1, `Post ${i + 1}`, (i % USERS) + 1]);
  const s1 = await rawPrepare(`INSERT INTO "${SCHEMA}"."USERS" VALUES (?, ?, ?)`);
  await p((cb) => s1.execBatch(users, cb));
  const s2 = await rawPrepare(`INSERT INTO "${SCHEMA}"."POSTS" VALUES (?, ?, ?)`);
  await p((cb) => s2.execBatch(posts, cb));
  await rawExec("COMMIT").catch(() => {});
}

// ---- timing ------------------------------------------------------------------------------------
interface Stats {
  median: number;
  p95: number;
  ops: number;
}
async function time(iterations: number, fn: (i: number) => Promise<unknown>): Promise<Stats> {
  for (let i = 0; i < Math.min(20, iterations); i++) await fn(i); // warm up
  const ms: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    await fn(i);
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)]!;
  return { median, p95: ms[Math.floor(ms.length * 0.95)]!, ops: 1000 / median };
}

interface Result {
  name: string;
  orm: Stats;
  raw: Stats;
  /** orm median / raw median. */
  ratio: number;
}
const results: Result[] = [];
async function scenario(name: string, iterations: number, orm: (i: number) => Promise<unknown>, raw: (i: number) => Promise<unknown>): Promise<void> {
  const r = await time(iterations, raw);
  const o = await time(iterations, orm);
  results.push({ name, orm: o, raw: r, ratio: o.median / r.median });
  console.log(`${name}: orm ${o.median.toFixed(3)} ms, raw ${r.median.toFixed(3)} ms (×${(o.median / r.median).toFixed(2)})`);
}

// ---- scenarios ----------------------------------------------------------------------------------
try {
  await setup();
  const version = ((await rawExec<{ VERSION: string }[]>("SELECT VERSION FROM SYS.M_DATABASE"))[0]?.VERSION) ?? "unknown";

  const byId = await rawPrepare(`SELECT "id", "email", "name" FROM "${SCHEMA}"."USERS" WHERE "id" = ?`);
  await scenario(
    "findUnique by id",
    500,
    (i) => db.user.findUnique({ where: { id: (i % USERS) + 1 } }),
    (i) => p((cb) => byId.exec([(i % USERS) + 1], cb)),
  );

  const page = await rawPrepare(`SELECT "id", "email", "name" FROM "${SCHEMA}"."USERS" ORDER BY "id" LIMIT 50 OFFSET ?`);
  await scenario(
    "findMany 50 users with include posts (500 rows)",
    100,
    (i) => db.user.findMany({ orderBy: { id: "asc" }, take: 50, skip: (i * 50) % USERS, include: { posts: true } }),
    async (i) => {
      const users = await p<any[]>((cb) => page.exec([(i * 50) % USERS], cb));
      const ids = users.map((u) => u.id);
      const posts = await rawExec<any[]>(`SELECT "id", "title", "authorId" FROM "${SCHEMA}"."POSTS" WHERE "authorId" IN (${ids.map(() => "?").join(", ")})`, ids);
      const byAuthor = new Map<number, any[]>();
      for (const post of posts) (byAuthor.get(post.authorId) ?? byAuthor.set(post.authorId, []).get(post.authorId)!).push(post);
      return users.map((u) => ({ ...u, posts: byAuthor.get(u.id) ?? [] }));
    },
  );

  let next = 1;
  const insertEvent = await rawPrepare(`INSERT INTO "${SCHEMA}"."EVENTS" VALUES (?, ?, ?)`);
  const rows = (start: number) => Array.from({ length: 1000 }, (_, k) => ({ id: start + k, kind: "click", value: k }));
  await scenario(
    "createMany 1000 rows",
    20,
    async () => {
      const start = next;
      next += 1000;
      await db.event.createMany({ data: rows(start) });
    },
    async () => {
      const start = next;
      next += 1000;
      await p((cb) => insertEvent.execBatch(rows(start).map((r) => [r.id, r.kind, r.value]), cb));
    },
  );

  const engine = db._engine?.();
  const plan = typeof engine?.planCacheStats === "function" ? engine.planCacheStats() : null;
  const hitRate = plan && plan.hits + plan.misses ? plan.hits / (plan.hits + plan.misses) : null;
  if (plan) console.log(`plan cache: ${plan.hits} hits, ${plan.misses} misses, ${plan.uncacheable} uncacheable`);

  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  const report = {
    date: new Date().toISOString(),
    version: pkg.version,
    commit: process.env.GITHUB_SHA ?? null,
    node: process.version,
    hana: version,
    planCache: plan ? { ...plan, hitRate } : null,
    results,
  };
  const out = arg("--out");
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    `### hana-orm ${pkg.version} — ${report.date.slice(0, 10)} (HANA ${version}, Node ${process.version})`,
    "",
    "| scenario | hana-orm median | raw median | ratio | hana-orm p95 | raw p95 |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.orm.median.toFixed(3)} ms | ${r.raw.median.toFixed(3)} ms | ×${r.ratio.toFixed(2)} | ${r.orm.p95.toFixed(3)} ms | ${r.raw.p95.toFixed(3)} ms |`),
    "",
    hitRate === null ? "" : `Plan cache hit rate: ${(hitRate * 100).toFixed(1)}%`,
  ].join("\n");
  const mdOut = arg("--md");
  if (mdOut) writeFileSync(mdOut, `${md}\n`);
  console.log(`\n${md}`);
} finally {
  await rawExec(`DROP SCHEMA "${SCHEMA}" CASCADE`).catch(() => {});
  await p((cb) => conn.disconnect(cb)).catch(() => {});
  await db.$disconnect();
}
