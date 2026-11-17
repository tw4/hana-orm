/** Syntax tree of a `.hana` schema file, before semantic resolution. */

export interface Position {
  line: number;
  col: number;
  /** Source file, set when a schema is compiled from several files. */
  file?: string;
}

export type Value =
  | { kind: "string"; value: string; pos: Position }
  | { kind: "number"; value: number; pos: Position }
  | { kind: "boolean"; value: boolean; pos: Position }
  | { kind: "ident"; name: string; pos: Position }
  | { kind: "call"; name: string; args: Arg[]; pos: Position }
  | { kind: "array"; items: Value[]; pos: Position };

export interface Arg {
  name?: string;
  value: Value;
}

export interface Attribute {
  /** Name without the leading `@`/`@@`, e.g. `id`, `relation`, `db.NVarChar`. */
  name: string;
  args: Arg[];
  pos: Position;
}

export interface FieldDecl {
  name: string;
  type: string;
  /** Argument of `Unsupported("...")`. */
  unsupported?: string;
  optional: boolean;
  list: boolean;
  attributes: Attribute[];
  doc?: string;
  pos: Position;
}

export interface ModelDecl {
  kind: "model" | "view";
  name: string;
  fields: FieldDecl[];
  attributes: Attribute[];
  doc?: string;
  pos: Position;
}

export interface EnumValueDecl {
  name: string;
  attributes: Attribute[];
  pos: Position;
}

export interface EnumDecl {
  kind: "enum";
  name: string;
  values: EnumValueDecl[];
  attributes: Attribute[];
  doc?: string;
  pos: Position;
}

export interface ConfigProperty {
  key: string;
  value: Value;
  pos: Position;
}

export interface ConfigBlock {
  kind: "datasource" | "generator";
  name: string;
  properties: ConfigProperty[];
  pos: Position;
}

export type Declaration = ModelDecl | EnumDecl | ConfigBlock;

export interface SchemaAst {
  declarations: Declaration[];
}
