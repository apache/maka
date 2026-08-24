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

# Maka 能力成熟度审计 v1

> Archived on 2026-07-13. This is a point-in-time audit against a May 2026 code baseline; its progress and frontend-document references are not current guidance.

> 编写：@xuan
> 日期：2026-05-22
> 基线：`main` at `832bbac`
> 范围：能力 / runtime / storage / IPC / release gate。UI 视觉规则以 `docs/design-system.md` 为准。

本文档回应 task #12 中 "@xuan 详细挖掘现在项目存在的问题，和需要继续做的能力"。
目标不是再列一组 wish list，而是把 Maka 从 "能聊天的桌面 app" 推向
reference implementation / reference implementation 那类成熟工作台时必须补齐的系统 contract。

审计参考：

- Maka 当前代码：`packages/core/src/session.ts`,
  `packages/core/src/events.ts`, `packages/core/src/llm-connections.ts`,
  `packages/runtime/src/session-manager.ts`, `packages/runtime/src/builtin-tools.ts`,
  `apps/desktop/src/main/main.ts`, `apps/desktop/tests/smoke.md`
- reference implementation 本地资料：local research notes,
  architecture gap notes,
  `docs/11-providers.md`, `docs/17-workspaces-git.md`, `docs/39-streaming-deep.md`,
  `readable/preload.js`
- reference implementation 本地资料：`~/.reference implementation-agent/docs/reference implementation-cli.md`,
  `~/.reference implementation-agent/release-notes/*.md`

## 0. 当前基线判断

Maka 目前已经不是早期 chat demo：

- provider model discovery 已走 live fetch + source/fetchedAt contract；
- Settings / ModelTable / turn grouping / typed tool renderer / visual smoke fixture 已有基本 gate；
- Electron 安全边界、console audit、readiness reason、window state 等桌面基础已补了一轮；
- `docs/design-system.md` 已把 visual release gate 写成契约。

但能力层仍然薄：核心数据模型仍围绕 "session + JSONL messages"，没有 artifact、
workspace status、turn control、source/automation、health、memory 这些成熟工作台必须有的持久化对象。
接下来最重要的不是继续堆 Settings polish，而是补数据结构和状态机。

## 1. 第一优先级：ArtifactRecord + right pane

### 现状问题

Maka 当前的 tool result 都落在 transcript 里：

- `ToolResultContent` 只有 `file_diff` / `file_write` / `terminal` / `image` / `summary` 等结果形状；
- UI 通过 typed renderer 把 diff/terminal 渲染好，但仍然是 chat turn 的一部分；
- 大 HTML、图片、PDF、长 diff、生成文件没有成为可选择、可复看、可导出的工作成果。

用户路径上的不成熟感：

- 一次生成网页 / 图片 / 文档后，用户只能在长聊天里找结果；
- terminal/diff 输出占据主叙事，缺少 "成果面板"；
- 后续 snapshot / rollback / preview 没有对象可挂。

### reference implementation / reference implementation 对照

reference implementation preload 已有 `snapshot.*` 一组能力（create / file / list / get / diff / rollback / cleanup），并把 workspace diff/snapshot 从 transcript 中分离出来。
reference implementation 的 release notes 也反复强调 diff / preview / data table / terminal preview 的独立呈现。

可复制的是：artifact 作为第一等对象；不可照搬的是 reference implementation wide-open local API。

### Contract / API

新增 core contract：

```ts
export type ArtifactKind =
  | 'file'
  | 'html'
  | 'image'
  | 'pdf'
  | 'diff'
  | 'terminal'
  | 'json'
  | 'markdown';

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  turnId?: string;
  toolUseId?: string;
  kind: ArtifactKind;
  title: string;
  createdAt: number;
  updatedAt: number;
  source: 'tool_result' | 'user_upload' | 'export' | 'snapshot';
  ref: StorageRef;
  mimeType?: string;
  bytes?: number;
  summary?: string;
  status: 'ready' | 'streaming' | 'errored' | 'deleted';
  errorReason?: string;
}
```

Storage:

- `artifacts.jsonl` per session or `artifacts/metadata.jsonl` per workspace；
- large payload 必须 file-backed，不进入 `session.jsonl`；
- HTML preview 使用 sandboxed iframe，禁止 inline untrusted script 执行；
- deletion 先 soft-delete，避免 transcript 中引用断裂。

