# mc-agent-service Improvement Plan

Senior-architect review against the design docs and the Mindcraft reference. Source code was reviewed read-only; this file is the requested deliverable.

## Executive Summary

`mc-agent-service` has the right architectural skeleton for the design: TypeScript, Zod schemas, REST/WebSocket/MCP adapters, worker-thread bot isolation, a control plane, job records, a Mineflayer adapter, a state tracker, a skill executor, and a mode engine.

The main problem is that the contracts are ahead of the implementation. Several user-facing paths compile but do not work correctly:

- `PATCH /bots/{botId}/modes/{modeName}` sends `toggleMode`, but the worker never handles it.
- `POST /bots/{botId}/look` submits `move.look`, which is not registered, then returns `looked: true` anyway.
- `POST /bots/{botId}/chat` with `asJob: true` submits skill `chat`, but the registered skill is `chat.send`.
- Running job cancellation is not finalized as `job.cancelled`; it usually becomes `job.failed` or stays running until a timeout/event.
- `cancel-current` and `emergency-stop` can dispatch a new job before the previous skill has cleaned up, so the one-primary-action rule is not enforced.
- Worker job events are forwarded to `JobManager` twice in `BotManager`, risking duplicate lifecycle transitions and queue dispatch.
- Event IDs and timestamps are often emitted as empty strings because callers pass `id: ""` and `ts: ""`, bypassing `EventBus` stamping.
- The public schemas in `SKILLS.md` and `API.md` diverge from implementation parameters for several important skills.

Build status: `npm run build` passes. `npm test` fails because no Vitest test files exist.

## A. Feature Gap Analysis

Legend:

- Essential: needed for MVP/basic service reliability.
- Nice-to-have: useful parity with Mindcraft, can wait.
- Unnecessary: Mindcraft-specific or conflicts with mc-agent-service non-goals.
- Effort: small, medium, large.

### Mindcraft Action Skills

