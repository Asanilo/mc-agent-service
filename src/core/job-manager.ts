/**
 * JobManager — job lifecycle manager.
 *
 * Responsibilities (from SPEC §3):
 *  - Create jobs for skill invocations and chat sends when chat is configured as a job.
 *  - Enforce bot busy policy: queue, reject-if-busy, cancel-current, or emergency-stop.
 *  - Route job execution requests to the target bot actor via BotManager.
 *  - Track job state, progress, result, error, retry count, timeout, timestamps,
 *    and cancellation reason.
 *  - Emit job.progress, job.completed, job.failed, and job.cancelled events.
 *
 * Job state machine:
 *   pending → running → completed | failed | cancelled | timeout
 *
 * Uses dependency injection for EventBus and BotManager for testability.
 */

import { randomUUID } from "node:crypto";
import pino from "pino";
import type {
  Job,
  JobStatus,
  JobError,
  JobProgress,
  BusyPolicy,
  CancellationMode,
  RetryPolicy,
} from "../types/jobs.js";
import type { WorkerEvent } from "../types/worker.js";
import { EventBus } from "./event-bus.js";
import type { BotManager } from "./bot-manager.js";

// ─── Submit options ────────────────────────────────────────────────────────

export interface SubmitJobOptions {
  timeoutMs?: number;
  busyPolicy?: BusyPolicy;
  retry?: RetryPolicy;
}

// ─── List filter ───────────────────────────────────────────────────────────

export interface JobListFilter {
  botId?: string;
  status?: JobStatus;
  skill?: string;
  since?: string;
  until?: string;
  limit?: number;
}

// ─── Default timeout ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000; // 1 minute
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: 0,
  retryOn: [],
};

// ─── JobManager ────────────────────────────────────────────────────────────

export interface JobManagerOptions {
  eventBus: EventBus;
  botManager: BotManager;
  logger?: pino.Logger;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly jobMeta = new Map<string, { paused?: boolean; attempt?: number }>();
  private readonly botQueues = new Map<string, string[]>(); // botId → queued jobId[]
  private readonly eventBus: EventBus;
  private readonly botManager: BotManager;
  private readonly logger: pino.Logger;

  constructor(opts: JobManagerOptions) {
    this.eventBus = opts.eventBus;
    this.botManager = opts.botManager;
    this.logger = (opts.logger ?? pino()).child({ module: "JobManager" });
  }

  // ── Submit ─────────────────────────────────────────────────────────────

  /**
   * Submit a new job for a bot. Returns the created Job record.
   * Enforces busy policy before dispatching.
   */
  submitJob(
    botId: string,
    skill: string,
    params: unknown,
    options: SubmitJobOptions = {},
  ): Job {
    // Verify bot exists
    const botStatus = this.botManager.getBotStatus(botId);

    const busyPolicy: BusyPolicy = options.busyPolicy ?? "queue";
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retry: RetryPolicy = options.retry ?? { ...DEFAULT_RETRY };
    const now = new Date().toISOString();

    const job: Job = {
      id: `job_${randomUUID().slice(0, 8)}`,
      botId,
      skill,
      params,
      state: "pending",
      timeoutMs,
      retry,
      createdAt: now,
    };

    // Validate: bot must not be destroyed or failed
    if (botStatus === "destroyed" || botStatus === "failed") {
      job.state = "failed";
      job.error = {
        code: "BOT_NOT_READY",
        message: `Bot ${botId} is ${botStatus}`,
        retryable: false,
      };
      job.finishedAt = now;
      this.jobs.set(job.id, job);
      this.emitJobEvent("job.failed", job, { error: job.error });
      return job;
    }

    this.jobs.set(job.id, job);

    // Check busy policy
    if (this.isBotBusy(botId)) {
      switch (busyPolicy) {
        case "reject-if-busy":
          this.finishJobAsFailed(job, "BOT_BUSY", "Bot is busy and policy is reject-if-busy", false);
          return job;

        case "cancel-current":
          this.cancelCurrentJob(botId, "Replaced by new job", "cancel-current");
          // Will dispatch below
          break;

        case "emergency-stop":
          this.cancelCurrentJob(botId, "Emergency stop requested", "emergency-stop");
          break;

        case "queue":
        default:
          this.enqueueJob(botId, job.id);
          this.logger.info({ jobId: job.id, botId, skill }, "Job queued (bot busy)");
          this.emitJobEvent("job.created", job);
          return job;
      }
    }

    // Dispatch
    this.dispatchJob(job);
    return job;
  }

