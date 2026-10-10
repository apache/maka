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

//! The selected task's trace, usage summary and context snapshot, kept
//! fresh while the Trace face shows, as Desktop's `useSessionTrace` keeps
//! them (`use-session-trace.ts`, with `session-trace-refresh.ts`).
//!
//! Three reads with three owners, kept apart so one that fails cannot
//! blank another: the trace (a window of pages from the newest), the
//! Session's usage summary, and the context snapshot. Their freshness has
//! two authorities, as the workbar README says:
//!
//! - the Session's own events: a tool starting or ending, durable rows
//!   landing, the root Turn's state moving ([`Signal::Trace`]) re-read the
//!   trace window and the context snapshot, never on streaming deltas;
//! - `session_domain_changed` with domain `usage` ([`Signal::Usage`])
//!   re-reads the summary, and nothing else does.
//!
//! A burst of either is one read, [`REFRESH_DEBOUNCE`] after its last
//! signal. Nothing is read, scheduled or applied while the face is hidden:
//! hiding drops the reads in flight and the scheduled ones, and showing
//! again reads all three, keeping what was shown until the answers land.
//! The depth the person paged to (Load earlier) is kept for the task across
//! refreshes and re-activation, and rebuilt from the newest page each time;
//! another task starts at one page.

use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{Context, Entity, SharedString, Subscription, Task};
use host_protocol::{ContextDiagnosticsResult, PushFrame, SessionTracePage, SubscriptionFrame};
use workspace::{HostSession, HostSessionEvent};

use crate::model::{SessionUsage, Trace, merge_pages};
use crate::read::{self, ReadFailure};

/// `TRACE_REFRESH_DEBOUNCE_MS`: long enough to absorb a Turn's closing
/// burst, short enough to feel live.
pub const REFRESH_DEBOUNCE: Duration = Duration::from_millis(400);

/// What a frame of the Session's subscription means for the face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// Something the trace projects from may have been recorded.
    Trace,
    /// The Session's usage ledger changed.
    Usage,
}

/// What `frame` means for Session `session_id`'s face, read from its routing
/// fields only (a frame is not decoded whole for this). Desktop re-reads on
/// `tool_start`, `tool_result`, `token_usage`, `provider_retry`, `error`,
/// `complete` and `abort` (`TRACE_RELEVANT_EVENT_TYPES`); over the Host's
/// subscription those are a Tool event, a durable row landing
/// (`transcript_advanced`: usage records and the Turn's end), and a new
/// projection (the root Turn's status or retry). Deltas, Tool output and
/// progress are not: a streaming Turn must not re-project per delta.
pub fn signal_of(frame: &SubscriptionFrame, session_id: &str) -> Option<Signal> {
    let raw = &frame.raw;
    let names = |pointer: &str| raw.pointer(pointer).and_then(|value| value.as_str());
    match frame.kind.as_str() {
        "subscription.session_event" if names("/sessionId") == Some(session_id) => {
            matches!(names("/event/type"), Some("tool_start" | "tool_result"))
                .then_some(Signal::Trace)
        }
        "subscription.transcript_advanced" if names("/sessionId") == Some(session_id) => {
            Some(Signal::Trace)
        }
        "subscription.session_projection"
            if names("/snapshot/session/sessionId") == Some(session_id) =>
        {
            Some(Signal::Trace)
        }
        "subscription.session_domain_changed"
            if names("/sessionId") == Some(session_id) && names("/domain") == Some("usage") =>
        {
            Some(Signal::Usage)
        }
        _ => None,
    }
}

/// The selected task's trace, summary and snapshot.
///
/// Behavior owner for reading, paging and refreshing; the face only draws
/// what it holds. It notifies once per coherent change.
pub struct InspectorState {
    host: Entity<HostSession>,
    session_id: Option<SharedString>,
    shown: bool,
    /// The window of pages read, newest first.
    pages: Vec<SessionTracePage>,
    /// The pages merged, once per change of the window.
    trace: Option<Rc<Trace>>,
    /// How many pages the person asked to see, for this task.
    depth: usize,
    trace_loading: bool,
    earlier_loading: bool,
    trace_failure: Option<ReadFailure>,
    usage: Option<SessionUsage>,
    usage_loading: bool,
    usage_failed: bool,
    context: Option<ContextDiagnosticsResult>,
    /// Moves with every change the face draws.
    version: u64,
    /// A newer read replaces (and so drops) the one in flight.
    _trace_read: Option<Task<()>>,
    _usage_read: Option<Task<()>>,
    _context_read: Option<Task<()>>,
    _trace_refresh: Option<Task<()>>,
    _usage_refresh: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for InspectorState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InspectorState")
            .field("session_id", &self.session_id)
            .field("shown", &self.shown)
            .field("pages", &self.pages.len())
            .field("depth", &self.depth)
            .finish_non_exhaustive()
    }
}