| Mindcraft capability | mc-agent-service status | Priority | Effort | Notes |
| --- | --- | --- | --- | --- |
| `craftRecipe` | Partial: `craft.item` exists | Essential | Medium | Missing temporary crafting table placement/cleanup when no table exists; schema matches intent. |
| `wait` | Missing | Nice-to-have | Small | Useful as `utility.wait` or job delay, but not required for core body control. |
| `smeltItem` | Partial: `craft.smelt_item` exists | Essential | Medium | Needs stronger smeltability validation, fuel accounting, reliable cleanup, temporary furnace behavior. |
| `clearNearestFurnace` | Missing | Nice-to-have | Small | Useful companion to smelting; add as `craft.clear_nearest_furnace` or inventory/container skill. |
| `attackNearest` | Implemented as `combat.attack_nearest` | Essential | Small | Mostly present; needs mode/lane cleanup and better kill timeout semantics. |
| `attackEntity` | Implemented differently as `combat.attack_entity` | Essential | Small | Supports ID/type; spec expects ID + kill. Add `kill` parameter parity. |
| `defendSelf` | Partial: `combat.defend_self` | Essential | Medium | Current schema uses `distance` not spec `range`; likely increments defeated before confirming death. |
| `collectBlock` | Partial: `mine.collect_blocks` | Essential | Medium | Aliases exist; missing `exclude`, safety checks, inventory capacity, falling block/liquid details. |
| `pickupNearbyItems` | Implemented as `inventory.pickup_nearby` | Nice-to-have | Small | Present; progress/count semantics are approximate. |
| `breakBlockAt` | Implemented as `mine.break_block_at` | Essential | Small | Present; needs safety/tool consistency and cleanup on cancellation. |
| `placeBlock` | Missing | Essential for building | Medium | Docs mention `block.place` permissions, but no built-in placement skill exists. |
| `equip` | Implemented as `inventory.equip` | Essential | Small | Present. |
| `discard` | Implemented as `inventory.discard` | Essential | Small | Present; uses fragile `findInventoryItem` by name cast. |
| `putInChest` | Implemented differently | Essential | Medium | Implementation requires coordinates; docs/Mindcraft use nearest chest. Align schema or docs. |
| `takeFromChest` | Implemented differently | Essential | Medium | Same nearest-vs-coordinate mismatch. |
| `viewChest` | Implemented differently | Essential | Medium | Requires coordinates despite docs saying empty params/nearest chest. |
| `consume` | Missing | Nice-to-have | Small | Auto-eat plugin exists, but explicit `inventory.consume` should be added. |
| `giveToPlayer` | Implemented with different params | Nice-to-have | Small | Uses `itemName`; docs use `itemType`. Behavior mostly present. |
| `goToGoal` | Internal helper only | Unnecessary as API | N/A | Should stay internal; not a public structured skill. |
| `goToPosition` | Implemented as `move.to_position` | Essential | Small | Schema uses `distance`; docs use `minDistance`. Align. |
| `goToNearestBlock` | Implemented as `move.to_block` | Essential | Small | Schema lacks `minDistance` and uses `distance` for range. Align. |
| `goToNearestEntity` | Missing | Nice-to-have | Small | Useful as `move.to_entity`; spec mentions it in category list. |
| `goToPlayer` | Implemented as `move.to_player` | Essential | Small | Present. |
| `followPlayer` | Implemented as `move.follow_player` | Essential | Medium | Present, but long-running success/cancellation semantics should be fixed. |
| `moveAway` | Missing | Nice-to-have | Small | Useful primitive; `move.avoid_enemies` covers only hostile case. |
| `moveAwayFromEntity` | Missing | Nice-to-have | Small | Internal helper for give/flee; no public skill needed unless `move.away_from_entity`. |
| `avoidEnemies` | Implemented as `move.avoid_enemies` | Essential | Medium | Present but simplistic. |
| `stay` | Implemented as `move.stay` | Essential | Small | Present; ensure cancellation result is `cancelled`, not successful interruption. |
| `useDoor` | Missing | Nice-to-have | Medium | Helpful navigation/action primitive; not MVP. |
| `goToBed` | Missing | Nice-to-have | Medium | Useful survival behavior, not MVP. |
| `tillAndSow` | Missing | Nice-to-have | Medium | Farming extension, not core MVP. |
| `activateNearestBlock` | Missing | Nice-to-have | Medium | Needed for buttons/levers/doors if interaction support expands. |
| `showVillagerTrades` | Missing | Nice-to-have | Medium | Good advanced gameplay, not MVP. |
| `tradeWithVillager` | Missing | Nice-to-have | Large | Requires container/trade safety and schemas. |
| `digDown` | Implemented differently | Essential | Small | Docs/Mindcraft use distance; implementation uses targetY. Align. |
| `goToSurface` | Implemented as `mine.go_to_surface` | Nice-to-have | Small | Present. |
| `useToolOn` | Missing | Nice-to-have | Medium | Useful for bucket/shears/hoe/interaction tasks; can wait. |
| `useToolOnBlock` | Internal helper missing | Nice-to-have | Medium | Needed if adding `useToolOn`. |
| `log` | Replaced by ctx logging | Implemented better | N/A | Service logging/output envelope is the right replacement. |

### Mindcraft World Queries

| Mindcraft query/helper | mc-agent-service status | Priority | Effort | Notes |
| --- | --- | --- | --- | --- |
| `getNearestFreeSpace` | Missing | Essential for placement | Medium | Needed before robust craft-table/furnace/block placement. |
| `getBlockAtPosition` | Missing as explicit query | Nice-to-have | Small | Add `observe.block_at` if docs keep it. |
| `getSurroundingBlocks` | Missing | Nice-to-have | Small | Useful for debugging/local context. |
| `getFirstBlockAboveHead` | Missing | Nice-to-have | Small | Useful underground/surface reasoning. |
| `getNearestBlocks` | Partial: `observe.nearby_blocks` | Essential | Small | Schema differs: docs use `blockTypes` and `count`; implementation uses `blockType` and `num`. |
| `getNearestBlocksWhere` | Internal helper not present | Unnecessary as API | N/A | Predicate queries should not be public because clients cannot send code. |
| `getNearestBlock` | Partial through `move.to_block`/`observe.nearby_blocks` | Essential | Small | Good enough if `count: 1` is supported. |
| `getNearbyEntities` | Implemented as `observe.nearby_entities` | Essential | Small | Present, but schema differs from docs. |
| `getNearestEntityWhere` | Internal helper missing | Nice-to-have | Small | Add typed helpers, not public predicate API. |
| `getNearbyPlayers` | Partial via `observe.nearby` | Essential | Small | Present. |
| `getVillagerProfession` | Missing | Nice-to-have | Small | Needed before villager trade tools. |
| `getInventoryCounts` | Implemented | Essential | Small | Present in state and `observe.inventory`. |
| `getCraftableItems` | Implemented as `observe.craftable` | Essential | Medium | Present, but recipe details may be incomplete. |
| `getPosition` | Implemented | Essential | Small | Present in state/position endpoint. |
| `getNearbyEntityTypes` | Partial | Nice-to-have | Small | Can be derived from `observe.nearby_entities`; not explicit. |
| `isEntityType` | Missing helper | Nice-to-have | Small | Useful for validation in `useToolOn`/move-to-entity. |
| `getNearbyPlayerNames` | Partial | Essential | Small | Derivable from state. |
| `getNearbyBlockTypes` | Partial via `observe.nearby` | Essential | Medium | Current block sampling is approximate and state cache has empty `nearby.blocks`. |
| `isClearPath` | Missing | Essential for modes | Medium | Mindcraft modes use it to avoid bad interruptions. |
| `shouldPlaceTorch` | Missing | Nice-to-have | Medium | Needed for torch mode. |
| `getBiomeName` | Implemented | Nice-to-have | Small | Present in state, but biome detection should be verified. |

