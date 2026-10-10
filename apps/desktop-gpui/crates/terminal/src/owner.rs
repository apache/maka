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

//! The owner of a window's terminals: what must outlive any terminal view.
//!
//! It sits beside the window's Host connection ([`HostSession`]) and the
//! conversation state, whose Session subscription carries the output, and
//! follows the task that state shows. Terminals survive switching tasks,
//! collapsing the panel and closing the view, which only release the
//! controller; only [`Terminals::close`] stops a shell (the lifecycle
//! invariants of Maka Desktop's workbar,
//! `apps/desktop/src/renderer/features/workbar/README.md`).

use std::collections::{BTreeSet, HashMap};

use conversation::{ConversationEvent, ConversationState, SessionPtyEvent};
use gpui_kit::{
    AppContext as _, Context, Entity, EntityId, EventEmitter, SharedString, Subscription, Task,
};
use host_protocol::{
    HostOperationErrorCode, MAX_LIVE_PTY_RUNS, RuntimeResource, RuntimeResourceOwnership,
    RuntimeResourceQuery, RuntimeResourceQueryInput, RuntimeResourceQueryResult,
    RuntimeResourceStart, RuntimeResourceStartInput, ShellMode,
};
use workspace::{HostRequestError, HostRequester, HostSession, HostSessionEvent};

use crate::terminal::{Terminal, TerminalEvent};

/// How many times the inventory starts over when the list changes while it
/// is read page by page.
const INVENTORY_ATTEMPTS: usize = 3;

/// Where reading the selected task's terminals stands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Inventory {
    /// No task is selected, or no connection to read on.
    Idle,
    Loading,
    Loaded,
    /// The read failed; [`Terminals::reload`] tries again. The terminals
    /// already shown stay.
    Failed(SharedString),
}

/// Where starting a terminal stands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum StartState {
    Idle,
    /// `runtime.resource.start` is in flight, or waits for the selected
    /// task's terminals to be read; one at a time.
    Starting,
    /// The live PTYs this window can see, across every task, are at the
    /// Host's limit ([`MAX_LIVE_PTY_RUNS`]), so none is started: the Host
    /// does not report its limit, and a start past it makes it drain and
    /// restart. Clears when one of them ends.
    LimitReached,
    /// The Host failed to start a shell (`internal_failure`) and is
    /// restarting; a reconnect follows.
    HostRestarting,
    /// The start failed for another reason.
    Failed(SharedString),
}

/// How much of the selected task's terminals a window shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TerminalsShown {
    /// Nothing: the panel is hidden. No output, no controllers.
    #[default]
    Hidden,
    /// Only their tabs: the panel shows another face. Their output streams
    /// in, so the tabs' titles and bells stay current, but they hold no
    /// controllers, and nothing typed reaches them.
    Tabs,
    /// Their face: their output and their controllers.
    Face,
}

/// Emitted by [`Terminals`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum TerminalsEvent {
    /// A terminal this window started: the view shows it.
    Started(Entity<Terminal>),
}

