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

//! The transcript state machine: bootstrap, frame application, durable
//! catch-up, and change reporting.
//!
//! Frame ordering follows `ClientSessionSubscription.accept` in
//! `packages/runtime-host/src/client/session-subscription.ts`: a frame of a
//! different Host epoch or subscription, a sequence other than the next one,
//! a projection revision that does not advance, or a transcript watermark
//! that does not advance ends the subscription. Here that is reported once
//! as [`Change::NeedsReopen`] and the transcript stops changing; the owner
//! opens a new subscription and bootstraps a new transcript. Nothing is
//! patched over.
//!
//! Durable rows arrive through `session.transcript.page` reads the owner
//! issues after [`Change::TranscriptBehind`] (the Desktop's
//! `DesktopTranscriptReplica.advance`); [`Transcript::transcript_request`]
//! builds the next read. Older history is read on demand, one page at a
//! time, with [`Transcript::older_request`] (the Desktop's `readOlderPage`);
//! its rows are prepended.

use std::collections::{BTreeMap, HashMap, HashSet};

use host_protocol::{
    InteractionOutcome, InteractionRequest, InteractionSnapshot, InteractionStatus,
    SessionContinuitySnapshot, SessionFrame, SessionFrameEvent, SessionTranscriptPage,
    SessionTranscriptPageInput, StoredMessage, SubscriptionClosedReason, SubscriptionFrame,
    SubscriptionOpenResult, TranscriptAssembler, TranscriptAssemblyError, TranscriptDirection,
    TranscriptEntry, TurnRunStatus, TurnSnapshot, TurnStatus,
};
use thiserror::Error;

use crate::live::{self, DeltaOutcome, LiveEvent, LiveTurn, Part, Projector};
use crate::materialize::{live_only_turn, materialize_turn, overlay_live_turn};
use crate::stream::FoldError;
use crate::view::{
    InteractionItem, InteractionState, ItemKey, Resolution, TurnFailure, TurnItem, TurnView,
    TurnViewStatus,
};

/// Rows without a `turnId` (none are written today) are grouped here, as
/// `materializeTurns` does.
const LOOSE_TURN_ID: &str = "__loose";

/// What an update moved, so the UI can notify narrowly.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Change {
    /// A Turn appeared at `index` of [`Transcript::turns`]. Its items are not
    /// reported separately.
    TurnAdded {
        turn_id: String,
        index: usize,
    },
    TurnRemoved {
        turn_id: String,
    },
    /// Status, failure, or model of the Turn changed.
    TurnUpdated {
        turn_id: String,
    },
    /// The Turn reached a terminal status.
    TurnFinished {
        turn_id: String,
        status: TurnViewStatus,
    },
    ItemAdded {
        turn_id: String,
        key: ItemKey,
        index: usize,
    },
    /// Only text was appended to a text item.
    ItemTextAppended {
        turn_id: String,
        key: ItemKey,
    },
    ItemUpdated {
        turn_id: String,
        key: ItemKey,
    },
    ItemRemoved {
        turn_id: String,
        key: ItemKey,
    },
    /// Existing items changed their relative order.
    ItemsReordered {
        turn_id: String,
    },
    /// A new continuity snapshot: session status, root Turn, or pending
    /// interactions may have changed.
    SessionStateChanged,
    /// Durable rows through `through_sequence` exist that this transcript has
    /// not read; issue [`Transcript::transcript_request`].
    TranscriptBehind {
        through_sequence: u64,
    },
    /// The Host closed the subscription.
    Closed {
        reason: SubscriptionClosedReason,
    },
    /// This transcript can no longer follow the subscription; open a new one.
    NeedsReopen {
        reason: ReopenReason,
    },
}

/// Why the subscription must be reopened.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum ReopenReason {
    #[error("expected frame {expected} but received {received}")]
    SequenceGap { expected: u64, received: u64 },
    #[error("the Host epoch changed")]
    HostEpochChanged,
    #[error("a frame names a different subscription or Session")]
    CorrelationChanged,
    #[error("the projection revision did not advance")]
    ProjectionRevisionStale,
    #[error("the transcript watermark did not advance")]
    TranscriptWatermarkStale,
    /// A `session.transcript.page` answered with the cursor it was read
    /// with, so reading on would repeat the same read forever. The TS client
    /// fails the read as `correlation_changed` ("Session transcript cursor
    /// did not advance", `#loadTranscriptSource` in
    /// packages/runtime-host/src/client/session-subscription.ts).
    #[error("the transcript cursor did not advance")]
    TranscriptCursorStale,
    #[error("a subscription frame could not be decoded: {0}")]
    MalformedFrame(String),
    #[error("an assistant stream diverged: {0}")]
    StreamDiverged(FoldError),
    #[error("the durable transcript could not be read: {0}")]
    TranscriptCorrupt(String),
}

/// Why a transcript could not be bootstrapped.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum BootstrapError {
    #[error("the transcript tail could not be reassembled")]
    Transcript(#[from] TranscriptAssemblyError),
    #[error("the transcript tail is inconsistent: {0}")]
    Inconsistent(ReopenReason),
}

