/** A CliContext for command tests: temp folder, fake driver, recorded output and commands. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext, ParsedArgs } from "../../src/cli/context.ts";
import type { Contract } from "../../src/schema/contract.ts";
import { blogContract, FakeDriver } from "./fixtures.ts";

export interface TestCtx extends CliContext {
  logs: string[];
  warns: string[];
  contract: Contract;
  driver: FakeDriver;
  /** Answers for `confirm`, consumed in order; the default answer when empty. */
  answers: boolean[];
  /** Questions asked through `confirm`. */
  questions: string[];
  /** Commands run through `runCommand`. */
  commands: { command: string; cwd: string; env: NodeJS.ProcessEnv }[];
  /** Exit code returned by `runCommand`. */
  commandExitCode: number;
  host: string;
  /** Number of `connect()` calls. */
  connects: number;
}

export async function makeCtx(): Promise<TestCtx> {
  const dir = await mkdtemp(join(tmpdir(), "hana-orm-cli-"));
  const ctx: TestCtx = {
    cwd: dir,
    schemaPath: join(dir, "schema.hana"),
    migrationsDir: join(dir, "migrations"),
    logs: [],
    warns: [],
    contract: blogContract(),
    driver: new FakeDriver(),
    answers: [],
    questions: [],
    commands: [],
    commandExitCode: 0,
    host: "localhost",
    connects: 0,
    async loadContract() {
      return ctx.contract;
    },
    async connect() {
      ctx.connects++;
      return ctx.driver;
    },
    async defaultSchema() {
      return undefined;
    },
    async connectionHost() {
      return ctx.host;
    },
    log(m) {
      ctx.logs.push(m);
    },
    warn(m) {
      ctx.warns.push(m);
    },
    async confirm(q, d) {
      ctx.questions.push(q);
      return ctx.answers.length ? ctx.answers.shift()! : d;
    },
    async runCommand(command, cwd, env) {
      ctx.commands.push({ command, cwd, env });
      return ctx.commandExitCode;
    },
  };
  return ctx;
}

export async function withCtx(fn: (ctx: TestCtx) => Promise<void>): Promise<void> {
  const ctx = await makeCtx();
  try {
    await fn(ctx);
  } finally {
    await rm(ctx.cwd, { recursive: true, force: true });
  }
}

export const args = (flags: Record<string, string | boolean> = {}, positional: string[] = []): ParsedArgs => ({ flags, positional });
