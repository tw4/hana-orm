import { DECIMAL_MODES, type DecimalMode } from "../runtime/codec.ts";
import { clientContract, columnFields, relationFields, type ColumnFieldDef, type Contract, type ModelDef, type RelationFieldDef } from "../schema/contract.ts";

export interface GenerateOptions {
  /** Module the generated code imports the runtime from (default `hana-orm/runtime`). */
  runtimeImport?: string;
  /** Name of the generated client class (default `HanaClient`). */
  clientName?: string;
  /** How Decimal fields are typed and returned (default "string"). */
  decimal?: DecimalMode;
}

/** Type of a Decimal value in the generated code, per mode (the generator sets it). */
let decimalType = "$r.Decimal";
let decimalInput = "$r.Decimal | number";

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function outputType(contract: Contract, f: ColumnFieldDef): string {
  if (f.kind === "enum") return f.type;
  switch (f.type) {
    case "String":
      return "string";
    case "Int":
    case "Float":
      return "number";
    case "BigInt":
      return "bigint";
    case "Decimal":
      return decimalType;
    case "Boolean":
      return "boolean";
    case "DateTime":
      return "Date";
    case "Bytes":
      return "Buffer";
    case "Json":
      return "$r.JsonValue";
  }
  void contract;
}

function inputType(contract: Contract, f: ColumnFieldDef): string {
  if (f.kind === "scalar") {
    if (f.type === "BigInt") return "bigint | number";
    if (f.type === "Decimal") return decimalInput;
    if (f.type === "DateTime") return "Date | string";
    if (f.type === "Bytes") return "Buffer | Uint8Array";
  }
  return outputType(contract, f);
}

function isNumeric(f: ColumnFieldDef): boolean {
  return f.kind === "scalar" && ["Int", "BigInt", "Float", "Decimal"].includes(f.type);
}

function filterType(contract: Contract, f: ColumnFieldDef): string {
  const t = inputType(contract, f);
  const n = f.optional;
  if (f.kind === "scalar") {
    if (f.type === "String") return n ? `string | $r.Placeholder | null | $r.StringNullableFilter` : `string | $r.Placeholder | $r.StringFilter`;
    if (f.type === "Boolean") return n ? `boolean | $r.Placeholder | null | $r.BoolNullableFilter` : `boolean | $r.Placeholder | $r.BoolFilter`;
    if (f.type === "Json") return `$r.JsonFilter`;
  }
  // placeholder("x") may stand for a value in prepared queries
  const tp = `${t} | $r.Placeholder`;
  return n ? `${tp} | null | $r.NullableFilter<${tp}>` : `${tp} | $r.Filter<${tp}>`;
}

function doc(text: string | undefined, indent = ""): string {
  if (!text) return "";
  return `${indent}/** ${text.split("\n").join(`\n${indent} * `)} */\n`;
}

function hasDefault(f: ColumnFieldDef): boolean {
  return f.default !== undefined || (f.kind === "scalar" && f.updatedAt);
}

/** Foreign key fields of `model` (set through relations, so optional in create input). */
function fkFields(model: ModelDef): Set<string> {
  const s = new Set<string>();
  for (const r of relationFields(model)) if (r.owner) for (const f of r.localFields) s.add(f);
  return s;
}

function uniqueCombos(model: ModelDef): { key: string; fields: string[] }[] {
  const out: { key: string; fields: string[] }[] = [];
  if (model.primaryKey) out.push({ key: model.primaryKey.name, fields: model.primaryKey.fields });
  for (const u of model.uniques) if (!out.some((o) => o.key === u.name)) out.push({ key: u.name, fields: u.fields });
  return out;
}

function relationPayload(r: RelationFieldDef, value: string): string {
  const p = `${r.model}GetPayload<${value}, G>`;
  if (r.list) return `${p}[]`;
  return r.owner && !r.optional ? p : `${p} | null`;
}

