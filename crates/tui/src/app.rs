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

use crate::{
    i18n::I18n,
    navigation::{Navigation, Route},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui::layout::{Position, Rect};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Focus {
    Navigation,
    List,
    Composer,
    Transcript,
    Queue,
    Page,
    /// A session's panels beside its conversation.
    Inspector,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Visit(Route),
    Back,
    Forward,
    Palette,
    ClosePalette,
    Connect,
    Refresh,
    ToggleTheme,
    Theme(crate::theme::editor::Command),
    CycleLocale,
    ToggleSidebar,
    ToggleFullscreen,
    ToggleDetails,
    ToggleInspector,
    ToggleTrace,
    BrowseTranscript,
    Search(crate::pages::chat::render::search::Command),
    Copy(crate::pages::chat::render::selection::CopyMode),
    CopyFile(String),
    Branch(crate::pages::branch::Command),
    Recap(crate::pages::recap::Command),
    Resume(crate::pages::resume::Command),
    Settings(crate::pages::settings::Message),
    Sidebar(crate::pages::sidebar::Message),
    Home(crate::pages::home::Message),
    Attachment(crate::pages::attachments::Command),
    References,
    Apps(crate::apps::Message),
    Skills(crate::pages::skills::Command),
    Revision(crate::pages::revision::Command),
    ToggleSymbols,
    ToggleMotion,
    RefreshSessions,
    NextSessions,
    PreviousSessions,
    RefreshSession,
    OlderMessages,
    NewerMessages,
    LatestMessages,
    ToggleMessage(crate::pages::chat::render::MessageKey),
    SendMessage,
    SteerMessage,
    Queue(crate::pages::queue::Command),
    StopTurn(crate::pages::chat::stopping::Target),
    ReconcileSubmission,
    RetrySubmission,
    CreateSession,
    Manage(crate::pages::manage::Command),
    Onboard(crate::pages::onboarding::Command),
    Project(crate::pages::projects::Command),
    Connection(crate::pages::connections::Command),
    OpenInteraction,
    Interaction(crate::pages::interactions::Command),
    Quit,
    Detach,
    ConfirmQuit,
    CancelQuit,
    NextTab,
    PreviousTab,
    CloseTab(String),
}

#[derive(Clone, Debug)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected { root_id: String, epoch: String },
    Failed(String),
    WrongEpoch,
}

