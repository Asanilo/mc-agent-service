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

Listen on `127.0.0.1` by default once P0 #5 (`docs/STATUS.md`) ships. Until then, the bundled config binds `0.0.0.0` — set host to `127.0.0.1` in `mc-agent-service.json` for local development, or set `MCAGENT_ALLOW_INSECURE=1` only if you need LAN exposure and accept the implications.

## Connect any brain

mc-agent-service is **brain-agnostic**: any LLM agent that speaks MCP, REST, or WebSocket can drive the bot. Swapping the brain does not require changing the service.
