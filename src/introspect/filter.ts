/**
 * Table filters for `db pull --tables A,B --exclude X`. Patterns are comma separated, match
 * case-insensitively and may use `*` (any characters) and `?` (one character).
 */

function patternToRegExp(pattern: string): RegExp {
  const re = pattern
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`, "i");
}

export function parsePatternList(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function makeTableFilter(include: readonly string[], exclude: readonly string[]): ((name: string) => boolean) | undefined {
  if (!include.length && !exclude.length) return undefined;
  const inc = include.map(patternToRegExp);
  const exc = exclude.map(patternToRegExp);
  return (name) => (inc.length === 0 || inc.some((r) => r.test(name))) && !exc.some((r) => r.test(name));
}
