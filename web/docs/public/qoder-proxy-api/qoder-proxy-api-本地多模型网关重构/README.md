# qoder-proxy-api → 本地多模型网关：架构重构与并行开发包

> 评审对象：`ggbdpq/qoder-proxy-api` **main @ `47b1af6`**（v0.2.2，Node 24，零运行时依赖，`node --test` 89/89 绿）
> 参照系：`yetone/magpie`（MIT，Go，本机多 Agent 网关 + 原生控制台）——**借产品结构与交互语义，不借代码、名字、图标**
> 用途：交给 Cursor / ZCode 等编码代理**并行开发**。每个工作包写明归属文件、接口、验收和可直接粘贴的提示词。

## 一页结论

1. **继续用 Node + TypeScript，不改 Go。** magpie 选 Go 是为了单二进制、原生菜单栏和 TUI。我们的形态是"本机网关 + 浏览器控制台"：网关在 `/ui` 托管 React 静态产物，`npx` 或 Node SEA 分发就够；桌面壳（Tauri / Electron）放到最后，可选。
2. **先修 P0，再谈多模型。** 出口序列化器只输出 `text.delta`，工具调用、思考、`stopReason` 全丢（Q-P0-1，`src/protocols/openai/chat.ts` 里没有一处 `tool`）；入口把工具历史和图片压平（Q-P0-2）。不修这两个，接任何 Agent 都跑不通两轮工具往返。WP1–WP4 先做。
3. **原则调整，写进 ADR-0006**：从"显式路由、无自动 fallback"改为"**只允许显式、可见、跨供应商的改道**"。
   - 改道只在用户配置的**路由组**内发生；
   - 只在**下游还没收到任何内容之前**发生；
   - 每一次都产生路由事件，控制台可见。
   - **不做**同一服务的多账号池、额度共享或限流绕过。README 加定位声明。
4. **langchain.js 不进数据面。** Canonical Event 继续是核心语言。langchain 的消息模型会丢 thinking signature、`cache_control`、Responses item id，还多一层延迟。它只在三处出现：
   - **借语义**：middleware 的 beforeModel / modelFallback / modelCallLimit → 网关管线（自己实现，零依赖）；
   - **devDependency**：standard-tests 风格契约测试 + ChatOpenAI/ChatAnthropic/`createAgent` 两轮工具往返（Q3/Q4）；
   - **独立 `apps/playground`**：用 `createAgent` 经网关跑真实 Agent 循环。
5. **结构**：`apps/gateway`（现有 `src/` 原样迁入，零运行时依赖，新增 `/admin/*` 与路由事件流）、`apps/console`（React 19 + TS 7 + Vite 8 + React Router + Zustand 5 + Zod 4 + Tailwind 4 + shadcn CLI v4）、`packages/contracts`（admin 契约的 zod schema，只给控制台用）。配置存 JSON，用量存 `node:sqlite`。
6. **控制台照 magpie 的信息结构做 MVP**：Agent / 供应商 / 路由 / 用量 / 设置。Agent 只接 **Claude Code、Codex、OpenCode** 三个，配置写入带备份与恢复。

| # | 现状问题 | 证据 | 重构后 | 工作包 |
|---|---|---|---|---|
| Q-P0-1 | 出口只发 `text.delta`，丢工具 / 思考 / stopReason | `protocols/openai/chat.ts:60-75,88-89`；`anthropic/messages.ts:40,65-77`；`openai/responses.ts:71` | 三个序列化器完整映射 Canonical Event | WP1 |
| Q-P0-2 | 入口压平工具历史与图片：`content` 为空的 assistant 工具调用轮被整条丢弃，`tool_call_id` 不保留，图片变成 `[image: …]` 占位文本 | `openai/request.ts:19`（`if (!text) continue`）、`:15-27`、`:111-130`；`anthropic/request.ts:47-63` | 保真映射 + 往返性质测试 | WP2 |
| Q-P1-1 | `assertProvider` 校验恒通过（先合并默认值再查键） | `core/provider.ts:35` | 只查 provider 自己的返回值 | WP3 |
| Q-P1-2 | 上游失败一律 500；`beginSse` 先写 200 头 | `server/server.ts:195-209`；`openai/chat.ts:57` | 429/502/504 + Retry-After；先 peek 首事件再写头 | WP3 |
| Q-P1-3 | SSE 无心跳、无背压 | `server/sse.ts` | 15 秒心跳 + `drain` | WP3 |
| 新 | 只有 Qoder 三条链路，无法接其他供应商 | `core/provider.ts:16` id 联合类型 | 通用 OpenAI 兼容 Provider | WP5 |
| 新 | 显式路由一对一，无组、无健康状态 | `routing/modelRouter.ts:3` | 路由组 + 健康簿 + 改道管线 | WP6 |
| 新 | 无管理面、无可观测性 | — | `/admin/*` + 路由事件流 + 用量库 | WP7 |
| 新 | 无界面 | — | `apps/console` + Agent 接入 | WP8、WP9 |

