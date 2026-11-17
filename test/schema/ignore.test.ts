import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSchema } from "../../src/schema/build.ts";
import { clientContract } from "../../src/schema/contract.ts";
import { SchemaError } from "../../src/schema/errors.ts";
import { formatSchema } from "../../src/schema/format.ts";
import { generateClient } from "../../src/generator/client.ts";
import { createClientClass } from "../../src/runtime/client.ts";
import { contractToPhysical } from "../../src/migrate/contract-to-physical.ts";
import { diffSchemas } from "../../src/migrate/diff.ts";
import { renderSchema } from "../../src/introspect/render.ts";
import { FakeDriver } from "../runtime/fake-driver.ts";

const SCHEMA = `datasource db {
  provider = "hana"
  schema   = "APP"
}

model User {
  id        Int       @id
  email     String    @unique
  legacyKey String?   @unique @ignore @map("LEGACY_KEY")
  geom      Unsupported("ST_GEOMETRY")? @ignore
  posts     Post[]
  audits    Audit[]   @ignore

  @@map("USERS")
}

model Post {
  id       Int  @id
  authorId Int  @map("AUTHOR_ID")
  author   User @relation(fields: [authorId], references: [id])

  @@map("POSTS")
}

/// Written by a trigger, read by another system.
model Audit {
  id     Int    @id
  userId Int    @map("USER_ID")
  user   User   @relation(fields: [userId], references: [id])
  note   String @default("")

  @@map("AUDITS")
  @@ignore
}
`;

const compile = (src: string) => compileSchema(src);

function errorsOf(src: string): string {
  try {
    compileSchema(src);
  } catch (e) {
    if (e instanceof SchemaError) return e.message;
    throw e;
  }
  assert.fail("expected a SchemaError");
}

test("@ignore and @@ignore are kept in the contract and in the hash", () => {
  const c = compile(SCHEMA);
  assert.equal(c.models.Audit!.ignored, true);
  assert.equal(c.models.User!.fields.find((f) => f.name === "legacyKey")!.ignored, true);
  assert.equal(c.models.User!.fields.find((f) => f.name === "audits")!.ignored, true);
  assert.notEqual(c.hash, compile(SCHEMA.replace("  @@ignore\n", "").replace("Audit[]   @ignore", "Audit[]")).hash, "ignoring a model is a schema change");
});

test("migrations see ignored tables, columns, constraints and foreign keys", () => {
  const phys = contractToPhysical(compile(SCHEMA), { defaultSchema: "APP" });
  assert.ok(phys.tables.AUDITS, "ignored model is still a table");
  assert.deepEqual(phys.tables.AUDITS!.foreignKeys.map((f) => f.refTable), ["USERS"]);
  const users = phys.tables.USERS!;
  assert.deepEqual(users.columns.map((c) => c.name), ["id", "email", "LEGACY_KEY", "geom"]);
  assert.ok(users.uniques.some((u) => u.columns.includes("LEGACY_KEY")));

  // adding @ignore changes nothing in the database
  const plain = SCHEMA.replace(" @ignore @map", " @map").replace("audits    Audit[]   @ignore", "audits    Audit[]").replace("  @@ignore\n", "");
  assert.deepEqual(diffSchemas(contractToPhysical(compile(plain), { defaultSchema: "APP" }), phys), []);
});

test("the client contract drops ignored models, fields and uniques but keeps the hash", () => {
  const full = compile(SCHEMA);
  const c = clientContract(full);
  assert.deepEqual(Object.keys(c.models), ["User", "Post"]);
  assert.deepEqual(c.models.User!.fields.map((f) => f.name), ["id", "email", "posts"]);
  assert.deepEqual(c.models.User!.uniques.map((u) => u.name), ["email"]);
  assert.equal(c.hash, full.hash);
  const plain = compile(`model A {\n  id Int @id\n}\n`);
  assert.equal(clientContract(plain), plain, "unchanged contract is returned as is");
});

test("the generated client has no ignored model, field or unique input", () => {
  const src = generateClient(compile(SCHEMA), { runtimeImport: "x" });
  assert.doesNotMatch(src, /legacyKey|LEGACY_KEY|audits|AUDITS|\baudit\b|Audit/);
  assert.match(src, /export type User = \{\n  id: number;\n  email: string;\n\};/);
});

test("the runtime never selects ignored columns, even from a full contract", async () => {
  const driver = new FakeDriver();
  const Client = createClientClass(compile(SCHEMA));
  const db = new Client({ driver }) as unknown as Record<string, { findMany(a?: unknown): Promise<unknown> } | undefined>;
  assert.equal(db.audit, undefined);
  await db.user!.findMany();
  assert.equal(driver.calls[0]!.sql, `SELECT t0."id" AS "id", t0."email" AS "email" FROM "APP"."USERS" t0`);
});

test("ignored parts cannot be reached from the client", () => {
  assert.match(errorsOf(`model A {\n  id Int @id @ignore\n}\n`), /Primary key field 'A\.id' cannot be ignored/);
  assert.match(
    errorsOf(SCHEMA.replace("audits    Audit[]   @ignore", "audits    Audit[]")),
    /Relation 'User\.audits' points to the ignored model 'Audit'; add @ignore/,
  );
  assert.match(
    errorsOf(SCHEMA.replace(`authorId Int  @map("AUTHOR_ID")`, `authorId Int  @map("AUTHOR_ID") @ignore`)),
    /Relation 'Post\.author' uses the ignored field 'authorId'; add @ignore to the relation field too/,
  );
  assert.match(
    errorsOf(SCHEMA.replace(`authorId Int  @map("AUTHOR_ID")`, `authorId Int  @map("AUTHOR_ID") @ignore`).replace("author   User @relation", "author   User @ignore @relation")),
    /Relation 'User\.posts' is the other side of the ignored field 'Post\.author'; ignore both sides/,
  );
  assert.match(errorsOf(`model A {\n  id Int @id\n  b Int @ignore(true)\n}\n`), /@ignore takes no arguments/);
});

test("format keeps @ignore in the canonical attribute position", () => {
  const out = formatSchema(`model A {\n  id Int @id\n  b String @map("B") @ignore @unique\n  @@ignore\n  @@map("AS")\n}\n`);
  assert.match(out, /b +String +@unique @ignore @map\("B"\)/);
  assert.match(out, /@@map\("AS"\)\n  @@ignore\n/);
});

test("db pull keeps @ignore and @@ignore and ignores relations into ignored models", () => {
  const physical = contractToPhysical(compile(SCHEMA), { defaultSchema: "APP" });
  const existing = SCHEMA.replace("  posts     Post[]\n", "").replace("model Post {\n  id       Int  @id\n  authorId Int  @map(\"AUTHOR_ID\")\n  author   User @relation(fields: [authorId], references: [id])\n\n  @@map(\"POSTS\")\n}\n", "")
    .replace("  audits    Audit[]   @ignore\n", "")
    .replace("  user   User   @relation(fields: [userId], references: [id])\n", "");
  const { source } = renderSchema(physical, { existingSource: existing, defaultSchema: "APP", inScope: () => true });
  assert.match(source, /legacyKey +String\? +@unique @ignore @map\("LEGACY_KEY"\)/);
  assert.match(source, /@@ignore/);
  assert.match(source, /audits +Audit\[\] +@ignore/, "back side of a relation into an ignored model");
  const c = compileSchema(source);
  assert.equal(c.models.Audit!.ignored, true);
  assert.deepEqual(diffSchemas(contractToPhysical(c, { defaultSchema: "APP" }), physical), []);
});
