import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import type { IndexedData } from "minecraft-data";
import type {
  BotState,
  BotStatus,
  InventoryItem,
  InventorySnapshot,
  EntitySummary,
  ModeStatus,
  Experience,
  ChatMessage,
  ServiceErrorObject,
  BlockSummary,
  NearbySnapshot,
} from "../types/bot.js";
import type { Vec3 } from "../types/config.js";

// ─── State diff for WebSocket updates ───────────────────────────────────────

export interface StateDiff {
  sequence: number;
  changed: Partial<Record<keyof BotState, unknown>>;
  updatedAt: string;
}

// ─── StateTracker ───────────────────────────────────────────────────────────

export class StateTracker extends EventEmitter {
  private state: BotState;
  private sequence = 0;
  private bot: Bot | null = null;
  private mcData: IndexedData | null = null;
  private lastChat: ChatMessage[] = [];
  private lastErrors: ServiceErrorObject[] = [];
  private readonly MAX_CHAT_HISTORY = 20;
  private readonly MAX_ERROR_HISTORY = 10;

  constructor(botId: string) {
    super();
    this.state = this.createDefaultState(botId);
  }

  // ── Bind to live Mineflayer bot ──────────────────────────────────────────

  bind(bot: Bot, mcData: IndexedData): void {
    this.bot = bot;
    this.mcData = mcData;
    this.bindEvents();
  }

  // ── Get full snapshot ────────────────────────────────────────────────────

  getState(): BotState {
    if (this.bot) {
      this.refreshFromBot();
    }
    return { ...this.state, updatedAt: new Date().toISOString() };
  }

  // ── Get diff since last call ─────────────────────────────────────────────

  getDiff(): StateDiff | null {
    this.sequence++;
    const changed = this.computeChanged();
    if (Object.keys(changed).length === 0) return null;

    const updatedAt = new Date().toISOString();
    return { sequence: this.sequence, changed, updatedAt };
  }

  // ── Set status (called by BotRuntime) ────────────────────────────────────

  setStatus(status: BotStatus): void {
    this.state.status = status;
  }

  setCurrentJob(jobId: string | undefined): void {
    this.state.currentJobId = jobId;
    this.state.busy = jobId !== undefined;
  }

  setCurrentAction(action: string | undefined): void {
    this.state.currentAction = action;
  }

  setModes(modes: ModeStatus[]): void {
    this.state.modes = modes;
  }

  // ── Chat tracking ───────────────────────────────────────────────────────

  addChatMessage(msg: ChatMessage): void {
    this.lastChat.push(msg);
    if (this.lastChat.length > this.MAX_CHAT_HISTORY) {
      this.lastChat.shift();
    }
    this.state.lastChat = [...this.lastChat];
  }

  // ── Error tracking ──────────────────────────────────────────────────────

  addError(err: ServiceErrorObject): void {
    this.lastErrors.push(err);
    if (this.lastErrors.length > this.MAX_ERROR_HISTORY) {
      this.lastErrors.shift();
    }
    this.state.lastErrors = [...this.lastErrors];
  }

  // ── Update username/uuid after login ─────────────────────────────────────

  setIdentity(username: string, uuid?: string): void {
    this.state.username = username;
    this.state.uuid = uuid;
  }

  // ── Private: refresh state from live bot ─────────────────────────────────

  private refreshFromBot(): void {
    const bot = this.bot!;
    const s = this.state;

    // Position
    if (bot.entity?.position) {
      const pos = bot.entity.position;
      s.position = { x: pos.x, y: pos.y, z: pos.z };
    }

    // Velocity
    if (bot.entity?.velocity) {
      const vel = bot.entity.velocity;
      s.velocity = { x: vel.x, y: vel.y, z: vel.z };
    }

    // Rotation
    if (bot.entity) {
      s.rotation = {
        yaw: bot.entity.yaw ?? 0,
        pitch: bot.entity.pitch ?? 0,
      };
    }

    // Health / food
    s.health = bot.health ?? 0;
    s.food = bot.food ?? 0;

    // Oxygen
    if (bot.oxygenLevel !== undefined) {
      s.oxygen = bot.oxygenLevel;
    }

    // Experience
    s.experience = {
      level: bot.experience?.level ?? 0,
      points: bot.experience?.points ?? 0,
      progress: bot.experience?.progress ?? 0,
    };

    // Game mode / dimension / biome
    s.gameMode = bot.game?.gameMode;
    s.dimension = bot.game?.dimension;

    try {
      const block = bot.blockAt(bot.entity.position);
      if (block && this.mcData) {
        const biome = this.mcData.biomes?.[block.biome as unknown as number];
        if (biome) {
          s.biome = biome.name;
        }
      }
    } catch {
      // blocks may not be loaded yet
    }

    // Time
    if (bot.time) {
      s.time = {
        timeOfDay: bot.time.timeOfDay ?? 0,
        day: bot.time.day ?? 0,
        isDay: (bot.time.timeOfDay ?? 0) < 13000,
      };
    }

    // Weather
    if (bot.isRaining !== undefined) {
      s.weather = {
        isRaining: bot.isRaining,
        rainState: bot.thunderState ?? 0,
        thunderState: bot.thunderState ?? 0,
      };
    }

    // Username / uuid
    s.username = bot.username ?? s.username;
    if (bot.player?.uuid) {
      s.uuid = bot.player.uuid;
    }

    // Inventory
    s.inventory = this.buildInventorySnapshot();

    // Nearby entities
    s.nearby = this.buildNearbySnapshot();

    s.updatedAt = new Date().toISOString();
  }

