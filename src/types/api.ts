import { z } from "zod";
import { BotConfigSchema, BotSummarySchema, BotDetailSchema, BotStateSchema, InventorySnapshotSchema, NearbySnapshotSchema } from "./bot.js";
import { JobSchema, BusyPolicySchema, RetryPolicySchema, CancellationModeSchema } from "./jobs.js";
import { SkillDefinitionSchema } from "./skills.js";

// ─── Error Codes Enum ───────────────────────────────────────────────────────

export const ErrorCodeSchema = z.enum([
  "BOT_NOT_FOUND",
  "BOT_ALREADY_EXISTS",
  "BOT_NOT_CONNECTED",
  "BOT_DESTROYED",
  "BOT_BUSY",
  "BOT_START_FAILED",
  "BOT_STOP_FAILED",
  "BOT_DESTROY_FAILED",
  "JOB_NOT_FOUND",
  "JOB_ALREADY_FINISHED",
  "JOB_CANCELLED",
  "SKILL_NOT_FOUND",
  "SKILL_DISABLED",
  "SKILL_PERMISSION_DENIED",
  "SKILL_VALIDATION_FAILED",
  "SNAPSHOT_UNAVAILABLE",
  "VALIDATION_FAILED",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_FORBIDDEN",
  "RATE_LIMITED",
  "CHAT_RATE_LIMITED",
  "MODE_NOT_FOUND",
  "MODE_UPDATE_FAILED",
  "ENTITY_NOT_FOUND",
  "LOOK_FAILED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ─── Service Error Object ───────────────────────────────────────────────────

export const ServiceErrorObjectSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    retryable: z.boolean().optional(),
    source: z.string().optional(),
  })
  .strict();
export type ServiceErrorObject = z.infer<typeof ServiceErrorObjectSchema>;

// ─── Error Response ─────────────────────────────────────────────────────────

export const ErrorResponseSchema = z
  .object({
    error: ServiceErrorObjectSchema,
  })
  .strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ─── POST /bots — Create Bot ────────────────────────────────────────────────

export const CreateBotRequestSchema = z
  .object({
    bot: BotConfigSchema,
    connect: z.boolean().default(true),
  })
  .strict();
export type CreateBotRequest = z.infer<typeof CreateBotRequestSchema>;

export const CreateBotResponseSchema = z
  .object({
    bot: BotDetailSchema,
  })
  .strict();
export type CreateBotResponse = z.infer<typeof CreateBotResponseSchema>;

// ─── GET /bots — List Bots ──────────────────────────────────────────────────

export const ListBotsResponseSchema = z
  .object({
    bots: z.array(BotSummarySchema),
  })
  .strict();
export type ListBotsResponse = z.infer<typeof ListBotsResponseSchema>;

// ─── GET /bots/{id} — Get Bot Detail ────────────────────────────────────────

export const GetBotResponseSchema = z
  .object({
    bot: BotDetailSchema,
  })
  .strict();
export type GetBotResponse = z.infer<typeof GetBotResponseSchema>;

// ─── DELETE /bots/{id} — Destroy Bot ────────────────────────────────────────

export const DestroyBotResponseSchema = z
  .object({
    botId: z.string(),
    destroyed: z.boolean(),
    cancelledJobIds: z.array(z.string()),
  })
  .strict();
export type DestroyBotResponse = z.infer<typeof DestroyBotResponseSchema>;

// ─── GET /bots/{id}/state — Bot State ───────────────────────────────────────

export const BotStateResponseSchema = z
  .object({
    state: BotStateSchema,
  })
  .strict();
export type BotStateResponse = z.infer<typeof BotStateResponseSchema>;

// ─── GET /bots/{id}/inventory — Inventory ───────────────────────────────────

export const BotInventoryResponseSchema = z
  .object({
    inventory: InventorySnapshotSchema,
  })
  .strict();
export type BotInventoryResponse = z.infer<typeof BotInventoryResponseSchema>;

// ─── GET /bots/{id}/nearby — Nearby Snapshot ────────────────────────────────

export const BotNearbyResponseSchema = z
  .object({
    nearby: NearbySnapshotSchema,
  })
  .strict();
export type BotNearbyResponse = z.infer<typeof BotNearbyResponseSchema>;

// ─── POST /bots/{id}/actions/{skill} — Run Skill ───────────────────────────

