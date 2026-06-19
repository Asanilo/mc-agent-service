import { z } from "zod";

// ─── Vec3 / Rotation (shared primitives) ────────────────────────────────────

export const Vec3Schema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
export type Vec3 = z.infer<typeof Vec3Schema>;

export const RotationSchema = z
  .object({
    yaw: z.number(),
    pitch: z.number(),
  })
  .strict();
export type Rotation = z.infer<typeof RotationSchema>;

// ─── ISO DateTime ───────────────────────────────────────────────────────────

export const ISODateTimeSchema = z.string().datetime();
export type ISODateTime = z.infer<typeof ISODateTimeSchema>;

// ─── Auth Config ────────────────────────────────────────────────────────────

export const AuthNoneSchema = z.object({ mode: z.literal("none") }).strict();
export const AuthBearerSchema = z
  .object({
    mode: z.literal("bearer"),
    tokenEnv: z.string().min(1),
  })
  .strict();
export const AuthApiKeySchema = z
  .object({
    mode: z.literal("api-key"),
    header: z.string().min(1),
    keyEnv: z.string().min(1),
  })
  .strict();

export const AuthConfigSchema = z.discriminatedUnion("mode", [
  AuthNoneSchema,
  AuthBearerSchema,
  AuthApiKeySchema,
]);
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// ─── Storage Config ─────────────────────────────────────────────────────────

export const StorageConfigSchema = z
  .object({
    provider: z.enum(["none", "file"]),
    dataDir: z.string().min(1),
    eventLog: z.boolean(),
    jobHistory: z.boolean(),
    maxEventLogBytes: z.number().int().positive().optional(),
    maxJobHistoryBytes: z.number().int().positive().optional(),
  })
  .strict();
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

// ─── Rate Limit Config ──────────────────────────────────────────────────────

export const RateLimitConfigSchema = z
  .object({
    enabled: z.boolean(),
    maxRequestsPerMinute: z.number().int().positive(),
    maxSkillInvocationsPerMinute: z.number().int().positive(),
    maxChatMessagesPerMinute: z.number().int().positive(),
  })
  .strict();
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

// ─── Reconnect Policy ───────────────────────────────────────────────────────

export const ReconnectPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().int().nonnegative().default(1000),
    maxDelayMs: z.number().int().nonnegative().default(60000),
    factor: z.number().min(1).default(2),
    jitter: z.boolean().default(true),
    maxAttempts: z.number().int().positive().optional(),
  })
  .strict();
export type ReconnectPolicy = z.infer<typeof ReconnectPolicySchema>;

// ─── Memory Config ──────────────────────────────────────────────────────────

export const MemoryFileConfigSchema = z
  .object({
    path: z.string().optional(),
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();

export const MemoryHermesConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    scopeRecallPath: z.string().optional(),
  })
  .strict();

export const MemoryConfigSchema = z
  .object({
    provider: z.enum(["none", "file", "hermes"]).default("none"),
    scope: z.string().optional(),
    file: MemoryFileConfigSchema.optional(),
    hermes: MemoryHermesConfigSchema.optional(),
  })
  .strict();
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

// ─── Compatibility Config ───────────────────────────────────────────────────

export const CompatibilityConfigSchema = z
  .object({
    acceptResourcePacks: z.boolean().default(true),
    throttlePositionPackets: z.boolean().default(false),
    positionThrottleMs: z.number().int().nonnegative().default(100),
    suppressPartialReadErrors: z.boolean().default(true),
  })
  .strict();
export type CompatibilityConfig = z.infer<typeof CompatibilityConfigSchema>;

// ─── Logging Config ─────────────────────────────────────────────────────────

export const LoggingConfigSchema = z
  .object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
    pretty: z.boolean(),
  })
  .strict();
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

// ─── Workers Config ─────────────────────────────────────────────────────────

export const WorkersConfigSchema = z
  .object({
    stopGraceMs: z.number().int().positive(),
    maxBots: z.number().int().positive(),
  })
  .strict();
export type WorkersConfig = z.infer<typeof WorkersConfigSchema>;

// ─── MCP Config ─────────────────────────────────────────────────────────────

export const McpConfigSchema = z
  .object({
    enabled: z.boolean(),
    transport: z.enum(["stdio", "http"]),
    path: z.string().optional(),
  })
  .strict();
export type McpConfig = z.infer<typeof McpConfigSchema>;

// ─── WebSocket Config ───────────────────────────────────────────────────────

export const WebSocketConfigSchema = z
  .object({
    enabled: z.boolean(),
    path: z.string().min(1),
  })
  .strict();
export type WebSocketConfig = z.infer<typeof WebSocketConfigSchema>;

// ─── Server Config ──────────────────────────────────────────────────────────

export const ServerConfigSchema = z
  .object({
    http: z
      .object({
        host: z.string(),
        port: z.number().int().min(1).max(65535),
      })
      .strict(),
    websocket: WebSocketConfigSchema,
    mcp: McpConfigSchema,
    auth: AuthConfigSchema,
    storage: StorageConfigSchema,
    logging: LoggingConfigSchema,
    workers: WorkersConfigSchema,
    rateLimit: RateLimitConfigSchema.optional(),
  })
  .strict();
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
