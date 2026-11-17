import { createHash } from "node:crypto";
import type { Arg, Attribute, ConfigBlock, EnumDecl, FieldDecl, ModelDecl, Position, SchemaAst, Value } from "./ast.ts";
import {
  CONTRACT_VERSION,
  SCALAR_TYPES,
  type ConfigValue,
  type Contract,
  type DatasourceDef,
  type DefaultDef,
  type EnumDef,
  type FieldDef,
  type GeneratorDef,
  type IndexDef,
  type ModelDef,
  type NativeType,
  type ReferentialAction,
  type RelationFieldDef,
  type ScalarType,
  type UniqueDef,
} from "./contract.ts";
import { SchemaError, type Diagnostic } from "./errors.ts";
import { parseSchema } from "./parser.ts";

export interface BuildOptions {
  /** File name used in error messages. */
  file?: string;
}

/** Parses and validates schema source and returns its contract. Throws `SchemaError` listing every problem. */
export function compileSchema(source: string, options: BuildOptions = {}): Contract {
  return buildContract(parseSchema(source, options.file), options);
}

const REFERENTIAL_ACTIONS = new Set<ReferentialAction>(["Cascade", "Restrict", "NoAction", "SetNull", "SetDefault"]);
const MAX_IDENT = 127;

interface PendingRelation {
  model: ModelDef;
  decl: FieldDecl;
  field: RelationFieldDef;
  /** Raw names from `@relation(fields: [...], references: [...])`. */
  fields?: string[];
  references?: string[];
  explicitName?: string;
  mapName?: string;
}