### Mindcraft Commands

| Command capability | Service equivalent | Priority | Effort | Recommendation |
| --- | --- | --- | --- | --- |
| `!newAction` generated code | None | Unnecessary | N/A | Explicitly keep out of core. Conflicts with no arbitrary JS/code-gen endpoint. |
| `!stop` | Job cancellation / emergency-stop | Essential | Medium | Fix cancellation semantics and add real emergency stop. |
| `!stfu` | None | Unnecessary | N/A | Mindcraft chat-loop behavior, not service core. |
| `!restart` | Process manager concern | Unnecessary | N/A | Do not expose restart endpoint in core. |
| `!clearChat` | None | Nice-to-have | Small | Only if chat history is persisted later. |
| Movement commands | Movement skills | Essential | Small/Medium | Mostly covered except move-away and entity navigation. |
| `!rememberHere`, `!goToRememberedPlace`, `!savedPlaces` | Memory absent | Nice-to-have | Medium | Position memory is useful but optional; implement via memory provider. |
| Inventory/container commands | Inventory skills | Essential | Medium | Covered but schema mismatches must be resolved. |
| Mining/crafting/combat commands | Skills | Essential | Medium | Mostly covered; add placement, consume, clear furnace. |
| `!setMode` | Broken mode endpoint | Essential | Small | Worker must implement `toggleMode`; expose correct events. |
| `!goal`, `!endGoal` self-prompting | None | Unnecessary in core | N/A | Keep as external planner/Hermes responsibility. |
| Villager commands | None | Nice-to-have | Medium/Large | Advanced gameplay. |
| Bot-to-bot conversation commands | None | Unnecessary | N/A | Product-specific Mindcraft behavior. |
| `!lookAtPlayer`, `!lookAtPosition` | Broken `POST /look` | Nice-to-have | Medium | Add `look.at_position`, `look.at_player`, `look.at_entity` or remove endpoint until implemented. |
| `!useOn` | None | Nice-to-have | Medium | Add later for tool/entity/block interaction. |

### Mindcraft Query Commands

| Query command | Service equivalent | Priority | Effort | Recommendation |
| --- | --- | --- | --- | --- |
| `!stats` | `GET /state`, `observe.state` | Essential | Small | Present; state shape needs contract cleanup. |
| `!inventory` | `GET /inventory`, `observe.inventory` | Essential | Small | Present. |
| `!nearbyBlocks` | `observe.nearby_blocks` | Essential | Medium | Present but schema mismatch and no cached nearby blocks. |
| `!craftable` | `observe.craftable` | Essential | Medium | Present. |
| `!entities` | `observe.nearby_entities`, `observe.nearby` | Essential | Small | Present. |
| `!modes` | `GET /modes` | Essential | Small | Present, but toggling broken and mode runtime shallow. |
| `!savedPlaces` | None | Nice-to-have | Medium | Optional memory. |
| Blueprint queries | None | Unnecessary | N/A | Mindcraft task-specific construction module, not core service. |
| `!getCraftingPlan` | None | Nice-to-have | Medium | Valuable planning query; add after recipe helper layer. |
| `!searchWiki` | None | Unnecessary in core | N/A | External agents can browse; do not put web scraping in service core. |
| `!help` | `GET /skills`, MCP resources | Essential | Small | Present. |

