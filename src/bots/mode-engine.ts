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
  let lastActionTime = 0;
  const COOLDOWN_MS = 3000;

  return {
    name: "self_preservation",
    description: "Respond to drowning, burning, and damage at low health. Interrupts all actions.",
    priority: 100,
    enabled: true,
    permissions: ["move"],
    interruptsAll: true,
    interruptsSkills: [],
    update: (ctx) => {
      const now = Date.now();
      if (now - lastActionTime < COOLDOWN_MS) return;

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
  let lastAttackTime = 0;

  // Weapon damage values (higher = better)
  const WEAPON_DAMAGE: Record<string, number> = {
    netherite_sword: 4, diamond_sword: 3, iron_sword: 3,
    stone_sword: 2, wooden_sword: 1, gold_sword: 1,
    netherite_axe: 3, diamond_axe: 3, iron_axe: 2,
    stone_axe: 2, wooden_axe: 1, gold_axe: 1,
  };

  function equipBestWeapon(bot: Bot): void {
    const current = bot.heldItem?.name ?? "";
    if (WEAPON_DAMAGE[current]) return; // already holding a weapon

    // Find best weapon in inventory (fallback: slots for creative mode)
    let items = bot.inventory.items();
    if (items.length === 0) {
      items = bot.inventory.slots.filter((s): s is NonNullable<typeof bot.inventory.slots[number]> => s !== null);
    }
    let bestItem: any = null;
    let bestDamage = 0;
    for (const item of items) {
      const dmg = WEAPON_DAMAGE[item.name] ?? 0;
      if (dmg > bestDamage) {
        bestDamage = dmg;
        bestItem = item;
      }
    }
    if (bestItem) {
      bot.equip(bestItem, "hand").catch(() => {});
    }
  }

  return {
    name: "self_defense",
    description: "Attack nearby hostile mobs. Interrupts some actions.",
    priority: 80,
    enabled: true,
    permissions: ["attack", "move"],
    interruptsAll: true,
    interruptsSkills: [],
    update: (ctx) => {
      const now = Date.now();
      const bot = ctx.bot;
      const pos = bot.entity.position;

      // If health drops below 4 during combat, flee instead of fighting
      if (bot.health < 4) {
        ctx.log("Health critical during combat — fleeing!");
        ctx.requestAction("move.away", { x: pos.x, y: pos.y, z: pos.z, distance: 10 });
        return;
      }

      // Find nearest alive hostile mob within 5 blocks
      let nearestHostile: any = null;
      let nearestDist = Infinity;

      for (const entity of Object.values(bot.entities)) {
        if (!entity?.position || !entity.name) continue;
        if (entity === bot.entity) continue;
        const dist = pos.distanceTo(entity.position);
        if (dist > 5 || dist >= nearestDist) continue;
        if (!isHostile(entity)) continue;
        // Check if entity is alive (health > 0 or no health data)
        const health = (entity as any).health;
        if (health !== undefined && health <= 0) continue;
        nearestHostile = entity;
        nearestDist = dist;
      }

      if (nearestHostile) {
        ctx.log(`Hostile ${nearestHostile.name} nearby — attacking!`);
        ctx.interruptCurrentAction();

        // Equip best weapon before attacking
        equipBestWeapon(bot);

        // Attack with cooldown (0.6s between hits)
        if (now - lastAttackTime > 600) {
          try {
            bot.attack(nearestHostile);
            lastAttackTime = now;
            // Check if entity was defeated
            if (!bot.entities[nearestHostile.id]) {
              defeatedCount++;
              ctx.log(`Defeated hostile #${defeatedCount}: ${nearestHostile.name}`);
            }
          } catch {
            // Entity may have despawned mid-attack
          }
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
  let lastEscalation = 0;
  let prevHealth = 20;

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

      if (ctx.isIdle) {
        // Idle: only react to health drops (suffocation, drowning, etc.)
        const healthDiff = prevHealth - bot.health;
        prevHealth = bot.health;

        if (healthDiff > 0 && bot.health < 15) {
          ctx.log(`Taking damage while idle (health: ${bot.health}) — escaping!`);
          // Try jump + random direction + dig
          bot.setControlState("jump", true);
          setTimeout(() => bot.setControlState("jump", false), 500);
          const dir = Math.random() > 0.5 ? "forward" : "back";
          bot.setControlState(dir, true);
          setTimeout(() => bot.setControlState(dir, false), 800);
          // Also try dig nearby
          const blockAtFeet = bot.blockAt(pos);
          if (blockAtFeet && blockAtFeet.name !== "air" && blockAtFeet.name !== "bedrock") {
            void bot.dig(blockAtFeet).catch(() => {});
          }
        }

        prevPosition = null;
        stuckTime = 0;
        lastEscalation = 0;
        lastCheck = now;
        return;
      }

      // Job running: position-based stuck detection
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

      const threshold = 5;

      if (stuckTime > threshold && lastEscalation < 1) {
        ctx.log(`Stuck for ${threshold}s — jumping!`);
        bot.setControlState("jump", true);
        setTimeout(() => bot.setControlState("jump", false), 500);
        lastEscalation = 1;
      } else if (!ctx.isIdle && stuckTime > 10 && lastEscalation < 2) {

} else if (!ctx.isIdle && stuckTime > 10 && lastEscalation < 2) {
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
        setTimeout(() => {
          bot.setControlState(pick[0], false);
          bot.setControlState(pick[1], false);
        }, 1000);
        lastEscalation = 2;
      } else if (stuckTime > 15 && lastEscalation < 3) {
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
          void bot.dig(targetBlock).catch(() => {});
        }
        lastEscalation = 3;
      } else if (stuckTime > 20) {
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
      prevHealth = 20;
    },
  };
}

function isHostile(entity: { type?: string; name?: string }): boolean {
  if (entity.type === "hostile") return true;
  if (entity.type === "mob" && entity.name !== "iron_golem" && entity.name !== "snow_golem") {
    return true;
  }
  return false;
}

// ─── Idle Staring Mode ─────────────────────────────────────────────────────

export function createIdleStaringMode(): ModeDefinition {
  let lastLookTime = 0;

  return {
    name: "idle_staring",
    description: "Look at nearby entities when idle.",
    priority: 10,
    enabled: true,
    permissions: [],
    interruptsAll: false,
    interruptsSkills: [],
    update: (ctx) => {
      if (!ctx.isIdle) return;

      const now = Date.now();
      if (now - lastLookTime < 5000 + Math.random() * 5000) return;

      const bot = ctx.bot;
      const pos = bot.entity.position;

      const entity = Object.values(bot.entities).find((e) => {
        if (!e?.position || !e.name) return false;
        return pos.distanceTo(e.position) < 10 && e.name !== bot.username;
      });

      if (entity) {
        const target = entity.position.offset(0, (entity as any).height ?? 1.6, 0);
        bot.lookAt(target).catch(() => {});
        lastLookTime = now;
      }
    },
  };
}

// ─── Elbow Room Mode ───────────────────────────────────────────────────────

export function createElbowRoomMode(): ModeDefinition {
  let lastStepTime = 0;

  return {
    name: "elbow_room",
    description: "Step back when a player is too close.",
    priority: 5,
    enabled: true,
    permissions: [],
    interruptsAll: false,
    interruptsSkills: [],
    update: (ctx) => {
      if (!ctx.isIdle) return;

      const now = Date.now();
      if (now - lastStepTime < 3000) return;

      const bot = ctx.bot;
      const pos = bot.entity.position;

      const player = Object.values(bot.entities).find((e) => {
        if (!e?.position || e.type !== "player") return false;
        return pos.distanceTo(e.position) < 1.5;
      });

      if (player) {
        // Look at the player first
        const target = player.position.offset(0, (player as any).height ?? 1.6, 0);
        bot.lookAt(target).catch(() => {});
        // Then step back
        bot.setControlState("back", true);
        setTimeout(() => bot.setControlState("back", false), 500);
        lastStepTime = now;
      }
    },
  };
}
