# mc-agent-service Technical Architecture

This document describes the module boundaries, runtime process model, data flows, state model, event system, extension points, security model, error handling, and testing strategy for `mc-agent-service`.

The central rule is strict: the Control Plane does not import Mineflayer. Only Bot Worker runtime modules own Mineflayer objects or call Mineflayer APIs.

## 1. Module Dependency Graph

Allowed import and call directions:

```text
External Clients
  REST / WebSocket / MCP callers
        |
        v
+--------------------------------------------------+
| API Gateway                                      |
| Express REST, ws WebSocket, MCP adapter          |
| - auth                                           |
| - rate limits                                    |
| - request/response validation                    |
+--------------------------+-----------------------+
                           |
                           v
+--------------------------------------------------+
| Control Plane                                    |
| - BotManager                                     |
| - JobManager                                     |
| - EventBus                                       |
| - Config                                         |
| - Storage                                        |
|                                                  |
| IMPORTANT: no Mineflayer imports are allowed.    |
+--------------------------+-----------------------+
                           |
                           | worker_threads messages
                           v
+--------------------------------------------------+
| Bot Worker                                       |
| one worker per bot                               |
| - mailbox                                        |
| - action lanes                                   |
| - worker message handlers                        |
+--------------------------+-----------------------+
                           |
                           v
+--------------------------------------------------+
| Bot Runtime                                      |
| - SkillExecutor                                  |
| - ModeEngine                                     |
| - StateTracker                                   |
| - ConnectionSupervisor                           |
| - MineflayerAdapter                              |
+--------------------------+-----------------------+
                           |
                           v
+--------------------------------------------------+
| Mineflayer + plugins                             |
| mineflayer-pathfinder, pvp, collectblock, etc.   |
+--------------------------+-----------------------+
                           |
                           v
+--------------------------------------------------+
| Minecraft Server                                 |
+--------------------------------------------------+
```

Import rules:

```text
API Gateway
  may import: Control Plane service interfaces, Zod/API schemas, auth/rate-limit helpers
  must not import: Mineflayer, Mineflayer plugins, Bot Runtime internals

Control Plane
  may import: worker message types, storage interfaces, event types, config schemas
  must not import: Mineflayer, Mineflayer plugins, live bot classes

Bot Worker
  may import: Bot Runtime modules, worker message types
  owns: one bot runtime instance

Bot Runtime
  may import: MineflayerAdapter, StateTracker, SkillExecutor, ModeEngine
  owns: live Mineflayer bot and plugin state

MineflayerAdapter
  may import: mineflayer and Mineflayer plugins
  is the only low-level integration boundary for Mineflayer creation and direct calls
```

## 2. Data Flow Diagrams

### Scenario A: External Agent Sends "mine 64 diamonds"

The core service does not interpret natural language. The external caller, adapter, or upstream planner must submit a structured skill request such as `mine.collect_blocks` with `{ "blockType": "diamond_ore", "num": 64 }`.

