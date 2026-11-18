/**
 * Editor features for `.hana` files, independent of VS Code so they can be tested in the
 * repository's test suite: diagnostics, formatting, go to definition and completion.
 * Positions are 0-based (line, character) like the Language Server Protocol.
 */

import { SCALAR_TYPES } from "../../../src/schema/contract.ts";
import { SchemaError } from "../../../src/schema/errors.ts";
import { compileSchemaSources, type SchemaSource } from "../../../src/schema/files.ts";
import { formatSchema } from "../../../src/schema/format.ts";

export interface Position {
  line: number;
  character: number;
}

export interface EditorDiagnostic {
  start: Position;
  end: Position;
  message: string;
}

export interface Location {
  file: string;
  start: Position;
  end: Position;
}

export type CompletionKind = "keyword" | "type" | "attribute" | "function";
export interface Completion {
  label: string;
  kind: CompletionKind;
  detail?: string;
  /** Text to insert when it differs from the label (snippet syntax: `$1`). */
  insert?: string;
}

/** The file being edited plus the other `.hana` files of a schema folder. */
export interface Workspace {
  file: string;
  text: string;
  siblings?: readonly SchemaSource[];
}

const WORD = /[A-Za-z_][A-Za-z0-9_.]*/g;

function wordRange(lineText: string, character: number): { start: number; end: number; word: string } | null {
  for (const m of lineText.matchAll(WORD)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (character >= start && character <= end) return { start, end, word: m[0] };
  }
  return null;
}

// ---- diagnostics --------------------------------------------------------------------------------

/** Problems of the schema, reported for `ws.file` (problems in sibling files are left out). */
export function diagnose(ws: Workspace): EditorDiagnostic[] {
  const sources: SchemaSource[] = [{ file: ws.file, source: ws.text }, ...(ws.siblings ?? []).filter((s) => s.file !== ws.file)];
  try {
    compileSchemaSources(sources, sources.length === 1 ? { file: ws.file } : {});
    return [];
  } catch (e) {
    if (!(e instanceof SchemaError)) return [{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, message: (e as Error).message }];
    const lines = ws.text.split(/\r?\n/);
    const out: EditorDiagnostic[] = [];
    for (const d of e.diagnostics) {
      const file = d.pos?.file;
      if (file && file !== ws.file) continue;
      if (!d.pos) {
        out.push({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, message: d.message });
        continue;
      }
      const line = Math.max(0, d.pos.line - 1);
      const character = Math.max(0, d.pos.col - 1);
      const w = wordRange(lines[line] ?? "", character);
      const end = w && w.start === character ? w.end : character + 1;
      out.push({ start: { line, character }, end: { line, character: end }, message: d.message });
    }
    return out;
  }
}

// ---- formatting --------------------------------------------------------------------------------

/** The formatted text, or null when the file has syntax errors (the formatter refuses those). */
export function format(text: string, file?: string): string | null {
  try {
    return formatSchema(text, file);
  } catch {
    return null;
  }
}

// ---- definitions ------------------------------------------------------------------------------

const DECLARATION = /^\s*(model|view|enum|type)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** Declarations (`model X`, `view X`, `enum X`) in a source. */
export function declarations(file: string, text: string): { name: string; kind: string; location: Location }[] {
  const out: { name: string; kind: string; location: Location }[] = [];
  text.split(/\r?\n/).forEach((l, line) => {
    const m = DECLARATION.exec(l);
    if (!m) return;
    const character = l.indexOf(m[2]!, m[0].length - m[2]!.length);
    out.push({ name: m[2]!, kind: m[1]!, location: { file, start: { line, character }, end: { line, character: character + m[2]!.length } } });
  });
  return out;
}

/** Where the model or enum under the cursor is declared. */
export function definition(ws: Workspace, pos: Position): Location | null {
  const lineText = ws.text.split(/\r?\n/)[pos.line] ?? "";
  const w = wordRange(lineText, pos.character);
  if (!w) return null;
  const name = w.word.replace(/\?|\[\]$/g, "");
  const all = [{ file: ws.file, source: ws.text }, ...(ws.siblings ?? []).filter((s) => s.file !== ws.file)];
  for (const s of all) {
    const d = declarations(s.file, s.source).find((x) => x.name === name);
    if (d) return d.location;
  }
  return null;
}

// ---- completion --------------------------------------------------------------------------------

