/**
 * `hana-orm format`: canonical layout for schema files.
 *
 * - Two-space indentation, one blank line between top-level blocks, no runs of blank lines.
 * - Field names, types and attributes are aligned in columns per model.
 * - Field attributes are put in a fixed order (`@id @default @unique @updatedAt @ignore
 *   @relation @map @db.*`); runs of block attributes are ordered `@@id @@unique @@index @@map
 *   @@schema @@ignore`.
 * - Attribute arguments are spaced uniformly: `@db.Decimal(15, 2)`, `fields: [a, b]`.
 * - `key = value` lines in `datasource`/`generator` blocks are aligned on `=`.
 * - Comments (`//` and `///`) are kept, including trailing comments.
 *
 * Formatting never changes meaning: the result is parsed again and compared with the input's
 * syntax tree. Formatting is idempotent: `format(format(x)) === format(x)`.
 */

import { parseSchema } from "./parser.ts";

interface Line {
  /** Code without comments, trimmed. Empty for blank and comment-only lines. */
  code: string;
  /** Comment text including the leading `//` or `///`. */
  comment?: string;
}

const FIELD_ATTR_ORDER = ["id", "default", "unique", "updatedAt", "ignore", "relation", "map"];
const BLOCK_ATTR_ORDER = ["id", "unique", "index", "fulltext", "map", "schema", "ignore"];

/** Formats schema source. Throws `SchemaError` when the source has syntax errors. */
export function formatSchema(source: string, file?: string): string {
  const before = parseSchema(source, file);
  const out = render(splitLines(source));
  let after;
  try {
    after = parseSchema(out, file);
  } catch (e) {
    throw new Error(`internal formatter error: the formatted schema does not parse (${(e as Error).message})`);
  }
  if (JSON.stringify(stripPositions(before)) !== JSON.stringify(stripPositions(after))) {
    throw new Error("internal formatter error: formatting would change the meaning of the schema");
  }
  return out;
}

/** True when `formatSchema(source)` would change the text. */
export function needsFormatting(source: string, file?: string): boolean {
  return formatSchema(source, file) !== source;
}

/** Syntax tree without positions; attribute lists sorted, since their order has no meaning. */
function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "pos") continue;
      const stripped = stripPositions(v);
      out[k] = k === "attributes" && Array.isArray(stripped) ? stripped.map((a) => JSON.stringify(a)).sort() : stripped;
    }
    return out;
  }
  return value;
}

// ---- logical lines ----------------------------------------------------------------

/**
 * Splits source into logical lines: a newline inside `(...)`/`[...]` does not end a line,
 * `{` ends one and `}` stands on its own line.
 */
function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let code = "";
  const comments: string[] = [];
  let depth = 0;
  const flush = (force = false) => {
    const c = code.trim();
    if (c || comments.length || force) lines.push({ code: c, ...(comments.length ? { comment: comments.join(" ") } : {}) });
    code = "";
    comments.length = 0;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"' && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      code += source.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      let end = source.indexOf("\n", i);
      if (end < 0) end = source.length;
      comments.push(source.slice(i, end).trimEnd());
      i = end - 1;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      if (depth > 0) code += " ";
      else flush(true);
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === "{") {
      code += "{";
      flush();
      continue;
    }
    if (depth === 0 && ch === "}") {
      flush();
      code = "}";
      // a trailing comment on the closing line stays with it
      let j = i + 1;
      while (source[j] === " " || source[j] === "\t") j++;
      if (source[j] === "/" && source[j + 1] === "/") continue;
      flush();
      continue;
    }
    code += ch;
  }
  flush();
  // a final newline produces an empty trailing line
  while (lines.length && !lines.at(-1)!.code && !lines.at(-1)!.comment) lines.pop();
  return lines;
}

// ---- token-level normalization ------------------------------------------------------

/** Re-spaces code: strings kept verbatim, one space after `,` and `:`, none elsewhere. */
export function normalizeCode(text: string): string {
  let out = "";
  let prevWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t") continue;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
      prevWord = true;
      continue;
    }
    const word = /^[A-Za-z0-9_.\-]+/.exec(text.slice(i));
    if (word) {
      if (prevWord) out += " ";
      out += word[0];
      i += word[0].length - 1;
      prevWord = true;
      continue;
    }
    out += ch;
    prevWord = false;
    if (ch === "," || ch === ":") out += " ";
  }
  return out.trimEnd();
}

/** Splits `@a(x) @b @@c(...)` at top-level `@` signs. */
function splitAttributes(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "@" && depth === 0 && text[i - 1] !== "@") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(normalizeCode);
}

/** Index of the first top-level `@` outside strings, or -1. */
function firstAttribute(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "@" && depth === 0) return i;
  }
  return -1;
}

function attrName(attr: string): string {
  return /^@@?([A-Za-z_][A-Za-z0-9_.]*)/.exec(attr)?.[1] ?? "";
}

function rank(order: readonly string[], name: string): number {
  if (name.startsWith("db.")) return order.length + 1;
  const i = order.indexOf(name);
  return i < 0 ? order.length + 2 : i;
}

