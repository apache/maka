# WP9 · 收尾：删除 Python 智能体代码、去掉开关、更新文档

**目标**：迁移完成。FastAPI 只剩任务、订单、支付、场景；契约镜像只保留这些仍被 Python 使用的部分。

**依赖**：WP5、WP7 合并，且 04 §6 人工验收全部打勾。**分支**：`refactor/wp9-cleanup`

## 归属文件

- 删除：`apps/api/app/agent.py`、`llm.py`、`evidence.py`、`apps/api/tests/test_agent_sse.py`、`test_llm.py`，以及 `apps/api/app/sse.py`（若再无引用）
- `apps/api/app/main.py`：删 `/api/agent/chat`、`/api/evidence/{id}` 路由
- `apps/api/app/schemas.py`：删事件与卡片镜像（ThoughtEvent…ErrorEvent、FlowerCardPayload、Evidence、ChatRequest），保留任务和订单
- `apps/api/tests/test_contracts.py`：只对账保留的部分；`fixtures/contract-example.json` 不删字段（只追加原则），在 README 注明哪些段只由 TS 校验
- `apps/web/vite.config.ts`、`scripts/demo.mjs`、`ci.yml`：去掉 `AGENT_BACKEND` 与 py 回退
- `apps/agent/test/parity.test.ts`：删除
- `README.md`、`CONTEXT.md`、`AGENTS.md`、`CLAUDE.md`：架构图、端口、命令、"契约变更同步"规则改为 contracts.ts（+ 仍有镜像时的 schemas.py）

## 步骤

1. `rg "agent\.|llm\.|get_evidence|script_stream" apps/api` 确认无残留引用。
2. 删代码 → 跑 `pnpm test:api`（测试数从 29 降到约 21，是预期）。
3. 文档：
   - AGENTS.md 的 DoD 加 `pnpm test:agent`；
   - 新增"智能体改动规则"：工具只在 tools.ts、createAgent 只在 agent.ts、出站事件只在 translate.ts。
4. CI：e2e 只跑一遍。

## 验收

- DoD 全绿；`rg -n "AGENT_BACKEND" .` 无结果（除 CHANGELOG）。
- 新同学按 README 从零启动，能跑通 3 个场景和多轮对话。

## Cursor 提示词

```text
仓库 agent-hub，分支 refactor/wp9-cleanup（从已合并 WP5、WP7 的 main 拉）。
目标：迁移收尾。删除 Python 智能体代码与 AGENT_BACKEND 回退开关，更新文档与 CI。
先读：工作包/WP9、03-并行开发计划.md 文件归属矩阵、README.md、CONTEXT.md、AGENTS.md。
步骤：
1. rg 确认 apps/api 内对 agent.py、llm.py、evidence.py、sse.py 的引用，只剩 main.py 的两个路由。
2. 删除上述模块及 test_agent_sse.py、test_llm.py；main.py 删 /api/agent/chat 与 /api/evidence/{id}；schemas.py 删事件/卡片/证据/ChatRequest 镜像，保留任务与订单；test_contracts.py 只对账保留部分；fixture 不删字段。
3. vite.config.ts、scripts/demo.mjs、ci.yml 去掉 AGENT_BACKEND 与 py 回退；删除 apps/agent/test/parity.test.ts。
4. README/CONTEXT/AGENTS：更新架构图（web→agent:8809 / api:8808）、命令、DoD（加 pnpm test:agent）、智能体改动规则（工具只在 tools.ts、createAgent 只在 agent.ts、出站事件只在 translate.ts）。
硬约束：不改 apps/agent 业务代码；不改前端协议；DoD：pnpm build && pnpm test:shared && pnpm test:api && pnpm test:agent && pnpm test:e2e 全绿。
完成后输出：删除与修改清单、测试数量变化、rg AGENT_BACKEND 结果。
```
