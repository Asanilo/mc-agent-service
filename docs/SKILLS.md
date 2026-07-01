# mc-agent-service Skill System Specification

## 1. Skill System Overview

Skills are typed, schema-validated operations that map structured parameters to Mineflayer behavior. They are not text commands, do not parse natural language, and never execute client-supplied JavaScript.

Every skill definition has:

- `name`: stable identifier used by REST, jobs, MCP tools, events, and plugin manifests.
- `description`: short operator-facing description.
- `category`: built-in or plugin category.
- `parameters`: Zod parameter schema.
- `permissions`: declared runtime capabilities required before execution.
- `timeoutMs`: default job timeout.
- `busyPolicy`: default behavior when the bot is already running a primary action.
- `handler`: async function executed inside the bot worker.

Canonical TypeScript shape:

```ts
type SkillCategory =
  | "movement"
  | "mining"
  | "crafting"
  | "combat"
  | "inventory"
  | "observation"
  | "communication"
  | string;

type SkillPermission =
  | "movement"
  | "inventory"
  | "block.place"
  | "block.break"
  | "combat"
  | "chat"
  | "container"
  | "entity.interact";

interface SkillDefinition<TParams, TResult = unknown> {
  name: string;
  description: string;
  category: SkillCategory;
  parameters: z.ZodType<TParams>;
  permissions: SkillPermission[];
  timeoutMs: number;
  busyPolicy: "queue" | "reject-if-busy" | "cancel-current" | "emergency-stop";
  handler(ctx: SkillExecutionContext, params: TParams): Promise<SkillResult<TResult>>;
}
```

Skill names are dot-separated. Built-ins reserve the `move.*`, `mine.*`, `craft.*`, `combat.*`, `inventory.*`, `observe.*`, and `chat.*` namespaces.

## 2. Skill Manifest Format

Custom skill plugins are loaded from configured plugin directories. Each plugin provides a JSON manifest and a compiled JavaScript entrypoint. The manifest is declarative metadata only; executable behavior lives in the entrypoint.

```json
{
  "schemaVersion": 1,
  "name": "example-farming-skills",
  "version": "1.0.0",
  "description": "Farming skills for harvesting and replanting crops.",
  "main": "./dist/index.js",
  "author": "example",
  "mcAgentService": {
    "minVersion": "0.1.0"
  },
  "skills": [
    {
      "name": "farm.harvest_and_replant",
      "description": "Harvest mature crops in range and replant seeds.",
      "category": "farming",
      "permissions": ["movement", "block.break", "block.place", "inventory"],
      "timeoutMs": 300000,
      "busyPolicy": "queue",
      "parametersSchema": {
        "type": "object",
        "properties": {
          "crop": { "type": "string", "minLength": 1 },
          "radius": { "type": "integer", "minimum": 1, "maximum": 64 }
        },
        "required": ["crop", "radius"],
        "additionalProperties": false
      }
    }
  ]
}
```

Manifest rules:

- `schemaVersion` must be supported by the service.
- `name` must be unique among loaded plugins.
- `main` is resolved relative to the manifest file.
- `skills[].name` must be globally unique unless the service is explicitly configured to allow overrides.
- `parametersSchema` is JSON Schema and is converted to Zod, or validated by a JSON Schema adapter, before registration.
- Plugin entrypoints must export `registerSkills(registry, helpers)`.
- Plugin code receives service helper APIs and the per-invocation `SkillExecutionContext`; it must not depend on process-global Mineflayer state.

Recommended plugin structure:

```text
my-plugin/
  skill-manifest.json
  package.json
  tsconfig.json
  src/
    index.ts
  dist/
    index.js
```

## 3. Built-in Skills

Common reusable schemas:

```ts
const PositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
}).strict();

const BlockPositionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int()
}).strict();

const CountSchema = z.number().int().min(1);
const AllOrCountSchema = z.number().int().min(-1).refine((n) => n === -1 || n >= 1);
```

