import type { Bot } from "mineflayer";
import type { IndexedData } from "minecraft-data";
import type { BotConfig } from "../types/bot.js";
import type { BotState } from "../types/bot.js";
import type { SkillResult, SkillProgressReport } from "../types/skills.js";
import { MineflayerAdapter } from "./mineflayer-adapter.js";
import { StateTracker } from "./state-tracker.js";
import { SkillExecutor } from "./skill-executor.js";
import {
  ModeEngine,
  createSelfPreservationMode,
  createSelfDefenseMode,
  createUnstuckMode,
  createIdleStaringMode,
  createElbowRoomMode,
} from "./mode-engine.js";
import type { SkillDefinition, SkillExecutionContext } from "./skill-executor.js";

// ─── BotRuntime Events ──────────────────────────────────────────────────────

export interface BotRuntimeEvents {
  connected: (host: string, port: number) => void;
  spawned: () => void;
  disconnected: (reason: string, expected: boolean, willReconnect: boolean) => void;
  chatReceived: (sender: string | undefined, message: string, ts: string) => void;
  jobProgress: (jobId: string, progress: SkillProgressReport) => void;
  jobComplete: (jobId: string, result: SkillResult) => void;
  jobFailed: (jobId: string, error: { code: string; message: string; retryable: boolean }) => void;
  jobCancelled: (jobId: string, reason: string) => void;
  error: (err: { code: string; message: string; retryable: boolean; source: string }) => void;
  stateChanged: (state: BotState) => void;
  modeTriggered: (mode: string, reason: string) => void;
}

// ─── BotRuntime ─────────────────────────────────────────────────────────────

export class BotRuntime {
  readonly adapter: MineflayerAdapter;
  readonly stateTracker: StateTracker;
  readonly skillExecutor: SkillExecutor;
  readonly modeEngine: ModeEngine;

  private botConfig: BotConfig | null = null;
  private connected = false;
  private mcData: IndexedData | null = null;
  private eventCallbacks: Partial<BotRuntimeEvents> = {};

  constructor(botId: string) {
    this.adapter = new MineflayerAdapter();
    this.stateTracker = new StateTracker(botId);
    this.skillExecutor = new SkillExecutor();
    this.modeEngine = new ModeEngine();

    this.registerBuiltInModes();
    this.bindAdapterEvents();
  }

  // ── Event registration ──────────────────────────────────────────────────

  on<K extends keyof BotRuntimeEvents>(
    event: K,
    callback: BotRuntimeEvents[K],
  ): void {
    this.eventCallbacks[event] = callback;
  }

  // ── Connect ─────────────────────────────────────────────────────────────

  async connect(config: BotConfig): Promise<void> {
    this.botConfig = config;
    this.stateTracker.setStatus("connecting");

    // Load mode config
    this.modeEngine.loadConfig(config.modes);

    // Connect the Mineflayer bot
    await this.adapter.connect(config);

    // The adapter emits 'connected' and 'spawned' events which we handle
    // to finish initialization via onAdapterConnected/onAdapterSpawned
  }

  // ── Disconnect ──────────────────────────────────────────────────────────

  async disconnect(reason?: string): Promise<void> {
    this.stateTracker.setStatus("disconnected");
    this.modeEngine.stop();
    await this.adapter.disconnect(reason);
    this.connected = false;
  }

  // ── Destroy ─────────────────────────────────────────────────────────────

  async destroy(reason?: string): Promise<void> {
    this.stateTracker.setStatus("destroyed");
    this.modeEngine.destroy();
    await this.adapter.destroy(reason);
    this.connected = false;
  }

  // ── Run a skill ─────────────────────────────────────────────────────────

