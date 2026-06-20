/**
 * REST API Router for mc-agent-service.
 *
 * All endpoints use Zod validation and return proper HTTP status codes.
 * Error responses follow the ErrorResponse schema from types/api.ts.
 */

import { Router, type Request, type Response } from "express";
import pino from "pino";
import type { BotManager } from "../core/bot-manager.js";
import type { JobManager } from "../core/job-manager.js";
import type { EventBus } from "../core/event-bus.js";
import type { BotState } from "../types/bot.js";
import type { SkillDefinition as ApiSkillDefinition } from "../types/skills.js";
import {
  CreateBotRequestSchema,
  StartBotRequestSchema,
  StopBotRequestSchema,
  RunSkillRequestSchema,
  CancelJobRequestSchema,
  SendChatRequestSchema,
  ListJobsQuerySchema,
  LookRequestSchema,
  ModesPatchRequestSchema,
  type ErrorResponse,
  type ErrorCode,
} from "../types/api.js";
import type { RateLimitConfig } from "../types/config.js";
import { createChatRateLimitMiddleware } from "./rate-limit.js";

// ─── Skill Registry (control-plane skill definitions) ────────────────────────

/**
 * Simple registry for API-facing skill definitions.
 * Populated at startup from skill plugins.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, ApiSkillDefinition>();

  register(definition: ApiSkillDefinition): void {
    this.skills.set(definition.name, definition);
  }

  get(name: string): ApiSkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): ApiSkillDefinition[] {
    return Array.from(this.skills.values());
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }
}

// ─── Bot State Cache ─────────────────────────────────────────────────────────

/**
 * Maintains a cache of the latest BotState per bot, updated via EventBus.
 * Used by state/inventory/nearby/modes endpoints.
 */
export class BotStateCache {
  private readonly cache = new Map<string, BotState>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly eventBus: EventBus) {}

  start(): void {
    const sub = this.eventBus.subscribe(
      (event) => event.type === "state.changed",
      (event) => {
        if (event.botId && event.data && typeof event.data === "object") {
          this.cache.set(event.botId, event.data as BotState);
        }
      },
    );
    this.unsubscribe = () => this.eventBus.unsubscribe(sub.id);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get(botId: string): BotState | undefined {
    return this.cache.get(botId);
  }

  set(botId: string, state: BotState): void {
    this.cache.set(botId, state);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely extract a string route param (Express v5 types return string | string[]). */
function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0]! : (val ?? "");
}

function sendError(res: Response, status: number, code: ErrorCode, message: string, details?: unknown): void {
  const body: ErrorResponse = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  res.status(status).json(body);
}

