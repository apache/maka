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

`agent.fork` captures a source revision and an explicit `position`: `end`, `through_turn`, or `before_turn` with a logical Turn ID, or `start` for empty history. `before_turn` excludes the complete target Turn and accepts the first Turn to create an empty conversation. The Host resolves the boundary from canonical history in the copy transaction; clients do not need a preceding Turn or the sampled history landmarks. The returned branch retains that position, and the source conversation is unchanged.

Exposes Agent execution as native application services. `provide` registers factories; `executor` and `workhub` connect the service to the execution and coordination domains. Packages and product compositions choose which factories to activate and how to bind their imports.

The service owns its activation and delegates runs to `maka-agent-engine`. Session history, controls and tool calls use admitted scopes and original operation receipts. Files, processes, skills and other services are explicit dependencies selected by composition.

Session summaries and catalog entries expose `parentSessionId`: the session that initiated creation through an Agent call, or the source of a newly scheduled run. Direct client creation has no parent. The Host captures this immutable origin from the call context; it is separate from fork `branch` ancestry, task ownership and permissions. Sending work to an existing session preserves its parent.

Service tools select `target: { kind: "import", name: "files" }` for an imported service or `target: { kind: "export", name: "agent" }` for this Agent's own API. Own exports introduce no import or startup dependency and become callable only after publication. Both targets use the same Host admission, operation receipts and optional `confirmation` flow. Maka exposes Session browsing, history, creation, forks, metadata, archive/removal, messaging, queue and execution controls this way; schemas come from the existing [Agent contract](../api/src/contract.rs).

When workspace instructions are enabled, the selected global `AGENTS.md` body appears immediately after the builtin identity, wrapped only in `<global_instruction>` and `</global_instruction>`. `~/.maka/AGENTS.md` takes precedence; only its absence permits `~/.agents/AGENTS.md`. Other global and project instruction files follow later. Instructions are captured at admission and retained on resume. The native global-instruction API reads and saves the complete selected UTF-8 file, and prompt capture has no independent file-size cutoff. Saving checks the selected source and content revision before atomic replacement; the Assistant editor uses the shared complete-text editing and capture path.

New instruction captures select English, Simplified Chinese or Traditional Chinese from the saved Root language preference, then the configured locale, then the native environment. Explicit Auto uses the native environment. One policy snapshot supplies the language for builtin instructions, skills, default summaries and runtime guidance; tool schemas stay English and user, custom and external content stays unchanged.

Queued work, retries, resumed invocations and approved Goal/schedule chains retain their accepted language. New messages, notifications and independently admitted title/recap requests capture the current preference. Titles and recaps still request output in the user's language. Compaction preserves a reused Main prefix and localizes only newly rendered framing. Persisted language defaults to English and omits that field for English records; Chinese records use the full `zh-CN` or `zh-TW` tag.

Historical answers and thinking retain each step's requested model and any provider-reported model. History and source excerpts preserve this evidence across model changes, copies and restarts. The UI labels an unreported model as requested and imported model metadata as imported; executor output carries no inferred model identity.

The [independent public-client acceptance](../../../products/maka/cli/src/acp/tests/public_client.rs) runs the real Agent in a public Host with a controlled HTTP model, without an ACP, TUI or GPUI adapter. It verifies fenced history pagination, watch continuation, a pending question across complete client detachment and reconnect, and response followed by an exact invocation stop. The existing fixture supplies the original endpoint and epoch; reconnect does not resend the message. See the [client contract entrypoint](../api/README.md) for integration.

```sh
cargo nextest run -p maka-cli --bin maka -E 'test(independent_public_agent_client_reconnects_history_watch_and_pending_interaction)'
```

The Agent captures the model's Code Mode default or explicit `codeMode` override when it accepts a message. Queued work and resumed runs retain their original mode. A service tool can opt into Code Mode with `nestable: true`; nested calls use the same permissions, operation receipts and cleanup as direct calls. JavaScript receives the declared business result; the durable journal retains the original native receipt. Omitted `nestable` keeps the tool callable only directly. The Maka default composition enables nesting for files, processes, Web and Skills.

The model settings select `codeModeLanguage: "javascript" | "python"` independently of `codeMode`. JavaScript remains the default. Python uses the bundled Monty interpreter, with top-level await, `asyncio.gather`, JSON tool arguments and the same output/store helpers. The language is frozen when a message is accepted, including queued work and continuations; changing it applies to newly submitted messages. This does not change `maka code`, plugin JavaScript or Computer Use REPLs.

MCP tool servers can use global/project `.maka/mcp.json` and `.agents/mcp.json` files, or installation `mcpServers`. Project files require explicit user trust before startup. The native Agent supports stdio and Streamable HTTP, sharing direct/Code Mode permissions, approval and journal paths. See [MCP configuration and trust](../mcp/README.md).

The default Maka composition enables `toolDiscovery`: optional tool schemas load through `tool_search`, with loaded schemas retained across turns in the same active Host session. Code Mode can still call authorized nested tools before their descriptions are loaded. Discovery policy is captured when a message is accepted and retained on continuation. Loaded schemas and Code Mode `store`/`load` values are session-local, in-memory state; restarting the Host clears them. Committed context compaction resets the loaded schema set.

