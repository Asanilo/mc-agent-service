/**
 * Observation skills for mc-agent-service.
 * Read-only skills that return bot state, inventory, nearby entities, and craftable items.
 */
import { z } from "zod";
import type { Bot } from "mineflayer";
import type { SkillDefinition, SkillExecutionContext } from "../bots/skill-executor.js";
import type { SkillResult } from "../types/skills.js";
import { Vec3 } from "vec3";

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
  maxDistance: z.number().min(1).max(256).default(16),
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
    const { maxDistance: scanDistance, includePlayers, includeEntities, includeBlockTypes } = params;

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
  blockTypes: z.array(z.string().min(1)).optional(),
  distance: z.number().int().min(1).max(256).default(16),
  count: z.number().int().min(1).max(10000).default(100),
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
    const { blockTypes, distance, count: num } = params;

    const positions = bot.findBlocks({
      matching: (block) => {
        if (block.name === "air" || block.name === "cave_air") return false;
        if (blockTypes && blockTypes.length > 0) {
          return blockTypes.includes(block.name);
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
  maxDistance: z.number().int().min(1).max(256).default(16),
  entityTypes: z.array(z.string().min(1)).optional(),
  includePlayers: z.boolean().default(true),
  count: z.number().int().min(1).max(1000).default(100),
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
    const { maxDistance, entityTypes, includePlayers, count: maxCount } = params;

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

      // Skip players if not included
      if (!includePlayers && entity.type === "player") continue;

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
      data: { entities: entities.slice(0, maxCount) },
    };
  },
};

// ─── Export all observation skills ───────────────────────────────────────────

// ─── observe.block_at ───────────────────────────────────────────────────────

const BlockAtSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
}).strict();

export const observeBlockAt: SkillDefinition<z.infer<typeof BlockAtSchema>> = {
  name: "observe.block_at",
  description: "Return block info at a specific position.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: BlockAtSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z } = params;

    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `No block data at ${x},${y},${z}`, retryable: false },
      };
    }

    return {
      ok: true,
      status: "success",
      data: {
        name: block.name,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        hardness: block.hardness,
        harvestable: block.harvestTools !== undefined,
      },
    };
  },
};

// ─── observe.nearest_free_space ─────────────────────────────────────────────

const NearestFreeSpaceSchema = z.object({
  maxDistance: z.number().int().min(1).max(64).default(16),
}).strict();

export const observeNearestFreeSpace: SkillDefinition<z.infer<typeof NearestFreeSpaceSchema>> = {
  name: "observe.nearest_free_space",
  description: "Find the nearest air block suitable for block placement.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: NearestFreeSpaceSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { maxDistance } = params;

    const emptyNames = ["air", "cave_air", "water", "lava", "grass", "short_grass", "tall_grass", "snow", "dead_bush", "fern"];

    const positions = bot.findBlocks({
      matching: (block) => block.name === "air" || block.name === "cave_air",
      maxDistance,
      count: 27,
    });

    for (const pos of positions) {
      // Check if there's a solid block adjacent to place against
      const neighbors = [
        pos.offset(0, -1, 0), pos.offset(0, 1, 0),
        pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1), pos.offset(0, 0, -1),
      ];
      for (const n of neighbors) {
        const nBlock = bot.blockAt(n);
        if (nBlock && !emptyNames.includes(nBlock.name)) {
          const dist = bot.entity.position.distanceTo(pos);
          return {
            ok: true,
            status: "success",
            data: {
              position: { x: pos.x, y: pos.y, z: pos.z },
              distance: Math.round(dist * 10) / 10,
              adjacentBlock: nBlock.name,
            },
          };
        }
      }
    }

    return {
      ok: false,
      status: "failed",
      error: { code: "TARGET_NOT_FOUND", message: `No free space with adjacent solid block found within ${maxDistance} blocks`, retryable: true },
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// Phase 3 — Mod-aware observation skills
// ════════════════════════════════════════════════════════════════════════════

import { getKnowledgeProvider } from "../knowledge/index.js";

// ─── observe.recipe ─────────────────────────────────────────────────────

const ObserveRecipeSchema = z.object({
  itemId: z.string().min(1),
}).strict();

export const observeRecipe: SkillDefinition<z.infer<typeof ObserveRecipeSchema>> = {
  name: "observe.recipe",
  description: "Look up the crafting recipe for an item by ID or display name.",
  category: "observation",
  permissions: [],
  timeoutMs: 10000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveRecipeSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { itemId } = params;
    const knowledge = getKnowledgeProvider();

    // 1. Try Mineflayer's built-in recipe lookup
    const item = bot.registry.itemsByName[itemId]
      ?? Object.values(bot.registry.itemsByName).find((i: any) => i.name === itemId || i.displayName === itemId);

    if (item) {
      try {
        const recipes = bot.recipesFor((item as any).id, null, 1, null);
        if (recipes && recipes.length > 0) {
          const recipe = recipes[0]!;
          const ingredients = (recipe.ingredients ?? []).map((ing: any) => ({
            item: bot.registry.items[ing.id]?.name ?? `item_${ing.id}`,
            count: ing.count,
          }));
          return {
            ok: true,
            status: "success",
            data: {
              found: true,
              source: "vanilla",
              item: itemId,
              outputCount: recipe.result?.count ?? 1,
              ingredients,
              machine: null,
            },
          };
        }
      } catch {
        // Recipe lookup failed — fall through to knowledge layer
      }
    }

    // 2. Try knowledge layer (mod recipes)
    const modRecipe = knowledge.getRecipe(itemId);
    if (modRecipe) {
      return {
        ok: true,
        status: "success",
        data: {
          found: true,
          source: "knowledge",
          item: modRecipe.outputItem,
          outputCount: modRecipe.outputCount,
          ingredients: modRecipe.ingredients,
          machine: modRecipe.machine,
          modId: modRecipe.modId,
        },
      };
    }

    // 3. Unknown
    return {
      ok: true,
      status: "success",
      data: {
        found: false,
        item: itemId,
        message: "Recipe not available. The knowledge database may not be loaded for this modpack.",
      },
    };
  },
};

