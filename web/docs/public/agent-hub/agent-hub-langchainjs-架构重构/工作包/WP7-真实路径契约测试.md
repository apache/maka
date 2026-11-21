# WP7 · 真实路径契约测试（ChatOpenAI × 假 OpenAI SSE 上游）

**目标**：不需要 key，就能在 CI 里测到"真实模型路径"：ChatOpenAI → langchain → 翻译层 → 事件。覆盖上游的各种异常。这补上了 A-P1-3 的另一半——E2E 只测 mock。

**依赖**：WP4（用 `startServer` 做端到端）。**分支**：`test/wp7-real-path`。**参考**：`附录/技术验证/spike3-ChatOpenAI假上游.mts`

## 归属文件

`apps/agent/test/fake-openai.ts`、`apps/agent/test/real-path.test.ts`，以及在这些测试暴露问题时对 `translate.ts` 的最小修复

## 步骤

1. `fake-openai.ts`：用 `node:http` 实现 `/v1/chat/completions`，按"剧本"逐帧回放 `data: {...}\n\n`，最后 `data: [DONE]`。可配置的行为：
   - 正常：先 `delta.reasoning_content`，再 `delta.content`；
   - 工具调用：`delta.tool_calls` 分 3 片（id/name 在首片，arguments 分两片），`finish_reason:'tool_calls'`；
   - 首帧 `choices: []`（usage 帧）；
   - HTTP 500 `{error:{message:'boom sk-test'}}`；
   - 发到一半 `socket.destroy()`；
   - 根据请求里 messages 的内容决定下一轮回放，模拟完整的工具循环：检索 → 目录 → 展示 → 作答。
2. `real-path.test.ts`：`createChatModel({ OPENAI_API_KEY:'test', OPENAI_BASE_URL: fake.url })` → `buildAgent` → `runTurn`，每种情况断言：
   - `assertSequence` 通过；
   - 完整循环得到 card + evidence + token，且 card 商品来自目录；
   - 500 → `error{server}`，message 不含 `sk-test`；
   - 断流 → `error{server}`，没有 done；
   - reasoning → thought。
3. 再通过 `startServer` 用 fetch 做一次 SSE 端到端，验证帧格式。
4. 调整 05 U1：录一段"长开场白 + 工具调用"的回放，确认扣留策略。若不满足就按 05 U1 改，并写进 PR。

## 验收

- `pnpm test:agent` 全绿，且全程无外网访问（CI 环境不配 key）。

## 不要做

- 不调真实厂商；不引 HTTP mock 库（nock、msw 等）。

## Cursor 提示词

```text
仓库 agent-hub，分支 test/wp7-real-path（从已合并 WP4 的 main 拉）。
目标：不需要 key 的真实路径契约测试：ChatOpenAI 指向本地假 OpenAI SSE 服务，验证 langchain → translate → AgentStreamEvent 全链路。
先读：02-接口契约.md §2 §5、工作包/WP7、附录/技术验证/spike3-ChatOpenAI假上游.mts 与 spike3-output.txt。
步骤：
1. apps/agent/test/fake-openai.ts：node:http 实现 /v1/chat/completions 流式回放，支持：reasoning_content + content；tool_calls 分 3 片 + finish_reason tool_calls；首帧 choices:[]；HTTP 500（body 含 sk-test）；中途 socket.destroy()；按请求 messages 决定下一轮，模拟 检索→目录→展示→作答 的完整循环。
2. apps/agent/test/real-path.test.ts：createChatModel({OPENAI_API_KEY:'test', OPENAI_BASE_URL: fake.url}) → buildAgent → runTurn，逐场景断言 assertSequence、完整循环有 card+evidence+token 且商品来自 CATALOG、500→error{server} 且不含 sk-test、断流→error 无 done、reasoning→thought；再用 startServer + fetch 跑一次 SSE 端到端。
3. 增加"长开场白+工具调用"回放，检查 PREAMBLE 扣留策略；若暴露问题，只对 translate.ts 做最小修复并补用例。
硬约束：无外网；不引 mock 库与测试框架；只改归属文件（translate.ts 仅限最小修复）；pnpm test:agent 全绿。
完成后输出：改动文件、各场景事件序列摘要、发现的问题与修复。
```
