# mc-agent-service 状态文档

> 最后更新: 2026-06-26

## 项目概况

35 个 TypeScript 文件，~12,000 行代码。Standalone Node.js 服务，给外部 AI 提供 Minecraft"身体"。

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