### Reactive Modes

| Mindcraft mode | mc-agent-service status | Priority | Effort | Notes |
| --- | --- | --- | --- | --- |
| `self_preservation` | Partial | Essential | Large | Current mode mostly interrupts/jumps; it does not reliably flee, place water, or recover. |
| `unstuck` | Partial | Essential | Medium | Current mode interrupts but does not perform an unstuck action. |
| `cowardice` | Missing | Nice-to-have | Medium | Could be folded into self-preservation/self-defense policy. |
| `self_defense` | Partial | Essential | Large | Interrupts only; should run `combat.defend_self` through arbitration. |
| `hunting` | Missing | Nice-to-have | Medium | Not MVP. |
| `item_collecting` | Missing | Nice-to-have | Medium | Useful but can wait behind primary job reliability. |
| `torch_placing` | Missing | Nice-to-have | Medium | Useful during mining; requires placement skill and light/torch helper. |
| `elbow_room` | Missing | Nice-to-have | Small | Cosmetic/multi-bot ergonomics. |
| `idle_staring` | Missing | Unnecessary | N/A | Cosmetic animation. |
| `cheat` | Missing by design | Unnecessary | N/A | Keep out of production service; maybe test-only mode later. |

### Mindcraft Autonomous/LLM Surfaces

| Capability | Service status | Priority | Effort | Decision |
| --- | --- | --- | --- | --- |
| Self-prompter autonomous loop | Missing | Unnecessary in core | N/A | Keep external; document Hermes/Codex planner loop instead. |
| Code generation and sandboxed execution | Missing | Unnecessary | N/A | Correctly excluded by non-goals. |
| Position memory bank | Missing | Nice-to-have | Medium | Add through optional memory provider, not global object. |
| Conversation history summarization | Missing | Nice-to-have externally | Large | Could live in Hermes, not service core. |
| Vision screenshot interpretation | Missing | Advanced | Large | Optional read-only module later. |
| TTS/speak | Missing | Unnecessary | N/A | Not relevant to service API. |

## B. Our Advantages Over Mindcraft

- Clean service boundary: external agents call stable REST/WebSocket/MCP APIs rather than embedding Mineflayer and LLM logic in one process.
- Structured skill inputs with Zod validation instead of natural-language command parsing.
- Worker-thread isolation per bot, which is better aligned with multi-bot and failure isolation.
- Job model with IDs, timestamps, state, progress, timeout, retry fields, and cancellation metadata.
- API-facing skill registry and generated JSON schemas from Zod skill schemas.
- Explicit permission model per bot for movement, inventory, block break/place, combat, chat, container, and entity interaction.
- Authentication and rate-limiting modules exist.
- WebSocket event fanout exists and is transport-neutral.
- MCP adapter exists and uses the same BotManager/JobManager services as REST for many operations.
- Mineflayer adapter centralizes plugin loading and compatibility policies.
- NaN coordinate detection is a useful guardrail not present as a first-class concern in Mindcraft.
- No arbitrary client JavaScript execution in core. This is a major security improvement over Mindcraft's `!newAction`.
- The TypeScript domain types create a path to contract tests and client generation.

## C. Design Doc Compliance Check

### SPEC.md

