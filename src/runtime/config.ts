import type { ConfigValue, DatasourceDef } from "../schema/contract.ts";
import type { ConnectionConfig } from "./hana-driver.ts";

let envLoaded = false;

/** Loads `.env` from the working directory once, without overriding existing variables. */
export function loadDotEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: fine
  }
}

export function resolveConfigValue(v: ConfigValue | undefined): string | number | boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "object") {
    let value = process.env[v.env];
    if (value === undefined) {
      loadDotEnv();
      value = process.env[v.env];
    }
    if (value === undefined || value === "") return undefined;
    return value;
  }
  return v;
}

function bool(v: string | number | boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true" || v === "1";
}

/** Parses `hana://user:password@host:port/?databaseName=X&currentSchema=Y&encrypt=true`. */
export function parseHanaUrl(url: string): Partial<ConnectionConfig> {
  const u = new URL(url);
  if (u.protocol !== "hana:") throw new Error(`Datasource url must start with hana:// (got ${u.protocol}//)`);
  const out: Partial<ConnectionConfig> = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 30015,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
  const q = u.searchParams;
  if (q.get("databaseName")) out.databaseName = q.get("databaseName")!;
  if (q.get("currentSchema")) out.currentSchema = q.get("currentSchema")!;
  if (q.has("encrypt")) out.encrypt = bool(q.get("encrypt")!);
  if (q.has("sslValidateCertificate")) out.sslValidateCertificate = bool(q.get("sslValidateCertificate")!);
  return out;
}

/**
 * Builds the connection config from the datasource block. Falls back to the conventional
 * `HANA_HOST`, `HANA_PORT`, `HANA_USER`, `HANA_PASSWORD`, `HANA_DATABASE`, `HANA_SCHEMA`,
 * `HANA_ENCRYPT`, `HANA_SSL_VALIDATE_CERTIFICATE` env vars for anything not configured.
 */
export function resolveConnectionConfig(ds: DatasourceDef | undefined, override: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const fromUrl = ds?.url !== undefined ? resolveConfigValue(ds.url) : undefined;
  const base: Partial<ConnectionConfig> = typeof fromUrl === "string" ? parseHanaUrl(fromUrl) : {};
  const env = (name: string) => resolveConfigValue({ env: name });
  const pick = (v: ConfigValue | undefined, envName: string) => resolveConfigValue(v) ?? env(envName);

  const cfg: Partial<ConnectionConfig> = {
    host: String(pick(ds?.host, "HANA_HOST") ?? base.host ?? ""),
    port: Number(pick(ds?.port, "HANA_PORT") ?? base.port ?? 30015),
    user: String(pick(ds?.user, "HANA_USER") ?? base.user ?? ""),
    password: String(pick(ds?.password, "HANA_PASSWORD") ?? base.password ?? ""),
  };
  const databaseName = pick(ds?.databaseName, "HANA_DATABASE") ?? base.databaseName;
  if (databaseName) cfg.databaseName = String(databaseName);
  const schema = pick(ds?.schema, "HANA_SCHEMA") ?? base.currentSchema;
  if (schema) cfg.currentSchema = String(schema);
  const encrypt = bool(pick(ds?.encrypt, "HANA_ENCRYPT")) ?? base.encrypt;
  if (encrypt !== undefined) cfg.encrypt = encrypt;
  const ssl = bool(pick(ds?.sslValidateCertificate, "HANA_SSL_VALIDATE_CERTIFICATE")) ?? base.sslValidateCertificate;
  if (ssl !== undefined) cfg.sslValidateCertificate = ssl;

  const result = { ...cfg, ...override } as ConnectionConfig;
  const missing = (["host", "user", "password"] as const).filter((k) => !result[k]);
  if (missing.length) {
    throw new Error(
      `Missing HANA connection settings: ${missing.join(", ")}. Set them in the datasource block or via HANA_HOST / HANA_USER / HANA_PASSWORD (a .env file in the working directory is loaded automatically).`,
    );
  }
  return result;
}

/** The default database schema configured for the datasource, if any. */
export function resolveDefaultSchema(ds: DatasourceDef | undefined): string | undefined {
  const v = resolveConfigValue(ds?.schema) ?? resolveConfigValue({ env: "HANA_SCHEMA" });
  if (v) return String(v);
  const url = resolveConfigValue(ds?.url);
  if (typeof url === "string") return parseHanaUrl(url).currentSchema;
  return undefined;
}
