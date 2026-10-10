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

//! One terminal of a task: a PTY the Host runs, the controller seat this
//! window takes on it, and the emulator its output is parsed into.
//!
//! The requests on one PTY go one at a time, as Maka Desktop serializes them
//! (`#run` in `apps/desktop/src/main/runtime-host-shell-runs-ipc-main.ts`):
//! a stop, then a release, then an acquire, then the next control. Each
//! answer is matched to the connection it was asked on; a new connection
//! starts over with a new controller id.

use std::sync::Arc;
use std::time::Duration;

use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::{Point, Side};
use alacritty_terminal::selection::SelectionType;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::TermMode;
use futures_lite::future;
use gpui_kit::{
    AppContext as _, BackgroundExecutor, Context, EventEmitter, Keystroke, Modifiers, SharedString,
    Task,
};
use host_protocol::{
    HostOperationError, PtySize, RuntimeResourceControlInput, RuntimeResourceControllerAcquire,
    RuntimeResourceControllerControl, RuntimeResourceControllerInput,
    RuntimeResourceControllerRelease, RuntimeResourceFailure, RuntimeResourceQuery,
    RuntimeResourceQueryInput, RuntimeResourceQueryResult, RuntimeResourceStop,
    RuntimeResourceStopInput, ShellRunState,
};
use search::SearchQuery;
use workspace::{HostRequestError, HostRequester};

use crate::controls::ControlQueue;
use crate::emulator::{
    Emulator, EmulatorEvent, SYNC_UPDATE_TIMEOUT, TerminalContent, default_size,
};
use crate::hydration::{Accepted, Hydration};
use crate::input::{self, MouseAction};
use crate::link::{self, TerminalLink};
use crate::owner::TerminalsShown;
use crate::search::{GridText, TerminalMatch};

/// The first parsed output is shown at once; what follows within this
/// window is shown together, as Zed's terminal batches its events.
pub const BATCH_WINDOW: Duration = Duration::from_millis(4);
/// At most this many parsed outputs go into one batch.
pub const BATCH_LIMIT: usize = 100;
/// Feeds the background parser applies before it publishes a picture.
const FEEDS_PER_PASS: usize = 64;
/// Pictures the parser may publish before the window takes them.
const PICTURES_IN_FLIGHT: usize = 4;
/// The output broke (a gap, a `reset` frame, a backlog too long to hold
/// for a snapshot): the acquire again waits this long, so that a burst of
/// breaks costs one. The wait doubles, up to [`RESYNC_MAX_DELAY`], each
/// time the output breaks again before an attach settles.
pub(crate) const RESYNC_DELAY: Duration = Duration::from_millis(100);
pub(crate) const RESYNC_MAX_DELAY: Duration = Duration::from_secs(1);
/// An attach whose output keeps joining its snapshot this long has
/// settled: the next break waits [`RESYNC_DELAY`] again.
pub(crate) const RESYNC_SETTLE: Duration = Duration::from_secs(1);

/// Where a terminal's attachment to this window stands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TerminalPhase {
    /// No controller: its face does not show. While its tab does (the
    /// panel shows another face) its output still streams in, for the tab's
    /// title and bell, onto the last picture, which a snapshot replaces
    /// when the face shows again; with the panel hidden, no output either.
    Detached,
    /// Its output and the controller are being acquired, or acquired again
    /// after a gap or a new connection; the last picture stays meanwhile.
    Attaching,
    /// This window controls the PTY and its output streams in.
    Live,
    /// Another window or app controls the PTY: the Host allows one
    /// controller per PTY. [`Terminal::retry`] asks again.
    HeldElsewhere,
    /// Attaching failed; [`Terminal::retry`] tries again.
    Failed(SharedString),
    /// The shell ended. Nothing more is sent; the last picture stays.
    Exited { exit_code: Option<i64>, failure_message: Option<SharedString> },
}

/// Where closing the terminal (stopping its shell) stands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CloseState {
    Open,
    /// `runtime.resource.stop` is in flight or due.
    Closing,
    /// The stop failed; [`Terminal::close`] tries again.
    Failed(SharedString),
}

/// Emitted by [`Terminal`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TerminalEvent {
    /// The program set or reset its title ([`Terminal::title`]).
    TitleChanged,
    /// The program rang the bell.
    Bell,
    /// The program asked to put this text on the clipboard (OSC 52 write).
    /// Whether to is the view's call; a program can never read it.
    ClipboardStore(String),
    /// The shell ended.
    Exited,
    /// The close is confirmed: the shell is gone and the terminal with it.
    Closed,
    /// It holds no controller and has nothing in flight.
    Released,
    /// The output it needs from the subscription changed
    /// ([`Terminal::wants_output`]).
    InterestChanged,
}

/// The kind of request in flight on the PTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Request {
    Acquire,
    Control,
    Release,
    Stop,
}

/// What the background parser is asked to do, in order.
enum Feed {
    Hydrate { size: PtySize, buffer: String, grid: PtySize },
    Output(String),
    Resize(PtySize),
    Scroll(Scroll),
    ScrollTo(usize),
    CursorBlinkDefault(bool),
    StartSelection(SelectionType, Point, Side),
    UpdateSelection(Point, Side),
    ClearSelection,
}

/// What the parser publishes after a pass.
struct Parsed {
    content: Arc<TerminalContent>,
    events: Vec<EmulatorEvent>,
}

