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
  playerName: z.string().min(1),
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
    const { playerName, itemName, num } = params;

    // Cannot give to self
    if (bot.username === playerName) {
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
    const player = bot.players[playerName];
    if (!player || !player.entity) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Player "${playerName}" not found or not loaded`, retryable: true },
      };
    }

    const playerEntity = player.entity;

    ctx.progress({ current: 0, target: 3, unit: "steps", message: `Moving to ${playerName}` });

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
      if (collector.username === playerName) {
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
      data: { given: true, itemName, username: playerName, count: given },
      message: `Gave ${given} ${itemName} to ${playerName}`,
    };
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
];