```text
Caller intent:
  "mine 64 diamonds"

Structured API request:
  POST /bots/{botId}/actions/mine.collect_blocks
  {
    "params": { "blockType": "diamond_ore", "num": 64 },
    "busyPolicy": "queue"
  }

Forward path:

+------------------+
| External Agent   |
+---------+--------+
          |
          | HTTP POST /bots/{botId}/actions/mine.collect_blocks
          v
+------------------+
| REST API         |
| validate request |
+---------+--------+
          |
          | create skill invocation
          v
+------------------+
| SkillExecutor    |
| resolve skill    |
| validate params  |
| check permission |
+---------+--------+
          |
          | create async job
          v
+------------------+
| JobManager       |
| state: pending   |
| apply busyPolicy |
+---------+--------+
          |
          | runSkill message
          v
+------------------+
| Bot Worker       |
| acquire lane     |
| state: running   |
+---------+--------+
          |
          | execute handler
          v
+------------------+
| Mineflayer       |
| pathfind + dig   |
| collect blocks   |
+---------+--------+
          |
          | packets/actions
          v
+------------------+
| MC Server        |
+------------------+

Progress and result path:

+------------------+       job.progress        +------------------+
| Bot Worker       +--------------------------->| JobManager       |
+---------+--------+                            +---------+--------+
          |                                                |
          | state.changed / job.progress                   | update job record
          v                                                v
+------------------+       service event       +------------------+
| EventBus         +--------------------------->| Storage optional |
+---------+--------+                            +------------------+
          |
          | WebSocket event:
          | {
          |   "type": "job.progress",
          |   "botId": "...",
          |   "jobId": "...",
          |   "data": { "current": 17, "target": 64, "unit": "blocks" }
          | }
          v
+------------------+
| WS Subscribers   |
+------------------+

Completion:

+------------------+       job.completed       +------------------+
| Bot Worker       +--------------------------->| JobManager       |
+------------------+                            +---------+--------+
                                                     |
                                                     | event fanout
                                                     v
                                               +------------------+
                                               | WebSocket / MCP  |
                                               | / REST polling   |
                                               +------------------+
```

### Scenario B: Bot Self-Preservation Mode Triggers During Mining

```text
Initial state:

+------------------+
| JobManager       |
| job: mining      |
| state: running   |
+---------+--------+
          |
          | runSkill mine.collect_blocks
          v
+------------------+
| Bot Worker       |
| primary lane     |
+---------+--------+
          |
          | mining loop
          v
+------------------+
| Mineflayer       |
| digging/pathfind |
+------------------+

Self-preservation trigger:

+------------------+
| StateTracker     |
| health changed   |
| health below min |
+---------+--------+
          |
          | observation
          v
+------------------+
| ModeEngine       |
| self_preservation|
| priority: high   |
+---------+--------+
          |
          | interrupt current primary action
          v
+------------------+
| Bot Worker       |
| set interrupt    |
| stop dig/path    |
+---------+--------+
          |
          | mode.triggered event
          v
+------------------+        "mode.triggered"        +------------------+
| EventBus         +------------------------------->| WS Subscribers   |
+------------------+                                +------------------+

Safety action:

+------------------+
| ModeEngine       |
| acquire movement |
+---------+--------+
          |
          | move to safe position / eat / flee
          v
+------------------+
| Mineflayer       |
| safety behavior  |
+---------+--------+
          |
          | actions
          v
+------------------+
| MC Server        |
+------------------+

Job outcome:

+------------------+      interrupted result      +------------------+
| Bot Worker       +----------------------------->| JobManager       |
+------------------+                              | job: interrupted |
                                                    | reason:          |
                                                    | self_preservation|
                                                    +---------+--------+
                                                              |
                                                              | job.interrupted
                                                              v
                                                    +------------------+
                                                    | EventBus / WS    |
                                                    +------------------+
```

If the public API keeps the `pending | running | completed | failed | cancelled` job states from `API.md`, the persisted representation should be `cancelled` with `cancellation.reason = "mode.self_preservation"` and event data marking the interruption. Internally, the worker may still use `interrupted` as a runtime outcome.

### Scenario C: Bot Disconnects and Reconnects Mid-Job

