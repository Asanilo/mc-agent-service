# mc-agent-service Implementation Specification

## 1. Project Goals and Non-Goals

### Goals

mc-agent-service is a standalone TypeScript/Node.js service that gives external AI agents a reliable "body" in Minecraft. The service wraps Mineflayer bots and exposes stable HTTP, WebSocket, and MCP APIs that agent systems such as Hermes, Codex, and Claude Code can call without embedding Mineflayer directly.

The core goals are:

- Run as an independent process with no dependency on a specific LLM runtime.
- Provide a clean, validated API surface for bot creation, state inspection, chat, and skill execution.
- Support multiple Minecraft bots in one service instance.
- Isolate each bot enough that a stuck pathfinder, server disconnect, inventory operation, or plugin error does not corrupt the control plane.
- Represent work as jobs with lifecycle state, progress, cancellation, timeouts, and retry metadata.
- Provide a skill system that maps structured inputs to Mineflayer operations rather than interpreting natural language.
- Keep memory, planning, vision, and viewer features optional and replaceable.
- Make Minecraft version, auth, server connection, memory provider, and mode policy configurable per bot.
- Emit events suitable for external agents to maintain situational awareness.
- Persist enough config, event history, and job history to debug bot behavior and survive process restarts when configured.

### Non-Goals

The service core must not become an LLM application. Specifically:

- No LLM is bundled into the core runtime.
- No prompt templates are required for core behavior.
- No natural-language command interpretation is required for skill execution.
- No UI is included in core.
- No code generation or arbitrary code execution endpoint is exposed.
- No server-specific gameplay strategy is embedded in the control plane.
- No direct dependency on Hermes, Codex, Claude Code, or any single agent framework is required.
- No guarantee is made that a bot can complete high-level goals such as "build a house" without an external planner or explicit sequence of skills.

Optional modules may call LLMs or memory systems, but those modules must be disabled by default and must communicate through explicit interfaces.

## 2. Architecture Overview

The service is split into a small API process, a control plane, and per-bot worker runtimes. External agents talk to adapters; adapters call shared control-plane services; the control plane sends messages to isolated bot workers; workers own Mineflayer instances.

```text
External AI Agents
  Hermes / Codex / Claude Code / custom clients
        |
        v
+-----------------------------+
| API Gateway                 |
| REST + WebSocket + MCP      |
+--------------+--------------+
               |
               v
+-----------------------------+
| Control Plane               |
| BotManager                  |
| JobManager                  |
| EventBus                    |
| Config                      |
| Storage                     |
+--------------+--------------+
               |
       worker_threads messages
               |
               v
+-----------------------------+
| Bot Workers                 |
| one actor per bot           |
| mailbox + action lanes      |
+--------------+--------------+
               |
               v
+-----------------------------+
| Bot Runtime                 |
| MineflayerAdapter           |
| StateTracker                |
| SkillExecutor               |
| ModeEngine                  |
+--------------+--------------+
               |
               v
+-----------------------------+
| Mineflayer + plugins        |
+--------------+--------------+
               |
               v
+-----------------------------+
| Minecraft Server            |
+-----------------------------+
```

Core rule: API adapters never touch Mineflayer objects directly. All bot mutation goes through BotManager -> worker mailbox -> Bot Runtime -> MineflayerAdapter.

## 3. Module Breakdown

### API Gateway

The API Gateway owns transport protocols and request authentication. It exposes REST, WebSocket, and MCP adapters over the same control-plane services.

Responsibilities:

- Parse and validate inbound transport-specific requests.
- Authenticate HTTP, WebSocket, and MCP clients using configured auth policy.
- Convert REST requests to BotManager and JobManager commands.
- Broadcast EventBus messages to WebSocket subscribers.
- Register MCP tools that call the same service methods as REST.
- Normalize errors into stable transport responses.
- Avoid duplicating bot logic in adapter code.

REST uses Express. WebSocket uses `ws`. MCP uses `@modelcontextprotocol/sdk`. All request bodies and tool parameters are validated with Zod schemas before reaching the control plane.

### Control Plane

The Control Plane coordinates service-level state. It does not hold live Mineflayer objects.

#### BotManager

BotManager owns the registry of bots and workers.

Responsibilities:

