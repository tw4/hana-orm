import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSchema } from "../../src/schema/build.ts";
import { compileSchemaSources, readSchemaSources, schemaFiles } from "../../src/schema/files.ts";
import { SchemaError } from "../../src/schema/errors.ts";
import { loadSchema, schemaDir } from "../../src/cli/index.ts";

const base = `datasource db {\n  provider = "hana"\n  schema   = "APP"\n}\n`;
const users = `model User {\n  id    Int    @id\n  posts Post[]\n}\n`;
const posts = `model Post {\n  id       Int  @id\n  authorId Int\n  author   User @relation(fields: [authorId], references: [id])\n}\n`;

test("models in several files merge into one contract with cross-file relations", () => {
  const merged = compileSchemaSources([
    { file: "schema/base.hana", source: base },
    { file: "schema/post.hana", source: posts },
    { file: "schema/user.hana", source: users },
  ]);
  const single = compileSchema(base + users + posts);
  assert.deepEqual(Object.keys(merged.models).sort(), ["Post", "User"]);
  assert.equal(merged.hash, single.hash, "splitting a schema into files does not change the contract");
  assert.equal(merged.datasource.schema, "APP");
});

test("errors name the file they come from", () => {
  const err = (sources: { file: string; source: string }[]): string => {
    try {
      compileSchemaSources(sources);
    } catch (e) {
      assert.ok(e instanceof SchemaError);
      return e.message;
    }
    return assert.fail("expected SchemaError");
  };
  assert.match(err([{ file: "a.hana", source: users }, { file: "b.hana", source: "model Post {\n  id Int @id\n  x Strin\n}\n" }]), /b\.hana:3:3 - Unknown type 'Strin'/);
  assert.match(err([{ file: "a.hana", source: users + posts }, { file: "b.hana", source: users }]), /b\.hana:1:1 - 'User' is defined more than once/);
  assert.match(err([{ file: "a.hana", source: base }, { file: "b.hana", source: base }]), /b\.hana:1:1 - Only one datasource block is allowed/);
  assert.match(err([{ file: "a.hana", source: "model {" }, { file: "b.hana", source: "model B {" }]), /a\.hana:1:7[\s\S]*b\.hana:1:10/);
});

test("a schema folder: *.hana files sorted by name, migrations inside the folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hana-orm-files-"));
  try {
    const folder = join(dir, "schema");
    await mkdir(join(folder, "migrations"), { recursive: true });
    await writeFile(join(folder, "user.hana"), users);
    await writeFile(join(folder, "base.hana"), base);
    await writeFile(join(folder, "post.hana"), posts);
    await writeFile(join(folder, "notes.txt"), "not a schema");
    assert.deepEqual(schemaFiles(folder).map((p) => p.slice(folder.length + 1)), ["base.hana", "post.hana", "user.hana"]);
    assert.deepEqual(readSchemaSources(folder, dir).map((s) => s.file.replace(/\\/g, "/")), ["schema/base.hana", "schema/post.hana", "schema/user.hana"]);
    assert.deepEqual(Object.keys(loadSchema(dir, folder).models).sort(), ["Post", "User"]);
    assert.equal(schemaDir(folder), folder);
    assert.equal(schemaDir(join(folder, "user.hana")), folder);
    assert.throws(() => loadSchema(dir, join(dir, "missing.hana")), /Schema file not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
