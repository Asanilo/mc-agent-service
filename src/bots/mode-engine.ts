import type { Bot } from "mineflayer";
import type { IndexedData } from "minecraft-data";
import type { ModeStatus } from "../types/bot.js";

// ─── Mode Definition ────────────────────────────────────────────────────────

export interface ModeDefinition {
  name: string;
  description: string;
  priority: number; // higher = more important
  enabled: boolean;
  permissions: string[]; // what this mode can do: "move", "attack", "dig", "place", "consume"
  /** Whether this mode can interrupt the current primary action */
  interruptsAll: boolean;
  /** Specific skill names this mode can interrupt */
  interruptsSkills: string[];
  /** The update function — called each tick. Should return quickly (<100ms). */
  update: (ctx: ModeContext) => Promise<void> | void;
  /** Called when mode is unpaused — reset internal state */
  onUnpause?: () => void;
}

export interface ModeContext {
  bot: Bot;
  mcData: IndexedData;
  isIdle: boolean;
  currentSkillName: string | null;
  interruptCurrentAction: () => void;
  log: (message: string) => void;
}

// ─── Mode Runtime State ─────────────────────────────────────────────────────

interface ModeRuntime {
  definition: ModeDefinition;
  enabled: boolean;
  paused: boolean;
  active: boolean;
  pausedDepth: number; // for scoped pauses
  lastTriggeredAt: string | null;
}

// ─── Scoped Pause Handle ────────────────────────────────────────────────────

export interface ScopedPauseHandle {
  restore: () => void;
}

// ─── ModeEngine ─────────────────────────────────────────────────────────────

export class ModeEngine {
  private modes = new Map<string, ModeRuntime>();
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private bot: Bot | null = null;
  private mcData: IndexedData | null = null;
  private onInterruptRequest: (() => void) | null = null;
  private isIdleFn: (() => boolean) | null = null;
  private currentSkillFn: (() => string | null) | null = null;
  private onModeTriggered: ((mode: string, reason: string) => void) | null = null;
  private logFn: ((message: string) => void) | null = null;

  // ── Register a mode ─────────────────────────────────────────────────────

  registerMode(definition: ModeDefinition): void {
    if (this.modes.has(definition.name)) {
      throw new Error(`Mode "${definition.name}" is already registered`);
    }
    this.modes.set(definition.name, {
      definition,
      enabled: definition.enabled,
      paused: false,
      active: false,
      pausedDepth: 0,
      lastTriggeredAt: null,
    });
  }

  // ── Initialize with bot and callbacks ───────────────────────────────────

  init(opts: {
    bot: Bot;
    mcData: IndexedData;
    onInterrupt: () => void;
    isIdle: () => boolean;
    currentSkill: () => string | null;
    onTriggered: (mode: string, reason: string) => void;
    log: (message: string) => void;
  }): void {
    this.bot = opts.bot;
    this.mcData = opts.mcData;
    this.onInterruptRequest = opts.onInterrupt;
    this.isIdleFn = opts.isIdle;
    this.currentSkillFn = opts.currentSkill;
    this.onModeTriggered = opts.onTriggered;
    this.logFn = opts.log;
  }

  // ── Start the mode update loop ──────────────────────────────────────────

