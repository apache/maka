# 00 · 评审：现状，以及向 magpie 借什么、不借什么

## 1. 现状：骨架是对的，出口是漏的

qoder-proxy-api @ `47b1af6`：约 4.1k 行 TS，零运行时依赖，Node 24 原生跑 `.ts`，`node --test` 89/89 绿。

**长板（重构必须保住）**

| 编号 | 长板 | 位置 | 重构里的去向 |
|---|---|---|---|
| S1 | Canonical Event：三条链路只说一种内部语言 | `core/events.ts` | **继续是核心**，新 Provider 也只产出它 |
| S2 | 非流式由流式聚合，没有第二条执行路径 | `core/aggregate.ts` | 不动；路由管线只包流式 |
| S3 | 显式路由，没有隐式 fallback | `routing/modelRouter.ts:3` | 升级为"显式路由组内的可见改道"（ADR-0006） |
| S4 | 目录依赖方向有脚本检查 | `scripts/architectureCheck.ts`（注释写着"一次性脚本，不入 npm scripts"） | 加进 `pnpm check`，并新增 `routing ↛ protocols`、`admin ↛ providers` 两条 |
| S5 | 认证 single-flight | `providers/gateway/auth.ts` | 不动 |
| S6 | 真实抓包 fixture | `test/fixtures/gateway/thinking-tools.sse` 等 | WP1 直接用它做出口回放 |
| S7 | 客户端断开时中止上游 | `server/server.ts:75-78` | 管线保留：abort 不改道、不让成员歇 |

**短板（按阻塞程度）**

- **Q-P0-1 出口丢事件。** 三个序列化器只处理 `text.delta` / `usage` / `error`。`thinking-tools.sse` 回放出来的工具调用到不了客户端，`finish_reason` 永远是 `stop`。Claude Code / Codex / OpenCode 都依赖工具调用，这一条不修，"接入 Agent"就无从谈起。
- **Q-P0-2 入口压平。** `chatToCanonical` 把内容压成字符串，空内容直接 `continue`，所以 assistant 的 `tool_calls` 轮整条消失，`tool` 消息也丢了 `tool_call_id`。Anthropic 侧同理。第二轮请求里，模型看不到自己上一轮调过什么工具。
- **Q-P1-1～3**：`assertProvider` 恒通过；错误一律 500；`beginSse` 先写 200 头；SSE 无心跳、无背压。
- **结构性缺口**：Provider id 是 `"gateway" | "cli" | "cloudAgents"` 联合类型（`core/provider.ts:16`），接不了别家；没有管理面，没有可观测性，也没有界面。

## 2. magpie 是什么（只陈述读到的事实）

`yetone/magpie`，MIT，Go。本地克隆约 30.5 万行 Go，其中 gateway 约 6.6 万行，支持 60 多个 Agent。
- 原生 GUI（`internal/gui/assets/app.css` 定义了全部设计令牌）、菜单栏、TUI、CLI。
- **路由组**：`routing=` 可选 `smart`（默认，按订阅额度窗口）/ `order` / `rotate` / `usage` / `pace` / `weight`（`docs/reference.md:1274`）。
- **歇息规则**（`reference.md:1493-1520`）：
  - 429 额度用完 → 歇到恢复，且"只要回复还没发出一个字"就立即改道；
  - 短限流按 `Retry-After` 歇（最多 1 小时），否则从 1 分钟起翻倍，最多 30 分钟；
  - 其他失败从 1 分钟起递增，最多 10 分钟；
  - 401/403、模型不存在也会歇。
- **安全拒答不让任何人歇**，可配置是否换人重问；其他 400 一律不重试（`reference.md:1522-1535`）。
- `affinity.json` 记录每个会话由哪把 Key / 哪个账号回答（`reference.md:2827`）。
- 大量逻辑围绕**同一服务的多订阅账号**：额度窗口、周节奏、`smart` 按额度续期时间排序。

## 3. 逐项取舍

