# WP8 · 控制台：供应商 / 路由 / 用量 / 设置

- **目标**：把 `附录/console-原型` 产品化为 `apps/console`，接上 WP7 的真实契约。
- **依赖**：WP0（contracts）。可与 WP6 同时开工（mock 模式），联调依赖 WP7。
- **分支**：`feat/wp8-console`
- **归属文件**：`apps/console/**`（Agent 页只做静态壳，WP9 接真实逻辑）
- **起点**：`附录/console-原型/`（构建通过，9 张截图，live 模式已对演示网关验证 0 条非法事件）

## 技术栈

React 19、TypeScript 7、Vite 8、React Router、Zustand 5、Zod 4（从 `@qpa/contracts` 引入）、Tailwind 4、shadcn CLI v4（按需生成组件，替换原型里手写的 `components/ui.tsx`）。

## 步骤

1. 迁移原型；`contracts.ts` 改为 import `@qpa/contracts`。
2. 数据层：`api.ts`（fetch + token + `If-Match` + 错误解析）、`events.ts`（**fetch 流读取 SSE**，指数退避重连，带 `Last-Event-ID`，收到 `reset` 重新拉 state）；store 的 reducer 保留原型逻辑（safeParse、`invalidEvents` 计数、有界 trace）。
3. 页面：
   - **路由**：组卡片 + 拓扑（实时连线动画）+ 统计 + 最近一个请求的逐步说明 + 组编辑器（zod 校验，字段级错误）；
   - **供应商**：列表、新增 / 编辑（Key 只写，显示 `keyHint`）、测试连接、歇息状态与"恢复"；
   - **用量**：按天 / Agent / 供应商 / 模型，请求数、错误、改道、token、p50/p95；
   - **设置**：端口、数据目录、admin token 重置、定位声明。
4. 状态提示：连接断开时顶部条提示（原型踩过"静默拿旧数据"的坑）；`invalidEvents > 0` 时在设置页显示计数。
5. 无障碍：键盘可达、`prefers-reduced-motion` 关动画、深浅色。
6. 测试：Vitest 测 reducer（喂一串事件断言状态）；Playwright 在 mock 和 live 两种模式下截图。

## 验收

- `pnpm --filter console build` 与 typecheck 0 错误。
- live 模式连真实网关：发 10 个请求（含一次 429 改道），路由页依次显示，`invalidEvents == 0`。
- 断开网关 → 3 秒内顶部出现断线提示；恢复后自动续传。
- 主要页面截图附在 PR。

## 不要做

- 不在前端保存任何 Key（只发给 admin API）。
- 不实现 Agent 配置写入（WP9）。
- 不复制 magpie 的图标、名字、文案。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP8：控制台。只改 apps/console/**。起点是文档包 附录/console-原型/（React 19 + TS 7 + Vite 8 + React Router + Zustand 5 + Zod 4 + Tailwind 4，已能构建）。

1. 迁入原型，把 src/contracts.ts 换成从 @qpa/contracts 导入。用 shadcn CLI v4 生成需要的组件替换原型的 components/ui.tsx，保留现有设计 token（styles.css）。
2. 数据层：api.ts 封装 fetch（Authorization: Bearer 来自 <meta name="qpa-admin-token">，写操作带 If-Match，解析 02-接口契约.md §3.4 的错误格式）；events.ts 用 fetch + ReadableStream 读 /admin/events（不要用 EventSource），断线指数退避重连并带 Last-Event-ID，收到 event: reset 时重新拉 /admin/state。store reducer 保持原型逻辑：每条事件 safeParse，非法计数 invalidEvents。
3. 页面：路由（组卡片、拓扑、统计、最近请求说明、组编辑器字段级校验）、供应商（增改删、Key 只写显示 keyHint、测试连接、恢复歇息）、用量（按天/Agent/供应商/模型）、设置（端口、数据目录、重置 token、定位声明）。Agent 页只保留静态壳。
4. 网关断开时 3 秒内显示顶部提示条；reduced-motion 关闭动画；深浅色都要可用。
5. 测试：Vitest 测 reducer；Playwright 在 mock 与 live 两种模式截图。

约束：前端不持久化任何 Key；不实现 Agent 配置写入；不使用 magpie 的图标和名称。
```