```text
Running job:

+------------------+
| JobManager       |
| job: running     |
+---------+--------+
          |
          | runSkill
          v
+------------------+
| Bot Worker       |
| currentJobId     |
+---------+--------+
          |
          | Mineflayer operation
          v
+------------------+
| Mineflayer       |
+------------------+

Disconnect event:

+------------------+
| Mineflayer       |
| end/kick/error   |
+---------+--------+
          |
          | disconnect event
          v
+------------------------+
| ConnectionSupervisor   |
| classify error         |
+-----------+------------+
            |
            +-------------------------------+
            |                               |
            | transient                     | fatal
            v                               v
+------------------------+       +------------------------+
| Reconnect policy       |       | JobManager             |
| exponential backoff    |       | fail current job       |
| preserve job state     |       | code: fatal error      |
+-----------+------------+        +-----------+-----------+
            |                                |
            | bot.reconnecting              | job.failed
            v                                v
+------------------------+       +------------------------+
| EventBus / WS          |       | EventBus / WS          |
+-----------+------------+       +------------------------+
            |
            | after delay
            v
+------------------------+
| Bot Worker             |
| connect message        |
+-----------+------------+
            |
            | MineflayerAdapter.connect
            v
+------------------------+
| Mineflayer             |
| login/spawn            |
+-----------+------------+
            |
            | bot.connected / bot.spawned
            v
+------------------------+
| StateTracker           |
| refresh snapshot       |
+-----------+------------+
            |
            | resume from last durable job state
            v
+------------------------+
| SkillExecutor          |
| continue retry-safe    |
| skill or fail if unsafe|
+-----------+------------+
            |
            | job.progress / completed / failed
            v
+------------------------+
| JobManager + EventBus  |
+------------------------+
```

Transient examples include server restart, temporary network disconnect, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, temporary chunk failures, and retryable pathfinder failures. Fatal examples include invalid auth, unsupported version, banned or whitelisted server rejection, required plugin initialization failure, and reconnect attempts exceeding policy.

### Scenario D: Multiple Callers Try To Control Same Bot

```text
Caller A starts mining:

+------------+       POST mine.collect_blocks       +------------+
| Caller A   +-------------------------------------->| REST API   |
+------------+                                      +-----+------+
                                                          |
                                                          v
                                                    +------------+
                                                    | JobManager |
                                                    | job A      |
                                                    | running    |
                                                    +-----+------+
                                                          |
                                                          v
                                                    +------------+
                                                    | Bot Worker |
                                                    | primary    |
                                                    | lane busy  |
                                                    +------------+

Caller B sends move command while job A is running:

+------------+       POST move.to_position          +------------+
| Caller B   +-------------------------------------->| REST API   |
+------------+                                      +-----+------+
                                                          |
                                                          v
                                                    +------------+
                                                    | JobManager |
                                                    | bot busy   |
                                                    +-----+------+
                                                          |
                 +----------------------------------------+----------------------------------------+
                 |                                        |                                        |
                 | busyPolicy: reject-if-busy             | busyPolicy: cancel-current              | busyPolicy: queue
                 v                                        v                                        v
        +--------------------+                   +--------------------+                   +--------------------+
        | Reject job B       |                   | Cancel job A       |                   | Accept job B        |
        | HTTP 409           |                   | interrupt token    |                   | state: pending      |
        | error: BOT_BUSY    |                   | stop current work  |                   | wait for lane       |
        +---------+----------+                   +---------+----------+                   +---------+----------+
                  |                                        |                                        |
                  | response to Caller B                   | job.cancelled for A                     | job.created for B
                  v                                        v                                        v
        +--------------------+                   +--------------------+                   +--------------------+
        | Caller B receives  |                   | EventBus / WS      |                   | EventBus / WS      |
        | 409 Conflict       |                   | Caller A notified  |                   | B waits            |
        +--------------------+                   +---------+----------+                   +---------+----------+
                                                           |                                        |
                                                           | run job B after cleanup                | after job A ends
                                                           v                                        v
                                                 +--------------------+                   +--------------------+
                                                 | Bot Worker         |                   | Bot Worker         |
                                                 | move.to_position   |                   | move.to_position   |
                                                 +--------------------+                   +--------------------+
```

`emergency-stop` is a stricter cancellation policy used for safety or operator intervention. It preempts all action lanes, stops pathfinder, PVP, digging, item activation, open windows where possible, and control states.

## 3. Process Model

The service runs as one main Node.js process plus one worker thread per bot.

Main process responsibilities:

