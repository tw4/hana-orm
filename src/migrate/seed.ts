/**
 * `hana-orm db seed`: runs the project's seed command with the connection environment loaded.
 *
 * The command is configured in one of two places (first match wins):
 *
 * - `seed = "node ./seed.ts"` in a `generator` block of the schema
 * - `"hana-orm": { "seed": "node ./seed.ts" }` in `package.json` of the working directory
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliContext, ParsedArgs } from "../cli/context.ts";

export interface SeedCommand {
  command: string;
  /** Where it was configured, for messages. */
  source: string;
}

/** Finds the configured seed command, or undefined when none is configured. */
export async function resolveSeedCommand(ctx: CliContext): Promise<SeedCommand | undefined> {
  if (existsSync(ctx.schemaPath)) {
    const contract = await ctx.loadContract();
    for (const g of contract.generators) {
      if (typeof g.seed === "string" && g.seed.trim()) return { command: g.seed.trim(), source: `generator ${g.name}` };
    }
  }
  const pkgPath = join(ctx.cwd, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (e) {
      throw new Error(`Could not read package.json: ${(e as Error).message}`);
    }
    const seed = (pkg as { "hana-orm"?: { seed?: unknown } })?.["hana-orm"]?.seed;
    if (typeof seed === "string" && seed.trim()) return { command: seed.trim(), source: "package.json" };
  }
  return undefined;
}

/** Runs a shell command in `cwd`, inheriting stdio and the (already .env-loaded) environment. */
export function runShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export const SEED_NOT_CONFIGURED =
  'No seed command configured. Add `seed = "node ./seed.ts"` to the generator block of the schema, or `"hana-orm": { "seed": "..." }` to package.json.';

/**
 * Runs the seed command. Returns its exit code; `required: false` turns a missing
 * configuration into a no-op (used by `migrate reset`).
 */
export async function runSeed(ctx: CliContext, options: { required: boolean }): Promise<number> {
  const seed = await resolveSeedCommand(ctx);
  if (!seed) {
    if (options.required) {
      ctx.warn(SEED_NOT_CONFIGURED);
      return 1;
    }
    return 0;
  }
  ctx.log(`Running seed command from ${seed.source}: ${seed.command}`);
  const env = { ...process.env, HANA_ORM_SCHEMA: ctx.schemaPath };
  const code = await (ctx.runCommand ?? ((c, cwd, e) => runShellCommand(c, cwd, e)))(seed.command, ctx.cwd, env);
  if (code !== 0) ctx.warn(`The seed command failed with exit code ${code}.`);
  else ctx.log("Seeding finished.");
  return code;
}

export async function dbSeed(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  return runSeed(ctx, { required: true });
}