Return types use the common `SkillResult<T>` envelope in section 5. The `data` type listed below is the successful result payload.

### Movement

#### `move.to_position`

Navigate to a world position using Mineflayer pathfinder. Mirrors Mindcraft `goToPosition(bot, x, y, z, min_distance)`.

```ts
z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  minDistance: z.number().min(0).max(64).default(2)
}).strict()
```

Return data:

```ts
{ reached: boolean; position: { x: number; y: number; z: number }; distance: number }
```

Permissions: `movement`.

#### `move.to_block`

Find the nearest matching block and navigate near it. Mirrors Mindcraft `goToNearestBlock(bot, blockType, min_distance, range)`.

```ts
z.object({
  blockType: z.string().min(1),
  minDistance: z.number().min(0).max(64).default(2),
  range: z.number().int().min(1).max(512).default(64)
}).strict()
```

Return data:

```ts
{ reached: boolean; block?: { name: string; position: BlockPosition }; distance?: number }
```

Permissions: `movement`.

#### `move.to_player`

Navigate to a player by username. Mirrors Mindcraft `goToPlayer(bot, username, distance)`.

```ts
z.object({
  username: z.string().min(1),
  distance: z.number().min(0.5).max(64).default(3)
}).strict()
```

Return data:

```ts
{ reached: boolean; username: string; distance?: number }
```

Permissions: `movement`, `entity.interact`.

#### `move.follow_player`

Continuously follow a player until cancelled. Mirrors Mindcraft `followPlayer(bot, username, distance)`.

```ts
z.object({
  username: z.string().min(1),
  distance: z.number().min(0.5).max(64).default(4)
}).strict()
```

Return data:

```ts
{ following: boolean; username: string; cancelled: boolean }
```

Permissions: `movement`, `entity.interact`.

#### `move.stay`

Stay in the current position, pausing conflicting background modes. Mirrors Mindcraft `stay(bot, seconds)`.

```ts
z.object({
  seconds: z.number().int().min(-1).max(86400).default(30)
}).strict()
```

`seconds: -1` means stay until cancelled.

Return data:

```ts
{ stayedSeconds: number; interrupted: boolean }
```

Permissions: `movement`.

#### `move.avoid_enemies`

Move away from nearby hostile mobs until no hostile entity remains within range. Mirrors Mindcraft `avoidEnemies(bot, distance)`.

```ts
z.object({
  distance: z.number().min(1).max(128).default(16)
}).strict()
```

Return data:

```ts
{ avoided: boolean; distance: number; enemiesRemaining: number }
```

Permissions: `movement`, `combat`.

#### `move.to_entity`

Navigate to an entity by type or ID. Added in Phase 2.

```ts
z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.number().int().nonnegative().optional(),
  minDistance: z.number().min(0.5).max(64).default(2)
}).strict().refine(data => data.entityType !== undefined || data.entityId !== undefined)
```

Return data: `{ arrived: boolean; distance: number }`.

Permissions: `movement`, `entity.interact`.

#### `move.away`

Move away from a target position (flee). Uses inverted pathfinder goal. Added in Phase 2.

```ts
z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  distance: z.number().min(1).max(128).default(16)
}).strict()
```

Return data: `{ fled: boolean; distance: number }`.

Permissions: `movement`.

### Mining

#### `mine.collect_blocks`

Collect one or more nearby blocks of a given type. Mirrors Mindcraft `collectBlock(bot, blockType, num, exclude)`.

```ts
z.object({
  blockType: z.string().min(1),
  num: CountSchema.default(1),
  exclude: z.array(BlockPositionSchema).default([])
}).strict()
```

Behavior notes:

- Resource aliases follow Mindcraft behavior: for example `coal` also searches `coal_ore`; ores also search `deepslate_*`; `dirt` also searches `grass_block`; `cobblestone` also searches `stone`.
- `water` and `lava` collect source blocks and require a bucket.
- The implementation must check tool harvestability, safety, liquids, falling block risk, and inventory capacity.