The independent `applyPatch` model override selects either patch editing or structured Write/Edit tools. Like Code Mode, it defaults on for GPT and DeepSeek models and the DeepSeek endpoint, and is frozen for queued work and continuations. Selection follows the bound Files contract and method even when a composition renames its tools. Read tools remain available, and all file operations retain their live permission checks. The connection settings model-overrides JSON accepts `codeMode` and `applyPatch` separately.

Shell tools accept an optional model-authored `title`, enabled by default. Assistant preferences can disable it for subsequent model requests; existing calls retain their complete arguments in model history. The title is recorded for display and removed only from the process-service request. Missing titles use the command as their display label.

The default Maka composition enables `todo`: `todo_read` and `todo_write` maintain a persistent checklist for the current session, including in Code Mode and read-only workspaces. Writes replace the whole list with revision checks. The UI shows reported progress and a read-only Checklist panel, with bounded pages covering up to 200 items. Checklist completion is model-reported progress, not proof that an operation succeeded.

The default Maka composition enables `automaticTitles`. Conversations created with `automaticTitle: true` receive one title attempt after their first admitted message, using the accepted model with a bounded, separately accounted request. Explicit titles, manual renames (including the unchanged placeholder), archived and managed sessions retain their names. Retries and Host restarts do not repeat an admitted title attempt; Host shutdown waits for its physical cleanup.

Automatic-title preparation, model and invalid-output failures are durable session diagnostics. Empty or output-limited responses retain their actual physical usage while recording the logical title failure. Stopping the owner and policy skips do not report title failures; uncertain persistence or cleanup retains its original recovery priority.

Model preparation and OAuth refresh failures emit Host warnings before their original cause is reduced to a public error. Warnings include a safe error category and existing connection/session identifiers when available; they exclude credentials, configuration, request content and arbitrary provider error text. Re-reading a failed refresh does not log the original failure again. Fatal queue and auxiliary-request errors record safe Host diagnostics with available owner, invocation or request identity. Diagnostics distinguish session quarantine from owner shutdown; the original recovery and resource-custody rules remain authoritative.

Model context capacity, any independent input ceiling and the compaction threshold are captured with the accepted model selection and retained across queueing and restart. Without an explicit threshold, known input capacity sets the proactive threshold at 85%; output reserve remains a separate engine calculation.

The default composition enables `recaps`. The Session recap command reads cached text; generating a new recap requires explicit confirmation of the selected model and possible charges. Each request reads at most 256 bounded history pages, keeps at most 32 KiB of history text, and limits output to 1,024 tokens and 30 seconds. Incognito mode and session access are checked even for cached reads. Refresh and original operation recovery never regenerate; an unknown request remains pending across restart. Auxiliary usage belongs to the original application operation, and shutdown waits for physical model cleanup.

The default composition enables `goals`. The Goal command creates or saves an objective with 1–100 iterations and an optional retrospective token threshold. Confirmation captures the selected model and the exact session workspace and permission boundary; a changed boundary requires renewed approval. Each iteration enters the original Agent message queue and retains its original admission and operation receipts across restart. `GoalStatus` is always discoverable and callable from Direct and Code Mode, but can report only for its own active Goal execution. A report takes effect only after normal completion and physical cleanup. Pause allows an accepted iteration to finish; Cancel targets only that Goal's original execution. Missing token counters stop budgeted continuation. Incognito mode, archived sessions and revoked authority prevent new admission; paused Host handoff requires explicit session recovery before resuming the Goal.

The default composition enables `plans`. The Plan command switches an idle conversation into Planning mode, whose tool selection permits inspection, questions and `SubmitPlan` but no workspace mutation or autonomous delegation. Submission ends that Turn without executing. Approving the displayed proposal freezes its artifact, selected model, workspace and permission boundary; implementation enters the original Agent queue. `update_plan` also works in Code Mode and reports every frozen step, but completion requires both all steps completed/skipped and successful execution with physical cleanup. Explicit resume preserves the artifact and progress while obtaining a new approval. Cancel targets only the original Plan invocation. Durable decisions, bounded read-only history and original approval receipts survive restart; stale boundaries and Incognito prevent new execution.

WorkHub coordinator conversations can select Graph or Swarm. Graph decisions and original WorkHub task assignments commit atomically; the existing task owner retains dispatch, dependency input capture, control receipts and cleanup. The five Graph tools expose published targets, bounded work/result/history reads, updates and yielding. Swarm wakes the supervisor for attention or a settled batch. Historical inputs must name selected final results from an earlier finished epoch; result inputs use bounded 16 KiB previews with complete result pagination available. Original session, epoch and permission boundaries remain enforced across stop, queueing and restart.

WorkHub task and graph notifications retain their recorded source in history and have distinct message labels.

WorkHub tasks list newest accepted work first. Each task detail includes its recorded title and acceptance time, which remain fixed across status changes and restarts. Pagination cursors preserve a position in the live list; refresh the first page to see newer work.

Reusable WorkHub presets store an explicit connection and model. New ordinary and Graph tasks resolve that target against current settings, so unrelated connection edits do not invalidate the preset. Accepted tasks retain their captured selection and tools; changing or disabling a preset does not rewrite them. New routes report unavailable presets, connections or models before accepting work.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
