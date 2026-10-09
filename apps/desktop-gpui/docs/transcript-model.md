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

# Transcript model

`crates/transcript-model` turns one Session subscription into a renderable
transcript. It is pure: no GPUI, no I/O, no clock. The same inputs give the
same `Transcript` and the same `Change` list, which is what the tests replay.

TypeScript references are to the Maka checkout at commit `518fd529c`
(`$MAKA_REPO`, default `~/code/maka-pin`; `MAKA_PIN` names the commit the
protocol types now follow). Paths are relative to that
checkout; `ui/` means `packages/ui/src/`, `adapter/` means
`packages/runtime-host/src/adapter/`.

## What the Desktop does, and what this crate does instead

The Electron Desktop runs four layers between the socket and React:

1. `ClientSessionSubscription` (`packages/runtime-host/src/client/session-subscription.ts`)
   checks frame order and reassembles transcript fragments.
2. `RuntimeHostSessionProjector` (`adapter/session-projector.ts`) folds
   assistant deltas per message and turns frames into core `SessionEvent`s.
3. `live-turn-projection.ts` / `live-turn-buffer.ts` (`ui/`) keep the live
   Turn as steps and drop what durable rows cover.
4. `materialize.ts` (`ui/`) builds Turn view models from durable
   `StoredMessage` rows and overlays the live Turn.

This crate keeps the same split of responsibilities but skips the
`SessionEvent` hop between layers 2 and 3, because the projector already
emits exact, non-overlapping tails. Everything that TS computes per render
is computed here per applied frame, for the one Turn the frame touched, and
the result is diffed against the previous view to report narrow changes.

What a transcript page carries: each fragment is a byte slice of one
durable row, and a row is a JSON `StoredMessage` (`packages/core/src/session.ts`),
not a `RuntimeEvent`. The Desktop decodes rows with `decodeStoredMessage`.
`host_protocol::StoredMessage` models user, assistant, tool call, tool
result, permission decision, and turn state rows; the rest stay JSON in
`StoredMessage::Other`.

## Inputs and outputs

| Call | Input | TS counterpart |
|---|---|---|
| `Transcript::bootstrap` | `SubscriptionOpenResult` | `ClientSessionSubscription` constructor (session-subscription.ts:177), `RuntimeHostSessionProjector` constructor and `seedActive` (session-projector.ts:102, 164), `DesktopTranscriptReplica.prepare` |
| `Transcript::apply_frame` / `apply` | `SubscriptionFrame` / `SessionFrame` | `ClientSessionSubscription.accept` (session-subscription.ts:431) then `RuntimeHostSessionProjector.accept` (session-projector.ts:359) |
| `Transcript::transcript_request` | — | `DesktopTranscriptReplica.#readToWatermark` (apps/desktop/src/main/desktop-transcript-replica.ts:425) |
| `Transcript::apply_transcript_page` | `SessionTranscriptPage` (`direction: newer`) | `#readToWatermark` + `TranscriptFragmentAssembler` (session-subscription.ts:589) |
| `Transcript::older_request` | page size in bytes | `DesktopTranscriptReplica.readOlderPage` (desktop-transcript-replica.ts:262) |
| `Transcript::apply_transcript_page` | `SessionTranscriptPage` (`direction: older`) | `readOlderPage` + `TranscriptFragmentAssembler`; rows prepended |
| `Transcript::apply_interaction` | `InteractionSnapshot` from `interaction.answer` | `publishInteractionAnswer` (apps/desktop/src/main/runtime-host-session-observer.ts) |

Output: `turns() -> &[TurnView]`, each with ordered `TurnItem`s keyed by
`ItemKey` (`User(messageId)`, `Thinking(stepId)`, `Text(stepId)`,
`Tool(toolUseId)`, `Interaction(interactionId)`), plus the `Change` list
every call returns.

## Function mapping

### Ordering and bootstrap (`src/transcript.rs`)

