import { z } from "zod";
import {
  CompatibilityConfigSchema,
  ISODateTimeSchema,
  MemoryConfigSchema,
  ReconnectPolicySchema,
  Vec3Schema,
} from "./config.js";

// ─── Bot Status Enum ────────────────────────────────────────────────────────

export const BotStatusSchema = z.enum([
  "creating",
  "connecting",
  "spawning",
  "running",
  "disconnected",
  "reconnecting",
  "stopping",
  "destroyed",
  "failed",
]);
export type BotStatus = z.infer<typeof BotStatusSchema>;

// ─── Skill Permissions ──────────────────────────────────────────────────────

export const SkillPermissionSchema = z.enum([
  "movement",
  "inventory",
  "block.place",
  "block.break",
  "combat",
  "chat",
  "container",
  "entity.interact",
]);
export type SkillPermission = z.infer<typeof SkillPermissionSchema>;

// ─── Per-Bot Skill Config ───────────────────────────────────────────────────

export const BotSkillConfigSchema = z
  .object({
    disabled: z.array(z.string()).optional(),
    permissions: z
      .record(SkillPermissionSchema, z.boolean())
      .optional(),
    defaultTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type BotSkillConfig = z.infer<typeof BotSkillConfigSchema>;

// ─── Minecraft Connection Config ────────────────────────────────────────────

export const MinecraftConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(25565),
    version: z.union([z.literal("auto"), z.string().min(1)]).default("auto"),
    auth: z.enum(["offline", "microsoft"]).default("offline"),
    username: z.string().min(1),
    passwordEnv: z.string().optional(),
    checkTimeoutIntervalMs: z.number().int().positive().optional(),
  })
  .strict();
export type MinecraftConfig = z.infer<typeof MinecraftConfigSchema>;

// ─── Bot Config ─────────────────────────────────────────────────────────────

export const BotConfigSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
    name: z.string().min(1),
    minecraft: MinecraftConfigSchema,
    reconnect: ReconnectPolicySchema.optional(),
    memory: MemoryConfigSchema.optional(),
    modes: z.record(z.string(), z.boolean()).optional(),
    skills: BotSkillConfigSchema.optional(),
    compatibility: CompatibilityConfigSchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BotConfig = z.infer<typeof BotConfigSchema>;

// ─── Service Error Object ───────────────────────────────────────────────────

export const ServiceErrorObjectSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    retryable: z.boolean().optional(),
    source: z.string().optional(),
  })
  .strict();
export type ServiceErrorObject = z.infer<typeof ServiceErrorObjectSchema>;

// ─── Inventory Item ─────────────────────────────────────────────────────────

export const InventoryItemSchema = z
  .object({
    slot: z.number().int().nonnegative(),
    name: z.string(),
    displayName: z.string(),
    type: z.number().int(),
    count: z.number().int().nonnegative(),
    metadata: z.number().int().optional(),
    nbt: z.union([z.record(z.unknown()), z.null()]).optional(),
    durabilityUsed: z.number().int().nonnegative().optional(),
    maxDurability: z.number().int().nonnegative().optional(),
  })
  .strict();
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

// ─── Inventory Snapshot ─────────────────────────────────────────────────────

