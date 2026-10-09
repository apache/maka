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

//! The Memory page, after Maka Desktop's (memory-settings-page.tsx,
//! use-memory-settings-controller.ts, memory-entry-list.tsx,
//! memory-settings-sections.tsx): the two switches (local MEMORY.md, and
//! whether the model's context reads it), what Maka remembers (add by
//! hand, filter, the active and archived lists with archive, restore, and
//! copy), the file and its backups (the backups, MEMORY.md's text with
//! Save, Reload, Reset, and Open), and the model-context preview.
//!
//! The switches are the Host's runtime policy (`set_memory`); everything
//! else is `memory.query` and `memory.mutate` ([`crate::memory_store`]).
//! MEMORY.md lives under the State Root (`memory/MEMORY.md`), which this
//! client's Host shares with it, so Open hands the file to the system.
//!
//! Differs from Desktop: an entry is added and archived by the Host
//! (`remember`, `set_status`) instead of by editing the draft, so an entry
//! added here takes no tags, and the lists show the file as saved, not the
//! draft being edited; a draft with unsaved edits stays when an entry
//! changes. "Locate in draft" is left out. Every backup is listed (Desktop
//! lists them once there are two, and puts the latest behind a menu).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    Anchor, AnyElement, AnyWindowHandle, App, AppContext as _, ClipboardItem, Context, Entity,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{
    MemoryBackup, MemoryBackupKind, MemoryEntry, MemoryEntrySource, MemoryMutateInput,
    MemoryPolicy, RuntimePolicy, RuntimePolicyMutation,
};
use shared::copy::memory as copy;
use shared::copy::{Locale, Text};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FadedSwitch;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, control_button, floating_surface, quiet_button};
use workspace::{HostSession, HostSessionEvent};

use crate::memory_preview::{PROMPT_MAX_CHARS, PromptPreview, prompt_preview};
use crate::memory_store::{self, MemoryAccess, MemorySnapshot, Reason};
use crate::page_kit::{Tone, ago, empty_state, policy_status, status_dot, titled};
use crate::policy::HostPolicy;
use crate::rows::{
    ActionRow, FieldBlock, SettingsGroup, SettingsRow, StatusKind, StatusLine, filter_field,
    settings_button,
};

/// The key of the page's own status line (offline, or the policy unread).
const PAGE_KEY: &str = "memory";

/// The directory under the State Root that holds MEMORY.md and its backups.
const MEMORY_DIRECTORY: &str = "memory";
const MEMORY_FILE: &str = "MEMORY.md";

/// The file a backup kind is kept in (Desktop's `BACKUP_FILES`).
fn backup_file(kind: &MemoryBackupKind) -> &'static str {
    match kind {
        MemoryBackupKind::Reset => "MEMORY.md.reset.bak",
        MemoryBackupKind::Restore => "MEMORY.md.restore.bak",
        _ => "MEMORY.md.bak",
    }
}

fn backup_kind_label(kind: &MemoryBackupKind) -> Text {
    match kind {
        MemoryBackupKind::Reset => copy::BACKUP_RESET,
        MemoryBackupKind::Restore => copy::BACKUP_RESTORE,
        _ => copy::BACKUP_SAVE,
    }
}

fn origin_label(source: &MemoryEntrySource) -> Text {
    match source {
        MemoryEntrySource::UserAuthored => copy::ORIGIN_MANUAL,
        MemoryEntrySource::ChatExtracted => copy::ORIGIN_EXTRACTED,
        _ => copy::ORIGIN_UNKNOWN,
    }
}

/// A long path as its last three parts after an ellipsis
/// (`displayMemoryPath`).
pub fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    let parts: Vec<&str> = text.split(['/', '\\']).filter(|part| !part.is_empty()).collect();
    if parts.len() <= 3 {
        return text;
    }
    let separator = if text.contains('\\') && !text.contains('/') { "\\" } else { "/" };
    format!("…{separator}{}", parts[parts.len() - 3..].join(separator))
}

/// Whether `entry` matches the filter `query` (lowercase): its id, title,
/// text, origin, times, or tags (`filterLocalMemoryEntries`).
fn matches(entry: &MemoryEntry, query: &str, locale: Locale) -> bool {
    let times =
        [entry.created_at, entry.updated_at].map(|t| t.map(|t| t.to_string()).unwrap_or_default());
    [
        entry.id.as_str(),
        entry.title.as_str(),
        entry.content.as_str(),
        entry.source.as_str(),
        origin_label(&entry.source).in_locale(locale),
        times[0].as_str(),
        times[1].as_str(),
    ]
    .into_iter()
    .chain(entry.tags.iter().map(String::as_str))
    .any(|field| field.to_lowercase().contains(query))
}

/// The action in flight: one at a time, and the control that started it
/// says so.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Pending {
    Enable,
    AgentRead,
    Add,
    Entry(String),
    Save,
    Reload,
    Reset,
    Restore(MemoryBackupKind),
    Open,
}

/// Where each area's last action left its line.
const SWITCHES: &str = "memory-switches";
const ENTRIES: &str = "memory-entries";
const DOCUMENT: &str = "memory-document";

/// Opens a file or folder with the system.
type Opener = Rc<dyn Fn(&Path, &mut App)>;

/// Behavior and presentation owner of the Memory page: memory as last
/// read, the draft of MEMORY.md being edited, the add form, the filter,
/// and the one action in flight.
///
/// Memory is read when the page shows, again after each write (a write
/// that fails reads it too, so the page shows what the Host has), and when
/// the policy switches memory or incognito. A read keeps the snapshot it
/// replaces on screen, and a draft with unsaved edits unless the action was
/// on the file itself (Save, Reload, Reset, Restore). What an action found
/// says so on its area's line. Restore asks first; Reset keeps a backup,
/// so it does not.
pub struct MemoryPage {
    host: Entity<HostSession>,
    policy: Entity<HostPolicy>,
    snapshot: Option<Box<MemorySnapshot>>,
    load_error: Option<SharedString>,
    loading: bool,
    /// Drops a read that a newer one overtook.
    generation: u64,
    pending: Option<Pending>,
    feedback: HashMap<&'static str, (StatusKind, SharedString)>,
    add_open: bool,
    details_open: bool,
    title: Entity<InputState>,
    content: Entity<TextareaState>,
    filter: Entity<InputState>,
    editor: Entity<TextareaState>,
    preview_scroll: ScrollHandle,
    /// Whether the page has shown, so a new connection reads again.
    shown: bool,
    /// Memory switched on, and incognito, as the policy last said.
    seen_access: Option<(bool, bool)>,
    utc_offset: i32,
    window: AnyWindowHandle,
    opener: Opener,
    _load: Option<Task<()>>,
    _action: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for MemoryPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryPage")
            .field("pending", &self.pending)
            .field("loading", &self.loading)
            .field("feedback", &self.feedback)
            .finish_non_exhaustive()
    }
}