Return data:

```ts
{ collected: number; blockType: string; requested: number }
```

Permissions: `movement`, `block.break`, `inventory`.

#### `mine.break_block_at`

Break the block at the supplied position. Mirrors Mindcraft `breakBlockAt(bot, x, y, z)`.

```ts
z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int()
}).strict()
```

Return data:

```ts
{ broken: boolean; block?: string; position: BlockPosition }
```

Permissions: `movement`, `block.break`, `inventory`.

#### `mine.dig_down`

Dig downward from the bot's current position for a bounded number of blocks. Mirrors Mindcraft `digDown(bot, distance)`.

```ts
z.object({
  distance: z.number().int().min(1).max(64).default(10)
}).strict()
```

The skill must stop before lava, water, world bottom, or unsafe drops.

Return data:

```ts
{ dug: number; requested: number; stoppedReason?: string }
```

Permissions: `movement`, `block.break`, `inventory`.

#### `mine.go_to_surface`

Navigate to the highest non-air block above the bot's current x/z column. Mirrors Mindcraft `goToSurface(bot)`.

```ts
z.object({}).strict()
```

Return data:

```ts
{ reached: boolean; targetY?: number; position?: Position }
```

Permissions: `movement`.

### Crafting

#### `craft.item`

Craft an item from the bot inventory, using or temporarily placing a crafting table when required and allowed. Mirrors Mindcraft `craftRecipe(bot, itemName, num)`.

```ts
z.object({
  itemName: z.string().min(1),
  num: CountSchema.default(1)
}).strict()
```

Return data:

```ts
{ crafted: number; itemName: string; requested: number }
```

Permissions: `movement`, `inventory`, `block.place`, `block.break`.

#### `craft.smelt_item`

Smelt an item in a nearby or temporary furnace, using available fuel. Mirrors Mindcraft `smeltItem(bot, itemName, num)`.

```ts
z.object({
  itemName: z.string().min(1),
  num: CountSchema.default(1)
}).strict()
```

Return data:

```ts
{ smelted: number; itemName: string; outputItemName?: string; requested: number }
```

Permissions: `movement`, `inventory`, `container`, `block.place`, `block.break`.

### Combat

#### `combat.attack_nearest`

Attack the nearest mob of the requested type. Mirrors Mindcraft `attackNearest(bot, mobType, kill)`.

```ts
z.object({
  mobType: z.string().min(1),
  kill: z.boolean().default(true)
}).strict()
```

Return data:

```ts
{ attacked: boolean; killed?: boolean; entity?: EntitySummary }
```

Permissions: `movement`, `combat`, `inventory`.

#### `combat.attack_entity`

Attack a specific observed entity by runtime entity ID. Mindcraft accepts an `Entity`; mc-agent-service accepts a serializable identifier and resolves it inside the worker.

```ts
z.object({
  entityId: z.number().int().nonnegative(),
  kill: z.boolean().default(true)
}).strict()
```

Return data:

```ts
{ attacked: boolean; killed?: boolean; entity?: EntitySummary }
```

Permissions: `movement`, `combat`, `inventory`, `entity.interact`.

#### `combat.defend_self`

Attack nearby hostile mobs until the area is clear or the job is cancelled. Mirrors Mindcraft `defendSelf(bot, range)`.

```ts
z.object({
  range: z.number().min(1).max(64).default(9)
}).strict()
```

Return data:

```ts
{ defended: boolean; enemiesDefeated: number; enemiesRemaining: number }
```

Permissions: `movement`, `combat`, `inventory`.

### Inventory

#### `inventory.equip`

Equip an item to its appropriate slot, or unequip the hand with `itemName: "hand"`. Mirrors Mindcraft `equip(bot, itemName)`.