- API Gateway: Express REST, WebSocket, and MCP adapters.
- Control Plane: BotManager, JobManager, Config, Storage, and lifecycle coordination.
- EventBus: in-process `EventEmitter` fanout with typed JSON event envelopes.
- Worker supervision: starts workers, routes typed messages, detects worker exit, and applies restart policy.

Worker thread responsibilities:

- One worker owns one bot.
- Each worker owns its Mineflayer bot instance, action lanes, mailbox, runtime state, ModeEngine, StateTracker, SkillExecutor, and ConnectionSupervisor.
- Workers are lighter than child processes while still isolating blocked pathfinder calls, bot plugin errors, and per-bot runtime crashes from the control plane.

Worker communication uses typed messages over `parentPort.postMessage`:

```text
Main process                         Bot worker
------------                         ----------
BotManager
  |
  | { type: "connect", botConfig }
  | { type: "runSkill", jobId, skill, params, timeoutMs }
  | { type: "cancelJob", jobId, mode, reason }
  | { type: "getSnapshot", requestId }
  v
parentPort.postMessage  --------->   worker message handler

worker event handler     <---------   parentPort.postMessage
  ^
  | { type: "event", event }
  | { type: "reply", requestId, result }
  | { type: "jobProgress", jobId, progress }
  | { type: "jobFinished", jobId, result }
  | { type: "workerError", error }
```

Worker crash recovery:

- The main process listens for worker `exit` and `error`.
- Expected exits from `stop` or `destroy` mark the bot stopped or destroyed.
- Unexpected exits mark the bot failed or reconnecting depending on lifecycle and reconnect policy.
- Running jobs owned by the crashed worker are failed, cancelled, or retried only when their retry policy and skill idempotency allow it.
- If restart is enabled, BotManager starts a new worker for the same bot config and rehydrates cached state, event history, and eligible job state.

## 4. State Management

Bot state is derived inside the worker and exposed as serializable snapshots and diffs. Live Mineflayer objects never leave the worker.

Tracked bot state:

- Position, velocity, yaw, and pitch.
- Health, hunger, oxygen, experience, and death/respawn status.
- Inventory slots, item counts, selected slot, equipment, and empty slot count.
- Nearby players, entities, item drops, mobs, and selected nearby blocks.
- Biome, dimension, time, day/night state, and weather.
- Connected status and lifecycle status: creating, connecting, spawning, running, disconnected, reconnecting, stopping, destroyed, or failed.
- Current action, current job ID, busy flag, active modes, paused modes, and last mode trigger.
- Last chat messages and recent errors.

Snapshots vs diffs:

```text
Full snapshot:
  - returned by GET /bots/{botId}/state
  - returned by observe.state
  - used after connect, spawn, reconnect, or WebSocket resubscribe
  - includes the full serializable BotStateSnapshot

State diff:
  - sent over WebSocket as state.changed
  - contains changed fields, previous revision, next revision, and update time
  - rate-limited and coalesced to avoid flooding clients
  - never requires clients to receive Mineflayer objects
```

State refresh:

- Event-driven refresh occurs when Mineflayer emits movement, health, inventory, entity, weather, chat, spawn, disconnect, or error events.
- Job progress can trigger state refresh when a skill changes position, inventory, current action, or nearby context.
- On-demand refresh is available through `GET /bots/{botId}/state`, `POST /bots/{botId}/observe`, and `observe.*` skills.
- Observation skills are read-only and may run while a primary action is active if they only read cached state or perform safe reads.

## 5. Event System

The internal EventBus is a typed wrapper over Node `EventEmitter`. It accepts worker and control-plane events, attaches event IDs and timestamps, fans out to subscribers, and optionally persists events for debugging and replay.

Event envelope:

```text
{
  "id": "evt_...",
  "ts": "ISO-8601 UTC timestamp",
  "type": "job.progress",
  "botId": "bot-1",
  "jobId": "job-1",
  "data": {}
}
```

Event categories:

