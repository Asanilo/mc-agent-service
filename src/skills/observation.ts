/**
 * Observation skills for mc-agent-service.
 * Read-only skills that return bot state, inventory, nearby entities, and craftable items.
 */
import { z } from "zod";
import type { Bot } from "mineflayer";
import type { SkillDefinition, SkillExecutionContext } from "../bots/skill-executor.js";
import type { SkillResult } from "../types/skills.js";

// ─── observe.state ──────────────────────────────────────────────────────────

const ObserveStateSchema = z.object({
  includeRecentEvents: z.boolean().default(false),
  includeLastErrors: z.boolean().default(true),
}).strict();

export const observeState: SkillDefinition<z.infer<typeof ObserveStateSchema>> = {
  name: "observe.state",
  description: "Return the latest bot state snapshot.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveStateSchema,
  async run(ctx, _params) {
    const bot = ctx.bot;

    const pos = bot.entity.position;
    const health = bot.health;
    const food = bot.food;
    const gameMode = bot.game.gameMode;
    const dimension = (bot as any).game?.dimension ?? "overworld";
    const timeOfDay = bot.time.timeOfDay;
    const day = bot.time.day;
    const isRaining = (bot as any).isRaining ?? false;
    const thunderState = (bot as any).thunderState ?? 0;

    // Get biome from current position
    let biome = "unknown";
    try {
      const block = bot.blockAt(pos);
      if (block && (block as any).biome) {
        biome = (block as any).biome.name ?? "unknown";
      }
    } catch {
      // biome not available
    }

    return {
      ok: true,
      status: "success",
      data: {
        position: { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 },
        health: Math.round(health * 10) / 10,
        food,
        gameMode,
        dimension,
        timeOfDay,
        day,
        isRaining,
        thunderState,
        biome,
        yaw: Math.round(bot.entity.yaw * 100) / 100,
        pitch: Math.round(bot.entity.pitch * 100) / 100,
      },
    };
  },
};

// ─── observe.inventory ──────────────────────────────────────────────────────

const ObserveInventorySchema = z.object({
  includeSlots: z.boolean().default(false),
  includeEquipment: z.boolean().default(true),
}).strict();

export const observeInventory: SkillDefinition<z.infer<typeof ObserveInventorySchema>> = {
  name: "observe.inventory",
  description: "Return inventory counts and equipped items.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveInventorySchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { includeSlots, includeEquipment } = params;

    // Build inventory counts — fall back to slots if items() returns empty
    // (happens in creative mode)
    const counts: Record<string, number> = {};
    let inventoryItems = bot.inventory.items();
    if (inventoryItems.length === 0) {
      inventoryItems = bot.inventory.slots.filter(
        (slot): slot is NonNullable<typeof slot> => slot !== null,
      );
    }
    for (const item of inventoryItems) {
      counts[item.name] = (counts[item.name] ?? 0) + item.count;
    }

    const result: any = { counts };

    // Equipment
    if (includeEquipment) {
      const heldItem = bot.heldItem;
      const equip = (bot as any).equipment;
      result.equipment = {
        hand: heldItem ? { name: heldItem.name, count: heldItem.count } : null,
        offHand: equip?.offhand ? { name: equip.offhand.name, count: equip.offhand.count } : null,
        head: equip?.head ? { name: equip.head.name, count: equip.head.count } : null,
        torso: equip?.torso ? { name: equip.torso.name, count: equip.torso.count } : null,
        legs: equip?.legs ? { name: equip.legs.name, count: equip.legs.count } : null,
        feet: equip?.feet ? { name: equip.feet.name, count: equip.feet.count } : null,
      };
    }

    // Full slot list
    if (includeSlots) {
      result.slots = bot.inventory.slots
        .filter((slot) => slot !== null)
        .map((slot) => ({
          name: slot!.name,
          count: slot!.count,
          slot: slot!.slot,
        }));
    }

    return {
      ok: true,
      status: "success",
      data: result,
    };
  },
};

// ─── observe.nearby ─────────────────────────────────────────────────────────

const ObserveNearbySchema = z.object({
  distance: z.number().min(1).max(256).default(16),
  includePlayers: z.boolean().default(true),
  includeEntities: z.boolean().default(true),
  includeBlockTypes: z.boolean().default(true),
}).strict();

export const observeNearby: SkillDefinition<z.infer<typeof ObserveNearbySchema>> = {
  name: "observe.nearby",
  description: "Return nearby players, entities, and block type summaries.",
  category: "observation",
  permissions: [],
  timeoutMs: 10000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveNearbySchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { distance: scanDistance, includePlayers, includeEntities, includeBlockTypes } = params;

    const result: any = {};

    // Players
    if (includePlayers) {
      const players: Array<{ username: string; distance: number; position: { x: number; y: number; z: number } }> = [];
      for (const [username, player] of Object.entries(bot.players)) {
        if (username === bot.username) continue;
        if (!player.entity) continue;
        const distance = bot.entity.position.distanceTo(player.entity.position);
        if (distance <= scanDistance) {
          const p = player.entity.position;
          players.push({
            username,
            distance: Math.round(distance * 10) / 10,
            position: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
          });
        }
      }
      players.sort((a, b) => a.distance - b.distance);
      result.players = players;
    }

    // Entities
    if (includeEntities) {
      const entities: Array<{ name: string; id: number; distance: number; position: { x: number; y: number; z: number } }> = [];
      for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity) continue;
        const distance = bot.entity.position.distanceTo(entity.position);
        if (distance <= scanDistance && entity.name) {
          const p = entity.position;
          entities.push({
            name: entity.name,
            id: entity.id,
            distance: Math.round(distance * 10) / 10,
            position: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
          });
        }
      }
      entities.sort((a, b) => a.distance - b.distance);
      result.entities = entities.slice(0, 100); // cap at 100
    }

    // Block types (sampling approach)
    if (includeBlockTypes) {
      const blockTypes = new Set<string>();
      const pos = bot.entity.position;
      const scanRange = Math.min(scanDistance, 32); // limit scan range for performance

      for (let dx = -scanRange; dx <= scanRange; dx += 4) {
        for (let dy = -scanRange; dy <= scanRange; dy += 4) {
          for (let dz = -scanRange; dz <= scanRange; dz += 4) {
            const block = bot.blockAt(pos.offset(dx, dy, dz));
            if (block && block.name !== "air" && block.name !== "cave_air") {
              blockTypes.add(block.name);
            }
          }
        }
      }
      result.blockTypes = Array.from(blockTypes).sort();
    }

    return {
      ok: true,
      status: "success",
      data: result,
    };
  },
};

