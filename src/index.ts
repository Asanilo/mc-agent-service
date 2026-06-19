/**
 * mc-agent-service — main entry point.
 *
 * Bootstraps:
 *  1. Configuration (defaults → config file → env overrides → Zod validation)
 *  2. EventBus for service-wide event distribution
 *  3. BotManager for bot lifecycle management
 *  4. JobManager for skill execution and job queuing
 *  5. Express HTTP server with REST API
 *  6. WebSocket server for real-time event streaming
 *  7. MCP server for LLM agent integration
 *  8. Graceful shutdown on SIGTERM / SIGINT
 */

import pino from "pino";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { loadConfig, EventBus, BotManager, JobManager } from "./core/index.js";
import {
  createRestRouter,
  SkillRegistry,
  BotStateCache,
  WsManager,
  createMcpServer,
  startMcpTransport,
  type McpTransportHandle,
} from "./api/index.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load configuration
  const configFacade = await loadConfig();
  const config = configFacade.raw;

  // 2. Create logger
  const logger = pino({
    level: config.logging.level,
    transport: config.logging.pretty
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  });

  logger.info({ config: configFacade.toJSON() }, "mc-agent-service starting");

  // 3. Create core services
  const eventBus = new EventBus();
  const botManager = new BotManager({ serverConfig: config, eventBus, logger });
  const jobManager = new JobManager({ eventBus, botManager, logger });
  botManager.setJobEventHandler((event) => jobManager.handleWorkerEvent(event));

  // 4. Create API-layer services
  const skillRegistry = new SkillRegistry();
  const stateCache = new BotStateCache(eventBus);
  stateCache.start();

  // 4b. Register built-in skills into API SkillRegistry
  const { allSkillGroups } = await import("./skills/index.js");
  for (const skill of allSkillGroups) {
    skillRegistry.register({
      name: skill.name,
      description: skill.description,
      category: skill.category,
      permissions: skill.permissions,
      timeoutMs: skill.timeoutMs,
      busyPolicy: skill.busyPolicy,
      readOnly: skill.readOnly,
      parametersSchema: {},
    });
  }
  logger.info({ count: allSkillGroups.length }, "Built-in skills registered");

  // 5. Create Express app
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Mount REST API
  const restRouter = createRestRouter({
    botManager,
    jobManager,
    eventBus,
    skillRegistry,
    stateCache,
    logger,
  });
  app.use("/", restRouter);

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "Unhandled Express error");
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
  });

  // 6. Create HTTP server
  const httpServer = createServer(app);

  // 7. Attach WebSocket server
  let wsManager: WsManager | null = null;
  if (config.websocket.enabled) {
    wsManager = new WsManager({ eventBus, logger });
    wsManager.attachToServer(httpServer, config.websocket.path);
  }

  // 8. Create MCP server
  let mcpHandle: McpTransportHandle | null = null;
  if (config.mcp.enabled) {
    const mcpServer = createMcpServer({
      botManager,
      jobManager,
      skillRegistry,
      stateCache,
      config,
      logger,
    });

    // For stdio transport, start immediately
    if (config.mcp.transport === "stdio") {
      mcpHandle = await startMcpTransport(mcpServer, config, logger);
    } else {
      // For HTTP transport, mount on Express
      const mcpPath = config.mcp.path ?? "/mcp";
      const transport = new (await import("@modelcontextprotocol/sdk/server/streamableHttp.js"))
        .StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      await mcpServer.connect(transport);

      app.all(mcpPath, async (req, res) => {
        await transport.handleRequest(req, res);
      });

      mcpHandle = { mcp: mcpServer, close: async () => { await mcpServer.close(); } };
      logger.info({ path: mcpPath }, "MCP HTTP transport mounted");
    }
  }

  // 9. Start listening
  const { host, port } = config.http;
  httpServer.listen(port, host, async () => {
    logger.info({ host, port }, "HTTP server listening");
    if (wsManager) {
      logger.info({ path: config.websocket.path }, "WebSocket server active");
    }

    // 10. Auto-start bots from config file
    const botProfiles = config.bots ?? [];
    for (const profile of botProfiles) {
      if (profile.autoStart === false) continue;
      try {
        const botConfig = {
          id: profile.id ?? profile.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
          name: profile.name,
          minecraft: profile.minecraft,
          reconnect: profile.reconnect,
          memory: profile.memory,
          modes: profile.modes,
        };
        await botManager.createBot(botConfig);
        logger.info({ botId: botConfig.id, host: profile.minecraft.host }, "Auto-started bot from config");
      } catch (err) {
        logger.error({ err, botName: profile.name }, "Failed to auto-start bot");
      }
    }
  });

  // 10. Graceful shutdown
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Shutdown initiated");

    // Stop accepting new connections
    httpServer.close(() => {
      logger.info("HTTP server closed");
    });

    // Close WebSocket connections
    wsManager?.close();

    // Close MCP server
    await mcpHandle?.close();

    // Stop state cache
    stateCache.stop();

    // Destroy all bots and wait for workers to exit
    const bots = botManager.listBots();
    const destroyPromises = bots
      .filter((b) => b.status !== "destroyed")
      .map((b) => botManager.destroyBot(b.id, "shutdown").catch(() => {/* best effort */}));
    await Promise.all(destroyPromises);

    // Give in-flight requests time to finish
    const forceExitTimeout = setTimeout(() => {
      logger.warn("Forced exit after timeout");
      process.exit(1);
    }, 10_000);
    forceExitTimeout.unref();

    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle unhandled errors
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled rejection");
    shutdown("unhandledRejection");
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  // Use console.error since logger may not be initialized yet
  console.error("Fatal startup error:", err);
  process.exit(1);
});
