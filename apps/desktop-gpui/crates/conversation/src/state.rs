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

//! The conversation of the selected session: its subscription, its
//! transcript, and the commands that act on it.

use std::collections::HashMap;
use std::time::Duration;

use gpui_kit::{App, Context, Entity, EventEmitter, SharedString, Subscription, Task};
use host_protocol::{
    HostOperationErrorCode, InteractionAnswer, InteractionAnswerCommand, InteractionAnswerInput,
    InteractionSnapshot, MessageContent, PermissionMode, PushFrame, SessionCatalogItem,
    SessionCatalogProjection, SessionCatalogQuery, SessionCatalogQueryInput,
    SessionCatalogQueryResult, SessionConfigurationPatch, SessionConfigurationUpdate,
    SessionConfigurationUpdateInput, SessionTranscriptPage, SessionTranscriptPageQuery,
    SessionUpdateResult, SubscriptionClose, SubscriptionClosedReason, SubscriptionFrame,
    SubscriptionIdInput, SubscriptionOpen, SubscriptionOpenInput, SubscriptionOpenResult,
    SubscriptionReady, ThinkingLevel, TurnSnapshot, TurnStop, TurnStopInput,
};
use host_protocol::{
    MAX_ATTACHMENT_COUNT, MessagePlacement, MessageQueueEntryState, Operation, QueueEntryPromote,
    QueueEntryPromoteInput, QueueEntryRetract, QueueEntryRetractInput, QueueEntryUpdate,
    QueueEntryUpdateInput, QueueMutationResult, SessionCreate, SessionCreateInput,
    SessionMessageQueueProjection, SessionRemove, SessionRemoveInput, SessionRemoveResult,
    StorageRef, TurnMessageSubmit, TurnMessageSubmitInput, TurnMessageSubmitResult,
};
use serde_json::Value;
use transcript_model::{Change, Transcript};
use workspace::{
    ConnectionEntry, ConnectionList, HostRequestError, HostRequester, HostSession, HostSessionEvent,
};

use shared::copy::conversation as copy;
use shared::copy::{Locale, NEW_TASK_FAILED, failure};

use crate::attachments::{self, PickedFile};

/// The shortest time between two commits while a turn streams: about 8 Hz
/// (the streaming rate limit in `AGENTS.md`). Frames are applied to the
/// transcript as they arrive; only the notification that views re-read it is
/// coalesced.
pub const COMMIT_INTERVAL: Duration = Duration::from_millis(125);

/// How long to wait before asking again when `subscription.open` answers
/// `transcript_preparing`, and for how many attempts: 25 ms for up to 30 s,
/// as `RuntimeHostConnection.openSessionSubscription` does
/// (`packages/runtime-host/src/client/connection.ts`).
const PREPARING_RETRY_DELAY: Duration = Duration::from_millis(25);
const PREPARING_MAX_ATTEMPTS: u32 = 1200;

/// How long to wait before reopening after a failure of the live
/// subscription, doubling for each consecutive failure that no successfully
/// applied frame has followed: 250 ms, 500 ms, 1 s, … up to 5 s. The Desktop
/// re-establishes at once, but only after `sequence_gap`,
/// `projection_revision_invalid`, `slow_consumer`, and a transcript page
/// answering `not_found` (`isRecoverableSubscriptionFailure` in
/// apps/desktop/src/main/runtime-host-session-subscription-owner.ts); it
/// treats any other failure, a malformed frame or a correlation error
/// included, as terminal. This client reopens on those too, because a reopen
/// rereads canonical state, so it spaces the reopens out: after `ready` the
/// Host resends open streams from their start, and a frame this client cannot
/// apply fails again on every new subscription. The cap is the TS client's
/// reconnect cap (`DEFAULT_BACKOFF_MAX_MS` in
/// packages/runtime-host/src/client/reconnect-lifecycle.ts).
const REOPEN_BACKOFF_START: Duration = Duration::from_millis(250);
const REOPEN_BACKOFF_MAX: Duration = Duration::from_secs(5);

/// After this many consecutive failures with no successfully applied frame
/// between them, the conversation stops reopening and shows the failure with
/// Retry ([`ConversationPhase::Failed`]), where the Desktop would stop at the
/// first failure it does not classify as recoverable. With the backoff above
/// that takes about 18 s.
const REOPEN_ATTEMPT_LIMIT: u32 = 8;

/// The wait before the reopen that follows `failures` consecutive failures
/// (at least one).
fn reopen_delay(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    REOPEN_BACKOFF_START.saturating_mul(1 << doublings).min(REOPEN_BACKOFF_MAX)
}

/// The most bytes one read of older history asks for. The Desktop asks for
/// the Host's maximum, 512 KiB (`readOlderPage` in
/// apps/desktop/src/main/desktop-transcript-replica.ts); a smaller page makes
/// reaching the top add a few Turns rather than the whole history, and a
/// page that stops inside a Turn is followed by the next one at once.
pub const OLDER_PAGE_BYTES: u64 = 64 * 1024;

/// Where the subscription of the selected session stands. The last
/// transcript stays readable through every state except [`Self::Idle`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConversationPhase {
    /// No session is selected.
    Idle,
    /// A session is selected but there is no connection to open it on.
    WaitingForHost,
    /// `subscription.open` is in flight (first open or a reopen).
    Opening,
    /// The transcript follows the subscription.
    Live,
    /// Opening or following failed; [`ConversationState::retry`] tries again.
    Failed(SharedString),
    /// The Host ended the subscription for good (the session was removed or
    /// access was revoked). Nothing reopens it.
    Ended(SharedString),
}

/// Whether the transcript can show more of its past, and how the last read
/// of older history went.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum OlderHistory {
    /// The transcript holds the Session from its first row, and nothing was
    /// paged (a short Session), or no transcript is loaded.
    None,
    /// Older rows exist; [`ConversationState::load_older_history`] reads them.
    Available,
    /// A read of older history is in flight.
    Loading,
    /// The last read failed; loading again retries it.
    Failed(SharedString),
    /// Reading older history reached the Session's first row.
    Reached,
}

/// Where the selected session's turn stands, as far as Send and Stop care.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum TurnActivity {
    /// The session's transcript is not loaded yet (no selection, still
    /// opening, or failed), so whether a turn runs is unknown.
    Unavailable,
    /// Nothing runs; a message starts a turn.
    Idle,
    /// A message is being submitted to an idle session, or started a turn
    /// the transcript does not show yet.
    Starting,
    /// A turn runs and may be stopped.
    Running,
    /// A `turn.stop` is in flight.
    Stopping,
}

impl TurnActivity {
    /// Whether a message may be submitted now: the Host starts a turn with
    /// it, or queues it behind the one that runs.
    pub fn is_sendable(self) -> bool {
        self != Self::Unavailable
    }

    /// Whether a message sent now waits for the current turn instead of
    /// starting one.
    pub fn queues(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }

    /// Whether Stop may stop a turn now.
    pub fn is_stoppable(self) -> bool {
        self == Self::Running
    }
}

/// What the selected session runs its turns with, as the Host's session
/// catalog reports it (`SessionCatalogProjection` in
/// `packages/runtime-host/src/protocol/session-catalog.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SessionSettings {
    /// The model id new turns use, for example `glm-5.3`.
    pub model: SharedString,
    /// The connection the model runs on (`llmConnectionId`); none for a
    /// session without a model connection.
    pub connection_id: Option<SharedString>,
    /// `llmConnectionSlug`, for example `ollama-local`.
    pub connection_slug: SharedString,
    pub permission_mode: PermissionMode,
    /// The thinking level new turns ask for; `None` leaves it to the model.
    pub thinking_level: Option<ThinkingLevel>,
    /// The catalog projection's `revision` these were read at: what the next
    /// `session.configuration.update` names as `expectedRevision`.
    pub revision: u64,
}

impl SessionSettings {
    fn from_projection(session: &SessionCatalogProjection) -> Self {
        Self {
            model: session.model.clone().into(),
            connection_id: session.llm_connection_id.clone().map(Into::into),
            connection_slug: session.llm_connection_slug.clone().into(),
            permission_mode: session.permission_mode.clone(),
            thinking_level: session.thinking_level.clone(),
            revision: session.revision,
        }
    }

    /// The connection of `list` the session runs on: the one its
    /// connection id names, else the one connection with its slug. A task
    /// moved over from Maka Desktop keeps Desktop's connection id, which
    /// this Host's catalog does not list, while the slug still names the
    /// connection. `None` when no connection has that slug, or more than
    /// one does.
    pub fn connection_in<'a>(&self, list: &'a ConnectionList) -> Option<&'a ConnectionEntry> {
        if let Some(connection) = self.connection_id.as_deref().and_then(|id| list.connection(id)) {
            return Some(connection);
        }
        let mut with_slug =
            list.connections.iter().filter(|connection| connection.slug == self.connection_slug);
        let connection = with_slug.next()?;
        with_slug.next().is_none().then_some(connection)
    }

    /// Whether the session runs `model` on the connection `connection_id`
    /// of `list` (the one [`Self::connection_in`] finds).
    pub fn runs(&self, list: &ConnectionList, connection_id: &str, model: &str) -> bool {
        self.model == model
            && self.connection_in(list).is_some_and(|connection| connection.id == connection_id)
    }
}

/// An answer to an interaction that has not been recorded yet.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum AnswerState {
    /// `interaction.answer` with this answer is in flight; the prompt takes
    /// no other answer meanwhile.
    Sending(InteractionAnswer),
    /// The Host refused or the request failed; the prompt can be answered
    /// again.
    Failed(SharedString),
}

