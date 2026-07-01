
我看完了。先说结论：**这个仓库不算“粗糙”，方向其实很对；它现在的问题不是“没东西”，而是已经长出了服务骨架，所以接下来最该补的是合约一致性、任务状态机、动作互斥和安全默认值。**

我这里是基于公开 GitHub 页面和 raw 文件做的代码审查，没有本地 clone 运行 build/test，所以运行时结论我会说得保守一点。

## 总体评价

你这个 `mc-agent-service` 的定位很清楚：**不是再魔改 Mindcraft，而是把 Mineflayer 抽成一个“Minecraft 身体服务”，让外部 LLM / Hermes / MCP 客户端通过结构化 API 控制它。** 这和之前我们定的路线很贴：第一阶段先让 AI 进服、聊天、跟随、停止、简单采集；Hermes、视觉、TTS、长期记忆都放后面，避免一开始糊成一锅粥。

仓库目前是公开 repo，主分支有 42 次提交，文件里已经有 `src/`、`API.md`、`ARCHITECTURE.md`、`SPEC.md`、`STATUS.md`、`mc-agent-service.json`、`package.json`、`tsconfig.json` 等，语言显示 TypeScript 100%。但根目录没有 README，我打开 raw README 是 404，这对后续交给 Codex / Hermes / 其他人使用会比较伤。([GitHub][1])

我的打分大概是：

| 项             |     评价 |
| ------------- | -----: |
| 架构方向          |   8/10 |
| MVP 工程完成度     |   6/10 |
| 接 Hermes 的可用度 | 4.5/10 |
| 安全边界          | 6.5/10 |
| MC 行为可靠性      |   5/10 |

不是贬低，是它现在已经进入“不能再随便堆功能”的阶段了。现在最值钱的是把它变成一个**可靠身体运行时**。

## 做得好的地方

第一，**分层方向非常正确**。`SPEC.md` 里明确写了它是独立 TypeScript/Node 服务，负责给外部 AI agent 提供 Minecraft body，通过 HTTP / WebSocket / MCP 包装 Mineflayer；同时明确 non-goals：不内置 LLM、不做 prompt 模板、不做自然语言命令解释、不提供任意代码执行端点、不直接依赖 Hermes/Codex/Claude Code。这个边界特别好。([GitHub][2])

第二，**架构没有让 API 层直接碰 Mineflayer 对象**。`ARCHITECTURE.md` 里写的是 API Gateway → Control Plane → Worker → Bot Runtime → Mineflayer，并强调 API adapters 不直接触碰 Mineflayer 对象；还有一 bot 一 worker thread、typed messages、worker crash recovery、event bus、状态快照/差分等设计。这比“Express 路由里直接 bot.chat / bot.pathfinder.goto”成熟很多。([GitHub][3])

第三，**安全方向比 Mindcraft coding 模式稳**。你没有让 LLM 写 JS 再执行，而是把能力压成结构化 skill 参数；文档里也强调 no code generation、no natural-language command execution、no arbitrary JS endpoint。这正好避开 Mindcraft 原本最吓人的那块。([GitHub][3])

第四，**状态推进很快**。`STATUS.md` 显示到 2026-06-26 已经有 35 个 TS 文件、约 12k LOC；Phase 1 修了 EventBus stamp、worker event duplicate、job cancel status、skillQueue 串行化、API routes、timeout 等问题；Phase 2 已经扩到 35 个 skills，并加了 self_preservation、unstuck、self_defense、idle_staring、elbow_room 这些模式。这个不是玩具脚本了。([GitHub][4])

第五，**TypeScript 严格度不错**。`tsconfig.json` 开了 `strict`、`noImplicitAny`、`strictNullChecks`、`noUncheckedIndexedAccess`，这对 agent runtime 很重要。你现在这种系统最怕“undefined 坐标传进去，然后 bot 在世界里抽风”。([GitHub][5])

## 最高优先级问题

### 1. MCP 工具参数和 skill schema 有不一致风险

我看到一个比较具体的坑：MCP 里的 `move.to_position` 工具参数用了 `distance`，但实际 movement skill 的 schema 是 `minDistance`，而且 schema 是 strict。这样外部 MCP 客户端调用 `move.to_position` 时，很可能传进去 `{ x, y, z, distance }`，然后被 skill schema 判成未知字段，或者至少不是你预期的参数语义。([GitHub][6])

这个问题很典型：**REST / MCP / SkillRegistry 三套 schema 手写，最后一定漂移。**

建议改成：

```text
SkillRegistry / Zod schema 是唯一事实源
        ↓
自动生成 REST validation
        ↓
自动生成 MCP tool schema
        ↓
自动生成 OpenAPI / API.md
```

