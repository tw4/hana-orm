/** VS Code extension features (issue #35), tested without VS Code. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { complete, declarations, definition, diagnose, format } from "../../editors/vscode/src/analysis.ts";

const SCHEMA = `datasource db {
  provider = "hana"
}

enum Role {
  USER
  ADMIN
}

model User {
  id    Int    @id
  role  Role
  posts Post[]
}

model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
`;

test("a valid schema has no diagnostics", () => {
  assert.deepEqual(diagnose({ file: "schema.hana", text: SCHEMA }), []);
});

test("diagnostics point at the field, 0-based, covering the word", () => {
  const text = SCHEMA.replace("role  Role", "role  Rol");
  const [d] = diagnose({ file: "schema.hana", text });
  assert.ok(d);
  assert.match(d.message, /Rol/);
  const line = text.split("\n")[d.start.line]!;
  assert.match(line, /role\s+Rol/);
  // the compiler reports the field; the range covers its name
  assert.equal(line.slice(d.start.character, d.end.character), "role");
});

test("syntax errors are reported too", () => {
  const ds = diagnose({ file: "schema.hana", text: "model A {\n  id Int @id\n" });
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.start.line >= 0, true);
});

test("schema folders: types from sibling files resolve; their problems are not reported here", () => {
  const user = { file: "/s/user.hana", source: "model User {\n  id Int @id\n  posts Post[]\n}\n" };
  const post = "model Post {\n  id Int @id\n  authorId Int\n  author User @relation(fields: [authorId], references: [id])\n}\n";
  assert.deepEqual(diagnose({ file: "/s/post.hana", text: post, siblings: [user] }), []);
  const broken = { file: "/s/other.hana", source: "model X {\n  id Nope @id\n}\n" };
  assert.deepEqual(diagnose({ file: "/s/post.hana", text: post, siblings: [user, broken] }), []);
});

test("format uses the schema formatter and returns null for broken files", () => {
  assert.equal(format("model A {\nid Int @id\n}\n"), "model A {\n  id Int @id\n}\n");
  assert.equal(format("model A {\n"), null);
});

test("go to definition finds models and enums, also in sibling files", () => {
  const lines = SCHEMA.split("\n");
  const fieldLine = lines.findIndex((l) => l.includes("role  Role"));
  const loc = definition({ file: "schema.hana", text: SCHEMA }, { line: fieldLine, character: lines[fieldLine]!.indexOf("Role") + 1 });
  assert.deepEqual(loc, { file: "schema.hana", start: { line: 4, character: 5 }, end: { line: 4, character: 9 } });
  const postsLine = lines.findIndex((l) => l.includes("Post[]"));
  assert.equal(definition({ file: "schema.hana", text: SCHEMA }, { line: postsLine, character: lines[postsLine]!.indexOf("Post") })!.start.line, lines.findIndex((l) => l.startsWith("model Post")));
  const other = { file: "/s/tag.hana", source: "model Tag {\n  name String @id\n}\n" };
  const text = "model A {\n  id Int @id\n  t Tag\n}\n";
  assert.equal(definition({ file: "/s/a.hana", text, siblings: [other] }, { line: 2, character: 5 })!.file, "/s/tag.hana");
  assert.equal(definition({ file: "schema.hana", text: SCHEMA }, { line: 0, character: 0 }), null);
  assert.deepEqual(declarations("x", SCHEMA).map((d) => `${d.kind} ${d.name}`), ["enum Role", "model User", "model Post"]);
});

test("completion depends on the position", () => {
  const ws = (text: string) => ({ file: "schema.hana", text });
  const labels = (text: string, line: number, character: number) => complete(ws(text), { line, character }).map((c) => c.label);
  // top level
  assert.ok(labels("", 0, 0).includes("model"));
  // field type
  const t = "enum Role {\n  A\n}\nmodel User {\n  role \n}\n";
  const types = labels(t, 4, 7);
  assert.ok(types.includes("String") && types.includes("Role") && types.includes("User") && types.includes("Unsupported"));
  // attributes
  const a = "model User {\n  id Int @\n}\n";
  assert.ok(labels(a, 1, 10).includes("@id"));
  assert.ok(labels(a, 1, 10).includes("@db.NVarChar"));
  const b = "model User {\n  id Int @id\n  @@\n}\n";
  assert.deepEqual(labels(b, 2, 4).slice(0, 2), ["@@id", "@@unique"]);
  // @default functions
  const d = "model User {\n  id Int @default(\n}\n";
  assert.ok(labels(d, 1, 18).includes("autoincrement()"));
  // nothing inside datasource blocks or after the attributes
  assert.deepEqual(labels('datasource db {\n  provider = "hana"\n}\n', 1, 5), []);
});

test("the TextMate grammar is valid JSON and its patterns compile", () => {
  const grammar = JSON.parse(readFileSync(new URL("../../editors/vscode/syntaxes/hana.tmLanguage.json", import.meta.url), "utf8"));
  assert.equal(grammar.scopeName, "source.hana");
  const patterns: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "match" || k === "begin" || k === "end") && typeof x === "string") patterns.push(x);
        else walk(x);
      }
    }
  };
  walk(grammar);
  assert.ok(patterns.length > 10);
  for (const p of patterns) assert.doesNotThrow(() => new RegExp(p), p);
  // a few spot checks
  assert.ok(new RegExp(grammar.repository.field.match).test("  email String? @unique"));
  assert.ok(new RegExp(grammar.repository["model-block"].begin).test("model User {"));
});
