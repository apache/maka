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

//! The message composer under the transcript.

use std::collections::HashMap;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Enter, InputEvent, Position, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, IconName, Sizable as _, h_flex, v_flex,
};
use gpui_kit::{
    Anchor, AnyElement, App, AppContext as _, BoxShadow, ClipboardEntry, ClipboardItem, Context,
    ElementId, Entity, ExternalPaths, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, TestSupportExt as _, WeakEntity, Window, div, point, px, rems,
};
use host_protocol::{
    AttachmentKind, ChangeNotice, MAX_ATTACHMENT_COUNT, MessageContent, MessagePlacement, Nullable,
    PermissionMode, PushFrame, RuntimePolicyQuery, RuntimePolicyQueryInput,
    SessionConfigurationPatch, SessionCreateInput, SessionModelTarget, ThinkingLevel,
};
use shared::copy::conversation as copy;
use shared::copy::{self as shell_copy, Locale, Text};
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, DISABLED_OPACITY, MakaPalette};
use workspace::actions::{AddConnection, OpenProjectSettings, SendMessage, StopTurn};
use workspace::{
    ConnectionCatalog, ConnectionCatalogStatus, ConnectionList, HostSessionEvent, ProjectCommand,
    ProjectSelection,
};

use crate::attachments::{self, AttachmentSource, PickRefusal, PickedFile};
use crate::queue::QueuePlate;
use crate::side_chat::SideChat;
use crate::state::{ConversationState, TurnActivity, new_session_id};
use crate::style::{
    BODY_SIZE, COLUMN_GUTTER, LABEL_SIZE, RADIUS_CHAT, RADIUS_CONTROL, RADIUS_SURFACE,
    SUPPORTING_SIZE, column_max_width, dp, dp_px,
};

/// Key context of the composer region.
const COMPOSER_CONTEXT: &str = "Composer";

/// Rows the draft grows through before it scrolls.
const DRAFT_ROWS: (usize, usize) = (1, 8);

/// The project picker's menu width bounds.
const PROJECT_MENU_MIN_WIDTH_REMS: f32 = 15.;
const PROJECT_MENU_MAX_WIDTH_REMS: f32 = 24.;
/// The widest a project's name reads on its chip before it is cut short.
const PROJECT_CHIP_LABEL_MAX_REMS: f32 = 12.;

/// Which session setting a `session.configuration.update` in flight
/// changes, so only that picker shows progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Setting {
    Model,
    ThinkingLevel,
    PermissionMode,
}

/// What the thinking level picker offers and shows: the levels of the
/// model (in the catalog's order, with Model default before them) and the
/// one in use, `None` for the model's default.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ThinkingChoice {
    levels: Vec<ThinkingLevel>,
    current: Option<ThinkingLevel>,
}

/// The draft of a task that is not on screen: its text and its files.
#[derive(Debug, Default)]
struct StashedDraft {
    text: String,
    attachments: Vec<PickedFile>,
}

/// The model the person picked for the new task, by connection and model
/// id.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DraftModel {
    connection_id: SharedString,
    model: SharedString,
}

/// A model a picker offers, as the catalog names it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OfferedModel {
    connection_id: SharedString,
    connection_slug: SharedString,
    model: SharedString,
    label: SharedString,
}

/// What the composer's one round button does now. It sends the draft, and
/// while a turn runs with an empty draft it is Stop, as in Maka Desktop: a
/// draft typed mid-turn is sent (the Host queues it), so the primary control
/// never offers something that cannot happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerAction {
    /// Send the draft; `enabled` needs a connection, a loaded session, and
    /// text. `busy` while a `turn.message.submit` is in flight. `queues`
    /// when a turn runs, so the message waits for it.
    Send { enabled: bool, busy: bool, queues: bool },
    /// Stop the running turn. `busy` while a `turn.stop` is in flight.
    Stop { enabled: bool, busy: bool },
}

/// A multi-line draft in a rounded card, with the session's model and
/// permission mode and one round button that sends or stops.
///
/// Enter sends and Shift+Enter inserts a newline; while a turn runs, Enter
/// queues the message after it and Cmd+Enter (Ctrl+Enter elsewhere) steers
/// the running turn with it, as in Maka Desktop. The textarea runs in
/// submit-on-enter mode: it inserts the newline for Shift+Enter itself and
/// lets a plain (or secondary) Enter action bubble up, where the composer
/// handles it. Handling it matters: an Enter nobody handles is typed into the
/// textarea as a newline.
///
/// Presentation owner of the draft; [`ConversationState`] owns the session it
/// sends to and the turn commands. Sending needs a connected Host and a
/// loaded session ([`TurnActivity`]); every message goes through
/// `turn.message.submit`, so the Host decides whether it starts a turn or
/// waits in the queue, which [`QueuePlate`] shows above the card. The draft
/// stays until the Host accepts the message, and stays after a refusal,
/// whose reason shows in the card. The round button is Send, or Stop while
/// a turn runs and the draft is empty ([`ComposerAction`]); there is never a
/// second, disabled button beside it. The shell dispatches its Send and Stop
/// commands here, so the button, the menu, and the key bindings end in
/// [`Self::send`] and [`Self::stop`].
///
/// The thinking level picker follows the model picker (Desktop's
/// `ThinkingLevelSelector`): Model default, then the levels the model
/// offers, the one in use checked; it is not there for a model that offers
/// none. A choice for the session sends its model target with the level,
/// as Desktop does; it waits while a turn runs, as the model picker does.
/// A model switch sets the level back to the model's default.
///
/// The model picker lists every enabled model of every enabled connection
/// in [`ConnectionCatalog`], grouped under the connection's name, with the
/// session's model checked. Choosing one switches the session through
/// [`ConversationState::configure_session`]; the picker shows progress
/// until the Host commits, keeps the old model if it refuses (the reason
/// shows in the card), and is disabled while a turn runs, when the Host
/// would refuse the switch.
///
/// The permission mode picker offers Maka's three modes, each with its
/// one-line description, Full access's in the warning color. It goes
/// through the same update. It stays available while a turn runs: the Host
/// lets a mode widen mid-turn and says so when it refuses a narrowing.
///
/// With no session selected the composer is the new task's draft
/// (Desktop's new-task surface): the model and permission mode pickers
/// choose what the task starts with, and Send creates the task in the
/// chosen project with them, then sends the message as its first
/// ([`ConversationState::start_session`]). With no project to start it
/// in, Send asks for a folder first ([`ProjectSelection::add_project`])
/// and sends once one is chosen.
///
/// Each task keeps its own draft, and so does the new task, as in Desktop:
/// the text and files on screen belong to the task shown, and come back
/// when it shows again.
///
/// A side chat's composer ([`Self::for_side_chat`]) sends through its
/// [`SideChat`], which makes the fork on the first send. It has one draft
/// (the side chat's), the quotes staged for the next message as chips
/// above it, the model as a read-only chip (the fork runs its task's), the
/// permission mode picker (before the fork exists, the mode it starts
/// with), and no project chip.
///
/// Keyboard: Tab goes from the draft to the model and permission mode
/// pickers (once the settings are read) and then to the round button.
pub struct Composer {
    draft: Entity<TextareaState>,
    state: Entity<ConversationState>,
    /// The side chat this composer sends for, when it is one's.
    side: Option<Entity<SideChat>>,
    queue: Entity<QueuePlate>,
    /// Files picked, pasted, or dropped for the next message, in that
    /// order.
    attachments: Vec<PickedFile>,
    /// The session the draft on screen belongs to (`None`: the new task).
    draft_key: Option<SharedString>,
    /// The drafts of the tasks not on screen, the new task's under `None`.
    stash: HashMap<Option<SharedString>, StashedDraft>,
    connections: Entity<ConnectionCatalog>,
    /// Where a new task goes.
    projects: Entity<ProjectSelection>,
    /// The model the person picked for the new task.
    draft_model: Option<DraftModel>,
    /// The thinking level the person picked for the new task (`Some(None)`:
    /// Model default); untouched, the model's own default applies.
    draft_thinking: Option<Option<ThinkingLevel>>,
    /// The permission mode the person picked for the new task.
    draft_mode: Option<PermissionMode>,
    /// The permission mode the Host starts a new task in
    /// (`chatDefaults.permissionMode`), read on connecting.
    default_mode: Option<PermissionMode>,
    /// A `turn.start` the Host has not answered.
    sending: bool,
    /// A `turn.stop` the Host has not answered.
    stopping: bool,
    /// The setting a `session.configuration.update` in flight changes.
    configuring: Option<Setting>,
    /// Why the last send, stop, or settings change failed.
    error: Option<SharedString>,
    /// The model the picker last named: what the disabled chip shows while
    /// no task's settings can be read (offline, or with no task).
    last_model: Option<SharedString>,
    /// The placeholder the draft shows: "Ask anything…", or while a turn
    /// runs, when a message waits for it, "Queue a follow-up…".
    placeholder: &'static str,
    _send: Option<Task<()>>,
    _stop: Option<Task<()>>,
    _configure: Option<Task<()>>,
    _pick: Option<Task<()>>,
    /// Asking for a project before a new task's first message.
    _project: Option<Task<()>>,
    _policy: Option<Task<()>>,
    /// The last batch of files being checked; each batch waits for the one
    /// before, so none is lost and they arrive in order.
    _inspect: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for Composer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Composer").finish_non_exhaustive()
    }
}

