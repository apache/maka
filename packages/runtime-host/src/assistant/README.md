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

# Native personal assistant

The Runtime Host owns three built-in services: memory indexes, durable Matters, and an Inbox-driven personal-assistant Bot with independent proactive exploration. They do not install extension packages, register Plugin fibers, or depend on desktop plugin slots. Feishu remains an independently authorized source plugin.

`service.ts` owns tools, prompt contributions, the Matter finish check, the fixed desktop API, scheduler startup and shutdown. `execution-composition.ts` recovers its state after source plugins, and starts schedulers after execution recovery. Shared Host agent, model, history and source adapters retain invocation identity and permissions; using these adapters does not install a plugin.

The feature defaults **off**, including installations with existing assistant data. Enable **通用 → 启用个人助手** in Settings, beside the WorkHub switch, to expose the sidebar entry and start the three services on that Host. The switch is shared by clients of the same Host, not a desktop-only visibility preference. Its labeled conversation is excluded from the ordinary Session rail and palette. WorkHub remains separate. Opening the assistant does not import history, create indexes, enable discovery or call a model.

## Conversation workspace

Personal Assistant keeps the existing Session creation rules: use the configured default Project when applicable, then the Host's current Project preference. A local Host with no Project still allocates its existing `~/Maka/tasks/task-*` directory (`~/Maka Dev/tasks/task-*` for development).

Only when an implicit assistant creation on WSL or a remote Host has no resolvable Project, Desktop calls `assistant.allocate-workspace` on that Host. The Host allocates a fresh task directory in its own home and registers its Project identity for ordinary Session creation. It never adopts an arbitrary existing Project or accepts a Client directory. Standard Host development profiles use `~/Maka Dev/tasks/task-*`; other Host profiles use `~/Maka/tasks/task-*`. The connecting Desktop does not choose a remote Host's namespace. Allocation failure is reported without falling back to the Client filesystem. Client and Host must both support compatibility epoch 226.

Existing assistant bindings retain their conversation, cwd, model and history. Opening them does not allocate another directory or migrate files. This change does not alter ordinary task creation or explicit remote workspace validation.

## Master switch

`personal-assistant/enablement.json` stores the Host-owned feature switch. When absent, the personal assistant is enabled by default. An explicit `enabled: false` is preserved across restarts; while disabled, the Host does not import the modules, open their databases, adopt old plugin data, register assistant tools/prompts/finish checks, or run any assistant schedulers. Initialization failures leave the assistant unavailable with an error exposed in Settings, preserve stored preferences/data, and do not fail Host recovery. After fixing the configuration, enabling in Settings retries initialization. The two allowlisted desktop operations `assistant.enablement` and `assistant.set-enabled` remain available; feature operations reject while disabled.

Disabling fences new calls, aborts in-flight tools, stops assistant/worker Sessions and all three schedulers, then closes their stores. Captured tools from a retired runtime reject further calls. Transitions serialize so re-enabling cannot overlap the previous generation. Session admission also checks the switch so old queued messages cannot restart disabled assistant workers. Ordinary conversations and WorkHub are unaffected.

Existing indexes, originals, coverage, conversations and task state remain on disk. Re-enabling restores saved scheduling preferences and overdue work; interrupted tasks that were paused by shutdown require explicit recovery in Settings. Switching the feature on does not import history or enable proactive heartbeats for a new user. Feishu remains a separately controlled plugin; this switch stops assistant access/maintenance, not unrelated uses of that plugin.

## Existing data

On first explicit enablement, `personal-assistant/assistant.json` in the Host control directory records each component's directory and configuration. Existing `data-directory` storage and profile configuration from the three retired plugin packages are adopted in place. Databases, references, checkpoints, delegated sessions and feedback receipts keep their existing formats and paths. No database is copied or rebuilt. An invalid or ambiguous configuration fails explicitly instead of opening an empty replacement.

The Host suppresses the three former packages on every composition projection, including later enable/reload attempts. Their persisted configuration and package data are retained; Feishu is not suppressed. Restarting uses the native settings file as the authority. Native feature lifetime no longer depends on plugin installation or reload.

Memory defaults remain 12-hour maintenance and at most 5 concurrent indexing jobs, configurable in the native component configuration. Each index retains its own maintenance controls. Only checkpoints advance coverage; reading refreshes observations without organizing. The UI controls heartbeat cadence, per-index maintenance and task recovery. There is no automatic Feishu authorization or historical import.