/// One terminal: a Host PTY (`maka://runtime/background-tasks/<id>`) of
/// a task.
///
/// Its owner ([`crate::Terminals`]) keeps it while its task is selected and
/// hands it the subscription's output and the connection; a view reads its
/// picture ([`Self::content`]) and sends what the person types. Its state
/// outlives every view: closing a view only releases the controller.
pub struct Terminal {
    session_id: SharedString,
    resource_ref: SharedString,
    requester: HostRequester,
    /// The connection the owner is on, by generation; `None` while
    /// disconnected.
    connection: Option<u64>,
    /// This connection's controller id for the PTY; a new connection gets
    /// a new one.
    controller_id: String,
    phase: TerminalPhase,
    close: CloseState,
    /// How much of it the window shows: its tab, its face, or nothing.
    shown: TerminalsShown,
    /// The subscription on which the Host confirmed interest in its output.
    interest: Option<SharedString>,
    controller_held: bool,
    acquire_due: bool,
    release_due: bool,
    stop_due: bool,
    /// The request in flight and the connection it went out on.
    in_flight: Option<(Request, u64)>,
    hydration: Hydration,
    controls: ControlQueue,
    /// The grid a view asked for, clamped to what the Host accepts.
    grid: Option<PtySize>,
    reading_state: bool,
    read_again: bool,
    /// What the next break of the output waits before acquiring again.
    resync_delay: Duration,
    /// The wait after a break, while it runs: the acquire due goes after.
    _resync: Option<Task<()>>,
    /// From an attach's commit: run out with no break, the wait resets.
    _settle: Option<Task<()>>,
    emulator: Arc<FairMutex<Emulator>>,
    feeds: async_channel::Sender<Feed>,
    content: Arc<TerminalContent>,
    title: Option<SharedString>,
    bell: bool,
    /// Whether the cursor blinks while the program has not chosen.
    blink_default: bool,
    _request: Option<Task<()>>,
    _read: Option<Task<()>>,
    _parser: Task<()>,
    _batches: Task<()>,
}

impl EventEmitter<TerminalEvent> for Terminal {}

impl std::fmt::Debug for Terminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminal")
            .field("resource_ref", &self.resource_ref)
            .field("phase", &self.phase)
            .field("close", &self.close)
            .finish_non_exhaustive()
    }
}

impl Terminal {
    /// A terminal of `session_id` with the PTY `resource_ref`, on the
    /// connection `connection`. Nothing is sent until it shows.
    pub(crate) fn new(
        session_id: SharedString,
        resource_ref: SharedString,
        requester: HostRequester,
        connection: Option<u64>,
        cx: &mut Context<Self>,
    ) -> Self {
        let emulator = Arc::new(FairMutex::new(Emulator::new(default_size())));
        let content = Arc::new(emulator.lock().content());
        let (feeds, feed_receiver) = async_channel::unbounded();
        // Each picture copies the visible cells: while the window is busy the
        // parser waits instead of piling them up, and catches up in fewer,
        // larger passes.
        let (parsed, parsed_receiver) = async_channel::bounded(PICTURES_IN_FLIGHT);
        let parser = cx.background_spawn(parse(
            emulator.clone(),
            feed_receiver,
            parsed,
            cx.background_executor().clone(),
        ));
        let batches = cx.spawn(async move |this, cx| {
            while let Ok(first) = parsed_receiver.recv().await {
                if this.update(cx, |this, cx| this.apply_parsed(vec![first], cx)).is_err() {
                    return;
                }
                let mut batch = Vec::new();
                let mut window = cx.background_executor().timer(BATCH_WINDOW);
                while batch.len() < BATCH_LIMIT {
                    let next = future::or(async { parsed_receiver.recv().await.ok() }, async {
                        (&mut window).await;
                        None
                    })
                    .await;
                    let Some(parsed) = next else { break };
                    batch.push(parsed);
                }
                if !batch.is_empty()
                    && this.update(cx, |this, cx| this.apply_parsed(batch, cx)).is_err()
                {
                    return;
                }
            }
        });
        Self {
            session_id,
            resource_ref,
            requester,
            connection,
            controller_id: new_controller_id(),
            phase: TerminalPhase::Detached,
            close: CloseState::Open,
            shown: TerminalsShown::Hidden,
            interest: None,
            controller_held: false,
            acquire_due: false,
            release_due: false,
            stop_due: false,
            in_flight: None,
            hydration: Hydration::default(),
            controls: ControlQueue::default(),
            grid: None,
            reading_state: false,
            read_again: false,
            resync_delay: RESYNC_DELAY,
            _resync: None,
            _settle: None,
            emulator,
            feeds,
            content,
            title: None,
            bell: false,
            blink_default: false,
            _request: None,
            _read: None,
            _parser: parser,
            _batches: batches,
        }
    }

    // What a view reads.

    pub fn session_id(&self) -> &SharedString {
        &self.session_id
    }

    /// The PTY's ref, `maka://runtime/background-tasks/<id>`: a stable id
    /// for the terminal's tab.
    pub fn resource_ref(&self) -> &SharedString {
        &self.resource_ref
    }

    pub fn phase(&self) -> &TerminalPhase {
        &self.phase
    }

    pub fn close_state(&self) -> &CloseState {
        &self.close
    }

