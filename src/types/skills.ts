import { z } from "zod";
import { BusyPolicySchema } from "./jobs.js";

// ─── Skill Category ─────────────────────────────────────────────────────────

export const SkillCategorySchema = z.string();
export type SkillCategory = z.infer<typeof SkillCategorySchema>;

// ─── Skill Permission (from bot.ts, re-exported for convenience) ────────────

export const SkillPermissionSchema = z.enum([
  "movement",
  "inventory",
  "block.place",
  "block.break",
  "combat",
  "chat",
  "container",
  "entity.interact",
]);
export type SkillPermission = z.infer<typeof SkillPermissionSchema>;

// ─── Skill Error ────────────────────────────────────────────────────────────

export const SkillErrorCodeSchema = z.enum([
  "SKILL_NOT_FOUND",
  "SKILL_DISABLED",
  "PERMISSION_DENIED",
  "VALIDATION_FAILED",
  "BOT_NOT_READY",
  "JOB_CANCELLED",
  "JOB_TIMEOUT",
  "PATH_NOT_FOUND",
  "TARGET_NOT_FOUND",
  "MISSING_ITEM",
  "MISSING_TOOL",
  "INVENTORY_FULL",
  "CONTAINER_NOT_FOUND",
  "CONTAINER_BUSY",
  "UNSAFE_BLOCK",
  "MINEFLAYER_ERROR",
]);
export type SkillErrorCode = z.infer<typeof SkillErrorCodeSchema>;

export const SkillErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  })
  .strict();
export type SkillError = z.infer<typeof SkillErrorSchema>;

// ─── Skill Result Status ────────────────────────────────────────────────────

export const SkillResultStatusSchema = z.enum(["success", "failed", "cancelled"]);
export type SkillResultStatus = z.infer<typeof SkillResultStatusSchema>;

// ─── Skill Result ───────────────────────────────────────────────────────────

export const SkillResultSchema = z
  .object({
    ok: z.boolean(),
    status: SkillResultStatusSchema,
    data: z.unknown().optional(),
    message: z.string().optional(),
    output: z.array(z.string()).optional(),
    error: SkillErrorSchema.optional(),
    metrics: z
      .object({
        startedAt: z.string(),
        finishedAt: z.string(),
        durationMs: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SkillResult = z.infer<typeof SkillResultSchema>;

// ─── Skill Definition (API-facing, without runtime handler) ─────────────────

export const SkillDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    category: z.string(),
    permissions: z.array(z.string()),
    timeoutMs: z.number().int().positive(),
    busyPolicy: BusyPolicySchema,
    readOnly: z.boolean(),
    parametersSchema: z.record(z.unknown()),
    resultSchema: z.record(z.unknown()).optional(),
  })
  .strict();
export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

// ─── Skill Manifest (plugin manifest JSON) ──────────────────────────────────

export const SkillManifestEntrySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    category: z.string(),
    permissions: z.array(z.string()),
    timeoutMs: z.number().int().positive(),
    busyPolicy: BusyPolicySchema,
    parametersSchema: z.record(z.unknown()),
  })
  .strict();
export type SkillManifestEntry = z.infer<typeof SkillManifestEntrySchema>;

export const SkillManifestSchema = z
  .object({
    schemaVersion: z.number().int(),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    main: z.string().min(1),
    author: z.string().optional(),
    mcAgentService: z
      .object({
        minVersion: z.string().optional(),
      })
      .strict()
      .optional(),
    skills: z.array(SkillManifestEntrySchema),
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ─── Skill Execution Context (runtime shape, not serialized) ────────────────

export const SkillProgressReportSchema = z
  .object({
    current: z.number(),
    target: z.number().optional(),
    unit: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export type SkillProgressReport = z.infer<typeof SkillProgressReportSchema>;

// Note: SkillExecutionContext is a runtime-only interface that includes
// live Bot references, AbortSignal, and helper objects. It cannot be
// fully represented as a Zod schema because it contains non-serializable
// objects. We define the serializable parts here and the full interface
// in the skills module.

export interface SkillExecutionContext {
  bot: unknown; // Mineflayer Bot — runtime only, not serializable
  params: unknown;
  jobId: string;
  botId: string;
  signal: AbortSignal;
  cancellation: {
    isCancellationRequested(): boolean;
    throwIfCancellationRequested(): void;
    reason?: string;
  };
  progress(report: SkillProgressReport): void;
  emit(event: { type: string; data: unknown }): void;
  log(message: string, fields?: Record<string, unknown>): void;
  config: Readonly<unknown>; // Readonly<BotConfig>
  helpers: {
    world: unknown;
    inventory: unknown;
    movement: unknown;
    cleanup: unknown;
    mcData: unknown;
    modes: unknown;
  };
}

// ─── Skill Permissions Map ──────────────────────────────────────────────────

export const SkillPermissionsSchema = z.record(
  SkillPermissionSchema,
  z.boolean(),
);
export type SkillPermissions = z.infer<typeof SkillPermissionsSchema>;
