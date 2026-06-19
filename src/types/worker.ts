import { z } from "zod";
import { BotConfigSchema } from "./bot.js";
import { CancellationModeSchema, JobProgressSchema, JobErrorSchema, JobSchema } from "./jobs.js";

// ─── Worker Command Discriminated Union ─────────────────────────────────────

export const WorkerConnectCommandSchema = z
  .object({
    type: z.literal("connect"),
    botConfig: BotConfigSchema,
  })
  .strict();

export const WorkerDisconnectCommandSchema = z
  .object({
    type: z.literal("disconnect"),
    reason: z.string().optional(),
  })
  .strict();

export const WorkerDestroyCommandSchema = z
  .object({
    type: z.literal("destroy"),
    reason: z.string().optional(),
  })
  .strict();

export const WorkerRunSkillCommandSchema = z
  .object({
    type: z.literal("runSkill"),
    jobId: z.string(),
    skill: z.string(),
    params: z.unknown(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const WorkerCancelJobCommandSchema = z
  .object({
    type: z.literal("cancelJob"),
    jobId: z.string(),
    mode: CancellationModeSchema,
    reason: z.string().optional(),
  })
  .strict();

export const WorkerSendChatCommandSchema = z
  .object({
    type: z.literal("sendChat"),
    jobId: z.string().optional(),
    message: z.string(),
  })
  .strict();

export const WorkerGetSnapshotCommandSchema = z
  .object({
    type: z.literal("getSnapshot"),
    requestId: z.string(),
  })
  .strict();

export const WorkerToggleModeCommandSchema = z
  .object({
    type: z.literal("toggleMode"),
    modeName: z.string(),
    enabled: z.boolean().optional(),
    paused: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const WorkerCommandSchema = z.discriminatedUnion("type", [
  WorkerConnectCommandSchema,
  WorkerDisconnectCommandSchema,
  WorkerDestroyCommandSchema,
  WorkerRunSkillCommandSchema,
  WorkerCancelJobCommandSchema,
  WorkerSendChatCommandSchema,
  WorkerGetSnapshotCommandSchema,
  WorkerToggleModeCommandSchema,
]);
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;

// ─── Individual Worker Command Type Aliases ─────────────────────────────────

export type WorkerConnectCommand = z.infer<typeof WorkerConnectCommandSchema>;
export type WorkerDisconnectCommand = z.infer<typeof WorkerDisconnectCommandSchema>;
export type WorkerDestroyCommand = z.infer<typeof WorkerDestroyCommandSchema>;
export type WorkerRunSkillCommand = z.infer<typeof WorkerRunSkillCommandSchema>;
export type WorkerCancelJobCommand = z.infer<typeof WorkerCancelJobCommandSchema>;
export type WorkerSendChatCommand = z.infer<typeof WorkerSendChatCommandSchema>;
export type WorkerGetSnapshotCommand = z.infer<typeof WorkerGetSnapshotCommandSchema>;

// ─── Worker Event Discriminated Union ───────────────────────────────────────

export const WorkerConnectedEventSchema = z
  .object({
    type: z.literal("connected"),
    botId: z.string(),
    host: z.string(),
    port: z.number().int(),
  })
  .strict();

export const WorkerDisconnectedEventSchema = z
  .object({
    type: z.literal("disconnected"),
    botId: z.string(),
    reason: z.string().optional(),
    expected: z.boolean(),
    willReconnect: z.boolean(),
  })
  .strict();

export const WorkerStateUpdateEventSchema = z
  .object({
    type: z.literal("stateUpdate"),
    botId: z.string(),
    state: z.unknown(), // BotStateSnapshot — full serializable state
  })
  .strict();

export const WorkerJobProgressEventSchema = z
  .object({
    type: z.literal("jobProgress"),
    botId: z.string(),
    jobId: z.string(),
    progress: JobProgressSchema,
  })
  .strict();

export const WorkerJobCompleteEventSchema = z
  .object({
    type: z.literal("jobComplete"),
    botId: z.string(),
    jobId: z.string(),
    job: JobSchema,
    result: z.unknown().optional(),
  })
  .strict();

export const WorkerJobFailedEventSchema = z
  .object({
    type: z.literal("jobFailed"),
    botId: z.string(),
    jobId: z.string(),
    job: JobSchema,
    error: JobErrorSchema,
  })
  .strict();

export const WorkerChatReceivedEventSchema = z
  .object({
    type: z.literal("chatReceived"),
    botId: z.string(),
    sender: z.string().optional(),
    message: z.string(),
    raw: z.unknown().optional(),
    ts: z.string(),
  })
  .strict();

export const WorkerErrorEventSchema = z
  .object({
    type: z.literal("error"),
    botId: z.string(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    source: z.string().optional(),
    details: z.unknown().optional(),
  })
  .strict();

export const WorkerEventSchema = z.discriminatedUnion("type", [
  WorkerConnectedEventSchema,
  WorkerDisconnectedEventSchema,
  WorkerStateUpdateEventSchema,
  WorkerJobProgressEventSchema,
  WorkerJobCompleteEventSchema,
  WorkerJobFailedEventSchema,
  WorkerChatReceivedEventSchema,
  WorkerErrorEventSchema,
]);
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;

// ─── Individual Worker Event Type Aliases ───────────────────────────────────

export type WorkerConnectedEvent = z.infer<typeof WorkerConnectedEventSchema>;
export type WorkerDisconnectedEvent = z.infer<typeof WorkerDisconnectedEventSchema>;
export type WorkerStateUpdateEvent = z.infer<typeof WorkerStateUpdateEventSchema>;
export type WorkerJobProgressEvent = z.infer<typeof WorkerJobProgressEventSchema>;
export type WorkerJobCompleteEvent = z.infer<typeof WorkerJobCompleteEventSchema>;
export type WorkerJobFailedEvent = z.infer<typeof WorkerJobFailedEventSchema>;
export type WorkerChatReceivedEvent = z.infer<typeof WorkerChatReceivedEventSchema>;
export type WorkerErrorEvent = z.infer<typeof WorkerErrorEventSchema>;

// ─── Worker Snapshot Response (for getSnapshot command) ─────────────────────

export const WorkerSnapshotResponseSchema = z
  .object({
    type: z.literal("snapshot"),
    requestId: z.string(),
    botId: z.string(),
    state: z.unknown(), // BotStateSnapshot
  })
  .strict();
export type WorkerSnapshotResponse = z.infer<typeof WorkerSnapshotResponseSchema>;