短期可以兼容 alias：

```ts
distance -> minDistance
```

但长期不要靠手写同步。这个优先级我会放 P0，因为 Hermes 后面接 MCP 时，会直接踩。

### 2. Action lanes 还没真正落地

`STATUS.md` 自己也把 action lanes 放在 future/TODO 里。现在 skillQueue 已经能串行化 `runSkill`，这是好事，但 MC bot 不是只有“一个动作队列”这么简单。移动、挖掘、战斗、自保、观察、聊天、模式引擎会互相抢资源。([GitHub][4])

建议至少拆成：

```text
primary lane：移动 / 挖掘 / 放置 / 合成 / 跟随
safety lane：自保 / 逃离 / 防御 / unstuck
observe lane：状态查询 / 附近实体 / 背包 / 方块查询
chat lane：聊天输出
system lane：start / stop / reconnect / cancel
```

规则可以简单一点：

```text
observe 不阻塞 primary
chat 不阻塞 primary
safety 可以中断 primary
primary 同时只能一个
system 可以取消所有
```

这一步比继续加新 skill 更重要。没有 lanes，后面“跟随 + 自保 + 采集 + Hermes 指令”会变成一锅并发炖汤。

### 3. Cancel 语义需要统一

`move.follow_player` 这种长循环 skill 被取消后，目前看起来会返回类似 success + cancelled data 的语义；`JobManager` 对 running job 的 cancel 也是发 cancel 命令后等待 worker 事件决定最终状态。([GitHub][7])

我建议统一成这套：

```text
用户取消 / 上层取消：
job.status = cancelled
reason = USER_CANCELLED / SUPERSEDED / MODE_INTERRUPT

安全模式打断：
job.status = cancelled
reason = SAFETY_INTERRUPT

超时：
job.status = failed
code = JOB_TIMEOUT

路径失败 / 方块找不到：
job.status = failed
code = PATH_NOT_FOUND / BLOCK_NOT_FOUND

正常到达 / 正常完成：
job.status = succeeded
```

不要让“取消”伪装成 success。Hermes 后面会根据 job 结果更新计划，如果 cancelled 被当成 succeeded，它就会误以为“跟随任务完成了”，然后状态会慢慢歪掉。

### 4. Worker 崩溃和 command 发送失败会让 Job 状态变脏

`BotManager` 里 worker exit 时会合成一个 failed job 事件；`sendCommand` 在没有 active worker 时只是 log warning 然后 return。这个设计有隐患：JobManager 可能已经把 job 认为 running 了，但命令实际没发出去。([GitHub][8])

这里应该让 **JobManager 永远是 job 生命周期的 owner**：

```text
BotManager 只报告：
- worker_dead(botId)
- command_send_failed(botId, jobId, reason)

JobManager 负责：
- 找到原始 job
- 标记 failed/cancelled
- 清 timeout
- 发 job.failed/job.cancelled 事件
```

不要在 BotManager 里“捏造一个 failed job”。这个以后 debug 会很痛。

### 5. 默认安全配置偏危险

默认配置里 `http.host` 是 `0.0.0.0`，auth mode 是 `none`；示例 `mc-agent-service.json` 也绑定 `0.0.0.0`，bot 用 offline auth 连接本地 MC 服务。虽然你有 bearer / api-key auth 支持，也有 rate limit 组件，但默认裸开在所有网卡上很危险。([GitHub][9])

建议默认改成：

```json
{
  "http": {
    "host": "127.0.0.1"
  },
  "auth": {
    "mode": "none"
  }
}
```

如果用户配置成：

```text
host = 0.0.0.0
auth.mode = none
```

启动时直接拒绝，除非显式设置：

```bash
MCAGENT_ALLOW_INSECURE=1
```

这很必要。MC bot 能挖方块、放方块、移动、聊天、攻击，裸 API 等于把世界遥控器扔局域网里。

## 中优先级改进

### 补 README，而且要补“最短运行路径”

现在 repo 没 README，这会让人第一眼不知道怎么跑。建议 README 只写最小闭环：

```text
1. 安装依赖
2. 启动本地 MC server
3. 修改 mc-agent-service.json
4. npm run dev
5. curl 创建 bot / 启动 bot
6. curl 调用 say / move / observe
7. MCP 怎么接
```

文档可以很短，但必须有。`API.md / ARCHITECTURE.md / SPEC.md` 是给开发者看的，README 是给“十分钟内跑起来”的人看的。

### 格式化要立刻统一

