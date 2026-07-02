# mc-agent-service Roadmap v2

> Author: Asanilo + GPT, 2026-07-02.
> This document supersedes the original `docs/archive/GPT_roadmap.md` draft. **It is the implementation plan for this repo**, not a generic vision doc.

## 0. Premise

mc-agent-service is the **body**. Any upstream LLM agent (Hermes, Codex, a local model, a future agent) drives the service through the same MCP/REST/WebSocket surface — the brain is **swappable**. The body must:

1. Be reliable: hard cancel semantics, clean job lifecycle, safe defaults.
2. Be brain-agnostic: the same tool surface works for any client.
3. **Play modpacks** as a real player would. The reference pack is **Mechanomania (NeoForge / 1.21.1)**, but the design should generalize.
4. Defer memory: the provider contract is reserved, but no built-in store ships in v0.x.
5. Defer multi-bot coordination: multiple simultaneous bots is a Phase 9 concern.

---

## 1. Phase Index

| # | Name | Repo | Status |
|---|---|---|---|
| 0 | Repository hardening | this | **done** |
| 1 | Brain-agnostic transport | this | **done** |
| 2 | Core body runtime stability | this | **done** |
| 3 | Mod-aware observation | this | **done** |
| 4 | Mod-aware action | this | **active — next** |
| 5 | Modpack knowledge indexer | this | **next** |
| 6 | Create early-game helper | this | **next** |
| 7 | Memory providers | this | **reserved** |
| 8 | AgentProbe Mod | **external** | spec-only |
| 9 | Multi-brain / multi-bot | this | **deferred** |
| 10 | Touhou Little Maid | this | **deferred** |

---

## Phase 0 — Repository hardening

Hardening tracked in `docs/STATUS.md` "GPT Review P0 Status":

- **P0 #5** — default `http.host` becomes `127.0.0.1`; refuse to start when `host=0.0.0.0 && auth.mode=none` unless `MCAGENT_ALLOW_INSECURE=1`.
- **P0 #3** — long-running skills (`move.follow_player`, `move.stay`, `move.avoid_enemies`) return `{ ok: false, status: "cancelled", cancellation: { reason: "USER_CANCELLED" } }` when their `ctx.signal` aborts — never `ok: true`.
- **P0 #1** — all `move.*` skills **and** their MCP tool wrappers share a single `distance` field name. The current `move.to_position` skill uses `minDistance`; rename to `distance`.
- **P0 #4** — `BotManager` no longer synthesizes a fake Job inside its `worker.on("exit")` handler. Instead, it emits a `worker_dead(botId, jobId, code, reason)` event; `JobManager` is the sole owner of job terminal state.
- **P0 #2** (post-P0) — Action lanes as a first-class arbitration layer in the worker (primary / observation / safety / system), per SPEC §9.

Exit criteria for Phase 0:

- All five P0 PRs merged with tests. ✅ (2026-07-02)
- `npm run typecheck && npm run test && npm run lint` green. ✅
- Replay test: kill a worker mid-job, restart service, verify job is reported failed with `code: WORKER_CRASH` and that `BotManager` carried no fabricated job record. ✅ (unit-tested in `src/core/job-manager.test.ts`)

---

## Phase 1 — Brain-agnostic transport

The transport surface (MCP / REST / WebSocket) is the public contract. Any LLM agent that speaks one of these can drive the service without code changes here. This phase is **already in place** — the work is documenting it loudly:

1. SPEC §1 Goals carries a `brain-agnostic` clause (done in this revision).
2. `README.md` lists a "Connect any brain" section with one-line examples: `mc-agent-service` + `mcp` config block for Claude Code / Cursor / Codex / Hermes.
3. README references a `examples/` directory (to be added) with one minimal client per family.

Exit criteria:

- README documents the transport surface for non-developers. ✅
- One working example client per transport family in `examples/`. ✅ (`rest-client.sh`, `ws-client.mjs`, `mcp-config.json`)

---

## Phase 2 — Core body runtime stability

✅ **Completed 2026-07-02.**

- **Reconnect backoff**: `BotManager.reconnectBot()` now reads `ReconnectPolicy` from bot config and applies: `min(initialDelay * factor^(attempt-1), maxDelay)` + optional jitter. Respects `maxAttempts` (marks bot as `failed` with `RECONNECT_EXHAUSTED` when exceeded). Respects `enabled: false` (skips reconnect entirely).
- **Skill cleanup verified**: all 35 skills audited. `pathfinder.stop()` properly called in all long-running movement skills. `pvp.stop()` called on cancellation and normal exit in all combat skills. `bot.closeWindow()` called in all container skills. No leaked `setInterval` timers — all delays use `setTimeout` with Promise patterns that GC naturally. No cleanup regressions.
- **SkillPermission**: existing enum kept — no new enum introduced.

---

## Phase 3 — Mod-aware observation

✅ **Completed 2026-07-02.**

### New skills (landed in `src/skills/observation.ts` + `src/knowledge/`)