/// The renderable state of one Session subscription.
#[derive(Debug)]
pub struct Transcript {
    session_id: String,
    subscription_id: String,
    host_epoch: String,
    next_sequence: u64,
    snapshot: SessionContinuitySnapshot,
    /// The newest announced durable watermark.
    watermark: Option<u64>,
    /// Durable rows through this watermark have been applied.
    durable_through: Option<u64>,
    /// Where older history continues; `None` once the first row is held.
    older: Option<Older>,
    /// At least one older page was applied.
    paged_older: bool,
    /// Set when the rows held begin inside a Turn: the tail stopped part
    /// way through one (`endsAtTurnBoundary` false, or a row cut at its
    /// edge). The Turns with a row at or before this sequence, the tail's
    /// newest, may not hold their first rows. Cleared once older rows are
    /// prepended, which always begin at a Turn's start, or the first row is
    /// held.
    partial_through: Option<u64>,
    catch_up: Option<CatchUp>,
    durable: BTreeMap<u64, StoredMessage>,
    durable_by_turn: HashMap<String, Vec<u64>>,
    durable_users: HashSet<String>,
    /// Turns in order of first appearance.
    turn_order: Vec<String>,
    projector: Projector,
    live: Vec<LiveTurn>,
    interactions: Vec<InteractionRecord>,
    views: Vec<TurnView>,
    closed: Option<SubscriptionClosedReason>,
    reopen: Option<ReopenReason>,
}

/// A multi-page durable read in progress.
#[derive(Debug)]
struct CatchUp {
    assembler: TranscriptAssembler,
    through: Option<u64>,
    cursor: String,
}

/// Older history that can still be read: the cursor the last older page
/// (or the bootstrap tail) returned, the watermark the Host bound it to, the
/// assembler that holds a row cut at that page's edge until the next page
/// completes it, and the complete rows of a Turn the pages have not read to
/// its start yet.
#[derive(Debug)]
struct Older {
    assembler: TranscriptAssembler,
    through: Option<u64>,
    cursor: String,
    /// Oldest first; prepended once a page ends at a Turn boundary.
    held: Vec<TranscriptEntry>,
}

/// Where newly read rows go relative to the rows already held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// Catch-up and the tail: after everything held.
    Newest,
    /// Older history: before everything held.
    Oldest,
}

/// An interaction this transcript has seen, live or durable.
#[derive(Debug, Clone)]
struct InteractionRecord {
    interaction_id: String,
    turn_id: String,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    request: Option<InteractionRequest>,
    state: InteractionState,
}

impl InteractionRecord {
    fn from_snapshot(snapshot: &InteractionSnapshot) -> Self {
        let tool_name = match &snapshot.request {
            InteractionRequest::Permission(request) => {
                request.prompt.tool_name().map(str::to_owned)
            }
            _ => None,
        };
        Self {
            interaction_id: snapshot.interaction_id.clone(),
            turn_id: snapshot.turn_id.clone(),
            tool_use_id: snapshot.tool_use_id().map(str::to_owned),
            tool_name,
            request: Some(snapshot.request.clone()),
            state: state_of(snapshot),
        }
    }

    fn is_permission(&self) -> bool {
        matches!(self.request, None | Some(InteractionRequest::Permission(_)))
    }
}

fn state_of(snapshot: &InteractionSnapshot) -> InteractionState {
    match (&snapshot.status, &snapshot.outcome) {
        (InteractionStatus::Pending, _) => InteractionState::Pending,
        (_, outcome) => InteractionState::Resolved(resolution_of(outcome.as_ref())),
    }
}

fn resolution_of(outcome: Option<&InteractionOutcome>) -> Resolution {
    match outcome {
        Some(InteractionOutcome::PermissionAnswer(answer)) => Resolution::Permission {
            decision: answer.decision.clone(),
            remember_for_turn: answer.remember_for_turn,
        },
        Some(InteractionOutcome::QuestionAnswer(answer)) => {
            Resolution::Question { answers: answer.answers.clone() }
        }
        Some(InteractionOutcome::SandboxBoundaryDecision(outcome)) => Resolution::SandboxBoundary {
            decision: outcome.decision.clone(),
            status: outcome.status.clone(),
        },
        Some(InteractionOutcome::Closure(closure)) => Resolution::Closed(closure.reason.clone()),
        Some(_) => Resolution::Other,
        None => Resolution::Unknown,
    }
}

impl Transcript {
    /// Seeds a transcript from `subscription.open`: the snapshot, pending
    /// interactions, the live root Turn's open streams, and the durable tail.
    ///
    /// A row cut at the edge of the tail waits for the first older page
    /// ([`Transcript::older_request`]), which starts with its missing bytes.
    pub fn bootstrap(open: &SubscriptionOpenResult) -> Result<Self, BootstrapError> {
        let mut transcript = Self {
            session_id: open.snapshot.session.session_id.clone(),
            subscription_id: open.subscription_id.clone(),
            host_epoch: open.host_epoch.clone(),
            next_sequence: open.next_sequence,
            snapshot: open.snapshot.clone(),
            watermark: None,
            durable_through: None,
            older: None,
            paged_older: false,
            partial_through: None,
            catch_up: None,
            durable: BTreeMap::new(),
            durable_by_turn: HashMap::new(),
            durable_users: HashSet::new(),
            turn_order: Vec::new(),
            projector: Projector::default(),
            live: Vec::new(),
            interactions: Vec::new(),
            views: Vec::new(),
            closed: None,
            reopen: None,
        };
        if let Some(bootstrap) = &open.transcript {
            let page = &bootstrap.durable;
            if page.direction != TranscriptDirection::Older {
                return Err(BootstrapError::Inconsistent(ReopenReason::TranscriptCorrupt(
                    "the tail is not an older page".into(),
                )));
            }
            let mut assembler = TranscriptAssembler::new(TranscriptDirection::Older);
            assembler.accept(&page.fragments)?;
            let entries = assembler.take_complete();
            // The Host cuts a tail back to the last point between Turns; it
            // stops inside one only when a single Turn fills it, so the
            // Turns it holds are the one that reaches its start and those
            // nested in it.
            let cut = !page.ends_at_turn_boundary || assembler.continuation_bytes().is_some();
            if page.next_cursor.is_some() && cut {
                transcript.partial_through = entries.iter().map(|entry| entry.sequence).max();
            }
            transcript.older = page.next_cursor.clone().map(|cursor| Older {
                assembler,
                through: page.through_sequence,
                cursor,
                held: Vec::new(),
            });
            transcript.durable_through = page.through_sequence;
            transcript.watermark = page.through_sequence;
            transcript
                .store_rows(entries, Placement::Newest)
                .map_err(BootstrapError::Inconsistent)?;
        }
        transcript.interactions = open
            .snapshot
            .interactions
            .pending
            .iter()
            .map(InteractionRecord::from_snapshot)
            .collect();
        if let Some(root) =
            open.snapshot.root_turn.as_ref().filter(|root| !root.status.is_terminal())
        {
            let rows = rows_of(&transcript.durable_by_turn, &transcript.durable, &root.turn_id);
            let active: Vec<(Part, String)> = open
                .active_assistant_streams
                .iter()
                .filter(|stream| stream.turn_id == root.turn_id)
                .filter_map(|stream| Some((Part::of(&stream.kind)?, stream.message_id.clone())))
                .collect();
            transcript.projector.seed(&root.turn_id, &rows, &active);
            // `seedActive`: an open stream shows what is already known of it;
            // the Host resends the in-flight text from offset 0 after ready.
            for (part, message_id, text, _) in transcript.projector.open_streams(&root.turn_id) {
                if !text.is_empty() {
                    live::apply(
                        &mut transcript.live,
                        LiveEvent::Delta {
                            part,
                            turn_id: &root.turn_id,
                            message_id: &message_id,
                            text,
                        },
                    );
                }
            }
        }
        let turns = transcript.turn_order.clone();
        for turn_id in turns.iter().chain(transcript.interaction_turns().iter()) {
            transcript.rebuild(turn_id);
        }
        Ok(transcript)
    }

