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

//! The Archived tasks page, after Maka Desktop's
//! (apps/desktop/src/renderer/settings/tasks-settings-page.tsx and
//! task-catalog-rows.ts): the archived tasks, found by name or project,
//! each restored (`session.lifecycle.set`) or deleted for good
//! (`session.remove.preview`, then `session.remove`), and every archived
//! task, or the ones a search found, deleted in one sweep.
//!
//! The page reads the whole session catalog itself (`session.catalog.query`,
//! every page, as the sidebar's catalog does) and again on
//! `session.catalog.changed`, which the Host announces to every window after
//! each of these commands: the sidebar's Archived group follows through the
//! same notice. A task counts as the sidebar counts it: a subagent task is
//! part of its parent, unless the parent is gone, when it stays a row of its
//! own (Desktop's `archivedTaskRows`, `isOrphanedSubagentTask`).

use std::collections::HashSet;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, TestSupportExt as _, Window, div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{
    ChangeNotice, PushFrame, SessionCatalogItem, SessionCatalogProjection, SessionCatalogQuery,
    SessionCatalogQueryInput, SessionCatalogQueryResult, SessionLifecycleSet,
    SessionLifecycleSetInput, SessionRemove, SessionRemoveInput, SessionRemovePreview,
    SessionRemovePreviewInput, SessionRemoveResult, WorkspaceTarget,
};
use shared::copy::settings as settings_copy;
use shared::copy::tasks as copy;
use shared::copy::{self as shell_copy, Locale, failure, task_title};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, floating_surface};
use shared::time::{compact_timestamp, local_utc_offset};
use workspace::{HostRequestError, HostRequester, HostSession, HostSessionEvent, ProjectSelection};

use crate::policy::host_error_reason;
use crate::rows::{SettingsGroup, StatusLine, destructive_button};

/// Restarts allowed when the catalog changes between pages
/// (`MAX_STABLE_READ_ATTEMPTS` in packages/runtime-host/src/client/catalog-reader.ts).
const MAX_STABLE_READ_ATTEMPTS: usize = 8;

/// Tries of a removal whose task moved on meanwhile
/// (`MAX_SESSION_REVISION_ATTEMPTS` in apps/desktop/src/main/runtime-host-client.ts).
const MAX_REMOVE_ATTEMPTS: usize = 8;

/// The page's status line key.
const PAGE_KEY: &str = "archived-tasks";

/// Supporting text: 12px on 20px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

/// One archived task as the page lists it, built once per read.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ArchivedTask {
    pub id: SharedString,
    /// The stored name; [`Self::title`] is how it reads.
    pub name: SharedString,
    /// The registered project the task runs in, when it names one.
    pub project_id: Option<SharedString>,
    /// A subagent task whose parent task was deleted.
    pub parent_deleted: bool,
    pub last_message_at: Option<u64>,
    /// The Host's recency for the task: its last message, else when it was
    /// created (`activityAt`).
    pub activity_at: u64,
}

impl ArchivedTask {
    /// The name as the sidebar shows it, in `locale` when it has none.
    pub fn title(&self, locale: Locale) -> &str {
        task_title(locale, &self.name)
    }
}

/// Where reading the catalog stands. The rows of the last read stay while
/// it is read again.
#[derive(Debug, Clone, PartialEq)]
enum LoadState {
    Idle,
    Loading,
    Loaded,
    Failed(SharedString),
}

/// What removing a task that should still be archived came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Removal {
    /// Gone, with the subtasks the Host moved to the archive.
    Removed { archived_subtasks: u64 },
    /// Restored before the removal reached it: kept.
    Restored,
}

/// What a sweep can honestly say afterwards (Desktop's `SessionPurgeOutcome`).
#[derive(Debug, Clone, Default, PartialEq)]
struct PurgeOutcome {
    removed: usize,
    archived_subtasks: u64,
    remaining: usize,
    restored: usize,
    /// False when the catalog could not be read back to confirm.
    verified: bool,
    first_failure: Option<String>,
}

