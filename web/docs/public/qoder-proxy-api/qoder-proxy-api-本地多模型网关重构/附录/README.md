# 附录：代码骨架、控制台原型、截图

## 1. `代码骨架/`：零依赖参考实现（约 1440 行，Node 24 直接跑 TS）

```bash
cd 代码骨架
node --test "test/*.test.ts"     # 22/22（见 test-output.txt）
node src/demoServer.ts           # 演示网关 http://127.0.0.1:8320，admin token = demo
```

| 文件 | 内容 | 落到哪个 WP |
|---|---|---|
| `src/events.ts` | Canonical 最小副本 + `retryAfterMs`、`PROVIDER_REJECTED`、`GatewayProvider{id,kind,label}` | WP0 |
| `src/routeEvents.ts` | `RouteEvent` 类型 + `RouteEventBus`（环形 500 条、`since(seq)`、订阅） | WP0 / WP6 |
| `src/health.ts` | `classify()` 歇息规则 + `HealthBook`（EWMA 首字节、在途数、重置） | WP6 |
| `src/routeGroups.ts` | `parseRouteGroups`（手写校验）+ `plan()`（ready / resting / skipped、ordered / smart） | WP6 |
| `src/pipeline.ts` | `resolveTarget`、`routeStream`（commit 前扣住、改道、maxAttempts）、`peekFirst`、`httpStatusOf` | WP3 / WP6 |
| `src/openaiCompatible.ts` | OpenAI 兼容 Provider（首字节计时器、SSE 解析、tool_calls 分片、Retry-After） | WP5 |
| `src/gatewayServer.ts` | `/v1/chat/completions` + `/admin/state`、`/admin/events`（回放 + 心跳）、`/admin/health/reset`；8 MB 上限；dev CORS | WP3 / WP7 |
| `src/fakes.ts` | 脚本化假 Provider | 测试 |
| `src/demoServer.ts` | 假供应商 deepseek / kimi（每 4 次 429）/ glm / qoder，3 个组，3 把 Agent Key，自动造流量 | 演示 |
| `test/pipeline.test.ts` | 17 个管线用例 | WP6 |
| `test/openaiCompatible.test.ts` | 5 个用例，含端到端：Codex → `group/daily` → Kimi 429 → DeepSeek | WP5 / WP6 |

**简化之处（不要原样照搬）**：只实现了 `/v1/chat/completions` 一个入口；Canonical 是最小副本；能力是布尔视图；没有持久化。

## 2. `console-原型/`：React 控制台原型

```bash
cd console-原型
pnpm install
pnpm dev                          # mock 模式：浏览器内按同一规则模拟路由事件
# live 模式：先在另一个终端跑 代码骨架 的 demoServer，然后打开
#   http://localhost:5173/?live=http://127.0.0.1:8320&token=demo
pnpm build                        # tsc -b && vite build
```

技术栈：React 19.3、React Router 8、Zustand 5、Zod 4、Tailwind 4.3、Vite 8.3、TypeScript 7.0。

| 文件 | 内容 |
|---|---|
| `src/contracts.ts` | zod schema（→ WP0 的 `packages/contracts`） |
| `src/store.ts` | Zustand reducer：逐条 safeParse、`invalidEvents`、健康、在途、有界 trace |
| `src/sim.ts` / `src/live.ts` | mock 事件源 / 连真实网关（`/admin/state` + SSE） |
| `src/configPreview.ts` | 三个 Agent 的配置片段预览（字段待 WP9 验证） |
| `src/pages/*` | Agent、供应商、路由（含拓扑 SVG 与请求逐步说明）、用量、设置 |

**mock 与真实的边界**：路由页的事件在 live 模式下来自真实管线；供应商 / 用量页的数字、Agent 页的写入都是原型数据，没有写任何文件。模型名仅作示意。

## 3. `截图/`

| 文件 | 内容 |
|---|---|
| `01-路由页-实时.png` | 路由页：组卡片、拓扑连线、统计、最近请求说明 |
| `02-Agent页.png` | 三个 Agent、模型选择、方案 |
| `03-路由页-深色.png` | 深色主题 |
| `04-供应商页.png` | 供应商列表与歇息状态 |
| `05-用量页.png` | 用量 |
| `06-断开确认.png` | 断开 → 从备份恢复确认 |
| `07-接入确认-配置预览.png` | 接入 → 备份并写入，配置 diff 预览 |
| `08-新建组-校验.png` | 新建路由组的字段级校验 |
| `09-路由页-连接演示网关.png` | live 模式：真实管线事件，0 条非法 |
