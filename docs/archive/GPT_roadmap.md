
# mc-agent-service × 重度机械症未来发展路线图

## 0. 项目定位

本项目的长期定位不是“给 Mineflayer 包一层 API”，而是：

> **Minecraft Body Runtime：给任意 AI Agent 提供一个稳定、可审计、可停止、可恢复的 Minecraft 玩家身体。**

上层可以是 Hermes、Claude Code、Codex、本地模型、网页前端或脚本；底层由 `mc-agent-service` 负责连接 Minecraft 服务器，控制 bot 观察、移动、聊天、采集、合成、战斗、避险，并把所有动作变成结构化任务、事件和日志。

当前主线目标锁定为：

```text
目标整合包：重度机械症 / Mechanomania
运行方式：NeoForge
MC 版本：1.21.1
Bot 数量：单 bot
玩法模式：Normal Player Mode，不给 OP，不默认 /tp，不默认 /data
核心体验：AI 像真实玩家一样陪在机械动力整合包中探索、跟随、收集、理解任务、辅助建设
```

MC百科当前页面显示《重度机械症》是 NeoForge / 1.21.1 整合包，包含 152 个模组，标签包含机械动力、车万女仆；介绍强调它是节奏舒缓的机械动力主题包，没有前期可用传送，旅行本身就是体验的一部分。这个特性非常适合测试“真实玩家式 AI agent”。

---

## 1. 设计原则

### 1.1 单 bot 优先

当前阶段只支持一个 bot。多 bot 暂缓。

原因：

```text
1. 单 bot 已经足够验证 MC body runtime。
2. 多 bot 会引入抢方块、挡路、同时开箱子、路径碰撞、任务冲突。
3. 本机同时跑客户端、服务端、Node bot、AI 工具，资源压力已经不低。
4. 多 agent / 多 bot 的价值要建立在单 bot 稳定之后。
```

第一阶段 README 应明确写：

```text
Current scope:
- single bot only
- one primary action at a time
- no autonomous multi-agent planning
- no OP commands by default
- no vehicle piloting
- no Touhou Little Maid adapter yet
```

### 1.2 Normal Player Mode 优先

默认模式必须像真实玩家：

```text
允许：
- 读取已加载区块内方块
- 读取附近实体
- 读取自身血量、饥饿、背包、装备
- 读取打开的容器窗口
- 使用 JEI / Jade / Patchouli / FTB Quests 等玩家本来能看到的信息
- 通过 pathfinder 正常走路
- 正常挖掘、放置、合成、交互

禁止：
- /tp
- /data get block
- /give
- /locate
- 读取未加载区块
- xray / 矿物透视
- 隐藏服务端状态读取
- 任意 JS 代码执行
```

调试模式可以保留，但必须显式开启：

```text
Admin Debug Mode:
- allow /tp
- allow /data get block
- allow registry dump
- only local/private server
- never default
```

### 1.3 服务化边界必须保留

`mc-agent-service` 不内置人格，不负责长期陪伴，不直接做自然语言理解。

它只负责：

```text
我看到了什么？
我能做什么？
我正在做什么？
我为什么失败？
我能不能安全停止？
这个动作是谁发起的？
这个世界状态是否危险？
```

Hermes 层负责：

```text
人格
长期记忆
用户偏好
对话风格
主动性
任务意图理解
是否要让 MC bot 行动
失败后的解释和安抚
```

### 1.4 先工程稳定，再智能复杂

阶段顺序：

```text
先登录
再观察
再移动
再跟随
再停止
再采集
再合成
再读任务书/配方
再理解机械动力流程
再做长期记忆
最后再做多 agent / TLM / 视觉 / 载具
```

---

## 2. 总体架构

