/** Programmatic API of the migration engine and introspection (`hana-orm/migrate`). */

export * from "./physical.ts";
export * from "./types.ts";
export * from "./ops.ts";
export * from "./ddl.ts";
export { contractToPhysical, modelTableKey, referentialActionToSql } from "./contract-to-physical.ts";
export type { ContractToPhysicalOptions } from "./contract-to-physical.ts";
export { applyRenames, diffSchemas, emptyRenames } from "./diff.ts";
export type { DiffOptions, Renames } from "./diff.ts";
export { findRenameCandidates, renamesFromContracts, withRenames } from "./renames.ts";
export type { RenameCandidates } from "./renames.ts";
export * from "./files.ts";
export * from "./history.ts";
export * from "./apply.ts";
export { compareWithLive, contractSchemas } from "./drift.ts";
export type { LiveComparison } from "./drift.ts";
export { splitSqlStatements } from "./sql-split.ts";
export { EMPTY_CONTRACT_HASH, planBetween } from "./commands.ts";
export { DB_MIGRATE_HELP, runDbOrMigrateCommand } from "./cli.ts";
export { dbSeed, resolveSeedCommand, runSeed, runShellCommand } from "./seed.ts";
export type { SeedCommand } from "./seed.ts";
export { introspect, buildPhysicalFromCatalog, readCatalog, catalogType, currentSchema, CATALOG_SQL } from "../introspect/catalog.ts";
export type { CatalogRows, IntrospectOptions } from "../introspect/catalog.ts";
export { renderSchema, mapHanaType } from "../introspect/render.ts";
export type { RenderOptions, RenderResult } from "../introspect/render.ts";
export { makeTableFilter, parsePatternList } from "../introspect/filter.ts";