/// Behavior and presentation owner of the Archived tasks page.
///
/// It reads the catalog when the page shows and on each
/// `session.catalog.changed` after that; a read supersedes one in flight.
/// One command runs per task, and a sweep blocks the others; while either
/// runs, Back to app waits. Deleting one task asks first (naming it and the
/// subtasks the Host would move to the archive); a sweep asks with the
/// number it will delete, frozen when asked. Restoring asks nothing: it can
/// be undone from the sidebar.
pub struct ArchivedTasksPage {
    host: Entity<HostSession>,
    projects: Entity<ProjectSelection>,
    search: Entity<InputState>,
    state: LoadState,
    /// Every archived task the page lists, newest activity first.
    tasks: Vec<ArchivedTask>,
    generation: u64,
    reload_pending: bool,
    /// Tasks a command is waiting on.
    pending: HashSet<SharedString>,
    purging: bool,
    /// Why the last command failed, until the next one starts.
    error: Option<SharedString>,
    active: bool,
    _load: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ArchivedTasksPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArchivedTasksPage")
            .field("state", &self.state)
            .field("tasks", &self.tasks.len())
            .finish_non_exhaustive()
    }
}

impl ArchivedTasksPage {
    pub fn new(
        host: Entity<HostSession>,
        projects: Entity<ProjectSelection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::ARCHIVED_SEARCH.get(cx)));
        let subscriptions = vec![
            cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if !this.active {
                    return;
                }
                match event {
                    HostSessionEvent::Connected { .. } => this.reload(cx),
                    HostSessionEvent::Push(frame)
                        if matches!(
                            frame.as_ref(),
                            PushFrame::Change(ChangeNotice::SessionCatalogChanged { .. })
                        ) =>
                    {
                        this.request_reload(cx)
                    }
                    _ => {}
                }
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = copy::ARCHIVED_SEARCH.get(cx);
                this.search
                    .update(cx, |search, cx| search.set_placeholder(placeholder, window, cx));
            }),
            cx.observe(&projects, |_, _, cx| cx.notify()),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        Self {
            host,
            projects,
            search,
            state: LoadState::Idle,
            tasks: Vec::new(),
            generation: 0,
            reload_pending: false,
            pending: HashSet::new(),
            purging: false,
            error: None,
            active: false,
            _load: None,
            _subscriptions: subscriptions,
        }
    }

    /// The page is shown: reads the catalog.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.active = true;
        self.reload(cx);
    }

    /// Every archived task, newest activity first.
    pub fn tasks(&self) -> &[ArchivedTask] {
        &self.tasks
    }

    /// Whether a command it sent is unanswered.
    pub fn is_busy(&self) -> bool {
        self.purging || !self.pending.is_empty()
    }

    /// The search field, while it shows: there are archived tasks.
    pub fn search_field(&self) -> Option<Entity<InputState>> {
        (self.state == LoadState::Loaded && !self.tasks.is_empty()).then(|| self.search.clone())
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    /// Reads the catalog now, superseding a read in flight.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.generation += 1;
        self.reload_pending = false;
        let generation = self.generation;
        if self.state != LoadState::Loaded {
            self.state = LoadState::Loading;
        }
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = read_catalog(&requester).await;
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this._load = None;
                match result {
                    Ok(sessions) => {
                        this.tasks = archived_tasks(&sessions);
                        this.state = LoadState::Loaded;
                    }
                    Err(error) => {
                        log::warn!("session.catalog.query failed: {error}");
                        if this.state != LoadState::Loaded {
                            let reason = host_error_reason(&error, locale);
                            this.state = LoadState::Failed(reason.into());
                        }
                    }
                }
                cx.notify();
                if std::mem::take(&mut this.reload_pending) {
                    this.reload(cx);
                }
            })
            .ok();
        }));
        cx.notify();
    }

    /// Reads the catalog again, or once more after the read in flight.
    fn request_reload(&mut self, cx: &mut Context<Self>) {
        if self._load.is_some() {
            self.reload_pending = true;
        } else {
            self.reload(cx);
        }
    }

    /// The search as typed, trimmed.
    fn query(&self, cx: &App) -> String {
        self.search.read(cx).value().trim().to_owned()
    }

    /// The tasks the search finds: by name or by project name, whichever the
    /// row shows (`matchesArchivedTaskQuery`).
    pub fn visible(&self, cx: &App) -> Vec<ArchivedTask> {
        let query = self.query(cx).to_lowercase();
        let locale = Locale::current(cx);
        self.tasks
            .iter()
            .filter(|task| {
                query.is_empty() || {
                    let project = self.project_label(task, cx).unwrap_or_default();
                    let title = task.title(locale);
                    format!("{title}\n{project}").to_lowercase().contains(&query)
                }
            })
            .cloned()
            .collect()
    }

    /// The row's project: the project's name, "No project" when the task
    /// runs in a plain folder, nothing when its project cannot be found.
    fn project_label(&self, task: &ArchivedTask, cx: &App) -> Option<SharedString> {
        match &task.project_id {
            None => Some(copy::ARCHIVED_NO_PROJECT.get(cx).into()),
            Some(id) => self.projects.read(cx).project(id).map(|project| project.label()),
        }
    }

    /// Restores task `id` to the task list.
    pub fn restore(&mut self, id: &SharedString, window: &mut Window, cx: &mut Context<Self>) {
        if self.purging || !self.pending.insert(id.clone()) {
            return;
        }
        self.error = None;
        let input = SessionLifecycleSetInput::new(id.to_string(), false);
        let request = self.requester(cx).request::<SessionLifecycleSet>(&input);
        let locale = Locale::current(cx);
        let id = id.clone();
        let task = cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this.pending.remove(&id);
                match result {
                    Ok(_) => this.tasks.retain(|task| task.id != id),
                    Err(error) => {
                        let what = shell_copy::TASK_UNARCHIVE_FAILED.in_locale(locale);
                        let reason = host_error_reason(&error, locale);
                        this.error = Some(failure(locale, what, &reason).into());
                    }
                }
                cx.notify();
            })
            .ok();
        });
        task.detach();
        cx.notify();
    }

    /// Asks before deleting task `id`: the sidebar's question, with the
    /// subtasks the Host's removal plan would move to the archive
    /// (`session.remove.preview`; when it cannot tell, the question says
    /// nothing about them).
    pub fn ask_delete(&mut self, id: &SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let Some(task) = self.tasks.iter().find(|task| &task.id == id).cloned() else {
            return;
        };
        if self.purging || self.pending.contains(id) {
            return;
        }
        let input = SessionRemovePreviewInput::new(id.to_string());
        let preview = self.requester(cx).request::<SessionRemovePreview>(&input);
        let command = cx.spawn_in(window, async move |this, cx| {
            let subtasks = match preview.await {
                Ok(preview) => Some(preview.archivable_subtask_count),
                Err(error) => {
                    log::warn!("session.remove.preview failed: {error}");
                    None
                }
            };
            this.update_in(cx, |this, window, cx| {
                this.open_delete_dialog(task, subtasks, window, cx);
            })
            .ok();
        });
        command.detach();
    }

    fn open_delete_dialog(
        &mut self,
        task: ArchivedTask,
        subtasks: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let body = shell_copy::DELETE_TASK_BODY.in_locale(locale);
        let body: SharedString = match subtasks.filter(|count| *count > 0) {
            Some(count) => shell_copy::sentences(
                locale,
                body,
                &shell_copy::delete_task_subtasks(locale, count),
            ),
            None => body.to_owned(),
        }
        .into();
        let page = cx.entity();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (page, task) = (page.clone(), task.clone());
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(shell_copy::delete_task_title(
                    locale,
                    task.title(locale),
                )))
                .description(shared::dialog::confirmation_text(body.clone()))
                .footer(shared::dialog::confirmation_answers(
                    shell_copy::CANCEL.in_locale(locale),
                    shell_copy::DELETE.in_locale(locale),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    page.update(cx, |page, cx| page.delete(task.clone(), window, cx));
                    true
                })
        });
    }

    /// Deletes `task`, confirmed, unless it was restored meanwhile; says
    /// what happened.
    fn delete(&mut self, task: ArchivedTask, window: &mut Window, cx: &mut Context<Self>) {
        if self.purging || !self.pending.insert(task.id.clone()) {
            return;
        }
        self.error = None;
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        let command = cx.spawn_in(window, async move |this, cx| {
            let result = remove_archived(&requester, &task.id).await;
            this.update_in(cx, |this, window, cx| {
                this.pending.remove(&task.id);
                let notification = match result {
                    Ok(Removal::Removed { archived_subtasks }) => {
                        this.tasks.retain(|row| row.id != task.id);
                        let note = (archived_subtasks > 0)
                            .then(|| copy::purged_subtasks(locale, archived_subtasks as usize));
                        let title = copy::deleted(locale, task.title(locale));
                        match note {
                            Some(note) => Notification::success(note).title(title),
                            None => Notification::success(title),
                        }
                    }
                    Ok(Removal::Restored) => {
                        Notification::success(copy::delete_restored(locale, task.title(locale)))
                    }
                    Err(error) => {
                        let what = shell_copy::TASK_DELETE_FAILED.in_locale(locale);
                        let reason = host_error_reason(&error, locale);
                        this.error = Some(failure(locale, what, &reason).into());
                        cx.notify();
                        return;
                    }
                };
                window.push_notification(notification, cx);
                cx.notify();
            })
            .ok();
        });
        command.detach();
        cx.notify();
    }

    /// Asks before deleting every archived task, or the ones the search
    /// found, naming how many; the set is the one on screen when asked.
    pub fn ask_purge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_busy() {
            return;
        }
        let searching = !self.query(cx).is_empty();
        let ids: Vec<SharedString> = self.visible(cx).into_iter().map(|task| task.id).collect();
        if ids.is_empty() {
            return;
        }
        let locale = Locale::current(cx);
        let title = copy::purge_title(locale, ids.len(), searching);
        let body = shell_copy::sentences(
            locale,
            copy::ARCHIVED_PURGE_BODY.in_locale(locale),
            copy::ARCHIVED_PURGE_SUBTASKS.in_locale(locale),
        );
        let page = cx.entity();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (page, ids) = (page.clone(), ids.clone());
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(title.clone()))
                .description(shared::dialog::confirmation_text(body.clone()))
                .footer(shared::dialog::confirmation_answers(
                    shell_copy::CANCEL.in_locale(locale),
                    copy::ARCHIVED_PURGE_CONFIRM.in_locale(locale),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    page.update(cx, |page, cx| page.purge(ids.clone(), window, cx));
                    true
                })
        });
    }

    /// Deletes the tasks `ids` that are still archived when the sweep
    /// reaches them, one after another, and reports what it could confirm
    /// (Desktop's `purgeSessions`): a task restored meanwhile is kept and
    /// said so, and when a removal failed the catalog is read back to count
    /// what is really still there.
    fn purge(&mut self, ids: Vec<SharedString>, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_busy() {
            return;
        }
        self.purging = true;
        self.error = None;
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        let command = cx.spawn_in(window, async move |this, cx| {
            let outcome = sweep(&requester, &ids, locale).await;
            this.update_in(cx, |this, window, cx| {
                this.purging = false;
                window.push_notification(purge_notification(&outcome, locale), cx);
                this.request_reload(cx);
                cx.notify();
            })
            .ok();
        });
        command.detach();
        cx.notify();
    }

    fn page_status(&self, cx: &mut Context<Self>) -> Option<StatusLine> {
        if !self.host.read(cx).is_connected() {
            return Some(StatusLine::info(PAGE_KEY, copy::ARCHIVED_OFFLINE.get(cx)));
        }
        if let Some(error) = &self.error {
            return Some(StatusLine::error(PAGE_KEY, error.clone()));
        }
        let LoadState::Failed(message) = &self.state else {
            return None;
        };
        let reason = failure(Locale::current(cx), copy::ARCHIVED_LOAD_FAILED.get(cx), message);
        let retry =
            crate::rows::settings_button("archived-retry", settings_copy::RETRY.get(cx), cx)
                .on_click(cx.listener(|this, _, _, cx| this.reload(cx)));
        Some(StatusLine::error(PAGE_KEY, reason).action(retry))
    }

    fn render_row(
        &self,
        task: &ArchivedTask,
        now_ms: u64,
        offset: i32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let busy = self.purging || self.pending.contains(&task.id);
        // Desktop's row shows when the task last had a message, and nothing
        // for one that never had any; the catalog keeps no archive time, so
        // such a task shows when it was created (its `activityAt`) instead.
        let at = task.last_message_at.unwrap_or(task.activity_at);
        let updated = Some(compact_timestamp(locale, at, now_ms, offset));
        let parts: Vec<String> = [
            task.parent_deleted.then(|| copy::ARCHIVED_DELETED_PARENT.get(cx).to_owned()),
            self.project_label(task, cx).map(|label| label.to_string()),
            updated,
        ]
        .into_iter()
        .flatten()
        .collect();
        let description = parts.join(" · ");
        let title = task.title(locale).to_owned();
        let spoken = std::iter::once(title.clone())
            .chain((!description.is_empty()).then(|| description.clone()))
            .collect::<Vec<_>>()
            .join(", ");
        let restore_id = task.id.clone();
        let delete_id = task.id.clone();
        let icon_button = |id: &'static str, icon: Icon, label: String| {
            Button::new(domain_element_id(id, &task.id))
                .ghost()
                .small()
                .size_7()
                .icon(icon.size_4().text_color(maka.ink_muted))
                .accessibility_label(label)
                .disabled(busy)
        };
        h_flex()
            .id(domain_element_id("archived-task", &task.id))
            .test_support()
            .aria_label(spoken)
            .w_full()
            .items_center()
            .gap_3()
            .py_2()
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
                            .child(title.clone()),
                    )
                    .when(!description.is_empty(), |this| {
                        this.child(
                            div()
                                .truncate()
                                .text_xs()
                                .line_height(rems(SUPPORTING_LINE_REMS))
                                .text_color(maka.ink_muted)
                                .child(description),
                        )
                    }),
            )
            .child(
                h_flex()
                    .flex_shrink_0()
                    .gap_1()
                    .child(
                        icon_button(
                            "archived-restore",
                            Icon::new(AssetIcon::ArchiveRestore),
                            copy::unarchive_task(locale, &title),
                        )
                        .tooltip(copy::ARCHIVED_UNARCHIVE.get(cx))
                        .on_click(cx.listener(
                            move |this, _, window, cx| this.restore(&restore_id, window, cx),
                        )),
                    )
                    .child(
                        icon_button(
                            "archived-delete",
                            Icon::new(AssetIcon::Trash),
                            copy::delete_task(locale, &title),
                        )
                        .tooltip(copy::ARCHIVED_DELETE.get(cx))
                        .on_click(cx.listener(
                            move |this, _, window, cx| this.ask_delete(&delete_id, window, cx),
                        )),
                    ),
            )
            .into_any_element()
    }

    /// A note in place of the list: nothing archived, or no match.
    fn render_note(
        &self,
        key: &'static str,
        title: SharedString,
        body: SharedString,
        cx: &App,
    ) -> AnyElement {
        let maka = cx.maka();
        v_flex()
            .id(key)
            .test_support()
            .aria_label(title.clone())
            .w_full()
            .items_center()
            .gap_1()
            .py_8()
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(maka.ink)
                    .child(title),
            )
            .child(div().text_xs().text_color(maka.ink_muted).child(body))
            .into_any_element()
    }
}