    /// Applies a routed subscription frame. A frame that cannot be decoded
    /// is a protocol violation and asks for a reopen.
    pub fn apply_frame(&mut self, frame: &SubscriptionFrame) -> Vec<Change> {
        match frame.decode() {
            Ok(decoded) => self.apply(&decoded),
            Err(error) => self.reopen(ReopenReason::MalformedFrame(error.to_string())),
        }
    }

    /// Applies one decoded subscription frame.
    pub fn apply(&mut self, frame: &SessionFrame) -> Vec<Change> {
        if self.reopen.is_some() {
            return Vec::new();
        }
        if frame.host_epoch() != Some(self.host_epoch.as_str()) {
            return self.reopen(ReopenReason::HostEpochChanged);
        }
        if frame.subscription_id() != Some(self.subscription_id.as_str()) {
            return self.reopen(ReopenReason::CorrelationChanged);
        }
        if let SessionFrame::RuntimeResourcePtyData(_) = frame {
            // Unordered terminal bytes; terminals are out of MVP scope.
            return Vec::new();
        }
        let Some(sequence) = frame.sequence() else {
            // A future unordered frame kind, like PTY data: nothing to order
            // or render.
            return match frame {
                SessionFrame::Unknown(_) => Vec::new(),
                _ => self.reopen(ReopenReason::MalformedFrame("frame without a sequence".into())),
            };
        };
        if self.closed.is_some() {
            return self.reopen(ReopenReason::CorrelationChanged);
        }
        if sequence != self.next_sequence {
            return self.reopen(ReopenReason::SequenceGap {
                expected: self.next_sequence,
                received: sequence,
            });
        }
        self.next_sequence += 1;
        match frame {
            SessionFrame::Projection(frame) => self.apply_projection(&frame.snapshot),
            SessionFrame::Delta(frame) => {
                if frame.session_id != self.session_id {
                    return self.reopen(ReopenReason::CorrelationChanged);
                }
                self.apply_delta(&frame.delta)
            }
            SessionFrame::Event(frame) => {
                if frame.session_id != self.session_id {
                    return self.reopen(ReopenReason::CorrelationChanged);
                }
                self.apply_event(&frame.event)
            }
            SessionFrame::TranscriptAdvanced(frame) => {
                if frame.session_id != self.session_id {
                    return self.reopen(ReopenReason::CorrelationChanged);
                }
                if self.watermark.is_some_and(|watermark| frame.through_sequence <= watermark) {
                    return self.reopen(ReopenReason::TranscriptWatermarkStale);
                }
                self.watermark = Some(frame.through_sequence);
                self.behind().into_iter().collect()
            }
            SessionFrame::DomainChanged(frame) => {
                if frame.session_id != self.session_id {
                    return self.reopen(ReopenReason::CorrelationChanged);
                }
                Vec::new()
            }
            SessionFrame::AgentGraphChanged(frame) => {
                if frame.root_session_id != self.session_id {
                    return self.reopen(ReopenReason::CorrelationChanged);
                }
                Vec::new()
            }
            SessionFrame::Closed(frame) => {
                self.closed = Some(frame.reason.clone());
                vec![Change::Closed { reason: frame.reason.clone() }]
            }
            _ => Vec::new(),
        }
    }

    /// Applies one `session.transcript.page` result: a catch-up page read
    /// with [`Transcript::transcript_request`] (`newer`) or a page of older
    /// history read with [`Transcript::older_request`] (`older`), whose rows
    /// are prepended.
    pub fn apply_transcript_page(&mut self, page: &SessionTranscriptPage) -> Vec<Change> {
        if self.reopen.is_some() {
            return Vec::new();
        }
        if page.session_id != self.session_id {
            return self.reopen(ReopenReason::CorrelationChanged);
        }
        match page.direction {
            TranscriptDirection::Newer => self.apply_newer_page(page),
            TranscriptDirection::Older => self.apply_older_page(page),
            _ => Vec::new(),
        }
    }