impl Composer {
    pub fn new(
        state: Entity<ConversationState>,
        connections: Entity<ConnectionCatalog>,
        projects: Entity<ProjectSelection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let draft = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(DRAFT_ROWS.0, DRAFT_ROWS.1)
                .submit_on_enter(true)
                .placeholder(copy::COMPOSER_PLACEHOLDER.get(cx))
        });
        let host = state.read(cx).host().clone();
        let queue = cx.new(|cx| QueuePlate::new(state.clone(), cx));
        let subscriptions = vec![
            cx.subscribe(&draft, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.error = None;
                    cx.notify();
                }
            }),
            // The selection, the turn activity, and the connection. The
            // draft follows the task on screen; the placeholder follows
            // whether a message would wait for a turn.
            cx.observe_in(&state, window, |this, _, window, cx| {
                this.sync_draft_key(window, cx);
                this.sync_placeholder(window, cx);
                cx.notify();
            }),
            // Offline, the placeholder says why nothing can be sent.
            cx.observe_in(&host, window, |this, _, window, cx| {
                this.sync_placeholder(window, cx);
                cx.notify();
            }),
            // The permission mode a new task starts in, read again with each
            // connection and when the Host's configuration changes.
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| match event {
                HostSessionEvent::Connected { .. } => this.read_default_mode(cx),
                HostSessionEvent::Push(frame)
                    if matches!(
                        frame.as_ref(),
                        PushFrame::Change(ChangeNotice::ConfigurationChanged { .. })
                    ) =>
                {
                    this.read_default_mode(cx)
                }
                _ => {}
            }),
            // The models the picker lists.
            cx.observe(&connections, |_, _, cx| cx.notify()),
            // Where a new task goes.
            cx.observe(&projects, |_, _, cx| cx.notify()),
            // The placeholder is the draft's own state, set in words.
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                this.sync_placeholder(window, cx);
            }),
        ];
        let draft_key = state.read(cx).session_id().cloned();
        let mut this = Self {
            draft,
            state,
            side: None,
            queue,
            attachments: Vec::new(),
            draft_key,
            stash: HashMap::new(),
            last_model: None,
            connections,
            projects,
            draft_model: None,
            draft_thinking: None,
            draft_mode: None,
            default_mode: None,
            sending: false,
            stopping: false,
            configuring: None,
            error: None,
            placeholder: copy::COMPOSER_PLACEHOLDER.get(cx),
            _send: None,
            _stop: None,
            _configure: None,
            _pick: None,
            _project: None,
            _policy: None,
            _inspect: None,
            _subscriptions: subscriptions,
        };
        this.read_default_mode(cx);
        this
    }

    /// A side chat's composer: it sends through `chat`, whose fork it
    /// shows once made.
    pub fn for_side_chat(
        chat: Entity<SideChat>,
        connections: Entity<ConnectionCatalog>,
        projects: Entity<ProjectSelection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = chat.read(cx).state().clone();
        let mut this = Self::new(state, connections, projects, window, cx);
        this.draft_key = None;
        this._subscriptions.push(cx.observe(&chat, |_, _, cx| cx.notify()));
        this.side = Some(chat);
        this
    }

    /// The side chat it sends for, when it is one's.
    pub fn side_chat(&self) -> Option<&Entity<SideChat>> {
        self.side.as_ref()
    }

    /// Reads the permission mode the Host starts a new task in
    /// (`runtime.policy.query`, `chatDefaults.permissionMode`), which the
    /// new task's picker shows until the person picks one. A failed read
    /// leaves the Host to apply it.
    fn read_default_mode(&mut self, cx: &mut Context<Self>) {
        if !self.connected(cx) {
            return;
        }
        let requester = self.state.read(cx).host().read(cx).requester();
        let request = requester.request::<RuntimePolicyQuery>(&RuntimePolicyQueryInput::default());
        self._policy = Some(cx.spawn(async move |this, cx| {
            let snapshot = match request.await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    log::info!("runtime.policy.query failed: {error}");
                    return;
                }
            };
            let mode = snapshot.policy.chat_defaults.permission_mode;
            this.update(cx, |this, cx| {
                this.default_mode = Some(PermissionMode::from_wire(mode.as_str()));
                cx.notify();
            })
            .ok();
        }));
    }

    /// Puts the draft of the task now shown on screen, keeping the one it
    /// replaces for when its task shows again (Desktop's per-task drafts).
    fn sync_draft_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // A side chat has one draft, the fork's from its first send on.
        if self.side.is_some() {
            return;
        }
        let key = self.state.read(cx).session_id().cloned();
        if key == self.draft_key {
            return;
        }
        let leaving = std::mem::replace(&mut self.draft_key, key.clone());
        let text = self.draft.read(cx).value().to_string();
        let attachments = std::mem::take(&mut self.attachments);
        if text.is_empty() && attachments.is_empty() {
            self.stash.remove(&leaving);
        } else {
            self.stash.insert(leaving, StashedDraft { text, attachments });
        }
        let shown = self.stash.remove(&key).unwrap_or_default();
        let end = shown.text.len();
        self.draft.update(cx, |draft, cx| {
            draft.set_value(shown.text, window, cx);
            draft.set_selected_range(end..end, cx);
        });
        self.attachments = shown.attachments;
        self.error = None;
    }

    /// Takes a message the Host accepted out of the draft it was sent
    /// from, `key`'s, unless that draft was edited meanwhile; files added
    /// meanwhile stay for the next message.
    fn clear_sent(
        &mut self,
        key: &Option<SharedString>,
        text: &str,
        files: &[PickedFile],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if &self.draft_key == key {
            if self.draft.read(cx).value().trim_end() == text {
                self.draft.update(cx, |draft, cx| draft.set_value("", window, cx));
            }
            self.attachments.retain(|file| !files.contains(file));
            return;
        }
        if let Some(stashed) = self.stash.get_mut(key) {
            if stashed.text.trim_end() == text {
                stashed.text.clear();
            }
            stashed.attachments.retain(|file| !files.contains(file));
            if stashed.text.is_empty() && stashed.attachments.is_empty() {
                self.stash.remove(key);
            }
        }
    }

    /// What the draft shows while empty.
    pub fn placeholder(&self) -> &'static str {
        self.placeholder
    }

    /// Whether the Host is there to send to.
    fn connected(&self, cx: &App) -> bool {
        self.state.read(cx).host().read(cx).is_connected()
    }

    /// Sets the draft's placeholder for the current language and turn:
    /// while a message would wait for the running turn it says so, and
    /// without a Host it says why nothing can be sent, on the one line the
    /// dock already has (Desktop keeps its controls row offline).
    fn sync_placeholder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let placeholder = if !self.connected(cx) {
            copy::COMPOSER_OFFLINE.get(cx)
        } else if self.state.read(cx).turn_activity().queues() {
            copy::COMPOSER_PLACEHOLDER_QUEUE.get(cx)
        } else {
            copy::COMPOSER_PLACEHOLDER.get(cx)
        };
        if placeholder != self.placeholder {
            self.placeholder = placeholder;
            self.draft.update(cx, |draft, cx| draft.set_placeholder(placeholder, window, cx));
        }
    }

    /// The draft's state.
    pub fn draft(&self) -> &Entity<TextareaState> {
        &self.draft
    }

    /// The queued messages shown above the card.
    pub fn queue_plate(&self) -> &Entity<QueuePlate> {
        &self.queue
    }

    /// The files picked, pasted, or dropped for the next message.
    pub fn attachments(&self) -> &[PickedFile] {
        &self.attachments
    }

    /// Asks for files with the platform dialog and adds them to the next
    /// message ([`Self::add_files`]).
    pub fn attach(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some(copy::ATTACH_BUTTON.get(cx).into()),
        });
        self._pick = Some(cx.spawn(async move |this, cx| {
            let paths = match paths.await {
                Ok(Ok(Some(paths))) => paths,
                Ok(Err(error)) => {
                    log::warn!("the file dialog failed: {error:#}");
                    return;
                }
                _ => return,
            };
            this.update(cx, |this, cx| this.add_files(paths, cx)).ok();
        }));
    }

    /// Adds the files at `paths` to the next message once their size and
    /// first bytes are read (on a background thread). A file already
    /// attached is skipped; a folder, one over the size limit, one that
    /// cannot be read, and any past the eighth are refused with the reason
    /// in the card. The "+" dialog, a paste, and a drop all end here.
    pub fn add_files(&mut self, paths: Vec<std::path::PathBuf>, cx: &mut Context<Self>) {
        let inspected = cx.background_spawn(async move { attachments::inspect(paths) });
        self.add_inspected(inspected, cx);
    }

    /// What Cmd+V (or the draft's Paste menu item) hands the draft, as in
    /// Maka Desktop: files on the clipboard (copied in Finder) are attached
    /// as the "+" dialog attaches them, and otherwise an image (a
    /// screenshot) is attached as `clipboard-image.png`; either way nothing
    /// is typed. Returns false for anything else, so the draft pastes the
    /// text itself.
    fn paste(&mut self, item: &ClipboardItem, cx: &mut Context<Self>) -> bool {
        let entries = item.entries();
        let paths: Vec<std::path::PathBuf> = entries
            .iter()
            .filter_map(|entry| match entry {
                ClipboardEntry::ExternalPaths(paths) => Some(paths.paths()),
                _ => None,
            })
            .flatten()
            .cloned()
            .collect();
        if !paths.is_empty() {
            self.add_files(paths, cx);
            return true;
        }
        let images: Vec<_> = entries
            .iter()
            .filter_map(|entry| match entry {
                ClipboardEntry::Image(image) => Some(attachments::pasted_image(image)),
                _ => None,
            })
            .collect();
        if images.is_empty() {
            return false;
        }
        self.add_inspected(Task::ready(images), cx);
        true
    }

    /// Adds the files of a drop on the dock, as [`Self::add_files`] does.
    fn on_drop(&mut self, paths: &ExternalPaths, _: &mut Window, cx: &mut Context<Self>) {
        self.add_files(paths.paths().to_vec(), cx);
    }

    /// Adds the checked files once `inspected` has them, after any batch
    /// still being checked, within the limits [`Self::add_files`] names.
    fn add_inspected(
        &mut self,
        inspected: Task<Vec<Result<PickedFile, PickRefusal>>>,
        cx: &mut Context<Self>,
    ) {
        let previous = self._inspect.take();
        self._inspect = Some(cx.spawn(async move |this, cx| {
            if let Some(previous) = previous {
                previous.await;
            }
            let inspected = inspected.await;
            this.update(cx, |this, cx| {
                for result in inspected {
                    match result {
                        Ok(file) if this.is_attached(&file.source) => {}
                        Ok(_) if this.attachments.len() >= MAX_ATTACHMENT_COUNT => {
                            this.error = Some(copy::ATTACH_TOO_MANY.get(cx).into());
                        }
                        Ok(file) => this.attachments.push(file),
                        Err(PickRefusal::TooLarge(name)) => {
                            this.error =
                                Some(copy::attach_too_large(Locale::current(cx), &name).into());
                        }
                        Err(PickRefusal::Unreadable(name)) => {
                            this.error =
                                Some(copy::attach_unreadable(Locale::current(cx), &name).into());
                        }
                        Err(PickRefusal::Folder) => {
                            this.error = Some(copy::ATTACH_FOLDER.get(cx).into());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Whether the file from `source` is on the next message already.
    fn is_attached(&self, source: &AttachmentSource) -> bool {
        self.attachments.iter().any(|file| file.source == *source)
    }

    /// Takes the file from `source` off the next message.
    pub fn remove_attachment(&mut self, source: &AttachmentSource, cx: &mut Context<Self>) {
        self.attachments.retain(|file| file.source != *source);
        cx.notify();
    }

    /// Whether the model and permission mode pickers are on screen and can
    /// be used: the session's settings have been read, or the new task's
    /// draft shows on a live Host.
    pub fn shows_settings(&self, cx: &App) -> bool {
        let state = self.state.read(cx);
        state.settings().is_some() || (state.session_id().is_none() && self.connected(cx))
    }

    /// The last failure the card shows, if any.
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    /// Moves keyboard focus into the draft.
    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.draft.update(cx, |draft, cx| draft.focus(window, cx));
    }

    /// Replaces the draft with `text`, puts the caret at its end, and moves
    /// focus there; nothing is sent.
    pub fn fill(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.error = None;
        self.draft.update(cx, |draft, cx| {
            draft.set_value(text.to_owned(), window, cx);
            let last_line = text.split('\n').count().saturating_sub(1);
            let end = Position::new(u32::try_from(last_line).unwrap_or(u32::MAX), u32::MAX);
            // Moves the caret and focuses the draft.
            draft.set_cursor_position(end, window, cx);
        });
        cx.notify();
    }

    /// What the round button does now.
    pub fn action(&self, cx: &gpui_kit::App) -> ComposerAction {
        let activity = self.state.read(cx).turn_activity();
        let empty = self.draft_is_empty(cx);
        match activity {
            TurnActivity::Running if empty => {
                ComposerAction::Stop { enabled: !self.stopping, busy: self.stopping }
            }
            TurnActivity::Stopping if empty => ComposerAction::Stop { enabled: false, busy: true },
            TurnActivity::Starting if empty => {
                ComposerAction::Send { enabled: false, busy: true, queues: false }
            }
            _ => ComposerAction::Send {
                enabled: self.is_sendable(cx),
                busy: self.sending,
                // The first message of an idle session is still on its way;
                // nothing runs yet for another one to wait for.
                queues: activity.queues()
                    && !(activity == TurnActivity::Starting && self.state.read(cx).is_submitting()),
            },
        }
    }

    /// Nothing to send: no text, no attachment, and (in a side chat) no
    /// staged quote, which a message may carry alone.
    fn draft_is_empty(&self, cx: &App) -> bool {
        let quoted = self.side.as_ref().is_some_and(|side| !side.read(cx).quotes().is_empty());
        !quoted && self.attachments.is_empty() && self.draft.read(cx).value().trim().is_empty()
    }

    fn selected_session(&self, cx: &gpui_kit::App) -> Option<SharedString> {
        self.state.read(cx).session_id().cloned()
    }

    fn turn_activity(&self, cx: &gpui_kit::App) -> TurnActivity {
        self.state.read(cx).turn_activity()
    }

    /// Sending needs a connection, text, and a loaded session, or the new
    /// task's draft (the send creates the task). One send at a time.
    fn is_sendable(&self, cx: &gpui_kit::App) -> bool {
        let state = self.state.read(cx);
        if self.sending || !state.host().read(cx).is_connected() || self.draft_is_empty(cx) {
            return false;
        }
        if let Some(side) = &self.side {
            let side = side.read(cx);
            if side.is_creating() || side.is_disposed() {
                return false;
            }
        }
        match state.session_id() {
            Some(_) => !state.is_submitting() && state.turn_activity().is_sendable(),
            None => !state.is_starting(),
        }
    }

    fn is_stoppable(&self, cx: &gpui_kit::App) -> bool {
        !self.stopping && self.turn_activity(cx).is_stoppable()
    }

    /// Sends the draft to the selected session: it starts a turn, or, while
    /// one runs, waits after it. The draft is cleared once the Host accepts
    /// the message, unless it was edited meanwhile; on a refusal it stays
    /// and the reason shows below it.
    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit(MessagePlacement::NextTurn, window, cx);
    }

    /// Sends the draft into the running turn as steering, applied at its
    /// next step; with no turn running it starts one, as [`Self::send`] does.
    pub fn steer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit(MessagePlacement::CurrentTurn, window, cx);
    }

    fn submit(&mut self, placement: MessagePlacement, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_sendable(cx) {
            return;
        }
        let text = self.draft.read(cx).value().trim_end().to_owned();
        let files = self.attachments.clone();
        let accepted = match self.selected_session(cx) {
            _ if self.side.is_some() => {
                let list = self.connections.read(cx).list().cloned();
                let (text, files) = (text.clone(), files.clone());
                let side = self.side.clone().expect("a side chat");
                side.update(cx, |side, cx| side.send(text, files, placement, list.as_ref(), cx))
            }
            Some(session_id) if files.is_empty() => {
                let content = MessageContent::text(text.clone());
                self.state
                    .update(cx, |state, cx| state.send_message(&session_id, content, placement, cx))
            }
            Some(session_id) => {
                let (text, files) = (text.clone(), files.clone());
                self.state.update(cx, |state, cx| {
                    state.send_with_attachments(&session_id, text, files, placement, cx)
                })
            }
            None => {
                let Some(input) = self.new_session_input(cx) else {
                    // No project to start the task in: ask for a folder, as
                    // New task did before the draft, and send once it is
                    // chosen.
                    self.add_project(true, window, cx);
                    return;
                };
                let (text, files) = (text.clone(), files.clone());
                self.state.update(cx, |state, cx| state.start_session(input, text, files, cx))
            }
        };
        // The draft the message leaves from; the task on screen may change
        // before the Host answers (a new task's first message selects it).
        let key = self.draft_key.clone();
        self.sending = true;
        self.error = None;
        self._send = Some(cx.spawn_in(window, async move |this, cx| {
            let result = accepted.await;
            this.update_in(cx, |this, window, cx| {
                this.sending = false;
                match result {
                    Ok(_) => {
                        this.clear_sent(&key, &text, &files, window, cx);
                        // A mode picked for one new task is not a default
                        // for the next (Desktop's
                        // `clearNewChatPermissionChoice`).
                        if key.is_none() {
                            this.draft_mode = None;
                        }
                    }
                    // Said where the draft it came from shows; a draft left
                    // behind keeps its text to send again.
                    Err(message) if this.draft_key == key => this.error = Some(message),
                    Err(_) => {}
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// New project…: asks for a folder and makes it the new task's project
    /// ([`ProjectSelection::add_project`]); a refusal shows in the card.
    /// With `then_send`, the draft is sent once the folder is chosen.
    pub fn add_project(&mut self, then_send: bool, window: &mut Window, cx: &mut Context<Self>) {
        let added = self.projects.update(cx, |projects, cx| projects.add_project(cx));
        self.error = None;
        self._project = Some(cx.spawn_in(window, async move |this, cx| {
            let added = added.await;
            this.update_in(cx, |this, window, cx| match added {
                Ok(true) => {
                    let still_draft = this.selected_session(cx).is_none();
                    if then_send && still_draft && this.projects.read(cx).target().is_some() {
                        this.send(window, cx);
                    }
                }
                Ok(false) => {}
                Err(reason) => {
                    this.error = Some(reason);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// What `session.create` needs for the new task: a fresh id, where it
    /// runs (the chosen project), and what it runs with (the draft's
    /// model and permission mode). `None` with no project to run in.
    fn new_session_input(&self, cx: &App) -> Option<SessionCreateInput> {
        let target = self.projects.read(cx).target()?;
        let model = match self.draft_offered_model(cx) {
            Some(model) => SessionModelTarget::Explicit {
                connection_id: model.connection_id.to_string(),
                connection_slug: model.connection_slug.to_string(),
                model: model.model.to_string(),
            },
            None => SessionModelTarget::Default,
        };
        let mut input = SessionCreateInput::new(new_session_id(), target.workspace(), model);
        input.permission_mode = self.draft_mode.clone().or_else(|| self.default_mode.clone());
        // Untouched, the level is left out and the model's preference
        // applies; Model default asks for the provider's (`null`).
        let offered = self.thinking_choice(cx).map(|choice| choice.levels).unwrap_or_default();
        input.thinking_level = match &self.draft_thinking {
            Some(Some(level)) if offered.contains(level) => Nullable::Value(level.clone()),
            Some(None) => Nullable::Null,
            _ => Nullable::Absent,
        };
        Some(input)
    }

    /// What the thinking level picker offers and shows: the session's
    /// level among its model's levels on its connection, or the new task's
    /// among the draft model's (untouched, the model's own default). `None`
    /// when the model offers no level, or the catalog lists no connection
    /// the session runs on ([`SessionSettings::connection_in`]).
    fn thinking_choice(&self, cx: &App) -> Option<ThinkingChoice> {
        let state = self.state.read(cx);
        let list = self.connections.read(cx).list()?;
        let (levels, current) = match state.settings() {
            Some(settings) => {
                let connection = settings.connection_in(list)?;
                let levels = connection.thinking_levels(&settings.model).to_vec();
                (levels, settings.thinking_level.clone())
            }
            None if state.session_id().is_some() => return None,
            None => {
                let offered = self.draft_offered_model(cx)?;
                let connection = list.connection(&offered.connection_id)?;
                let levels = connection.thinking_levels(&offered.model).to_vec();
                let current = match &self.draft_thinking {
                    Some(choice) => choice.clone(),
                    None => connection.default_thinking_level(&offered.model).cloned(),
                };
                (levels, current)
            }
        };
        if levels.is_empty() {
            return None;
        }
        // A level the model no longer offers reads as its default.
        let current = current.filter(|level| levels.contains(level));
        Some(ThinkingChoice { levels, current })
    }

    /// Whether the thinking level picker is in the controls row.
    pub fn shows_thinking_level(&self, cx: &App) -> bool {
        self.thinking_choice(cx).is_some()
    }

    /// The thinking level the picker shows, once it is shown (`Some(None)`:
    /// Model default).
    pub fn thinking_level(&self, cx: &App) -> Option<Option<ThinkingLevel>> {
        self.thinking_choice(cx).map(|choice| choice.current)
    }

    /// Asks for `level` (`None`: Model default): for the new task, when it
    /// is created; for the session, with `session.configuration.update`,
    /// its model target and the level together, as Desktop's
    /// `setModelConfiguration` does. The target names the catalog's
    /// connection the session runs on ([`SessionSettings::connection_in`]),
    /// as a choice in the model picker does: a task moved over from Maka
    /// Desktop names a connection id this Host does not know, which it
    /// would refuse. Nothing happens for the level in use, while a turn
    /// runs, while another settings change is in flight, or for a session
    /// on no connection the catalog lists.
    pub fn select_thinking_level(&mut self, level: Option<ThinkingLevel>, cx: &mut Context<Self>) {
        if self.selected_session(cx).is_none() {
            self.draft_thinking = Some(level);
            cx.notify();
            return;
        }
        if self.configuring.is_some() || !self.model_switchable(cx) {
            return;
        }
        if self.thinking_choice(cx).is_none_or(|choice| choice.current == level) {
            return;
        }
        let Some(settings) = self.state.read(cx).settings() else {
            return;
        };
        let catalog = self.connections.read(cx);
        let Some(connection) = catalog.list().and_then(|list| settings.connection_in(list)) else {
            return;
        };
        let mut patch = SessionConfigurationPatch::model(
            connection.id.as_ref(),
            connection.slug.as_ref(),
            settings.model.as_ref(),
        );
        patch.thinking_level = match level {
            Some(level) => Nullable::Value(level),
            None => Nullable::Null,
        };
        self.configure(Setting::ThinkingLevel, patch, copy::THINKING_LEVEL_FAILED.get(cx), cx);
    }

    /// The model the new task runs on: the one the person picked while a
    /// picker offers it, else the catalog's default
    /// ([`ConnectionList::default_model`]). `None` until the catalog lists
    /// a model; the Host then applies its default.
    fn draft_offered_model(&self, cx: &App) -> Option<OfferedModel> {
        let list = self.connections.read(cx).list()?;
        let picked = self.draft_model.as_ref().and_then(|picked| {
            let connection = list.enabled().find(|c| c.id == picked.connection_id)?;
            let model = connection.models.iter().find(|m| m.id == picked.model)?;
            Some((connection, model))
        });
        let (connection, model) = picked.or_else(|| list.default_model())?;
        Some(OfferedModel {
            connection_id: connection.id.clone(),
            connection_slug: connection.slug.clone(),
            model: model.id.clone(),
            label: model.label.clone(),
        })
    }

    /// The permission mode the new task starts in: the person's pick, else
    /// the Host's default, else Auto until that is read.
    fn draft_permission_mode(&self) -> PermissionMode {
        self.draft_mode.clone().or_else(|| self.default_mode.clone()).unwrap_or(PermissionMode::Ask)
    }

    /// The Enter the textarea passed up in submit mode: Enter sends,
    /// Cmd+Enter steers the running turn.
    fn on_enter(&mut self, action: &Enter, window: &mut Window, cx: &mut Context<Self>) {
        if action.shift {
            return;
        }
        if action.secondary && self.turn_activity(cx).queues() {
            self.steer(window, cx);
        } else {
            self.send(window, cx);
        }
    }

    /// The models the model picker offers, in its order, with the one the
    /// session runs marked; empty until the session's settings and the
    /// catalog are read. The command palette lists the same choices.
    pub fn model_choices(&self, cx: &App) -> Vec<ModelChoice> {
        let Some(menu) = self.model_menu(cx) else {
            return Vec::new();
        };
        menu.groups
            .into_iter()
            .flat_map(|group| {
                let (connection_id, connection) = (group.connection_id, group.name);
                group.models.into_iter().map(move |(model, current)| ModelChoice {
                    connection_id: connection_id.clone(),
                    connection: connection.clone(),
                    model_id: model.id.clone(),
                    label: model.label.clone(),
                    current,
                })
            })
            .collect()
    }

    /// The model menu for the session on screen, once its settings are
    /// read, or for the new task's draft.
    fn model_menu(&self, cx: &App) -> Option<ModelMenu> {
        let catalog = self.connections.read(cx);
        let state = self.state.read(cx);
        if let Some(settings) = state.settings() {
            let list = catalog.list();
            let current = |id: &str, model: &str| list.is_some_and(|l| settings.runs(l, id, model));
            return Some(ModelMenu::new(&current, list, catalog.status()));
        }
        if state.session_id().is_some() {
            return None;
        }
        let offered = self.draft_offered_model(cx);
        let current = |id: &str, model: &str| {
            offered
                .as_ref()
                .is_some_and(|offered| offered.connection_id == id && offered.model == model)
        };
        Some(ModelMenu::new(&current, catalog.list(), catalog.status()))
    }

    /// The session's permission mode, once its settings are read, or the
    /// one the new task's draft starts in.
    pub fn permission_mode(&self, cx: &App) -> Option<PermissionMode> {
        let state = self.state.read(cx);
        match state.settings() {
            Some(settings) => Some(settings.permission_mode.clone()),
            None if state.session_id().is_none() => Some(self.draft_permission_mode()),
            None => None,
        }
    }

    /// Whether the model may be switched now. The Host refuses while a turn
    /// of the session is active (`session_busy`), so the picker waits.
    pub fn model_switchable(&self, cx: &App) -> bool {
        matches!(self.turn_activity(cx), TurnActivity::Idle | TurnActivity::Unavailable)
    }

    /// Switches the session to `model` on the connection `connection_id`.
    /// Nothing happens for the model the session already runs, while a turn
    /// runs, or while another settings change is in flight.
    pub fn select_model(&mut self, connection_id: &str, model: &str, cx: &mut Context<Self>) {
        if self.selected_session(cx).is_none() {
            // The new task's: nothing to ask the Host until it is created.
            self.draft_model = Some(DraftModel {
                connection_id: connection_id.to_owned().into(),
                model: model.to_owned().into(),
            });
            // Another model starts from its own default level (Desktop's
            // `setPendingNewChatModel`).
            self.draft_thinking = None;
            cx.notify();
            return;
        }
        if self.configuring.is_some() || !self.model_switchable(cx) {
            return;
        }
        let Some(settings) = self.state.read(cx).settings() else {
            return;
        };
        let Some(list) = self.connections.read(cx).list() else {
            return;
        };
        let Some(connection) = list.connection(connection_id) else {
            return;
        };
        if settings.runs(list, connection_id, model) {
            return;
        }
        // The level goes back to the model's default with the switch, as
        // Desktop's `modelConfigurationIntentForModel` sends it, so a level
        // the new model does not offer never stays.
        let mut patch =
            SessionConfigurationPatch::model(connection_id, connection.slug.as_ref(), model);
        patch.thinking_level = Nullable::Null;
        self.configure(Setting::Model, patch, copy::MODEL_SWITCH_FAILED.get(cx), cx);
    }

    /// Switches the session to the permission mode `mode`. Nothing happens
    /// for the session's own mode or while another settings change is in
    /// flight. No confirmation: a mode is switched back just as easily.
    pub fn select_permission_mode(&mut self, mode: PermissionMode, cx: &mut Context<Self>) {
        if let Some(side) = self.side.clone()
            && self.selected_session(cx).is_none()
        {
            // The mode the fork starts with, set on it before its first
            // message runs.
            side.update(cx, |side, cx| side.stage_permission_mode(mode, cx));
            cx.notify();
            return;
        }
        if self.selected_session(cx).is_none() {
            // The new task's, sent when it is created.
            self.draft_mode = Some(mode);
            cx.notify();
            return;
        }
        if self.configuring.is_some() {
            return;
        }
        let Some(settings) = self.state.read(cx).settings() else {
            return;
        };
        if settings.permission_mode == mode {
            return;
        }
        let patch = SessionConfigurationPatch::permission_mode(mode);
        self.configure(Setting::PermissionMode, patch, copy::PERMISSION_MODE_FAILED.get(cx), cx);
    }

    /// Sends one settings change and shows its outcome.
    fn configure(
        &mut self,
        setting: Setting,
        patch: SessionConfigurationPatch,
        what: &'static str,
        cx: &mut Context<Self>,
    ) {
        let changed = self.state.update(cx, |state, cx| state.configure_session(patch, what, cx));
        self.configuring = Some(setting);
        self.error = None;
        self._configure = Some(cx.spawn(async move |this, cx| {
            let result = changed.await;
            this.update(cx, |this, cx| {
                this.configuring = None;
                if let Err(message) = result {
                    this.error = Some(message);
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Stops the selected session's running turn.
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if !self.is_stoppable(cx) {
            return;
        }
        let Some(session_id) = self.selected_session(cx) else {
            return;
        };
        let stopped = self.state.update(cx, |state, cx| state.stop_turn(&session_id, cx));
        self.stopping = true;
        self.error = None;
        self._stop = Some(cx.spawn(async move |this, cx| {
            let result = stopped.await;
            this.update(cx, |this, cx| {
                this.stopping = false;
                if let Err(message) = result {
                    this.error = Some(message);
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }
}

impl Composer {
    /// The round primary button, 32 px, in its three looks (spec §8): with
    /// nothing to send it is quiet (the `wash`, ink at 6%, and a muted
    /// arrow, in both themes) and inert;
    /// with a draft it is the one solid colour on screen (primary fill,
    /// arrow in on-primary); while a turn runs with an empty draft it is Stop
    /// (ink fill, a square in the plate colour). Its id names the command, so
    /// a test (or a person reading the element tree) always knows which one
    /// is on screen. While its request is in flight it keeps its look, shows
    /// progress, and takes no click.
    fn render_action_button(&self, window: &Window, cx: &mut Context<Self>) -> Button {
        let maka = cx.maka();
        let glyph = |icon: MakaIcon, color: Hsla, busy: bool| -> AnyElement {
            if busy {
                Spinner::new()
                    .icon(MakaIcon::StatusRunning)
                    .color(color)
                    .with_size(dp_px(16., window))
                    .into_any_element()
            } else {
                Icon::new(icon).with_size(dp_px(16., window)).text_color(color).into_any_element()
            }
        };
        let round = |button: Button| button.size(dp(32.)).p_0().rounded(dp_px(16., window));
        match self.action(cx) {
            ComposerAction::Send { enabled, busy, queues } => {
                let label = if queues { copy::SEND_QUEUED.get(cx) } else { copy::SEND.get(cx) };
                let ready = enabled || busy;
                let (button, color) = if ready {
                    (Button::new("send-message").primary(), maka.on_primary)
                } else {
                    // Disabled, so it takes no hover; the instance colours
                    // outlast the disabled state's.
                    let quiet = Button::new("send-message").ghost();
                    (quiet.bg(maka.wash).text_color(maka.ink_muted), maka.ink_muted)
                };
                round(button)
                    .child(glyph(MakaIcon::Send, color, busy))
                    .accessibility_label(label)
                    .loading(busy)
                    .disabled(!ready)
                    .tooltip_with_action(label, &SendMessage, None)
                    .on_click(cx.listener(|this, _, window, cx| this.send(window, cx)))
            }
            ComposerAction::Stop { enabled, busy } => {
                // The kit has no ink-filled variant: the disc is drawn inside
                // a ghost button, which keeps the button's focus ring and
                // keyboard behaviour, and darkens on the button's hover.
                const GROUP: &str = "composer-stop";
                let ink = maka.ink;
                round(Button::new("stop-turn").ghost())
                    .group(GROUP)
                    .child(
                        h_flex()
                            .size_full()
                            .justify_center()
                            .rounded(dp(16.))
                            .bg(ink)
                            .group_hover(GROUP, |style| style.bg(ink.opacity(0.84)))
                            .child(glyph(MakaIcon::Stop, maka.plate, busy)),
                    )
                    .accessibility_label(copy::STOP.get(cx))
                    .loading(busy)
                    .disabled(!enabled && !busy)
                    .tooltip_with_action(copy::STOP.get(cx), &StopTurn, None)
                    .on_click(cx.listener(|this, _, _, cx| this.stop(cx)))
            }
        }
    }

    /// "+", a 28 px round ghost button that opens the platform file dialog.
    /// Always in the row, as Desktop's is; disabled offline and while a
    /// message is being sent. In the new task's draft the files wait for
    /// the task, and are uploaded into it with its first message.
    fn render_attach_button(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let disabled = self.sending || !self.connected(cx);
        // The glyph sets its own ink, so the disabled fade is its own too.
        let (_, ink) = chip_inks(&cx.maka(), disabled);
        Button::new("composer-attach")
            .ghost()
            .size(dp(28.))
            .p_0()
            .rounded(dp_px(14., window))
            .child(Icon::new(MakaIcon::Plus).with_size(dp_px(16., window)).text_color(ink))
            .accessibility_label(copy::ATTACH.get(cx))
            .tooltip(copy::ATTACH.get(cx))
            .disabled(disabled)
            .on_click(cx.listener(|this, _, _, cx| this.attach(cx)))
            .into_any_element()
    }

    /// The attached files as chips between the draft and the controls (spec
    /// §8): 28 px, radius 10, sunken fill, the name, the size, and a remove
    /// button, the same for a pasted image as for a picked file. While the
    /// message is being sent the remove button gives way to progress, and
    /// nothing can be removed.
    fn render_attachments(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.attachments.is_empty() {
            return None;
        }
        let maka = cx.maka();
        let uploading = self.sending;
        let chips: Vec<AnyElement> = self
            .attachments
            .iter()
            .map(|file| {
                let source = file.source.clone();
                let id = shared::domain_element_id("composer-attachment", &file.source.key());
                let locale = Locale::current(cx);
                let end = if uploading {
                    Spinner::new()
                        .icon(MakaIcon::StatusRunning)
                        .color(maka.ink_muted)
                        .with_size(dp_px(12., window))
                        .into_any_element()
                } else {
                    Button::new("attachment-remove")
                        .ghost()
                        .size(dp(20.))
                        .p_0()
                        .rounded(dp_px(RADIUS_CONTROL, window))
                        .child(
                            Icon::new(MakaIcon::Close)
                                .with_size(dp_px(12., window))
                                .text_color(maka.ink_muted),
                        )
                        .accessibility_label(copy::remove_attachment(locale, &file.name))
                        .tooltip(copy::remove_attachment(locale, &file.name))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.remove_attachment(&source, cx)),
                        )
                        .into_any_element()
                };
                let icon = attachment_kind_icon(&file.kind, window, cx);
                attachment_chip(id, file.name.clone(), file.bytes, Some(icon), Some(end), cx)
            })
            .collect();
        Some(
            h_flex()
                .id("composer-attachments")
                .test_support()
                .flex_wrap()
                .gap(dp(6.))
                .children(chips)
                .into_any_element(),
        )
    }

    /// The session's model and permission mode as quiet chips. With a
    /// task on a live Host nothing shows until its settings are read. In
    /// the new task's draft they choose what the task starts with: the
    /// catalog's default model unless one is picked (the model last shown,
    /// else "Model", until the catalog is read), and the Host's default
    /// mode unless one is picked. Offline, Desktop's composer keeps both
    /// pickers, disabled.
    fn render_settings(&mut self, window: &Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if self.side.is_some() {
            return self.render_side_settings(window, cx);
        }
        if let Some(settings) = self.state.read(cx).settings().cloned() {
            // The connection it runs on, found once rather than per model.
            let list = self.connections.read(cx).list();
            let on = list.and_then(|list| settings.connection_in(list)).map(|c| c.id.clone());
            let current = |id: &str, model: &str| {
                on.as_deref() == Some(id) && settings.model.as_ref() == model
            };
            let switchable = self.model_switchable(cx);
            let fallback = Some(settings.model.clone());
            let (label, model) =
                self.render_model_picker(&current, fallback, switchable, window, cx);
            self.last_model = label;
            let mut controls = vec![model];
            controls.extend(self.render_thinking_picker(switchable, window, cx));
            let mode = settings.permission_mode.clone();
            controls.push(self.render_permission_mode_picker(mode, window, cx));
            return controls;
        }
        let locale = Locale::current(cx);
        if self.selected_session(cx).is_some() {
            if self.connected(cx) {
                return Vec::new();
            }
            // Offline before the task's settings were read.
            let label = self.last_model.clone().unwrap_or_else(|| copy::MODEL.get(cx).into());
            let model = chip("composer-model", label.clone(), true, window, cx)
                .accessibility_label(shell_copy::labeled(locale, copy::MODEL.get(cx), &label))
                .tooltip(copy::MODEL.get(cx));
            let mode = permission_mode_label(&PermissionMode::Ask, locale);
            let permission = chip("composer-permission-mode", mode.clone(), true, window, cx)
                .accessibility_label(shell_copy::labeled(
                    locale,
                    copy::PERMISSION_MODE.get(cx),
                    &mode,
                ))
                .tooltip(copy::PERMISSION_MODE.get(cx));
            return vec![model.into_any_element(), permission.into_any_element()];
        }
        // The new task's draft.
        let offered = self.draft_offered_model(cx);
        let fallback = offered
            .as_ref()
            .map(|offered| offered.label.clone())
            .or_else(|| self.last_model.clone());
        let current = |id: &str, model: &str| {
            offered
                .as_ref()
                .is_some_and(|offered| offered.connection_id == id && offered.model == model)
        };
        let (_, model) = self.render_model_picker(&current, fallback, true, window, cx);
        let mut controls = vec![model];
        controls.extend(self.render_thinking_picker(true, window, cx));
        let mode = self.draft_permission_mode();
        controls.push(self.render_permission_mode_picker(mode, window, cx));
        controls
    }

    /// A side chat's controls: the model as a read-only chip (the fork
    /// runs its task's model and does not switch it, as in Desktop), then
    /// the permission mode picker. Nothing until the settings are read.
    fn render_side_settings(&mut self, window: &Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let Some(side) = self.side.clone() else { return Vec::new() };
        let side = side.read(cx);
        let Some(settings) = side.settings(cx).cloned() else { return Vec::new() };
        let mode = side.permission_mode(cx).unwrap_or(PermissionMode::Ask);
        let locale = Locale::current(cx);
        let catalog = self.connections.read(cx);
        let list = catalog.list();
        let on = list.and_then(|list| settings.connection_in(list)).map(|c| c.id.clone());
        let current =
            |id: &str, model: &str| on.as_deref() == Some(id) && settings.model.as_ref() == model;
        let label = ModelMenu::new(&current, list, catalog.status())
            .current_label()
            .unwrap_or_else(|| settings.model.clone());
        // The model's name gives way first at the panel's width (Desktop
        // caps the side chat's model chip): it shrinks and ends in an
        // ellipsis, so the mode and the round button keep their place.
        let (ink, _) = chip_inks(&cx.maka(), true);
        let model = Button::new("composer-model")
            .ghost()
            .h(dp(28.))
            .px(dp(8.))
            .min_w_0()
            .flex_shrink(1.)
            .rounded(dp_px(RADIUS_SURFACE, window))
            .disabled(true)
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(dp(LABEL_SIZE))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(ink)
                    .child(label.clone()),
            )
            .accessibility_label(shell_copy::labeled(locale, copy::MODEL.get(cx), &label))
            .tooltip(shared::copy::side_chat::MODEL_INHERITED.get(cx));
        let mode = self.render_permission_mode_picker(mode, window, cx);
        vec![model.into_any_element(), div().flex_none().child(mode).into_any_element()]
    }

    /// The quotes staged in a side chat for its next message, as chips
    /// above the files: each with its remove button.
    fn render_quotes(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let side = self.side.clone()?;
        let quotes = side.read(cx).quotes().to_vec();
        if quotes.is_empty() {
            return None;
        }
        let chips = quotes.into_iter().map(|staged| {
            let id = staged.id;
            let chat = side.downgrade();
            let label = staged.quote.label.clone().map(SharedString::from);
            let text: SharedString =
                staged.quote.text.split_whitespace().collect::<Vec<_>>().join(" ").into();
            crate::quotes::staged_quote_chip(
                shared::domain_element_id("staged-quote", &id.to_string()),
                label.as_ref(),
                &text,
                move |_, cx| {
                    chat.update(cx, |chat, cx| chat.remove_quote(id, cx)).ok();
                },
                window,
                cx,
            )
        });
        Some(
            v_flex()
                .id("composer-quotes")
                .test_support()
                .w_full()
                .gap(dp(6.))
                .children(chips)
                .into_any_element(),
        )
    }

    /// The thinking level picker (Desktop's `ThinkingLevelSelector`) right
    /// after the model picker: a chip naming the level in use (Model
    /// default when none), opening Model default and the model's levels,
    /// the one in use checked. Not there for a model without levels; while
    /// a turn runs (not `switchable`) a disabled chip whose tooltip says
    /// why.
    fn render_thinking_picker(
        &self,
        switchable: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let ThinkingChoice { levels, current } = self.thinking_choice(cx)?;
        let locale = Locale::current(cx);
        let label = thinking_level_label(current.as_ref(), locale);
        let connected = self.connected(cx);
        let button =
            chip("composer-thinking-level", label.clone(), !switchable || !connected, window, cx)
                .accessibility_label(shell_copy::labeled(
                    locale,
                    copy::THINKING_LEVEL.get(cx),
                    &label,
                ))
                .loading(self.configuring == Some(Setting::ThinkingLevel));
        if !switchable {
            return Some(button.tooltip(copy::THINKING_LEVEL_BUSY.get(cx)).into_any_element());
        }
        if !connected {
            return Some(button.tooltip(copy::THINKING_LEVEL.get(cx)).into_any_element());
        }
        let composer = cx.entity().downgrade();
        let button = button.tooltip(copy::THINKING_LEVEL.get(cx)).dropdown_menu_with_anchor(
            Anchor::BottomLeft,
            move |mut menu, _, cx| {
                let locale = Locale::current(cx);
                let options = std::iter::once(None).chain(levels.iter().cloned().map(Some));
                for option in options {
                    let checked = option == current;
                    let label = thinking_level_label(option.as_ref(), locale);
                    let composer = composer.clone();
                    menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                        move |_, _, cx| {
                            composer
                                .update(cx, |composer, cx| {
                                    composer.select_thinking_level(option.clone(), cx)
                                })
                                .ok();
                        },
                    ));
                }
                menu
            },
        );
        Some(button.into_any_element())
    }

    /// The permission mode picker: `current`, opening a menu of the three
    /// modes with their descriptions.
    fn render_permission_mode_picker(
        &self,
        current: PermissionMode,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mode = permission_mode_label(&current, Locale::current(cx));
        let composer = cx.entity().downgrade();
        chip("composer-permission-mode", mode.clone(), !self.connected(cx), window, cx)
            .accessibility_label(shell_copy::labeled(
                Locale::current(cx),
                copy::PERMISSION_MODE.get(cx),
                &mode,
            ))
            .tooltip(copy::PERMISSION_MODE.get(cx))
            .loading(self.configuring == Some(Setting::PermissionMode))
            .dropdown_menu_with_anchor(Anchor::BottomLeft, move |mut menu, _, _| {
                for mode in PERMISSION_MODES {
                    let checked = current == mode;
                    let composer = composer.clone();
                    let choice = mode.clone();
                    menu = menu.item(
                        PopupMenuItem::element(move |_, cx| permission_mode_item(&mode, cx))
                            .checked(checked)
                            .on_click(move |_, _, cx| {
                                composer
                                    .update(cx, |composer, cx| {
                                        composer.select_permission_mode(choice.clone(), cx)
                                    })
                                    .ok();
                            }),
                    );
                }
                menu
            })
            .into_any_element()
    }

    /// The model picker: the model `current` marks, labelled as the catalog
    /// names it (else `fallback`, else "Model"), opening the [`ModelMenu`],
    /// with that label. While a turn runs (not `switchable`) it is a
    /// disabled chip whose tooltip says why, without a menu.
    fn render_model_picker(
        &self,
        current: &dyn Fn(&str, &str) -> bool,
        fallback: Option<SharedString>,
        switchable: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> (Option<SharedString>, AnyElement) {
        let catalog = self.connections.read(cx);
        let menu = ModelMenu::new(current, catalog.list(), catalog.status());
        let label = menu.current_label().or(fallback);
        let connected = self.connected(cx);
        let name = match &label {
            Some(label) => {
                shell_copy::labeled(Locale::current(cx), copy::MODEL.get(cx), label).into()
            }
            None => SharedString::from(copy::MODEL.get(cx)),
        };
        let shown = label.clone().unwrap_or_else(|| copy::MODEL.get(cx).into());
        let button = chip("composer-model", shown, !switchable || !connected, window, cx)
            .accessibility_label(name)
            .loading(self.configuring == Some(Setting::Model));
        if !switchable {
            return (label, button.tooltip(copy::MODEL_BUSY.get(cx)).into_any_element());
        }
        if !connected {
            return (label, button.tooltip(copy::MODEL.get(cx)).into_any_element());
        }
        let composer = cx.entity().downgrade();
        let button = button
            .tooltip(copy::MODEL.get(cx))
            // The composer sits at the window's bottom: the menu opens upward.
            .dropdown_menu_with_anchor(Anchor::BottomLeft, move |popup, window, cx| {
                menu.build(popup, &composer, window, Locale::current(cx))
            });
        (label, button.into_any_element())
    }

    /// The new task's project (Desktop's `WorkspacePicker`), at the end of
    /// the controls row while the draft shows: a ghost chip with the folder
    /// icon, the chosen project's name (else Choose project), and a chevron.
    /// Its menu lists each project that is not archived, the chosen one
    /// checked and one whose folder is gone disabled, then New project… and
    /// Manage projects…; with no project listed, it asks for a folder at
    /// once. A choice sets where new tasks go ([`ProjectSelection`]). Once
    /// the task exists the chip is gone: the header's folder button says
    /// where a task runs.
    fn render_project_picker(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let projects = self.projects.read(cx);
        let locale = Locale::current(cx);
        let label = projects.target().map(|target| target.label());
        let name: SharedString = match &label {
            Some(label) => {
                shell_copy::labeled(locale, shell_copy::CHOOSE_PROJECT.get(cx), label).into()
            }
            None => shell_copy::CHOOSE_PROJECT.get(cx).into(),
        };
        let registering = projects.pending_command() == Some(ProjectCommand::Register);
        let choices: Vec<ProjectChoice> = projects
            .active_projects()
            .map(|project| ProjectChoice {
                id: project.id.clone(),
                name: project.label(),
                path: project.path.clone(),
                available: project.available,
                current: projects.selected_project().is_some_and(|p| p.id == project.id),
            })
            .collect();
        let shown = label.unwrap_or_else(|| shell_copy::CHOOSE_PROJECT.get(cx).into());
        let disabled = !self.connected(cx);
        let (ink, chevron) = chip_inks(&cx.maka(), disabled);
        let button = Button::new("composer-project")
            .ghost()
            .h(dp(28.))
            .px(dp(8.))
            .rounded(dp_px(RADIUS_SURFACE, window))
            .disabled(disabled)
            .loading(registering)
            .accessibility_label(name)
            .tooltip(shell_copy::CHOOSE_PROJECT.get(cx))
            .child(
                h_flex()
                    .gap(dp(4.))
                    .min_w_0()
                    .text_size(dp(LABEL_SIZE))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(ink)
                    .child(
                        Icon::new(MakaIcon::Folder)
                            .with_size(dp_px(14., window))
                            .text_color(chevron),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .max_w(rems(PROJECT_CHIP_LABEL_MAX_REMS))
                            .truncate()
                            .child(shown),
                    )
                    .child(
                        Icon::new(MakaIcon::ChevronDown)
                            .with_size(dp_px(14., window))
                            .text_color(chevron),
                    ),
            );
        if disabled {
            return button.into_any_element();
        }
        if choices.is_empty() {
            return button
                .on_click(cx.listener(|this, _, window, cx| this.add_project(false, window, cx)))
                .into_any_element();
        }
        let composer = cx.entity().downgrade();
        let projects = self.projects.downgrade();
        button
            .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, window, cx| {
                project_menu(menu, &choices, projects.clone(), composer.clone(), window, cx)
            })
            .into_any_element()
    }
}

/// One project as the project picker lists it.
#[derive(Debug, Clone)]
struct ProjectChoice {
    id: SharedString,
    name: SharedString,
    path: SharedString,
    available: bool,
    current: bool,
}

/// The project picker's items (see [`Composer::render_project_picker`]).
fn project_menu(
    mut menu: PopupMenu,
    choices: &[ProjectChoice],
    projects: WeakEntity<ProjectSelection>,
    composer: WeakEntity<Composer>,
    window: &Window,
    cx: &App,
) -> PopupMenu {
    let rem = window.rem_size();
    menu = menu
        .min_w(rem * PROJECT_MENU_MIN_WIDTH_REMS)
        .max_w(rem * PROJECT_MENU_MAX_WIDTH_REMS)
        .scrollable(true)
        .max_h(rem * 24.);
    for choice in choices {
        let (id, projects) = (choice.id.clone(), projects.clone());
        let shown = choice.clone();
        menu = menu.item(
            PopupMenuItem::element(move |_, cx| project_choice(&shown, cx))
                .checked(choice.current)
                .disabled(!choice.available)
                .on_click(move |_, _, cx| {
                    projects.update(cx, |projects, cx| projects.select_project(&id, cx)).ok();
                }),
        );
    }
    let ink = cx.maka().ink_muted;
    menu.separator()
        .item(
            PopupMenuItem::new(shell_copy::NEW_PROJECT.get(cx))
                .icon(Icon::new(AssetIcon::FolderPlus).text_color(ink))
                .on_click(move |_, window, cx| {
                    composer
                        .update(cx, |composer, cx| composer.add_project(false, window, cx))
                        .ok();
                }),
        )
        .item(
            PopupMenuItem::new(shell_copy::MANAGE_PROJECTS.get(cx))
                .icon(Icon::new(MakaIcon::Settings).text_color(ink))
                .action(Box::new(OpenProjectSettings)),
        )
}

/// A project in the project picker: its name over its folder in muted text
/// (or, when the folder is gone, saying so). A remote Host's projects have
/// no folder here: their name alone.
fn project_choice(choice: &ProjectChoice, cx: &App) -> AnyElement {
    let detail: Option<SharedString> = if !choice.available {
        Some(shell_copy::PROJECT_MISSING.get(cx).into())
    } else {
        Some(choice.path.clone()).filter(|path| !path.is_empty())
    };
    v_flex()
        .id(shared::domain_element_id("project-choice", &choice.id))
        .test_support()
        .aria_label(choice.name.clone())
        .min_w_0()
        .py_1()
        .child(div().truncate().child(choice.name.clone()))
        .children(
            detail.map(|detail| {
                div().truncate().text_xs().text_color(cx.maka().ink_muted).child(detail)
            }),
        )
        .into_any_element()
}

/// An attachment's chip (spec §8): 28 px, radius 10, sunken fill, the name
/// in 14 ink and the size in 12 muted, between `leading` and `end` when
/// given. The composer shows one per file for the next message, its remove
/// button as `end`; the transcript one per file a sent message carries.
pub(crate) fn attachment_chip(
    id: ElementId,
    name: SharedString,
    bytes: u64,
    leading: Option<AnyElement>,
    end: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    // The remove button brings its own inset to the chip's end.
    let end_padding = if end.is_some() { 4. } else { 10. };
    h_flex()
        .id(id)
        .test_support()
        .aria_label(name.clone())
        .max_w_full()
        .min_w_0()
        .h(dp(28.))
        .pl(dp(10.))
        .pr(dp(end_padding))
        .gap(dp(6.))
        .rounded(dp(RADIUS_SURFACE))
        .bg(maka.sunken)
        .children(leading)
        .child(
            div().min_w_0().truncate().text_size(dp(LABEL_SIZE)).text_color(maka.ink).child(name),
        )
        .child(
            div()
                .flex_shrink_0()
                .text_size(dp(SUPPORTING_SIZE))
                .text_color(maka.ink_muted)
                .child(copy::file_size(Locale::current(cx), bytes)),
        )
        .children(end)
        .into_any_element()
}

/// An attachment chip's leading glyph for its kind, 14 px in muted ink:
/// Desktop's `ATTACHMENT_KIND_ICON` (packages/ui/src/attachment-kinds.tsx).
pub(crate) fn attachment_kind_icon(kind: &AttachmentKind, window: &Window, cx: &App) -> AnyElement {
    let glyph = match kind {
        AttachmentKind::Image => AssetIcon::FileImage,
        AttachmentKind::Pdf => AssetIcon::FileText,
        AttachmentKind::Doc => AssetIcon::FileType,
        AttachmentKind::Code => AssetIcon::FileCode,
        _ => AssetIcon::Paperclip,
    };
    div()
        .id(shared::domain_element_id("attachment-kind", kind.as_str()))
        .test_support()
        .flex_shrink_0()
        .child(Icon::new(glyph).with_size(dp_px(14., window)).text_color(cx.maka().ink_muted))
        .into_any_element()
}

/// A picker chip of the controls row (spec §8): 28 px, radius 10, label
/// 14/500 ink, then a muted chevron. A disabled chip is drawn whole at
/// half strength, Astryx's disabled control: its label sets its own ink,
/// which the kit's disabled colour does not reach (review round 16).
fn chip(
    id: &'static str,
    label: SharedString,
    disabled: bool,
    window: &Window,
    cx: &App,
) -> Button {
    let (ink, chevron) = chip_inks(&cx.maka(), disabled);
    Button::new(id)
        .ghost()
        .h(dp(28.))
        .px(dp(8.))
        .rounded(dp_px(RADIUS_SURFACE, window))
        .disabled(disabled)
        .child(
            h_flex()
                .gap(dp(4.))
                .text_size(dp(LABEL_SIZE))
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink)
                .child(label)
                .child(
                    Icon::new(MakaIcon::ChevronDown)
                        .with_size(dp_px(14., window))
                        .text_color(chevron),
                ),
        )
}

/// A [`chip`]'s label and chevron inks: ink and muted ink, both at
/// [`DISABLED_OPACITY`] while it is disabled.
fn chip_inks(maka: &MakaPalette, disabled: bool) -> (Hsla, Hsla) {
    let strength = if disabled { DISABLED_OPACITY } else { 1. };
    (maka.ink.opacity(strength), maka.ink_muted.opacity(strength))
}

/// The model menu as it stood when the composer last rendered: the enabled
/// models of every enabled connection, grouped under the connection's name,
/// with the session's model checked, and last "Add connection…", which
/// dispatches `AddConnection`. A read in progress or a failed first read
/// shows as a disabled line; a failed reload keeps the last list.
#[derive(Debug, Clone)]
struct ModelMenu {
    groups: Vec<ModelGroup>,
    note: Option<Text>,
}

#[derive(Debug, Clone)]
struct ModelGroup {
    connection_id: SharedString,
    name: SharedString,
    /// Each model with whether the session runs it.
    models: Vec<(workspace::ConnectionModel, bool)>,
}

impl ModelMenu {
    /// The menu over `list`, checking the model `current` says runs (by
    /// connection id and model id).
    fn new(
        current: &dyn Fn(&str, &str) -> bool,
        list: Option<&ConnectionList>,
        status: &ConnectionCatalogStatus,
    ) -> Self {
        let groups: Vec<ModelGroup> = list
            .map(|list| {
                list.enabled()
                    .filter(|connection| !connection.models.is_empty())
                    .map(|connection| ModelGroup {
                        connection_id: connection.id.clone(),
                        name: connection.name.clone(),
                        models: connection
                            .models
                            .iter()
                            .map(|model| {
                                let runs = current(&connection.id, &model.id);
                                (model.clone(), runs)
                            })
                            .collect(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let note = match (list, status) {
            (Some(_), _) if groups.is_empty() => Some(copy::MODELS_NONE),
            (Some(_), _) => None,
            (None, ConnectionCatalogStatus::Failed(_)) => Some(copy::MODELS_FAILED),
            (None, _) => Some(copy::MODELS_LOADING),
        };
        Self { groups, note }
    }

    /// The catalog's label for the session's model, when it is listed.
    fn current_label(&self) -> Option<SharedString> {
        self.groups
            .iter()
            .flat_map(|group| &group.models)
            .find_map(|(model, current)| current.then(|| model.label.clone()))
    }

    fn build(
        &self,
        mut popup: PopupMenu,
        composer: &WeakEntity<Composer>,
        window: &Window,
        locale: Locale,
    ) -> PopupMenu {
        // Long catalogs scroll inside the menu instead of leaving the window.
        popup = popup.scrollable(true).max_h(window.rem_size() * 24.);
        for (ix, group) in self.groups.iter().enumerate() {
            if ix > 0 {
                popup = popup.separator();
            }
            popup = popup.label(group.name.clone());
            for (model, current) in &group.models {
                let composer = composer.clone();
                let connection_id = group.connection_id.clone();
                let model_id = model.id.clone();
                popup =
                    popup.item(PopupMenuItem::new(model.label.clone()).checked(*current).on_click(
                        move |_, _, cx| {
                            composer
                                .update(cx, |composer, cx| {
                                    composer.select_model(&connection_id, &model_id, cx)
                                })
                                .ok();
                        },
                    ));
            }
        }
        if let Some(note) = self.note {
            popup = popup.item(PopupMenuItem::new(note.in_locale(locale)).disabled(true));
        }
        // The shell opens Settings at Connections, on the form, for this command.
        popup.separator().item(
            PopupMenuItem::new(copy::ADD_CONNECTION.in_locale(locale))
                .icon(IconName::Plus)
                .action(Box::new(AddConnection)),
        )
    }
}

/// One model the picker offers.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ModelChoice {
    pub connection_id: SharedString,
    /// The connection's name, as the picker's group heading shows it.
    pub connection: SharedString,
    pub model_id: SharedString,
    pub label: SharedString,
    /// The session runs it.
    pub current: bool,
}

/// How the thinking level picker names `level` (`None`: Model default), as
/// Maka Desktop does (`model.level`). A level this client does not know is
/// shown by its wire literal.
pub fn thinking_level_label(level: Option<&ThinkingLevel>, locale: Locale) -> SharedString {
    let text = match level {
        None => copy::THINKING_LEVEL_DEFAULT,
        Some(ThinkingLevel::Off) => copy::THINKING_LEVEL_OFF,
        Some(ThinkingLevel::Minimal) => copy::THINKING_LEVEL_MINIMAL,
        Some(ThinkingLevel::Low) => copy::THINKING_LEVEL_LOW,
        Some(ThinkingLevel::Medium) => copy::THINKING_LEVEL_MEDIUM,
        Some(ThinkingLevel::High) => copy::THINKING_LEVEL_HIGH,
        Some(ThinkingLevel::Xhigh) => copy::THINKING_LEVEL_XHIGH,
        Some(ThinkingLevel::Max) => copy::THINKING_LEVEL_MAX,
        Some(other) => return other.as_str().to_owned().into(),
    };
    text.in_locale(locale).into()
}

/// The modes the permission picker offers, in Maka's order
/// (`PERMISSION_MODES` in packages/core/src/permission.ts).
pub const PERMISSION_MODES: [PermissionMode; 3] =
    [PermissionMode::Explore, PermissionMode::Ask, PermissionMode::Bypass];

/// One permission mode in the menu: its name over its one-line
/// description. Full access's description is in the warning color; its
/// words carry the warning too.
fn permission_mode_item(mode: &PermissionMode, cx: &App) -> AnyElement {
    let locale = Locale::current(cx);
    let label = permission_mode_label(mode, locale);
    let maka = cx.maka();
    let hint_color = if *mode == PermissionMode::Bypass { maka.warning } else { maka.ink_muted };
    v_flex()
        .id(SharedString::from(format!("permission-mode-{}", mode.as_str())))
        .test_support()
        .aria_label(label.clone())
        .py_1()
        .child(label)
        .children(
            permission_mode_hint(mode)
                .map(|hint| div().text_xs().text_color(hint_color).child(hint.in_locale(locale))),
        )
        .into_any_element()
}

/// A mode's one-line description, as Maka Desktop words it.
pub fn permission_mode_hint(mode: &PermissionMode) -> Option<Text> {
    match mode {
        PermissionMode::Explore => Some(copy::PERMISSION_READ_ONLY_HINT),
        PermissionMode::Ask => Some(copy::PERMISSION_AUTO_HINT),
        PermissionMode::Bypass => Some(copy::PERMISSION_FULL_ACCESS_HINT),
        _ => None,
    }
}

/// How the composer names a permission mode. A mode this client does not
/// know is shown by its wire literal rather than guessed.
pub fn permission_mode_label(mode: &PermissionMode, locale: Locale) -> SharedString {
    match mode {
        PermissionMode::Explore => copy::PERMISSION_READ_ONLY.in_locale(locale).into(),
        PermissionMode::Ask => copy::PERMISSION_AUTO.in_locale(locale).into(),
        PermissionMode::Bypass => copy::PERMISSION_FULL_ACCESS.in_locale(locale).into(),
        other => other.as_str().to_owned().into(),
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        // Without a Host nothing can be sent, whatever is selected; the
        // placeholder says so, and the controls row keeps its controls,
        // disabled, as Desktop's does. The note says only why the last
        // command failed.
        let note = match &self.error {
            Some(error) => div()
                .id("composer-error")
                .test_support()
                .aria_label(error.clone())
                .text_color(maka.destructive)
                .child(error.clone()),
            None => div().id("composer-note").test_support(),
        }
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(dp(SUPPORTING_SIZE))
        .pr(dp(6.));
        let mut controls = self.render_settings(window, cx);
        controls.insert(0, self.render_attach_button(window, cx));
        // Last in the row, so nothing moves when it goes with the draft. A
        // side chat runs where its task does.
        if self.selected_session(cx).is_none() && self.side.is_none() {
            controls.push(self.render_project_picker(window, cx));
        }
        // First in the row, the note starts on the input's text edge (the
        // field's 8 inside the dock's 12, review round 12); after a control,
        // 6 from it.
        let note = note.pl(dp(if controls.is_empty() { 8. } else { 6. })).into_any_element();
        let chips = match (self.render_quotes(window, cx), self.render_attachments(window, cx)) {
            (Some(quotes), Some(files)) => {
                Some(v_flex().w_full().gap(dp(6.)).child(quotes).child(files).into_any_element())
            }
            (quotes, files) => quotes.or(files),
        };
        let action = self.render_action_button(window, cx);
        // The outer row centres the dock in the reading column, 16 px above
        // the plate's bottom edge; queued messages sit right above it.
        h_flex()
            .key_context(COMPOSER_CONTEXT)
            .on_action(cx.listener(Self::on_enter))
            .flex_shrink_0()
            .w_full()
            .justify_center()
            .px(dp(COLUMN_GUTTER))
            .pt(dp(8.))
            .pb(dp(16.))
            .child(
                v_flex()
                    .w_full()
                    .max_w(column_max_width())
                    .child(self.render_dock(controls, chips, note, action, window, cx)),
            )
    }
}

impl Composer {
    /// The dock (spec §8): plate fill, radius 28 (the chat rung it shares
    /// with the user bubble), a 1 px ring plus two soft shadows in light
    /// mode and the ring alone in dark mode, 12 px padding; the borderless
    /// draft, the chips, then the controls row. As in Maka Desktop's
    /// composer the ring does not change with focus: the draft's caret shows
    /// where typing goes, and every control in the row draws its own focus
    /// ring.
    ///
    /// The dock is where files are dropped (the rest of the window takes
    /// none); while files are dragged over it, its ring is the one the kit
    /// draws around a focused field (`focus_ring_style`): the edge in the
    /// accent and a 3 px band beyond it at half strength. Shadows take no
    /// room, so nothing moves.
    fn render_dock(
        &self,
        controls: Vec<AnyElement>,
        chips: Option<AnyElement>,
        note: AnyElement,
        action: Button,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let maka = cx.maka();
        let dark = cx.theme().mode.is_dark();
        let ring = if dark { maka.border } else { maka.ink.opacity(0.08) };
        let edge = |color: Hsla, width: f32| BoxShadow {
            color,
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(width),
            inset: false,
        };
        let mut shadows = vec![edge(ring, 1.)];
        if !dark {
            shadows.push(BoxShadow {
                color: maka.ink.opacity(0.04),
                offset: point(px(0.), dp_px(1., window)),
                blur_radius: dp_px(2., window),
                spread_radius: px(0.),
                inset: false,
            });
            shadows.push(BoxShadow {
                // Offset, blur and spread reach 8 px below the dock, well
                // inside the 16 px it keeps above the plate's edge, so no
                // shadow falls on the canvas (review rounds 5 and 7).
                color: maka.ink.opacity(0.08),
                offset: point(px(0.), dp_px(4., window)),
                blur_radius: dp_px(8., window),
                spread_radius: dp_px(-4., window),
                inset: false,
            });
        }
        let mut dropping = shadows.clone();
        dropping[0] = edge(maka.accent, 1.);
        dropping.insert(0, edge(maka.accent.alpha(0.5), 1. + 3.));
        let composer = cx.entity().downgrade();
        let body = v_flex()
            .w_full()
            .p(dp(12.))
            .gap(dp(6.))
            .child(
                // The kit pads a multi-line field by a fixed 8 px above and
                // below and 10 px at the sides; these margins leave the
                // spec's 6 / 8 / 2 around the text.
                div().mt(px(-2.)).mx(px(-2.)).mb(px(-6.)).child(
                    Textarea::new(&self.draft)
                        .appearance(false)
                        .text_size(dp(BODY_SIZE))
                        .line_height(dp(20.))
                        .text_color(maka.ink)
                        .aria_label(copy::COMPOSER_LABEL.get(cx))
                        .on_paste(move |item, _, cx| {
                            composer
                                .update(cx, |composer, cx| composer.paste(item, cx))
                                .unwrap_or(false)
                        }),
                ),
            )
            .children(chips)
            .child(
                h_flex().items_center().gap(dp(2.)).children(controls).child(note).child(action),
            );
        // Queued messages are the dock's top section (it renders nothing when
        // the queue is empty); the dock's corners clip it.
        v_flex()
            .id("composer")
            .test_support()
            .w_full()
            .rounded(dp(RADIUS_CHAT))
            .overflow_hidden()
            .bg(maka.plate)
            .shadow(shadows)
            .drag_over::<ExternalPaths>(move |style, _, _, _| style.shadow(dropping.clone()))
            .on_drop(cx.listener(Self::on_drop))
            .child(self.queue.clone())
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use host_protocol::PermissionMode;
    use workspace::{ConnectionEntry, ConnectionModel};

    use super::*;
    use crate::state::SessionSettings;

    fn settings(connection_id: Option<&str>, slug: &str, model: &str) -> SessionSettings {
        SessionSettings {
            model: model.to_owned().into(),
            connection_id: connection_id.map(|id| id.to_owned().into()),
            connection_slug: slug.to_owned().into(),
            permission_mode: PermissionMode::Ask,
            thinking_level: None,
            revision: 1,
        }
    }

    fn list() -> ConnectionList {
        let models = |ids: &[(&str, &str)]| {
            ids.iter().map(|(id, label)| ConnectionModel::new(*id, *label)).collect()
        };
        ConnectionList::new(
            1,
            None,
            vec![
                ConnectionEntry::new("c1", "one", "One", 1, models(&[("m", "Model M")])),
                ConnectionEntry::new(
                    "c2",
                    "two",
                    "Two",
                    1,
                    models(&[("m", "M on two"), ("n", "n")]),
                ),
                ConnectionEntry::new("c3", "three", "Empty", 1, Vec::new()),
            ],
        )
    }

    fn menu_for(
        settings: &SessionSettings,
        list: Option<&ConnectionList>,
        status: &ConnectionCatalogStatus,
    ) -> ModelMenu {
        let current = |id: &str, model: &str| list.is_some_and(|l| settings.runs(l, id, model));
        ModelMenu::new(&current, list, status)
    }

    fn checked(menu: &ModelMenu) -> Vec<(String, String)> {
        menu.groups
            .iter()
            .flat_map(|group| {
                group
                    .models
                    .iter()
                    .filter(|(_, current)| *current)
                    .map(|(model, _)| (group.connection_id.to_string(), model.id.to_string()))
            })
            .collect()
    }

    #[test]
    fn the_menu_checks_the_model_on_the_session_connection_only() {
        let list = list();
        let loaded = ConnectionCatalogStatus::Loaded;
        let menu = menu_for(&settings(Some("c2"), "two", "m"), Some(&list), &loaded);
        assert_eq!(checked(&menu), [("c2".to_owned(), "m".to_owned())]);
        assert_eq!(menu.current_label().as_deref(), Some("M on two"));
        assert_eq!(menu.groups.len(), 2, "a connection without models is left out");
        assert_eq!(menu.note, None);
        // Without a connection id, the slug names the connection; so it
        // does for an id the catalog does not list (Maka Desktop's).
        let menu = menu_for(&settings(None, "one", "m"), Some(&list), &loaded);
        assert_eq!(checked(&menu), [("c1".to_owned(), "m".to_owned())]);
        let menu = menu_for(&settings(Some("desktop"), "two", "m"), Some(&list), &loaded);
        assert_eq!(checked(&menu), [("c2".to_owned(), "m".to_owned())]);
        // A model the catalog does not list checks nothing.
        let menu = menu_for(&settings(Some("c1"), "one", "gone"), Some(&list), &loaded);
        assert!(checked(&menu).is_empty());
        assert_eq!(menu.current_label(), None);
    }

    #[test]
    fn a_disabled_chip_does_not_draw_its_label_in_full_ink() {
        for palette in [MakaPalette::light(), MakaPalette::dark()] {
            assert_eq!(chip_inks(&palette, false), (palette.ink, palette.ink_muted));
            let (label, chevron) = chip_inks(&palette, true);
            assert_ne!(label, palette.ink);
            assert_eq!(label, palette.ink.opacity(DISABLED_OPACITY));
            assert_eq!(chevron, palette.ink_muted.opacity(DISABLED_OPACITY));
        }
    }

    #[test]
    fn a_missing_catalog_shows_why_instead_of_models() {
        let session = settings(Some("c1"), "one", "m");
        let loading = menu_for(&session, None, &ConnectionCatalogStatus::Loading);
        assert_eq!(loading.note, Some(copy::MODELS_LOADING));
        let failed = menu_for(&session, None, &ConnectionCatalogStatus::Failed("x".into()));
        assert_eq!(failed.note, Some(copy::MODELS_FAILED));
        let empty = ConnectionList::new(1, None, Vec::new());
        let none = menu_for(&session, Some(&empty), &ConnectionCatalogStatus::Loaded);
        assert_eq!(none.note, Some(copy::MODELS_NONE));
        // A failed reload keeps the last list.
        let list = list();
        let stale = menu_for(&session, Some(&list), &ConnectionCatalogStatus::Failed("x".into()));
        assert_eq!((stale.groups.len(), stale.note), (2, None));
    }
}
