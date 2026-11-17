#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compileSchemaSources, isSchemaFolder, readSchemaSources } from "../schema/files.ts";
import { formatSchema } from "../schema/format.ts";
import type { Contract } from "../schema/contract.ts";
import { SchemaError } from "../schema/errors.ts";
import { generateClient } from "../generator/client.ts";
import { loadDotEnv, resolveConnectionConfig, resolveDefaultSchema } from "../runtime/config.ts";
import { HanaDriver } from "../runtime/hana-driver.ts";
import type { CliContext, ParsedArgs } from "./context.ts";
import { DB_MIGRATE_HELP, runDbOrMigrateCommand } from "../migrate/cli.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `hana-orm ${VERSION} — type-safe ORM for SAP HANA

Usage: hana-orm <command> [options]

Commands
  init                 Create schema.hana and .env.example in the current folder
  generate [--watch]   Generate the typed client from the schema
  validate             Check the schema for errors
  format [--check]     Format the schema file(s) in place: aligned columns, attribute order,
                       spacing. --check only lists files that are not formatted (exit 1).
  version              Print the version
${DB_MIGRATE_HELP}
Global options
  --schema <path>      Schema file, or a folder whose *.hana files are merged into one schema
                       (default: ./schema.hana, then ./hana/schema.hana, then ./schema/)
  --help               Show help
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[key] = argv[++i]!;
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

// Flags that never take a value, so `--watch schema.hana` is not misread.
const BOOLEAN_FLAGS = new Set(["watch", "help", "dry-run", "allow-destructive", "print", "empty", "views", "force", "yes", "check"]);

function normalizeFlags(args: ParsedArgs): ParsedArgs {
  for (const [k, v] of Object.entries(args.flags)) {
    if (BOOLEAN_FLAGS.has(k) && typeof v === "string") {
      args.positional.push(v);
      args.flags[k] = true;
    }
  }
  return args;
}

function findSchema(cwd: string, flag: string | boolean | undefined): string {
  if (typeof flag === "string") return isAbsolute(flag) ? flag : resolve(cwd, flag);
  for (const candidate of ["schema.hana", "hana/schema.hana"]) {
    const p = resolve(cwd, candidate);
    if (existsSync(p)) return p;
  }
  if (isSchemaFolder(resolve(cwd, "schema"))) return resolve(cwd, "schema");
  return resolve(cwd, "schema.hana");
}

/** Folder that holds `migrations/` and that generator outputs are relative to. */
export function schemaDir(schemaPath: string): string {
  return isSchemaFolder(schemaPath) ? schemaPath : dirname(schemaPath);
}

/** Reads and compiles the schema file or folder. */
export function loadSchema(cwd: string, schemaPath: string): Contract {
  if (!existsSync(schemaPath)) throw new Error(`Schema file not found: ${relative(cwd, schemaPath) || schemaPath}. Run 'hana-orm init' or pass --schema.`);
  return compileSchemaSources(readSchemaSources(schemaPath, cwd));
}