| Skill | Replaces / Adds |
|---|---|
| `observe.recipe(itemId)` | Look up recipe for an item by id or display name; returns shape `{ inputs, output, machine, modId }`. |
| `observe.recipe_usage(itemId)` | Reverse lookup: what uses this item as input. |
| `observe.jade_look_at(blockPos)` | Returns the Jade-style tooltip block for the block at coords. |
| `observe.quest_progress()` | Current FTB Quest chapter + active task list. |
| `observe.quest_tree(depth?)` | Whole quest tree (capped, paginated). |
| `observe.guide_search(query)` | Patchouli-style guide lookup. |
| `observe.mod_info(modId)` | Mod metadata + id space summary. |

### Knowledge layer (read-only at this phase)

Each skill reads from `src/knowledge/` (a thin cache layer). The knowledge layer is **populated by Phase 5**, but Phase 3 ships the consumer APIs.

Exit criteria:

- Skill schemas defined in `docs/SKILLS.md`. ✅
- Skills behave correctly when the knowledge layer is empty (degrade to "unknown" — never fabricate). ✅ (`EmptyKnowledgeProvider` returns null for every query; all skills return `found: false` / `available: false` with helpful messages)
- Skills respect `Normal Player Mode` (no `/data`, no chunk-loaded bypass). ✅ (all skills use `bot.registry` and `bot.blockAt` only)

---

## Phase 4 — Mod-aware action

Goal: the bot can interact with mod internals — search items in JEI, complete quest steps, work with Create blocks — through structured skills.

### New skills

| Skill | Notes |
|---|---|
| `craft.create_recipe(itemId, count?)` | Knows to use the right Create machine; uses `observe.recipe` first. |
| `interact.jei_lookup(itemId)` | Query JEI-like metadata if supplied by the knowledge index or AgentProbe; otherwise returns `failed / JEI_UNAVAILABLE`. Mineflayer does not load the JEI client UI directly. |
| `quest.complete_step(questId, taskId)` | Submit a step if the server has a non-cheat endpoint; otherwise returns `code: QUEST_STEP_BLOCKED`. |
| `interact.patchouli_open(book, entry)` | Open a Patchouli page if AgentProbe or a client-side bridge is available; otherwise returns `failed / PATCHOULI_UI_UNAVAILABLE`. |

### Rules

- These skills **must** run on the primary lane (`move.*` / `interact.*` etc.).
- Each composes Phase 3 observation skills. No skill invents a recipe; if `observe.recipe` returns `unknown`, `craft.create_recipe` returns `failed / unknown_recipe`.
- Client-mod UI actions must degrade gracefully. Without AgentProbe or a client-side bridge, they return a typed unavailable error instead of pretending Mineflayer can open the UI.

Exit criteria:

- Mechanomania Create early-game tasks (8 quests, ~12 items) are completable end-to-end through skills only, in tests against a controlled server.

---

## Phase 5 — Modpack knowledge indexer

Goal: build `knowledge.sqlite` for a given modpack install, offline. The result is consumed by Phase 3 skills.

### Inputs (file paths)

```
mods/*.jar
kubejs/
config/
defaultconfigs/
datapacks/
lang/  (en_us.json, etc.)
recipes/         (data-driven recipes)
tags/            (data-driven tags)
ftb-quests/      (FTB Quests data files)
patchouli/       (books)
```

### Output schema

```sql
items(
  id TEXT PRIMARY KEY,
  display_name TEXT,
  mod_id TEXT,
  source TEXT        -- jar / kubejs / datapack / lang
)

blocks(
  id TEXT PRIMARY KEY,
  display_name TEXT,
  mod_id TEXT,
  hardness REAL,
  harvest_tool TEXT,
  source TEXT
)

recipes(
  id TEXT PRIMARY KEY,
  type TEXT,
  output_item TEXT,
  output_count INTEGER,
  ingredients_json TEXT,
  machine TEXT,
  source TEXT
)

quests(
  id TEXT PRIMARY KEY,
  title TEXT,
  chapter TEXT,
  dependencies_json TEXT,
  tasks_json TEXT,
  rewards_json TEXT,
  source TEXT
)

guide_entries(
  id TEXT PRIMARY KEY,
  book TEXT,
  title TEXT,
  text TEXT,
  linked_items_json TEXT,
  source TEXT
)
```

### CLI

```bash
mc-agent-knowledge index \
  --modpack /path/to/mechanomania \
  --out    ./data/mechanomania/knowledge.sqlite
```

### Behavior

- Pure off-line tool. **Does not** connect to a Minecraft server.
- Idempotent: re-runs produce the same DB on the same inputs.
- Incremental: detects which jar/datapack changed since last run.

Exit criteria:

- Indexer produces a valid `knowledge.sqlite` for Mechanomania (1.21.1, 152 mods).
- Phase 3 skills (offline-fixture tests) return the expected recipes / quests.

---

## Phase 6 — Create early-game helper

Goal: the AI can advance through Create's opening quest chain without grinding.

### Compositional skills