impl Render for ArchivedTasksPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.page_status(cx);
        let connected = self.host.read(cx).is_connected();
        let loading = connected && matches!(self.state, LoadState::Idle | LoadState::Loading);
        let body: Option<AnyElement> = if self.state != LoadState::Loaded {
            loading.then(|| {
                h_flex()
                    .id("archived-loading")
                    .test_support()
                    .gap_2()
                    .py_4()
                    .text_sm()
                    .text_color(cx.maka().ink_muted)
                    .child(Spinner::new().small())
                    .child(copy::ARCHIVED_LOADING.get(cx))
                    .into_any_element()
            })
        } else if self.tasks.is_empty() {
            let (title, body) = (copy::ARCHIVED_EMPTY.get(cx), copy::ARCHIVED_EMPTY_HELP.get(cx));
            Some(self.render_note("archived-empty", title.into(), body.into(), cx))
        } else {
            let locale = Locale::current(cx);
            let searching = !self.query(cx).is_empty();
            let visible = self.visible(cx);
            let targets = if searching { visible.len() } else { self.tasks.len() };
            let label = if searching {
                copy::purge_matches(locale, visible.len())
            } else {
                copy::ARCHIVED_PURGE_ALL.get(cx).to_owned()
            };
            let purge = destructive_button("archived-purge", label, cx)
                .disabled(self.is_busy() || targets == 0 || !connected)
                .loading(self.purging)
                .on_click(cx.listener(|this, _, window, cx| this.ask_purge(window, cx)));
            let toolbar = h_flex()
                .w_full()
                .items_center()
                .gap_2()
                .child(
                    div().flex_1().min_w_0().child(
                        Input::new(&self.search)
                            .field_fill(cx)
                            .id("archived-search")
                            .aria_label(copy::ARCHIVED_SEARCH.get(cx))
                            .prefix(Icon::new(MakaIcon::Search).small())
                            .cleanable(true),
                    ),
                )
                .child(purge);
            let list = if visible.is_empty() {
                let (title, body) =
                    (copy::ARCHIVED_NO_MATCH.get(cx), copy::ARCHIVED_NO_MATCH_HELP.get(cx));
                SettingsGroup::new("archived-list").bare().child(self.render_note(
                    "archived-no-match",
                    title.into(),
                    body.into(),
                    cx,
                ))
            } else {
                let now_ms = now_ms();
                let offset = local_utc_offset();
                let rows: Vec<AnyElement> =
                    visible.iter().map(|task| self.render_row(task, now_ms, offset, cx)).collect();
                SettingsGroup::new("archived-list").children(rows)
            };
            Some(
                v_flex()
                    .id("archived-tasks")
                    .test_support()
                    .aria_label(copy::ARCHIVED_LIST.get(cx))
                    .w_full()
                    .gap_6()
                    .child(toolbar)
                    .child(list)
                    .into_any_element(),
            )
        };
        v_flex().w_full().gap_6().children(status).children(body)
    }
}