impl MemoryPage {
    pub fn new(
        host: Entity<HostSession>,
        policy: Entity<HostPolicy>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let title = cx.new(|cx| {
            InputState::new(window, cx).placeholder(copy::ENTRY_TITLE_PLACEHOLDER.get(cx))
        });
        let content = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 8)
                .placeholder(copy::ENTRY_CONTENT_PLACEHOLDER.get(cx))
        });
        let filter =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::FILTER_PLACEHOLDER.get(cx)));
        let editor = cx.new(|cx| TextareaState::new(window, cx).auto_grow(12, 24));
        let subscriptions = vec![
            cx.subscribe(&filter, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.subscribe(&editor, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.observe(&policy, |this, _, cx| this.policy_changed(cx)),
            // A page shown while offline reads once there is a Host.
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if matches!(event, HostSessionEvent::Connected { .. }) && this.shown {
                    this.load(false, cx);
                }
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let (title, content, filter) = (
                    copy::ENTRY_TITLE_PLACEHOLDER.get(cx),
                    copy::ENTRY_CONTENT_PLACEHOLDER.get(cx),
                    copy::FILTER_PLACEHOLDER.get(cx),
                );
                this.title.update(cx, |input, cx| input.set_placeholder(title, window, cx));
                this.content.update(cx, |input, cx| input.set_placeholder(content, window, cx));
                this.filter.update(cx, |input, cx| input.set_placeholder(filter, window, cx));
                this.utc_offset = shared::time::local_utc_offset();
            }),
        ];
        Self {
            host,
            policy,
            snapshot: None,
            load_error: None,
            loading: false,
            generation: 0,
            pending: None,
            feedback: HashMap::new(),
            add_open: false,
            details_open: false,
            title,
            content,
            filter,
            editor,
            preview_scroll: ScrollHandle::new(),
            shown: false,
            seen_access: None,
            utc_offset: shared::time::local_utc_offset(),
            window: window.window_handle(),
            opener: Rc::new(|path, cx| cx.open_with_system(path)),
            _load: None,
            _action: None,
            _subscriptions: subscriptions,
        }
    }

    /// Opens files with `opener` instead of the system (tests).
    pub fn set_opener(&mut self, opener: impl Fn(&Path, &mut App) + 'static) {
        self.opener = Rc::new(opener);
    }

    /// The page shows: reads memory.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.shown = true;
        if self.pending.is_none() {
            self.load(false, cx);
        }
    }

    /// Opens a place on the page, for screenshots (`--open-settings
    /// memory:<target>`): `add` the add form, `details` and `details-end`
    /// the file and its backups.
    pub fn reveal(&mut self, target: &str, window: &mut Window, cx: &mut Context<Self>) {
        match target {
            "add" if !self.add_open => self.toggle_add(window, cx),
            "details" | "details-end" => {
                self.details_open = true;
                cx.notify();
            }
            _ => {}
        }
    }

    pub fn snapshot(&self) -> Option<&MemorySnapshot> {
        self.snapshot.as_deref()
    }

    pub fn title_input(&self) -> &Entity<InputState> {
        &self.title
    }

    pub fn content_input(&self) -> &Entity<TextareaState> {
        &self.content
    }

    pub fn filter_input(&self) -> &Entity<InputState> {
        &self.filter
    }

    pub fn editor(&self) -> &Entity<TextareaState> {
        &self.editor
    }

    /// What the last action in `area` (`memory-switches`, `memory-entries`,
    /// `memory-document`) found.
    pub fn feedback(&self, area: &str) -> Option<&(StatusKind, SharedString)> {
        self.feedback.get(area)
    }

    /// Whether a write is unanswered.
    pub fn is_busy(&self) -> bool {
        self.pending.as_ref().is_some_and(|pending| *pending != Pending::Open)
    }

    /// The filter field, while it shows: once the policy is read and the
    /// local memory has entries to list.
    pub fn search_field(&self, cx: &App) -> Option<Entity<InputState>> {
        let listed = self.policy.read(cx).policy().is_some()
            && self
                .snapshot
                .as_deref()
                .is_some_and(|snapshot| snapshot.active.len() + snapshot.archived.len() > 0);
        listed.then(|| self.filter.clone())
    }

    fn memory_dir(&self, cx: &App) -> PathBuf {
        self.host.read(cx).root().join(MEMORY_DIRECTORY)
    }

    fn memory_policy(&self, cx: &App) -> Option<(MemoryPolicy, bool)> {
        let policy = self.policy.read(cx).policy()?;
        Some((policy.memory, policy.privacy.incognito_active))
    }

    /// The draft as the editor holds it.
    fn draft(&self, cx: &App) -> String {
        self.editor.read(cx).value().to_string()
    }

    fn saved_content(&self) -> &str {
        self.snapshot.as_ref().map_or("", |snapshot| snapshot.content.as_str())
    }

    fn dirty(&self, cx: &App) -> bool {
        self.draft(cx) != self.saved_content()
    }

    /// The policy turned memory or incognito on or off: memory reads again.
    fn policy_changed(&mut self, cx: &mut Context<Self>) {
        let access = self.memory_policy(cx).map(|(memory, incognito)| (memory.enabled, incognito));
        if access.is_some() && access != self.seen_access {
            let first = self.seen_access.is_none();
            self.seen_access = access;
            if !first && self.pending.is_none() && self.snapshot.is_some() {
                self.load(false, cx);
            }
        }
        cx.notify();
    }

    /// Reads memory; the draft takes the new text when `replace_draft` or
    /// when it has no unsaved edits.
    fn load(&mut self, replace_draft: bool, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        let requester = self.host.read(cx).requester();
        let locale = Locale::current(cx);
        let window = self.window;
        self.loading = true;
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = memory_store::read_snapshot(&requester, locale).await;
            cx.update_window(window, |_, window, cx| {
                this.update(cx, |this, cx| {
                    if this.generation != generation {
                        return;
                    }
                    this._load = None;
                    this.took(result, replace_draft, window, cx);
                })
                .ok();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Takes what a read found.
    fn took(
        &mut self,
        result: Result<MemorySnapshot, Reason>,
        replace_draft: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.loading = false;
        match result {
            Ok(snapshot) => {
                let keep = !replace_draft && self.snapshot.is_some() && self.dirty(cx);
                if !keep && self.draft(cx) != snapshot.content {
                    let content = snapshot.content.clone();
                    self.editor.update(cx, |editor, cx| editor.set_value(content, window, cx));
                }
                self.snapshot = Some(Box::new(snapshot));
                self.load_error = None;
            }
            Err(reason) => {
                log::warn!("memory.query failed: {reason}");
                let what = copy::LOAD_FAILED.in_locale(Locale::current(cx));
                self.load_error = Some(titled(Locale::current(cx), what, &reason).into());
            }
        }
        cx.notify();
    }

    /// Runs `work`, then reads memory again whatever it answered; `done`
    /// says what went through, and a failure says why on `area`'s line,
    /// after `what`.
    #[allow(clippy::too_many_arguments)]
    fn run(
        &mut self,
        pending: Pending,
        area: &'static str,
        what: Text,
        work: impl Future<Output = Result<(), Reason>> + 'static,
        replace_draft: bool,
        done: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let requester = self.host.read(cx).requester();
        let locale = Locale::current(cx);
        let window = self.window;
        self.generation += 1;
        let generation = self.generation;
        self.pending = Some(pending);
        self.feedback.remove(area);
        self._action = Some(cx.spawn(async move |this, cx| {
            let result = work.await;
            let read = memory_store::read_snapshot(&requester, locale).await;
            cx.update_window(window, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this._action = None;
                    this.pending = None;
                    if this.generation == generation {
                        this.took(read, replace_draft && result.is_ok(), window, cx);
                    }
                    match result {
                        Ok(()) => done(this, window, cx),
                        Err(reason) => {
                            log::warn!("a memory change was not made: {reason}");
                            let line = titled(locale, what.in_locale(locale), &reason);
                            this.feedback.insert(area, (StatusKind::Error, line.into()));
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .ok();
        }));
        cx.notify();
    }

    fn say(&mut self, area: &'static str, kind: StatusKind, line: impl Into<SharedString>) {
        self.feedback.insert(area, (kind, line.into()));
    }

    /// A switch of the memory policy: local memory, or the model's reading
    /// of it.
    fn set_switch(&mut self, agent_read: bool, on: bool, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let change = move |policy: &RuntimePolicy| {
            let mut value = policy.memory;
            if agent_read {
                value.agent_read_enabled = on;
            } else {
                value.enabled = on;
            }
            (value != policy.memory).then_some(RuntimePolicyMutation::SetMemory { value })
        };
        let Some(task) = self.policy.update(cx, |policy, cx| policy.mutate(change, locale, cx))
        else {
            return;
        };
        let (pending, what) = if agent_read {
            (Pending::AgentRead, copy::AGENT_READ_FAILED)
        } else {
            (Pending::Enable, copy::TOGGLE_FAILED)
        };
        let work = async move { task.await.map_err(|refusal| refusal.reason().to_owned()) };
        self.run(pending, SWITCHES, what, work, !agent_read, |_, _, _| {}, cx);
    }

    /// Local MEMORY.md on or off.
    pub fn set_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        self.set_switch(false, on, cx);
    }

    /// Whether the model's context reads local memory.
    pub fn set_agent_read(&mut self, on: bool, cx: &mut Context<Self>) {
        self.set_switch(true, on, cx);
    }

    fn toggle_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add_open = !self.add_open;
        if self.add_open {
            self.title.update(cx, |input, cx| input.focus(window, cx));
        }
        cx.notify();
    }

    fn cancel_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add_open = false;
        self.title.update(cx, |input, cx| input.set_value("", window, cx));
        self.content.update(cx, |input, cx| input.set_value("", window, cx));
        self.feedback.remove(ENTRIES);
        cx.notify();
    }

    /// Add memory: the title (as the Host keeps it, one line of at most 80
    /// characters) and the text, remembered for every task.
    pub fn add_entry(&mut self, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let title: String =
            self.title.read(cx).value().split_whitespace().collect::<Vec<_>>().join(" ");
        let title: String = title.chars().take(80).collect();
        let content = self.content.read(cx).value().trim().to_owned();
        let missing = if title.is_empty() {
            Some((copy::EMPTY_TITLE, copy::EMPTY_TITLE_DETAIL))
        } else if content.is_empty() {
            Some((copy::EMPTY_CONTENT, copy::EMPTY_CONTENT_DETAIL))
        } else if content.len() > host_protocol::MEMORY_CONTENT_MAX_BYTES {
            Some((copy::SAVE_FAILED, copy::RESULT_OVERSIZE))
        } else {
            None
        };
        if let Some((what, why)) = missing {
            let line = titled(locale, what.in_locale(locale), why.in_locale(locale));
            self.say(ENTRIES, StatusKind::Error, line);
            cx.notify();
            return;
        }
        let requester = self.host.read(cx).requester();
        let (sent_title, sent_content) = (title.clone(), content);
        let work = async move {
            let make = |state: &host_protocol::MemoryState| {
                Some(MemoryMutateInput::remember(
                    &state.revision,
                    sent_title.clone(),
                    sent_content.clone(),
                ))
            };
            memory_store::write(&requester, make, locale).await
        };
        let done = move |this: &mut Self, window: &mut Window, cx: &mut Context<Self>| {
            this.title.update(cx, |input, cx| input.set_value("", window, cx));
            this.content.update(cx, |input, cx| input.set_value("", window, cx));
            let line = touched(locale, copy::ADDED, &title);
            this.say(ENTRIES, StatusKind::Info, line);
        };
        self.run(Pending::Add, ENTRIES, copy::SAVE_FAILED, work, false, done, cx);
    }

    /// Archives an active entry, or brings an archived one back.
    pub fn set_archived(&mut self, entry: &MemoryEntry, archived: bool, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let requester = self.host.read(cx).requester();
        let id = entry.id.clone();
        let work = async move {
            let make = |state: &host_protocol::MemoryState| {
                Some(MemoryMutateInput::set_archived(&state.revision, id.clone(), archived))
            };
            memory_store::write(&requester, make, locale).await
        };
        let (what, said) = if archived {
            (copy::ARCHIVE_FAILED, copy::ARCHIVED)
        } else {
            (copy::ENTRY_RESTORE_FAILED, copy::RESTORED)
        };
        let title = entry.title.clone();
        let done = move |this: &mut Self, _: &mut Window, _: &mut Context<Self>| {
            this.say(ENTRIES, StatusKind::Info, touched(locale, said, &title));
        };
        self.run(Pending::Entry(entry.id.clone()), ENTRIES, what, work, false, done, cx);
    }

    /// Copies what identifies an entry (Desktop's `copyMemoryEntryReference`).
    pub fn copy_entry_reference(&mut self, entry: &MemoryEntry, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let status = if entry.status == host_protocol::MemoryEntryStatus::Archived {
            copy::ENTRY_ARCHIVED
        } else {
            copy::ENTRY_ACTIVE
        };
        let mut lines = vec![
            format!("Memory entry: {}", entry.title),
            format!("ID: {}", entry.id),
            format!("Status: {}", status.in_locale(locale)),
            format!("Origin: {}", origin_label(&entry.source).in_locale(locale)),
        ];
        let time = |ms: u64| shared::time::absolute_time(locale, ms, self.utc_offset);
        lines.extend(entry.created_at.map(|ms| format!("Created: {}", time(ms))));
        lines.extend(entry.updated_at.map(|ms| format!("Updated: {}", time(ms))));
        if !entry.tags.is_empty() {
            lines.push(format!("Tags: {}", entry.tags.join(", ")));
        }
        cx.write_to_clipboard(ClipboardItem::new_string(lines.join("\n")));
        self.say(
            ENTRIES,
            StatusKind::Info,
            touched(locale, copy::ENTRY_REFERENCE_COPIED, &entry.id),
        );
        cx.notify();
    }

    /// Save: MEMORY.md becomes the draft (the Host redacts suspected
    /// secrets as it writes, which the line then says).
    pub fn save(&mut self, cx: &mut Context<Self>) {
        if self.pending.is_some() || !self.dirty(cx) {
            return;
        }
        let locale = Locale::current(cx);
        let requester = self.host.read(cx).requester();
        let draft = self.draft(cx);
        let sent = draft.clone();
        let work = async move { memory_store::replace_document(&requester, &sent, locale).await };
        let done = move |this: &mut Self, _: &mut Window, _: &mut Context<Self>| {
            let Some(snapshot) = this.snapshot.as_deref() else {
                return;
            };
            if snapshot.access == MemoryAccess::SafeMode {
                let line = titled(
                    locale,
                    copy::SAVE_BLOCKED.in_locale(locale),
                    copy::SAFE_MODE.in_locale(locale),
                );
                this.say(DOCUMENT, StatusKind::Error, line);
                return;
            }
            let (active, archived) = (snapshot.active.len() as u64, snapshot.archived.len() as u64);
            let summary = copy::save_summary(locale, active, archived);
            let title =
                if snapshot.content == draft { copy::SAVED_FILE } else { copy::SAVED_REDACTED };
            this.say(DOCUMENT, StatusKind::Info, titled(locale, title.in_locale(locale), &summary));
        };
        self.run(Pending::Save, DOCUMENT, copy::SAVE_FAILED, work, true, done, cx);
    }

    /// Reload: the draft becomes MEMORY.md as saved.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let done = move |this: &mut Self, _: &mut Window, _: &mut Context<Self>| {
            let line = titled(
                locale,
                copy::RELOADED.in_locale(locale),
                copy::RELOAD_DISCARDED.in_locale(locale),
            );
            this.say(DOCUMENT, StatusKind::Info, line);
        };
        self.run(Pending::Reload, DOCUMENT, copy::LOAD_FAILED, async { Ok(()) }, true, done, cx);
    }

    /// Reset and back up: MEMORY.md becomes the Host's starter file, the
    /// current one kept as a backup.
    pub fn reset(&mut self, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let requester = self.host.read(cx).requester();
        let work = async move {
            let make = |state: &host_protocol::MemoryState| {
                Some(MemoryMutateInput::Reset { expected_revision: state.revision.clone() })
            };
            memory_store::write(&requester, make, locale).await
        };
        let done = move |this: &mut Self, _: &mut Window, _: &mut Context<Self>| {
            let line = titled(
                locale,
                copy::RESET_DONE.in_locale(locale),
                copy::RESET_DONE_DETAIL.in_locale(locale),
            );
            this.say(DOCUMENT, StatusKind::Info, line);
        };
        self.run(Pending::Reset, DOCUMENT, copy::RESET_FAILED, work, true, done, cx);
    }

    /// A backup's line: its kind, what it holds, and when.
    fn backup_label(&self, backup: &MemoryBackup, locale: Locale) -> String {
        let summary = if backup.safe_mode {
            copy::BACKUP_OVERSIZE.in_locale(locale).to_owned()
        } else {
            copy::entries_summary(locale, backup.active_entry_count, backup.archived_entry_count)
        };
        let when = ago(locale, backup.updated_at, self.utc_offset);
        format!("{} · {summary} · {when}", backup_kind_label(&backup.kind).in_locale(locale))
    }

    /// Restore: asks, then puts the backup `kind` back (the current file is
    /// kept as the restore backup).
    pub fn confirm_restore(
        &mut self,
        kind: MemoryBackupKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let Some(backup) =
            self.snapshot.as_ref().and_then(|s| s.backups().into_iter().find(|b| b.kind == kind))
        else {
            return;
        };
        if self.pending.is_some() || window.has_active_dialog(cx) {
            return;
        }
        let label = self.backup_label(&backup, locale);
        let page = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let page = page.clone();
            let kind = kind.clone();
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(copy::RESTORE_CANDIDATE_TITLE.get(cx)))
                .description(shared::dialog::confirmation_text(copy::labeled(
                    locale,
                    copy::RESTORE_CANDIDATE_DESCRIPTION,
                    &label,
                )))
                .footer(shared::dialog::confirmation_answers(
                    copy::CANCEL.get(cx),
                    copy::CONFIRM_RESTORE.get(cx),
                    true,
                    cx,
                ))
                .on_ok(move |_, _, cx| {
                    let kind = kind.clone();
                    page.update(cx, |page, cx| page.restore(kind, cx)).ok();
                    true
                })
        });
    }

    fn restore(&mut self, kind: MemoryBackupKind, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let requester = self.host.read(cx).requester();
        let label = self
            .snapshot
            .as_ref()
            .and_then(|s| s.backups().into_iter().find(|b| b.kind == kind))
            .map(|backup| self.backup_label(&backup, locale))
            .unwrap_or_default();
        let wanted = kind.clone();
        let work = async move {
            let make = |state: &host_protocol::MemoryState| {
                let backup = state.backups.iter().find(|backup| backup.kind == wanted)?;
                Some(MemoryMutateInput::RestoreBackup {
                    expected_revision: state.revision.clone(),
                    backup_kind: wanted.clone(),
                    expected_backup_revision: backup.revision.clone(),
                })
            };
            memory_store::write(&requester, make, locale).await
        };
        let done = move |this: &mut Self, _: &mut Window, _: &mut Context<Self>| {
            let what = touched(locale, copy::RESTORED_CANDIDATE, &label);
            let line = titled(locale, &what, copy::RESTORED_DETAIL.in_locale(locale));
            this.say(DOCUMENT, StatusKind::Info, line);
        };
        self.run(Pending::Restore(kind), DOCUMENT, copy::RESTORE_FAILED, work, true, done, cx);
    }

    /// Opens `name` in the memory directory (or the directory itself) with
    /// the system, once it is found to be a file there (a directory for the
    /// folder), as Desktop's `openMemoryPath` checks.
    pub fn open(&mut self, name: Option<&'static str>, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let dir = self.memory_dir(cx);
        let path = name.map_or_else(|| dir.clone(), |name| dir.join(name));
        let check = path.clone();
        let found = cx.background_spawn(async move {
            match std::fs::metadata(&check) {
                Ok(meta) if name.is_none() && meta.is_dir() => Ok(()),
                Ok(meta) if name.is_some() && meta.is_file() => Ok(()),
                Ok(_) => Err(copy::RESULT_NOT_REGULAR_FILE),
                Err(_) => Err(copy::RESULT_FILE_NOT_FOUND),
            }
        });
        let opener = self.opener.clone();
        self.pending = Some(Pending::Open);
        self.feedback.remove(DOCUMENT);
        self._action = Some(cx.spawn(async move |this, cx| {
            let found = found.await;
            this.update(cx, |this, cx| {
                this._action = None;
                this.pending = None;
                match found {
                    Ok(()) => opener(&path, cx),
                    Err(why) => {
                        let line = titled(
                            locale,
                            copy::OPEN_FAILED.in_locale(locale),
                            why.in_locale(locale),
                        );
                        this.say(DOCUMENT, StatusKind::Error, line);
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn copy_path(&mut self, cx: &mut Context<Self>) {
        let path = self.memory_dir(cx).join(MEMORY_FILE).display().to_string();
        cx.write_to_clipboard(ClipboardItem::new_string(path.clone()));
        let locale = Locale::current(cx);
        self.say(DOCUMENT, StatusKind::Info, touched(locale, copy::PATH_COPIED, &path));
        cx.notify();
    }

    fn copy_context(&mut self, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.say(DOCUMENT, StatusKind::Info, copy::PROMPT_COPIED.get(cx));
        cx.notify();
    }

    /// What the switch row's status says (Desktop's `memoryStatuses`).
    fn access_status(&self, enabled: bool, incognito: bool) -> (Text, Tone) {
        if self.load_error.is_some() && self.snapshot.is_none() {
            return (copy::STATUS_ERROR, Tone::Error);
        }
        match self.snapshot.as_ref().map(|snapshot| snapshot.access) {
            _ if !enabled => (copy::STATUS_DISABLED, Tone::Neutral),
            _ if incognito => (copy::STATUS_INCOGNITO, Tone::Attention),
            Some(MemoryAccess::SafeMode) => (copy::STATUS_SAFE_MODE, Tone::Attention),
            _ => (copy::STATUS_OK, Tone::Success),
        }
    }

    fn line(&self, area: &'static str) -> Option<StatusLine> {
        self.feedback.get(area).map(|(kind, line)| StatusLine::new(area, *kind, line.clone()))
    }
}

/// "Memory added: Preference": an action's words and what it touched.
fn touched(locale: Locale, what: Text, detail: &str) -> String {
    shared::copy::labeled(locale, what.in_locale(locale), detail)
}

impl MemoryPage {
    fn render_switches(
        &self,
        memory: MemoryPolicy,
        incognito: bool,
        editable: bool,
        cx: &mut Context<Self>,
    ) -> SettingsGroup {
        let (label, tone) = self.access_status(memory.enabled, incognito);
        let page = cx.weak_entity();
        let enable = {
            let (checked, disabled) = (memory.enabled, !editable);
            FadedSwitch::new(
                Switch::new(domain_element_id("settings-toggle", "memory-enabled"))
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(copy::ENABLE_LOCAL_FILE.get(cx))
                    .on_change(move |on, _, cx| {
                        page.update(cx, |page, cx| page.set_enabled(*on, cx)).ok();
                    }),
                checked,
                disabled,
            )
        };
        let page = cx.weak_entity();
        let agent_read = {
            let (checked, disabled) = (memory.agent_read_enabled, !editable || !memory.enabled);
            FadedSwitch::new(
                Switch::new(domain_element_id("settings-toggle", "memory-agent-read"))
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(copy::ENABLE_AGENT_READ.get(cx))
                    .on_change(move |on, _, cx| {
                        page.update(cx, |page, cx| page.set_agent_read(*on, cx)).ok();
                    }),
                checked,
                disabled,
            )
        };
        let status = self.load_error.clone().filter(|_| self.snapshot.is_none()).map(|error| {
            let this = cx.weak_entity();
            let retry = settings_button("memory-retry", shared::copy::settings::RETRY.get(cx), cx)
                .on_click(move |_, _, cx| {
                    this.update(cx, |this, cx| this.load(false, cx)).ok();
                });
            StatusLine::error("memory-load", error).action(retry)
        });
        SettingsGroup::new("memory-sources")
            .title(copy::SOURCES_TITLE.get(cx))
            .description(copy::SOURCES_HELP.get(cx))
            .child(
                SettingsRow::new("memory-enabled", copy::LOCAL_FILE.get(cx))
                    .detail(copy::LOCAL_FILE_HELP.get(cx))
                    .end(
                        h_flex()
                            .items_center()
                            .gap_3()
                            .child(status_dot("memory", label.get(cx), tone, cx))
                            .child(enable),
                    )
                    .status(status),
            )
            .child(
                SettingsRow::new("memory-agent-read", copy::AGENT_READABLE.get(cx))
                    .detail(copy::AGENT_READABLE_HELP.get(cx))
                    .end(agent_read)
                    .status(self.line(SWITCHES)),
            )
    }

    fn render_entries(&self, blocked: bool, cx: &mut Context<Self>) -> SettingsGroup {
        let locale = Locale::current(cx);
        let adding = self.pending == Some(Pending::Add);
        let add = settings_button("memory-add", copy::MANUAL_ADD.get(cx), cx)
            .toggled(self.add_open)
            .disabled(blocked)
            .on_click(cx.listener(|this, _, window, cx| this.toggle_add(window, cx)));
        let mut group = SettingsGroup::new("memory-entries")
            .title(copy::ENTRIES.get(cx))
            .description(copy::ENTRIES_HELP.get(cx))
            .action(add);
        if self.add_open {
            let submit = control_button(Button::new("memory-add-submit").primary())
                .label(if adding { copy::ADDING } else { copy::ADD_ENTRY }.get(cx))
                .loading(adding)
                .disabled(blocked)
                .on_click(cx.listener(|this, _, _, cx| this.add_entry(cx)));
            let cancel = quiet_button(Button::new("memory-add-cancel"), cx)
                .label(copy::CANCEL.get(cx))
                .on_click(cx.listener(|this, _, window, cx| this.cancel_add(window, cx)));
            // Desktop's manual add stacks its two fields.
            group = group
                .field(
                    FieldBlock::new("memory-add-title").field(
                        copy::ENTRY_TITLE.get(cx),
                        Input::new(&self.title)
                            .field_fill(cx)
                            .id("memory-add-title")
                            .aria_label(copy::ENTRY_TITLE.get(cx))
                            .disabled(blocked),
                    ),
                )
                .field(
                    FieldBlock::new("memory-add")
                        .field(
                            copy::ENTRY_CONTENT.get(cx),
                            div().id("memory-add-content").test_support().w_full().child(
                                Textarea::new(&self.content)
                                    .field_fill(cx)
                                    .aria_label(copy::ENTRY_CONTENT.get(cx))
                                    .disabled(blocked),
                            ),
                        )
                        .help(copy::MANUAL_ADD_HELP.get(cx))
                        .action(submit)
                        .action(cancel),
                );
        }
        group = group.children(self.line(ENTRIES).map(|line| div().py_2().child(line)));
        let Some(snapshot) = self.snapshot.as_deref() else {
            return group;
        };
        let total = snapshot.active.len() + snapshot.archived.len();
        if total == 0 {
            return group.child(empty_state(
                "memory-entries",
                Icon::new(gpui_kit::assets::IconName::Brain),
                copy::WAITING_ENTRY.get(cx),
                Some(copy::WAITING_ENTRY_HELP.get(cx).into()),
                None,
                cx,
            ));
        }
        let query = self.filter.read(cx).value().trim().to_lowercase();
        let keep = |entries: &[MemoryEntry]| -> Vec<MemoryEntry> {
            entries
                .iter()
                .filter(|entry| query.is_empty() || matches(entry, &query, locale))
                .cloned()
                .collect()
        };
        let (active, archived) = (keep(&snapshot.active), keep(&snapshot.archived));
        // The lists' sub-headers count the entries; beside the filter only
        // the matches, while it filters.
        let count = (!query.is_empty())
            .then(|| copy::match_count(locale, active.len() + archived.len(), total));
        let muted = cx.maka().ink_muted;
        group = group.child(
            h_flex()
                .id("memory-filter")
                .test_support()
                .w_full()
                .py_2()
                .gap_3()
                .child(div().flex_1().min_w_0().child(filter_field(
                    &self.filter,
                    "memory-filter-field",
                    copy::FILTER_LABEL.get(cx),
                    cx,
                )))
                .children(count.map(|count| {
                    div()
                        .id("memory-filter-count")
                        .test_support()
                        .aria_label(SharedString::from(count.clone()))
                        .flex_shrink_0()
                        .text_xs()
                        .text_color(muted)
                        .child(count)
                })),
        );
        if !query.is_empty() && active.is_empty() && archived.is_empty() {
            let clear = settings_button("memory-filter-empty-clear", copy::CLEAR.get(cx), cx)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.filter.update(cx, |input, cx| input.set_value("", window, cx));
                    cx.notify();
                }));
            return group.child(empty_state(
                "memory-filter",
                Icon::new(MakaIcon::Search),
                copy::FILTER_EMPTY.get(cx),
                Some(copy::FILTER_EMPTY_HELP.get(cx).into()),
                Some(clear.into_any_element()),
                cx,
            ));
        }
        let filtered = !query.is_empty();
        group = self.render_list(
            group,
            "memory-active",
            copy::ACTIVE_MEMORIES,
            &active,
            false,
            filtered,
            blocked,
            cx,
        );
        if !snapshot.archived.is_empty() {
            group = self.render_list(
                group,
                "memory-archived",
                copy::ARCHIVED_MEMORIES,
                &archived,
                true,
                filtered,
                blocked,
                cx,
            );
        }
        group
    }

    #[allow(clippy::too_many_arguments)]
    fn render_list(
        &self,
        group: SettingsGroup,
        key: &'static str,
        title: Text,
        entries: &[MemoryEntry],
        archived: bool,
        filtered: bool,
        blocked: bool,
        cx: &mut Context<Self>,
    ) -> SettingsGroup {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        // The active list's sub-header goes on from the filter above it
        // with no rule of its own (the filter's 8 and its 8, 16 apart); the
        // archived list's follows the last entry's rule, 12 under it.
        let follows_filter = !archived;
        let header = h_flex()
            .id(domain_element_id("memory-list", key))
            .test_support()
            .aria_label(title.get(cx))
            .w_full()
            .map(|this| if follows_filter { this.pt_2() } else { this.pt_3() })
            .pb_1()
            .justify_between()
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .text_color(maka.ink)
                    .child(title.get(cx)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(copy::entry_count(locale, entries.len())),
            );
        let mut group = if follows_filter { group.follow(header) } else { group.child(header) };
        if entries.is_empty() {
            let empty = if filtered { copy::NO_MATCH_ENTRY } else { copy::NO_ENTRY };
            return group
                .child(div().py_2().text_xs().text_color(maka.ink_muted).child(empty.get(cx)));
        }
        for entry in entries {
            group = group.child(self.render_entry(entry, archived, blocked, cx));
        }
        group
    }

    fn render_entry(
        &self,
        entry: &MemoryEntry,
        archived: bool,
        blocked: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let origin = origin_label(&entry.source).in_locale(locale);
        let meta = if entry.tags.is_empty() {
            origin.to_owned()
        } else {
            format!("{origin} · {}", entry.tags.join(" / "))
        };
        let short: String = if entry.title.chars().count() > 80 {
            format!("{}…", entry.title.chars().take(79).collect::<String>())
        } else {
            entry.title.clone()
        };
        let context = entry
            .created_at
            .or(entry.updated_at)
            .map(|ms| shared::time::absolute_time(locale, ms, self.utc_offset))
            .unwrap_or_else(|| {
                entry
                    .content
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(48)
                    .collect()
            });
        let identity = [short.as_str(), origin, context.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let action = if archived { copy::RESTORE_ACTION } else { copy::ARCHIVE_ACTION };
        let busy = self.pending == Some(Pending::Entry(entry.id.clone()));
        let status_entry = entry.clone();
        // Desktop's entry actions are ghost sm buttons: 28 tall, 8 apart.
        let toggle = control_button(
            Button::new(domain_element_id("memory-entry-status", &entry.id)).ghost(),
        )
        .h_7()
        .label(action.get(cx))
        .accessibility_label(copy::entry_action(locale, action, &identity))
        .loading(busy)
        .disabled(blocked)
        .on_click(
            cx.listener(move |this, _, _, cx| this.set_archived(&status_entry, !archived, cx)),
        );
        let copied = entry.clone();
        let reference =
            control_button(Button::new(domain_element_id("memory-entry-copy", &entry.id)).ghost())
                .h_7()
                .label(copy::COPY_REFERENCE.get(cx))
                .accessibility_label(copy::entry_action(locale, copy::COPY_REFERENCE, &identity))
                .on_click(
                    cx.listener(move |this, _, _, cx| this.copy_entry_reference(&copied, cx)),
                );
        let updated =
            entry.updated_at.map(|ms| copy::updated(locale, &ago(locale, ms, self.utc_offset)));
        let source = match updated {
            Some(updated) => format!("{meta} · {updated}"),
            None => meta,
        };
        // Desktop's memory row: the entry on the left (title 14/500, its
        // source 12 muted, the text 14 muted in at most two lines), the
        // actions in the trailing lane, centred on the row.
        h_flex()
            .id(domain_element_id("memory-entry", &entry.id))
            .test_support()
            .aria_label(SharedString::from(entry.title.clone()))
            .w_full()
            .py_2()
            .gap_4()
            .items_center()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(maka.ink)
                            .child(entry.title.clone()),
                    )
                    .child(div().truncate().text_xs().text_color(maka.ink_muted).child(source))
                    .child(
                        div()
                            .text_sm()
                            .line_clamp(2)
                            .text_color(maka.ink_muted)
                            .child(entry.content.clone()),
                    ),
            )
            .child(h_flex().flex_shrink_0().gap_2().child(toggle).child(reference))
            .into_any_element()
    }

    fn render_document(&self, enabled: bool, cx: &mut Context<Self>) -> SettingsGroup {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let details = settings_button(
            "memory-details",
            if self.details_open { copy::HIDE_DETAILS } else { copy::SHOW_DETAILS }.get(cx),
            cx,
        )
        .toggled(self.details_open)
        .on_click(cx.listener(|this, _, _, cx| {
            this.details_open = !this.details_open;
            cx.notify();
        }));
        let group = SettingsGroup::new("memory-document")
            .title(copy::DOCUMENT.get(cx))
            .description(copy::DOCUMENT_HELP.get(cx))
            .action(details);
        if !self.details_open {
            return group;
        }
        let busy = self.pending.is_some() || self.loading && self.snapshot.is_none();
        let usable = enabled && self.host.read(cx).is_connected();
        let backups = self.snapshot.as_ref().map(|s| s.backups()).unwrap_or_default();
        let latest = backups.first().map(|backup| self.backup_label(backup, locale));
        let dirty = self.dirty(cx);
        // A remote Host's memory files are on its machine: this one can
        // neither show their folder nor open them.
        let local = !self.host.read(cx).is_remote();
        let path = self.memory_dir(cx).join(MEMORY_FILE);
        // The file's name as the title; on this machine its path under it
        // as a mono value (review round 10).
        let file = if local {
            SettingsRow::path("memory-file", MEMORY_FILE, display_path(&path))
        } else {
            SettingsRow::new("memory-file", MEMORY_FILE)
        };
        // The draft's state is a trailing label: centred on the row.
        let file = file
            .detail(latest.unwrap_or_else(|| copy::WAITING_BACKUP.get(cx).to_owned()))
            .centred()
            .end(
                div()
                    .id("memory-dirty")
                    .test_support()
                    .aria_label(if dirty { copy::DIRTY } else { copy::SAVED_DRAFT }.get(cx))
                    .text_xs()
                    .text_color(if dirty { maka.warning } else { maka.ink_muted })
                    .child(if dirty { copy::DIRTY } else { copy::SAVED_DRAFT }.get(cx)),
            );
        let candidates = (!backups.is_empty()).then(|| {
            let rows = backups.iter().map(|backup| {
                let label = self.backup_label(backup, locale);
                let kind = backup.kind.clone();
                let file = backup_file(&backup.kind);
                let restoring = self.pending == Some(Pending::Restore(backup.kind.clone()));
                let open = quiet_button(
                    Button::new(domain_element_id("memory-backup-open", kind.as_str())),
                    cx,
                )
                .label(copy::OPEN.get(cx))
                .accessibility_label(copy::labeled(locale, copy::OPEN_BACKUP_LABEL, &label))
                .disabled(busy || !usable)
                .on_click(cx.listener(move |this, _, _, cx| this.open(Some(file), cx)));
                let restore = quiet_button(
                    Button::new(domain_element_id("memory-backup-restore", kind.as_str())),
                    cx,
                )
                .label(if restoring { copy::RESTORING } else { copy::RESTORE }.get(cx))
                .accessibility_label(copy::labeled(locale, copy::RESTORE_BACKUP_LABEL, &label))
                .loading(restoring)
                .disabled(busy || !usable)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.confirm_restore(kind.clone(), window, cx)
                }));
                h_flex()
                    .id(domain_element_id("memory-backup", backup.kind.as_str()))
                    .test_support()
                    .aria_label(SharedString::from(label.clone()))
                    .w_full()
                    .gap_2()
                    .child(div().flex_1().min_w_0().text_xs().text_color(maka.ink).child(label))
                    .children(local.then_some(open))
                    .child(restore)
            });
            v_flex()
                .id("memory-backups")
                .test_support()
                .aria_label(copy::BACKUP_CANDIDATES.get(cx))
                .w_full()
                .py_2()
                .gap_1()
                .child(
                    div()
                        .text_sm()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(maka.ink)
                        .child(copy::BACKUP_CANDIDATES.get(cx)),
                )
                .children(rows)
                .child(div().text_xs().text_color(maka.ink_muted).child(copy::BACKUP_HELP.get(cx)))
        });
        let editor = FieldBlock::new("memory-editor").field(
            copy::FILE_CONTENT.get(cx),
            div().id("memory-editor-field").test_support().w_full().child(
                Textarea::new(&self.editor)
                    .field_fill(cx)
                    .aria_label(copy::FILE_CONTENT.get(cx))
                    .disabled(busy || !usable)
                    .font_family(cx.theme().mono_font_family.clone()),
            ),
        );
        let reason = self.snapshot.as_ref().and_then(|snapshot| match snapshot.access {
            MemoryAccess::SafeMode => Some(copy::SAFE_MODE),
            MemoryAccess::Incognito => Some(copy::PROMPT_BLOCKED_INCOGNITO),
            MemoryAccess::Disabled => Some(copy::RESULT_DISABLED),
            MemoryAccess::Ready => None,
        });
        let saving = self.pending == Some(Pending::Save);
        let save = control_button(Button::new("memory-save").primary())
            .label(
                if saving {
                    copy::SAVING
                } else if dirty {
                    copy::SAVE
                } else {
                    copy::SAVED
                }
                .get(cx),
            )
            .loading(saving)
            .disabled(busy || !usable || !dirty)
            .on_click(cx.listener(|this, _, _, cx| this.save(cx)));
        let open = quiet_button(Button::new("memory-open-file"), cx)
            .label(copy::OPEN_FILE.get(cx))
            .disabled(busy || !usable)
            .on_click(cx.listener(|this, _, _, cx| this.open(Some(MEMORY_FILE), cx)));
        let reloading = self.pending == Some(Pending::Reload);
        let reload = quiet_button(Button::new("memory-reload"), cx)
            .label(if reloading { copy::LOADING } else { copy::RELOAD }.get(cx))
            .loading(reloading)
            .disabled(busy || !usable)
            .on_click(cx.listener(|this, _, _, cx| this.reload(cx)));
        let page = cx.weak_entity();
        let menu_enabled = !busy && usable;
        let more = control_button(Button::new("memory-more").ghost())
            .icon(Icon::new(MakaIcon::More).size_4().text_color(cx.maka().ink_muted))
            .accessibility_label(copy::FILE_ACTIONS.get(cx))
            .loading(self.pending == Some(Pending::Reset))
            .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, window, cx| {
                let (folder, path, reset) = (page.clone(), page.clone(), page.clone());
                let menu = menu.min_w(window.rem_size() * 14.);
                let menu = if local {
                    menu.item(
                        PopupMenuItem::new(copy::OPEN_FOLDER.get(cx))
                            .disabled(!menu_enabled)
                            .on_click(move |_, _, cx| {
                                folder.update(cx, |page, cx| page.open(None, cx)).ok();
                            }),
                    )
                    .item(PopupMenuItem::new(copy::COPY_PATH.get(cx)).on_click(move |_, _, cx| {
                        path.update(cx, |page, cx| page.copy_path(cx)).ok();
                    }))
                    .separator()
                } else {
                    menu
                };
                menu.item(
                    PopupMenuItem::new(copy::RESET_BACKUP.get(cx))
                        .disabled(!menu_enabled)
                        .on_click(move |_, _, cx| {
                            reset.update(cx, |page, cx| page.reset(cx)).ok();
                        }),
                )
            });
        group
            .child(file)
            .children(candidates)
            .child(editor)
            .children(
                reason.map(|reason| div().child(StatusLine::info("memory-reason", reason.get(cx)))),
            )
            .child(
                v_flex()
                    .id("memory-file-actions")
                    .test_support()
                    .aria_label(copy::FILE_ACTIONS.get(cx))
                    .w_full()
                    .child(
                        ActionRow::new("memory-file")
                            .child(save)
                            .children(local.then_some(open))
                            .child(reload)
                            .child(more),
                    )
                    .children(self.line(DOCUMENT).map(|line| div().pb_2().child(line))),
            )
    }

    fn render_preview(
        &self,
        memory: MemoryPolicy,
        incognito: bool,
        cx: &mut Context<Self>,
    ) -> SettingsGroup {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let preview = prompt_preview(&self.draft(cx));
        let safe_mode = matches!(preview, PromptPreview::SafeMode)
            || self.snapshot.as_ref().is_some_and(|s| s.access == MemoryAccess::SafeMode);
        let blocked = if !memory.enabled {
            Some(copy::PROMPT_BLOCKED_DISABLED)
        } else if incognito {
            Some(copy::PROMPT_BLOCKED_INCOGNITO)
        } else if safe_mode {
            Some(copy::PROMPT_BLOCKED_SAFE_MODE)
        } else if !memory.agent_read_enabled {
            Some(copy::PROMPT_BLOCKED_AGENT_READ)
        } else {
            None
        };
        let (text, truncated) = match &preview {
            PromptPreview::Body { text, truncated } => {
                let marker = copy::PREVIEW_TRUNCATION_MARKER.in_locale(locale);
                let shown = if *truncated { format!("{text}\n\n{marker}") } else { text.clone() };
                (Some(shown), *truncated)
            }
            _ => (None, false),
        };
        let will_inject = text.is_some() && blocked.is_none();
        let budget = copy::preview_budget(
            locale,
            text.as_ref().map(|text| text.encode_utf16().count()),
            truncated,
            PROMPT_MAX_CHARS,
        );
        let copied = text.clone();
        let copy_button = settings_button("memory-copy-context", copy::COPY_CONTEXT.get(cx), cx)
            .disabled(copied.is_none())
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(text) = copied.clone() {
                    this.copy_context(text, cx);
                }
            }));
        let inject = if will_inject { copy::WILL_INJECT } else { copy::WILL_NOT_INJECT };
        let action = h_flex()
            .items_center()
            .gap_3()
            .child(
                div()
                    .id("memory-inject")
                    .test_support()
                    .aria_label(inject.get(cx))
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(inject.get(cx)),
            )
            .child(copy_button);
        let body: AnyElement = match text {
            Some(text) => div()
                .relative()
                .w_full()
                .child(
                    div()
                        .id("memory-preview")
                        .test_support()
                        .aria_label(SharedString::from(text.clone()))
                        .w_full()
                        .max_h(rems(24.))
                        .overflow_y_scroll()
                        .track_scroll(&self.preview_scroll)
                        .p_3()
                        .rounded(cx.theme().radius)
                        .bg(maka.code)
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_xs()
                        .text_color(maka.ink)
                        .child(text),
                )
                .child(Scrollbar::vertical(&self.preview_scroll))
                .into_any_element(),
            None => div()
                .id("memory-preview-empty")
                .test_support()
                .text_sm()
                .text_color(maka.ink_muted)
                .child(
                    if safe_mode { copy::SAFE_MODE_PREVIEW } else { copy::EMPTY_PROMPT_PREVIEW }
                        .get(cx),
                )
                .into_any_element(),
        };
        SettingsGroup::new("memory-preview")
            .title(copy::PROMPT_PREVIEW.get(cx))
            .description(copy::PROMPT_PREVIEW_HELP.get(cx))
            .action(action)
            .bare()
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        div()
                            .id("memory-preview-budget")
                            .test_support()
                            .aria_label(SharedString::from(budget.clone()))
                            .text_xs()
                            .text_color(maka.ink_muted)
                            .child(budget),
                    )
                    .child(body)
                    .children(blocked.filter(|_| text_is_some(&preview)).map(|reason| {
                        div()
                            .id("memory-preview-blocked")
                            .test_support()
                            .text_xs()
                            .text_color(maka.ink_muted)
                            .child(reason.get(cx))
                    })),
            )
    }
}