/// The terminals of the task a window shows, and everything about them
/// that outlives a terminal view: controller ids and control sequences
/// (each [`Terminal`]), the PTY interest merged into the one Session
/// subscription, the live PTYs of every task seen (for the Host's limit),
/// and the connection they were acquired on.
///
/// Behavior owner for starting, attaching, releasing and closing terminals.
/// It follows the conversation's selected task: selecting another releases
/// the previous task's controllers and reads the new task's terminals from
/// the Host (`runtime.resource.query`: client terminals that are starting
/// or running; the agent's runs and terminals orphaned by a Host restart
/// are not listed). While their tabs show ([`Self::set_shown`]) the
/// terminals' output streams in; while their face shows they attach: PTY
/// interest first, then the controller, as the output between a snapshot
/// and the interest would otherwise be lost. Holding controllers only
/// then leaves them to another window or Maka Desktop while the face is
/// hidden. After a reconnect every attached terminal attaches again with a
/// new controller, and the inventory is read again.
pub struct Terminals {
    host: Entity<HostSession>,
    conversation: Entity<ConversationState>,
    session_id: Option<SharedString>,
    shown: TerminalsShown,
    terminals: Vec<Entity<Terminal>>,
    /// Terminals of a task no longer selected, until their release answers.
    retiring: Vec<Entity<Terminal>>,
    /// The live PTYs of each task listed, by ref: its terminals and the
    /// agent's interactive runs, which count toward the Host's limit too.
    live: HashMap<SharedString, BTreeSet<SharedString>>,
    /// Reads of a live PTY no terminal here follows (another task's, or
    /// the agent's), by ref, after the Host said it changed: one at a
    /// time, `true` when it changed again meanwhile.
    live_checks: HashMap<SharedString, (bool, Task<()>)>,
    inventory: Inventory,
    /// Incremented for every inventory read; an older read's answer is
    /// dropped.
    inventory_generation: u64,
    /// Terminals of the selected task started (`true`) or closed (`false`)
    /// since the inventory read in flight began, which its answer may not
    /// know about yet.
    recent: HashMap<SharedString, bool>,
    start: StartState,
    /// A start asked for before the selected task's terminals were read:
    /// it goes once they are, against the count they give.
    start_pending: bool,
    /// The connection terminals are acquired on, by generation; `None`
    /// while disconnected.
    connection: Option<u64>,
    connections: u64,
    _inventory: Option<Task<()>>,
    _start: Option<Task<()>>,
    terminal_subscriptions: HashMap<EntityId, Subscription>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<TerminalsEvent> for Terminals {}

impl std::fmt::Debug for Terminals {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminals")
            .field("session_id", &self.session_id)
            .field("terminals", &self.terminals.len())
            .field("inventory", &self.inventory)
            .field("start", &self.start)
            .finish_non_exhaustive()
    }
}

