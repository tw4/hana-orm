/** Programmatic API: parse/compile schemas and generate clients. The runtime lives in `hana-orm/runtime`. */
export { parseSchema } from "./schema/parser.ts";
export { buildContract, compileSchema, contractHash, constraintName } from "./schema/build.ts";
export { SchemaError, type Diagnostic } from "./schema/errors.ts";
export { formatSchema } from "./schema/format.ts";
export { compileSchemaSources, readSchemaSources, schemaFiles, type SchemaSource } from "./schema/files.ts";
export type * from "./schema/contract.ts";
export { clientContract } from "./schema/contract.ts";
export type * from "./schema/ast.ts";
export { generateClient, type GenerateOptions } from "./generator/client.ts";