  // ── Inventory snapshot ──────────────────────────────────────────────────

  private buildInventorySnapshot(): InventorySnapshot | undefined {
    const bot = this.bot;
    if (!bot?.inventory) return undefined;

    const slots: InventoryItem[] = [];
    const counts: Record<string, number> = {};

    for (const item of bot.inventory.items()) {
      slots.push({
        slot: item.slot,
        name: item.name,
        displayName: item.displayName ?? item.name,
        type: item.type,
        count: item.count,
      });
      counts[item.name] = (counts[item.name] ?? 0) + item.count;
    }

    const equipment: InventorySnapshot["equipment"] = {};

    // Equipment slots
    const handItem = bot.heldItem;
    if (handItem) {
      equipment.hand = {
        slot: handItem.slot,
        name: handItem.name,
        displayName: handItem.displayName ?? handItem.name,
        type: handItem.type,
        count: handItem.count,
      };
    }

    return {
      botId: this.state.botId,
      selectedSlot: bot.quickBarSlot ?? 0,
      slots,
      equipment,
      counts,
      emptySlotCount: bot.inventory.emptySlotCount?.() ?? (36 - slots.length),
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Nearby snapshot ─────────────────────────────────────────────────────

  private buildNearbySnapshot(): NearbySnapshot | undefined {
    const bot = this.bot;
    if (!bot?.entity?.position) return undefined;

    const botPos = bot.entity.position;
    const players: EntitySummary[] = [];
    const entities: EntitySummary[] = [];

    for (const entity of Object.values(bot.entities)) {
      if (!entity?.position) continue;
      const dist = botPos.distanceTo(entity.position);
      if (dist > 48) continue;

      const summary: EntitySummary = {
        id: entity.id,
        type: entity.type ?? "unknown",
        name: entity.name,
        kind: classifyEntity(entity),
        position: {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z,
        },
        distance: Math.round(dist * 100) / 100,
        health: (entity as unknown as { health?: number }).health,
        username: (entity as unknown as { username?: string }).username,
      };

      if (summary.kind === "player") {
        players.push(summary);
      } else {
        entities.push(summary);
      }
    }

    return {
      botId: this.state.botId,
      radius: 48,
      players,
      entities,
      blocks: [], // blocks are queried on-demand via observation skills
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Mineflayer event binding ─────────────────────────────────────────────

  private bindEvents(): void {
    const bot = this.bot!;

    bot.on("spawn", () => {
      this.state.status = "running";
      this.emit("stateUpdate", this.getState());
    });

    bot.on("health", () => {
      this.emit("stateUpdate", this.getState());
    });

    bot.on("move", () => {
      this.emit("stateUpdate", this.getState());
    });

    bot.on("playerCollect", () => {
      this.emit("stateUpdate", this.getState());
    });

    bot.on("entityGone", () => {
      this.emit("stateUpdate", this.getState());
    });

    bot.on("entitySpawn", () => {
      this.emit("stateUpdate", this.getState());
    });

    bot.on("rain", () => {
      this.emit("stateUpdate", this.getState());
    });

    bot.on("time", () => {
      // Time updates are very frequent — don't emit state on every tick
      // State is refreshed on-demand via getState()
    });

    bot.on("game", () => {
      this.state.gameMode = bot.game?.gameMode;
      this.state.dimension = bot.game?.dimension;
      this.emit("stateUpdate", this.getState());
    });
  }

  // ── Compute changed fields since last snapshot ──────────────────────────

  private lastSnapshot: BotState | null = null;

  private computeChanged(): Partial<Record<keyof BotState, unknown>> {
    const current = this.getState();
    const changed: Partial<Record<keyof BotState, unknown>> = {};

    if (!this.lastSnapshot) {
      this.lastSnapshot = current;
      return current as unknown as Partial<Record<keyof BotState, unknown>>;
    }

    const keys = Object.keys(current) as (keyof BotState)[];
    for (const key of keys) {
      if (!deepEqual(current[key], this.lastSnapshot[key])) {
        changed[key] = current[key];
      }
    }

    this.lastSnapshot = current;
    return changed;
  }

  // ── Default state ───────────────────────────────────────────────────────

  private createDefaultState(botId: string): BotState {
    const now = new Date().toISOString();
    return {
      botId,
      status: "creating",
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0, pitch: 0 },
      health: 0,
      food: 0,
      modes: [],
      busy: false,
      updatedAt: now,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function classifyEntity(
  entity: unknown,
): EntitySummary["kind"] {
  const e = entity as { type?: string; name?: string; player?: unknown };
  if (e.type === "player") return "player";
  if (e.type === "mob" || e.type === "hostile") return "mob";
  if (e.name === "item") return "item";
  if (e.name === "experience_orb") return "orb";
  if (e.type === "object") return "object";
  return "unknown";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
