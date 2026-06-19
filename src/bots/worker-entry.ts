import { parentPort } from "node:worker_threads";
import { BotRuntime } from "./bot-runtime.js";
import type { BotConfig } from "../types/bot.js";
import type {
  WorkerCommand,
  WorkerEvent,
  WorkerSnapshotResponse,
} from "../types/worker.js";
import type { SkillProgressReport } from "../types/skills.js";
import type { BotState } from "../types/bot.js";
import type { Job } from "../types/jobs.js";

// ─── Worker Entry Point ─────────────────────────────────────────────────────
//
// This file runs inside a worker_threads Worker. It receives WorkerCommands
// via parentPort.on('message'), dispatches them to a BotRuntime instance,
// and sends WorkerEvents back via parentPort.postMessage.
//
// Graceful shutdown: listens for 'destroy' and 'disconnect' commands and
// exits cleanly after cleanup.

let runtime: BotRuntime | null = null;
let botConfig: BotConfig | null = null;
let shuttingDown = false;

// ─── Message handler ────────────────────────────────────────────────────────

parentPort?.on("message", (msg: WorkerCommand) => {
  if (shuttingDown) return;

  switch (msg.type) {
    case "connect":
      handleConnect(msg.botConfig);
      break;
    case "disconnect":
      handleDisconnect(msg.reason);
      break;
    case "destroy":
      handleDestroy(msg.reason);
      break;
    case "runSkill":
      handleRunSkill(msg.jobId, msg.skill, msg.params, msg.timeoutMs);
      break;
    case "cancelJob":
      handleCancelJob(msg.jobId, msg.mode, msg.reason);
      break;
    case "sendChat":
      handleSendChat(msg.jobId, msg.message);
      break;
    case "getSnapshot":
      handleGetSnapshot(msg.requestId);
      break;
    default:
      sendEvent({
        type: "error",
        botId: botConfig?.id ?? botConfig?.name ?? "unknown",
        code: "UNKNOWN_COMMAND",
        message: `Unknown command type: ${(msg as { type: string }).type}`,
        retryable: false,
        source: "worker",
      });
  }
});

// ─── Handle connect ─────────────────────────────────────────────────────────

function handleConnect(config: BotConfig): void {
  botConfig = config;
  const botId = config.id ?? config.name;

  try {
    runtime = new BotRuntime(botId);

    // Wire up runtime events → parentPort
    runtime.on("connected", (host, port) => {
      sendEvent({
        type: "connected",
        botId,
        host,
        port,
      });
    });

    runtime.on("spawned", () => {
      // Emit state snapshot after spawn
      emitStateUpdate();
    });

    runtime.on("disconnected", (reason, expected, willReconnect) => {
      sendEvent({
        type: "disconnected",
        botId,
        reason,
        expected,
        willReconnect,
      });
    });

    runtime.on("chatReceived", (sender, message, ts) => {
      sendEvent({
        type: "chatReceived",
        botId,
        sender,
        message,
        ts,
      });
    });

    runtime.on("jobProgress", (jobId, progress) => {
      sendEvent({
        type: "jobProgress",
        botId,
        jobId,
        progress,
      });
    });

    runtime.on("jobComplete", (jobId, result) => {
      const job = buildStubJob(jobId, "completed");
      sendEvent({
        type: "jobComplete",
        botId,
        jobId,
        job,
        result,
      });
      emitStateUpdate();
    });

    runtime.on("jobFailed", (jobId, error) => {
      const job = buildStubJob(jobId, "failed");
      sendEvent({
        type: "jobFailed",
        botId,
        jobId,
        job,
        error,
      });
      emitStateUpdate();
    });

    runtime.on("error", (err) => {
      sendEvent({
        type: "error",
        botId,
        ...err,
      });
    });

    runtime.on("modeTriggered", (_mode, _reason) => {
      emitStateUpdate();
    });

    // Start connecting
    void runtime.connect(config).catch((err) => {
      const errStr = err instanceof Error ? err.message : String(err);
      sendEvent({
        type: "error",
        botId,
        code: "CONNECT_FAILED",
        message: errStr,
        retryable: true,
        source: "worker",
      });
    });
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err);
    sendEvent({
      type: "error",
      botId,
      code: "WORKER_INIT_FAILED",
      message: errStr,
      retryable: false,
      source: "worker",
    });
  }
}

// ─── Handle disconnect ──────────────────────────────────────────────────────

async function handleDisconnect(reason?: string): Promise<void> {
  if (!runtime) return;
  try {
    await runtime.disconnect(reason);
  } catch (err) {
    sendWorkerError("DISCONNECT_FAILED", err);
  }
}

// ─── Handle destroy ─────────────────────────────────────────────────────────

