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

# Agent Plugins

[简体中文](README.zh-CN.md)

`plugins/agent/` implements Maka's conversation engine, model protocols, collaboration Rooms, tool orchestration, and external agent integrations. Crates follow a strict one-way dependency order so persisted state, deterministic reconciliation, and live OS capabilities cannot tangle:

| Layer | Crates | Role |
| --- | --- | --- |
| Pure data & contracts | [`facts/`](facts/src/lib.rs), [`api/`](api/src/lib.rs), [`ports/`](ports/src/lib.rs) | Canonical persisted fact types, public RPC/tool schemas (`schemars`), and abstract execution traits |
| Storage & folding | [`state/`](state/src/lib.rs) | SQLite migrations on `RootStore`, atomic fact commits, history snapshots, FTS/Recall indexes, and deterministic state projections |
| Execution loop | [`engine/`](engine/src/lib.rs), [`tools/`](tools/src/lib.rs), [`tool-catalog/`](tool-catalog/src/lib.rs) | Durable obligation-frontier reconciler, context compaction, and V8/Python Code Mode cells |
| Model & MCP protocols | [`provider-protocol/`](provider-protocol/src/lib.rs), [`model/`](model/src/lib.rs), [`providers/`](providers/src/lib.rs), [`mcp/`](mcp/src/lib.rs) | Pure-Rust OpenAI Responses, Chat Completions, Anthropic Messages, OAuth/API-key providers, and `rmcp` stdio/Streamable-HTTP clients |
| Auxiliary features | [`assistant/`](assistant/src/lib.rs), [`goal/`](goal/src/lib.rs), [`scheduler/`](scheduler/engine/src/lib.rs), [`session-title/`](session-title/src/lib.rs), [`session-recap/`](session-recap/src/lib.rs), [`session-import/`](session-import/src/lib.rs), [`insights/`](insights/src/lib.rs), [`acp-executor/`](acp-executor/native/src/lib.rs) | System prompts & Recall tools, persistent Goals, cron/interval schedules, auto-titling, session recaps/imports, analytics, and ACP subprocess executors |
| Live Host owner | [`authority/`](authority/src/lib.rs), [`native/`](native/src/lib.rs) | Activation custody, workspace permission intersection, RPC handlers, `Session*` tools, and built-in external CLI drivers |

## Sessions, Rooms, and collaboration tools

Workbench clients consume granular RPC methods on [`maka-agent-api`](api/src/contract.rs) (`observe`, `history`, `watch`, `create`, `send`, `fork`, etc.), while agents interact with conversations and Rooms through seven human-symmetric tools plus `Read`:

- **`Read("maka://session/<id>")`** — Renders a clean Markdown digest of any readable Agent conversation or Room (pinned to a consistent `through` watermark across pages), linking full tool outputs at `maka://session/<id>/tool-results/<event-id>`.
- **`SessionList` / `SessionRead`** — Search conversations or inspect metadata, active/latest `RunId` status, blockers, pending questions, queued messages, and paged transcripts in one call.
- **`SessionCreate`** — Creates an Agent conversation or shared Room (`kind: "room"`), optionally branching via `forkFrom`, allocating a managed Git `worktree`, or applying a subagent `presetId`.
- **`SessionSend`** — Posts to a Room (with atomic `@mentions` and `replyTo`) or sends/steers a message to an Agent session. Agent-to-worker sends default to `onComplete: "notify_caller"`, waking the caller with an inline `<worker_result>` summary when the worker finishes.
- **`SessionRespond` / `SessionStop` / `SessionManage`** — Answer worker questions/approvals, stop active runs, edit queued messages, continue terminal runs, or update/archive/restore/remove sessions.

## Subagent presets

## Ordinary memory records

The Agent service exposes `memories`, `memory`, `memoryHistory` and `changeMemory`; see the [contract](api/src/contract/memory.rs). Trusted management callers can create, correct, mark as always-used, suppress and explicitly restore records in a personal or Host-resolved project scope. Updates use revision CAS; content versions, user-operation sources and body-free receipts commit on the original Root. Suppression retains matching content but hides it from normal reads and history.

The existing settings preferences API controls `memory.enabled` and `memory.agentReadEnabled`. Model reads require current execution authority and both switches; user management remains available when model reading is disabled. This stage does not expose a model write tool, inject always-used records, or perform semantic deduplication. Those consumers must use the same records and suppression boundary.

Clients resolve selected conversation text with `memorySource`, page evidence with `memoryEvidence`, and attach it to a specific assertion with `changeMemory.add_evidence`. The Host verifies the owned conversation, immutable message identity, fingerprint and text span at commit. Assertion metadata records kind, statement and temporal validity. `create.incognito` establishes an immutable memory privacy boundary inherited by derived sessions; it does not erase conversation history.

## Subagent preset management

## MCP servers

`maka-agent-mcp` connects to stdio and Streamable HTTP MCP servers via `rmcp`, surfacing their tools across direct calls, `tool_search`, and JavaScript/Python Code Mode under the same approval and receipt pipeline. Configure global or per-project servers in **Settings → MCP servers** (or portable `.mcp.json` files); ACP clients can also attach ephemeral session-scoped MCP servers on session load.

Configured MCP servers are trusted extensions: stdio servers execute as the Host OS user outside workspace file sandboxes, receiving a minimal environment plus explicitly configured secrets.

## External CLI executors

Enabling `claude`, `codex`, or `antigravity` under `agent.external.runtimes` lets sessions run installed native CLIs directly in the project workspace (Claude Code over an interactive PTY, Codex via its managed `app-server`, and Antigravity over ACP) while keeping Maka's durable session history, Host MCP bridge, editable message queue, and live steering:

- **Native prompts & instruction sync** — External CLIs keep their own native system prompts. Maka delivers `<maka_system_instructions>` once per digest change without overriding native prompts or re-injecting unchanged instructions across background wake-up turns.
- **Honest settlement** — Each task runs under `TaskOwner` custody. Process exit, silence, or EOF alone never marks a turn successful without protocol-level completion evidence, and unconfirmed interruptions never trigger blind prompt replay.
