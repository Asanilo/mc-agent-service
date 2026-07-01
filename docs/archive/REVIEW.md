# mc-agent-service Code Review

> Codex review, 2026-06-20. Read-only analysis against SPEC.md, API.md, SKILLS.md, ARCHITECTURE.md and Mindcraft reference.

## Executive Findings

1. **P0 — MCP skill-name mismatch**: MCP tools use `move_to`, `follow_player`, `collect_blocks`, `craft_item` but registered skills are dot-names (`move.to_position`, `move.follow_player`, `mine.collect_blocks`, `craft.item`). All MCP tool calls will fail with `SKILL_NOT_FOUND`.

2. **P0 — NaN coordinate bug unfixed**: Raw Mineflayer positions emitted/stored without finite validation in `mineflayer-adapter.ts:256` and `state-tracker.ts:125`. Zod `Vec3Schema` uses `.finite()` but runtime snapshots aren't parsed through it.

3. **P0 — Worker protocol not runtime-validated**: `parentPort.on("message")` trusts `WorkerCommand`; main-thread worker events trusted in `bot-manager.ts`. No Zod `safeParse` at boundaries.

4. **P0 — `state.changed` schema deviation**: Schema expects `{ sequence, patch, snapshot? }` (events.ts:73); implementation emits full `BotState` directly (bot-manager.ts:381).

5. **P0 — Job lifecycle gaps**: `BotRuntime.runSkill()` returns `BOT_NOT_READY` without emitting `jobFailed`. Worker ignores returned promise. `BotManager` summaries never set `busy=true` on dispatch.

6. **P1 — Unimplemented**: Storage/event log/job history, auth middleware, rate limiting, custom skill plugin loading, several REST/MCP endpoints.

## Code Quality

| Dimension | Assessment |
|-----------|-----------|
| Type safety | ✅ strict mode, noImplicitAny, strictNullChecks. Leaks: `as any` in event emissions, skill registration |
| Zod usage | ✅ Good for config/REST. ⚠️ Weak at worker boundaries — messages not safeParsed |
| Error handling | ⚠️ Worker crash doesn't fail/retry active jobs. EventBus swallows subscriber errors |
| Module coupling | ✅ Clean high-level separation. ⚠️ SkillRegistry/BotStateCache embedded in rest.ts |
| Thread safety | ⚠️ Reconnect can create new BotRuntime without destroying old one |
| Memory leaks | ⚠️ BotStateCache never clears stale entries. StateTracker binds without unbind |

## Spec Compliance

| Requirement | Status |
|-------------|--------|
| TypeScript strict + worker isolation | ✅ |
| Config validation with Zod | ✅ |
| Multi-bot support | ⚠️ Worker/job crash recovery incomplete |
| Job system (queue/cancel/retry/timeout) | ⚠️ Lacks durable history, worker-crash reconciliation |
| Built-in skills (19 minimum) | ⚠️ 21/19 minimum, ~21/29 full SKILLS.md list |
| Auth + rate limiting | ❌ Documented but no middleware |
| Storage adapters | ❌ Specified but not implemented |
| REST completeness | ⚠️ Missing /jobs, /position, /look, mode toggles |
| MCP completeness | ⚠️ Missing inventory/job resources, wrong tool names |

## Mindcraft Comparison

| Dimension | Mindcraft | mc-agent-service |
|-----------|-----------|-----------------|
| Skills count | 38 actions + 21 world queries | 21 built-in skills |
| Gameplay primitives | Richer (placeBlock, digDown, villager trading, farming, bed/door/tool) | Basic set covers core loop |
| World queries | Dedicated helpers (getNearestBlock, getBiomeName, isClearPath) | Consolidated observation skills |
| Mining safety | safeToBreak, falling/flow checks | No safety checks |
| Type safety | None (plain JS) | Full Zod + TypeScript strict |
| API surface | Socket.IO events only | REST + WebSocket + MCP |
| Job model | ActionManager (single action) | Full job lifecycle with queue/retry/timeout |
| Worker isolation | Child process per agent | worker_threads per bot |
| Error recovery | Log and exit | Exponential backoff reconnect |
| Cancellation | interrupt_code flag | AbortSignal per skill |

## Recommendations (prioritized)

1. **P0, 0.5-1d**: Fix MCP skill-name mappings to dot-name registry
2. **P0, 1-2d**: Add finite coordinate validation in MineflayerAdapter/StateTracker; NaN → disconnect/reconnect
3. **P0, 2-4d**: Harden worker lifecycle: Zod-parse commands/events, fail jobs on worker exit, terminate workers on shutdown
4. **P1, 1-2d**: Implement auth + rate-limit middleware
5. **P1, 2-3d**: Align REST/MCP with docs: add missing endpoints, fix tool names, add resources
6. **P1, 2-4d**: Generate skill parameter schemas from Zod for API/MCP exposure
7. **P2, 3-6d**: Storage adapters for event/job history
8. **P2, 3-5d**: Close Mindcraft skill gaps (move.to_block, mine.dig_down, mine.go_to_surface, move.avoid_enemies, inventory.give_to_player)
