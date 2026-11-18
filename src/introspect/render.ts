/**
 * Physical schema → schema source text (`db pull`).
 *
 * Re-running keeps manual changes: when an existing model maps to an introspected table
 * (matched by `@@map`/`@@schema`), its model name, field names (matched by `@map`), relation
 * field names, relation names, enum/Json field types, doc comments, `@updatedAt` and
 * runtime defaults (`uuid()`, `cuid()`) are kept. `datasource`, `generator`, `enum` blocks
 * and models outside the introspected tables are copied unchanged.
 */

import type { Attribute, FieldDecl, ModelDecl, SchemaAst, Value } from "../schema/ast.ts";
import { parseSchema } from "../schema/parser.ts";
import type { PhysicalColumn, PhysicalForeignKey, PhysicalSchema, PhysicalTable, PhysicalView } from "../migrate/physical.ts";
import { MAX_IDENT_LENGTH, refKeyOf, sameColumns, tableKey } from "../migrate/physical.ts";
import { parseType } from "../migrate/types.ts";
import { splitBlocks } from "./blocks.ts";
import { backRelationName, camelCase, lowerFirst, pascalCase, plural, quoteString, singular, uniqueName, upperFirst } from "./naming.ts";

export interface RenderOptions {
  /** Current schema file text, if any. */
  existingSource?: string;
  existingFile?: string;
  /** Datasource default schema (actual name); models in other schemas get `@@schema`. */
  defaultSchema: string;
  /**
   * Returns true when a table key was part of this introspection run (schema read and not
   * filtered out). Existing models in scope whose table is gone produce a warning.
   */
  inScope?: (key: string) => boolean;
}

export interface RenderResult {
  source: string;
  warnings: string[];
  /** Model names that were added, updated or kept. */
  added: string[];
  updated: string[];
}

// ---- type mapping -------------------------------------------------------------

export interface MappedType {
  /** Scalar type name, or undefined for `Unsupported("...")`. */
  scalar?: string;
  /** `@db.X(args)` attribute text without the `@`, when it differs from the default mapping. */
  native?: string;
  /** Original HANA type for `Unsupported`. */
  raw: string;
}

/** Maps a normalized HANA type to a schema type. */
export function mapHanaType(type: string): MappedType {
  const { name, args } = parseType(type);
  const a = args.length ? `(${args.join(", ")})` : "";
  switch (name) {
    case "NVARCHAR":
      return { scalar: "String", ...(args[0] === 5000 ? {} : { native: `db.NVarChar${a}` }), raw: type };
    case "VARCHAR":
      return { scalar: "String", native: `db.VarChar${a}`, raw: type };
    case "NCHAR":
      return { scalar: "String", native: `db.NChar${a}`, raw: type };
    case "CHAR":
      return { scalar: "String", native: `db.Char${a}`, raw: type };
    case "ALPHANUM":
      return { scalar: "String", native: `db.Alphanum${a}`, raw: type };
    case "NCLOB":
      return { scalar: "String", native: "db.NClob", raw: type };
    case "CLOB":
      return { scalar: "String", native: "db.Clob", raw: type };
    case "TEXT":
      return { scalar: "String", native: "db.Text", raw: type };
    case "INTEGER":
      return { scalar: "Int", raw: type };
    case "SMALLINT":
      return { scalar: "Int", native: "db.SmallInt", raw: type };
    case "TINYINT":
      return { scalar: "Int", native: "db.TinyInt", raw: type };
    case "BIGINT":
      return { scalar: "BigInt", raw: type };
    case "DECIMAL":
      if (args[0] === 38 && args[1] === 10) return { scalar: "Decimal", raw: type };
      return { scalar: "Decimal", native: `db.Decimal${a}`, raw: type };
    case "SMALLDECIMAL":
      return { scalar: "Decimal", native: "db.SmallDecimal", raw: type };
    case "DOUBLE":
      return { scalar: "Float", raw: type };
    case "REAL":
      return { scalar: "Float", native: "db.Real", raw: type };
    case "BOOLEAN":
      return { scalar: "Boolean", raw: type };
    case "TIMESTAMP":
      return { scalar: "DateTime", raw: type };
    case "SECONDDATE":
      return { scalar: "DateTime", native: "db.SecondDate", raw: type };
    case "DATE":
      return { scalar: "DateTime", native: "db.Date", raw: type };
    case "TIME":
      return { scalar: "DateTime", native: "db.Time", raw: type };
    case "BLOB":
      return { scalar: "Bytes", raw: type };
    case "VARBINARY":
      return { scalar: "Bytes", native: `db.VarBinary${a}`, raw: type };
    case "BINARY":
      return { scalar: "Bytes", native: `db.Binary${a}`, raw: type };
    default:
      return { raw: type };
  }
}

