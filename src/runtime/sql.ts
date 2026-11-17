import type { ModelDef } from "../schema/contract.ts";

/** Quotes an identifier for HANA: `"NAME"` with embedded quotes doubled. Case is preserved. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Fully qualified table reference, e.g. `"APP"."USERS"`; uses the default schema when the model has none. */
export function tableRef(model: Pick<ModelDef, "dbName" | "schema">, defaultSchema?: string): string {
  const schema = model.schema ?? defaultSchema;
  return schema ? `${quoteIdent(schema)}.${quoteIdent(model.dbName)}` : quoteIdent(model.dbName);
}

/** Escapes `%`, `_` and `\` for use in `LIKE ? ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
