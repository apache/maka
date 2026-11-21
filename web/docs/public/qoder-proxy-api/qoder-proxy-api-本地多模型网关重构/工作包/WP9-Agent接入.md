# WP9 · Agent 接入：配置写入器 + Agent 页 + 方案

- **目标**：Claude Code、Codex、OpenCode 一键接入 / 换模型 / 断开，带备份、dry-run diff 和逐字节恢复；方案（多个 Agent 的模型分配快照）。
- **依赖**：WP7、WP8
- **分支**：`feat/wp9-agents`
- **归属文件**：`apps/gateway/src/agents/**`（新增）、`src/admin/routes.ts` 中 agents / plans 端点、`apps/console/src/pages/AgentPage.tsx` 及相关、`test/agents/**`

## 步骤

1. **先验证字段（05 R4）**：在临时 HOME 下安装三个 CLI 的当前版本，按 02 §6 写配置，各跑一次真实请求到网关，记录 CLI 版本和结果到 `docs/agents.md`。字段不对就先改 02 §6（契约 PR）。
2. 写入器接口：
   ```ts
   interface AgentWriter {
     id: "claude-code" | "codex" | "opencode";
     locate(home: string): { configPath: string; installed: boolean };
     plan(current: string | null, intent: { baseUrl; key; model } | null): { next: string | null; diff: string };
   }
   ```
   `plan` 是纯函数（`null` 表示删除文件），便于测试；读写和备份由公共的 `apply()` 完成。
3. JSON（Claude Code、OpenCode）：保留缩进与键顺序，只改我们的路径。TOML（Codex）：行级编辑，只动顶层 `model` / `model_provider` 和 `[model_providers.qoder-proxy]` 表，保留注释。
4. 备份与三方比对（02 §6 规则 2、3）；`drift` 时只删我们的键。
5. Agent Key：接入时生成 `qpa-<agent>-<随机>`，写 `secrets.json`；Codex 走 `QPA_CODEX_KEY` 环境变量，界面给出 export 命令。
6. 方案：保存 / 应用 / 删除；应用 = 对每个已接入 Agent 调用"只换模型"。
7. Agent 页：接原型交互（模型选择、开关 → dry-run diff 弹窗 → 确认写入；断开 → 恢复预览；"显示其余 N 个"列出暂不支持的 Agent）。

## 验收

- I7：三个 Agent × {原文件存在、原文件不存在、接入后用户手改} = 9 个用例，全部在临时 HOME 下跑；前两种断开后 sha256 与原文件一致，第三种只删除我们的键且用户改动保留。
- TOML 注释、JSON 键顺序在接入前后保持。
- 真实 CLI 验证记录（版本号 + 结果）附在 PR。

## 不要做

- 不支持三个以外的 Agent（ADR-0009）。
- 不写任何不属于我们的键；不改文件权限。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP9：Agent 接入。只改 apps/gateway/src/agents/**（新增）、apps/gateway/src/admin/routes.ts 中 agents 和 plans 端点、apps/console/src/pages/AgentPage.tsx 及其依赖、apps/gateway/test/agents/**、docs/agents.md。

第一步先验证：在临时 HOME 下用 Claude Code、Codex、OpenCode 的当前版本，按 文档包 02-接口契约.md §6 的字段写配置，各发一次真实请求到本地网关，把 CLI 版本和结果记到 docs/agents.md。字段有误就停下来报告，不要猜。

实现 AgentWriter（locate + 纯函数 plan(current, intent) 返回 next 文本和 diff）与公共 apply()（备份到 ~/.qoder-proxy-api/backups/<agent>/<时间戳>.orig，记录原文件和写入后的 sha256）。
JSON 保留缩进和键顺序；Codex 的 TOML 用行级编辑，只动顶层 model、model_provider 和 [model_providers.qoder-proxy] 表，保留注释。Codex 的 Key 用 env_key = "QPA_CODEX_KEY"，不写进文件。
断开：当前文件 sha256 等于写入后 sha256 → 逐字节恢复备份（或删除原本不存在的文件）；否则只删我们的键并返回 drift: true。
connect/disconnect 支持 dryRun 返回 diff。实现方案（plans）保存/应用/删除。
Agent 页接上真实 API：开关先请求 dryRun 展示 diff，确认后写入。

测试：三个 Agent × {原文件存在, 不存在, 接入后用户手改} 共 9 例，全部在临时目录里跑，断言 sha256 / 键保留。
约束：只支持这三个 Agent；不写不属于我们的键；不改文件权限。
```