/// Now, in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The archived tasks of `sessions`, in the catalog's order (newest
/// activity first): archived, not a subagent task of a task still there.
fn archived_tasks(sessions: &[SessionCatalogProjection]) -> Vec<ArchivedTask> {
    let known: HashSet<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
    sessions
        .iter()
        .filter(|session| session.is_archived)
        .filter_map(|session| {
            let parent = session
                .subagent
                .as_ref()
                .map(|subagent| subagent.parent_session_id.as_str())
                .or(session.parent_session_id.as_deref());
            let parent_deleted = match parent {
                Some(parent) if known.contains(parent) => return None,
                Some(_) => true,
                None => false,
            };
            let project_id = match &session.workspace.target {
                WorkspaceTarget::Project { project_id } => Some(project_id.clone().into()),
                _ => None,
            };
            Some(ArchivedTask {
                id: session.id.clone().into(),
                name: session.name.clone().into(),
                project_id,
                parent_deleted,
                last_message_at: session.last_message_at,
                activity_at: session.activity_at,
            })
        })
        .collect()
}

/// Every Session of the catalog, read page by page at one revision.
pub(crate) async fn read_catalog(
    requester: &HostRequester,
) -> Result<Vec<SessionCatalogProjection>, HostRequestError> {
    let mut attempts = 0;
    let mut sessions = Vec::new();
    let mut input = SessionCatalogQueryInput::ListStart;
    loop {
        match requester.request::<SessionCatalogQuery>(&input).await? {
            SessionCatalogQueryResult::Page { revision, sessions: page, next_cursor } => {
                sessions.extend(page.into_iter().filter_map(|item| match item {
                    SessionCatalogItem::Session(session) => Some(*session),
                    SessionCatalogItem::UnsupportedLegacy(_) => None,
                }));
                match next_cursor {
                    Some(cursor) => {
                        input = SessionCatalogQueryInput::ListContinue { revision, cursor }
                    }
                    None => return Ok(sessions),
                }
            }
            SessionCatalogQueryResult::RevisionChanged { .. } => {
                attempts += 1;
                if attempts >= MAX_STABLE_READ_ATTEMPTS {
                    return Err(HostRequestError::Transport(
                        "the session catalog kept changing while it was read".into(),
                    ));
                }
                sessions.clear();
                input = SessionCatalogQueryInput::ListStart;
            }
            _ => {
                return Err(HostRequestError::Transport(
                    "session.catalog.query answered with an unexpected result".into(),
                ));
            }
        }
    }
}