IPC:

- `artifacts:list(sessionId?)`
- `artifacts:get(id)`
- `artifacts:open(id)`
- `artifacts:delete(id)`
- `artifacts:export(id, format?)`

Renderer:

- right pane 作为 `--z-panel` 消费者；
- Chat turn 内只显示 compact artifact card；
- pane 负责 full preview / copy / open / export。

### Failure state

需要固定 reason：

- `artifact_missing`
- `artifact_deleted`
- `artifact_too_large`
- `artifact_preview_unsupported`
- `artifact_load_failed`
- `artifact_sandbox_blocked`

### Gate

- node:test：ArtifactStore append/list/get/delete；HTML artifact 必须 file-backed；
- fixture：新增 `artifact-pane` scenario，包含 html + image + diff + errored artifact；
- smoke.md：新增 "Artifact pane open / preview / export / error" path；
- screenshot：light/dark/narrow + missing artifact failure state。

## 2. Tool output streaming delta 协议

### 现状问题

Maka 已有 `ToolProgressEvent`，但当前 runtime tools 多数只在 tool 完成后返回完整 result。
`Bash` 使用 `exec`，只有完成后一次性拿 stdout/stderr。UI 的 terminal renderer 也只能显示 settled output。

用户路径上的不成熟感：

- 长测试 / build / install 没有实时 stdout；
- 用户以为 app 卡住；
- Stop 后看不到 partial output。

### reference implementation / reference implementation 对照

reference implementation streaming docs 强调 tool output delta；reference implementation release notes 也多次修复 partial output / streaming error recovery。
可复制的是 "delta 先到 UI，final result 再落盘"。

### Contract / API

扩展事件：

```ts
export interface ToolProgressEvent extends BaseEvent {
  type: 'tool_progress';
  toolUseId: string;
  sequence: number;
  stream: 'stdout' | 'stderr' | 'progress' | 'text';
  text: string;
  truncated?: boolean;
}
```

Runtime:

- Bash 从 `exec` 改成 `spawn`；
- stdout/stderr chunk 经 redaction 后发 `tool_progress`；
- final `tool_result` 保留 capped output + artifact ref（完整日志入 artifact）；
- abort 时落 `tool_result` with `isError=true` + `reason='aborted'` 或独立 aborted event。

### Failure state

- `tool_aborted`
- `tool_timeout`
- `tool_output_truncated`
- `tool_spawn_failed`
- `tool_permission_denied`

### Gate

- node:test：fake streaming tool emits ordered progress → result；
- fixture：`turn-with-streaming-tool`；
- smoke：长 running command 能实时显示 stdout/stderr，Stop 后保留 partial output。

## 3. ModelCatalogEntry：模型目录不再只是 ModelInfo

### 现状问题

当前 `ModelInfo` 只有 `id/contextWindow/maxOutputTokens/capabilities`，capabilities 也只有 vision/reasoning/functionCalling。
不足：

- 没有 `mode` 区分 chat/image/audio/embedding/rerank；
- 没有 pricing/source/stale/unsupported；
- default model 校验只看 model id 是否在 enabled list；
- 无法阻止 image-only / embedding-only model 被设为 chat default；
- Health / first-run 无法解释 "模型存在但不能用于当前 chat"。

### reference implementation / reference implementation 对照

reference implementation provider 层会根据 model id 补 capability；reference implementation 在 release notes 中也反复修 model resolution / Bedrock region / unsupported model 过滤。
可复制的是 backend-normalized catalog，而不是 UI 猜。

### Contract / API

新增：

```ts
export type ModelCapability =
  | 'chat'
  | 'tool_use'
  | 'vision'
  | 'reasoning'
  | 'image_generation'
  | 'audio_input'
  | 'audio_output'
  | 'embedding';

export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  providerType: ProviderType;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: {
    inputPerMtok?: number;
    outputPerMtok?: number;
    currency: 'USD' | 'CNY';
    source: 'builtin' | 'provider' | 'user';
  };
  source: 'fetched' | 'fallback' | 'user_custom';
  fetchedAt?: number;
  stale?: boolean;
  unsupportedReason?: 'not_chat_model' | 'missing_tool_use' | 'provider_deprecated' | 'unknown';
}
```

Readiness guard:

- chat default requires `capabilities.includes('chat')`；
- tool mode requires `tool_use`；
- image/audio model 不能设为 chat default。