raw 文件看起来很多是单行/压缩风格，虽然不影响运行，但会严重影响 code review、diff、Codex 修改质量。建议加：

```bash
prettier
eslint
lint-staged 可选
```

然后做一次全仓库 format。这个不是洁癖，agent 项目后面会被 AI 工具频繁改，格式不稳定会让 diff 像雪崩。

### Mineflayer 版本要重新评估

`package.json` 里是 `mineflayer ^4.23.0`，但 npm 上 Mineflayer 最新已经到 4.37.1，官方 repo 说明支持 Minecraft 1.8 到 1.21.11。([GitHub][10])

建议不要盲升，但要做版本矩阵：

```text
目标 MC 版本：1.21.6 / 1.21.8 / 1.21.11
Mineflayer：当前 4.23.x vs 最新 4.37.x
测试项：登录、聊天、移动、pathfinder、挖掘、背包、实体观察
```

如果目标是稳定接 Hermes，我倾向于**锁定一个 MC 版本 + 一个 Mineflayer 版本**，不要用宽松 `^` 漂移。

### State / Event 需要 replay 能力

WebSocket 现在有订阅、广播、ping heartbeat；架构文档里也提了 event bus 和 JSONL persistence，但 `STATUS.md` 还把 persistence / replay 放在 TODO。([GitHub][11])

后面 Hermes 接入时，这个很关键。Hermes 不应该只靠“当前 socket 在线时收到的事件”。建议加：

```text
events.jsonl
jobs.jsonl
state snapshots
GET /bots/:id/events?since=eventId
GET /jobs/:id
GET /bots/:id/snapshot
```

否则 Hermes 一重启，就不知道 bot 刚刚为什么停下、哪个 job 被取消、有没有被怪打断。

## 我建议的下一步路线

别继续狂加技能了，先硬化运行时。

### 第一阶段：仓库可用性

```text
1. 加 README quickstart
2. 全仓库 Prettier format
3. 默认 host 改 127.0.0.1
4. 0.0.0.0 + auth none 时拒绝启动
5. 写一个 examples/curl-basic.sh
```

### 第二阶段：合约统一

```text
1. SkillRegistry 作为唯一 schema 来源
2. MCP tools 从 SkillRegistry 生成
3. REST validation 从同一份 schema 来
4. 修 move.to_position distance/minDistance 漂移
5. 生成 OpenAPI / MCP tool list
```

### 第三阶段：Job / cancel / lanes

```text
1. 引入 action lanes
2. 统一 cancellation status
3. 所有 skill 必须有 finally cleanup
4. BotManager 不再捏造 job
5. JobManager 统一处理 worker crash / timeout / cancel
```

### 第四阶段：Hermes adapter

等上面稳了，再写 Hermes plugin：

```text
Hermes tool:
- mc.list_bots
- mc.get_state
- mc.say
- mc.move_to_player
- mc.follow_player
- mc.stop_current_action
- mc.collect_blocks
- mc.place_block
```

而且 Hermes 一开始只发**高层结构化命令**，不要让它直接规划复杂生存任务。先让它做到“看状态 → 做一个动作 → 等 job 结果 → 再决定下一步”。

## 最关键的设计建议

你现在这个仓库最有价值的地方是：**它把 AI brain 和 Minecraft body 分开了。**

所以之后不要把它重新写回“一个会聊天的 MC AI 大杂烩”。它应该保持冷静、结构化、可审计：

```text
mc-agent-service：
我能看到什么？
我能做什么？
我正在做什么？
我为什么失败？
我能不能安全停止？

Hermes：
我要不要让她做？
这件事是否符合记忆、偏好、权限、上下文？
失败后怎么安抚/解释/重试？
```

现在的方向对。下一步不是“让她更聪明”，而是让这个身体**不乱动、不误报、不失控、可恢复**。这一步过了，Hermes 接进去才会真的优雅。

[1]: https://github.com/Asanilo/mc-agent-service "GitHub - Asanilo/mc-agent-service · GitHub"
[2]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/SPEC.md "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/ARCHITECTURE.md "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/STATUS.md "raw.githubusercontent.com"
[5]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/tsconfig.json "raw.githubusercontent.com"
[6]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/src/api/mcp.ts "raw.githubusercontent.com"
[7]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/src/skills/movement.ts "raw.githubusercontent.com"
[8]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/src/core/bot-manager.ts "raw.githubusercontent.com"
[9]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/src/core/config.ts "raw.githubusercontent.com"
[10]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/package.json "raw.githubusercontent.com"
[11]: https://raw.githubusercontent.com/Asanilo/mc-agent-service/master/src/api/websocket.ts "raw.githubusercontent.com"
