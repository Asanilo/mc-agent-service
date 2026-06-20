/**
 * Combat skills for mc-agent-service.
 * Handles attacking mobs and self-defense.
 */
import { z } from "zod";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { SkillDefinition, SkillExecutionContext } from "../bots/skill-executor.js";
import type { SkillResult } from "../types/skills.js";
import pf from "mineflayer-pathfinder";

const { Movements, goals } = pf;
const { GoalFollow, GoalInvert } = goals;

// ─── Helper: check cancellation ─────────────────────────────────────────────

function checkCancelled(ctx: SkillExecutionContext): boolean {
  return ctx.signal.aborted;
}

// ─── Helper: hostile mob detection ──────────────────────────────────────────

const HOSTILE_MOBS = new Set([
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

function isHostile(entity: Entity): boolean {
  return entity.name !== undefined && HOSTILE_MOBS.has(entity.name);
}

// ─── Helper: equip best weapon ──────────────────────────────────────────────

async function equipBestWeapon(bot: Bot): Promise<void> {
  const items = bot.inventory.items();
  // Prefer swords, then axes, then pickaxes, then shovels
  let weapons = items.filter(
    (item) => item.name.includes("sword") || (item.name.includes("axe") && !item.name.includes("pickaxe"))
  );
  if (weapons.length === 0) {
    weapons = items.filter((item) => item.name.includes("pickaxe") || item.name.includes("shovel"));
  }
  if (weapons.length === 0) return;

  // Sort by attack damage (highest first)
  weapons.sort((a, b) => ((b as any).attackDamage ?? 0) - ((a as any).attackDamage ?? 0));
  const weapon = weapons[0];
  if (weapon) await bot.equip(weapon, "hand");
}

// ─── Helper: get nearby entities ────────────────────────────────────────────

function getNearbyEntities(bot: Bot, maxDistance: number): Entity[] {
  const entities: { entity: Entity; distance: number }[] = [];
  for (const entity of Object.values(bot.entities)) {
    const distance = entity.position.distanceTo(bot.entity.position);
    if (distance <= maxDistance) {
      entities.push({ entity, distance });
    }
  }
  entities.sort((a, b) => a.distance - b.distance);
  return entities.map((e) => e.entity);
}

// ─── combat.attack_nearest ──────────────────────────────────────────────────

const AttackNearestSchema = z.object({
  mobType: z.string().min(1),
  kill: z.boolean().default(true),
}).strict();

export const combatAttackNearest: SkillDefinition<z.infer<typeof AttackNearestSchema>> = {
  name: "combat.attack_nearest",
  description: "Attack the nearest mob of the specified type.",
  category: "combat",
  permissions: ["movement", "combat", "inventory"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: AttackNearestSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { mobType, kill } = params;

    ctx.progress({ current: 0, target: 1, unit: "attack", message: `Searching for ${mobType}` });

    // Find the nearest entity matching the mob type
    const entities = getNearbyEntities(bot, 24);
    const mob = entities.find((e) => e.name === mobType);

    if (!mob) {
      return {
        ok: false,
        status: "failed",
        error: { code: "TARGET_NOT_FOUND", message: `No ${mobType} found nearby`, retryable: true },
      };
    }

    ctx.log(`Found ${mobType} at distance ${Math.round(bot.entity.position.distanceTo(mob.position))}`);

    await equipBestWeapon(bot);

    if (!kill) {
      // Single attack
      if (bot.entity.position.distanceTo(mob.position) > 5) {
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new GoalFollow(mob, 3));
        } catch {
          // Entity might have moved
        }
      }
      await bot.attack(mob);

      return {
        ok: true,
        status: "success",
        data: {
          attacked: true,
          killed: false,
          entity: { name: mob.name, id: mob.id },
        },
      };
    }

    // Kill mode: use pvp plugin
    ctx.progress({ current: 0, target: 1, unit: "kill", message: `Attacking ${mobType}` });

    const pvp = (bot as any).pvp;
    if (pvp) {
      pvp.attack(mob);

      // Wait until the mob is dead or out of range
      let timeout = 0;
      const maxTimeout = 30000; // 30 seconds max
      while (timeout < maxTimeout) {
        if (checkCancelled(ctx)) {
          pvp.stop();
          return { ok: false, status: "cancelled", message: "Attack cancelled" };
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
        timeout += 500;

        // Check if entity is gone (dead or despawned)
        const stillExists = bot.entities[mob.id];
        if (!stillExists) break;
      }

      pvp.stop();

      return {
        ok: true,
        status: "success",
        data: {
          attacked: true,
          killed: !bot.entities[mob.id],
          entity: { name: mob.name, id: mob.id },
        },
      };
    } else {
      // Fallback: manual attack loop
      let attacks = 0;
      while (attacks < 100) {
        if (checkCancelled(ctx)) {
          return { ok: false, status: "cancelled", message: "Attack cancelled" };
        }

        const stillExists = bot.entities[mob.id];
        if (!stillExists) break;

        if (bot.entity.position.distanceTo(mob.position) > 4) {
          const movements = new Movements(bot);
          bot.pathfinder.setMovements(movements);
          try {
            await bot.pathfinder.goto(new GoalFollow(mob, 3));
          } catch {
            break;
          }
        }

        try {
          await bot.attack(mob);
          attacks++;
        } catch {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return {
        ok: true,
        status: "success",
        data: {
          attacked: true,
          killed: !bot.entities[mob.id],
          entity: { name: mob.name, id: mob.id },
        },
      };
    }
  },
};

// ─── combat.defend_self ─────────────────────────────────────────────────────

const DefendSelfSchema = z.object({
  range: z.number().min(1).max(64).default(9),
}).strict();

export const combatDefendSelf: SkillDefinition<z.infer<typeof DefendSelfSchema>> = {
  name: "combat.defend_self",
  description: "Attack nearby hostile mobs until the area is clear.",
  category: "combat",
  permissions: ["movement", "combat", "inventory"],
  timeoutMs: 120000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: DefendSelfSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { range: distance } = params;

    ctx.progress({ current: 0, target: 1, unit: "defense", message: "Defending self" });

    const pvp = (bot as any).pvp;
    let enemiesDefeated = 0;

    // Find nearest hostile entity
    let enemy = getNearbyEntities(bot, distance).find(isHostile);

    while (enemy) {
      if (checkCancelled(ctx)) {
        if (pvp) pvp.stop();
        return {
          ok: true,
          status: "cancelled",
          data: { defended: true, enemiesDefeated, enemiesRemaining: getNearbyEntities(bot, distance).filter(isHostile).length },
        };
      }

      await equipBestWeapon(bot);

      // Navigate to enemy if too far
      const dist = bot.entity.position.distanceTo(enemy.position);
      if (dist >= 4 && enemy.name !== "creeper" && enemy.name !== "phantom") {
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new GoalFollow(enemy, 3.5));
        } catch {
          // Entity might die during approach
        }
      }

      // Move away if too close (except creepers)
      if (bot.entity.position.distanceTo(enemy.position) <= 2 && enemy.name !== "creeper") {
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          const invertedGoal = new GoalInvert(new GoalFollow(enemy, 2));
          await bot.pathfinder.goto(invertedGoal);
        } catch {
          // Ignore
        }
      }

      // Attack
      if (pvp) {
        pvp.attack(enemy);
      } else {
        try {
          await bot.attack(enemy);
        } catch {
          // Entity may have died
        }
      }

      // Wait for combat to resolve
      await new Promise((resolve) => setTimeout(resolve, 1000));
      enemiesDefeated++;

      // Find next enemy
      enemy = getNearbyEntities(bot, distance).find(isHostile);
    }

    // Stop pvp
    if (pvp) pvp.stop();

    const enemiesRemaining = getNearbyEntities(bot, distance).filter(isHostile).length;

    return {
      ok: true,
      status: "success",
      data: {
        defended: true,
        enemiesDefeated,
        enemiesRemaining,
      },
      message: enemiesDefeated > 0
        ? `Defeated ${enemiesDefeated} enemies`
        : "No hostile mobs found nearby",
    };
  },
};

