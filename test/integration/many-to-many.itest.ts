// Implicit many-to-many relations end to end: migrate plan/deploy creates the join tables,
// the generated client reads and writes through them, and db pull turns them back into
// list fields.
//
// Runs DDL, so it only runs when HANA_ORM_ALLOW_DDL=1 (set it for a local/test database only,
// e.g. the docker-compose.hana.yml instance). It creates a fresh schema per run and drops it
// (CASCADE) at the end.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "../../src/cli/index.ts";
import { HanaDriver } from "../../src/runtime/hana-driver.ts";
import { resolveConnectionConfig } from "../../src/runtime/config.ts";
import { NotFoundError } from "../../src/runtime/errors.ts";
import { compileSchema } from "../../src/schema/build.ts";
import { contractToPhysical } from "../../src/migrate/contract-to-physical.ts";

if (process.env.HANA_ORM_ENV_FILE) process.loadEnvFile(process.env.HANA_ORM_ENV_FILE);
const enabled = process.env.HANA_ORM_ALLOW_DDL === "1" && Boolean(process.env.HANA_HOST);
const skip = enabled ? false : "set HANA_ORM_ALLOW_DDL=1 with a local/test HANA to run";

const schemaName = `HANA_ORM_IT_${Date.now().toString(36).toUpperCase()}_M2M`;
const dir = mkdtempSync(join(tmpdir(), "hana-orm-m2m-"));
const schemaFile = join(dir, "schema.hana");
const runtimeUrl = pathToFileURL(join(import.meta.dirname, "../../src/runtime/index.ts")).href;
let admin: HanaDriver;
const cwd = process.cwd();

const header = `datasource db {
  provider = "hana"
  schema   = env("HANA_ORM_IT_SCHEMA")
}

generator client {
  provider      = "hana-orm"
  output        = "./gen"
  runtimeImport = "${runtimeUrl}"
}
`;

const schema = `${header}
model Post {
  id    Int    @id @default(autoincrement())
  title String @db.NVarChar(100)
  tags  Tag[]

  @@map("POSTS")
}

model Tag {
  name  String @id @db.NVarChar(40)
  posts Post[]

  @@map("TAGS")
}

model Person {
  id        Int      @id @default(autoincrement())
  name      String   @db.NVarChar(40)
  followers Person[] @relation("Follows")
  following Person[] @relation("Follows")

  @@map("PEOPLE")
}
`;

async function cli(...args: string[]): Promise<number> {
  process.chdir(dir);
  try {
    return await main([...args, "--schema", schemaFile]);
  } finally {
    process.chdir(cwd);
  }
}

before(async () => {
  if (!enabled) return;
  process.env.HANA_ORM_IT_SCHEMA = schemaName;
  admin = new HanaDriver(resolveConnectionConfig(undefined, { currentSchema: undefined }), { poolSize: 1 });
  await admin.execute(`CREATE SCHEMA "${schemaName}"`);
});

after(async () => {
  if (!enabled) return;
  await admin.execute(`DROP SCHEMA "${schemaName}" CASCADE`).catch(() => {});
  await admin.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrate plan + deploy creates the join tables", { skip }, async () => {
  writeFileSync(schemaFile, schema);
  assert.equal(await cli("migrate", "plan", "--name", "init"), 0);
  const [migration] = readdirSync(join(dir, "migrations"));
  const sql = readFileSync(join(dir, "migrations", migration!, "migration.sql"), "utf8");
  assert.match(sql, /CREATE COLUMN TABLE "_PostToTag"/);
  assert.match(sql, /CREATE COLUMN TABLE "_Follows"/);
  assert.match(sql, /FOREIGN KEY \("A"\) REFERENCES "POSTS" \("id"\) ON UPDATE CASCADE ON DELETE CASCADE/);
  assert.equal(await cli("migrate", "deploy"), 0);
  assert.equal(await cli("migrate", "status"), 0, "no drift: the live join tables match the contract");
  const cols = await admin.query<{ C: string; T: string }>(
    `SELECT COLUMN_NAME AS "C", DATA_TYPE_NAME AS "T" FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = '_PostToTag' ORDER BY POSITION`,
    [schemaName],
  );
  assert.deepEqual(cols, [
    { C: "A", T: "INTEGER" },
    { C: "B", T: "NVARCHAR" },
  ]);
});

