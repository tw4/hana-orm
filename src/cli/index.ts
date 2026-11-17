#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compileSchema } from "../schema/build.ts";
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
  version              Print the version
${DB_MIGRATE_HELP}
Global options
  --schema <path>      Schema file (default: ./schema.hana, then ./hana/schema.hana)
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
const BOOLEAN_FLAGS = new Set(["watch", "help", "dry-run", "allow-destructive", "print", "empty", "views", "force", "yes"]);

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
  return resolve(cwd, "schema.hana");
}

function createContext(cwd: string, schemaPath: string): CliContext {
  let cached: Contract | undefined;
  const loadContract = async () => {
    if (cached) return cached;
    if (!existsSync(schemaPath)) throw new Error(`Schema file not found: ${relative(cwd, schemaPath) || schemaPath}. Run 'hana-orm init' or pass --schema.`);
    cached = compileSchema(readFileSync(schemaPath, "utf8"), { file: relative(cwd, schemaPath) });
    return cached;
  };
  const datasource = async () => (existsSync(schemaPath) ? (await loadContract()).datasource : undefined);
  return {
    cwd,
    schemaPath,
    migrationsDir: join(dirname(schemaPath), "migrations"),
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
      contract = compileSchema(readFileSync(ctx.schemaPath, "utf8"), { file: relative(ctx.cwd, ctx.schemaPath) });
    } catch (e) {
      if (e instanceof SchemaError) {
        console.error(e.message);
        return false;
      }
      throw e;
    }
    const generators = contract.generators.length ? contract.generators : [{ name: "client", provider: "hana-orm", output: "./generated/hana" }];
    for (const g of generators) {
      const outDir = resolve(dirname(ctx.schemaPath), String(g.output ?? "./generated/hana"));
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