```text
lifecycle:
  bot.created
  bot.connected
  bot.spawned
  bot.disconnected
  bot.reconnecting
  bot.destroyed

chat:
  chat.received
  chat.sent

state:
  state.changed
  state.snapshot

job:
  job.created
  job.running
  job.progress
  job.completed
  job.failed
  job.cancelled
  job.interrupted

mode:
  mode.enabled
  mode.disabled
  mode.paused
  mode.unpaused
  mode.triggered
  mode.completed

error:
  error.reported
  worker.error
  connection.error
```

Event persistence: **(not yet implemented — stubs only)**

- Persistence is optional and controlled by storage config.
- The planned initial provider writes JSONL event records under the configured data directory.
- Persisted events include ID, timestamp, type, bot ID, job ID, and JSON-serializable data.
- Event logs are for debugging, replay, and postmortems; they are not the primary source of live bot truth.

Event filtering:

- WebSocket clients may subscribe to all bots, selected bot IDs, selected event categories, or selected event types.
- Filters are applied in the API Gateway after authentication.
- Reconnecting clients may request replay from a cursor when event persistence is enabled.
- Event payloads must not include secrets, raw Mineflayer objects, or unbounded logs.

## 6. Extension Points

Custom skills: **(manifest type exists, plugin loader not yet implemented)**

- Plugins provide a `skill-manifest.json` and compiled JavaScript entrypoint.
- Manifests declare skill names, descriptions, categories, permissions, timeout defaults, busy policies, and JSON Schemas.
- Entrypoints export `registerSkills(registry, helpers)`.
- Skill parameters are validated before execution.
- Skill handlers run inside the owning bot worker through a constrained `SkillExecutionContext`.
- Plugin skills are exposed through REST, WebSocket job events, and MCP like built-ins.

Custom memory providers: **(not yet implemented — `none` is the only available provider)**

- Memory is optional, with `none` as the default provider.
- Providers implement `init`, `store`, `retrieve`, `search`, and `clear`.
- Built-in provider targets include no-op, file JSONL, and Hermes proxy.
- Memory provider failures must not crash bot workers or corrupt job state.

Custom mode policies:

- Modes declare name, default enabled state, priority, required permissions, and mutation capabilities.
- ModeEngine arbitrates background behavior against primary jobs.
- Custom modes can pause, interrupt, or yield only through ModeEngine APIs.
- Self-preservation, self-defense, auto-eat, unstuck, and related policies should be implemented as modes, not API adapter logic.

Custom API middleware:

- Express middleware may be added for authentication, authorization, request logging, tracing, rate limiting, CORS, and request IDs.
- Middleware must run before handlers call BotManager or JobManager.
- Middleware must not access Mineflayer or worker runtime objects.

## 7. Security Model

Core security principles:

- No code generation in core.
- No natural-language command execution in core.
- No arbitrary JavaScript execution endpoint.
- API clients submit structured skill parameters, not executable code.
- API adapters and the Control Plane never expose live Mineflayer objects.

Skill permissions:

- Skills declare permissions such as `movement`, `inventory`, `block.break`, `block.place`, `combat`, `chat`, `container`, and `entity.interact`.
- Per-bot config can disable skills or deny permissions.
- Permission checks occur before execution reaches the primary action lane.
- Background modes use the same permission model and must not bypass it.

API authentication:

- Authentication is optional by config.
- Supported policies should include no auth for local development and bearer token or API key authentication for protected deployments.
- Secrets are read from environment variables and redacted in logs and API responses.
- Viewer and debug endpoints must be disabled by default or protected by auth.

Worker sandboxing:

- Skill handlers run inside bot workers through `SkillExecutionContext`.
- Handlers receive helper APIs rather than process-global service internals.
- Skill handlers must not receive filesystem or network capabilities through the execution context.
- Core skill handlers must not perform filesystem or network access.
- Plugin skill loading should be constrained by manifest validation, explicit permission declarations, and deployment policy.
- For stricter deployments, plugin execution can be limited to vetted plugin directories, disabled entirely, or moved to a stronger sandbox.

