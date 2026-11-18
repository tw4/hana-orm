/** Drift: differences between the live database and the physical schema a contract expects. */

import type { Contract } from "../schema/contract.ts";
import type { Queryable } from "../runtime/driver.ts";
import { introspect } from "../introspect/catalog.ts";
import { contractToPhysical, managesComments } from "./contract-to-physical.ts";
import { diffSchemas } from "./diff.ts";
import type { MigrationOp } from "./ops.ts";
import type { PhysicalSchema } from "./physical.ts";

export interface LiveComparison {
  expected: PhysicalSchema;
  live: PhysicalSchema;
  /** Ops that would bring the live database to the expected state. */
  ops: MigrationOp[];
}

/** Schemas a contract uses: the default schema plus every `@@schema`. */
export function contractSchemas(contract: Pick<Contract, "models">, defaultSchema: string): string[] {
  const s = new Set([defaultSchema]);
  for (const m of Object.values(contract.models)) if (m.schema) s.add(m.schema);
  return [...s].sort();
}

/**
 * Introspects only the tables and sequences the contract defines and diffs them against the
 * contract. Other objects in the database are never touched or reported.
 */
export async function compareWithLive(db: Queryable, contract: Pick<Contract, "models" | "enums">, defaultSchema: string): Promise<LiveComparison> {
  const expected = contractToPhysical(contract, { defaultSchema });
  const live = await introspect(db, {
    schemas: contractSchemas(contract, defaultSchema),
    defaultSchema,
    onlyTables: new Set(Object.keys(expected.tables)),
    onlySequences: new Set(Object.keys(expected.sequences ?? {})),
  });
  if (!managesComments(contract)) {
    // an old snapshot knows nothing about comments, so the database's comments are not drift
    for (const t of Object.values(live.tables)) {
      delete t.comment;
      for (const c of t.columns) delete c.comment;
    }
  }
  return { expected, live, ops: diffSchemas(live, expected) };
}
