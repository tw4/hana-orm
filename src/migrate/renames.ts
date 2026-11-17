/**
 * Rename detection.
 *
 * - Certain renames come from the contracts: a model (or field) keeps its name in the schema
 *   but its `@@map` (`@map`) changes → RENAME TABLE (RENAME COLUMN) instead of drop + create.
 * - Candidate renames are guesses: a dropped and a created table with identical columns, or a
 *   dropped and an added column of the same type in one table. The CLI asks before using them.
 */

import type { Contract, ModelDef } from "../schema/contract.ts";
import { columnFields } from "../schema/contract.ts";
import { modelTableKey } from "./contract-to-physical.ts";
import { cmp } from "./ddl.ts";
import type { Renames } from "./diff.ts";
import { applyRenames, emptyRenames } from "./diff.ts";
import type { PhysicalSchema } from "./physical.ts";
import { normalizeType } from "./types.ts";

export function renamesFromContracts(
  prev: Pick<Contract, "models">,
  next: Pick<Contract, "models">,
  defaultSchema?: string,
): Renames {
  const out = emptyRenames();
  const prevModels = Object.values(prev.models).filter((m) => m.kind === "model");
  const nextModels = Object.values(next.models).filter((m) => m.kind === "model");
  const pairs: [ModelDef, ModelDef][] = [];
  const usedPrev = new Set<ModelDef>();
  for (const n of nextModels) {
    const p = prev.models[n.name];
    if (p && p.kind === "model") {
      pairs.push([p, n]);
      usedPrev.add(p);
    }
  }
  // Model renamed in the schema but still mapped to the same table: fields can still be paired.
  for (const n of nextModels) {
    if (pairs.some(([, x]) => x === n)) continue;
    const key = modelTableKey(n, defaultSchema);
    const p = prevModels.find((m) => !usedPrev.has(m) && modelTableKey(m, defaultSchema) === key);
    if (p) {
      pairs.push([p, n]);
      usedPrev.add(p);
    }
  }
  for (const [p, n] of pairs) {
    const fromKey = modelTableKey(p, defaultSchema);
    const toKey = modelTableKey(n, defaultSchema);
    if (fromKey !== toKey && (p.schema ?? defaultSchema ?? "") === (n.schema ?? defaultSchema ?? "")) out.tables[fromKey] = toKey;
    const cols: Record<string, string> = {};
    for (const nf of columnFields(n)) {
      const pf = columnFields(p).find((f) => f.name === nf.name);
      if (pf && pf.dbName !== nf.dbName) cols[pf.dbName] = nf.dbName;
    }
    if (Object.keys(cols).length) out.columns[toKey] = cols;
  }
  return out;
}

export interface RenameCandidates {
  tables: { from: string; to: string }[];
  columns: { table: string; from: string; to: string }[];
}

/** Guesses renames that the contracts do not state (see module comment). */
export function findRenameCandidates(from: PhysicalSchema, to: PhysicalSchema, renames: Renames): RenameCandidates {
  const a = applyRenames(from, renames);
  const out: RenameCandidates = { tables: [], columns: [] };
  const signature = (cols: { name: string; type: string }[]): string =>
    cols
      .map((c) => `${c.name}:${normalizeType(c.type)}`)
      .sort(cmp)
      .join(",");
  const dropped = Object.keys(a.tables).filter((k) => !to.tables[k]).sort(cmp);
  const created = Object.keys(to.tables).filter((k) => !a.tables[k]).sort(cmp);
  const usedCreated = new Set<string>();
  for (const d of dropped) {
    const td = a.tables[d]!;
    const matches = created.filter((c) => !usedCreated.has(c) && (to.tables[c]!.schema ?? "") === (td.schema ?? "") && signature(to.tables[c]!.columns) === signature(td.columns));
    if (matches.length === 1) {
      out.tables.push({ from: d, to: matches[0]! });
      usedCreated.add(matches[0]!);
    }
  }
  for (const key of Object.keys(to.tables).sort(cmp)) {
    const ta = a.tables[key];
    const tb = to.tables[key]!;
    if (!ta) continue;
    const droppedCols = ta.columns.filter((c) => !tb.columns.some((x) => x.name === c.name));
    const addedCols = tb.columns.filter((c) => !ta.columns.some((x) => x.name === c.name));
    for (const dc of droppedCols) {
      const same = addedCols.filter((ac) => normalizeType(ac.type) === normalizeType(dc.type) && ac.nullable === dc.nullable);
      const competitors = droppedCols.filter((x) => normalizeType(x.type) === normalizeType(dc.type) && x.nullable === dc.nullable);
      if (same.length === 1 && competitors.length === 1) out.columns.push({ table: key, from: dc.name, to: same[0]!.name });
    }
  }
  return out;
}

/** Merges accepted candidates into `renames` (returns a new object). */
export function withRenames(renames: Renames, accepted: RenameCandidates): Renames {
  const out: Renames = { tables: { ...renames.tables }, columns: Object.fromEntries(Object.entries(renames.columns).map(([k, v]) => [k, { ...v }])) };
  for (const t of accepted.tables) out.tables[t.from] = t.to;
  for (const c of accepted.columns) (out.columns[c.table] ??= {})[c.from] = c.to;
  return out;
}