- Create bot records from validated per-bot config.
- Start one `worker_threads` worker per bot.
- Stop, destroy, and reconnect bots.
- Route commands to the correct worker mailbox.
- Maintain bot status: `creating`, `connecting`, `spawning`, `running`, `disconnected`, `reconnecting`, `stopping`, `destroyed`, `failed`.
- Detect worker exit and classify it as expected stop, transient failure, or fatal failure.
- Apply reconnection policy.
- Expose read APIs for bot summaries and cached state.

#### JobManager

JobManager owns submitted actions and their lifecycle.

Responsibilities:

- Create jobs for skill invocations and chat sends when chat is configured as a job.
- Enforce bot busy policy: `queue`, `reject-if-busy`, `cancel-current`, or `emergency-stop`.
- Route job execution requests to the target bot actor.
- Track job state, progress, result, error, retry count, timeout, timestamps, and cancellation reason.
- Persist job history if storage is enabled.
- Emit `job.progress`, `job.completed`, `job.failed`, and `job.cancelled` events.

#### EventBus

EventBus is an in-process typed pub/sub channel used by APIs, storage, and workers.

Responsibilities:

- Accept events from workers and control-plane services.
- Attach monotonically increasing event IDs and timestamps.
- Fan out events to WebSocket clients.
- Persist events when event logging is enabled.
- Provide replay from a cursor for reconnecting clients.

Events must be JSON-serializable and must not contain Mineflayer object references.

#### Config

Config loads and validates service configuration.

Responsibilities:

- Load defaults.
- Merge config file values.
- Merge environment variable overrides.
- Validate server config, storage config, auth config, and per-bot config.
- Redact secrets in logs and API responses.

### Bot Workers

Each bot runs in a separate `worker_threads` worker. A worker is an actor: it receives typed messages, mutates only its own bot runtime, and sends typed replies or events.

Responsibilities:

- Own exactly one Mineflayer bot instance.
- Own that bot's mailbox and action lanes.
- Serialize all primary gameplay mutations.
- Run background policies through the ModeEngine with explicit arbitration.
- Convert worker messages to runtime calls.
- Convert runtime state changes to control-plane events.
- Recover from local Mineflayer errors where possible.
- Exit cleanly when destroyed.

Worker message examples:

```ts
type WorkerCommand =
  | { type: "connect"; botConfig: BotConfig }
  | { type: "disconnect"; reason?: string }
  | { type: "destroy"; reason?: string }
  | { type: "runSkill"; jobId: string; skill: string; params: unknown; timeoutMs?: number }
  | { type: "cancelJob"; jobId: string; mode: CancellationMode; reason?: string }
  | { type: "sendChat"; jobId?: string; message: string }
  | { type: "getSnapshot"; requestId: string };
```

### Bot Runtime

The Bot Runtime is the code inside each worker that adapts Mineflayer into service primitives.

#### MineflayerAdapter

MineflayerAdapter owns bot creation, plugin loading, low-level event binding, and direct Mineflayer calls.

Implementation requirements from the Mindcraft reference:

- Create bots through `mineflayer.createBot`.
- Support host, port, username, auth, version, and connection timeout options.
- Omit `version` when configured as `auto`.
- Load core plugins in one place: `mineflayer-pathfinder`, `mineflayer-pvp`, `mineflayer-collectblock`, `mineflayer-auto-eat`, and `mineflayer-armor-manager`.
- Accept resource packs automatically unless disabled by config.
- Initialize `minecraft-data` and `prismarine-item` after login when the server version is known.
- Provide helper lookups for item IDs, block IDs, entity IDs, recipes, smelting data, tool requirements, and generated `Item` instances.
- Include an optional Paper/Spigot compatibility setting that throttles position-related packets.
- Include an optional parser-error suppression policy for known non-critical `PartialReadError` cases.

The adapter exposes methods such as:

```ts
interface MineflayerAdapter {
  connect(config: BotConfig): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  destroy(reason?: string): Promise<void>;
  sendChat(message: string): Promise<void>;
  getBot(): Bot;
  getMcData(): MinecraftData;
}
```

Only Bot Runtime modules may call `getBot()`.

#### StateTracker

StateTracker converts live Mineflayer state into serializable snapshots and emits state changes.

Tracked state includes:

- Connection status.
- Username, UUID when available, game mode, dimension, biome, time of day.
- Position, velocity, yaw, pitch, health, food, oxygen, experience.
- Inventory counts and equipment.
- Nearby players, nearby entities, nearby block types, and selected nearest blocks.
- Current action, current job ID, active modes, and busy state.
- Last chat messages and last errors.