/** Same rule as the contract builder: `PK_<TABLE>`, `UQ_<TABLE>_<COLS>`, … trimmed to 127 chars. */
function defaultConstraintName(prefix: string, table: string, columns: string[]): string {
  const name = [prefix, table, ...columns].join("_");
  return name.length <= MAX_IDENT_LENGTH ? name : "";
}

function isSystemName(name: string | undefined): boolean {
  return !name || name.startsWith("_SYS_") || /^SYS_/.test(name);
}

function mapArg(name: string | undefined, prefix: string, table: string, columns: string[]): string {
  if (!name || isSystemName(name) || name === defaultConstraintName(prefix, table, columns)) return "";
  return `map: ${quoteString(name)}`;
}

// ---- existing schema --------------------------------------------------------------

interface ExistingField {
  decl: FieldDecl;
  dbName: string;
  /** The field type names a model or view of the schema. */
  isRelation: boolean;
}

interface ExistingModel {
  decl: ModelDecl;
  key: string;
  fields: ExistingField[];
}

function attr(attrs: readonly Attribute[], name: string): Attribute | undefined {
  return attrs.find((a) => a.name === name);
}

function stringArg(a: Attribute | undefined): string | undefined {
  const v = a?.args.find((x) => !x.name)?.value ?? a?.args.find((x) => x.name === "name" || x.name === "map")?.value;
  return v?.kind === "string" ? v.value : undefined;
}

/** Relation name: first positional string or `name:` (never `map:`, which is the FK name). */
function relationNameArg(a: Attribute | undefined): string | undefined {
  const v = a?.args.find((x) => !x.name)?.value ?? a?.args.find((x) => x.name === "name")?.value;
  return v?.kind === "string" ? v.value : undefined;
}

function identList(v: Value | undefined): string[] {
  return v?.kind === "array" ? v.items.filter((i) => i.kind === "ident").map((i) => (i as { name: string }).name) : [];
}

function existingModels(ast: SchemaAst, defaultSchema: string): ExistingModel[] {
  const out: ExistingModel[] = [];
  const modelNames = new Set(ast.declarations.filter((d) => d.kind === "model" || d.kind === "view").map((d) => d.name));
  for (const d of ast.declarations) {
    if (d.kind !== "model" && d.kind !== "view") continue;
    const dbName = stringArg(attr(d.attributes, "map")) ?? d.name;
    const schema = stringArg(attr(d.attributes, "schema"));
    const key = tableKey(schema && schema !== defaultSchema ? schema : undefined, dbName);
    out.push({
      decl: d,
      key,
      fields: d.fields.map((f) => ({ decl: f, dbName: stringArg(attr(f.attributes, "map")) ?? f.name, isRelation: modelNames.has(f.type) })),
    });
  }
  return out;
}

// ---- rendering --------------------------------------------------------------------

interface FieldLine {
  name: string;
  type: string;
  attrs: string[];
  doc?: string;
}

interface ModelPlan {
  key: string;
  kind: "model" | "view";
  name: string;
  table: PhysicalTable | PhysicalView;
  existing?: ExistingModel;
  /** column name → field name (only columns with a usable field) */
  fieldOf: Map<string, string>;
  taken: Set<string>;
  lines: FieldLine[];
  relationLines: FieldLine[];
  blockAttrs: string[];
}