  async runSkill(
    skill: string,
    params: unknown,
    jobId: string,
    timeoutMs?: number,
  ): Promise<SkillResult> {
    if (!this.connected || !this.botConfig) {
      const error = {
        code: "BOT_NOT_READY",
        message: "Bot is not connected",
        retryable: false,
      };
      this.eventCallbacks.jobFailed?.(jobId, error);
      return {
        ok: false,
        status: "failed",
        error,
      };
    }

    this.stateTracker.setCurrentJob(jobId);
    this.stateTracker.setCurrentAction(skill);

    const bot = this.adapter.getBot();
    const mcData = this.adapter.getMcData();

    try {
      const result = await this.skillExecutor.executeSkill(
        skill,
        params,
        bot,
        mcData,
        this.botConfig.id ?? this.botConfig.name,
        jobId,
        this.botConfig,
        this.modeEngine,
        (report) => {
          this.eventCallbacks.jobProgress?.(jobId, report);
        },
        timeoutMs,
      );

      if (result.ok) {
        this.eventCallbacks.jobComplete?.(jobId, result);
      } else if (result.status === "cancelled") {
        this.eventCallbacks.jobCancelled?.(jobId, result.error?.message ?? "cancelled");
      } else {
        this.eventCallbacks.jobFailed?.(jobId, {
          code: result.error?.code ?? "SKILL_FAILED",
          message: result.error?.message ?? "Skill failed",
          retryable: result.error?.retryable ?? false,
        });
      }

      return result;
    } finally {
      this.stateTracker.setCurrentJob(undefined);
      this.stateTracker.setCurrentAction(undefined);
    }
  }

  // ── Run an observation skill (parallel — does not block the primary lane) ──

  async runObservation(
    skill: string,
    params: unknown,
    jobId: string,
    timeoutMs?: number,
  ): Promise<SkillResult> {
    if (!this.connected || !this.botConfig) {
      const error = {
        code: "BOT_NOT_READY",
        message: "Bot is not connected",
        retryable: false,
      };
      this.eventCallbacks.jobFailed?.(jobId, error);
      return { ok: false, status: "failed", error };
    }

    const bot = this.adapter.getBot();
    const mcData = this.adapter.getMcData();

    const result = await this.skillExecutor.executeObservationSkill(
      skill,
      params,
      bot,
      mcData,
      this.botConfig.id ?? this.botConfig.name,
      jobId,
      this.botConfig,
      (report) => {
        this.eventCallbacks.jobProgress?.(jobId, report);
      },
      timeoutMs,
    );

    if (result.ok) {
      this.eventCallbacks.jobComplete?.(jobId, result);
    } else if (result.status === "cancelled") {
      this.eventCallbacks.jobCancelled?.(jobId, result.error?.message ?? "cancelled");
    } else {
      this.eventCallbacks.jobFailed?.(jobId, {
        code: result.error?.code ?? "SKILL_FAILED",
        message: result.error?.message ?? "Skill failed",
        retryable: result.error?.retryable ?? false,
      });
    }

    return result;
  }

  // ── Cancel a job ────────────────────────────────────────────────────────

  cancelJob(jobId: string, reason?: string): boolean {
    return this.skillExecutor.cancelJob(jobId, reason);
  }

  // ── Get current state ───────────────────────────────────────────────────

  getState(): BotState {
    const state = this.stateTracker.getState();
    state.modes = this.modeEngine.getStatuses();
    return state;
  }

  // ── Toggle a mode ──────────────────────────────────────────────────────

  toggleMode(modeName: string, enabled?: boolean, paused?: boolean): boolean {
    return this.modeEngine.toggleMode(modeName, enabled, paused);
  }

  // ── Send chat ───────────────────────────────────────────────────────────

  sendChat(message: string): void {
    if (!this.connected) {
      throw new Error("Bot is not connected");
    }
    this.adapter.sendChat(message);
  }

  // ── Register a skill ────────────────────────────────────────────────────

  registerSkill<TParams>(definition: SkillDefinition<TParams>): void {
    this.skillExecutor.registerSkill(definition);
  }

  // ── Is connected? ───────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  // ── Private: register built-in modes ────────────────────────────────────