/// Removes Session `id` while it is still archived (Desktop's
/// `removeSession` with `requireArchived`): read it, keep it if restored,
/// else remove it at the revision read; a conflict reads it again. A task
/// already gone counts as removed.
async fn remove_archived(requester: &HostRequester, id: &str) -> Result<Removal, HostRequestError> {
    for _ in 0..MAX_REMOVE_ATTEMPTS {
        let input = SessionCatalogQueryInput::Get { session_id: id.to_owned() };
        let current = match requester.request::<SessionCatalogQuery>(&input).await? {
            SessionCatalogQueryResult::Session { session: Some(item) } => item,
            SessionCatalogQueryResult::Session { session: None } => {
                return Ok(Removal::Removed { archived_subtasks: 0 });
            }
            _ => {
                return Err(HostRequestError::Transport(
                    "session.catalog.query answered with an unexpected result".into(),
                ));
            }
        };
        let revision = match &current {
            SessionCatalogItem::Session(session) if !session.is_archived => {
                return Ok(Removal::Restored);
            }
            SessionCatalogItem::Session(session) => session.revision,
            SessionCatalogItem::UnsupportedLegacy(record) => record.revision,
        };
        let input = SessionRemoveInput::new(id, revision);
        match requester.request::<SessionRemove>(&input).await? {
            SessionRemoveResult::Removed { archived_subtask_count, .. } => {
                return Ok(Removal::Removed {
                    archived_subtasks: archived_subtask_count.unwrap_or(0),
                });
            }
            SessionRemoveResult::RevisionConflict { .. } => continue,
            _ => {
                return Err(HostRequestError::Transport(
                    "session.remove answered with an unexpected result".into(),
                ));
            }
        }
    }
    Err(HostRequestError::Transport("the task kept changing while it was deleted".into()))
}

