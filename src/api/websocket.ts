/**
 * WebSocket server for mc-agent-service.
 *
 * Clients connect to /ws (all events) or /ws?botId=X (filtered to a single bot).
 * Supports subscribe/unsubscribe messages from clients and broadcasts
 * ServiceEvents from EventBus to subscribed clients.
 */

import { type IncomingMessage } from "node:http";
import { type Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import pino from "pino";
import type { EventBus } from "../core/event-bus.js";
import type { ServiceEvent } from "../types/events.js";
import type { AuthConfig } from "../types/config.js";
import { checkWsAuth } from "./auth.js";

// ─── Client state ────────────────────────────────────────────────────────────

interface WsClient {
  ws: WebSocket;
  botFilter: string | null; // null = all events, string = only that botId
  subscriptions: Set<string>; // event type subscriptions (empty = all types)
  alive: boolean;
  id: string;
}

// ─── Messages from client ────────────────────────────────────────────────────

interface SubscribeMessage {
  type: "subscribe";
  eventTypes?: string[];
  botId?: string;
}

interface UnsubscribeMessage {
  type: "unsubscribe";
  eventTypes?: string[];
}

interface PingMessage {
  type: "ping";
}

type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

function parseClientMessage(raw: RawData): ClientMessage | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf-8");
    const data = JSON.parse(text) as Record<string, unknown>;
    if (data["type"] === "subscribe" || data["type"] === "unsubscribe" || data["type"] === "ping") {
      return data as unknown as ClientMessage;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── WebSocket Manager ───────────────────────────────────────────────────────

export interface WsManagerOptions {
  eventBus: EventBus;
  logger?: pino.Logger;
  authConfig?: AuthConfig;
}

export class WsManager {
  private readonly clients = new Map<string, WsClient>();
  private readonly eventBus: EventBus;
  private readonly logger: pino.Logger;
  private readonly authConfig: AuthConfig | undefined;
  private wss: WebSocketServer | null = null;
  private eventSubscription: { id: string } | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private clientSeq = 0;

  constructor(opts: WsManagerOptions) {
    this.eventBus = opts.eventBus;
    this.logger = (opts.logger ?? pino()).child({ module: "WebSocket" });
    this.authConfig = opts.authConfig;
  }

  /**
   * Attach to an existing HTTP server at the given path.
   */
  attachToServer(server: { on: (event: string, cb: (...args: unknown[]) => void) => void }, path: string): void {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle HTTP upgrade
    server.on("upgrade", (req: unknown, socket: unknown, head: unknown) => {
      const request = req as IncomingMessage;
      const sock = socket as Duplex;
      const buf = head as Buffer;

      // Only handle our WS path
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== path) return;

      // Auth check
      if (this.authConfig && this.authConfig.mode !== "none") {
        const authError = checkWsAuth(this.authConfig, request.headers as Record<string, string | string[] | undefined>, url.searchParams);
        if (authError) {
          const errorPayload = JSON.stringify({
            error: { code: authError.code, message: authError.message },
          });
          sock.write(
            `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(errorPayload)}\r\n\r\n${errorPayload}`,
          );
          sock.destroy();
          return;
        }
      }

      // Strip token from URL to prevent logging sensitive query params
      url.searchParams.delete("token");
      request.url = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "");

      this.wss!.handleUpgrade(request, sock, buf, (ws) => {
        this.wss!.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Subscribe to all EventBus events
    this.eventSubscription = this.eventBus.subscribe(
      () => true, // accept all events
      (event) => this.broadcast(event),
    );

    // Ping/pong heartbeat every 30s
    this.pingInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          this.logger.debug({ clientId: client.id }, "Client heartbeat failed, terminating");
          client.ws.terminate();
          continue;
        }
        client.alive = false;
        client.ws.ping();
      }
    }, 30_000);

    this.logger.info({ path }, "WebSocket server attached");
  }

  /**
   * Gracefully shut down.
   */
  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.eventSubscription) {
      this.eventBus.unsubscribe(this.eventSubscription.id);
      this.eventSubscription = null;
    }

    for (const client of this.clients.values()) {
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.logger.info("WebSocket server closed");
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = `ws_${++this.clientSeq}`;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const botFilter = url.searchParams.get("botId");

    const client: WsClient = {
      ws,
      botFilter,
      subscriptions: new Set(),
      alive: true,
      id: clientId,
    };

    this.clients.set(clientId, client);
    this.logger.info({ clientId, botFilter }, "WebSocket client connected");

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("message", (data: RawData) => {
      this.handleClientMessage(client, data);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.clients.delete(clientId);
      this.logger.info({ clientId, code, reason: reason.toString() }, "WebSocket client disconnected");
    });

    ws.on("error", (err: Error) => {
      this.logger.error({ clientId, err }, "WebSocket client error");
      this.clients.delete(clientId);
    });

    // Send welcome message
    this.sendToClient(client, {
      type: "connected",
      clientId,
      botFilter,
      timestamp: new Date().toISOString(),
    });
  }

  private handleClientMessage(client: WsClient, data: RawData): void {
    const msg = parseClientMessage(data);
    if (!msg) {
      this.sendToClient(client, { type: "error", message: "Invalid message format" });
      return;
    }

    switch (msg.type) {
      case "subscribe":
        if (msg.botId !== undefined) {
          client.botFilter = msg.botId ?? null;
        }
        if (msg.eventTypes) {
          for (const t of msg.eventTypes) {
            client.subscriptions.add(t);
          }
        }
        this.sendToClient(client, {
          type: "subscribed",
          botFilter: client.botFilter,
          eventTypes: Array.from(client.subscriptions),
        });
        break;

      case "unsubscribe":
        if (msg.eventTypes) {
          for (const t of msg.eventTypes) {
            client.subscriptions.delete(t);
          }
        } else {
          client.subscriptions.clear();
        }
        this.sendToClient(client, {
          type: "unsubscribed",
          eventTypes: Array.from(client.subscriptions),
        });
        break;

      case "ping":
        this.sendToClient(client, { type: "pong", timestamp: new Date().toISOString() });
        break;
    }
  }

  private broadcast(event: ServiceEvent): void {
    const payload = JSON.stringify(event);

    for (const client of this.clients.values()) {
      // Bot filter
      if (client.botFilter && event.botId !== client.botFilter) continue;

      // Event type filter (empty = all types)
      if (client.subscriptions.size > 0 && !client.subscriptions.has(event.type)) continue;

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  private sendToClient(client: WsClient, data: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  }
}
