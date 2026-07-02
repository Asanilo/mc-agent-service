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

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMovements(bot: Bot): InstanceType<typeof Movements> {
  return new Movements(bot);
}

function findPlayerEntity(bot: Bot, username: string) {
  const listedEntity = bot.players[username]?.entity;
  if (listedEntity) return listedEntity;

  return Object.values(bot.entities).find(
    (entity) => entity.type === "player" && (entity as { username?: string }).username === username
  );
}

function checkCancelled(ctx: SkillExecutionContext): boolean {
  return ctx.signal.aborted;
}

// ─── move.to_position ───────────────────────────────────────────────────────

const ToPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  distance: z.number().min(0).max(64).default(2),
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
    const { x, y, z, distance } = params;

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: `Moving to ${x}, ${y}, ${z}` });

    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    const goal = new goals.GoalNear(x, y, z, distance);

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
    const actualDistance = pos.distanceTo(new Vec3(x, y, z));
    ctx.progress({ current: 1, target: 1, unit: "navigation", message: "Arrived" });

    return {
      ok: true,
      status: "success",
      data: {
        reached: actualDistance <= distance + 1,
        position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
        distance: Math.round(actualDistance * 10) / 10,
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

    const entity = findPlayerEntity(bot, username);
    if (!entity) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Player "${username}" not found or not loaded`, retryable: true },
      };
    }

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: `Moving to player ${username}` });

    const movements = createMovements(bot);
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

    const entity = findPlayerEntity(bot, username);
    if (!entity) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Player "${username}" not found`, retryable: true },
      };
    }

    const move = createMovements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true);

    ctx.progress({ current: 0, target: 1, unit: "following", message: `Following ${username}` });
    ctx.log(`Now following player ${username} at distance ${distance}`);

    while (!checkCancelled(ctx)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Re-check player entity still exists
      const currentEntity = findPlayerEntity(bot, username);
      if (!currentEntity) {
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

    return { ok: false, status: "cancelled", message: "Movement cancelled" };
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

    while (!checkCancelled(ctx)) {
      if (seconds !== -1) {
        const elapsed = (Date.now() - start) / 1000;
        if (elapsed >= seconds) break;
        ctx.progress({ current: elapsed, target: seconds, unit: "seconds" });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    bot.pathfinder.stop();

    if (checkCancelled(ctx)) {
      return { ok: false, status: "cancelled", message: "Movement cancelled" };
    }

    const stayedSeconds = Math.round((Date.now() - start) / 1000);
    return {
      ok: true,
      status: "success",
      data: { stayedSeconds, interrupted: false },
    };
  },
};

// ─── move.to_block ─────────────────────────────────────────────────────────

const ToBlockSchema = z.object({
  blockType: z.string().min(1),
  distance: z.number().min(0).max(64).default(2),
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
    const { blockType, distance: arrivalDistance, range: searchRange } = params;

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: `Searching for ${blockType}` });

    // Handle liquid source blocks specially
    let blocks: import("vec3").Vec3[];
    if (blockType === "water" || blockType === "lava") {
      blocks = bot.findBlocks({
        matching: (block) => block.name === blockType && (block as any).metadata === 0,
        maxDistance: searchRange,
        count: 1,
      });
      if (blocks.length === 0) {
        // Fall back to any flowing block
        blocks = bot.findBlocks({
          matching: (block) => block.name === blockType,
          maxDistance: searchRange,
          count: 1,
        });
      }
    } else {
      blocks = bot.findBlocks({
        matching: (block) => block.name === blockType,
        maxDistance: searchRange,
        count: 1,
      });
    }

    if (blocks.length === 0) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `Could not find any ${blockType} within ${searchRange} blocks`, retryable: true },
      };
    }

    const blockPos = blocks[0]!;
    const block = bot.blockAt(blockPos);
    ctx.log(`Found ${blockType} at ${blockPos.x}, ${blockPos.y}, ${blockPos.z}`);

    ctx.progress({ current: 0.5, target: 1, unit: "navigation", message: `Moving to ${blockType}` });

    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, arrivalDistance));
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
    const actualDistance = pos.distanceTo(blockPos);
    ctx.progress({ current: 1, target: 1, unit: "navigation", message: "Arrived" });

    return {
      ok: true,
      status: "success",
      data: {
        reached: actualDistance <= arrivalDistance + 1,
        block: { name: block?.name ?? blockType, position: { x: blockPos.x, y: blockPos.y, z: blockPos.z } },
        distance: Math.round(actualDistance * 10) / 10,
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

    ctx.progress({ current: 0, target: 1, unit: "fleeing", message: "Avoiding enemies" });

    let avoided = false;
    let wasCancelled = false;
    const MAX_ITERATIONS = 20;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (checkCancelled(ctx)) {
        wasCancelled = true;
        break;
      }

      // Find ALL hostiles within range
      const hostiles = Object.values(bot.entities).filter(
        (e) => e.name !== undefined && HOSTILE_NAMES.has(e.name) &&
          bot.entity.position.distanceTo(e.position) < distance
      );

      if (hostiles.length === 0) break;

      // Calculate centroid of ALL hostiles
      let avgX = 0, avgY = 0, avgZ = 0;
      for (const h of hostiles) {
        avgX += h.position.x;
        avgY += h.position.y;
        avgZ += h.position.z;
      }
      avgX /= hostiles.length;
      avgY /= hostiles.length;
      avgZ /= hostiles.length;

      // Move away from centroid (away from all enemies)
      const centroid = new Vec3(avgX, avgY, avgZ);
      const avoidGoal = new goals.GoalNear(centroid.x, centroid.y, centroid.z, distance);
      const invertedGoal = new goals.GoalInvert(avoidGoal);
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(invertedGoal, true);

      // Wait a bit for movement
      await new Promise((resolve) => setTimeout(resolve, 1000));
      avoided = true;
    }

    bot.pathfinder.stop();

    if (wasCancelled) {
      return { ok: false, status: "cancelled", message: "Movement cancelled" };
    }

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

// ─── move.to_entity ─────────────────────────────────────────────────────────

const ToEntitySchema = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.number().int().nonnegative().optional(),
  distance: z.number().min(0.5).max(64).default(2),
}).strict().refine((data) => data.entityType !== undefined || data.entityId !== undefined, {
  message: "Must provide either entityType or entityId",
});