    fn apply_newer_page(&mut self, page: &SessionTranscriptPage) -> Vec<Change> {
        let read_with = self.catch_up.as_ref().map(|catch_up| &catch_up.cursor);
        if read_with.is_some() && page.next_cursor.as_ref() == read_with {
            return self.reopen(ReopenReason::TranscriptCursorStale);
        }
        let mut assembler = self.catch_up.take().map_or_else(
            || TranscriptAssembler::new(TranscriptDirection::Newer),
            |catch_up| catch_up.assembler,
        );
        if let Err(error) = assembler.accept(&page.fragments) {
            return self.reopen(ReopenReason::TranscriptCorrupt(error.to_string()));
        }
        let entries = assembler.take_complete();
        match &page.next_cursor {
            Some(cursor) => {
                self.catch_up = Some(CatchUp {
                    assembler,
                    through: page.through_sequence,
                    cursor: cursor.clone(),
                });
            }
            None if assembler.continuation_bytes().is_some() => {
                return self.reopen(ReopenReason::TranscriptCorrupt(
                    "a row ended before every fragment arrived".into(),
                ));
            }
            None => {
                self.durable_through = self.durable_through.max(page.through_sequence);
            }
        }
        let mut changes = match self.insert_rows(entries, Placement::Newest) {
            Ok(changes) => changes,
            Err(reason) => return self.reopen(reason),
        };
        changes.extend(self.behind());
        changes
    }

    /// One page of older history (`readOlderPage` in the Desktop replica).
    /// Its complete rows are prepended once the pages read so far end at a
    /// Turn boundary (`endsAtTurnBoundary`), so a Turn never shows without
    /// its start; until then they are held and
    /// [`Transcript::older_read_incomplete`] asks for the next page. A row
    /// cut at the page's edge waits for the next page. A page that arrives
    /// when no older read is possible is stale and ignored.
    fn apply_older_page(&mut self, page: &SessionTranscriptPage) -> Vec<Change> {
        let Some(mut older) = self.older.take() else {
            return Vec::new();
        };
        if page.next_cursor.as_ref() == Some(&older.cursor) {
            return self.reopen(ReopenReason::TranscriptCursorStale);
        }
        if let Err(error) = older.assembler.accept(&page.fragments) {
            return self.reopen(ReopenReason::TranscriptCorrupt(error.to_string()));
        }
        // The page's rows are older than the ones already held.
        let mut rows = older.assembler.take_complete();
        rows.append(&mut older.held);
        let whole_turns =
            page.ends_at_turn_boundary && older.assembler.continuation_bytes().is_none();
        match &page.next_cursor {
            Some(cursor) => {
                older.cursor = cursor.clone();
                if !whole_turns {
                    older.held = rows;
                    rows = Vec::new();
                }
                self.older = Some(older);
            }
            None if older.assembler.continuation_bytes().is_some() => {
                return self.reopen(ReopenReason::TranscriptCorrupt(
                    "the first row ended before every fragment arrived".into(),
                ));
            }
            None => {}
        }
        self.paged_older = true;
        // What is prepended begins at a Turn's start, or at the first row.
        if page.next_cursor.is_none() || !rows.is_empty() {
            self.partial_through = None;
        }
        match self.insert_rows(rows, Placement::Oldest) {
            Ok(changes) => changes,
            Err(reason) => self.reopen(reason),
        }
    }

    /// Records an interaction snapshot this client obtained itself, for
    /// example the `answered` snapshot `interaction.answer` returns
    /// (`publishInteractionAnswer` in the Desktop observer).
    pub fn apply_interaction(&mut self, snapshot: &InteractionSnapshot) -> Vec<Change> {
        if self.reopen.is_some() || snapshot.session_id != self.session_id {
            return Vec::new();
        }
        let record = InteractionRecord::from_snapshot(snapshot);
        match self
            .interactions
            .iter_mut()
            .find(|known| known.interaction_id == record.interaction_id)
        {
            Some(known) => {
                known.state = record.state;
                known.request = record.request.or(known.request.take());
            }
            None => self.interactions.push(record),
        }
        self.rebuild(&snapshot.turn_id)
    }

    /// The next durable read to issue, if this transcript is behind the
    /// announced watermark or in the middle of a multi-page read.
    pub fn transcript_request(&self) -> Option<SessionTranscriptPageInput> {
        if self.reopen.is_some() {
            return None;
        }
        if let Some(catch_up) = &self.catch_up {
            let mut input = SessionTranscriptPageInput::newer(
                self.subscription_id.clone(),
                catch_up.through.unwrap_or_default(),
                None,
            );
            input.through_sequence = catch_up.through;
            input.cursor = Some(catch_up.cursor.clone());
            return Some(input);
        }
        let target = self.watermark?;
        if self.durable_through.is_some_and(|through| through >= target) {
            return None;
        }
        Some(SessionTranscriptPageInput::newer(
            self.subscription_id.clone(),
            target,
            self.durable_through,
        ))
    }

    /// The next page of older history to read, `max_bytes` at most (1 to
    /// [`host_protocol::SESSION_TRANSCRIPT_PAGE_MAX_BYTES`]), or `None` once
    /// the first row is held. Read one page at a time: each continues the
    /// cursor of the one before.
    pub fn older_request(&self, max_bytes: u64) -> Option<SessionTranscriptPageInput> {
        if self.reopen.is_some() {
            return None;
        }
        let older = self.older.as_ref()?;
        Some(SessionTranscriptPageInput::older(
            self.subscription_id.clone(),
            older.through,
            older.cursor.clone(),
            max_bytes,
        ))
    }