function createContext(cwd: string, schemaPath: string): CliContext {
  let cached: Contract | undefined;
  const loadContract = async () => {
    if (cached) return cached;
    cached = loadSchema(cwd, schemaPath);
    return cached;
  };
  const datasource = async () => (existsSync(schemaPath) ? (await loadContract()).datasource : undefined);
  return {
    cwd,
    schemaPath,
    migrationsDir: join(schemaDir(schemaPath), "migrations"),
    loadContract,
    async connect() {
      return new HanaDriver(resolveConnectionConfig(await datasource()), { poolSize: 2 });
    },
    async defaultSchema() {
      return resolveDefaultSchema(await datasource());
    },
    log: (m) => console.log(m),
    warn: (m) => console.warn(`warning: ${m}`),
    async confirm(question, defaultAnswer) {
      if (!process.stdin.isTTY) return defaultAnswer;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`${question} ${defaultAnswer ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        return answer ? answer.startsWith("y") : defaultAnswer;
      } finally {
        rl.close();
      }
    },
  };
}

const SCHEMA_TEMPLATE = `// hana-orm schema. Docs: https://github.com/tw4/hana-orm
datasource db {
  provider = "hana"
  host     = env("HANA_HOST")
  port     = env("HANA_PORT")
  user     = env("HANA_USER")
  password = env("HANA_PASSWORD")
  // databaseName = env("HANA_DATABASE") // tenant database when connecting through SYSTEMDB
  // schema       = "MY_SCHEMA"           // default schema for tables
}

generator client {
  provider = "hana-orm"
  output   = "./src/generated/hana"
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.NVarChar(320)
  name      String?
  createdAt DateTime @default(now())
}
`;

const ENV_TEMPLATE = `# Copy to .env and fill in. Never commit .env.
HANA_HOST=localhost
HANA_PORT=30015
HANA_USER=
HANA_PASSWORD=
HANA_DATABASE=
`;

function cmdInit(ctx: CliContext): number {
  if (existsSync(ctx.schemaPath)) {
    ctx.warn(`${relative(ctx.cwd, ctx.schemaPath)} already exists; nothing to do`);
    return 0;
  }
  writeFileSync(ctx.schemaPath, SCHEMA_TEMPLATE);
  const envExample = join(ctx.cwd, ".env.example");
  if (!existsSync(envExample)) writeFileSync(envExample, ENV_TEMPLATE);
  ctx.log(`Created ${relative(ctx.cwd, ctx.schemaPath)} and .env.example.

Next steps:
  1. Copy .env.example to .env and fill in your connection
  2. Edit the schema, or pull an existing database: hana-orm db pull
  3. hana-orm generate`);
  return 0;
}

async function cmdGenerate(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const once = async (): Promise<boolean> => {
    let contract: Contract;
    try {
      contract = loadSchema(ctx.cwd, ctx.schemaPath);
    } catch (e) {
      if (e instanceof SchemaError) {
        console.error(e.message);
        return false;
      }
      throw e;
    }
    const generators = contract.generators.length ? contract.generators : [{ name: "client", provider: "hana-orm", output: "./generated/hana" }];
    for (const g of generators) {
      const outDir = resolve(schemaDir(ctx.schemaPath),String(g.output ?? "./generated/hana"));
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, "index.ts");
      const portable = { ...contract, generators: contract.generators.map(({ output: _o, ...rest }) => rest) } as Contract;
      writeFileSync(file, generateClient(portable, { ...(typeof g.runtimeImport === "string" ? { runtimeImport: g.runtimeImport } : {}), ...(typeof g.clientName === "string" ? { clientName: g.clientName } : {}) }));
      ctx.log(`Generated client for ${Object.keys(contract.models).length} model(s) → ${relative(ctx.cwd, file)}`);
    }
    return true;
  };
  const ok = await once();
  if (!args.flags.watch) return ok ? 0 : 1;
  ctx.log(`Watching ${relative(ctx.cwd, ctx.schemaPath)} for changes...`);
  let timer: NodeJS.Timeout | undefined;
  watch(ctx.schemaPath, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void once(), 100);
  });
  return new Promise(() => {});
}

/** `hana-orm format [--check]`: formats every schema file; with --check it only reports. */
export function cmdFormat(ctx: CliContext, args: ParsedArgs): number {
  if (!existsSync(ctx.schemaPath)) throw new Error(`Schema file not found: ${relative(ctx.cwd, ctx.schemaPath) || ctx.schemaPath}. Run 'hana-orm init' or pass --schema.`);
  const check = !!args.flags.check;
  const sources = readSchemaSources(ctx.schemaPath, ctx.cwd);
  const changed: string[] = [];
  for (const s of sources) {
    const formatted = formatSchema(s.source, s.file);
    if (formatted === s.source) continue;
    changed.push(s.file);
    if (!check) writeFileSync(s.path!, formatted);
  }
  if (check) {
    for (const f of changed) ctx.warn(`${f} is not formatted`);
    ctx.log(changed.length ? "Run 'hana-orm format' to fix." : `All ${sources.length} schema file(s) are formatted.`);
    return changed.length ? 1 : 0;
  }
  ctx.log(changed.length ? `Formatted ${changed.join(", ")}.` : `All ${sources.length} schema file(s) were already formatted.`);
  return 0;
}

async function cmdValidate(ctx: CliContext): Promise<number> {
  const c = await ctx.loadContract();
  ctx.log(`The schema is valid: ${Object.keys(c.models).length} model(s), ${Object.keys(c.enums).length} enum(s). Contract hash ${c.hash.slice(0, 12)}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const args = normalizeFlags(parseArgs(argv));
  const [command, sub] = args.positional;
  if (!command || args.flags.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }
  const cwd = process.cwd();
  const ctx = createContext(cwd, findSchema(cwd, args.flags.schema));
  try {
    switch (command) {
      case "init":
        return cmdInit(ctx);
      case "generate":
        return await cmdGenerate(ctx, args);
      case "validate":
        return await cmdValidate(ctx);
      case "format":
        return cmdFormat(ctx, args);
      case "version":
      case "--version":
        console.log(VERSION);
        return 0;
      case "db":
      case "migrate":
        if (!sub) {
          console.log(HELP);
          return 1;
        }
        return await runDbOrMigrateCommand(command, sub, { positional: args.positional.slice(2), flags: args.flags }, ctx);
      default:
        console.error(`Unknown command '${command}'. Run 'hana-orm --help'.`);
        return 1;
    }
  } catch (e) {
    if (e instanceof SchemaError) console.error(e.message);
    else console.error(`error: ${(e as Error).message}`);
    if (process.env.HANA_ORM_DEBUG) console.error(e);
    return 1;
  }
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) main(process.argv.slice(2)).then((code) => process.exit(code));