const FIELD_ATTRIBUTES: Completion[] = [
  { label: "@id", kind: "attribute", detail: "primary key" },
  { label: "@unique", kind: "attribute", detail: "unique constraint" },
  { label: "@default", kind: "attribute", detail: "default value", insert: "@default($1)" },
  { label: "@updatedAt", kind: "attribute", detail: "set on every write" },
  { label: "@map", kind: "attribute", detail: "column name", insert: '@map("$1")' },
  { label: "@relation", kind: "attribute", detail: "relation fields", insert: "@relation(fields: [$1], references: [$2])" },
  { label: "@ignore", kind: "attribute", detail: "hide from the client" },
  ...["NVarChar", "VarChar", "NChar", "Char", "Alphanum", "NClob", "Clob", "Text", "SmallInt", "TinyInt", "Decimal", "SmallDecimal", "Real", "Double", "SecondDate", "Date", "Time", "Timestamp", "VarBinary", "Blob"].map(
    (t): Completion => ({ label: `@db.${t}`, kind: "attribute", detail: "native HANA type", ...(/Var|Char|Alphanum|Decimal|Binary/.test(t) && t !== "SmallDecimal" ? { insert: `@db.${t}($1)` } : {}) }),
  ),
];

const BLOCK_ATTRIBUTES: Completion[] = [
  { label: "@@id", kind: "attribute", detail: "compound primary key", insert: "@@id([$1])" },
  { label: "@@unique", kind: "attribute", detail: "compound unique", insert: "@@unique([$1])" },
  { label: "@@index", kind: "attribute", detail: "index", insert: "@@index([$1])" },
  { label: "@@map", kind: "attribute", detail: "table name", insert: '@@map("$1")' },
  { label: "@@schema", kind: "attribute", detail: "database schema", insert: '@@schema("$1")' },
  { label: "@@ignore", kind: "attribute", detail: "hide the model from the client" },
];

const DEFAULT_FUNCTIONS: Completion[] = ["autoincrement()", "now()", "uuid()", "cuid()", 'dbgenerated("")'].map((f) => ({ label: f, kind: "function" }));

const TOP_LEVEL: Completion[] = [
  { label: "model", kind: "keyword", insert: "model $1 {\n  id Int @id @default(autoincrement())\n}" },
  { label: "enum", kind: "keyword", insert: "enum $1 {\n  \n}" },
  { label: "view", kind: "keyword", insert: "view $1 {\n  \n}" },
  { label: "datasource", kind: "keyword", insert: 'datasource db {\n  provider = "hana"\n}' },
  { label: "generator", kind: "keyword", insert: 'generator client {\n  provider = "hana-orm"\n  output   = "$1"\n}' },
];

/** Whether `line` is inside a `{ … }` block, and which block keyword opened it. */
function enclosingBlock(lines: readonly string[], line: number): string | null {
  for (let i = line; i >= 0; i--) {
    const l = lines[i]!;
    if (i < line && /^\s*}/.test(l)) return null;
    const m = /^\s*(model|view|enum|datasource|generator)\b.*\{/.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/** Suggestions at the cursor. */
export function complete(ws: Workspace, pos: Position): Completion[] {
  const lines = ws.text.split(/\r?\n/);
  const before = (lines[pos.line] ?? "").slice(0, pos.character);
  const block = enclosingBlock(lines, pos.line);
  if (!block) return /^\s*[A-Za-z]*$/.test(before) ? TOP_LEVEL : [];
  if (block !== "model" && block !== "view") return [];
  if (/@default\([^)]*$/.test(before)) return DEFAULT_FUNCTIONS;
  if (/(^|\s)@@[\w.]*$/.test(before)) return BLOCK_ATTRIBUTES;
  if (/(^|\s)@[\w.]*$/.test(before)) return FIELD_ATTRIBUTES;
  // `name |` or `name Ty|`: the field type
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_]*$/.test(before)) {
    const names = [{ file: ws.file, source: ws.text }, ...(ws.siblings ?? []).filter((s) => s.file !== ws.file)].flatMap((s) => declarations(s.file, s.source));
    return [
      ...SCALAR_TYPES.map((t): Completion => ({ label: t, kind: "type", detail: "scalar" })),
      ...names.map((d): Completion => ({ label: d.name, kind: "type", detail: d.kind })),
      { label: "Unsupported", kind: "type", detail: "column hidden from the client", insert: 'Unsupported("$1")' },
    ];
  }
  return [];
}