function formatDefault(col: PhysicalColumn, scalar: string | undefined, enumValues?: { name: string; dbName: string }[]): string | undefined {
  if (col.identity) return "autoincrement()";
  const d = col.default;
  if (d === undefined) return undefined;
  if (d === "CURRENT_UTCTIMESTAMP" && scalar === "DateTime") return "now()";
  const lit = /^'(.*)'$/s.exec(d);
  if (lit) {
    const value = lit[1]!.replace(/''/g, "'");
    if (enumValues) {
      const ev = enumValues.find((v) => v.dbName === value);
      if (ev) return ev.name;
    }
    if (scalar === "String" || scalar === "DateTime" || scalar === "Decimal" || scalar === "BigInt" || scalar === "Json") return quoteString(value);
  }
  if (/^[+-]?\d+(\.\d+)?$/.test(d) && (scalar === "Int" || scalar === "BigInt" || scalar === "Float" || scalar === "Decimal")) {
    if (scalar === "BigInt" && !Number.isSafeInteger(Number(d))) return quoteString(d);
    return d;
  }
  if ((d === "TRUE" || d === "FALSE") && scalar === "Boolean") return d.toLowerCase();
  return `dbgenerated(${quoteString(d)})`;
}

function fieldLineText(f: FieldLine, nameWidth: number, typeWidth: number): string {
  const parts = [`  ${f.name.padEnd(nameWidth)} ${f.attrs.length ? f.type.padEnd(typeWidth) : f.type}`];
  if (f.attrs.length) parts.push(` ${f.attrs.join(" ")}`);
  const doc = f.doc ? `${f.doc.split("\n").map((l) => `  ///${l.startsWith(" ") || !l ? l : ` ${l}`}`).join("\n")}\n` : "";
  return doc + parts.join("").trimEnd();
}