/// Removes each of `ids` that is still archived, then, when a removal
/// failed, reads the catalog back to count what is really still there.
async fn sweep(requester: &HostRequester, ids: &[SharedString], locale: Locale) -> PurgeOutcome {
    let mut outcome = PurgeOutcome { verified: true, ..PurgeOutcome::default() };
    let mut unsettled = Vec::new();
    for id in ids {
        match remove_archived(requester, id).await {
            Ok(Removal::Removed { archived_subtasks }) => {
                outcome.removed += 1;
                outcome.archived_subtasks += archived_subtasks;
            }
            Ok(Removal::Restored) => outcome.restored += 1,
            Err(error) => {
                log::warn!("deleting archived task {id} failed: {error}");
                outcome.first_failure.get_or_insert_with(|| host_error_reason(&error, locale));
                unsettled.push(id.clone());
            }
        }
    }
    if unsettled.is_empty() {
        return outcome;
    }
    match read_catalog(requester).await {
        Ok(sessions) => {
            let present: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
            let remaining = unsettled.iter().filter(|id| present.contains(id.as_ref())).count();
            outcome.removed += unsettled.len() - remaining;
            outcome.remaining = remaining;
        }
        Err(error) => {
            log::warn!("reading the catalog back after a sweep failed: {error}");
            outcome.verified = false;
        }
    }
    outcome
}