| Requirement area | Status | Notes |
| --- | --- | --- |
| Standalone TypeScript/Node service | Fully implemented | Service boots from `src/index.ts`; build passes. |
| REST, WebSocket, MCP API adapters | Partially implemented | All exist. Some required endpoints/tools are missing or broken. |
| No bundled LLM / no natural language parser / no arbitrary JS endpoint | Fully implemented | Good alignment with non-goals. |
| Multiple bots in one service instance | Partially implemented | BotManager supports many records/workers, but queue/lane/job correctness needs fixes. |
| One worker thread per bot | Fully implemented | Worker entry exists and BotManager spawns workers. |
| Control plane must not own Mineflayer objects | Fully implemented structurally | Mineflayer imports are in bot runtime/adapter/skills, not core control plane. |
| BotManager lifecycle statuses | Partially implemented | Statuses exist, but reconnecting/spawning semantics are incomplete and duplicate disconnect events occur. |
| JobManager lifecycle/progress/cancellation/timeouts/retry | Partially implemented | Core exists, but timeout state diverges from spec, cancellation is not finalized correctly, duplicate worker event handling exists. |
| EventBus ID/timestamp stamping | Partially implemented | EventBus can stamp, but callers pass empty strings so many events keep empty `id`/`ts`. |
| Event replay/persistence | Not implemented | No storage provider. |
| Config defaults/file/env validation | Partially implemented | Defaults/file/env exist; CLI flags and broader persistence not present. |
| MineflayerAdapter plugins | Fully implemented | pathfinder, pvp, collectblock, auto-eat, armor-manager loaded. |
| Resource pack / packet throttle / PartialRead compatibility | Partially implemented | Present, but position throttle timer tracking is not robust. |
| StateTracker required state | Partially implemented | Core state exists; nearby blocks are empty in cached snapshot; equipment/weather details are incomplete. |
| SkillExecutor registry/validation/permissions/progress | Partially implemented | Present, but no action lanes, weak cancellation cleanup, and no plugin loading. |
| ModeEngine background policies | Partially implemented | Three modes registered; they mostly interrupt rather than perform recovery actions. |
| Optional memory providers | Not implemented | Docs should mark as future. |
| Storage JSONL | Not implemented | No event/job persistence. |
| API `POST /jobs` | Not implemented | Type schema exists; route missing. |
| MCP required tools | Partially implemented | Some required tools exist, many documented tools missing. |
| Reconnection policy | Partially implemented | Adapter reconnects internally; control-plane state/job integration is weak. |
| Multi-bot action lanes | Not implemented | No real lane locks; async worker handlers allow overlap. |
| Testing strategy | Not implemented | No tests; `npm test` fails due to no test files. |

### SKILLS.md

| Requirement area | Status | Notes |
| --- | --- | --- |
| Skill shape with name/category/permissions/timeout/busyPolicy/schema/handler | Partially implemented | Runtime shape uses `run`, API shape uses generated schemas. |
| Permission names | Fully implemented | Public permission names match the compatibility note. |
| Custom plugin manifest loading | Not implemented | Manifest schema exists only as type/schema. |
| Skill result envelope | Partially implemented | Skills return envelopes; cancellation/error consistency needs work. |
| Movement built-ins | Partially implemented | Missing `move.to_entity`/`move.away`; schema mismatches for `minDistance`/`range`. |
| Mining built-ins | Partially implemented | All listed exist, but `mine.dig_down` schema is wrong and `collect_blocks.exclude` missing. |
| Crafting built-ins | Partially implemented | `craft.item` and `craft.smelt_item` exist; `clear_nearest_furnace` missing from broader spec examples. |
| Combat built-ins | Partially implemented | Present, but schemas differ and behavior is shallow. |
| Inventory built-ins | Partially implemented | Missing `inventory.consume`; chest skills require coordinates contrary to docs. |
| Observation built-ins | Partially implemented | Missing `observe.block_at`/biome explicit skill; parameter names diverge. |
| Communication built-ins | Partially implemented | `chat.send` exists; REST `asJob` uses wrong skill name. |
| Action lifecycle cleanup | Partially implemented | Some skills clean up locally; no centralized cleanup for pathfinder/PVP/windows/timers/control states. |
| Documentation auto-generation | Partially implemented | Zod-to-JSON exists for skill registry; no OpenAPI/doc generation. |

### API.md

