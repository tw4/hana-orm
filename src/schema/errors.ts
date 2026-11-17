import type { Position } from "./ast.ts";

export interface Diagnostic {
  message: string;
  pos?: Position;
}

/** One or more problems found in a schema file. */
export class SchemaError extends Error {
  readonly diagnostics: Diagnostic[];
  readonly file: string | undefined;

  constructor(diagnostics: Diagnostic[], file?: string) {
    super(SchemaError.format(diagnostics, file));
    this.name = "SchemaError";
    this.diagnostics = diagnostics;
    this.file = file;
  }

  static format(diagnostics: Diagnostic[], file?: string): string {
    const where = file ?? "schema";
    return diagnostics
      .map((d) => (d.pos ? `${d.pos.file ?? where}:${d.pos.line}:${d.pos.col} - ${d.message}` : `${where} - ${d.message}`))
      .join("\n");
  }
}
