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

The feature defaults **off**, including installations with existing assistant data. Enable **通用 → 启用个人助手** in Settings, beside the WorkHub switch, to expose the sidebar entry and start the three services on that Host. The switch is shared by clients of the same Host, not a desktop-only visibility preference. Its labeled conversation is excluded from the ordinary Session rail and palette. WorkHub remains separate. Opening the assistant does not import history, create indexes or enable discovery. Once its conversation is bound, missing appearance settings can trigger a one-time Bot question; asset creation waits for the user’s choice.

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

Heartbeats use the discovery and judgement instructions from code; configuration only changes cadence. Two persistent background Sessions share an append-only notebook, rather than handing off a fixed candidate list. Each worker reads the notebook from a private Markdown file and writes only its new observations (and, for judgement, feedback interpretations and proposed messages) to a per-wake JSON file. The Host persists those operations atomically; empty results are allowed. Only genuine user feedback may close or defer a topic, and newer feedback invalidates stale drafts. Judgement may reopen a topic the user closed or deferred only when its information changed: it must first append a note on that topic after the user's feedback and then record a reason, and a newer user rule overrides the reopening. Judgement also records a topic it investigated but chose not to tell the user as withheld, which is kept apart from the topic's notes (investigated) and delivery receipts (told). These are provenance and consistency checks, not a model/keyword review of recommendation quality. Judgement chooses directions from the entire notebook, considering occurrence time and current user value. Its messages go through the Bot inbox; acceptance is recorded as “reported”, never as confirmed delivery. Actual assistant conversation is shown separately. A failed judgement resumes from the notebook without repeating discovery. Both worker histories, the notebook and the configured cadence survive restart. New prompt versions reach existing Sessions once; obsolete saved custom instructions do not override them. Source history and indexes are unchanged. Existing pre-upgrade reports remain readable as historical context for the pending judgement.

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


The Bot can change its local identity with `AssistantCharacterPack({action: 'set_avatar', emoji, background?})`.
The avatar can be one emoji or an image, plus an optional `#RRGGBB` background.
`AssistantCharacterPack({action: 'set_avatar', image: "/path/to/avatar.png"})` also accepts HTTP(S) image URLs.
Generated and found images use the same setter; generation/search uses existing tools or delegated tasks.
PNG, JPEG, WebP and GIF are accepted up to 2 MiB, through the existing Session filesystem
boundary or Host public-network image loader. Markup and arbitrary URI schemes are rejected.
Validated bytes and metadata are saved atomically in the Bot database, independent of the
original file or URL. The Bot and its designated initialization Matter can write it. Reads never wake a model.
`assistant.avatar` returns lightweight metadata; `assistant.avatar-image` transfers bounded
chunks only when the image changes. Image bytes never appear in tool results/model context.
The desktop entry and assistant messages share the avatar, displayed as a rounded square.
This tool changes appearance only and does not send a message.

运行中的持续任务在每次模型请求前获得当前任务 Inbox 的动态上下文（用户追加要求和 Bot 澄清），同时刷新任务文件，不依赖 Recall。渲染上下文不会确认或消费输入；仍由 MatterRead 和提交检查维护观察边界，收尾时才消费已处理事件。已发出的模型请求或已执行的工具不会被追溯撤销；取消仍使用任务控制接口。


### Local character pack

The Host keeps one active `character-pack/` directory beside the Bot's component data:

- `persona.md`: editable identity and expression, up to 200 lines / 24 KiB. Only this
  document is loaded into the Bot's system instructions on each prompt assembly.
- `GUIDE.md`: on-demand maintenance and creative-use instructions, not automatically
  injected. The Bot role itself is unchanged.
- `manifest.json` and `assets/`: versioned catalog and independent image copies.

`AssistantCharacterPack` is directly available to the Bot worker. `read` reads `persona`
or `guide`; `write` uses the previous `revision` to detect conflicting edits. `list`
paginates metadata, `asset` resolves an ID, and `add_image` copies a generated or found
image using the existing avatar loader and its Session-file / public-network checks.
`update_asset` changes the title, kind or usage without replacing the image; `remove_asset`
removes an asset without withdrawing previously sent content or clearing the current avatar.
The guide explicitly permits autonomous changes to identity, style, the guide itself and
asset organization, respecting the user's stated preferences.
Use `AssistantCharacterPack({action: 'set_avatar', assetId})` to apply a saved image to the existing desktop and
chat avatar. Registration alone neither changes the avatar nor sends a message.
Generation and search still use the existing tools or delegated work; there is no new
image generator or execution permission. Images never enter model context as base64.