export function buildContract(ast: SchemaAst, options: BuildOptions = {}): Contract {
  const diags: Diagnostic[] = [];
  const err = (message: string, pos?: Position) => diags.push({ message, pos });

  const modelDecls = ast.declarations.filter((d): d is ModelDecl => d.kind === "model" || d.kind === "view");
  const enumDecls = ast.declarations.filter((d): d is EnumDecl => d.kind === "enum");
  const configs = ast.declarations.filter((d): d is ConfigBlock => d.kind === "datasource" || d.kind === "generator");

  // ---- names --------------------------------------------------------------
  const typeNames = new Map<string, Position>();
  for (const d of [...modelDecls, ...enumDecls]) {
    if (typeNames.has(d.name)) err(`'${d.name}' is defined more than once`, d.pos);
    else if ((SCALAR_TYPES as readonly string[]).includes(d.name)) err(`'${d.name}' is a reserved type name`, d.pos);
    typeNames.set(d.name, d.pos);
  }

  // ---- datasource / generators -------------------------------------------
  const datasources = configs.filter((c) => c.kind === "datasource");
  if (datasources.length > 1) err("Only one datasource block is allowed", datasources[1]!.pos);
  const datasource = buildDatasource(datasources[0], err);
  const generators: GeneratorDef[] = configs
    .filter((c) => c.kind === "generator")
    .map((g) => {
      const def: GeneratorDef = { name: g.name, provider: "hana-orm" };
      for (const p of g.properties) {
        const v = configValue(p.value, err);
        if (v !== undefined) def[p.key] = v;
      }
      return def;
    });

  // ---- enums --------------------------------------------------------------
  const enums: Record<string, EnumDef> = {};
  for (const e of enumDecls) {
    const seen = new Set<string>();
    const values = e.values.map((v) => {
      if (seen.has(v.name)) err(`Enum value '${v.name}' is defined more than once in '${e.name}'`, v.pos);
      seen.add(v.name);
      return { name: v.name, dbName: mapArg(v.attributes, "map", err) ?? v.name };
    });
    if (!values.length) err(`Enum '${e.name}' has no values`, e.pos);
    enums[e.name] = { name: e.name, dbName: mapArg(e.attributes, "map", err) ?? e.name, values, ...(e.doc ? { doc: e.doc } : {}) };
  }

  // ---- models (columns first, relations second) ---------------------------
  const models: Record<string, ModelDef> = {};
  const pending: PendingRelation[] = [];

  for (const m of modelDecls) {
    const model: ModelDef = {
      name: m.name,
      dbName: mapArg(m.attributes, "map", err) ?? m.name,
      kind: m.kind,
      fields: [],
      primaryKey: null,
      uniques: [],
      indexes: [],
      ...(m.doc ? { doc: m.doc } : {}),
    };
    const schemaAttr = findAttr(m.attributes, "schema");
    if (schemaAttr) {
      const s = stringArg(schemaAttr, 0, err);
      if (s) model.schema = s;
    }
    models[m.name] = model;

    const fieldNames = new Set<string>();
    for (const f of m.fields) {
      if (fieldNames.has(f.name)) err(`Field '${f.name}' is defined more than once in '${m.name}'`, f.pos);
      fieldNames.add(f.name);
      if (f.unsupported !== undefined) continue; // not exposed in the client
      const def = buildField(m, f, typeNames, enums, err);
      if (!def) continue;
      if (def.kind === "relation") {
        const rel = findAttr(f.attributes, "relation");
        const pr: PendingRelation = { model, decl: f, field: def };
        if (rel) {
          for (const a of rel.args) {
            if (!a.name || a.name === "name") pr.explicitName = stringValue(a.value, err);
            else if (a.name === "fields") pr.fields = identList(a.value, err);
            else if (a.name === "references") pr.references = identList(a.value, err);
            else if (a.name === "onDelete" || a.name === "onUpdate") {
              const action = a.value.kind === "ident" ? a.value.name : "";
              if (!REFERENTIAL_ACTIONS.has(action as ReferentialAction)) err(`Invalid referential action '${action}'`, rel.pos);
              else def[a.name] = action as ReferentialAction;
            } else if (a.name === "map") pr.mapName = stringValue(a.value, err);
            else err(`Unknown argument '${a.name}' in @relation`, rel.pos);
          }
        }
        pending.push(pr);
      }
      model.fields.push(def);
    }

    // block attributes
    for (const a of m.attributes) {
      switch (a.name) {
        case "map":
        case "schema":
          break;
        case "id": {
          const fields = fieldListArg(a, model, err);
          if (model.primaryKey) err(`Model '${m.name}' has more than one primary key`, a.pos);
          else if (fields) model.primaryKey = { name: fields.join("_"), dbName: namedMap(a) ?? constraintName("PK", model.dbName, []), fields };
          break;
        }
        case "unique": {
          const fields = fieldListArg(a, model, err);
          if (fields) {
            model.uniques.push({
              name: namedArg(a, "name") ?? fields.join("_"),
              dbName: namedMap(a) ?? constraintName("UQ", model.dbName, columnNames(model, fields)),
              fields,
            });
          }
          break;
        }
        case "index": {
          const fields = fieldListArg(a, model, err);
          if (fields) model.indexes.push({ dbName: namedMap(a) ?? constraintName("IX", model.dbName, columnNames(model, fields)), fields });
          break;
        }
        default:
          err(`Unknown block attribute '@@${a.name}'`, a.pos);
      }
    }

    // field-level @id / @unique
    const idFields = model.fields.filter((f) => f.kind !== "relation" && f.id);
    if (idFields.length > 1) err(`Model '${m.name}' has more than one @id field; use @@id([...]) for a compound key`, m.pos);
    if (idFields.length === 1) {
      if (model.primaryKey) err(`Model '${m.name}' has both @id and @@id`, m.pos);
      else {
        const decl = m.fields.find((f) => f.name === idFields[0]!.name)!;
        const idAttr = findAttr(decl.attributes, "id")!;
        model.primaryKey = { name: idFields[0]!.name, dbName: namedMap(idAttr) ?? constraintName("PK", model.dbName, []), fields: [idFields[0]!.name] };
      }
    }
    for (const f of model.fields) {
      if (f.kind === "relation" || !f.unique) continue;
      const decl = m.fields.find((d) => d.name === f.name)!;
      const u = findAttr(decl.attributes, "unique")!;
      model.uniques.push({ name: f.name, dbName: namedMap(u) ?? constraintName("UQ", model.dbName, [f.dbName]), fields: [f.name] });
    }
    if (model.primaryKey) {
      for (const name of model.primaryKey.fields) {
        const f = model.fields.find((x) => x.name === name);
        if (f && f.kind !== "relation" && f.optional) err(`Primary key field '${name}' of '${m.name}' cannot be optional`, m.pos);
      }
    }
    const dbCols = new Map<string, string>();
    for (const f of model.fields) {
      if (f.kind === "relation") continue;
      const prev = dbCols.get(f.dbName);
      if (prev) err(`Fields '${prev}' and '${f.name}' of '${m.name}' map to the same column '${f.dbName}'`, m.pos);
      dbCols.set(f.dbName, f.name);
    }
  }

  // ---- table name clashes ------------------------------------------------
  const tables = new Map<string, string>();
  for (const m of Object.values(models)) {
    const key = `${m.schema ?? ""}.${m.dbName}`;
    const prev = tables.get(key);
    if (prev) err(`Models '${prev}' and '${m.name}' map to the same table '${m.dbName}'`);
    tables.set(key, m.name);
  }

  resolveRelations(pending, models, err);

  if (diags.length) throw new SchemaError(diags, options.file);

  const contract: Contract = { version: CONTRACT_VERSION, hash: "", datasource, generators, models, enums };
  contract.hash = contractHash(contract);
  return contract;
}