    /// The picture to paint, as of the last batch of output.
    pub fn content(&self) -> &Arc<TerminalContent> {
        &self.content
    }

    /// The program's title, for the tab.
    pub fn title(&self) -> Option<&SharedString> {
        self.title.as_ref()
    }

    /// Whether the bell rang since [`Self::clear_bell`], for a marker on
    /// the tab.
    pub fn bell(&self) -> bool {
        self.bell
    }

    pub fn clear_bell(&mut self, cx: &mut Context<Self>) {
        if std::mem::take(&mut self.bell) {
            cx.notify();
        }
    }

    /// The grid the PTY gets: the view's, clamped to 2–240 columns and
    /// 1–100 rows, so a view larger or smaller than that letterboxes.
    pub fn grid(&self) -> Option<PtySize> {
        self.grid
    }

    /// Whether what the person types goes anywhere: the shell runs and the
    /// controller is this window's or being acquired.
    pub fn accepts_input(&self) -> bool {
        matches!(self.phase, TerminalPhase::Live | TerminalPhase::Attaching)
            && self.close == CloseState::Open
    }

    pub fn is_exited(&self) -> bool {
        matches!(self.phase, TerminalPhase::Exited { .. })
    }

    // What a view sends.

    /// Sends `text` to the shell as typed (already encoded: keys through
    /// [`input::key_input`], text as is). Queued while the controller is
    /// being acquired; dropped when nothing accepts it.
    pub fn input(&mut self, text: &str, cx: &mut Context<Self>) {
        if text.is_empty() || !self.accepts_input() {
            return;
        }
        self.controls.push_input(text);
        self.pump(cx);
    }

    /// Sends what `keystroke` types, when it sends anything of its own
    /// ([`input::key_input`]). Returns whether it did.
    pub fn key(
        &mut self,
        keystroke: &Keystroke,
        option_as_meta: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(bytes) = input::key_input(keystroke, self.content.mode, option_as_meta) else {
            return false;
        };
        self.input(&bytes, cx);
        true
    }

    /// Pastes `text`: bracketed when the program asked for it, line breaks
    /// as Enter otherwise.
    pub fn paste(&mut self, text: &str, cx: &mut Context<Self>) {
        let text = input::paste_input(text, self.content.mode);
        self.input(&text, cx);
    }

    /// Tells the program the view gained or lost focus, when it asked to
    /// hear it.
    pub fn focus_changed(&mut self, focused: bool, cx: &mut Context<Self>) {
        if let Some(report) = input::focus_input(focused, self.content.mode) {
            self.input(report, cx);
        }
    }

    /// Reports a mouse action at a cell of the screen when the program
    /// asked for mouse reports. Returns whether it did; otherwise the view
    /// selects or scrolls.
    pub fn mouse(
        &mut self,
        action: MouseAction,
        column: usize,
        row: usize,
        modifiers: &Modifiers,
        cx: &mut Context<Self>,
    ) -> bool {
        match input::mouse_input(action, column, row, modifiers, self.content.mode) {
            Some(report) => {
                self.input(&report, cx);
                true
            }
            None => false,
        }
    }

    /// Turns the wheel by `lines` (up when positive): arrow keys on the
    /// alternate screen when the program asked for alternate scroll, the
    /// scrollback otherwise. Mouse reports go through [`Self::mouse`].
    pub fn scroll_wheel(&mut self, lines: i32, cx: &mut Context<Self>) {
        match input::alternate_scroll_input(lines, self.content.mode) {
            Some(arrows) => self.input(&arrows, cx),
            None => self.scroll_display(Scroll::Delta(lines)),
        }
    }

    /// Scrolls the scrollback (shown in the next picture).
    pub fn scroll_display(&mut self, scroll: Scroll) {
        self.feed(Feed::Scroll(scroll));
    }

    /// Scrolls to `display_offset` lines above the bottom (shown in the
    /// next picture): where the scrollbar was dragged to.
    pub fn scroll_to_offset(&mut self, display_offset: usize) {
        self.feed(Feed::ScrollTo(display_offset));
    }

    /// Whether the cursor blinks while the program has not chosen a style
    /// (DECSCUSR): the app's setting. A program's choice overrides it.
    pub fn set_cursor_blink_default(&mut self, blinking: bool) {
        if self.blink_default != blinking {
            self.blink_default = blinking;
            self.feed(Feed::CursorBlinkDefault(blinking));
        }
    }

    pub fn start_selection(&mut self, ty: SelectionType, point: Point, side: Side) {
        self.feed(Feed::StartSelection(ty, point, side));
    }

    pub fn update_selection(&mut self, point: Point, side: Side) {
        self.feed(Feed::UpdateSelection(point, side));
    }

    pub fn clear_selection(&mut self) {
        self.feed(Feed::ClearSelection);
    }

    /// The link at the cell `point` (grid coordinates), if it is in one: an
    /// OSC 8 hyperlink or an address in the text, `http:` or `https:` only.
    /// Read off the main thread.
    pub fn link_at(&self, point: Point, cx: &mut Context<Self>) -> Task<Option<TerminalLink>> {
        let emulator = self.emulator.clone();
        cx.background_spawn(async move { link::link_at(emulator.lock().term(), point) })
    }