### Failure state

- `model_unsupported`
- `model_stale`
- `model_not_chat_capable`
- `model_requires_refresh`

### Gate

- node:test：unsupported/image-only cannot become default；
- fixture：provider has mixed chat/image/embedding models；
- smoke：ModelTable shows unsupported row disabled + reason。

## 4. Session status / workstation shell

### 现状问题

`SessionSummary` 当前没有 status。运行态由 renderer 的 `streamingBySession` map 临时推断。
这对单窗口短聊天够用，但对工作台不够：

- session 正在 running / waiting permission / blocked / errored / review / done 无持久状态；
- app 重启后无法恢复 "上次卡在 permission" / "上次工具失败"；
- sidebar 只能显示 unread / streaming dot，不知道工作流阶段；
- Health / automations / artifacts 都缺 workspace shell 可挂载的位置。

### reference implementation / reference implementation 对照

reference implementation 有 thread/workspace/snapshot 体系；reference implementation 有 workspace、labels、sources、automations，release notes 里也提到 branch/session recovery。
可复制的是 session 状态机和 workspace metadata。

### Contract / API

扩展 `SessionHeader`：

```ts
export type SessionStatus =
  | 'active'
  | 'running'
  | 'waiting_permission'
  | 'blocked'
  | 'review'
  | 'done'
  | 'errored'
  | 'archived';

export interface SessionHeader {
  status: SessionStatus;
  statusReason?: string;
  workspace?: {
    root: string;
    branch?: string;
    pr?: string;
    dirty?: boolean;
  };
}
```

Runtime:

- send start → `running`
- permission_request → `waiting_permission`
- permission deny → `blocked`
- complete → `done` or `review`（由 turn control 决定）
- error → `errored` with reason
- archive → `archived`

### Failure state

- `session_connection_missing`
- `session_permission_blocked`
- `session_tool_failed`
- `session_aborted`
- `session_recovery_needed`

### Gate

- node:test：status transitions；
- fixture：running / waiting_permission / errored / done sessions；
- smoke：sidebar row + header status match。

## 5. Turn control：retry / branch / regenerate / checkpoint

### 现状问题

Maka 有 turn grouping，但没有 turn-level controls：

- retry/regenerate 没有 contract；
- branch-from-turn 没有 lineage；
- cancel/abort 只是一条 system note，不是 turn status；
- tool 执行前没有 checkpoint/snapshot，因此 destructive 修改后无法 rollback；
- 旧输出不可覆盖这个原则没有被模型化。

### reference implementation / reference implementation 对照

reference implementation 有 snapshots / branch / compact；reference implementation release notes 明确 session branching 和 branch cutoff 是长期复杂点。
这说明分支/重试必须从第一天就有 sidecar anchor 和 lineage，不要先做 UI 按钮。

### Contract / API

新增 `TurnRecord`：

```ts
export interface TurnRecord {
  id: string;
  sessionId: string;
  parentTurnId?: string;
  branchId?: string;
  status: 'running' | 'completed' | 'aborted' | 'errored' | 'superseded';
  startedAt: number;
  completedAt?: number;
  modelId?: string;
  snapshotIdBeforeTools?: string;
  errorReason?: string;
}
```

IPC:

- `turns:retry(sessionId, turnId)`
- `turns:branch(sessionId, turnId)`
- `turns:cancel(sessionId, turnId)`
- `turns:createCheckpoint(sessionId, turnId)`

### Failure state

- `turn_not_found`
- `turn_already_running`
- `branch_cutoff_invalid`
- `checkpoint_failed`
- `retry_requires_model`

### Gate

- node:test：branch copies messages up to turn boundary only；
- fixture：branched session + aborted turn；
- smoke：branch from prior turn creates new sidebar session, original unchanged。

## 6. Health Center：分散状态收拢

### 现状问题

目前健康状态分散：

- provider credential 在 Account / Models；
- proxy 在 Network；
- bot 在 Bot Chat；
- model fetch source 在 ModelTable；
- storage / visual smoke / console gate 不在 UI；
- missing connection 只在 chat header。

用户路径上的不成熟感：

- 出错时不知道是 key、网络、proxy、provider、bot、model list、workspace 权限哪一个；
- bug report 不能一键 copy redacted diagnostics；
- release smoke 也没有一个综合状态页。