## Index sources and navigation

`MemoryIndexAddSources` appends IDs from `MemorySources` to one or more existing indexes in one transaction. It preserves documents, references, coverage, grouping and maintenance settings. Actual additions require idle group workers and no unfinished range on each changed index. Repeated additions are no-ops. Reading refreshes observations; `MemoryIndexMaintain` organizes the new history through the existing Agent. Only its checkpoint advances coverage.

Index reads expose shared usage guidance. `MemoryIndexContent` defaults to directory navigation; `key`, `keys` and `view=full` read bodies. `MemoryIndexLinks` navigates saved references to originals and accessible related entries, preserving exact versions and paginating expanded paths. Its shared-object count is not a recommendation score. It neither retrieves remote bodies nor runs maintenance.

`MemorySourceQuery` supports `view=content` to return compact original bodies with stable refs, or `queries` to query several sources concurrently. Legacy single-source metadata reads remain available. `MemoryOriginal` accepts `refs` for batched reads and `view=content` for compact output. Content reads budget complete records with `maxChars` (default 6,000) and the runtime UTF-8 byte threshold, including pagination metadata; `nextPage` continues the same persisted, session-bound batch after a restart. After finishing a batch, `sources[].next` is the native source query continuation. Each continuation rechecks source scope and permissions. Source failures remain explicit. Oversized individual bodies return `truncated`, `totalChars` and `nextOffsetChars`; use a single `MemoryOriginal` content read with `offsetChars` to continue. These reads neither organize indexes nor advance coverage. External `MemoryHistory` offsets skip earlier bodies when selection only depends on metadata; body-dependent keyword/conversation filters retain their semantics.


## Proactive instructions

Heartbeats use the discovery and judgement instructions from code; configuration only changes cadence. Two persistent background Sessions share an append-only notebook, rather than handing off a fixed candidate list. Each worker reads the notebook from a private Markdown file and writes only its new observations (and, for judgement, feedback interpretations and proposed messages) to a per-wake JSON file. The Host persists those operations atomically; empty results are allowed. Only genuine user feedback may close, defer or reopen a topic, and newer feedback invalidates stale drafts. These are provenance and consistency checks, not a model/keyword review of recommendation quality. Judgement chooses directions from the entire notebook, considering occurrence time and current user value. Its messages go through the Bot inbox; acceptance is recorded as “reported”, never as confirmed delivery. Actual assistant conversation is shown separately. A failed judgement resumes from the notebook without repeating discovery. Both worker histories, the notebook and the configured cadence survive restart. New prompt versions reach existing Sessions once; obsolete saved custom instructions do not override them. Source history and indexes are unchanged. Existing pre-upgrade reports remain readable as historical context for the pending judgement.

## Turn identities

Background turns (heartbeats, Matter wakes, task notifications, bot-delivered messages) run under Host turn ids. The Host admits a turn id only when it matches `^[A-Za-z0-9_-]{1,128}$` (`requireEntityId`), and the desktop can branch from any turn it can read. Use dashes as separators, never colons, and hash caller-supplied text instead of embedding it (see `bot/turn-ids.ts`). The desktop disables Branch on turns whose id the Host would reject. Transcripts written before this rule keep colon-form ids, so readers must accept both forms (`isPendingActivationTurnId`, and the input-receipt check in `execution-composition.ts`).

## Verification

Run `npm run build --workspace @maka/runtime-host`, `npm run test:assistant --workspace @maka/runtime-host`, and the native service/platform tests in `dist/__tests__`. The behavioral tests now start the native service directly. Their external-source test still installs the real Feishu source plugin. Mock models are used; no paid model test is started. The assistant suite is also part of the Host's normal `test:dist` command.

## Assistant Bot

The Bot offers concrete help or follow-up based on the user’s situation, while distinguishing a proposal from work already arranged. Backend results inform its own conversation with the user. Backend findings, updates, offers of help and questions intended for the user must be conveyed in the current turn unless there is a concrete reason to filter them. Non-urgency, message count or a vague plan to wait for natural conversation is not sufficient. When it filters all or part of an Inbox message, it records a short reason with `Sleep.notNotified: [{inboxId, reason}]`. These timestamped, append-only decisions survive restart and are returned by `InboxRead`; tool retries do not duplicate them. They are an audit trail, not a processed-message state or a ban on future notification. They are saved even if new mail prevents sleep.