```ts
z.object({
  itemName: z.string().min(1)
}).strict()
```

Return data:

```ts
{ equipped: boolean; itemName: string; slot?: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet" }
```

Permissions: `inventory`.

#### `inventory.place_block`

Place a block at specified coordinates, or auto-find the nearest free space adjacent to the bot. Added in Phase 2.

```ts
z.object({
  blockType: z.string().min(1),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  z: z.number().int().optional()
}).strict()
```

If coordinates are omitted, the skill finds the nearest empty space and places the block there.

Return data: `{ placed: boolean; position: Vec3; blockType: string }`.

Permissions: `movement`, `inventory`, `block.place`.

#### `inventory.consume`

Eat or drink the best available food, or a specific food item. Added in Phase 2.

```ts
z.object({
  itemName: z.string().optional()
}).strict()
```

When `itemName` is omitted, the best available food is chosen by a built-in food-value table. Waits for the eating animation to complete.

Return data: `{ consumed: boolean; itemName: string; foodLevel: number; saturation: number }`.

Permissions: `inventory`.

#### `inventory.discard`

Toss items from inventory. Mirrors Mindcraft `discard(bot, itemName, num)`.

```ts
z.object({
  itemName: z.string().min(1),
  num: AllOrCountSchema.default(-1)
}).strict()
```

`num: -1` discards all matching items.

Return data:

```ts
{ discarded: number; itemName: string }
```

Permissions: `inventory`.

#### `inventory.pickup_nearby`

Walk to nearby dropped item entities and pick them up. Mirrors Mindcraft `pickupNearbyItems(bot)`.

```ts
z.object({}).strict()
```

The built-in search distance is 8 blocks.

Return data:

```ts
{ pickedUp: number }
```

Permissions: `movement`, `inventory`, `entity.interact`.

#### `inventory.put_in_chest`

Deposit items into the nearest chest. Mirrors Mindcraft `putInChest(bot, itemName, num)`.

```ts
z.object({
  itemName: z.string().min(1),
  num: AllOrCountSchema.default(-1)
}).strict()
```

`num: -1` deposits all matching items. The built-in chest search range is 32 blocks.

Return data:

```ts
{ deposited: number; itemName: string; chest: BlockPosition }
```

Permissions: `movement`, `inventory`, `container`.

#### `inventory.take_from_chest`

Withdraw items from the nearest chest, scanning all matching container slots. Mirrors Mindcraft `takeFromChest(bot, itemName, num)`.

```ts
z.object({
  itemName: z.string().min(1),
  num: AllOrCountSchema.default(-1)
}).strict()
```

`num: -1` withdraws all matching items. The built-in chest search range is 32 blocks.

Return data:

```ts
{ withdrawn: number; itemName: string; chest: BlockPosition }
```

Permissions: `movement`, `inventory`, `container`.

#### `inventory.view_chest`

Open and report the contents of the nearest chest. Mirrors Mindcraft `viewChest(bot)`.

```ts
z.object({}).strict()
```

Return data:

```ts
{ chest: BlockPosition; items: Array<{ name: string; count: number; slot: number }> }
```

Permissions: `movement`, `container`.

#### `inventory.give_to_player`

Move near a player and toss items so the target can collect them. Mirrors Mindcraft `giveToPlayer(bot, itemType, username, num)`.

```ts
z.object({
  itemType: z.string().min(1),
  username: z.string().min(1),
  num: CountSchema.default(1)
}).strict()
```

Return data:

```ts
{ given: boolean; itemType: string; username: string; count: number }
```

Permissions: `movement`, `inventory`, `entity.interact`.

### Observation

Observation skills are read-only and may run while a primary action is active if they do not mutate bot state.

#### `observe.state`

Return the latest bot state snapshot.

```ts
z.object({
  includeRecentEvents: z.boolean().default(false),
  includeLastErrors: z.boolean().default(true)
}).strict()
```

Return data:

