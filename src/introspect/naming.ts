/** Name conversion for `db pull`: `ORDER_ITEMS` → `OrderItems` / `orderItems`. */

/** Splits a database name into lower-case words. */
export function words(name: string): string[] {
  const hasLower = /[a-z]/.test(name);
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (hasLower) {
      // camelCase / PascalCase boundaries; keeps acronyms together (`HTTPServer` → http, server)
      for (const w of p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) if (w) out.push(w.toLowerCase());
    } else out.push(p.toLowerCase());
  }
  return out;
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function safeStart(s: string): string {
  if (!s) return "_";
  return /^[A-Za-z_]/.test(s) ? s : `_${s}`;
}

export function pascalCase(name: string): string {
  return safeStart(words(name).map(cap).join(""));
}

export function camelCase(name: string): string {
  const w = words(name);
  if (!w.length) return "_";
  return safeStart(w[0]! + w.slice(1).map(cap).join(""));
}

export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function upperFirst(s: string): string {
  return cap(s);
}

/** Naive English plural, good enough for relation field names. */
export function plural(word: string): string {
  // Table-derived names are often plural already (`Orders`, `OrderItems`).
  if (/[^s]s$/i.test(word)) return word;
  if (/(ss|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Returns `base`, or `base2`, `base3`, … — the first name not in `taken`. Adds it to `taken`. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}

/** Schema-language string literal. */
export function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}