PNG, JPEG, WebP and GIF share the existing 2 MiB avatar limit. Images deduplicate by
content hash; documents and metadata use atomic replacement. Restart preserves edits
and assets, including when their original source disappears. Invalid persona content
is omitted with a repair notice rather than blocking the Bot; corrupt assets/catalogs
are reported, not silently reset. The guide contains creative suggestions and usage
rules. This initial framework does not add a desktop pet overlay, notification UI,
audio playback or an asset gallery.

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


### Sticker shelf and chat bubbles

The Bot prompt includes up to 10 textual sticker entries (title, short usage, ID),
never image bytes. The random selection is persisted separately from persona.md and
stays stable across model calls and restart. A persona revision or a new durable
compaction checkpoint refreshes it, favoring other available stickers; deleted or
reclassified entries are removed and vacancies filled without padding the catalog.
`AssistantStickerSearch` is immediately available to the Bot, accepts optional name/use
keywords and returns up to 10 matching imageUrl attachment references; an empty query samples the library.
Saved images are published as durable owner-conversation attachments, with stable IDs and
existing image archive quotas. Chat does not read the private character-pack cache path;
removing the source asset does not remove already published chat images.
Sticker assets receive a Host-generated attachment identity carrying their presentation
kind. Chat caps their thumbnail at 128 × 128 CSS pixels without enlarging small images;
clicking opens a larger preview. Normal images and avatars keep their existing layout.
`SendUser.messages[].stickerId` accepts a saved sticker ID directly, alongside optional
`text` and `summary`, or alone for a sticker-only bubble. The Host publishes the image
and adds the attachment reference without another model lookup. All images resolve
before any message is queued; failed resolution sends no partial batch. A durable receipt
keeps retries identical even after the source sticker is removed or the Host restarts.
Existing Markdown imageUrl messages remain supported; byte reads and sizing are handled by code.
A failed checkpoint lookup preserves the selection and does not block conversation.

SendUser's tool description asks for an independent summary for text longer than
200 characters. It does not require splitting long sentences or paragraphs into bubbles. These are model-facing instructions, not a new send rejection or automatic
truncation. Newlines within one item still render within one bubble. The Bot role prompt
is unchanged.


### First-run character creation

On enabled Host startup, after the assistant conversation/model is bound, a missing
persona starts one normal Matter with a durable task key. No default persona is
injected. A previously customized persona is adopted without replacement or greeting.
The initializer briefly checks available preferences, freely invents a distinctive
coherent identity when history is insufficient, and uses the same character-pack API.
Downloaded images are preferred to repeated generation; offline creation can finish
with an emoji avatar and no stickers. It never blocks the Bot loop.

Initialization identity, worker permission, preparation and introduction mode live in
Bot SQLite. Delegation publishes the worker identity before admitting its first run.
Startup retries reuse the same task key; normal Matter recovery and failure feedback
remain in charge after admission. `finish_initialization` validates a non-default
persona and a saved avatar; completion feedback uses the existing durable Inbox
message, adding first-person introduction guidance. A new user gets an introduction;
an existing conversation gets a short explanation of the new appearance. Retries keep
the same envelope, and restart neither creates another Matter nor repeats the greeting.
`assistant.character-status` exposes setup state and startup errors. Disabled assistants
do not initialize. A new installation without a conversation waits for first binding.

The standalone `AssistantSetAvatar` model tool is removed. `set_avatar` in
`AssistantCharacterPack` is the single write interface; existing avatar API reads and
stored avatars remain compatible. New image avatars are saved in the pack before
being applied to the existing UI cache.

Character creation starts from the user's characters, communities and humor, rather
than a generic assistant mascot. Stickers are reaction/meme images, not arbitrary
illustrations. Optional asset `sourceUrl` and `attribution` preserve provenance separately
from the short chat `usage` and the injected sticker shelf. Existing custom packs are
not overwritten by changes to the creation brief.

System instructions define responsibilities and work mechanisms; the character defines
speaking style. Initialization first checks user history and interests, then uses
current internet memes if no clear interests are found. It looks for suitable existing
chat stickers online and leaves the collection empty if none are available.
Authored summaries remain optional and collapsible regardless of length; the 200-character
guidance refers to visible prose, excluding image/link destinations. Stickers are rendered
outside the text disclosure and remain visible when it is collapsed.

On first character initialization, a short setup message is sent through the durable
conversation outbox without a model turn. Retries reuse its message identity. The
completion envelope snapshots the actual discovery toggle: enabled means explaining
token usage and pause/frequency options; disabled means offering to enable it, without
changing settings. If the pack contains stickers, the Bot is asked to include one with
its first introduction using a published asset URL. These onboarding instructions are
only delivered on initialization completion, not added to every Bot turn.