async function handleDestroy(reason?: string): Promise<void> {
  shuttingDown = true;
  if (runtime) {
    try {
      await runtime.destroy(reason ?? "destroyed");
    } catch {
      // best effort
    }
  }
  // Give a small delay for any pending messages to flush
  setTimeout(() => {
    process.exit(0);
  }, 100);
}

// ─── Handle runSkill ────────────────────────────────────────────────────────

async function handleRunSkill(
  jobId: string,
  skill: string,
  params: unknown,
  timeoutMs?: number,
): Promise<void> {
  if (!runtime) {
    sendEvent({
      type: "jobFailed",
      botId: botConfig?.id ?? botConfig?.name ?? "unknown",
      jobId,
      job: buildStubJob(jobId, "failed"),
      error: {
        code: "BOT_NOT_READY",
        message: "Runtime not initialized",
        retryable: false,
      },
    });
    return;
  }

  // Run skill asynchronously — results are emitted via event callbacks
  void runtime.runSkill(skill, params, jobId, timeoutMs);
}

// ─── Handle cancelJob ───────────────────────────────────────────────────────

function handleCancelJob(
  jobId: string,
  _mode: string,
  reason?: string,
): void {
  if (!runtime) return;
  runtime.cancelJob(jobId, reason ?? "user requested cancellation");
}

// ─── Handle sendChat ────────────────────────────────────────────────────────

function handleSendChat(jobId: string | undefined, message: string): void {
  if (!runtime) {
    sendEvent({
      type: "error",
      botId: botConfig?.id ?? botConfig?.name ?? "unknown",
      code: "BOT_NOT_READY",
      message: "Runtime not initialized",
      retryable: false,
      source: "worker",
    });
    return;
  }

  try {
    runtime.sendChat(message);

    const ts = new Date().toISOString();
    sendEvent({
      type: "chatReceived",
      botId: botConfig?.id ?? botConfig?.name ?? "unknown",
      sender: undefined,
      message,
      ts,
    });
  } catch (err) {
    sendWorkerError("CHAT_FAILED", err);
  }
}

// ─── Handle getSnapshot ─────────────────────────────────────────────────────

function handleGetSnapshot(requestId: string): void {
  if (!runtime) {
    sendEvent({
      type: "error",
      botId: botConfig?.id ?? botConfig?.name ?? "unknown",
      code: "BOT_NOT_READY",
      message: "Runtime not initialized",
      retryable: false,
      source: "worker",
    });
    return;
  }

  const state = runtime.getState();
  const response: WorkerSnapshotResponse = {
    type: "snapshot",
    requestId,
    botId: botConfig?.id ?? botConfig?.name ?? "unknown",
    state,
  };
  parentPort?.postMessage(response);
}

// ─── Emit state update ──────────────────────────────────────────────────────

function emitStateUpdate(): void {
  if (!runtime) return;
  const state = runtime.getState();
  sendEvent({
    type: "stateUpdate",
    botId: botConfig?.id ?? botConfig?.name ?? "unknown",
    state,
  });
}

// ─── Send event to parent ───────────────────────────────────────────────────

function sendEvent(event: WorkerEvent): void {
  parentPort?.postMessage(event);
}

// ─── Send worker error ──────────────────────────────────────────────────────

function sendWorkerError(code: string, err: unknown): void {
  const errStr = err instanceof Error ? err.message : String(err);
  sendEvent({
    type: "error",
    botId: botConfig?.id ?? botConfig?.name ?? "unknown",
    code,
    message: errStr,
    retryable: false,
    source: "worker",
  });
}

// ─── Build stub job for WorkerEvent ─────────────────────────────────────────

function buildStubJob(
  jobId: string,
  state: "completed" | "failed",
): Job {
  const now = new Date().toISOString();
  return {
    id: jobId,
    botId: botConfig?.id ?? botConfig?.name ?? "unknown",
    skill: "",
    params: undefined,
    state,
    timeoutMs: 0,
    retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  };
}

// ─── Graceful shutdown on process signals ───────────────────────────────────

process.on("SIGTERM", () => {
  void handleDestroy("SIGTERM");
});

process.on("SIGINT", () => {
  void handleDestroy("SIGINT");
});

process.on("uncaughtException", (err) => {
  sendEvent({
    type: "error",
    botId: botConfig?.id ?? botConfig?.name ?? "unknown",
    code: "UNCAUGHT_EXCEPTION",
    message: err.message,
    retryable: false,
    source: "worker",
    details: { stack: err.stack },
  });
  // Don't exit — let the main process decide
});

process.on("unhandledRejection", (reason) => {
  const errStr = reason instanceof Error ? reason.message : String(reason);
  sendEvent({
    type: "error",
    botId: botConfig?.id ?? botConfig?.name ?? "unknown",
    code: "UNHANDLED_REJECTION",
    message: errStr,
    retryable: false,
    source: "worker",
  });
});
