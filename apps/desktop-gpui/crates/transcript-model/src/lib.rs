/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Pure logic that folds Runtime Host subscription frames into a renderable
//! transcript. No GPUI, no I/O, no clock: the same inputs always give the
//! same [`Transcript`] and the same [`Change`] list, which is what the replay
//! tests assert.
//!
//! # Use
//!
//! 1. `subscription.open` → [`Transcript::bootstrap`], then send
//!    `subscription.ready` (the Host holds frames until then).
//! 2. Every routed `subscription.*` frame → [`Transcript::apply_frame`]
//!    (or [`Transcript::apply`] with an already decoded frame). Coalescing
//!    UI notifications to about 8 Hz is the caller's job; this crate never
//!    delays anything.
//! 3. On [`Change::TranscriptBehind`], issue `session.transcript.page` with
//!    [`Transcript::transcript_request`] and feed the result to
//!    [`Transcript::apply_transcript_page`]. For older history, read
//!    [`Transcript::older_request`] when the reader asks for it (and again at
//!    once while [`Transcript::older_read_incomplete`]); the same call
//!    prepends its rows.
//! 4. Feed the snapshot `interaction.answer` returns to
//!    [`Transcript::apply_interaction`].
//! 5. On [`Change::NeedsReopen`], close the subscription, open a new one, and
//!    bootstrap a new transcript. On [`Change::Closed`], reopen unless the
//!    reason is `session_removed` or `access_revoked`.
//!
//! The mapping from the TypeScript sources and the Phase 2 list live in
//! `docs/transcript-model.md`.
//!
//! # TODO(phase-2)
//!
//! - Secondary redaction of streamed text and Tool output (`redactSecrets`,
//!   `streaming-display-redaction.ts`) and the Tool output caps
//!   (`tool-output-stream.ts`).
//! - Tool progress and subagent previews (`tool_progress`,
//!   `tool_result_preview`), shell-run folding, system notes, token totals,
//!   the context-compaction row, provider-retry countdowns.
//! - The message queue and the timestamp splice of steering messages the
//!   live stream missed (`overlayLiveTurn`'s deferred steering).
//! - Side conversations, revisions, and branches.

pub mod edits;
mod live;
mod materialize;
mod stream;
mod transcript;
mod view;

pub use stream::{
    ASSISTANT_CHUNK_MARKER, ASSISTANT_MAX_DELTA_UNITS, ASSISTANT_MAX_TOTAL_UNITS,
    ASSISTANT_TOTAL_MARKER, FoldError, Recovery, StreamCaps, StreamText, THINKING_CHUNK_MARKER,
    THINKING_MAX_DELTA_UNITS, THINKING_MAX_TOTAL_UNITS, THINKING_TOTAL_MARKER,
    apply_stream_complete, apply_stream_delta, utf16_len,
};
pub use transcript::{BootstrapError, Change, ReopenReason, Transcript};
pub use view::{
    InteractionItem, InteractionState, ItemKey, Resolution, TextItem, ThinkingItem, ToolItem,
    ToolOutputChunk, ToolStatus, TurnFailure, TurnItem, TurnView, TurnViewStatus, UserItem,
};
