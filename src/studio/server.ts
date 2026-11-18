/**
 * `hana-orm studio`: a local web UI to browse and edit data (issue #37).
 *
 * The server only talks JSON to its own page. It binds to 127.0.0.1 by default, accepts only
 * requests whose Host header is the address it listens on (no DNS rebinding), and every API call
 * must carry the per-run token from the URL in an `X-Studio-Token` header, which a page from
 * another origin cannot send without a CORS preflight that this server never answers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { ColumnFieldDef, Contract, ModelDef, RelationFieldDef } from "../schema/contract.ts";
import { STUDIO_CSS, STUDIO_HTML, STUDIO_JS } from "./ui.ts";

/** What the studio needs from a client: one delegate per model (`client.user.findMany`, …). */
export type StudioClient = Record<string, unknown>;

export interface StudioOptions {
  contract: Contract;
  client: StudioClient;
  /** Refuse creates, updates and deletes. */
  readOnly?: boolean;
  /** Shown in the page header, e.g. the database host. */
  label?: string;
  /** Fixed token (tests); default: random per run. */
  token?: string;
  /** Rows per page at most (default 500). */
  maxTake?: number;
}

export interface StudioServer {
  server: Server;
  token: string;
  /** Starts listening; resolves with the URL to open (with the token). */
  listen(port: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

// ---- metadata -------------------------------------------------------------------------------

export interface StudioField {
  name: string;
  kind: "scalar" | "enum" | "relation";
  type: string;
  optional: boolean;
  id: boolean;
  unique: boolean;
  /** The database fills it when left out (default, autoincrement, @updatedAt). */
  generated: boolean;
  enumValues?: string[];
  /** `owner`: this model holds the foreign key (`localFields`). */
  relation?: { model: string; list: boolean; owner: boolean; localFields: string[]; targetFields: string[] };
}

export interface StudioModel {
  name: string;
  kind: "model" | "view";
  /** Fields that identify a row (primary key, else the first unique); null = rows cannot be edited. */
  key: string[] | null;
  fields: StudioField[];
}

export function studioModels(contract: Contract): StudioModel[] {
  return Object.values(contract.models)
    .filter((m) => !m.fields.every((f) => f.ignored))
    .map((m) => ({
      name: m.name,
      kind: m.kind,
      key: rowKey(m),
      fields: m.fields.filter((f) => !f.ignored).map((f) => studioField(contract, f)),
    }));
}

function rowKey(m: ModelDef): string[] | null {
  if (m.kind === "view") return null;
  if (m.primaryKey) return m.primaryKey.fields;
  const single = m.fields.find((f): f is ColumnFieldDef => f.kind !== "relation" && f.unique && !f.optional);
  if (single) return [single.name];
  return m.uniques[0]?.fields ?? null;
}

function studioField(contract: Contract, f: ColumnFieldDef | RelationFieldDef): StudioField {
  if (f.kind === "relation") {
    return {
      name: f.name,
      kind: "relation",
      type: f.model,
      optional: f.optional,
      id: false,
      unique: false,
      generated: true,
      relation: { model: f.model, list: f.list, owner: f.owner, localFields: f.localFields, targetFields: f.targetFields },
    };
  }
  return {
    name: f.name,
    kind: f.kind,
    type: f.type,
    optional: f.optional,
    id: f.id,
    unique: f.unique,
    generated: f.default !== undefined || f.updatedAt,
    ...(f.kind === "enum" ? { enumValues: contract.enums[f.type]?.values.map((v) => v.name) ?? [] } : {}),
  };
}

// ---- values on the wire -----------------------------------------------------------------------

/** JSON-safe form of a value the client returned. */
export function toWire(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (typeof v === "object" && v.constructor?.name === "Decimal") return String(v);
  return v;
}

function rowToWire(row: Record<string, unknown>, columns: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (columns.has(k)) out[k] = toWire(v);
  return out;
}

class BadRequest extends Error {}

/** A value from the page, converted to what the client expects for `field`. */
export function fromWire(field: ColumnFieldDef, v: unknown): unknown {
  if (v === null) {
    return null;
  }
  const bad = (): never => {
    throw new BadRequest(`'${field.name}' expects ${field.type}, got ${JSON.stringify(v)}`);
  };
  switch (field.kind === "enum" ? "Enum" : field.type) {
    case "Int":
    case "Float": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n) || (field.type === "Int" && !Number.isInteger(n))) bad();
      return n;
    }
    case "BigInt":
      try {
        return BigInt(typeof v === "number" || typeof v === "string" ? v : bad());
      } catch {
        return bad();
      }
    case "Decimal":
      if ((typeof v !== "string" && typeof v !== "number") || !/^-?\d+(\.\d+)?$/.test(String(v).trim())) bad();
      return String(v).trim();
    case "Boolean":
      if (typeof v === "boolean") return v;
      if (v === "true" || v === "false") return v === "true";
      return bad();
    case "DateTime": {
      const d = new Date(typeof v === "string" || typeof v === "number" ? v : NaN);
      if (Number.isNaN(d.getTime())) bad();
      return d;
    }
    case "Bytes":
      if (typeof v !== "string") bad();
      return Buffer.from(v as string, "base64");
    case "Json":
      return v;
    default:
      if (typeof v !== "string") bad();
      return v;
  }
}