impl InspectorState {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
            match event {
                // A new connection may reach a Host whose records moved on.
                HostSessionEvent::Connected { .. } => {
                    if this.is_live() {
                        this.load(cx);
                    }
                }
                HostSessionEvent::Push(frame) => {
                    if let PushFrame::Subscription(frame) = frame.as_ref()
                        && let Some(session) = this.session_id.as_deref()
                        && let Some(signal) = signal_of(frame, session)
                    {
                        this.observe(signal, cx);
                    }
                }
                _ => {}
            }
        })];
        Self {
            host,
            session_id: None,
            shown: false,
            pages: Vec::new(),
            trace: None,
            depth: 1,
            trace_loading: false,
            earlier_loading: false,
            trace_failure: None,
            usage: None,
            usage_loading: false,
            usage_failed: false,
            context: None,
            version: 0,
            _trace_read: None,
            _usage_read: None,
            _context_read: None,
            _trace_refresh: None,
            _usage_refresh: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn session_id(&self) -> Option<&SharedString> {
        self.session_id.as_ref()
    }

    pub fn is_shown(&self) -> bool {
        self.shown
    }

    /// The trace over the pages read, oldest Turn first.
    pub fn trace(&self) -> Option<&Rc<Trace>> {
        self.trace.as_ref()
    }

    /// The cursor of the page before the window: more can be loaded.
    pub fn next_cursor(&self) -> Option<&str> {
        self.pages.last().and_then(|page| page.next_cursor.as_deref())
    }

    /// The window reaches the oldest page and holds more than one: the
    /// earlier pages can be hidden again.
    pub fn can_hide_earlier(&self) -> bool {
        self.pages.len() > 1 && self.next_cursor().is_none()
    }

    /// How many pages the person asked to see.
    pub fn depth(&self) -> usize {
        self.depth
    }

    pub fn pages(&self) -> usize {
        self.pages.len()
    }

    pub fn is_trace_loading(&self) -> bool {
        self.trace_loading
    }

    pub fn is_earlier_loading(&self) -> bool {
        self.earlier_loading
    }

    pub fn trace_failure(&self) -> Option<&ReadFailure> {
        self.trace_failure.as_ref()
    }

    pub fn usage(&self) -> Option<&SessionUsage> {
        self.usage.as_ref()
    }

    pub fn is_usage_loading(&self) -> bool {
        self.usage_loading
    }

    /// The last summary read failed (and none is shown).
    pub fn is_usage_failed(&self) -> bool {
        self.usage_failed
    }

    pub fn context(&self) -> Option<&ContextDiagnosticsResult> {
        self.context.as_ref()
    }

    /// Moves with every change the face draws.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// Whether a refresh is scheduled: the trace's, and the summary's.
    pub fn refresh_scheduled(&self) -> (bool, bool) {
        (self._trace_refresh.is_some(), self._usage_refresh.is_some())
    }

    fn is_live(&self) -> bool {
        self.shown && self.session_id.is_some()
    }

    /// Follows task `session_id`: another task's trace, summary, snapshot
    /// and depth are dropped, and the new one's read while the face shows.
    pub fn set_session(&mut self, session_id: Option<SharedString>, cx: &mut Context<Self>) {
        let shown = self.shown;
        self.follow(session_id, shown, cx);
    }

    /// Whether the face shows: it reads all three as it appears, and drops
    /// what is in flight or scheduled as it hides, keeping what it shows.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        let session_id = self.session_id.clone();
        self.follow(session_id, shown, cx);
    }

    /// Follows task `session_id` and whether the face shows, together, so a
    /// change of both reads once, and never for a task whose face is
    /// hidden: switching from a task whose Trace face shows to one whose
    /// face does not reads nothing.
    pub fn follow(
        &mut self,
        session_id: Option<SharedString>,
        shown: bool,
        cx: &mut Context<Self>,
    ) {
        let was_live = self.is_live();
        let session_changed = self.session_id != session_id;
        if !session_changed && self.shown == shown {
            return;
        }
        if session_changed {
            self.session_id = session_id;
            self.cancel();
            self.pages.clear();
            self.trace = None;
            self.depth = 1;
            self.trace_failure = None;
            self.usage = None;
            self.usage_failed = false;
            self.context = None;
        }
        self.shown = shown;
        if !shown && was_live {
            self.cancel();
        }
        self.changed(cx);
        if self.is_live() && (session_changed || !was_live) {
            self.load(cx);
        }
    }

    /// The face's Retry: all three again.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        if self.session_id.is_some() {
            self.load(cx);
        }
    }

    /// Reads the page before the window and keeps it: the depth grows by
    /// one. Nothing while a read of the trace is under way or the window
    /// reaches the oldest page.
    pub fn load_earlier(&mut self, cx: &mut Context<Self>) {
        let (Some(session), Some(cursor)) =
            (self.session_id.clone(), self.next_cursor().map(str::to_owned))
        else {
            return;
        };
        if self.trace_loading || self.earlier_loading {
            return;
        }
        self.depth = self.depth.max(self.pages.len()) + 1;
        self.earlier_loading = true;
        self.trace_failure = None;
        self.changed(cx);
        let requester = self.host.read(cx).requester();
        let loaded = self.pages.clone();
        self._trace_read = Some(cx.spawn(async move |this, cx| {
            let result = read::earlier_page(&requester, &session, cursor, &loaded).await;
            this.update(cx, |this, cx| this.finish_earlier(result, cx)).ok();
        }));
    }

    /// Keeps the newest page only, once the window reaches the oldest: the
    /// depth goes back to one.
    pub fn hide_earlier(&mut self, cx: &mut Context<Self>) {
        if !self.can_hide_earlier() {
            return;
        }
        self.pages.truncate(1);
        self.depth = 1;
        self.trace = merge_pages(&self.pages).map(Rc::new);
        self.changed(cx);
    }

    fn observe(&mut self, signal: Signal, cx: &mut Context<Self>) {
        if !self.is_live() {
            return;
        }
        // Restart rather than stack: the last signal of a burst is the one
        // whose state the reader wants.
        let refresh = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REFRESH_DEBOUNCE).await;
            this.update(cx, |this, cx| match signal {
                Signal::Trace => {
                    this._trace_refresh = None;
                    this.read_trace(cx);
                    this.read_context(cx);
                }
                Signal::Usage => {
                    this._usage_refresh = None;
                    this.read_usage(cx);
                }
            })
            .ok();
        });
        match signal {
            Signal::Trace => self._trace_refresh = Some(refresh),
            Signal::Usage => self._usage_refresh = Some(refresh),
        }
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self._trace_refresh = None;
        self._usage_refresh = None;
        self.read_trace(cx);
        self.read_usage(cx);
        self.read_context(cx);
    }

    /// Drops every read in flight and every scheduled refresh; what they
    /// would have answered is never applied.
    fn cancel(&mut self) {
        self._trace_read = None;
        self._usage_read = None;
        self._context_read = None;
        self._trace_refresh = None;
        self._usage_refresh = None;
        self.trace_loading = false;
        self.earlier_loading = false;
        self.usage_loading = false;
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.version += 1;
        cx.notify();
    }

    /// Reads the window of pages the depth asks for, from the newest.
    fn read_trace(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.session_id.clone() else { return };
        let count = self.depth.max(1);
        self.trace_loading = true;
        self.earlier_loading = false;
        self.trace_failure = None;
        self.changed(cx);
        let requester = self.host.read(cx).requester();
        self._trace_read = Some(cx.spawn(async move |this, cx| {
            let result = read::trace_window(&requester, &session, count).await;
            this.update(cx, |this, cx| this.finish_trace(result, cx)).ok();
        }));
    }

    fn finish_trace(
        &mut self,
        result: Result<Vec<SessionTracePage>, ReadFailure>,
        cx: &mut Context<Self>,
    ) {
        self._trace_read = None;
        self.trace_loading = false;
        self.earlier_loading = false;
        match result {
            Ok(pages) => {
                self.trace = merge_pages(&pages).map(Rc::new);
                self.pages = pages;
            }
            // What was shown stays, under the failure.
            Err(failure) => {
                log::warn!("inspector: reading the trace failed: {failure:?}");
                self.trace_failure = Some(failure);
            }
        }
        self.changed(cx);
    }

    fn finish_earlier(
        &mut self,
        result: Result<SessionTracePage, ReadFailure>,
        cx: &mut Context<Self>,
    ) {
        self._trace_read = None;
        self.trace_loading = false;
        self.earlier_loading = false;
        match result {
            Ok(page) => {
                self.pages.push(page);
                self.depth = self.pages.len();
                self.trace = merge_pages(&self.pages).map(Rc::new);
            }
            Err(failure) => {
                log::warn!("inspector: reading earlier records failed: {failure:?}");
                self.depth = self.pages.len().max(1);
                self.trace_failure = Some(failure);
            }
        }
        self.changed(cx);
    }

    fn read_usage(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.session_id.clone() else { return };
        self.usage_loading = true;
        self.changed(cx);
        let requester = self.host.read(cx).requester();
        self._usage_read = Some(cx.spawn(async move |this, cx| {
            let result = read::usage_summary(&requester, &session).await;
            this.update(cx, |this, cx| {
                this._usage_read = None;
                this.usage_loading = false;
                match result {
                    Ok(usage) => {
                        this.usage = Some(usage);
                        this.usage_failed = false;
                    }
                    // An old summary is not presented as current.
                    Err(failure) => {
                        log::warn!("inspector: reading the usage summary failed: {failure:?}");
                        this.usage = None;
                        this.usage_failed = true;
                    }
                }
                this.changed(cx);
            })
            .ok();
        }));
    }

    fn read_context(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.session_id.clone() else { return };
        let requester = self.host.read(cx).requester();
        self._context_read = Some(cx.spawn(async move |this, cx| {
            let result = read::context(&requester, &session).await;
            this.update(cx, |this, cx| {
                this._context_read = None;
                match result {
                    Ok(context) => {
                        this.context = Some(context);
                        this.changed(cx);
                    }
                    // The last snapshot stays: it is still the newest
                    // answer, and blanking it would report no composition
                    // for a read that only failed.
                    Err(failure) => {
                        log::warn!("inspector: reading the context snapshot failed: {failure:?}");
                    }
                }
            })
            .ok();
        }));
    }
}
