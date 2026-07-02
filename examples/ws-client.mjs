#!/usr/bin/env node
// ─── WebSocket API Example ────────────────────────────────────────────────────
// Connects to the WebSocket event stream and prints events in real time.
// Also sends a chat message via the WebSocket connection.
//
// Prerequisites: mc-agent-service running with websocket enabled.
//   npm run dev   (websocket is enabled by default at /ws)
//
// Usage:
//   node examples/ws-client.mjs
//   HOST=192.168.1.5 node examples/ws-client.mjs   # remote service
//
import { WebSocket } from "ws";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = process.env.PORT ?? "3001";
const WS_URL = `ws://${HOST}:${PORT}/ws`;

function connect() {
  console.log(`Connecting to ${WS_URL} ...`);
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("Connected. Listening for events...\n");

    // Subscribe to all bot events
    ws.send(JSON.stringify({ type: "subscribe", botIds: ["*"] }));
  });

  ws.on("message", (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const ts = event.ts ? new Date(event.ts).toLocaleTimeString() : "??:??:??";
      console.log(`[${ts}] ${event.type} | bot=${event.botId ?? "-"} | job=${event.jobId ?? "-"}`);
    } catch {
      // non-JSON frame (e.g. ping)
    }
  });

  ws.on("close", (code, _reason) => {
    console.log(`Disconnected (code=${code}). Reconnecting in 3s...`);
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

connect();
console.log("Press Ctrl+C to stop.\n");
console.log("Expected events: bot.connected, state.changed, job.*, chat.*, etc.");
console.log("These events stream from whichever bots are running on the service.\n");