function modelTypes(contract: Contract, m: ModelDef): string {
  const M = m.name;
  const cols = columnFields(m);
  const rels = relationFields(m);
  const lists = rels.filter((r) => r.list);
  const fks = fkFields(m);
  const readOnly = m.kind === "view" || (!m.primaryKey && !m.uniques.length);
  const L: string[] = [];

  // model type
  L.push(doc(m.doc) + `export type ${M} = {`);
  for (const f of cols) L.push(doc(f.doc, "  ") + `  ${f.name}: ${outputType(contract, f)}${f.optional ? " | null" : ""};`);
  L.push("};", "");

  // where
  L.push(`export type ${M}WhereInput = {`);
  // an sql`...` fragment can stand for a condition (issue #31)
  const W = `${M}WhereInput | $r.SQL<unknown>`;
  L.push(`  AND?: ${W} | (${W})[];`, `  OR?: (${W})[];`, `  NOT?: ${W} | (${W})[];`);
  for (const f of cols) L.push(`  ${f.name}?: ${filterType(contract, f)};`);
  for (const r of rels) {
    const T = r.model;
    const TW = `${T}WhereInput | $r.SQL<unknown>`;
    if (r.list) L.push(`  ${r.name}?: { some?: ${TW}; every?: ${TW}; none?: ${TW} };`);
    else L.push(`  ${r.name}?: ${TW} | null | { is?: ${TW} | null; isNot?: ${TW} | null };`);
  }
  L.push("};", "");

  const combos = uniqueCombos(m);
  if (combos.length) {
    const alts = combos.map((c) =>
      c.fields.length === 1
        ? `{ ${c.fields[0]}: ${inputType(contract, m.fields.find((x) => x.name === c.fields[0]) as ColumnFieldDef)} | $r.Placeholder }`
        : `{ ${c.key}: { ${c.fields.map((n) => `${n}: ${inputType(contract, m.fields.find((x) => x.name === n) as ColumnFieldDef)} | $r.Placeholder`).join("; ")} } }`,
    );
    L.push(`export type ${M}WhereUniqueInput = ${M}WhereInput & (${alts.join(" | ")});`, "");
  } else {
    L.push(`export type ${M}WhereUniqueInput = ${M}WhereInput;`, "");
  }

  // order by
  L.push(`export type ${M}OrderByInput = {`);
  for (const f of cols) L.push(`  ${f.name}?: $r.SortOrder | $r.SortOrderInput;`);
  for (const r of rels) L.push(r.list ? `  ${r.name}?: { _count?: $r.SortOrder };` : `  ${r.name}?: ${r.model}OrderByInput;`);
  L.push("};", "");

  // select / include
  const countSelect = lists.length ? `{ ${lists.map((r) => `${r.name}?: boolean`).join("; ")} }` : "{}";
  L.push(`export type ${M}CountOutput = { ${lists.map((r) => `${r.name}: number`).join("; ")} };`);
  L.push(`export type ${M}Select = {`);
  for (const f of cols) L.push(`  ${f.name}?: boolean;`);
  for (const r of rels) L.push(`  ${r.name}?: boolean | ${r.list ? `${r.model}FindManyArgs` : `${r.model}DefaultArgs`};`);
  if (lists.length) L.push(`  _count?: boolean | { select?: ${countSelect} };`);
  L.push("};");
  L.push(`export type ${M}Include = {`);
  for (const r of rels) L.push(`  ${r.name}?: boolean | ${r.list ? `${r.model}FindManyArgs` : `${r.model}DefaultArgs`};`);
  if (lists.length) L.push(`  _count?: boolean | { select?: ${countSelect} };`);
  L.push("};");
  L.push(`/** Fields to leave out of results (\`true\`), or to bring back when the client omits them by default (\`false\`). */`);
  L.push(`export type ${M}Omit = { ${cols.map((f) => `${f.name}?: boolean`).join("; ")} };`);
  L.push(`export type ${M}DefaultArgs = { select?: ${M}Select | null; include?: ${M}Include | null; omit?: ${M}Omit | null };`, "");

  // payload (G is the client-wide omit config)
  const mapping = (src: string) => {
    const branches = rels.map((r) => `K extends "${r.name}" ? ${relationPayload(r, `${src}[K]`)}`);
    if (lists.length) branches.push(`K extends "_count" ? $r.CountPayload<${src}[K], ${M}CountOutput>`);
    branches.push(`K extends keyof ${M} ? ${M}[K]`);
    return `{ [K in $r.SelectedKeys<${src}>]: ${branches.join(" : ")} : never }`;
  };
  const base = `$r.OmitFields<${M}, A, $r.ModelOmit<G, "${lowerFirst(M)}">>`;
  L.push(`export type ${M}GetPayload<A, G = {}> = A extends { select: infer S }`);
  L.push(`  ? S extends object ? $r.Simplify<${mapping("S")}> : ${base}`);
  L.push(`  : A extends { include: infer I }`);
  L.push(`    ? I extends object ? $r.Simplify<${base} & ${mapping("I")}> : ${base}`);
  L.push(`    : ${base};`, "");

  // args
  L.push(`export type ${M}FindManyArgs = {`);
  L.push(`  where?: ${M}WhereInput | $r.SQL<unknown>;`, `  select?: ${M}Select | null;`, `  include?: ${M}Include | null;`, `  omit?: ${M}Omit | null;`);
  L.push(`  orderBy?: ${M}OrderByInput | ${M}OrderByInput[];`, `  cursor?: ${M}WhereUniqueInput;`, `  take?: number;`, `  skip?: number;`);
  L.push(`  /** One row per distinct combination of these fields (the first one in \`orderBy\` order). */`);
  L.push(`  distinct?: ${M}ScalarField | ${M}ScalarField[];`);
  L.push("};");
  L.push(`export type ${M}FindUniqueArgs = { where: ${M}WhereUniqueInput; select?: ${M}Select | null; include?: ${M}Include | null; omit?: ${M}Omit | null };`);
  L.push(`export type ${M}CountArgs = { where?: ${M}WhereInput | $r.SQL<unknown>; orderBy?: ${M}OrderByInput | ${M}OrderByInput[]; cursor?: ${M}WhereUniqueInput; take?: number; skip?: number; select?: { _all?: boolean } & { [K in keyof ${M}]?: boolean } };`);
  const numeric = cols.filter(isNumeric).map((f) => `${f.name}?: true`).join("; ");
  const all = cols.map((f) => `${f.name}?: true`).join("; ");
  L.push(`export type ${M}AggregateArgs = {`);
  L.push(`  where?: ${M}WhereInput | $r.SQL<unknown>; orderBy?: ${M}OrderByInput | ${M}OrderByInput[]; cursor?: ${M}WhereUniqueInput; take?: number; skip?: number;`);
  L.push(`  _count?: true | { _all?: true; ${all} }; _sum?: { ${numeric} }; _avg?: { ${numeric} }; _min?: { ${all} }; _max?: { ${all} };`);
  L.push("};");
  L.push(`export type ${M}ScalarField = ${cols.map((f) => `"${f.name}"`).join(" | ") || "never"};`);
  const numericCols = cols.filter(isNumeric);
  const countFilter = `number | $r.Filter<number>`;
  L.push(`/** groupBy \`having\`: filters on \`by\` fields and on aggregates of each group. */`);
  L.push(`export type ${M}HavingInput = {`);
  L.push(`  AND?: ${M}HavingInput | ${M}HavingInput[];`, `  OR?: ${M}HavingInput[];`, `  NOT?: ${M}HavingInput | ${M}HavingInput[];`);
  for (const f of cols) L.push(`  ${f.name}?: ${filterType(contract, f)};`);
  L.push(`  _count?: { _all?: ${countFilter}; ${cols.map((f) => `${f.name}?: ${countFilter}`).join("; ")} };`);
  L.push(`  _sum?: { ${numericCols.map((f) => `${f.name}?: ${filterType(contract, { ...f, optional: true })}`).join("; ")} };`);
  L.push(`  _avg?: { ${numericCols.map((f) => `${f.name}?: number | null | $r.NullableFilter<number>`).join("; ")} };`);
  L.push(`  _min?: { ${cols.map((f) => `${f.name}?: ${filterType(contract, { ...f, optional: true })}`).join("; ")} };`);
  L.push(`  _max?: { ${cols.map((f) => `${f.name}?: ${filterType(contract, { ...f, optional: true })}`).join("; ")} };`);
  L.push("};");
  const sort = (fs: ColumnFieldDef[]) => fs.map((f) => `${f.name}?: $r.SortOrder | $r.SortOrderInput`).join("; ");
  L.push(`/** groupBy \`orderBy\`: \`by\` fields and aggregates of each group. */`);
  L.push(`export type ${M}GroupByOrderByInput = {`);
  for (const f of cols) L.push(`  ${f.name}?: $r.SortOrder | $r.SortOrderInput;`);
  L.push(`  _count?: { _all?: $r.SortOrder; ${sort(cols)} };`);
  L.push(`  _sum?: { ${sort(numericCols)} };`, `  _avg?: { ${sort(numericCols)} };`, `  _min?: { ${sort(cols)} };`, `  _max?: { ${sort(cols)} };`);
  L.push("};");
  L.push(
    `export type ${M}GroupByArgs = Omit<${M}AggregateArgs, "cursor" | "orderBy"> & { by: ${M}ScalarField | ${M}ScalarField[]; having?: ${M}HavingInput; orderBy?: ${M}GroupByOrderByInput | ${M}GroupByOrderByInput[] };`,
    "",
  );

  // Nested createMany rows: the foreign key back to the parent is filled in by the runtime.
  const nestedMany = (r: RelationFieldDef) => {
    const keys = r.targetFields.map((f) => JSON.stringify(f)).join(" | ");
    return keys ? `$r.OptionalKeys<${r.model}CreateManyInput, ${keys}>` : `${r.model}CreateManyInput`;
  };

  // implicit many-to-many relations have no createMany (rows must be linked one by one)
  const nestedCreateMany = (r: RelationFieldDef) =>
    r.through ? "" : `createMany?: { data: ${nestedMany(r)} | ${nestedMany(r)}[]; skipDuplicates?: boolean }; `;

  // create / update inputs
  if (!readOnly || m.kind !== "view") {
    L.push(`export type ${M}CreateInput = {`);
    for (const f of cols) {
      const optional = f.optional || hasDefault(f) || fks.has(f.name);
      L.push(`  ${f.name}${optional ? "?" : ""}: ${inputType(contract, f)}${f.optional ? " | null" : ""};`);
    }
    for (const r of rels) {
      const T = r.model;
      if (r.list) {
        L.push(
          `  ${r.name}?: { create?: ${T}CreateInput | ${T}CreateInput[]; ${nestedCreateMany(r)}connect?: ${T}WhereUniqueInput | ${T}WhereUniqueInput[]; connectOrCreate?: { where: ${T}WhereUniqueInput; create: ${T}CreateInput } | { where: ${T}WhereUniqueInput; create: ${T}CreateInput }[] };`,
        );
      } else {
        L.push(`  ${r.name}?: { create?: ${T}CreateInput; connect?: ${T}WhereUniqueInput; connectOrCreate?: { where: ${T}WhereUniqueInput; create: ${T}CreateInput } };`);
      }
    }
    L.push("};");
    L.push(`export type ${M}CreateManyInput = {`);
    for (const f of cols) {
      const optional = f.optional || hasDefault(f);
      L.push(`  ${f.name}${optional ? "?" : ""}: ${inputType(contract, f)}${f.optional ? " | null" : ""};`);
    }
    L.push("};");

    const updateField = (f: ColumnFieldDef) => {
      const t = inputType(contract, f);
      if (isNumeric(f)) return f.optional ? `$r.NullableNumberUpdate<${t}>` : `$r.NumberUpdate<${t}>`;
      return `$r.SetUpdate<${t}${f.optional ? " | null" : ""}>${f.optional ? " | null" : ""}`;
    };
    L.push(`export type ${M}UpdateManyInput = {`);
    for (const f of cols) L.push(`  ${f.name}?: ${updateField(f)};`);
    L.push("};");
    L.push(`export type ${M}UpdateInput = ${M}UpdateManyInput & {`);
    for (const r of rels) {
      const T = r.model;
      if (r.list) {
        L.push(
          `  ${r.name}?: { create?: ${T}CreateInput | ${T}CreateInput[]; ${nestedCreateMany(r)}connect?: ${T}WhereUniqueInput | ${T}WhereUniqueInput[]; connectOrCreate?: { where: ${T}WhereUniqueInput; create: ${T}CreateInput } | { where: ${T}WhereUniqueInput; create: ${T}CreateInput }[]; set?: ${T}WhereUniqueInput[]; disconnect?: ${T}WhereUniqueInput | ${T}WhereUniqueInput[]; delete?: ${T}WhereUniqueInput | ${T}WhereUniqueInput[]; deleteMany?: ${T}WhereInput | ${T}WhereInput[]; update?: { where: ${T}WhereUniqueInput; data: ${T}UpdateInput } | { where: ${T}WhereUniqueInput; data: ${T}UpdateInput }[]; updateMany?: { where: ${T}WhereInput; data: ${T}UpdateManyInput } | { where: ${T}WhereInput; data: ${T}UpdateManyInput }[]; upsert?: { where: ${T}WhereUniqueInput; create: ${T}CreateInput; update: ${T}UpdateInput } | { where: ${T}WhereUniqueInput; create: ${T}CreateInput; update: ${T}UpdateInput }[] };`,
        );
      } else {
        L.push(
          `  ${r.name}?: { create?: ${T}CreateInput; connect?: ${T}WhereUniqueInput; connectOrCreate?: { where: ${T}WhereUniqueInput; create: ${T}CreateInput }; disconnect?: boolean; delete?: boolean; update?: ${T}UpdateInput | { data: ${T}UpdateInput }; upsert?: { create: ${T}CreateInput; update: ${T}UpdateInput } };`,
        );
      }
    }
    L.push("};", "");
  }

  // delegate
  L.push(doc(`Queries for model {@link ${M}} (table ${m.schema ? `${m.schema}.` : ""}${m.dbName}).`) + `export interface ${M}Delegate<G = {}, R = {}> {`);
  L.push(`  /** @internal Types of computed fields from \`$extends({ result })\` (type-only). */`, `  readonly $computed?: R;`);
  // A call without arguments gets its own overload instead of a `= {}` default on `A`: with the
  // default, the TypeScript language service offers no field names inside `where`, `select` or
  // `orderBy` (empty object or after a comma), see issue #82.
  const noArgs = `$r.WithComputed<${M}GetPayload<$r.StripComputed<{}, R>, G>, R, {}>`;
  const withArgs = `$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A>`;
  const findManyArgs = `A extends $r.ArgsWithComputed<${M}FindManyArgs, R>`;
  L.push(`  findMany(): $r.PreparableQuery<${noArgs}[]>;`);
  L.push(`  findMany<${findManyArgs}>(args?: A): $r.PreparableQuery<${withArgs}[]>;`);
  L.push(`  findFirst(): $r.PreparableQuery<${noArgs} | null>;`);
  L.push(`  findFirst<${findManyArgs}>(args?: A): $r.PreparableQuery<${withArgs} | null>;`);
  L.push(`  findFirstOrThrow(): $r.PreparableQuery<${noArgs}>;`);
  L.push(`  findFirstOrThrow<${findManyArgs}>(args?: A): $r.PreparableQuery<${withArgs}>;`);
  L.push(`  findUnique<A extends $r.ArgsWithComputed<${M}FindUniqueArgs, R>>(args: A): $r.PreparableQuery<$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A> | null>;`);
  L.push(`  findUniqueOrThrow<A extends $r.ArgsWithComputed<${M}FindUniqueArgs, R>>(args: A): $r.PreparableQuery<$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A>>;`);
  L.push(`  count(): Promise<number>;`);
  L.push(`  count<A extends ${M}CountArgs>(args?: A): Promise<A extends { select: infer S } ? { [K in $r.SelectedKeys<S>]: number } : number>;`);
  L.push(`  aggregate<A extends ${M}AggregateArgs>(args: A): Promise<$r.AggregatePayload<${M}, A>>;`);
  L.push(`  groupBy<A extends ${M}GroupByArgs>(args: A): Promise<$r.GroupByPayload<${M}, A>[]>;`);
  if (m.kind !== "view") {
    L.push(`  create<A extends $r.ArgsWithComputed<{ data: ${M}CreateInput; select?: ${M}Select | null; include?: ${M}Include | null; omit?: ${M}Omit | null }, R>>(args: A): Promise<$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A>>;`);
    L.push(`  createMany(args: { data: ${M}CreateManyInput | ${M}CreateManyInput[]; skipDuplicates?: boolean }): Promise<$r.BatchPayload>;`);
    L.push(`  createManyAndReturn<A extends $r.ArgsWithComputed<{ data: ${M}CreateManyInput | ${M}CreateManyInput[]; skipDuplicates?: boolean; select?: ${M}Select | null; include?: ${M}Include | null; omit?: ${M}Omit | null }, R>>(args: A): Promise<$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A>[]>;`);
    L.push(`  updateMany(args: { where?: ${M}WhereInput | $r.SQL<unknown>; data: ${M}UpdateManyInput }): Promise<$r.BatchPayload>;`);
    L.push(`  deleteMany(args?: { where?: ${M}WhereInput | $r.SQL<unknown> }): Promise<$r.BatchPayload>;`);
    if (!readOnly) {
      const sel = `select?: ${M}Select | null; include?: ${M}Include | null; omit?: ${M}Omit | null`;
      L.push(`  update<A extends $r.ArgsWithComputed<{ where: ${M}WhereUniqueInput; data: ${M}UpdateInput; ${sel} }, R>>(args: A): Promise<$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A>>;`);
      L.push(`  upsert<A extends $r.ArgsWithComputed<{ where: ${M}WhereUniqueInput; create: ${M}CreateInput; update: ${M}UpdateInput; ${sel} }, R>>(args: A): Promise<$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A>>;`);
      L.push(`  delete<A extends $r.ArgsWithComputed<{ where: ${M}WhereUniqueInput; ${sel} }, R>>(args: A): Promise<$r.WithComputed<${M}GetPayload<$r.StripComputed<A, R>, G>, R, A>>;`);
    }
  }
  L.push("}", "");
  return L.join("\n");
}