The visible assistant Session is a conversation transport. User messages enter a durable Inbox and are projected to its transcript without starting a model Turn there. A separate background Bot Session owns the ordinary Agent loop. All ordinary model text and tool activity stay in that worker; only `SendUser` publishes assistant chat messages. The existing WorkHub is unchanged.

`InboxCheck` delivers new message bodies in batches (default 50 messages, at most 100 and 24,000 content characters). Long bodies carry an explicit `nextOffset` for `InboxRead`; `hasMore` describes further messages. `InboxList` and `InboxRead` remain optional, non-consuming history reads. There is no pending/processed state or `InboxUpdate`: receiving mail does not mean completing a task or notifying the user. `SendUser({messageId, messages: [...]})` sends an ordered batch of independent chat bubbles in one tool call, without ending the loop. The whole batch is registered atomically before delivery; retries reuse `messageId` and identical content, skip delivered bubbles, and resume the remainder in order. Changing or extending a committed batch is rejected. The model chooses natural conversational boundaries; there is no punctuation splitter or artificial typing delay. `Sleep` explicitly requests suspension, with no requirement to respond or act on received mail. A finish check prevents sleeping past undelivered messages, including arrivals during execution or between Sleep and completion. Normal final text alone does not end the Bot loop. There is no added round timeout or wake-count limit.

The delivery cursor is committed at an accepted Sleep boundary; successive checks in a live loop return only new batches, and retrying the same tool call returns the same batch. An interrupted loop can replay messages since the last accepted Sleep (at-least-once delivery), rather than lose input before its tool result reaches durable history. Previously delivered history does not repeatedly wake the Bot. Existing mail and worker history are retained; the obsolete SQLite `processed` column, if present, is ignored.

User input, discovery findings, task reports, and actionable system events have distinct source types. Identity, source and timestamp are supplied by the Host. Worker reports are evidence, not user instructions. Bot tools have a Host-enforced coordination ceiling: Inbox, messaging, task control and memory/context reads; no shell, editing or browser execution tools. Matter delegation remains owned by the visible conversation, so existing tasks and recovery controls remain available. Investigation and execution go to independent Matters. The Bot directly creates indexes and groups, configures maintenance, adds sources, and starts background maintenance; it does not delegate a Matter to supervise an index worker. Memory tools retain the visible conversation owner for permissions and feedback. Index workers keep ownership of writes and checkpoints. `MemoryIndexControl stop` cancels the shared organizing job and disables maintenance for all its members, retaining content and progress; `pause` only disables scheduled continuation. Index job completion and failure are persisted in a notification outbox and delivered to the owner Bot with stable IDs; undelivered notifications retry after restart. Inbox acceptance is not proof of user notification.

Sleep/wake metadata, the worker Session identity, Inbox and outgoing messages survive restart. Visible messages use stable IDs; a publication retry reconciles against the canonical conversation before appending again. Task feedback uses durable Inbox acceptance instead of inferring delivery from arbitrary assistant final text. Acceptance does not claim the user was notified. Model errors retain mail and appear in assistant Settings; a new input retries the worker. This version has a single loop and does not implement priority/preemption.

The message protocol has an explicit `inbox` admission receipt without a fabricated model Turn ID. Direct `turn.start` on a bound conversation is rejected. Attachment ownership is checked before admission. Explicit turn orchestration / skill selection belongs to a delegated execution, and is rejected at this conversation transport rather than silently discarded.


The Bot can change its local identity with `AssistantSetAvatar({emoji, background?})`.
The avatar can be one emoji or an image, plus an optional `#RRGGBB` background.
`AssistantSetAvatar({image: "/path/to/avatar.png"})` also accepts HTTP(S) image URLs.
Generated and found images use the same setter; generation/search uses existing tools or delegated tasks.
PNG, JPEG, WebP and GIF are accepted up to 2 MiB, through the existing Session filesystem
boundary or Host public-network image loader. Markup and arbitrary URI schemes are rejected.
Validated bytes and metadata are saved atomically in the Bot database, independent of the
original file or URL. Only the Bot worker can write it. Reads never wake a model.
`assistant.avatar` returns lightweight metadata; `assistant.avatar-image` transfers bounded
chunks only when the image changes. Image bytes never appear in tool results/model context.
The desktop entry and assistant messages share the avatar, displayed as a rounded square.
This tool changes appearance only and does not send a message.

