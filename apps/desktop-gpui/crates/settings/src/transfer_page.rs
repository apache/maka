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

//! The Import/export tasks page, after Maka Desktop's
//! (apps/desktop/src/renderer/settings/import-tasks-settings-page.tsx and
//! features/session-bundle): import another local agent's conversations
//! (Codex, Claude Code, OpenCode) as tasks, import a `.maka-session` file,
//! or export a task with its subagent conversations to one.
//!
//! The Host reads the agents' directories (`external-session.*`) and the
//! bundle files (`session-bundle.*`); a bundle names a path the platform
//! dialog chose, which the Host reads on its own filesystem, so the page
//! offers bundles only because this window's Host is the local one.
//!
//! Importing one conversation opens the task it became, as Desktop does; a
//! batch of marked ones runs one after another and reports on the page.
//! While a conversation shows as importing (another window's, say) the
//! page reads its window of the catalog again every second.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::Button;
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, PathPromptOptions, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{
    ExternalSessionCatalogItem, ExternalSessionCatalogQuery, ExternalSessionCatalogQueryInput,
    ExternalSessionImport, ExternalSessionImportInput, ExternalSessionImportResult,
    ExternalSessionLimit, ExternalSessionSourceQuery, ExternalSessionSourceQueryInput,
    HostOperationErrorCode, SessionBundleExport, SessionBundleExportInput, SessionBundleImport,
    SessionBundleImportInput, SessionCatalogProjection,
};
use sha2::{Digest as _, Sha256};
use shared::copy::settings as settings_copy;
use shared::copy::tasks as copy;
use shared::copy::{self as shell_copy, Locale, task_title};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, badge, floating_surface, quiet_button, segment, segmented_track,
};
use shared::time::{absolute_time, local_utc_offset};
use workspace::{HostRequestError, HostRequester, HostSession, HostSessionEvent, ProjectSelection};

use crate::archived_page::read_catalog;
use crate::policy::host_error_reason;
use crate::rows::{SettingsGroup, StatusLine, settings_button};

/// The source that is a file, not an agent's directory
/// (`MAKA_BUNDLE_SOURCE_ID`).
pub const BUNDLE_SOURCE: &str = "maka-bundle";

/// A bundle file's extension (`BUNDLE_EXTENSION`).
const BUNDLE_EXTENSION: &str = "maka-session";

/// How long the search waits after the typing stops.
const SEARCH_DEBOUNCE: Duration = Duration::from_millis(250);

/// How often a catalog with a conversation importing is read again
/// (`EXTERNAL_SESSION_IMPORT_POLL_MS`).
const IMPORT_POLL: Duration = Duration::from_secs(1);

/// Catalog windows kept per source, filter and search
/// (`CATALOG_CACHE_LIMIT`).
const CATALOG_CACHE_LIMIT: usize = 24;

/// Supporting text: 12px on 20px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

/// Which half the page shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TransferMode {
    Import,
    Export,
}

/// What the page asks of the settings surface.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TransferEvent {
    /// Show this task: one a conversation became.
    OpenTask(SharedString),
}

