import type {
  Arg,
  Attribute,
  ConfigBlock,
  ConfigProperty,
  Declaration,
  EnumDecl,
  EnumValueDecl,
  FieldDecl,
  ModelDecl,
  SchemaAst,
  Value,
} from "./ast.ts";
import { SchemaError } from "./errors.ts";
import { tokenize, type Token } from "./lexer.ts";

/** Parses schema source text into a syntax tree. Throws `SchemaError` on syntax errors. */
export function parseSchema(source: string, file?: string): SchemaAst {
  return new Parser(tokenize(source, file), file).parse();
}

class Parser {
  private i = 0;
  private readonly tokens: Token[];
  private readonly file: string | undefined;

  constructor(tokens: Token[], file?: string) {
    this.tokens = tokens;
    this.file = file;
  }

  parse(): SchemaAst {
    const declarations: Declaration[] = [];
    let doc: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (t.type === "newline") {
        this.next();
        continue;
      }
      if (t.type === "doc") {
        doc.push(this.next().value);
        continue;
      }
      if (t.type !== "ident") this.fail(t, `Expected a declaration, found '${t.value}'`);
      const docText = doc.length ? doc.join("\n") : undefined;
      doc = [];
      switch (t.value) {
        case "model":
        case "view":
          declarations.push(this.model(t.value, docText));
          break;
        case "enum":
          declarations.push(this.enumDecl(docText));
          break;
        case "datasource":
        case "generator":
          declarations.push(this.config(t.value));
          break;
        default:
          this.fail(t, `Unknown block type '${t.value}'. Expected model, view, enum, datasource or generator`);
      }
    }
    return { declarations };
  }

  // ---- blocks -------------------------------------------------------------

  private model(kind: "model" | "view", doc?: string): ModelDecl {
    const start = this.next();
    const name = this.expectIdent("model name").value;
    this.expectPunct("{");
    const fields: FieldDecl[] = [];
    const attributes: Attribute[] = [];
    let fieldDoc: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === "newline") {
        this.next();
        continue;
      }
      if (t.type === "doc") {
        fieldDoc.push(this.next().value);
        continue;
      }
      if (t.type === "punct" && t.value === "}") {
        this.next();
        break;
      }
      if (t.type === "eof") this.fail(t, `Missing '}' for ${kind} '${name}'`);
      if (t.type === "atat") {
        this.next();
        attributes.push(this.attribute(t));
        this.endOfLine();
        continue;
      }
      const field = this.field();
      if (fieldDoc.length) field.doc = fieldDoc.join("\n");
      fieldDoc = [];
      fields.push(field);
    }
    return { kind, name, fields, attributes, doc, pos: start.pos };
  }

  private field(): FieldDecl {
    const nameTok = this.expectIdent("field name");
    const typeTok = this.expectIdent("field type");
    const field: FieldDecl = {
      name: nameTok.value,
      type: typeTok.value,
      optional: false,
      list: false,
      attributes: [],
      pos: nameTok.pos,
    };
    if (typeTok.value === "Unsupported") {
      this.expectPunct("(");
      const s = this.next();
      if (s.type !== "string") this.fail(s, "Unsupported(...) expects a string");
      field.unsupported = s.value;
      this.expectPunct(")");
    }
    if (this.isPunct("?")) {
      this.next();
      field.optional = true;
    } else if (this.isPunct("[")) {
      this.next();
      this.expectPunct("]");
      field.list = true;
    }
    while (this.peek().type === "at") {
      const at = this.next();
      field.attributes.push(this.attribute(at));
    }
    this.endOfLine();
    return field;
  }

  private enumDecl(doc?: string): EnumDecl {
    const start = this.next();
    const name = this.expectIdent("enum name").value;
    this.expectPunct("{");
    const values: EnumValueDecl[] = [];
    const attributes: Attribute[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === "newline" || t.type === "doc") {
        this.next();
        continue;
      }
      if (t.type === "punct" && t.value === "}") {
        this.next();
        break;
      }
      if (t.type === "eof") this.fail(t, `Missing '}' for enum '${name}'`);
      if (t.type === "atat") {
        this.next();
        attributes.push(this.attribute(t));
        this.endOfLine();
        continue;
      }
      const v = this.expectIdent("enum value");
      const value: EnumValueDecl = { name: v.value, attributes: [], pos: v.pos };
      while (this.peek().type === "at") value.attributes.push(this.attribute(this.next()));
      this.endOfLine();
      values.push(value);
    }
    return { kind: "enum", name, values, attributes, doc, pos: start.pos };
  }

  private config(kind: "datasource" | "generator"): ConfigBlock {
    const start = this.next();
    const name = this.expectIdent(`${kind} name`).value;
    this.expectPunct("{");
    const properties: ConfigProperty[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === "newline" || t.type === "doc") {
        this.next();
        continue;
      }
      if (t.type === "punct" && t.value === "}") {
        this.next();
        break;
      }
      if (t.type === "eof") this.fail(t, `Missing '}' for ${kind} '${name}'`);
      const key = this.expectIdent("property name");
      this.expectPunct("=");
      properties.push({ key: key.value, value: this.value(), pos: key.pos });
      this.endOfLine();
    }
    return { kind, name, properties, pos: start.pos };
  }

  // ---- attributes and values ---------------------------------------------

  private attribute(at: Token): Attribute {
    const nameTok = this.peek();
    if (nameTok.type !== "ident") this.fail(nameTok, `Expected attribute name after '${at.value}'`);
    this.next();
    const args = this.isPunct("(") ? this.args() : [];
    return { name: nameTok.value, args, pos: at.pos };
  }

  private args(): Arg[] {
    this.expectPunct("(");
    const args: Arg[] = [];
    this.skipNewlines();
    if (this.isPunct(")")) {
      this.next();
      return args;
    }
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      const after = this.tokens[this.i + 1];
      if (t.type === "ident" && after?.type === "punct" && after.value === ":") {
        this.next();
        this.next();
        args.push({ name: t.value, value: this.value() });
      } else {
        args.push({ value: this.value() });
      }
      this.skipNewlines();
      if (this.isPunct(",")) {
        this.next();
        continue;
      }
      this.expectPunct(")");
      return args;
    }
  }

  private value(): Value {
    this.skipNewlines();
    const t = this.next();
    switch (t.type) {
      case "string":
        return { kind: "string", value: t.value, pos: t.pos };
      case "number":
        return { kind: "number", value: Number(t.value), pos: t.pos };
      case "ident":
        if (t.value === "true" || t.value === "false") return { kind: "boolean", value: t.value === "true", pos: t.pos };
        if (this.isPunct("(")) return { kind: "call", name: t.value, args: this.args(), pos: t.pos };
        return { kind: "ident", name: t.value, pos: t.pos };
      case "punct":
        if (t.value === "[") {
          const items: Value[] = [];
          this.skipNewlines();
          if (this.isPunct("]")) {
            this.next();
            return { kind: "array", items, pos: t.pos };
          }
          for (;;) {
            items.push(this.value());
            this.skipNewlines();
            if (this.isPunct(",")) {
              this.next();
              continue;
            }
            this.expectPunct("]");
            return { kind: "array", items, pos: t.pos };
          }
        }
    }
    return this.fail(t, `Expected a value, found '${t.value || t.type}'`);
  }

  // ---- token helpers -----------------------------------------------------

  private peek(): Token {
    return this.tokens[this.i]!;
  }

  private next(): Token {
    const t = this.tokens[this.i]!;
    if (t.type !== "eof") this.i++;
    return t;
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.type === "punct" && t.value === v;
  }

  private skipNewlines(): void {
    while (this.peek().type === "newline") this.next();
  }

  private expectPunct(v: string): Token {
    const t = this.next();
    if (t.type !== "punct" || t.value !== v) this.fail(t, `Expected '${v}', found '${t.value || t.type}'`);
    return t;
  }

  private expectIdent(what: string): Token {
    const t = this.next();
    if (t.type !== "ident") this.fail(t, `Expected ${what}, found '${t.value || t.type}'`);
    return t;
  }

  private endOfLine(): void {
    const t = this.peek();
    if (t.type === "newline" || t.type === "eof" || t.type === "doc") return;
    if (t.type === "punct" && t.value === "}") return;
    this.fail(t, `Unexpected '${t.value}'`);
  }

  private fail(t: Token, message: string): never {
    throw new SchemaError([{ message, pos: t.pos }], this.file);
  }
}