### reference implementation / reference implementation 对照

reference implementation 有大量 `/api/*/status` 和 settings tree；reference implementation CLI 的 `source test/validate`、automation validate/lint 都是 health surface。

### Contract / API

新增：

```ts
export type HealthComponent =
  | 'provider'
  | 'credential'
  | 'model_catalog'
  | 'proxy'
  | 'bot'
  | 'storage'
  | 'skills'
  | 'search'
  | 'voice'
  | 'open_gateway';

export interface HealthCheckResult {
  component: HealthComponent;
  id: string;
  label: string;
  status: 'ok' | 'warning' | 'error' | 'disabled' | 'unknown';
  reason?: string;
  message: string;
  lastCheckedAt?: number;
  details?: Record<string, unknown>; // redacted only
}
```

IPC:

- `health:list()`
- `health:run(component?, id?)`
- `health:copyDiagnostics()`

Diagnostics must include:

- app version / OS / workspace schema；
- provider statuses without secrets；
- latest generalized errors；
- proxy enabled/type without credentials；
- storage file presence / JSON parse status；
- no raw paths unless user explicitly copies workspace path。

### Failure state

Use same reason vocabulary as readiness / connection / proxy:

- `auth`
- `timeout`
- `network`
- `provider_unavailable`
- `connection_missing`
- `storage_corrupt`
- `unsupported`

### Gate

- node:test：diagnostics redaction；
- fixture：mixed ok/warning/error health；
- smoke：Health Center copy output contains no key/path secret。

## 7. Sources / Skills / Automations visible system

### 现状问题

Maka only lists installed skills from `workspaceRoot/skills`. There is no first-class source, no source-scoped permissions, no automations.

Current gaps:

- skill visibility does not mean invocability / permissions；
- no source auth/scope/status；
- no automation last-run/history；
- user cannot audit which capability can touch what。

### reference implementation 对照

reference implementation CLI has first-class `source`, `skill`, `automation`, `permission` entities with validate/test/history commands.
This is a strong model for Maka because it keeps external capability visible and revocable.

### Contract / API

Minimal first step:

```ts
export interface SourceRecord {
  slug: string;
  name: string;
  type: 'mcp' | 'api' | 'local';
  enabled: boolean;
  authType: 'oauth' | 'bearer' | 'none';
  scopeSummary: string[];
  status: 'ready' | 'needs_auth' | 'error' | 'disabled';
  lastTestAt?: number;
  lastErrorReason?: string;
}

export interface AutomationRecord {
  id: string;
  name: string;
  enabled: boolean;
  trigger: 'manual' | 'schedule' | 'event';
  permissionMode: 'explore' | 'ask' | 'execute';
  lastRunAt?: number;
  lastRunStatus?: 'ok' | 'error' | 'skipped';
}
```

### Failure state

- `source_needs_auth`
- `source_scope_denied`
- `automation_disabled`
- `automation_last_run_failed`
- `skill_missing_source`

### Gate

- node:test：skill cannot widen permission mode；
- fixture：source needs auth + disabled automation；
- smoke：Settings surface shows source/skill/automation enabled/disabled/test states。

## 8. First-run to value

### 现状问题

OnboardingHero exists and provider save auto-fetch works, but flow is still fragmented:

1. Provider preset；
2. paste key；
3. save；
4. auto-fetch；
5. choose default；
6. go back to chat；
7. send prompt。

There is no explicit "you are ready" smoke prompt, no inline model fetch failure lane, and no first-run state machine.

### reference implementation / reference implementation 对照

reference implementation `validate-server` auto-bootstraps temp workspace/connection for validation；reference implementation onboarding has permission timing and settings tree.
可复制的是 first-run guided state, not cinematic onboarding.

### Contract / API

```ts
export type FirstRunStep =
  | 'choose_provider'
  | 'enter_secret'
  | 'fetch_models'
  | 'choose_default'
  | 'send_smoke_prompt'
  | 'done';

export interface FirstRunState {
  current: FirstRunStep;
  providerSlug?: string;
  errorReason?: string;
  completedAt?: number;
}
```

### Failure state

- `secret_invalid`
- `model_fetch_failed`
- `no_chat_models`
- `default_model_missing`
- `smoke_prompt_failed`

### Gate

- fixture：`first-run`, `first-run-auth-error`, `first-run-fetched-empty`；
- smoke：4 screens max from provider pick to first successful assistant answer；
- node:test：step transition reducer。