Rate limiting: **(only chat rate limit middleware is wired)**

- REST, WebSocket, and MCP adapters apply rate limits independently.
- Chat sends have a dedicated rate limit to avoid server kicks.
- Progress and state events are rate-limited or coalesced before WebSocket fanout.
- Reconnect attempts use exponential backoff with jitter to avoid tight reconnect loops. **(not yet implemented — current reconnect uses fixed 1s delay)**

## 8. Error Handling Strategy

All errors are classified into retryable transient errors or permanent failures.

Transient errors:

- Temporary network disconnects.
- Server restart or lag.
- `ECONNRESET`, `ETIMEDOUT`, and `EPIPE`.
- Missing chunk data.
- Temporary pathfinder failure.
- Known non-critical packet parse errors when suppression policy allows it.
- Rate-limit kick when reconnect policy allows delayed retry.

Permanent errors:

- Invalid auth credentials.
- Unsupported Minecraft version when auto negotiation is unavailable.
- Banned or whitelisted server rejection.
- Required plugin initialization failure.
- Configuration validation failure.
- Missing required permissions.
- Invalid skill parameters.
- Missing tools, missing items, unsafe block, or impossible target when gameplay state makes retry pointless.
- Reconnect attempts exceeding policy.

Job error recovery:

- Each job has timeout and retry policy.
- Retry is allowed only for retryable errors and retry-safe skills.
- Backoff is configurable per job or defaults from skill/service config.
- Timeout requests cooperative cancellation first, then escalates after `stopGraceMs`.
- Skill cleanup must stop pathfinder goals, PVP, digging, item activation, control states, timers, and open windows.

Worker error isolation:

- One worker crash affects one bot.
- BotManager marks the bot failed, disconnected, or reconnecting according to classification and policy.
- Other workers and other bots continue running.
- Running jobs in the crashed worker are failed, cancelled, or retried based on durable state and retry policy.

Connection error handling:

- Mineflayer disconnect, kick, and error events flow to ConnectionSupervisor.
- ConnectionSupervisor classifies the error.
- Transient failures schedule reconnect with exponential backoff and jitter.
- Fatal failures fail the current job, emit `error.reported`, and stop reconnect attempts.
- Reconnect preserves bot config and eligible job state, then refreshes state after spawn.

## 9. Testing Strategy

Unit tests:

- Zod schema validation for API request bodies, bot config, skill parameters, plugin manifests, and event envelopes.
- Skill handler logic with mocked `SkillExecutionContext` helpers.
- JobManager state machine transitions: pending, running, completed, failed, cancelled, timeout, retry, and busy policies.
- ModeEngine arbitration: pause, unpause, trigger, priority, conflict detection, and scoped pause restoration.
- ConnectionSupervisor error classification.

Integration tests:

- Bot creation through API into BotManager and worker startup.
- Connect flow: create bot, start worker, connect, spawn, state snapshot available.
- Skill execution: submit job, route to worker, emit progress, complete job.
- Cancellation and timeout: interrupt worker action and verify cleanup/result events.
- Reconnect flow: simulate disconnect, classify transient error, backoff, reconnect, refresh state.

Contract tests:

- OpenAPI/JSON Schema definitions match actual REST responses.
- WebSocket event envelopes match `ServiceEvent`.
- MCP tool schemas match the same skill schemas used by REST.
- Error responses use stable codes and the documented error object shape.

End-to-end tests:

```text
1. Start mc-agent-service.
2. Create a bot with test server config.
3. Wait for bot.connected and bot.spawned.
4. Execute a skill, such as observe.state or mine.collect_blocks in a controlled world.
5. Watch job.progress over WebSocket.
6. Wait for job.completed or expected job.failed.
7. Verify the resulting state change through GET /bots/{botId}/state.
8. Stop and destroy the bot.
```

Test environments should include a local Minecraft server fixture for mutating skills, plus mocked worker/runtime tests for fast control-plane coverage.