pub enum Notice {
    Local(&'static str),
    Clipboard { key: &'static str, until: Instant },
    Diagnostic(String),
    Catalog { kind: String, revision: String },
}

#[derive(Clone)]
pub struct Hit {
    pub area: Rect,
    pub action: Action,
}

pub struct App {
    known_root: Option<String>,
    pub(crate) page_states: std::collections::VecDeque<(Route, crate::navigation::state::State)>,
    pub navigation: Navigation,
    pub tabs: crate::navigation::tabs::Tabs,
    pub focus: Focus,
    pub selected_control: usize,
    pub i18n: I18n,
    pub chrome: crate::chrome::Chrome,
    pub sessions: crate::pages::sessions::Sessions,
    pub inbox: crate::pages::sessions::Sessions,
    pub management: crate::pages::manage::Management,
    pub branch: crate::pages::branch::State,
    pub recap: crate::pages::recap::State,
    pub resume: crate::pages::resume::State,
    pub attachments: crate::pages::attachments::State,
    pub skills: crate::pages::skills::State,
    pub settings: crate::pages::settings::State,
    pub sidebar: crate::pages::sidebar::State,
    /// The modal layer presenting whichever overlay is a kernel sheet.
    pub layer: crate::ui::Layer<Action>,
    pub home: crate::pages::home::State,
    pub apps: crate::apps::Apps,
    pub directories:
        std::collections::BTreeMap<String, Vec<maka_protocol::turn::DirectoryReference>>,
    pub revision: crate::pages::revision::State,
    pub onboarding: crate::pages::onboarding::Onboarding,
    pub projects: crate::pages::projects::Projects,
    pub connections: crate::pages::connections::Connections,
    pub providers: crate::providers::Providers,
    pub chat: crate::pages::chat::Chat,
    pub interactions: crate::pages::interactions::Interactions,
    pub queue: crate::pages::queue::Queue,
    pub sending: HashMap<String, crate::pages::sending::Sending>,
    // Local to this Root/client instance. Reconnects must not discard drafts.
    pub drafts: HashMap<String, crate::editor::Editor>,
    pub palette: Option<usize>,
    pub command_palette: crate::pages::commands::State,
    pub hits: Vec<Hit>,
    pub hover: Option<Action>,
    pub hover_area: Option<Rect>,
    pub(crate) hover_since: Option<Instant>,
    pub root: PathBuf,
    pub connection: ConnectionState,
    pub status: Option<Value>,
    pub notice: Option<Notice>,
    pub state_error: Option<String>,
    pub closing: bool,
    pub shutdown: crate::shutdown::State,
    pub theme: crate::theme::Theme,
    pub refreshing: bool,
    pub creating: bool,
    pub(crate) frame_size: Option<(u16, u16)>,
}

impl App {
    pub fn new(root: PathBuf, i18n: I18n) -> Self {
        let locale = i18n.locale().id();
        Self {
            known_root: None,
            page_states: Default::default(),
            navigation: Navigation::default(),
            tabs: Default::default(),
            focus: Focus::Navigation,
            selected_control: 0,
            i18n,
            chrome: Default::default(),
            sessions: Default::default(),
            inbox: crate::pages::sessions::Sessions::inbox(),
            management: Default::default(),
            branch: Default::default(),
            recap: Default::default(),
            resume: Default::default(),
            attachments: Default::default(),
            skills: Default::default(),
            settings: Default::default(),
            sidebar: Default::default(),
            layer: Default::default(),
            home: Default::default(),
            apps: crate::apps::Apps::new(locale),
            directories: Default::default(),
            revision: Default::default(),
            onboarding: Default::default(),
            projects: Default::default(),
            connections: Default::default(),
            providers: Default::default(),
            chat: Default::default(),
            interactions: Default::default(),
            queue: Default::default(),
            sending: HashMap::new(),
            drafts: HashMap::new(),
            palette: None,
            command_palette: Default::default(),
            hits: Vec::new(),
            hover: None,
            hover_area: None,
            hover_since: None,
            root,
            connection: ConnectionState::Disconnected,
            status: None,
            notice: None,
            state_error: None,
            closing: false,
            shutdown: Default::default(),
            theme: crate::theme::Theme::default(),
            refreshing: false,
            creating: false,
            frame_size: None,
        }
    }
    pub fn commands(&self) -> Vec<(Action, crate::pages::commands::Label)> {
        if self.palette.is_some() {
            return self.command_palette.filtered(&self.i18n);
        }
        let mut commands = vec![
            (Action::Visit(Route::Workspace), "command-workspace"),
            (Action::Visit(Route::Host), "command-host"),
            (Action::Visit(Route::Settings), "command-settings"),
            (Action::Visit(Route::Connections), "route-connections"),
            (
                Action::Apps(crate::apps::Message::Directory),
                "route-extensions",
            ),
            (
                Action::Onboard(crate::pages::onboarding::Command::Open),
                "onboard-title",
            ),
            (Action::Visit(Route::Help), "command-help"),
            (Action::Visit(Route::Inbox), "command-inbox"),
            (Action::Visit(Route::Projects), "route-projects"),
            (Action::CreateSession, "session-create"),
            (Action::Connect, "command-connect"),
            (Action::ToggleSidebar, "command-sidebar"),
            (Action::Quit, "command-quit"),
            (Action::Detach, "command-detach"),
        ];
        commands.extend(self.management_commands());
        commands.extend(self.branch_commands());
        commands.extend(self.recap_commands());
        commands.extend(self.resume_commands());
        commands.extend(self.revision_commands());
        commands.extend(self.oauth_commands());
        if let Some(action) = self.default_model_action() {
            commands.push((action, "default-model-title"));
        }
        if self.navigation.current() == Route::Projects {
            commands.retain(|(action, _)| *action != Action::CreateSession);
            commands.extend(
                self.project_actions()
                    .into_iter()
                    .filter(|action| {
                        !matches!(
                            action,
                            Action::Project(crate::pages::projects::Command::Refresh)
                                | Action::Manage(_)
                        )
                    })
                    .map(|action| {
                        let Action::Project(command) = &action else {
                            unreachable!()
                        };
                        let label = command.label();
                        (action, label)
                    }),
            );
        }
        if let Some(action) = self.refresh_action() {
            commands.insert(5, (action, "command-refresh"));
        }
        if !self.tabs.entries.is_empty() {
            commands.push((Action::PreviousTab, "tabs-previous"));
            commands.push((Action::NextTab, "tabs-next"));
        }
        if matches!(self.navigation.current(), Route::Session(_)) {
            if let Route::Session(id) = self.navigation.current() {
                commands.push((Action::CloseTab(id), "tabs-close"));
            }
            if self.has_interaction() {
                commands.push((Action::OpenInteraction, "interaction-open"));
            }
            commands.push((
                Action::Attachment(crate::pages::attachments::Command::Open),
                "attachments-add",
            ));
            commands.push((Action::References, "references-title"));
            commands.push((
                Action::Skills(crate::pages::skills::Command::Open),
                "skills-title",
            ));
            commands.push((
                Action::SendMessage,
                if self.stop_target().is_some() {
                    "queue-send"
                } else {
                    "chat-send"
                },
            ));
            if self.stop_target().is_some() {
                commands.push((Action::SteerMessage, "queue-steer"));
            }
            if !self.queue_rows().is_empty() {
                commands.push((
                    Action::Queue(crate::pages::queue::Command::Focus),
                    "queue-focus",
                ));
            }
            if let Some(target) = self.stop_target() {
                commands.push((Action::StopTurn(target), "chat-stop"));
            }
            if self.enabled(&Action::ReconcileSubmission) {
                commands.push((Action::ReconcileSubmission, "chat-reconcile"));
            }
            if self.enabled(&Action::RetrySubmission) {
                commands.push((Action::RetrySubmission, "chat-retry-original"));
            }
            commands.push((Action::ToggleFullscreen, "command-fullscreen"));
            commands.push((Action::ToggleDetails, "command-details"));
            if self.inspector_available() {
                commands.push((
                    Action::ToggleInspector,
                    if self.chrome.inspector {
                        "command-inspector-hide"
                    } else {
                        "command-inspector-show"
                    },
                ));
            }
            commands.push((Action::BrowseTranscript, "chat-browse"));
            for mode in [
                crate::pages::chat::render::selection::CopyMode::Selection,
                crate::pages::chat::render::selection::CopyMode::Message,
                crate::pages::chat::render::selection::CopyMode::Source,
            ] {
                commands.push((Action::Copy(mode), mode.label()));
            }
            if let Some(path) = self
                .chat
                .reader()
                .and_then(|reader| reader.selected_file())
                .and_then(|path| crate::files::resolve(self, path))
            {
                commands.push((Action::CopyFile(path), "file-copy-path"));
            }
            commands.push((
                Action::Search(crate::pages::chat::render::search::Command::Open),
                "chat-search",
            ));
            commands.push((
                Action::Search(crate::pages::chat::render::search::Command::Scope),
                "chat-search-scope-toggle",
            ));
            commands.push((
                Action::ToggleTrace,
                if self.chat.view.trace {
                    "command-trace-hide"
                } else {
                    "command-trace-show"
                },
            ));
            if !self.chat.view.following() {
                commands.push((Action::LatestMessages, "chat-latest"));
            }
            if self.chat.can_newer() {
                commands.push((Action::NewerMessages, "chat-newer"));
            }
            if let Some(key) = self.chat.view.selection()
                && self.chat.view.can_toggle(&key)
            {
                commands.push((Action::ToggleMessage(key), "chat-toggle-message"));
            }
        }
        let mut commands: Vec<_> = commands
            .into_iter()
            .map(|(action, key)| (action, key.into()))
            .collect();
        commands.extend(self.apps_commands());
        commands
    }
    pub(crate) fn bind_root(&mut self, root: &str) -> bool {
        if let Some(known) = &self.known_root {
            return known == root;
        }
        self.known_root = Some(root.into());
        true
    }
    pub fn page_actions(&self) -> Vec<Action> {
        let mut actions = match self.navigation.current() {
            // App and directory controls live in their kernel surfaces.
            Route::Extensions | Route::App(_) => vec![],
            Route::Connections => self.connection_actions(),
            Route::Projects => self.project_actions(),
            Route::Inbox => {
                if self.inbox.error.is_some() {
                    vec![Action::RefreshSessions]
                } else if self.inbox.can_previous() || self.inbox.can_next() {
                    vec![Action::PreviousSessions, Action::NextSessions]
                } else {
                    vec![]
                }
            }
            // Home controls live in its kernel surface.
            Route::Workspace => vec![],
            Route::Session(_) => {
                let mut actions = vec![
                    self.send_action(),
                    Action::Attachment(crate::pages::attachments::Command::Open),
                    Action::ToggleDetails,
                    Action::ToggleFullscreen,
                ];
                if self.inspector_available() {
                    actions.push(Action::ToggleInspector);
                }
                if self.stop_target().is_some() && self.enabled(&Action::SendMessage) {
                    actions.insert(1, Action::SendMessage);
                    actions.insert(2, Action::SteerMessage);
                }
                if self.chat.can_older() {
                    actions.insert(0, Action::OlderMessages);
                }
                if self.chat.can_newer() {
                    actions.insert(0, Action::NewerMessages);
                }
                if self.has_interaction() {
                    actions.insert(0, Action::OpenInteraction);
                }
                if !self.chat.view.following() {
                    actions.insert(0, Action::LatestMessages);
                }
                actions
            }
            Route::Host => vec![
                Action::Apps(crate::apps::Message::Directory),
                if matches!(self.connection, ConnectionState::Connected { .. }) {
                    Action::Refresh
                } else {
                    Action::Connect
                },
            ],
            // Settings controls live in its kernel surface, not page actions.
            Route::Settings | Route::Help => vec![],
        };
        if self.fullscreen() && self.inbox_attention() {
            actions.push(Action::Visit(Route::Inbox));
        }
        actions
    }
    pub fn inbox_attention(&self) -> bool {
        matches!(self.connection, ConnectionState::Connected { .. })
            && (!self.inbox.items.is_empty()
                || self.inbox.can_previous()
                || self.inbox.error.is_some())
    }
    pub fn begin_frame(&mut self, area: Rect) {
        self.attachments.begin_frame();
        self.branch.invalidate_geometry();
        self.recap.invalidate_geometry();
        self.resume.invalidate_geometry();
        self.revision.begin_frame();
        for item in &self.sessions.items {
            self.tabs.rename(&item.id, &item.name);
        }
        if let crate::pages::sessions::Detail::Ready(item) = &self.sessions.detail {
            self.tabs.rename(&item.id, &item.name);
        }
        if let Some(reader) = self.chat.reader_mut() {
            reader.text_selection.begin_frame();
        }
        self.hits.clear();
        self.queue.area = None;
        self.chat.area = None;
        self.frame_size = Some((area.width, area.height));
    }
    pub fn fullscreen(&self) -> bool {
        self.chrome.session_fullscreen && matches!(self.navigation.current(), Route::Session(_))
    }
    pub fn tooltip_wait(&self) -> Option<Duration> {
        if self.overlay().is_some() || !self.has_tooltip() {
            return None;
        }
        let remaining = Duration::from_millis(450).checked_sub(self.hover_since?.elapsed())?;
        (!remaining.is_zero()).then_some(remaining)
    }
    pub fn selection_wait(&self, now: Instant) -> Option<Duration> {
        if self.overlay().is_some()
            || !matches!(self.navigation.current(), Route::Session(_))
            || self.chrome.details
        {
            return None;
        }
        self.chat.reader()?.selection_wait(now)
    }
    pub fn selection_scroll(&mut self, now: Instant) -> bool {
        self.selection_wait(now) == Some(Duration::ZERO)
            && self
                .chat
                .reader_mut()
                .is_some_and(|reader| reader.selection_scroll(now))
    }
    pub fn tooltip_visible(&self) -> bool {
        self.overlay().is_none()
            && self.has_tooltip()
            && self
                .hover_since
                .is_some_and(|start| start.elapsed() >= Duration::from_millis(450))
    }
    fn has_tooltip(&self) -> bool {
        self.hover.as_ref().is_some_and(|action| {
            !matches!(
                action,
                Action::ToggleMessage(_)
                    | Action::Search(crate::pages::chat::render::search::Command::PreviewToggle(
                        _
                    ))
            )
        })
    }
    fn refresh_action(&self) -> Option<Action> {
        match self.navigation.current() {
            Route::Extensions => Some(Action::Apps(crate::apps::Message::Reload)),
            Route::App(key) => Some(Action::Apps(crate::apps::Message::Instance(
                key,
                crate::apps::Command::Refresh,
            ))),
            Route::Connections => Some(Action::Connection(
                crate::pages::connections::Command::Refresh,
            )),
            Route::Projects => Some(Action::Project(crate::pages::projects::Command::Refresh)),
            Route::Workspace | Route::Inbox => Some(Action::RefreshSessions),
            Route::Session(_) => Some(Action::RefreshSession),
            Route::Host => Some(Action::Refresh),
            _ => None,
        }
    }
    pub fn apply(&mut self, action: Action) -> Option<Action> {
        if !self.enabled(&action) {
            return None;
        }
        match action {
            Action::NextTab | Action::PreviousTab => {
                let route = self.navigation.current();
                let id = if let Route::Session(id) = &route {
                    Some(id.as_str())
                } else {
                    None
                };
                if let Some(id) = self.tabs.relative(id, action == Action::NextTab) {
                    return self.apply(Action::Visit(Route::Session(id)));
                }
            }
            Action::CloseTab(id) => {
                self.leave_page();
                let current = self.navigation.current();
                let fallback = self
                    .tabs
                    .close(&id)
                    .map_or(Route::Workspace, Route::Session);
                self.navigation.close_session(&id, fallback);
                if current != self.navigation.current() {
                    self.sync_route();
                    self.enter_page();
                }
                self.hits.clear();
                self.hover = None;
            }
            Action::Manage(command) => return self.management_action(command),
            Action::Attachment(command) => return self.attachment_action(command),
            Action::References => self.open_references(),
            Action::Skills(command) => self.skills_action(command),
            Action::Apps(message) => return self.apps_action(message),
            Action::Branch(command) => return self.branch_action(command),
            Action::Recap(command) => return self.recap_action(command),
            Action::Resume(command) => return self.resume_action(command),
            Action::Settings(message) => return self.settings_action(message),
            Action::Sidebar(message) => return self.sidebar_action(message),
            Action::Home(message) => return self.home_action(message),
            Action::Revision(command) => return self.revision_action(command),
            Action::Onboard(command) => return self.onboarding_action(command),
            Action::Project(command) => return self.project_action(command),
            Action::Connection(command) => self.connection_action(command),
            Action::Queue(command) => return self.queue_action(command),
            Action::Copy(_) | Action::CopyFile(_) => return Some(action),
            Action::OpenInteraction => self.open_interaction(),
            Action::Interaction(_) => return Some(action),
            Action::Visit(route) => {
                if !self.prepare_route(&route) {
                    return None;
                }
                if route == self.navigation.current() {
                    return None;
                }
                if matches!(self.navigation.current(), Route::Workspace | Route::Inbox)
                    && let Route::Session(id) = &route
                    && self.catalog().items.iter().any(|item| item.id == *id)
                {
                    self.catalog_mut().selected = Some(id.clone());
                }
                self.leave_page();
                self.invalidate_editor_geometry();
                self.hover = None;
                if let Route::Session(id) = &route {
                    self.sessions.open(id);
                }
                self.navigation.visit(route);
                self.enter_page();
                self.open_draft();
            }
            Action::Back => {
                if !self.prepare_route(&self.navigation.destination(false)) {
                    return None;
                }
                self.leave_page();
                self.hover = None;
                self.navigation.back();
                self.sync_route();
                self.enter_page();
            }
            Action::Forward => {
                if !self.prepare_route(&self.navigation.destination(true)) {
                    return None;
                }
                self.leave_page();
                self.hover = None;
                self.navigation.forward();
                self.sync_route();
                self.enter_page();
            }
            Action::ClosePalette => self.palette = None,
            Action::Palette => {
                // A new palette session: nothing of the last one carries over.
                self.layer.close();
                self.invalidate_editor_geometry();
                self.hover = None;
                // Background updates may disable an action, never move its hit target.
                self.command_palette = crate::pages::commands::State::new(self.commands());
                self.palette = Some(0);
            }
            Action::ToggleTheme => self.theme.cycle(),
            Action::Theme(command) => self.theme_action(command),
            Action::ToggleSidebar => {
                if self.fullscreen() {
                    self.chrome.session_fullscreen = false;
                }
                self.chrome.toggle_sidebar(
                    self.frame_size.map_or(120, |size| size.0),
                    std::time::Instant::now(),
                );
                self.invalidate_editor_geometry();
            }
            Action::ToggleFullscreen => {
                self.chrome.session_fullscreen = !self.chrome.session_fullscreen;
                self.chrome.stop_animation();
                if self.fullscreen() && self.focus == Focus::Navigation {
                    self.focus = Focus::Composer;
                }
                self.invalidate_editor_geometry();
            }
            Action::ToggleDetails => {
                self.invalidate_editor_geometry();
                if self
                    .chat
                    .view
                    .search
                    .as_ref()
                    .is_some_and(|search| search.history.is_some())
                {
                    self.focus = Focus::Page;
                } else {
                    self.chat.view.search = None;
                }
                self.chrome.details = !self.chrome.details;
                if self.chrome.details && self.focus == Focus::Transcript {
                    self.focus = Focus::Page;
                }
            }
            Action::ToggleInspector => {
                self.chrome.inspector = !self.chrome.inspector;
                if !self.chrome.inspector && self.focus == Focus::Inspector {
                    self.focus = Focus::Composer;
                }
                self.apps.inspector.invalidate();
                self.invalidate_editor_geometry();
            }
            Action::BrowseTranscript => {
                self.chat.view.search = None;
                self.chrome.details = false;
                self.chat.view.enter();
                self.focus = Focus::Transcript;
            }
            Action::Search(command) => {
                if matches!(
                    command,
                    crate::pages::chat::render::search::Command::Open
                        | crate::pages::chat::render::search::Command::Scope
                ) && let Some(reader) = self.chat.reader_mut()
                {
                    reader.text_selection.clear();
                }
                self.chrome.details = false;
                self.chat.view.search_command(command);
                self.hover = None;
            }
            Action::ToggleTrace => self.chat.toggle_trace(),
            Action::ToggleSymbols => self.set_ascii(!self.chrome.ascii),
            Action::ToggleMotion => self.set_motion(!self.chrome.motion),
            Action::CycleLocale => {
                self.i18n.cycle();
                self.set_locale(self.i18n.preference);
            }
            Action::RefreshSessions => self.catalog_mut().restart(),
            Action::NextSessions => self.catalog_mut().next(),
            Action::PreviousSessions => self.catalog_mut().previous(),
            Action::RefreshSession => {
                self.sessions.refresh_detail();
                return Some(action);
            }
            Action::OlderMessages => self.chat.request_older(),
            Action::NewerMessages => self.chat.request_newer(),
            Action::LatestMessages => self.chat.latest(),
            Action::ToggleMessage(key) => {
                self.chat.view.search = None;
                self.chat.view.select(key.clone());
                self.chat.view.toggle(&key);
                self.focus = Focus::Transcript;
            }
            Action::SendMessage
            | Action::SteerMessage
            | Action::ReconcileSubmission
            | Action::RetrySubmission
            | Action::StopTurn(_) => {
                return Some(action);
            }
            Action::CreateSession => {
                self.creating = true;
                self.notice = None;
                return Some(action);
            }
            Action::Connect if !matches!(self.connection, ConnectionState::Connecting) => {
                self.connection = ConnectionState::Connecting;
                self.status = None;
                self.notice = None;
                self.sessions = Default::default();
                self.inbox = crate::pages::sessions::Sessions::inbox();
                self.projects = Default::default();
                self.connections = Default::default();
                return Some(action);
            }
            Action::Refresh
                if matches!(self.connection, ConnectionState::Connected { .. })
                    && !self.refreshing =>
            {
                self.refreshing = true;
                return Some(action);
            }
            Action::Quit | Action::Detach | Action::ConfirmQuit => return Some(action),
            Action::CancelQuit => {
                self.shutdown = Default::default();
                self.hits.clear();
                self.hover = None;
            }
            _ => {}
        }
        None
    }
    pub fn enabled(&self, action: &Action) -> bool {
        if *action == Action::ConfirmQuit {
            return matches!(self.shutdown.prompt, Some(crate::shutdown::Prompt::Busy))
                && !self.shutdown.stopping;
        }
        if let Action::Apps(message) = action {
            return self.apps_enabled(message);
        }
        if let Action::Skills(command) = action {
            return self.skills_enabled(command);
        }
        if *action == Action::References {
            return self.management.dialog.is_none()
                && self
                    .reference_target()
                    .is_some_and(|t| self.reference_editable(&t));
        }
        if let Action::Attachment(command) = action {
            return self.attachment_enabled(command);
        }
        if let Action::Revision(command) = action {
            return self.revision_enabled(command);
        }
        if let Action::Recap(command) = action {
            return self.recap_enabled(command);
        }
        if let Action::Resume(command) = action {
            return self.resume_enabled(command);
        }
        if let Action::Sidebar(crate::pages::sidebar::Message::New)
        | Action::Home(crate::pages::home::Message::New) = action
        {
            return self.enabled(&Action::CreateSession);
        }
        if let Action::Settings(message) = action {
            use crate::pages::settings::Message;
            return match message {
                Message::Palette(_) | Message::CustomTheme => !self.theme.busy(),
                Message::SandboxDefaults => self.sandbox_defaults_action().is_some(),
                _ => true,
            };
        }
        if let Action::Branch(command) = action {
            return self.branch_enabled(command);
        }
        if let Action::Connection(command) = action {
            return self.connection_enabled(command);
        }
        if let Action::Onboard(command) = action {
            return self.onboarding_enabled(command);
        }
        if let Action::Project(command) = action {
            return self.project_enabled(command);
        }
        if let Action::Manage(command) = action {
            return self.management_enabled(command);
        }
        if let Action::Queue(command) = action {
            return self.queue_enabled(command);
        }
        if *action == Action::SteerMessage {
            if let Route::Session(id) = self.navigation.current()
                && self.has_skills(&id)
            {
                return false;
            }
            return self
                .stop_target()
                .is_some_and(|target| !self.chat.stop.pending(&target))
                && self.enabled(&Action::SendMessage);
        }
        if let Action::Interaction(command) = action {
            return self.interaction_enabled(*command);
        }
        if *action == Action::OpenInteraction {
            return self.has_interaction();
        }
        let connected = matches!(self.connection, ConnectionState::Connected { .. });
        match action {
            Action::CloseTab(id) => self.tabs.contains(id),
            Action::CopyFile(path) => {
                crate::files::valid_path(path) && std::path::Path::new(path).is_absolute()
            }
            Action::Theme(command) => {
                *command == crate::theme::editor::Command::Close || !self.theme.busy()
            }
            Action::NextTab | Action::PreviousTab => !self.tabs.entries.is_empty(),
            Action::Copy(mode) => {
                matches!(self.navigation.current(), Route::Session(_))
                    && !self.chrome.details
                    && self.chat.reader().is_some_and(|reader| {
                        if *mode == crate::pages::chat::render::selection::CopyMode::Selection {
                            reader.text_selection.active()
                        } else {
                            reader.selection().is_some()
                        }
                    })
            }
            Action::StopTurn(target) => {
                self.stop_target().as_ref() == Some(target) && !self.chat.stop.pending(target)
            }
            Action::Refresh => connected && !self.refreshing,
            Action::Connect => !matches!(self.connection, ConnectionState::Connecting),
            Action::RefreshSessions => connected && !self.catalog().loading,
            Action::NextSessions => connected && self.catalog().can_next(),
            Action::PreviousSessions => connected && self.catalog().can_previous(),
            Action::RefreshSession => connected && self.sessions.can_refresh_detail(),
            Action::OlderMessages => connected && self.chat.can_older(),
            Action::NewerMessages => connected && self.chat.can_newer(),
            Action::LatestMessages => !self.chat.view.following(),
            Action::ToggleMessage(key) => self.chat.view.can_toggle(key),
            Action::CreateSession => {
                connected
                    && !self.creating
                    && self.tabs.entries.len() < crate::navigation::tabs::LIMIT
                    && (self.drafts.len() < crate::navigation::tabs::LIMIT
                        || self.drafts.iter().any(|(id, editor)| {
                            editor.text().is_empty()
                                && !self.attachments.has(id)
                                && !self.has_directories(id)
                                && !self.has_skills(id)
                                && !self.tabs.contains(id)
                                && !self
                                    .sending
                                    .get(id)
                                    .is_some_and(|sent| sent.delivery.blocks_send())
                        }))
            }
            Action::ReconcileSubmission | Action::RetrySubmission => {
                let Route::Session(id) = self.navigation.current() else {
                    return false;
                };
                self.sending.get(&id).is_some_and(|sent| {
                    matches!(&self.connection, ConnectionState::Connected { root_id, epoch } if *root_id == sent.request.root_id
                        && (action != &Action::RetrySubmission || *epoch == sent.request.origin_epoch))
                        && matches!(sent.delivery, crate::pages::sending::Delivery::Unknown(_))
                })
            }
            Action::SendMessage => {
                let Route::Session(id) = self.navigation.current() else {
                    return false;
                };
                connected
                    && !(self.chat.session.as_deref() == Some(&id) && self.chat.removed)
                    && !matches!(&self.sessions.detail, crate::pages::sessions::Detail::Missing { id: missing } if *missing == id)
                    && self.attachments.ready(&id)
                    && (!self.has_skills(&id) || self.stop_target().is_none())
                    && (self.attachments.has(&id)
                        || self.has_directories(&id)
                        || self.has_skills(&id)
                        || self
                            .drafts
                            .get(&id)
                            .is_some_and(|draft| !draft.text().trim().is_empty()))
                    && !self
                        .sending
                        .get(&id)
                        .is_some_and(|sent| sent.delivery.blocks_send())
            }
            Action::ToggleInspector => self.inspector_available(),
            Action::ToggleFullscreen
            | Action::ToggleDetails
            | Action::ToggleTrace
            | Action::BrowseTranscript
            | Action::Search(_) => {
                matches!(self.navigation.current(), Route::Session(_))
            }
            _ => true,
        }
    }
    pub fn send_action(&self) -> Action {
        if let Some(target) = self.stop_target() {
            return Action::StopTurn(target);
        }
        if let Route::Session(id) = self.navigation.current()
            && self
                .sending
                .get(&id)
                .is_some_and(|sent| sent.delivery.unresolved())
        {
            Action::ReconcileSubmission
        } else {
            Action::SendMessage
        }
    }
    pub fn stop_target(&self) -> Option<crate::pages::chat::stopping::Target> {
        let Route::Session(session) = self.navigation.current() else {
            return None;
        };
        if self.chat.session.as_ref() != Some(&session) {
            return None;
        }
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        self.chat.stop_target(root_id, epoch)
    }
    fn sync_route(&mut self) {
        self.invalidate_editor_geometry();
        let route = self.navigation.current();
        if let Route::Session(id) = &route {
            self.sessions.open(id);
        }
        if let Route::App(key) = &route {
            self.apps.open(key);
        }
        if matches!(self.focus, Focus::List | Focus::Composer | Focus::Queue) {
            self.focus = Focus::Page;
        }
        if self.fullscreen() && self.focus == Focus::Navigation {
            self.focus = Focus::Composer;
        }
        self.open_draft();
    }

    fn open_draft(&mut self) {
        if let Route::Session(id) = self.navigation.current()
            && self.drafts.len() < 32
        {
            self.drafts.entry(id).or_default();
        }
    }

    pub(crate) fn catalog(&self) -> &crate::pages::sessions::Sessions {
        if self.navigation.current() == Route::Inbox {
            &self.inbox
        } else {
            &self.sessions
        }
    }

    fn catalog_mut(&mut self) -> &mut crate::pages::sessions::Sessions {
        if self.navigation.current() == Route::Inbox {
            &mut self.inbox
        } else {
            &mut self.sessions
        }
    }

    fn prepare_route(&mut self, route: &Route) -> bool {
        let Route::Session(id) = route else {
            return true;
        };
        if !self.tabs.contains(id) && self.tabs.entries.len() == crate::navigation::tabs::LIMIT {
            self.notice = Some(Notice::Local("tabs-limit"));
            return false;
        }
        if !self.drafts.contains_key(id) && self.drafts.len() == crate::navigation::tabs::LIMIT {
            // Only discard an empty, closed editor with no uncertain submission.
            // Unsent text and accepted-but-unconfirmed identity are never evicted.
            let empty = self
                .drafts
                .iter()
                .find(|(id, editor)| {
                    editor.text().is_empty()
                        && !self.attachments.has(id)
                        && !self.has_directories(id)
                        && !self.has_skills(id)
                        && !self.tabs.contains(id)
                        && !self
                            .sending
                            .get(*id)
                            .is_some_and(|sent| sent.delivery.blocks_send())
                })
                .map(|(id, _)| id.clone());
            if let Some(empty) = empty {
                self.drafts.remove(&empty);
                self.attachments.saved.remove(&empty);
                self.directories.remove(&empty);
                self.skills.saved.remove(&empty);
                self.sending.remove(&empty);
            } else {
                self.notice = Some(Notice::Local("tabs-drafts-limit"));
                return false;
            }
        }
        self.tabs.open(id);
        if matches!(self.notice, Some(Notice::Local(_))) {
            self.notice = None;
        }
        true
    }

    pub fn invalidate_editor_geometry(&mut self) {
        self.layer.invalidate();
        self.apps.invalidate_geometry();
        if let Some(editor) = &mut self.theme.editor {
            editor.invalidate();
        }
        self.management.invalidate_geometry();
        self.skills.invalidate_geometry();
        self.management.oauth.invalidate_identity_geometry();
        self.branch.invalidate_geometry();
        self.recap.invalidate_geometry();
        self.resume.invalidate_geometry();
        self.revision.invalidate_geometry();
        self.onboarding.invalidate_geometry();
        if let Some(reader) = self.chat.reader_mut() {
            reader.text_selection.invalidate_geometry();
            reader.invalidate_scrollbar();
        }
        if let Some(search) = &mut self.chat.view.search {
            search.editor.invalidate_geometry();
            if let Some(history) = &mut search.history {
                history.invalidate_geometry();
            }
        }
        self.queue.area = None;
        if let Some(edit) = &mut self.queue.edit {
            edit.editor.invalidate_geometry();
        }
        self.interactions.invalidate_geometry();
        for editor in self.drafts.values_mut() {
            editor.invalidate_geometry();
        }
    }

    fn editor(&mut self) -> Option<&mut crate::editor::Editor> {
        let Route::Session(id) = self.navigation.current() else {
            return None;
        };
        self.drafts.get_mut(&id)
    }

    /// Only the displayed frame contributes hit regions. Overlay rendering
    /// replaces that list, so a mouse event cannot reach a covered page.
    pub fn input(&mut self, event: Event) -> (bool, Option<Action>) {
        if self.shutdown.stopping
            && !matches!(
                event,
                Event::Resize(_, _) | Event::FocusLost | Event::FocusGained
            )
        {
            return (false, None);
        }
        if self.closing {
            match &event {
                Event::Key(key)
                    if key.code == KeyCode::Esc && key.kind != KeyEventKind::Release =>
                {
                    self.closing = false;
                    return (true, None);
                }
                Event::Resize(_, _) | Event::FocusLost | Event::FocusGained => {}
                _ => return (false, None),
            }
        }
        if matches!(event, Event::FocusLost) {
            self.chrome.window_focused = false;
            self.chrome.stop_animation();
            self.invalidate_editor_geometry();
            self.hover = None;
            self.hover_area = None;
            self.hover_since = None;
            return (true, None);
        }
        if matches!(event, Event::FocusGained) {
            self.chrome.window_focused = true;
            return (true, None);
        }
        let keyboard = matches!(&event, Event::Key(key) if key.kind != KeyEventKind::Release);
        let mouse = matches!(&event, Event::Mouse(_));
        if keyboard && let Some(reader) = self.chat.reader_mut() {
            reader.text_selection.end_drag();
        }
        let outcome = self.dispatch_input(event);
        if mouse
            && outcome.0
            && self.focus == Focus::Transcript
            && let Some(reader) = self.chat.reader_mut()
        {
            // A mouse disclosure may select its message internally; that is not
            // a keyboard focus request and must not underline the clicked title.
            reader.mouse_selected = true;
        }
        if keyboard && outcome.0 {
            self.hover = None;
            self.hover_area = None;
            self.hover_since = None;
        }
        outcome
    }

    /// Kernel surfaces take their input first: the sidebar, then a page
    /// presented by the kernel. Unconsumed events continue to the shell.
    fn surface_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        let (mouse, key) = (
            matches!(event, Event::Mouse(_)),
            matches!(event, Event::Key(_)),
        );
        if mouse || (key && (self.focus == Focus::Navigation || self.sidebar.surface.captures())) {
            let outcome = self.sidebar.surface.input(event).map(Action::Sidebar);
            if outcome.consumed {
                return Some(self.surface_outcome(event, Focus::Navigation, outcome));
            }
        }
        let captures = match self.navigation.current() {
            Route::Settings => self.settings.surface.captures(),
            Route::Workspace => self.home.surface.captures(),
            Route::Extensions | Route::App(_) => self
                .apps_surface()
                .is_some_and(|surface| surface.captures()),
            // A session's panels and status lines take what is theirs; the
            // conversation keeps the rest.
            Route::Session(_) => {
                return self
                    .inspector_input(event)
                    .or_else(|| self.status_input(event));
            }
            _ => return None,
        };
        let paste = matches!(event, Event::Paste(_));
        if !(mouse || ((key || paste) && (self.focus == Focus::Page || captures))) {
            return None;
        }
        let outcome = match self.navigation.current() {
            Route::Settings => {
                if let Some(redraw) = self.settings_field_input(event) {
                    return Some((redraw, None));
                }
                self.settings.surface.input(event).map(Action::Settings)
            }
            Route::App(key) => {
                if let Some(redraw) = self.app_page_input(&key, event) {
                    return Some((redraw, None));
                }
                self.apps_surface()?.input(event).map(Action::Apps)
            }
            Route::Extensions => self.apps.surface.input(event).map(Action::Apps),
            _ => self.home.surface.input(event).map(Action::Home),
        };
        outcome
            .consumed
            .then(|| self.surface_outcome(event, Focus::Page, outcome))
    }

    fn surface_outcome(
        &mut self,
        event: &Event,
        focus: Focus,
        outcome: crate::ui::Outcome<Action>,
    ) -> (bool, Option<Action>) {
        let mut redraw = outcome.redraw;
        if let Event::Mouse(mouse) = event {
            // A surface owns hover over its area; drop the shell's.
            redraw |= self.hover.take().is_some();
            self.hover_area = None;
            if matches!(mouse.kind, MouseEventKind::Down(_)) {
                self.focus = focus;
            }
        }
        let action = outcome.message.and_then(|action| self.apply(action));
        (redraw || action.is_some(), action)
    }

    fn dispatch_input(&mut self, event: Event) -> (bool, Option<Action>) {
        if let Some(overlay) = self.overlay()
            && !matches!(event, Event::Resize(_, _))
        {
            return self.overlay_input(overlay, event);
        }
        if self.palette.is_none()
            && let Event::Key(key) = &event
            && key.kind != KeyEventKind::Release
            && key.modifiers == KeyModifiers::CONTROL
        {
            let action = match key.code {
                KeyCode::PageDown => Some(Action::NextTab),
                KeyCode::PageUp => Some(Action::PreviousTab),
                KeyCode::Char('w') => match self.navigation.current() {
                    Route::Session(id) => Some(Action::CloseTab(id)),
                    _ => None,
                },
                _ => None,
            };
            if let Some(action) = action {
                return (true, self.apply(action));
            }
        }
        if let Some(outcome) = self.surface_input(&event) {
            return outcome;
        }
        if self.palette.is_none()
            && !self.chrome.details
            && matches!(self.navigation.current(), Route::Session(_))
        {
            if let Event::Key(key) = &event
                && key.kind != KeyEventKind::Release
                && key.modifiers == KeyModifiers::SHIFT
                && self.focus == Focus::Transcript
                && (self.chat.view.search.is_none()
                    || self
                        .chat
                        .reader()
                        .is_some_and(|reader| reader.text_selection.has_caret()))
                && let Some(changed) = self
                    .chat
                    .reader_mut()
                    .and_then(|reader| reader.selection_key(key.code))
            {
                return (changed, None);
            }
            if let Event::Key(key) = &event
                && key.kind != KeyEventKind::Release
                && self.chat.reader().is_some_and(|reader| {
                    reader.text_selection.has_caret() || reader.text_selection.dragging()
                })
            {
                if key.code == KeyCode::Esc {
                    self.chat.reader_mut().unwrap().text_selection.clear();
                    if matches!(self.notice, Some(Notice::Clipboard { .. })) {
                        self.notice = None;
                    }
                    return (true, None);
                }
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    return (
                        true,
                        self.apply(Action::Copy(
                            crate::pages::chat::render::selection::CopyMode::Selection,
                        )),
                    );
                }
            }
            if let Event::Mouse(mouse) = &event
                && self.frame_size.is_some()
            {
                if self
                    .chat
                    .reader_mut()
                    .is_some_and(|reader| reader.scrollbar_mouse(*mouse))
                {
                    if mouse.kind == MouseEventKind::Up(MouseButton::Left)
                        && self.chat.view.search.is_none()
                    {
                        self.chat.scroll(true, 0);
                    }
                    self.focus = Focus::Transcript;
                    self.hover = None;
                    return (true, None);
                }
                let target = self
                    .hits
                    .iter()
                    .rev()
                    .find(|hit| hit.area.contains((mouse.column, mouse.row).into()))
                    .map(|hit| hit.action.clone());
                let content = target.as_ref().is_none_or(|action| {
                    matches!(
                        action,
                        Action::ToggleMessage(_)
                            | Action::CopyFile(_)
                            | Action::Search(
                                crate::pages::chat::render::search::Command::PreviewToggle(_)
                            )
                    )
                });
                if (content
                    || self
                        .chat
                        .reader()
                        .is_some_and(|reader| reader.text_selection.dragging()))
                    && let Some(outcome) = self
                        .chat
                        .reader_mut()
                        .and_then(|reader| reader.text_mouse(*mouse, target))
                {
                    self.focus = Focus::Transcript;
                    self.hover = None;
                    return (true, outcome.and_then(|action| self.apply(action)));
                }
            }
        }
        if self.palette.is_none()
            && !self.chrome.details
            && matches!(self.navigation.current(), Route::Session(_))
            && let Some(outcome) = self.chat.view.search_input(&event)
        {
            if matches!(event, Event::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left))
                && let Some(reader) = self.chat.reader_mut()
            {
                reader.text_selection.clear();
            }
            return (outcome, None);
        }
        let action = match event {
            Event::Resize(_, _) => {
                self.chat.area = None;
                self.settings.surface.invalidate();
                self.sidebar.surface.invalidate();
                self.home.surface.invalidate();
                if let Some(surface) = self.apps_surface() {
                    surface.invalidate();
                }
                self.invalidate_editor_geometry();
                self.hits.clear();
                self.frame_size = None;
                self.hover = None;
                return (true, None);
            }
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q') {
                    Some(Action::Quit)
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('f')
                    && matches!(self.navigation.current(), Route::Session(_))
                {
                    Some(Action::Search(
                        crate::pages::chat::render::search::Command::Open,
                    ))
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('a')
                    && self.focus != Focus::Composer
                    && self.has_interaction()
                {
                    Some(Action::OpenInteraction)
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('n')
                {
                    // New session from anywhere; Projects creates in its selection.
                    if self.navigation.current() == Route::Projects {
                        self.projects
                            .selected
                            .clone()
                            .map(|id| Action::Project(crate::pages::projects::Command::Create(id)))
                    } else {
                        Some(Action::CreateSession)
                    }
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('r')
                    && matches!(self.navigation.current(), Route::Session(_))
                {
                    Some(Action::ReconcileSubmission)
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('o')
                    && matches!(self.navigation.current(), Route::Session(_))
                {
                    Some(Action::SteerMessage)
                } else if self.focus == Focus::Queue && self.palette.is_none() {
                    return self.queue_key(key);
                } else if key.code == KeyCode::Up
                    && key.modifiers.is_empty()
                    && self.focus == Focus::Composer
                    && self.editor().is_some_and(|editor| editor.text().is_empty())
                    && !self.queue_rows().is_empty()
                {
                    Some(Action::Queue(crate::pages::queue::Command::Focus))
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('s')
                    && matches!(self.navigation.current(), Route::Session(_))
                {
                    Some(Action::SendMessage)
                } else if matches!(key.code, KeyCode::PageUp | KeyCode::PageDown)
                    && self.focus != Focus::Composer
                    && matches!(self.navigation.current(), Route::Session(_))
                {
                    if key.code == KeyCode::PageUp {
                        self.chat.scroll(true, 10);
                    } else {
                        self.chat.scroll(false, 10);
                    }
                    return (true, None);
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('p')
                {
                    Some(Action::Palette)
                } else if key.modifiers.contains(KeyModifiers::ALT)
                    && key.code == KeyCode::Down
                    && self.focus != Focus::Composer
                    && matches!(self.navigation.current(), Route::Session(_))
                {
                    Some(Action::BrowseTranscript)
                } else if key.modifiers.contains(KeyModifiers::ALT) && key.code == KeyCode::Left {
                    Some(Action::Back)
                } else if key.modifiers.contains(KeyModifiers::ALT) && key.code == KeyCode::Right {
                    Some(Action::Forward)
                } else if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('b')
                {
                    Some(Action::ToggleSidebar)
                } else {
                    match key.code {
                        KeyCode::End
                            if self.focus != Focus::Composer
                                && matches!(self.navigation.current(), Route::Session(_)) =>
                        {
                            Some(Action::LatestMessages)
                        }
                        KeyCode::Char(' ')
                            if self.focus != Focus::Composer
                                && !self.chrome.details
                                && matches!(self.navigation.current(), Route::Session(_)) =>
                        {
                            self.chat.view.selection().map(Action::ToggleMessage)
                        }
                        KeyCode::F(1) => Some(Action::Visit(Route::Help)),
                        KeyCode::F(5) => self.refresh_action(),
                        KeyCode::F(11) => Some(Action::ToggleFullscreen),
                        KeyCode::Tab | KeyCode::BackTab => {
                            let count = self.page_actions().len().max(1);
                            let backwards = key.code == KeyCode::BackTab
                                || key.modifiers.contains(KeyModifiers::SHIFT);
                            match self.focus {
                                Focus::Queue => self.focus = Focus::Composer,
                                Focus::Navigation => {
                                    self.focus = if !backwards
                                        && matches!(
                                            self.navigation.current(),
                                            Route::Inbox | Route::Projects | Route::Connections
                                        ) {
                                        Focus::List
                                    } else if !backwards
                                        && matches!(self.navigation.current(), Route::Session(_))
                                    {
                                        Focus::Composer
                                    } else {
                                        Focus::Page
                                    };
                                    self.selected_control = if backwards { count - 1 } else { 0 };
                                }
                                Focus::List | Focus::Composer => {
                                    self.focus = if backwards {
                                        Focus::Navigation
                                    } else if self.focus == Focus::Composer && !self.chrome.details
                                    {
                                        self.chat.view.enter();
                                        Focus::Transcript
                                    } else {
                                        Focus::Page
                                    };
                                    self.selected_control = 0;
                                }
                                Focus::Transcript => {
                                    self.focus = if backwards {
                                        Focus::Composer
                                    } else if self.inspector_shown() {
                                        Focus::Inspector
                                    } else {
                                        Focus::Page
                                    };
                                    self.selected_control = 0;
                                }
                                // Panels read after the conversation they belong to.
                                Focus::Inspector => {
                                    self.focus = if !backwards {
                                        Focus::Page
                                    } else if self.chrome.details {
                                        Focus::Composer
                                    } else {
                                        self.chat.view.enter();
                                        Focus::Transcript
                                    };
                                    self.selected_control = 0;
                                }
                                Focus::Page if backwards && self.selected_control > 0 => {
                                    self.selected_control -= 1
                                }
                                Focus::Page if !backwards && self.selected_control + 1 < count => {
                                    self.selected_control += 1
                                }
                                Focus::Page => {
                                    self.focus = if backwards
                                        && matches!(
                                            self.navigation.current(),
                                            Route::Inbox | Route::Projects | Route::Connections
                                        ) {
                                        Focus::List
                                    } else if backwards && self.inspector_shown() {
                                        Focus::Inspector
                                    } else if backwards
                                        && matches!(self.navigation.current(), Route::Session(_))
                                    {
                                        if self.chrome.details {
                                            Focus::Composer
                                        } else {
                                            self.chat.view.enter();
                                            Focus::Transcript
                                        }
                                    } else {
                                        Focus::Navigation
                                    }
                                }
                            }
                            if self.fullscreen() && self.focus == Focus::Navigation {
                                self.focus = if backwards {
                                    Focus::Page
                                } else {
                                    Focus::Composer
                                };
                                self.selected_control = count - 1;
                            }
                            match (self.focus, self.navigation.current()) {
                                (Focus::Navigation, _) => self.sidebar.surface.enter(backwards),
                                (Focus::Inspector, _) => self.apps.inspector.enter(backwards),
                                (Focus::Page, Route::Settings) => {
                                    self.settings.surface.enter(backwards)
                                }
                                (Focus::Page, Route::Workspace) => {
                                    self.home.surface.enter(backwards)
                                }
                                (Focus::Page, Route::Extensions | Route::App(_)) => {
                                    if let Some(surface) = self.apps_surface() {
                                        surface.enter(backwards);
                                    }
                                }
                                _ => {}
                            }
                            None
                        }
                        KeyCode::Esc if self.focus == Focus::Composer => {
                            self.focus = Focus::Page;
                            None
                        }
                        KeyCode::Esc if self.focus == Focus::Inspector => {
                            self.focus = Focus::Composer;
                            None
                        }
                        KeyCode::Esc if self.focus == Focus::Transcript => {
                            self.focus = Focus::Page;
                            None
                        }
                        KeyCode::Home if self.focus == Focus::Transcript => {
                            self.chat.view.first();
                            None
                        }
                        KeyCode::Up | KeyCode::Down if self.focus == Focus::Transcript => {
                            self.chat.view.move_selection(key.code == KeyCode::Down);
                            None
                        }
                        KeyCode::Left | KeyCode::Right if self.focus == Focus::Transcript => self
                            .chat
                            .view
                            .horizontal(key.code == KeyCode::Right)
                            .map(Action::ToggleMessage),
                        KeyCode::Enter if self.focus == Focus::Transcript => {
                            self.chat.view.selection().map(Action::ToggleMessage)
                        }
                        _ if self.focus == Focus::Composer => {
                            return (self.editor().is_some_and(|editor| editor.key(key)), None);
                        }
                        KeyCode::Up if self.focus == Focus::Page => {
                            self.selected_control = self.selected_control.saturating_sub(1);
                            None
                        }
                        KeyCode::Down if self.focus == Focus::Page => {
                            self.selected_control = (self.selected_control + 1)
                                .min(self.page_actions().len().saturating_sub(1));
                            None
                        }
                        KeyCode::Up | KeyCode::Down if self.focus == Focus::List => {
                            if self.navigation.current() == Route::Connections {
                                self.connections.move_selection(key.code == KeyCode::Down);
                            } else if self.navigation.current() == Route::Projects {
                                self.projects.move_selection(key.code == KeyCode::Down);
                            } else {
                                self.catalog_mut().move_selection(key.code == KeyCode::Down);
                            }
                            None
                        }
                        KeyCode::Enter
                            if self.focus == Focus::List
                                && self.navigation.current() == Route::Projects =>
                        {
                            self.projects.selected.clone().map(|id| {
                                Action::Project(crate::pages::projects::Command::Create(id))
                            })
                        }
                        KeyCode::Enter
                            if self.focus == Focus::List
                                && self.navigation.current() == Route::Connections =>
                        {
                            self.rename_connection_action()
                        }
                        KeyCode::Enter if self.focus == Focus::List => self
                            .catalog()
                            .selected
                            .clone()
                            .map(|id| Action::Visit(Route::Session(id))),
                        KeyCode::Enter => self.page_actions().get(self.selected_control).cloned(),
                        KeyCode::Esc => Some(Action::Back),
                        _ => return (false, None),
                    }
                }
            }
            Event::Mouse(mouse) if self.frame_size.is_some() => {
                if self.palette.is_none()
                    && let Some(editor) = self.editor()
                {
                    let point = Position::new(mouse.column, mouse.row);
                    if (editor.contains(point) || editor.dragging()) && editor.mouse(mouse) {
                        if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
                            if let Some(reader) = self.chat.reader_mut() {
                                reader.text_selection.clear();
                            }
                            self.chat.view.search = None;
                            self.focus = Focus::Composer;
                        }
                        self.hover = None;
                        return (true, None);
                    }
                }
                let hit = self
                    .hits
                    .iter()
                    .rev()
                    .find(|hit| hit.area.contains(Position::new(mouse.column, mouse.row)))
                    .cloned();
                if self.palette.is_none()
                    && self
                        .queue
                        .area
                        .is_some_and(|area| area.contains(Position::new(mouse.column, mouse.row)))
                    && matches!(
                        mouse.kind,
                        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                    )
                {
                    self.queue_move(mouse.kind == MouseEventKind::ScrollDown);
                    return (true, None);
                }
                if self.palette.is_none()
                    && self
                        .chat
                        .area
                        .is_some_and(|area| area.contains(Position::new(mouse.column, mouse.row)))
                {
                    match mouse.kind {
                        MouseEventKind::ScrollUp => {
                            self.chat.scroll(true, 3);
                            return (true, None);
                        }
                        MouseEventKind::ScrollDown => {
                            self.chat.scroll(false, 3);
                            return (true, None);
                        }
                        _ => {}
                    }
                }
                let target = hit.as_ref().map(|hit| hit.action.clone());
                match mouse.kind {
                    MouseEventKind::Moved => {
                        let area = hit.map(|hit| hit.area);
                        if self.hover == target && self.hover_area == area {
                            return (false, None);
                        }
                        self.hover = target;
                        self.hover_area = area;
                        self.hover_since = Some(Instant::now());
                        return (true, None);
                    }
                    MouseEventKind::Down(MouseButton::Left) => {
                        if target.as_ref().is_some_and(|action| {
                            !matches!(
                                action,
                                Action::Visit(_)
                                    | Action::Back
                                    | Action::Forward
                                    | Action::NextTab
                                    | Action::PreviousTab
                                    | Action::CloseTab(_)
                            ) && !matches!(
                                action,
                                Action::Search(_) | Action::Palette | Action::ToggleDetails
                            )
                        }) {
                            self.chat.view.search = None;
                        }
                        if self.palette.is_none()
                            && let Some(index) = self
                                .page_actions()
                                .iter()
                                .position(|action| Some(action) == target.as_ref())
                        {
                            self.focus = Focus::Page;
                            self.selected_control = index;
                        }
                        if target.is_some() {
                            self.palette = None;
                        }
                        target
                    }
                    MouseEventKind::ScrollDown | MouseEventKind::ScrollUp
                        if self.navigation.current() == Route::Connections
                            && matches!(
                                target.as_ref(),
                                Some(Action::Connection(
                                    crate::pages::connections::Command::Select(_)
                                ))
                            ) =>
                    {
                        self.focus = Focus::List;
                        self.connections
                            .move_selection(mouse.kind == MouseEventKind::ScrollDown);
                        None
                    }
                    MouseEventKind::ScrollDown | MouseEventKind::ScrollUp
                        if self.navigation.current() == Route::Projects
                            && matches!(
                                target.as_ref(),
                                Some(Action::Project(crate::pages::projects::Command::Select(_)))
                            ) =>
                    {
                        self.focus = Focus::List;
                        self.projects
                            .move_selection(mouse.kind == MouseEventKind::ScrollDown);
                        None
                    }
                    MouseEventKind::ScrollDown | MouseEventKind::ScrollUp
                        if self.navigation.current() == Route::Inbox
                            && target
                                .as_ref()
                                .is_some_and(|a| matches!(a, Action::Visit(Route::Session(_)))) =>
                    {
                        self.focus = Focus::List;
                        self.catalog_mut()
                            .move_selection(mouse.kind == MouseEventKind::ScrollDown);
                        None
                    }
                    _ => return (false, None),
                }
            }
            Event::Paste(text) if self.palette.is_none() && self.focus == Focus::Composer => {
                return (
                    self.editor().is_some_and(|editor| editor.insert(&text)),
                    None,
                );
            }
            _ => return (false, None),
        };
        (true, action.and_then(|action| self.apply(action)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEvent;
    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }
    #[test]
    fn mouse_disclosure_does_not_leave_keyboard_focus_decoration() {
        use ratatui::{Terminal, backend::TestBackend};
        let mut app = App::new(
            "/unused".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.apply(Action::Visit(Route::Session("chat".into())));
        let rows = std::collections::BTreeMap::from([(
            1,
            serde_json::json!({
                "id":"prompt","turnId":"turn","type":"user","text":"first\nsecond\nthird\nfourth"
            }),
        )]);
        app.chat.view.sync(&rows, &[], 0, &app.i18n, false);
        app.frame_size = Some((60, 10));
        let mut terminal = Terminal::new(TestBackend::new(60, 10)).unwrap();
        terminal
            .draw(|frame| app.hits = app.chat.view.draw(frame, frame.area(), false).unwrap())
            .unwrap();
        let hit = app
            .hits
            .iter()
            .find(|hit| matches!(hit.action, Action::ToggleMessage(_)))
            .unwrap()
            .clone();
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            app.input(Event::Mouse(crossterm::event::MouseEvent {
                kind,
                column: hit.area.x + 3,
                row: hit.area.y,
                modifiers: KeyModifiers::NONE,
            }));
        }
        let Action::ToggleMessage(message) = hit.action else {
            unreachable!()
        };
        assert!(!app.chat.view.folded(&message));
        assert!(
            app.chat.view.mouse_selected,
            "mouse expansion must not ask for an underline"
        );
        app.input(key(KeyCode::Down));
        assert!(
            !app.chat.view.mouse_selected,
            "keyboard navigation remains visibly focused"
        );
    }
    #[test]
    fn session_tabs_preserve_drafts_pending_identity_and_scoped_keyboard_with_bounded_overflow() {
        use ratatui::{Terminal, backend::TestBackend};
        for locale in crate::Locale::ALL {
            let mut app = App::new(
                "/unconfigured".into(),
                crate::i18n::I18n::new(crate::LocalePreference::Explicit(locale), locale),
            );
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            let mut terminal = Terminal::new(TestBackend::new(120, 24)).unwrap();
            app.apply(Action::Visit(Route::Session("a".into())));
            app.drafts.get_mut("a").unwrap().insert("未发送🦀");
            let submission = app.submission().unwrap();
            app.apply(Action::Visit(Route::Session("b".into())));
            app.drafts.get_mut("b").unwrap().insert("other draft");
            app.tabs.rename("a", "同名");
            app.tabs.rename("b", "同名");
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.input(Event::Key(KeyEvent::new(
                KeyCode::PageUp,
                KeyModifiers::CONTROL,
            )));
            assert_eq!(app.navigation.current(), Route::Session("a".into()));
            app.apply(Action::Palette);
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('w'),
                KeyModifiers::CONTROL,
            )));
            assert_eq!(
                app.tabs.entries.len(),
                2,
                "modal input must not close a background tab"
            );
            app.input(key(KeyCode::Esc));
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('w'),
                KeyModifiers::CONTROL,
            )));
            assert_eq!(app.navigation.current(), Route::Session("b".into()));
            assert_eq!(app.drafts["a"].text(), "未发送🦀");
            assert_eq!(app.sending["a"].request.id, submission.id);
            assert!(app.sending["a"].delivery.blocks_send());
            app.apply(Action::Visit(Route::Session("a".into())));
            assert!(!app.enabled(&Action::SendMessage));
            assert_eq!(app.drafts["b"].text(), "other draft");
            app.chat
                .view
                .search_command(crate::pages::chat::render::search::Command::Open);
            app.chat.view.search.as_mut().unwrap().editor.insert("find");
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.apply(Action::CloseTab("b".into()));
            assert_eq!(
                app.chat.view.search.as_ref().unwrap().editor.text(),
                "find",
                "closing a background tab must not dismiss the current find scope"
            );
            assert_eq!(app.navigation.current(), Route::Session("a".into()));
            app.apply(Action::Visit(Route::Session("b".into())));
            for index in 0..30 {
                app.apply(Action::Visit(Route::Session(format!("s-{index}"))));
                app.drafts
                    .get_mut(&format!("s-{index}"))
                    .unwrap()
                    .insert("keep");
            }
            let before = app.navigation.current();
            app.apply(Action::Visit(Route::Session("overflow".into())));
            assert_eq!(app.navigation.current(), before);
            assert!(matches!(app.notice, Some(Notice::Local("tabs-limit"))));
            app.apply(Action::CloseTab("s-0".into()));
            app.apply(Action::Visit(Route::Session("overflow".into())));
            assert!(matches!(
                app.notice,
                Some(Notice::Local("tabs-drafts-limit"))
            ));
            app.drafts
                .get_mut("s-0")
                .unwrap()
                .clear_if_unchanged("keep");
            app.apply(Action::Visit(Route::Session("overflow".into())));
            assert_eq!(app.navigation.current(), Route::Session("overflow".into()));
            assert_eq!(app.drafts.len(), 32);
            app.focus = Focus::Navigation;
            for width in [30, 80, 120] {
                let mut terminal = Terminal::new(TestBackend::new(width, 10)).unwrap();
                terminal
                    .draw(|frame| crate::view::draw(frame, &mut app))
                    .unwrap();
                app.input(Event::Resize(width, 10));
            }
            assert!(app.i18n.diagnostics().is_empty());
        }
    }
    #[test]
    fn escape_restores_scope_without_navigating() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.apply(Action::Visit(Route::Settings));
        let focus = app.focus;
        app.apply(Action::Palette);
        app.input(key(KeyCode::Esc));
        assert_eq!(app.focus, focus);
        assert_eq!(app.navigation.current(), Route::Settings);
        app.input(key(KeyCode::Esc));
        assert_eq!(app.navigation.current(), Route::Workspace);
    }

    #[test]
    fn windows_release_and_unused_inputs_do_not_activate_or_redraw() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.apply(Action::Visit(Route::Settings));
        let event =
            KeyEvent::new_with_kind(KeyCode::Enter, KeyModifiers::NONE, KeyEventKind::Release);
        assert_eq!(app.input(Event::Key(event)), (false, None));
        assert!((app.theme.choice != crate::theme::Choice::Terminal));
        assert_eq!(
            app.input(Event::Paste("do not execute\n".into())),
            (false, None)
        );
        assert!(app.tooltip_wait().is_none());
        app.hover = Some(Action::ToggleSidebar);
        app.hover_since = Some(Instant::now());
        assert_eq!(app.input(key(KeyCode::F(12))), (false, None));
        assert_eq!(app.hover, Some(Action::ToggleSidebar));
        assert!(app.tooltip_wait().is_some());
        assert!(!app.tooltip_visible());
        app.hover_since = Some(Instant::now() - Duration::from_millis(500));
        assert!(app.tooltip_visible());
        assert!(
            app.tooltip_wait().is_none(),
            "a visible tooltip must not keep waking the loop"
        );
        app.hover = Some(Action::ToggleMessage(
            serde_json::from_value(
                serde_json::json!({"turn":"t", "message":"tool", "part":"tool"}),
            )
            .unwrap(),
        ));
        assert!(
            !app.tooltip_visible(),
            "foldable rows should not explain their own affordance"
        );
        assert!(app.tooltip_wait().is_none());
        app.hover = Some(Action::CopyFile("/workspace/main.rs".into()));
        assert!(
            app.tooltip_visible(),
            "file links retain their full-path tooltip"
        );
        app.apply(Action::Palette);
        assert!(!app.tooltip_visible());
        assert!(app.tooltip_wait().is_none());
    }
}