```text
Hermes / Claude / CLI / Web UI / Local Agent
        │
        ▼
Agent Gateway
- MCP Client
- REST Client
- WebSocket Client
- sourceAgentId
        │
        ▼
mc-agent-service
        │
        ├─ API Layer
        │  ├─ REST
        │  ├─ MCP
        │  └─ WebSocket events
        │
        ├─ Control Plane
        │  ├─ BotManager
        │  ├─ JobManager
        │  ├─ SkillRegistry
        │  ├─ Action Lanes
        │  └─ EventBus
        │
        ├─ Bot Runtime
        │  ├─ Mineflayer Adapter
        │  ├─ Pathfinder
        │  ├─ Combat / Auto Eat / Inventory
        │  └─ Normal Player Perception
        │
        ├─ Modpack Knowledge Layer
        │  ├─ Registry / minecraft-data
        │  ├─ Recipes / Tags / Lang
        │  ├─ JEI/EMI-derived data
        │  ├─ Patchouli books
        │  ├─ FTB Quests
        │  └─ KubeJS scripts
        │
        ├─ Storage
        │  ├─ events.jsonl
        │  ├─ jobs.jsonl
        │  ├─ state snapshots
        │  └─ knowledge.sqlite
        │
        └─ Optional Future
           ├─ AgentProbe Mod
           ├─ Jade Adapter
           ├─ TLM Adapter
           └─ Multi-Agent Coordinator
```

---

## 3. 技术选型

### 3.1 主语言和工程栈

```text
语言：TypeScript
运行时：Node.js
包管理：pnpm 或 npm，先不引入复杂 monorepo
校验：Zod
日志：pino
存储：JSONL + SQLite
测试：vitest + integration scripts
格式化：prettier + eslint
```

理由：

```text
1. Mineflayer 生态本身是 Node.js / JavaScript 栈。
2. TypeScript 能把 skill 参数、job 状态、event schema 管住。
3. Zod 可以作为 REST / MCP / Skill 的统一 schema 来源。
4. SQLite 足够保存事件、任务、知识索引，不需要一开始上 PostgreSQL。
5. JSONL 适合记录长期可回放事件，debug 体验好。
```

### 3.2 Minecraft Bot 底座

```text
核心：mineflayer
移动：mineflayer-pathfinder
战斗：mineflayer-pvp
采集：mineflayer-collectblock
吃饭：mineflayer-auto-eat
护甲：mineflayer-armor-manager
版本数据：minecraft-data / prismarine-registry
```

Mineflayer 官方描述它是用于创建 Minecraft bots 的高层 JavaScript API，支持实体追踪、方块查询、物理移动、攻击、背包、合成、箱子、挖掘和建筑等能力，并支持多个 Minecraft Java 版本。
`minecraft-data` 是 PrismarineJS 生态里的版本数据模块，提供多版本 Minecraft 客户端/服务端/库可用的数据。
`mineflayer-pathfinder` 是 Mineflayer 的寻路插件，可以创建静态、动态或组合目标，让 bot 自动导航地形。

### 3.3 NeoForge / modded server 风险

重度机械症是 NeoForge / 1.21.1。第一风险不是 AI 智能，而是 bot 能不能完成 modded server 登录。

Forge/FML 服务器有额外握手，用于确定 mod 和 block IDs；wiki.vg 的 Forge Handshake 文档明确说明，不完成额外握手，服务器不会允许登录。
PrismarineJS 的 `node-minecraft-protocol-forge` 可以在服务器宣称 Forge/FML 时自动安装 forgeHandshake 插件，但它主要是探索方向，不保证所有现代 NeoForge 包都稳定。

因此 P0 必须是：

```text
Bot 能不能进重度机械症服务端？
```

结果分支：

```text
A. 能进服：
继续正常开发。

B. 被 NeoForge/FML 握手踢：
研究 node-minecraft-protocol-forge / NeoForge 握手。
如果短期搞不定，临时切换到“AgentProbe + 玩家客户端信息桥”路线。

C. 能进服但 registry / 方块 / 实体异常：
进入 Modpack Knowledge Layer 和 RegistryMapper 开发。
```

