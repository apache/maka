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

# Maka 核心技术解读

> Archived on 2026-07-13. Current backend guidance lives in `ARCHITECTURE.md`, its architecture chapters, source, and tests.

> 一份面向工程师的 Maka 技术栈通读笔记。覆盖 runtime 内核、权限系统、持久化与恢复、Electron 集成。
> 生成日期：2026-06-25

## 目录

- [整体定位](#整体定位)
- [仓库分层](#仓库分层)
- [Runtime 内核架构](#runtime-内核架构)
  - [SessionManager：公共 runtime API](#sessionmanager公共-runtime-api)
  - [AgentRun：单 turn 的 durable 编排](#agentrun单-turn-的-durable-编排)
  - [AiSdkBackend：流式 + 多步工具循环](#aisdkbackend流式--多步工具循环)
  - [ToolRuntime：权限门控 seam](#toolruntime权限门控-seam)
  - [ModelAdapter：provider 归一化](#modeladapterprovider-归一化)
  - [RunTrace：best-effort 诊断](#runtracebest-effort-诊断)
- [权限系统](#权限系统)
  - [四档 PermissionMode](#四档-permissionmode)
  - [12 类 ToolCategory](#12-类-toolcategory)
  - [mode × category 策略矩阵](#mode--category-策略矩阵)
  - [纯函数原则](#纯函数原则)
  - [parked Promise 机制](#parked-promise-机制)
- [持久化与恢复](#持久化与恢复)
  - [文件布局](#文件布局)
  - [AgentRun ledger](#agentrun-ledger)
  - [启动恢复](#启动恢复)
- [Electron 集成层](#electron-集成层)
  - [进程边界](#进程边界)
  - [密钥安全边界](#密钥安全边界)
  - [多入口](#多入口)
- [数据流：一次对话的完整路径](#数据流一次对话的完整路径)
- [技术亮点小结](#技术亮点小结)

---

## 整体定位

Maka 是一个**本地优先（local-first）的 Electron 桌面 AI agent 工作台**。一句话概括它的技术追求：让用户在自己的电脑上跑一个**可观察、可控、可恢复**的 agent——所有数据本地落盘，敏感值按各自边界保存在本地，工具调用走权限策略，单次对话崩溃后能从 ledger 恢复。

## 仓库分层

monorepo 用 npm workspaces，分层干净：

- `packages/core`：纯契约层，零运行时依赖，只定义类型和纯函数。
- `packages/storage`：文件持久化层。
- `packages/runtime`：内核实现，最核心的部分。
- `packages/ui`：共享渲染组件。
- `apps/desktop`：Electron 壳子，把 runtime 装进窗口。

**核心设计原则**：契约与实现分离，runtime 内核再拆成可独立理解的边界，公共 API 保持稳定的同时内部可演化。

---

## Runtime 内核架构

这是整个项目最值钱的部分。分层关系：

```
SessionManager            ← 对外公共 API（桌面 / bot / gateway 都走它）
  -> AgentRun             ← 单次 turn 的生命周期 + 启动恢复
      -> AiSdkBackend     ← 流式 + 工具循环引擎
          -> ModelAdapter ← provider stream / usage / error 归一化
          -> ToolRuntime  ← 工具输入校验 / 权限 / watchdog / abort / telemetry
      -> RunTrace         ← best-effort 诊断 trace，写失败不影响对话
      -> AgentRunStore    ← durable run ledger
```

关键代码入口：

| 模块 | 文件 |
| --- | --- |
| `SessionManager` 类 | `packages/runtime/src/session-manager.ts:232` |
| `AgentRun.execute()` | `packages/runtime/src/agent-run.ts` |
| `send()` 流式泵 | `packages/runtime/src/ai-sdk-backend.ts:435` |
| `wrapToolExecute` 权限门控 | `packages/runtime/src/tool-runtime.ts:146` |
| provider 适配 | `packages/runtime/src/model-adapter.ts` |

### SessionManager：公共 runtime API

对外（桌面 IPC、bot adapter、open-gateway 三类入口）暴露的唯一 runtime 门面。职责：

- session CRUD
- backend registry 编排
- active run 查找
- 恢复入口

真正干活的 turn 生命周期被委派给 `AgentRun`。

### AgentRun：单 turn 的 durable 编排

理解恢复机制的关键。一次 `sendMessage` 会创建一个 `AgentRun`，它负责：

1. 生成 runId，写 `run_created` 事件到 ledger。
2. 追加用户消息、写初始 turn 状态。
3. 锁定连接快照（`connectionLocked`），防止 turn 跑到一半连接被改。
4. 构建 prior runtime context（从历史 run 的 `RuntimeEvent` 投影成模型历史）。
5. 驱动 backend 流事件，投影 session 状态。
6. 写 turn 完成 / 失败 / abort / permission-wait 状态。
7. `finalize()` 收尾：注销 active run、更新 header、写 `run_completed / run_failed / run_cancelled`。

`execute()` 是 async generator，核心结构简洁：

```ts
async *execute(): AsyncIterable<SessionEvent> {
  try {
    const begin = await this.begin();
    for await (const ev of begin.backend.send(begin.backendInput)) {
      await this.recordSessionEvent(ev);
      yield ev;
    }
  } catch (error) {
    await this.recordFailure(error);
    throw error;
  } finally {
    await this.finalize();
  }
}
```

每个 backend 事件都会被 `recordSessionEvent` 投影成 session 状态变更（running / blocked / aborted），并记录到 run ledger。即使进程崩了，重启时也能从 ledger 重建。

### AiSdkBackend：流式 + 多步工具循环

agent loop 的引擎。用 Vercel AI SDK 的 `streamText` 配合 `stopWhen: stepCountIs(N)` 驱动多步工具调用循环——循环本身交给 AI SDK，但所有"自己的机器"（权限、持久化、materializer、watchdog）都保留在 Maka 这边。

`send()` 结构（`ai-sdk-backend.ts:435`）：

1. 建 `AsyncEventQueue<SessionEvent>`，作为后台泵和前台 yield 之间的缓冲。
2. `ModelAdapter.resolveModel()` 解析 LanguageModel，失败立即推 error + complete。
3. 构建 provider tools dict，**每个工具的 `execute` 被权限层包了一层**。
4. 从 RuntimeEvent 历史构建模型消息。
5. 后台泵：`streamText({...})` → `for await (chunk of result.fullStream)` → `ModelAdapter.handleStreamChunk` 归一化 → 推 queue。
6. 前台 `yield* drain(queue)`。

精巧点：

- **StreamWatchdog**：流式连接有 connect timeout 和 idle timeout，超时会 abort controller 并推 error 事件，防止挂死。
- **step cap grace**：当 `finishReason === 'tool-calls'`（撞了 step 上限）且没有 assistant 文本时，注入一条确定性提示，告诉用户已达本轮工具上限、可发"继续"。
- **prepareStep 动态工具加载**：同 turn 内可以逐步激活更多工具（deferred load），active 工具集按 step 重算。

### ToolRuntime：权限门控 seam

整个安全模型的执行点。工具的 `execute` 回调被 `wrapToolExecute` 包裹后交给 AI SDK，每次模型调用工具都经过这条链：

1. **loop-gate**：同一个 tool + 同一组 args 连续失败 N 次，直接 block，防止 agent 死循环。block 本身不记 outcome，streak 停在阈值，后续相同调用继续被拦。
2. **PermissionEngine.evaluate()** 返回三态：
   - `allow` → 跑真实 `impl`，写 `ToolResult`。
   - `block` → 合成 `isError:true` 的工具结果返回给模型，不执行真实逻辑。
   - `prompt` → 推 `PermissionRequestEvent` 给 UI，await 一个 parked Promise，等用户决定。allow 则跑，deny 则合成"用户拒绝"。
3. 工具执行期间**暂停 stream watchdog**（避免长任务被判超时），`finally` 里恢复。
4. abort signal 透传进工具，stop 按钮能中断。
5. 记录 telemetry、artifact candidate、错误分类。

### ModelAdapter：provider 归一化

把 provider / AI SDK 的细节挡在外面：stream chunk 类型、provider setup、usage 归一化、provider error mapping。

- `startStream` 统一调 `streamText`。
- `handleStreamChunk` 把各种 chunk 翻译成 Maka 的 `SessionEvent`（text delta、thinking delta、complete 等）。

这样未来加 provider 不需要重复权限 / 工具 / run / session 逻辑。

### RunTrace：best-effort 诊断

记录 turn 的里程碑事件：turn started、model resolved / stream started / completed / failed、tool started / completed / failed、permission requested / decided、usage recorded、abort requested。

**关键约束：trace 写失败绝不影响用户对话**。它和 session 消息 JSONL 是分开的两套持久化。

---

## 权限系统

这是 Maka 区别于普通 chat demo 的核心安全设计，定义在 `packages/core/src/permission.ts`。

### 四档 PermissionMode

`explore` / `ask` / `execute` / `bypass`，从只读到全自动。

### 12 类 ToolCategory

`read`、`web_read`、`file_write`、`fs_destructive`、`shell_safe`、`shell_unsafe`、`git_destructive`、`network_send`、`privileged`、`browser`、`custom_tool`、`subagent`。

### mode × category 策略矩阵

`PERMISSION_POLICY` 是纯函数决策表，决定每个组合是 `allow` / `prompt` / `block`。设计很克制：

| 模式 | 读 | 写 | 危险操作 | 网络 | 浏览器 |
| --- | --- | --- | --- | --- | --- |
| `explore` | allow | block | block | web_read=prompt | block |
| `ask` | allow | prompt | prompt | prompt | prompt |
| `execute` | allow | allow | **永远 prompt** | allow | **永远 prompt** |
| `bypass` | allow | allow | allow | allow | allow |

核心规则：**不可逆操作（`fs_destructive`、`git_destructive`、`privileged`、`browser`）在 `execute` 模式下仍强制 prompt**——浏览器操作可能发帖 / 下单，视为不可逆。`bypass` 全 allow，仅用户显式选择时进入。

`BUILTIN_TOOL_CATEGORY` 把 Claude SDK 风格的工具名映射到类别，`Bash` 默认 `shell_unsafe`，再由 `categorizeBash()` 根据命令前缀动态降级或升级（`ls`/`pwd` → `shell_safe`，`rm` → `fs_destructive`，`git push --force` → `git_destructive`）。

### 纯函数原则

`preToolUse()` 给定输入必然返回相同结果，不生成 UUID（requestId 由 runtime 层的 `PermissionEngine` 生成），便于测试。

### parked Promise 机制

`PermissionEngine` 为每个 outstanding 权限请求维护一个 parked Promise，UI 的决定通过 `respondToPermission()` resolve 回等待中的 adapter。turn 结束时未回答的请求会被 reject 成 `user_stop`。

---

## 持久化与恢复

### 文件布局

工作数据放 Electron `userData` 下的 workspace 目录：

```
<Electron userData>/workspaces/default/
  llm-connections.json
  credentials.json
  settings.json
  sessions/<sessionId>/
    messages.jsonl
    runs/<runId>/
      run.json          ← run header（原子写）
      events.jsonl      ← append-only run 事件
```

### AgentRun ledger

`FileAgentRunStore`（`packages/storage/src/agent-run-store.ts`）实现：

- `run.json` 原子写（`writeAtomic` 先写临时文件再 rename）。
- `events.jsonl` append-only。
- **同 run 写串行化**（`writeQueues` per sessionId+runId 的 Promise 链），避免并发写竞争。
- ID 校验 `SAFE_ID_PATTERN`，防路径穿越。
- 读事件时容忍损坏行（`event_corrupt`）和未终止尾部。

这套 ledger 和用户可见的 session 消息 JSONL 分开，诊断 / 恢复状态不污染对话历史。

### 启动恢复

`recoverInterruptedSessions()` 优先用 run ledger：扫描持久化的 run header 和事件，分类非终态 run（`created` / `running` / `waiting_permission`），修复后收敛 session / turn 投影。

覆盖的恢复场景：

- stale 的 `created` / `running` run
- 停在 `run_started` / `model_stream_started` 的 run
- `tool_started` 后的残留
- `permission_requested` 后的等待
- 缺终态事件的 `model_stream_completed`
- 损坏事件行

没有 run ledger 的老 session 走旧的 message + turn-state 恢复路径。

---

## Electron 集成层

### 进程边界

| 进程 | 文件 | 职责 |
| --- | --- | --- |
| main | `apps/desktop/src/main/main.ts`（4593 行） | 装配 `SessionManager`、注册 IPC、管理窗口、OAuth、bot、gateway |
| preload | `apps/desktop/src/preload/preload.ts` | `contextBridge` 暴露 `window.maka.*` 白名单 API |
| renderer | `apps/desktop/src/renderer/` | React UI + Settings |

`main.ts:1262` 装配 `runtime = new SessionManager({...})`，`main.ts:564` 起 `OpenGatewayService`。IPC 用 `ipcMain.handle` 注册大量通道（memory、artifacts、settings、connection、session 等）。

### 密钥安全边界

- Provider/API key、bot token、proxy password、gateway token、Tavily key 写入本机凭据文件，依赖 OS 账号边界和文件权限；subscription OAuth token 使用独立的系统安全存储。
- Renderer 永远拿不到明文密钥，Settings 只显示 masked 状态和测试结果。

### 多入口

除了桌面 UI，runtime 还服务两类外部入口：

- **Bot adapter**（`packages/runtime/src/bots/`）：Telegram、飞书、企业微信、微信 iLink、Discord、钉钉、QQ，都继承 `base-adapter.ts`，统一对接 SessionManager。
- **Open Gateway**（`open-gateway.ts`，1489 行）：本地 HTTP / SSE API，用 token 保护，让外部读取会话状态 / 事件 / 能力 / 健康摘要。

---

## 数据流：一次对话的完整路径

1. 用户在 renderer 输入消息 → `window.maka.session.send` → IPC → `SessionManager.sendMessage`。
2. 创建 `AgentRun`，写 `run_created` 到 ledger，append 用户消息到 `messages.jsonl`。
3. 从历史 run 的 RuntimeEvent 投影模型上下文。
4. `AiSdkBackend.send()`：构建权限包裹的工具 → `streamText(stepCountIs(N))` → 后台泵 fullStream。
5. 每个流 chunk 经 `ModelAdapter.handleStreamChunk` 归一化成 `SessionEvent` → 推 queue → 前台 yield → IPC 流到 renderer。
6. 模型调用工具 → `wrapToolExecute` → loop-gate → `PermissionEngine.evaluate` → allow / block / prompt → 执行或合成错误。
7. assistant 文本落 `messages.jsonl`，usage 记 telemetry，trace 写 run ledger。
8. `finalize()` 收尾，写 `run_completed`，更新 session header。

---

## 技术亮点小结

- **ledger + projection 模式**：run 事件是 source of truth，session 状态是投影，崩溃可重建——整个恢复能力的根基。
- **纯函数策略 + runtime 包装**：权限决策表是纯函数好测试，requestId / parking 状态由 runtime 管，职责分得清楚。
- **权限门控作为工具 execute 的 seam**：不动 AI SDK 的循环，在 execute 回调里插入 allow / block / prompt，最小侵入。
- **best-effort trace 不影响主路径**：诊断信息尽力写，失败静默，对话绝不受拖累。
- **同 run 写串行化 + 原子写**：文件持久化的并发安全靠 Promise 链和 rename 保证。
- **安全分层**：模式 × 类别矩阵 + 命令分类器 + 凭据文件权限 / subscription token 安全存储 + preload 白名单，多层防御。