test("the client reads and writes through the join tables", { skip }, async () => {
  assert.equal(await cli("generate"), 0);
  const { HanaClient } = await import(pathToFileURL(join(dir, "gen", "index.ts")).href);
  const db = new HanaClient({ poolSize: 2 });
  try {
    const p1 = await db.post.create({
      data: { title: "one", tags: { create: [{ name: "hana" }, { name: "sql" }], connectOrCreate: { where: { name: "orm" }, create: { name: "orm" } } } },
      include: { tags: { orderBy: { name: "asc" } } },
    });
    assert.deepEqual(p1.tags.map((t: { name: string }) => t.name), ["hana", "orm", "sql"]);
    const p2 = await db.post.create({ data: { title: "two", tags: { connect: [{ name: "hana" }] } } });
    // connecting twice is a no-op
    await db.post.update({ where: { id: p2.id }, data: { tags: { connect: [{ name: "hana" }, { name: "sql" }] } } });
    await db.post.create({ data: { title: "three" } });

    // the other side
    const hana = await db.tag.findUniqueOrThrow({ where: { name: "hana" }, include: { posts: { orderBy: { title: "asc" }, select: { title: true } } } });
    assert.deepEqual(hana.posts, [{ title: "one" }, { title: "two" }]);

    // include with per-parent paging; rows shared by several parents
    const paged = await db.post.findMany({ orderBy: { title: "asc" }, include: { tags: { orderBy: { name: "desc" }, take: 1 } } });
    assert.deepEqual(paged.map((p: { title: string; tags: { name: string }[] }) => [p.title, p.tags.map((t) => t.name)]), [
      ["one", ["sql"]],
      ["three", []],
      ["two", ["sql"]],
    ]);

    // filters, _count and ordering by _count
    const withOrm = await db.post.findMany({ where: { tags: { some: { name: "orm" } } }, select: { title: true } });
    assert.deepEqual(withOrm, [{ title: "one" }]);
    const untagged = await db.post.findMany({ where: { tags: { none: {} } }, select: { title: true } });
    assert.deepEqual(untagged, [{ title: "three" }]);
    const onlyCore = await db.post.findMany({ where: { tags: { every: { name: { in: ["hana", "sql"] } } } }, orderBy: { title: "asc" }, select: { title: true } });
    assert.deepEqual(onlyCore, [{ title: "three" }, { title: "two" }]);
    const counted = await db.post.findMany({ orderBy: [{ tags: { _count: "desc" } }, { title: "asc" }], select: { title: true, _count: { select: { tags: true } } } });
    assert.deepEqual(counted, [
      { title: "one", _count: { tags: 3 } },
      { title: "two", _count: { tags: 2 } },
      { title: "three", _count: { tags: 0 } },
    ]);
    assert.equal(await db.tag.count({ where: { posts: { some: { title: "two" } } } }), 2);

    // nested update, updateMany, upsert, disconnect, set
    await db.post.update({
      where: { id: p1.id },
      data: { tags: { update: { where: { name: "orm" }, data: { name: "orm2" } }, disconnect: { name: "hana" }, upsert: { where: { name: "new" }, create: { name: "new" }, update: {} } } },
    });
    const after1 = await db.post.findUniqueOrThrow({ where: { id: p1.id }, include: { tags: { orderBy: { name: "asc" } } } });
    assert.deepEqual(after1.tags.map((t: { name: string }) => t.name), ["new", "orm2", "sql"]);
    await assert.rejects(db.post.update({ where: { id: p2.id }, data: { tags: { update: { where: { name: "orm2" }, data: { name: "x" } } } } }), NotFoundError, "only linked rows can be updated");
    await db.post.update({ where: { id: p2.id }, data: { tags: { set: [{ name: "new" }] } } });
    const after2 = await db.post.findUniqueOrThrow({ where: { id: p2.id }, include: { tags: true } });
    assert.deepEqual(after2.tags.map((t: { name: string }) => t.name), ["new"]);

    // delete / deleteMany remove the related rows and their links
    await db.post.update({ where: { id: p1.id }, data: { tags: { deleteMany: { name: { startsWith: "orm" } } } } });
    assert.equal(await db.tag.findUnique({ where: { name: "orm2" } }), null);
    await db.post.update({ where: { id: p1.id }, data: { tags: { delete: { name: "new" } } } });
    assert.equal(await db.tag.findUnique({ where: { name: "new" } }), null);
    const p2Tags = await db.post.findUniqueOrThrow({ where: { id: p2.id }, include: { tags: true } });
    assert.deepEqual(p2Tags.tags, [], "links of the deleted tag are gone for the other post too");

    // deleting a parent removes its links (ON DELETE CASCADE)
    await db.post.delete({ where: { id: p1.id } });
    const sqlTag = await db.tag.findUniqueOrThrow({ where: { name: "sql" }, include: { posts: true } });
    assert.deepEqual(sqlTag.posts, []);

    // self relation
    const ada = await db.person.create({ data: { name: "ada" } });
    const bob = await db.person.create({ data: { name: "bob", following: { connect: { id: ada.id } } } });
    const adaFollowers = await db.person.findUniqueOrThrow({ where: { id: ada.id }, include: { followers: true, following: true } });
    assert.deepEqual(adaFollowers.followers.map((p: { name: string }) => p.name), ["bob"]);
    assert.deepEqual(adaFollowers.following, []);
    const bobView = await db.person.findUniqueOrThrow({ where: { id: bob.id }, include: { following: true } });
    assert.deepEqual(bobView.following.map((p: { name: string }) => p.name), ["ada"]);
  } finally {
    await db.$disconnect();
  }
});

test("db pull turns the join tables back into many-to-many fields", { skip }, async () => {
  const pulledFile = join(dir, "pulled.hana");
  writeFileSync(pulledFile, header);
  process.chdir(dir);
  try {
    assert.equal(await main(["db", "pull", "--schema", pulledFile]), 0);
  } finally {
    process.chdir(cwd);
  }
  const pulled = readFileSync(pulledFile, "utf8");
  assert.doesNotMatch(pulled, /model _/, "join tables are not models");
  assert.match(pulled, /tags +Tags\[\] +@relation\("PostToTag"\)/);
  assert.match(pulled, /posts +Posts\[\] +@relation\("PostToTag"\)/);
  assert.match(pulled, /followsA +People\[\] +@relation\("Follows"\)/);
  // the pulled schema describes the same join tables
  const tables = (source: string) => contractToPhysical(compileSchema(source, { file: "x.hana" })).tables;
  const original = tables(schema);
  const again = tables(pulled);
  assert.deepEqual(again["_PostToTag"], original["_PostToTag"]);
  assert.deepEqual(again["_Follows"], original["_Follows"]);
});