export const moveToEntity: SkillDefinition<z.infer<typeof ToEntitySchema>> = {
  name: "move.to_entity",
  description: "Navigate to an entity by type or ID.",
  category: "movement",
  permissions: ["movement", "entity.interact"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: ToEntitySchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { entityType, entityId, distance } = params;

    let target: import("prismarine-entity").Entity | undefined;

    if (entityId !== undefined) {
      target = bot.entities[entityId];
      if (!target) {
        return {
          ok: false,
          status: "failed",
          error: { code: "TARGET_NOT_FOUND", message: `Entity with ID ${entityId} not found`, retryable: true },
        };
      }
    }

    if (!target && entityType) {
      const entities = Object.values(bot.entities).filter((e) => e !== bot.entity && e.name === entityType);
      entities.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      target = entities[0];
      if (!target) {
        return {
          ok: false,
          status: "failed",
          error: { code: "TARGET_NOT_FOUND", message: `No ${entityType} found nearby`, retryable: true },
        };
      }
    }

    if (!target) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: "No target specified or found", retryable: true },
      };
    }

    ctx.progress({ current: 0, target: 1, unit: "navigation", message: `Moving to ${target.name}` });

    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(new goals.GoalFollow(target, distance));
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
    const dist = pos.distanceTo(target.position);
    ctx.progress({ current: 1, target: 1, unit: "navigation", message: "Arrived" });

    return {
      ok: true,
      status: "success",
      data: {
        reached: dist <= distance + 1,
        entity: { name: target.name, id: target.id },
        distance: Math.round(dist * 10) / 10,
      },
    };
  },
};

// ─── move.away ──────────────────────────────────────────────────────────────

const MoveAwaySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  distance: z.number().min(1).max(128).default(16),
}).strict();

export const moveAway: SkillDefinition<z.infer<typeof MoveAwaySchema>> = {
  name: "move.away",
  description: "Move away from a target position.",
  category: "movement",
  permissions: ["movement"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: MoveAwaySchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { x, y, z, distance } = params;

    const targetPos = new Vec3(x, y, z);
    const botPos = bot.entity.position;

    ctx.progress({ current: 0, target: 1, unit: "fleeing", message: `Moving away from ${x}, ${y}, ${z}` });

    // Use GoalInvert on a GoalNear to move in the opposite direction
    const followGoal = new goals.GoalFollow({ position: targetPos } as any, distance);
    const invertedGoal = new goals.GoalInvert(followGoal);
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(invertedGoal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Movement cancelled" };
      }
      // Pathfinder may throw when it can't find a path far enough — that's ok
      ctx.log(`Pathfinder stopped: ${msg}`);
    }

    bot.pathfinder.stop();
    const newPos = bot.entity.position;
    const actualDistance = newPos.distanceTo(targetPos);
    ctx.progress({ current: 1, target: 1, unit: "fleeing", message: "Moved away" });

    return {
      ok: true,
      status: "success",
      data: {
        moved: true,
        position: { x: Math.round(newPos.x), y: Math.round(newPos.y), z: Math.round(newPos.z) },
        distanceFromTarget: Math.round(actualDistance * 10) / 10,
      },
    };
  },
};

export const movementSkills = [
  moveToPosition,
  moveToBlock,
  moveToPlayer,
  moveFollowPlayer,
  moveStay,
  moveAvoidEnemies,
  moveToEntity,
  moveAway,
];