/** Generates the TypeScript source of a typed client for `contract`. */
export function generateClient(fullContract: Contract, options: GenerateOptions = {}): string {
  // @ignore / @@ignore parts stay in the schema for migrations but never reach the client
  const contract = clientContract(fullContract);
  const runtime = options.runtimeImport ?? "hana-orm/runtime";
  const decimal = options.decimal ?? "string";
  if (!DECIMAL_MODES.includes(decimal)) throw new Error(`Unknown decimal mode '${String(decimal)}'; use ${DECIMAL_MODES.map((m) => `"${m}"`).join(", ")}`);
  decimalType = decimal === "number" ? "number" : decimal === "decimal.js" ? "$Decimal" : "$r.Decimal";
  decimalInput = decimal === "number" ? "number | string" : decimal === "decimal.js" ? "$Decimal | number | string" : "$r.Decimal | number";
  const C = options.clientName ?? "HanaClient";
  const models = Object.values(contract.models);
  const out: string[] = [];
  out.push("// Generated by hana-orm. Do not edit: run `hana-orm generate` after changing the schema.");
  out.push("/* eslint-disable */");
  out.push(`import * as $r from "${runtime}";`);
  if (decimal === "decimal.js") out.push(`import { Decimal as $Decimal } from "decimal.js";`);
  out.push("");
  out.push(`export const contract: $r.Contract = ${JSON.stringify(contract)};`, "");

  for (const e of Object.values(contract.enums)) {
    out.push(doc(e.doc) + `export const ${e.name} = { ${e.values.map((v) => `${v.name}: "${v.name}"`).join(", ")} } as const;`);
    out.push(`export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`, "");
  }

  for (const m of models) out.push(modelTypes(contract, m));

  out.push(`/** Client-wide \`omit\` option: fields left out of every result of a model unless a query asks for them. */`);
  out.push(`export type ${C}OmitConfig = { ${models.map((m) => `${lowerFirst(m.name)}?: ${m.name}Omit`).join("; ")} };`);
  out.push(`export interface ${C}Options extends $r.ClientOptions { omit?: ${C}OmitConfig }`, "");
  // SQL-like query builder: typed tables and the builder methods (skipped when a model has the name)
  out.push(`/** Tables for the SQL-like builder: \`db.select().from(tables.user)\`. */`);
  out.push(`export const tables = $r.createTables(contract) as unknown as {`);
  for (const m of models) {
    const key = lowerFirst(m.name);
    const cols = columnFields(m).map((f) => `readonly ${f.name}: $r.Column<${outputType(contract, f)}${f.optional ? " | null" : ""}, "${key}">`);
    out.push(`  readonly ${key}: $r.Table<"${key}", { ${cols.join("; ")} }, ${m.kind === "view" ? "never" : `${m.name}CreateManyInput`}>;`);
  }
  out.push("};");
  out.push(
    `export { sql, alias, eq, ne, gt, gte, lt, lte, like, notLike, ilike, inArray, notInArray, isNull, isNotNull, between, and, or, not, exists, notExists, asc, desc, count, countDistinct, sum, avg, min, max } from "${runtime}";`,
    "",
  );
  const taken = new Set(models.map((m) => lowerFirst(m.name)));
  const builderMethods: string[] = [];
  const add = (name: string, ...lines: string[]) => {
    if (!taken.has(name)) builderMethods.push(...lines);
  };
  const anyTable = "{ readonly [$r.TABLE]: unknown }";
  add("select", `  select(): $r.SelectStart<"all">;`, `  select<S extends $r.Selection>(fields: S): $r.SelectStart<S>;`);
  add("selectDistinct", `  selectDistinct(): $r.SelectStart<"all">;`, `  selectDistinct<S extends $r.Selection>(fields: S): $r.SelectStart<S>;`);
  add("insert", `  insert<T extends ${anyTable}>(table: T): $r.InsertBuilder<$r.InsertOf<T>>;`);
  add("update", `  update<T extends ${anyTable}>(table: T): $r.UpdateStart<T>;`);
  add("delete", `  delete<T extends ${anyTable}>(table: T): $r.DeleteBuilder;`);
  add("with", `  with(...ctes: $r.Cte<string, Record<string, unknown>>[]): { select(): $r.SelectStart<"all">; select<S extends $r.Selection>(fields: S): $r.SelectStart<S>; selectDistinct<S extends $r.Selection>(fields?: S): $r.SelectStart<S | "all"> };`);
  builderMethods.push(`  $with<A extends string>(name: A): $r.WithStart<A>;`);

  out.push(`export interface ${C}Transaction<G = {}> {`);
  for (const m of models) out.push(`  readonly ${lowerFirst(m.name)}: ${m.name}Delegate<G>;`);
  out.push(...builderMethods);
  out.push(`  $queryRaw<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;`);
  out.push(`  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;`);
  out.push(`  $queryRawUnsafe<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;`);
  out.push(`  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;`);
  out.push(`  /** Runs a query generated from a .sql file (\`hana-orm generate --sql\`). */`);
  out.push(`  $queryRawTyped<R>(query: $r.TypedSql<R>): Promise<R[]>;`);
  out.push("}", "");
  out.push(`export interface ${C}<G = {}> extends ${C}Transaction<G> {`);
  out.push(`  $connect(): Promise<void>;`);
  out.push(`  $disconnect(): Promise<void>;`);
  out.push(`  /** Subscribes to \`query\`, \`info\`, \`warn\` or \`error\` events; returns a function that unsubscribes. */`);
  out.push(`  $on<E extends $r.ClientEventName>(event: E, handler: (event: $r.ClientEvents[E]) => void): () => void;`);
  out.push(`  /** Query and transaction counters and the connection pool's state. */`);
  out.push(`  $metrics(): $r.ClientMetrics;`);
  out.push(`  $transaction<R>(fn: (tx: ${C}Transaction<G>) => Promise<R>, options?: $r.TransactionOptions): Promise<R>;`);
  out.push(`  /** Runs the queries in order in one transaction. Pass them without awaiting them. */`);
  out.push(`  $transaction<const P extends readonly Promise<unknown>[]>(queries: P, options?: $r.TransactionOptions): Promise<{ -readonly [K in keyof P]: Awaited<P[K]> }>;`);
  out.push(`  /** Runs queries and builders in order on one connection in one transaction; identical builder updates/deletes go as one batch. */`);
  out.push(`  $batch<const P extends readonly PromiseLike<unknown>[]>(items: P, options?: $r.TransactionOptions): Promise<{ -readonly [K in keyof P]: Awaited<P[K]> }>;`);
  out.push(`  $extends<E extends $r.ExtensionArgs & { result?: ${C}ResultArgs }>(extension: E): Extended<${C}<G>, E, G>;`);
  out.push("}", "");
  out.push(`/** \`result\` extension shape: \`compute\` receives the model row. */`);
  out.push(`export type ${C}ResultArgs = { ${models.map((m) => `${lowerFirst(m.name)}?: Record<string, { needs?: { [F in keyof ${m.name}]?: boolean }; compute: (row: ${m.name}) => unknown }>`).join("; ")} };`);
  out.push(`type ModelMethods<E, K extends string> = E extends { model: infer MM } ? (MM extends Record<string, unknown> ? (K extends keyof MM ? MM[K] : {}) & ("$allModels" extends keyof MM ? MM["$allModels"] : {}) : {}) : {};`);
  out.push(`type ClientMethods<E> = E extends { client: infer CM } ? CM : {};`);
  out.push(
    `export type Extended<C, E, G = {}> = Omit<C, ${[...models.map((m) => `"${lowerFirst(m.name)}"`), `"$extends"`].join(" | ")}> & ClientMethods<E> & {\n` +
      `  /** Extends again; computed fields of earlier extensions are kept. */\n` +
      `  $extends<E2 extends $r.ExtensionArgs & { result?: ${C}ResultArgs }>(extension: E2): Extended<Extended<C, E, G>, E2, G>;\n${models
      .map((m) => `  readonly ${lowerFirst(m.name)}: ${m.name}Delegate<G, $r.Simplify<$r.PrevComputed<C, "${lowerFirst(m.name)}"> & $r.ComputedOf<E, "${lowerFirst(m.name)}">>> & ModelMethods<E, "${lowerFirst(m.name)}">;`)
      .join("\n")}\n};`,
    "",
  );
  out.push(
    `export const ${C} = $r.createClientClass(contract${decimal === "string" ? "" : `, { decimal: "${decimal}"${decimal === "decimal.js" ? ", Decimal: $Decimal" : ""} }`}) as unknown as { new <const G extends ${C}OmitConfig = {}>(options?: ${C}Options & { omit?: G }): ${C}<G> };`,
    "",
  );
  return out.join("\n");
}
