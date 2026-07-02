# mc-agent-service

Standalone Minecraft AI body runtime. Mineflayer wrapped as a REST + WebSocket + MCP service for external agents (Hermes, Codex, scripts).

The service is the **body**: it executes structured skill commands and emits state. It is not the brain — long-term memory, planning, and personality live in the upstream agent.

## Status

Pre-1.0. See `docs/STATUS.md` for what works today and `docs/SPEC.md` for the contract. Active work is tracked as P0 (Phase 0 / repo hardening) plus roadmap Phases 3–7 (mod-aware observation, action, knowledge indexer, Create helpers, memory providers).

## Documentation map

Start here:

- `README.md` — quickstart and project orientation.
- `docs/STATUS.md` — current implementation status, active P0 checklist, and known gaps.
- `docs/ROADMAP_v2.md` — active implementation roadmap. This is the current plan.

Contracts:

- `docs/SPEC.md` — project goals, non-goals, and implementation contract.
- `docs/API.md` — REST, WebSocket, and MCP API reference.
- `docs/SKILLS.md` — skill catalog, parameters, permissions, and execution semantics.
- `docs/ARCHITECTURE.md` — module boundaries, worker model, and data flow.
- `docs/NORMAL_PLAYER_MODE.md` — no-OP / no-cheat policy for real-player modpack play.

Archive:

- `docs/archive/*` — historical GPT/Codex reviews and drafts. Keep for traceability, but do not treat them as current truth.

## Quickstart

Requirements: Node.js (TypeScript), a local Minecraft server (vanilla recommended for first run).

```bash
# 1. Install
npm install

# 2. Run (uses mc-agent-service.json)
npm run dev

# 3. Create a bot
curl -X POST http://127.0.0.1:3001/bots \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hermes",
    "minecraft": { "host": "127.0.0.1", "port": 25565, "username": "Hermes", "auth": "offline", "version": "auto" }
  }'

# 4. Drive it
curl -X POST http://127.0.0.1:3001/bots/<botId>/chat \
  -H "Content-Type: application/json" -d '{"message": "hello"}'

# 5. Read state
curl http://127.0.0.1:3001/bots/<botId>/state
```

Bot ID comes from the create response (e.g. `bot_xxxxxxxx`). Port comes from your config (default 3001).

## Scripts

- `npm run dev` — `tsx watch src/index.ts` (hot reload)
- `npm run build` — compile to `dist/`
- `npm start` — run `dist/index.js`
- `npm test` — `vitest`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `eslint src/`

## Endpoints at a glance

- `POST /bots` — create bot
- `GET /bots/{id}/state` — full state snapshot
- `POST /bots/{id}/actions/{skill}` — submit a skill job
- `POST /bots/{id}/chat` — send chat
- `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel` — job lifecycle
- `WS /ws` — event stream (`job.*`, `chat.*`, `bot.*`, `state.*`)
- MCP server (stdio) when `mcp.enabled=true`

Full surface: `docs/API.md`. Skill catalog: `docs/SKILLS.md`.

## Project layout

```
src/
  api/         REST, WebSocket, MCP, auth, rate-limit, zod-to-json-schema
  core/        BotManager, JobManager, EventBus, Config
  bots/        worker-entry, BotRuntime, MineflayerAdapter, StateTracker, ModeEngine, SkillExecutor
  skills/      movement, mining, crafting, combat, inventory, observation, communication
  types/       api, bot, config, events, jobs, skills, worker
```

Module dependency rule: Control Plane never imports Mineflayer. Only Bot Runtime modules do. See `docs/ARCHITECTURE.md` §1.

## Security defaults

The service listens on `127.0.0.1` by default. Binding to `0.0.0.0` or `::` (all interfaces) with `auth.mode=none` is refused at startup unless `MCAGENT_ALLOW_INSECURE=1` is set. To expose the service on a network, either:

- Enable auth (`bearer` or `api-key` mode), or
- Set `MCAGENT_ALLOW_INSECURE=1` (accepting the risk).

## Connect any brain

mc-agent-service is **brain-agnostic**: any LLM agent that speaks MCP, REST, or WebSocket can drive the bot. Swapping the brain does not require changing the service.

### REST — any HTTP client

```bash
# Submit a movement skill
curl -X POST http://127.0.0.1:3001/bots/<botId>/actions/move.to_position \
  -H "Content-Type: application/json" \
  -d '{"params":{"x":0,"y":64,"z":0,"distance":2}}'

# Read state
curl http://127.0.0.1:3001/bots/<botId>/state

# Cancel a running job
curl -X POST http://127.0.0.1:3001/jobs/<jobId>/cancel \
  -H "Content-Type: application/json" -d '{}'
```

### WebSocket — real-time event stream

```js
const ws = new WebSocket("ws://127.0.0.1:3001/ws");
ws.on("message", (data) => {
  const event = JSON.parse(data);
  // event.type: "state.changed" | "job.completed" | "chat.received" | ...
});
```

### MCP — Claude Code, Cursor, Codex, any MCP client

```json
{
  "mcpServers": {
    "mc-agent": {
      "command": "npx", "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/mc-agent-service",
      "env": { "MCAGENT_MCP_ENABLED": "true", "MCAGENT_MCP_TRANSPORT": "stdio" }
    }
  }
}
```

Once connected, the agent sees tools: `create_bot`, `stop_bot`, `send_chat`, `get_state`, `move.to_position`, `move.follow_player`, `mine.collect_blocks`, `craft.item`, `cancel_job`.

### Runnable examples

See `examples/` for fully worked, runnable clients:

| Transport | File | Requires |
|-----------|------|----------|
| REST | `examples/rest-client.sh` | `curl`, `bash` |
| WebSocket | `examples/ws-client.mjs` | `npm install ws` |
| MCP | `examples/mcp-config.json` | Claude Code / Cursor / Codex |
