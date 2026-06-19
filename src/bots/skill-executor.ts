import type { Bot } from "mineflayer";
import type { IndexedData } from "minecraft-data";
import type { ZodType, ZodTypeDef } from "zod";
import type { BotConfig } from "../types/bot.js";
import type {
  SkillResult,
  SkillResultStatus,
  SkillProgressReport,
  SkillPermission,
} from "../types/skills.js";
import type { ModeEngine } from "./mode-engine.js";

// ─── Skill Definition (runtime, with handler) ───────────────────────────────

export interface SkillDefinition<TParams = unknown> {
  name: string;
  description: string;
  category: string;
  parameters: ZodType<TParams, ZodTypeDef, unknown>;
  permissions: SkillPermission[];
  timeoutMs: number;
  busyPolicy: "queue" | "reject-if-busy" | "cancel-current" | "emergency-stop";
  readOnly: boolean;
  run: (ctx: SkillExecutionContext, params: TParams) => Promise<SkillResult>;
}

// ─── Skill Execution Context ────────────────────────────────────────────────

export interface SkillExecutionContext {
  bot: Bot;
  mcData: IndexedData;
  botId: string;
  jobId: string;
  signal: AbortSignal;
  config: Readonly<BotConfig>;
  modes: ModeEngine;
  progress: (report: SkillProgressReport) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

// ─── SkillExecutor ──────────────────────────────────────────────────────────

export class SkillExecutor {
  private registry = new Map<string, SkillDefinition>();
  private currentController: AbortController | null = null;
  private currentJobId: string | null = null;

  // ── Register a skill ────────────────────────────────────────────────────

  registerSkill<TParams>(definition: SkillDefinition<TParams>): void {
    if (this.registry.has(definition.name)) {
      throw new Error(`Skill "${definition.name}" is already registered`);
    }
    this.registry.set(definition.name, definition as SkillDefinition);
  }

  // ── Unregister ──────────────────────────────────────────────────────────

  unregisterSkill(name: string): boolean {
    return this.registry.delete(name);
  }

  // ── Get skill definition ────────────────────────────────────────────────

  getSkill(name: string): SkillDefinition | undefined {
    return this.registry.get(name);
  }

  // ── List all skills ─────────────────────────────────────────────────────

  listSkills(): SkillDefinition[] {
    return Array.from(this.registry.values());
  }

  // ── Check if a skill exists ─────────────────────────────────────────────

  hasSkill(name: string): boolean {
    return this.registry.has(name);
  }

  // ── Execute a skill ─────────────────────────────────────────────────────

  async executeSkill(
    name: string,
    params: unknown,
    bot: Bot,
    mcData: IndexedData,
    botId: string,
    jobId: string,
    config: Readonly<BotConfig>,
    modes: ModeEngine,
    onProgress: (report: SkillProgressReport) => void,
    timeoutMs?: number,
  ): Promise<SkillResult> {
    const skill = this.registry.get(name);
    if (!skill) {
      return makeErrorResult("SKILL_NOT_FOUND", `Skill "${name}" not found`, false);
    }

    // Check if disabled in bot config
    const disabledSkills = config.skills?.disabled;
    if (disabledSkills?.includes(name)) {
      return makeErrorResult("SKILL_DISABLED", `Skill "${name}" is disabled`, false);
    }

    // Check permissions
    const permDenied = checkPermissions(skill, config);
    if (permDenied) {
      return makeErrorResult("PERMISSION_DENIED", permDenied, false);
    }

    // Validate params with Zod
    const parsed = skill.parameters.safeParse(params);
    if (!parsed.success) {
      return makeErrorResult(
        "VALIDATION_FAILED",
        `Invalid parameters: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        false,
      );
    }

    // Create abort controller for cancellation
    const controller = new AbortController();
    this.currentController = controller;
    this.currentJobId = jobId;

    const effectiveTimeout = timeoutMs ?? skill.timeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const logs: string[] = [];
    const startedAt = new Date().toISOString();

    const ctx: SkillExecutionContext = {
      bot,
      mcData,
      botId,
      jobId,
      signal: controller.signal,
      config,
      modes,
      progress: onProgress,
      log: (message, _fields) => {
        logs.push(message);
      },
    };

    try {
      // Set up timeout
      if (effectiveTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          controller.abort();
        }, effectiveTimeout);
      }

      // Pause conflicting modes while skill runs
      const scopedHandles = pauseConflictingModes(modes, skill);

      let result: SkillResult;
      try {
        // Check if already cancelled
        if (controller.signal.aborted) {
          result = makeErrorResult("JOB_CANCELLED", "Job was cancelled before execution", false);
        } else {
          result = await skill.run(ctx, parsed.data);
        }
      } finally {
        // Restore paused modes
        for (const handle of scopedHandles) {
          handle.restore();
        }
      }

      const finishedAt = new Date().toISOString();
      result = {
        ...result,
        output: logs.length > 0 ? logs : result.output,
        metrics: {
          startedAt,
          finishedAt,
          durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        },
      };

      return result;
    } catch (err) {
      if (controller.signal.aborted) {
        return makeErrorResult(
          "JOB_CANCELLED",
          `Skill "${name}" was cancelled: ${controller.signal.reason ?? "no reason"}`,
          false,
        );
      }

      const errStr = err instanceof Error ? err.message : String(err);
      return makeErrorResult("MINEFLAYER_ERROR", errStr, true);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (this.currentJobId === jobId) {
        this.currentController = null;
        this.currentJobId = null;
      }
    }
  }

  // ── Cancel current skill ────────────────────────────────────────────────

  cancelCurrent(reason?: string): boolean {
    if (!this.currentController) return false;
    this.currentController.abort(reason);
    return true;
  }

  // ── Cancel specific job ─────────────────────────────────────────────────

  cancelJob(jobId: string, reason?: string): boolean {
    if (this.currentJobId !== jobId) return false;
    return this.cancelCurrent(reason);
  }

  // ── Is a skill currently running? ───────────────────────────────────────

  isRunning(): boolean {
    return this.currentController !== null;
  }

  getCurrentJobId(): string | null {
    return this.currentJobId;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeErrorResult(
  code: string,
  message: string,
  retryable: boolean,
): SkillResult {
  return {
    ok: false,
    status: "failed" as SkillResultStatus,
    error: { code, message, retryable },
  };
}

function checkPermissions(
  skill: SkillDefinition,
  config: BotConfig,
): string | null {
  const permConfig = config.skills?.permissions;
  if (!permConfig) return null;

  for (const perm of skill.permissions) {
    const allowed = permConfig[perm as keyof typeof permConfig];
    if (allowed === false) {
      return `Permission "${perm}" denied for skill "${skill.name}"`;
    }
  }
  return null;
}

function pauseConflictingModes(
  modes: ModeEngine,
  skill: SkillDefinition,
): { restore: () => void }[] {
  const handles: { restore: () => void }[] = [];

  // Combat skills pause self_defense and cowardice
  if (skill.permissions.includes("combat")) {
    const h1 = modes.pauseScoped("self_defense");
    const h2 = modes.pauseScoped("cowardice");
    if (h1) handles.push(h1);
    if (h2) handles.push(h2);
  }

  // Movement skills pause unstuck
  if (skill.permissions.includes("movement")) {
    const h = modes.pauseScoped("unstuck");
    if (h) handles.push(h);
  }

  return handles;
}