World query patterns should follow the Mindcraft separation between observation and action:

- Observation helpers read blocks, entities, inventory, craftable items, biome, and position.
- Action skills call observation helpers instead of duplicating query code.
- Queries return plain JSON DTOs, not Mineflayer objects.

#### SkillExecutor

SkillExecutor registers built-in and plugin skills, validates parameters, runs skills, reports progress, and maps runtime errors into job errors.

Responsibilities:

- Maintain a registry keyed by skill name.
- Validate skill input with Zod before execution.
- Enforce skill permissions.
- Start, interrupt, and stop skills through a shared action lifecycle.
- Provide helpers for progress reporting and output logging.
- Pause or unpause modes only through ModeEngine APIs.
- Ensure cleanup for pathfinder goals, PVP state, open windows, timers, and intervals.

The action lifecycle follows Mindcraft's core pattern:

- Only one primary action executes at a time.
- A new primary action either queues, rejects, cancels the current action, or emergency-stops based on job policy.
- Cancellation is cooperative first: set an interrupt token, stop pathfinder/PVP/digging, and let the skill return.
- A hard kill is allowed only after the configured stop grace period.
- Action output is summarized and bounded.
- Timeouts mark the job timed out, request cancellation, and emit failure if cleanup completes.
- Successful non-interrupted completion emits idle state.

#### ModeEngine

ModeEngine runs background behavior that is useful but lower priority than explicit jobs.

Example modes:

- `self_preservation`
- `self_defense`
- `cowardice`
- `item_collecting`
- `hunting`
- `torch_placing`
- `unstuck`
- `elbow_room`
- `auto_eat`

Modes must declare:

- Name.
- Enabled default.
- Priority.
- Required permissions.
- Whether it may move, dig, place, attack, open containers, or consume items.
- Which primary skills can pause it.

ModeEngine must support `pause(name)`, `unpause(name)`, `pauseMany(names)`, and scoped pause handles that automatically restore previous state after a skill finishes.

### Optional Modules

Optional modules are disabled unless configured.

#### Planner/LLM

Planner/LLM is off by default. If enabled later, it must call the public service APIs like any external agent or use an internal interface that accepts the same typed commands. It must not bypass JobManager or SkillExecutor.

#### Memory

Memory is pluggable and described in section 7. The default provider is `none`.

#### Vision

Vision may expose screenshots, image descriptions, or block/entity visual summaries. It must be read-only unless paired with explicit skills. It must not add hidden action side effects.

#### Viewer

Viewer may expose a debug viewer such as prismarine-viewer. It is an operator tool, not a required UI. It must be protected by auth and disabled by default.

### Storage

Storage is a small persistence layer for operational data.

Stored data:

- Service config file and per-bot config.
- Event log.
- Job history.
- Optional memory provider data.

Initial implementation may use JSONL files under a configured data directory. The storage interface must allow future SQLite or Postgres implementations without changing API handlers.

Storage records:

```ts
interface StoredEvent {
  id: string;
  ts: string;
  type: string;
  botId?: string;
  jobId?: string;
  data: unknown;
}

interface StoredJob {
  id: string;
  botId: string;
  skill?: string;
  state: JobState;
  params?: unknown;
  result?: unknown;
  error?: JobError;
  progress?: JobProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

## 4. API Design Summary

Detailed payload documentation belongs in `API.md`; this section defines the required surface.

### REST Endpoints

- `POST /bots` creates and optionally connects a bot.
- `GET /bots` lists bots.
- `GET /bots/{id}` returns one bot summary.
- `DELETE /bots/{id}` stops and destroys a bot.
- `GET /bots/{id}/state` returns the latest state snapshot.
- `GET /bots/{id}/inventory` returns inventory counts and equipment.
- `GET /bots/{id}/nearby` returns nearby players, entities, and block summaries.
- `POST /bots/{id}/actions/{skill}` creates a skill job for a bot.
- `GET /jobs` lists jobs with filters for bot, state, skill, and time range.
- `POST /jobs` creates a job using a body that specifies `botId`, `skill`, and `params`.
- `GET /jobs/{id}` returns job status.
- `POST /jobs/{id}/cancel` cancels a running or queued job.
- `POST /bots/{id}/chat` sends a chat message from a bot.

HTTP response principles:

- `202 Accepted` for accepted asynchronous jobs.
- `200 OK` for synchronous reads and successful chat when chat is not job-backed.
- `400 Bad Request` for Zod validation failures.
- `401 Unauthorized` or `403 Forbidden` for auth failures.
- `404 Not Found` for unknown bot or job IDs.
- `409 Conflict` for busy bots when policy is `reject-if-busy`.
- `500 Internal Server Error` only for unexpected service faults.

### WebSocket Events

Clients connect to the WebSocket API and receive JSON events. Clients may subscribe to all bots, selected bot IDs, or selected event types.

Required event types:

- `bot.connected`
- `bot.disconnected`
- `chat.received`
- `job.progress`
- `job.completed`
- `state.changed`

Additional core events:

- `bot.created`
- `bot.spawned`
- `bot.reconnecting`
- `bot.destroyed`
- `job.created`
- `job.running`
- `job.failed`
- `job.cancelled`
- `error.reported`

Common envelope:

```ts
interface ServiceEvent<T = unknown> {
  id: string;
  ts: string;
  type: string;
  botId?: string;
  jobId?: string;
  data: T;
}
```

### MCP Tools

The MCP adapter exposes tools that map to the same BotManager and JobManager services as REST.

Required MCP tools:

- `create_bot`
- `stop_bot`
- `send_chat`
- `get_state`
- `move_to`
- `collect_blocks`
- `craft_item`
- `cancel_job`

MCP tool behavior:

- Tool arguments are validated by the same Zod schemas used by REST.
- Mutating tools return job IDs unless the operation is explicitly synchronous.
- Tool results include stable machine-readable fields, not only prose.
- MCP never receives raw Mineflayer objects.

## 5. Skill System

Skills are typed operations implemented in TypeScript. A skill maps structured parameters to Mineflayer operations. It is not a text command and does not parse natural language.

### Skill Definition

Each skill has:

- `name`: stable identifier used in REST routes, jobs, MCP tools, and manifests.
- `description`: short operator-facing description.
- `category`: one of the built-in categories or a plugin category.
- `parameters`: Zod schema.
- `permissions`: declared runtime capabilities.
- `timeoutMs`: default timeout.
- `busyPolicy`: default behavior when another primary action is active.
- `run`: async handler executed inside the bot worker.

```ts
type SkillPermission =
  | "move"
  | "dig"
  | "place"
  | "attack"
  | "inventory"
  | "craft"
  | "smelt"
  | "container"
  | "chat"
  | "observe"
  | "consume"
  | "trade";