```ts
BotStateSnapshot
```

Permissions: none.

#### `observe.inventory`

Return inventory counts and equipped items. Mirrors Mindcraft `world.getInventoryCounts(bot)`.

```ts
z.object({
  includeSlots: z.boolean().default(false),
  includeEquipment: z.boolean().default(true)
}).strict()
```

Return data:

```ts
{ counts: Record<string, number>; equipment?: EquipmentSnapshot; slots?: InventorySlotSnapshot[] }
```

Permissions: none.

#### `observe.nearby`

Return nearby players, nearby entities, and nearby block type summaries.

```ts
z.object({
  maxDistance: z.number().min(1).max(256).default(16),
  includePlayers: z.boolean().default(true),
  includeEntities: z.boolean().default(true),
  includeBlockTypes: z.boolean().default(true)
}).strict()
```

Return data:

```ts
{
  players?: PlayerSummary[];
  entities?: EntitySummary[];
  blockTypes?: string[];
}
```

Permissions: none.

#### `observe.nearby_blocks`

Return nearby blocks matching requested block types. Mirrors Mindcraft `world.getNearestBlocks(bot, block_types, distance, count)`.

```ts
z.object({
  blockTypes: z.array(z.string().min(1)).optional(),
  distance: z.number().int().min(1).max(256).default(16),
  count: z.number().int().min(1).max(10000).default(100)
}).strict()
```

If `blockTypes` is omitted, all non-air block types may be returned.

Return data:

```ts
{ blocks: Array<{ name: string; position: BlockPosition; distance: number }> }
```

Permissions: none.

#### `observe.nearby_entities`

Return nearby entities sorted by distance. Mirrors Mindcraft `world.getNearbyEntities(bot, maxDistance)`.

```ts
z.object({
  maxDistance: z.number().min(1).max(256).default(16),
  entityTypes: z.array(z.string().min(1)).optional(),
  includePlayers: z.boolean().default(true),
  count: z.number().int().min(1).max(1000).default(100)
}).strict()
```

Return data:

```ts
{ entities: EntitySummary[] }
```

Permissions: none.

#### `observe.craftable`

Return item names currently craftable from inventory, using a nearby or carried crafting table when available. Mirrors Mindcraft `world.getCraftableItems(bot)`.

```ts
z.object({
  includeRecipes: z.boolean().default(false)
}).strict()
```

Return data:

```ts
{ items: string[]; recipes?: CraftableRecipeSummary[] }
```

Permissions: none.

#### `observe.block_at`

Return block info at a specific coordinate. Added in Phase 2.

```ts
z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int()
}).strict()
```

Return data: `{ name: string; displayName: string; position: Vec3; hardness: number; solid: boolean }`.

Permissions: none.

#### `observe.nearest_free_space`

Find the nearest air block suitable for block placement. Added in Phase 2.

```ts
z.object({
  maxDistance: z.number().int().min(1).max(64).default(16)
}).strict()
```

Searches for air/cave_air blocks with a solid neighbor to place against.

Return data: `{ position: Vec3 | null; distance: number }`.

Permissions: none.

### Communication

#### `chat.send`

Send a Minecraft chat message and emit `chat.sent`.

```ts
z.object({
  message: z.string().min(1).max(256)
}).strict()
```

Return data:

```ts
{ sent: boolean; message: string }
```

Permissions: `chat`.

## 4. Skill Execution Context

Handlers execute inside the owning bot worker. API adapters and control-plane services never receive Mineflayer object references.

```ts
interface SkillExecutionContext {
  bot: Bot;
  params: unknown;
  jobId: string;
  botId: string;
  signal: AbortSignal;
  cancellation: {
    isCancellationRequested(): boolean;
    throwIfCancellationRequested(): void;
    reason?: string;
  };
  progress(progress: JobProgress): void;
  emit(event: Omit<ServiceEvent, "id" | "ts" | "botId" | "jobId">): void;
  log(message: string, fields?: Record<string, unknown>): void;
  config: Readonly<BotConfig>;
  helpers: {
    world: WorldQueryHelpers;
    inventory: InventoryHelpers;
    movement: MovementHelpers;
    cleanup: CleanupHelpers;
    mcData: MinecraftDataHelpers;
    modes: ModeEngine;
  };
}
```