// ---- requests ---------------------------------------------------------------------------------

export type FilterOp = "equals" | "not" | "contains" | "startsWith" | "gt" | "gte" | "lt" | "lte" | "isNull" | "notNull";
const FILTER_OPS = new Set<FilterOp>(["equals", "not", "contains", "startsWith", "gt", "gte", "lt", "lte", "isNull", "notNull"]);

export interface Filter {
  field: string;
  op: FilterOp;
  value?: unknown;
}

function columnOf(model: ModelDef, name: string): ColumnFieldDef {
  const f = model.fields.find((x): x is ColumnFieldDef => x.name === name && x.kind !== "relation" && !x.ignored);
  if (!f) throw new BadRequest(`'${model.name}' has no column '${name}'`);
  return f;
}

/** `where` of the object API from the page's filters (all must match). */
export function filtersToWhere(model: ModelDef, filters: Filter[]): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  for (const f of filters) {
    if (!FILTER_OPS.has(f.op)) throw new BadRequest(`Unknown filter '${f.op}'`);
    const col = columnOf(model, f.field);
    if (f.op === "isNull") and.push({ [col.name]: null });
    else if (f.op === "notNull") and.push({ [col.name]: { not: null } });
    else if (f.op === "contains" || f.op === "startsWith") {
      if (col.kind !== "scalar" || col.type !== "String") throw new BadRequest(`'${f.op}' needs a String column, '${col.name}' is ${col.type}`);
      and.push({ [col.name]: { [f.op]: String(f.value ?? ""), mode: "insensitive" } });
    } else if (col.kind === "scalar" && col.type === "Json") {
      throw new BadRequest(`Filter Json column '${col.name}' with is null / is not null`);
    } else and.push({ [col.name]: { [f.op]: fromWire(col, f.value ?? null) } });
  }
  return and.length ? { AND: and } : {};
}

function dataFromWire(model: ModelDef, data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new BadRequest("'data' must be an object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = fromWire(columnOf(model, k), v);
  return out;
}

function keyWhere(model: ModelDef, key: string[] | null, value: unknown): Record<string, unknown> {
  if (!key) throw new BadRequest(`Rows of '${model.name}' cannot be edited: it has no primary key or unique field`);
  if (!value || typeof value !== "object") throw new BadRequest("'key' must be an object");
  const v = value as Record<string, unknown>;
  const where: Record<string, unknown> = {};
  for (const name of key) {
    if (v[name] === undefined || v[name] === null) throw new BadRequest(`'key' needs '${name}'`);
    where[name] = fromWire(columnOf(model, name), v[name]);
  }
  return where;
}

const MAX_BODY = 1 << 20;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("Request body too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new BadRequest("Body must be a JSON object");
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Names this machine answers to, for the Host check when listening on all interfaces. */
function localAddresses(): string[] {
  const out = [hostname()];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) out.push(a.family === "IPv6" ? `[${a.address}]` : a.address);
  }
  return out;
}

