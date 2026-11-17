// Generates typed clients for test fixtures. Run before tests/typecheck: `node test/setup.ts`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { compileSchema } from "../src/schema/build.ts";
import { generateClient } from "../src/generator/client.ts";

for (const name of ["blog", "itest"]) {
  const contract = compileSchema(readFileSync(new URL(`./fixtures/${name}.hana`, import.meta.url), "utf8"), { file: `${name}.hana` });
  const dir = new URL(`./generated/${name}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("index.ts", dir), generateClient(contract, { runtimeImport: "../../../src/runtime/index.ts" }));
}
