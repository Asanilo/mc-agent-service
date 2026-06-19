/**
 * BotManager — bot registry and worker lifecycle manager.
 *
 * Responsibilities (from SPEC §3):
 *  - Create bot records from validated per-bot config.
 *  - Start one worker_threads worker per bot.
 *  - Stop, destroy, and reconnect bots.
 *  - Route commands to the correct worker mailbox.
 *  - Maintain bot status.
 *  - Detect worker exit and classify it.
 *  - Apply reconnection policy.
 *  - Expose read APIs for bot summaries and cached state.
 *
 * Uses dependency injection for EventBus (not global singleton) for testability.
 */

import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import pino from "pino";
import type { BotConfig, BotSummary, BotStatus } from "../types/bot.js";
import { WorkerEventSchema, type WorkerCommand, type WorkerEvent } from "../types/worker.js";
import type { ServerConfig } from "../types/config.js";
import { EventBus } from "./event-bus.js";

// ─── Internal bot record ───────────────────────────────────────────────────

interface BotRecord {
  id: string;
  config: BotConfig;
  status: BotStatus;
  worker: Worker | null;
  busy: boolean;
  currentJobId: string | undefined;
  createdAt: string;
  updatedAt: string;
  connectedAt: string | undefined;
  lastDisconnectedAt: string | undefined;
  lastError: { code: string; message: string; retryable?: boolean } | undefined;
  reconnectAttempts: number;
}

// ─── Worker entry-point resolution ─────────────────────────────────────────

/**
 * Default worker entry-point. The actual file lives at src/workers/bot-worker.ts
 * (compiled to dist/workers/bot-worker.js). Callers may override via constructor.
 */
const DEFAULT_WORKER_PATH = new URL("../bots/worker-entry.js", import.meta.url).pathname;

// ─── BotManager ────────────────────────────────────────────────────────────

export interface BotManagerOptions {
  serverConfig: ServerConfig;
  eventBus: EventBus;
  logger?: pino.Logger;
  workerPath?: string;
}

export class BotManager {
  private readonly bots = new Map<string, BotRecord>();
  private readonly eventBus: EventBus;
  private readonly logger: pino.Logger;
  private readonly serverConfig: ServerConfig;
  private readonly workerPath: string;
  private readonly destroyWaiters = new Map<string, () => void>();
  private jobEventHandler: ((event: WorkerEvent) => void) | null = null;

  constructor(opts: BotManagerOptions) {
    this.serverConfig = opts.serverConfig;
    this.eventBus = opts.eventBus;
    this.logger = (opts.logger ?? pino()).child({ module: "BotManager" });
    this.workerPath = opts.workerPath ?? DEFAULT_WORKER_PATH;
  }

  /**
   * Register a handler that receives every WorkerEvent for job lifecycle wiring.
   * Called by the integrator (index.ts) to forward events to JobManager.
   */
  setJobEventHandler(handler: (event: WorkerEvent) => void): void {
    this.jobEventHandler = handler;
  }

  // ── Create ─────────────────────────────────────────────────────────────