    /// The selected text, read off the main thread.
    pub fn selection_text(&self, cx: &mut Context<Self>) -> Task<Option<String>> {
        let emulator = self.emulator.clone();
        cx.background_spawn(async move { emulator.lock().selection_text() })
    }

    /// Every occurrence of `query` in the grid and its scrollback, top to
    /// bottom, found off the main thread.
    pub fn find(&self, query: SearchQuery, cx: &mut Context<Self>) -> Task<Vec<TerminalMatch>> {
        let emulator = self.emulator.clone();
        cx.background_spawn(async move {
            let text = GridText::of(emulator.lock().term());
            text.find(&query)
        })
    }

    /// Sizes the PTY for a view of `cols` × `rows` cells. The grid is
    /// clamped to what the Host accepts; the emulator follows at once and
    /// the PTY with the next control, only when the size changed.
    pub fn set_grid(&mut self, cols: u16, rows: u16, cx: &mut Context<Self>) {
        let grid = PtySize::clamped(cols, rows);
        if self.grid == Some(grid) {
            return;
        }
        self.grid = Some(grid);
        if self.phase == TerminalPhase::Live {
            self.feed(Feed::Resize(grid));
            self.controls.request_resize(grid);
            self.pump(cx);
        }
        cx.notify();
    }

    /// Attaches again after [`TerminalPhase::Failed`] or
    /// [`TerminalPhase::HeldElsewhere`].
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        if matches!(self.phase, TerminalPhase::Failed(_) | TerminalPhase::HeldElsewhere)
            && self.shown == TerminalsShown::Face
        {
            self.begin_attach(cx);
        }
    }

    // What the owner drives.

    /// Whether the subscription should carry its output: its face shows
    /// and it may attach, or only its tab shows (and its shell runs).
    pub(crate) fn wants_output(&self) -> bool {
        match self.shown {
            TerminalsShown::Hidden => false,
            TerminalsShown::Tabs => self.phase == TerminalPhase::Detached,
            TerminalsShown::Face => {
                matches!(self.phase, TerminalPhase::Attaching | TerminalPhase::Live)
            }
        }
    }

    /// Whether it should hold the controller: its face shows and its shell
    /// runs.
    fn wants_controller(&self) -> bool {
        self.shown == TerminalsShown::Face && !self.is_exited()
    }

    /// Whether it holds nothing on the Host and has nothing in flight.
    pub(crate) fn is_idle(&self) -> bool {
        !self.controller_held && self.in_flight.is_none() && !self.stop_due
    }

    /// How much of it the window shows. Its face attaches it: interest,
    /// then the controller, whose snapshot replaces the picture. With only
    /// its tab showing it holds no controller and its output still streams
    /// in (the Host carries a PTY's output to any subscription that asks),
    /// so the tab's title and bell stay current. Leaving the face releases
    /// the controller after the control in flight and drops queued input;
    /// the shell keeps running.
    pub(crate) fn set_shown(&mut self, shown: TerminalsShown, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        let was = std::mem::replace(&mut self.shown, shown);
        if shown == TerminalsShown::Face {
            if !self.is_exited() {
                self.begin_attach(cx);
            }
        } else if was == TerminalsShown::Face {
            self.acquire_due = false;
            self._resync = None;
            self._settle = None;
            self.release_due = true;
            self.controls.clear();
            self.hydration.invalidate();
            if !self.is_exited() {
                self.phase = TerminalPhase::Detached;
            }
            self.pump(cx);
            cx.emit(TerminalEvent::InterestChanged);
        } else {
            cx.emit(TerminalEvent::InterestChanged);
        }
        cx.notify();
    }

    /// The Host confirmed interest in this terminal's output on
    /// `subscription`, or the interest it had is gone (`None`). Output of
    /// a stream that broke cannot be joined: it attaches again once the
    /// interest is back.
    pub(crate) fn set_interest(
        &mut self,
        subscription: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        if self.interest == subscription {
            return;
        }
        let broke = self.interest.is_some();
        self.interest = subscription;
        if broke && self.wants_output() {
            self.resync(cx);
        }
        self.pump(cx);
    }

    /// The subscription could not carry its output.
    pub(crate) fn interest_failed(&mut self, message: SharedString, cx: &mut Context<Self>) {
        if self.phase == TerminalPhase::Attaching {
            self.acquire_due = false;
            self._resync = None;
            self.phase = TerminalPhase::Failed(message);
            cx.emit(TerminalEvent::InterestChanged);
            cx.notify();
        }
    }

    /// A chunk of its output from the subscription.
    pub(crate) fn output(&mut self, sequence: u64, data: &str, cx: &mut Context<Self>) {
        if !self.wants_output() {
            return;
        }
        if self.phase == TerminalPhase::Detached {
            // Only its tab shows: what streams in is parsed for the title
            // and the bell, joined or not; the face's snapshot replaces it.
            self.feed(Feed::Output(data.to_owned()));
            return;
        }
        match self.hydration.accept(sequence, data) {
            Accepted::Apply(data) => self.feed(Feed::Output(data)),
            Accepted::Hold => {}
            Accepted::Resync => {
                log::info!("terminal {}: output has a gap, attaching again", self.resource_ref);
                self.resync(cx);
            }
        }
    }

    /// The Host dropped output (`reset`; it covers every terminal of the
    /// subscription): attach again for a fresh snapshot.
    pub(crate) fn output_dropped(&mut self, cx: &mut Context<Self>) {
        if self.wants_output() {
            self.resync(cx);
        }
    }

    /// The owner's connection changed. Controllers and the Host's replay
    /// cache die with a connection, so a new one gets a new controller id
    /// and attaches again, taking the next sequence from the acquire. A
    /// control in flight, and queued input, are dropped rather than sent
    /// again (which could type them twice); a stop in flight goes again.
    pub(crate) fn set_connection(&mut self, connection: Option<u64>, cx: &mut Context<Self>) {
        if self.connection == connection {
            return;
        }
        self.connection = connection;
        self.controller_id = new_controller_id();
        self.controller_held = false;
        self.in_flight = None;
        self._request = None;
        self.reading_state = false;
        self.read_again = false;
        self._read = None;
        self._resync = None;
        self.release_due = false;
        self.controls.clear();
        self.interest = None;
        // Whatever the attach came to on the old connection (a seat held,
        // a failure while it dropped), it starts over on the new one.
        if self.wants_controller() {
            self.begin_attach(cx);
        }
        self.pump(cx);
        cx.notify();
    }

    /// A `runtime_resource` domain change named this terminal: read its
    /// state. One read at a time; changes while it is in flight make one
    /// more read when it answers.
    pub(crate) fn resource_changed(&mut self, cx: &mut Context<Self>) {
        if self.is_exited() {
            return;
        }
        self.read_state(cx);
    }

    /// Its state as an inventory listed it.
    pub(crate) fn observed(&mut self, state: Option<&ShellRunState>, cx: &mut Context<Self>) {
        match state {
            Some(state) if !state.status.is_terminal() => {}
            state => self.exited(state, cx),
        }
    }

    /// Stops the shell (`runtime.resource.stop`), after the request in
    /// flight; queued input is dropped. The close is confirmed by the
    /// stop's answer, by an exit seen meanwhile, or by the stop failing
    /// `not_found` after the exit; then [`TerminalEvent::Closed`]. A failed
    /// stop can be closed again.
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        if self.is_exited() {
            self.close = CloseState::Open;
            cx.emit(TerminalEvent::Closed);
            return;
        }
        if self.close == CloseState::Closing {
            return;
        }
        self.close = CloseState::Closing;
        self.stop_due = true;
        self.controls.clear();
        self.pump(cx);
        cx.notify();
    }

    // The request queue.

    /// Attaches from the start: interest, then the controller. The owner
    /// hears that it needs the output, whatever it last asked for: an
    /// attach waiting for interest the owner no longer asks for would never
    /// proceed.
    fn begin_attach(&mut self, cx: &mut Context<Self>) {
        self.phase = TerminalPhase::Attaching;
        self.release_due = false;
        self.acquire_due = true;
        self._resync = None;
        self.hydration.invalidate();
        self.pump(cx);
        cx.emit(TerminalEvent::InterestChanged);
        cx.notify();
    }

    /// The output cannot be joined to the picture: acquire again, after the
    /// wait ([`RESYNC_DELAY`], longer while breaks repeat), with the
    /// interest asked for again too (as in [`Self::begin_attach`]). A break
    /// while an acquire is due, waiting or not, adds nothing: that acquire
    /// answers a fresh snapshot. One while an acquire is out makes another,
    /// after a longer wait: the snapshot on its way may miss what dropped.
    fn resync(&mut self, cx: &mut Context<Self>) {
        // Without the face nothing joins the output to a snapshot.
        if !self.wants_controller() {
            return;
        }
        self.hydration.invalidate();
        self._settle = None;
        if self.phase == TerminalPhase::Live {
            self.phase = TerminalPhase::Attaching;
        }
        if !self.acquire_due {
            self.acquire_due = true;
            let delay = self.resync_delay;
            self.resync_delay = (delay * 2).min(RESYNC_MAX_DELAY);
            log::info!("terminal {}: attaching again in {delay:?}", self.resource_ref);
            self._resync = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(delay).await;
                this.update(cx, |this, cx| {
                    this._resync = None;
                    this.pump(cx);
                })
                .ok();
            }));
        }
        self.pump(cx);
        cx.emit(TerminalEvent::InterestChanged);
        cx.notify();
    }

    /// Whether the attach waits on nothing: no acquire due or in flight,
    /// nor any other request whose answer could move it on.
    fn attach_stalled(&self) -> bool {
        self.phase == TerminalPhase::Attaching && !self.acquire_due && self.in_flight.is_none()
    }

    /// Sends the next request due, if none is in flight.
    fn pump(&mut self, cx: &mut Context<Self>) {
        if self.in_flight.is_some() {
            return;
        }
        let Some(connection) = self.connection else {
            return;
        };
        if self.stop_due {
            self.send_stop(connection, cx);
            return;
        }
        if self.release_due {
            if self.controller_held {
                self.send_release(connection, cx);
                return;
            }
            self.release_due = false;
            cx.emit(TerminalEvent::Released);
        }
        if !self.wants_controller() {
            return;
        }
        if self.acquire_due
            && self.phase == TerminalPhase::Attaching
            && self.interest.is_some()
            && self._resync.is_none()
        {
            self.send_acquire(connection, cx);
            return;
        }
        if self.controller_held
            && self.phase == TerminalPhase::Live
            && let Some((sequence, control)) = self.controls.next()
        {
            self.send_control(connection, sequence, control, cx);
        }
    }

    fn controller(&self) -> RuntimeResourceControllerInput {
        RuntimeResourceControllerInput::new(
            self.session_id.to_string(),
            self.resource_ref.to_string(),
            self.controller_id.clone(),
        )
    }

    fn send_acquire(&mut self, connection: u64, cx: &mut Context<Self>) {
        self.acquire_due = false;
        self.hydration.begin();
        self.in_flight = Some((Request::Acquire, connection));
        let request =
            self.requester.request::<RuntimeResourceControllerAcquire>(&self.controller());
        self._request = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if this.answered(Request::Acquire, connection) {
                    this.finish_acquire(result, cx);
                }
            })
            .ok();
        }));
    }

    fn finish_acquire(
        &mut self,
        result: Result<host_protocol::RuntimeResourceAcquireResult, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        match result {
            Ok(acquired) => {
                self.controller_held = true;
                let pty = acquired.pty;
                self.controls.acquired(acquired.next_sequence, pty.size);
                if !self.wants_controller() || self.phase != TerminalPhase::Attaching {
                    // Its face went, it ended, or it was given up on
                    // meanwhile (the interest failed): released next.
                    self.release_due = true;
                } else if let Some(replay) = self.hydration.commit(pty.sequence) {
                    let grid = self.grid.unwrap_or(pty.size);
                    self.feed(Feed::Hydrate { size: pty.size, buffer: pty.buffer, grid });
                    for chunk in replay {
                        self.feed(Feed::Output(chunk));
                    }
                    self.controls.request_resize(grid);
                    self.phase = TerminalPhase::Live;
                    self._settle = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(RESYNC_SETTLE).await;
                        this.update(cx, |this, _| this.resync_delay = RESYNC_DELAY).ok();
                    }));
                    log::info!(
                        "terminal {}: attached at output {} ({}x{}, grid {}x{})",
                        self.resource_ref,
                        pty.sequence,
                        pty.size.cols,
                        pty.size.rows,
                        grid.cols,
                        grid.rows
                    );
                } else {
                    // The output broke while the acquire was in flight.
                    self.resync(cx);
                }
            }
            Err(error) => self.acquire_failed(error, cx),
        }
        self.pump(cx);
        cx.notify();
    }

    fn acquire_failed(&mut self, error: HostRequestError, cx: &mut Context<Self>) {
        log::info!("terminal {}: acquire failed: {error}", self.resource_ref);
        match failure_of(&error) {
            // The next connection attaches again.
            Failure::NotConnected => {}
            Failure::Host(RuntimeResourceFailure::ControllerHeld) => {
                self.acquire_due = false;
                self._resync = None;
                self.phase = TerminalPhase::HeldElsewhere;
                cx.emit(TerminalEvent::InterestChanged);
            }
            Failure::Host(
                RuntimeResourceFailure::NotLive
                | RuntimeResourceFailure::NotFound
                | RuntimeResourceFailure::Stopping,
            ) => {
                // Most likely the shell ended; its state says.
                self.read_state(cx);
            }
            Failure::Host(_) | Failure::Unknown => {
                self.acquire_due = false;
                self._resync = None;
                self.phase = TerminalPhase::Failed(error.to_string().into());
                cx.emit(TerminalEvent::InterestChanged);
            }
        }
    }

    fn send_control(
        &mut self,
        connection: u64,
        sequence: u64,
        control: host_protocol::PtyControl,
        cx: &mut Context<Self>,
    ) {
        self.in_flight = Some((Request::Control, connection));
        let input = RuntimeResourceControlInput::new(&self.controller(), sequence, control);
        let request = self.requester.request::<RuntimeResourceControllerControl>(&input);
        self._request = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if this.answered(Request::Control, connection) {
                    this.finish_control(result.map(drop), cx);
                }
            })
            .ok();
        }));
    }

    fn finish_control(&mut self, result: Result<(), HostRequestError>, cx: &mut Context<Self>) {
        match result {
            Ok(()) => self.controls.accepted(),
            Err(error) => {
                log::info!("terminal {}: control failed: {error}", self.resource_ref);
                match failure_of(&error) {
                    // Nothing went out; the next connection starts over.
                    Failure::NotConnected => {}
                    // Whether the Host took it is unknown: it is not sent
                    // again, and an acquire answers the next sequence.
                    Failure::Unknown
                    | Failure::Host(
                        RuntimeResourceFailure::SequenceConflict
                        | RuntimeResourceFailure::ControllerLost,
                    ) => {
                        self.controls.lost();
                        self.resync(cx);
                    }
                    Failure::Host(RuntimeResourceFailure::ControllerHeld) => {
                        self.controls.lost();
                        self.controller_held = false;
                        self.phase = TerminalPhase::HeldElsewhere;
                        cx.emit(TerminalEvent::InterestChanged);
                    }
                    Failure::Host(
                        RuntimeResourceFailure::NotLive
                        | RuntimeResourceFailure::NotFound
                        | RuntimeResourceFailure::Stopping,
                    ) => {
                        self.controls.clear();
                        self.controller_held = false;
                        self.read_state(cx);
                    }
                    Failure::Host(_) => self.controls.refused(),
                }
            }
        }
        self.pump(cx);
    }

    fn send_release(&mut self, connection: u64, cx: &mut Context<Self>) {
        self.release_due = false;
        self.in_flight = Some((Request::Release, connection));
        let request =
            self.requester.request::<RuntimeResourceControllerRelease>(&self.controller());
        self._request = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if this.answered(Request::Release, connection) {
                    if let Err(error) = &result {
                        log::info!("terminal {}: release failed: {error}", this.resource_ref);
                    }
                    // Released or not, this window no longer controls it.
                    this.controller_held = false;
                    this.controls.clear();
                    if this.is_idle() {
                        cx.emit(TerminalEvent::Released);
                    }
                    this.pump(cx);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    fn send_stop(&mut self, connection: u64, cx: &mut Context<Self>) {
        self.in_flight = Some((Request::Stop, connection));
        let input = RuntimeResourceStopInput::new(
            self.session_id.to_string(),
            self.resource_ref.to_string(),
        );
        let request = self.requester.request::<RuntimeResourceStop>(&input);
        self._request = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if this.answered(Request::Stop, connection) {
                    this.finish_stop(result.map(drop), cx);
                }
            })
            .ok();
        }));
    }

    fn finish_stop(&mut self, result: Result<(), HostRequestError>, cx: &mut Context<Self>) {
        let error = match result {
            Ok(()) => {
                self.stop_due = false;
                self.confirm_close(cx);
                return;
            }
            Err(error) => error,
        };
        log::info!("terminal {}: stop failed: {error}", self.resource_ref);
        match failure_of(&error) {
            // Nothing went out: the stop goes on the next connection.
            Failure::NotConnected => return,
            Failure::Host(RuntimeResourceFailure::NotFound) if self.is_exited() => {
                self.stop_due = false;
                self.confirm_close(cx);
                return;
            }
            failure => {
                self.stop_due = false;
                self.close = CloseState::Failed(error.to_string().into());
                // A shell that is gone confirms the close once its state
                // says so.
                if failure == Failure::Host(RuntimeResourceFailure::NotFound) {
                    self.read_state(cx);
                }
            }
        }
        self.pump(cx);
        cx.notify();
    }

    fn confirm_close(&mut self, cx: &mut Context<Self>) {
        self.close = CloseState::Open;
        self.controller_held = false;
        self.controls.clear();
        log::info!("terminal {}: closed", self.resource_ref);
        cx.emit(TerminalEvent::Closed);
        cx.notify();
    }

    /// Whether an answer to `request` sent on `connection` is the one in
    /// flight; it no longer is once the connection changed.
    fn answered(&mut self, request: Request, connection: u64) -> bool {
        if self.in_flight != Some((request, connection)) {
            return false;
        }
        self.in_flight = None;
        self._request = None;
        true
    }

    // The resource's state.

    fn read_state(&mut self, cx: &mut Context<Self>) {
        if self.reading_state {
            self.read_again = true;
            return;
        }
        let Some(connection) = self.connection else {
            return;
        };
        self.reading_state = true;
        let input = RuntimeResourceQueryInput::Get {
            session_id: self.session_id.to_string(),
            resource_ref: self.resource_ref.to_string(),
        };
        let request = self.requester.request::<RuntimeResourceQuery>(&input);
        self._read = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if this.connection == Some(connection) {
                    this.finish_read_state(result, cx);
                }
            })
            .ok();
        }));
    }

    fn finish_read_state(
        &mut self,
        result: Result<RuntimeResourceQueryResult, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        self.reading_state = false;
        self._read = None;
        match result {
            Ok(RuntimeResourceQueryResult::Resource { resource: Some(resource), .. }) => {
                if resource.result.status.is_terminal() {
                    self.exited(Some(&resource.result), cx);
                } else if self.attach_stalled() {
                    // The acquire failed and the shell runs on: not live
                    // yet, or not a PTY, so nothing to attach to. (A read
                    // that answers while the acquire is still out says
                    // nothing about it: the change that set it off is
                    // most likely the start's own move to running.)
                    self.phase = TerminalPhase::Failed(
                        format!("the terminal is {:?}", resource.result.status).into(),
                    );
                    cx.emit(TerminalEvent::InterestChanged);
                }
            }
            Ok(RuntimeResourceQueryResult::Resource { resource: None, .. }) => {
                self.exited(None, cx);
            }
            Ok(_) => self.state_unknown("the Host answered with something else".into(), cx),
            Err(error) => {
                log::info!("terminal {}: reading its state failed: {error}", self.resource_ref);
                self.state_unknown(error.to_string().into(), cx);
            }
        }
        if std::mem::take(&mut self.read_again) && !self.is_exited() {
            self.read_state(cx);
        }
        cx.notify();
    }

    /// A read of its state could not say where it stands. An attach that
    /// was waiting on it (its acquire failed) fails with `message`, and
    /// Retry, rather than attaching with nothing left to move it on.
    fn state_unknown(&mut self, message: SharedString, cx: &mut Context<Self>) {
        if self.attach_stalled() {
            self.phase = TerminalPhase::Failed(message);
            cx.emit(TerminalEvent::InterestChanged);
        }
    }

    /// The shell ended (`state` is its final state; `None` when the Host no
    /// longer has it). The controller went with it and nothing more is
    /// sent; the picture stays. A close in progress is confirmed.
    fn exited(&mut self, state: Option<&ShellRunState>, cx: &mut Context<Self>) {
        if !self.is_exited() {
            self.phase = TerminalPhase::Exited {
                exit_code: state.and_then(|state| state.exit_code),
                failure_message: state
                    .and_then(|state| state.failure_message.clone())
                    .map(Into::into),
            };
            log::info!("terminal {}: exited ({:?})", self.resource_ref, self.phase);
            self.controller_held = false;
            self.acquire_due = false;
            self._resync = None;
            self._settle = None;
            self.release_due = false;
            self.controls.clear();
            self.hydration.invalidate();
            cx.emit(TerminalEvent::Exited);
            cx.emit(TerminalEvent::InterestChanged);
        }
        if self.close != CloseState::Open {
            self.stop_due = false;
            self.confirm_close(cx);
        }
        cx.notify();
    }

    // The emulator.

    fn feed(&self, feed: Feed) {
        // The parser ends only with this terminal.
        self.feeds.try_send(feed).ok();
    }

    fn apply_parsed(&mut self, batch: Vec<Parsed>, cx: &mut Context<Self>) {
        let mut title_changed = false;
        for parsed in batch {
            for event in parsed.events {
                match event {
                    EmulatorEvent::Title(title) => {
                        title_changed |= self.title != title;
                        self.title = title;
                    }
                    EmulatorEvent::Bell => {
                        self.bell = true;
                        cx.emit(TerminalEvent::Bell);
                    }
                    EmulatorEvent::ClipboardStore(text) => {
                        cx.emit(TerminalEvent::ClipboardStore(text));
                    }
                    EmulatorEvent::Reply(reply) => {
                        if self.phase == TerminalPhase::Live {
                            self.controls.push_input(&reply);
                        }
                    }
                }
            }
            self.content = parsed.content;
        }
        if title_changed {
            cx.emit(TerminalEvent::TitleChanged);
        }
        self.pump(cx);
        cx.notify();
    }

    /// The mode flags of the last picture.
    pub fn mode(&self) -> TermMode {
        self.content.mode
    }
}