export const InventorySnapshotSchema = z
  .object({
    botId: z.string(),
    selectedSlot: z.number().int().nonnegative(),
    slots: z.array(InventoryItemSchema),
    equipment: z
      .object({
        hand: InventoryItemSchema.optional(),
        offHand: InventoryItemSchema.optional(),
        head: InventoryItemSchema.optional(),
        torso: InventoryItemSchema.optional(),
        legs: InventoryItemSchema.optional(),
        feet: InventoryItemSchema.optional(),
      })
      .strict(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    emptySlotCount: z.number().int().nonnegative(),
    updatedAt: ISODateTimeSchema,
  })
  .strict();
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>;

// ─── Entity Summary ─────────────────────────────────────────────────────────

export const EntitySummarySchema = z
  .object({
    id: z.union([z.number().int(), z.string()]),
    uuid: z.string().optional(),
    type: z.string(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    kind: z.enum(["player", "mob", "animal", "object", "orb", "item", "unknown"]),
    position: Vec3Schema,
    velocity: Vec3Schema.optional(),
    distance: z.number().nonnegative(),
    health: z.number().optional(),
    username: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export type EntitySummary = z.infer<typeof EntitySummarySchema>;

// ─── Block Summary ──────────────────────────────────────────────────────────

export const BlockSummarySchema = z
  .object({
    name: z.string(),
    displayName: z.string(),
    type: z.number().int(),
    position: Vec3Schema,
    distance: z.number().nonnegative(),
    hardness: z.number().optional(),
    harvestable: z.boolean().optional(),
    boundingBox: z.string().optional(),
  })
  .strict();
export type BlockSummary = z.infer<typeof BlockSummarySchema>;

// ─── Nearby Snapshot ────────────────────────────────────────────────────────

export const NearbySnapshotSchema = z
  .object({
    botId: z.string(),
    radius: z.number().min(1),
    players: z.array(EntitySummarySchema),
    entities: z.array(EntitySummarySchema),
    blocks: z.array(BlockSummarySchema),
    updatedAt: ISODateTimeSchema,
  })
  .strict();
export type NearbySnapshot = z.infer<typeof NearbySnapshotSchema>;

// ─── Mode Status ────────────────────────────────────────────────────────────

export const ModeStatusSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean(),
    paused: z.boolean(),
    active: z.boolean(),
    priority: z.number().int(),
    permissions: z.array(z.string()),
    lastTriggeredAt: ISODateTimeSchema.optional(),
    lastError: ServiceErrorObjectSchema.optional(),
  })
  .strict();
export type ModeStatus = z.infer<typeof ModeStatusSchema>;

// ─── Experience ─────────────────────────────────────────────────────────────

export const ExperienceSchema = z
  .object({
    level: z.number().int().nonnegative(),
    points: z.number().int().nonnegative(),
    progress: z.number().nonnegative(),
  })
  .strict();
export type Experience = z.infer<typeof ExperienceSchema>;

// ─── Time Info ──────────────────────────────────────────────────────────────

export const TimeInfoSchema = z
  .object({
    timeOfDay: z.number().int(),
    day: z.number().int(),
    isDay: z.boolean(),
  })
  .strict();
export type TimeInfo = z.infer<typeof TimeInfoSchema>;

// ─── Weather Info ───────────────────────────────────────────────────────────

export const WeatherInfoSchema = z
  .object({
    isRaining: z.boolean(),
    rainState: z.number(),
    thunderState: z.number(),
  })
  .strict();
export type WeatherInfo = z.infer<typeof WeatherInfoSchema>;

// ─── Chat Message ───────────────────────────────────────────────────────────

export const ChatMessageSchema = z
  .object({
    botId: z.string(),
    direction: z.enum(["received", "sent"]),
    sender: z.string().optional(),
    message: z.string(),
    raw: z.unknown().optional(),
    ts: ISODateTimeSchema,
  })
  .strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ─── Bot State ──────────────────────────────────────────────────────────────

export const BotStateSchema = z
  .object({
    botId: z.string(),
    status: BotStatusSchema,
    username: z.string().optional(),
    uuid: z.string().optional(),
    gameMode: z.string().optional(),
    dimension: z.string().optional(),
    biome: z.string().optional(),
    time: TimeInfoSchema.optional(),
    weather: WeatherInfoSchema.optional(),
    position: Vec3Schema,
    velocity: Vec3Schema,
    rotation: z.object({ yaw: z.number(), pitch: z.number() }).strict(),
    health: z.number().nonnegative(),
    food: z.number().nonnegative(),
    oxygen: z.number().nonnegative().optional(),
    experience: ExperienceSchema.optional(),
    inventory: InventorySnapshotSchema.optional(),
    nearby: NearbySnapshotSchema.optional(),
    modes: z.array(ModeStatusSchema),
    busy: z.boolean(),
    currentJobId: z.string().optional(),
    currentAction: z.string().optional(),
    lastChat: z.array(ChatMessageSchema).optional(),
    lastErrors: z.array(ServiceErrorObjectSchema).optional(),
    updatedAt: ISODateTimeSchema,
  })
  .strict();
export type BotState = z.infer<typeof BotStateSchema>;

// ─── Bot Summary ────────────────────────────────────────────────────────────

export const BotSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: BotStatusSchema,
    username: z.string().optional(),
    uuid: z.string().optional(),
    host: z.string(),
    port: z.number().int(),
    version: z.string().optional(),
    auth: z.enum(["offline", "microsoft"]).optional(),
    currentJobId: z.string().optional(),
    busy: z.boolean(),
    metadata: z.record(z.string(), z.string()).optional(),
    createdAt: ISODateTimeSchema,
    updatedAt: ISODateTimeSchema,
    connectedAt: ISODateTimeSchema.optional(),
    lastDisconnectedAt: ISODateTimeSchema.optional(),
    lastError: ServiceErrorObjectSchema.optional(),
  })
  .strict();
export type BotSummary = z.infer<typeof BotSummarySchema>;

// ─── Bot Detail ─────────────────────────────────────────────────────────────

export const BotReconnectDetailSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: ISODateTimeSchema.optional(),
    lastStableAt: ISODateTimeSchema.optional(),
  })
  .strict();

export const BotDetailSchema = BotSummarySchema.extend({
  config: BotConfigSchema,
  reconnect: BotReconnectDetailSchema.optional(),
}).strict();
export type BotDetail = z.infer<typeof BotDetailSchema>;
