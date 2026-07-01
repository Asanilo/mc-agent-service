# Normal Player Mode (NPM)

> This document defines what it means for mc-agent-service to behave like a **real Minecraft player** in modded environments (Mechanomania / NeoForge / 1.21.1 reference pack).

---

## 1. Core Principle

The bot must behave as a **legitimate player entity**, not a privileged system agent.

It must:

- Only use information a normal player could access in-game.
- Never rely on server-side debug APIs or admin commands.
- Never assume knowledge of unloaded chunks or hidden registry data.

---

## 2. Forbidden capabilities (Hard rules)

The following are **never allowed in default mode**:

### Commands / Admin APIs
- `/tp`
- `/give`
- `/data get`
- `/locate`
- `/fill`
- `/gamemode`

### Engine-level cheating
- Reading unloaded chunks
- Reading server registry beyond client sync
- X-ray / ore injection
- Direct block state queries via server internals

### Service-level violations
- Injecting arbitrary JS into Mineflayer runtime
- Bypassing pathfinding with teleport fallback
- Modifying server world state outside player actions

---

## 3. Allowed capabilities (Normal Player equivalence)

The bot is allowed to use:

### Perception
- `observe.state`
- `observe.inventory`
- `observe.nearby`
- `observe.block_at` (only loaded chunks)
- Entity tracking within render/simulation range

### Interaction
- Mining blocks
- Placing blocks
- Crafting via crafting table / machines
- Opening containers
- Using items

### Modded UI equivalents (if visible to player)
- JEI/EMI recipe browsing (via knowledge layer)
- FTB Quests progression (via in-world data or AgentProbe)
- Patchouli guide reading (if exposed)
- Jade tooltips (if exposed via client/bridge)

---

## 4. Information boundary rule

If a human player cannot see it, the bot must treat it as:

- `unknown`
- or `not_loaded`

It must never hallucinate hidden information.

---

## 5. Modded environment rule

For modded packs (e.g. Mechanomania):

- The bot may use modded mechanics **only through normal gameplay interfaces**.
- If a mod requires GUI interaction, the bot must simulate player interaction (open GUI → click → wait).
- If a mod exposes no observable interface, it is treated as opaque.

---

## 6. Failure semantics

When blocked or uncertain:

- The bot must fail gracefully.
- Return structured error:

```json
{
  "ok": false,
  "error": "NO_PLAYER_ACCESS",
  "reason": "Information or action not available to normal player"
}
```

Never fallback to:
- admin commands
- debug APIs
- internal server state

---

## 7. Relationship with Memory System

Normal Player Mode applies to memory as well:

- Memory cannot store hidden world state.
- External memory providers must only store **observed events**.
- No predictive or inferred world reconstruction is allowed in default mode.

---

## 8. Relationship with AgentProbe (future)

If AgentProbe Mod is installed:

- It must enforce Normal Player Mode filtering.
- It cannot expose hidden or unloaded chunk data.
- It only mirrors what is already visible to the player client.

---

## 9. Design intent

This mode exists to ensure:

> The AI is not a server admin pretending to be a player.
> It is a player.

This makes behavior:

- testable
- reproducible
- comparable to human gameplay
- safe for modded environments
