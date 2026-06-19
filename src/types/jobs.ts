import { z } from "zod";
import { ISODateTimeSchema } from "./config.js";

// ─── Job Status Enum ────────────────────────────────────────────────────────

export const JobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

// ─── Cancellation Mode Enum ─────────────────────────────────────────────────

export const CancellationModeSchema = z.enum([
  "cancel-current",
  "queue",
  "reject-if-busy",
  "emergency-stop",
]);
export type CancellationMode = z.infer<typeof CancellationModeSchema>;

// ─── Busy Policy ────────────────────────────────────────────────────────────

export const BusyPolicySchema = z.enum([
  "queue",
  "reject-if-busy",
  "cancel-current",
  "emergency-stop",
]);
export type BusyPolicy = z.infer<typeof BusyPolicySchema>;

// ─── Job Progress ───────────────────────────────────────────────────────────

export const JobProgressSchema = z
  .object({
    current: z.number(),
    target: z.number().optional(),
    unit: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export type JobProgress = z.infer<typeof JobProgressSchema>;

// ─── Job Error ──────────────────────────────────────────────────────────────

export const JobErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  })
  .strict();
export type JobError = z.infer<typeof JobErrorSchema>;

// ─── Retry Policy ───────────────────────────────────────────────────────────

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive().default(1),
    backoffMs: z.number().int().nonnegative().default(0),
    retryOn: z.array(z.string()),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// ─── Job Cancellation Info ──────────────────────────────────────────────────

export const JobCancellationSchema = z
  .object({
    requestedAt: ISODateTimeSchema,
    reason: z.string().optional(),
    mode: CancellationModeSchema,
  })
  .strict();
export type JobCancellation = z.infer<typeof JobCancellationSchema>;

// ─── Job ────────────────────────────────────────────────────────────────────

export const JobSchema = z
  .object({
    id: z.string(),
    botId: z.string(),
    skill: z.string(),
    params: z.unknown(),
    state: JobStatusSchema,
    progress: JobProgressSchema.optional(),
    result: z.unknown().optional(),
    error: JobErrorSchema.optional(),
    timeoutMs: z.number().int().positive(),
    retry: RetryPolicySchema,
    cancellation: JobCancellationSchema.optional(),
    createdAt: ISODateTimeSchema,
    startedAt: ISODateTimeSchema.optional(),
    finishedAt: ISODateTimeSchema.optional(),
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

// ─── Stored Job (for persistence) ───────────────────────────────────────────

export const StoredJobSchema = z
  .object({
    id: z.string(),
    botId: z.string(),
    skill: z.string().optional(),
    state: JobStatusSchema,
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: JobErrorSchema.optional(),
    progress: JobProgressSchema.optional(),
    createdAt: ISODateTimeSchema,
    startedAt: ISODateTimeSchema.optional(),
    finishedAt: ISODateTimeSchema.optional(),
  })
  .strict();
export type StoredJob = z.infer<typeof StoredJobSchema>;

// ─── Stored Event (for persistence) ─────────────────────────────────────────

export const StoredEventSchema = z
  .object({
    id: z.string(),
    ts: ISODateTimeSchema,
    type: z.string(),
    botId: z.string().optional(),
    jobId: z.string().optional(),
    data: z.unknown(),
  })
  .strict();
export type StoredEvent = z.infer<typeof StoredEventSchema>;
