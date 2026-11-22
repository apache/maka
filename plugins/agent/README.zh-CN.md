<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Agent 插件域

[English](README.md)

`plugins/agent/` 实现 Maka 的会话引擎、模型协议栈、多方协作 Room、工具编排以及外部 Agent CLI 接入。内部按严格的单向 crate 依赖分层，确保持久化事实、确定性状态机与底层系统句柄互不耦合：

| 层级 | Crates | 职责 |
| --- | --- | --- |
| 纯数据与契约 | [`facts/`](facts/src/lib.rs)、[`api/`](api/src/lib.rs)、[`ports/`](ports/src/lib.rs) | 持久化事实结构、对外 RPC/工具协议契约（`schemars`）与抽象执行接口 |
| 存储与状态折叠 | [`state/`](state/src/lib.rs) | `RootStore` 上的 SQLite 迁移、原子事实写入、历史快照、FTS/Recall 索引与同事务确定性状态投影 |
| 执行循环与沙箱单元 | [`engine/`](engine/src/lib.rs)、[`tools/`](tools/src/lib.rs)、[`tool-catalog/`](tool-catalog/src/lib.rs) | 基于义务前沿（Obligation Frontier）的调谐驱动、上下文压缩，以及 V8/Python Code Mode 执行单元 |
| 模型协议与 MCP | [`provider-protocol/`](provider-protocol/src/lib.rs)、[`model/`](model/src/lib.rs)、[`providers/`](providers/src/lib.rs)、[`mcp/`](mcp/src/lib.rs) | 纯 Rust 实现的 OpenAI Responses / Chat Completions / Anthropic Messages 协议栈、OAuth/API Key 提供商，以及基于 `rmcp` 的 stdio / Streamable HTTP 客户端 |
| 扩展能力模块 | [`assistant/`](assistant/src/lib.rs)、[`goal/`](goal/src/lib.rs)、[`scheduler/`](scheduler/engine/src/lib.rs)、[`session-title/`](session-title/src/lib.rs)、[`session-recap/`](session-recap/src/lib.rs)、[`session-import/`](session-import/src/lib.rs)、[`insights/`](insights/src/lib.rs)、[`acp-executor/`](acp-executor/native/src/lib.rs) | 系统提示词与 Recall 检索、持久 Goal 循环、定时任务、自动标题、会话回顾/导入、统计分析与独立 ACP 执行器 |
| 原生运行时宿主 | [`authority/`](authority/src/lib.rs)、[`native/`](native/src/lib.rs) | 活跃实例租约、工作区权限求交、RPC 服务路由、`Session*` 工具实现以及内置外部 CLI 驱动 |

## 会话、Room 与协同工具

前端工作台直接消费 [`maka-agent-api`](api/src/contract.rs) 的细粒度 RPC（`observe`、`history`、`watch`、`create`、`send`、`fork` 等）；面向模型的协同能力则收敛为 `Read` 加 7 个与人类操作对称的 `Session*` 工具：

- **`Read("maka://session/<id>")`** — 直接把任意可读会话或 Room 渲染为精炼的 Markdown 对话摘要（跨页翻阅自动锚定同一 `through` 水位线），工具大输出按需通过 `maka://session/<id>/tool-results/<event-id>` 无损调阅。
- **`SessionList` / `SessionRead`** — 检索会话，或单次读取会话元数据、当前/最近一次 `RunId` 状态、阻塞原因、待处理审批、排队消息与分页历史。
- **`SessionCreate`** — 创建 Agent 会话或共享 Room（`kind: "room"`），支持 `forkFrom` 分支、托管 Git `worktree` 隔离或直接套用子 Agent 预设 `presetId`。
- **`SessionSend`** — 向 Room 发言（原子提交 `@mentions` 与 `replyTo`）或向 Agent 会话发消息/插话引导（Steer）。Agent 派发给子会话的消息默认开启 `onComplete: "notify_caller"`，完工后自动携带 `<worker_result>` 结论摘要唤醒调用方。
- **`SessionRespond` / `SessionStop` / `SessionManage`** — 回复子会话提问与权限请求、终止运行、编辑待发队列、续跑已结束的原生模型轮次，以及改名/归档/恢复/删除会话。

