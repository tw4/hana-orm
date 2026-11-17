/**
 * Splits schema source text into its top-level blocks without interpreting them, so
 * `db pull` can keep `datasource`, `generator`, `enum` and untouched models byte for byte.
 */

export interface SourceBlock {
  keyword: string;
  name: string;
  /** Block text including directly preceding comment lines. */
  text: string;
  start: number;
  end: number;
}

export interface SplitSource {
  /** Text before the first block that is not attached to it (e.g. a file header comment). */
  preamble: string;
  blocks: SourceBlock[];
}

export function splitBlocks(source: string): SplitSource {
  const blocks: SourceBlock[] = [];
  const n = source.length;
  let i = 0;
  let depth = 0;
  let blockStart = -1;
  let header: { keyword: string; name: string } | null = null;
  let lineStart = true;
  while (i < n) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") {
      const e = source.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n && source[i] !== '"' && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (depth === 0 && lineStart && /[A-Za-z]/.test(ch)) {
      const m = /^([A-Za-z]+)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/.exec(source.slice(i));
      if (m) {
        header = { keyword: m[1]!, name: m[2]! };
        blockStart = i;
        depth = 1;
        i += m[0].length;
        lineStart = false;
        continue;
      }
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0 && header) {
        const end = i + 1;
        blocks.push({ keyword: header.keyword, name: header.name, text: "", start: withLeadingComments(source, blockStart), end });
        header = null;
      }
    }
    if (ch === "\n") lineStart = true;
    else if (ch !== " " && ch !== "\t" && ch !== "\r") lineStart = false;
    i++;
  }
  for (const b of blocks) b.text = source.slice(b.start, b.end);
  const firstStart = blocks[0]?.start ?? source.length;
  return { preamble: source.slice(0, firstStart).trim(), blocks };
}

/** Moves `start` back over comment lines directly above it (no blank line in between). */
function withLeadingComments(source: string, start: number): number {
  let s = start;
  for (;;) {
    const prevEnd = source.lastIndexOf("\n", s - 1);
    if (prevEnd < 0) return s;
    const prevStart = source.lastIndexOf("\n", prevEnd - 1) + 1;
    const line = source.slice(prevStart, prevEnd).trim();
    if (line.startsWith("//")) s = prevStart;
    else return s;
  }
}