/// What the Host did with a submitted message (`TurnMessageSubmitResult`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SendOutcome {
    /// The session was idle: the message opened a turn.
    Started,
    /// Queued as steering for the running turn's next step.
    Steering,
    /// Queued to run as its own turn after the running one.
    Followup,
}

/// What a new task's first message did to the session it created
/// ([`ConversationState::start_session`]); the window keeps its task list in
/// step.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum NewSessionEvent {
    /// `session.create` answered with this session, which the state shows
    /// from now on.
    Created(Box<SessionCatalogItem>),
    /// The session created for a first message the Host then did not take
    /// is deleted again.
    Discarded(SharedString),
}

/// Why a message was not sent.
#[derive(Debug)]
enum NotSent {
    /// The Host did not take it: it refused it, or it was never sent.
    Refused(SharedString),
    /// The request failed on its way (a dropped connection, a timeout), or
    /// the Host answered in a way this client cannot read: the Host may
    /// have taken it.
    Unknown(SharedString),
}

impl NotSent {
    fn into_message(self) -> SharedString {
        match self {
            Self::Refused(message) | Self::Unknown(message) => message,
        }
    }
}

/// A new task's first message, from `session.create` until the Host
/// answers the message.
#[derive(Debug)]
struct FirstSend {
    session_id: SharedString,
    /// The created session's revision, which `session.remove` names; `None`
    /// until `session.create` answers.
    revision: Option<u64>,
    /// The text and files, until they are submitted.
    message: Option<(String, Vec<PickedFile>)>,
    reply: async_channel::Sender<Result<SendOutcome, SharedString>>,
}

/// Emitted by [`ConversationState`] once per commit.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConversationEvent {
    /// The transcript, the phase, or an answer changed. `session_changed`
    /// is true when a different session (or none) is shown from now on, so
    /// views start over instead of diffing.
    Changed { session_changed: bool },
}

/// The selected session's conversation: its subscription, its transcript,
/// the turn commands, and the answers to its prompts.
///
/// Behavior owner for everything the conversation view and the composer
/// show. It opens `subscription.open` with a transcript tail when a session is
/// selected, sends `subscription.ready`, bootstraps a [`Transcript`], applies
/// every frame the [`HostSession`] forwards, and reads
/// `session.transcript.page` whenever the transcript is behind. A frame is
/// applied as it arrives; views are told to re-read at most every
/// [`COMMIT_INTERVAL`] while a turn runs and at once otherwise. A gap, an
/// epoch change, or a new connection reopens the subscription while the last
/// transcript stays visible; reopens after failures back off and stop at
/// [`REOPEN_ATTEMPT_LIMIT`]. Nothing here runs from `render`.
pub struct ConversationState {
    host: Entity<HostSession>,
    session_id: Option<SharedString>,
    phase: ConversationPhase,
    transcript: Option<Transcript>,
    /// The subscription the Host holds open for this state: the live one,
    /// or the one just bootstrapped. Closed on reselection and release.
    subscription_id: Option<String>,
    /// Incremented for every open; a result of an older open is dropped.
    generation: u64,
    /// Consecutive failures of the live subscription that asked for a reopen
    /// with no successfully applied frame since; see [`REOPEN_ATTEMPT_LIMIT`].
    reopen_failures: u32,
    page_in_flight: bool,
    /// A read of older history is in flight.
    older_loading: bool,
    /// Why the last read of older history failed.
    older_failure: Option<SharedString>,
    /// Changes applied since the last commit.
    pending: Vec<Change>,
    /// A commit was held back by the rate limit.
    commit_pending: bool,
    session_changed: bool,
    /// A turn a submitted message started that the transcript does not
    /// show yet.
    started_turn: Option<StartedTurn>,
    /// A `turn.message.submit` is in flight.
    submitting: bool,
    /// The queue entry a `queue.*` command in flight changes.
    queue_action: Option<String>,
    stopping: bool,
    answers: HashMap<String, AnswerState>,
    settings: Option<SessionSettings>,
    /// The session revision `settings` was read at, or asked for while a
    /// read is in flight; the Host bumps it on every committed change.
    settings_revision: u64,
    /// A `session.configuration.update` is in flight.
    configuring: bool,
    /// A new task's first message on its way ([`Self::start_session`]).
    first: Option<FirstSend>,
    _first: Option<Task<()>>,
    _commit_window: Option<Task<()>>,
    _open: Option<Task<()>>,
    /// Waits out [`reopen_delay`] before a reopen.
    _reopen_delay: Option<Task<()>>,
    _ready: Option<Task<()>>,
    _page: Option<Task<()>>,
    _older: Option<Task<()>>,
    _send: Option<Task<()>>,
    _upload: Option<Task<()>>,
    _queue: Option<Task<()>>,
    _stop: Option<Task<()>>,
    _answers: HashMap<String, Task<()>>,
    _settings: Option<Task<()>>,
    _configure: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ConversationEvent> for ConversationState {}
impl EventEmitter<NewSessionEvent> for ConversationState {}

/// A turn `turn.message.submit` started, until the transcript shows it or
/// anything after it.
#[derive(Debug)]
struct StartedTurn {
    turn_id: String,
    /// The root Turn the transcript showed when the start was recorded. Any
    /// other root Turn is the started one or came after it.
    root_before: Option<String>,
    /// [`ConversationState::generation`] when the start was recorded. An
    /// open with a later generation was issued after the Host admitted the
    /// turn, so its snapshot already shows the turn or what followed it.
    generation: u64,
}

impl std::fmt::Debug for ConversationState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConversationState")
            .field("session_id", &self.session_id)
            .field("phase", &self.phase)
            .field("subscription_id", &self.subscription_id)
            .field("turns", &self.transcript.as_ref().map(|t| t.turns().len()))
            .finish_non_exhaustive()
    }
}