  // ── Read ───────────────────────────────────────────────────────────────

  /** Get a job by ID. Throws if not found. */
  getJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) {
      throw new JobManagerError("JOB_NOT_FOUND", `Job ${id} not found`);
    }
    return { ...job };
  }

  /** List jobs matching the given filter. */
  listJobs(filter: JobListFilter = {}): Job[] {
    let results = Array.from(this.jobs.values());

    if (filter.botId) {
      results = results.filter((j) => j.botId === filter.botId);
    }
    if (filter.status) {
      results = results.filter((j) => j.state === filter.status);
    }
    if (filter.skill) {
      results = results.filter((j) => j.skill === filter.skill);
    }
    if (filter.since) {
      results = results.filter((j) => j.createdAt >= filter.since!);
    }
    if (filter.until) {
      results = results.filter((j) => j.createdAt <= filter.until!);
    }

    // Sort newest first
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Apply limit
    const limit = filter.limit ?? 100;
    return results.slice(0, limit).map((j) => ({ ...j }));
  }

  // ── Cancel ─────────────────────────────────────────────────────────────

  /**
   * Cancel a running or pending job.
   * For running jobs, sends a cancelJob command to the worker.
   * For pending jobs, transitions directly to cancelled.
   */
  cancelJob(id: string, mode: CancellationMode = "cancel-current", reason?: string): Job {
    const job = this.requireMutableJob(id);

    if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") {
      throw new JobManagerError("JOB_ALREADY_FINISHED", `Job ${id} is already ${job.state}`);
    }

    if (job.state === "pending") {
      // Remove from queue if queued
      this.removeFromQueue(job.botId, id);
      this.transitionJob(job, "cancelled");
      job.cancellation = {
        requestedAt: new Date().toISOString(),
        reason,
        mode,
      };
      this.emitJobEvent("job.cancelled", job, { reason, mode });
      return { ...job };
    }

    // Running — send cancel to worker
    this.botManager.cancelJob(job.botId, id, mode, reason);
    job.cancellation = {
      requestedAt: new Date().toISOString(),
      reason,
      mode,
    };
    this.logger.info({ jobId: id, mode, reason }, "Cancel requested for running job");
    return { ...job };
  }

  // ── Pause / Resume ─────────────────────────────────────────────────────

  /**
   * Pause a pending or running job. For running jobs, sends cancel with
   * cancel-current mode and marks it as paused so it can be resumed.
   */
  pauseJob(id: string): Job {
    const job = this.requireMutableJob(id);

    if (job.state === "pending") {
      // Simply mark — the job won't be dispatched until resumed
      this.getOrCreateMeta(job.id).paused = true;
      this.logger.info({ jobId: id }, "Pending job paused");
      return { ...job };
    }

    if (job.state === "running") {
      // Cancel the running action but keep the job record in a resumable state
      this.botManager.cancelJob(job.botId, id, "cancel-current", "pause requested");
      this.getOrCreateMeta(job.id).paused = true;
      this.logger.info({ jobId: id }, "Running job pause requested");
      return { ...job };
    }

    throw new JobManagerError("JOB_ALREADY_FINISHED", `Job ${id} is ${job.state}, cannot pause`);
  }

  /**
   * Resume a paused job. If the job was pending, it will be dispatched
   * on the next cycle. If it was running, it will be re-submitted.
   */
  resumeJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) {
      throw new JobManagerError("JOB_NOT_FOUND", `Job ${id} not found`);
    }

    if (!this.jobMeta.get(job.id)?.paused) {
      throw new JobManagerError("JOB_ALREADY_FINISHED", `Job ${id} is not paused`);
    }

    this.jobMeta.delete(job.id);

    // Re-submit as a new pending dispatch
    if (job.state === "cancelled" || job.state === "completed" || job.state === "failed" || job.state === "timeout") {
      // Job was already terminal — can't truly resume, but we can re-queue
      // Reset to pending and re-dispatch
      job.state = "pending";
      job.startedAt = undefined;
      job.finishedAt = undefined;
      job.error = undefined;
      job.result = undefined;
      job.progress = undefined;
    }

    if (this.isBotBusy(job.botId)) {
      this.enqueueJob(job.botId, job.id);
      this.logger.info({ jobId: id }, "Job re-queued (bot busy)");
    } else {
      this.dispatchJob(job);
    }

    return { ...job };
  }

  // ── Worker event handling (called by BotManager or external wiring) ────

  /**
   * Process a WorkerEvent that pertains to job lifecycle.
   * This should be wired up by the integrator (e.g., BotManager forwards events).
   */
  handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case "jobProgress": {
        const job = this.jobs.get(event.jobId);
        if (!job) return;
        job.progress = event.progress;
        this.emitJobEvent("job.progress", job, { progress: event.progress });
        break;
      }

      case "jobComplete": {
        const job = this.jobs.get(event.jobId);
        if (!job) return;
        this.transitionJob(job, "completed");
        job.result = event.result;
        this.emitJobEvent("job.completed", job, { result: event.result });
        this.dispatchNextInQueue(job.botId);
        break;
      }

      case "jobFailed": {
        const job = this.jobs.get(event.jobId);
        if (!job) return;

        // Check retry policy
        const currentAttempt = this.jobMeta.get(job.id)?.attempt ?? 1;
        if (
          job.retry.maxAttempts > 1 &&
          currentAttempt < job.retry.maxAttempts &&
          this.shouldRetry(job, event.error)
        ) {
          this.getOrCreateMeta(job.id).attempt = currentAttempt + 1;
          job.state = "pending";
          const delay = job.retry.backoffMs * currentAttempt;
          this.logger.info(
            { jobId: job.id, attempt: currentAttempt + 1, delay },
            "Retrying job",
          );
          setTimeout(() => {
            this.dispatchJob(job);
          }, delay);
        } else {
          this.transitionJob(job, "failed");
          job.error = event.error;
          this.emitJobEvent("job.failed", job, { error: event.error });
          this.dispatchNextInQueue(job.botId);
        }
        break;
      }
    }
  }

  // ── Internal: dispatch ─────────────────────────────────────────────────

  private dispatchJob(job: Job): void {
    const now = new Date().toISOString();
    job.state = "running";
    job.startedAt = now;
    this.getOrCreateMeta(job.id).attempt = this.jobMeta.get(job.id)?.attempt ?? 1;

    this.logger.info({ jobId: job.id, botId: job.botId, skill: job.skill }, "Dispatching job");

    this.botManager.runSkill(
      job.botId,
      job.id,
      job.skill,
      job.params,
      job.timeoutMs,
    );

    this.emitJobEvent("job.started", job);

    // Set up timeout
    if (job.timeoutMs > 0) {
      const timeoutHandle = setTimeout(() => {
        if (job.state === "running") {
          this.transitionJob(job, "timeout");
          job.error = {
            code: "JOB_TIMEOUT",
            message: `Job timed out after ${job.timeoutMs}ms`,
            retryable: false,
          };
          this.botManager.cancelJob(job.botId, job.id, "cancel-current", "timeout");
          this.emitJobEvent("job.failed", job, { error: job.error });
          this.dispatchNextInQueue(job.botId);
        }
      }, job.timeoutMs);

      // Store handle so we can clear on completion
      this.timeoutHandles.set(job.id, timeoutHandle);
    }
  }

  private dispatchNextInQueue(botId: string): void {
    const queue = this.botQueues.get(botId);
    if (!queue || queue.length === 0) return;

    const nextId = queue.shift();
    if (!nextId) return;

    const nextJob = this.jobs.get(nextId);
    if (!nextJob || nextJob.state !== "pending") {
      // Skip and try next
      this.dispatchNextInQueue(botId);
      return;
    }

    // Check if paused
    if (this.jobMeta.get(nextJob.id)?.paused) return;

    this.dispatchJob(nextJob);
  }

  // ── Internal: busy management ──────────────────────────────────────────

  private isBotBusy(botId: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.botId === botId && job.state === "running") {
        return true;
      }
    }
    return false;
  }

  private cancelCurrentJob(botId: string, reason: string, mode: CancellationMode): void {
    for (const job of this.jobs.values()) {
      if (job.botId === botId && job.state === "running") {
        this.cancelJob(job.id, mode, reason);
        return;
      }
    }
  }

  // ── Internal: queue management ─────────────────────────────────────────

  private enqueueJob(botId: string, jobId: string): void {
    let queue = this.botQueues.get(botId);
    if (!queue) {
      queue = [];
      this.botQueues.set(botId, queue);
    }
    queue.push(jobId);
  }

  private removeFromQueue(botId: string, jobId: string): void {
    const queue = this.botQueues.get(botId);
    if (!queue) return;
    const idx = queue.indexOf(jobId);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
  }

  // ── Internal: state transitions ────────────────────────────────────────

  private finishJobAsFailed(job: Job, code: string, message: string, retryable: boolean): void {
    const now = new Date().toISOString();
    job.state = "failed";
    job.finishedAt = now;
    job.error = { code, message, retryable };
    this.emitJobEvent("job.failed", job, { error: job.error });
  }

  private transitionJob(job: Job, newStatus: JobStatus): void {
    const terminalStatuses = new Set(["completed", "failed", "cancelled", "timeout"]);

    job.state = newStatus;
    if (terminalStatuses.has(newStatus)) {
      job.finishedAt = new Date().toISOString();
      this.cleanupJob(job.id);
    }
  }

  // ── Internal: retry logic ──────────────────────────────────────────────

  private shouldRetry(job: Job, error: JobError): boolean {
    if (!error.retryable) return false;
    if (job.retry.retryOn.length === 0) return true;
    return job.retry.retryOn.includes(error.code);
  }

  // ── Internal: event emission ───────────────────────────────────────────

  private emitJobEvent(
    eventType: string,
    job: Job,
    extraData: Record<string, unknown> = {},
  ): void {
    this.eventBus.emit({
      id: "",
      ts: "",
      type: eventType,
      botId: job.botId,
      jobId: job.id,
      data: {
        job: { ...job },
        ...extraData,
      },
    } as any);
  }

  // ── Internal: metadata helpers ─────────────────────────────────────────

  private getOrCreateMeta(jobId: string): { paused?: boolean; attempt?: number } {
    let meta = this.jobMeta.get(jobId);
    if (!meta) {
      meta = {};
      this.jobMeta.set(jobId, meta);
    }
    return meta;
  }

  private cleanupJob(jobId: string): void {
    this.jobMeta.delete(jobId);
    const handle = this.timeoutHandles.get(jobId);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(jobId);
    }
  }

  // ── Internal: validation ───────────────────────────────────────────────

  private requireMutableJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) {
      throw new JobManagerError("JOB_NOT_FOUND", `Job ${id} not found`);
    }
    return job;
  }
}

// ─── Error class ───────────────────────────────────────────────────────────

export class JobManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "JobManagerError";
  }
}