| Rust | TypeScript |
|---|---|
| `Transcript::apply` sequence, epoch, subscription, closed checks | `ClientSessionSubscription.accept`, session-subscription.ts:431-540 |
| projection revision must advance (`ProjectionRevisionStale`) | same, the `projection_revision_invalid` branch |
| watermark must advance (`TranscriptWatermarkStale`) | same, the `transcript_advanced` branch |
| a page must not return the cursor it was read with (`TranscriptCursorStale`) | "Session transcript cursor did not advance" in `#loadTranscriptSource` (session-subscription.ts:301, 389) |
| `apply_projection` interaction bookkeeping | `newlyPendingInteractions`, `removedPendingInteractions` (session-projector.ts:724, 736) |
| `apply_projection` new run → `Projector::start_run` | `accept`, `startedTurn` (session-projector.ts:421-450) |
| `apply_projection` terminal → open-stream completions + `LiveEvent::Terminal` | `accept` → `#terminalEvents` (session-projector.ts:467-471, 481-530), `sameRuntimeHostTerminalTurn` (820) → `same_terminal` |
| `bootstrap` seeding | constructor (session-projector.ts:102-154) and `seedActive` text seeding (164-204) |
| `apply_root_status` | not in TS as one function: the Desktop shows the live root status from the snapshot; `TurnRunStatus` → `TurnViewStatus` |
| `store_rows` / `insert_rows` | `DesktopTranscriptReplica.#installDurable` (desktop-transcript-replica.ts) |
| `attach_interactions` | none (see Deviations) |
| `diff_turn` | none; replaces React re-render with narrow `Change`s |

### Live projection (`src/live.rs`)

| Rust | TypeScript |
|---|---|
| `Projector::fold` | `accept`, `subscription.session_delta` branch (session-projector.ts:361-398), accumulators keyed by `Part` and message as `accumulatorKey` (806) |
| `Projector::seed` | constructor seeding durable `thinking` and text, then active streams of both kinds (session-projector.ts:102-154) |
| `StreamText::fold` (`src/stream.rs`) | `foldRuntimeHostAssistantDelta` (session-projector.ts:707-722) |
| `Projector::admit_steering` | `accept`, steering dedupe (session-projector.ts:401-409) |
| `Projector::open_streams` | `#terminalEvents` accumulator loop (session-projector.ts:483-494) |
| `apply` | `applyLiveTurnBufferEvent` (ui/live-turn-buffer.ts:32) |
| `LiveTurn::apply` | `projectLiveTurnEvent` (ui/live-turn-projection.ts:221-587): steering 226-251, step resolution 297-348, thinking 350-387, text 388-426, Tools 427-531, content order 532-538, finalize 571-585 |
| `LiveTurn::place_step` | the Tool relocation in `projectLiveTurnEvent` (live-turn-projection.ts:539-570) |
| `LiveTurn::terminalize` | `terminalizeLiveSteps` (live-turn-projection.ts:152) and the `complete`/`error`/`abort` branches (258-276) |
| `LiveTurn::completion_remainder` | `completionRemainder` (live-turn-projection.ts:600) |
| `apply_tool_event` | the `tool_*` branches of `projectLiveTurnEvent`, with `projectSessionEvent` (session-projector.ts:630) folded in |
| `reconcile` | `reconcileLiveTurnBuffer` (ui/live-turn-buffer.ts:51) |
| `reconcile_terminal` | `reconcileTerminalLiveTurn` (live-turn-projection.ts:703) |
| `durable_stream_evidence` | `durableStreamEvidence` (live-turn-projection.ts:673) |
| `settle_step` | `settleLiveTurnStep` (live-turn-projection.ts:643) |

### Streams (`src/stream.rs`)

| Rust | TypeScript |
|---|---|
| `apply_stream_delta` | `applyStreamDelta` (ui/stream-delta.ts:120), recovery `head`, via `applyAssistantDelta` (ui/assistant-stream.ts:65) |
| `apply_stream_complete` | `applyStreamComplete` (ui/stream-delta.ts:221) via `applyAssistantComplete` (assistant-stream.ts:84) |
| `StreamCaps::ASSISTANT` | `ASSISTANT_MAX_DELTA_CHARS`, `ASSISTANT_MAX_TOTAL_CHARS` (assistant-stream.ts:54-55), en-US markers from `ui/shared-ui-copy.ts` |
| `StreamCaps::THINKING`, `Recovery::Tail` | `THINKING_MAX_DELTA_CHARS`, `THINKING_MAX_TOTAL_CHARS`, `applyThinkingDelta`/`applyThinkingComplete` (ui/thinking-stream.ts), tail recovery in `applyStreamDelta` with `truncateStreamingDisplayTail` (ui/streaming-display-redaction.ts:267) |
| per-delta cut | `truncateStreamingDisplayAppend` (ui/streaming-display-redaction.ts:239) without the redaction state |

