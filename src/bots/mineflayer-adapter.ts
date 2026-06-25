import { EventEmitter } from "node:events";
import mineflayer from "mineflayer";
import pf from "mineflayer-pathfinder";
const { pathfinder } = pf;
import { plugin as pvp } from "mineflayer-pvp";
import { plugin as collectblock } from "mineflayer-collectblock";
import { plugin as autoEat } from "mineflayer-auto-eat";
import armorManagerPlugin from "mineflayer-armor-manager";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import type { IndexedData } from "minecraft-data";
import type { CompatibilityConfig, ReconnectPolicy } from "../types/config.js";
import type { BotConfig } from "../types/bot.js";

// ─── Typed events emitted by MineflayerAdapter ──────────────────────────────

export interface MineflayerAdapterEvents {
  connected: () => void;
  spawned: () => void;
  disconnected: (reason: string, expected: boolean, willReconnect: boolean) => void;
  kicked: (reason: string, loggedIn: boolean) => void;
  chatReceived: (sender: string | undefined, message: string, raw: unknown) => void;
  healthChanged: (health: number, food: number) => void;
  positionChanged: (x: number, y: number, z: number) => void;
  entityGone: (entityId: number) => void;
  nanDetected: () => void;
  error: (err: { code: string; message: string; retryable: boolean; source: string }) => void;
}

// ─── Reconnect state ────────────────────────────────────────────────────────

const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  factor: 2,
  jitter: true,
};

// ─── MineflayerAdapter ──────────────────────────────────────────────────────

export class MineflayerAdapter extends EventEmitter {
  private bot: Bot | null = null;
  private mcData: IndexedData | null = null;
  private botConfig: BotConfig | null = null;
  private disconnectExpected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableSince: number | null = null;
  private positionThrottleTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Public getters ──────────────────────────────────────────────────────

  getBot(): Bot {
    if (!this.bot) throw new Error("Bot not initialized — call connect() first");
    return this.bot;
  }

  getMcData(): IndexedData {
    if (!this.mcData) throw new Error("mcData not initialized — bot must be logged in");
    return this.mcData;
  }

  isConnected(): boolean {
    return this.bot !== null && this.bot.entity !== undefined;
  }

  // ── Connect ─────────────────────────────────────────────────────────────

  async connect(config: BotConfig): Promise<void> {
    this.botConfig = config;
    this.disconnectExpected = false;

    const mc = config.minecraft;
    const options: mineflayer.BotOptions = {
      username: mc.username,
      host: mc.host,
      port: mc.port,
      auth: mc.auth as "offline" | "microsoft",
      checkTimeoutInterval: mc.checkTimeoutIntervalMs ?? 60000,
    };

    // Only set version when not "auto"
    if (mc.version && mc.version !== "auto") {
      options.version = mc.version;
    }

    this.bot = mineflayer.createBot(options);
    this.loadPlugins();
    this.applyCompatibility(config.compatibility);
    this.bindEvents();
  }

  // ── Disconnect ──────────────────────────────────────────────────────────

  async disconnect(reason?: string): Promise<void> {
    this.disconnectExpected = true;
    this.clearReconnectTimer();
    this.clearPositionThrottleTimer();

    if (this.bot) {
      try {
        this.bot.quit(reason);
      } catch {
        // ignore — bot may already be disconnected
      }
    }
  }

  // ── Destroy ─────────────────────────────────────────────────────────────

  async destroy(reason?: string): Promise<void> {
    this.disconnectExpected = true;
    this.clearReconnectTimer();
    this.clearPositionThrottleTimer();

    if (this.bot) {
      try {
        this.bot.end(reason ?? "destroyed");
      } catch {
        // ignore
      }
      this.bot = null;
      this.mcData = null;
    }
  }

  // ── Send chat ───────────────────────────────────────────────────────────

  sendChat(message: string): void {
    if (!this.bot) throw new Error("Bot not initialized");
    this.bot.chat(message);
  }

  // ── Plugin loading ──────────────────────────────────────────────────────