interface SkillDefinition<TParams> {
  name: string;
  description: string;
  category: SkillCategory;
  parameters: z.ZodType<TParams>;
  permissions: SkillPermission[];
  timeoutMs: number;
  busyPolicy: BusyPolicy;
  run(ctx: SkillContext, params: TParams): Promise<SkillResult>;
}
```

`SkillContext` includes:

- Bot runtime references scoped to the worker.
- Read-only config.
- Abort signal or interrupt token.
- Progress reporter.
- Output logger.
- State query helpers.
- Skill helper functions for pathfinding, inventory, block lookup, and cleanup.

### Skill Manifest Format for Custom Plugins

Custom skill plugins are loaded from configured directories. Each plugin has a manifest plus compiled JavaScript entrypoint.

```json
{
  "name": "example-farming-skills",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "skills": [
    {
      "name": "farm.harvest_and_replant",
      "description": "Harvest mature crops in range and replant seeds.",
      "category": "farming",
      "permissions": ["move", "dig", "place", "inventory"],
      "timeoutMs": 300000,
      "parametersSchema": {
        "type": "object",
        "properties": {
          "crop": { "type": "string" },
          "radius": { "type": "number", "minimum": 1, "maximum": 64 }
        },
        "required": ["crop", "radius"],
        "additionalProperties": false
      }
    }
  ]
}
```

Runtime plugin requirements:

- Plugin entrypoint exports `registerSkills(registry)`.
- Plugin code receives service helper APIs, not global Mineflayer state.
- Plugin schemas are converted to Zod or validated through a JSON Schema adapter.
- Plugin names must not collide with built-ins unless explicit override is enabled.
- Plugin loading failures are fatal only for that plugin unless `strictPluginLoading` is true.

### Built-In Skill Categories

#### Movement

Examples:

- `move.to_position`
- `move.to_block`
- `move.to_entity`
- `move.to_player`
- `move.follow_player`
- `move.away`
- `move.avoid_enemies`
- `move.stay`
- `move.surface`
- `move.dig_down`

Movement skills use `mineflayer-pathfinder` goals and movement profiles. They should prefer non-destructive movement first and then use destructive movement only if allowed by config and skill permissions.

#### Mining

Examples:

- `mine.collect_blocks`
- `mine.break_block_at`
- `mine.dig_down`

Mining skills must check block existence, harvestability, tool availability, safety, liquid handling, falling-block risk, and inventory capacity. They should support progress with `current`, `target`, and `unit: "blocks"`.

#### Crafting

Examples:

- `craft.item`
- `craft.smelt_item`
- `craft.clear_nearest_furnace`

Crafting skills use `minecraft-data` recipes and Mineflayer `recipesFor`. They should detect whether a crafting table or furnace is required, move within interaction range, place temporary utility blocks only when allowed, and clean them up when configured.

#### Combat

Examples:

- `combat.attack_nearest`
- `combat.attack_entity`
- `combat.defend_self`

Combat skills use `mineflayer-pvp` for sustained attacks and direct `bot.attack` for one-shot interactions. They must pause conflicting safety modes deliberately and restore them.

#### Inventory

Examples:

- `inventory.equip`
- `inventory.discard`
- `inventory.pickup_nearby`
- `inventory.put_in_chest`
- `inventory.take_from_chest`
- `inventory.view_chest`
- `inventory.consume`
- `inventory.give_to_player`

Inventory skills must close windows and containers on success, failure, timeout, and cancellation.

#### Observation

Examples:

- `observe.state`
- `observe.inventory`
- `observe.nearby`
- `observe.block_at`
- `observe.nearest_blocks`
- `observe.craftable_items`
- `observe.biome`

Observation skills are read-only and may run while a primary action is active if they do not mutate bot state.

#### Communication

Examples:

- `chat.send`
- `chat.whisper`

Communication skills send Minecraft chat messages and emit `chat.sent`. They must honor configured rate limits.

### Skill Mapping Rule

Every built-in skill maps to a Mineflayer operation or a deterministic composition of Mineflayer operations. Skills must not execute arbitrary JavaScript supplied by API clients.

## 6. Job System

### Lifecycle

Jobs move through the following states:

```text
pending -> running -> completed
pending -> running -> failed
pending -> cancelled
pending -> running -> cancelled
```

State definitions:

- `pending`: accepted by JobManager but not yet executing.
- `running`: assigned to a bot worker and currently executing.
- `completed`: finished successfully with a result.
- `failed`: finished with an error, timeout, fatal bot disconnect, validation issue discovered after acceptance, or exhausted retries.
- `cancelled`: stopped before completion by user request, busy policy, shutdown, or bot destruction.

### Job Record

```ts
type JobState = "pending" | "running" | "completed" | "failed" | "cancelled";

interface JobProgress {
  current: number;
  target?: number;
  unit?: string;
  message?: string;
}

interface JobError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