---

## 4. Skill / Job / Event 设计

### 4.1 Skill 分层

参考 Odyssey 的思想，技能分成 primitive 和 compositional。Odyssey 提出 open-world skill library，包含 40 个 primitive skills 和 183 个 compositional skills。

本项目对应设计：

```text
Primitive Skills:
- communication.say
- observe.state
- observe.inventory
- observe.nearby
- observe.block_at
- move.to_position
- move.to_player
- move.follow_player
- move.stop
- mine.block
- mine.nearby
- place.block
- inventory.equip
- inventory.drop
- inventory.pickup
- combat.defend_self
- survival.eat
- survival.flee

Compositional Skills:
- collect_wood
- gather_basic_stone
- follow_and_wait
- return_to_player
- collect_item_for_recipe
- craft_item
- complete_simple_quest_step
- build_simple_platform
- make_create_shaft
- make_create_cogwheel
```

第一阶段只实现 primitive。compositional 不直接让 LLM 写代码，而是由可审计 recipe/plan 调用 primitive。

### 4.2 Job 状态机

所有动作都必须变成 job。

```text
queued
running
succeeded
failed
cancelled
timeout
interrupted
```

必须包含：

```json
{
  "jobId": "job_xxx",
  "botId": "kishi",
  "sourceAgentId": "hermes",
  "skill": "move.follow_player",
  "args": {},
  "status": "running",
  "startedAt": 0,
  "finishedAt": null,
  "reason": null,
  "error": null
}
```

取消不能伪装成 success：

```text
用户取消 → cancelled / USER_CANCELLED
安全层打断 → interrupted / SAFETY_INTERRUPT
超时 → timeout / JOB_TIMEOUT
路径失败 → failed / PATH_NOT_FOUND
目标不存在 → failed / TARGET_NOT_FOUND
```

### 4.3 Action Lanes

单 bot 也要有 lanes，否则后面会乱。

```text
observe lane:
- observe.state
- observe.inventory
- observe.nearby
不阻塞 primary

chat lane:
- communication.say
不阻塞 primary，但需要频率限制

primary lane:
- move
- mine
- place
- craft
同时只能一个

safety lane:
- flee
- eat
- defend
可以打断 primary

system lane:
- connect
- disconnect
- cancel
- stop
最高优先级
```

### 4.4 EventBus

事件分级：

```text
bot.lifecycle
- connected
- spawned
- disconnected
- died
- respawned

job.lifecycle
- queued
- started
- progress
- succeeded
- failed
- cancelled
- timeout
- interrupted

world.observation
- nearby_entity
- nearby_player
- block_seen
- item_picked
- container_opened

safety
- low_health
- low_food
- hostile_nearby
- stuck
- drowning
- burning

chat
- player_message
- bot_message
- system_message

debug
- path_update
- packet_warning
- registry_warning
- mod_unknown
```

事件必须写入 `events.jsonl`，支持 replay：

```http
GET /events?botId=kishi&since=event_xxx
GET /jobs/:jobId
GET /bots/:botId/snapshot
```

---

## 5. 重度机械症适配路线

### 5.1 为什么重度机械症适合主线

重度机械症是机械动力主题整合包，MC百科介绍中强调“没有快节奏的奔袭与传送便利”，而是亲手修路、轨迹、旅行。这对 AI agent 很关键，因为它迫使 bot 不能依赖传送，而要真实移动、记录路径、建立基地记忆。

它还包含 Jade、Jade Addons、FTB Quests、JEI、KubeJS、Touhou Little Maid、Create 及多个 Create 附属等模组。
这些模组给了我们很好的信息入口：

```text
Jade / Jade Addons：方块、实体、Create 机器 tooltip
JEI：物品和配方
FTB Quests：任务树和 progression
KubeJS：魔改配方和脚本
Patchouli：若包内包含相关手册，可作为知识源
Create：主线机械系统
Touhou Little Maid：未来 NPC/任务系统参考，暂不实现
```

