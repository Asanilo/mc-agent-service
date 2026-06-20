/**
 * Inventory skills for mc-agent-service.
 * Handles equipping, discarding, picking up items, and chest operations.
 */
import { z } from "zod";
import type { Bot } from "mineflayer";
import type { SkillDefinition, SkillExecutionContext } from "../bots/skill-executor.js";
import type { SkillResult } from "../types/skills.js";
import { Vec3 } from "vec3";
import pf from "mineflayer-pathfinder";

const { Movements, goals } = pf;
const { GoalFollow, GoalNear, GoalInvert } = goals;

// ─── Helper: check cancellation ─────────────────────────────────────────────

function checkCancelled(ctx: SkillExecutionContext): boolean {
  return ctx.signal.aborted;
}

// ─── Helper: navigate to position ───────────────────────────────────────────

async function navigateTo(bot: Bot, x: number, y: number, z: number, distance = 2): Promise<void> {
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  await bot.pathfinder.goto(new GoalNear(x, y, z, distance));
}

// ─── Helper: find nearest block ─────────────────────────────────────────────

function findNearestBlock(bot: Bot, blockName: string, maxDistance: number) {
  const positions = bot.findBlocks({
    matching: (block) => block.name === blockName,
    maxDistance,
    count: 1,
  });
  if (positions.length === 0) return null;
  return bot.blockAt(positions[0]!);
}

function findPlayerEntity(bot: Bot, username: string) {
  const listedEntity = bot.players[username]?.entity;
  if (listedEntity) return listedEntity;

  return Object.values(bot.entities).find(
    (entity) => entity.type === "player" && (entity as { username?: string }).username === username
  );
}

// ─── inventory.equip ────────────────────────────────────────────────────────

const EquipSchema = z.object({
  itemName: z.string().min(1),
}).strict();

export const inventoryEquip: SkillDefinition<z.infer<typeof EquipSchema>> = {
  name: "inventory.equip",
  description: "Equip an item to its appropriate slot.",
  category: "inventory",
  permissions: ["inventory"],
  timeoutMs: 15000,
  busyPolicy: "reject-if-busy",
  readOnly: false,
  parameters: EquipSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { itemName } = params;

    // Special case: unequip hand
    if (itemName === "hand") {
      await bot.unequip("hand");
      return {
        ok: true,
        status: "success",
        data: { equipped: true, itemName: "hand", slot: "hand" },
      };
    }

    // Find item in inventory
    const item = bot.inventory.slots.find((slot) => slot && slot.name === itemName);
    if (!item) {
      return {
        ok: false,
        status: "failed",
        error: { code: "MISSING_ITEM", message: `You do not have any ${itemName} to equip`, retryable: false },
      };
    }

    // Determine the correct equipment slot
    let destination: string;
    if (itemName.includes("leggings")) {
      destination = "legs";
    } else if (itemName.includes("boots")) {
      destination = "feet";
    } else if (itemName.includes("helmet") || itemName.includes("cap")) {
      destination = "head";
    } else if (itemName.includes("chestplate") || itemName.includes("elytra")) {
      destination = "torso";
    } else if (itemName.includes("shield")) {
      destination = "off-hand";
    } else {
      destination = "hand";
    }

    try {
      await bot.equip(item, destination as any);
      return {
        ok: true,
        status: "success",
        data: { equipped: true, itemName, slot: destination },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to equip ${itemName}: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── inventory.discard ──────────────────────────────────────────────────────

const DiscardSchema = z.object({
  itemName: z.string().min(1),
  num: z.number().int().min(-1).default(-1).refine((n) => n === -1 || n >= 1, {
    message: "Must be -1 (all) or >= 1",
  }),
}).strict();

export const inventoryDiscard: SkillDefinition<z.infer<typeof DiscardSchema>> = {
  name: "inventory.discard",
  description: "Toss items from inventory.",
  category: "inventory",
  permissions: ["inventory"],
  timeoutMs: 15000,
  busyPolicy: "reject-if-busy",
  readOnly: false,
  parameters: DiscardSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { itemName, num } = params;

    let discarded = 0;
    const targetCount = num === -1 ? Infinity : num;

    while (discarded < targetCount) {
      const item = (bot.inventory.findInventoryItem as any)(itemName);
      if (!item) break;

      const toDiscard = Math.min(targetCount - discarded, item.count);
      try {
        await bot.toss(item.type, null, toDiscard);
        discarded += toDiscard;
      } catch (err: unknown) {
        if (discarded === 0) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            status: "failed",
            error: { code: "MINEFLAYER_ERROR", message: `Failed to toss ${itemName}: ${msg}`, retryable: true },
          };
        }
        break;
      }
    }

    if (discarded === 0) {
      return {
        ok: false,
        status: "failed",
        error: { code: "MISSING_ITEM", message: `You do not have any ${itemName} to discard`, retryable: false },
      };
    }

    return {
      ok: true,
      status: "success",
      data: { discarded, itemName },
    };
  },
};