  start(intervalMs = 500): void {
    if (this.updateInterval) return;
    this.updateInterval = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  // ── Stop the update loop ────────────────────────────────────────────────

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  // ── Pause a mode ────────────────────────────────────────────────────────

  pause(name: string): void {
    const runtime = this.modes.get(name);
    if (!runtime) return;
    runtime.paused = true;
    runtime.pausedDepth++;
  }

  // ── Unpause a mode ──────────────────────────────────────────────────────

  unpause(name: string): void {
    const runtime = this.modes.get(name);
    if (!runtime) return;
    if (runtime.pausedDepth > 0) runtime.pausedDepth--;
    if (runtime.pausedDepth === 0) {
      runtime.paused = false;
      runtime.definition.onUnpause?.();
    }
  }

  // ── Pause multiple modes ────────────────────────────────────────────────

  pauseMany(names: string[]): void {
    for (const name of names) {
      this.pause(name);
    }
  }

  // ── Unpause all ─────────────────────────────────────────────────────────

  unpauseAll(): void {
    for (const [name] of this.modes) {
      const runtime = this.modes.get(name)!;
      runtime.paused = false;
      runtime.pausedDepth = 0;
      runtime.definition.onUnpause?.();
    }
  }

  // ── Scoped pause — returns handle that restores previous state ──────────

  pauseScoped(name: string): ScopedPauseHandle | null {
    const runtime = this.modes.get(name);
    if (!runtime) return null;

    const wasPaused = runtime.paused;
    const prevDepth = runtime.pausedDepth;

    this.pause(name);

    return {
      restore: () => {
        if (!wasPaused) {
          runtime.paused = false;
        }
        runtime.pausedDepth = prevDepth;
      },
    };
  }

  // ── Enable/disable a mode ───────────────────────────────────────────────

  setEnabled(name: string, enabled: boolean): void {
    const runtime = this.modes.get(name);
    if (!runtime) return;
    runtime.enabled = enabled;
  }

  isEnabled(name: string): boolean {
    return this.modes.get(name)?.enabled ?? false;
  }

  isPaused(name: string): boolean {
    return this.modes.get(name)?.paused ?? false;
  }

  isActive(name: string): boolean {
    return this.modes.get(name)?.active ?? false;
  }

  // ── Get mode statuses for BotState ──────────────────────────────────────

  getStatuses(): ModeStatus[] {
    const statuses: ModeStatus[] = [];
    for (const [name, runtime] of this.modes) {
      statuses.push({
        name,
        enabled: runtime.enabled,
        paused: runtime.paused,
        active: runtime.active,
        priority: runtime.definition.priority,
        permissions: runtime.definition.permissions,
        lastTriggeredAt: runtime.lastTriggeredAt ?? undefined,
      });
    }
    return statuses;
  }

  // ── Set mode config from bot config ─────────────────────────────────────

  loadConfig(modeConfig: Record<string, boolean> | undefined): void {
    if (!modeConfig) return;
    for (const [name, enabled] of Object.entries(modeConfig)) {
      const runtime = this.modes.get(name);
      if (runtime) {
        runtime.enabled = enabled;
      }
    }
  }

  // ── Interrupt current action (called by mode update functions) ──────────

  private requestInterrupt(modeName: string, reason: string): void {
    this.onInterruptRequest?.();
    this.onModeTriggered?.(modeName, reason);
  }

  // ── Tick — called by the interval ───────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.bot || !this.mcData) return;

    const isIdle = this.isIdleFn?.() ?? true;
    const currentSkill = this.currentSkillFn?.() ?? null;

    // Sort by priority (highest first)
    const sorted = Array.from(this.modes.entries()).sort(
      (a, b) => b[1].definition.priority - a[1].definition.priority,
    );

    for (const [name, runtime] of sorted) {
      if (!runtime.enabled || runtime.paused || runtime.active) continue;

      // Check if this mode can run given current activity
      const def = runtime.definition;
      const canInterrupt =
        isIdle ||
        def.interruptsAll ||
        (currentSkill !== null && def.interruptsSkills.includes(currentSkill));

      if (!canInterrupt) continue;

      // Build context
      const ctx: ModeContext = {
        bot: this.bot,
        mcData: this.mcData,
        isIdle,
        currentSkillName: currentSkill,
        interruptCurrentAction: () => {
          this.requestInterrupt(name, def.description);
        },
        log: (msg) => {
          this.logFn?.(`[mode:${name}] ${msg}`);
        },
      };

      // Run mode update
      runtime.active = true;
      try {
        await def.update(ctx);
        runtime.lastTriggeredAt = new Date().toISOString();
      } catch (err) {
        const errStr = err instanceof Error ? err.message : String(err);
        this.logFn?.(`[mode:${name}] Error: ${errStr}`);
      } finally {
        runtime.active = false;
      }

      // If this mode interrupted something, stop processing lower-priority modes
      if (runtime.active) break;
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────────

  destroy(): void {
    this.stop();
    this.modes.clear();
    this.bot = null;
    this.mcData = null;
  }
}

// ─── Built-in Mode Definitions ──────────────────────────────────────────────

/**
 * Self-preservation: flee when health is critically low.
 */
export function createSelfPreservationMode(): ModeDefinition {
  return {
    name: "self_preservation",
    description: "Respond to drowning, burning, and damage at low health. Interrupts all actions.",
    priority: 100,
    enabled: true,
    permissions: ["move"],
    interruptsAll: true,
    interruptsSkills: [],
    update: (ctx) => {
      const bot = ctx.bot;
      const pos = bot.entity.position;
      const block = bot.blockAt(pos);
      const blockAbove = bot.blockAt(pos.offset(0, 1, 0));

      if (!block || !blockAbove) return;

      // In water — jump
      if (blockAbove.name === "water") {
        if (!bot.pathfinder?.goal) {
          bot.setControlState("jump", true);
        }
        return;
      }

      // In lava/fire — try to escape
      if (
        block.name === "lava" ||
        block.name === "fire" ||
        blockAbove.name === "lava" ||
        blockAbove.name === "fire"
      ) {
        ctx.log("On fire/lava — fleeing!");
        ctx.interruptCurrentAction();
        return;
      }

      // Low health and recently damaged
      const lastDamage = (bot as unknown as { lastDamageTime?: number }).lastDamageTime ?? 0;
      if (
        Date.now() - lastDamage < 3000 &&
        (bot.health < 5 || bot.health <= 2)
      ) {
        ctx.log("Low health under attack — fleeing!");
        ctx.interruptCurrentAction();
      }
    },
  };
}

/**
 * Self-defense: auto-attack hostile mobs nearby.
 */
export function createSelfDefenseMode(): ModeDefinition {
  return {
    name: "self_defense",
    description: "Attack nearby hostile mobs. Interrupts some actions.",
    priority: 80,
    enabled: true,
    permissions: ["attack", "move"],
    interruptsAll: true,
    interruptsSkills: [],
    update: (ctx) => {
      const bot = ctx.bot;
      const pos = bot.entity.position;

      // Find nearest hostile mob within 8 blocks
      const hostile = Object.values(bot.entities).find((entity) => {
        if (!entity?.position || !entity.name) return false;
        const dist = pos.distanceTo(entity.position);
        if (dist > 8) return false;
        return isHostile(entity);
      });

      if (hostile) {
        ctx.log(`Hostile ${hostile.name} nearby — defending!`);
        ctx.interruptCurrentAction();
      }
    },
  };
}

/**
 * Unstuck: detect when bot hasn't moved and try to free it.
 */
export function createUnstuckMode(): ModeDefinition {
  let prevPosition: { x: number; y: number; z: number } | null = null;
  let stuckTime = 0;
  let lastCheck = Date.now();

  return {
    name: "unstuck",
    description: "Get unstuck when stuck in the same position for too long.",
    priority: 90,
    enabled: true,
    permissions: ["move"],
    interruptsAll: true,
    interruptsSkills: [],
    update: (ctx) => {
      if (ctx.isIdle) {
        prevPosition = null;
        stuckTime = 0;
        return;
      }

      const bot = ctx.bot;
      const pos = bot.entity.position;
      const now = Date.now();

      if (prevPosition) {
        const dx = pos.x - prevPosition.x;
        const dy = pos.y - prevPosition.y;
        const dz = pos.z - prevPosition.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < 0.5) {
          stuckTime += (now - lastCheck) / 1000;
        } else {
          stuckTime = 0;
          prevPosition = { x: pos.x, y: pos.y, z: pos.z };
        }
      } else {
        prevPosition = { x: pos.x, y: pos.y, z: pos.z };
      }

      lastCheck = now;

      if (stuckTime > 20) {
        ctx.log("Stuck for 20s — trying to get unstuck!");
        stuckTime = 0;
        prevPosition = null;
        ctx.interruptCurrentAction();
      }
    },
    onUnpause: () => {
      prevPosition = null;
      stuckTime = 0;
      lastCheck = Date.now();
    },
  };
}

// ─── Entity classification helper ───────────────────────────────────────────

function isHostile(entity: { type?: string; name?: string }): boolean {
  if (entity.type === "hostile") return true;
  if (entity.type === "mob" && entity.name !== "iron_golem" && entity.name !== "snow_golem") {
    return true;
  }
  return false;
}