Handler call sequence:

1. Resolve skill by name.
2. Validate raw params with the skill's Zod schema.
3. Enforce skill availability and bot permission configuration.
4. Acquire the required action lane locks.
5. Run `handler(ctx, validatedParams)`.
6. Cooperatively cancel on `signal.abort`, timeout, or explicit job cancellation.
7. Always cleanup pathfinder goals, PVP state, digging, control states, windows, containers, timers, and scoped mode pauses.
8. Return a `SkillResult` and emit job lifecycle events.

## 5. Skill Result Format

Skill handlers return a stable JSON-serializable result. The job system wraps this result in the job record and emits it through `job.completed`, `job.failed`, or `job.cancelled`.

```ts
type SkillResultStatus = "success" | "failed" | "cancelled";

interface SkillResult<TData = unknown> {
  ok: boolean;
  status: SkillResultStatus;
  data?: TData;
  message?: string;
  output?: string[];
  error?: SkillError;
  metrics?: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
}

interface SkillError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}
```

Conventions:

- `ok: true` requires `status: "success"` and no `error`.
- Expected gameplay failures, such as missing tools or no matching block nearby, return `ok: false`, `status: "failed"`, and a stable `error.code`.
- Cancellation returns `ok: false`, `status: "cancelled"`, and preserves the cancellation reason when available.
- `output` is a bounded list of human-readable log lines, not a primary data channel.
- `data` must contain machine-readable fields for API, WebSocket, and MCP clients.

Common error codes:

```ts
type SkillErrorCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_DISABLED"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "BOT_NOT_READY"
  | "JOB_CANCELLED"
  | "JOB_TIMEOUT"
  | "PATH_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "MISSING_ITEM"
  | "MISSING_TOOL"
  | "INVENTORY_FULL"
  | "CONTAINER_NOT_FOUND"
  | "CONTAINER_BUSY"
  | "UNSAFE_BLOCK"
  | "MINEFLAYER_ERROR";
```

## 6. Permissions Model

Permissions describe runtime capabilities. Skills declare required permissions, and each bot config can restrict which permissions are available.

Supported permissions:

- `movement`: pathfinder goals, control states, following, fleeing, and movement-related mode pauses.
- `inventory`: equip, toss, pickup, craft inventory mutation, and item count changes.
- `block.place`: block placement, including temporary crafting tables or furnaces.
- `block.break`: digging, mining, collection, and breaking temporary utility blocks.
- `combat`: PVP, direct attacks, self-defense, and hostile-mob engagement.
- `chat`: sending Minecraft chat or commands.
- `container`: opening, reading, depositing into, and withdrawing from containers.
- `entity.interact`: targeting, following, giving to, attacking by ID, or otherwise interacting with entities and players.

Per-bot config:

```ts
interface BotSkillConfig {
  disabled?: string[];
  permissions?: Partial<Record<SkillPermission, boolean>>;
  defaultTimeoutMs?: number;
}
```

Permission enforcement:

1. Disabled skills are rejected before job creation when possible.
2. Required permissions are checked before the job enters the worker action lane.
3. Missing permissions fail with `PERMISSION_DENIED`.
4. Background modes must declare the same permissions and cannot run when they conflict with a primary skill.
5. Plugin skills cannot request permissions outside `SkillPermission` unless the service has been extended with an explicit permission registry.

Compatibility note: older internal drafts used Mindcraft-like names such as `move`, `dig`, `place`, and `attack`. The public mc-agent-service permission names are `movement`, `block.break`, `block.place`, and `combat`.