### Materialize (`src/materialize.rs`)

| Rust | TypeScript |
|---|---|
| `materialize_turn` | the per-Turn part of `materializeTurns` (ui/materialize.ts:696-822) with `deriveTurnRecords` (packages/core/src/session.ts:1954) |
| `infer_legacy_status` | `inferLegacyTurnStatus` (session.ts:2001) |
| `materialize_tools` | `materializeTools` (materialize.ts:192) with `unfinishedToolActivityStatus` (packages/core/src/tool-result-status.ts:55) |
| `tool_result_status` | `toolResultActivityStatus`, `isCancelledToolResultContent` (tool-result-status.ts:79, 62) |
| `build_timeline` | `buildTurnTimeline` (materialize.ts:974-1071), `thinking` entries included |
| `overlay_live_turn` | `overlayLiveTurn` (materialize.ts:397-597) |
| `merge_live_over_persisted` | `mergeLiveOverPersisted` (materialize.ts:254) |
| `ItemKey` | `timelineItemKey` (materialize.ts:1102) |

### Protocol helpers (`crates/host-protocol`)

| Rust | TypeScript |
|---|---|
| `TranscriptAssembler` | `TranscriptFragmentAssembler` (session-subscription.ts:589-730) |
| `SessionTranscriptPageInput::newer` | the read in `#readToWatermark` (desktop-transcript-replica.ts:425) |
| `SessionTranscriptPageInput::older` | the read in `readOlderPage` (desktop-transcript-replica.ts:262) |
| `SubscriptionFrame::decode` → `SessionFrame` | `decodeSubscriptionFrame` (packages/runtime-host/src/protocol/session-continuity.ts:394) |

## Deviations from TypeScript, and why

- **Text settles without a reveal animation.** TS keeps a non-terminal
  Turn's live text until the renderer's reveal callback calls
  `settleLiveTurnStep`. This client has no reveal, so `reconcile` settles a
  step as soon as its live text is complete and its durable assistant row
  exists. The item keeps its key; the change is one `ItemUpdated`.
- **Interaction items.** The Desktop shows prompts outside the transcript
  (`projectRuntimeHostInteractionRequest` returns nothing for permissions).
  The Phase 1 spec puts the prompt inline, so `attach_interactions` inserts
  an `Interaction` item right after the Tool it names (or at the end of the
  Turn). A durable `permission_decision` row settles the live record with
  the same id, or, failing that, the permission record of the same Tool;
  the item keeps the key it was first shown under.
- **Sandbox-boundary prompts.** They name no Tool, so they go at the end of
  their Turn. The `answered` snapshot `interaction.answer` returns carries
  `InteractionCanonicalSandboxBoundaryOutcome`, which `apply_interaction`
  turns into `Resolution::SandboxBoundary { decision, status }` (`status`
  tells an applied `approved` from an allowed but unapplied `conflict`),
  also when a projection already dropped the prompt as `Unknown`. No
  `StoredMessage` records the decision (the runtime's
  `sandbox_boundary_decision_ack` event is not a transcript row), so after a
  reopen only a still-pending prompt reappears.
- **Opening message as an item.** `TurnViewModel.user` is a separate field
  in TS; here the prompt is the first item, so a list over items renders a
  whole Turn.
- **Tools are not grouped.** TS merges adjacent Tools into one `tools`
  entry (`mergeAdjacentTimeline`); grouping is presentation.
- **Reasoning blocks are not merged.** TS joins adjacent settled `thinking`
  entries with a blank line under the first one's key; here each step's
  reasoning stays its own `Thinking(stepId)` item, so keys never change
  when a later step settles.
- **A settle waits for both streams.** A step is settled against its
  durable assistant row once its text and its reasoning are complete; a
  step holding only reasoning stays live until its assistant row exists
  (`reconcileTerminalLiveTurn`, live-turn-projection.ts:733).
- **No `replaySafeDelta`.** TS needs it because events may replay across a
  steering boundary; the projector's tails already exclude replayed text.
