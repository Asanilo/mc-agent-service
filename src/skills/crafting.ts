/**
 * Crafting skills for mc-agent-service.
 * Handles item crafting and smelting operations.
 */
import { z } from "zod";
import type { Bot } from "mineflayer";
import type { SkillDefinition, SkillExecutionContext } from "../bots/skill-executor.js";
import type { SkillResult } from "../types/skills.js";
import pf from "mineflayer-pathfinder";
const { goals, Movements } = pf;
import { Vec3 } from "vec3";

// ─── Helper: check cancellation ─────────────────────────────────────────────

function checkCancelled(ctx: SkillExecutionContext): boolean {
  return ctx.signal.aborted;
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

// ─── craft.item ─────────────────────────────────────────────────────────────

const CraftItemSchema = z.object({
  itemName: z.string().min(1),
  num: z.number().int().min(1).default(1),
}).strict();

export const craftItem: SkillDefinition<z.infer<typeof CraftItemSchema>> = {
  name: "craft.item",
  description: "Craft an item from available recipes.",
  category: "crafting",
  permissions: ["movement", "inventory", "block.place", "block.break"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: CraftItemSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { itemName, num } = params;

    ctx.progress({ current: 0, target: num, unit: "items", message: `Crafting ${itemName}` });

    const itemId = bot.registry.itemsByName[itemName]?.id;
    if (itemId === undefined) {
      return {
        ok: false,
        status: "failed",
        error: { code: "MISSING_ITEM", message: `Unknown item "${itemName}"`, retryable: false },
      };
    }

    // Find recipes (try without crafting table first, then with)
    let recipes = bot.recipesFor(itemId, null, 1, null);
    let usedCraftingTable: any = null;

    if (!recipes || recipes.length === 0) {
      // Try with crafting table
      recipes = bot.recipesFor(itemId, null, 1, true);
      if (recipes && recipes.length > 0) {
        // Find or place a crafting table
        const tableRange = 16;
        const tableBlock = findNearestBlock(bot, "crafting_table", tableRange);

        if (tableBlock) {
          if (bot.entity.position.distanceTo(tableBlock.position) > 4) {
            const movements = new Movements(bot);
            bot.pathfinder.setMovements(movements);
            await bot.pathfinder.goto(
              new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 3)
            );
          }
          usedCraftingTable = tableBlock;
          recipes = bot.recipesFor(itemId, null, 1, usedCraftingTable);
        }
      }
    }

    if (!recipes || recipes.length === 0) {
      return {
        ok: false,
        status: "failed",
        error: {
          code: "MISSING_ITEM",
          message: `No recipe found for "${itemName}" or missing ingredients`,
          retryable: false,
        },
      };
    }

    const recipe = recipes[0]!;

    try {
      await bot.craft(recipe, num, usedCraftingTable);
      ctx.progress({ current: num, target: num, unit: "items", message: "Crafted" });

      return {
        ok: true,
        status: "success",
        data: {
          crafted: num,
          itemName,
          requested: num,
        },
      };
    } catch (err: unknown) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Crafting cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Crafting failed: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── craft.smelt_item ───────────────────────────────────────────────────────

const SmeltItemSchema = z.object({
  itemName: z.string().min(1),
  num: z.number().int().min(1).default(1),
}).strict();

export const craftSmeltItem: SkillDefinition<z.infer<typeof SmeltItemSchema>> = {
  name: "craft.smelt_item",
  description: "Smelt items in a furnace.",
  category: "crafting",
  permissions: ["movement", "inventory", "container", "block.place", "block.break"],
  timeoutMs: 180000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: SmeltItemSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { itemName, num } = params;

    ctx.progress({ current: 0, target: num, unit: "items", message: `Smelting ${itemName}` });

    // Find furnace
    const furnaceRange = 16;
    let furnaceBlock = findNearestBlock(bot, "furnace", furnaceRange);
    let placedFurnace = false;

    if (!furnaceBlock) {
      // Try to place a furnace from inventory
      const furnaceItem = bot.inventory.findInventoryItem(bot.registry.itemsByName["furnace"]!.id, null, false);
      if (furnaceItem) {
        const airPositions = bot.findBlocks({
          matching: (block) => block.name === "air",
          maxDistance: 8,
          count: 1,
        });
        if (airPositions.length > 0) {
          const placePos = airPositions[0];
          const belowBlock = bot.blockAt(placePos!.offset(0, -1, 0));
          if (belowBlock && belowBlock.drops && belowBlock.drops.length > 0) {
            try {
              await bot.equip(furnaceItem, "hand");
              await bot.placeBlock(belowBlock, new Vec3(0, 1, 0));
              furnaceBlock = bot.blockAt(placePos!);
              placedFurnace = true;
            } catch {
              // Failed to place
            }
          }
        }
      }
    }

    if (!furnaceBlock) {
      return {
        ok: false,
        status: "failed",
        error: {
          code: "CONTAINER_NOT_FOUND",
          message: "No furnace found nearby and no furnace in inventory to place",
          retryable: false,
        },
      };
    }

    // Navigate to furnace
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      await bot.pathfinder.goto(
        new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 3)
      );
    }

    try {
      const furnace = await bot.openFurnace(furnaceBlock);

      // Check if furnace is busy with a different item
      const inputItem = furnace.inputItem();
      if (inputItem && inputItem.count > 0) {
        const inputName = bot.registry.items[inputItem.type]?.name ?? "unknown";
        if (inputName !== itemName) {
          await bot.closeWindow(furnace);
          return {
            ok: false,
            status: "failed",
            error: {
              code: "CONTAINER_BUSY",
              message: `Furnace is already smelting ${inputName}`,
              retryable: true,
            },
          };
        }
      }

      // Add fuel if needed
      if (!furnace.fuelItem()) {
        const fuelItem =
          bot.inventory.findInventoryItem(bot.registry.itemsByName["coal"]!.id, null, false) ??
          bot.inventory.findInventoryItem(bot.registry.itemsByName["charcoal"]!.id, null, false) ??
          bot.inventory.findInventoryItem(bot.registry.itemsByName["oak_log"]!.id, null, false) ??
          bot.inventory.findInventoryItem(bot.registry.itemsByName["birch_log"]!.id, null, false);

        if (!fuelItem) {
          await bot.closeWindow(furnace);
          return {
            ok: false,
            status: "failed",
            error: {
              code: "MISSING_ITEM",
              message: "No fuel available (need coal, charcoal, or wood)",
              retryable: false,
            },
          };
        }

        const fuelCount = Math.ceil(num / 8);
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelCount, fuelItem.count));
      }

      // Put input items
      const inputItemId = bot.registry.itemsByName[itemName]?.id;
      if (inputItemId === undefined) {
        await bot.closeWindow(furnace);
        return {
          ok: false,
          status: "failed",
          error: { code: "MISSING_ITEM", message: `Unknown item "${itemName}"`, retryable: false },
        };
      }

      await furnace.putInput(inputItemId, null, num);

      // Wait for smelting to complete
      let smelted = 0;
      let lastCollected = Date.now();

      while (smelted < num) {
        if (checkCancelled(ctx)) break;

        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (furnace.outputItem()) {
          const output = await furnace.takeOutput();
          if (output) {
            smelted += output.count;
            lastCollected = Date.now();
            ctx.progress({ current: smelted, target: num, unit: "items" });
          }
        }

        if (Date.now() - lastCollected > 15000) break;
      }

      // Clean up
      try {
        if (furnace.inputItem()) await furnace.takeInput();
        if (furnace.fuelItem()) await furnace.takeFuel();
      } catch {
        // Ignore cleanup errors
      }

      await bot.closeWindow(furnace);

      if (placedFurnace && furnaceBlock) {
        try {
          await bot.dig(furnaceBlock);
        } catch {
          // Ignore
        }
      }

      return {
        ok: smelted > 0,
        status: checkCancelled(ctx) ? "cancelled" : smelted > 0 ? "success" : "failed",
        data: {
          smelted,
          itemName,
          requested: num,
        },
        message: smelted === 0 ? `Failed to smelt ${itemName}` : `Smelted ${smelted} ${itemName}`,
      };
    } catch (err: unknown) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Smelting cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Smelting failed: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── Export all crafting skills ──────────────────────────────────────────────

export const craftingSkills = [
  craftItem,
  craftSmeltItem,
];