impl ConversationState {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                this.on_host_event(event, cx);
            }),
            // Closing needs a context, so it cannot live in `Drop`.
            cx.on_release(|this, cx| this.close_subscription_on_release(cx)),
        ];
        Self {
            host,
            session_id: None,
            phase: ConversationPhase::Idle,
            transcript: None,
            subscription_id: None,
            generation: 0,
            reopen_failures: 0,
            page_in_flight: false,
            older_loading: false,
            older_failure: None,
            pending: Vec::new(),
            commit_pending: false,
            session_changed: false,
            started_turn: None,
            submitting: false,
            queue_action: None,
            stopping: false,
            answers: HashMap::new(),
            settings: None,
            settings_revision: 0,
            configuring: false,
            first: None,
            _first: None,
            _commit_window: None,
            _open: None,
            _reopen_delay: None,
            _ready: None,
            _page: None,
            _older: None,
            _send: None,
            _upload: None,
            _queue: None,
            _stop: None,
            _answers: HashMap::new(),
            _settings: None,
            _configure: None,
            _subscriptions: subscriptions,
        }
    }

    /// The Host connection the state talks to.
    pub fn host(&self) -> &Entity<HostSession> {
        &self.host
    }

    pub fn session_id(&self) -> Option<&SharedString> {
        self.session_id.as_ref()
    }

    pub fn phase(&self) -> &ConversationPhase {
        &self.phase
    }

    /// The transcript on screen: the live one, or the last one while a
    /// reopen is in flight.
    pub fn transcript(&self) -> Option<&Transcript> {
        self.transcript.as_ref()
    }

    /// Whether older history can be read, is being read, or was read to the
    /// Session's start.
    pub fn older_history(&self) -> OlderHistory {
        let Some(transcript) = &self.transcript else {
            return OlderHistory::None;
        };
        if self.older_loading {
            OlderHistory::Loading
        } else if let Some(failure) = &self.older_failure {
            OlderHistory::Failed(failure.clone())
        } else if transcript.has_older_history() {
            OlderHistory::Available
        } else if transcript.reached_first_row() {
            OlderHistory::Reached
        } else {
            OlderHistory::None
        }
    }

    /// The selected session's model and permission mode, once read.
    pub fn settings(&self) -> Option<&SessionSettings> {
        self.settings.as_ref()
    }

    /// Whether a `session.configuration.update` is in flight.
    pub fn is_configuring(&self) -> bool {
        self.configuring
    }

    /// An answer that is in flight or failed for `interaction_id`.
    pub fn answer_state(&self, interaction_id: &str) -> Option<&AnswerState> {
        self.answers.get(interaction_id)
    }

    /// Where the selected session's turn stands.
    pub fn turn_activity(&self) -> TurnActivity {
        if self.transcript.is_none() || self.phase != ConversationPhase::Live {
            return TurnActivity::Unavailable;
        }
        match self.running_turn() {
            Some(_) if self.stopping => TurnActivity::Stopping,
            Some(_) => TurnActivity::Running,
            None if self.submitting || self.started_turn.is_some() => TurnActivity::Starting,
            None => TurnActivity::Idle,
        }
    }

    /// Whether a `turn.message.submit` is in flight; one at a time, so
    /// messages keep the order they were sent in.
    pub fn is_submitting(&self) -> bool {
        self.submitting
    }

    /// Whether a new task's first message is on its way, from
    /// `session.create` until the Host answers the message.
    pub fn is_starting(&self) -> bool {
        self.first.is_some()
    }

    /// The message queue the Host holds for the session: steering for the
    /// running turn and follow-ups that each run as their own turn.
    pub fn queue(&self) -> Option<&SessionMessageQueueProjection> {
        self.transcript.as_ref().map(|transcript| &transcript.snapshot().queue)
    }

    /// The queue entry a `queue.*` command in flight changes.
    pub fn queue_action(&self) -> Option<&str> {
        self.queue_action.as_deref()
    }

    /// The live root turn, as the transcript shows it.
    fn running_turn(&self) -> Option<&TurnSnapshot> {
        let root = self.transcript.as_ref()?.root_turn();
        root.filter(|root| !root.status.is_terminal())
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    fn label(&self) -> &str {
        self.session_id.as_deref().unwrap_or("-")
    }

    // Selection and the subscription lifecycle.

    /// Shows the session `session_id`, or nothing. Closes the subscription
    /// of the previous session and opens one for the new session.
    pub fn select_session(&mut self, session_id: Option<SharedString>, cx: &mut Context<Self>) {
        if self.session_id == session_id {
            return;
        }
        // Another task chosen before a new task's first message went: the
        // task is not wanted (Desktop's `discardUnsentSession` when the
        // selection moved on).
        if self.first.as_ref().is_some_and(|first| {
            first.message.is_some() && session_id.as_ref() != Some(&first.session_id)
        }) && let Some(first) = self.first.take()
        {
            let locale = Locale::current(cx);
            first.reply.try_send(Err(copy::OTHER_SESSION.in_locale(locale).into())).ok();
            self.discard_session(first.session_id, first.revision, cx);
        }
        self.close_subscription(cx);
        self.session_id = session_id;
        self.transcript = None;
        self.reopen_failures = 0;
        self._reopen_delay = None;
        self.started_turn = None;
        self.queue_action = None;
        self._queue = None;
        self.answers.clear();
        self._answers.clear();
        self.settings = None;
        self.settings_revision = 0;
        self._settings = None;
        self.configuring = false;
        self._configure = None;
        self.pending.clear();
        self.session_changed = true;
        self.open(cx);
        self.commit_now(cx);
    }

    /// Opens the subscription again after a failure.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        if matches!(self.phase, ConversationPhase::Failed(_)) {
            self.reopen_failures = 0;
            self._reopen_delay = None;
            self.reopen(cx);
        }
    }

    /// Drops every request that follows the current subscription and moves
    /// the generation on, so an answer still on its way belongs to nobody.
    fn cancel_reads(&mut self) {
        self.generation += 1;
        self._open = None;
        self._ready = None;
        self._page = None;
        self.page_in_flight = false;
        self._older = None;
        self.older_loading = false;
        self.older_failure = None;
    }

    fn open(&mut self, cx: &mut Context<Self>) {
        self.cancel_reads();
        let Some(session_id) = self.session_id.clone() else {
            self.phase = ConversationPhase::Idle;
            return;
        };
        if !self.host.read(cx).is_connected() {
            self.phase = ConversationPhase::WaitingForHost;
            return;
        }
        self.phase = ConversationPhase::Opening;
        let generation = self.generation;
        let requester = self.requester(cx);
        // A 16 KiB tail, the most the Host accepts, as the Desktop
        // (`openSession` in apps/desktop/src/main/runtime-host-client.ts) and
        // the CLI (packages/cli/src/runtime-host-session-driver.ts) ask for.
        let input = SubscriptionOpenInput::with_tail(session_id.to_string());
        log::info!("session {session_id}: opening a subscription");
        self._open = Some(cx.spawn(async move |this, cx| {
            let mut attempts = 0;
            let result = loop {
                match requester.request::<SubscriptionOpen>(&input).await {
                    Err(HostRequestError::Operation {
                        code: HostOperationErrorCode::TranscriptPreparing,
                        ..
                    }) if attempts < PREPARING_MAX_ATTEMPTS => {
                        attempts += 1;
                        cx.background_executor().timer(PREPARING_RETRY_DELAY).await;
                    }
                    other => break other,
                }
            };
            this.update(cx, |this, cx| this.finish_open(generation, result, cx)).ok();
        }));
    }

    fn finish_open(
        &mut self,
        generation: u64,
        result: Result<SubscriptionOpenResult, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        if generation != self.generation {
            if let Ok(open) = result {
                self.send_close(open.subscription_id, cx);
            }
            return;
        }
        let open = match result {
            Ok(open) => open,
            Err(HostRequestError::NotConnected) => {
                self.phase = ConversationPhase::WaitingForHost;
                self.commit_now(cx);
                return;
            }
            Err(error) => {
                log::warn!("session {}: subscription.open failed: {error}", self.label());
                self.fail(
                    failure(locale, copy::OPEN_FAILED.in_locale(locale), &error.to_string()),
                    cx,
                );
                return;
            }
        };
        if Some(open.snapshot.session.session_id.as_str()) != self.session_id.as_deref() {
            self.send_close(open.subscription_id, cx);
            self.fail(copy::OPEN_FAILED.in_locale(locale).to_owned(), cx);
            return;
        }
        let transcript = match Transcript::bootstrap(&open) {
            Ok(transcript) => transcript,
            Err(error) => {
                log::warn!("session {}: the transcript tail is unusable: {error}", self.label());
                self.send_close(open.subscription_id, cx);
                self.fail(
                    failure(locale, copy::OPEN_FAILED.in_locale(locale), &error.to_string()),
                    cx,
                );
                return;
            }
        };
        let subscription_id = open.subscription_id.clone();
        log::info!(
            "session {}: subscription {subscription_id} open: {} turns, next sequence {}, root turn {}",
            self.label(),
            transcript.turns().len(),
            open.next_sequence,
            describe_root(transcript.root_turn()),
        );
        // Record the subscription before `ready`: the Host starts sending
        // frames as soon as it has processed `ready`, possibly before its
        // answer arrives.
        self.subscription_id = Some(subscription_id.clone());
        self.transcript = Some(transcript);
        self.phase = ConversationPhase::Live;
        self.forget_started_turn_after_open(generation);
        self.forget_seen_turn();
        let ready = self
            .requester(cx)
            .request::<SubscriptionReady>(&SubscriptionIdInput::new(subscription_id.clone()));
        self._ready = Some(cx.spawn(async move |this, cx| {
            let result = ready.await;
            this.update(cx, |this, cx| this.finish_ready(generation, result, cx)).ok();
        }));
        // After `ready`, which must follow the open directly.
        self.refresh_settings(open.snapshot.session.metadata_revision, true, cx);
        self.commit_now(cx);
    }

    fn finish_ready<T>(
        &mut self,
        generation: u64,
        result: Result<T, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        if generation != self.generation {
            return;
        }
        match result {
            Ok(_) => {
                self.fetch_page(cx);
                self.submit_first(cx);
            }
            // A lost connection reopens on the next `Connected`.
            Err(HostRequestError::NotConnected | HostRequestError::Transport(_))
                if !self.host.read(cx).is_connected() => {}
            Err(error) => {
                log::warn!("session {}: subscription.ready failed: {error}", self.label());
                self.fail(
                    failure(locale, copy::OPEN_FAILED.in_locale(locale), &error.to_string()),
                    cx,
                );
            }
        }
    }

    /// Issues the next `session.transcript.page` read the transcript asks
    /// for, one at a time.
    fn fetch_page(&mut self, cx: &mut Context<Self>) {
        if self.page_in_flight || self.phase != ConversationPhase::Live {
            return;
        }
        let Some(transcript) = &self.transcript else {
            return;
        };
        let Some(input) = transcript.transcript_request() else {
            return;
        };
        let subscription_id = transcript.subscription_id().to_owned();
        let request = self.requester(cx).request::<SessionTranscriptPageQuery>(&input);
        self.page_in_flight = true;
        self._page = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| this.finish_page(&subscription_id, result, cx)).ok();
        }));
    }

    fn finish_page(
        &mut self,
        subscription_id: &str,
        result: Result<SessionTranscriptPage, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let Some(transcript) = self
            .transcript
            .as_mut()
            .filter(|transcript| transcript.subscription_id() == subscription_id)
        else {
            return;
        };
        self.page_in_flight = false;
        match result {
            Ok(page) => {
                let changes = transcript.apply_transcript_page(&page);
                self.handle_changes(changes, cx);
            }
            Err(_) if !self.host.read(cx).is_connected() => {}
            // The Host closed the subscription (`#readTranscriptPage` in
            // packages/runtime-host/src/server/session-continuity-coordinator.ts),
            // most likely as `slow_consumer`. Its `subscription.closed` frame
            // takes the push path and usually arrives after this answer; the
            // reopen closes the subscription first, so that frame is dropped.
            // The Desktop re-establishes on exactly this error
            // (`isRecoverableSubscriptionFailure`).
            Err(HostRequestError::Operation {
                code: HostOperationErrorCode::NotFound,
                message,
                ..
            }) => {
                self.recover(format!("the transcript page was refused ({message})"), cx);
            }
            Err(error) => {
                log::warn!("session {}: session.transcript.page failed: {error}", self.label());
                self.fail(
                    failure(locale, copy::OPEN_FAILED.in_locale(locale), &error.to_string()),
                    cx,
                );
            }
        }
    }

    /// Reads the next page of older history (`session.transcript.page`
    /// `older`, [`OLDER_PAGE_BYTES`]) and prepends its Turns. One read at a
    /// time; nothing happens when the transcript starts at the Session's
    /// first row. A page that stops inside a Turn is followed by the next at
    /// once, so a Turn never shows without its start. A cursor the Host no
    /// longer accepts reopens the subscription; any other failure shows in
    /// the transcript ([`OlderHistory::Failed`]) until the next attempt.
    pub fn load_older_history(&mut self, cx: &mut Context<Self>) {
        if self.older_loading || self.phase != ConversationPhase::Live {
            return;
        }
        let Some(transcript) = &self.transcript else {
            return;
        };
        let Some(input) = transcript.older_request(OLDER_PAGE_BYTES) else {
            return;
        };
        let subscription_id = transcript.subscription_id().to_owned();
        let request = self.requester(cx).request::<SessionTranscriptPageQuery>(&input);
        log::info!(
            "session {}: reading older history before watermark {:?}",
            self.label(),
            input.through_sequence
        );
        self.older_loading = true;
        self.older_failure = None;
        self._older = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| this.finish_older(&subscription_id, result, cx)).ok();
        }));
        self.commit_now(cx);
    }

    fn finish_older(
        &mut self,
        subscription_id: &str,
        result: Result<SessionTranscriptPage, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        // A reopen replaced the transcript; its answer belongs to nobody.
        let Some(transcript) = self
            .transcript
            .as_mut()
            .filter(|transcript| transcript.subscription_id() == subscription_id)
        else {
            return;
        };
        self.older_loading = false;
        self._older = None;
        match result {
            Ok(page) => {
                let changes = transcript.apply_transcript_page(&page);
                let incomplete = transcript.older_read_incomplete();
                let (turns, reached) = (transcript.turns().len(), transcript.reached_first_row());
                log::info!(
                    "session {}: older page of {} fragments, {turns} Turns shown{}",
                    self.label(),
                    page.fragments.len(),
                    if reached { ", first row reached" } else { "" }
                );
                self.handle_changes(changes, cx);
                if incomplete {
                    self.load_older_history(cx);
                }
            }
            Err(HostRequestError::Operation {
                code:
                    HostOperationErrorCode::InvalidRequest
                    | HostOperationErrorCode::NotFound
                    | HostOperationErrorCode::OperationConflict,
                message,
                ..
            }) => {
                // The cursor is bound to this subscription and watermark; the
                // Host no longer honors it, so start over from a new tail.
                self.recover(format!("the older history cursor was refused ({message})"), cx);
                return;
            }
            Err(_) if !self.host.read(cx).is_connected() => {}
            Err(error) => {
                log::warn!("session {}: reading older history failed: {error}", self.label());
                self.older_failure = Some(
                    failure(
                        locale,
                        copy::OLDER_HISTORY_FAILED.in_locale(locale),
                        &error.to_string(),
                    )
                    .into(),
                );
            }
        }
        self.commit_now(cx);
    }

    fn fail(&mut self, message: String, cx: &mut Context<Self>) {
        self.close_subscription(cx);
        self.phase = ConversationPhase::Failed(message.clone().into());
        self.commit_now(cx);
        // A new task whose subscription cannot open never gets its first
        // message: it is deleted again and the draft keeps the message.
        let unsent = self.first.as_ref().is_some_and(|first| {
            first.message.is_some() && Some(&first.session_id) == self.session_id.as_ref()
        });
        if unsent && let Some(first) = self.first.take() {
            first.reply.try_send(Err(message.into())).ok();
            self.discard_session(first.session_id, first.revision, cx);
        }
    }

    /// Closes the subscription and opens a new one; the transcript on screen
    /// stays until the new one is bootstrapped.
    fn reopen(&mut self, cx: &mut Context<Self>) {
        self.close_subscription(cx);
        self.open(cx);
        self.commit_now(cx);
    }

    /// Reopens after a failure of the live subscription, `reason`, once
    /// [`reopen_delay`] has passed for the consecutive failures so far, or
    /// fails with Retry at the [`REOPEN_ATTEMPT_LIMIT`]th. The subscription
    /// is closed at once and the transcript on screen stays meanwhile.
    fn recover(&mut self, reason: String, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        self.reopen_failures += 1;
        if self.reopen_failures >= REOPEN_ATTEMPT_LIMIT {
            log::warn!(
                "session {}: {} consecutive failures, not reopening again: {reason}",
                self.label(),
                self.reopen_failures
            );
            self.cancel_reads();
            self.fail(failure(locale, copy::OPEN_FAILED.in_locale(locale), &reason), cx);
            return;
        }
        let delay = reopen_delay(self.reopen_failures);
        log::info!(
            "session {}: reopening the subscription in {} ms (failure {}): {reason}",
            self.label(),
            delay.as_millis(),
            self.reopen_failures
        );
        self.close_subscription(cx);
        self.cancel_reads();
        self.phase = ConversationPhase::Opening;
        let generation = self.generation;
        self._reopen_delay = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| {
                // Anything that opened or failed meanwhile moved the
                // generation on.
                if this.generation == generation {
                    this.open(cx);
                    this.commit_now(cx);
                }
            })
            .ok();
        }));
        self.commit_now(cx);
    }

    fn close_subscription(&mut self, cx: &mut Context<Self>) {
        if let Some(subscription_id) = self.subscription_id.take() {
            self.send_close(subscription_id, cx);
        }
    }

    /// Asks the Host to close `subscription_id` without waiting; a failure
    /// only means the connection is already gone, which closes it anyway.
    fn send_close(&self, subscription_id: String, cx: &mut App) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        log::info!("session {}: closing subscription {subscription_id}", self.label());
        let request = self
            .requester(cx)
            .request::<SubscriptionClose>(&SubscriptionIdInput::new(subscription_id));
        cx.spawn(async move |_| {
            if let Err(error) = request.await {
                log::debug!("subscription.close failed: {error}");
            }
        })
        .detach();
    }

    fn close_subscription_on_release(&mut self, cx: &mut App) {
        if let Some(subscription_id) = self.subscription_id.take() {
            self.send_close(subscription_id, cx);
        }
    }

    fn on_host_event(&mut self, event: &HostSessionEvent, cx: &mut Context<Self>) {
        match event {
            HostSessionEvent::Push(frame) => {
                if let PushFrame::Subscription(frame) = frame.as_ref() {
                    self.apply_frame(frame, cx);
                }
            }
            HostSessionEvent::Connected { host_changed } => {
                if self.session_id.is_none() {
                    return;
                }
                // Subscriptions live and die with their connection: a new
                // connection always needs a new one.
                log::info!(
                    "session {}: connected (Host changed: {host_changed}), reopening",
                    self.label()
                );
                self.subscription_id = None;
                self.reopen_failures = 0;
                self._reopen_delay = None;
                self.open(cx);
                self.commit_now(cx);
            }
            HostSessionEvent::StatusChanged => {
                let live =
                    matches!(self.phase, ConversationPhase::Live | ConversationPhase::Opening);
                if live && !self.host.read(cx).is_connected() {
                    self.subscription_id = None;
                    self.open(cx);
                    self.commit_now(cx);
                }
            }
            _ => {}
        }
    }

    fn apply_frame(&mut self, frame: &SubscriptionFrame, cx: &mut Context<Self>) {
        if self.phase != ConversationPhase::Live {
            return;
        }
        let Some(transcript) = self
            .transcript
            .as_mut()
            .filter(|transcript| transcript.subscription_id() == frame.subscription_id)
        else {
            return;
        };
        log::debug!("session frame {}", frame.kind);
        let changes = transcript.apply_frame(frame);
        let failed = changes
            .iter()
            .any(|change| matches!(change, Change::NeedsReopen { .. } | Change::Closed { .. }));
        if !failed {
            self.reopen_failures = 0;
        }
        // A projection names the session's revision; a newer one may carry
        // another model or permission mode.
        if let Some(revision) =
            frame.raw.pointer("/snapshot/session/metadataRevision").and_then(Value::as_u64)
        {
            self.refresh_settings(revision, false, cx);
        }
        self.handle_changes(changes, cx);
    }

    /// Reads the session's settings from the catalog (`session.catalog.query`
    /// with `get`) when `revision` is newer than the one last asked for.
    /// After a (re)open, `retry_missing` also reads again when an earlier
    /// read failed. A failed read keeps what was shown before.
    fn refresh_settings(&mut self, revision: u64, retry_missing: bool, cx: &mut Context<Self>) {
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        let missing = self.settings.is_none() && self._settings.is_none();
        if revision <= self.settings_revision && !(retry_missing && missing) {
            return;
        }
        self.settings_revision = self.settings_revision.max(revision);
        let input = SessionCatalogQueryInput::Get { session_id: session_id.to_string() };
        let request = self.requester(cx).request::<SessionCatalogQuery>(&input);
        self._settings = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this._settings = None;
                if this.session_id.as_ref() != Some(&session_id) {
                    return;
                }
                match session_settings(result) {
                    Ok(settings) => {
                        // A read that started before a committed change may
                        // answer after it; the older revision loses.
                        let current = this.settings.as_ref();
                        let newer =
                            current.is_none_or(|current| settings.revision >= current.revision);
                        if newer && current != Some(&settings) {
                            this.settings = Some(settings);
                            cx.notify();
                        }
                    }
                    Err(reason) => {
                        log::warn!("session {session_id}: couldn't read its settings: {reason}");
                    }
                }
            })
            .ok();
        }));
    }

    /// Acts on what the transcript reported: reopen, read the next page, or
    /// schedule a commit.
    fn handle_changes(&mut self, changes: Vec<Change>, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        if changes.is_empty() {
            return;
        }
        let mut reopen = None;
        let mut ended = None;
        let mut behind = false;
        for change in &changes {
            match change {
                Change::NeedsReopen { reason } => reopen = Some(reason.to_string()),
                Change::Closed { reason } => match reason {
                    SubscriptionClosedReason::SessionRemoved => {
                        ended = Some(copy::SESSION_REMOVED.in_locale(locale))
                    }
                    SubscriptionClosedReason::AccessRevoked => {
                        ended = Some(copy::ACCESS_REVOKED.in_locale(locale))
                    }
                    _ => reopen = Some(format!("the Host closed the subscription ({reason:?})")),
                },
                Change::TranscriptBehind { .. } => behind = true,
                _ => {}
            }
        }
        self.pending.extend(changes);
        self.forget_seen_turn();
        if let Some(message) = ended {
            log::info!("session {}: {message}", self.label());
            // The Host already closed it.
            self.subscription_id = None;
            self.phase = ConversationPhase::Ended(message.into());
            self.commit_now(cx);
        } else if let Some(reason) = reopen {
            self.recover(reason, cx);
        } else {
            if behind {
                self.fetch_page(cx);
            }
            self.schedule_commit(cx);
        }
    }

    /// Drops the started turn once the transcript shows it or a newer one:
    /// the root Turn is the started turn, or any root Turn other than the
    /// one shown when the start was recorded (the started turn has come and
    /// gone, for example a queued follow-up ran after it).
    fn forget_seen_turn(&mut self) {
        let Some(started) = &self.started_turn else {
            return;
        };
        let root = self.transcript.as_ref().and_then(Transcript::root_turn);
        if let Some(root) = root
            && (root.turn_id == started.turn_id
                || started.root_before.as_deref() != Some(root.turn_id.as_str()))
        {
            self.started_turn = None;
        }
    }

    /// After the open `generation` bootstrapped the transcript: when that
    /// open was issued after the start was recorded, its snapshot is newer
    /// than the start, so an idle session means the started turn has already
    /// ended. A reopen after a lost connection is the usual case: the frames
    /// that showed the turn went with the connection.
    fn forget_started_turn_after_open(&mut self, generation: u64) {
        let issued_after_start =
            self.started_turn.as_ref().is_some_and(|started| started.generation < generation);
        if issued_after_start && self.running_turn().is_none() {
            self.started_turn = None;
        }
    }

    // Commits.

    /// Commits now when nothing streams, otherwise at most every
    /// [`COMMIT_INTERVAL`]: the first change after a quiet period commits at
    /// once and opens a window; changes inside the window commit when it
    /// closes.
    fn schedule_commit(&mut self, cx: &mut Context<Self>) {
        if self.running_turn().is_none() {
            self._commit_window = None;
            self.commit_now(cx);
            return;
        }
        if self._commit_window.is_some() {
            self.commit_pending = true;
            return;
        }
        self.commit_now(cx);
        self.open_commit_window(cx);
    }

    fn open_commit_window(&mut self, cx: &mut Context<Self>) {
        self._commit_window = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COMMIT_INTERVAL).await;
            this.update(cx, |this, cx| {
                this._commit_window = None;
                if std::mem::take(&mut this.commit_pending) {
                    this.commit_now(cx);
                    if this.running_turn().is_some() {
                        this.open_commit_window(cx);
                    }
                }
            })
            .ok();
        }));
    }

    fn commit_now(&mut self, cx: &mut Context<Self>) {
        self.commit_pending = false;
        let changes = std::mem::take(&mut self.pending);
        if !changes.is_empty() {
            log::info!("session {}: {}", self.label(), describe_changes(&changes, self));
        }
        let session_changed = std::mem::take(&mut self.session_changed);
        cx.emit(ConversationEvent::Changed { session_changed });
        cx.notify();
    }

    // Commands.

    /// Submits a message to `session_id` with `turn.message.submit`, as the
    /// Desktop does (`submitAndProject` in
    /// apps/desktop/src/renderer/app-shell-chat-actions.ts): the Host starts
    /// a turn with it when the session is idle, and otherwise queues it:
    /// `next_turn` as a follow-up that runs as its own turn, `current_turn`
    /// as steering for the running turn's next step
    /// (`packages/runtime-host/src/protocol/message.ts`). One submit at a
    /// time, so messages keep their order. The message id is fresh; the
    /// durable user row takes it as its id.
    pub fn send_message(
        &mut self,
        session_id: &str,
        content: MessageContent,
        placement: MessagePlacement,
        cx: &mut Context<Self>,
    ) -> Task<Result<SendOutcome, SharedString>> {
        let sent = self.submit_message(session_id, content, placement, cx);
        cx.foreground_executor().spawn(async move { sent.await.map_err(NotSent::into_message) })
    }

    /// [`Self::send_message`], saying whether the Host may have taken a
    /// message that failed.
    fn submit_message(
        &mut self,
        session_id: &str,
        content: MessageContent,
        placement: MessagePlacement,
        cx: &mut Context<Self>,
    ) -> Task<Result<SendOutcome, NotSent>> {
        let locale = Locale::current(cx);
        let refused = |text: shared::copy::Text| {
            Task::ready(Err(NotSent::Refused(text.in_locale(locale).into())))
        };
        if self.session_id.as_deref() != Some(session_id) {
            return refused(copy::OTHER_SESSION);
        }
        let Some(transcript) =
            self.transcript.as_ref().filter(|_| self.turn_activity().is_sendable())
        else {
            return refused(copy::NOT_READY);
        };
        if self.submitting {
            return refused(copy::SEND_BUSY);
        }
        let message_id = uuid::Uuid::new_v4().simple().to_string();
        let input = TurnMessageSubmitInput::new(
            transcript.host_epoch(),
            session_id,
            message_id.clone(),
            content,
            placement,
        );
        log::info!(
            "session {session_id}: turn.message.submit {message_id} ({} characters, {} attachments, {}) while {:?}",
            input.content.text.chars().count(),
            input.content.attachments.as_ref().map_or(0, Vec::len),
            input.placement,
            self.turn_activity(),
        );
        let request = self.requester(cx).request::<TurnMessageSubmit>(&input);
        self.submitting = true;
        cx.notify();
        let session_id = SharedString::from(session_id.to_owned());
        let (reply, answer) = async_channel::bounded(1);
        self._send = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let outcome = this
                .update(cx, |this, cx| this.finish_send(&session_id, result, cx))
                .unwrap_or_else(|_| {
                    Err(NotSent::Unknown(copy::SEND_FAILED.in_locale(locale).into()))
                });
            reply.try_send(outcome).ok();
        }));
        receive_send(answer, copy::SEND_FAILED.in_locale(locale), cx)
    }

    fn finish_send(
        &mut self,
        session_id: &str,
        result: Result<TurnMessageSubmitResult, HostRequestError>,
        cx: &mut Context<Self>,
    ) -> Result<SendOutcome, NotSent> {
        let locale = Locale::current(cx);
        self.submitting = false;
        cx.notify();
        let current = self.session_id.as_deref() == Some(session_id);
        match result {
            Ok(TurnMessageSubmitResult::TurnStarted { turn_id, .. }) => {
                log::info!("session {session_id}: the message started turn {turn_id}");
                if current {
                    let root_before = self
                        .transcript
                        .as_ref()
                        .and_then(Transcript::root_turn)
                        .map(|root| root.turn_id.clone());
                    self.started_turn =
                        Some(StartedTurn { turn_id, root_before, generation: self.generation });
                    self.forget_seen_turn();
                }
                Ok(SendOutcome::Started)
            }
            Ok(TurnMessageSubmitResult::Steering { queue_revision, .. }) => {
                log::info!(
                    "session {session_id}: the message is queued as steering (queue revision {queue_revision:?})"
                );
                Ok(SendOutcome::Steering)
            }
            Ok(TurnMessageSubmitResult::Followup { queue_revision, .. }) => {
                log::info!(
                    "session {session_id}: the message is queued as a follow-up (queue revision {queue_revision:?})"
                );
                Ok(SendOutcome::Followup)
            }
            Ok(TurnMessageSubmitResult::Blocked { .. }) => {
                Err(NotSent::Refused(copy::SEND_BLOCKED.in_locale(locale).into()))
            }
            Ok(_) => Err(NotSent::Unknown(copy::SEND_UNEXPECTED.in_locale(locale).into())),
            Err(error) => {
                log::warn!("session {session_id}: turn.message.submit failed: {error}");
                let message: SharedString =
                    failure(locale, copy::SEND_FAILED.in_locale(locale), &error.to_string()).into();
                // Desktop keeps a first message whose outcome is unknown
                // (`outcome_unknown`): the Host may have taken it.
                match error {
                    HostRequestError::Transport(_)
                    | HostRequestError::Operation {
                        code:
                            HostOperationErrorCode::OutcomeUnknown
                            | HostOperationErrorCode::CommitOutcomeUnknown,
                        ..
                    } => Err(NotSent::Unknown(message)),
                    _ => Err(NotSent::Refused(message)),
                }
            }
        }
    }

    /// Sends `text` with `files` attached: each file is uploaded into the
    /// session first (`artifact.ingest`, see [`crate::attachments`]), then
    /// the message carries their `AttachmentRef`s through
    /// [`Self::send_message`]. One send at a time, uploads included; a file
    /// that fails to upload fails the send and nothing is submitted.
    pub fn send_with_attachments(
        &mut self,
        session_id: &str,
        text: String,
        files: Vec<PickedFile>,
        placement: MessagePlacement,
        cx: &mut Context<Self>,
    ) -> Task<Result<SendOutcome, SharedString>> {
        let sent = self.submit_with_attachments(session_id, text, files, placement, cx);
        cx.foreground_executor().spawn(async move { sent.await.map_err(NotSent::into_message) })
    }

    /// [`Self::send_with_attachments`], saying whether the Host may have
    /// taken a message that failed. A file that fails to upload means
    /// nothing was submitted.
    fn submit_with_attachments(
        &mut self,
        session_id: &str,
        text: String,
        files: Vec<PickedFile>,
        placement: MessagePlacement,
        cx: &mut Context<Self>,
    ) -> Task<Result<SendOutcome, NotSent>> {
        let locale = Locale::current(cx);
        if files.is_empty() {
            return self.submit_message(session_id, MessageContent::text(text), placement, cx);
        }
        let refused = |text: shared::copy::Text| {
            Task::ready(Err(NotSent::Refused(text.in_locale(locale).into())))
        };
        if self.session_id.as_deref() != Some(session_id) {
            return refused(copy::OTHER_SESSION);
        }
        if self.transcript.is_none() || !self.turn_activity().is_sendable() {
            return refused(copy::NOT_READY);
        }
        if self.submitting {
            return refused(copy::SEND_BUSY);
        }
        if files.len() > MAX_ATTACHMENT_COUNT {
            return refused(copy::ATTACH_TOO_MANY);
        }
        let requester = self.requester(cx);
        let session = session_id.to_owned();
        log::info!("session {session}: uploading {} attachments", files.len());
        self.submitting = true;
        cx.notify();
        let (reply, answer) = async_channel::bounded(1);
        self._upload = Some(cx.spawn(async move |this, cx| {
            let executor = cx.background_executor().clone();
            let mut attachments = Vec::with_capacity(files.len());
            let mut failure = None;
            for file in &files {
                match attachments::upload(&requester, &session, file, &executor, locale).await {
                    Ok(attachment) => {
                        log::info!(
                            "session {session}: attached {} as {} ({}, {} bytes)",
                            file.name,
                            match &attachment.storage {
                                StorageRef::SessionFile { relative_path, .. } => relative_path,
                                _ => "?",
                            },
                            attachment.mime_type,
                            attachment.bytes
                        );
                        attachments.push(attachment);
                    }
                    Err(message) => {
                        failure = Some(message);
                        break;
                    }
                }
            }
            let submitted = this.update(cx, |this, cx| {
                this.submitting = false;
                cx.notify();
                if let Some(message) = failure {
                    log::warn!("session {session}: {message}");
                    return Task::ready(Err(NotSent::Refused(message)));
                }
                let mut content = MessageContent::text(text);
                content.attachments = Some(
                    attachments
                        .iter()
                        .filter_map(|attachment| serde_json::to_value(attachment).ok())
                        .collect(),
                );
                this.submit_message(&session, content, placement, cx)
            });
            let outcome = match submitted {
                Ok(task) => task.await,
                Err(_) => Err(NotSent::Unknown(copy::SEND_FAILED.in_locale(locale).into())),
            };
            reply.try_send(outcome).ok();
        }));
        receive_send(answer, copy::SEND_FAILED.in_locale(locale), cx)
    }

    /// Creates a session with `input` (the draft's workspace, model,
    /// thinking level, and permission mode), shows it, and sends `text` with
    /// `files` as its first message once its subscription is ready, as the
    /// Desktop's first send does (`send` in
    /// apps/desktop/src/renderer/app-shell-chat-actions.ts: create, observe,
    /// then submit). [`NewSessionEvent::Created`] tells the window, which
    /// lists the new session.
    ///
    /// The session exists for its first message. When the Host does not
    /// take the message, when its subscription cannot open, or when another
    /// task is chosen before the message went, it is deleted again
    /// (`session.remove`, as Desktop's `discardUnsentSession`) and
    /// [`NewSessionEvent::Discarded`] tells the window. A request that
    /// failed on its way leaves it, since the Host may have taken the
    /// message. Only from no session (the new task's draft), one at a time.
    pub fn start_session(
        &mut self,
        input: SessionCreateInput,
        text: String,
        files: Vec<PickedFile>,
        cx: &mut Context<Self>,
    ) -> Task<Result<SendOutcome, SharedString>> {
        let locale = Locale::current(cx);
        if self.session_id.is_some() {
            return Task::ready(Err(copy::OTHER_SESSION.in_locale(locale).into()));
        }
        if self.first.is_some() {
            return Task::ready(Err(copy::SEND_BUSY.in_locale(locale).into()));
        }
        let session_id: SharedString = input.session_id.clone().into();
        log::info!(
            "session.create {session_id} in {}",
            serde_json::to_string(&input.workspace).unwrap_or_default()
        );
        let request = self.requester(cx).request::<SessionCreate>(&input);
        let (reply, answer) = async_channel::bounded(1);
        self.first = Some(FirstSend {
            session_id: session_id.clone(),
            revision: None,
            message: Some((text, files)),
            reply,
        });
        self._first = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| this.finish_create(session_id, result, cx)).ok();
        }));
        cx.notify();
        receive(answer, copy::SEND_FAILED.in_locale(locale), cx)
    }

    fn finish_create(
        &mut self,
        session_id: SharedString,
        result: Result<SessionCatalogItem, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let wanted = self.first.as_ref().is_some_and(|first| first.session_id == session_id);
        let created = match result {
            Ok(item) => match &item {
                SessionCatalogItem::Session(session) if session.id == session_id => {
                    Ok((session.revision, item))
                }
                _ => Err(copy::SEND_UNEXPECTED.in_locale(locale).to_owned()),
            },
            Err(error) => {
                log::warn!("session {session_id}: session.create failed: {error}");
                Err(failure(locale, NEW_TASK_FAILED.in_locale(locale), &error.to_string()))
            }
        };
        let (revision, item) = match created {
            Ok(created) => created,
            Err(message) => {
                if wanted && let Some(first) = self.first.take() {
                    first.reply.try_send(Err(message.into())).ok();
                    cx.notify();
                }
                return;
            }
        };
        if !wanted {
            // Another task was chosen while it was being created.
            log::info!("session {session_id}: created for a draft that moved on, deleting it");
            self.remove_session(session_id, revision, cx);
            return;
        }
        if let Some(first) = self.first.as_mut() {
            first.revision = Some(revision);
        }
        log::info!("session {session_id}: created; opening it for its first message");
        cx.emit(NewSessionEvent::Created(Box::new(item)));
        self.select_session(Some(session_id), cx);
    }

    /// Submits the new session's first message, once its subscription is
    /// ready.
    fn submit_first(&mut self, cx: &mut Context<Self>) {
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        let Some((text, files)) = self
            .first
            .as_mut()
            .filter(|first| first.session_id == session_id)
            .and_then(|first| first.message.take())
        else {
            return;
        };
        let sent =
            self.submit_with_attachments(&session_id, text, files, MessagePlacement::NextTurn, cx);
        self._first = Some(cx.spawn(async move |this, cx| {
            let result = sent.await;
            this.update(cx, |this, cx| this.finish_first(&session_id, result, cx)).ok();
        }));
    }

    fn finish_first(
        &mut self,
        session_id: &SharedString,
        result: Result<SendOutcome, NotSent>,
        cx: &mut Context<Self>,
    ) {
        let Some(first) = self.first.take_if(|first| &first.session_id == session_id) else {
            return;
        };
        match result {
            Ok(outcome) => {
                first.reply.try_send(Ok(outcome)).ok();
            }
            Err(NotSent::Unknown(message)) => {
                first.reply.try_send(Err(message)).ok();
            }
            Err(NotSent::Refused(message)) => {
                log::info!("session {session_id}: its first message was not taken, deleting it");
                first.reply.try_send(Err(message)).ok();
                self.discard_session(first.session_id, first.revision, cx);
            }
        }
        cx.notify();
    }

    /// Deletes `session_id`, created for a first message it never got, and
    /// tells the window; the draft shows again in its place.
    fn discard_session(
        &mut self,
        session_id: SharedString,
        revision: Option<u64>,
        cx: &mut Context<Self>,
    ) {
        let Some(revision) = revision else {
            return;
        };
        self.remove_session(session_id.clone(), revision, cx);
        cx.emit(NewSessionEvent::Discarded(session_id.clone()));
        if self.session_id.as_ref() == Some(&session_id) {
            self.select_session(None, cx);
        }
    }

    /// `session.remove` at `revision`, best effort: a failure is logged and
    /// the next catalog load shows the session again. A revision conflict
    /// is retried once at the revision the Host names.
    fn remove_session(&self, session_id: SharedString, revision: u64, cx: &mut App) {
        let requester = self.requester(cx);
        cx.spawn(async move |_| {
            let mut expected = revision;
            for _ in 0..2 {
                let input = SessionRemoveInput::new(session_id.to_string(), expected);
                match requester.request::<SessionRemove>(&input).await {
                    Ok(SessionRemoveResult::Removed { .. }) => {
                        log::info!("session {session_id}: deleted");
                        return;
                    }
                    Ok(SessionRemoveResult::RevisionConflict { actual_revision, .. }) => {
                        expected = actual_revision;
                    }
                    Ok(_) => break,
                    Err(error) => {
                        log::warn!("session {session_id}: session.remove failed: {error}");
                        return;
                    }
                }
            }
            log::warn!("session {session_id}: could not be deleted");
        })
        .detach();
    }

    /// Moves the queued follow-up `entry_id` into the running turn as
    /// steering (`queue.entry.promote`).
    pub fn promote_queued(
        &mut self,
        entry_id: &str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        let locale = Locale::current(cx);
        let Some((epoch, session_id)) = self.queue_target() else {
            return Task::ready(Err(copy::NOT_READY.in_locale(locale).into()));
        };
        let input = QueueEntryPromoteInput::new(epoch, session_id, entry_id, fresh_id());
        self.queue_command::<QueueEntryPromote>(
            entry_id,
            input,
            copy::QUEUE_PROMOTE_FAILED.in_locale(locale),
            cx,
        )
    }

    /// Takes the queued entry `entry_id` back before it is sent
    /// (`queue.entry.retract`).
    pub fn retract_queued(
        &mut self,
        entry_id: &str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        let locale = Locale::current(cx);
        let Some((epoch, session_id)) = self.queue_target() else {
            return Task::ready(Err(copy::NOT_READY.in_locale(locale).into()));
        };
        let input = QueueEntryRetractInput::new(epoch, session_id, entry_id, fresh_id());
        self.queue_command::<QueueEntryRetract>(
            entry_id,
            input,
            copy::QUEUE_RETRACT_FAILED.in_locale(locale),
            cx,
        )
    }

    /// Replaces the text of the queued entry `entry_id` with `text`
    /// (`queue.entry.update`), at `expected_revision`, the queue revision the
    /// edit started from, when the entry read `original`.
    ///
    /// The Host refuses the update with `operation_conflict` once the queue
    /// has moved since (`HostMessageCoordinator` in
    /// packages/runtime-host/src/server/message-coordinator.ts), which it does
    /// whenever the running turn takes steering or another message is queued.
    /// On that refusal the revision is read again from the latest projection
    /// and the update is sent once more at it, with the same text, when that
    /// revision is newer and the entry is still queued with the text the edit
    /// started from; a second refusal, or an entry someone else changed, is
    /// reported as the failure.
    pub fn edit_queued(
        &mut self,
        entry_id: &str,
        expected_revision: u64,
        original: &str,
        text: &str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        let locale = Locale::current(cx);
        let what = copy::QUEUE_EDIT_FAILED.in_locale(locale);
        let Some((epoch, session_id)) = self.queue_target() else {
            return Task::ready(Err(copy::NOT_READY.in_locale(locale).into()));
        };
        if self.queue_action.is_some() {
            return Task::ready(Err(copy::QUEUE_BUSY.in_locale(locale).into()));
        }
        log::info!(
            "session {session_id}: {} {entry_id} at queue revision {expected_revision}",
            QueueEntryUpdate::NAME
        );
        let requester = self.requester(cx);
        self.queue_action = Some(entry_id.to_owned());
        cx.notify();
        let (entry_id, original, text) =
            (entry_id.to_owned(), original.to_owned(), text.to_owned());
        let (reply, answer) = async_channel::bounded(1);
        self._queue = Some(cx.spawn(async move |this, cx| {
            let mut expected = expected_revision;
            let mut retried = false;
            let result = loop {
                let input = QueueEntryUpdateInput::new(
                    &epoch,
                    &session_id,
                    &entry_id,
                    fresh_id(),
                    expected,
                    &text,
                );
                let result = requester.request::<QueueEntryUpdate>(&input).await;
                let conflict = matches!(
                    &result,
                    Err(HostRequestError::Operation {
                        code: HostOperationErrorCode::OperationConflict,
                        ..
                    })
                );
                if !conflict || retried {
                    break result;
                }
                let latest = this
                    .read_with(cx, |this, _| this.edit_retry_revision(&entry_id, expected, &original))
                    .ok()
                    .flatten();
                let Some(latest) = latest else {
                    break result;
                };
                log::info!(
                    "session {session_id}: queue revision {expected} is stale; editing {entry_id} again at {latest}"
                );
                expected = latest;
                retried = true;
            };
            let outcome = this
                .update(cx, |this, cx| {
                    this.queue_action = None;
                    cx.notify();
                    match result {
                        Ok(done) => {
                            log::info!(
                                "session {}: {} answered queue revision {}",
                                this.label(),
                                QueueEntryUpdate::NAME,
                                done.queue_revision
                            );
                            Ok(())
                        }
                        Err(error) => {
                            log::warn!(
                                "session {}: {} failed: {error}",
                                this.label(),
                                QueueEntryUpdate::NAME
                            );
                            Err(failure(locale, what, &error.to_string()).into())
                        }
                    }
                })
                .unwrap_or_else(|_| Err(what.into()));
            reply.try_send(outcome).ok();
        }));
        receive(answer, what, cx)
    }

    /// The queue revision to send an edit of `entry_id` at again after
    /// `refused` was refused as stale: the latest projection's, when it is
    /// newer and the entry is still queued and still reads `original`.
    fn edit_retry_revision(&self, entry_id: &str, refused: u64, original: &str) -> Option<u64> {
        let queue = self.queue()?;
        let entry = queue.entries().find(|entry| entry.entry_id == entry_id)?;
        let unchanged = entry.state == MessageQueueEntryState::Queued
            && entry.content.user_facing_text() == original;
        (queue.queue_revision > refused && unchanged).then_some(queue.queue_revision)
    }

    /// The Host epoch and session a queue command names.
    fn queue_target(&self) -> Option<(String, String)> {
        let transcript =
            self.transcript.as_ref().filter(|_| self.phase == ConversationPhase::Live)?;
        Some((transcript.host_epoch().to_owned(), self.session_id.as_ref()?.to_string()))
    }

    /// Sends one `queue.*` command for `entry_id`. One at a time; the next
    /// projection shows the queue it left.
    fn queue_command<O>(
        &mut self,
        entry_id: &str,
        input: O::Input,
        what: &'static str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>>
    where
        O: Operation<Output = QueueMutationResult> + 'static,
    {
        let locale = Locale::current(cx);
        if self.queue_action.is_some() {
            return Task::ready(Err(copy::QUEUE_BUSY.in_locale(locale).into()));
        }
        log::info!("session {}: {} {entry_id}", self.label(), O::NAME);
        let request = self.requester(cx).request::<O>(&input);
        self.queue_action = Some(entry_id.to_owned());
        cx.notify();
        let (reply, answer) = async_channel::bounded(1);
        self._queue = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let outcome = this
                .update(cx, |this, cx| {
                    this.queue_action = None;
                    cx.notify();
                    match result {
                        Ok(done) => {
                            log::info!(
                                "session {}: {} answered queue revision {}",
                                this.label(),
                                O::NAME,
                                done.queue_revision
                            );
                            Ok(())
                        }
                        Err(error) => {
                            log::warn!("session {}: {} failed: {error}", this.label(), O::NAME);
                            Err(failure(locale, what, &error.to_string()).into())
                        }
                    }
                })
                .unwrap_or_else(|_| Err(what.into()));
            reply.try_send(outcome).ok();
        }));
        receive(answer, what, cx)
    }

    /// Stops the running root turn of `session_id` with `turn.stop`, naming
    /// the turn and run from [`Transcript::root_turn`].
    pub fn stop_turn(
        &mut self,
        session_id: &str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        let locale = Locale::current(cx);
        if self.session_id.as_deref() != Some(session_id) {
            return Task::ready(Err(copy::OTHER_SESSION.in_locale(locale).into()));
        }
        if self.turn_activity() != TurnActivity::Running {
            return Task::ready(Err(copy::NOTHING_RUNNING.in_locale(locale).into()));
        }
        let Some(root) = self.running_turn() else {
            return Task::ready(Err(copy::NOTHING_RUNNING.in_locale(locale).into()));
        };
        let input = TurnStopInput::new(session_id, root.turn_id.clone(), root.run_id.clone());
        log::info!("session {session_id}: turn.stop {} (run {})", root.turn_id, root.run_id);
        let request = self.requester(cx).request::<TurnStop>(&input);
        self.stopping = true;
        cx.notify();
        let session_id = SharedString::from(session_id.to_owned());
        let (reply, answer) = async_channel::bounded(1);
        self._stop = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let outcome = this
                .update(cx, |this, cx| {
                    this.stopping = false;
                    cx.notify();
                    match result {
                        Ok(turn) => {
                            log::info!(
                                "session {session_id}: turn.stop answered {:?}",
                                turn.status
                            );
                            Ok(())
                        }
                        Err(error) => {
                            log::warn!("session {session_id}: turn.stop failed: {error}");
                            Err(failure(
                                locale,
                                copy::STOP_FAILED.in_locale(locale),
                                &error.to_string(),
                            )
                            .into())
                        }
                    }
                })
                .unwrap_or_else(|_| Err(copy::STOP_FAILED.in_locale(locale).into()));
            reply.try_send(outcome).ok();
        }));
        receive(answer, copy::STOP_FAILED.in_locale(locale), cx)
    }

    /// Answers the prompt `interaction_id` with `interaction.answer`, then
    /// records the answered snapshot in the transcript. Refused while an
    /// answer to the same prompt is in flight.
    pub fn answer_interaction(
        &mut self,
        interaction_id: &str,
        answer: InteractionAnswer,
        cx: &mut Context<Self>,
    ) {
        if matches!(self.answers.get(interaction_id), Some(AnswerState::Sending(_))) {
            return;
        }
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        let input = InteractionAnswerInput::new(
            session_id.to_string(),
            interaction_id.to_owned(),
            answer.clone(),
        );
        log::info!("session {session_id}: interaction.answer {interaction_id} {answer:?}");
        let request = self.requester(cx).request::<InteractionAnswerCommand>(&input);
        self.answers.insert(interaction_id.to_owned(), AnswerState::Sending(answer));
        let id = interaction_id.to_owned();
        let task = cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| this.finish_answer(&session_id, &id, result, cx)).ok();
        });
        self._answers.insert(interaction_id.to_owned(), task);
        self.commit_now(cx);
    }

    /// Changes the selected session's configuration with
    /// `session.configuration.update`, at the revision its settings were read
    /// at, and shows the committed settings. A revision conflict re-reads the
    /// session and tries once more. One change at a time; on failure the
    /// settings stay as they were (or as the re-read found them), and the
    /// error starts with `what` failed.
    pub fn configure_session(
        &mut self,
        patch: SessionConfigurationPatch,
        what: &'static str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        let locale = Locale::current(cx);
        let (Some(session_id), Some(settings)) = (self.session_id.clone(), self.settings.as_ref())
        else {
            return Task::ready(Err(copy::NOT_READY.in_locale(locale).into()));
        };
        if self.configuring {
            return Task::ready(Err(copy::CONFIGURE_BUSY.in_locale(locale).into()));
        }
        let requester = self.requester(cx);
        let expected = settings.revision;
        self.configuring = true;
        cx.notify();
        let (reply, answer) = async_channel::bounded(1);
        self._configure = Some(cx.spawn(async move |this, cx| {
            let configured = configure_with_retry(
                requester,
                session_id.to_string(),
                expected,
                patch,
                what,
                locale,
            )
            .await;
            let outcome = this
                .update(cx, |this, cx| this.finish_configure(&session_id, configured, cx))
                .unwrap_or_else(|_| Err(what.into()));
            reply.try_send(outcome).ok();
        }));
        receive(answer, what, cx)
    }

    fn finish_configure(
        &mut self,
        session_id: &str,
        configured: Configured,
        cx: &mut Context<Self>,
    ) -> Result<(), SharedString> {
        let locale = Locale::current(cx);
        if self.session_id.as_deref() != Some(session_id) {
            return Err(copy::OTHER_SESSION.in_locale(locale).into());
        }
        self.configuring = false;
        self._configure = None;
        if let Some(session) = configured.latest {
            let settings = SessionSettings::from_projection(&session);
            self.settings_revision = self.settings_revision.max(settings.revision);
            self.settings = Some(settings);
        }
        cx.notify();
        configured.result
    }

    fn finish_answer(
        &mut self,
        session_id: &str,
        interaction_id: &str,
        result: Result<InteractionSnapshot, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        if self.session_id.as_deref() != Some(session_id) {
            return;
        }
        self._answers.remove(interaction_id);
        match result {
            Ok(snapshot) => {
                log::info!(
                    "session {session_id}: interaction {interaction_id} is {:?}",
                    snapshot.status
                );
                self.answers.remove(interaction_id);
                let changes = self
                    .transcript
                    .as_mut()
                    .map(|transcript| transcript.apply_interaction(&snapshot))
                    .unwrap_or_default();
                self.pending.extend(changes);
            }
            Err(error) => {
                log::warn!("session {session_id}: interaction.answer failed: {error}");
                let message =
                    failure(locale, copy::ANSWER_FAILED.in_locale(locale), &error.to_string());
                self.answers.insert(interaction_id.to_owned(), AnswerState::Failed(message.into()));
            }
        }
        self.commit_now(cx);
    }
}

