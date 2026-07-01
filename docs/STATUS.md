# mc-agent-service 状态文档

> 最后更新: 2026-07-02

## 项目概况

35 个 TypeScript 文件，~12,000 行代码。Standalone Node.js 服务，给外部 AI 提供 Minecraft"身体"。

## 当前真相来源

- 当前实现状态：本文档。
- 当前路线图：`docs/ROADMAP_v2.md`。
- 当前契约：`docs/SPEC.md`、`docs/API.md`、`docs/SKILLS.md`、`docs/ARCHITECTURE.md`。
- 历史参考：`docs/archive/*`，不作为当前任务来源。

## P0 Active Checklist

| ID | 项目 | 状态 | 说明 |
|---|------|------|------|
| P0 #1 | `distance` / `minDistance` 统一 | active | `move.*` skills 与 MCP wrapper 统一使用 `distance`；必要时保留兼容 alias。 |
| P0 #3 | 长运行 skill 取消语义 | active | `move.follow_player`、`move.stay`、`move.avoid_enemies` 等 abort 时必须返回 `ok:false,status:"cancelled"`。 |
| P0 #4 | Worker crash job ownership | active | `BotManager` 不再伪造 failed job；只发 `worker_dead`，由 `JobManager` 统一处理终态。 |
| P0 #5 | 安全默认值 | active | 默认 `127.0.0.1`；`0.0.0.0 + auth:none` 需 `MCAGENT_ALLOW_INSECURE=1`。 |
| P0 #2 | Action Lanes | post-P0 | primary / observation / safety / system 仲裁层，P0 #1/#3/#4/#5 后做。 |

## Memory provider 计划

Memory provider 采用三层枚举思路：

| Provider | 含义 | 状态 |
|---|---|---|
| `none` | 不持久化、不外发记忆事件 | v0.x 默认 |
| `built_in` | 服务内置持久化后端，如 file / sqlite | Phase 7 |
| `external` | 外部记忆服务，如 Hermes HTTP adapter 或其他 agent memory service | Phase 7 |

原则：memory provider 不参与动作执行，不阻塞 primary lane，不因为记忆失败影响 bot 生存或 job 状态。

## 完成状态

### ✅ Phase 1: Bug 修复（2026-06-20 完成）

| # | 问题 | 修法 |
|---|------|------|
| 1 | 事件空打戳 | EventBus 自动 stamp，不再传空 id/ts |
| 2 | worker 事件重复转发 | jobEventHandler 只调一次 |
| 3 | Job 取消未正确 cancelled | cancelled 状态正确传播 |
| 4 | 无单动作执行 | skillQueue 串行化 runSkill |
| 5 | API 路径错误 | chat asJob→chat.send, /look 删除, toggleMode 生效 |
| 6 | 超时状态 | 统一用 failed+JOB_TIMEOUT |
| 7 | observe.inventory 空 | creative 模式 fallback 到 slots |

### ✅ Phase 2: 核心能力（2026-06-20 完成）

新增 6 个技能，共 35 个：
- `inventory.place_block` — 放方块（坐标/自动）
- `inventory.consume` — 吃东西
- `move.to_entity` — 走到指定实体
- `move.away` — 远离目标
- `observe.block_at` — 查指定坐标方块
- `observe.nearest_free_space` — 找最近空位

参数对齐：`minDistance`, `range`, `distance` 统一。

### ✅ Mode 层: Alive Behavior（2026-06-20~25）

| Mode | 优先级 | 行为 |
|------|--------|------|
| `self_preservation` | 100 | 水里跳、岩浆火逃跑、低血量逃跑、被埋挖出（自动换工具） |
| `unstuck` | 90 | Job 卡住 5s 跳→10s 跑→15s 挖→20s 放弃；Idle 只跟踪血量 |
| `self_defense` | 80 | 怪 >3 格：用 pathfinder 往质心反方向跑；怪 ≤3 格：换武器攻击 |
| `idle_staring` | 10 | 每 200ms 看最近玩家，没人时 pitch=0 |
| `elbow_room` | 5 | 玩家 <1.5 格时转头+后退 |

