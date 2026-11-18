// Connects to the HANA in HANA_ORM_ENV_FILE (or the environment) and prints its version.
// Used by the integration workflow before the tests, so a broken setup fails loudly instead of
// the tests skipping themselves.
import { HanaDriver } from "../src/runtime/hana-driver.ts";

if (process.env.HANA_ORM_ENV_FILE) process.loadEnvFile(process.env.HANA_ORM_ENV_FILE);
const { HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD, HANA_DATABASE } = process.env;
if (!HANA_HOST || !HANA_PORT || !HANA_USER || !HANA_PASSWORD) {
  console.error("Set HANA_HOST, HANA_PORT, HANA_USER and HANA_PASSWORD (or HANA_ORM_ENV_FILE)");
  process.exit(1);
}

const driver = new HanaDriver({ host: HANA_HOST, port: Number(HANA_PORT), user: HANA_USER, password: HANA_PASSWORD, ...(HANA_DATABASE ? { databaseName: HANA_DATABASE } : {}) }, { poolSize: 1 });
try {
  const [row] = await driver.query<{ VERSION: string }>("SELECT VERSION FROM SYS.M_DATABASE");
  console.log(`Connected to HANA ${row?.VERSION ?? "(unknown version)"} at ${HANA_HOST}:${HANA_PORT}`);
} catch (e) {
  console.error(`Cannot connect to HANA at ${HANA_HOST}:${HANA_PORT}: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await driver.close();
}