## Appearance onboarding and desktop pet

On a bound assistant, first-run onboarding posts one durable Inbox question for a missing character pack. `AssistantSetup` starts the existing Matter-based initializer only after the user chooses a style or accepts a random interesting character; declining is persisted. After character setup or a decline, the pet is checked separately. Existing selected pets and customized personas are preserved. A pet can match the character or be independent; changing the character does not recreate the pet. Pending delegation retries reuse their task identity across restarts.

`AssistantPetPack` exposes requirements, list, status, create and select. Creation validates and installs local assets without selecting them. Selection updates the current Host's desktop settings; the local desktop watches those settings and loads the selected pet without a restart. A remote Host selection does not activate a pet on the local machine. The floating window fits its visible contents and moves the bubble below the pet at the top edge.

## Quick proactive help

`QuickDiscoveryControl` enables a separate ordinary discovery Session. It defaults to off; enabling it does not enable or change the broad discovery schedule. `intervalMinutes` defaults to 15 and `idleMinutes` to 60. The native API exposes `assistant.quick-discovery` and `assistant.quick-discovery-status` (compatibility epoch 229). `check` requests one run; `pause` stops future admission without cancelling an in-flight run. The assistant master switch still owns shutdown and disables all background work.

`quietHours: {start: "01:00", end: "08:30", timeZone: "Asia/Shanghai"}` optionally suppresses idle fallback wakes during that daily window (start inclusive, end exclusive, including cross-midnight windows). New observed activity and explicit `check` requests still run; an already running check is not cancelled. Pending failed work can retry inside the window after its retry deadline, while still respecting pause, worker execution and user-interaction admission guards. Lightweight source observations continue without model calls. Sources without lightweight observation also wait until outside this window for their idle fallback. Skipping a wake never advances the successful-check watermark. The window persists across restarts; omitting it preserves the setting, and `quietHours: null` disables it. No window is enabled implicitly for existing installations. The next scheduler tick after the window ends can resume an overdue idle check.

The scheduler checks permitted Session revision metadata and optional source `activityToken` observations, batching changes at the activity cadence. This is **not source synchronization**: the Feishu CLI source observes published local-cache versions, so discovery cannot see remote messages before Feishu synchronization publishes them. Adapters without a lightweight observation retain the idle fallback; status exposes unsupported/failed observations. No enumeration, index maintenance or model call is performed just to check activity. Index reads retain their existing refresh semantics.

The worker keeps one Session, receives UTC and a last-successful-check/start-of-this-run time boundary, and chooses how much recent and historical information to investigate. The boundary is a discovery checkpoint, not an index coverage declaration. New arrivals during execution remain for a later wake; failures retain the pending window and never advance it. Restart recovery reuses the worker and durable submission identities.

`QuickDiscoveryReport` durably hands user-facing discoveries, concrete offers of help and questions to the Bot with retry-safe inbox identities. Its messages contain the actual conversational text, not instructions to the Bot about wording, filtering or timing. Acceptance means delivery to the Bot inbox, not user notification or task delegation. The worker cannot delegate Matters or change schedules; it can read the existing notebook through `QuickDiscoveryNotebook` but cannot maintain it. There is no separate quick-discovery notebook and no whole-turn time limit.


The shared notebook also retains actual quick-discovery message deliveries and explicitly linked `DiscoveryFeedback` replies. Receipt synchronization runs before each quick or two-stage wake and before `QuickDiscoveryNotebook` reads. It replays the Bot's durable receipts with stable IDs, so a crash or worker Session replacement does not lose delivery memory or duplicate entries. Unsent reports, filtered candidates and ordinary conversation are excluded. Quick receipts without a notebook topic appear separately, without inventing research topics; feedback may establish rules for future related topics. The quick worker remains read-only.

The quick-discovery, exploration and judgement Sessions use native history compaction, not timed Session replacement. Their default proactive threshold is 70% of the model input window, without a fixed token cap (no fallback threshold is inferred if the window is unknown). An explicit model compaction threshold takes precedence. Runtime usage triggers compaction at a safe request boundary, retaining a durable summary and current work; this is not a time or execution limit. Bot, Matter and ordinary Session policies are unchanged. Notebook receipts and user feedback live outside compacted history and are available on later wakes. Controlled tests verify the plumbing, not a guarantee that compaction improves discovery quality.

### Continuous event intake (opt-in)