// ─── combat.attack_entity ──────────────────────────────────────────────────

const AttackEntitySchema = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.number().int().nonnegative().optional(),
  distance: z.number().min(1).max(64).default(16),
}).strict().refine((data) => data.entityType !== undefined || data.entityId !== undefined, {
  message: "Must provide either entityType or entityId",
});

export const combatAttackEntity: SkillDefinition<z.infer<typeof AttackEntitySchema>> = {
  name: "combat.attack_entity",
  description: "Attack a specific entity by ID or type.",
  category: "combat",
  permissions: ["movement", "combat", "inventory", "entity.interact"],
  timeoutMs: 60000,
  busyPolicy: "cancel-current",
  readOnly: false,
  parameters: AttackEntitySchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { entityType, entityId, distance } = params;

    let target: Entity | undefined;

    // Find by entity ID first
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

    // Find by entity type
    if (!target && entityType) {
      const entities = getNearbyEntities(bot, distance);
      target = entities.find((e) => e.name === entityType);
      if (!target) {
        return {
          ok: false,
          status: "failed",
          error: { code: "TARGET_NOT_FOUND", message: `No ${entityType} found within ${distance} blocks`, retryable: true },
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

    ctx.log(`Attacking ${target.name} (ID: ${target.id}) at distance ${Math.round(bot.entity.position.distanceTo(target.position))}`);
    ctx.progress({ current: 0, target: 1, unit: "attack", message: `Attacking ${target.name}` });

    await equipBestWeapon(bot);

    // Use PVP plugin if available
    const pvp = (bot as any).pvp;
    if (pvp) {
      pvp.attack(target);

      let timeout = 0;
      const maxTimeout = 30000;
      while (timeout < maxTimeout) {
        if (checkCancelled(ctx)) {
          pvp.stop();
          return { ok: false, status: "cancelled", message: "Attack cancelled" };
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
        timeout += 500;

        const stillExists = bot.entities[target.id];
        if (!stillExists) break;
      }

      pvp.stop();

      return {
        ok: true,
        status: "success",
        data: {
          attacked: true,
          killed: !bot.entities[target.id],
          entity: { name: target.name, id: target.id },
        },
      };
    }

    // Fallback: manual attack loop
    let attacks = 0;
    while (attacks < 100) {
      if (checkCancelled(ctx)) {
        return { ok: false, status: "cancelled", message: "Attack cancelled" };
      }

      const stillExists = bot.entities[target.id];
      if (!stillExists) break;

      if (bot.entity.position.distanceTo(target.position) > 4) {
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new GoalFollow(target, 3));
        } catch {
          break;
        }
      }

      try {
        await bot.attack(target);
        attacks++;
      } catch {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return {
      ok: true,
      status: "success",
      data: {
        attacked: true,
        killed: !bot.entities[target.id],
        entity: { name: target.name, id: target.id },
      },
    };
  },
};

// ─── Export all combat skills ────────────────────────────────────────────────

export const combatSkills = [
  combatAttackNearest,
  combatAttackEntity,
  combatDefendSelf,
];
