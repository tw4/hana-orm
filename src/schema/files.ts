/**
 * Schemas made of several files: `--schema schema/` reads every `*.hana` file directly inside
 * the folder (sorted by name) and merges them into one contract. Declarations may reference
 * each other across files; there is exactly one datasource in the whole set.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SchemaAst } from "./ast.ts";
import type { BuildOptions } from "./build.ts";
import { buildContract } from "./build.ts";
import type { Contract } from "./contract.ts";
import { SchemaError } from "./errors.ts";
import type { Diagnostic } from "./errors.ts";
import { parseSchema } from "./parser.ts";

export const SCHEMA_EXTENSION = ".hana";

export interface SchemaSource {
  /** Name used in error messages (usually relative to the working directory). */
  file: string;
  /** Absolute path, when read from disk. */
  path?: string;
  source: string;
}

export function isSchemaFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The schema files behind `path`: the file itself, or the `*.hana` files of a folder. */
export function schemaFiles(path: string): string[] {
  if (!isSchemaFolder(path)) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(SCHEMA_EXTENSION))
    .map((e) => join(path, e.name))
    .sort();
}

/** Reads the schema file or folder. Names in the result are relative to `cwd`. */
export function readSchemaSources(path: string, cwd: string): SchemaSource[] {
  return schemaFiles(path).map((p) => ({ file: relative(cwd, p) || p, path: p, source: readFileSync(p, "utf8") }));
}

function tagPositions(value: unknown, file: string): void {
  if (Array.isArray(value)) {
    for (const v of value) tagPositions(v, file);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.line === "number" && typeof obj.col === "number") {
    obj.file = file;
    return;
  }
  for (const v of Object.values(obj)) tagPositions(v, file);
}

/** Parses each source and merges the declarations into one syntax tree. */
export function parseSchemaSources(sources: readonly SchemaSource[]): SchemaAst {
  const declarations: SchemaAst["declarations"] = [];
  const diagnostics: Diagnostic[] = [];
  for (const s of sources) {
    try {
      const ast = parseSchema(s.source, s.file);
      if (sources.length > 1) tagPositions(ast, s.file);
      declarations.push(...ast.declarations);
    } catch (e) {
      if (!(e instanceof SchemaError)) throw e;
      for (const d of e.diagnostics) diagnostics.push(d.pos ? { ...d, pos: { ...d.pos, file: s.file } } : { ...d, message: `${s.file}: ${d.message}` });
    }
  }
  if (diagnostics.length) throw new SchemaError(diagnostics, sources.length === 1 ? sources[0]!.file : undefined);
  return { declarations };
}

/** Compiles one or more schema sources into a single contract. */
export function compileSchemaSources(sources: readonly SchemaSource[], options: BuildOptions = {}): Contract {
  if (!sources.length) throw new SchemaError([{ message: `No ${SCHEMA_EXTENSION} files found` }], options.file);
  const file = options.file ?? (sources.length === 1 ? sources[0]!.file : undefined);
  return buildContract(parseSchemaSources(sources), file ? { ...options, file } : options);
}
