/**
 * API module barrel export for mc-agent-service.
 *
 * Re-exports:
 *  - REST router factory + SkillRegistry + BotStateCache
 *  - WebSocket manager
 *  - MCP server factory + transport helpers
 *  - Auth middleware
 *  - Rate limiting
 *  - Zod-to-JSON-Schema converter
 */

export { createRestRouter, SkillRegistry, BotStateCache } from "./rest.js";
export type { RestRouterOptions } from "./rest.js";

export { WsManager } from "./websocket.js";
export type { WsManagerOptions } from "./websocket.js";

export { createMcpServer, startMcpTransport } from "./mcp.js";
export type { McpAdapterOptions, McpTransportHandle } from "./mcp.js";

export { createAuthMiddleware, checkWsAuth, checkMcpAuth } from "./auth.js";
export { createRestRateLimitMiddleware, createChatRateLimitMiddleware, SlidingWindowLimiter, checkMcpRateLimit } from "./rate-limit.js";
export { zodSchemaToJsonSchema } from "./zod-to-json-schema.js";