impl Terminals {
    /// The terminals of the window whose Host connection is `host` and
    /// whose selected task is `conversation`'s.
    pub fn new(
        host: Entity<HostSession>,
        conversation: Entity<ConversationState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscriptions = vec![
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| this.on_host(event, cx)),
            cx.subscribe(&conversation, |this, _, event: &ConversationEvent, cx| {
                let ConversationEvent::Changed { session_changed: true, .. } = event else {
                    return;
                };
                this.follow_selection(cx);
            }),
            cx.subscribe(&conversation, |this, _, event: &SessionPtyEvent, cx| {
                this.on_pty(event, cx);
            }),
        ];
        let connected = host.read(cx).is_connected();
        let mut this = Self {
            host,
            conversation,
            session_id: None,
            shown: TerminalsShown::Hidden,
            terminals: Vec::new(),
            retiring: Vec::new(),
            live: HashMap::new(),
            live_checks: HashMap::new(),
            inventory: Inventory::Idle,
            inventory_generation: 0,
            recent: HashMap::new(),
            start: StartState::Idle,
            start_pending: false,
            connection: connected.then_some(1),
            connections: u64::from(connected),
            _inventory: None,
            _start: None,
            terminal_subscriptions: HashMap::new(),
            _subscriptions: subscriptions,
        };
        this.follow_selection(cx);
        this
    }

    // What a view reads.

    /// The selected task's terminals, in the order the Host lists them,
    /// those started here last.
    pub fn terminals(&self) -> &[Entity<Terminal>] {
        &self.terminals
    }

    /// The task whose terminals these are.
    pub fn session_id(&self) -> Option<&SharedString> {
        self.session_id.as_ref()
    }

    pub fn inventory(&self) -> &Inventory {
        &self.inventory
    }

    pub fn start_state(&self) -> &StartState {
        &self.start
    }

    pub fn shown(&self) -> TerminalsShown {
        self.shown
    }

    /// The live PTYs this window can see, which [`Self::start`] keeps under
    /// the Host's limit: those of every task it has listed, terminals and
    /// the agent's interactive runs, less those the Host has since said
    /// ended. Other tasks' are not read for it: the Host lists them a task
    /// at a time, reading each task's transcript to do so, and shuts down
    /// on a task it cannot read.
    pub fn live_count(&self) -> usize {
        self.live.values().map(BTreeSet::len).sum()
    }

    // What a view does.

    /// How much of the selected task's terminals shows. With their face
    /// they attach; with only their tabs their output streams in and they
    /// release their controllers; hidden, their output stops too. Their
    /// shells keep running.
    pub fn set_shown(&mut self, shown: TerminalsShown, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        for terminal in self.terminals.clone() {
            terminal.update(cx, |terminal, cx| terminal.set_shown(shown, cx));
        }
        self.update_interest(cx);
        cx.notify();
    }

    /// Starts a terminal in the selected task: the user's login shell in a
    /// PTY in the task's workspace (`runtime.resource.start` without a
    /// command, launched as `desktop-terminal-<uuid>` like Maka Desktop's,
    /// so either app lists the other's terminals). Refused while one starts,
    /// and at the Host's limit ([`StartState::LimitReached`]). Until the
    /// task's terminals are read it waits for them (reading them again
    /// after a failed read), so that the limit counts them: a start before
    /// that could be the Host's ninth.
    pub fn start(&mut self, cx: &mut Context<Self>) {
        if self.start == StartState::Starting {
            return;
        }
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        if self.connection.is_none() {
            self.start = StartState::Failed(HostRequestError::NotConnected.to_string().into());
            cx.notify();
            return;
        }
        if self.inventory != Inventory::Loaded {
            self.start_pending = true;
            self.start = StartState::Starting;
            if self.inventory != Inventory::Loading {
                self.load_inventory(cx);
            }
            cx.notify();
            return;
        }
        if self.live_count() >= MAX_LIVE_PTY_RUNS {
            log::info!("terminals: {} live, not starting another", self.live_count());
            self.start = StartState::LimitReached;
            cx.notify();
            return;
        }
        self.start = StartState::Starting;
        let input = RuntimeResourceStartInput::terminal(
            session_id.to_string(),
            &uuid::Uuid::new_v4().to_string(),
        );
        let request = self.requester(cx).request::<RuntimeResourceStart>(&input);
        self._start = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this._start = None;
                match result {
                    Ok(started) => {
                        let resource_ref: SharedString = started.resource.resource_ref.into();
                        log::info!("terminals: started {resource_ref} in {session_id}");
                        this.start = StartState::Idle;
                        this.live
                            .entry(session_id.clone())
                            .or_default()
                            .insert(resource_ref.clone());
                        if this.session_id.as_ref() == Some(&session_id)
                            && this.find(&resource_ref, cx).is_none()
                        {
                            this.recent.insert(resource_ref.clone(), true);
                            let terminal = this.add_terminal(resource_ref, cx);
                            cx.emit(TerminalsEvent::Started(terminal));
                        }
                    }
                    Err(HostRequestError::Operation {
                        code: HostOperationErrorCode::InternalFailure,
                        ..
                    }) => {
                        log::warn!("terminals: the Host could not start a shell and is restarting");
                        this.start = StartState::HostRestarting;
                    }
                    Err(error) => {
                        log::warn!("terminals: starting a terminal failed: {error}");
                        this.start = StartState::Failed(error.to_string().into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Closes `terminal`: stops its shell, or forgets it when it already
    /// ended. It leaves the list once the close is confirmed.
    pub fn close(&mut self, terminal: &Entity<Terminal>, cx: &mut Context<Self>) {
        terminal.update(cx, |terminal, cx| terminal.close(cx));
    }

    /// Reads the selected task's terminals again.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.load_inventory(cx);
    }

    /// Forgets a failed or refused start, for the view to dismiss.
    pub fn dismiss_start(&mut self, cx: &mut Context<Self>) {
        if self.start != StartState::Starting {
            self.start = StartState::Idle;
            cx.notify();
        }
    }

    // Following the window.

    fn requester(&self, cx: &gpui_kit::App) -> HostRequester {
        self.host.read(cx).requester()
    }

    fn find(&self, resource_ref: &str, cx: &gpui_kit::App) -> Option<Entity<Terminal>> {
        self.terminals
            .iter()
            .find(|terminal| terminal.read(cx).resource_ref() == resource_ref)
            .cloned()
    }

    fn on_host(&mut self, event: &HostSessionEvent, cx: &mut Context<Self>) {
        match event {
            HostSessionEvent::Connected { host_changed } => {
                self.connections += 1;
                self.connection = Some(self.connections);
                if *host_changed {
                    // A new Host process: every PTY of the old one is
                    // orphaned. The selected task's are read again below.
                    self.live.clear();
                    if self.start == StartState::HostRestarting {
                        self.start = StartState::Idle;
                    }
                }
                log::info!("terminals: connected (Host changed: {host_changed})");
                self.live_checks.clear();
                self.drop_retiring();
                for terminal in self.terminals.clone() {
                    terminal
                        .update(cx, |terminal, cx| terminal.set_connection(self.connection, cx));
                }
                self.load_inventory(cx);
            }
            HostSessionEvent::StatusChanged
                if self.connection.is_some() && !self.host.read(cx).is_connected() =>
            {
                self.connection = None;
                self.live_checks.clear();
                // The Host releases controllers with the connection.
                self.drop_retiring();
                for terminal in self.terminals.clone() {
                    terminal.update(cx, |terminal, cx| terminal.set_connection(None, cx));
                }
                cx.notify();
            }
            _ => {}
        }
    }

    fn follow_selection(&mut self, cx: &mut Context<Self>) {
        let selected = self.conversation.read(cx).session_id().cloned();
        if selected == self.session_id {
            return;
        }
        // The previous task's terminals release their controllers; their
        // shells keep running and still count toward the limit.
        for terminal in std::mem::take(&mut self.terminals) {
            terminal.update(cx, |terminal, cx| terminal.set_shown(TerminalsShown::Hidden, cx));
            if terminal.read(cx).is_idle() {
                self.terminal_subscriptions.remove(&terminal.entity_id());
            } else {
                self.retiring.push(terminal);
            }
        }
        self.session_id = selected;
        // A start waiting for the previous task's list was for that task.
        if std::mem::take(&mut self.start_pending) || self.start != StartState::Starting {
            self.start = StartState::Idle;
        }
        self.load_inventory(cx);
        cx.notify();
    }

    fn on_pty(&mut self, event: &SessionPtyEvent, cx: &mut Context<Self>) {
        let ours = |session_id: &SharedString| self.session_id.as_ref() == Some(session_id);
        match event {
            SessionPtyEvent::InterestSet { session_id, subscription_id, refs }
                if ours(session_id) =>
            {
                for terminal in self.terminals.clone() {
                    terminal.update(cx, |terminal, cx| {
                        let named = refs.iter().any(|name| **name == **terminal.resource_ref());
                        terminal.set_interest(named.then(|| subscription_id.clone()), cx);
                    });
                }
            }
            SessionPtyEvent::InterestLost { session_id } if ours(session_id) => {
                for terminal in self.terminals.clone() {
                    terminal.update(cx, |terminal, cx| terminal.set_interest(None, cx));
                }
            }
            SessionPtyEvent::InterestFailed { session_id, message } if ours(session_id) => {
                for terminal in self.terminals.clone() {
                    terminal
                        .update(cx, |terminal, cx| terminal.interest_failed(message.clone(), cx));
                }
            }
            SessionPtyEvent::Data(frame) if ours(&frame.session_id.clone().into()) => {
                if frame.reset {
                    // The Host collapsed its queue: any terminal may have
                    // lost output.
                    for terminal in self.terminals.clone() {
                        terminal.update(cx, |terminal, cx| terminal.output_dropped(cx));
                    }
                } else if let Some(terminal) = self.find(&frame.resource_ref, cx) {
                    terminal.update(cx, |terminal, cx| {
                        terminal.output(frame.pty_sequence, &frame.data, cx)
                    });
                }
            }
            // Every Session view hears every task's changes.
            SessionPtyEvent::ResourcesChanged { session_id, changes } if ours(session_id) => {
                for change in changes.iter() {
                    let source: SharedString = change.source_session_id.clone().into();
                    let resource_ref: SharedString = change.resource_ref.clone().into();
                    if self.session_id.as_ref() == Some(&source)
                        && let Some(terminal) = self.find(&resource_ref, cx)
                    {
                        terminal.update(cx, |terminal, cx| terminal.resource_changed(cx));
                    } else if self
                        .live
                        .get(&source)
                        .is_some_and(|live| live.contains(&resource_ref))
                    {
                        self.check_live(source, resource_ref, cx);
                    }
                }
            }
            _ => {}
        }
    }

    fn on_terminal(
        &mut self,
        terminal: Entity<Terminal>,
        event: &TerminalEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            TerminalEvent::InterestChanged => self.update_interest(cx),
            TerminalEvent::Exited => {
                let resource_ref = terminal.read(cx).resource_ref().clone();
                self.forget_live(&terminal, &resource_ref, cx);
                cx.notify();
            }
            TerminalEvent::Closed => {
                let resource_ref = terminal.read(cx).resource_ref().clone();
                self.forget_live(&terminal, &resource_ref, cx);
                self.recent.insert(resource_ref, false);
                self.terminals.retain(|held| *held != terminal);
                self.retiring.retain(|held| *held != terminal);
                self.terminal_subscriptions.remove(&terminal.entity_id());
                self.update_interest(cx);
                cx.notify();
            }
            TerminalEvent::Released if self.retiring.contains(&terminal) => {
                self.retiring.retain(|held| *held != terminal);
                self.terminal_subscriptions.remove(&terminal.entity_id());
            }
            _ => {}
        }
    }

    /// Forgets the previous task's terminals still releasing: a lost
    /// connection released them.
    fn drop_retiring(&mut self) {
        for terminal in std::mem::take(&mut self.retiring) {
            self.terminal_subscriptions.remove(&terminal.entity_id());
        }
    }

    fn forget_live(
        &mut self,
        terminal: &Entity<Terminal>,
        resource_ref: &SharedString,
        cx: &mut Context<Self>,
    ) {
        let session_id = terminal.read(cx).session_id().clone();
        if let Some(live) = self.live.get_mut(&session_id) {
            live.remove(resource_ref);
        }
        if self.start == StartState::LimitReached && self.live_count() < MAX_LIVE_PTY_RUNS {
            self.start = StartState::Idle;
        }
    }

    /// Reads the state of `resource_ref`, a live PTY of `session_id` no
    /// terminal here follows, which the Host said changed: once it ended it
    /// no longer counts toward the limit.
    fn check_live(
        &mut self,
        session_id: SharedString,
        resource_ref: SharedString,
        cx: &mut Context<Self>,
    ) {
        if let Some((again, _)) = self.live_checks.get_mut(&resource_ref) {
            *again = true;
            return;
        }
        if self.connection.is_none() {
            return;
        }
        let input = RuntimeResourceQueryInput::Get {
            session_id: session_id.to_string(),
            resource_ref: resource_ref.to_string(),
        };
        let request = self.requester(cx).request::<RuntimeResourceQuery>(&input);
        let key = resource_ref.clone();
        let task = cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this.finish_live_check(session_id, resource_ref, result, cx)
            })
            .ok();
        });
        self.live_checks.insert(key, (false, task));
    }

    fn finish_live_check(
        &mut self,
        session_id: SharedString,
        resource_ref: SharedString,
        result: Result<RuntimeResourceQueryResult, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        let again = self.live_checks.remove(&resource_ref).is_some_and(|(again, _)| again);
        let ended = match result {
            Ok(RuntimeResourceQueryResult::Resource { resource: Some(resource), .. }) => {
                resource.result.status.is_terminal()
            }
            Ok(RuntimeResourceQueryResult::Resource { resource: None, .. }) => true,
            Ok(_) => false,
            Err(error) => {
                log::info!("terminals: reading {resource_ref} failed: {error}");
                false
            }
        };
        let Some(live) = self.live.get_mut(&session_id) else { return };
        if ended {
            log::info!("terminals: {resource_ref} in {session_id} ended");
            live.remove(&resource_ref);
            if self.start == StartState::LimitReached && self.live_count() < MAX_LIVE_PTY_RUNS {
                self.start = StartState::Idle;
            }
            cx.notify();
        } else if again && live.contains(&resource_ref) {
            self.check_live(session_id, resource_ref, cx);
        }
    }

    /// Asks the subscription for the output of every terminal that wants
    /// it: the one merge point of the window's PTY interest.
    fn update_interest(&mut self, cx: &mut Context<Self>) {
        let refs: Vec<String> = self
            .terminals
            .iter()
            .map(|terminal| terminal.read(cx))
            .filter(|terminal| terminal.wants_output())
            .map(|terminal| terminal.resource_ref().to_string())
            .collect();
        self.conversation.update(cx, |conversation, cx| conversation.set_pty_interest(refs, cx));
    }

    fn add_terminal(
        &mut self,
        resource_ref: SharedString,
        cx: &mut Context<Self>,
    ) -> Entity<Terminal> {
        let session_id = self.session_id.clone().unwrap_or_default();
        let requester = self.requester(cx);
        let connection = self.connection;
        let terminal =
            cx.new(|cx| Terminal::new(session_id, resource_ref, requester, connection, cx));
        let subscription = cx.subscribe(&terminal, |this, terminal, event: &TerminalEvent, cx| {
            this.on_terminal(terminal, event, cx);
        });
        self.terminal_subscriptions.insert(terminal.entity_id(), subscription);
        self.terminals.push(terminal.clone());
        if self.shown != TerminalsShown::Hidden {
            let shown = self.shown;
            terminal.update(cx, |terminal, cx| terminal.set_shown(shown, cx));
        }
        terminal
    }

    // The inventory.

    fn load_inventory(&mut self, cx: &mut Context<Self>) {
        self.inventory_generation += 1;
        self._inventory = None;
        self.recent.clear();
        let Some(session_id) = self.session_id.clone() else {
            self.inventory = Inventory::Idle;
            return;
        };
        if self.connection.is_none() {
            self.inventory = Inventory::Idle;
            return;
        }
        self.inventory = Inventory::Loading;
        let generation = self.inventory_generation;
        let requester = self.requester(cx);
        self._inventory = Some(cx.spawn(async move |this, cx| {
            let result = read_inventory(requester, session_id.to_string()).await;
            this.update(cx, |this, cx| this.finish_inventory(generation, session_id, result, cx))
                .ok();
        }));
        cx.notify();
    }

    fn finish_inventory(
        &mut self,
        generation: u64,
        session_id: SharedString,
        result: Result<Vec<RuntimeResource>, SharedString>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.inventory_generation {
            return;
        }
        self._inventory = None;
        match result {
            Ok(resources) => {
                let listed: Vec<&RuntimeResource> =
                    resources.iter().filter(|resource| resource.is_desktop_terminal()).collect();
                let mut live: Vec<SharedString> = listed
                    .iter()
                    .filter(|resource| resource.result.status.is_active())
                    .map(|resource| resource.result.resource_ref.clone().into())
                    .collect();
                // What started or closed while the list was read is newer
                // than the list.
                for (resource_ref, started) in std::mem::take(&mut self.recent) {
                    live.retain(|listed| *listed != resource_ref);
                    if started {
                        live.push(resource_ref);
                    }
                }
                // The agent's live interactive runs take PTYs too; a run
                // another task owns counts in that task's list.
                let runs = resources.iter().filter(|resource| {
                    resource.ownership == RuntimeResourceOwnership::Local
                        && resource.result.mode == ShellMode::Pty
                        && resource.result.status.is_active()
                        && !resource.is_desktop_terminal()
                });
                let counted: BTreeSet<SharedString> = live
                    .iter()
                    .cloned()
                    .chain(runs.map(|resource| resource.result.resource_ref.clone().into()))
                    .collect();
                log::info!(
                    "terminals: {session_id} has {} live terminals, {} live PTYs",
                    live.len(),
                    counted.len()
                );
                self.live.insert(session_id, counted);
                for terminal in self.terminals.clone() {
                    let resource_ref = terminal.read(cx).resource_ref().clone();
                    if !live.contains(&resource_ref) {
                        let state = listed
                            .iter()
                            .find(|resource| resource.result.resource_ref == *resource_ref)
                            .map(|resource| &resource.result);
                        terminal.update(cx, |terminal, cx| terminal.observed(state, cx));
                    }
                }
                for resource_ref in live {
                    if self.find(&resource_ref, cx).is_none() {
                        self.add_terminal(resource_ref, cx);
                    }
                }
                self.inventory = Inventory::Loaded;
                if self.start == StartState::LimitReached && self.live_count() < MAX_LIVE_PTY_RUNS {
                    self.start = StartState::Idle;
                }
                if std::mem::take(&mut self.start_pending) {
                    self.start = StartState::Idle;
                    self.start(cx);
                }
            }
            Err(message) => {
                log::warn!("terminals: reading the task's terminals failed: {message}");
                self.inventory = Inventory::Failed(message);
                // Without the list there is no count to start against;
                // the failure shows, with Retry.
                if std::mem::take(&mut self.start_pending) {
                    self.start = StartState::Idle;
                }
            }
        }
        self.update_interest(cx);
        cx.notify();
    }
}