// ─── observe.recipe_usage ──────────────────────────────────────────────

const ObserveRecipeUsageSchema = z.object({
  itemId: z.string().min(1),
}).strict();

export const observeRecipeUsage: SkillDefinition<z.infer<typeof ObserveRecipeUsageSchema>> = {
  name: "observe.recipe_usage",
  description: "Find recipes that use this item as an ingredient.",
  category: "observation",
  permissions: [],
  timeoutMs: 15000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveRecipeUsageSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { itemId } = params;
    const knowledge = getKnowledgeProvider();

    const usages: Array<{ outputItem: string; outputCount: number; source: string }> = [];

    // 1. Scan vanilla recipes for usage
    try {
      const item = bot.registry.itemsByName[itemId]
        ?? Object.values(bot.registry.itemsByName).find((i: any) => i.name === itemId || i.displayName === itemId);
      if (item) {
        const itemIdNum = (item as any).id;
        for (const [name, candidate] of Object.entries(bot.registry.itemsByName)) {
          try {
            const recipes = bot.recipesFor((candidate as any).id, null, 1, null);
            if (recipes && recipes.length > 0) {
              for (const recipe of recipes) {
                const usesItem = recipe.ingredients?.some((ing: any) => ing.id === itemIdNum);
                if (usesItem) {
                  usages.push({
                    outputItem: name,
                    outputCount: recipe.result?.count ?? 1,
                    source: "vanilla",
                  });
                }
              }
            }
          } catch {
            // skip
          }
        }
      }
    } catch {
      // vanilla scan failed
    }

    // 2. Try knowledge layer
    const modUsages = knowledge.getRecipeUsage(itemId);
    for (const r of modUsages) {
      usages.push({
        outputItem: r.outputItem,
        outputCount: r.outputCount,
        source: "knowledge",
      });
    }

    return {
      ok: true,
      status: "success",
      data: {
        item: itemId,
        count: usages.length,
        usages: usages.slice(0, 50), // cap
      },
    };
  },
};

// ─── observe.jade_look_at ───────────────────────────────────────────────

const JadeLookAtSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
}).strict();

export const observeJadeLookAt: SkillDefinition<z.infer<typeof JadeLookAtSchema>> = {
  name: "observe.jade_look_at",
  description: "Return block info at a position, Jade-style.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: JadeLookAtSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z } = params;
    const knowledge = getKnowledgeProvider();
    const dimension = (bot as any).game?.dimension ?? "overworld";

    // 1. Built-in block data from Mineflayer
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block || block.name === "air" || block.name === "cave_air") {
      return {
        ok: true,
        status: "success",
        data: {
          found: false,
          position: { x, y, z },
          message: "No solid block at this position",
        },
      };
    }

    const baseInfo = {
      name: block.name,
      displayName: block.displayName ?? block.name,
      hardness: block.hardness ?? -1,
      harvestTools: block.harvestTools
        ? Object.entries(block.harvestTools as Record<string, boolean>)
            .filter(([, v]) => v)
            .map(([k]) => k)
        : [],
    };

    // 2. Try knowledge layer for Jade-style tooltip
    const jadeInfo = knowledge.getBlockInfo(x, y, z, dimension);
    if (jadeInfo) {
      return {
        ok: true,
        status: "success",
        data: {
          found: true,
          source: "knowledge",
          ...jadeInfo,
        },
      };
    }

    // 3. Fall back to vanilla block info
    return {
      ok: true,
      status: "success",
      data: {
        found: true,
        source: "vanilla",
        ...baseInfo,
        modId: block.name.includes(":") ? block.name.split(":")[0]! : "minecraft",
        harvestLevel: null,
        tooltip: [
          `Name: ${baseInfo.displayName}`,
          `Hardness: ${baseInfo.hardness}`,
          baseInfo.harvestTools.length > 0 ? `Tool: ${baseInfo.harvestTools.join(", ")}` : "No special tool required",
        ],
      },
    };
  },
};

