/**
 * Core barrel export for mc-agent-service control plane.
 *
 * Re-exports:
 *  - EventBus (class + singleton instance)
 *  - Config loader + ConfigFacade
 *  - BotManager + BotManagerError
 *  - JobManager + JobManagerError
 */

export { EventBus, eventBus } from "./event-bus.js";
export type { EventFilter, EventHandler, EventSubscription } from "./event-bus.js";

export { loadConfig, ConfigFacade } from "./config.js";
export type { LoadConfigOptions } from "./config.js";

export { BotManager, BotManagerError } from "./bot-manager.js";
export type { BotManagerOptions } from "./bot-manager.js";

export { JobManager, JobManagerError } from "./job-manager.js";
export type { JobManagerOptions, SubmitJobOptions, JobListFilter } from "./job-manager.js";