/// A source's name: the agent's brand, or the file (`sourceNames`).
fn source_label(adapter: &str, locale: Locale) -> String {
    match adapter {
        "codex" => "Codex".to_owned(),
        "claude-code" => "Claude Code".to_owned(),
        "opencode" => "OpenCode".to_owned(),
        BUNDLE_SOURCE => copy::SOURCE_BUNDLE.in_locale(locale).to_owned(),
        other => other.to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Sources {
    Idle,
    Loading,
    Loaded(Vec<String>),
    Failed(SharedString),
}

/// A window of a source's catalog.
#[derive(Debug, Clone, Default, PartialEq)]
struct Catalog {
    sessions: Vec<ExternalSessionCatalogItem>,
    next_cursor: Option<String>,
}

/// What the catalog shown was read for.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CatalogKey {
    adapter: String,
    include_archived: bool,
    search: String,
}

/// What the last batch can honestly say (`ImportBatchOutcome`).
#[derive(Debug, Clone, Default, PartialEq)]
struct BatchOutcome {
    imported: usize,
    duplicated: usize,
    failed: usize,
    no_model: bool,
    limits: Vec<(String, ExternalSessionLimit)>,
}

/// The page's import activity (`ImportRun`): one at a time.
#[derive(Debug, Clone, PartialEq)]
enum ImportRun {
    Idle { summary: Option<BatchOutcome>, unknown: Vec<String> },
    Single { source_id: String, name: String },
    Batch { done: usize, total: usize, current: Option<String> },
}

/// A bundle action's outcome line.
#[derive(Debug, Clone, PartialEq)]
struct Note {
    ok: bool,
    text: String,
    detail: Option<String>,
}

/// What one import came to.
enum ImportOutcome {
    Imported(String),
    SourceLimit(ExternalSessionLimit),
    NoModel,
    Unreadable,
    /// The command may or may not have run.
    Unknown,
    Failed(String),
}

/// Behavior and presentation owner of the Import/export tasks page.
pub struct TransferPage {
    host: Entity<HostSession>,
    projects: Entity<ProjectSelection>,
    mode: TransferMode,
    sources: Sources,
    source: Option<String>,
    include_archived: bool,
    search: Entity<InputState>,
    /// The search the catalog was asked for.
    searched: String,
    catalog: Catalog,
    catalog_key: Option<CatalogKey>,
    cache: Vec<(CatalogKey, Catalog)>,
    catalog_loading: bool,
    loading_more: bool,
    catalog_error: Option<SharedString>,
    import_error: Option<SharedString>,
    run: ImportRun,
    selection: HashSet<String>,
    generation: u64,
    bundle_busy: bool,
    note: Option<Note>,
    /// Every task of the Host's catalog, for the export half.
    tasks: Option<Vec<SessionCatalogProjection>>,
    tasks_error: Option<SharedString>,
    active: bool,
    _load: Option<Task<()>>,
    _catalog: Option<Task<()>>,
    _poll: Option<Task<()>>,
    _search: Option<Task<()>>,
    _run: Option<Task<()>>,
    _tasks: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for TransferPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferPage")
            .field("mode", &self.mode)
            .field("source", &self.source)
            .field("run", &self.run)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<TransferEvent> for TransferPage {}

impl TransferPage {
    pub fn new(
        host: Entity<HostSession>,
        projects: Entity<ProjectSelection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder(copy::IMPORT_SEARCH_PLACEHOLDER.get(cx))
        });
        let subscriptions = vec![
            cx.subscribe(&search, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.search_changed(cx);
                }
            }),
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if matches!(event, HostSessionEvent::Connected { .. }) && this.active {
                    this.load_sources(cx);
                }
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = copy::IMPORT_SEARCH_PLACEHOLDER.get(cx);
                this.search
                    .update(cx, |search, cx| search.set_placeholder(placeholder, window, cx));
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        Self {
            host,
            projects,
            mode: TransferMode::Import,
            sources: Sources::Idle,
            source: None,
            include_archived: false,
            search,
            searched: String::new(),
            catalog: Catalog::default(),
            catalog_key: None,
            cache: Vec::new(),
            catalog_loading: false,
            loading_more: false,
            catalog_error: None,
            import_error: None,
            run: ImportRun::Idle { summary: None, unknown: Vec::new() },
            selection: HashSet::new(),
            generation: 0,
            bundle_busy: false,
            note: None,
            tasks: None,
            tasks_error: None,
            active: false,
            _load: None,
            _catalog: None,
            _poll: None,
            _search: None,
            _run: None,
            _tasks: None,
            _subscriptions: subscriptions,
        }
    }

    /// The page is shown: reads the sources, and the tasks when exporting.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.active = true;
        self.load_sources(cx);
        if self.mode == TransferMode::Export {
            self.load_tasks(cx);
        }
    }

    pub fn mode(&self) -> TransferMode {
        self.mode
    }

    /// The source shown, by adapter id ([`BUNDLE_SOURCE`] for the file).
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    /// The conversations listed.
    pub fn conversations(&self) -> &[ExternalSessionCatalogItem] {
        &self.catalog.sessions
    }

    /// Whether an import or a bundle action is running.
    pub fn is_busy(&self) -> bool {
        !matches!(self.run, ImportRun::Idle { .. }) || self.bundle_busy
    }

    /// The import's search, while it shows: importing, from a source that
    /// lists tasks (not a bundle), once the sources are read.
    pub fn search_field(&self) -> Option<Entity<InputState>> {
        let shows = self.mode == TransferMode::Import
            && matches!(self.sources, Sources::Loaded(_))
            && self.source.as_deref() != Some(BUNDLE_SOURCE);
        shows.then(|| self.search.clone())
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    pub fn set_mode(&mut self, mode: TransferMode, cx: &mut Context<Self>) {
        if self.mode != mode {
            // The note reports what the other half did.
            self.note = None;
            self.mode = mode;
            if mode == TransferMode::Export {
                self.load_tasks(cx);
            }
            cx.notify();
        }
    }

    /// Reads the installed agents; the first becomes the source, else the
    /// file.
    fn load_sources(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.sources = Sources::Loading;
        self.source = None;
        self.cache.clear();
        self.catalog = Catalog::default();
        self.catalog_key = None;
        self.catalog_error = None;
        self.import_error = None;
        let request = self
            .requester(cx)
            .request::<ExternalSessionSourceQuery>(&ExternalSessionSourceQueryInput::default());
        let locale = Locale::current(cx);
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                match result {
                    Ok(sources) => {
                        let first = sources.adapter_ids.first().cloned();
                        this.sources = Sources::Loaded(sources.adapter_ids);
                        this.select_source(first.unwrap_or_else(|| BUNDLE_SOURCE.to_owned()), cx);
                    }
                    Err(error) => {
                        log::warn!("external-session.source.query failed: {error}");
                        this.sources = Sources::Failed(reason_or(&error, locale).into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Shows `source`, with the catalog read for it.
    pub fn select_source(&mut self, source: String, cx: &mut Context<Self>) {
        self.selection.clear();
        self.source = Some(source);
        self.load_catalog(None, cx);
        cx.notify();
    }

    pub fn set_include_archived(&mut self, include: bool, cx: &mut Context<Self>) {
        if self.include_archived != include {
            self.include_archived = include;
            self.load_catalog(None, cx);
            cx.notify();
        }
    }

    /// The search as the Host takes it: trimmed, or none when empty
    /// (`normalizeExternalSessionQueryText`).
    fn search_text(search: &str) -> Option<String> {
        let search = search.trim();
        (!search.is_empty()).then(|| search.to_owned())
    }

    fn search_changed(&mut self, cx: &mut Context<Self>) {
        let typed = self.search.read(cx).value().to_string();
        if typed == self.searched {
            self._search = None;
            return;
        }
        self._search = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEARCH_DEBOUNCE).await;
            this.update(cx, |this, cx| {
                this.searched = typed;
                this.load_catalog(None, cx);
            })
            .ok();
        }));
    }

    fn key(&self) -> Option<CatalogKey> {
        let adapter = self.source.clone().filter(|source| source != BUNDLE_SOURCE)?;
        Some(CatalogKey {
            adapter,
            include_archived: self.include_archived,
            search: self.searched.clone(),
        })
    }

    /// Reads the catalog's first page, or the page after `cursor`. A
    /// window read before shows at once and is read again whole behind it.
    fn load_catalog(&mut self, cursor: Option<String>, cx: &mut Context<Self>) {
        let Some(key) = self.key() else {
            self._catalog = None;
            self._poll = None;
            return;
        };
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        let append = cursor.is_some();
        let cached = if append { None } else { self.cached(&key) };
        self.catalog_error = None;
        self.import_error = None;
        if append {
            self.loading_more = true;
        } else if let Some(cached) = cached.clone() {
            self.catalog = cached;
            self.catalog_loading = false;
            self.loading_more = false;
        } else {
            self.catalog = Catalog::default();
            self.catalog_loading = true;
        }
        self.catalog_key = Some(key.clone());
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        let minimum = cached.as_ref().map_or(0, |cached| cached.sessions.len());
        let previous = if append { self.catalog.sessions.clone() } else { Vec::new() };
        self._poll = None;
        self._catalog = Some(cx.spawn(async move |this, cx| {
            let result = match cursor {
                Some(cursor) => read_page(&requester, &key, Some(cursor)).await.map(|page| {
                    let mut sessions = previous;
                    sessions.extend(page.sessions);
                    Catalog { sessions, next_cursor: page.next_cursor }
                }),
                None => read_window(&requester, &key, minimum).await,
            };
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.catalog_loading = false;
                this.loading_more = false;
                match result {
                    Ok(catalog) => {
                        this.remember(key, catalog.clone());
                        this.catalog = catalog;
                        this.schedule_poll(cx);
                    }
                    Err(error) => {
                        log::warn!("external-session.catalog.query failed: {error}");
                        this.catalog_error = Some(reason_or(&error, locale).into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn cached(&self, key: &CatalogKey) -> Option<Catalog> {
        self.cache.iter().find(|(cached, _)| cached == key).map(|(_, catalog)| catalog.clone())
    }

    fn remember(&mut self, key: CatalogKey, catalog: Catalog) {
        self.cache.retain(|(cached, _)| *cached != key);
        self.cache.push((key, catalog));
        if self.cache.len() > CATALOG_CACHE_LIMIT {
            self.cache.remove(0);
        }
    }

    /// While a conversation shows as importing and the page is idle, reads
    /// the window again in a second.
    fn schedule_poll(&mut self, cx: &mut Context<Self>) {
        let importing = self.catalog.sessions.iter().any(|s| s.import_state.is_importing);
        let idle = matches!(self.run, ImportRun::Idle { .. });
        if !importing || !idle || self.catalog_loading || self.loading_more {
            self._poll = None;
            return;
        }
        let Some(key) = self.catalog_key.clone() else {
            return;
        };
        let generation = self.generation;
        let requester = self.requester(cx);
        let minimum = self.catalog.sessions.len();
        self._poll = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(IMPORT_POLL).await;
            // Best effort: a failed poll keeps the window and tries again.
            let result = read_window(&requester, &key, minimum).await;
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                if let Ok(catalog) = result {
                    this.remember(key, catalog.clone());
                    this.catalog = catalog;
                }
                this.schedule_poll(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Where an imported task goes: the project new tasks go into, else the
    /// conversation's own folder (the Host's fallback).
    fn import_workspace(&self, cx: &App) -> Option<host_protocol::WorkspaceTarget> {
        self.projects.read(cx).target().map(|target| target.workspace())
    }

    /// Imports one conversation and opens the task it became.
    pub fn import_one(&mut self, source_id: &str, cx: &mut Context<Self>) {
        let Some(adapter) = self.key().map(|key| key.adapter) else {
            return;
        };
        let Some(conversation) =
            self.catalog.sessions.iter().find(|session| session.id == source_id).cloned()
        else {
            return;
        };
        if self.is_busy() || conversation.import_state.is_importing {
            return;
        }
        self.run = ImportRun::Single {
            source_id: conversation.id.clone(),
            name: conversation.name.clone(),
        };
        self.import_error = None;
        self._poll = None;
        let requester = self.requester(cx);
        let workspace = self.import_workspace(cx);
        let locale = Locale::current(cx);
        self._run = Some(cx.spawn(async move |this, cx| {
            let outcome = import(&requester, &adapter, &conversation.id, workspace, locale).await;
            this.update(cx, |this, cx| {
                let mut unknown = Vec::new();
                match outcome {
                    ImportOutcome::Imported(session) => {
                        cx.emit(TransferEvent::OpenTask(session.into()))
                    }
                    ImportOutcome::Unknown => {
                        unknown.push(conversation.name.clone());
                        this.load_catalog(None, cx);
                    }
                    ImportOutcome::NoModel => {
                        this.import_error = Some(copy::IMPORT_NO_MODEL.in_locale(locale).into());
                    }
                    ImportOutcome::Unreadable => {
                        this.import_error = Some(copy::IMPORT_UNREADABLE.in_locale(locale).into());
                    }
                    ImportOutcome::SourceLimit(limit) => {
                        let text = copy::import_limit(locale, limit.kind.as_str(), limit.max);
                        this.import_error = Some(text.into());
                    }
                    ImportOutcome::Failed(reason) => this.import_error = Some(reason.into()),
                }
                this.run = ImportRun::Idle { summary: None, unknown };
                this.schedule_poll(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// The conversations that can be marked: not importing already.
    fn eligible(&self) -> Vec<&ExternalSessionCatalogItem> {
        self.catalog.sessions.iter().filter(|session| !session.import_state.is_importing).collect()
    }

    /// The marked rows still on screen, in the catalog's order.
    fn marked(&self) -> Vec<&ExternalSessionCatalogItem> {
        self.eligible().into_iter().filter(|session| self.selection.contains(&session.id)).collect()
    }

    pub fn set_marked(&mut self, source_id: &str, marked: bool, cx: &mut Context<Self>) {
        if marked {
            self.selection.insert(source_id.to_owned());
        } else {
            self.selection.remove(source_id);
        }
        cx.notify();
    }

    pub fn set_all_marked(&mut self, marked: bool, cx: &mut Context<Self>) {
        self.selection = if marked {
            self.eligible().into_iter().map(|session| session.id.clone()).collect()
        } else {
            HashSet::new()
        };
        cx.notify();
    }

    /// Imports the marked conversations one after another and reports on
    /// the page (`importSelected`).
    pub fn import_marked(&mut self, cx: &mut Context<Self>) {
        let Some(adapter) = self.key().map(|key| key.adapter) else {
            return;
        };
        if self.is_busy() {
            return;
        }
        let targets: Vec<ExternalSessionCatalogItem> = self.marked().into_iter().cloned().collect();
        if targets.is_empty() {
            return;
        }
        self.import_error = None;
        self._poll = None;
        self.run = ImportRun::Batch {
            done: 0,
            total: targets.len(),
            current: targets.first().map(|target| target.id.clone()),
        };
        let requester = self.requester(cx);
        let workspace = self.import_workspace(cx);
        let locale = Locale::current(cx);
        self._run = Some(cx.spawn(async move |this, cx| {
            let mut outcome = BatchOutcome::default();
            let mut unknown = Vec::new();
            for (ix, target) in targets.iter().enumerate() {
                let was_imported = target.import_state.imported_count > 0;
                match import(&requester, &adapter, &target.id, workspace.clone(), locale).await {
                    ImportOutcome::Imported(_) => {
                        outcome.imported += 1;
                        if was_imported {
                            outcome.duplicated += 1;
                        }
                    }
                    ImportOutcome::Unknown => unknown.push(target.name.clone()),
                    ImportOutcome::NoModel => {
                        outcome.failed += 1;
                        outcome.no_model = true;
                    }
                    ImportOutcome::SourceLimit(limit) => {
                        outcome.failed += 1;
                        outcome.limits.push((target.name.clone(), limit));
                    }
                    ImportOutcome::Unreadable | ImportOutcome::Failed(_) => outcome.failed += 1,
                }
                let next = targets.get(ix + 1).map(|target| target.id.clone());
                let total = targets.len();
                let still = this.update(cx, |this, cx| {
                    this.run = ImportRun::Batch { done: ix + 1, total, current: next };
                    cx.notify();
                });
                if still.is_err() {
                    return;
                }
            }
            this.update(cx, |this, cx| {
                this.run = ImportRun::Idle { summary: Some(outcome), unknown };
                // Answered: marks left would invite importing them twice.
                this.selection.clear();
                this.load_catalog(None, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Picks a `.maka-session` file and merges it into this workspace.
    pub fn import_bundle(&mut self, cx: &mut Context<Self>) {
        if self.is_busy() {
            return;
        }
        self.bundle_busy = true;
        self.note = None;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(copy::IMPORT.get(cx).into()),
        });
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        self._run = Some(cx.spawn(async move |this, cx| {
            let picked = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    log::warn!("the file dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let note = match picked {
                None => None,
                Some(path) => {
                    let input = SessionBundleImportInput::new(path.display().to_string());
                    Some(match requester.request::<SessionBundleImport>(&input).await {
                        Ok(result) => Note {
                            ok: true,
                            text: copy::bundle_imported(locale, result.session_count),
                            detail: None,
                        },
                        Err(error) => bundle_failure(&error, locale),
                    })
                }
            };
            this.update(cx, |this, cx| {
                this.bundle_busy = false;
                this.note = note;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Reads the Host's tasks for the export half.
    fn load_tasks(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        self._tasks = Some(cx.spawn(async move |this, cx| {
            let result = read_catalog(&requester).await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(tasks) => {
                        this.tasks = Some(tasks);
                        this.tasks_error = None;
                    }
                    Err(error) => {
                        log::warn!("session.catalog.query failed: {error}");
                        this.tasks_error = Some(host_error_reason(&error, locale).into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Exports task `id`, asking first when subagent conversations come
    /// along: the row names one task and the file holds several.
    pub fn ask_export(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tasks) = self.tasks.as_ref() else {
            return;
        };
        let Some(task) = tasks.iter().find(|task| task.id == id) else {
            return;
        };
        if self.is_busy() {
            return;
        }
        let subtree = whole_subtree(tasks, id);
        let name = task_title(Locale::current(cx), &task.name).to_owned();
        let carried = subtree.len() - 1;
        if carried == 0 {
            self.export(id.to_owned(), name, subtree, cx);
            return;
        }
        let locale = Locale::current(cx);
        let page = cx.entity();
        let id = id.to_owned();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (page, id, name, subtree) =
                (page.clone(), id.clone(), name.clone(), subtree.clone());
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(copy::export_confirm(locale, carried)))
                .description(shared::dialog::confirmation_text(
                    copy::EXPORT_CONFIRM_BODY.in_locale(locale),
                ))
                .footer(shared::dialog::confirmation_answers(
                    shell_copy::CANCEL.in_locale(locale),
                    copy::EXPORT.in_locale(locale),
                    false,
                    cx,
                ))
                .on_ok(move |_, _, cx| {
                    let (id, name, subtree) = (id.clone(), name.clone(), subtree.clone());
                    page.update(cx, |page, cx| page.export(id, name, subtree, cx));
                    true
                })
        });
    }

    /// Picks the file and writes the task with its confirmed subtree.
    fn export(&mut self, id: String, name: String, subtree: Vec<String>, cx: &mut Context<Self>) {
        if self.is_busy() {
            return;
        }
        self.bundle_busy = true;
        self.note = None;
        let directory = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let suggested = format!("{}.{BUNDLE_EXTENSION}", bundle_file_name(&name));
        let path = cx.prompt_for_new_path(&directory, Some(&suggested));
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        self._run = Some(cx.spawn(async move |this, cx| {
            let picked = match path.await {
                Ok(Ok(Some(path))) => Some(path),
                Ok(Err(error)) => {
                    log::warn!("the save dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let note = match picked {
                None => None,
                Some(path) => {
                    let input = SessionBundleExportInput::new(
                        id,
                        path.display().to_string(),
                        Some(subtree_digest(&subtree)),
                    );
                    Some(match requester.request::<SessionBundleExport>(&input).await {
                        Ok(result) => Note {
                            ok: true,
                            text: copy::exported(locale, result.session_count),
                            detail: None,
                        },
                        Err(error) => bundle_failure(&error, locale),
                    })
                }
            };
            this.update(cx, |this, cx| {
                this.bundle_busy = false;
                this.note = note;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn render_mode(&self, cx: &mut Context<Self>) -> AnyElement {
        let choices = [
            (TransferMode::Import, "import", copy::TRANSFER_IMPORT),
            (TransferMode::Export, "export", copy::TRANSFER_EXPORT),
        ];
        // Desktop's `SegmentedControl layout="fill" size="sm"`: the
        // column's width, its segments equal.
        segmented_track(cx)
            .id("transfer-mode")
            .test_support()
            .aria_label(copy::TRANSFER_MODE.get(cx))
            .w_full()
            .children(choices.map(|(mode, key, label)| {
                let button = Button::new(domain_element_id("transfer-mode", key));
                segment(button, label.get(cx), self.mode == mode, cx)
                    .on_click(cx.listener(move |this, _, _, cx| this.set_mode(mode, cx)))
            }))
            .into_any_element()
    }

    fn render_note(&self) -> Option<StatusLine> {
        let note = self.note.as_ref()?;
        let text = match &note.detail {
            Some(detail) => format!("{} {detail}", note.text),
            None => note.text.clone(),
        };
        Some(if note.ok {
            StatusLine::info("transfer-note", text)
        } else {
            StatusLine::error("transfer-note", text)
        })
    }

    fn render_sources(&self, sources: &[String], cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let mut ids: Vec<String> = sources.to_vec();
        ids.push(BUNDLE_SOURCE.to_owned());
        let current = self.source.clone().unwrap_or_default();
        let single = ids.len() == 1;
        let mut group = SettingsGroup::new("transfer-source").bare();
        if single {
            // One source is a fact, not a choice: Desktop's section names
            // it under its title, then goes straight on.
            group = group.title(copy::SOURCE.get(cx)).description(source_label(&current, locale));
        } else {
            // Desktop's source control is the mode's recipe: fill, small.
            group = group.title(copy::SOURCE.get(cx)).child(
                segmented_track(cx)
                    .id("transfer-source")
                    .test_support()
                    .aria_label(copy::SOURCE.get(cx))
                    .w_full()
                    .children(ids.iter().map(|id| {
                        let button = Button::new(domain_element_id("transfer-source", id));
                        let chosen = id.clone();
                        segment(button, &source_label(id, locale), *id == current, cx)
                            .disabled(self.catalog_loading || self.is_busy())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_source(chosen.clone(), cx)
                            }))
                    })),
            );
        }
        if current == BUNDLE_SOURCE {
            let choose = settings_button("transfer-bundle-import", copy::BUNDLE_CHOOSE.get(cx), cx)
                .loading(self.bundle_busy)
                .disabled(self.is_busy() || !self.host.read(cx).is_connected())
                .on_click(cx.listener(|this, _, _, cx| this.import_bundle(cx)));
            group = group
                .children(self.render_note())
                .child(supporting(copy::BUNDLE_IMPORT_HELP.get(cx), cx.maka().ink_muted))
                .child(h_flex().child(choose));
        } else {
            let this = cx.weak_entity();
            let archived = Checkbox::new("transfer-include-archived")
                .label(copy::INCLUDE_ARCHIVED.get(cx))
                // The row text size; the kit's medium label is 16px.
                .text_sm()
                .checked(self.include_archived)
                .disabled(self.catalog_loading)
                .on_click(move |checked, _, cx| {
                    this.update(cx, |this, cx| this.set_include_archived(*checked, cx)).ok();
                });
            group = group
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(gpui_kit::FontWeight::MEDIUM)
                                .text_color(cx.maka().ink_muted)
                                .child(copy::IMPORT_SEARCH.get(cx)),
                        )
                        .child(
                            Input::new(&self.search)
                                .field_fill(cx)
                                .id("transfer-search")
                                .aria_label(copy::IMPORT_SEARCH.get(cx))
                                .cleanable(true),
                        )
                        .child(supporting(copy::IMPORT_SEARCH_HELP.get(cx), cx.maka().ink_muted)),
                )
                .child(archived);
        }
        group.into_any_element()
    }

    fn render_catalog(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let mut lines: Vec<AnyElement> = Vec::new();
        if let Some(error) = &self.catalog_error {
            let retry = settings_button("transfer-catalog-retry", settings_copy::RETRY.get(cx), cx)
                .on_click(cx.listener(|this, _, _, cx| this.load_catalog(None, cx)));
            let message = shell_copy::phrases(locale, copy::IMPORT_LOAD_FAILED.get(cx), error);
            lines.push(
                StatusLine::error("transfer-catalog", message).action(retry).into_any_element(),
            );
        }
        if let Some(error) = &self.import_error {
            let message = shell_copy::phrases(locale, copy::IMPORT_FAILED.get(cx), error);
            lines.push(StatusLine::error("transfer-import", message).into_any_element());
        }
        match &self.run {
            ImportRun::Single { name, .. } => {
                let message = shell_copy::phrases(
                    locale,
                    copy::IMPORT_IN_PROGRESS.get(cx),
                    &copy::named(copy::IMPORT_IN_PROGRESS_HELP, locale, name),
                );
                lines.push(StatusLine::info("transfer-run", message).into_any_element());
            }
            ImportRun::Batch { done, total, .. } => {
                let message = shell_copy::phrases(
                    locale,
                    copy::IMPORT_IN_PROGRESS.get(cx),
                    &copy::batch_progress(locale, *done, *total),
                );
                lines.push(StatusLine::info("transfer-run", message).into_any_element());
            }
            ImportRun::Idle { summary, unknown } => {
                if let Some(summary) = summary {
                    lines.push(render_summary(summary, locale).into_any_element());
                }
                if !unknown.is_empty() {
                    let message = shell_copy::phrases(
                        locale,
                        copy::IMPORT_UNKNOWN_OUTCOME.get(cx),
                        &copy::unknown_outcome(locale, unknown),
                    );
                    lines.push(StatusLine::error("transfer-unknown", message).into_any_element());
                }
            }
        }
        let mut body: Vec<AnyElement> = Vec::new();
        if self.catalog_loading {
            body.push(
                h_flex()
                    .id("transfer-loading")
                    .test_support()
                    .gap_2()
                    .py_4()
                    .text_sm()
                    .text_color(maka.ink_muted)
                    .child(Spinner::new().small())
                    .child(copy::IMPORT_LOADING.get(cx))
                    .into_any_element(),
            );
        }
        let empty = !self.catalog_loading
            && self.catalog_error.is_none()
            && self.catalog.sessions.is_empty();
        if empty {
            let (title, help) = match Self::search_text(&self.searched) {
                Some(term) => {
                    (copy::IMPORT_SEARCH.get(cx).to_owned(), copy::search_empty(locale, &term))
                }
                None => (
                    copy::IMPORT_EMPTY.get(cx).to_owned(),
                    copy::IMPORT_EMPTY_HELP.get(cx).to_owned(),
                ),
            };
            body.push(note_block("transfer-empty", title, help, cx));
        }
        if !self.catalog.sessions.is_empty() {
            body.push(self.render_selection_bar(cx));
            let rows: Vec<AnyElement> =
                self.catalog.sessions.iter().map(|session| self.render_row(session, cx)).collect();
            body.push(SettingsGroup::new("transfer-list").children(rows).into_any_element());
        }
        if self.catalog.next_cursor.is_some() {
            let label =
                if self.loading_more { copy::IMPORT_LOADING_MORE } else { copy::IMPORT_LOAD_MORE };
            body.push(
                settings_button("transfer-load-more", label.get(cx), cx)
                    .w_full()
                    .disabled(self.loading_more)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let cursor = this.catalog.next_cursor.clone();
                        this.load_catalog(cursor, cx);
                    }))
                    .into_any_element(),
            );
        }
        SettingsGroup::new("transfer-catalog")
            .description(copy::IMPORT_DUPLICATE_NOTE.get(cx))
            .bare()
            .children(lines)
            .children(body)
            .into_any_element()
    }

    fn render_selection_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let eligible = self.eligible().len();
        let marked = self.marked().len();
        let busy = self.is_busy();
        let this = cx.weak_entity();
        let all = eligible > 0 && marked == eligible;
        let master = Checkbox::new("transfer-select-all")
            .accessibility_label(copy::SELECT_ALL.get(cx))
            .checked(all)
            .disabled(busy || eligible == 0)
            .on_click(move |checked, _, cx| {
                this.update(cx, |this, cx| this.set_all_marked(*checked, cx)).ok();
            });
        let import = settings_button("transfer-import-selected", copy::IMPORT_SELECTED.get(cx), cx)
            .loading(matches!(self.run, ImportRun::Batch { .. }))
            .disabled(busy || marked == 0)
            .on_click(cx.listener(|this, _, _, cx| this.import_marked(cx)));
        h_flex()
            .id("transfer-selection")
            .test_support()
            .w_full()
            .items_center()
            .gap_2()
            .child(master)
            .child(
                div()
                    .id("transfer-selected-count")
                    .test_support()
                    .aria_label(copy::selected_count(locale, marked, eligible))
                    .text_xs()
                    .text_color(cx.maka().ink_muted)
                    .child(copy::selected_count(locale, marked, eligible)),
            )
            .child(div().flex_1())
            .child(import)
            .into_any_element()
    }

    fn render_row(
        &self,
        session: &ExternalSessionCatalogItem,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let busy = self.is_busy();
        let eligible = !session.import_state.is_importing;
        let offset = local_utc_offset();
        let timestamp = session.updated_at.or(session.created_at);
        let parts: Vec<String> = [
            (!session.host_cwd.is_empty()).then(|| session.host_cwd.clone()),
            timestamp.map(|at| absolute_time(locale, at, offset)),
            session.archived.unwrap_or(false).then(|| copy::IMPORT_ARCHIVED.get(cx).to_owned()),
            (session.import_state.imported_count > 0)
                .then(|| copy::imported_count(locale, session.import_state.imported_count)),
        ]
        .into_iter()
        .flatten()
        .collect();
        let description = parts.join(" · ");
        let importing = session.import_state.is_importing
            || matches!(&self.run, ImportRun::Single { source_id, .. } if *source_id == session.id)
            || matches!(&self.run, ImportRun::Batch { current: Some(current), .. } if *current == session.id);
        let imported = session.import_state.imported_count > 0;
        let (label, spoken) = if importing {
            (copy::IMPORTING, copy::named(copy::IMPORTING_TASK, locale, &session.name))
        } else if imported {
            (copy::IMPORT_AGAIN, copy::named(copy::IMPORT_TASK_AGAIN, locale, &session.name))
        } else {
            (copy::IMPORT, copy::named(copy::IMPORT_TASK, locale, &session.name))
        };
        let id = session.id.clone();
        let import =
            settings_button(domain_element_id("transfer-import", &session.id), label.get(cx), cx)
                .accessibility_label(spoken)
                .loading(importing)
                .disabled(busy || !eligible)
                .on_click(cx.listener(move |this, _, _, cx| this.import_one(&id, cx)));
        let latest = session.import_state.imported_session_ids.first().cloned();
        let open = latest.map(|task| {
            let task: SharedString = task.into();
            quiet_button(Button::new(domain_element_id("transfer-open", &session.id)), cx)
                .label(copy::OPEN_IMPORTED.get(cx))
                .accessibility_label(copy::named(copy::OPEN_IMPORTED_FOR, locale, &session.name))
                .on_click(
                    cx.listener(move |_, _, _, cx| cx.emit(TransferEvent::OpenTask(task.clone()))),
                )
        });
        let this = cx.weak_entity();
        let mark_id = session.id.clone();
        let mark = Checkbox::new(domain_element_id("transfer-mark", &session.id))
            .accessibility_label(copy::named(copy::SELECT_ROW, locale, &session.name))
            .checked(self.selection.contains(&session.id) && eligible)
            .disabled(busy || !eligible)
            .on_click(move |checked, _, cx| {
                this.update(cx, |this, cx| this.set_marked(&mark_id, *checked, cx)).ok();
            });
        h_flex()
            .id(domain_element_id("transfer-row", &session.id))
            .test_support()
            .aria_label(if description.is_empty() {
                session.name.clone()
            } else {
                format!("{}, {description}", session.name)
            })
            .w_full()
            .items_center()
            .gap_3()
            .py_2()
            .child(mark)
            .child(
                Icon::new(AssetIcon::MessageSquare)
                    .size_4()
                    .flex_shrink_0()
                    .text_color(maka.ink_muted),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(maka.ink)
                            .child(session.name.clone()),
                    )
                    .when(!description.is_empty(), |this| {
                        this.child(supporting(description.clone(), maka.ink_muted).truncate())
                    }),
            )
            .child(h_flex().flex_shrink_0().gap_2().children(open).child(import))
            .into_any_element()
    }

    fn render_import(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let locale = Locale::current(cx);
        match &self.sources {
            Sources::Idle | Sources::Loading => {
                if !self.host.read(cx).is_connected() {
                    return Vec::new();
                }
                vec![
                    h_flex()
                        .id("transfer-sources-loading")
                        .test_support()
                        .gap_2()
                        .text_sm()
                        .text_color(cx.maka().ink_muted)
                        .child(Spinner::new().small())
                        .child(copy::IMPORT_LOADING.get(cx))
                        .into_any_element(),
                ]
            }
            Sources::Failed(reason) => {
                let retry =
                    settings_button("transfer-sources-retry", settings_copy::RETRY.get(cx), cx)
                        .on_click(cx.listener(|this, _, _, cx| this.load_sources(cx)));
                let message = shell_copy::phrases(locale, copy::IMPORT_LOAD_FAILED.get(cx), reason);
                vec![
                    StatusLine::error("transfer-sources", message).action(retry).into_any_element(),
                ]
            }
            Sources::Loaded(sources) => {
                let mut elements = vec![self.render_sources(sources, cx)];
                if self.source.as_deref() != Some(BUNDLE_SOURCE) {
                    elements.push(self.render_catalog(cx));
                }
                elements
            }
        }
    }

    fn render_export(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let mut group = SettingsGroup::new("transfer-export")
            .title(copy::EXPORT_TITLE.get(cx))
            .description(copy::EXPORT_HELP.get(cx))
            .bare()
            .children(self.render_note());
        if let Some(reason) = &self.tasks_error {
            let retry = settings_button("transfer-tasks-retry", settings_copy::RETRY.get(cx), cx)
                .on_click(cx.listener(|this, _, _, cx| this.load_tasks(cx)));
            let message =
                shell_copy::failure(locale, shell_copy::TASKS_LOAD_FAILED.get(cx), reason);
            group = group.child(StatusLine::error("transfer-tasks", message).action(retry));
        }
        let Some(tasks) = self.tasks.as_ref() else {
            return group.into_any_element();
        };
        let tree = ExportTree::new(tasks);
        if tree.roots.is_empty() {
            return group
                .child(note_block(
                    "transfer-export-empty",
                    copy::EXPORT_EMPTY.get(cx).to_owned(),
                    String::new(),
                    cx,
                ))
                .into_any_element();
        }
        let mut rows = Vec::new();
        for root in &tree.roots {
            self.render_export_node(&tree, root, 0, &mut rows, cx);
        }
        group
            .child(v_flex().id("transfer-export-tree").test_support().w_full().children(rows))
            .into_any_element()
    }

    fn render_export_node(
        &self,
        tree: &ExportTree<'_>,
        task: &SessionCatalogProjection,
        depth: usize,
        rows: &mut Vec<AnyElement>,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let carried = tree.descendants(&task.id);
        let name = task_title(locale, &task.name).to_owned();
        let agent = task.subagent.as_ref().and_then(|subagent| subagent.agent_name.clone());
        let id = task.id.clone();
        let button = quiet_button(Button::new(domain_element_id("transfer-export", &task.id)), cx)
            .label(copy::EXPORT.get(cx))
            .accessibility_label(copy::export_task(locale, &name))
            .disabled(self.is_busy() || !self.host.read(cx).is_connected())
            .on_click(cx.listener(move |this, _, window, cx| this.ask_export(&id, window, cx)));
        rows.push(
            h_flex()
                .id(domain_element_id("transfer-export-row", &task.id))
                .test_support()
                .aria_label(name.clone())
                .w_full()
                .items_center()
                .gap_3()
                .py_1p5()
                .pl(rems(0.5 + depth as f32 * 1.25))
                .pr_2()
                .when(depth > 0, |this| this.border_l_1().border_color(maka.border_soft))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    div()
                                        .truncate()
                                        .text_sm()
                                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                                        .text_color(maka.ink)
                                        .child(name),
                                )
                                .children(agent.map(|agent| badge(agent, cx))),
                        )
                        .when(carried > 0, |this| {
                            this.child(supporting(
                                copy::export_carries(locale, carried),
                                maka.ink_muted,
                            ))
                        }),
                )
                .child(button)
                .into_any_element(),
        );
        for child in tree.children(&task.id) {
            self.render_export_node(tree, child, depth + 1, rows, cx);
        }
    }
}

impl Render for TransferPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let offline = (!self.host.read(cx).is_connected())
            .then(|| StatusLine::info("transfer", settings_copy::PERMISSIONS_OFFLINE.get(cx)));
        let body = match self.mode {
            TransferMode::Import => self.render_import(cx),
            TransferMode::Export => vec![self.render_export(cx)],
        };
        v_flex()
            .id("transfer-page")
            .test_support()
            .w_full()
            .gap_6()
            .children(offline)
            .child(self.render_mode(cx))
            .children(body)
    }
}

/// A batch's report line.
fn render_summary(summary: &BatchOutcome, locale: Locale) -> StatusLine {
    let title = if summary.imported > 0 {
        copy::batch_counted(copy::BATCH_DONE, locale, summary.imported)
    } else {
        copy::BATCH_NOTHING.in_locale(locale).to_owned()
    };
    let mut parts = vec![title];
    if summary.duplicated > 0 {
        parts.push(copy::batch_counted(copy::BATCH_DUPLICATED, locale, summary.duplicated));
    }
    if summary.failed > 0 {
        parts.push(copy::batch_counted(copy::BATCH_FAILED, locale, summary.failed));
    }
    if summary.no_model {
        parts.push(copy::IMPORT_NO_MODEL.in_locale(locale).to_owned());
    }
    for (name, limit) in &summary.limits {
        let limit = copy::import_limit(locale, limit.kind.as_str(), limit.max);
        parts.push(shell_copy::labeled(locale, name, &limit));
    }
    let message = parts.join(" ");
    if summary.failed > 0 {
        StatusLine::error("transfer-summary", message)
    } else {
        StatusLine::info("transfer-summary", message)
    }
}

/// A quiet note in place of a list.
fn note_block(key: &'static str, title: String, body: String, cx: &App) -> AnyElement {
    let maka = cx.maka();
    v_flex()
        .id(key)
        .test_support()
        .aria_label(title.clone())
        .w_full()
        .items_center()
        .gap_1()
        .py_6()
        .child(
            div()
                .text_sm()
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(maka.ink)
                .child(title),
        )
        .when(!body.is_empty(), |this| this.child(supporting(body, maka.ink_muted)))
        .into_any_element()
}

fn supporting(text: impl Into<SharedString>, ink: gpui_kit::Hsla) -> gpui_kit::Div {
    div().text_xs().line_height(rems(SUPPORTING_LINE_REMS)).text_color(ink).child(text.into())
}

/// The Host's reason, in `locale`.
fn reason_or(error: &HostRequestError, locale: Locale) -> String {
    host_error_reason(error, locale)
}

/// A bundle failure as Desktop words it (`failureText`): the reason the
/// person can act on, else what the Host said.
fn bundle_failure(error: &HostRequestError, locale: Locale) -> Note {
    let code = match error {
        HostRequestError::Operation { code, .. } => Some(code),
        _ => None,
    };
    let text = match code {
        Some(HostOperationErrorCode::SessionBusy) => copy::BUNDLE_BUSY,
        Some(HostOperationErrorCode::CandidateSetStale) => copy::BUNDLE_SUBTREE_CHANGED,
        Some(HostOperationErrorCode::OperationConflict) => copy::BUNDLE_CONFLICT,
        Some(HostOperationErrorCode::SourceUnreadable) => copy::BUNDLE_UNREADABLE,
        _ => {
            log::warn!("a session bundle failed: {error}");
            return Note {
                ok: false,
                text: copy::BUNDLE_FAILED.in_locale(locale).to_owned(),
                detail: Some(host_error_reason(error, locale)),
            };
        }
    };
    Note { ok: false, text: text.in_locale(locale).to_owned(), detail: None }
}

/// One page of `key`'s catalog.
async fn read_page(
    requester: &HostRequester,
    key: &CatalogKey,
    cursor: Option<String>,
) -> Result<Catalog, HostRequestError> {
    let input = ExternalSessionCatalogQueryInput::new(
        key.adapter.clone(),
        key.include_archived,
        TransferPage::search_text(&key.search),
        cursor,
    );
    let page = requester.request::<ExternalSessionCatalogQuery>(&input).await?;
    Ok(Catalog { sessions: page.sessions, next_cursor: page.next_cursor })
}

/// The catalog's pages from the first until `minimum` conversations are
/// read (at least one page), as `readCatalogWindow` does; a repeated cursor
/// is an error.
async fn read_window(
    requester: &HostRequester,
    key: &CatalogKey,
    minimum: usize,
) -> Result<Catalog, HostRequestError> {
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = None;
    loop {
        let page = read_page(requester, key, cursor).await?;
        sessions.extend(page.sessions);
        match page.next_cursor {
            Some(next) if sessions.len() < minimum => {
                if !seen.insert(next.clone()) {
                    return Err(HostRequestError::Transport(
                        "the external session catalog repeated a cursor".into(),
                    ));
                }
                cursor = Some(next);
            }
            next => return Ok(Catalog { sessions, next_cursor: next }),
        }
    }
}

/// Imports one conversation (Desktop's `external-sessions:import`): the
/// task it became, the limit it went over, or why not.
async fn import(
    requester: &HostRequester,
    adapter: &str,
    source_id: &str,
    workspace: Option<host_protocol::WorkspaceTarget>,
    locale: Locale,
) -> ImportOutcome {
    let input = ExternalSessionImportInput::new(adapter, source_id, workspace);
    match requester.request::<ExternalSessionImport>(&input).await {
        Ok(ExternalSessionImportResult::Imported { session }) => {
            ImportOutcome::Imported(session.id().to_owned())
        }
        Ok(ExternalSessionImportResult::SourceLimitExceeded { limit }) => {
            ImportOutcome::SourceLimit(limit)
        }
        Ok(_) => ImportOutcome::Unknown,
        Err(HostRequestError::Operation { code, message, .. }) => match code {
            HostOperationErrorCode::ModelUnavailable => ImportOutcome::NoModel,
            HostOperationErrorCode::SourceUnreadable => ImportOutcome::Unreadable,
            HostOperationErrorCode::CommitOutcomeUnknown => ImportOutcome::Unknown,
            _ => {
                let fallback = copy::IMPORT_FAILED_FALLBACK.in_locale(locale);
                log::warn!("external-session.import failed: {message}");
                ImportOutcome::Failed(shell_copy::failure(locale, fallback, &message))
            }
        },
        // A dropped connection may have run the command.
        Err(error) => {
            log::warn!("external-session.import did not answer: {error}");
            ImportOutcome::Unknown
        }
    }
}

/// `bundleFileName`: the task's name made safe for a file name.
fn bundle_file_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let short: String = trimmed.chars().take(80).collect();
    let short = short.trim();
    if short.is_empty() { "maka-session".to_owned() } else { short.to_owned() }
}

/// `subtreeDigest`: sha256 (hex) over the ids, sorted and joined by
/// newlines.
fn subtree_digest(ids: &[String]) -> String {
    let mut sorted = ids.to_vec();
    sorted.sort();
    let digest = Sha256::digest(sorted.join("\n").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A task's subagent parent, as `linkedSubagentParentId` reads it.
fn parent_of(task: &SessionCatalogProjection) -> Option<&str> {
    task.subagent
        .as_ref()
        .map(|subagent| subagent.parent_session_id.as_str())
        .or(task.parent_session_id.as_deref())
}

/// Every task linked under `id`, archived ones included, `id` first: the
/// set the Host fences and writes (`wholeSubtree`).
fn whole_subtree(tasks: &[SessionCatalogProjection], id: &str) -> Vec<String> {
    let tree = ExportTree::linked(tasks);
    let mut ids = vec![id.to_owned()];
    let mut pending: Vec<&SessionCatalogProjection> = tree.children(id).collect();
    while let Some(next) = pending.pop() {
        ids.push(next.id.clone());
        pending.extend(tree.children(&next.id));
    }
    ids
}

/// `projectLinkedSessionTree`: each task under its subagent parent when the
/// parent is among the tasks and the chain has no cycle, else a root.
struct ExportTree<'a> {
    roots: Vec<&'a SessionCatalogProjection>,
    links: Vec<(&'a str, &'a SessionCatalogProjection)>,
}

impl<'a> ExportTree<'a> {
    /// The tree the export half draws: tasks not archived.
    fn new(tasks: &'a [SessionCatalogProjection]) -> Self {
        let visible: Vec<&SessionCatalogProjection> =
            tasks.iter().filter(|task| !task.is_archived).collect();
        Self::of(visible)
    }

    /// Every task, archived ones included.
    fn linked(tasks: &'a [SessionCatalogProjection]) -> Self {
        Self::of(tasks.iter().collect())
    }

    fn of(tasks: Vec<&'a SessionCatalogProjection>) -> Self {
        let known: HashSet<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
        let parent = |task: &'a SessionCatalogProjection| -> Option<&'a str> {
            parent_of(task).filter(|parent| known.contains(parent) && *parent != task.id)
        };
        let cyclic = |start: &'a SessionCatalogProjection| {
            let mut seen = HashSet::from([start.id.as_str()]);
            let mut current = parent(start);
            while let Some(id) = current {
                if !seen.insert(id) {
                    return true;
                }
                current = tasks.iter().find(|task| task.id == id).and_then(|task| parent(task));
            }
            false
        };
        let mut roots = Vec::new();
        let mut links = Vec::new();
        for task in tasks.iter().copied() {
            match parent(task).filter(|_| !cyclic(task)) {
                Some(parent) => links.push((parent, task)),
                None => roots.push(task),
            }
        }
        Self { roots, links }
    }

    fn children(&self, id: &str) -> impl Iterator<Item = &'a SessionCatalogProjection> + '_ {
        let id = id.to_owned();
        self.links.iter().filter(move |(parent, _)| *parent == id).map(|(_, child)| *child)
    }

    /// Every task under `id`, at any depth.
    fn descendants(&self, id: &str) -> usize {
        let mut count = 0;
        let mut pending: Vec<&SessionCatalogProjection> = self.children(id).collect();
        while let Some(next) = pending.pop() {
            count += 1;
            pending.extend(self.children(&next.id));
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn task(id: &str, parent: Option<&str>, archived: bool) -> SessionCatalogProjection {
        let mut value = json!({
            "id": id, "revision": 1,
            "workspace": {"target": {"kind": "host_path", "path": "/w"}, "hostCwd": "/w"},
            "createdAt": 1, "activityAt": 2, "name": id, "isFlagged": false,
            "isArchived": archived, "labels": [], "labelsTruncated": false, "hasUnread": false,
            "status": "active", "backend": "ai-sdk", "llmConnectionId": null,
            "llmConnectionSlug": "env", "connectionLocked": false, "model": "m",
            "permissionMode": "ask", "collaborationMode": "agent", "orchestrationMode": "default"
        });
        if let Some(parent) = parent {
            value["subagent"] = json!({"parentSessionId": parent, "agentName": "Explorer"});
        }
        serde_json::from_value(value).expect("task")
    }

    #[test]
    fn the_export_tree_nests_subagents_and_the_subtree_takes_archived_ones() {
        let tasks = vec![
            task("root", None, false),
            task("child", Some("root"), false),
            task("grandchild", Some("child"), false),
            task("archived-child", Some("root"), true),
            task("orphan", Some("gone"), false),
            task("loop-a", Some("loop-b"), false),
            task("loop-b", Some("loop-a"), false),
        ];
        let tree = ExportTree::new(&tasks);
        let roots: Vec<&str> = tree.roots.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(roots, ["root", "orphan", "loop-a", "loop-b"], "a cycle nests nothing");
        assert_eq!(tree.descendants("root"), 2, "the archived child is not drawn");
        let mut subtree = whole_subtree(&tasks, "root");
        subtree.sort();
        assert_eq!(subtree, ["archived-child", "child", "grandchild", "root"]);
    }

    #[test]
    fn a_subtree_digest_is_desktops() {
        // `createHash('sha256').update(['b', 'a'].sort().join('\n'))` in Node.
        assert_eq!(
            subtree_digest(&["b".into(), "a".into()]),
            "7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78"
        );
    }

    #[test]
    fn a_bundle_file_name_is_safe() {
        assert_eq!(bundle_file_name("Plan: v2/next?"), "Plan v2 next");
        assert_eq!(bundle_file_name("  ..hidden  "), "hidden");
        assert_eq!(bundle_file_name("\u{0}"), "maka-session");
        assert_eq!(bundle_file_name(&"x".repeat(100)).len(), 80);
    }
}