### 5.2 信息获取优先级

第一阶段不要写大而全模组。先做离线和普通玩家信息。

```text
Layer 1：离线索引
- 扫 mods/*.jar
- 扫 config/
- 扫 kubejs/
- 扫 datapacks/
- 扫 lang
- 扫 recipes
- 扫 tags
- 扫 FTB Quests 文件
- 扫 Patchouli books

Layer 2：Mineflayer 普通玩家感知
- bot.blockAt
- bot.findBlocks
- bot.entities
- bot.inventory
- bot.openContainer
- bot.recipesFor
- chat / scoreboard / bossbar

Layer 3：可选 AgentProbe Mod
- Jade Adapter
- JEI/EMI Adapter
- FTB Quests Adapter
- Patchouli Adapter
- Crosshair Probe
- Normal Player Policy
```

Jade 是现代 Waila/Hwyla 类信息 HUD；它可以仅客户端安装，但不少功能需要服务端也安装，比如物品存储、酿造台燃料、蜂箱蜜蜂等。
JEI 是物品和配方查看模组，强调稳定、性能和开发者 API。
Patchouli 是数据驱动的 Minecraft 文档/手册系统，适合从 JSON 生成游戏内手册。
FTB Quests 是轻量、团队式任务模组，适合把任务书抽象成 agent 的 progression/curriculum。

---

## 6. 目录结构建议

```text
mc-agent-service/
  docs/
    ROADMAP.md
    NORMAL_PLAYER_MODE.md
    MODPACK_MECHANOMANIA.md
    API_CONTRACT.md
    SKILL_DESIGN.md
    EVENT_SCHEMA.md

  src/
    api/
      rest.ts
      mcp.ts
      websocket.ts
      schemas.ts

    core/
      bot-manager.ts
      job-manager.ts
      event-bus.ts
      action-lanes.ts
      config.ts

    bots/
      mineflayer-adapter.ts
      lifecycle.ts
      snapshot.ts

    skills/
      index.ts
      communication.ts
      observation.ts
      movement.ts
      mining.ts
      placing.ts
      crafting.ts
      inventory.ts
      combat.ts
      survival.ts

    knowledge/
      indexer.ts
      sqlite.ts
      lang-index.ts
      recipe-index.ts
      tag-index.ts
      quest-index.ts
      patchouli-index.ts
      kubejs-index.ts

    modcompat/
      registry/
        registry-mapper.ts
        item-mapper.ts
        block-mapper.ts
        entity-mapper.ts
      policy/
        perception-policy.ts
        unknown-block-policy.ts
        unknown-entity-policy.ts

    storage/
      events-log.ts
      jobs-log.ts
      snapshots.ts

    testing/
      smoke-runner.ts
      fixtures.ts

  scripts/
    mechanomania-smoke.sh
    index-modpack.ts
    run-local-server.sh

  examples/
    curl-basic.sh
    hermes-client-example.ts
    mcp-client-example.ts
```

---

## 7. 阶段路线图

## Phase 0：环境冻结与基线记录

目标：把“重度机械症开发环境”固定下来。

任务：

```text
1. 下载并安装重度机械症客户端和服务端。
2. 记录实际版本：
   - Minecraft version
   - NeoForge version
   - modpack version
   - mod count
   - Java version
3. 服务端单独启动成功。
4. 玩家客户端能进服。
5. 先不开光影，降低干扰。
6. 服务端 view-distance 6～8，simulation-distance 4～6。
7. 记录 idle TPS / 内存 / CPU。
8. 手动玩 30～60 分钟，记录开局任务、Jade/JEI/FTB Quests 是否可用。
```

验收标准：

```text
- 玩家能稳定进入世界
- 服务端 30 分钟不崩
- 记录 modpack manifest
- 记录第一小时玩家流程
```

产物：