  /**
   * Create a new bot from validated config. Optionally auto-connect.
   * Returns the bot summary immediately (connection is async).
   */
  createBot(config: BotConfig, connect = true): BotSummary {
    const existing = config.id && this.bots.get(config.id);
    if (existing) {
      throw new BotManagerError("BOT_ALREADY_EXISTS", `Bot ${config.id} already exists`);
    }

    if (this.bots.size >= this.serverConfig.workers.maxBots) {
      throw new BotManagerError(
        "SERVICE_UNAVAILABLE",
        `Maximum bot limit (${this.serverConfig.workers.maxBots}) reached`,
      );
    }

    const id = config.id ?? `bot_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const record: BotRecord = {
      id,
      config: { ...config, id },
      status: "creating",
      worker: null,
      busy: false,
      currentJobId: undefined,
      createdAt: now,
      updatedAt: now,
      connectedAt: undefined,
      lastDisconnectedAt: undefined,
      lastError: undefined,
      reconnectAttempts: 0,
    };

    this.bots.set(id, record);

    this.logger.info({ botId: id, name: config.name }, "Bot created");

    // Start the worker thread
    this.startWorker(record);

    // If connect requested, send the connect command
    if (connect && record.worker) {
      this.sendCommand(id, { type: "connect", botConfig: record.config });
      this.updateStatus(id, "connecting");
    }

    return this.toSummary(record);
  }

  // ── Read ───────────────────────────────────────────────────────────────

  /** Get a bot summary by ID. Throws if not found. */
  getBot(id: string): BotSummary {
    const record = this.requireBot(id);
    return this.toSummary(record);
  }

  /** List all bot summaries. */
  listBots(): BotSummary[] {
    return Array.from(this.bots.values()).map((r) => this.toSummary(r));
  }

  /** Get bot status (lightweight). */
  getBotStatus(id: string): BotStatus {
    return this.requireBot(id).status;
  }

  /** Check if a bot exists and is in a connectable state. */
  isBotReady(id: string): boolean {
    const record = this.bots.get(id);
    if (!record) return false;
    return record.status === "running" || record.status === "disconnected";
  }

  // ── Lifecycle commands ─────────────────────────────────────────────────

  /**
   * Start (or restart) a bot. Sends a `connect` command to the worker.
   * If the worker has exited, spawns a new one.
   */
  startBot(id: string): void {
    const record = this.requireBot(id);

    if (record.status === "destroyed" || record.status === "failed") {
      throw new BotManagerError("BOT_DESTROYED", `Bot ${id} is ${record.status}`);
    }

    if (!record.worker) {
      this.startWorker(record);
    }

    this.sendCommand(id, { type: "connect", botConfig: record.config });
    this.updateStatus(id, "connecting");
  }

  /**
   * Gracefully stop a bot. Sends `disconnect` to the worker.
   * Optionally cancels running jobs.
   */
  stopBot(id: string, reason?: string): void {
    const record = this.requireBot(id);

    if (record.status === "destroyed") {
      throw new BotManagerError("BOT_DESTROYED", `Bot ${id} is destroyed`);
    }

    this.sendCommand(id, { type: "disconnect", reason });
    this.updateStatus(id, "stopping");
  }

  /**
   * Destroy a bot permanently. Sends `destroy` to the worker,
   * which will cause the worker to exit after cleanup.
   * Returns a promise that resolves when the worker exits (or times out).
   */
  async destroyBot(id: string, reason?: string): Promise<void> {
    const record = this.requireBot(id);

    if (record.status === "destroyed") {
      return; // idempotent
    }

    this.sendCommand(id, { type: "destroy", reason });
    this.updateStatus(id, "stopping");

    // Wait for worker to exit, force-terminate after 5s
    if (record.worker) {
      const worker = record.worker;
      const exitPromise = new Promise<void>((resolve) => {
        this.destroyWaiters.set(id, resolve);
      });
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          // Force-terminate if still alive
          if (this.destroyWaiters.has(id)) {
            this.destroyWaiters.delete(id);
            try {
              worker.terminate();
            } catch {
              // already exited
            }
          }
          resolve();
        }, 5000);
      });
      await Promise.race([exitPromise, timeoutPromise]);
    }
  }

  /**
   * Request reconnection for a bot.
   */
  reconnectBot(id: string): void {
    const record = this.requireBot(id);

    if (record.status === "destroyed" || record.status === "failed") {
      throw new BotManagerError("BOT_DESTROYED", `Bot ${id} is ${record.status}`);
    }

    this.sendCommand(id, { type: "disconnect", reason: "reconnect requested" });
    // The worker will transition to disconnected, and we'll re-connect.
    // We schedule the re-connect after a short delay.
    record.reconnectAttempts++;
    this.updateStatus(id, "reconnecting");

    setTimeout(() => {
      if (this.bots.has(id) && record.status === "reconnecting") {
        this.sendCommand(id, { type: "connect", botConfig: record.config });
        this.updateStatus(id, "connecting");
      }
    }, 1000);
  }

  /**
   * Send a runSkill command to a bot's worker.
   * Used by JobManager to dispatch job execution.
   */
  runSkill(botId: string, jobId: string, skill: string, params: unknown, timeoutMs?: number): void {
    const record = this.requireBot(botId);
    record.busy = true;
    record.currentJobId = jobId;
    this.sendCommand(botId, { type: "runSkill", jobId, skill, params, timeoutMs });
  }

  /**
   * Send a cancelJob command to a bot's worker.
   */
  cancelJob(botId: string, jobId: string, mode: "cancel-current" | "queue" | "reject-if-busy" | "emergency-stop", reason?: string): void {
    this.requireBot(botId);
    this.sendCommand(botId, { type: "cancelJob", jobId, mode, reason });
  }

  /**
   * Send a sendChat command to a bot's worker.
   */
  sendChat(botId: string, message: string, jobId?: string): void {
    this.requireBot(botId);
    this.sendCommand(botId, { type: "sendChat", jobId, message });
  }

  /**
   * Send a toggleMode command to a bot's worker.
   */
  toggleMode(botId: string, modeName: string, enabled?: boolean, paused?: boolean, reason?: string): void {
    this.requireBot(botId);
    this.sendCommand(botId, { type: "toggleMode", modeName, enabled, paused, reason });
  }

  /**
   * Request a full state snapshot from a bot's worker.
   */
  requestSnapshot(botId: string, requestId: string): void {
    this.requireBot(botId);
    this.sendCommand(botId, { type: "getSnapshot", requestId });
  }

  // ── Internal: worker management ────────────────────────────────────────

  private startWorker(record: BotRecord): void {
    const worker = new Worker(this.workerPath, {
      workerData: { botId: record.id },
    });

    record.worker = worker;

    worker.on("message", (msg: unknown) => {
      this.handleWorkerEvent(record.id, msg);
    });

    worker.on("error", (err) => {
      this.logger.error({ botId: record.id, err }, "Worker error");
      record.lastError = {
        code: "WORKER_ERROR",
        message: err.message,
        retryable: true,
      };
      this.updateStatus(record.id, "failed");
      this.emitBotError(record.id, "WORKER_ERROR", err.message);
    });

    worker.on("exit", (code) => {
      this.logger.info({ botId: record.id, code }, "Worker exited");
      record.worker = null;

      // Resolve any pending destroy-wait promise
      const waiter = this.destroyWaiters.get(record.id);
      if (waiter) {
        waiter();
        this.destroyWaiters.delete(record.id);
      }

      if (record.status !== "destroyed" && record.status !== "stopping" && record.status !== "failed") {
        // Unexpected exit — fail any active job
        if (record.currentJobId) {
          const jobId = record.currentJobId;
          const now = new Date().toISOString();
          record.busy = false;
          record.currentJobId = undefined;
          const failedJob = {
            id: jobId,
            botId: record.id,
            skill: "",
            state: "failed" as const,
            timeoutMs: 0,
            retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] as string[] },
            createdAt: now,
            startedAt: now,
          };
          const failedError = { code: "WORKER_CRASH", message: `Worker exited with code ${code}`, retryable: true };
          this.eventBus.emit({
            id: "",
            ts: now,
            type: "job.failed",
            botId: record.id,
            jobId,
            data: {
              job: failedJob,
              error: failedError,
            },
          } as any);
          // Notify JobManager directly so it transitions job state and dispatches queued jobs
          this.jobEventHandler?.({
            type: "jobFailed",
            botId: record.id,
            jobId,
            job: failedJob,
            error: failedError,
          });
        }

        // Unexpected exit — classify
        if (code === 0) {
          // Clean exit but we didn't request it — treat as disconnected
          this.updateStatus(record.id, "disconnected");
        } else {
          record.lastError = {
            code: "WORKER_CRASH",
            message: `Worker exited with code ${code}`,
            retryable: true,
          };
          this.updateStatus(record.id, "failed");
        }
      } else {
        this.updateStatus(record.id, "destroyed");
      }
    });

    this.logger.debug({ botId: record.id }, "Worker spawned");
  }

  private sendCommand(botId: string, command: WorkerCommand): void {
    const record = this.bots.get(botId);
    if (!record?.worker) {
      this.logger.warn({ botId }, "Cannot send command — no active worker");
      return;
    }

    try {
      record.worker.postMessage(command);
    } catch (err) {
      this.logger.error({ botId, err, command: command.type }, "Failed to send command to worker");
    }
  }

  // ── Internal: worker event handling ────────────────────────────────────

  private handleWorkerEvent(botId: string, raw: unknown): void {
    const record = this.bots.get(botId);
    if (!record) return;

    const parsed = WorkerEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn({ botId, error: parsed.error.message }, "Invalid worker event received");
      return;
    }

    const event = parsed.data;

    switch (event.type) {
      case "connected":
        this.updateStatus(botId, "running");
        record.connectedAt = new Date().toISOString();
        record.reconnectAttempts = 0;
        record.lastError = undefined;
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "bot.connected",
          botId,
          data: {
            bot: this.toSummary(record),
            host: event.host,
            port: event.port,
          },
        } as any);
        break;

      case "disconnected":
        record.lastDisconnectedAt = new Date().toISOString();
        if (event.expected) {
          this.updateStatus(botId, "disconnected");
        } else {
          record.lastError = {
            code: "DISCONNECTED",
            message: event.reason ?? "Unexpected disconnect",
            retryable: event.willReconnect,
          };
          this.updateStatus(botId, "disconnected");
        }
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "bot.disconnected",
          botId,
          data: {
            reason: event.reason,
            expected: event.expected,
            willReconnect: event.willReconnect,
          },
        } as any);
        break;

      case "stateUpdate":
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "state.changed",
          botId,
          data: event.state,
        } as any);
        break;

      case "jobProgress":
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "job.progress",
          botId,
          jobId: event.jobId,
          data: { progress: event.progress },
        } as any);
        break;

      case "jobComplete":
        record.busy = false;
        record.currentJobId = undefined;
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "job.completed",
          botId,
          jobId: event.jobId,
          data: { job: event.job, result: event.result },
        } as any);
        break;

      case "jobFailed":
        record.busy = false;
        record.currentJobId = undefined;
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "job.failed",
          botId,
          jobId: event.jobId,
          data: { job: event.job, error: event.error },
        } as any);
        break;

      case "chatReceived":
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "chat.received",
          botId,
          data: {
            botId,
            direction: "received" as const,
            sender: event.sender,
            message: event.message,
            raw: event.raw,
            ts: event.ts,
          },
        } as any);
        break;

      case "error":
        record.lastError = {
          code: event.code,
          message: event.message,
          retryable: event.retryable,
        };
        this.eventBus.emit({
          id: "",
          ts: "",
          type: "error.raised",
          botId,
          data: {
            error: {
              code: event.code,
              message: event.message,
              retryable: event.retryable,
              source: event.source,
              details: event.details,
            },
          },
        } as any);
        break;

      default: {
        // Exhaustive check
        const _exhaustive: never = event;
        this.logger.warn({ botId, event: _exhaustive }, "Unknown worker event type");
      }
    }

    // Forward to JobManager for job lifecycle tracking
    this.jobEventHandler?.(event);
  }

  // ── Internal: status management ────────────────────────────────────────

  private updateStatus(botId: string, status: BotStatus): void {
    const record = this.bots.get(botId);
    if (!record) return;

    const prev = record.status;
    record.status = status;
    record.updatedAt = new Date().toISOString();

    if (prev !== status) {
      this.logger.info({ botId, from: prev, to: status }, "Bot status changed");
    }
  }

  private emitBotError(botId: string, code: string, message: string): void {
    this.eventBus.emit({
      id: "",
      ts: "",
      type: "error.raised",
      botId,
      data: {
        error: { code, message, retryable: false },
      },
    } as any);
  }

  // ── Internal: record lookup ────────────────────────────────────────────

  private requireBot(id: string): BotRecord {
    const record = this.bots.get(id);
    if (!record) {
      throw new BotManagerError("BOT_NOT_FOUND", `Bot ${id} not found`);
    }
    return record;
  }

  // ── Internal: summary construction ─────────────────────────────────────

  private toSummary(record: BotRecord): BotSummary {
    return {
      id: record.id,
      name: record.config.name,
      status: record.status,
      host: record.config.minecraft.host,
      port: record.config.minecraft.port,
      busy: record.busy,
      currentJobId: record.currentJobId,
      metadata: record.config.metadata,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      connectedAt: record.connectedAt,
      lastDisconnectedAt: record.lastDisconnectedAt,
      lastError: record.lastError,
    };
  }
}

// ─── Error class ───────────────────────────────────────────────────────────

export class BotManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "BotManagerError";
  }
}