interface Job {
  id: string;
  botId: string;
  skill: string;
  params: unknown;
  state: JobState;
  progress?: JobProgress;
  result?: unknown;
  error?: JobError;
  timeoutMs: number;
  retry: RetryPolicy;
  cancellation?: {
    requestedAt: string;
    reason?: string;
    mode: CancellationMode;
  };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

### Progress Tracking

Progress uses:

- `current`: numeric progress made.
- `target`: optional total.
- `unit`: semantic unit such as `blocks`, `items`, `meters`, `steps`, `trades`, or `milliseconds`.
- `message`: concise human-readable status.

Progress events are rate-limited per job to avoid flooding WebSocket clients.

### Cancellation

Cancellation modes:

- `cancel-current`: request cooperative cancellation of the current primary action and run the new job after the current action stops.
- `queue`: keep the new job pending until the primary action lane is free.
- `reject-if-busy`: reject new work with `409 Conflict` or an MCP conflict result if the bot is busy.
- `emergency-stop`: immediately request interrupt, stop pathfinder, stop PVP, stop digging, close windows when possible, clear control states, and fail or cancel the active job.

Cancellation is cooperative by default:

1. Mark job cancellation requested.
2. Set worker interrupt token.
3. Stop Mineflayer subsystems that can continue running: pathfinder, PVP, digging, item activation, and control states.
4. Wait for skill code to return.
5. After `stopGraceMs`, classify as worker-unresponsive and terminate the worker if configured.

### Timeout and Retry

Each job has a timeout. Timeout behavior:

- Mark job as timed out.
- Emit progress with timeout message.
- Request cancellation.
- If cleanup succeeds, finish as `failed` with `code: "JOB_TIMEOUT"`.
- If worker does not respond, terminate worker and mark bot as failed or reconnecting.

Retry policy:

```ts
interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryOn: string[];
}
```

Retries are allowed only for errors marked retryable and only when the skill declares idempotent or retry-safe behavior. Examples of retryable errors include transient pathfinder failures, temporary server lag, and missing chunk data. Examples of non-retryable errors include invalid item names, missing tools, permission denial, and fatal auth failures.

## 7. Memory System (Optional)

Memory is optional. The default provider is `none`, which performs no storage.

### Provider Interface

```ts
interface MemoryProvider {
  init(config: MemoryProviderConfig): Promise<void>;
  store(record: MemoryRecord): Promise<void>;
  retrieve(key: string): Promise<MemoryRecord | null>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  clear(scope?: MemoryScope): Promise<void>;
}

interface MemoryRecord {
  key: string;
  botId: string;
  scope?: string;
  type: "event" | "observation" | "job" | "note";
  text?: string;
  data?: unknown;
  tags?: string[];
  createdAt: string;
}

interface MemorySearchQuery {
  botId: string;
  text?: string;
  tags?: string[];
  limit?: number;
  since?: string;
}
```

### Implementations

#### `none`

No-op provider. All methods succeed without storing data. `retrieve` returns `null`; `search` returns `[]`.

#### `file`

Stores JSONL records in the configured data directory. It is suitable for development and small deployments.

Required behavior:

- One file per bot or one partitioned JSONL file with `botId`.
- Atomic append for `store`.
- In-memory index for recent keys after `init`.
- Linear search is acceptable for initial implementation with bounded file size config.

#### `hermes-proxy`

Delegates recall to Hermes over HTTP.

Behavior:

- `store` sends records to configured Hermes memory endpoint when available.
- `retrieve` maps key lookup to Hermes memory query if supported.
- `search` calls Hermes `scope_recall`.
- Timeouts, HTTP errors, and invalid Hermes responses are returned as memory errors but must not crash the bot worker.
- Memory calls must include bot ID and configured scope.

### Per-Bot Config

```ts
type MemoryProviderName = "none" | "file" | "hermes";

interface BotMemoryConfig {
  provider: MemoryProviderName;
  scope?: string;
  file?: {
    path?: string;
    maxBytes?: number;
  };
  hermes?: {
    baseUrl: string;
    apiKeyEnv?: string;
    timeoutMs?: number;
    scopeRecallPath?: string;
  };
}
```

Example:

```json
{
  "memory": {
    "provider": "hermes",
    "scope": "minecraft.survival.bot-alpha",
    "hermes": {
      "baseUrl": "http://localhost:8787",
      "apiKeyEnv": "HERMES_API_KEY",
      "timeoutMs": 5000,
      "scopeRecallPath": "/scope_recall"
    }
  }
}
```

## 8. Bot Lifecycle

### Lifecycle States

```text
Create -> Connect -> Spawn -> Running -> Disconnected -> Reconnect
                                            |
                                            v
                                         Destroy
```

Detailed state flow:

- `Create`: BotManager validates config, creates a bot record, starts a worker.
- `Connect`: worker calls MineflayerAdapter.connect.
- `Spawn`: Mineflayer emits spawn; StateTracker initializes live state.
- `Running`: bot accepts jobs and emits state.
- `Disconnected`: Mineflayer end/kick/error occurred or disconnect requested.
- `Reconnect`: BotManager schedules reconnect when policy allows it.
- `Destroy`: worker closes Mineflayer, clears timers, stops modes, rejects queued jobs, and exits.

### Reconnection

Reconnection uses exponential backoff:

```ts
interface ReconnectPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: boolean;
  maxAttempts?: number;
}
```

Recommended defaults:

- `enabled: true`
- `initialDelayMs: 1000`
- `maxDelayMs: 60000`
- `factor: 2`
- `jitter: true`
- `maxAttempts: undefined`

Backoff resets after a stable running period, default 5 minutes.

### Error Classification

Transient errors should retry or reconnect:

- Server restart or temporary network disconnect.
- `ECONNRESET`, `ETIMEDOUT`, `EPIPE`.
- Temporary chunk or pathfinder failures.
- Known non-critical packet parse errors when suppression policy allows it.
- Bot kicked for rate limiting when reconnect policy allows a delayed retry.

Fatal errors should stop the bot:

- Invalid auth credentials.
- Unsupported Minecraft version when auto-negotiation is unavailable.
- Banned or whitelisted server rejection.
- Repeated reconnect failures exceeding max attempts.
- Plugin initialization failure for required plugins.
- Configuration validation failure.
- Worker crash during initialization.

Error events must include:

- `code`
- `message`
- `retryable`
- `source`
- `botId`
- optional `details`

## 9. Multi-bot Support

The service must support multiple bots against the same or different Minecraft servers.

### Actor Model

Each bot is an actor:

- One worker per bot.
- One mailbox per worker.
- Commands are processed serially unless explicitly marked read-only.
- Worker owns all mutable Mineflayer state.
- Control Plane never shares live bot references between workers.

### Action Lanes

Each bot has:

- One primary action lane for movement, mining, crafting, combat, inventory mutation, and other world mutations.
- Background policy lanes managed by ModeEngine.
- Observation lane for read-only snapshots and queries.
- System lane for lifecycle commands such as disconnect, destroy, and emergency stop.

No concurrent mutation is allowed without arbitration.

Arbitration rules:

- Primary actions are exclusive.
- Background lanes may run only when their declared permissions do not conflict with the primary action.
- Emergency stop preempts every lane.
- Observation may run while actions are active if it only reads cached state or performs safe Mineflayer reads.
- Container/window operations are exclusive and must prevent other inventory skills from starting.
- Pathfinder goal ownership is exclusive; skills and modes must acquire it before setting goals.
- PVP ownership is exclusive; combat modes and combat skills must acquire it before attacking.

### Multi-bot Coordination

Core does not implement team planning, but it must expose enough primitives for external agents:

- Bot list and per-bot state.
- Per-bot job queue visibility.
- Bot-specific event streams.
- Optional tags or metadata on bots.
- Independent bot configs.
- Stable job IDs and bot IDs.

Future coordination modules must be implemented outside the core mutation path or through regular jobs.

## 10. Configuration

Configuration is loaded in this order:

1. Built-in defaults.
2. Config file.
3. Environment variables.
4. Explicit CLI flags when implemented.

### Server Config

```ts
interface ServerConfig {
  http: {
    host: string;
    port: number;
  };
  websocket: {
    enabled: boolean;
    path: string;
  };
  mcp: {
    enabled: boolean;
    transport: "stdio" | "http";
    path?: string;
  };
  auth: AuthConfig;
  storage: StorageConfig;
  logging: {
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    pretty: boolean;
  };
  workers: {
    stopGraceMs: number;
    maxBots: number;
  };
}
```

Auth config:

```ts
type AuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; tokenEnv: string }
  | { mode: "api-key"; header: string; keyEnv: string };
```

Storage config:

```ts
interface StorageConfig {
  provider: "none" | "file";
  dataDir: string;
  eventLog: boolean;
  jobHistory: boolean;
  maxEventLogBytes?: number;
  maxJobHistoryBytes?: number;
}
```

### Per-Bot Config

```ts
interface BotConfig {
  id?: string;
  name: string;
  minecraft: {
    host: string;
    port: number;
    version: string | "auto";
    auth: "offline" | "microsoft";
    username: string;
    passwordEnv?: string;
    checkTimeoutIntervalMs?: number;
  };
  reconnect: ReconnectPolicy;
  memory: BotMemoryConfig;
  modes: Record<string, boolean>;
  skills?: {
    disabled?: string[];
    permissions?: Partial<Record<SkillPermission, boolean>>;
    defaultTimeoutMs?: number;
  };
  compatibility?: {
    acceptResourcePacks: boolean;
    throttlePositionPackets: boolean;
    positionThrottleMs: number;
    suppressPartialReadErrors: boolean;
  };
  metadata?: Record<string, string>;
}
```

### Environment Variables

Required and supported environment variables:

- `MC_AGENT_HOST`: HTTP bind host.
- `MC_AGENT_PORT`: HTTP port.
- `MC_AGENT_WS_ENABLED`: enable WebSocket API.
- `MC_AGENT_WS_PATH`: WebSocket path.
- `MC_AGENT_MCP_ENABLED`: enable MCP adapter.
- `MC_AGENT_MCP_TRANSPORT`: `stdio` or `http`.
- `MC_AGENT_MCP_PATH`: HTTP MCP path when using HTTP transport.
- `MC_AGENT_AUTH_MODE`: `none`, `bearer`, or `api-key`.
- `MC_AGENT_AUTH_TOKEN`: bearer token when auth mode is bearer.
- `MC_AGENT_API_KEY`: API key when auth mode is api-key.
- `MC_AGENT_API_KEY_HEADER`: API key header name.
- `MC_AGENT_DATA_DIR`: storage directory.
- `MC_AGENT_STORAGE_PROVIDER`: `none` or `file`.
- `MC_AGENT_EVENT_LOG`: enable event log.
- `MC_AGENT_JOB_HISTORY`: enable job history.
- `MC_AGENT_LOG_LEVEL`: pino log level.
- `MC_AGENT_LOG_PRETTY`: pretty logs for local development.
- `MC_AGENT_MAX_BOTS`: maximum bots in this service instance.
- `MC_AGENT_WORKER_STOP_GRACE_MS`: worker graceful stop timeout.
- `HERMES_API_KEY`: optional Hermes memory API key when referenced by bot config.

Environment values must be parsed and validated through the same Zod config schemas as file config.

## 11. TypeScript Stack

### Runtime and Language

- Node.js with TypeScript.
- TypeScript strict mode enabled.
- ESM modules preferred unless a dependency requires CommonJS interop.
- Zod for runtime validation and inferred TypeScript types.

### Core Dependencies

- `mineflayer`
- `minecraft-data`
- `prismarine-item`
- `vec3`
- `mineflayer-pathfinder`
- `mineflayer-pvp`
- `mineflayer-collectblock`
- `mineflayer-auto-eat`
- `mineflayer-armor-manager`
- `express`
- `ws`
- `@modelcontextprotocol/sdk`
- `zod`
- `pino`

### Node APIs

- `worker_threads` for bot isolation.
- `events` or a typed EventEmitter wrapper for EventBus.
- `fs/promises` for file storage.
- `crypto.randomUUID` for IDs.
- `AbortController` for cancellation signals where compatible.

### Project Layout

```text
src/
  api/
    rest.ts
    websocket.ts
    mcp.ts
    auth.ts
    errors.ts
  core/
    BotManager.ts
    JobManager.ts
    EventBus.ts
    Config.ts
    Storage.ts
    ids.ts
  bots/
    worker.ts
    BotRuntime.ts
    MineflayerAdapter.ts
    StateTracker.ts
    ModeEngine.ts
    actionLifecycle.ts
    workerProtocol.ts
  skills/
    registry.ts
    types.ts
    movement.ts
    mining.ts
    crafting.ts
    combat.ts
    inventory.ts
    observation.ts
    communication.ts
    world.ts
    mcdata.ts
  optional/
    memory/
      MemoryProvider.ts
      NoneMemoryProvider.ts
      FileMemoryProvider.ts
      HermesMemoryProvider.ts
    planner/
    vision/
    viewer/
  types/
    api.ts
    bot.ts
    config.ts
    events.ts
    jobs.ts
    skills.ts
```

### TypeScript Requirements

`tsconfig.json` must enable:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### Implementation Principles

- Shared schemas live beside shared types, and types are inferred from Zod where practical.
- API handlers validate input before calling services.
- Control Plane services do not import Mineflayer.
- Bot worker modules may import Mineflayer.
- Skill modules do not access process-wide mutable state.
- All worker messages are typed and validated.
- All public errors use stable error codes.
- Logs use pino and include `botId`, `jobId`, and `workerId` where available.
- Secrets are never logged.
- Tests should cover schema validation, job lifecycle, busy policy arbitration, worker protocol serialization, skill registry behavior, and storage adapters.

### Minimum Built-In Skills for First Complete Core

The first complete core should ship these skills:

- `move.to_position`
- `move.to_block`
- `move.to_player`
- `move.follow_player`
- `move.stay`
- `mine.collect_blocks`
- `mine.break_block_at`
- `craft.item`
- `craft.smelt_item`
- `combat.attack_nearest`
- `combat.defend_self`
- `inventory.equip`
- `inventory.discard`
- `inventory.pickup_nearby`
- `inventory.view_chest`
- `observe.state`
- `observe.inventory`
- `observe.nearby`
- `chat.send`

These skills establish every required runtime capability: movement, mining, crafting, combat, inventory mutation, observation, communication, cancellation, progress, and event emission.