`QuickDiscoveryControl({action:"enable", eventIntake:true,
intakeModelKey:"connection-slug::model-id"})` enables the input path alongside the
existing quick-discovery worker. `eventIntake:false` disables input processing;
`pause` disables both paths. The existing global assistant switch still closes
all background work. No source is installed or authorized implicitly. Omit
`intakeModelKey` to use the owner model; a configured small model is recommended
for the single tool-free classification call. An invalid model target fails
visibly, never silently falls back. Calls use the Host credential/usage path.

Every five seconds the input reader checks supported sources without invoking a
model. Sources implementing `changes(cursor, limit, caller)` provide durable
adapter-owned positions and original references, including changes to old
objects. First contact establishes the current position instead of treating all
history as new activity. Scope changes establish a new baseline. This is an
input receipt position, **not** `coveredCursor` and never advances an index.
Unsupported sources retain periodic discovery; generated memory is context,
not an independent activity trigger.

Each received page and its cursor commit together to the private quick-discovery
SQLite database. Replays are deduplicated by source/event ID. A short burst is
grouped by source/conversation and rotated fairly across groups. Oldest and newest
pending records both make progress; records outside the current batch remain
pending. Each group gets a share before spare space is reused.

Screening is a tool-free, stateless call. Its input is only `{now, events}`: source
and conversation groups containing occurrence time, content and kind/title.
There are no model-facing receipt IDs or per-record selection labels. Any quote already in source content stays
intact. It does not query owner conversation, tasks, indexes or old events, and
does not maintain a screening notebook or search index. The investigator retrieves
that context when a specific clue warrants it. Opaque receipt/authorization
metadata and full originals remain in SQLite rather than repeated in the prompt.

Screening batches use the selected model's resolved context window/input limit,
including user overrides, instead of a fixed character limit. The input budget is
90% of the smaller of the input limit and context window minus the output reserve
(2,048 tokens, capped by the model's output limit). Full serialized input and the
system prompt are counted with a conservative UTF-8-byte estimate plus framing,
not an exact provider tokenizer. Unknown capacity is a visible configuration error;
records remain pending. Host rechecks capacity immediately before sending.
An oversized record is durably split to fit the selected model, preserving the
original and fragment offsets. Remaining records are processed in later batches;
no source content is silently cut to fit a request.

The output is a single JSON string: one short direction such as
`"The card deployment may not have taken effect"`, or `""` when no wake is useful.
All input records in a successful call advance to `screened`; this only means the
wake decision has read them, not that any underlying matter was investigated.
A nonempty direction creates a durable wake hint atomically with that progress.
There is no selected-event queue or model-authored investigation checklist.
Host-only references retain authorization checks; they are not sent as work items.

Malformed/truncated output and provider failures leave inputs pending and back off
those groups. Source failures retain positions, report through Bot and do not
block healthy sources. Permissions are checked before and after screening and
again before a direction is shown to the worker. Transient permission-check
failures retain a hint; revoked evidence invalidates it. Source text and generated
hints are reference material, never authorization or instructions.

Receipts coalesce for 1.5 seconds. A direction requests a wake of the ordinary quick
discovery Agent without waiting for the periodic cadence. Multiple pending hints
coalesce into one wake, with identical direction text shown once. Hints arriving
during execution stay pending for a subsequent wake. The wake carries current
time and short directions, explicitly described as possibly inaccurate/incomplete.
The worker uses its existing global discovery instructions, reads sources/indexes/
history as it judges useful, and may investigate a different direction or stay
quiet. There is no event-reading tool, per-event report acknowledgement or finish
hook requiring every event to be investigated. QuickDiscoveryReport only hands
user-facing messages to Bot, which retains SendUser/Matter routing.

Successful execution consumes the captured wake hints atomically with activation
completion, even if no notification was warranted. Failures preserve the wake and
existing delivery IDs for retry. Event wakes do not postpone the independently
scheduled periodic fallback. Upgrade preserves originals, cursors and reports;
unfinished legacy selected-event records return to pending screening, and legacy
activations no longer carry a mandatory event checklist. Old search tables and
historical event statuses may remain unused on disk. QuickDiscoveryStatus.intake
separately exposes receipt/screening counts, wake delivery counts, source errors
and the last call's direction and estimated model input budget. None of these
counts is an independent-matter count or a measure of investigation completeness.

The optional `scripts/plugins/codex-source` adapter supports Codex session changes
and Computer History appended complete records. Files/database updates are polled
locally; this is not a live subscription to all applications or private messages.
No change feed can recover observations never recorded by its upstream source.