fn text_is_some(preview: &PromptPreview) -> bool {
    matches!(preview, PromptPreview::Body { .. })
}

impl Render for MemoryPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status = policy_status(PAGE_KEY, &self.host, &self.policy, cx);
        let connected = self.host.read(cx).is_connected();
        let (policy, unread, policy_saving) = {
            let read = self.policy.read(cx);
            (
                read.policy().map(|policy| (policy.memory, policy.privacy.incognito_active)),
                read.load_error().is_none(),
                read.is_saving(),
            )
        };
        let Some((memory, incognito)) = policy else {
            let placeholder = (connected && unread)
                .then(|| SettingsRow::loading("memory-enabled", copy::LOCAL_FILE.get(cx), 6., cx));
            return v_flex().w_full().gap_8().children(status).child(
                SettingsGroup::new("memory-sources")
                    .description(copy::SOURCES_HELP.get(cx))
                    .children(placeholder),
            );
        };
        let controls_disabled = self.pending.is_some() || self.loading && self.snapshot.is_none();
        let editable = connected && self.pending.is_none() && !policy_saving;
        let blocked = controls_disabled || !connected || !memory.enabled || incognito;
        let switches = self.render_switches(memory, incognito, editable, cx);
        let entries = self.render_entries(blocked, cx);
        let document = self.render_document(memory.enabled, cx);
        let preview = self.details_open.then(|| self.render_preview(memory, incognito, cx));
        v_flex()
            .w_full()
            .gap_8()
            .children(status)
            .child(switches)
            .child(entries)
            .child(document)
            .children(preview)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_path_shows_its_last_three_parts() {
        assert_eq!(display_path(Path::new("/a/b/c")), "/a/b/c");
        assert_eq!(
            display_path(Path::new("/Users/me/.maka/memory/MEMORY.md")),
            "…/.maka/memory/MEMORY.md"
        );
    }
}
