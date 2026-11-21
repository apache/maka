# WP0 · 契约增量、ADR 与 apps/agent 空壳

**目标**：一次性把所有包共用的东西落地，后续各包只写业务代码。
- ChatRequest 进 zod；
- 三份 ADR；
- `apps/agent` 包与依赖；
- `/healthz`；
- CI 新 job。

**依赖**：无。**分支**：`refactor/wp0-contracts-shell`

## 归属文件

- `packages/shared/src/contracts.ts`、`contracts.test.ts`
- `apps/api/app/schemas.py`、`apps/api/tests/test_contracts.py`
- `fixtures/contract-example.json`（只追加）
- `docs/adr/0003-*.md`、`0004-*.md`、`0005-*.md`（从本包 ADR草案 复制）
- `apps/agent/package.json`、`tsconfig.json`、`src/server.ts`（只有 healthz）、`src/server.test.ts`（1 个用例）
- 根 `package.json`（加 `test:agent`）、`pnpm-lock.yaml`、`.github/workflows/ci.yml`

## 步骤

1. 契约：按 02 §1 加 `ChatRequest`。`schemas.py` 加 `threadId: str | None = None`。fixture 追加 `chatRequest`。两端各加一个对账用例。
2. `apps/agent/package.json`：
   ```json
   { "name": "@agent-hub/agent", "private": true, "type": "module",
     "scripts": { "dev": "node --watch src/server.ts", "start": "node src/server.ts",
                  "test": "node --test src/ test/", "typecheck": "tsc --noEmit -p ." },
     "dependencies": { "@agent-hub/shared": "workspace:*", "langchain": "~1.5.18", "@langchain/core": "~1.2.18",
                       "@langchain/langgraph": "~1.5.1", "@langchain/openai": "~1.6.2", "zod": "^4.5.4" },
     "devDependencies": { "typescript": "~7.0.2", "@types/node": "^24" } }
   ```
3. `tsconfig.json`：
   - `module/moduleResolution: nodenext`
   - `allowImportingTsExtensions`、`noEmit`、`erasableSyntaxOnly`、`verbatimModuleSyntax`
   - `strict`、`skipLibCheck`
4. `server.ts`：`node:http` 监听 `AGENT_PORT ?? 8809`，`GET /healthz → ok`，其余 404。用 `if (import.meta.main)` 启动，导出 `startServer(port)` 供测试使用（端口传 0）。
5. 根 `package.json` 加 `"test:agent": "pnpm --filter @agent-hub/agent test"`、`"agent": "pnpm --filter @agent-hub/agent start"`。
6. CI：新增 job `agent`（setup-node 24 → `pnpm install --frozen-lockfile` → `pnpm --filter @agent-hub/agent typecheck` → `pnpm test:agent`）。
7. 验证 05 U4：typecheck 能否通过 langchain 的类型。不通过时在 PR 中说明报错，并按 05 U4 的回退执行。

## 验收

- `pnpm build && pnpm test:shared && pnpm test:api && pnpm test:agent` 全绿。
- `node apps/agent/src/server.ts` 后 `curl localhost:8809/healthz` 返回 `ok`。
- 前端、Vite 代理、E2E 都没有改动，且仍然全绿。

## 不要做

- 不写任何智能体逻辑；不改 Vite 代理；不改 `AgentStreamEvent`。

## Cursor 提示词

```text
仓库 agent-hub，分支 refactor/wp0-contracts-shell（从 main 拉）。
目标：为 langchain.js 智能体服务铺底：契约增量 + ADR + apps/agent 空壳 + CI。不写智能体逻辑。
先读：AGENTS.md、附带的 02-接口契约.md、ADR草案/*.md、工作包/WP0。
步骤：
1. packages/shared/src/contracts.ts 新增 ChatRequest = z.object({ message: z.string().trim().min(1).max(2000), threadId: z.string().min(8).max(64).optional() }) 并从 index.ts 导出；apps/api/app/schemas.py 的 ChatRequest 加 threadId: str | None = None；fixtures/contract-example.json 只追加 chatRequest 样例 {"message":"想给妈妈送生日礼物","threadId":"t-0123456789"}；contracts.test.ts 和 test_contracts.py 各加一个对账用例。AgentStreamEvent 一个字段都不许改。
2. 把 ADR草案 里的三份复制为 docs/adr/0003-langchainjs-agent-service.md、0004-a2ui-as-tool.md、0005-conversation-memory.md，状态改为"已接受"，日期填今天。
3. 新建 apps/agent：package.json 按 WP0 文档（依赖版本用 ~ 锁小版本），tsconfig.json（nodenext、allowImportingTsExtensions、noEmit、erasableSyntaxOnly、verbatimModuleSyntax、strict、skipLibCheck），src/server.ts 用 node:http 实现 GET /healthz，导出 startServer(port)，import.meta.main 时启动；src/server.test.ts 用 node:test 起 port 0 断言 /healthz=ok、未知路径 404。
4. 根 package.json 加 test:agent 和 agent 两个 script；.github/workflows/ci.yml 新增 agent job（typecheck + test:agent）。
5. 跑 pnpm --filter @agent-hub/agent typecheck，若 langchain 类型报错，记录报错原文，不要关 strict。
硬约束：Node 24 直接跑 .ts（不写参数属性、enum、namespace，import 带 .ts 后缀）；不引测试框架；不改前端和 Vite 代理；DoD：pnpm build && pnpm test:shared && pnpm test:api && pnpm test:agent 全绿。
完成后输出：改动文件、测试结果、typecheck 结论。
```