export const RunSkillRequestSchema = z
  .object({
    params: z.unknown(),
    timeoutMs: z.number().int().positive().optional(),
    busyPolicy: BusyPolicySchema.optional(),
    retry: RetryPolicySchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type RunSkillRequest = z.infer<typeof RunSkillRequestSchema>;

export const RunSkillResponseSchema = z
  .object({
    job: JobSchema,
  })
  .strict();
export type RunSkillResponse = z.infer<typeof RunSkillResponseSchema>;

// ─── POST /jobs — Create Job ────────────────────────────────────────────────

export const CreateJobRequestSchema = z
  .object({
    botId: z.string(),
    skill: z.string(),
    params: z.unknown(),
    timeoutMs: z.number().int().positive().optional(),
    busyPolicy: BusyPolicySchema.optional(),
    retry: RetryPolicySchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const CreateJobResponseSchema = z
  .object({
    job: JobSchema,
  })
  .strict();
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

// ─── GET /jobs — List Jobs ──────────────────────────────────────────────────

export const ListJobsQuerySchema = z
  .object({
    botId: z.string().optional(),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
    skill: z.string().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).default(100),
    cursor: z.string().optional(),
  })
  .strict();
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

export const ListJobsResponseSchema = z
  .object({
    jobs: z.array(JobSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

// ─── GET /jobs/{id} — Get Job ───────────────────────────────────────────────

export const GetJobResponseSchema = z
  .object({
    job: JobSchema,
  })
  .strict();
export type GetJobResponse = z.infer<typeof GetJobResponseSchema>;

// ─── POST /jobs/{id}/cancel — Cancel Job ────────────────────────────────────

export const CancelJobRequestSchema = z
  .object({
    reason: z.string().max(512).optional(),
    mode: CancellationModeSchema.default("cancel-current"),
  })
  .strict();
export type CancelJobRequest = z.infer<typeof CancelJobRequestSchema>;

export const CancelJobResponseSchema = z
  .object({
    job: JobSchema,
    accepted: z.boolean(),
  })
  .strict();
export type CancelJobResponse = z.infer<typeof CancelJobResponseSchema>;

// ─── POST /bots/{id}/chat — Send Chat ───────────────────────────────────────

export const SendChatRequestSchema = z
  .object({
    message: z.string().min(1).max(256),
    asJob: z.boolean().default(false),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type SendChatRequest = z.infer<typeof SendChatRequestSchema>;

// ─── POST /bots/{id}/look — Look At Target ─────────────────────────────────

export const LookRequestSchema = z
  .object({
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("position"), position: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict() }).strict(),
      z.object({ type: z.literal("entity"), entityId: z.union([z.number().int(), z.string()]) }).strict(),
      z.object({ type: z.literal("player"), username: z.string().min(1) }).strict(),
    ]),
    force: z.boolean().default(true),
  })
  .strict();
export type LookRequest = z.infer<typeof LookRequestSchema>;

export const SendChatSyncResponseSchema = z
  .object({
    sent: z.boolean(),
    message: z.unknown(), // ChatMessage
  })
  .strict();

export const SendChatJobResponseSchema = z
  .object({
    job: JobSchema,
  })
  .strict();

export const SendChatResponseSchema = z.union([
  SendChatSyncResponseSchema,
  SendChatJobResponseSchema,
]);
export type SendChatResponse = z.infer<typeof SendChatResponseSchema>;

// ─── GET /skills — List Skills ──────────────────────────────────────────────

export const ListSkillsResponseSchema = z
  .object({
    skills: z.array(SkillDefinitionSchema),
  })
  .strict();
export type ListSkillsResponse = z.infer<typeof ListSkillsResponseSchema>;

// ─── GET /skills/{name} — Get Skill ─────────────────────────────────────────

export const GetSkillResponseSchema = z
  .object({
    skill: SkillDefinitionSchema,
  })
  .strict();
export type GetSkillResponse = z.infer<typeof GetSkillResponseSchema>;

// ─── POST /bots/{id}/start — Start Bot ──────────────────────────────────────

export const StartBotRequestSchema = z
  .object({
    forceReconnect: z.boolean().default(false),
    reason: z.string().max(512).optional(),
  })
  .strict();
export type StartBotRequest = z.infer<typeof StartBotRequestSchema>;

export const StartBotResponseSchema = z
  .object({
    bot: BotSummarySchema,
    accepted: z.boolean(),
  })
  .strict();
export type StartBotResponse = z.infer<typeof StartBotResponseSchema>;

// ─── POST /bots/{id}/stop — Stop Bot ────────────────────────────────────────

export const StopBotRequestSchema = z
  .object({
    reason: z.string().max(512).optional(),
    cancelRunningJobs: z.boolean().default(true),
  })
  .strict();
export type StopBotRequest = z.infer<typeof StopBotRequestSchema>;

export const StopBotResponseSchema = z
  .object({
    bot: BotSummarySchema,
    cancelledJobIds: z.array(z.string()),
  })
  .strict();
export type StopBotResponse = z.infer<typeof StopBotResponseSchema>;
