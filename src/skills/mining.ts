/**
 * Mining skills for mc-agent-service.
 * Handles block collection and breaking.
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

// ─── Helper: resource aliases (mirrors Mindcraft) ───────────────────────────

function resolveBlockTypes(blockType: string): string[] {
  const types = [blockType];
  if (["coal", "diamond", "emerald", "iron", "gold", "lapis_lazuli", "redstone"].includes(blockType)) {
    types.push(blockType + "_ore");
  }
  if (blockType.endsWith("_ore")) {
    types.push("deepslate_" + blockType);
  }
  if (blockType === "dirt") {
    types.push("grass_block");
  }
  if (blockType === "cobblestone") {
    types.push("stone");
  }
  return types;
}

// ─── mine.collect_blocks ────────────────────────────────────────────────────

const CollectBlocksSchema = z.object({
  blockType: z.string().min(1),
  num: z.number().int().min(1).default(1),
  radius: z.number().int().min(1).max(128).default(32),
}).strict();

export const mineCollectBlocks: SkillDefinition<z.infer<typeof CollectBlocksSchema>> = {
  name: "mine.collect_blocks",
  description: "Collect nearby blocks of the specified type.",
  category: "mining",
  permissions: ["movement", "block.break", "inventory"],
  timeoutMs: 120000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: CollectBlocksSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { blockType, num, radius } = params;

    const blockTypes = resolveBlockTypes(blockType);
    const isLiquid = blockType === "lava" || blockType === "water";

    let collected = 0;
    ctx.progress({ current: 0, target: num, unit: "blocks", message: `Collecting ${blockType}` });

    for (let i = 0; i < num; i++) {
      if (checkCancelled(ctx)) break;

      const blocks = bot.findBlocks({
        matching: (block) => {
          if (!blockTypes.includes(block.name)) return false;
          if (isLiquid) return block.metadata === 0;
          return true;
        },
        maxDistance: radius,
        count: 1,
      });

      if (blocks.length === 0) {
        ctx.log(collected === 0 ? `No ${blockType} found within ${radius} blocks` : `No more ${blockType} found`);
        break;
      }

      const blockPos = blocks[0];
      const block = bot.blockAt(blockPos!);
      if (!block || block.name === "air") continue;

      try {
        if (bot.entity.position.distanceTo(block.position) > 4.5) {
          const movements = new Movements(bot);
          bot.pathfinder.setMovements(movements);
          await bot.pathfinder.goto(
            new goals.GoalNear(block.position.x, block.position.y, block.position.z, 4)
          );
        }

        if ((bot as any).collectBlock && !isLiquid) {
          await (bot as any).collectBlock.collect(block);
        } else {
          if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem(bot.registry.itemsByName["bucket"]!.id, null, false);
            if (!bucket) {
              return {
                ok: false,
                status: "failed",
                error: { code: "MISSING_TOOL", message: "Need a bucket to collect liquids", retryable: false },
              };
            }
            await bot.equip(bucket, "hand");
            await bot.activateBlock(block);
          } else {
            // Try to equip best tool
            try {
              await (bot as any).tool?.equipForBlock(block);
            } catch {
              // tool equip may not be available
            }
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!block.canHarvest(itemId)) {
              return {
                ok: false,
                status: "failed",
                error: { code: "MISSING_TOOL", message: `Cannot harvest ${blockType} with current tools`, retryable: false },
              };
            }
            await bot.dig(block);
          }
        }

        collected++;
        ctx.progress({ current: collected, target: num, unit: "blocks" });
      } catch (err: unknown) {
        if (checkCancelled(ctx)) break;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`Failed to collect ${blockType}: ${msg}`);
        continue;
      }
    }

    return {
      ok: collected > 0,
      status: checkCancelled(ctx) ? "cancelled" : "success",
      data: { collected, blockType, requested: num },
      message: `Collected ${collected} of ${num} requested ${blockType}`,
    };
  },
};

// ─── mine.break_block_at ────────────────────────────────────────────────────

const BreakBlockAtSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
}).strict();

export const mineBreakBlockAt: SkillDefinition<z.infer<typeof BreakBlockAtSchema>> = {
  name: "mine.break_block_at",
  description: "Break the block at the specified coordinates.",
  category: "mining",
  permissions: ["movement", "block.break", "inventory"],
  timeoutMs: 30000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: BreakBlockAtSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z } = params;

    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block || block.name === "air" || block.name === "water" || block.name === "lava") {
      return {
        ok: false,
        status: "failed",
        error: {
          code: "UNSAFE_BLOCK",
          message: `Block at ${x},${y},${z} is ${block?.name ?? "unknown"}, cannot break`,
          retryable: false,
        },
      };
    }

    ctx.progress({ current: 0, target: 1, unit: "block", message: `Breaking ${block.name} at ${x},${y},${z}` });

    try {
      if (bot.entity.position.distanceTo(block.position) > 4.5) {
        const movements = new Movements(bot);
        (movements as any).canPlaceOn = false;
        (movements as any).allow1by1towers = false;
        bot.pathfinder.setMovements(movements);
        await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 4));
      }

      if (bot.game.gameMode !== "creative") {
        try {
          await (bot as any).tool?.equipForBlock(block);
        } catch {
          // tool equip may not be available
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) {
          return {
            ok: false,
            status: "failed",
            error: { code: "MISSING_TOOL", message: `Cannot harvest ${block.name} with current tools`, retryable: false },
          };
        }
      }

      await bot.dig(block);
      ctx.progress({ current: 1, target: 1, unit: "block", message: "Done" });

      return {
        ok: true,
        status: "success",
        data: { broken: true, block: block.name, position: { x, y, z } },
      };
    } catch (err: unknown) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Block breaking cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to break block: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── Export all mining skills ────────────────────────────────────────────────

export const miningSkills = [
  mineCollectBlocks,
  mineBreakBlockAt,
];