/** sha256 over the data model (models + enums + default schema), canonical JSON. */
export function contractHash(contract: Pick<Contract, "models" | "enums" | "datasource">): string {
  const schema = contract.datasource.schema;
  const payload = canonical({
    models: contract.models,
    enums: contract.enums,
    schema: typeof schema === "string" ? schema : null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined && k !== "doc")
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---- fields -----------------------------------------------------------------

type Err = (message: string, pos?: Position) => void;

function buildField(
  m: ModelDecl,
  f: FieldDecl,
  typeNames: Map<string, Position>,
  enums: Record<string, EnumDef>,
  err: Err,
): FieldDef | undefined {
  const isScalar = (SCALAR_TYPES as readonly string[]).includes(f.type);
  const isEnum = f.type in enums;
  const isModel = !isScalar && !isEnum && typeNames.has(f.type);
  if (!isScalar && !isEnum && !isModel) {
    err(`Unknown type '${f.type}' for field '${m.name}.${f.name}'`, f.pos);
    return undefined;
  }
  const doc = f.doc ? { doc: f.doc } : {};

  if (isModel) {
    if (f.list && f.optional) err(`Relation list '${f.name}' cannot be optional`, f.pos);
    for (const a of f.attributes) if (a.name !== "relation") err(`Attribute '@${a.name}' is not allowed on relation field '${f.name}'`, a.pos);
    return {
      kind: "relation",
      name: f.name,
      model: f.type,
      list: f.list,
      optional: f.optional,
      relationName: "",
      owner: false,
      localFields: [],
      targetFields: [],
      ...doc,
    };
  }

  if (f.list) {
    err(`Scalar lists are not supported by SAP HANA tables ('${m.name}.${f.name}'); use a relation or Json`, f.pos);
    return undefined;
  }

  let id = false;
  let unique = false;
  let updatedAt = false;
  let dflt: DefaultDef | undefined;
  let nativeType: NativeType | undefined;
  let dbName = f.name;

  for (const a of f.attributes) {
    if (a.name.startsWith("db.")) {
      if (nativeType) err(`Field '${f.name}' has more than one @db attribute`, a.pos);
      nativeType = { name: a.name.slice(3), args: a.args.map((x) => (x.value.kind === "number" ? x.value.value : NaN)) };
      if (nativeType.args.some(Number.isNaN)) err(`@${a.name} expects numeric arguments`, a.pos);
      continue;
    }
    switch (a.name) {
      case "id":
        id = true;
        break;
      case "unique":
        unique = true;
        break;
      case "map":
        dbName = stringArg(a, 0, err) ?? dbName;
        break;
      case "updatedAt":
        if (f.type !== "DateTime") err(`@updatedAt is only valid on DateTime fields`, a.pos);
        updatedAt = true;
        break;
      case "default":
        dflt = buildDefault(a, f, isEnum ? enums[f.type] : undefined, err);
        break;
      case "relation":
        err(`@relation is only valid on relation fields`, a.pos);
        break;
      default:
        err(`Unknown attribute '@${a.name}' on field '${f.name}'`, a.pos);
    }
  }
  if (dbName.length > MAX_IDENT) err(`Column name '${dbName}' is longer than ${MAX_IDENT} characters`, f.pos);

  const base = { name: f.name, dbName, optional: f.optional, id, unique, ...(dflt ? { default: dflt } : {}), ...(nativeType ? { nativeType } : {}), ...doc };
  if (isEnum) return { kind: "enum", type: f.type, updatedAt: false, ...base };
  return { kind: "scalar", type: f.type as ScalarType, updatedAt, ...base };
}

function buildDefault(a: Attribute, f: FieldDecl, enumDef: EnumDef | undefined, err: Err): DefaultDef | undefined {
  const v = a.args[0]?.value;
  if (!v || a.args.length !== 1) {
    err(`@default expects exactly one argument`, a.pos);
    return undefined;
  }
  if (v.kind === "call") {
    switch (v.name) {
      case "autoincrement":
        if (f.type !== "Int" && f.type !== "BigInt") err(`autoincrement() is only valid on Int and BigInt fields`, a.pos);
        return { kind: "autoincrement" };
      case "now":
        if (f.type !== "DateTime") err(`now() is only valid on DateTime fields`, a.pos);
        return { kind: "now" };
      case "uuid":
      case "cuid":
        if (f.type !== "String") err(`${v.name}() is only valid on String fields`, a.pos);
        return { kind: v.name };
      case "dbgenerated": {
        const sql = v.args[0]?.value;
        if (!sql || sql.kind !== "string") {
          err(`dbgenerated() expects a SQL string`, a.pos);
          return undefined;
        }
        return { kind: "dbgenerated", sql: sql.value };
      }
      default:
        err(`Unknown default function '${v.name}()'`, a.pos);
        return undefined;
    }
  }
  if (enumDef) {
    if (v.kind !== "ident" || !enumDef.values.some((x) => x.name === v.name)) {
      err(`Default of '${f.name}' must be a value of enum '${enumDef.name}'`, a.pos);
      return undefined;
    }
    return { kind: "value", value: v.name };
  }
  const ok =
    (v.kind === "string" && (f.type === "String" || f.type === "Decimal" || f.type === "DateTime" || f.type === "Json" || f.type === "BigInt")) ||
    (v.kind === "number" && ["Int", "BigInt", "Float", "Decimal"].includes(f.type)) ||
    (v.kind === "boolean" && f.type === "Boolean");
  if (!ok) {
    err(`Default value does not match type '${f.type}' of field '${f.name}'`, a.pos);
    return undefined;
  }
  return { kind: "value", value: (v as { value: string | number | boolean }).value };
}

// ---- relations --------------------------------------------------------------

function resolveRelations(pending: PendingRelation[], models: Record<string, ModelDef>, err: Err): void {
  const used = new Set<PendingRelation>();

  // owners first: they define the foreign key
  for (const p of pending) {
    if (!p.fields && !p.references) continue;
    const { model, field, decl } = p;
    const target = models[field.model]!;
    if (!p.fields || !p.references || p.fields.length !== p.references.length || !p.fields.length) {
      err(`@relation on '${model.name}.${field.name}' needs 'fields' and 'references' of the same length`, decl.pos);
      continue;
    }
    if (field.list) {
      err(`The foreign key side '${model.name}.${field.name}' cannot be a list`, decl.pos);
      continue;
    }
    let ok = true;
    for (const name of p.fields) {
      const f = model.fields.find((x) => x.name === name);
      if (!f || f.kind === "relation") {
        err(`Unknown field '${name}' in fields of '${model.name}.${field.name}'`, decl.pos);
        ok = false;
      }
    }
    for (const name of p.references) {
      const f = target.fields.find((x) => x.name === name);
      if (!f || f.kind === "relation") {
        err(`Unknown field '${name}' in references of '${model.name}.${field.name}' (model '${target.name}')`, decl.pos);
        ok = false;
      }
    }
    if (!ok) continue;
    const fkOptional = p.fields.some((n) => (model.fields.find((x) => x.name === n) as { optional: boolean }).optional);
    if (fkOptional !== field.optional) {
      err(
        field.optional
          ? `Relation '${model.name}.${field.name}' is optional but its foreign key fields are required; make them optional or the relation required`
          : `Relation '${model.name}.${field.name}' is required but a foreign key field is optional; mark the relation optional with '?'`,
        decl.pos,
      );
    }
    field.owner = true;
    field.localFields = p.fields;
    field.targetFields = p.references;
    field.relationName = p.explicitName ?? defaultRelationName(model.name, target.name);
    field.fkName = p.mapName ?? constraintName("FK", model.dbName, columnNames(model, p.fields));
    used.add(p);
  }

  // back sides
  for (const p of pending) {
    if (used.has(p)) continue;
    const { model, field, decl } = p;
    const candidates = pending.filter(
      (o) =>
        o !== p &&
        o.field.owner &&
        o.model.name === field.model &&
        o.field.model === model.name &&
        (p.explicitName === undefined ? o.explicitName === undefined || countBetween(pending, model.name, field.model) === 1 : o.explicitName === p.explicitName),
    );
    if (candidates.length !== 1) {
      err(
        candidates.length === 0
          ? `Relation '${model.name}.${field.name}' has no matching side with @relation(fields: [...], references: [...]) on model '${field.model}'`
          : `Relation '${model.name}.${field.name}' is ambiguous; give both sides the same name: @relation("Name")`,
        decl.pos,
      );
      continue;
    }
    const owner = candidates[0]!.field;
    field.relationName = owner.relationName;
    field.owner = false;
    field.localFields = owner.targetFields;
    field.targetFields = owner.localFields;
    if (!field.list && !field.optional) err(`The non-foreign-key side '${model.name}.${field.name}' of a one-to-one relation must be optional`, decl.pos);
    used.add(p);
  }
}

function countBetween(pending: PendingRelation[], a: string, b: string): number {
  return pending.filter((p) => p.field.owner && p.model.name === b && p.field.model === a).length;
}

function defaultRelationName(a: string, b: string): string {
  return [a, b].sort().join("To");
}

// ---- datasource -------------------------------------------------------------

function buildDatasource(block: ConfigBlock | undefined, err: Err): DatasourceDef {
  const ds: DatasourceDef = { name: block?.name ?? "db", provider: "hana" };
  if (!block) return ds;
  const allowed = new Set(["provider", "url", "host", "port", "user", "password", "databaseName", "schema", "encrypt", "sslValidateCertificate"]);
  for (const p of block.properties) {
    if (!allowed.has(p.key)) {
      err(`Unknown datasource property '${p.key}'`, p.pos);
      continue;
    }
    const v = configValue(p.value, err);
    if (v === undefined) continue;
    if (p.key === "provider") {
      if (v !== "hana") err(`Unsupported provider '${String(v)}'; only "hana" is supported`, p.pos);
      continue;
    }
    (ds as unknown as Record<string, ConfigValue>)[p.key] = v;
  }
  return ds;
}

function configValue(v: Value, err: Err): ConfigValue | undefined {
  switch (v.kind) {
    case "string":
    case "number":
    case "boolean":
      return v.value;
    case "call":
      if (v.name === "env" && v.args.length === 1 && v.args[0]!.value.kind === "string") return { env: v.args[0]!.value.value };
      err(`Only env("NAME") is allowed here`, v.pos);
      return undefined;
    default:
      err(`Expected a string, number, boolean or env("NAME")`, v.pos);
      return undefined;
  }
}

// ---- attribute helpers --------------------------------------------------------

function findAttr(attrs: Attribute[], name: string): Attribute | undefined {
  return attrs.find((a) => a.name === name);
}

function mapArg(attrs: Attribute[], name: string, err: Err): string | undefined {
  const a = findAttr(attrs, name);
  if (!a) return undefined;
  const s = stringArg(a, 0, err);
  if (s && s.length > MAX_IDENT) err(`Name '${s}' is longer than ${MAX_IDENT} characters`, a.pos);
  return s;
}

function stringArg(a: Attribute, index: number, err: Err): string | undefined {
  const arg = a.args.filter((x) => !x.name)[index] ?? (index === 0 ? a.args.find((x) => x.name === "name" || x.name === "map") : undefined);
  if (!arg) {
    err(`@${a.name} expects a string argument`, a.pos);
    return undefined;
  }
  return stringValue(arg.value, err);
}

function stringValue(v: Value, err: Err): string | undefined {
  if (v.kind !== "string") {
    err(`Expected a string`, v.pos);
    return undefined;
  }
  return v.value;
}

function identList(v: Value, err: Err): string[] | undefined {
  if (v.kind !== "array" || v.items.some((i) => i.kind !== "ident")) {
    err(`Expected a list of field names like [a, b]`, v.pos);
    return undefined;
  }
  return v.items.map((i) => (i as { name: string }).name);
}

function namedArg(a: Attribute, name: string): string | undefined {
  const arg: Arg | undefined = a.args.find((x) => x.name === name);
  return arg?.value.kind === "string" ? arg.value.value : undefined;
}

function namedMap(a: Attribute): string | undefined {
  return namedArg(a, "map");
}

function fieldListArg(a: Attribute, model: ModelDef, err: Err): string[] | undefined {
  const arg = a.args.find((x) => !x.name || x.name === "fields");
  if (!arg) {
    err(`@@${a.name} expects a list of fields`, a.pos);
    return undefined;
  }
  const list = identList(arg.value, err);
  if (!list) return undefined;
  for (const n of list) {
    const f = model.fields.find((x) => x.name === n);
    if (!f || f.kind === "relation") {
      err(`Unknown field '${n}' in @@${a.name} of '${model.name}'`, a.pos);
      return undefined;
    }
  }
  return list;
}

function columnNames(model: ModelDef, fields: string[]): string[] {
  return fields.map((n) => {
    const f = model.fields.find((x) => x.name === n);
    return f && f.kind !== "relation" ? f.dbName : n;
  });
}

/** Deterministic constraint name, e.g. `UQ_USERS_EMAIL`, trimmed to the HANA identifier limit. */
export function constraintName(prefix: string, table: string, columns: string[]): string {
  const name = [prefix, table, ...columns].join("_");
  if (name.length <= MAX_IDENT) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_IDENT - 9)}_${hash}`;
}

export type { IndexDef, UniqueDef };
