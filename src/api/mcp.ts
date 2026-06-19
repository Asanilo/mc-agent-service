/**
 * MCP (Model Context Protocol) server adapter for mc-agent-service.
 *
 * Exposes Minecraft bot management as MCP resources and tools,
 * allowing LLM agents to interact with the service via the MCP protocol.
 *
 * Resources:
 *   - minecraft://bots              — list all bots
 *   - minecraft://bots/{botId}/state — bot state snapshot
 *   - minecraft://skills            — list registered skills
 *
 * Tools:
 *   - create_bot, stop_bot, send_chat, get_state,
 *     move_to, follow_player, collect_blocks, craft_item, cancel_job
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { z } from "zod";
import type { BotManager } from "../core/bot-manager.js";
import type { JobManager } from "../core/job-manager.js";
import type { SkillRegistry, BotStateCache } from "./rest.js";
import type { ServerConfig } from "../types/config.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface McpAdapterOptions {
  botManager: BotManager;
  jobManager: JobManager;
  skillRegistry: SkillRegistry;
  stateCache: BotStateCache;
  config: ServerConfig;
  logger?: pino.Logger;
}

// ─── MCP Server Factory ──────────────────────────────────────────────────────

export function createMcpServer(opts: McpAdapterOptions): McpServer {
  const { botManager, jobManager, skillRegistry, stateCache } = opts;
  const logger = (opts.logger ?? pino()).child({ module: "MCP" });

  const mcp = new McpServer({
    name: "mc-agent-service",
    version: "0.1.0",
  });

  // ════════════════════════════════════════════════════════════════════════
  //  RESOURCES
  // ════════════════════════════════════════════════════════════════════════

  /** minecraft://bots — list all bots */
  mcp.resource(
    "bots",
    "minecraft://bots",
    { description: "List all managed Minecraft bots", mimeType: "application/json" },
    async () => {
      const bots = botManager.listBots();
      return {
        contents: [
          {
            uri: "minecraft://bots",
            mimeType: "application/json",
            text: JSON.stringify({ bots }),
          },
        ],
      };
    },
  );

  /** minecraft://bots/{botId}/state — bot state snapshot */
  mcp.resource(
    "bot-state",
    "minecraft://bots/{botId}/state",
    { description: "Full state snapshot for a specific bot", mimeType: "application/json" },
    async (uri: URL) => {
      // Extract botId from the URI path
      const pathParts = uri.pathname.split("/").filter(Boolean);
      // Expected: bots/{botId}/state
      const botId = pathParts[1] ?? "";

      try {
        botManager.getBot(botId);
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: `Bot "${botId}" not found` }),
            },
          ],
        };
      }

      const state = stateCache.get(botId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ state: state ?? null }),
          },
        ],
      };
    },
  );

  /** minecraft://skills — list registered skills */
  mcp.resource(
    "skills",
    "minecraft://skills",
    { description: "List all registered skills with their schemas", mimeType: "application/json" },
    async () => {
      const skills = skillRegistry.list();
      return {
        contents: [
          {
            uri: "minecraft://skills",
            mimeType: "application/json",
            text: JSON.stringify({ skills }),
          },
        ],
      };
    },
  );

  // ════════════════════════════════════════════════════════════════════════
  //  TOOLS
  // ════════════════════════════════════════════════════════════════════════

  /** create_bot — Create and optionally connect a new bot */
  mcp.tool(
    "create_bot",
    "Create a new Minecraft bot with the given configuration",
    {
      name: z.string().min(1).describe("Display name for the bot"),
      host: z.string().min(1).describe("Minecraft server hostname"),
      port: z.number().int().min(1).max(65535).default(25565).describe("Minecraft server port"),
      username: z.string().min(1).describe("Minecraft username"),
      version: z.string().default("auto").describe("Minecraft version or 'auto'"),
      auth: z.enum(["offline", "microsoft"]).default("offline").describe("Authentication mode"),
      connect: z.boolean().default(true).describe("Whether to auto-connect after creation"),
    },
    async (args) => {
      try {
        const summary = botManager.createBot(
          {
            name: args.name,
            minecraft: {
              host: args.host,
              port: args.port,
              username: args.username,
              version: args.version,
              auth: args.auth,
            },
          },
          args.connect,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ bot: summary }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** stop_bot — Stop/disconnect a bot */
  mcp.tool(
    "stop_bot",
    "Stop a running Minecraft bot",
    {
      botId: z.string().describe("The bot ID to stop"),
      reason: z.string().optional().describe("Reason for stopping"),
    },
    async (args) => {
      try {
        botManager.stopBot(args.botId, args.reason);
        const summary = botManager.getBot(args.botId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ bot: summary }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** send_chat — Send a chat message from a bot */
  mcp.tool(
    "send_chat",
    "Send a chat message from a bot to the Minecraft server",
    {
      botId: z.string().describe("The bot ID"),
      message: z.string().min(1).max(256).describe("Chat message to send"),
    },
    async (args) => {
      try {
        botManager.getBot(args.botId);
        botManager.sendChat(args.botId, args.message);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ sent: true, message: args.message }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** get_state — Get the current state of a bot */
  mcp.tool(
    "get_state",
    "Get the full current state of a Minecraft bot",
    {
      botId: z.string().describe("The bot ID"),
    },
    async (args) => {
      try {
        const summary = botManager.getBot(args.botId);
        const state = stateCache.get(args.botId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ bot: summary, state: state ?? null }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** move_to — Command a bot to move to coordinates */
  mcp.tool(
    "move_to",
    "Command a bot to move to specific coordinates",
    {
      botId: z.string().describe("The bot ID"),
      x: z.number().describe("Target X coordinate"),
      y: z.number().describe("Target Y coordinate"),
      z: z.number().describe("Target Z coordinate"),
    },
    async (args) => {
      try {
        botManager.getBot(args.botId);
        const job = jobManager.submitJob(args.botId, "move_to", {
          x: args.x,
          y: args.y,
          z: args.z,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ job }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** follow_player — Command a bot to follow a player */
  mcp.tool(
    "follow_player",
    "Command a bot to follow a specific player",
    {
      botId: z.string().describe("The bot ID"),
      username: z.string().min(1).describe("Username of the player to follow"),
      distance: z.number().min(1).max(20).default(3).describe("Following distance in blocks"),
    },
    async (args) => {
      try {
        botManager.getBot(args.botId);
        const job = jobManager.submitJob(args.botId, "follow_player", {
          username: args.username,
          distance: args.distance,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ job }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** collect_blocks — Command a bot to collect specific blocks */
  mcp.tool(
    "collect_blocks",
    "Command a bot to collect specific types of blocks in an area",
    {
      botId: z.string().describe("The bot ID"),
      blockType: z.string().min(1).describe("Type of block to collect (e.g. 'oak_log', 'stone')"),
      count: z.number().int().min(1).max(64).default(1).describe("Number of blocks to collect"),
      radius: z.number().min(1).max(64).default(32).describe("Search radius in blocks"),
    },
    async (args) => {
      try {
        botManager.getBot(args.botId);
        const job = jobManager.submitJob(args.botId, "collect_blocks", {
          blockType: args.blockType,
          count: args.count,
          radius: args.radius,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ job }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** craft_item — Command a bot to craft an item */
  mcp.tool(
    "craft_item",
    "Command a bot to craft a specific item",
    {
      botId: z.string().describe("The bot ID"),
      itemName: z.string().min(1).describe("Item to craft (e.g. 'crafting_table', 'wooden_pickaxe')"),
      count: z.number().int().min(1).max(64).default(1).describe("Number of items to craft"),
    },
    async (args) => {
      try {
        botManager.getBot(args.botId);
        const job = jobManager.submitJob(args.botId, "craft_item", {
          itemName: args.itemName,
          count: args.count,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ job }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /** cancel_job — Cancel a running or pending job */
  mcp.tool(
    "cancel_job",
    "Cancel a running or pending job",
    {
      jobId: z.string().describe("The job ID to cancel"),
      reason: z.string().optional().describe("Reason for cancellation"),
    },
    async (args) => {
      try {
        const job = jobManager.cancelJob(args.jobId, "cancel-current", args.reason);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ job, accepted: true }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return mcp;
}

// ─── Transport Setup ─────────────────────────────────────────────────────────

export interface McpTransportHandle {
  mcp: McpServer;
  close: () => Promise<void>;
}

/**
 * Start the MCP server with the appropriate transport.
 * - stdio: for CLI/integration use
 * - http: attaches to an Express app at the configured path
 */
export async function startMcpTransport(
  mcp: McpServer,
  config: ServerConfig,
  logger: pino.Logger,
  httpServer?: { on: (event: string, cb: (...args: unknown[]) => void) => void },
): Promise<McpTransportHandle> {
  if (config.mcp.transport === "stdio") {
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    logger.info("MCP server connected via stdio transport");

    return {
      mcp,
      close: async () => {
        await mcp.close();
      },
    };
  }

  // HTTP transport — we return the McpServer and let the main entry point
  // route requests to it via Express middleware
  logger.info({ path: config.mcp.path ?? "/mcp" }, "MCP server configured for HTTP transport");

  return {
    mcp,
    close: async () => {
      await mcp.close();
    },
  };
}
