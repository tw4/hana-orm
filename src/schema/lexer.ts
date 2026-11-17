import type { Position } from "./ast.ts";
import { SchemaError } from "./errors.ts";

export type TokenType = "ident" | "string" | "number" | "punct" | "newline" | "at" | "atat" | "doc" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  pos: Position;
}

const PUNCT = new Set(["{", "}", "(", ")", "[", "]", "=", ",", ":", "?"]);

export function tokenize(source: string, file?: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const pos = (): Position => ({ line, col });
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === "\n") {
      tokens.push({ type: "newline", value: "\n", pos: pos() });
      advance();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const start = pos();
      const isDoc = source[i + 2] === "/";
      let end = source.indexOf("\n", i);
      if (end === -1) end = source.length;
      const text = source.slice(i + (isDoc ? 3 : 2), end).trim();
      if (isDoc) tokens.push({ type: "doc", value: text, pos: start });
      advance(end - i);
      continue;
    }
    if (ch === "@") {
      const start = pos();
      if (source[i + 1] === "@") {
        tokens.push({ type: "atat", value: "@@", pos: start });
        advance(2);
      } else {
        tokens.push({ type: "at", value: "@", pos: start });
        advance();
      }
      continue;
    }
    if (ch === '"') {
      const start = pos();
      advance();
      let value = "";
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\n") throw new SchemaError([{ message: "Unterminated string", pos: start }], file);
        if (source[i] === "\\") {
          const next = source[i + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
          advance(2);
        } else {
          value += source[i];
          advance();
        }
      }
      if (i >= source.length) throw new SchemaError([{ message: "Unterminated string", pos: start }], file);
      advance();
      tokens.push({ type: "string", value, pos: start });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const start = pos();
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ type: "number", value: m[0], pos: start });
      advance(m[0].length);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = pos();
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(source.slice(i))!;
      tokens.push({ type: "ident", value: m[0], pos: start });
      advance(m[0].length);
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: "punct", value: ch, pos: pos() });
      advance();
      continue;
    }
    throw new SchemaError([{ message: `Unexpected character '${ch}'`, pos: pos() }], file);
  }
  tokens.push({ type: "eof", value: "", pos: pos() });
  return tokens;
}
