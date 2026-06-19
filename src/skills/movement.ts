/**
 * Movement skills for mc-agent-service.
 * Handles navigation, following, and pathfinder operations.
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

// ─── move.to_position ───────────────────────────────────────────────────────

const ToPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  minDistance: z.number().min(0).max(64).default(2),
}).strict();

export const moveToPosition: SkillDefinition<z.infer<typeof ToPositionSchema>> = {
  name: "move.to_position",
  description: "Navigate to a world position using the pathfinder.",
  category: "movement",
  permissions: ["movement"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: ToPositionSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z, minDistance } = params;

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: `Moving to ${x}, ${y}, ${z}` });

    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    const goal = new goals.GoalNear(x, y, z, minDistance);

    try {
      await bot.pathfinder.goto(goal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Movement cancelled" };
      }
      return {
        ok: false,
        status: "failed",
        error: { code: "PATH_NOT_FOUND", message: `Pathfinding failed: ${msg}`, retryable: true },
      };
    }

    const pos = bot.entity.position;
    const distance = pos.distanceTo(new Vec3(x, y, z));
    ctx.progress({ current: 1, target: 1, unit: "navigation", message: "Arrived" });

    return {
      ok: true,
      status: "success",
      data: {
        reached: distance <= minDistance + 1,
        position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
        distance: Math.round(distance * 10) / 10,
      },
    };
  },
};

// ─── move.to_player ─────────────────────────────────────────────────────────

const ToPlayerSchema = z.object({
  username: z.string().min(1),
  distance: z.number().min(0.5).max(64).default(3),
}).strict();

export const moveToPlayer: SkillDefinition<z.infer<typeof ToPlayerSchema>> = {
  name: "move.to_player",
  description: "Navigate to a player by username.",
  category: "movement",
  permissions: ["movement", "entity.interact"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: ToPlayerSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { username, distance } = params;

    const player = bot.players[username];
    if (!player || !player.entity) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Player "${username}" not found or not loaded`, retryable: true },
      };
    }

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: `Moving to player ${username}` });

    const entity = player.entity;
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    const goal = new goals.GoalFollow(entity, distance);

    try {
      await bot.pathfinder.goto(goal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Movement cancelled" };
      }
      return {
        ok: false,
        status: "failed",
        error: { code: "PATH_NOT_FOUND", message: `Pathfinding failed: ${msg}`, retryable: true },
      };
    }

    const pos = bot.entity.position;
    const dist = pos.distanceTo(entity.position);
    ctx.progress({ current: 1, target: 1, unit: "navigation", message: "Arrived" });

    return {
      ok: true,
      status: "success",
      data: {
        reached: dist <= distance + 1,
        username,
        distance: Math.round(dist * 10) / 10,
      },
    };
  },
};

// ─── move.follow_player ─────────────────────────────────────────────────────

const FollowPlayerSchema = z.object({
  username: z.string().min(1),
  distance: z.number().min(0.5).max(64).default(4),
}).strict();

export const moveFollowPlayer: SkillDefinition<z.infer<typeof FollowPlayerSchema>> = {
  name: "move.follow_player",
  description: "Continuously follow a player until cancelled.",
  category: "movement",
  permissions: ["movement", "entity.interact"],
  timeoutMs: 300000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: FollowPlayerSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { username, distance } = params;

    const player = bot.players[username];
    if (!player || !player.entity) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Player "${username}" not found or not loaded`, retryable: true },
      };
    }

    const entity = player.entity;
    const move = new Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true);

    ctx.progress({ current: 0, target: 1, unit: "following", message: `Following ${username}` });
    ctx.log(`Now following player ${username} at distance ${distance}`);

    let cancelled = false;
    while (!checkCancelled(ctx)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Re-check player entity still exists
      const currentPlayer = bot.players[username];
      if (!currentPlayer || !currentPlayer.entity) {
        bot.pathfinder.stop();
        return {
          ok: false,
          status: "failed",
          error: { code: "TARGET_NOT_FOUND", message: `Lost sight of player "${username}"`, retryable: true },
        };
      }
    }

    // Cleanup on cancellation
    bot.pathfinder.stop();
    cancelled = true;

    return {
      ok: true,
      status: "success",
      data: { following: true, username, cancelled },
    };
  },
};

// ─── move.stay ──────────────────────────────────────────────────────────────

const StaySchema = z.object({
  seconds: z.number().int().min(-1).max(86400).default(30),
}).strict();

export const moveStay: SkillDefinition<z.infer<typeof StaySchema>> = {
  name: "move.stay",
  description: "Stay in the current position, pausing conflicting modes.",
  category: "movement",
  permissions: ["movement"],
  timeoutMs: 120000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: StaySchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { seconds } = params;

    // Clear pathfinder to stop movement
    bot.pathfinder.stop();

    ctx.progress({ current: 0, target: seconds === -1 ? 1 : seconds, unit: "seconds", message: "Staying in place" });

    const start = Date.now();
    let interrupted = false;

    while (!checkCancelled(ctx)) {
      if (seconds !== -1) {
        const elapsed = (Date.now() - start) / 1000;
        if (elapsed >= seconds) break;
        ctx.progress({ current: elapsed, target: seconds, unit: "seconds" });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (checkCancelled(ctx)) {
      interrupted = true;
    }

    const stayedSeconds = Math.round((Date.now() - start) / 1000);
    bot.pathfinder.stop();

    return {
      ok: true,
      status: "success",
      data: { stayedSeconds, interrupted },
    };
  },
};

// ─── move.to_block ─────────────────────────────────────────────────────────

const ToBlockSchema = z.object({
  blockType: z.string().min(1),
  minDistance: z.number().min(0).max(64).default(2),
  range: z.number().int().min(1).max(512).default(64),
}).strict();

export const moveToBlock: SkillDefinition<z.infer<typeof ToBlockSchema>> = {
  name: "move.to_block",
  description: "Find the nearest matching block and navigate near it.",
  category: "movement",
  permissions: ["movement"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: ToBlockSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { blockType, minDistance, range } = params;

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: `Searching for ${blockType}` });

    // Handle liquid source blocks specially
    let blocks: import("vec3").Vec3[];
    if (blockType === "water" || blockType === "lava") {
      blocks = bot.findBlocks({
        matching: (block) => block.name === blockType && (block as any).metadata === 0,
        maxDistance: range,
        count: 1,
      });
      if (blocks.length === 0) {
        // Fall back to any flowing block
        blocks = bot.findBlocks({
          matching: (block) => block.name === blockType,
          maxDistance: range,
          count: 1,
        });
      }
    } else {
      blocks = bot.findBlocks({
        matching: (block) => block.name === blockType,
        maxDistance: range,
        count: 1,
      });
    }

    if (blocks.length === 0) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Could not find any ${blockType} within ${range} blocks`, retryable: true },
      };
    }

    const blockPos = blocks[0]!;
    const block = bot.blockAt(blockPos);
    ctx.log(`Found ${blockType} at ${blockPos.x}, ${blockPos.y}, ${blockPos.z}`);

    ctx.progress({ current: 0.5, target: 1, unit: "navigation", message: `Moving to ${blockType}` });

    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, minDistance));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Movement cancelled" };
      }
      return {
        ok: false,
        status: "failed",
        error: { code: "PATH_NOT_FOUND", message: `Pathfinding failed: ${msg}`, retryable: true },
      };
    }

    const pos = bot.entity.position;
    const distance = pos.distanceTo(blockPos);
    ctx.progress({ current: 1, target: 1, unit: "navigation", message: "Arrived" });

    return {
      ok: true,
      status: "success",
      data: {
        reached: distance <= minDistance + 1,
        block: { name: block?.name ?? blockType, position: { x: blockPos.x, y: blockPos.y, z: blockPos.z } },
        distance: Math.round(distance * 10) / 10,
      },
    };
  },
};

// ─── move.avoid_enemies ────────────────────────────────────────────────────

const AvoidEnemiesSchema = z.object({
  distance: z.number().min(1).max(128).default(16),
}).strict();

export const moveAvoidEnemies: SkillDefinition<z.infer<typeof AvoidEnemiesSchema>> = {
  name: "move.avoid_enemies",
  description: "Move away from nearby hostile mobs until clear.",
  category: "movement",
  permissions: ["movement", "combat"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: AvoidEnemiesSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { distance } = params;

    const HOSTILE_NAMES = new Set([
      "zombie", "zombie_villager", "husk", "drowned",
      "skeleton", "stray", "wither_skeleton",
      "creeper", "spider", "cave_spider",
      "enderman", "witch", "blaze", "ghast",
      "slime", "magma_cube", "phantom",
      "piglin", "piglin_brute", "zombified_piglin",
      "hoglin", "zoglin", "warden",
      "guardian", "elder_guardian",
      "vindicator", "evoker", "pillager", "ravager",
      "vex", "shulker",
    ]);

    const findHostile = () =>
      bot.nearestEntity(
        (entity) => entity.name !== undefined && HOSTILE_NAMES.has(entity.name) &&
          bot.entity.position.distanceTo(entity.position) < distance
      );

    ctx.progress({ current: 0, target: 1, unit: "fleeing", message: "Avoiding enemies" });

    let enemy = findHostile();
    let avoided = false;

    while (enemy) {
      if (checkCancelled(ctx)) break;

      // Move away from this enemy
      const followGoal = new goals.GoalFollow(enemy, distance + 1);
      const invertedGoal = new goals.GoalInvert(followGoal);
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(invertedGoal, true);

      // Wait a bit for movement
      await new Promise((resolve) => setTimeout(resolve, 500));
      avoided = true;

      // Check for next enemy
      enemy = findHostile();
    }

    bot.pathfinder.stop();

    const enemiesRemaining = Object.values(bot.entities).filter(
      (e) => e.name !== undefined && HOSTILE_NAMES.has(e.name) &&
        bot.entity.position.distanceTo(e.position) < distance
    ).length;

    return {
      ok: true,
      status: "success",
      data: { avoided, distance, enemiesRemaining },
    };
  },
};

// ─── Export all movement skills ─────────────────────────────────────────────

export const movementSkills = [
  moveToPosition,
  moveToBlock,
  moveToPlayer,
  moveFollowPlayer,
  moveStay,
  moveAvoidEnemies,
];
