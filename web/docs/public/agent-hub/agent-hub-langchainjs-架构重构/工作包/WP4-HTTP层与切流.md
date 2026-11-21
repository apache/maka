# WP4 · HTTP 层与切流（E2E 绿是门槛）

**目标**：`apps/agent` 对外提供 `/api/agent/chat`（SSE）与 `/api/evidence/:id`；Vite 代理分流；demo 启动 3 个进程；现有 3 条 E2E 在 ts 后端上不改即绿，`AGENT_BACKEND=py` 回退也绿。

**依赖**：WP3。**分支**：`refactor/wp4-http-cutover`。**参考实现**：`附录/代码骨架/server.ts`（curl 验证过）

## 归属文件

`apps/agent/src/server.ts`、`server.test.ts`、`apps/web/vite.config.ts`、`scripts/demo.mjs`、`playwright.config.ts`、`.github/workflows/ci.yml`（e2e job）、根 `package.json`（只改 `demo`）

## 步骤

1. 先写 `server.test.ts` 的 4 个用例（04 §2 WP4），确认红。
2. `server.ts`：
   - 按 02 §4 实现：请求体 `ChatRequest.safeParse` → 422；
   - 写帧 `event: ${type}\ndata: ${JSON.stringify(e)}\n\n`；
   - `res.on('close')` 且 `!res.writableFinished` 时 abort；
   - 没有 `OPENAI_API_KEY` 用 `ScriptedChatModel(floraPolicy, {delayMs: 40})`，有就用 `createChatModel()`；
   - 启动时 `try { process.loadEnvFile() } catch {}`，读仓库根 `.env`；路径与 `llm.py` 的 `load_env` 保持一致。
3. `vite.config.ts`：
   ```ts
   const agentTarget = process.env.AGENT_BACKEND === 'py' ? 'http://127.0.0.1:8808' : 'http://127.0.0.1:8809';
   proxy: {
     '/api/agent':    { target: agentTarget, changeOrigin: true },
     '/api/evidence': { target: agentTarget, changeOrigin: true },
     '/api':          { target: 'http://127.0.0.1:8808', changeOrigin: true },
   }
   ```
   具体前缀要写在 `/api` 之前。
4. `demo.mjs`：`AGENT_BACKEND !== 'py'` 时多启动一个 `start('agent', process.execPath, [resolve(ROOT,'apps/agent/src/server.ts')], ROOT)`。参数数组、`shell:false`，Windows 同样适用。
5. `playwright.config.ts`：webServer 等待 `http://localhost:8888`，以及 ts 模式下的 `http://127.0.0.1:8809/healthz`（`webServer` 支持数组或在 demo 内等待健康检查，二选一）。
6. CI e2e job 跑两遍：默认（ts）与 `AGENT_BACKEND=py`。

## 验收

- `pnpm test:agent` 全绿；`pnpm test:e2e` 与 `AGENT_BACKEND=py pnpm test:e2e` 都全绿，`e2e/agent-hub.spec.ts` 一行未改。
- 浏览器里点"停止"后，agent 日志中不再出现后续模型调用。
- 04 §6 的真实模型人工验收至少做一次 deepseek，结果贴到 PR。

## 不要做

- 不改前端组件和 store（threadId 是 WP5）；不删 Python 代码（WP9）。

## Cursor 提示词

```text
仓库 agent-hub，分支 refactor/wp4-http-cutover（从已合并 WP3 的 main 拉）。
目标：apps/agent 提供 POST /api/agent/chat（SSE）与 GET /api/evidence/:id，Vite 代理分流，demo 启动三进程；现有 E2E 不改即绿，AGENT_BACKEND=py 可回退。
先读：02-接口契约.md §4–6、01-目标架构.md §1、工作包/WP4、scripts/demo.mjs、apps/web/vite.config.ts、playwright.config.ts；参考实现 附录/代码骨架/server.ts。
步骤：
1. 先写 src/server.test.ts（startServer(0)）：每帧匹配 /^event: (\w+)\ndata: [^\n]+\n\n$/ 且 event 名=data.type；{} 与超长 message → 422；/api/evidence/ev-purchase-01 → 200、/api/evidence/nope → 404 {detail:"evidence not found"}；读到第一帧后断开连接 → ScriptedChatModel 的调用计数不再增长。先确认失败。
2. 实现 server.ts（node:http；ChatRequest.safeParse；SSE 头 no-cache + x-accel-buffering:no；res.on('close') 未写完则 abort；无 OPENAI_API_KEY 用 ScriptedChatModel(floraPolicy,{delayMs:40})，否则 createChatModel()；启动时 process.loadEnvFile 读 .env，失败忽略）。
3. vite.config.ts：/api/agent 与 /api/evidence 指向 AGENT_BACKEND==='py' ? 8808 : 8809，其余 /api 仍到 8808，具体前缀放前面。
4. scripts/demo.mjs：非 py 模式多启动 agent 进程（process.execPath + 参数数组，shell:false），沿用任一退出全部拉停。
5. playwright.config.ts 确保 agent 健康后才开始测试；CI e2e job 跑 ts 与 py 两遍。
硬约束：e2e/agent-hub.spec.ts 不改；前端组件与 store 不改；不加依赖；只改归属文件；DoD：pnpm build && pnpm test:shared && pnpm test:api && pnpm test:agent && pnpm test:e2e，以及 AGENT_BACKEND=py pnpm test:e2e 全绿。
完成后输出：改动文件、两种模式的 E2E 结果、真实模型手测记录（若有 key）。
```