export function createStudio(options: StudioOptions): StudioServer {
  const { contract, client } = options;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const maxTake = options.maxTake ?? 500;
  const models = studioModels(contract);
  const metaByName = new Map(models.map((m) => [m.name, m]));
  let allowedHosts = new Set<string>();

  const delegate = (name: string): Record<string, (args?: unknown) => Promise<unknown>> => {
    const d = client[name.charAt(0).toLowerCase() + name.slice(1)];
    if (!d) throw new BadRequest(`Unknown model '${name}'`);
    return d as Record<string, (args?: unknown) => Promise<unknown>>;
  };
  const modelOf = (name: unknown): { def: ModelDef; meta: StudioModel } => {
    const def = typeof name === "string" ? contract.models[name] : undefined;
    const meta = typeof name === "string" ? metaByName.get(name) : undefined;
    if (!def || !meta) throw new BadRequest(`Unknown model '${String(name)}'`);
    return { def, meta };
  };
  const columnsOf = (def: ModelDef) => new Set(def.fields.filter((f) => f.kind !== "relation" && !f.ignored).map((f) => f.name));

  function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  }
  const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), "application/json; charset=utf-8");

  async function api(req: IncomingMessage, url: URL): Promise<unknown> {
    const method = req.method ?? "GET";
    if (url.pathname === "/api/meta" && method === "GET") {
      return { models, readOnly: !!options.readOnly, label: options.label ?? "" };
    }
    if (url.pathname !== "/api/rows") return undefined;

    if (method === "GET") {
      const { def, meta } = modelOf(url.searchParams.get("model"));
      const skip = Math.max(0, Number(url.searchParams.get("skip") ?? 0) | 0);
      const take = Math.min(maxTake, Math.max(1, Number(url.searchParams.get("take") ?? 50) | 0));
      let filters: Filter[] = [];
      try {
        filters = JSON.parse(url.searchParams.get("filters") ?? "[]");
      } catch {
        throw new BadRequest("'filters' must be JSON");
      }
      if (!Array.isArray(filters)) throw new BadRequest("'filters' must be a list");
      const where = filtersToWhere(def, filters);
      const sortField = url.searchParams.get("sort");
      const dir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
      const orderBy: Record<string, string>[] = [];
      if (sortField) orderBy.push({ [columnOf(def, sortField).name]: dir });
      // a stable order for paging: the row key after the chosen column
      for (const k of meta.key ?? []) if (k !== sortField) orderBy.push({ [k]: "asc" });
      const d = delegate(def.name);
      const [rows, total] = await Promise.all([
        d.findMany!({ where, skip, take, ...(orderBy.length ? { orderBy } : {}) }) as Promise<Record<string, unknown>[]>,
        d.count!({ where }) as Promise<number>,
      ]);
      const cols = columnsOf(def);
      return { rows: rows.map((r) => rowToWire(r, cols)), total };
    }

    if (method !== "POST" && method !== "PATCH" && method !== "DELETE") return undefined;
    if (options.readOnly) throw new BadRequest("The studio was started with --read-only");
    const body = await readJson(req);
    const { def, meta } = modelOf(body.model);
    if (def.kind === "view") throw new BadRequest(`'${def.name}' is a view and cannot be changed`);
    const d = delegate(def.name);
    const cols = columnsOf(def);
    if (method === "POST") {
      const row = (await d.create!({ data: dataFromWire(def, body.data) })) as Record<string, unknown>;
      return { row: rowToWire(row, cols) };
    }
    const where = keyWhere(def, meta.key, body.key);
    if (method === "PATCH") {
      const row = (await d.update!({ where, data: dataFromWire(def, body.data) })) as Record<string, unknown>;
      return { row: rowToWire(row, cols) };
    }
    await d.delete!({ where });
    return { deleted: true };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
      send(res, 421, "Misdirected request", "text/plain; charset=utf-8");
      return;
    }
    const url = new URL(req.url ?? "/", "http://studio.local");
    if (url.pathname === "/app.js") return send(res, 200, STUDIO_JS, "text/javascript; charset=utf-8");
    if (url.pathname === "/app.css") return send(res, 200, STUDIO_CSS, "text/css; charset=utf-8");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!sameToken(url.searchParams.get("token") ?? "", token)) {
        return send(res, 403, "Open the URL printed by 'hana-orm studio' (it contains the access token).", "text/plain; charset=utf-8");
      }
      return send(res, 200, STUDIO_HTML, "text/html; charset=utf-8", { "content-security-policy": CSP });
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const given = req.headers["x-studio-token"];
    if (typeof given !== "string" || !sameToken(given, token)) return json(res, 403, { error: "Missing or wrong studio token" });
    try {
      const result = await api(req, url);
      if (result === undefined) return json(res, 404, { error: "Not found" });
      json(res, 200, result);
    } catch (e) {
      if (e instanceof BadRequest) return json(res, 400, { error: e.message });
      const err = e as Error & { code?: unknown };
      // database and validation errors from the client are shown to the user as they are
      json(res, 422, { error: err.message, ...(typeof err.code === "string" ? { code: err.code } : {}) });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.end();
    });
  });

  return {
    server,
    token,
    listen(port: number, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const actual = typeof addr === "object" && addr ? addr.port : port;
          const names = host === "0.0.0.0" || host === "::" ? ["127.0.0.1", "localhost", ...localAddresses()] : [host.includes(":") ? `[${host}]` : host];
          if (host === "127.0.0.1") names.push("localhost");
          allowedHosts = new Set(names.map((n) => `${n}:${actual}`.toLowerCase()));
          resolve(`http://${names[0]}:${actual}/?token=${token}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