**关键技术发现：**
- `requestAction` 是空函数（onRequestAction 没接线），mode 调 requestAction 什么都不执行
- 服务器每 3 秒发 `position_look` 包重置 pitch→1.57（看地面）
- 修法：在 `mineflayer-adapter.ts` 用 `prependListener` + `bot.on("move")` 事件拦截

### 🟡 剩余已知问题

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| 1 | 创造模式飞行 | 待做 | pathfinder 不支持 `canFly`，需双击跳跃进飞行态 |
| 2 | NaN 坐标 bug | isFinite() check 已加 | Mineflayer 1.21.x 物理引擎 bug，bot 受伤→坐标 NaN→踢出 |
| 3 | 弓/远程武器 | 未实现 | 自防御模式只用近战攻击 |
| 4 | consume 食物识别 | 待完善 | 腐肉等食物未识别，需要完整食物表 |
| 5 | `mine.dig_down` 效率 | 已修但慢 | 生存模式能挖，但等待 fall 的 delay 较长 |
| 6 | `place_block` 自动空位 | 已修 | 周围都是石头时找不到空位（正常行为） |
| 7 | `move.avoid_enemies` | 已修 | 质心算法已修复来回跑问题 |

### ⏳ Mindcraft 有但我们没有的能力（按优先级）

| # | 能力 | 工作量 | 说明 |
|---|------|--------|------|
| 1 | `place_block` 至自动放置 | 小 | 现在已支持手动坐标 + 自动空位 |
| 2 | `activateNearestBlock` | 中 | 按按钮、拉杆、用工作台 |
| 3 | `consume` | 小 | 已实现但食物表不全 |
| 4 | `craftingPlan` | 中 | 查合成需要什么材料 |
| 5 | 搜索方块/实体 | 中 | Mindcraft 有大范围搜索 |
| 6 | 记住位置 | 小 | 标记家/矿洞入口并返回 |
| 7 | 村民交易 | 大 | 不优先 |
| 8 | 翻地播种 | 中 | 不优先 |
| 9 | 蓝图建造 | 大 | 不优先 |
| 10 | 聊天/对话 | 中 | 不优先（多 bot 交互） |
| 11 | 弓/远程 | 中 | 自防御模式扩展 |

### ⏳ 架构层面待做

| # | 项目 | 工作量 | 说明 |
|---|------|--------|------|
| 1 | **Hermes plugin** | 小 | `ctx.register_tool` 封装 HTTP 调用，让 Hermes 感知不到服务层 |
| 2 | **HERMES_INTEGRATION.md** | 小 | 设计文档，说明 turn-based agent 怎么集成 |
| 3 | **动作通道（Action Lanes）** | 大 | 观察/写入/系统三通道，互不阻塞 |
| 4 | **ModeEngine 重做** | 大 | 模式不只能 interrupt，能执行技能并恢复 |
| 5 | **重连架构** | 中 | BotManager vs MineflayerAdapter 职责分清 |
| 6 | **持久化** | 大 | JSONL 事件日志、Job 历史、WS replay |
| 7 | **合约测试** | 中 | REST schema、MCP tools、WebSocket 格式 |
| 8 | **MCP 对齐** | 中 | API.md 工具名与实现统一 |
| 9 | **OpenAPI 输出** | 小 | 从 skill registry 自动生成 |
| 10 | **Auth 加固** | 中 | MCP HTTP auth、config 脱敏、请求 ID |
| 11 | **文档对齐** | 小 | 2026-07-01 已对齐 API.md/SKILLS.md/SPEC.md/ARCHITECTURE.md 与代码，详见下方 |
| 12 | **Normal Player Mode 文档** | 已加 | 见 `docs/NORMAL_PLAYER_MODE.md`，定义无 OP、无作弊、玩家可见信息边界 |

### 📋 文档-代码对齐记录 (2026-07-01)

已修复的文档差异：