```text
docs/MODPACK_MECHANOMANIA.md
data/mechanomania/manifest.json
data/mechanomania/manual_first_hour.md
```

---

## Phase 1：Bot 登录烟测

目标：验证 Mineflayer bot 能否进重度机械症 NeoForge 服。

任务：

```text
1. 创建 offline/private 测试服。
2. 只启动一个 bot。
3. 尝试 mineflayer 直接连接。
4. 记录 disconnect/kick 原因。
5. 若被 Forge/NeoForge 握手踢，尝试 node-minecraft-protocol-forge 分支。
6. 不做任何 AI 行为，只做 connect/spawn/chat/disconnect。
```

最小测试：

```text
connect
spawn
say("hello")
observe.state
disconnect
```

验收标准：

```text
A 级：bot 能进服、出生、聊天、退出。
B 级：bot 能连接但 registry/block/entity 异常。
C 级：bot 被 NeoForge/FML 踢，需进入协议适配分支。
```

必须输出：

```json
{
  "canConnect": true,
  "canSpawn": true,
  "canChat": true,
  "kickReason": null,
  "protocolWarnings": []
}
```

---

## Phase 2：普通玩家观察层

目标：bot 像真实玩家一样知道自己和附近环境。

实现 skills：

```text
observe.state
observe.inventory
observe.equipment
observe.nearby_players
observe.nearby_entities
observe.nearby_blocks
observe.block_at
observe.health
observe.food
```

统一坐标 schema：

```ts
BlockPos = {
  x: int,
  y: int,
  z: int
}

EntityPos = {
  x: number,
  y: number,
  z: number
}
```

避免现在可能出现的参数漂移：

```text
不要有的工具用 {x,y,z}
有的工具用 {position:{x,y,z}}
有的工具用 {target:{x,y,z}}
```

统一使用：

```json
{
  "position": {
    "x": 0,
    "y": 64,
    "z": 0
  }
}
```

验收标准：

```text
- bot 能报告自身位置/维度/血量/饥饿
- bot 能看到玩家
- bot 能看到附近实体
- bot.blockAt 对已加载方块有效
- 未加载区域返回 null/unknown，不假装知道
```

---

## Phase 3：移动与跟随

目标：AI 能“站到你旁边”。

实现 skills：

```text
move.to_position
move.to_player
move.follow_player
move.stop
move.away
move.to_block
```

技术：

```text
mineflayer-pathfinder
GoalNear
GoalFollow
Movements
stuck detector
path progress event
```

必须修复：

```text
follow 被取消后，job.status 不能是 succeeded。
必须是 cancelled 或 interrupted。
```

Normal Player Mode：

```text
默认不 /tp。
距离太远或卡住时：
- 报告失败
- 请求玩家等一下
- 尝试重新寻路
- 必要时停止
```

验收标准：

```text
- bot 能走到玩家 3 格内
- bot 能跟随 60 秒
- bot 能 stop
- bot 卡住时能报告 stuck
- bot 不因为 pathfinder 异常直接退出进程
```

---

## Phase 4：基础生存动作

目标：bot 能帮忙做最基础的生存动作。

实现 skills：

```text
mine.block
mine.nearby
mine.collect_block_type
inventory.pickup
inventory.drop
inventory.equip
survival.eat
survival.flee
combat.defend_self
```

原则：

```text
1. 不主动破坏建筑。
2. 不挖玩家脚下方块。
3. 不离玩家太远。
4. 不主动攻击玩家。
5. hostile 识别不确定时先躲避，不先攻击。
6. 血量低时 safety lane 打断 primary lane。
```

验收任务：

```text
- 挖 3 个附近原木
- 捡起掉落物
- 回到玩家身边
- 饥饿时吃食物
- 遇到怪物能报告/后退/自保
```

---

## Phase 5：重度机械症知识索引 v0

目标：让 AI 知道这个整合包里“物品、配方、任务、说明”是什么。