function docText(doc: string | undefined, indent = ""): string {
  if (!doc) return "";
  return `${doc
    .split("\n")
    .map((l) => `${indent}///${l.startsWith(" ") || !l ? l : ` ${l}`}`)
    .join("\n")}\n`;
}

export function renderSchema(physical: PhysicalSchema, options: RenderOptions): RenderResult {
  const warnings: string[] = [];
  const { defaultSchema } = options;
  const source = options.existingSource ?? "";
  const ast: SchemaAst = source.trim() ? parseSchema(source, options.existingFile) : { declarations: [] };
  const split = splitBlocks(source);
  const existing = existingModels(ast, defaultSchema);
  const enums = new Map(
    ast.declarations
      .filter((d) => d.kind === "enum")
      .map((e) => [e.name, e.values.map((v) => ({ name: v.name, dbName: stringArg(attr(v.attributes, "map")) ?? v.name }))]),
  );

  const targets = new Map<string, { kind: "model" | "view"; table: PhysicalTable | PhysicalView }>();
  for (const [k, t] of Object.entries(physical.tables)) targets.set(k, { kind: "model", table: t });
  for (const [k, v] of Object.entries(physical.views ?? {})) if (!targets.has(k)) targets.set(k, { kind: "view", table: v });

  // ---- model names ----
  const takenModelNames = new Set<string>(enums.keys());
  const plans = new Map<string, ModelPlan>();
  const kept: ExistingModel[] = [];
  for (const em of existing) {
    takenModelNames.add(em.decl.name);
    if (targets.has(em.key) && !plans.has(em.key)) {
      const t = targets.get(em.key)!;
      plans.set(em.key, newPlan(em.key, t.kind, em.decl.name, t.table, em));
    } else {
      kept.push(em);
      if (options.inScope?.(em.key)) warnings.push(`Model '${em.decl.name}' maps to '${em.key}', which was not found in the database; the model was kept unchanged.`);
    }
  }
  const newKeys = [...targets.keys()].filter((k) => !plans.has(k)).sort();
  const newPlans: ModelPlan[] = [];
  for (const k of newKeys) {
    const t = targets.get(k)!;
    let base = pascalCase(t.table.name);
    if (t.table.schema && takenModelNames.has(base)) base = pascalCase(t.table.schema) + base;
    const plan = newPlan(k, t.kind, uniqueName(base, takenModelNames), t.table);
    plans.set(k, plan);
    newPlans.push(plan);
  }

  // ---- scalar fields ----
  for (const plan of plans.values()) buildColumns(plan, enums, warnings);

  // ---- relations ----
  const joins = takeJoinTables(plans, warnings);
  buildRelations(plans, warnings);
  buildManyToMany(joins, plans);

  // ---- assemble ----
  const out: string[] = [];
  if (split.preamble) out.push(split.preamble);
  if (!split.blocks.some((b) => b.keyword === "datasource")) out.push('datasource db {\n  provider = "hana"\n}');
  const emitted = new Set<string>();
  const updated: string[] = [];
  for (const b of split.blocks) {
    if (b.keyword === "model" || b.keyword === "view") {
      const em = existing.find((e) => e.decl.name === b.name);
      const plan = em ? [...plans.values()].find((p) => p.existing === em) : undefined;
      if (plan && !emitted.has(plan.key)) {
        out.push(renderModel(plan, defaultSchema));
        emitted.add(plan.key);
        updated.push(plan.name);
        continue;
      }
    }
    out.push(b.text.trim());
  }
  const ordered = [...newPlans.filter((x) => x.kind === "model"), ...newPlans.filter((x) => x.kind === "view")];
  for (const p of ordered) out.push(renderModel(p, defaultSchema));
  return { source: `${out.join("\n\n")}\n`, warnings, added: ordered.map((p) => p.name), updated };
}

function newPlan(key: string, kind: "model" | "view", name: string, table: PhysicalTable | PhysicalView, existing?: ExistingModel): ModelPlan {
  return { key, kind, name, table, ...(existing ? { existing } : {}), fieldOf: new Map(), taken: new Set(), lines: [], relationLines: [], blockAttrs: [] };
}

function buildColumns(plan: ModelPlan, enums: Map<string, { name: string; dbName: string }[]>, warnings: string[]): void {
  const t = plan.table;
  const isTable = plan.kind === "model" && "primaryKey" in t;
  const table = isTable ? (t as PhysicalTable) : undefined;
  const pk = table?.primaryKey ?? null;
  // existing field names that stay reserved (relation fields are re-assigned later)
  const existingByCol = new Map<string, ExistingField>();
  for (const f of plan.existing?.fields ?? []) {
    if (!f.isRelation) existingByCol.set(f.dbName, f);
  }
  for (const f of existingByCol.values()) if (t.columns.some((c) => c.name === f.dbName)) plan.taken.add(f.decl.name);

  for (const col of t.columns) {
    const ex = existingByCol.get(col.name);
    const name = ex ? ex.decl.name : uniqueName(camelCase(col.name), plan.taken);
    if (ex) plan.taken.add(name);
    const mapped = mapHanaType(col.type);
    let type: string;
    let native = mapped.native;
    let enumValues: { name: string; dbName: string }[] | undefined;
    if (!mapped.scalar) {
      type = `Unsupported(${quoteString(mapped.raw)})`;
      native = undefined;
      warnings.push(`Column '${plan.key}.${col.name}' has type ${mapped.raw}, which is not supported; it is emitted as Unsupported and hidden from the client.`);
    } else if (ex && enums.has(ex.decl.type) && mapped.scalar === "String") {
      type = ex.decl.type;
      enumValues = enums.get(ex.decl.type);
      native = col.type === "NVARCHAR(255)" ? undefined : native ?? `db.NVarChar(5000)`;
    } else if (ex && ex.decl.type === "Json" && col.type === "NCLOB") {
      type = "Json";
      native = undefined;
    } else type = mapped.scalar;
    if (mapped.scalar) plan.fieldOf.set(col.name, name);

    const attrs: string[] = [];
    const single = (cols: string[]): boolean => cols.length === 1 && cols[0] === col.name;
    if (pk && single(pk.columns)) {
      const m = mapArg(pk.name, "PK", t.name, []);
      attrs.push(m ? `@id(${m})` : "@id");
    }
    let dflt = formatDefault(col, mapped.scalar, enumValues);
    if (!dflt && ex) {
      const exDefault = attr(ex.decl.attributes, "default")?.args[0]?.value;
      if (exDefault?.kind === "call" && (exDefault.name === "uuid" || exDefault.name === "cuid")) dflt = `${exDefault.name}()`;
    }
    if (dflt) attrs.push(`@default(${dflt})`);
    const uq = table?.uniques.find((u) => single(u.columns));
    if (uq) {
      const m = mapArg(uq.name, "UQ", t.name, [col.name]);
      attrs.push(m ? `@unique(${m})` : "@unique");
    }
    if (ex && attr(ex.decl.attributes, "updatedAt")) attrs.push("@updatedAt");
    if (ex && attr(ex.decl.attributes, "ignore")) attrs.push("@ignore");
    if (name !== col.name) attrs.push(`@map(${quoteString(col.name)})`);
    if (native) attrs.push(`@${native}`);
    const optional = col.nullable && !(pk && pk.columns.includes(col.name));
    plan.lines.push({ name, type: `${type}${optional ? "?" : ""}`, attrs, ...(ex?.decl.doc ? { doc: ex.decl.doc } : {}) });
  }

  if (table) {
    const fieldsOf = (cols: string[]): string | undefined => {
      const names = cols.map((c) => plan.fieldOf.get(c));
      if (names.some((n) => !n)) return undefined;
      return `[${names.join(", ")}]`;
    };
    if (pk && pk.columns.length > 1) {
      const f = fieldsOf(pk.columns);
      if (f) {
        const m = mapArg(pk.name, "PK", t.name, []);
        plan.blockAttrs.push(`@@id(${f}${m ? `, ${m}` : ""})`);
      } else warnings.push(`Primary key of '${plan.key}' uses an unsupported column; @@id was left out.`);
    }
    for (const u of [...table.uniques].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (u.columns.length === 1) continue; // rendered as @unique on the field
      const f = fieldsOf(u.columns);
      if (!f) {
        warnings.push(`Unique constraint '${u.name}' on '${plan.key}' uses an unsupported column; it was left out.`);
        continue;
      }
      const m = mapArg(u.name, "UQ", t.name, u.columns);
      plan.blockAttrs.push(`@@unique(${f}${m ? `, ${m}` : ""})`);
    }
    for (const i of [...table.indexes].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = fieldsOf(i.columns);
      if (!f) {
        warnings.push(`Index '${i.name}' on '${plan.key}' uses an unsupported column; it was left out.`);
        continue;
      }
      const m = mapArg(i.name, "IX", t.name, i.columns);
      plan.blockAttrs.push(`@@index(${f}${m ? `, ${m}` : ""})`);
    }
    for (const x of [...(table.fulltext ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = fieldsOf([x.column]);
      if (!f) {
        warnings.push(`Full-text index '${x.name}' on '${plan.key}' uses an unsupported column; it was left out.`);
        continue;
      }
      const m = mapArg(x.name, "FTI", t.name, [x.column]);
      plan.blockAttrs.push(`@@fulltext(${f}${m ? `, ${m}` : ""})`);
    }
  }
}

interface RelationInfo {
  owner: ModelPlan;
  target: ModelPlan;
  fk: PhysicalForeignKey;
  ownerFields: string[];
  targetFields: string[];
}

function buildRelations(plans: Map<string, ModelPlan>, warnings: string[]): void {
  const rels: RelationInfo[] = [];
  for (const owner of [...plans.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (owner.kind !== "model") continue;
    const t = owner.table as PhysicalTable;
    for (const fk of [...t.foreignKeys].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const target = plans.get(refKeyOf(fk));
      if (!target || target.kind !== "model") {
        warnings.push(`Foreign key '${fk.name}' on '${owner.key}' references '${refKeyOf(fk)}', which is not part of this pull; no relation field was added.`);
        continue;
      }
      const ownerFields = fk.columns.map((c) => owner.fieldOf.get(c));
      const targetFields = fk.refColumns.map((c) => target.fieldOf.get(c));
      if (ownerFields.some((x) => !x) || targetFields.some((x) => !x)) {
        warnings.push(`Foreign key '${fk.name}' on '${owner.key}' uses an unsupported column; no relation field was added.`);
        continue;
      }
      rels.push({ owner, target, fk, ownerFields: ownerFields as string[], targetFields: targetFields as string[] });
    }
  }
  const pairCount = new Map<string, number>();
  const pairKey = (a: string, b: string): string => [a, b].sort().join("\u0000");
  for (const r of rels) pairCount.set(pairKey(r.owner.key, r.target.key), (pairCount.get(pairKey(r.owner.key, r.target.key)) ?? 0) + 1);

  const existingRel = (plan: ModelPlan): FieldDecl[] => (plan.existing?.fields ?? []).filter((f) => f.isRelation).map((f) => f.decl);
  const usedExisting = new Set<FieldDecl>();

  for (const r of rels) {
    const { owner, target, fk } = r;
    const self = owner === target;
    const needsName = self || (pairCount.get(pairKey(owner.key, target.key)) ?? 0) > 1;

    // owner side
    const exOwner = existingRel(owner).find((f) => {
      if (usedExisting.has(f) || f.type !== target.name) return false;
      const rel = attr(f.attributes, "relation");
      const fields = identList(rel?.args.find((a) => a.name === "fields")?.value);
      return sameColumns(fields, r.ownerFields);
    });
    let relationName: string | undefined;
    let ownerName: string;
    if (exOwner) {
      usedExisting.add(exOwner);
      ownerName = exOwner.name;
      owner.taken.add(ownerName);
      relationName = relationNameArg(attr(exOwner.attributes, "relation"));
    } else {
      const field = r.ownerFields.length === 1 ? r.ownerFields[0]! : "";
      let base = field.replace(/(_id|Id|ID|_ID)$/, "");
      // Several FKs to the same model: a column without an id suffix (`CREATED_BY`) gives
      // `createdByUser` instead of `users`, `users2`, …
      if (needsName && field && (base === field || owner.taken.has(base))) base = `${field}${upperFirst(singular(target.name))}`;
      if (!base || base === field || owner.taken.has(base)) base = lowerFirst(target.name);
      ownerName = uniqueName(base, owner.taken);
    }
    if (!relationName && needsName) relationName = `${owner.name}_${ownerName}`;

    const optional = fk.columns.some((c) => (owner.table as PhysicalTable).columns.find((x) => x.name === c)?.nullable);
    const relArgs: string[] = [];
    if (relationName) relArgs.push(quoteString(relationName));
    relArgs.push(`fields: [${r.ownerFields.join(", ")}]`, `references: [${r.targetFields.join(", ")}]`);
    if (fk.onDelete !== "RESTRICT") relArgs.push(`onDelete: ${actionName(fk.onDelete)}`);
    if (fk.onUpdate !== "RESTRICT") relArgs.push(`onUpdate: ${actionName(fk.onUpdate)}`);
    const m = mapArg(fk.name, "FK", owner.table.name, fk.columns);
    if (m) relArgs.push(m);

    // back side
    const ownerTable = owner.table as PhysicalTable;
    const oneToOne =
      (ownerTable.primaryKey && sameColumns([...ownerTable.primaryKey.columns].sort(), [...fk.columns].sort())) ||
      ownerTable.uniques.some((u) => sameColumns([...u.columns].sort(), [...fk.columns].sort()));
    const exBack = existingRel(target).find((f) => {
      if (usedExisting.has(f) || f.type !== owner.name || attr(f.attributes, "relation")?.args.some((a) => a.name === "fields")) return false;
      const n = relationNameArg(attr(f.attributes, "relation"));
      return relationName ? n === relationName : n === undefined;
    });
    let backName: string;
    if (exBack) {
      usedExisting.add(exBack);
      backName = exBack.name;
      target.taken.add(backName);
    } else {
      const ownerLower = lowerFirst(owner.name);
      const base = self
        ? `${ownerName}${upperFirst(oneToOne ? owner.name : plural(owner.name))}`
        : needsName
          ? backRelationName(ownerName, owner.name, target.name, oneToOne)
          : oneToOne
            ? ownerLower
            : plural(ownerLower);
      backName = uniqueName(base, target.taken);
    }
    // Keep @ignore from the existing schema. A relation must be ignored when it touches an
    // @@ignore model or an ignored foreign key field, and both sides are ignored together.
    const ignored =
      !!(exOwner && attr(exOwner.attributes, "ignore")) ||
      !!(exBack && attr(exBack.attributes, "ignore")) ||
      modelIgnored(owner) ||
      modelIgnored(target) ||
      owner.lines.some((l) => r.ownerFields.includes(l.name) && l.attrs.includes("@ignore"));
    const ignoreAttr = (plan: ModelPlan): string[] => (ignored && !modelIgnored(plan) ? ["@ignore"] : []);
    owner.relationLines.push({ name: ownerName, type: `${target.name}${optional ? "?" : ""}`, attrs: [...ignoreAttr(owner), `@relation(${relArgs.join(", ")})`], ...(exOwner?.doc ? { doc: exOwner.doc } : {}) });
    target.relationLines.push({
      name: backName,
      type: oneToOne ? `${owner.name}?` : `${owner.name}[]`,
      attrs: [...ignoreAttr(target), ...(relationName ? [`@relation(${quoteString(relationName)})`] : [])],
      ...(exBack?.doc ? { doc: exBack.doc } : {}),
    });
  }
}

interface JoinTable {
  relationName: string;
  a: ModelPlan;
  b: ModelPlan;
}

/**
 * Finds join tables of implicit many-to-many relations (Prisma's layout: `_<Name>` with
 * columns `A` and `B`, a foreign key from each to a single-column primary key, and a primary
 * key or unique on both) and removes them from `plans`. `A` must reference the model whose name
 * sorts first, as the schema builder expects; other tables stay models.
 */
function takeJoinTables(plans: Map<string, ModelPlan>, warnings: string[]): JoinTable[] {
  const joins: JoinTable[] = [];
  for (const [key, plan] of [...plans.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (plan.kind !== "model" || plan.existing) continue;
    const t = plan.table as PhysicalTable;
    if (!t.name.startsWith("_") || t.name.length < 2) continue;
    const cols = t.columns.map((c) => c.name).sort();
    if (cols.join(",") !== "A,B" || t.foreignKeys.length !== 2) continue;
    const both = (columns: readonly string[]) => sameColumns([...columns].sort(), ["A", "B"]);
    if (!(t.primaryKey && both(t.primaryKey.columns)) && !t.uniques.some((u) => both(u.columns))) continue;
    const fkOf = (col: string) => t.foreignKeys.find((fk) => fk.columns.length === 1 && fk.columns[0] === col);
    const fkA = fkOf("A");
    const fkB = fkOf("B");
    if (!fkA || !fkB) continue;
    const a = plans.get(refKeyOf(fkA));
    const b = plans.get(refKeyOf(fkB));
    const singleKey = (p: ModelPlan | undefined, fk: PhysicalForeignKey) => {
      const pk = p && p.kind === "model" ? (p.table as PhysicalTable).primaryKey : null;
      return !!pk && pk.columns.length === 1 && fk.refColumns.length === 1 && pk.columns[0] === fk.refColumns[0];
    };
    if (!a || !b || a === plan || b === plan || !singleKey(a, fkA) || !singleKey(b, fkB)) continue;
    if (a !== b && a.name > b.name) {
      warnings.push(`Table '${key}' looks like a many-to-many join table, but column A references '${a.name}', which sorts after '${b.name}'; it was kept as a model.`);
      continue;
    }
    plans.delete(key);
    joins.push({ relationName: t.name.slice(1), a, b });
  }
  return joins;
}

/** Adds the two list fields of each implicit many-to-many relation. */
function buildManyToMany(joins: JoinTable[], plans: Map<string, ModelPlan>): void {
  for (const { relationName, a, b } of joins) {
    if (![...plans.values()].includes(a) || ![...plans.values()].includes(b)) continue;
    const self = a === b;
    const named = self || relationName !== [a.name, b.name].sort().join("To");
    const attrs = named ? [`@relation(${quoteString(relationName)})`] : [];
    // existing list fields of this relation keep their names
    const existing = (plan: ModelPlan, type: string): string[] =>
      (plan.existing?.decl.fields ?? [])
        .filter((f) => f.type === type && f.list && !attr(f.attributes, "relation")?.args.some((x) => x.name === "fields"))
        .filter((f) => (relationNameArg(attr(f.attributes, "relation")) ?? [a.name, b.name].sort().join("To")) === relationName)
        .map((f) => f.name)
        .filter((n) => !plan.taken.has(n))
        .sort();
    if (self) {
      // the field whose name sorts first is the A side; both sides are on the same model
      const names = existing(a, a.name);
      const first = names[0] ?? uniqueName(`${lowerFirst(relationName)}A`, a.taken);
      if (names[0]) a.taken.add(first);
      const second = names[1] ?? uniqueName(`${lowerFirst(relationName)}B`, a.taken);
      if (names[1]) a.taken.add(second);
      for (const name of [first, second].sort()) a.relationLines.push({ name, type: `${a.name}[]`, attrs });
      continue;
    }
    const nameOn = (plan: ModelPlan, other: ModelPlan) => {
      const ex = existing(plan, other.name)[0];
      if (ex) {
        plan.taken.add(ex);
        return ex;
      }
      return uniqueName(plural(lowerFirst(other.name)), plan.taken);
    };
    a.relationLines.push({ name: nameOn(a, b), type: `${b.name}[]`, attrs });
    b.relationLines.push({ name: nameOn(b, a), type: `${a.name}[]`, attrs });
  }
}

function modelIgnored(plan: ModelPlan): boolean {
  return !!plan.existing && !!attr(plan.existing.decl.attributes, "ignore");
}

function actionName(a: string): string {
  return a === "CASCADE" ? "Cascade" : a === "SET NULL" ? "SetNull" : a === "SET DEFAULT" ? "SetDefault" : "Restrict";
}

function renderModel(plan: ModelPlan, defaultSchema: string): string {
  const t = plan.table;
  const lines = [...plan.lines, ...plan.relationLines];
  const nameWidth = Math.max(0, ...lines.map((l) => l.name.length));
  const typeWidth = Math.max(0, ...lines.map((l) => l.type.length));
  const body = lines.map((l) => fieldLineText(l, nameWidth, typeWidth));
  const block = [...plan.blockAttrs];
  if (t.name !== plan.name) block.push(`@@map(${quoteString(t.name)})`);
  const schema = t.schema ?? undefined;
  if (schema && schema !== defaultSchema) block.push(`@@schema(${quoteString(schema)})`);
  if (modelIgnored(plan)) block.push("@@ignore");
  const head: string[] = [];
  const doc = plan.existing?.decl.doc ?? ("comment" in t && t.comment ? t.comment : undefined);
  if (plan.kind === "model" && !(t as PhysicalTable).primaryKey) head.push("// This table has no primary key; the client treats it as read-only.");
  const parts = [`${head.length ? `${head.join("\n")}\n` : ""}${docText(doc)}${plan.kind} ${plan.name} {`, ...body];
  if (block.length) {
    if (body.length) parts.push("");
    parts.push(...block.map((b) => `  ${b}`));
  }
  parts.push("}");
  return parts.join("\n");
}
