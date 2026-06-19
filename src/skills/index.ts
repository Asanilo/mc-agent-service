/**
 * Built-in skills registry for mc-agent-service.
 * Imports and registers all built-in skills with the SkillExecutor.
 */
import type { SkillExecutor } from "../bots/skill-executor.js";

import { movementSkills } from "./movement.js";
import { miningSkills } from "./mining.js";
import { craftingSkills } from "./crafting.js";
import { combatSkills } from "./combat.js";
import { inventorySkills } from "./inventory.js";
import { observationSkills } from "./observation.js";
import { communicationSkills } from "./communication.js";

/**
 * All built-in skill arrays, grouped by category.
 */
export const allSkillGroups = [
  ...movementSkills,
  ...miningSkills,
  ...craftingSkills,
  ...combatSkills,
  ...inventorySkills,
  ...observationSkills,
  ...communicationSkills,
];

/**
 * Register all built-in skills with the given SkillExecutor.
 * Call this once during bot worker initialization.
 */
export function registerAllSkills(executor: SkillExecutor): void {
  for (const skill of allSkillGroups) {
    executor.registerSkill(skill as any);
  }
}

// Re-export individual skill groups for selective registration or testing
export { movementSkills } from "./movement.js";
export { miningSkills } from "./mining.js";
export { craftingSkills } from "./crafting.js";
export { combatSkills } from "./combat.js";
export { inventorySkills } from "./inventory.js";
export { observationSkills } from "./observation.js";
export { communicationSkills } from "./communication.js";