function sortAttributes(attrs: string[], order: readonly string[]): string[] {
  return attrs
    .map((a, i) => ({ a, i, r: rank(order, attrName(a)) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.a);
}

// ---- rendering ----------------------------------------------------------------------

function withComment(text: string, comment: string | undefined): string {
  if (!comment) return text;
  return text ? `${text} ${comment}` : comment;
}

function render(lines: Line[]): string {
  const out: string[] = [];
  const push = (s: string) => {
    if (s === "" && (out.length === 0 || out.at(-1) === "")) return;
    if (s !== "" && out.at(-1) === "}") out.push("");
    out.push(s);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^([A-Za-z]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line.code);
    if (!header) {
      push(withComment(line.code, line.comment));
      continue;
    }
    const keyword = header[1]!;
    const body: Line[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.code !== "}") body.push(lines[j++]!);
    push(withComment(`${keyword} ${header[2]} {`, line.comment));
    for (const l of formatBlock(keyword, body)) out.push(l);
    out.push(withComment("}", lines[j]?.comment));
    if (lines[j]?.comment) out.push("");
    i = j;
  }
  while (out.length && out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}

function trimBlank(body: Line[]): Line[] {
  const out: Line[] = [];
  for (const l of body) {
    const blank = !l.code && !l.comment;
    if (blank && (!out.length || (!out.at(-1)!.code && !out.at(-1)!.comment))) continue;
    out.push(l);
  }
  while (out.length && !out.at(-1)!.code && !out.at(-1)!.comment) out.pop();
  return out;
}

function formatBlock(keyword: string, rawBody: Line[]): string[] {
  const body = trimBlank(rawBody);
  switch (keyword) {
    case "model":
    case "view":
      return formatModel(body);
    case "enum":
      return formatEnum(body);
    case "datasource":
    case "generator":
      return formatConfig(body);
    default:
      return body.map((l) => (l.code || l.comment ? `  ${withComment(l.code, l.comment)}` : ""));
  }
}

interface FieldParts {
  name: string;
  type: string;
  attrs: string[];
  comment?: string;
}

type ModelItem = { kind: "field"; field: FieldParts } | { kind: "block"; attr: string; comment?: string } | { kind: "other"; text: string };

function parseField(line: Line): FieldParts {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*/.exec(line.code)!;
  const rest = line.code.slice(m[0].length);
  const at = firstAttribute(rest);
  const typeText = at < 0 ? rest : rest.slice(0, at);
  return {
    name: m[1]!,
    type: normalizeCode(typeText),
    attrs: at < 0 ? [] : sortAttributes(splitAttributes(rest.slice(at)), FIELD_ATTR_ORDER),
    ...(line.comment ? { comment: line.comment } : {}),
  };
}

function formatModel(body: Line[]): string[] {
  const items: ModelItem[] = body.map((l) => {
    if (!l.code) return { kind: "other", text: l.comment ? `  ${l.comment}` : "" };
    if (l.code.startsWith("@@")) return { kind: "block", attr: normalizeCode(l.code), ...(l.comment ? { comment: l.comment } : {}) };
    return { kind: "field", field: parseField(l) };
  });
  // order each run of consecutive block attributes
  for (let i = 0; i < items.length; ) {
    if (items[i]!.kind !== "block") {
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && items[j]!.kind === "block") j++;
    const run = items.slice(i, j) as Extract<ModelItem, { kind: "block" }>[];
    const sorted = run
      .map((b, k) => ({ b, k, r: rank(BLOCK_ATTR_ORDER, attrName(b.attr)) }))
      .sort((x, y) => x.r - y.r || x.k - y.k)
      .map((x) => x.b);
    items.splice(i, j - i, ...sorted);
    i = j;
  }
  const fields = items.filter((x): x is Extract<ModelItem, { kind: "field" }> => x.kind === "field").map((x) => x.field);
  const nameWidth = Math.max(0, ...fields.map((f) => f.name.length));
  const typeWidth = Math.max(0, ...fields.map((f) => f.type.length));
  const out: string[] = [];
  let prev: ModelItem["kind"] | undefined;
  for (const item of items) {
    if (item.kind === "field") {
      const f = item.field;
      const text = f.attrs.length ? `${f.name.padEnd(nameWidth)} ${f.type.padEnd(typeWidth)} ${f.attrs.join(" ")}` : `${f.name.padEnd(nameWidth)} ${f.type}`;
      out.push(`  ${withComment(text, f.comment)}`);
    } else if (item.kind === "block") {
      if (prev === "field") out.push("");
      out.push(`  ${withComment(item.attr, item.comment)}`);
    } else out.push(item.text);
    prev = item.kind;
  }
  return out;
}

function formatEnum(body: Line[]): string[] {
  const values = body.filter((l) => l.code && !l.code.startsWith("@@"));
  const split = (code: string): { name: string; attrs: string[] } => {
    const at = firstAttribute(code);
    return at < 0 ? { name: code.trim(), attrs: [] } : { name: code.slice(0, at).trim(), attrs: splitAttributes(code.slice(at)) };
  };
  const width = Math.max(0, ...values.map((l) => split(l.code).name.length));
  const out: string[] = [];
  let prevValue = false;
  for (const l of body) {
    if (!l.code) {
      out.push(l.comment ? `  ${l.comment}` : "");
      prevValue = false;
      continue;
    }
    if (l.code.startsWith("@@")) {
      if (prevValue) out.push("");
      out.push(`  ${withComment(normalizeCode(l.code), l.comment)}`);
      prevValue = false;
      continue;
    }
    const v = split(l.code);
    out.push(`  ${withComment(v.attrs.length ? `${v.name.padEnd(width)} ${v.attrs.join(" ")}` : v.name, l.comment)}`);
    prevValue = true;
  }
  return out;
}

function formatConfig(body: Line[]): string[] {
  const parts = body.map((l) => {
    const eq = l.code.indexOf("=");
    return eq < 0 ? undefined : { key: l.code.slice(0, eq).trim(), value: normalizeCode(l.code.slice(eq + 1)) };
  });
  const width = Math.max(0, ...parts.map((p) => p?.key.length ?? 0));
  return body.map((l, i) => {
    const p = parts[i];
    if (!l.code) return l.comment ? `  ${l.comment}` : "";
    return `  ${withComment(p ? `${p.key.padEnd(width)} = ${p.value}` : l.code, l.comment)}`;
  });
}