运行中的持续任务在每次模型请求前获得当前任务 Inbox 的动态上下文（用户追加要求和 Bot 澄清），同时刷新任务文件，不依赖 Recall。渲染上下文不会确认或消费输入；仍由 MatterRead 和提交检查维护观察边界，收尾时才消费已处理事件。已发出的模型请求或已执行的工具不会被追溯撤销；取消仍使用任务控制接口。


### Bot operation boundaries

The Bot coordinates work, configuration and notifications. Reuse an existing task or
index job when it already owns the requested outcome and reports progress. Create a
separate task only when additional investigation, recovery or follow-up is needed.
A request to notify the user when one issue resolves does not authorize changing the
assistant-wide discovery schedule.

- `InitiativeEnable({})` enables the saved discovery schedule, retaining its interval.
  Repeating it on an enabled schedule leaves the next wake unchanged. First setup
  defaults to 30 minutes. Extra arguments are rejected rather than silently ignored.
- `InitiativeConfigure({intervalMinutes})` explicitly changes that schedule and
  preserves its enabled/paused state. `InitiativeControl` pauses/resumes it or requests
  one general exploration. These operations create no goal-specific task.
- `MemoryIndexControl configure` configures one persisted maintenance clock (12 hours by default); per-index pause/resume only controls participation. At each deadline the scheduler gives all eligible indexes of the same owner to one organizing Agent, retaining independent ranges/checkpoints. It decides what needs changing and which reads/updates to share. Ownership boundaries remain isolated. Creating or manually maintaining an index does not reset the clock; interrupted shared rounds retain their exact ranges and completed members across restarts;
  `MemoryIndexMaintain` runs one organizing round. Shared-job stop semantics remain
  unchanged.
- `MatterDelegate` creates concrete work; `MatterTasks` reads progress;
  `MatterTaskMessage` appends requirements; `MatterTaskControl` changes that task.
  Appending a requirement saves it for a subsequent model request, not proof of compliance.

Mutation receipts identify their target and action. Discovery receipts also return
before/after schedule values. The desktop settings API retains its existing combined
enable-and-configure operation; the model-facing tools separate these intents.
The discovery exploration prompt and Inbox/Sleep loop are unchanged.

## Quick proactive help

`QuickDiscoveryControl` enables a separate ordinary discovery Session. It defaults to off; enabling it does not enable or change the broad discovery schedule. `intervalMinutes` defaults to 15 and `idleMinutes` to 60. The native API exposes `assistant.quick-discovery` and `assistant.quick-discovery-status` (compatibility epoch 229). `check` requests one run; `pause` stops future admission without cancelling an in-flight run. The assistant master switch still owns shutdown and disables all background work.

`quietHours: {start: "01:00", end: "08:30", timeZone: "Asia/Shanghai"}` optionally suppresses idle fallback wakes during that daily window (start inclusive, end exclusive, including cross-midnight windows). New observed activity and explicit `check` requests still run; an already running check is not cancelled. Lightweight source observations continue without model calls. Sources without lightweight observation also wait until outside this window for their idle fallback. Skipping a wake never advances the successful-check watermark. The window persists across restarts; omitting it preserves the setting, and `quietHours: null` disables it. No window is enabled implicitly for existing installations. The next scheduler tick after the window ends can resume an overdue idle check.

The scheduler checks permitted Session revision metadata and optional source `activityToken` observations, batching changes at the activity cadence. This is **not source synchronization**: the Feishu CLI source observes published local-cache versions, so discovery cannot see remote messages before Feishu synchronization publishes them. Adapters without a lightweight observation retain the idle fallback; status exposes unsupported/failed observations. No enumeration, index maintenance or model call is performed just to check activity. Index reads retain their existing refresh semantics.

The worker keeps one Session, receives UTC and a last-successful-check/start-of-this-run time boundary, and chooses how much recent and historical information to investigate. The boundary is a discovery checkpoint, not an index coverage declaration. New arrivals during execution remain for a later wake; failures retain the pending window and never advance it. Restart recovery reuses the worker and durable submission identities.

`QuickDiscoveryReport` durably hands user-facing discoveries, concrete offers of help and questions to the Bot with retry-safe inbox identities. Its messages contain the actual conversational text, not instructions to the Bot about wording, filtering or timing. Acceptance means delivery to the Bot inbox, not user notification or task delegation. The worker cannot delegate Matters or change schedules; it can read the existing notebook through `QuickDiscoveryNotebook` but cannot maintain it. There is no separate quick-discovery notebook and no whole-turn time limit.