## 9. Memory MVP

### 现状问题

Maka has personalization prompt, but no memory object:

- no persistent facts；
- no retrieval；
- no memory source visibility；
- no user review/delete；
- no sleep/consolidation。

Do not jump directly to reference implementation's sqlite-vec + ONNX. The first missing piece is user-visible memory CRUD and retrieval contract.

### reference implementation 对照

reference implementation has memory store, embeddings, sleep cycle, Recall tool, memory archive. Useful structure:

- memory rows have durability；
- retrieval is a tool / context source；
- sleep is previewable and cancelable。

### Contract / API

MVP:

```ts
export interface MemoryRecord {
  id: string;
  content: string;
  source: 'user_pinned' | 'assistant_suggested' | 'imported';
  durability: 'temporary' | 'permanent';
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}
```

No embeddings in first PR. Use keyword search + explicit user pin/delete.

### Failure state

- `memory_search_failed`
- `memory_disabled`
- `memory_import_invalid`

### Gate

- node:test：CRUD/search/archive；
- fixture：3 memories + archived item；
- smoke：Settings/Memory page can add/delete/search and chat can cite retrieved memory source。

## 10. Open Gateway / Voice / Search Coming Soon

### 现状问题

Settings has Coming Soon panels for search, voice, open gateway. The copy is better now, but capability is absent.
This creates expectation debt.

### Recommended order

1. Open Gateway SSE bridge: easiest to contract and test locally.
2. Search service: can start with provider abstraction + disabled health state.
3. Voice input: needs macOS permissions / audio device UX, do later unless user prioritizes.

### Open Gateway contract

Expose a local OpenAI-compatible endpoint only when explicitly enabled:

- bind `127.0.0.1` by default；
- per-workspace token generated locally；
- no plaintext secret in logs；
- `/v1/models` returns chat-capable `ModelCatalogEntry` only；
- `/v1/chat/completions` routes to selected connection；
- health reason if default connection unavailable。

Failure reasons:

- `gateway_disabled`
- `gateway_token_invalid`
- `gateway_model_unsupported`
- `gateway_connection_unavailable`

Gate:

- node:test for token auth + disabled path；
- fixture for gateway enabled/unavailable；
- smoke with curl local endpoint。

## 11. Recommended PR order

### Wave A: Workbench foundation

1. `ArtifactRecord` core/storage contract + fixture seed (no UI pane yet).
2. Right artifact pane renderer + smoke path.
3. Tool streaming delta for Bash + terminal artifact ref.

Why first: this changes Maka from "chat transcript" to "work product workspace".

### Wave B: Decision quality

4. `ModelCatalogEntry` + chat default gate.
5. Health Center core result type + provider/proxy/bot/storage checks.
6. First-run state reducer + first-run fixture expansion.

Why second: user setup and provider/model trust become understandable.

### Wave C: Workflow control

7. Session status state machine.
8. TurnRecord + cancel/abort persistence cleanup.
9. Branch/regenerate/checkpoint API.

Why third: these are more invasive and should build on artifact/snapshot shape.

### Wave D: Ecosystem

10. Sources/Skills/Automations records.
11. Memory MVP.
12. Open Gateway.
13. Search / Voice.

## 12. Do-not-copy list

From reference implementation/reference implementation, do not copy these patterns into Maka:

- wide-open local HTTP API without explicit enable/token；
- plaintext secret returns through IPC / API；
- auto-approval or subagent `--approve-all` trust shortcuts；
- activity/screen recorder defaults；
- cinematic onboarding that delays first value；
- hidden skill permission widening；
- raw console logs for chat IDs, API responses, provider bodies。

Maka should copy structure and state models, not unsafe shortcuts.

## 13. Immediate next action

My recommendation for the next implementation PR:

**PR-A1: `ArtifactRecord` core/storage/fixture contract only.**

Deliverables:

- `packages/core/src/artifacts.ts`
- `packages/storage/src/artifact-store.ts`
- `apps/desktop/src/main/visual-smoke-fixture.ts` adds `artifact-pane`
- node:test for append/list/get/soft-delete/file-backed invariant
- docs update: `docs/design-system.md` §9.1 fleshed out
- no renderer pane yet

This keeps the first step small, testable, and directly unlocks the right pane.