## 7. Custom Skill Plugin Development

Create a plugin:

```text
plugins/
  farming/
    skill-manifest.json
    package.json
    tsconfig.json
    src/
      index.ts
    dist/
      index.js
```

Example entrypoint:

```ts
import { z } from "zod";
import type { SkillRegistry } from "mc-agent-service/skills";

export function registerSkills(registry: SkillRegistry) {
  registry.register({
    name: "farm.harvest_and_replant",
    description: "Harvest mature crops in range and replant seeds.",
    category: "farming",
    permissions: ["movement", "block.break", "block.place", "inventory"],
    timeoutMs: 300000,
    busyPolicy: "queue",
    parameters: z.object({
      crop: z.string().min(1),
      radius: z.number().int().min(1).max(64)
    }).strict(),
    async handler(ctx, params) {
      ctx.progress({ current: 0, target: 1, unit: "steps", message: "Starting harvest" });
      const result = await ctx.helpers.world.findMatureCrops(params.crop, params.radius);
      return {
        ok: true,
        status: "success",
        data: { harvested: result.length, crop: params.crop }
      };
    }
  });
}
```

Registration lifecycle:

1. Service scans configured plugin directories.
2. Service reads `skill-manifest.json`.
3. Manifest metadata and JSON Schemas are validated.
4. Entrypoint is imported.
5. `registerSkills(registry, helpers)` is called.
6. Registered runtime definitions are compared against manifest declarations.
7. Plugin skills are exposed through REST, WebSocket job events, and MCP like built-ins.

Testing custom skills:

- Unit-test parameter schemas with valid and invalid inputs.
- Unit-test handlers with mocked `SkillExecutionContext` helpers.
- Integration-test against a local Minecraft server when a skill mutates world state.
- Verify cancellation by aborting the context signal during movement, digging, combat, and container operations.
- Verify cleanup closes windows and restores mode pauses after success, failure, timeout, and cancellation.

Hot reload:

- Development mode may watch plugin manifests and entrypoints.
- On change, the service unloads the plugin registry entries, imports the new entrypoint with a cache-busting URL, and re-registers skills.
- Running jobs continue with the old handler instance.
- New jobs use the reloaded skill definition.
- If reload fails, the old definition remains active unless `strictPluginLoading` is enabled.

## 8. Skill Documentation Auto-Generation

Skill schemas are the source of truth for generated API documentation and client-facing tool metadata.

Generated outputs:

- OpenAPI paths for REST skill submission:

```text
POST /bots/{botId}/actions/{skillName}
POST /jobs
```

- OpenAPI request bodies derived from each skill's Zod schema.
- OpenAPI response schemas using `Job` and `SkillResult<T>`.
- MCP tool definitions for skill invocations.
- Human-readable Markdown or HTML docs grouped by category.
- JSON metadata for clients that need to list available skills and permissions.

Generation rules:

- Zod schemas are converted to JSON Schema with stable `$id` values based on skill name and version.
- Descriptions, defaults, min/max constraints, enums, and examples must be preserved.
- Generated MCP tools call the same JobManager and SkillExecutor paths as REST.
- Mutating MCP tools return job IDs unless explicitly configured as synchronous.
- Observation tools may return data synchronously when they do not acquire a primary action lane.
- Documentation must include required permissions and timeout defaults for every skill.
- Disabled skills or permission-restricted skills can be hidden or marked unavailable in per-bot generated docs.

Example generated MCP tool metadata:

```json
{
  "name": "move.to_position",
  "description": "Navigate to a world position using Mineflayer pathfinder.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "botId": { "type": "string" },
      "x": { "type": "number" },
      "y": { "type": "number" },
      "z": { "type": "number" },
      "minDistance": { "type": "number", "default": 2, "minimum": 0, "maximum": 64 }
    },
    "required": ["botId", "x", "y", "z"],
    "additionalProperties": false
  }
}
```