实现 `modpack-indexer`：

```text
输入：
- mods/*.jar
- kubejs/
- config/
- defaultconfigs/
- datapacks/
- FTB Quests 数据
- lang 文件
- recipes
- tags
- Patchouli books 如存在

输出：
- knowledge.sqlite
- items
- blocks
- entities
- recipes
- tags
- quests
- guide_entries
```

数据库草案：

```sql
items(
  id TEXT PRIMARY KEY,
  display_name TEXT,
  mod_id TEXT,
  source TEXT
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

Knowledge API：

```text
knowledge.search_item(query)
knowledge.recipe(itemId)
knowledge.usage(itemId)
knowledge.quest_current()
knowledge.quest_tree()
knowledge.guide_search(query)
knowledge.mod_info(modId)
```

验收标准：

```text
- 能查 “安山合金” 对应 item id
- 能查基础机械动力物品配方
- 能列出可见任务
- 能把 quest step 转成 agent 目标
- 能解释某个物品来自哪个 mod
```

---

## Phase 6：机械动力基础助手

目标：AI 能辅助推进早期 Create 流程。

先不要求它独立完成复杂工厂，只做辅助：

```text
1. 读取任务书下一步。
2. 查 JEI/recipes 需要哪些材料。
3. 检查背包已有材料。
4. 告诉玩家缺什么。
5. 帮忙收集简单原料。
6. 能放置简单方块结构。
7. 能记住基地、箱子、工坊位置。
```

第一批 compositional skills：

```text
collect_wood(count)
collect_stone(count)
collect_iron_if_visible(count)
craft_basic_item(itemId, count)
bring_item_to_player(itemId, count)
remember_location(name)
return_to_location(name)
```

Create 相关先做“知识辅助”，不要急着做复杂机器：

```text
可以做：
- 解释配方
- 找材料
- 拿/放物品
- 帮忙挖基础资源
- 简单放方块

暂缓：
- 自动搭完整产线
- 自动调机械动力方向/转速/应力
- 自动驾驶火车/载具
- 自动管理大型仓储
```

验收标准：

```text
玩家问：“下一步要做什么？”
AI 能读任务/配方后回答。

玩家问：“做这个缺什么？”
AI 能对比背包和 recipe。

玩家说：“帮我挖点木头，别走太远。”
bot 能执行并返回。
```

---

## Phase 7：Hermes 接入

目标：Hermes 作为上层 companion brain，调用 `mc-agent-service`。

Hermes 不直接控制 Mineflayer，只走 MCP/REST：

```text
Hermes
  ↓
mc.get_state
mc.observe_nearby
mc.say
mc.follow_player
mc.stop
mc.collect_block
mc.query_recipe
mc.query_quest
```

Hermes 输入：

```text
- 用户聊天
- MC chat
- bot 状态
- job 结果
- world events
- quest/recipe knowledge
- 长期记忆
```

Hermes 输出：

```json
{
  "say": "我在你旁边了。现在任务书下一步好像要做安山合金。",
  "actions": [
    {
      "tool": "mc.follow_player",
      "args": { "player": "Asanilo", "distance": 3 }
    }
  ]
}
```

记忆分层：

```text
Core Memory:
- 用户偏好
- bot 名字
- 不用 OP
- 不乱破坏建筑
- 不离太远

Session Memory:
- 当前任务
- 当前基地
- 当前背包目标
- 刚才失败原因