## 已经验证过的（不是推测）

- **`附录/代码骨架/`：零依赖、能跑。** `node --test` **22/22 绿**，TypeScript 7.0.2 strict 0 错误。覆盖了：
  - 路由组 ordered / smart；
  - 首字节前 429 改道、首字节后不改道；
  - Retry-After 歇息与到点恢复；
  - 400 / 拒答不改道；
  - 全部在歇时返回 429 和最早恢复时间；
  - 能力过滤（图片）、会话亲和、客户端中止、maxAttempts、空回复；
  - 中间件钩子；
  - OpenAI 兼容 Provider 对接假上游（reasoning_content、分片 tool_calls、空 choices usage、CRLF 分帧、429/401）；
  - **端到端**：Codex Key → `group/daily` → Kimi 429 → 改道 DeepSeek → 工具调用完整下发 → `/admin/events` 回放出 8 个有序路由事件，且不含 prompt；
  - 请求体超限 413。
- **`附录/console-原型/`：能构建、能跑。** `tsc -b && vite build` 通过，有 9 张 Playwright 截图（`附录/截图/`）。
  - mock 模式：浏览器内按同一规则模拟事件；
  - live 模式：连 `附录/代码骨架/src/demoServer.ts`，**真实管线**产生的事件经 SSE 进入，逐条用 zod parse，0 条非法。
- 现有仓库基线：`47b1af6` 上 `node --test` 89/89 绿（Node 24.14.1）。本包**没有改动仓库**。
- 验证中发现、已写进设计的坑：
  1. `beginSse` 先写 200 头，所以"全部上游失败"只能变成流内错误。必须先 peek 首事件（`peekFirst`）再决定状态码。
  2. `AbortSignal.timeout` 会连流式正文一起掐断。首字节超时要自己用计时器实现，拿到响应头就清掉。
  3. 控制台在 dev server 跨源访问时，带 `Authorization` 的 `fetch` 会触发 CORS 预检。网关不处理 `OPTIONS`，`/admin/state` 就静默失败，界面拿着旧数据却看不出错。现在 dev 模式显式开 CORS，产品形态同源托管。
  4. `EventSource` 不能带请求头。正式版用 fetch 流读取 SSE，不把 token 放进 URL。
  5. 上游"干净结束但没有内容"要当作协议错误，并且允许改道（与 `dc6336f` 修过的空 body 同类）。

## 文档目录

| 文档 | 内容 |
|---|---|
| [00-评审：现状与借鉴 magpie 什么、不借什么](00-评审-现状与借鉴magpie什么不借什么.md) | 现状长板与短板；逐项取舍 |
| [01-目标架构](01-目标架构.md) | 进程拓扑、目录、管线、数据流、阶段 |
| [02-接口契约（WP0）](02-接口契约.md) | Canonical 增量、路由事件、路由组、Admin API、Agent 配置目标，**最先合并** |
| [03-并行开发计划](03-并行开发计划.md) | 依赖图、文件归属矩阵、合并顺序、worktree |
| [04-测试与验收](04-测试与验收.md) | 测试分层、不变量、每包验收、DoD |
| [05-风险与不确定点](05-风险与不确定点.md) | 置信度、待验证假设、回退方案 |
| ADR草案/ADR-0006~0009 | 改道原则；零依赖数据面与 contracts 边界；langchain 的位置；控制台托管、桌面壳与 Agent 范围 |
| 工作包/WP0–WP11 | 每包一份：目标、文件、步骤、验收、不要做、**Cursor 提示词** |
| [附录](附录/README.md) | 代码骨架、控制台原型、截图 |

## 推荐顺序（一句话版）

WP0（契约 + 目录迁移）→ 并行 **WP1 / WP2 / WP3 / WP5** → WP4（langchain 契约测试，验证 P0 真修好了）→ WP6（路由组管线）→ 并行 **WP7 / WP8** → WP9（Agent 接入）→ WP10（playground）→ WP11（分发与收尾，可选）。
