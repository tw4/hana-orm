import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSchema, needsFormatting } from "../../src/schema/format.ts";
import { compileSchema } from "../../src/schema/build.ts";
import { SchemaError } from "../../src/schema/errors.ts";
import { cmdFormat } from "../../src/cli/index.ts";
import type { CliContext } from "../../src/cli/context.ts";
import { buildPhysicalFromCatalog } from "../../src/introspect/catalog.ts";
import { renderSchema } from "../../src/introspect/render.ts";
import { shopCatalog } from "../introspect/catalog-fixture.ts";

test("db pull output is already formatted", () => {
  const src = renderSchema(buildPhysicalFromCatalog(shopCatalog(), { schema: "SHOP", defaultSchema: "SHOP" }), { defaultSchema: "SHOP" }).source;
  assert.equal(formatSchema(src), src);
});

const blog = readFileSync(new URL("../fixtures/blog.hana", import.meta.url), "utf8");

const messy = `// header comment
datasource db {
provider="hana"
    schema = "APP"   // default schema
  host=env( "HANA_HOST" )
}
generator client {
  provider = "hana-orm"
  output = "./generated"
}



enum Status {
  OPEN
  CLOSED @map( "closed" )
}
/// A synthetic order
model Order {

  id Int @default(autoincrement()) @id
  /// shown on the invoice
  code String @map("CODE") @unique @db.NVarChar(40)
  status Status @default(OPEN)
  total Decimal @db.Decimal(15,2) @default("0")
  customerId Int
  customer Customer @relation(fields:[customerId],references:[id],onDelete:Cascade) // owner side
  @@map("ORDERS")
  @@index([customerId])
  @@index([status,
          total])
}
model Customer { id Int @id
  orders Order[]
}
`;

test("formats a messy schema into the canonical layout", () => {
  const out = formatSchema(messy);
  assert.equal(
    out,
    `// header comment
datasource db {
  provider = "hana"
  schema   = "APP" // default schema
  host     = env("HANA_HOST")
}

generator client {
  provider = "hana-orm"
  output   = "./generated"
}

enum Status {
  OPEN
  CLOSED @map("closed")
}

/// A synthetic order
model Order {
  id         Int      @id @default(autoincrement())
  /// shown on the invoice
  code       String   @unique @map("CODE") @db.NVarChar(40)
  status     Status   @default(OPEN)
  total      Decimal  @default("0") @db.Decimal(15, 2)
  customerId Int
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Cascade) // owner side

  @@index([customerId])
  @@index([status, total])
  @@map("ORDERS")
}

model Customer {
  id     Int     @id
  orders Order[]
}
`,
  );
});

test("formatting is idempotent and keeps the contract", () => {
  for (const src of [messy, blog]) {
    const once = formatSchema(src);
    assert.equal(formatSchema(once), once);
    assert.equal(needsFormatting(once), false);
    assert.equal(compileSchema(once).hash, compileSchema(src).hash);
  }
});

test("only layout changes: the blog fixture keeps every line apart from column widths", () => {
  const out = formatSchema(blog);
  const squash = (s: string) => s.replace(/ +/g, " ");
  assert.equal(squash(out), squash(blog));
});

test("strings, Unsupported types and comments survive formatting", () => {
  const src = `model Shape {\n  id Int @id\n  geom   Unsupported("ST_GEOMETRY ( 4326 )")?\n  // a comment, with @ and \"quotes\"\n  label String @default("a , b : c")   // trailing\n}\n`;
  const out = formatSchema(src);
  assert.match(out, /geom  Unsupported\("ST_GEOMETRY \( 4326 \)"\)\?/);
  assert.match(out, /\n  \/\/ a comment, with @ and "quotes"\n/);
  assert.match(out, /@default\("a , b : c"\) \/\/ trailing/);
  assert.equal(formatSchema(out), out);
});

test("refuses to format a schema with syntax errors", () => {
  assert.throws(() => formatSchema("model A {\n  id Int @id\n", "bad.hana"), (e: unknown) => e instanceof SchemaError && /bad\.hana:/.test(e.message));
});

function ctxFor(dir: string, schemaPath: string): CliContext & { logs: string[]; warns: string[] } {
  const ctx = {
    cwd: dir,
    schemaPath,
    migrationsDir: join(dir, "migrations"),
    logs: [] as string[],
    warns: [] as string[],
    loadContract: async () => assert.fail("not used"),
    connect: async () => assert.fail("not used"),
    defaultSchema: async () => undefined,
    log: (m: string) => void ctx.logs.push(m),
    warn: (m: string) => void ctx.warns.push(m),
    confirm: async () => false,
  };
  return ctx;
}

test("format command: --check reports, plain run rewrites every file of a schema folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hana-orm-fmt-"));
  try {
    await writeFile(join(dir, "a.hana"), "model A {\nid Int @id\n}\n");
    await writeFile(join(dir, "b.hana"), "model B {\n  id Int @id\n}\n");
    const ctx = ctxFor(dir, dir);
    assert.equal(cmdFormat(ctx, { positional: [], flags: { check: true } }), 1);
    assert.deepEqual(ctx.warns, ["a.hana is not formatted"]);
    assert.equal(await readFile(join(dir, "a.hana"), "utf8"), "model A {\nid Int @id\n}\n");
    assert.equal(cmdFormat(ctx, { positional: [], flags: {} }), 0);
    assert.equal(await readFile(join(dir, "a.hana"), "utf8"), "model A {\n  id Int @id\n}\n");
    assert.equal(cmdFormat(ctx, { positional: [], flags: { check: true } }), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