| 文档 | 修复内容 |
|------|---------|
| API.md | `state.changed` 从 JSON Patch 改为完整 BotState；observe 精简为实际返回值；POST /look 标记为已移除；stop/start 标注未实现参数；bot.kicked 标注未发出；rate limiting 标注仅 chat 已实现；config 脱敏说明更新 |
| SKILLS.md | 添加 6 个缺失技能：`move.to_entity`, `move.away`, `inventory.place_block`, `inventory.consume`, `observe.block_at`, `observe.nearest_free_space` |
| SPEC.md | 权限表从旧名（move/dig/place/attack/...）对齐为实际名（movement/block.break/block.place/combat/...）；MCP 工具名对齐 |
| ARCHITECTURE.md | 标注持久化/插件加载/内存提供者/重连指数退避为未实现；rate limiting 标注仅 chat 已实现 |

已知但未修（代码层面待做）：

| # | 问题 |
|---|------|
| 1 | `state.changed` 应改为 JSON Patch diff（目前发完整 state） |
| 2 | POST /stop 和 DELETE /bots 的 `cancelledJobIds` 始终返回 `[]` |
| 3 | POST /start 的 `forceReconnect`/`reason` 参数未接入 |
| 4 | GET /bots/:botId 返回空 config |
| 5 | `bot.kicked` 事件 schema 已定义但未通过 WS 发出 |
| 6 | observe 不支持 `include`/`radius`/`blockNames` 过滤参数 |
| 7 | 认证中间件代码已存在但 MCP HTTP transport 未接入 |
| 8 | 仅 chat 有 rate limit；通用 REST/WS/MCP rate limit 未实现 |

## 架构要点

```
service = 身体（执行动作）
AI = 大脑（决定做什么）

即时反应（被打、低血量） → ModeEngine 内部处理，不过 HTTP
连续任务（跟随、挖矿）   → Job 系统，Hermes 发一次指令，job 自己跑
决策（下一步做什么）     → Hermes/Codex 决策，通过 HTTP/WS 调用
```

## 和 Mindcraft 的差距

| 能力 | Mindcraft | mc-agent-service |
|------|-----------|-----------------|
| 自主循环 | ✅ SelfPrompter | ❌ 由外部 AI 驱动 |
| 村民交易 | ✅ | ❌ |
| 蓝图建造 | ✅ | ❌ |
| 翻地播种 | ✅ | ❌ |
| 聊天/对话 | ✅ | ❌ |
| 工具有效性 | ✅ | ⚠️ 部分 OK |
| 服务化 API | ❌ 单体应用 | ✅ REST/WS/MCP |
| Worker 隔离 | ❌ | ✅ |
| 类型安全 | ❌ JS | ✅ TS + Zod |
| Fabric 模组兼容 | ❌ | ✅ 协议层无感知 |

## Roadmap (high level)

Detail in `docs/ROADMAP_v2.md`. SPEC §13 is the index.

| Phase | Status | One-line |
|---|---|---|
| 0 Repository hardening (P0 #1/3/4/5 + lanes + replay) | **active** | Code change, tracked above |
| 1 Brain-agnostic transport | **in place** | MCP/REST/WS; clients swap freely |
| 2 Core body runtime stability | **active** | Same as Phase 0 |
| 3 Mod-aware observation | **next** | `observe.recipe` / `observe.jade_look_at` / `observe.quest_*` / `observe.guide_*` |
| 4 Mod-aware action | **next** | Create-aware craft/interact skills |
| 5 Modpack knowledge indexer | **next** | Offline scan → `knowledge.sqlite` |
| 6 Create early-game helper | **next** | Compositional skills over 3–5 |
| 7 Memory providers | **reserved** | Provider kinds: `none` / `built_in` / `external` |
| 8 AgentProbe Mod | **external** | Separate NeoForge repo |
| 9 Multi-brain / multi-bot | **deferred** | Multi-brain already works; multi-bot coordination not |
| 10 Touhou Little Maid | **deferred** | Body-vs-entity split |