// ─── observe.quest_progress ─────────────────────────────────────────────

const ObserveQuestProgressSchema = z.object({}).strict();

export const observeQuestProgress: SkillDefinition<z.infer<typeof ObserveQuestProgressSchema>> = {
  name: "observe.quest_progress",
  description: "Get current FTB Quest chapter and active task list.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveQuestProgressSchema,
  async run(_ctx, _params) {
    const knowledge = getKnowledgeProvider();
    const progress = knowledge.getQuestProgress();

    if (!progress) {
      return {
        ok: true,
        status: "success",
        data: {
          available: false,
          message: "Quest data not available. The knowledge database may not be loaded for this modpack.",
        },
      };
    }

    return {
      ok: true,
      status: "success",
      data: {
        available: true,
        ...progress,
      },
    };
  },
};

// ─── observe.quest_tree ─────────────────────────────────────────────────

const ObserveQuestTreeSchema = z.object({
  depth: z.number().int().min(1).max(5).default(3),
}).strict();

export const observeQuestTree: SkillDefinition<z.infer<typeof ObserveQuestTreeSchema>> = {
  name: "observe.quest_tree",
  description: "Get the full quest tree, capped by depth.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveQuestTreeSchema,
  async run(_ctx, params) {
    const knowledge = getKnowledgeProvider();
    const tree = knowledge.getQuestTree(params.depth);

    if (!tree) {
      return {
        ok: true,
        status: "success",
        data: {
          available: false,
          message: "Quest tree not available. The knowledge database may not be loaded for this modpack.",
        },
      };
    }

    return {
      ok: true,
      status: "success",
      data: {
        available: true,
        depth: params.depth,
        tree,
      },
    };
  },
};

// ─── observe.guide_search ───────────────────────────────────────────────

const ObserveGuideSearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).default(5),
}).strict();

export const observeGuideSearch: SkillDefinition<z.infer<typeof ObserveGuideSearchSchema>> = {
  name: "observe.guide_search",
  description: "Search Patchouli-style guide books.",
  category: "observation",
  permissions: [],
  timeoutMs: 10000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveGuideSearchSchema,
  async run(_ctx, params) {
    const knowledge = getKnowledgeProvider();
    const entries = knowledge.searchGuide(params.query);

    if (entries.length === 0) {
      return {
        ok: true,
        status: "success",
        data: {
          query: params.query,
          count: 0,
          results: [],
          message: "No guide entries found. The knowledge database may not be loaded for this modpack.",
        },
      };
    }

    return {
      ok: true,
      status: "success",
      data: {
        query: params.query,
        count: entries.length,
        results: entries.slice(0, params.maxResults),
      },
    };
  },
};

// ─── observe.mod_info ───────────────────────────────────────────────────

const ObserveModInfoSchema = z.object({
  modId: z.string().min(1),
}).strict();

export const observeModInfo: SkillDefinition<z.infer<typeof ObserveModInfoSchema>> = {
  name: "observe.mod_info",
  description: "Get metadata summary for a mod by ID.",
  category: "observation",
  permissions: [],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: true,
  parameters: ObserveModInfoSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { modId } = params;
    const knowledge = getKnowledgeProvider();

    // 1. Try knowledge layer
    const modInfo = knowledge.getModInfo(modId);
    if (modInfo) {
      return {
        ok: true,
        status: "success",
        data: {
          found: true,
          source: "knowledge",
          modId: modInfo.modId,
          displayName: modInfo.displayName,
          version: modInfo.version,
          itemCount: modInfo.itemCount,
          blockCount: modInfo.blockCount,
          description: modInfo.description,
        },
      };
    }

    // 2. Fall back to basic registry scan
    const modItems = Object.entries(bot.registry.itemsByName).filter(([name]) =>
      name.startsWith(`${modId}:`)
    );
    const modBlocks = Object.entries(bot.registry.blocksByName ?? {}).filter(([name]: [string, unknown]) =>
      name.startsWith(`${modId}:`)
    );

    if (modItems.length === 0 && modBlocks.length === 0) {
      return {
        ok: true,
        status: "success",
        data: {
          found: false,
          modId,
          message: "No items or blocks found for this mod in the current registry. The knowledge database may provide more detail.",
        },
      };
    }

    return {
      ok: true,
      status: "success",
      data: {
        found: true,
        source: "registry",
        modId,
        displayName: modId,
        version: "unknown",
        itemCount: modItems.length,
        blockCount: modBlocks.length,
        description: `${modItems.length} items, ${modBlocks.length} blocks registered`,
      },
    };
  },
};

// ─── Export all observation skills ────────────────────────────────────────

export const observationSkills = [
  observeState,
  observeInventory,
  observeNearby,
  observeNearbyBlocks,
  observeNearbyEntities,
  observeCraftable,
  observeBlockAt,
  observeNearestFreeSpace,
  // Phase 3 — mod-aware observation
  observeRecipe,
  observeRecipeUsage,
  observeJadeLookAt,
  observeQuestProgress,
  observeQuestTree,
  observeGuideSearch,
  observeModInfo,
];