| API requirement | Status | Notes |
| --- | --- | --- |
| `POST /bots` | Fully implemented | Returns created detail, starts worker. |
| `GET /bots` | Fully implemented | Present. |
| `GET /bots/{botId}` | Partially implemented | Returns `config: {}` instead of real/redacted config. |
| `POST /bots/{botId}/start` | Partially implemented | `forceReconnect` and `reason` are ignored. |
| `POST /bots/{botId}/stop` | Partially implemented | `cancelRunningJobs` ignored. |
| `DELETE /bots/{botId}` | Partially implemented | Does not await async destroy. |
| `GET /bots/{botId}/state` | Partially implemented | Depends on cache; no direct worker snapshot fallback. |
| `GET /bots/{botId}/inventory` | Partially implemented | Present if cached state exists. |
| `GET /bots/{botId}/nearby` | Partially implemented | Nearby blocks are empty in cached state. |
| `GET /bots/{botId}/position` | Fully implemented | Present. |
| `GET/PATCH /modes` | Partially/broken | GET works from cache; PATCH is no-op because worker does not handle `toggleMode`. |
| `GET /skills`, `GET /skills/{name}` | Fully implemented | Present. |
| `POST /bots/{botId}/actions/{skillName}` | Fully implemented structurally | Works for registered skills, subject to job/worker bugs. |
| `GET /jobs`, `GET /jobs/{jobId}` | Fully implemented | Present. |
| `POST /jobs` | Not implemented | Type exists, route missing. |
| `POST /jobs/{jobId}/cancel` | Partially implemented | Request accepted; running job terminal state is unreliable. |
| `POST /bots/{botId}/chat` | Partially implemented | Sync path works but emits wrong event type; async path uses wrong skill name. |
| `POST /bots/{botId}/look` | Broken | Dispatches nonexistent `move.look` and returns success immediately. |
| `POST /bots/{botId}/observe` | Partially implemented | Ignores request shape and only returns cached subset. |
| WebSocket subscribe/unsubscribe | Partially implemented | Basic filtering exists; no replay/cursor support. |
| MCP resources | Partially implemented | Bots, state, inventory, jobs, skills exist. |
| MCP tools | Partially implemented | Missing many documented tools and naming differs from API.md. |
| Error object format | Partially implemented | Present, but codes vary from docs and some API errors become 500. |
| Authentication/rate limiting | Partially implemented | Modules exist; MCP auth import is unused in `mcp.ts` HTTP setup. |

### ARCHITECTURE.md

| Architecture decision | Status | Notes |
| --- | --- | --- |
| Strict module dependency direction | Mostly implemented | API/control do not import Mineflayer. |
| Worker process model | Implemented | One worker per bot. |
| Typed worker messages | Partially implemented | `toggleMode` is in schema but not handled by worker switch. |
| State snapshots and diffs | Partially implemented | Snapshots exist; diffs exist but are not used for WS coalescing/replay. |
| Event system with filtering/replay | Partially implemented | Filtering exists; persistence/replay absent; IDs/timestamps often empty. |
| Extension points for skills/memory/modes/middleware | Partially implemented | Middleware exists; skills/memory/modes plugins not implemented. |
| Security model | Partially implemented | Strong no-code-exec posture; plugin sandbox not implemented because plugin loading absent. |
| Error classification/reconnect | Partially implemented | Adapter classifies some transient errors; control-plane integration incomplete. |
| Testing strategy | Not implemented | No tests. |

## D. Recommended Design Doc Adjustments

### Requirements That Are Unrealistic for the Current MVP

- Full memory provider stack (`none`, `file`, `hermes-proxy`) is too much for the first stable core. Keep `none` only until jobs/events are reliable.
- Full custom skill plugin loading and hot reload should move after built-in skill contracts stabilize.
- Vision, viewer, autonomous loop, and multi-bot coordination modules should remain future/optional and not be acceptance criteria for core.
- Advanced Mindcraft gameplay surfaces like villager trading, farming, sleeping, wiki search, blueprint checks, and TTS should not be required for MVP.
- Exact Mindcraft command parity should not be a goal. Structured skill parity should be the goal.

### Missing Requirements

- A formal skill-schema compatibility policy. Decide whether docs or implementation names win, then enforce with contract tests.
- A real action-lane model: primary lane, observation lane, system lane, and exclusive resource locks for pathfinder, PVP, containers, digging, and control states.
- A cancellation completion protocol from worker to JobManager: `jobCancelled` event or `SkillResult.status === "cancelled"` mapping to `job.cancelled`.
- EventBus rule: callers must omit `id`/`ts`; empty IDs/timestamps should be normalized or rejected.
- Contract tests for REST responses, WebSocket event envelopes, MCP tool schemas, and skill parameter schemas.
- A safe direct snapshot request path for state endpoints when cache is empty/stale.
- A central cleanup utility for pathfinder goals, PVP, digging, control states, active item use, open windows, intervals, and scoped mode pauses.