  private registerBuiltInModes(): void {
    this.modeEngine.registerMode(createSelfPreservationMode());
    this.modeEngine.registerMode(createSelfDefenseMode());
    this.modeEngine.registerMode(createUnstuckMode());
    this.modeEngine.registerMode(createIdleStaringMode());
    this.modeEngine.registerMode(createElbowRoomMode());
  }

  // ── Private: bind adapter events ────────────────────────────────────────

  private bindAdapterEvents(): void {
    this.adapter.on("connected", () => {
      this.onAdapterConnected();
    });

    this.adapter.on("spawned", () => {
      this.onAdapterSpawned();
    });

    this.adapter.on("disconnected", (reason, expected, willReconnect) => {
      this.connected = false;
      this.stateTracker.setStatus(
        willReconnect ? "reconnecting" : "disconnected",
      );
      this.modeEngine.stop();
      this.eventCallbacks.disconnected?.(reason, expected, willReconnect);
    });

    this.adapter.on("chatReceived", (sender, message, _raw) => {
      const ts = new Date().toISOString();
      this.stateTracker.addChatMessage({
        botId: this.botConfig?.id ?? "",
        direction: "received",
        sender,
        message,
        ts,
      });
      this.eventCallbacks.chatReceived?.(sender, message, ts);
    });

    this.adapter.on("error", (err) => {
      this.stateTracker.addError(err);
      this.eventCallbacks.error?.(err);
    });

    this.adapter.on("nanDetected", () => {
      this.skillExecutor.cancelCurrent("nan_coordinate");
    });

    this.adapter.on("healthChanged", () => {
      // StateTracker picks this up via bot events directly
    });

    this.adapter.on("positionChanged", () => {
      // StateTracker picks this up via bot events directly
    });

    this.adapter.on("kicked", (reason, _loggedIn) => {
      this.stateTracker.addError({
        code: "KICKED",
        message: reason,
        retryable: true,
        source: "server",
      });
    });

    // StateTracker state updates → propagate to runtime events
    this.stateTracker.on("stateUpdate", (state: BotState) => {
      this.eventCallbacks.stateChanged?.(state);
    });
  }

  // ── Private: on adapter connected ───────────────────────────────────────

  private onAdapterConnected(): void {
    const bot = this.adapter.getBot();
    const mcData = this.adapter.getMcData();
    this.mcData = mcData;

    // Set identity
    this.stateTracker.setIdentity(bot.username, bot.player?.uuid);

    // Bind StateTracker to live bot
    this.stateTracker.bind(bot, mcData);

    // Initialize ModeEngine
    this.modeEngine.init({
      bot,
      mcData,
      isIdle: () => !this.skillExecutor.isRunning(),
      currentSkill: () => this.skillExecutor.getCurrentJobId() ? "running" : null,
      onInterrupt: () => {
        this.skillExecutor.cancelCurrent("mode_interrupt");
        // Stop pathfinder and pvp
        try {
          bot.pathfinder?.stop?.();
        } catch {
          /* ignore */
        }
        try {
          (bot as unknown as { pvp?: { stop: () => void } }).pvp?.stop?.();
        } catch {
          /* ignore */
        }
      },
      onRequestAction: (_skillName, _params) => {
        // Actions requested by modes are logged but execution
        // is handled by the mode's direct bot API calls.
        // The skill executor integration can be added when
        // the requestAction pipeline is fully wired.
      },
      onTriggered: (mode, reason) => {
        this.eventCallbacks.modeTriggered?.(mode, reason);
      },
      log: (msg) => {
        console.log(`[BotRuntime] ${msg}`);
      },
    });

    this.connected = true;

    const mc = this.botConfig?.minecraft;
    this.eventCallbacks.connected?.(
      mc?.host ?? "unknown",
      mc?.port ?? 25565,
    );
  }

  // ── Private: on adapter spawned ─────────────────────────────────────────

  private onAdapterSpawned(): void {
    this.stateTracker.setStatus("running");

    // Start mode update loop
    this.modeEngine.start(500);

    this.eventCallbacks.spawned?.();
  }
}