/// What a `session.configuration.update` came to, before it is applied.
struct Configured {
    /// The newest projection seen: the committed one, or the one re-read
    /// after a revision conflict.
    latest: Option<SessionCatalogProjection>,
    result: Result<(), SharedString>,
}

/// Sends `session.configuration.update` at `expected`. On a revision
/// conflict it re-reads the session once (`session.catalog.query` `get`)
/// and sends the patch again at the revision it read, as the Desktop's and
/// the CLI's update helpers do (`#updateSession` in
/// apps/desktop/src/main/runtime-host-client.ts,
/// `updateRuntimeHostSession` in packages/cli/src/runtime-host-session-update.ts),
/// but only once: a second conflict means someone else keeps changing it.
async fn configure_with_retry(
    requester: HostRequester,
    session_id: String,
    expected: u64,
    patch: SessionConfigurationPatch,
    what: &'static str,
    locale: Locale,
) -> Configured {
    let failed = |message: String, latest| Configured { latest, result: Err(message.into()) };
    let mut expected = expected;
    let mut latest = None;
    for attempt in 0..2 {
        let input = SessionConfigurationUpdateInput::new(&session_id, expected, patch.clone());
        log::info!(
            "session {session_id}: session.configuration.update at revision {expected}: {}",
            serde_json::to_string(&input.patch).unwrap_or_default()
        );
        match requester.request::<SessionConfigurationUpdate>(&input).await {
            Ok(SessionUpdateResult::Committed {
                session: SessionCatalogItem::Session(session),
            }) => {
                log::info!(
                    "session {session_id}: configuration committed at revision {}: model {} on {}, {}, thinking {}",
                    session.revision,
                    session.model,
                    session.llm_connection_slug,
                    session.permission_mode,
                    session.thinking_level.as_ref().map_or("default", ThinkingLevel::as_str)
                );
                return Configured { latest: Some(*session), result: Ok(()) };
            }
            Ok(SessionUpdateResult::Committed { .. }) => {
                return failed(copy::CONFIGURE_LEGACY.in_locale(locale).to_owned(), latest);
            }
            Ok(SessionUpdateResult::RevisionConflict { actual_revision, .. }) if attempt == 0 => {
                log::info!(
                    "session {session_id}: revision {expected} is stale (now {actual_revision}); \
                     reading the session again"
                );
                let get = SessionCatalogQueryInput::Get { session_id: session_id.clone() };
                match requester.request::<SessionCatalogQuery>(&get).await {
                    Ok(SessionCatalogQueryResult::Session {
                        session: Some(SessionCatalogItem::Session(session)),
                    }) => {
                        expected = session.revision;
                        latest = Some(*session);
                    }
                    Ok(_) => {
                        return failed(
                            copy::CONFIGURE_MISSING.in_locale(locale).to_owned(),
                            latest,
                        );
                    }
                    Err(error) => {
                        return failed(failure(locale, what, &error.to_string()), latest);
                    }
                }
            }
            Ok(SessionUpdateResult::RevisionConflict { .. }) => {
                return failed(copy::CONFIGURE_CONFLICT.in_locale(locale).to_owned(), latest);
            }
            Ok(_) => return failed(copy::SEND_UNEXPECTED.in_locale(locale).to_owned(), latest),
            Err(error) => {
                log::warn!("session {session_id}: session.configuration.update failed: {error}");
                return failed(failure(locale, what, &error.to_string()), latest);
            }
        }
    }
    failed(copy::CONFIGURE_CONFLICT.in_locale(locale).to_owned(), latest)
}