    /// The Turns, oldest first.
    pub fn turns(&self) -> &[TurnView] {
        &self.views
    }

    /// The Turn with `turn_id`.
    pub fn turn(&self, turn_id: &str) -> Option<&TurnView> {
        self.views.iter().find(|view| view.turn_id == turn_id)
    }

    /// The item that shows the durable row `message_id`, with its Turn: a
    /// user message, a reply (or, without text, its reasoning), or a Tool
    /// call by its call row or its result row. `None` while the row is not
    /// held, or for a row no item shows (a Turn's state, a usage record).
    /// Walks the rows held: for a one-off lookup, not for every frame.
    pub fn item_of_message(&self, message_id: &str) -> Option<(String, ItemKey)> {
        let message = self.durable.values().find(|message| message.id() == message_id)?;
        let turn_id = message.turn_id().unwrap_or(LOOSE_TURN_ID);
        let turn = self.turn(turn_id)?;
        let candidates = match message {
            StoredMessage::User(user) => vec![ItemKey::User(user.id.clone())],
            StoredMessage::Assistant(assistant) => {
                vec![ItemKey::Text(assistant.id.clone()), ItemKey::Thinking(assistant.id.clone())]
            }
            StoredMessage::ToolCall(call) => vec![ItemKey::Tool(call.id.clone())],
            StoredMessage::ToolResult(result) => vec![ItemKey::Tool(result.tool_use_id.clone())],
            _ => return None,
        };
        let key = candidates.into_iter().find(|key| turn.item(key).is_some())?;
        Some((turn_id.to_owned(), key))
    }

    /// The id of the Session's durable row at `index` (0-based, in storage
    /// order), once the transcript holds the Session's first row; `None`
    /// before that, when no row is at `index`, or for a row without an id.
    pub fn message_id_at(&self, index: usize) -> Option<&str> {
        if self.older.is_some() {
            return None;
        }
        self.durable.values().nth(index).map(StoredMessage::id).filter(|id| !id.is_empty())
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }

    pub fn host_epoch(&self) -> &str {
        &self.host_epoch
    }

    /// The `sequence` the next ordered frame must carry.
    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    /// The latest continuity snapshot.
    pub fn snapshot(&self) -> &SessionContinuitySnapshot {
        &self.snapshot
    }

    /// The root Turn: its `run_id` is what `turn.stop` needs.
    pub fn root_turn(&self) -> Option<&TurnSnapshot> {
        self.snapshot.root_turn.as_ref()
    }

    /// Interactions waiting for an answer.
    pub fn pending_interactions(&self) -> &[InteractionSnapshot] {
        &self.snapshot.interactions.pending
    }

    /// Durable rows through this watermark have been applied.
    pub fn durable_through(&self) -> Option<u64> {
        self.durable_through
    }

    /// The sequence of the oldest durable row held: each page of older
    /// history moves it back, also when its rows belong to a Turn already
    /// shown.
    pub fn durable_from(&self) -> Option<u64> {
        self.durable.keys().next().copied()
    }

    /// Whether rows older than the ones held exist
    /// ([`Transcript::older_request`] reads them).
    pub fn has_older_history(&self) -> bool {
        self.older.is_some()
    }

    /// Whether older pages were read back to the Session's first row.
    pub fn reached_first_row(&self) -> bool {
        self.paged_older && self.older.is_none()
    }

    /// Whether a Turn shown may lack its first rows: the tail stopped inside
    /// it. Reading older history ([`Transcript::older_request`]) until this
    /// is false completes it.
    pub fn has_partial_turn(&self) -> bool {
        self.partial_through.is_some()
    }

    /// Whether the transcript holds Turn `turn_id`'s first row, so the Turn
    /// shows whole. A Turn the tail cut does not, and neither do the Turns
    /// nested in it, until the older pages that complete it are prepended;
    /// a Turn whose first row arrived after the tail does.
    pub fn has_turn_start(&self, turn_id: &str) -> bool {
        let Some(through) = self.partial_through else {
            return true;
        };
        self.durable_by_turn
            .get(turn_id)
            .and_then(|sequences| sequences.first())
            .is_none_or(|first| *first > through)
    }

    /// Whether the last older page stopped inside a Turn: its rows are held
    /// back until the next page ([`Transcript::older_request`]) reaches the
    /// Turn's start, so read it right away. A row the bootstrap tail cut
    /// does not count; it waits until older history is asked for.
    pub fn older_read_incomplete(&self) -> bool {
        self.older.as_ref().is_some_and(|older| {
            !older.held.is_empty()
                || (self.paged_older && older.assembler.continuation_bytes().is_some())
        })
    }

    /// Set once the transcript stopped following the subscription.
    pub fn needs_reopen(&self) -> Option<&ReopenReason> {
        self.reopen.as_ref()
    }

    /// Set when the Host closed the subscription.
    pub fn closed(&self) -> Option<&SubscriptionClosedReason> {
        self.closed.as_ref()
    }

    fn reopen(&mut self, reason: ReopenReason) -> Vec<Change> {
        if self.reopen.is_some() {
            return Vec::new();
        }
        self.reopen = Some(reason.clone());
        vec![Change::NeedsReopen { reason }]
    }

    fn behind(&self) -> Option<Change> {
        let watermark = self.watermark?;
        let behind = self.catch_up.is_some()
            || self.durable_through.is_none_or(|through| through < watermark);
        behind.then_some(Change::TranscriptBehind { through_sequence: watermark })
    }

