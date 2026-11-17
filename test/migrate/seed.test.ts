import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DB_MIGRATE_HELP, runDbOrMigrateCommand } from "../../src/migrate/cli.ts";
import { resolveSeedCommand, runShellCommand } from "../../src/migrate/seed.ts";
import { args, withCtx } from "./cli-ctx.ts";

test("db seed runs the command from the generator block with the schema path in the environment", () =>
  withCtx(async (ctx) => {
    await writeFile(ctx.schemaPath, "// schema file exists");
    ctx.contract = { ...ctx.contract, generators: [{ name: "client", provider: "hana-orm", seed: "node ./seed.ts" }] };
    await writeFile(join(ctx.cwd, "package.json"), JSON.stringify({ "hana-orm": { seed: "node ./other.ts" } }));
    assert.equal(await runDbOrMigrateCommand("db", "seed", args(), ctx), 0);
    assert.equal(ctx.commands.length, 1);
    assert.equal(ctx.commands[0]!.command, "node ./seed.ts", "the generator block wins over package.json");
    assert.equal(ctx.commands[0]!.cwd, ctx.cwd);
    assert.equal(ctx.commands[0]!.env.HANA_ORM_SCHEMA, ctx.schemaPath);
    assert.ok(ctx.logs.some((l) => l.includes("from generator client")));
    assert.equal(ctx.connects, 0, "seeding does not open a connection itself");
  }));

test("db seed falls back to package.json", () =>
  withCtx(async (ctx) => {
    await writeFile(join(ctx.cwd, "package.json"), JSON.stringify({ name: "demo", "hana-orm": { seed: "node ./seed.js" } }));
    assert.deepEqual(await resolveSeedCommand(ctx), { command: "node ./seed.js", source: "package.json" });
    assert.equal(await runDbOrMigrateCommand("db", "seed", args(), ctx), 0);
    assert.equal(ctx.commands[0]!.command, "node ./seed.js");
  }));

test("db seed fails without configuration and passes on the command's exit code", () =>
  withCtx(async (ctx) => {
    assert.equal(await runDbOrMigrateCommand("db", "seed", args(), ctx), 1);
    assert.match(ctx.warns.join("\n"), /No seed command configured/);
    assert.equal(ctx.commands.length, 0);

    await writeFile(join(ctx.cwd, "package.json"), JSON.stringify({ "hana-orm": { seed: "node ./seed.js" } }));
    ctx.commandExitCode = 3;
    assert.equal(await runDbOrMigrateCommand("db", "seed", args(), ctx), 3);
    assert.match(ctx.warns.at(-1)!, /exit code 3/);
  }));

test("runShellCommand returns the exit code of a real process", async () => {
  assert.equal(await runShellCommand(`"${process.execPath}" -e "process.exit(process.env.SEED_TEST === 'yes' ? 4 : 0)"`, process.cwd(), { ...process.env, SEED_TEST: "yes" }), 4);
});

test("db seed is in the help text", () => {
  assert.match(DB_MIGRATE_HELP, /db seed/);
});