function errorToStatus(code: string): number {
  switch (code) {
    case "BOT_NOT_FOUND":
    case "JOB_NOT_FOUND":
    case "SKILL_NOT_FOUND":
    case "MODE_NOT_FOUND":
    case "ENTITY_NOT_FOUND":
      return 404;
    case "BOT_ALREADY_EXISTS":
      return 409;
    case "BOT_DESTROYED":
    case "BOT_NOT_CONNECTED":
      return 410;
    case "BOT_BUSY":
    case "JOB_ALREADY_FINISHED":
      return 409;
    case "VALIDATION_FAILED":
    case "SKILL_VALIDATION_FAILED":
      return 400;
    case "AUTH_REQUIRED":
      return 401;
    case "AUTH_INVALID":
    case "AUTH_FORBIDDEN":
    case "SKILL_PERMISSION_DENIED":
      return 403;
    case "RATE_LIMITED":
    case "CHAT_RATE_LIMITED":
      return 429;
    case "SERVICE_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

// ─── Router Factory ──────────────────────────────────────────────────────────

export interface RestRouterOptions {
  botManager: BotManager;
  jobManager: JobManager;
  eventBus: EventBus;
  skillRegistry: SkillRegistry;
  stateCache: BotStateCache;
  logger?: pino.Logger;
  rateLimitConfig?: RateLimitConfig;
}

export function createRestRouter(opts: RestRouterOptions): Router {
  const { botManager, jobManager, skillRegistry, stateCache } = opts;
  const logger = (opts.logger ?? pino()).child({ module: "REST" });
  const router = Router();

  // Chat rate limit middleware (applied per-bot)
  const chatRateLimit = opts.rateLimitConfig
    ? createChatRateLimitMiddleware(opts.rateLimitConfig)
    : null;

  function handleKnownError(res: Response, err: unknown): boolean {
    if (err instanceof Error && "code" in err) {
      const code = (err as Error & { code: string }).code;
      const status = errorToStatus(code);
      sendError(res, status, code as ErrorCode, err.message);
      return true;
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  BOT ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════

  /** POST /bots — Create a new bot */
  router.post("/bots", (req: Request, res: Response) => {
    const parsed = CreateBotRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      const summary = botManager.createBot(parsed.data.bot, parsed.data.connect);
      res.status(201).json({
        bot: {
          ...summary,
          config: parsed.data.bot,
        },
      });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to create bot");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to create bot");
      }
    }
  });

  /** GET /bots — List all bots */
  router.get("/bots", (_req: Request, res: Response) => {
    try {
      const bots = botManager.listBots();
      res.json({ bots });
    } catch (err) {
      logger.error({ err }, "Failed to list bots");
      sendError(res, 500, "INTERNAL_ERROR", "Failed to list bots");
    }
  });

  /** GET /bots/:botId — Get bot detail */
  router.get("/bots/:botId", (req: Request, res: Response) => {
    try {
      const summary = botManager.getBot(param(req, "botId"));
      res.json({ bot: { ...summary, config: {} } });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to get bot");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to get bot");
      }
    }
  });

  /** POST /bots/:botId/start — Start/reconnect bot */
  router.post("/bots/:botId/start", (req: Request, res: Response) => {
    const parsed = StartBotRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      const botId = param(req, "botId");
      botManager.startBot(botId);
      const summary = botManager.getBot(botId);
      res.json({ bot: summary, accepted: true });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to start bot");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to start bot");
      }
    }
  });

  /** POST /bots/:botId/stop — Stop bot */
  router.post("/bots/:botId/stop", (req: Request, res: Response) => {
    const parsed = StopBotRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      const botId = param(req, "botId");
      botManager.stopBot(botId, parsed.data.reason);
      const summary = botManager.getBot(botId);
      res.json({ bot: summary, cancelledJobIds: [] });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to stop bot");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to stop bot");
      }
    }
  });

  /** DELETE /bots/:botId — Destroy bot */
  router.delete("/bots/:botId", (req: Request, res: Response) => {
    try {
      const botId = param(req, "botId");
      botManager.destroyBot(botId);
      res.json({ botId, destroyed: true, cancelledJobIds: [] });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to destroy bot");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to destroy bot");
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  BOT STATE ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════

  /** GET /bots/:botId/state — Full state snapshot */
  router.get("/bots/:botId/state", (req: Request, res: Response) => {
    const botId = param(req, "botId");
    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "State snapshot not yet available for this bot");
        return;
      }
      res.json({ state });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to get bot state");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to get bot state");
      }
    }
  });

  /** GET /bots/:botId/inventory — Inventory */
  router.get("/bots/:botId/inventory", (req: Request, res: Response) => {
    const botId = param(req, "botId");
    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state?.inventory) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "Inventory snapshot not yet available");
        return;
      }
      res.json({ inventory: state.inventory });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to get inventory");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to get inventory");
      }
    }
  });

  /** GET /bots/:botId/nearby — Nearby entities/blocks */
  router.get("/bots/:botId/nearby", (req: Request, res: Response) => {
    const botId = param(req, "botId");
    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state?.nearby) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "Nearby snapshot not yet available");
        return;
      }

      // Apply radius filter if provided
      const radiusParam = req.query["radius"];
      let nearby = state.nearby;
      if (radiusParam !== undefined) {
        const radius = Number(radiusParam);
        if (Number.isFinite(radius) && radius > 0) {
          nearby = {
            ...nearby,
            radius,
            players: nearby.players.filter((e) => e.distance <= radius),
            entities: nearby.entities.filter((e) => e.distance <= radius),
            blocks: nearby.blocks.filter((b) => b.distance <= radius),
          };
        }
      }

      res.json({ nearby });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to get nearby");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to get nearby");
      }
    }
  });

  /** GET /bots/:botId/position — Bot position, velocity, rotation */
  router.get("/bots/:botId/position", (req: Request, res: Response) => {
    const botId = param(req, "botId");
    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "State snapshot not yet available for this bot");
        return;
      }
      res.json({
        botId,
        position: state.position,
        velocity: state.velocity,
        rotation: state.rotation,
        dimension: state.dimension,
        updatedAt: state.updatedAt,
      });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to get bot position");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to get bot position");
      }
    }
  });

  /** POST /bots/:botId/look — Look at entity or position */
  router.post("/bots/:botId/look", (req: Request, res: Response) => {
    const botId = param(req, "botId");

    const parsed = LookRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "Bot state not yet available");
        return;
      }

      // Submit a look skill job via the worker
      const target = parsed.data.target;
      const job = jobManager.submitJob(botId, "move.look", {
        target,
        force: parsed.data.force,
      });

      res.json({
        botId,
        looked: true,
        rotation: state.rotation,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to look at target");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to look at target");
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  SKILL EXECUTION
  // ════════════════════════════════════════════════════════════════════════

  /** POST /bots/:botId/actions/:skillName — Execute skill */
  router.post("/bots/:botId/actions/:skillName", (req: Request, res: Response) => {
    const botId = param(req, "botId");
    const skillName = param(req, "skillName");

    const parsed = RunSkillRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      botManager.getBot(botId);

      if (!skillRegistry.has(skillName)) {
        sendError(res, 404, "SKILL_NOT_FOUND", `Skill "${skillName}" not found`);
        return;
      }

      const job = jobManager.submitJob(botId, skillName, parsed.data.params, {
        timeoutMs: parsed.data.timeoutMs,
        busyPolicy: parsed.data.busyPolicy,
        retry: parsed.data.retry,
      });

      res.status(202).json({ job });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to execute skill");
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 500, "INTERNAL_ERROR", `Failed to execute skill: ${msg}`);
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  MODE ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════

  /** GET /bots/:botId/modes — List modes */
  router.get("/bots/:botId/modes", (req: Request, res: Response) => {
    const botId = param(req, "botId");
    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "State not yet available");
        return;
      }
      res.json({ modes: state.modes });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to list modes");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to list modes");
      }
    }
  });

  /** PATCH /bots/:botId/modes/:modeName — Toggle mode */
  router.patch("/bots/:botId/modes/:modeName", (req: Request, res: Response) => {
    const botId = param(req, "botId");
    const modeName = param(req, "modeName");

    const parsed = ModesPatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "State not yet available");
        return;
      }

      const mode = state.modes.find((m) => m.name === modeName);
      if (!mode) {
        sendError(res, 404, "MODE_NOT_FOUND", `Mode "${modeName}" not found`);
        return;
      }

      const newEnabled = parsed.data.enabled;
      const newPaused = parsed.data.paused ?? mode.paused;

      // Send mode toggle to worker via BotManager
      botManager.toggleMode(botId, modeName, newEnabled, newPaused, parsed.data.reason);

      logger.info({ botId, modeName, enabled: newEnabled, paused: newPaused }, "Mode toggle requested");

      res.json({
        botId,
        mode: {
          ...mode,
          enabled: newEnabled,
          paused: newPaused,
        },
      });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to toggle mode");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to toggle mode");
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  SKILL REGISTRY ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════

  /** GET /skills — List registered skills */
  router.get("/skills", (_req: Request, res: Response) => {
    try {
      const skills = skillRegistry.list();
      res.json({ skills });
    } catch (err) {
      logger.error({ err }, "Failed to list skills");
      sendError(res, 500, "INTERNAL_ERROR", "Failed to list skills");
    }
  });

  /** GET /skills/:skillName — Skill detail */
  router.get("/skills/:skillName", (req: Request, res: Response) => {
    try {
      const skillName = param(req, "skillName");
      const skill = skillRegistry.get(skillName);
      if (!skill) {
        sendError(res, 404, "SKILL_NOT_FOUND", `Skill "${skillName}" not found`);
        return;
      }
      res.json({ skill });
    } catch (err) {
      logger.error({ err }, "Failed to get skill");
      sendError(res, 500, "INTERNAL_ERROR", "Failed to get skill");
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  JOB ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════

  /** GET /jobs — List jobs (with optional query filters) */
  router.get("/jobs", (req: Request, res: Response) => {
    const parsed = ListJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid query parameters", parsed.error.issues);
      return;
    }

    try {
      const jobs = jobManager.listJobs({
        botId: parsed.data.botId,
        status: parsed.data.status,
        skill: parsed.data.skill,
        since: parsed.data.since,
        until: parsed.data.until,
        limit: parsed.data.limit,
      });
      res.json({ jobs });
    } catch (err) {
      logger.error({ err }, "Failed to list jobs");
      sendError(res, 500, "INTERNAL_ERROR", "Failed to list jobs");
    }
  });

  /** GET /jobs/:jobId — Job detail */
  router.get("/jobs/:jobId", (req: Request, res: Response) => {
    try {
      const job = jobManager.getJob(param(req, "jobId"));
      res.json({ job });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to get job");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to get job");
      }
    }
  });

  /** POST /jobs/:jobId/cancel — Cancel job */
  router.post("/jobs/:jobId/cancel", (req: Request, res: Response) => {
    const parsed = CancelJobRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      const job = jobManager.cancelJob(param(req, "jobId"), parsed.data.mode, parsed.data.reason);
      res.json({ job, accepted: true });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to cancel job");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to cancel job");
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  CHAT & OBSERVATION ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════

  /** POST /bots/:botId/chat — Send chat message */
  const chatHandlers = chatRateLimit ? [chatRateLimit] : [];
  router.post("/bots/:botId/chat", ...chatHandlers, (req: Request, res: Response) => {
    const botId = param(req, "botId");

    const parsed = SendChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request body", parsed.error.issues);
      return;
    }

    try {
      botManager.getBot(botId);

      if (parsed.data.asJob) {
        const job = jobManager.submitJob(botId, "chat", { message: parsed.data.message }, {
          timeoutMs: parsed.data.timeoutMs,
        });
        res.status(202).json({ job });
      } else {
        botManager.sendChat(botId, parsed.data.message);
        res.json({ sent: true, message: null });
      }
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to send chat");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to send chat");
      }
    }
  });

  /** POST /bots/:botId/observe — Get observation */
  router.post("/bots/:botId/observe", (req: Request, res: Response) => {
    const botId = param(req, "botId");

    try {
      botManager.getBot(botId);

      const state = stateCache.get(botId);
      if (!state) {
        sendError(res, 503, "SNAPSHOT_UNAVAILABLE", "Observation not yet available");
        return;
      }

      res.json({
        observation: {
          position: state.position,
          health: state.health,
          food: state.food,
          gameMode: state.gameMode,
          dimension: state.dimension,
          biome: state.biome,
          time: state.time,
          weather: state.weather,
          inventory: state.inventory,
          nearby: state.nearby,
          currentAction: state.currentAction,
          busy: state.busy,
        },
      });
    } catch (err) {
      if (!handleKnownError(res, err)) {
        logger.error({ err }, "Failed to get observation");
        sendError(res, 500, "INTERNAL_ERROR", "Failed to get observation");
      }
    }
  });

  return router;
}