### Priority Changes

1. Put lifecycle and contract correctness before adding more gameplay skills.
2. Align `SKILLS.md` with implemented schemas or change implementation to match docs before external integrations rely on it.
3. Make `chat.send`, mode toggling, cancellation, and observation reliable before adding memory or vision.
4. Add placement only after `getNearestFreeSpace`, inventory checks, and cleanup exist.
5. Treat MCP as a first-class contract, not a partial convenience layer; Hermes integration will depend on stable MCP behavior.

### Architecture Revisions

- Document that the MVP has no storage provider and no memory provider unless explicitly implemented.
- Replace "ModeEngine runs background behavior" with a staged model:
  - Stage 1: modes can interrupt and emit events.
  - Stage 2: modes can enqueue/execute built-in safety skills through lanes.
  - Stage 3: custom modes.
- Make internal reconnect ownership clear. Either the worker/adapter owns reconnect fully and reports it, or BotManager owns reconnect scheduling. Avoid both.
- Standardize public skill names and parameters:
  - Prefer `minDistance`/`range` from docs, or update docs to `distance`.
  - Prefer nearest chest skills if Mindcraft parity matters; otherwise rename coordinate forms to `*_at`.
  - Use `chat.send` everywhere.
- Remove `timeout` from public `JobState` or document it everywhere. The design docs currently say timeout finishes as `failed`.

## E. Prioritized Roadmap

### Phase 1: Bug Fixes and Contract Breakers

Estimated effort: 1-2 weeks.

1. Fix event stamping.
   - Stop passing `id: ""` and `ts: ""`.
   - Make `EventBus.emit` treat empty strings as absent.
   - Add tests for monotonic IDs and timestamps.

2. Fix worker event forwarding.
   - Remove duplicate `jobEventHandler?.(event)` calls in `BotManager`.
   - Ensure `job.progress`, `job.completed`, `job.failed`, and queue dispatch happen exactly once.

3. Fix job cancellation.
   - Add a worker `jobCancelled` event or map cancelled `SkillResult` to `job.cancelled`.
   - Ensure `cancelJob` on a running job transitions terminally without waiting for timeout.
   - Implement `emergency-stop` cleanup of pathfinder, PVP, digging, controls, active item, and windows.

4. Enforce one primary action.
   - Make the worker serialize `runSkill` commands.
   - Do not start a replacement job until the cancelled job has completed cleanup.
   - Prevent `SkillExecutor.currentController` from being overwritten by concurrent skills.

5. Fix broken API paths.
   - `POST /bots/{botId}/chat` with `asJob` must submit `chat.send`.
   - `POST /bots/{botId}/look` must either be removed or backed by real look skills.
   - `PATCH /bots/{botId}/modes/{modeName}` must be handled by worker and ModeEngine.
   - `DELETE /bots/{botId}` should await `destroyBot`.
   - `GET /bots/{botId}` should return real redacted config or docs should say config is omitted.

6. Resolve job state mismatch.
   - Remove public `timeout` state and represent timeout as `failed` with `JOB_TIMEOUT`, or update all docs/API filters/events to include `timeout`.

7. Add minimal tests.
   - JobManager transitions and busy policies.
   - EventBus stamping.
   - Worker command schema/switch coverage.
   - REST route behavior for chat/look/modes/cancel.

### Phase 2: Critical Missing Features

Estimated effort: 2-4 weeks.

1. Align built-in skill schemas with `SKILLS.md`.
   - `move.to_position`: `minDistance`.
   - `move.to_block`: `blockType`, `minDistance`, `range`.
   - `mine.collect_blocks`: `exclude`.
   - `mine.dig_down`: `distance`, not `targetY`.
   - `combat.defend_self`: `range`.
   - `inventory.*_chest`: either nearest-chest schemas or rename coordinate variants.
   - `observe.nearby*`: align `maxDistance`, `blockTypes`, `count`, `includePlayers`.

2. Add missing MVP skills.
   - `block.place` / `place.block_at`.
   - `inventory.consume`.
   - `move.to_entity` or equivalent.
   - `move.away`.
   - `craft.clear_nearest_furnace` if smelting remains a core skill.

