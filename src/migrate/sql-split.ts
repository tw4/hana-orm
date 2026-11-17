/**
 * Splits a SQL script into statements on `;`, ignoring semicolons inside string literals,
 * quoted identifiers and comments. Comment-only statements are dropped.
 */
export function splitSqlStatements(script: string): string[] {
  const out: string[] = [];
  let cur = "";
  let hasCode = false;
  let i = 0;
  const n = script.length;
  while (i < n) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (ch === "-" && next === "-") {
      const end = script.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      cur += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      cur += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (script[j] === ch) {
          if (script[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += script.slice(i, j + 1);
      hasCode = true;
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      if (hasCode) out.push(stripComments(cur));
      cur = "";
      hasCode = false;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) hasCode = true;
    cur += ch;
    i++;
  }
  if (hasCode) out.push(stripComments(cur));
  return out.filter((s) => s.length > 0);
}

/** Trims whitespace and leading full-line `--` comments. */
function stripComments(stmt: string): string {
  const lines = stmt.split("\n");
  while (lines.length && (lines[0]!.trim() === "" || lines[0]!.trim().startsWith("--"))) lines.shift();
  return lines.join("\n").trim();
}
