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

# Phase 1: MVP chat loop

Status: specification. Depends on Phase 0 (`host-protocol`, `host-client`, a documented dev Host).
Chinese overview lives in `2026-09-25-gpui-client-plan.md` §4. This file is the working spec
for implementers and is written in English so it can be handed to agents verbatim.

## Goal

One window in which a user can pick a project, create a session, send a message, watch the
assistant stream, see tool calls, answer a permission prompt, and stop a turn. Everything goes
through the Runtime Host protocol; nothing is computed locally that the Host already owns.

Acceptance: on the dev State Root, run one full turn where the model calls a tool that needs
permission, approve it, and see the result and the turn end. Open the same session in the
Electron Desktop afterwards and confirm the transcript matches.

## Work packages

Packages are ordered by dependency. P1 and P2 have no UI and can run in parallel with P3.

### P1. Protocol coverage for the MVP (`crates/host-protocol`)

Add typed operations and frames. Every type cites its TS decoder.

| Operation / frame | TS source |
|---|---|
| `session.create`, `session.configuration.update`, `session.metadata.update` | `packages/runtime-host/src/protocol/session-catalog.ts`, `session-status.ts` |
| `subscription.open`, `subscription.close` and all `subscription.*` frames | `packages/runtime-host/src/protocol/session-continuity.ts` (`SubscriptionOpenInput/Result`, `SessionProjectionFrame`, `SessionDeltaFrame`, `SessionEventFrame`, `SessionToolEvent`, `SessionTranscriptAdvancedFrame`, `SessionDomainChangedFrame`, `AgentGraphChangedFrame`, `SubscriptionClosedFrame`) |
| `session.transcript.page` | `protocol/session-transcript.ts` |
| `turn.start`, `turn.stop`, `turn.query`, `turn.interrupt` | `protocol/turn.ts` (`TurnStartInput`: `sessionId`, `turnId`, `content: MessageContent`, optional `skillIds`, `turnOrchestration`, `maxSteps`; `TurnSnapshot`, `TurnRunStatus`) |
| `interaction.query`, `interaction.answer` | `protocol/interaction.ts` and `packages/core/src/interaction.ts` (kinds `permission`, `question`, `form`, `sandbox_boundary`, `client_capability`; answers `permission_answer`, `question_answer`, `closure`) |
| `project.catalog.query`, `project.catalog.mutate` | `protocol/project-catalog.ts` |
| connection and model catalog queries | `protocol/connection-effects.ts`, `protocol/configuration.ts`; find the operation names by grepping `defineOperation(` |
| `session_catalog_changed`, `project_catalog_changed`, `connection_catalog_changed` frames | `protocol/session-catalog-change.ts`, `project-catalog-change.ts`, `connection-catalog-change.ts` |
| Runtime events carried by frames | `packages/core/src/events.ts`, `canonical-runtime-event.ts` |

Model only the fields the MVP reads. Keep the rest as `serde_json::Value` behind a clearly
named field so nothing is silently dropped when re-encoding fixtures.

### P2. Transcript state machine (`crates/transcript-model`)

Port the logic that turns subscription frames into a renderable transcript. No GPUI dependency.

TS sources to port, in this order:

1. `packages/ui/src/live-turn-projection.ts` (766 lines): the live turn projection.
2. `packages/ui/src/stream-delta.ts` (249 lines): coalescing assistant deltas.
3. `packages/ui/src/materialize.ts` (1163 lines): materializing durable events into turn items.
   Port the subset the MVP renders: user message, assistant text, tool call with input, tool
   result, interaction prompt and answer, turn status. Skip reasoning, redaction, and
   side-conversation handling in this phase and leave a `TODO(phase-2)` list in the module doc.

Public shape (adjust names to the code, keep the idea):

- `Transcript` holds ordered `TurnView`s; each `TurnView` holds ordered `TurnItem`s keyed by a
  stable id (`messageId`, `toolCallId`, `interactionId`).
- `Transcript::apply(frame: &SubscriptionFrame) -> Vec<Change>` where `Change` names what moved
  (item added, item text appended, item state changed, turn finished) so the UI can notify
  narrowly.
- `Transcript::bootstrap(open_result)` seeds from `SubscriptionOpenResult.snapshot` and the
  optional transcript tail.
- Sequence handling: frames arrive with `sequence`; a gap or a `hostEpoch` change is reported as
  `Change::NeedsReopen`, never patched over (see runtime-host-architecture.md §7).

Tests: replay fixtures. Record at least three sequences from the dev Host with the capture
script: a plain text answer, a turn with a tool call that triggers a permission prompt and is
approved, and a turn stopped by the user. Assert the final `Transcript` and the change list.

### P3. Application shell and views

Crates: `app`, `shared`, `workspace`, `session`, `conversation`. Read the gpui-kit coding and
design guides before starting. Use gpui-kit components; do not hand-roll buttons, inputs, lists.

Layout (desktop conventions, see design guide "Layout patterns"):

- `TitleBar` with the connected Host name and connection state.
- Left `Sidebar`: project selector at the top (`Select` or `Combobox`), session list below
  (`List` with `ListDelegate`, one row per session, `ElementId` from session id), "New session"
  button. Sessions come from `session.catalog.query` and update on `session_catalog_changed`.
- Center: transcript (`VirtualList` over `TurnItem`s) and the composer at the bottom
  (`Textarea` + send `Button` + stop `Button`, Enter sends, Shift+Enter newline). Decision:
  Escape only dismisses overlays and never stops a turn; Stop Turn (⌘.) and the stop button do.
- Permission prompt: rendered inline as a card in the transcript at the interaction's position,
  with `Allow` and `Deny` buttons and the tool input shown. Escape does not answer it.
- Connection state: a non-blocking `Alert` strip when disconnected, with a `Reconnect` button.
  While disconnected keep the last transcript visible.

State ownership:

- `HostSession` entity (in `workspace`): owns the `host-client` connection, spawns the read pump
  on the background executor, forwards frames to the foreground with `cx.spawn`, and emits
  typed events. One per connected Host.
- `SessionCatalog` entity (in `session`): the list, selection, loading state.
- `ConversationState` entity (in `conversation`): the `Transcript` for the open session, the
  subscription id, pending interactions, the composer draft. Applies frames at most about
  8 Hz by coalescing deltas (performance rules in `AGENTS.md`).

Markdown: render assistant text with `TextView::markdown(id, text)`. Rebuild the element per
change in this phase; measure before optimizing.

Tests: `#[gpui_kit::test]` integration tests for composer submit, permission answer, and stop,
driving the production views with a fake `host-client` transport that replays fixtures.

### P4. Dev loop

- `just run` starts the app against the dev Host from `docs/dev-host.md`. If the Host is not
  running, the app shows the disconnected strip with the command to start it; spawning the
  Host from the app is Phase 2.
- `just fixtures` records new sequences.

## Out of scope for Phase 1

Settings screens, message queue, transcript paging beyond the initial tail, reasoning display,
attachments, mentions, command palette, theming beyond system light/dark, i18n beyond English,
Windows named pipes, WebSocket transport, Host spawning from the app.