- **UTF-16 cuts never split a character.** Offsets and caps count UTF-16
  units as JS does; where JS would cut inside a surrogate pair, this cuts
  before it. A delta whose offset lands inside a pair is a stream conflict.
- **Failures reopen.** Where TS throws (`sequence_gap`, delta gap or
  conflict, malformed frame), this reports `Change::NeedsReopen` once and
  stops changing.
- **Unknown future frames are skipped** when they carry the next sequence,
  and ignored when they carry none. TS rejects unknown kinds.
- **Older history arrives whole Turns at a time.** The bootstrap tail's
  cursor, and every older page's, continue backwards at the tail's
  watermark (the Host binds a cursor to its subscription, Session,
  direction, and `throughSequence`; `session-transcript-pager.ts:181`). A
  row cut at a page edge stays in the older assembler until the next page
  completes it; complete rows are held back until a page reports
  `endsAtTurnBoundary`, so a Turn never shows without its prompt, and
  `older_read_incomplete` tells the owner to read the next page at once.
  The page size is the caller's: the conversation asks for 64 KiB where
  the Desktop asks for 512 KiB, so reaching the top adds a few Turns. A
  refused cursor (`invalid_request`) reopens; the new transcript starts
  from a fresh tail and older Turns read before are read again when the
  reader scrolls up (the Desktop reads back down to `resumeFrom`).

## Tests

- `tests/replay.rs` replays `crates/host-protocol/fixtures/sequences/*.jsonl`
  recorded from a real Host and asserts the final transcript and every
  change. It also checks that `transcript_request()` (and, for older pages,
  `older_request()`) asks for exactly the page read the recorder issued.
  `long_history.jsonl` (`scripts/capture-fixtures.sh --long-history <dir>`)
  is a five-Turn Session with 6.5 KiB prompts, reopened with the 16 KiB tail
  and paged back with 4 KiB older pages, so prompt rows split across pages.
  `reasoning.jsonl` is a Turn of `qwen3:0.6b` that streams reasoning
  (`--only-sequence reasoning`). `message_queue.jsonl` submits four
  messages with `turn.message.submit` and drives the queue commands.
- `tests/synthetic.rs` covers the text, permission, sandbox-boundary, and
  mid-stream stop flows on frames built in code, plus gap, epoch, divergence, stale
  projection, and malformed frame handling. When the dev Host's model
  connection works, record the real sequences
  (`scripts/capture-fixtures.sh --sequences /private/tmp/maka-gpui-fixture-workspace`)
  and add replay tests for `plain_text`, `permission_allow`, and
  `stop_mid_stream`.
- Unit tests in `src/stream.rs` (delta folding, UTF-16 offsets, caps) and
  `src/materialize.rs` (timeline order, unfinished Tools).

## Phase 2

- ~~Reasoning~~: done (`Thinking` items, tail-keep caps); the secondary
  redaction below applies to it too.
- Secondary redaction: `redactSecrets` and `streaming-display-redaction.ts`
  on assistant text and Tool output; `tool-output-stream.ts` caps.
- Tool progress (`decodeToolStepProgress`), subagent previews
  (`materializeToolResultPreviewForActivity`), shell-run folding
  (`foldShellRunToolActivities`, `foldShellRunUpdates`).
- System notes, token totals, duration, the context-compaction row,
  provider-retry countdowns (`liveProviderRetryEvent`).
- ~~Older history~~: done (see Deviations); left: reading back down to the
  oldest held row after a reopen, and a tail that itself ends inside a Turn
  (`endsAtTurnBoundary: false` on the bootstrap) still shows that Turn
  partly until the first older page.
- Message queue: the queue itself is read from the continuity snapshot by
  the conversation (`SessionMessageQueueProjection`); steering renders
  from `steering_message` events and the durable steering rows
  (`message_queue.jsonl`). Left: the steering row placement by timestamp
  (`overlayLiveTurn`'s deferred steering splice).
- Side conversations, revisions, branches, lineage (`deriveTurnLineageMap`).
- Performance: cache each Turn's materialized base and invalidate it only
  when that Turn's rows change, so a delta rebuilds the overlay alone;
  replace linear Turn lookups with an index if long Sessions need it.