/// A fresh client-chosen id (`^[A-Za-z0-9_-]{1,128}$`).
fn fresh_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A task that resolves with what a send sends on `answer`.
fn receive_send(
    answer: async_channel::Receiver<Result<SendOutcome, NotSent>>,
    failed: &'static str,
    cx: &App,
) -> Task<Result<SendOutcome, NotSent>> {
    cx.foreground_executor().spawn(async move {
        answer.recv().await.unwrap_or_else(|_| Err(NotSent::Unknown(failed.into())))
    })
}

/// A new session id: a hyphenated UUID v4, like the TS clients use. The
/// Host requires `^[A-Za-z0-9_-]{1,128}$` (`requireEntityId`).
pub(crate) fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A task that resolves with what a command task sends on `answer`.
fn receive<T: 'static>(
    answer: async_channel::Receiver<Result<T, SharedString>>,
    failed: &'static str,
    cx: &App,
) -> Task<Result<T, SharedString>> {
    cx.foreground_executor()
        .spawn(async move { answer.recv().await.unwrap_or_else(|_| Err(failed.into())) })
}

/// The settings in a `session.catalog.query` `get` answer.
fn session_settings(
    result: Result<SessionCatalogQueryResult, HostRequestError>,
) -> Result<SessionSettings, String> {
    match result.map_err(|error| error.to_string())? {
        SessionCatalogQueryResult::Session {
            session: Some(SessionCatalogItem::Session(session)),
        } => Ok(SessionSettings::from_projection(&session)),
        SessionCatalogQueryResult::Session { session: Some(_) } => {
            Err("a legacy record the Host can't represent".to_owned())
        }
        SessionCatalogQueryResult::Session { session: None } => Err("no such session".to_owned()),
        _ => Err("an answer that isn't a session".to_owned()),
    }
}

