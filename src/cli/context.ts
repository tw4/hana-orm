import type { Contract } from "../schema/contract.ts";
import type { Driver } from "../runtime/driver.ts";

/** What every CLI command receives. Created once in `cli/index.ts`. */
export interface CliContext {
  cwd: string;
  /** Absolute path of the schema file (may not exist yet, e.g. before `db pull`). */
  schemaPath: string;
  /** Folder holding migrations: `<schema dir>/migrations`. */
  migrationsDir: string;
  /** Parses and validates the schema file. Throws `SchemaError` on problems. */
  loadContract(): Promise<Contract>;
  /** Opens a driver using the schema's datasource (or env vars when the schema has none). */
  connect(): Promise<Driver>;
  /** Default database schema from the datasource, if configured. */
  defaultSchema(): Promise<string | undefined>;
  log(message: string): void;
  warn(message: string): void;
  /** Asks a yes/no question; returns `defaultAnswer` when stdin is not a TTY. */
  confirm(question: string, defaultAnswer: boolean): Promise<boolean>;
}

/** Parsed `--flag value`, `--flag` and positional arguments. */
export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}