// ─── inventory.pickup_nearby ────────────────────────────────────────────────

const PickupNearbySchema = z.object({}).strict();

export const inventoryPickupNearby: SkillDefinition<z.infer<typeof PickupNearbySchema>> = {
  name: "inventory.pickup_nearby",
  description: "Walk to nearby dropped item entities and pick them up.",
  category: "inventory",
  permissions: ["movement", "inventory", "entity.interact"],
  timeoutMs: 30000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: PickupNearbySchema,
  async run(ctx, _params) {
    const bot = ctx.bot;
    const distance = 8;

    const getNearestItem = () =>
      bot.nearestEntity(
        (entity) => entity.name === "item" && bot.entity.position.distanceTo(entity.position) < distance
      );

    let nearestItem = getNearestItem();
    let pickedUp = 0;

    while (nearestItem) {
      if (checkCancelled(ctx)) break;

      const movements = new Movements(bot);
      movements.canDig = false;
      bot.pathfinder.setMovements(movements);

      try {
        await bot.pathfinder.goto(new GoalFollow(nearestItem, 1));
      } catch {
        // Item might have been picked up
      }

      await new Promise((resolve) => setTimeout(resolve, 200));

      const prev = nearestItem;
      nearestItem = getNearestItem();
      if (prev === nearestItem) break; // stuck, no progress

      pickedUp++;
      ctx.progress({ current: pickedUp, target: pickedUp + 1, unit: "items" });
    }

    return {
      ok: true,
      status: "success",
      data: { pickedUp },
      message: `Picked up ${pickedUp} items`,
    };
  },
};

// ─── inventory.view_chest ───────────────────────────────────────────────────

const ViewChestSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
}).strict();