fn describe_root(root: Option<&TurnSnapshot>) -> String {
    match root {
        Some(root) => format!("{} {:?}", root.turn_id, root.status),
        None => "none".to_owned(),
    }
}

/// One log line for a commit: counts of the frequent changes, then the
/// notable ones by name.
fn describe_changes(changes: &[Change], state: &ConversationState) -> String {
    let mut appended = 0;
    let mut updated = 0;
    let mut notable = Vec::new();
    for change in changes {
        match change {
            Change::ItemTextAppended { .. } => appended += 1,
            Change::ItemUpdated { .. } | Change::TurnUpdated { .. } => updated += 1,
            Change::SessionStateChanged | Change::TranscriptBehind { .. } => {}
            Change::TurnAdded { turn_id, .. } => notable.push(format!("turn {turn_id} added")),
            Change::TurnFinished { turn_id, status } => {
                notable.push(format!("turn {turn_id} finished {status:?}"));
            }
            Change::ItemAdded { key, .. } => notable.push(format!("{key} added")),
            Change::ItemRemoved { key, .. } => notable.push(format!("{key} removed")),
            other => notable.push(format!("{other:?}")),
        }
    }
    let pending: Vec<String> = state
        .transcript
        .as_ref()
        .map(|transcript| {
            transcript
                .pending_interactions()
                .iter()
                .map(|pending| format!("{} {:?}", pending.interaction_id, pending.request))
                .collect()
        })
        .unwrap_or_default();
    let mut line = format!("{} changes ({appended} text deltas, {updated} updates)", changes.len());
    if !notable.is_empty() {
        line.push_str("; ");
        line.push_str(&notable.join(", "));
    }
    line.push_str(&format!("; activity {:?}", state.turn_activity()));
    if !pending.is_empty() {
        line.push_str(&format!("; pending prompts: {}", pending.join(", ")));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::TurnActivity;

    #[test]
    fn a_loaded_session_always_takes_messages_and_only_a_running_turn_stops() {
        let all = [
            TurnActivity::Unavailable,
            TurnActivity::Idle,
            TurnActivity::Starting,
            TurnActivity::Running,
            TurnActivity::Stopping,
        ];
        let sendable: Vec<_> = all.iter().filter(|activity| activity.is_sendable()).collect();
        let queues: Vec<_> = all.iter().filter(|activity| activity.queues()).collect();
        let stoppable: Vec<_> = all.iter().filter(|activity| activity.is_stoppable()).collect();
        assert_eq!(sendable, all[1..].iter().collect::<Vec<_>>());
        assert_eq!(
            queues,
            [&TurnActivity::Starting, &TurnActivity::Running, &TurnActivity::Stopping]
        );
        assert_eq!(stoppable, [&TurnActivity::Running]);
    }
}