    fn apply_projection(&mut self, snapshot: &SessionContinuitySnapshot) -> Vec<Change> {
        if snapshot.session.session_id != self.session_id {
            return self.reopen(ReopenReason::CorrelationChanged);
        }
        if snapshot.projection_revision <= self.snapshot.projection_revision {
            return self.reopen(ReopenReason::ProjectionRevisionStale);
        }
        let previous = std::mem::replace(&mut self.snapshot, snapshot.clone());
        let mut touched: Vec<String> = Vec::new();

        // `newlyPendingInteractions` / `removedPendingInteractions`.
        let previous_ids: HashSet<&str> = previous
            .interactions
            .pending
            .iter()
            .map(|pending| pending.interaction_id.as_str())
            .collect();
        let next_ids: HashSet<&str> = snapshot
            .interactions
            .pending
            .iter()
            .map(|pending| pending.interaction_id.as_str())
            .collect();
        for pending in &snapshot.interactions.pending {
            if previous_ids.contains(pending.interaction_id.as_str()) {
                continue;
            }
            touched.push(pending.turn_id.clone());
            match self
                .interactions
                .iter_mut()
                .find(|known| known.interaction_id == pending.interaction_id)
            {
                Some(known) => known.request = Some(pending.request.clone()),
                None => self.interactions.push(InteractionRecord::from_snapshot(pending)),
            }
        }
        for resolved in previous
            .interactions
            .pending
            .iter()
            .filter(|p| !next_ids.contains(p.interaction_id.as_str()))
        {
            touched.push(resolved.turn_id.clone());
            if let Some(known) = self
                .interactions
                .iter_mut()
                .find(|known| known.interaction_id == resolved.interaction_id)
                && known.state == InteractionState::Pending
            {
                known.state = InteractionState::Resolved(Resolution::Unknown);
            }
        }

        let previous_root = previous.root_turn.as_ref();
        if let Some(root) = previous_root {
            touched.push(root.turn_id.clone());
        }
        if let Some(root) = snapshot.root_turn.as_ref() {
            touched.push(root.turn_id.clone());
            let started = previous_root.is_none_or(|previous| previous.run_id != root.run_id);
            if started {
                self.projector.start_run();
            }
            if root.status.is_terminal() && !same_terminal(previous_root, root) {
                // `#terminalEvents`: close open streams, then freeze the Turn.
                for (part, message_id, text, interrupted) in
                    self.projector.open_streams(&root.turn_id)
                {
                    live::apply(
                        &mut self.live,
                        LiveEvent::Complete {
                            part,
                            turn_id: &root.turn_id,
                            message_id: &message_id,
                            text,
                            interrupted,
                        },
                    );
                }
                live::apply(&mut self.live, LiveEvent::Terminal { turn_id: &root.turn_id });
            }
        }
        self.reconcile_live();
        let mut changes = vec![Change::SessionStateChanged];
        touched.sort();
        touched.dedup();
        for turn_id in touched {
            changes.extend(self.rebuild(&turn_id));
        }
        changes
    }

    fn apply_delta(&mut self, delta: &host_protocol::SessionAssistantDelta) -> Vec<Change> {
        let outcome = self.projector.fold(delta);
        let Some(part) = Part::of(&delta.kind) else {
            return Vec::new();
        };
        let event = match outcome {
            Err(error) => return self.reopen(ReopenReason::StreamDiverged(error)),
            Ok(DeltaOutcome::None) => return Vec::new(),
            Ok(DeltaOutcome::Delta(text)) => LiveEvent::Delta {
                part,
                turn_id: &delta.turn_id,
                message_id: &delta.message_id,
                text,
            },
            Ok(DeltaOutcome::Complete { text, interrupted }) => LiveEvent::Complete {
                part,
                turn_id: &delta.turn_id,
                message_id: &delta.message_id,
                text,
                interrupted,
            },
        };
        live::apply(&mut self.live, event);
        self.reconcile_live();
        self.rebuild(&delta.turn_id)
    }

    fn apply_event(&mut self, event: &SessionFrameEvent) -> Vec<Change> {
        if let SessionFrameEvent::SteeringMessage(steering) = event
            && !self.projector.admit_steering(steering, &self.durable_users)
        {
            return Vec::new();
        }
        let Some(turn_id) = event.turn_id().map(str::to_owned) else {
            return Vec::new();
        };
        live::apply(&mut self.live, LiveEvent::Frame(event));
        self.reconcile_live();
        self.rebuild(&turn_id)
    }

    /// Stores rows without rebuilding; returns the Turns they touched. Turns
    /// seen for the first time go after the known ones, or, for older
    /// history, before them, in the order of their rows.
    fn store_rows(
        &mut self,
        entries: Vec<TranscriptEntry>,
        placement: Placement,
    ) -> Result<Vec<String>, ReopenReason> {
        let mut touched = Vec::new();
        let mut new_turns: Vec<String> = Vec::new();
        for entry in entries {
            let (sequence, message) = (entry.sequence, entry.message);
            if let Some(existing) = self.durable.get(&sequence) {
                if existing.id() != message.id() {
                    return Err(ReopenReason::TranscriptCorrupt(format!(
                        "row {sequence} changed identity"
                    )));
                }
                continue;
            }
            let turn_id = message.turn_id().unwrap_or(LOOSE_TURN_ID).to_owned();
            if let StoredMessage::User(user) = &message {
                self.durable_users.insert(user.id.clone());
            }
            let sequences = self.durable_by_turn.entry(turn_id.clone()).or_default();
            let position = sequences.partition_point(|&known| known < sequence);
            sequences.insert(position, sequence);
            self.durable.insert(sequence, message);
            if !self.turn_order.contains(&turn_id) && !new_turns.contains(&turn_id) {
                new_turns.push(turn_id.clone());
            }
            touched.push(turn_id);
        }
        match placement {
            Placement::Newest => self.turn_order.extend(new_turns),
            Placement::Oldest => {
                new_turns.append(&mut self.turn_order);
                self.turn_order = new_turns;
            }
        }
        Ok(touched)
    }

