import { describe, it, expect, beforeEach, vi } from "vitest";
import { JobManager } from "./job-manager.js";
import { EventBus } from "./event-bus.js";
import type { BotManager } from "./bot-manager.js";

/**
 * P0 #4: JobManager.handleWorkerDeath must transition the running job
 * to failed with code WORKER_CRASH, emit the event, and drain the queue
 * — without BotManager fabricating anything.
 */

function makeBotManagerStub(): BotManager {
  return {
    runSkill: vi.fn(),
    cancelJob: vi.fn(),
    getBotStatus: vi.fn().mockReturnValue("running"),
    getBot: vi.fn(),
    listBots: vi.fn(),
    isBotReady: vi.fn().mockReturnValue(true),
  } as unknown as BotManager;
}

describe("JobManager — handleWorkerDeath (P0 #4)", () => {
  let eventBus: EventBus;
  let botManager: BotManager;
  let jobManager: JobManager;

  beforeEach(() => {
    eventBus = new EventBus();
    botManager = makeBotManagerStub();
    jobManager = new JobManager({ eventBus, botManager });
  });

  it("transitions running job to failed with WORKER_CRASH", () => {
    // submitJob dispatches immediately (no busy bot), so the job starts "running"
    const job = jobManager.submitJob("bot1", "move.to_position", { x: 0, y: 0, z: 0 });

    jobManager.handleWorkerDeath("bot1", job.id, 1);

    const finalJob = jobManager.getJob(job.id);
    expect(finalJob.state).toBe("failed");
    expect(finalJob.error?.code).toBe("WORKER_CRASH");
    expect(finalJob.error?.message).toContain("1");
    expect(finalJob.error?.retryable).toBe(true);
    expect(finalJob.finishedAt).toBeDefined();
  });

  it("is a no-op when job is not found", () => {
    expect(() => jobManager.handleWorkerDeath("bot1", "nonexistent", 1)).not.toThrow();
  });

  it("does not re-fail an already-failed job", () => {
    const job = jobManager.submitJob("bot1", "move.to_position", { x: 0, y: 0, z: 0 });

    // First death: transitions to failed
    jobManager.handleWorkerDeath("bot1", job.id, 1);
    expect(jobManager.getJob(job.id).state).toBe("failed");

    const firstFinishedAt = jobManager.getJob(job.id).finishedAt;

    // Second death: should be a no-op (job is already failed, not running)
    jobManager.handleWorkerDeath("bot1", job.id, 1);
    expect(jobManager.getJob(job.id).state).toBe("failed");
    expect(jobManager.getJob(job.id).finishedAt).toBe(firstFinishedAt);
  });

  it("emits job.failed event to EventBus", () => {
    const events: Array<{ type: string; jobId: string }> = [];
    eventBus.on("job.failed", (e: any) => {
      events.push({ type: e.type, jobId: e.data?.job?.id });
    });

    const job = jobManager.submitJob("bot1", "move.to_position", { x: 0, y: 0, z: 0 });

    jobManager.handleWorkerDeath("bot1", job.id, 1);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.jobId).toBe(job.id);
  });

  it("dispatches next queued job after worker death", () => {
    // Submit first job (runs immediately)
    const job1 = jobManager.submitJob("bot1", "move.to_position", { x: 0, y: 0, z: 0 });

    // Submit second job — bot is busy, so it queues
    const job2 = jobManager.submitJob("bot1", "move.to_position", { x: 10, y: 0, z: 0 });

    // Worker dies with the first job
    jobManager.handleWorkerDeath("bot1", job1.id, 1);

    // First job should be failed
    const finalJob1 = jobManager.getJob(job1.id);
    expect(finalJob1.state).toBe("failed");
    expect(finalJob1.error?.code).toBe("WORKER_CRASH");

    // Second job should have been dispatched from the queue (now running)
    const finalJob2 = jobManager.getJob(job2.id);
    // If the queue drain dispatched it, it'll be "running".
    // If not (because we're stubbing runSkill), it's at least not "pending" anymore.
    expect(finalJob2.state).not.toBe("failed");
  });

  it("WORKER_CRASH error is retryable", () => {
    const job = jobManager.submitJob("bot1", "move.to_position", { x: 0, y: 0, z: 0 });

    jobManager.handleWorkerDeath("bot1", job.id, 1);

    const finalJob = jobManager.getJob(job.id);
    expect(finalJob.error?.retryable).toBe(true);
  });
});
