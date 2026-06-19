/**
 * Config loader for mc-agent-service.
 *
 * Responsibilities (from SPEC §3):
 *  - Load defaults.
 *  - Merge config file values.
 *  - Merge environment variable overrides.
 *  - Validate with ServerConfig Zod schema.
 *  - Redact secrets in logs and API responses.
 *
 * Environment variable overrides:
 *  MCAGENT_PORT, MCAGENT_HOST, MCAGENT_AUTH_MODE, MCAGENT_AUTH_TOKEN,
 *  MCAGENT_LOG_LEVEL
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ServerConfigSchema, type ServerConfig } from "../types/config.js";

// ─── Secrets to redact ─────────────────────────────────────────────────────

const SECRET_KEYS = new Set(["token", "tokenEnv", "passwordEnv", "keyEnv"]);

// ─── Default configuration ─────────────────────────────────────────────────

const DEFAULTS: ServerConfig = {
  http: {
    host: "0.0.0.0",
    port: 3000,
  },
  websocket: {
    enabled: true,
    path: "/ws",
  },
  mcp: {
    enabled: false,
    transport: "stdio",
  },
  auth: {
    mode: "none",
  },
  storage: {
    provider: "none",
    dataDir: "./data",
    eventLog: false,
    jobHistory: false,
  },
  logging: {
    level: "info",
    pretty: false,
  },
  workers: {
    stopGraceMs: 5000,
    maxBots: 8,
  },
  bots: [],
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Deep-merge source into target (mutates target). Arrays replaced, not merged. */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (target as Record<string, unknown>)[key];

    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      (target as Record<string, unknown>)[key] = srcVal;
    }
  }
  return target;
}

/** Recursively redact secret-looking values for safe logging/display. */
function redactSecrets(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key) && typeof value === "string") {
      out[key] = "***REDACTED***";
    } else if (typeof value === "object" && value !== null) {
      out[key] = redactSecrets(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ─── LoadConfig ────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  /** Path to a JSON config file. Defaults to MCAGENT_CONFIG or ./mc-agent-service.json */
  configPath?: string;
}

/**
 * Load, merge, and validate the service configuration.
 *
 * 1. Start from built-in defaults.
 * 2. Merge values from a JSON config file (if it exists).
 * 3. Apply environment variable overrides.
 * 4. Validate the final object against ServerConfigSchema.
 *
 * Returns a ConfigFacade that holds the validated config and provides
 * a `toJSON()` method with secrets redacted.
 */
export async function loadConfig(
  opts: LoadConfigOptions = {},
): Promise<ConfigFacade> {
  // 1. Defaults
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULTS));

  // 2. Config file
  const configPath = opts.configPath
    ?? process.env["MCAGENT_CONFIG"]
    ?? resolve(process.cwd(), "mc-agent-service.json");

  try {
    const raw = await readFile(configPath, "utf-8");
    const fileConfig = JSON.parse(raw) as Record<string, unknown>;
    deepMerge(merged, fileConfig);
  } catch (err: unknown) {
    // ENOENT is fine — file is optional. Other errors are thrown.
    const isNodeError = err !== null && typeof err === "object" && "code" in err;
    const code = isNodeError ? String((err as Record<string, unknown>)["code"]) : undefined;
    if (code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read config file ${configPath}: ${msg}`);
    }
  }

  // 3. Environment variable overrides
  applyEnvOverrides(merged);

  // 4. Validate
  const result = ServerConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return new ConfigFacade(result.data);
}

// ── Env overrides ──────────────────────────────────────────────────────────

function applyEnvOverrides(cfg: Record<string, unknown>): void {
  // Ensure nested objects exist
  if (typeof cfg["http"] !== "object" || cfg["http"] === null) {
    cfg["http"] = {};
  }
  const http = cfg["http"] as Record<string, unknown>;

  if (typeof cfg["auth"] !== "object" || cfg["auth"] === null) {
    cfg["auth"] = {};
  }
  const auth = cfg["auth"] as Record<string, unknown>;

  if (typeof cfg["logging"] !== "object" || cfg["logging"] === null) {
    cfg["logging"] = {};
  }
  const logging = cfg["logging"] as Record<string, unknown>;

  // MCAGENT_PORT
  const portEnv = process.env["MCAGENT_PORT"];
  if (portEnv !== undefined) {
    http["port"] = Number(portEnv);
  }

  // MCAGENT_HOST
  const hostEnv = process.env["MCAGENT_HOST"];
  if (hostEnv !== undefined) {
    http["host"] = hostEnv;
  }

  // MCAGENT_AUTH_MODE
  const authMode = process.env["MCAGENT_AUTH_MODE"];
  if (authMode !== undefined) {
    auth["mode"] = authMode;

    // When bearer mode is set via env, auto-configure tokenEnv if not already set
    if (authMode === "bearer" && auth["tokenEnv"] === undefined) {
      auth["tokenEnv"] = "MCAGENT_AUTH_TOKEN";
    }
  }

  // MCAGENT_AUTH_TOKEN — if set and auth is bearer, ensure tokenEnv points to it
  const authToken = process.env["MCAGENT_AUTH_TOKEN"];
  if (authToken !== undefined && auth["mode"] === "bearer") {
    auth["tokenEnv"] = "MCAGENT_AUTH_TOKEN";
  }

  // MCAGENT_LOG_LEVEL
  const logLevel = process.env["MCAGENT_LOG_LEVEL"];
  if (logLevel !== undefined) {
    logging["level"] = logLevel;
  }
}

// ─── ConfigFacade ──────────────────────────────────────────────────────────

/**
 * Wrapper around validated ServerConfig that provides safe JSON serialization
 * with secrets redacted. Also exposes the raw config for internal use.
 */
export class ConfigFacade {
  constructor(private readonly config: ServerConfig) {}

  /** The validated ServerConfig (secrets included — internal use only). */
  get raw(): ServerConfig {
    return this.config;
  }

  /** Convenience accessors */
  get host(): string {
    return this.config.http.host;
  }

  get port(): number {
    return this.config.http.port;
  }

  get authMode(): string {
    return this.config.auth.mode;
  }

  get logLevel(): string {
    return this.config.logging.level;
  }

  get maxBots(): number {
    return this.config.workers.maxBots;
  }

  get storageProvider(): string {
    return this.config.storage.provider;
  }

  /** Return a plain object with secrets replaced by `***REDACTED***`. */
  toJSON(): unknown {
    return redactSecrets(this.config);
  }
}