/// Every runtime resource of `session_id`, page by page, starting over when
/// the list changes in between.
async fn read_inventory(
    requester: HostRequester,
    session_id: String,
) -> Result<Vec<RuntimeResource>, SharedString> {
    let failed = |error: HostRequestError| SharedString::from(error.to_string());
    'attempt: for _ in 0..INVENTORY_ATTEMPTS {
        let input = RuntimeResourceQueryInput::ListStart { session_id: session_id.clone() };
        let first = requester.request::<RuntimeResourceQuery>(&input).await.map_err(failed)?;
        let RuntimeResourceQueryResult::Page { revision, mut resources, mut next_cursor, .. } =
            first
        else {
            return Err("the Host answered the terminal list with something else".into());
        };
        while let Some(cursor) = next_cursor.take() {
            let input = RuntimeResourceQueryInput::ListContinue {
                session_id: session_id.clone(),
                revision: revision.clone(),
                cursor,
            };
            match requester.request::<RuntimeResourceQuery>(&input).await.map_err(failed)? {
                RuntimeResourceQueryResult::Page { resources: more, next_cursor: next, .. } => {
                    resources.extend(more);
                    next_cursor = next;
                }
                RuntimeResourceQueryResult::RevisionChanged { .. } => continue 'attempt,
                _ => return Err("the Host answered the terminal list with something else".into()),
            }
        }
        return Ok(resources);
    }
    Err("the terminal list kept changing while it was read".into())
}