Episodic Memory:
- 第一次进重度机械症
- 第一个基地位置
- 第一次建工坊
- 一起修的路
```

注意：MC 事件不能伪装成用户消息。应该作为 `world_event` 注入。

---

## Phase 8：AgentProbe Mod，暂缓但预留

目标：当 Mineflayer 无法直接获得 mod UI/tooltip/quest 状态时，用一个薄模组提供 JSON 信息桥。

不是重写 Jade/JEI/FTB Quests，而是适配：

```text
AgentProbe Mod
├─ RegistryAdapter
├─ JadeAdapter
├─ JEIAdapter
├─ FTBQuestsAdapter
├─ PatchouliAdapter
└─ WebSocket / HTTP / file export
```

API 示例：

```http
GET /agentprobe/look_at
GET /agentprobe/quest/current
GET /agentprobe/recipe?id=create:shaft
GET /agentprobe/guide/search?q=andesite
```

安全策略：

```text
Normal Player Mode:
- 只导出玩家可见信息
- 只导出当前玩家已解锁 quest/guide
- 不导出未加载区块
- 不导出隐藏矿物
- 不导出 OP 数据

Debug Mode:
- 可导出 registry dump
- 可用 /data 验证
- 仅本地开发
```

实现时间：Phase 8 以后。不要现在做。

---

## Phase 9：多 Agent / 多 Bot，远期

当前不做多 bot。

未来多 agent 不是“多个 bot”起步，而是多个上层脑子协作控制一个 bot：

```text
Companion Agent:
- 聊天
- 解释
- 用户偏好

Planner Agent:
- 拆任务
- 查配方
- 制定目标

Safety Agent:
- 监控血量/怪物/卡住
- 可打断 primary action