## 记忆记录（Memory）

用户可控的记忆接口（[`api/src/contract/memory.rs`](api/src/contract/memory.rs) 中的 `memories`、`memory`、`memoryHistory`、`changeMemory`、`memorySource` 与 `memoryEvidence`）在个人或项目作用域内管理持久化记忆。更新采用版本 CAS；抑制（Suppress）记录会将其从常规读取与历史展示中隐藏，同时保留底层审计记录。模型侧读取需同时具备有效执行权限并开启偏好设置中的 `memory.enabled` 与 `memory.agentReadEnabled`（关闭模型读取不影响用户管理）。客户端可通过 `changeMemory.add_evidence` 为断言绑定经校验的会话原文片段；会话创建参数 `create.incognito` 则声明由派生会话继承的不可变记忆隐私边界。

## 主动发现

启用 Bot 和定时任务后，Bot 可以提议发现计划。新计划默认只读，用户批准工作区、模型和所选工具。Host 按绑定的服务或内置工具的用途确定类别，新建调查会话只获得当前工具上限内已批准的具体工具。

一次调查从启动到执行清理期间占用同一个执行位。worker 用 `UpsertDossier` 分别更新各条主线，用 `FinishNoChange` 结束调查。档案版本和关联的一次性提醒在同一事务中更新。`DiscoveryComplete` 的报告也保存为档案。桌面订阅仅在全局通知开启、主线未静音时接收打扰事件，同一版本只打扰一次。Bot 应用户询问，用 `ListDossiers` 和 `ReadDossier` 读取档案。历史调查记录与原始运行回执仍可通过调度器查阅。

参见[产品指南](../../products/maka/README.zh-CN.md#主动发现)、[调度契约](api/src/contract/scheduler.rs)和 [Host 测试](native/src/owner/driver/tests/model_recovery/discovery.rs)。

## 子 Agent 预设（Subagent Presets）

可复用的子 Agent 角色定义在 [`api/src/preset.rs`](api/src/preset.rs)（对模型暴露为 `SubagentPresetList/Read/Create/Update/Delete`），持久化角色名、用途描述、专属指令、目标模型与思考强度。修改与删除通过 `expectedRevision` 做并发保护并走 Host 操作日志原子提交；在 `SessionCreate` 传入 `presetId` 即可按预设拉起子会话。

## MCP 服务接入

`maka-agent-mcp` 基于 `rmcp` 连接本地 stdio 与远端 Streamable HTTP MCP 服务，发现的工具统一接入直接调用、`tool_search` 以及 JS/Python Code Mode，并复用同一套审批与操作回执链路。可在 **Settings → MCP servers**（或项目目录及主目录下的 `.maka/mcp.json` / `.agents/mcp.json`）管理配置；ACP 客户端也可在加载会话时挂载当前会话生命周期内的临时 MCP 服务。

已配置的 MCP 服务属于受信任扩展：stdio 进程以当前系统用户身份运行在会话文件沙箱之外，仅注入精简基础环境变量与显式配置的密钥。

## 内置外部 CLI 执行器

在 `agent.external.runtimes` 中启用 `claude`、`codex` 或 `antigravity` 后，会话可直接在项目工作区内驱动本机已安装的原厂 CLI（Claude Code 走交互式 PTY、Codex 走托管 `app-server`、Antigravity 走 ACP），同时完整接入 Maka 的持久化历史、Host MCP 工具桥、可编辑消息队列与运行中插话（Steer）：

- **保留原厂系统提示词与缓存前缀** — 外部 CLI 始终保留各自原厂系统提示词；Maka 将 `<maka_system_instructions>` 作为独立普通消息在摘要变化时同步一次，后台唤醒轮次自动继承既有指令摘要，绝不来回抖动破坏前缀缓存。
- **严格结算边界** — 子进程由 `TaskOwner` 托管；单纯的进程退出、静默或 EOF 不会当作执行成功，未确认结果的异常中断也绝不触发盲目重放。
