import type { Contract, ModelDef, ReferentialAction } from "../schema/contract.ts";
import { columnFields, relationFields } from "../schema/contract.ts";
import type { FkAction, PhysicalColumn, PhysicalSchema, PhysicalSequence, PhysicalTable } from "./physical.ts";
import { MAX_IDENT_LENGTH, keyOf, tableKey } from "./physical.ts";
import { DEFAULT_ENUM_TYPE, DEFAULT_SCALAR_TYPES, contractDefaultToSql, nativeTypeToDdl } from "./types.ts";

export interface ContractToPhysicalOptions {
  /**
   * The datasource default schema. Models whose `@@schema` equals it are keyed without a
   * schema, the same way introspection keys them.
   */
  defaultSchema?: string;
}

/** HANA has no `NO ACTION`; `RESTRICT` is its default and closest equivalent. */
export function referentialActionToSql(action: ReferentialAction | undefined): FkAction {
  switch (action) {
    case "Cascade":
      return "CASCADE";
    case "SetNull":
      return "SET NULL";
    case "SetDefault":
      return "SET DEFAULT";
    case "Restrict":
    case "NoAction":
    case undefined:
      return "RESTRICT";
  }
}

export function modelSchema(model: Pick<ModelDef, "schema">, defaultSchema: string | undefined): string | undefined {
  return model.schema && model.schema !== defaultSchema ? model.schema : undefined;
}

export function modelTableKey(model: Pick<ModelDef, "schema" | "dbName">, defaultSchema: string | undefined): string {
  return tableKey(modelSchema(model, defaultSchema), model.dbName);
}

/**
 * False for a migration snapshot written before `///` docs became database comments: the
 * migrations up to it never set comments, so its docs say nothing about the database.
 */
export function managesComments(contract: object): boolean {
  const isSnapshot = "hash" in contract && !("datasource" in contract);
  return !isSnapshot || (contract as { comments?: boolean }).comments === true;
}

/**
 * Expected physical schema for a contract. Views (`kind: "view"`) are not managed by
 * migrations and are left out.
 */
export function contractToPhysical(contract: Pick<Contract, "models" | "enums">, options: ContractToPhysicalOptions = {}): PhysicalSchema {
  const { defaultSchema } = options;
  const comments = managesComments(contract);
  const tables: Record<string, PhysicalTable> = {};
  const sequences: Record<string, PhysicalSequence> = {};
  const models = Object.values(contract.models).filter((m) => m.kind === "model");

  for (const model of models) {
    const columns: PhysicalColumn[] = columnFields(model).map((f) => {
      const enumDef = f.kind === "enum" ? contract.enums[f.type] : undefined;
      const type = f.nativeType
        ? nativeTypeToDdl(f.nativeType.name, f.nativeType.args)
        : f.kind === "enum"
          ? DEFAULT_ENUM_TYPE
          : DEFAULT_SCALAR_TYPES[f.type];
      const col: PhysicalColumn = { name: f.dbName, type, nullable: f.optional };
      const dflt = contractDefaultToSql(f.default, type, enumDef);
      if (dflt !== undefined) col.default = dflt;
      if (f.default?.kind === "autoincrement") col.identity = true;
      if (f.doc && comments) col.comment = f.doc;
      if (f.default?.kind === "sequence") {
        const d = f.default;
        const seqSchema = modelSchema(model, defaultSchema);
        sequences[tableKey(seqSchema, d.name)] = {
          ...(seqSchema ? { schema: seqSchema } : {}),
          name: d.name,
          ...(d.start !== undefined ? { start: d.start } : {}),
          ...(d.increment !== undefined ? { increment: d.increment } : {}),
        };
      }
      return col;
    });
    for (const ignored of model.ignoredColumns ?? []) {
      columns.push({ name: ignored.dbName, type: ignored.type.toUpperCase(), nullable: ignored.optional });
    }
    const colName = (field: string): string => {
      const f = model.fields.find((x) => x.name === field);
      return f && f.kind !== "relation" ? f.dbName : field;
    };
    const table: PhysicalTable = {
      name: model.dbName,
      columns,
      primaryKey: model.primaryKey ? { name: model.primaryKey.dbName, columns: model.primaryKey.fields.map(colName) } : null,
      uniques: model.uniques.map((u) => ({ name: u.dbName, columns: u.fields.map(colName) })),
      indexes: model.indexes.map((i) => ({ name: i.dbName, columns: i.fields.map(colName) })),
      foreignKeys: [],
    };
    if (model.fulltext?.length) table.fulltext = model.fulltext.map((x) => ({ name: x.dbName, column: colName(x.field) }));
    if (model.checks?.length) table.checks = model.checks.map((c) => ({ name: c.dbName, sql: c.sql }));
    if (model.doc && comments) table.comment = model.doc;
    const schema = modelSchema(model, defaultSchema);
    if (schema) table.schema = schema;

    for (const rel of relationFields(model)) {
      if (!rel.owner) continue;
      const target = contract.models[rel.model];
      if (!target || target.kind !== "model") continue;
      const targetCol = (field: string): string => {
        const f = target.fields.find((x) => x.name === field);
        return f && f.kind !== "relation" ? f.dbName : field;
      };
      const refSchema = modelSchema(target, defaultSchema);
      table.foreignKeys.push({
        name: rel.fkName ?? truncateIdent(`FK_${model.dbName}_${rel.localFields.map(colName).join("_")}`),
        columns: rel.localFields.map(colName),
        ...(refSchema ? { refSchema } : {}),
        refTable: target.dbName,
        refColumns: rel.targetFields.map(targetCol),
        onDelete: referentialActionToSql(rel.onDelete),
        onUpdate: referentialActionToSql(rel.onUpdate),
      });
    }
    tables[keyOf(table)] = table;
  }
  return Object.keys(sequences).length ? { tables, sequences } : { tables };
}

export function truncateIdent(name: string): string {
  return name.length <= MAX_IDENT_LENGTH ? name : name.slice(0, MAX_IDENT_LENGTH);
}