/// What a failed request means for the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    /// No connection was ready: nothing went out, and the next connection
    /// starts over.
    NotConnected,
    /// The Host refused it.
    Host(RuntimeResourceFailure),
    /// It failed on its way (the connection dropped, a timeout, an answer
    /// this client cannot read): the Host may have acted on it, so it is
    /// not sent again.
    Unknown,
}

fn failure_of(error: &HostRequestError) -> Failure {
    match error {
        HostRequestError::NotConnected => Failure::NotConnected,
        HostRequestError::Operation { code, message, .. } => Failure::Host(
            RuntimeResourceFailure::of(&HostOperationError::new(code.clone(), message.to_string())),
        ),
        _ => Failure::Unknown,
    }
}

/// A controller id the Host accepts (`^[A-Za-z0-9_-]{1,128}$`).
fn new_controller_id() -> String {
    format!("maka-gpui-terminal-{}", uuid::Uuid::new_v4().simple())
}

/// The background parser: applies feeds to the emulator in order and
/// publishes a picture after each pass, ending a synchronized update that
/// stays open too long.
async fn parse(
    emulator: Arc<FairMutex<Emulator>>,
    feeds: async_channel::Receiver<Feed>,
    parsed: async_channel::Sender<Parsed>,
    executor: BackgroundExecutor,
) {
    let mut sync_deadline: Option<Task<()>> = None;
    loop {
        let next = match sync_deadline.as_mut() {
            Some(deadline) => {
                future::or(async { Some(feeds.recv().await) }, async {
                    deadline.await;
                    None
                })
                .await
            }
            None => Some(feeds.recv().await),
        };
        let (published, pending) = {
            let mut emulator = emulator.lock();
            match next {
                Some(Ok(feed)) => {
                    apply(&mut emulator, feed);
                    for _ in 1..FEEDS_PER_PASS {
                        let Ok(feed) = feeds.try_recv() else { break };
                        apply(&mut emulator, feed);
                    }
                }
                Some(Err(_)) => return,
                None => {
                    sync_deadline = None;
                    emulator.stop_sync();
                }
            }
            let events = emulator.take_events();
            (Parsed { content: Arc::new(emulator.content()), events }, emulator.sync_pending())
        };
        if !pending {
            sync_deadline = None;
        } else if sync_deadline.is_none() {
            sync_deadline = Some(executor.timer(SYNC_UPDATE_TIMEOUT));
        }
        if parsed.send(published).await.is_err() {
            return;
        }
    }
}

fn apply(emulator: &mut Emulator, feed: Feed) {
    match feed {
        Feed::Hydrate { size, buffer, grid } => emulator.hydrate(size, &buffer, grid),
        Feed::Output(data) => emulator.advance(&data),
        Feed::Resize(size) => emulator.resize(size),
        Feed::Scroll(scroll) => emulator.scroll(scroll),
        Feed::ScrollTo(display_offset) => emulator.scroll_to(display_offset),
        Feed::CursorBlinkDefault(blinking) => emulator.set_cursor_blink_default(blinking),
        Feed::StartSelection(ty, point, side) => emulator.start_selection(ty, point, side),
        Feed::UpdateSelection(point, side) => emulator.update_selection(point, side),
        Feed::ClearSelection => emulator.clear_selection(),
    }
}