/// What a sweep reports (Desktop's toast after `onPurge`): whether it
/// failed, its title, and the line under it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PurgeReport {
    failed: bool,
    title: String,
    detail: Option<String>,
}

/// A failure's reason, or the count deleted, with the subtasks moved to the
/// archive and the tasks kept because they were restored meanwhile: a
/// sweep that lands on a smaller number than was agreed to accounts for
/// the whole of it.
fn purge_report(outcome: &PurgeOutcome, locale: Locale) -> PurgeReport {
    let moved = (outcome.archived_subtasks > 0)
        .then(|| copy::purged_subtasks(locale, outcome.archived_subtasks as usize));
    let kept = (outcome.restored > 0).then(|| copy::kept_restored(locale, outcome.restored));
    let joined = |parts: Vec<Option<String>>| {
        let parts: Vec<String> = parts.into_iter().flatten().collect();
        (!parts.is_empty()).then(|| parts.join(" "))
    };
    if !outcome.verified || outcome.remaining > 0 {
        let reason = if !outcome.verified {
            copy::ARCHIVED_PURGE_UNVERIFIED.in_locale(locale).to_owned()
        } else {
            match &outcome.first_failure {
                Some(reason) => reason.clone(),
                None => copy::purge_remaining(locale, outcome.remaining),
            }
        };
        return PurgeReport {
            failed: true,
            title: copy::ARCHIVED_PURGE_FAILED.in_locale(locale).to_owned(),
            detail: joined(vec![Some(reason), moved, kept]),
        };
    }
    PurgeReport {
        failed: false,
        title: copy::purged(locale, outcome.removed),
        detail: joined(vec![moved, kept]),
    }
}