// ─── observe.craftable ──────────────────────────────────────────────────────

const ObserveCraftableSchema = z.object({
  includeRecipes: z.boolean().default(false),
}).strict();

export const observeCraftable: SkillDefinition<z.infer<typeof ObserveCraftableSchema>> = {
  name: "observe.craftable",
  description: "Return item names currently craftable from inventory.",
  category: "observation",
  permissions: [],
  timeoutMs: 15000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveCraftableSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { includeRecipes } = params;

    const craftableItems: string[] = [];
    const recipeSummaries: Array<{ item: string; count: number; ingredients: Record<string, number> }> = [];

    // Iterate through all known items
    const itemsByName = bot.registry.itemsByName;
    for (const [itemName, itemInfo] of Object.entries(itemsByName)) {
      try {
        const recipes = bot.recipesFor(itemInfo.id, null, 1, null);
        if (recipes && recipes.length > 0) {
          craftableItems.push(itemName);

          if (includeRecipes) {
            const recipe = recipes[0];
            const ingredients: Record<string, number> = {};
            // Extract ingredients from recipe
            if (recipe!.ingredients) {
              for (const ingredient of recipe!.ingredients) {
                const iName = bot.registry.items[ingredient.id]?.name ?? `item_${ingredient.id}`;
                ingredients[iName] = (ingredients[iName] ?? 0) + ingredient.count;
              }
            }
            recipeSummaries.push({
              item: itemName,
              count: recipe!.result?.count ?? 1,
              ingredients,
            });
          }
        }
      } catch {
        // Skip items that error during recipe lookup
      }
    }

    const result: any = { items: craftableItems };
    if (includeRecipes) {
      result.recipes = recipeSummaries;
    }

    return {
      ok: true,
      status: "success",
      data: result,
    };
  },
};

// ─── observe.nearby_blocks ──────────────────────────────────────────────────

const NearbyBlocksSchema = z.object({
  blockType: z.string().min(1).optional(),
  distance: z.number().int().min(1).max(256).default(16),
  num: z.number().int().min(1).max(10000).default(100),
}).strict();

export const observeNearbyBlocks: SkillDefinition<z.infer<typeof NearbyBlocksSchema>> = {
  name: "observe.nearby_blocks",
  description: "Get nearby blocks by type.",
  category: "observation",
  permissions: [],
  timeoutMs: 10000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: NearbyBlocksSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { blockType, distance, num } = params;

    const positions = bot.findBlocks({
      matching: (block) => {
        if (block.name === "air" || block.name === "cave_air") return false;
        if (blockType) {
          return block.name === blockType;
        }
        return true;
      },
      maxDistance: distance,
      count: num,
    });

    const botPos = bot.entity.position;
    const blocks = positions
      .map((pos) => {
        const block = bot.blockAt(pos);
        if (!block) return null;
        return {
          name: block.name,
          position: { x: pos.x, y: pos.y, z: pos.z },
          distance: Math.round(botPos.distanceTo(pos) * 10) / 10,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .sort((a, b) => a.distance - b.distance);

    return {
      ok: true,
      status: "success",
      data: { blocks },
    };
  },
};

// ─── observe.nearby_entities ────────────────────────────────────────────────

const NearbyEntitiesSchema = z.object({
  entityTypes: z.array(z.string().min(1)).optional(),
  distance: z.number().int().min(1).max(256).default(16),
}).strict();

export const observeNearbyEntities: SkillDefinition<z.infer<typeof NearbyEntitiesSchema>> = {
  name: "observe.nearby_entities",
  description: "Get nearby entities by type.",
  category: "observation",
  permissions: [],
  timeoutMs: 10000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: NearbyEntitiesSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { entityTypes, distance: maxDistance } = params;

    const botPos = bot.entity.position;
    const entities: Array<{
      name: string;
      id: number;
      type: string;
      position: { x: number; y: number; z: number };
      distance: number;
    }> = [];

    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity) continue;
      if (!entity.name) continue;

      const distance = botPos.distanceTo(entity.position);
      if (distance > maxDistance) continue;

      if (entityTypes && entityTypes.length > 0) {
        if (!entityTypes.includes(entity.name)) continue;
      }

      const p = entity.position;
      entities.push({
        name: entity.name,
        id: entity.id,
        type: entity.type ?? "unknown",
        position: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
        distance: Math.round(distance * 10) / 10,
      });
    }

    entities.sort((a, b) => a.distance - b.distance);

    return {
      ok: true,
      status: "success",
      data: { entities },
    };
  },
};

// ─── Export all observation skills ───────────────────────────────────────────

export const observationSkills = [
  observeState,
  observeInventory,
  observeNearby,
  observeNearbyBlocks,
  observeNearbyEntities,
  observeCraftable,
];
