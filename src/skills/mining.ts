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
  distance: z.number().int().min(1).max(128).default(32),
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
    const { blockType, num, distance } = params;

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
        maxDistance: distance,
        count: 1,
      });

      if (blocks.length === 0) {
        ctx.log(collected === 0 ? `No ${blockType} found within ${distance} blocks` : `No more ${blockType} found`);
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

// ─── mine.dig_down ─────────────────────────────────────────────────────────

const DigDownSchema = z.object({
  distance: z.number().int().min(1).max(64).default(10),
}).strict();

export const mineDigDown: SkillDefinition<z.infer<typeof DigDownSchema>> = {
  name: "mine.dig_down",
  description: "Dig downward from the bot's current position for a bounded number of blocks.",
  category: "mining",
  permissions: ["movement", "block.break", "inventory"],
  timeoutMs: 120000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: DigDownSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { distance } = params;

    const startY = Math.floor(bot.entity.position.y);
    const targetY = startY - distance;

    const totalBlocks = distance;
    ctx.progress({ current: 0, target: totalBlocks, unit: "blocks", message: `Digging down ${distance} blocks` });

    let dug = 0;
    let stoppedReason: string | undefined;

    for (let y = startY - 1; y >= targetY; y--) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Digging cancelled" };
      }

      const pos = bot.entity.position;
      const blockBelow = bot.blockAt(new Vec3(Math.floor(pos.x), y, Math.floor(pos.z)));
      const blockUnderneath = bot.blockAt(new Vec3(Math.floor(pos.x), y - 1, Math.floor(pos.z)));

      if (!blockBelow || !blockUnderneath) {
        stoppedReason = "Reached world boundary";
        break;
      }

      // Safety: check for liquids
      if (blockBelow.name === "lava" || blockBelow.name === "water" ||
          blockUnderneath.name === "lava" || blockUnderneath.name === "water") {
        stoppedReason = `Reached ${blockBelow.name === "lava" || blockBelow.name === "water" ? blockBelow.name : blockUnderneath.name}`;
        break;
      }

      // Safety: check for dangerous drops (4+ blocks of air below)
      let airBlocks = 0;
      let checkBlock: ReturnType<typeof bot.blockAt> = blockUnderneath;
      for (let j = 0; j < 4; j++) {
        if (!checkBlock || (checkBlock.name !== "air" && checkBlock.name !== "cave_air")) break;
        airBlocks++;
        checkBlock = bot.blockAt(checkBlock.position.offset(0, -1, 0));
      }
      if (airBlocks >= 4) {
        stoppedReason = "Unsafe drop below next block";
        break;
      }

      // Skip air blocks
      if (blockBelow.name === "air" || blockBelow.name === "cave_air") {
        dug++;
        ctx.progress({ current: dug, target: totalBlocks, unit: "blocks" });
        continue;
      }

      // Navigate to position above target
      if (bot.entity.position.distanceTo(new Vec3(Math.floor(pos.x), y + 1, Math.floor(pos.z))) > 4) {
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new goals.GoalNear(Math.floor(pos.x), y + 1, Math.floor(pos.z), 4));
        } catch {
          // May fail if path is blocked, try to continue
        }
      }

      // Dig the block
      try {
        await bot.dig(blockBelow);
        dug++;
        ctx.progress({ current: dug, target: totalBlocks, unit: "blocks" });
      } catch (err: unknown) {
        if (checkCancelled(ctx)) {
          return { ok: false, status: "cancelled", message: "Digging cancelled" };
        }
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`Failed to dig block at Y=${y}: ${msg}`);
        stoppedReason = `Dig failed at Y=${y}`;
        break;
      }
    }

    if (dug === 0) {
      return {
        ok: false,
        status: "failed",
        error: { code: "SKILL_FAILED", message: stoppedReason ?? "Could not dig any blocks", retryable: true },
      };
    }
    return {
      ok: true,
      status: "success",
      data: { dug, requested: distance, stoppedReason },
      message: stoppedReason ? `Dug ${dug} blocks, stopped: ${stoppedReason}` : `Dug ${dug} blocks downward`,
    };
  },
};

// ─── mine.go_to_surface ────────────────────────────────────────────────────

const GoToSurfaceSchema = z.object({}).strict();

export const mineGoToSurface: SkillDefinition<z.infer<typeof GoToSurfaceSchema>> = {
  name: "mine.go_to_surface",
  description: "Navigate upward to the surface.",
  category: "mining",
  permissions: ["movement"],
  timeoutMs: 120000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: GoToSurfaceSchema,
  async run(ctx, _params) {
    const bot = ctx.bot;
    const pos = bot.entity.position;

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: "Finding surface" });

    // Scan upward from current position to find the highest non-air block
    let targetY = -1;
    for (let y = 360; y > -64; y--) {
      const block = bot.blockAt(new Vec3(Math.floor(pos.x), y, Math.floor(pos.z)));
      if (block && block.name !== "air" && block.name !== "cave_air") {
        targetY = y + 1; // Stand on top of the solid block
        break;
      }
    }

    if (targetY === -1) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: "Could not find surface", retryable: false },
      };
    }

    ctx.log(`Surface found at Y=${targetY}`);
    ctx.progress({ current: 0.5, target: 1, unit: "navigation", message: `Moving to surface at Y=${targetY}` });

    // Use pathfinder to navigate to the surface position
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(new goals.GoalNear(Math.floor(pos.x), targetY, Math.floor(pos.z), 0));
    } catch (err: unknown) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Movement cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "PATH_NOT_FOUND", message: `Failed to reach surface: ${msg}`, retryable: true },
      };
    }

    const finalPos = bot.entity.position;
    ctx.progress({ current: 1, target: 1, unit: "navigation", message: "Reached surface" });

    return {
      ok: true,
      status: "success",
      data: {
        reached: true,
        targetY,
        position: { x: Math.round(finalPos.x), y: Math.round(finalPos.y), z: Math.round(finalPos.z) },
      },
    };
  },
};

// ─── Export all mining skills ────────────────────────────────────────────────

export const miningSkills = [
  mineCollectBlocks,
  mineBreakBlockAt,
  mineDigDown,
  mineGoToSurface,
];