fn purge_notification(outcome: &PurgeOutcome, locale: Locale) -> Notification {
    let report = purge_report(outcome, locale);
    let notification = match (&report.detail, report.failed) {
        (Some(detail), true) => Notification::error(detail.clone()),
        (Some(detail), false) => Notification::success(detail.clone()),
        (None, true) => Notification::error(report.title.clone()),
        (None, false) => return Notification::success(report.title),
    };
    notification.title(report.title)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn session(
        id: &str,
        archived: bool,
        edit: impl FnOnce(&mut serde_json::Value),
    ) -> SessionCatalogProjection {
        let mut value = json!({
            "id": id, "revision": 1,
            "workspace": {"target": {"kind": "host_path", "path": "/work/demo"}, "hostCwd": "/work/demo"},
            "createdAt": 1, "activityAt": 2, "name": format!("Task {id}"), "isFlagged": false,
            "isArchived": archived, "labels": [], "labelsTruncated": false, "hasUnread": false,
            "status": "active", "backend": "ai-sdk", "llmConnectionId": null,
            "llmConnectionSlug": "env", "connectionLocked": false, "model": "m",
            "permissionMode": "ask", "collaborationMode": "agent", "orchestrationMode": "default"
        });
        edit(&mut value);
        serde_json::from_value(value).expect("projection")
    }

    #[test]
    fn a_subagent_task_is_a_row_only_once_its_parent_is_gone() {
        let sessions = [
            session("a", true, |_| {}),
            session("b", false, |_| {}),
            session("c", true, |value| value["parentSessionId"] = json!("a")),
            session("d", true, |value| value["parentSessionId"] = json!("gone")),
            session("e", true, |value| {
                value["workspace"]["target"] = json!({"kind": "project", "projectId": "p1"});
                value["name"] = json!("## Heading name");
                value["lastMessageAt"] = json!(42);
            }),
        ];
        let rows = archived_tasks(&sessions);
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_ref()).collect();
        assert_eq!(ids, ["a", "d", "e"]);
        assert!(!rows[0].parent_deleted);
        assert!(rows[1].parent_deleted);
        assert_eq!(rows[2].project_id.as_deref(), Some("p1"));
        assert_eq!(rows[2].title(Locale::English), "Heading name", "as the sidebar names it");
        assert_eq!(rows[2].last_message_at, Some(42));
        assert_eq!(rows[0].activity_at, 2, "for a task with no message");
    }

    #[test]
    fn a_sweep_reports_the_whole_account() {
        let en = Locale::English;
        let report = |outcome: PurgeOutcome| purge_report(&outcome, en);
        let base = PurgeOutcome { verified: true, ..PurgeOutcome::default() };
        assert_eq!(
            report(PurgeOutcome { removed: 3, ..base.clone() }),
            PurgeReport { failed: false, title: "Deleted 3 tasks".into(), detail: None }
        );
        assert_eq!(
            report(PurgeOutcome { removed: 1, archived_subtasks: 2, restored: 1, ..base.clone() }),
            PurgeReport {
                failed: false,
                title: "Deleted 1 task".into(),
                detail: Some(
                    "2 subtasks moved to Archived 1 more was restored meanwhile and kept.".into()
                ),
            }
        );
        let failed = report(PurgeOutcome {
            removed: 1,
            remaining: 2,
            first_failure: Some("A task is running".into()),
            ..base.clone()
        });
        assert!(failed.failed);
        assert_eq!(failed.title, copy::ARCHIVED_PURGE_FAILED.en());
        assert_eq!(failed.detail.as_deref(), Some("A task is running"), "a reason beats a count");
        let counted = report(PurgeOutcome { remaining: 2, ..base.clone() });
        assert_eq!(counted.detail.as_deref(), Some("2 tasks are still there. Try again."));
        let unverified = report(PurgeOutcome { verified: false, ..base });
        assert_eq!(unverified.detail.as_deref(), Some(copy::ARCHIVED_PURGE_UNVERIFIED.en()));
    }
}