    fn insert_rows(
        &mut self,
        entries: Vec<TranscriptEntry>,
        placement: Placement,
    ) -> Result<Vec<Change>, ReopenReason> {
        let mut touched = self.store_rows(entries, placement)?;
        if touched.is_empty() {
            return Ok(Vec::new());
        }
        // A live Turn loses content to the rows that cover it.
        self.reconcile_live();
        touched.extend(self.live.iter().map(|turn| turn.turn_id.clone()));
        touched.sort();
        touched.dedup();
        let mut ordered: Vec<String> =
            self.turn_order.iter().filter(|turn_id| touched.contains(turn_id)).cloned().collect();
        ordered.extend(touched.into_iter().filter(|turn_id| !self.turn_order.contains(turn_id)));
        let mut changes = Vec::new();
        for turn_id in ordered {
            changes.extend(self.rebuild(&turn_id));
        }
        Ok(changes)
    }

    fn rows_of(&self, turn_id: &str) -> Vec<&StoredMessage> {
        rows_of(&self.durable_by_turn, &self.durable, turn_id)
    }

    fn reconcile_live(&mut self) -> bool {
        if self.live.is_empty() {
            return false;
        }
        let durable: HashMap<String, Vec<&StoredMessage>> = self
            .live
            .iter()
            .map(|turn| {
                (turn.turn_id.clone(), rows_of(&self.durable_by_turn, &self.durable, &turn.turn_id))
            })
            .collect();
        let mut live = std::mem::take(&mut self.live);
        let changed = live::reconcile(&mut live, &durable);
        self.live = live;
        changed
    }

    fn interaction_turns(&self) -> Vec<String> {
        let mut turns: Vec<String> =
            self.interactions.iter().map(|record| record.turn_id.clone()).collect();
        turns.dedup();
        turns
    }

    /// Recomputes one Turn's view from its rows, live state, and
    /// interactions, and reports what moved.
    fn rebuild(&mut self, turn_id: &str) -> Vec<Change> {
        let view = self.build_view(turn_id);
        if view.is_some() && !self.turn_order.iter().any(|known| known == turn_id) {
            self.turn_order.push(turn_id.to_owned());
        }
        let old_index = self.views.iter().position(|old| old.turn_id == turn_id);
        match (old_index, view) {
            (None, None) => Vec::new(),
            (Some(index), None) => {
                self.views.remove(index);
                vec![Change::TurnRemoved { turn_id: turn_id.to_owned() }]
            }
            (None, Some(view)) => {
                let rank = |id: &str| self.turn_order.iter().position(|known| known == id);
                let own = rank(turn_id);
                let index =
                    self.views.iter().take_while(|other| rank(&other.turn_id) < own).count();
                self.views.insert(index, view);
                vec![Change::TurnAdded { turn_id: turn_id.to_owned(), index }]
            }
            (Some(index), Some(view)) => {
                let changes = diff_turn(&self.views[index], &view);
                self.views[index] = view;
                changes
            }
        }
    }

    fn build_view(&self, turn_id: &str) -> Option<TurnView> {
        let rows = self.rows_of(turn_id);
        let live = self.live.iter().find(|turn| turn.turn_id == turn_id);
        let has_interactions = self.interactions.iter().any(|record| record.turn_id == turn_id);
        let materialized = (!rows.is_empty()).then(|| materialize_turn(turn_id, &rows));
        let mut view = match (materialized, live) {
            (Some(turn), Some(live)) => {
                let ended = turn.recorded && turn.durable_status != TurnStatus::Running;
                overlay_live_turn(turn.view, live, ended)
            }
            (Some(turn), None) => turn.view,
            (None, Some(live)) if !live.steps.is_empty() || has_interactions => {
                overlay_live_turn(live_only_turn(live), live, false)
            }
            (None, _) if has_interactions => TurnView {
                turn_id: turn_id.to_owned(),
                status: TurnViewStatus::Running,
                failure: None,
                items: Vec::new(),
                started_at: 0,
                model_id: None,
                provider_retry: None,
            },
            (None, _) => return None,
        };
        if let Some(root) = self.snapshot.root_turn.as_ref().filter(|root| root.turn_id == turn_id)
        {
            apply_root_status(&mut view, root);
        }
        self.attach_interactions(&mut view, &rows);
        Some(view)
    }

