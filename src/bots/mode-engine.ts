import type { Bot } from "mineflayer";
import type { IndexedData } from "minecraft-data";
import type { ModeStatus } from "../types/bot.js";
import type { Entity } from "prismarine-entity";

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
  requestAction: (skillName: string, params?: Record<string, unknown>) => void;
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
  private onRequestAction: ((skillName: string, params?: Record<string, unknown>) => void) | null = null;
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
    onRequestAction: (skillName: string, params?: Record<string, unknown>) => void;
    isIdle: () => boolean;
    currentSkill: () => string | null;
    onTriggered: (mode: string, reason: string) => void;
    log: (message: string) => void;
  }): void {
    this.bot = opts.bot;
    this.mcData = opts.mcData;
    this.onInterruptRequest = opts.onInterrupt;
    this.onRequestAction = opts.onRequestAction;
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

  /** Toggle mode enabled/paused state. Returns true if mode was found. */
  toggleMode(name: string, enabled?: boolean, paused?: boolean): boolean {
    const runtime = this.modes.get(name);
    if (!runtime) return false;
    if (enabled !== undefined) runtime.enabled = enabled;
    if (paused !== undefined) runtime.paused = paused;
    return true;
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
        requestAction: (skillName, params) => {
          this.requestInterrupt(name, def.description);
          this.onRequestAction?.(skillName, params);
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
 * Priority 100 — highest priority, overrides everything.
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

      // In water/drowning — swim up
      if (block.name === "water" || blockAbove.name === "water") {
        bot.setControlState("jump", true);
        ctx.log("Swimming up to avoid drowning");
        return;
      }

      // In lava/fire — flee immediately via move.away skill
      if (
        block.name === "lava" ||
        block.name === "fire" ||
        blockAbove.name === "lava" ||
        blockAbove.name === "fire"
      ) {
        ctx.log("On fire/lava — fleeing!");
        ctx.requestAction("move.away", { x: pos.x, y: pos.y, z: pos.z, distance: 10 });
        ctx.log("Fled to safety");
        return;
      }

      // Low health (< 6) and recently damaged — flee
      const lastDamage = (bot as unknown as { lastDamageTime?: number }).lastDamageTime ?? 0;
      if (Date.now() - lastDamage < 3000 && bot.health < 6) {
        ctx.log("Low health under attack — fleeing!");
        ctx.requestAction("move.away", { x: pos.x, y: pos.y, z: pos.z, distance: 10 });
        ctx.log("Fled to safety");
      }
    },
  };
}

/**
 * Self-defense: auto-attack hostile mobs nearby.
 * Priority 80 — can interrupt skills but defers to self_preservation.
 */
export function createSelfDefenseMode(): ModeDefinition {
  let defeatedCount = 0;

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

      // If health drops below 4 during combat, flee instead of fighting
      if (bot.health < 4) {
        ctx.log("Health critical during combat — fleeing!");
        ctx.requestAction("move.away", { x: pos.x, y: pos.y, z: pos.z, distance: 10 });
        return;
      }

      // Find nearest hostile mob within 5 blocks
      let nearestHostile: Entity | null = null;
      let nearestDist = Infinity;

      for (const entity of Object.values(bot.entities)) {
        if (!entity?.position || !entity.name) continue;
        if (entity === bot.entity) continue;
        const dist = pos.distanceTo(entity.position);
        if (dist > 5 || dist >= nearestDist) continue;
        if (!isHostile(entity)) continue;
        nearestHostile = entity;
        nearestDist = dist;
      }

      if (nearestHostile) {
        ctx.log(`Hostile ${nearestHostile.name} nearby — attacking!`);
        ctx.interruptCurrentAction();
        try {
          bot.attack(nearestHostile);
          // Check if entity was defeated (no longer in world)
          if (!bot.entities[nearestHostile.id]) {
            defeatedCount++;
            ctx.log(`Defeated hostile #${defeatedCount}: ${nearestHostile.name}`);
          }
        } catch {
          // Entity may have despawned mid-attack
        }
      }
    },
    onUnpause: () => {
      // defeatedCount persists across pauses
    },
  };
}

/**
 * Unstuck: detect when bot hasn't moved and try to free it.
 * Priority 90 — escalates through jump, random movement, block breaking, then interrupt.
 */