  private loadPlugins(): void {
    const bot = this.bot!;
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManagerPlugin as unknown as (bot: Bot) => void);
  }

  // ── Compatibility patches (from mindcraft mcdata.js) ─────────────────────

  private applyCompatibility(compat?: CompatibilityConfig): void {
    if (!this.bot) return;
    const bot = this.bot;
    const throttlePosition = compat?.throttlePositionPackets ?? false;
    const suppressPartialRead = compat?.suppressPartialReadErrors ?? true;
    const acceptResourcePacks = compat?.acceptResourcePacks ?? true;
    const throttleMs = compat?.positionThrottleMs ?? 50;

    // Auto-accept resource packs
    if (acceptResourcePacks) {
      bot.once("resourcePack", () => {
        bot.acceptResourcePack();
      });
    }

    // Position packet throttling for Paper/Spigot servers
    if (throttlePosition) {
      this.applyPositionThrottle(bot, throttleMs);
    }

    // PartialReadError suppression
    if (suppressPartialRead) {
      this.applyPartialReadSuppression(bot);
    }
  }

  private applyPositionThrottle(bot: Bot, throttleMs: number): void {
    let lastPositionUpdate = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const originalWrite = bot._client.write.bind(bot._client) as (
      name: string,
      data: unknown,
    ) => void;

    bot._client.write = (name: string, data: unknown) => {
      if (
        name === "position" ||
        name === "position_look" ||
        name === "look"
      ) {
        const now = Date.now();
        if (now - lastPositionUpdate < throttleMs) {
          if (!pendingTimer) {
            pendingTimer = setTimeout(() => {
              pendingTimer = null;
              lastPositionUpdate = Date.now();
              originalWrite(name, data);
            }, throttleMs - (now - lastPositionUpdate));
          }
          return;
        }
        lastPositionUpdate = now;
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
      }
      return originalWrite(name, data);
    };

    this.positionThrottleTimer = pendingTimer;
  }

  private clearPositionThrottleTimer(): void {
    if (this.positionThrottleTimer) {
      clearTimeout(this.positionThrottleTimer);
      this.positionThrottleTimer = null;
    }
  }

  private applyPartialReadSuppression(bot: Bot): void {
    const originalEmit = bot._client.emit.bind(bot._client) as (
      event: string,
      ...args: unknown[]
    ) => boolean;

    bot._client.emit = (event: string, ...args: unknown[]): boolean => {
      if (event === "error" && args[0]) {
        const err = args[0] as Error;
        const errStr = err instanceof Error ? err.message : String(err);
        if (errStr.includes("PartialReadError")) {
          return true; // swallow
        }
      }
      return originalEmit(event, ...args);
    };

    // Prevent server position_look from overriding our pitch (run BEFORE Mineflayer's handler)
    bot._client.prependListener("position_look", (data: { yaw: number; pitch: number; x: number; y: number; z: number }) => {
      if (bot.entity && Math.abs(data.pitch) > 0.5) {
        data.pitch = 0; // keep horizontal
      }
    });

    // Fallback: immediate pitch correction on any position update
    bot.on("move", () => {
      if (bot.entity && Math.abs(bot.entity.pitch) > 0.5) {
        bot.entity.pitch = 0;
      }
    });
  }

  // ── Event binding ───────────────────────────────────────────────────────

  private bindEvents(): void {
    const bot = this.bot!;

    bot.once("login", () => {
      this.mcData = minecraftData(bot.version);
      this.reconnectAttempt = 0;
      this.stableSince = Date.now();
      this.emit("connected");
    });

    bot.once("spawn", () => {
      this.emit("spawned");
    });

    bot.on("health", () => {
      this.emit("healthChanged", bot.health, bot.food);
    });

    bot.on("move", () => {
      const pos = bot.entity.position;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        // NaN coordinate detected — quarantine: stop pathfinder, cancel active skill, and emit error
        try {
          bot.pathfinder?.stop?.();
        } catch {
          /* ignore */
        }
        this.emit("nanDetected");
        this.emit("error", {
          code: "NAN_COORDINATE",
          message: `NaN coordinate detected: (${pos.x}, ${pos.y}, ${pos.z})`,
          retryable: true,
          source: "mineflayer",
        });
        return;
      }
      this.emit("positionChanged", pos.x, pos.y, pos.z);
    });

    bot.on("entityGone", (entity) => {
      this.emit("entityGone", entity.id);
    });

    bot.on("chat", (username, message, _translate, jsonMsg) => {
      this.emit("chatReceived", username, message, jsonMsg);
    });

    bot.on("whisper", (username, message, _translate, jsonMsg) => {
      this.emit("chatReceived", username, message, jsonMsg);
    });

    bot.on("kicked", (reason, loggedIn) => {
      const reasonStr =
        typeof reason === "string" ? reason : JSON.stringify(reason);
      this.emit("kicked", reasonStr, loggedIn as boolean);

      if (this.disconnectExpected) return;
      this.handleDisconnect(reasonStr, false);
    });

    bot.on("end", (reason) => {
      const reasonStr = reason ?? "connection ended";
      if (!this.disconnectExpected) {
        this.handleDisconnect(reasonStr, false);
      } else {
        this.emit("disconnected", reasonStr, true, false);
      }
    });

    bot.on("error", (err) => {
      // Ignore errors after expected disconnect
      if (this.disconnectExpected) return;

      const errStr = err instanceof Error ? err.message : String(err);
      const retryable = isTransientError(errStr);

      this.emit("error", {
        code: retryable ? "TRANSIENT_ERROR" : "MINEFLAYER_ERROR",
        message: errStr,
        retryable,
        source: "mineflayer",
      });
    });
  }

  // ── Reconnection logic ──────────────────────────────────────────────────

  private handleDisconnect(reason: string, willReconnect: boolean): void {
    this.emit("disconnected", reason, false, willReconnect);

    const policy = this.botConfig?.reconnect ?? DEFAULT_RECONNECT;
    if (!policy.enabled) return;

    if (policy.maxAttempts !== undefined && this.reconnectAttempt >= policy.maxAttempts) {
      this.emit("error", {
        code: "RECONNECT_EXHAUSTED",
        message: `Max reconnect attempts (${policy.maxAttempts}) exceeded`,
        retryable: false,
        source: "reconnect",
      });
      return;
    }

    const delay = this.calculateBackoff(policy);
    this.reconnectAttempt++;

    this.emit("disconnected", reason, false, true);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  private calculateBackoff(policy: ReconnectPolicy): number {
    const base = policy.initialDelayMs ?? 1000;
    const max = policy.maxDelayMs ?? 60000;
    const factor = policy.factor ?? 2;

    let delay = base * Math.pow(factor, this.reconnectAttempt);
    delay = Math.min(delay, max);

    if (policy.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.botConfig) return;

    try {
      // Clean up old bot
      if (this.bot) {
        try {
          this.bot.end("reconnecting");
        } catch {
          // ignore
        }
      }

      await this.connect(this.botConfig);
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      this.emit("error", {
        code: "RECONNECT_FAILED",
        message: `Reconnect attempt ${this.reconnectAttempt} failed: ${errStr}`,
        retryable: true,
        source: "reconnect",
      });

      // Schedule next attempt
      this.handleDisconnect("reconnect failed", true);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ─── Error classification ───────────────────────────────────────────────────

const TRANSIENT_PATTERNS = [
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "ENOTFOUND",
  "socket hang up",
  "read ECONNRESET",
  "PartialReadError",
];

function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => message.includes(p));
}