    /// Places interaction items right after the Tool they are about, or at
    /// the end of the Turn. A durable `permission_decision` row settles the
    /// matching live interaction (by id, else by Tool) or stands alone.
    fn attach_interactions(&self, view: &mut TurnView, rows: &[&StoredMessage]) {
        let mut records: Vec<InteractionRecord> = self
            .interactions
            .iter()
            .filter(|record| record.turn_id == view.turn_id)
            .cloned()
            .collect();
        for row in rows {
            let StoredMessage::PermissionDecision(decision) = row else { continue };
            let resolution = Resolution::Permission {
                decision: decision.decision.clone(),
                remember_for_turn: decision.remember_for_turn.unwrap_or(false),
            };
            let matching = records.iter_mut().find(|record| {
                record.interaction_id == decision.id
                    || (record.is_permission()
                        && record.tool_use_id.as_deref() == Some(decision.tool_use_id.as_str()))
            });
            match matching {
                Some(record) => {
                    record.state = InteractionState::Resolved(resolution);
                    record.tool_name.get_or_insert_with(|| decision.tool_name.clone());
                }
                None => records.push(InteractionRecord {
                    interaction_id: decision.id.clone(),
                    turn_id: decision.turn_id.clone(),
                    tool_use_id: Some(decision.tool_use_id.clone()),
                    tool_name: Some(decision.tool_name.clone()),
                    request: None,
                    state: InteractionState::Resolved(resolution),
                }),
            }
        }
        for record in records {
            let item = TurnItem::Interaction(InteractionItem {
                interaction_id: record.interaction_id,
                tool_use_id: record.tool_use_id.clone(),
                tool_name: record.tool_name.or_else(|| {
                    record.request.as_ref().and_then(|request| match request {
                        InteractionRequest::Permission(permission) => {
                            permission.prompt.tool_name().map(str::to_owned)
                        }
                        _ => None,
                    })
                }),
                request: record.request,
                state: record.state,
            });
            let anchor = record.tool_use_id.as_deref().and_then(|tool_use_id| {
                view.items.iter().position(|existing| {
                    matches!(existing, TurnItem::Tool(tool) if tool.tool_use_id == tool_use_id)
                })
            });
            match anchor {
                Some(mut index) => {
                    index += 1;
                    while matches!(view.items.get(index), Some(TurnItem::Interaction(_))) {
                        index += 1;
                    }
                    view.items.insert(index, item);
                }
                None => view.items.push(item),
            }
        }
    }
}

/// A Turn's durable rows in storage order.
fn rows_of<'a>(
    by_turn: &HashMap<String, Vec<u64>>,
    durable: &'a BTreeMap<u64, StoredMessage>,
    turn_id: &str,
) -> Vec<&'a StoredMessage> {
    by_turn
        .get(turn_id)
        .map(|sequences| sequences.iter().filter_map(|sequence| durable.get(sequence)).collect())
        .unwrap_or_default()
}

/// The live root Turn's status, failure, and provider retry win over
/// durable rows.
fn apply_root_status(view: &mut TurnView, root: &TurnSnapshot) {
    let status = match &root.status {
        TurnRunStatus::Admitted | TurnRunStatus::Created | TurnRunStatus::Running => {
            TurnViewStatus::Running
        }
        TurnRunStatus::WaitingForUser => TurnViewStatus::WaitingForUser,
        TurnRunStatus::Completed => TurnViewStatus::Completed,
        TurnRunStatus::Failed => TurnViewStatus::Failed,
        TurnRunStatus::Cancelled => TurnViewStatus::Cancelled,
        _ => return,
    };
    view.status = status;
    view.failure = (status == TurnViewStatus::Failed).then(|| TurnFailure {
        class: root.failure_class.clone().unwrap_or_else(|| "runtime_error".to_owned()),
        message: root.failure_message.clone(),
    });
    view.provider_retry = root.provider_retry.clone().filter(|_| !status.is_terminal());
}

/// `sameRuntimeHostTerminalTurn`.
fn same_terminal(previous: Option<&TurnSnapshot>, next: &TurnSnapshot) -> bool {
    previous.is_some_and(|previous| {
        previous.status.is_terminal()
            && next.status.is_terminal()
            && previous.run_id == next.run_id
            && previous.terminal_event_id == next.terminal_event_id
    })
}

/// Reports what moved between two views of one Turn.
fn diff_turn(old: &TurnView, new: &TurnView) -> Vec<Change> {
    let turn_id = &new.turn_id;
    let mut changes = Vec::new();
    let old_items: HashMap<ItemKey, &TurnItem> =
        old.items.iter().map(|item| (item.key(), item)).collect();
    let new_keys: HashSet<ItemKey> = new.items.iter().map(TurnItem::key).collect();
    for (index, item) in new.items.iter().enumerate() {
        let key = item.key();
        match old_items.get(&key) {
            None => changes.push(Change::ItemAdded { turn_id: turn_id.clone(), key, index }),
            Some(previous) if *previous == item => {}
            Some(previous) => {
                let appended = match (previous, item) {
                    (TurnItem::Text(before), TurnItem::Text(after)) => {
                        after.text.len() > before.text.len()
                            && after.text.starts_with(&before.text)
                            && after.streaming == before.streaming
                            && after.interrupted == before.interrupted
                            && after.ts == before.ts
                    }
                    (TurnItem::Thinking(before), TurnItem::Thinking(after)) => {
                        after.text.len() > before.text.len()
                            && after.text.starts_with(&before.text)
                            && after.streaming == before.streaming
                            && after.truncated == before.truncated
                    }
                    _ => false,
                };
                changes.push(if appended {
                    Change::ItemTextAppended { turn_id: turn_id.clone(), key }
                } else {
                    Change::ItemUpdated { turn_id: turn_id.clone(), key }
                });
            }
        }
    }
    for item in &old.items {
        let key = item.key();
        if !new_keys.contains(&key) {
            changes.push(Change::ItemRemoved { turn_id: turn_id.clone(), key });
        }
    }
    let old_order: Vec<ItemKey> =
        old.items.iter().map(TurnItem::key).filter(|key| new_keys.contains(key)).collect();
    let new_order: Vec<ItemKey> =
        new.items.iter().map(TurnItem::key).filter(|key| old_items.contains_key(key)).collect();
    if old_order != new_order {
        changes.push(Change::ItemsReordered { turn_id: turn_id.clone() });
    }
    if !old.status.is_terminal() && new.status.is_terminal() {
        changes.push(Change::TurnFinished { turn_id: turn_id.clone(), status: new.status });
    } else if old.status != new.status
        || old.failure != new.failure
        || old.model_id != new.model_id
        || old.started_at != new.started_at
        || old.provider_retry != new.provider_retry
    {
        changes.push(Change::TurnUpdated { turn_id: turn_id.clone() });
    }
    changes
}