export function createUnstuckMode(): ModeDefinition {
  let prevPosition: { x: number; y: number; z: number } | null = null;
  let stuckTime = 0;
  let lastCheck = Date.now();
  let lastEscalation = 0; // 0=none, 1=jump, 2=random move, 3=dig, 4=interrupt

  return {
    name: "unstuck",
    description: "Get unstuck when stuck in the same position for too long.",
    priority: 90,
    enabled: true,
    permissions: ["move"],
    interruptsAll: true,
    interruptsSkills: [],
    update: (ctx) => {
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
          lastEscalation = 0;
        }
      } else {
        prevPosition = { x: pos.x, y: pos.y, z: pos.z };
      }

      lastCheck = now;

      // Progressive escalation based on stuck duration
      if (stuckTime > 5 && lastEscalation < 1) {
        // Level 1: try jumping
        ctx.log("Stuck for 5s — jumping!");
        bot.setControlState("jump", true);
        lastEscalation = 1;
      } else if (stuckTime > 10 && lastEscalation < 2) {
        // Level 2: pick a random direction and move
        ctx.log("Stuck for 10s — trying random movement!");
        const directions = [
          ["forward", "left"],
          ["forward", "right"],
          ["back", "left"],
          ["back", "right"],
        ] as const;
        const pick = directions[Math.floor(Math.random() * directions.length)]!;
        bot.setControlState(pick[0], true);
        bot.setControlState(pick[1], true);
        lastEscalation = 2;
      } else if (stuckTime > 15 && lastEscalation < 3) {
        // Level 3: try to break block at bot's position
        ctx.log("Stuck for 15s — trying to break block!");
        const blockAtFeet = bot.blockAt(pos);
        const blockAbove = bot.blockAt(pos.offset(0, 1, 0));
        const targetBlock =
          blockAtFeet && blockAtFeet.name !== "air" && blockAtFeet.name !== "bedrock"
            ? blockAtFeet
            : blockAbove && blockAbove.name !== "air" && blockAbove.name !== "bedrock"
              ? blockAbove
              : null;
        if (targetBlock) {
          void bot.dig(targetBlock).catch(() => {
            /* ignore dig errors */
          });
        }
        lastEscalation = 3;
      } else if (stuckTime > 20) {
        // Level 4: give up and interrupt
        ctx.log("Cannot get unstuck");
        stuckTime = 0;
        prevPosition = null;
        lastEscalation = 0;
        ctx.interruptCurrentAction();
      }
    },
    onUnpause: () => {
      prevPosition = null;
      stuckTime = 0;
      lastCheck = Date.now();
      lastEscalation = 0;
    },
  };
}

/**
 * Idle staring: when no job is active, periodically look at nearest entity.
 * Priority 10 — low priority, cosmetic behavior.
 */
export function createIdleStaringMode(): ModeDefinition {
  let lastLookTime = 0;
  let nextCooldown = 5000; // randomized 5-10s

  return {
    name: "idle_staring",
    description: "Periodically look at nearest entity when idle.",
    priority: 10,
    enabled: true,
    permissions: [],
    interruptsAll: false,
    interruptsSkills: [],
    update: (ctx) => {
      if (!ctx.isIdle) return;

      const now = Date.now();
      if (now - lastLookTime < nextCooldown) return;

      const bot = ctx.bot;
      const pos = bot.entity.position;

      // Find nearest entity within 10 blocks (excluding self)
      let nearest: Entity | null = null;
      let nearestDist = Infinity;

      for (const entity of Object.values(bot.entities)) {
        if (!entity?.position || entity === bot.entity) continue;
        const dist = pos.distanceTo(entity.position);
        if (dist > 10 || dist >= nearestDist) continue;
        nearest = entity;
        nearestDist = dist;
      }

      if (nearest) {
        // Look at the entity's head level
        const lookTarget = nearest.position.offset(0, nearest.height, 0);
        void bot.lookAt(lookTarget);
        lastLookTime = now;
        // Randomize next cooldown between 5-10 seconds
        nextCooldown = 5000 + Math.floor(Math.random() * 5000);
      }
    },
    onUnpause: () => {
      lastLookTime = 0;
    },
  };
}

/**
 * Elbow room: when a player is too close and bot is idle, move away slightly.
 * Priority 5 — lowest priority, only runs when idle.
 */
export function createElbowRoomMode(): ModeDefinition {
  let lastMoveTime = 0;

  return {
    name: "elbow_room",
    description: "Move away when players are too close while idle.",
    priority: 5,
    enabled: true,
    permissions: ["move"],
    interruptsAll: false,
    interruptsSkills: [],
    update: (ctx) => {
      if (!ctx.isIdle) return;

      const now = Date.now();
      if (now - lastMoveTime < 3000) return; // Only trigger every 3 seconds

      const bot = ctx.bot;
      const pos = bot.entity.position;

      // Check if any player entity is within 1.5 blocks
      for (const entity of Object.values(bot.entities)) {
        if (!entity?.position || entity === bot.entity) continue;
        if (entity.type !== "player") continue;
        const dist = pos.distanceTo(entity.position);
        if (dist < 1.5) {
          ctx.log("Player too close — giving space");
          bot.setControlState("back", true);
          // Release after 500ms to take a small step back
          setTimeout(() => {
            bot.setControlState("back", false);
          }, 500);
          lastMoveTime = now;
          return;
        }
      }
    },
    onUnpause: () => {
      lastMoveTime = 0;
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