3. Build shared world/inventory helper layer.
   - Nearest block/entity/player helpers.
   - Nearest free space.
   - Clear path.
   - Inventory counts and item lookup by name/id.
   - Block DTO/entity DTO conversion.

4. Improve state and observation.
   - Populate cached nearby blocks or document that blocks are on-demand only.
   - Add direct worker snapshot fallback for state endpoints.
   - Fix weather fields.
   - Add equipment slots beyond hand.

5. Improve skill safety.
   - Harvestability, falling block, liquid, inventory capacity, and tool checks.
   - Central cleanup utility used by every mutating skill.

### Phase 3: Architecture Improvements

Estimated effort: 3-6 weeks.

1. Implement action lanes.
   - Primary lane for mutating skills.
   - Observation lane for cached/safe reads.
   - System lane for stop/destroy/emergency-stop.
   - Exclusive locks for pathfinder, PVP, container/window, digging, and control states.

2. Rework ModeEngine execution.
   - Track current skill name correctly.
   - Implement mode conflict declarations using public permissions.
   - Let modes request actions through the same lane/cleanup path.
   - Start with self-preservation, self-defense, and unstuck.

3. Reconnection architecture.
   - Decide whether reconnect lives in BotManager or MineflayerAdapter.
   - Ensure running jobs are failed/cancelled/retried consistently on disconnect.
   - Emit `bot.reconnecting` and `bot.spawned` accurately.

4. Persistence.
   - JSONL event log.
   - Job history.
   - Optional config/state recovery.
   - WebSocket replay from cursor.

5. Contract tests and generated docs.
   - REST schemas vs actual responses.
   - MCP tools vs skill schemas.
   - WebSocket envelopes.
   - Skill list contains every built-in with valid JSON Schema.

### Phase 4: Platform Integration

Estimated effort: 2-4 weeks after Phase 2/3 foundations.

1. MCP alignment.
   - Add all required API.md tools: `move_to_player`, `follow_player`, `stay`, `break_block`, `smelt_item`, `attack_nearest`, `defend_self`, `equip_item`, `view_chest`, `get_inventory`, `get_nearby`, etc.
   - Decide naming convention: API.md snake_case tools vs generated dotted skill tools.
   - Return stable machine-readable envelopes consistently.

2. Hermes plugin integration.
   - Keep Hermes as an external planner/memory client.
   - Add optional `hermes-proxy` memory only after storage and errors are robust.
   - Provide a documented MCP/REST integration recipe.

3. OpenAPI/JSON Schema output.
   - Generate OpenAPI for REST.
   - Generate MCP tool metadata from the same skill registry.
   - Version schemas.

4. Auth and deployment hardening.
   - Verify MCP HTTP auth.
   - Redact configs in responses/logs.
   - Add request IDs and structured audit logs.

### Phase 5: Advanced Features

Estimated effort: 1-3 months, incremental.

1. Advanced behavior loop.
   - Not in core LLM runtime.
   - Provide examples where Hermes/Codex drives goals by submitting structured jobs.

2. Multi-bot coordination.
   - Bot tags/metadata.
   - Per-bot queues and state streams.
   - Coordination stays outside primary mutation path.

3. Vision.
   - Read-only screenshots/scene summaries.
   - No hidden action side effects.
   - Optional and auth-protected.

4. Gameplay extensions.
   - Villager trade inspect/execute.
   - Farming/till/sow/harvest.
   - Sleep/bed.
   - Tool-on-block/entity interactions.
   - Torch placement mode.
   - Item collecting/hunting modes.

5. Plugin system.
   - Manifest loader.
   - Runtime registry comparison.
   - Vetted plugin directories.
   - Hot reload only after stable tests and sandbox policy.

## Recommended Immediate Acceptance Criteria

The service should not be considered MVP-ready until these are true:

- `npm test` runs at least control-plane/API unit tests and passes.
- `chat.send`, `move.to_position`, `observe.state`, `observe.inventory`, `mine.break_block_at`, and cancellation work end-to-end through REST and MCP.
- No public endpoint returns success for a nonexistent skill.
- Every emitted event has a non-empty ID and timestamp.
- A running job can be cancelled and reaches `cancelled` without waiting for timeout.
- A queued job starts only after the previous primary job finishes cleanup.
- `GET /skills` schemas match the parameters accepted by the worker.
- Design docs and implementation agree on public skill names and parameters.