| Skill | Composes |
|---|---|
| `quest.read_step()` | `observe.quest_progress` → return current quest text |
| `recipe.ingredients(itemId)` | `observe.recipe` |
| `inventory.diff_to_recipe(itemId)` | `observe.inventory` + `observe.recipe` → diff to gather |
| `collect_for_recipe(itemId, count?)` | chain: `inventory.diff_to_recipe` + `observe.block_at` / `observe.entity` + `mine.*` / `combat.*` |
| `craft_basic_item(itemId, count?)` | chain: `recipe.ingredients` + `craft.*` |

### Co-design constraints

- All compositional skills must be deterministic given bot state.
- Compositional skills live in `src/skills/composition.ts` and only call primitive skills — never Mineflayer directly.
- Compositional skills must have human-readable narration returned in `SkillResult.message` so an LLM brain can quote it back.

Exit criteria:

- A scripted playthrough: 8 opening Create quests → all cleared with skill calls only, no Mineflayer-direct in composition.
- Bot never `places` an `andesite_casing` it cannot have; never crafts a `mechanical_piston` if the recipe calls for `electronic_iron`.

---

## Phase 7 — Memory providers

Goal: ship memory providers behind a small contract without breaking the brain-agnostic stance.

### Provider kinds

| Provider kind | Meaning | Ships |
|---|---|---|
| `none` | No persistence and no outbound memory calls. | v0.x default |
| `built-in` | Service-owned storage backends. Initial backends: JSONL file and SQLite. | Phase 7 |
| `external` | HTTP forwarder to an external memory service, such as Hermes or another agent memory service. | Phase 7 |

### v0.x (now)

- Provider kind `none` only.
- The config surface may reserve `built-in` and `external`, but unsupported providers must fail clearly or warn at startup.
- No built-in memory store ships before Phase 7.

### Phase 7 ships

- **Built-in file backend**: JSONL append, one record per `MemoryHookEvent`.
- **Built-in sqlite backend**: same events into SQLite, queryable by `(botId, type, ts)`.
- **External HTTP backend**: POST with retries; respects rate limits; never blocks the primary lane.

### Coupling to action lanes

- Provider `store()` runs on **observation lane** or below — never primary, never safety.
- Failures downgrade to log only; do not surface to the bot.

Exit criteria:

- A test fixture bot running for 1 hour produces a steady `memory.jsonl` and `memory.sqlite` of expected size when `built-in` is enabled.
- Killing the upstream agent mid-session leaves the service still running, with no `JobManager` state corruption.

---

## Phase 8 — AgentProbe Mod (external)

A separate NeoForge Mod repository. Not in this repo.

### Purpose

- Expose JEI / Jade / FTB Quests / Patchouli / KubeJS internal state as a JSON surface the service can subscribe to.
- The service already has an extension point (the `minecraft://` resource surface in MCP) that AgentProbe can publish to.

### Why external

- The Mod is Java + Architectury; it would not belong in a TypeScript repo.
- The service can stay un-modded on the player side; only the server (or a sidecar) needs the Mod installed.
- Improves the framework's reach without expanding its TypeScript surface.

### Status

- Spec-only at this point. Implement when Phase 4/5 reach a level where mod internals can't be inferred from observation alone.

---

## Phase 9 — Multi-brain / multi-bot (deferred)

- **Multi-brain today**: any client can drive the service. **Done.**
- **Multi-bot today**: SPEC §9 permits multiple bots; one-bot-per-worker isolation is the model. Add bots via `POST /bots`. No coordination layer.
- **Phase 9 adds**: a **coordinator** module that handles two or more simultaneous bots in the same Minecraft world. Out of scope until single-bot is fully stabilized (end of Phase 6).

---

## Phase 10 — Touhou Little Maid (deferred)

Two body models are different (player bot vs. TLM maid entity). The TLM body would be a separate adapter not in this repo's current scope. Revisit when multi-agent shapes stabilize.

---

## 2. Open questions

| Q | Where it bites | Owner |
|---|---|---|
| Does the indexer need to handle mod loaders other than NeoForge (Fabric / Forge)? | Phase 5 acceptance | TBD |
| Where does the `examples/` directory live — in this repo or split? | Phase 1 README | Asanilo |
| `mc-agent-knowledge` CLI: separate npm package or sub-binary of this repo? | Phase 5 | Asanilo |
| Should `observe.jade_look_at` use F3-style debug output or a separate Mod tap? | Phase 3 | likely AgentProbe (Phase 8) |
| Backwards compatibility for `move.to_position` MCP tool callers after `minDistance → distance` rename? | P0 #1 | Agent of P0 #1 |

---

## 3. Reference

- `docs/SPEC.md` — implementation contract
- `docs/ARCHITECTURE.md` — module graph, data flows, event system
- `docs/SKILLS.md` — skill catalog
- `docs/API.md` — transport reference
- `docs/STATUS.md` — current state, P0 status
- `docs/NORMAL_PLAYER_MODE.md` — no-OP / no-cheat player policy
- `docs/archive/GPT_roadmap.md` — original GPT draft (kept for traceability)
- `docs/archive/GPT0701review.md` — 2026-07-01 health check
