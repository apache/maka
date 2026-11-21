# WP4 · langchain 契约测试（Q3 / Q4）

- **目标**：用 langchain.js 作为"最挑剔的客户端"验收 P0：standard-tests 风格用例 + 两轮工具往返 smoke。
- **依赖**：WP1、WP2、WP3 已合并
- **分支**：`feat/wp4-langchain-contract`
- **归属文件**：`apps/gateway/test/standard/**`（独立 package.json，devDependencies）、`examples/langchain-smoke/**`、CI workflow 中新增的 job

## 步骤

1. `test/standard/` 新建独立包（不污染 gateway 的依赖）：`@langchain/core`、`@langchain/openai`、`@langchain/anthropic`、`langchain`（devDependencies）。
2. 测试夹具：起网关 + 脚本化假 provider（复用 gateway 的 test helpers），不依赖真实上游。
3. 移植约 15 个用例（参照 langchainjs `libs/langchain-standard-tests` 的 ChatModelIntegrationTests 思路）：
   - invoke / stream 文本；stop reason；usage 元数据；
   - `bindTools` 单工具 / 多工具 / 并行工具调用；工具结果回填后第二轮；
   - 空 content 的 assistant 工具调用轮作为历史；
   - 图片输入；thinking（Anthropic）与 reasoning（Responses）；
   - 中止信号；上游 429 时 langchain 收到可识别的 429 错误。
   每个用例在 `ChatOpenAI`（Chat）、`ChatOpenAI({ useResponsesApi: true })`、`ChatAnthropic` 三种客户端下跑。
4. `examples/langchain-smoke`：`createAgent` + 一个计算工具，两轮工具往返，经直连和 `group/<id>`（WP6 合并前只跑直连）。

## 验收

- 在 WP1–WP3 合并前的 commit 上跑，至少工具往返类用例是红的（证明测试有效，PR 里贴截图或日志）。
- 当前 main 上全绿。
- gateway 包的 `dependencies` 仍为空。

## 不要做

- 不要为了让测试过而改网关代码——发现问题开 issue 给对应 WP。
- 不要依赖真实供应商 Key。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP4：langchain 契约测试。只新增 apps/gateway/test/standard/**（独立 package.json，只用 devDependencies：@langchain/core、@langchain/openai、@langchain/anthropic、langchain）和 examples/langchain-smoke/**，以及 CI 里一个新 job。

用网关现有的测试辅助起服务，配脚本化的假 provider，不要连真实上游。
参照 langchainjs 的 standard-tests（ChatModelIntegrationTests）写约 15 个用例：文本 invoke/stream、stop reason、usage、bindTools 单/多/并行工具、工具结果回填第二轮、空 content 的工具调用轮作为历史、图片输入、thinking/reasoning、abort、上游 429。每个用例分别用 ChatOpenAI、ChatOpenAI({ useResponsesApi: true })、ChatAnthropic 跑。
examples/langchain-smoke 用 createAgent + 一个加法工具跑两轮工具往返。

验证测试有效性：在 WP1 合并之前的 commit 上跑一次，确认工具类用例失败，把输出贴进 PR。
约束：不要修改 apps/gateway/src 下任何文件；发现网关缺陷就记录下来，不在本 PR 修。
```
