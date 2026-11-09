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

# maka-agent-native

[简体中文](README.zh-CN.md)

[`CheckpointPublisher`](src/checkpoints.rs) binds the admitted native Session
namespace and original `RecoveryRef` to Root-owned history capture and recovery.
The [service adapter](src/owner/checkpoints.rs) exposes explicit management methods
with Host admission, original receipt authorization and bounded subscription reads.
Publication receipts resolve checkpoint success without fabricating generic Host
cleanup confirmation. See the [API workflow](../api/README.md#history-checkpoint-management)
and [manual baseline](src/owner/tests/checkpoints/benchmark.rs). Model tools and
cross-Root activation remain outside this API.

The [inspection adapter](src/owner/checkpoints/load.rs) adds exact checkpoint loading and bounded history/artifact queries through the same Host management boundary. Loaded history stays in isolated storage with its original IDs; it is never registered with this Owner's execution or message recovery. Query `historyCheckpointLoadReceipt` using the original operation and input after an uncertain reply. Workspace publication and explicit same-Root directory restoration are handled by the [Session adapter](src/owner/checkpoints/session.rs) and [restore adapter](src/owner/checkpoints/restore.rs). They retain conditional consistency warnings, require explicit target permissions/model selection, and never auto-send a message. See the [supported scope](../api/README.md#workspace-publication-and-local-continuation).

`agent.fork` captures a source revision and an explicit `position`: `end`, `through_turn`, or `before_turn` with a logical Turn ID, or `start` for empty history. `before_turn` excludes the complete target Turn and accepts the first Turn to create an empty conversation. The Host resolves the boundary from canonical history in the copy transaction; clients do not need a preceding Turn or the sampled history landmarks. The returned branch retains that position, and the source conversation is unchanged.

Exposes Agent execution as native application services. `provide` registers factories; `executor` connects the service to the execution domain. Packages and product compositions choose which factories to activate and how to bind their imports.

The service owns its activation and delegates runs to `maka-agent-engine`. Session history, controls and tool calls use admitted scopes and original operation receipts. Files, processes, skills and other services are explicit dependencies selected by composition.

Session summaries and catalog entries expose `parentSessionId`: the session that initiated creation through an Agent call, or the source of a newly scheduled run. Direct client creation has no parent. The Host captures this immutable origin from the call context; it is separate from fork `branch` ancestry, task ownership and permissions. Sending work to an existing session preserves its parent.

Service tools select `target: { kind: "import", name: "files" }` for an imported service or `target: { kind: "export", name: "agent" }` for this Agent's own API. Own exports introduce no import or startup dependency and become callable only after publication. Both targets use the same Host admission, operation receipts and optional `confirmation` flow. Maka exposes Session browsing, history, creation, forks, metadata, archive/removal, messaging, queue and execution controls this way; schemas come from the existing [Agent contract](../api/src/contract.rs).

The built-in `external` executor directly runs agy’s native `--print= --input-format stream-json --output-format stream-json` or the actual interactive Claude Code CLI, and connects to the shared Codex app-server daemon through `maka_process`. Enable each runtime under `external.runtimes` and select its required native ID: `antigravity`, `codex`, or `claude`. Optional `external.commands` overrides provide ordinary executable, arguments and environment settings; an existing Codex daemon retains its native startup environment and configuration. Install and log in with the native CLI; discovery does not install software or invent authentication/model capabilities. Claude exposes native default model selection without a print-mode helper.

Native assistant output preserves agy `step_index`, Codex item IDs and Claude API `message.id` (not each JSONL row UUID). Explicit message start/end boundaries keep commentary, tools and later answers in native order during streaming and after refresh or cancellation. Completion points to the last completed nonempty body message instead of replacing earlier output with a whole-run aggregate. Codex reasoning text/summaries and Claude thinking remain separate thinking content and never replace that final answer. The documented agy headless stream does not expose thinking text; token counts and effort settings are not a substitute.

agy and Claude retain one process per invocation; Codex uses the native managed daemon. Maka calls the idempotent `codex app-server daemon start` and opens a WebSocket connection through `codex app-server proxy`, reusing an already running daemon across conversations and turns. Maka never stops or restarts that shared daemon. Each invocation retains its own journal, connection and Host bridge owner. agy launches with `--dangerously-skip-permissions` on every new/resume; Codex must confirm `never` approval and `dangerFullAccess` on open/resume and receives the same policy on each turn.

Claude starts an empty, real screen-reader PTY with `--dangerously-skip-permissions` and a precommitted UUID. Maka handles the native theme/security/bypass setup and confirms workspace trust only when the native dialog names this invocation's exact canonical, already-authorized workspace; Claude itself persists that decision. Login still belongs to the user. Maka waits for the interactive prompt and this invocation's Host MCP catalog before sending input. Multiple PNG/JPEG/GIF/WebP uploads are pasted by immutable materialized path, acknowledged individually by native image number, followed by bracketed-paste text and a single Enter. Native JSONL admission must match the text, native image labels and complete image-block count. Terminal control characters are represented visibly and CRLF line endings normalized; Maka instructions are a separate ordinary user message, not a native system-prompt override. Native question/plan callbacks must use the captured Host equivalents; unrecognized dialogs fail explicitly rather than guessing answers. Codex Stop interrupts only the correlated turn and waits for its terminal notification; proxy exit alone never releases a submitted-turn fence. A CLI supporting native daemon/proxy is required; no private-server fallback is started. Complete Claude JSONL `turn_duration` records after the current prompt fence prove the turn ended, not API success; `isApiErrorMessage` rows remain failures; Stop hooks, terminal redraws, silence and process exit do not.

`SessionSend` defaults to steering active Codex and Claude executions; explicit `delivery: "queue"` and contributed service executors start a later invocation without interrupting. Codex uses `turn/steer` with the captured thread and active-turn precondition. Claude pastes additional inputs into the same PTY and presses ordinary Enter: this preserves its native busy-input queue rather than forcing send-now, cancellation or a replacement process. Every submitted Claude input must match a native user row before the final assistant/`turn_duration` can settle the shared Host invocation; intermediate durations cannot discard queued input. Steering preserves message identities, sender attribution, original receipts and the captured tool ceiling; it closes obsolete Host interactions without answering or approving them. Native notifications remain owned through acknowledgement rejection/cancellation, and an explicitly rejected input is not silently treated as delivered to the native model or replayed.

All three runtimes keep their original system prompts. Captured Maka instructions are wrapped in `<maka_system_instructions>` and submitted as a distinct ordinary user message before the actual task, never prefixed into that task. Native setup runs once; a durable delivered digest avoids repeating unchanged instructions. Changed or cleared instructions are explicitly delivered as a replacement before later tasks, without overriding native system prompts. Codex appends the message through native `thread/inject_items` without starting an extra model turn. Claude confirms the bootstrap message/result in the same PTY before submitting the task; bootstrap assistant text is not the human answer.

agy discovery uses the native `agy models` TSV catalog, preserving model/effort IDs across Gemini, Claude and GPT-OSS. Execution uses the same native CLI rather than ACP or a separate gateway/account store. Its conversation-private `--add-dir` plugin supplies the captured Host MCP endpoint and current invocation credentials without changing the user's settings or login. MCP loads lazily after the first user message. Initial setup persists native identity and opens Host admission before the separate bootstrap; the first task follows bootstrap completion and catalog confirmation. Subsequent invocations submit the actual task directly when instructions are unchanged, allowing the new client to discover MCP without an extra model turn. Cumulative native `num_turns` is not an invocation identifier. Uploaded images use ordered temporary path/media-type attachments in the task, with no tool-specific instructions, and remain owned until physical settlement. Native image-reading tool results can enter the model context; this does not establish a particular model's visual capability or remaining quota.

The per-invocation agy setting is `queuedMessages: "send-immediately"`, but 1.5.0 print/stream dispatch remains serial. On Unix, busy `SessionSend` therefore defaults to soft interruption and continuation: persist the follow-up, send SIGINT only to the owned process group, and wait for the correlated native terminal, accepted Host effects and physical exit before starting the queued invocation with the same native conversation ID. The original invocation is cancelled, not relabelled as an in-place steer. Explicit `delivery: "queue"` never interrupts. Missing terminal evidence or forced cleanup retains the uncertainty fence and cannot start a replacement. Windows has no safely owned console interrupt in the current pipe transport; busy steering fails explicitly there, and callers can use `delivery: "queue"`. No ACP fallback is retained.

The [official headless protocol](https://antigravity.google/docs/cli/headless/#stream-prompts-from-stdin) defines per-turn results, cumulative counters, text-only input blocks and unsupported control messages. Closing stdin waits for the active turn; it is not a substitute for interruption. Private-plugin Host wrappers use native server name `maka_maka`; unrelated native MCP tools remain visible, including DONE steps containing `tool_info.error`.

Native protocol frames, Claude JSONL rows and authenticated Host MCP requests share a 256 MiB memory guard, not a user attachment-size or image-count limit. Twenty 5 MiB images alone require about 134 MiB as base64 in one row. Pre-ack notifications have no count cutoff: their retained budget is also 256 MiB, charging at least 1 KiB per event for object overhead. Setup/RPC acknowledgement waits allow five minutes; Claude text acknowledgement/admission also allows another second per 32 KiB. These are not whole-turn execution deadlines; cancellation remains available. Cleanup/drain deadlines and unknown-effect fences remain independent.

History handoff reads indexed reverse pages up to 8 MiB of readable text / 64 MiB encoded source, without a fragment-count cutoff. Page boundaries do not insert artificial truncations inside a field; a genuinely omitted prefix is still explicit. This is a context/memory budget, not a guarantee that every model accepts that much context. Codex discovery follows native `nextCursor` pages before Host/UI pagination. Native Codex provider/feature `--config`, `--enable` and `--disable` settings are permitted; per-request full-access / never-approval policy remains mandatory.

Native identities, history watermarks and CAS fences use the `maka.agent.external` namespace, a deployment/instance prefix and a conversation/runtime key hash. Running records block the next invocation as unknown until the original effect is settled. The executor reads only the current journal format; storage and configuration migration must happen offline before activation.

The bounded opt-in test `native_external_real_runtime_host_tool_and_exact_resume` verifies a real Host tool receipt and two turns on the same native session. Select `MAKA_NATIVE_REAL_RUNTIME=antigravity|codex|claude`; optional `MAKA_NATIVE_REAL_COMMAND` accepts a private `NativeCommand` JSON launch override, with model, effort and workspace set through `MAKA_NATIVE_REAL_MODEL`, `MAKA_NATIVE_REAL_EFFORT` and `MAKA_NATIVE_REAL_CWD`. For visual verification, `MAKA_NATIVE_REAL_IMAGES` accepts a JSON array of PNG paths and `MAKA_NATIVE_REAL_IMAGE_ANSWER` contains the expected visible four-digit numbers, separated by spaces. Only the images, never that expected answer, are sent on turn one; turn two must recall them without reattaching. Run with `cargo test -p maka-agent-native --lib native_external_real_runtime_host_tool_and_exact_resume -- --ignored`.

External runtimes use only the captured, safe Host catalog: Skills, structured questions, supported Session orchestration, plugin management and eligible Recall tools. Calls retain live Maka identity, authorization, confirmation, ToolJournal records and original operation receipts. Cancellation closes admission, requests cancellation and drains every admitted effect before settling the native process and output streams. The Session's tool list limits this Host catalog; the CLI keeps its native tools and full mode.

The bridged Files `Read` tool only accepts Session attachment and archived-result resources, including bounded `page.next` continuations; it rejects workspace files, task resources and image output. Large Host results remain readable through the same archive resource path. CUA, Session metadata/archive/removal, Goal and scheduled execution tools are not exposed by this bridge. Third-party MCP configurations are not automatically forwarded.

Windows commands must select a native `.exe` or explicitly invoke `node.exe` with CLI-script arguments. `.cmd`/`.bat` shims fail with an actionable diagnostic rather than being implicitly passed through a shell.

Host tools use a conversation-scoped local HTTP MCP endpoint and stable private configuration paths while the Host activation remains live. Each invocation captures immutable definitions. A reduced invocation tool selection can retain advertised definitions for caching while rejecting unavailable calls; additions or changed definitions refresh the catalog only after the prior invocation has settled. Descriptions and plugin updates do not invalidate conversation identity. Every invocation receives a fresh bearer and isolated MCP transport sessions, not shared authority. Codex refreshes thread-scoped `http_headers`; Claude and agy atomically refresh credentials at the existing configuration paths. Closed credentials and old transport sessions cannot borrow the next invocation's authority. Accepted calls retain their original invocation and operation receipts through cancellation/disconnection. Idle conversations keep only the endpoint/catalog/configuration; session removal and Host shutdown release them after physical settlement. Host restart creates a new listener and private directory, and captures the current catalog while retaining native identity, the completed setup marker and delivered instruction digest. Credentials never appear in argv or logs.

When workspace instructions are enabled, the selected global `AGENTS.md` body appears immediately after the builtin identity, wrapped only in `<global_instruction>` and `</global_instruction>`. `~/.maka/AGENTS.md` takes precedence; only its absence permits `~/.agents/AGENTS.md`. Built-in model sessions also append the other global and project instruction files. External Codex, Claude and agy sessions receive only Maka identity, the selected global preferences and Maka tool/skill guidance (plus any configured Maka role). The CLI owns discovery and loading of its native global and project rules; Maka does not copy those files into the injected block or disable native discovery. The workspace-instruction preference controls Maka capture, not CLI-native loading. Maka instructions are captured at admission and retained on resume. The native global-instruction API reads and saves the complete selected UTF-8 file, and prompt capture has no independent file-size cutoff. Saving checks the selected source and content revision before atomic replacement; the Assistant editor uses the shared complete-text editing and capture path.

New instruction captures select English, Simplified Chinese or Traditional Chinese from the saved Root language preference, then the configured locale, then the native environment. Explicit Auto uses the native environment. One policy snapshot supplies the language for builtin instructions, skills, default summaries and runtime guidance; tool schemas stay English and user, custom and external content stays unchanged.

Queued work, retries, resumed invocations and approved Goal/schedule chains retain their accepted language. New messages, notifications and independently admitted title/recap requests capture the current preference. Titles and recaps still request output in the user's language. Compaction preserves a reused Main prefix and localizes only newly rendered framing. Persisted language defaults to English and omits that field for English records; Chinese records use the full `zh-CN` or `zh-TW` tag.

Historical answers and thinking retain each step's requested model and any provider-reported model. History and source excerpts preserve this evidence across model changes, copies and restarts. The UI labels an unreported model as requested and imported model metadata as imported; executor output carries no inferred model identity.

The [independent public-client acceptance](../../../products/maka/cli/src/acp/tests/public_client.rs) runs the real Agent in a public Host with a controlled HTTP model, without an ACP, TUI or GPUI adapter. It verifies fenced history pagination, watch continuation, a pending question across complete client detachment and reconnect, and response followed by an exact invocation stop. The existing fixture supplies the original endpoint and epoch; reconnect does not resend the message. See the [client contract entrypoint](../api/README.md) for integration.

```sh
cargo nextest run -p maka-cli --bin maka -E 'test(independent_public_agent_client_reconnects_history_watch_and_pending_interaction)'
```

The Agent captures the model's Code Mode default or explicit `codeMode` override when it accepts a message. Queued work and resumed runs retain their original mode. A service tool can opt into Code Mode with `nestable: true`; nested calls use the same permissions, operation receipts and cleanup as direct calls. JavaScript receives the declared business result; the durable journal retains the original native receipt. Omitted `nestable` keeps the tool callable only directly. The Maka default composition enables nesting for files, processes, Web, Skills, deployment/UI plugin management and Session/Model coordination tools, alongside built-in checklist, Goal, Recall, scheduled-task and Bot `SendUser` tools; provider-executed tools, turn-finishing tools (`sleep`), Computer Use REPL tools and `AskUserQuestion` remain direct-only.

The model settings select `codeModeLanguage: "javascript" | "python"` independently of `codeMode`. JavaScript remains the default. Python uses the bundled Monty interpreter, with top-level await, `asyncio.gather`, JSON tool arguments and the same output/store helpers. The language is frozen when a message is accepted, including queued work and continuations; changing it applies to newly submitted messages. This does not change `maka code`, plugin JavaScript or Computer Use REPLs.

MCP tool servers can use global/project `.maka/mcp.json` and `.agents/mcp.json` files, or installation `mcpServers`. Project files require explicit user trust before startup. The native Agent supports stdio and Streamable HTTP, sharing direct/Code Mode permissions, approval and journal paths. See [MCP configuration and trust](../mcp/README.md).

The default Maka composition enables `toolDiscovery`: optional tool schemas load through `tool_search`, with loaded schemas retained across turns in the same active Host session. Code Mode can still call authorized nested tools before their descriptions are loaded. Discovery policy is captured when a message is accepted and retained on continuation. Loaded schemas and Code Mode `store`/`load` values are session-local, in-memory state; restarting the Host clears them. Committed context compaction resets the loaded schema set.

The independent `applyPatch` model override selects either patch editing or structured Write/Edit tools. Like Code Mode, it defaults on for GPT and DeepSeek models and the DeepSeek endpoint, and is frozen for queued work and continuations. Selection follows the bound Files contract and method even when a composition renames its tools. Read tools remain available, and all file operations retain their live permission checks. The connection settings model-overrides JSON accepts `codeMode` and `applyPatch` separately.

Shell tools accept an optional model-authored `title`, enabled by default. Assistant preferences can disable it for subsequent model requests; existing calls retain their complete arguments in model history. The title is recorded for display and removed only from the process-service request. Missing titles use the command as their display label.

The default Maka composition enables `todo`: `todo_read` and `todo_write` maintain a persistent checklist for the current session, including in Code Mode and read-only workspaces. Writes replace the whole list with revision checks. The UI shows reported progress and a read-only Checklist panel, with bounded pages covering up to 200 items. Checklist completion is model-reported progress, not proof that an operation succeeded.

The default Maka composition enables `bot`, the Bot mode. `openBot` returns the installation's single Bot Session, creating it in the given workspace on first use or after the previous one was archived; the record is claimed before the Session is created, so concurrent and retried opens converge on one Session. That registered record is the only source of Bot identity: tool grants, recovery and `SendUser` all consult it, so forks and Sessions derived from the Bot are ordinary Sessions. The Bot Session is created with agent-native coordination tools (scheduled tasks, goals, recall, checklist, Session delegation/inspection and skills), and `SendUser` and `sleep` are granted by identity rather than by that list; ordinary creation cannot request either. `sleep` takes no arguments and has no duration: it ends the Turn and the Bot is woken by a user message, a background worker result or a scheduled event, each of which starts its own Turn. It is refused only while a queued message is already bound for the running Invocation's next step, and it must be called on its own, not in the same step as `SendUser`. A call records its messages in Host-owned storage kept apart from Run state, one record per call and per message: the same `messageId` with the same content is a duplicate and is not recorded again, the same id with different content is refused, and sending nothing is valid. Calls are never evicted, so a reused id is always recognized. `botOutbox` pages messages oldest first after a sequence cursor, and `watchBotOutbox` signals head and read-cursor changes. Each page carries `readThrough` and a `preview` of the latest message, at most 160 characters. `markBotRead` advances a per-Session read cursor, for a former Bot Session too; it only moves forward and cannot pass the head. Queued wakes of the Bot Session, including scheduled and worker-origin messages, continue after an unknown tool outcome with the model told rather than the tool replayed; ordinary Sessions keep the stricter rule.

The default Maka composition enables `automaticTitles`. Conversations created with `automaticTitle: true` receive one title attempt after their first admitted message, using the accepted model with a bounded, separately accounted request. Explicit titles, manual renames (including the unchanged placeholder), archived and managed sessions retain their names. Retries and Host restarts do not repeat an admitted title attempt; Host shutdown waits for its physical cleanup.

Automatic-title preparation, model and invalid-output failures are durable session diagnostics. Empty or output-limited responses retain their actual physical usage while recording the logical title failure. Stopping the owner and policy skips do not report title failures; uncertain persistence or cleanup retains its original recovery priority.

Model preparation and OAuth refresh failures emit Host warnings before their original cause is reduced to a public error. Warnings include a safe error category and existing connection/session identifiers when available; they exclude credentials, configuration, request content and arbitrary provider error text. Re-reading a failed refresh does not log the original failure again. Fatal queue and auxiliary-request errors record safe Host diagnostics with available owner, invocation or request identity. Diagnostics distinguish session quarantine from owner shutdown; the original recovery and resource-custody rules remain authoritative.

Each logical request resolves context capacity and any independent input ceiling from the current model observation, with accepted user overrides retained across queueing and restart. Without an explicit compaction threshold, known input capacity sets the proactive threshold at 85%; output reserve remains a separate engine calculation.

The default composition enables `recaps`. The Session recap command reads cached text; generating a new recap requires explicit confirmation of the selected model and possible charges. Each request reads at most 256 bounded history pages, keeps at most 32 KiB of history text, and limits output to 1,024 tokens and 30 seconds. Session access is checked even for cached reads. Refresh and original operation recovery never regenerate; an unknown request remains pending across restart. Auxiliary usage belongs to the original application operation, and shutdown waits for physical model cleanup.

The default composition enables `goals`. `/goal` or the composer’s + menu opens its panel; `/goal <objective>` starts immediately. Goals continue through the existing Session queue without an iteration limit. `CreateGoal`, `GetGoal` and `GoalStatus` work in Direct and Code Mode; the current objective, progress and budget accompany model requests, including after compaction. A model-created Goal owns its creating turn. Pause stops current work; Resume continues with the selected model and settings; Cancel targets only that Goal. Transient execution failures remain recoverable. Token budgets are optional scheduling thresholds checked between turns; missing usage is reported as incomplete rather than stopping work, and users can adjust budgets. Reads expose current usage, remaining budget and active elapsed time; completed usage stays frozen after cleanup. Original operation identities and receipts survive restart, and sealed Host handoffs use their reserved successors rather than replaying effects. Archived Sessions and changed execution prerequisites require user action before further execution.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)

[Performance baseline](checkpoint-baseline.md)

ChatGPT subscription requests use the Host-owned [account inventory](src/model/codex_inventory.rs).
Logical model-step preparation shares per-connection discovery, refreshes its five-minute
compatibility cache on demand, and retries failed discovery after a short jittered backoff.
Cancelling one waiter leaves shared work with the Host. Each request records its account,
connection and observed `comp_hash` in `ModelRequested.context`; these are provenance,
not same-account replay restrictions. Discovery does not change selected models. A fresh
Host obtains its own account observation before recording compatibility evidence.

Accepted work retains its selected model, thinking/tool policy, model overrides and body controls,
not resolved inventory capacities. Later default or presentation edits apply to subsequently
accepted messages. Each step and restored work continue using the captured user choices. Provider
identity, connection availability, credential authorization and the resolved transport route are
still checked before execution. Each logical request resolves one current model
observation into its context, capabilities, options and output budget; physical retries reuse the
already frozen request. Catalog changes alone therefore do not invalidate queued/restored work.

Goal scheduling skips authority decoding for inactive records without pending work and
isolates unreadable records, so one stored Goal cannot prevent other Goals from continuing.
All-session `Recall` searches and `catalog` pages likewise isolate unreadable session metadata
and transcript source events into reported `gaps` or skipped entries without legacy decoders,
while targeted single-session queries still surface the error directly.
New admission reads the current settings after shared discovery completes.

A cold or due ChatGPT catalog refresh is awaited during logical request preparation, including
background compaction capture. Concurrent waiters share the Host-owned request. Refresh starts
at 270 seconds to leave 30 seconds before the 300-second catalog TTL. Each discovery has a 15-second deadline; account replacement may first await the old flight and
then the new identity’s discovery. This is not a 15-second deadline for the complete model request.
Failure uses the existing model with no new compatibility claim,
then retries after a jittered 30–60-second backoff to avoid a request storm. Warm and backed-off
preparations do not wait for network discovery; credential resolution follows its existing policy.
These are local latency/load policies, not protocol
limits. The TTL governs new catalog observations; recorded producer facts and checkpoints do not
expire with that cache. Once capture finishes, proactive compaction executes alongside Main.

Connections use ordinary text summarization by default. Model connection settings expose
**Provider server-side compaction** only when the provider's configuration schema declares
`serverSideCompaction`. The setting is saved per connection; currently ChatGPT subscription
supports it. When enabled, manual and automatic compaction use the Responses native
`compaction_trigger` control.
The engine installs its opaque checkpoint only after the producing stream completes and storage
validates the same source fence and producer request. Subsequent requests replay the checkpoint
with the preserved suffix; another compact replaces that baseline. Session/global/custom text
compaction prompts remain editable and saved, but do not enter native ChatGPT compaction requests.
With the setting off, text compaction prompts apply as usual. Native checkpoints and ordinary
encrypted reasoning share hash-based replay admission, including across subscription accounts.
Incompatible native state is refused before inference; automatic conversion and smaller-window
switch preflight remain separate work.

The subscription provider selects native compaction in its resolved capabilities only when the
connection opts in. Disabling it preserves replay of existing native checkpoints; the next
compaction produces a text summary. Host freezes a single protocol operation; the Responses adapter adds the wire trigger and returns typed
`NativeCompaction` only at stream completion. Engine and EventLog do not extract provider-options
JSON for this result. Checkpoint headers retain the producing-step reference, digest and token
estimate; baseline reads derive producer/model facts from that original request.