Memory Agent:
- 总结经历
- 写入长期记忆
```

所有 agent 必须通过 coordinator：

```text
sourceAgentId
priority
lane
canInterrupt
permission
```

多 bot 只有在单 bot 稳定后再做。

---

## Phase 10：Touhou Little Maid，写计划但不实现

TLM 作为未来路线图保留：

```text
Future: Touhou Little Maid Adapter
```

参考价值：

```text
- owner 权限模型
- task 系统
- 女仆背包/跟随/战斗
- 大量附属生态
- 情绪/互动/伴随感设计
```

当前不实现原因：

```text
1. Mineflayer 玩家 bot 和 TLM 女仆实体是两套身体。
2. 当前主线是“AI 作为真实玩家”。
3. 现在接 TLM 会导致范围爆炸。
4. 等 MC body runtime 稳定后，TLM 可以作为第二身体适配器。
```

---

## 8. 测试计划

### 8.1 Smoke Test

```text
connect
spawn
say
observe.state
observe.inventory
observe.nearby_players
move.to_player
move.follow_player 60s
move.stop
mine.nearby_log 3
return_to_player
disconnect
```

### 8.2 Normal Player Test

```text
- 不给 OP
- 不开 /tp
- 不开 /data
- bot 必须通过正常路径移动
- 失败必须报告原因
```

### 8.3 Regression Test

每次改 skill，都跑：

```text
npm run test
npm run smoke:vanilla
npm run smoke:mechanomania
```

### 8.4 失败样例必须记录

```json
{
  "case": "follow_player_stuck",
  "world": "mechanomania",
  "botPos": {},
  "playerPos": {},
  "jobId": "",
  "pathEvents": [],
  "result": "failed",
  "reason": "STUCK"
}
```

---

## 9. 论文与项目启发

### Voyager

Voyager 的核心是自动课程、持续增长的技能库、从环境反馈/执行错误/自验证中迭代改进；论文明确把它描述为 Minecraft 中的 LLM lifelong learning agent。

本项目吸收：

```text
- 技能库要可积累
- 每个任务要有执行反馈
- 失败要进入经验记录
- 技能要可组合
```

不照搬：

```text
- 不允许 LLM 直接写任意 JS 并执行
- 技能必须是审核过的 structured skill / recipe
```

### JARVIS-1

JARVIS-1 使用视觉观察和人类指令进行规划，并配有多模态记忆；论文称其能完成 200+ Minecraft 任务。

本项目吸收：

```text
- 视觉未来有价值
- 记忆应该参与规划
- 结构化控制器比纯语言动作可靠
```

暂缓：

```text
- 不做第一阶段高频视觉
- 不让 vision 替代 block/entity structured state
```

### Odyssey

Odyssey 的启发是 primitive skills 与 compositional skills 分层。

本项目吸收：

```text
- move/mine/place/craft 是 primitive
- collect_wood/craft_item/complete_quest_step 是 compositional
- compositional skill 调 primitive，不直接碰 Mineflayer
```

### MineDojo

MineDojo 强调 Minecraft 作为开放世界 embodied agent benchmark，拥有大量任务和互联网规模知识。

本项目吸收：

```text
- 要有 benchmark / smoke test
- 任务要可复现
- 知识层要接入 wiki、手册、任务书、配方
```

### Ghost in the Minecraft / GITM

GITM 走 LLM + 文本知识 + 记忆 + 结构化动作路线，目标是更通用的 Minecraft agent。

本项目吸收：

```text
- 不要只靠视觉或 RL
- 文本知识和结构化动作非常重要
- 长任务需要记忆和状态跟踪
```

### MineStudio

MineStudio 关注 Minecraft AI agent 开发中的工程困难，并试图把 simulator、data、model、training、inference、benchmark 整合成开发包。

本项目吸收：

```text
- 工程可复现比单次 demo 更重要
- benchmark、日志、数据、接口都要统一
- 不能只做“能跑一次”的视频项目
```

---

## 10. 当前最小任务清单

近期只做这些：

```text
1. 删除根目录空的 mineflayer-pathfinder 文件。
2. 固定 TypeScript 格式化：prettier + eslint。
3. 统一 Position schema。
4. SkillRegistry 作为唯一 schema 来源。
5. REST/MCP schema 从 SkillRegistry 生成。
6. 修 follow cancel 语义。
7. 加 events.jsonl / jobs.jsonl。
8. 写 mechanomania smoke test。
9. 启动重度机械症服务端，测试 bot 登录。
10. 记录是否被 NeoForge/FML 握手踢。
```

暂缓：

```text
- 多 bot
- 多 agent coordinator
- Touhou Little Maid adapter
- AgentProbe Mod
- 高级视觉
- 自动驾驶载具
- 自动搭完整 Create 工厂
- ATM9 / 其他整合包适配
```

---

## 11. 里程碑

### M0：重度机械症可运行

```text
玩家进服成功
服务端稳定
记录 manifest
```

### M1：bot 登录成功

```text
bot 能 connect/spawn/chat/disconnect
```

### M2：bot 能站到你旁边

```text
observe + move.to_player + follow + stop
```

### M3：bot 能做普通玩家基础动作

```text
挖木头
捡物品
吃东西
回到玩家身边
遇怪自保
```

### M4：bot 能理解重度机械症早期流程

```text
读 quest
查 recipe
解释缺什么
辅助收集基础材料
```

### M5：Hermes 接入

```text
Hermes 能通过 MCP/REST 控制 bot
Hermes 能收到 world_event/job_event
Hermes 能把重要经历写入记忆
```

### M6：重度机械症陪玩 MVP

```text
玩家正常玩
AI 在旁边跟随、聊天、观察、辅助收集、读任务、查配方
不 OP
不 /tp
不乱挖
失败会说明
能停止
能恢复
```

---

## 12. 最终愿景

这个项目的终点不是“bot 会挖树”，而是：

> 玩家进入一个真实的机械动力整合包世界，AI 作为一个玩家站在旁边。她知道你们在哪，知道现在任务做到哪，知道基地在哪里，能跟你走路，能帮你收集简单材料，能查配方，能记住你们一起修过的路和建过的工坊。她不靠 OP 作弊，不假装会，不乱破坏。她失败了会停下来告诉你：我卡住了、我看不到路、我背包满了、这个方块我不认识。然后你们一起继续玩。

这才是 `mc-agent-service` 最有价值的方向：

```text
不是 Minecraft 自动化脚本，
而是 AI 在虚拟世界里的第一具身体。
```