export const inventoryViewChest: SkillDefinition<z.infer<typeof ViewChestSchema>> = {
  name: "inventory.view_chest",
  description: "Open and report the contents of a chest.",
  category: "inventory",
  permissions: ["movement", "container"],
  timeoutMs: 15000,
  busyPolicy: "cancel-current",
  readOnly: true,
  parameters: ViewChestSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z } = params;

    const chestBlock = bot.blockAt(new Vec3(x, y, z));
    if (!chestBlock || !chestBlock.name.includes("chest")) {
      // Try to find nearest chest
      const nearestChest = findNearestBlock(bot, "chest", 32);
      if (!nearestChest) {
        return {
          ok: false,
          status: "failed",
          error: { code: "CONTAINER_NOT_FOUND", message: "No chest found at specified position or nearby", retryable: false },
        };
      }

      // Navigate to nearest chest
      await navigateTo(bot, nearestChest.position.x, nearestChest.position.y, nearestChest.position.z, 2);

      try {
        const container = await bot.openContainer(nearestChest);
        const items = container.containerItems().map((item) => ({
          name: item.name,
          count: item.count,
          slot: item.slot,
        }));
        await bot.closeWindow(container);

        return {
          ok: true,
          status: "success",
          data: {
            chest: { x: nearestChest.position.x, y: nearestChest.position.y, z: nearestChest.position.z },
            items,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          status: "failed",
          error: { code: "MINEFLAYER_ERROR", message: `Failed to open chest: ${msg}`, retryable: true },
        };
      }
    }

    // Navigate to specified chest
    await navigateTo(bot, x, y, z, 2);

    try {
      const container = await bot.openContainer(chestBlock);
      const items = container.containerItems().map((item) => ({
        name: item.name,
        count: item.count,
        slot: item.slot,
      }));
      await bot.closeWindow(container);

      return {
        ok: true,
        status: "success",
        data: {
          chest: { x, y, z },
          items,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to open chest: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── inventory.put_in_chest ─────────────────────────────────────────────────

const PutInChestSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  itemName: z.string().min(1),
  num: z.number().int().min(-1).default(-1).refine((n) => n === -1 || n >= 1, {
    message: "Must be -1 (all) or >= 1",
  }),
}).strict();

export const inventoryPutInChest: SkillDefinition<z.infer<typeof PutInChestSchema>> = {
  name: "inventory.put_in_chest",
  description: "Deposit items into a chest.",
  category: "inventory",
  permissions: ["movement", "inventory", "container"],
  timeoutMs: 30000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: PutInChestSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z, itemName, num } = params;

    const chestBlock = bot.blockAt(new Vec3(x, y, z));
    if (!chestBlock || !chestBlock.name.includes("chest")) {
      return {
        ok: false,
        status: "failed",
        error: { code: "CONTAINER_NOT_FOUND", message: `No chest found at ${x},${y},${z}`, retryable: false },
      };
    }

    const item = (bot.inventory.findInventoryItem as any)(itemName);
    if (!item) {
      return {
        ok: false,
        status: "failed",
        error: { code: "MISSING_ITEM", message: `You do not have any ${itemName}`, retryable: false },
      };
    }

    const toPut = num === -1 ? item.count : Math.min(num, item.count);

    // Navigate to chest
    await navigateTo(bot, x, y, z, 2);

    try {
      const container = await bot.openContainer(chestBlock);
      await container.deposit(item.type, null, toPut);
      await bot.closeWindow(container);

      return {
        ok: true,
        status: "success",
        data: { deposited: toPut, itemName, chest: { x, y, z } },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to deposit items: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── inventory.take_from_chest ──────────────────────────────────────────────

const TakeFromChestSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  itemName: z.string().min(1),
  num: z.number().int().min(-1).default(-1).refine((n) => n === -1 || n >= 1, {
    message: "Must be -1 (all) or >= 1",
  }),
}).strict();

export const inventoryTakeFromChest: SkillDefinition<z.infer<typeof TakeFromChestSchema>> = {
  name: "inventory.take_from_chest",
  description: "Withdraw items from a chest.",
  category: "inventory",
  permissions: ["movement", "inventory", "container"],
  timeoutMs: 30000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: TakeFromChestSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z, itemName, num } = params;

    const chestBlock = bot.blockAt(new Vec3(x, y, z));
    if (!chestBlock || !chestBlock.name.includes("chest")) {
      return {
        ok: false,
        status: "failed",
        error: { code: "CONTAINER_NOT_FOUND", message: `No chest found at ${x},${y},${z}`, retryable: false },
      };
    }

    // Navigate to chest
    await navigateTo(bot, x, y, z, 2);

    try {
      const container = await bot.openContainer(chestBlock);

      // Find all matching items in the chest
      const matchingItems = container.containerItems().filter((item) => item.name === itemName);
      if (matchingItems.length === 0) {
        await bot.closeWindow(container);
        return {
          ok: false,
          status: "failed",
          error: { code: "MISSING_ITEM", message: `No ${itemName} found in chest`, retryable: false },
        };
      }

      const totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
      const remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
      let totalTaken = 0;

      // Withdraw from each slot
      for (const item of matchingItems) {
        if (remaining - totalTaken <= 0) break;
        const toTake = Math.min(remaining - totalTaken, item.count);
        try {
          await container.withdraw(item.type, null, toTake);
          totalTaken += toTake;
        } catch {
          break;
        }
      }

      await bot.closeWindow(container);

      return {
        ok: totalTaken > 0,
        status: "success",
        data: { withdrawn: totalTaken, itemName, chest: { x, y, z } },
        message: totalTaken === 0 ? `No ${itemName} could be withdrawn` : `Withdrew ${totalTaken} ${itemName}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to withdraw items: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── inventory.give_to_player ──────────────────────────────────────────────

const GiveToPlayerSchema = z.object({
  username: z.string().min(1),
  itemName: z.string().min(1),
  num: z.number().int().min(1).default(1),
}).strict();

export const inventoryGiveToPlayer: SkillDefinition<z.infer<typeof GiveToPlayerSchema>> = {
  name: "inventory.give_to_player",
  description: "Give items to a specific player.",
  category: "inventory",
  permissions: ["movement", "inventory", "entity.interact"],
  timeoutMs: 30000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: GiveToPlayerSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { username, itemName, num } = params;

    // Cannot give to self
    if (bot.username === username) {
      return {
        ok: false,
        status: "failed",
        error: { code: "VALIDATION_FAILED", message: "Cannot give items to yourself", retryable: false },
      };
    }

    // Check if we have the item
    const item = bot.inventory.findInventoryItem(bot.registry.itemsByName[itemName]?.id ?? -1, null, false);
    if (!item) {
      return {
        ok: false,
        status: "failed",
        error: { code: "MISSING_ITEM", message: `You do not have any ${itemName}`, retryable: false },
      };
    }

    // Find the player
    const playerEntity = findPlayerEntity(bot, username);
    if (!playerEntity) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Player "${username}" not found or not loaded`, retryable: true },
      };
    }

    ctx.progress({ current: 0, target: 3, unit: "steps", message: `Moving to ${username}` });

    // Navigate to player
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(new GoalFollow(playerEntity, 3));
    } catch (err: unknown) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Movement cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "PATH_NOT_FOUND", message: `Failed to reach player: ${msg}`, retryable: true },
      };
    }

    ctx.progress({ current: 1, target: 3, unit: "steps", message: "Dropping items" });

    // If too close, back up a bit
    if (bot.entity.position.distanceTo(playerEntity.position) < 2) {
      const tooCloseGoal = new GoalInvert(new GoalFollow(playerEntity, 2));
      try {
        await bot.pathfinder.goto(tooCloseGoal);
      } catch {
        // Ignore
      }
    }

    // Look at player and toss items
    await bot.lookAt(playerEntity.position);

    let given = 0;
    const toGive = Math.min(num, item.count);

    try {
      await bot.toss(item.type, null, toGive);
      given = toGive;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to toss items: ${msg}`, retryable: true },
      };
    }

    ctx.progress({ current: 2, target: 3, unit: "steps", message: "Waiting for pickup" });

    // Wait briefly for the player to pick up
    let received = false;
    const onCollect = (collector: any, _collected: any) => {
      if (collector.username === username) {
        received = true;
      }
    };
    bot.once("playerCollect", onCollect);

    const start = Date.now();
    while (!received && !checkCancelled(ctx) && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    bot.removeListener("playerCollect", onCollect);

    ctx.progress({ current: 3, target: 3, unit: "steps", message: "Done" });

    return {
      ok: true,
      status: "success",
      data: { given: true, itemName, username, count: given },
      message: `Gave ${given} ${itemName} to ${username}`,
    };
  },
};

// ─── inventory.place_block ──────────────────────────────────────────────────

const PlaceBlockSchema = z.object({
  blockType: z.string().min(1),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  z: z.number().int().optional(),
}).strict();

export const inventoryPlaceBlock: SkillDefinition<z.infer<typeof PlaceBlockSchema>> = {
  name: "inventory.place_block",
  description: "Place a block at a given position or nearest free space.",
  category: "inventory",
  permissions: ["movement", "inventory", "block.place"],
  timeoutMs: 30000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: PlaceBlockSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { blockType, x, y, z } = params;

    // Resolve item name (water → water_bucket, etc.)
    let itemName = blockType;
    if (itemName === "water") itemName = "water_bucket";
    else if (itemName === "lava") itemName = "lava_bucket";
    else if (itemName === "redstone_wire") itemName = "redstone";

    // Find item in inventory
    const item = bot.inventory.findInventoryItem(
      bot.registry.itemsByName[itemName]?.id ?? -1, null, false,
    );
    if (!item) {
      return {
        ok: false,
        status: "failed",
        error: { code: "MISSING_ITEM", message: `You do not have any ${itemName} to place`, retryable: false },
      };
    }

    // Determine target position
    let targetPos: import("vec3").Vec3;
    if (x !== undefined && y !== undefined && z !== undefined) {
      targetPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    } else {
      // Find nearest free space
      const airBlocks = bot.findBlocks({
        matching: (block) => block.name === "air" || block.name === "cave_air",
        maxDistance: 16,
        count: 27,
      });
      // Filter for blocks that have a solid neighbor to place against
      const emptyNames = ["air", "cave_air", "water", "lava", "grass", "short_grass", "tall_grass", "snow", "dead_bush", "fern"];
      let found: import("vec3").Vec3 | null = null;
      for (const pos of airBlocks) {
        const neighbors = [
          pos.offset(0, -1, 0), pos.offset(0, 1, 0),
          pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
          pos.offset(0, 0, 1), pos.offset(0, 0, -1),
        ];
        for (const n of neighbors) {
          const nBlock = bot.blockAt(n);
          if (nBlock && !emptyNames.includes(nBlock.name)) {
            found = pos;
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        return {
          ok: false,
          status: "failed",
          error: { code: "TARGET_NOT_FOUND", message: "No free space found nearby to place block", retryable: true },
        };
      }
      targetPos = found;
    }

    // Navigate close enough
    if (bot.entity.position.distanceTo(targetPos) > 4.5) {
      await navigateTo(bot, targetPos.x, targetPos.y, targetPos.z, 4);
    }

    // Find a solid neighbor to place against
    const emptyNames = ["air", "cave_air", "water", "lava", "grass", "short_grass", "tall_grass", "snow", "dead_bush", "fern"];
    const dirs = [
      new Vec3(0, -1, 0), new Vec3(0, 1, 0),
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ];
    let buildOffBlock: ReturnType<typeof bot.blockAt> = null;
    let faceVec: import("vec3").Vec3 | null = null;
    for (const d of dirs) {
      const neighborPos = targetPos.plus(d);
      const block = bot.blockAt(neighborPos);
      if (block && !emptyNames.includes(block.name)) {
        buildOffBlock = block;
        faceVec = new Vec3(-d.x, -d.y, -d.z);
        break;
      }
    }
    if (!buildOffBlock || !faceVec) {
      return {
        ok: false,
        status: "failed",
        error: { code: "UNSAFE_BLOCK", message: "Cannot place block here — nothing to attach to", retryable: false },
      };
    }

    try {
      // If target position has a non-air block in the way, try to break it first
      const targetBlock = bot.blockAt(targetPos);
      if (targetBlock && !emptyNames.includes(targetBlock.name)) {
        return {
          ok: false,
          status: "failed",
          error: { code: "UNSAFE_BLOCK", message: `Block ${targetBlock.name} is in the way at target position`, retryable: false },
        };
      }

      await bot.equip(item, "hand");
      await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
      await bot.placeBlock(buildOffBlock, faceVec);

      return {
        ok: true,
        status: "success",
        data: {
          placed: true,
          blockType,
          position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
        },
      };
    } catch (err: unknown) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Block placement cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to place block: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── inventory.consume ─────────────────────────────────────────────────────

const ConsumeSchema = z.object({
  itemName: z.string().optional(),
}).strict();

export const inventoryConsume: SkillDefinition<z.infer<typeof ConsumeSchema>> = {
  name: "inventory.consume",
  description: "Eat or drink the best available food, or a specific item.",
  category: "inventory",
  permissions: ["inventory"],
  timeoutMs: 15000,
  busyPolicy: "reject-if-busy",
  readOnly: false,
  parameters: ConsumeSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { itemName } = params;

    // Food value table for auto-eat ranking
    const foodValues: Record<string, number> = {
      golden_apple: 10, enchanted_golden_apple: 10,
      cooked_beef: 8, steak: 8,
      cooked_porkchop: 8, cooked_mutton: 6, cooked_salmon: 6,
      cooked_chicken: 6, cooked_cod: 5, cooked_rabbit: 5,
      bread: 5, baked_potato: 5, mushroom_stew: 6, beetroot_soup: 6,
      rabbit_stew: 10, suspicious_stew: 6,
      apple: 4, golden_carrot: 6, melon_slice: 2, sweet_berries: 2,
      glow_berries: 2, carrot: 3, potato: 1, beetroot: 1,
      raw_beef: 3, raw_porkchop: 3, raw_mutton: 2, raw_chicken: 2,
      raw_salmon: 2, raw_cod: 2, raw_rabbit: 2,
      cookie: 2, dried_kelp: 1, cake: 0,
      pumpkin_pie: 4, chorus_fruit: 4,
    };

    let item: import("prismarine-item").Item | null = null;

    if (itemName) {
      item = bot.inventory.findInventoryItem(
        bot.registry.itemsByName[itemName]?.id ?? -1, null, false,
      );
      if (!item) {
        return {
          ok: false,
          status: "failed",
          error: { code: "MISSING_ITEM", message: `You do not have any ${itemName} to consume`, retryable: false },
        };
      }
    } else {
      // Auto-eat: find best food in inventory
      const inventoryItems = bot.inventory.items();
      let bestItem: import("prismarine-item").Item | null = null;
      let bestValue = -1;
      for (const invItem of inventoryItems) {
        const value = foodValues[invItem.name] ?? -1;
        if (value > bestValue) {
          bestValue = value;
          bestItem = invItem;
        }
      }
      if (!bestItem || bestValue <= 0) {
        return {
          ok: false,
          status: "failed",
          error: { code: "MISSING_ITEM", message: "No food found in inventory to consume", retryable: false },
        };
      }
      item = bestItem;
    }

    try {
      await bot.equip(item, "hand");
      await bot.consume();
      return {
        ok: true,
        status: "success",
        data: { consumed: true, itemName: item.name },
      };
    } catch (err: unknown) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Consumption cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to consume: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── Export all inventory skills ─────────────────────────────────────────────

export const inventorySkills = [
  inventoryEquip,
  inventoryDiscard,
  inventoryPickupNearby,
  inventoryGiveToPlayer,
  inventoryViewChest,
  inventoryPutInChest,
  inventoryTakeFromChest,
  inventoryPlaceBlock,
  inventoryConsume,
];