| magpie 的东西 | 决定 | 理由 |
|---|---|---|
| 顶部分段导航：Agent / 供应商 / 网关 / 路由 / 用量 / 会话 / 资源库 / 插件 | **借结构，裁剪**为 Agent / 供应商 / 路由 / 用量 + 设置 | "网关"页并进设置；会话、资源库、插件不是 MVP |
| 设计令牌（`app.css` 的 `--bg/--card/--pill/--line/--accent…`、明暗两套） | **借数值**，命名保持一致便于对照 | MIT 允许；见原型 `src/styles.css` |
| Agent 行：图标 + 名称 + "● 已接入 · 说明" + "模型 N ›" + 模型下拉 + 开关；"显示其余 N 个"；底部"方案"chips + "＋ 保存当前" | **借交互** | 原型 `AgentPage.tsx` |
| 路由页：组卡片 + 策略说明 + 拓扑（左 Agent、中网关、右上游）+ 统计 + "最近一个请求是怎么路由的" + 路由组列表 | **借交互**；数据换成我们自己的路由事件 | 原型 `RoutingPage.tsx`、`Topology.tsx` |
| 名称、logo、各厂商 logo | **不借** | 用首字母色块，见原型 `Mark` |
| 60+ Agent 接入 | **不借**，只做 Claude Code / Codex / OpenCode | 每个配置写入器都要备份、恢复、三方差异，3 个做扎实比 60 个半成品值钱（ADR-0009） |
| 路由组 + `order` | **借** → `ordered` | |
| `smart`（按订阅额度窗口） | **改义**：我们的 `smart` = 会话亲和 → 最近没出错 → 并发少 → 首字快 → 配置顺序 | 我们没有、也不做额度窗口（见下一行） |
| `rotate` / `usage` / `pace` / `weight` | **不借**（先） | `pace`/`usage` 依赖额度窗口；`weight` 等有真实需求再说 |
| 歇息规则（Retry-After、翻倍、上限） | **借**，作用于"成员 = 供应商 + 模型" | 骨架 `health.ts` 的 `classify()` |
| "回复发出一个字之前才改道" | **借**，定为不变量 I1 | 骨架 `pipeline.ts` |
| 拒答 / 400 不让人歇、不改道 | **借**（简化为一律不改道） | 换人重问拒答属于内容策略，不进 MVP |
| 会话亲和（affinity） | **借**，内存 Map，P4 再落盘 | 提示词缓存命中率 |
| 同一服务多账号、额度共享、订阅轮换 | **不借，且写进定位声明** | 绕过 Qoder 等服务的单账号额度与条款，风险由用户和项目承担，不做（ADR-0006） |
| Go 单二进制、原生菜单栏、TUI | **不借** | 见 §4 |

## 4. 为什么不切 Go

- magpie 要 Go，是因为它要做原生菜单栏 App + TUI + 单文件分发。
- 我们的形态是"本机网关 + 浏览器控制台"：
  - 网关本来就是 Node 24 零依赖；
  - 控制台是静态文件，网关在 `/ui` 托管；
  - 分发用 `npx qoder-proxy-api` 或 Node SEA（单文件，WP11 验证）；
  - 要桌面壳再套 Tauri / Electron。
- 重写成 Go 等于丢掉 89 个测试、3 条已经调通的 Qoder 链路和 Canonical 设计，换来的只是分发方式，不划算。

## 5. 为什么 langchain.js 不进数据面

网关的职责是**无损转发**。langchain 的消息模型（`AIMessageChunk` 等）是为"应用写 Agent"设计的，放进数据面有四个问题：
- 丢 Anthropic thinking 块的 `signature`（下一轮回传时必须原样带上）；
- 丢 `cache_control`；
- 丢 Responses API 的 item id；
- 每个 chunk 多一次对象转换。

它在本项目的三个位置见 ADR-0008：借 middleware 语义、devDependency 契约测试、独立 playground。
