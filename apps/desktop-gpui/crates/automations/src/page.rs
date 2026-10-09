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

//! The Scheduled tasks page, after Desktop's `ScheduledTaskPanel`
//! (packages/ui/src/scheduled-task-panel.tsx), its detail
//! (scheduled-task-detail.tsx) and form (scheduled-task-form-dialog.tsx),
//! and the automations hub around it (module-hub-host.tsx): the page
//! ([`AutomationsView::render_page`]), headed by its title, the active
//! count, New scheduled task and the page menu (Refresh, Keep system
//! awake), then the Scheduled tasks and Daily review tabs, My scheduled
//! tasks and Run history, and a task's detail and form in dialogs.

use std::time::Duration;

use chrono::{DateTime, FixedOffset, Local};
use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::Dialog;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, IconName, Selectable as _, Sizable as _,
    StyledExt as _, ThemeStyled as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, KeyBinding, MouseButton, MouseDownEvent,
    ParentElement as _, Render, Role, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledText, Subscription, Task, TestSupportExt as _, TextRun, Window, div,
    prelude::FluentBuilder as _, relative, rems,
};
use host_protocol::{
    ScheduledTask, ScheduledTaskRun, ScheduledTaskRunOutcome, ScheduledTaskSchedule,
    ScheduledTaskStatus,
};
use shared::copy::automations as copy;
use shared::copy::{self as shell_copy, Locale, Text};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::layout::PAGE_MAX_WIDTH_REMS;
use shared::menu::{MenuEntry, MenuItem, MenuSlot};
use shared::rows::list_row;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, banner, banner_description, banner_title, control_button,
    destructive_button, floating_surface, page_bar, page_header, page_tabs, quiet_button, segment,
    segmented_track, selectable_row, tabular_nums,
};
use shared::theme::{FadedSwitch, Surface};
use workspace::actions::FocusSearch;

use crate::awake::KeepSystemAwake;
use crate::catalog::{ActionFailure, ScheduledTasks, TaskChange};
use crate::form::FormSeed;
use crate::form_view::{TaskForm, TaskFormEvent};
use crate::model::{
    RunRange, Semantic, TaskFilter, TaskSort, awaits_desktop, compare, countdown,
    delivered_by_desktop, delivery_label, dotted, is_terminal, matches_search, normalize_query,
    recurrence_label, run_label, run_semantic, status_label, status_semantic, task_time,
};
use crate::review::{DailyReviewEvent, DailyReviewView};
use crate::widgets::{
    Choice, ChoiceSelect, dialog_label, divider, empty_state, fact, fact_list, failure, notice,
    rows_with_rules, status_dot,
};

/// Key context of the page's body, where the listed tasks are one Tab
/// stop: Up, Down, Home, and End move through them, Enter or Space opens
/// the one under the cursor.
pub const SCHEDULED_TASK_LIST_CONTEXT: &str = "ScheduledTaskList";

/// Key context of the whole page: ⌘F moves focus to the tasks' search
/// while it shows.
pub const SCHEDULED_TASKS_PAGE_CONTEXT: &str = "ScheduledTasksPage";

/// The page menu's least width (224px).
const PAGE_MENU_WIDTH_REMS: f32 = 14.;
/// A task row's end lane: "Needs Maka Desktop" and "in 11 months" fit.
const LANE_WIDTH_REMS: f32 = 8.;

/// The list controls' widths (Desktop's 220, 172, and 148px).
const SEARCH_WIDTH_REMS: f32 = 13.75;
const SORT_WIDTH_REMS: f32 = 10.75;
const FILTER_WIDTH_REMS: f32 = 9.25;
/// Desktop's `Toolbar size="sm"`: every control in the page's toolbar is
/// its small element, 28 tall, as the view switch is; 12 between them.
const TOOLBAR_CONTROL_REMS: f32 = 1.75;

/// The views' segmented switch.
const VIEWS_WIDTH_REMS: f32 = 15.;

/// The detail dialog (Desktop's 560px).
const DETAIL_WIDTH_REMS: f32 = 35.;

/// The longest search query kept, as Desktop's field.
const SEARCH_MAX_CHARS: usize = 120;

/// From this many tasks on, the search, sort, and filter show
/// (`showListControls`); a narrowed list keeps them.
const LIST_CONTROLS_FROM: usize = 8;

/// How often the countdowns and "is it due" move on.
const CLOCK_TICK: Duration = Duration::from_secs(30);

gpui_kit::actions!(
    scheduled_task_list,
    [
        /// Move to the task above.
        SelectPreviousScheduledTask,
        /// Move to the task below.
        SelectNextScheduledTask,
        /// Move to the first task.
        SelectFirstScheduledTask,
        /// Move to the last task.
        SelectLastScheduledTask,
        /// Open the detail of the task under the cursor.
        OpenScheduledTask,
    ]
);

/// Binds the page's keys. Called by [`crate::init`].
pub(crate) fn bind_keys(cx: &mut App) {
    let context = Some(SCHEDULED_TASK_LIST_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("up", SelectPreviousScheduledTask, context),
        KeyBinding::new("down", SelectNextScheduledTask, context),
        KeyBinding::new("home", SelectFirstScheduledTask, context),
        KeyBinding::new("end", SelectLastScheduledTask, context),
        KeyBinding::new("enter", OpenScheduledTask, context),
        KeyBinding::new("space", OpenScheduledTask, context),
        KeyBinding::new("secondary-f", FocusSearch, Some(SCHEDULED_TASKS_PAGE_CONTEXT)),
    ]);
}

/// The page's tabs (Desktop's automations modules).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HubTab {
    ScheduledTasks,
    DailyReview,
}

/// The Scheduled tasks tab's views.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TasksView {
    Tasks,
    Runs,
}

/// What the page asks of the window it is in.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AutomationsEvent {
    /// Show this task (from the Daily review's active tasks).
    OpenTask(SharedString),
    /// Add this text to the composer's draft.
    AppendToComposer(String),
    /// Show Settings at Daily review.
    OpenDailyReviewSettings,
}

/// The action in flight: one at a time; the control that started it shows
/// it.
#[derive(Debug, Clone, PartialEq)]
enum Pending {
    Refresh,
    Change(SharedString, TaskChange),
}

/// Behavior and presentation owner of the page. The catalog
/// ([`ScheduledTasks`]) owns what the Host says; this view owns the tab
/// and view shown, the search, sort, filter, and run range, the keyboard
/// cursor, the task whose detail is open, the form while it shows, the one
/// action in flight and what the last one said, and the clock the
/// countdowns read. It lives as long as its window, so leaving the page
/// and coming back finds it as it was.
pub struct AutomationsView {
    catalog: Entity<ScheduledTasks>,
    /// The page's "…" menu, while it is open.
    page_menu: MenuSlot,
    /// Keep system awake, when the app offers it.
    awake: Option<Entity<KeepSystemAwake>>,
    review: Entity<DailyReviewView>,
    tab: HubTab,
    view: TasksView,
    sort: TaskSort,
    filter: TaskFilter,
    range: RunRange,
    search: Entity<InputState>,
    sort_select: Entity<ChoiceSelect<TaskSort>>,
    filter_select: Entity<ChoiceSelect<TaskFilter>>,
    range_select: Entity<ChoiceSelect<RunRange>>,
    /// The body's focus: the listed tasks' Tab stop.
    focus: FocusHandle,
    scroll: ScrollHandle,
    /// The task under the keyboard cursor, by id.
    cursor: Option<SharedString>,
    /// The task whose detail dialog is open, by id.
    detail: Option<SharedString>,
    /// The form while its dialog shows, and the task whose detail it
    /// replaced, which shows again after it.
    form: Option<(Entity<TaskForm>, Option<SharedString>)>,
    pending: Option<Pending>,
    feedback: Option<ActionFailure>,
    /// "Now" for the countdowns, in the local zone; moves every
    /// [`CLOCK_TICK`].
    now: DateTime<FixedOffset>,
    _clock: Task<()>,
    _action: Option<Task<()>>,
    _form: Option<Subscription>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<AutomationsEvent> for AutomationsView {}

impl std::fmt::Debug for AutomationsView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutomationsView")
            .field("tab", &self.tab)
            .field("view", &self.view)
            .field("detail", &self.detail)
            .field("pending", &self.pending)
            .finish_non_exhaustive()
    }
}

impl AutomationsView {
    pub fn new(
        catalog: Entity<ScheduledTasks>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let host = catalog.read(cx).host().clone();
        let review = cx.new(|cx| DailyReviewView::new(host, cx));
        let awake = KeepSystemAwake::try_global(cx);
        let locale = Locale::current(cx);
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder(copy::SEARCH_PLACEHOLDER.in_locale(locale))
        });
        let sort_select = cx.new(|cx| {
            let mut select = ChoiceSelect::new(sort_choices(locale), None, window, cx);
            select.set_selected_value(&TaskSort::default(), window, cx);
            select
        });
        let filter_select = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let range_select = cx.new(|cx| {
            let mut select = ChoiceSelect::new(range_choices(locale), None, window, cx);
            select.set_selected_value(&RunRange::default(), window, cx);
            select
        });
        let mut subscriptions = vec![
            cx.observe_in(&catalog, window, |this, _, window, cx| {
                this.sync_filter_choices(window, cx);
                cx.notify();
            }),
            cx.subscribe_in(&search, window, |this, search, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    let value = search.read(cx).value();
                    if value.chars().count() > SEARCH_MAX_CHARS {
                        let kept: String = value.chars().take(SEARCH_MAX_CHARS).collect();
                        search.update(cx, |search, cx| search.set_value(kept, window, cx));
                    }
                    this.cursor = None;
                    this.sync_filter_choices(window, cx);
                    cx.notify();
                }
            }),
            cx.subscribe(
                &sort_select,
                |this, _, event: &SelectEvent<Vec<Choice<TaskSort>>>, cx| {
                    if let SelectEvent::Confirm(Some(sort)) = event {
                        this.sort = *sort;
                        cx.notify();
                    }
                },
            ),
            cx.subscribe(
                &filter_select,
                |this, _, event: &SelectEvent<Vec<Choice<TaskFilter>>>, cx| {
                    if let SelectEvent::Confirm(Some(filter)) = event {
                        this.filter = *filter;
                        this.cursor = None;
                        cx.notify();
                    }
                },
            ),
            cx.subscribe(
                &range_select,
                |this, _, event: &SelectEvent<Vec<Choice<RunRange>>>, cx| {
                    if let SelectEvent::Confirm(Some(range)) = event {
                        this.range = *range;
                        cx.notify();
                    }
                },
            ),
            cx.subscribe(&review, |_, _, event: &DailyReviewEvent, cx| {
                cx.emit(match event {
                    DailyReviewEvent::OpenTask(id) => AutomationsEvent::OpenTask(id.clone()),
                    DailyReviewEvent::AppendToComposer(text) => {
                        AutomationsEvent::AppendToComposer(text.clone())
                    }
                    DailyReviewEvent::OpenSettings => AutomationsEvent::OpenDailyReviewSettings,
                });
            }),
            cx.observe(&review, |_, _, cx| cx.notify()),
            cx.observe_global_in::<Locale>(window, |this, window, cx| this.relabel(window, cx)),
        ];
        // The countdowns move with the clock, not only with the catalog.
        let clock = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(CLOCK_TICK).await;
                let tick = this.update(cx, |this, cx| {
                    this.now = Local::now().fixed_offset();
                    cx.notify();
                });
                if tick.is_err() {
                    break;
                }
            }
        });
        if let Some(awake) = &awake {
            subscriptions.push(cx.observe(awake, |_, _, cx| cx.notify()));
        }
        let mut this = Self {
            catalog,
            awake,
            review,
            tab: HubTab::ScheduledTasks,
            view: TasksView::Tasks,
            sort: TaskSort::default(),
            filter: TaskFilter::default(),
            range: RunRange::default(),
            search,
            sort_select,
            filter_select,
            range_select,
            focus: cx.focus_handle().tab_stop(true),
            scroll: ScrollHandle::new(),
            cursor: None,
            detail: None,
            form: None,
            pending: None,
            feedback: None,
            now: Local::now().fixed_offset(),
            _clock: clock,
            _action: None,
            _form: None,
            page_menu: MenuSlot::default(),
            _subscriptions: subscriptions,
        };
        this.sync_filter_choices(window, cx);
        this
    }

    pub fn catalog(&self) -> &Entity<ScheduledTasks> {
        &self.catalog
    }

    pub fn review(&self) -> &Entity<DailyReviewView> {
        &self.review
    }

    pub fn search(&self) -> &Entity<InputState> {
        &self.search
    }

    pub fn tab(&self) -> HubTab {
        self.tab
    }

    pub fn tasks_view(&self) -> TasksView {
        self.view
    }

    /// The task whose detail is open.
    pub fn detail(&self) -> Option<&SharedString> {
        self.detail.as_ref()
    }

    /// The form while its dialog shows.
    pub fn form(&self) -> Option<&Entity<TaskForm>> {
        self.form.as_ref().map(|(form, _)| form)
    }

    /// Whether an action is in flight.
    pub fn is_busy(&self) -> bool {
        self.pending.is_some()
    }

    /// The page shows: the Daily review is read the first time its tab
    /// does.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.now = Local::now().fixed_offset();
        if self.tab == HubTab::DailyReview {
            self.review.update(cx, |review, cx| review.activate(cx));
        }
    }

    /// Moves focus to the page's body.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }

    pub fn set_tab(&mut self, tab: HubTab, cx: &mut Context<Self>) {
        self.tab = tab;
        if tab == HubTab::DailyReview {
            self.review.update(cx, |review, cx| review.activate(cx));
        }
        cx.notify();
    }

    pub fn set_view(&mut self, view: TasksView, cx: &mut Context<Self>) {
        self.view = view;
        self.cursor = None;
        cx.notify();
    }

    fn query(&self, cx: &App) -> String {
        normalize_query(&self.search.read(cx).value())
    }

    /// ⌘F: the tasks' search, its text selected, while it shows (My
    /// scheduled tasks, with enough tasks to search); nothing otherwise.
    fn focus_search(&mut self, _: &FocusSearch, window: &mut Window, cx: &mut Context<Self>) {
        let shows = self.tab == HubTab::ScheduledTasks
            && self.view == TasksView::Tasks
            && self.shows_list_controls(cx);
        if !shows {
            cx.propagate();
            return;
        }
        self.search.update(cx, |search, cx| {
            search.focus(window, cx);
            search.select_all(window, cx);
        });
    }

    fn busy(&self) -> bool {
        self.pending.is_some()
    }

    fn locale_labels(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let (sort, range) = (self.sort, self.range);
        self.sort_select.update(cx, |select, cx| {
            select.set_items(sort_choices(locale), window, cx);
            select.set_selected_value(&sort, window, cx);
        });
        self.range_select.update(cx, |select, cx| {
            select.set_items(range_choices(locale), window, cx);
            select.set_selected_value(&range, window, cx);
        });
    }

    /// The language changed: the placeholder and every dropdown's labels.
    fn relabel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let placeholder = copy::SEARCH_PLACEHOLDER.get(cx);
        self.search.update(cx, |search, cx| search.set_placeholder(placeholder, window, cx));
        self.locale_labels(window, cx);
        self.sync_filter_choices(window, cx);
    }

    /// The status filter's options carry their counts among the tasks the
    /// search finds (`filterCounts`); they follow the catalog and the
    /// search, never render.
    fn sync_filter_choices(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let query = self.query(cx);
        let matched: Vec<ScheduledTask> = self
            .catalog
            .read(cx)
            .tasks()
            .unwrap_or_default()
            .iter()
            .filter(|task| matches_search(task, &query, locale))
            .cloned()
            .collect();
        let choices = TaskFilter::ALL
            .into_iter()
            .map(|filter| {
                let count = matched.iter().filter(|task| filter.keeps(task)).count();
                Choice::new(
                    filter,
                    copy::filter_option(locale, filter.label().in_locale(locale), count),
                )
            })
            .collect();
        let filter = self.filter;
        self.filter_select.update(cx, |select, cx| {
            select.set_items(choices, window, cx);
            select.set_selected_value(&filter, window, cx);
        });
    }

    /// Reads the catalog again (the page menu's Refresh).
    pub fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let read = self.catalog.update(cx, |catalog, cx| catalog.read(cx));
        let read = cx.spawn(async move |_, _| {
            read.await;
            Ok(())
        });
        self.run(Pending::Refresh, read, |_, _, _, _| {}, window, cx);
    }

    /// Runs `action` as the one action in flight: nothing while another
    /// runs. A failure is said where the person is looking: in the open
    /// detail, else at the top of the page.
    fn run(
        &mut self,
        pending: Pending,
        action: Task<Result<(), ActionFailure>>,
        then: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>, bool) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy() {
            return;
        }
        self.pending = Some(pending);
        self.feedback = None;
        cx.notify();
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let outcome = action.await;
            this.update_in(cx, |this, window, cx| {
                this.pending = None;
                let ok = outcome.is_ok();
                if let Err(failure) = outcome {
                    this.feedback = Some(failure);
                }
                then(this, window, cx, ok);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Changes a task: enables or pauses it, runs it now, snoozes it.
    pub fn change(
        &mut self,
        task_id: SharedString,
        change: TaskChange,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy() {
            return;
        }
        let deleting = change == TaskChange::Delete;
        let task =
            self.catalog.update(cx, |catalog, cx| catalog.change(&task_id, change.clone(), cx));
        let changed = task_id.clone();
        self.run(
            Pending::Change(task_id, change),
            task,
            move |this, window, cx, ok| {
                if ok && deleting {
                    if this.detail.as_ref() == Some(&changed) {
                        // The confirmation closed first; the detail is on top.
                        if window.has_active_dialog(cx) {
                            window.close_dialog(cx);
                        }
                        this.detail_closed(cx);
                    }
                    if this.cursor.as_ref() == Some(&changed) {
                        this.cursor = None;
                    }
                }
            },
            window,
            cx,
        );
    }

    /// Asks before clearing a task's runs (`clearRunHistory`'s confirm).
    pub fn confirm_clear(
        &mut self,
        task_id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(title) = self.catalog.read(cx).task(&task_id).map(|task| task.title.clone())
        else {
            return;
        };
        let locale = Locale::current(cx);
        self.confirm(
            copy::clear_title(locale, &title),
            copy::CLEAR_BODY,
            copy::CLEAR_RUNS,
            task_id,
            TaskChange::ClearHistory,
            window,
            cx,
        );
    }

    /// Asks before deleting a task (`delete`'s confirm).
    pub fn confirm_delete(
        &mut self,
        task_id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(title) = self.catalog.read(cx).task(&task_id).map(|task| task.title.clone())
        else {
            return;
        };
        let locale = Locale::current(cx);
        self.confirm(
            copy::delete_title(locale, &title),
            copy::DELETE_BODY,
            shell_copy::DELETE,
            task_id,
            TaskChange::Delete,
            window,
            cx,
        );
    }

    fn confirm(
        &mut self,
        title: String,
        body: Text,
        ok: Text,
        task_id: SharedString,
        change: TaskChange,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let title: SharedString = title.into();
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (view, task_id, change) = (view.clone(), task_id.clone(), change.clone());
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(title.clone()))
                .description(shared::dialog::confirmation_text(body.get(cx)))
                .footer(shared::dialog::confirmation_answers(
                    shell_copy::CANCEL.get(cx),
                    ok.get(cx),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    let (task_id, change) = (task_id.clone(), change.clone());
                    view.update(cx, |view, cx| view.change(task_id, change, window, cx)).ok();
                    true
                })
        });
    }

    /// Opens the detail of `task_id` in a dialog.
    pub fn open_detail(
        &mut self,
        task_id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.detail.is_some() || window.has_active_dialog(cx) {
            return;
        }
        self.detail = Some(task_id.clone());
        self.cursor = Some(task_id);
        self.feedback = None;
        let view = cx.entity();
        window.open_dialog(cx, move |dialog, window, cx| {
            view.update(cx, |view, cx| view.detail_dialog(dialog, window, cx))
        });
        cx.notify();
    }

    /// The detail went away (Escape, the close button, a press outside, or
    /// its task was deleted, or the form took its place).
    fn detail_closed(&mut self, cx: &mut Context<Self>) {
        self.detail = None;
        self.feedback = None;
        cx.notify();
    }

    /// New scheduled task: the form, blank.
    pub fn open_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let seed = FormSeed::blank(&Local::now());
        self.open_form(seed, window, cx);
    }

    /// Edit or Duplicate from the detail: the form takes the detail's
    /// place and gives it back when it closes.
    pub fn open_edit(
        &mut self,
        task_id: SharedString,
        duplicate: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(task) = self.catalog.read(cx).task(&task_id).cloned() else {
            return;
        };
        let now = Local::now();
        let seed = if duplicate {
            FormSeed::duplicate(&task, &now, Locale::current(cx))
        } else {
            FormSeed::edit(&task, &now)
        };
        self.open_form(seed, window, cx);
    }

    fn open_form(&mut self, seed: FormSeed, window: &mut Window, cx: &mut Context<Self>) {
        if self.form.is_some() || self.busy() {
            return;
        }
        let returns_to = self.detail.clone();
        if returns_to.is_some() {
            window.close_dialog(cx);
            self.detail_closed(cx);
        } else if window.has_active_dialog(cx) {
            return;
        }
        let catalog = self.catalog.clone();
        let form = cx.new(|cx| TaskForm::new(catalog, seed, window, cx));
        self._form =
            Some(cx.subscribe_in(&form, window, |this, _, event: &TaskFormEvent, window, cx| {
                if *event == TaskFormEvent::Done {
                    window.close_dialog(cx);
                    this.form_closed(window, cx);
                }
            }));
        self.form = Some((form.clone(), returns_to));
        let view = cx.entity().downgrade();
        let shown = form.clone();
        window.open_dialog(cx, move |dialog, window, cx| {
            let view = view.clone();
            shown.update(cx, |form, cx| form.dialog(dialog, window, cx)).on_close(
                move |_, window, cx| {
                    view.update(cx, |view, cx| view.form_closed(window, cx)).ok();
                },
            )
        });
        cx.defer_in(window, move |_, window, cx| {
            let title = form.read(cx).title_input().clone();
            title.update(cx, |title, cx| title.focus(window, cx));
        });
        cx.notify();
    }

    /// The form went away: the detail it replaced shows again.
    fn form_closed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((_, returns_to)) = self.form.take() else {
            return;
        };
        self._form = None;
        if let Some(task_id) = returns_to.filter(|id| self.catalog.read(cx).task(id).is_some()) {
            cx.defer_in(window, move |this, window, cx| this.open_detail(task_id, window, cx));
        }
        cx.notify();
    }

    /// Keep system awake, from the page menu; a failed save puts it back
    /// and says so (Desktop's toast).
    pub fn toggle_keep_awake(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(awake) = self.awake.clone() else {
            return;
        };
        let enabled = !awake.read(cx).is_enabled();
        let saved = awake.update(cx, |awake, cx| awake.set_enabled(enabled, cx));
        cx.spawn_in(window, async move |_, cx| {
            if saved.await.is_err() {
                cx.update(|window, cx| {
                    let failure = Notification::error(copy::KEEP_AWAKE_FALLBACK.get(cx))
                        .title(copy::KEEP_AWAKE_FAILED.get(cx));
                    window.push_notification(failure, cx);
                })
                .ok();
            }
        })
        .detach();
    }

    /// The tasks the search and the filter keep, in the chosen order.
    fn visible_tasks(&self, cx: &App) -> Vec<ScheduledTask> {
        let locale = Locale::current(cx);
        let query = self.query(cx);
        let mut tasks: Vec<ScheduledTask> = self
            .catalog
            .read(cx)
            .tasks()
            .unwrap_or_default()
            .iter()
            .filter(|task| matches_search(task, &query, locale) && self.filter.keeps(task))
            .cloned()
            .collect();
        tasks.sort_by(|a, b| compare(a, b, self.sort));
        tasks
    }

    /// Moves the cursor, while the list's Tab stop itself has focus.
    fn move_cursor(&mut self, step: CursorStep, window: &Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window)
            || self.tab != HubTab::ScheduledTasks
            || self.view != TasksView::Tasks
        {
            cx.propagate();
            return;
        }
        let ids: Vec<SharedString> =
            self.visible_tasks(cx).into_iter().map(|task| task.id.into()).collect();
        let Some(last) = ids.len().checked_sub(1) else {
            return;
        };
        let current =
            self.cursor.as_ref().and_then(|cursor| ids.iter().position(|id| id == cursor));
        let target = match (step, current) {
            (CursorStep::First, _) | (CursorStep::Next, None) => 0,
            (CursorStep::Last, _) | (CursorStep::Previous, None) => last,
            (CursorStep::Next, Some(ix)) => (ix + 1).min(last),
            (CursorStep::Previous, Some(ix)) => ix.saturating_sub(1),
        };
        self.cursor = Some(ids[target].clone());
        cx.notify();
    }

    fn select_previous(
        &mut self,
        _: &SelectPreviousScheduledTask,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_cursor(CursorStep::Previous, window, cx);
    }

    fn select_next(
        &mut self,
        _: &SelectNextScheduledTask,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_cursor(CursorStep::Next, window, cx);
    }

    fn select_first(
        &mut self,
        _: &SelectFirstScheduledTask,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_cursor(CursorStep::First, window, cx);
    }

    fn select_last(
        &mut self,
        _: &SelectLastScheduledTask,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_cursor(CursorStep::Last, window, cx);
    }

    fn open_cursor(&mut self, _: &OpenScheduledTask, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window)
            || self.tab != HubTab::ScheduledTasks
            || self.view != TasksView::Tasks
        {
            cx.propagate();
            return;
        }
        let visible = self.visible_tasks(cx);
        if let Some(cursor) = self
            .cursor
            .clone()
            .filter(|cursor| visible.iter().any(|task| task.id == cursor.as_ref()))
        {
            self.open_detail(cursor, window, cx);
        }
    }

    /// The page's meta beside its title: the active count, or the Daily
    /// review's task count.
    pub fn header_meta(&self, cx: &App) -> Option<String> {
        match self.tab {
            HubTab::ScheduledTasks => {
                let catalog = self.catalog.read(cx);
                catalog.tasks()?;
                Some(copy::active_count(Locale::current(cx), catalog.active_count()))
            }
            HubTab::DailyReview => self.review.read(cx).meta(cx),
        }
    }

    /// The page header's controls.
    fn render_header_actions(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let actions: Vec<AnyElement> = match self.tab {
            HubTab::DailyReview => {
                self.review.update(cx, |review, cx| review.render_header_actions(cx))
            }
            HubTab::ScheduledTasks => {
                let connected = self.catalog.read(cx).host().read(cx).is_connected();
                let create =
                    control_button(Button::new("scheduled-task-create").primary())
                        .icon(Icon::new(shared::icons::MakaIcon::Plus))
                        .label(copy::CREATE.get(cx))
                        .disabled(!connected)
                        .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                            this.open_create(window, cx)
                        }));
                vec![create.into_any_element(), self.render_page_menu(cx)]
            }
        };
        h_flex()
            .id("scheduled-tasks-actions")
            .test_support()
            .flex_shrink_0()
            .gap_2()
            .children(actions)
            .into_any_element()
    }

    /// The page menu: Refresh, and Keep system awake where it is offered.
    fn render_page_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let refreshing = self.pending == Some(Pending::Refresh);
        // 32px, the height of New scheduled task beside it.
        let button = Button::new("scheduled-tasks-menu")
            .ghost()
            .small()
            .size_8()
            .icon(Icon::new(IconName::Ellipsis).size_4().text_color(maka.ink_muted))
            .loading(refreshing)
            .selected(self.page_menu.is_open())
            .accessibility_label(copy::PAGE_SETTINGS.get(cx))
            .tooltip(copy::PAGE_SETTINGS.get(cx))
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                let width = window.rem_size() * PAGE_MENU_WIDTH_REMS;
                MenuSlot::toggle(
                    this,
                    |view| &mut view.page_menu,
                    event,
                    Self::page_menu_entries,
                    width,
                    window,
                    cx,
                );
            }));
        div().relative().child(button).children(self.page_menu.layer()).into_any_element()
    }

    /// Refresh, and Keep system awake where the app offers it.
    fn page_menu_entries(&self, cx: &mut Context<Self>) -> Vec<MenuEntry> {
        let view = cx.entity().downgrade();
        let refreshing = self.pending == Some(Pending::Refresh);
        let label = if refreshing { copy::REFRESHING } else { copy::REFRESH };
        let refresh = view.clone();
        let mut entries: Vec<MenuEntry> = vec![
            MenuItem::new("refresh", label.get(cx))
                .icon(Icon::new(IconName::RotateCw))
                .disabled(self.busy())
                .on_select(move |window, cx| {
                    refresh.update(cx, |view, cx| view.refresh(window, cx)).ok();
                })
                .into(),
        ];
        let awake = self.awake.as_ref().map(|awake| awake.read(cx)).and_then(|awake| {
            awake.is_supported().then(|| (awake.is_enabled(), awake.is_saving()))
        });
        if let Some((enabled, saving)) = awake {
            entries.push(MenuEntry::Separator);
            entries.push(
                MenuItem::new("keep-awake", copy::KEEP_AWAKE.get(cx))
                    .checked(enabled)
                    .disabled(saving)
                    .on_select(move |window, cx| {
                        view.update(cx, |view, cx| view.toggle_keep_awake(window, cx)).ok();
                    })
                    .into(),
            );
        }
        entries
    }

    /// The page under the header: its bar (the tabs, and the view's
    /// controls at the row's end), what the last action said, and the tab's
    /// body, in the page's column, which scrolls inside the plate.
    pub fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let selected = match self.tab {
            HubTab::ScheduledTasks => 0,
            HubTab::DailyReview => 1,
        };
        let shown = match self.tab {
            HubTab::ScheduledTasks => copy::TAB_SCHEDULED_TASKS,
            HubTab::DailyReview => copy::TAB_DAILY_REVIEW,
        };
        let spoken: SharedString = copy::hub_content(locale, shown.in_locale(locale)).into();
        let view = cx.entity().downgrade();
        let tabs = page_tabs(
            "automations-tabs",
            spoken.clone(),
            [
                ("scheduled-tasks", copy::TAB_SCHEDULED_TASKS),
                ("daily-review", copy::TAB_DAILY_REVIEW),
            ]
            .into_iter()
            .map(|(key, label)| {
                let label: SharedString = label.get(cx).into();
                (domain_element_id("automations-tab", key), label.clone(), label)
            })
            .collect(),
            selected,
            move |ix, _, cx| {
                let tab = if ix == 1 { HubTab::DailyReview } else { HubTab::ScheduledTasks };
                view.update(cx, |view, cx| view.set_tab(tab, cx)).ok();
            },
            cx,
        );
        let meta = self.header_meta(cx).map(SharedString::from);
        let actions = self.render_header_actions(window, cx);
        let header =
            page_header(shell_copy::extensions::SCHEDULED_TASKS.get(cx), meta, actions, cx);
        let (toolbar, content) = match self.tab {
            HubTab::ScheduledTasks => {
                let keyboard = self.focus.is_focused(window) && window.last_input_was_keyboard();
                let toolbar = self.render_toolbar(cx);
                let content = match self.view {
                    TasksView::Tasks => self.render_tasks(keyboard, window, cx),
                    TasksView::Runs => self.render_runs(cx),
                };
                (toolbar, content)
            }
            HubTab::DailyReview => {
                let now = self.now;
                self.review.update(cx, |review, cx| {
                    (review.render_toolbar(cx), review.render_body(&now, window, cx))
                })
            }
        };
        let feedback = self
            .feedback
            .filter(|_| self.detail.is_none() && self.tab == HubTab::ScheduledTasks)
            .map(|failure_value| failure("scheduled-tasks-feedback", &failure_value, cx));
        let maka = cx.maka();
        div()
            .id("scheduled-tasks-page")
            .test_support()
            .key_context(SCHEDULED_TASKS_PAGE_CONTEXT)
            .on_action(cx.listener(Self::focus_search))
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(
                div()
                    .id("scheduled-tasks-body")
                    .test_support()
                    .track_focus(&self.focus)
                    .key_context(SCHEDULED_TASK_LIST_CONTEXT)
                    .on_action(cx.listener(Self::select_previous))
                    .on_action(cx.listener(Self::select_next))
                    .on_action(cx.listener(Self::select_first))
                    .on_action(cx.listener(Self::select_last))
                    .on_action(cx.listener(Self::open_cursor))
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        v_flex()
                            .w_full()
                            .max_w(rems(PAGE_MAX_WIDTH_REMS))
                            .mx_auto()
                            .px_6()
                            .pb_12()
                            .gap_5()
                            .text_color(maka.ink)
                            .child(v_flex().gap_4().child(header).child(page_bar(tabs, toolbar)))
                            .children(feedback)
                            .child(content),
                    ),
            )
            .child(Scrollbar::vertical(&self.scroll))
            .into_any_element()
    }

    /// Whether the search, sort, and filter show.
    fn shows_list_controls(&self, cx: &App) -> bool {
        let count = self.catalog.read(cx).tasks().map_or(0, <[ScheduledTask]>::len);
        count >= LIST_CONTROLS_FROM
            || !self.query(cx).is_empty()
            || self.filter != TaskFilter::All
            || self.sort != TaskSort::CreatedDesc
    }

    /// My scheduled tasks | Run history, and the view's controls, for the
    /// end of the page's bar.
    fn render_toolbar(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let views = [
            (TasksView::Tasks, copy::VIEW_TASKS, "tasks"),
            (TasksView::Runs, copy::VIEW_RUNS, "runs"),
        ];
        let current = self.view;
        let track = segmented_track(cx)
            .id("scheduled-task-views")
            .test_support()
            .aria_label(copy::VIEWS.get(cx))
            .w(rems(VIEWS_WIDTH_REMS))
            .children(views.map(|(view, label, key)| {
                let button = Button::new(domain_element_id("scheduled-task-view", key)).on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| this.set_view(view, cx)),
                );
                segment(button, label.get(cx), current == view, cx)
            }));
        let controls: Vec<AnyElement> = match self.view {
            TasksView::Tasks if self.shows_list_controls(cx) => vec![
                Input::new(&self.search)
                    .field_fill(cx)
                    .px_3()
                    .h(rems(TOOLBAR_CONTROL_REMS))
                    .w(rems(SEARCH_WIDTH_REMS))
                    .aria_label(copy::SEARCH.get(cx))
                    .prefix(Icon::new(shared::icons::MakaIcon::Search).small())
                    .cleanable(true)
                    .into_any_element(),
                sized_select(
                    Select::new(&self.sort_select)
                        .id("scheduled-tasks-sort")
                        .h(rems(TOOLBAR_CONTROL_REMS))
                        .accessibility_label(copy::SORT.get(cx)),
                    SORT_WIDTH_REMS,
                ),
                sized_select(
                    Select::new(&self.filter_select)
                        .id("scheduled-tasks-filter")
                        .h(rems(TOOLBAR_CONTROL_REMS))
                        .accessibility_label(copy::FILTER.get(cx)),
                    FILTER_WIDTH_REMS,
                ),
            ],
            TasksView::Tasks => Vec::new(),
            TasksView::Runs => vec![sized_select(
                Select::new(&self.range_select)
                    .id("scheduled-tasks-range")
                    .h(rems(TOOLBAR_CONTROL_REMS))
                    .accessibility_label(copy::RANGE.get(cx)),
                FILTER_WIDTH_REMS,
            )],
        };
        Some(
            h_flex()
                .id("scheduled-tasks-toolbar")
                .test_support()
                .flex_wrap()
                .justify_end()
                .items_center()
                .gap_3()
                .child(track)
                .children(controls)
                .into_any_element(),
        )
    }

    /// My scheduled tasks: every listed task, one row each, the Tab stop's
    /// rows; or what the page says instead.
    fn render_tasks(
        &mut self,
        keyboard: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let (read, loading, error, connected) = {
            let catalog = self.catalog.read(cx);
            (
                catalog.tasks().map(<[ScheduledTask]>::len),
                catalog.is_loading(),
                catalog.error().copied(),
                catalog.host().read(cx).is_connected(),
            )
        };
        let Some(count) = read else {
            if let Some(error) = error {
                return self.render_read_error(&error, cx);
            }
            if !connected {
                return notice("scheduled-tasks-offline", copy::OFFLINE.get(cx), cx);
            }
            let _ = loading;
            return render_skeleton();
        };
        let mut sections = Vec::new();
        if let Some(error) = error {
            sections.push(self.render_read_error(&error, cx));
        }
        let query = self.query(cx);
        let tasks = self.visible_tasks(cx);
        if !query.is_empty() {
            let matched = self
                .catalog
                .read(cx)
                .tasks()
                .unwrap_or_default()
                .iter()
                .filter(|task| matches_search(task, &query, locale))
                .count();
            sections.push(self.render_search_summary(matched, cx));
        }
        if count == 0 {
            let create = control_button(Button::new("scheduled-task-empty-create").primary())
                .label(copy::CREATE.get(cx))
                .disabled(!connected)
                .on_click(
                    cx.listener(|this, _: &ClickEvent, window, cx| this.open_create(window, cx)),
                )
                .into_any_element();
            sections.push(empty_state(
                "scheduled-tasks-empty",
                Icon::new(AssetIcon::Clock),
                copy::EMPTY_TITLE.get(cx),
                Some(copy::EMPTY_BODY.get(cx)),
                Some(create),
                cx,
            ));
        } else if tasks.is_empty() {
            // The reader narrowed the list: the way out resets both.
            let searching = !query.is_empty();
            let clear = quiet_button(Button::new("scheduled-tasks-reset"), cx)
                .label(copy::CLEAR_SEARCH.get(cx))
                .on_click(
                    cx.listener(|this, _: &ClickEvent, window, cx| this.reset_list(window, cx)),
                )
                .into_any_element();
            let (title, body) = if searching {
                (copy::NO_SEARCH_TITLE, copy::NO_SEARCH_BODY)
            } else {
                (copy::NO_FILTER_TITLE, copy::NO_FILTER_BODY)
            };
            sections.push(empty_state(
                "scheduled-tasks-no-match",
                Icon::new(AssetIcon::Clock),
                title.get(cx),
                Some(body.get(cx)),
                Some(clear),
                cx,
            ));
        } else {
            let len = tasks.len();
            let rows = tasks
                .iter()
                .enumerate()
                .map(|(ix, task)| self.render_task_row(task, keyboard, (ix, len), window, cx))
                .collect();
            sections.push(rows_with_rules("scheduled-tasks-list", copy::LIST.get(cx), rows, cx));
        }
        v_flex().gap_4().children(sections).into_any_element()
    }

    /// Clear search on a narrowed list: the query and the filter.
    fn reset_list(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |search, cx| search.set_value("", window, cx));
        self.filter = TaskFilter::All;
        self.sync_filter_choices(window, cx);
        cx.notify();
    }

    fn render_search_summary(&self, count: usize, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        h_flex()
            .id("scheduled-tasks-search-summary")
            .test_support()
            .aria_label(copy::search_matches(locale, count))
            .gap_2()
            .text_xs()
            .text_color(cx.maka().ink_muted)
            .child(copy::search_matches(locale, count))
            .child(
                quiet_button(Button::new("scheduled-tasks-clear-search"), cx)
                    .label(copy::CLEAR_SEARCH.get(cx))
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.search.update(cx, |search, cx| search.set_value("", window, cx));
                        this.sync_filter_choices(window, cx);
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    /// A failed read: why, and Retry.
    fn render_read_error(
        &self,
        failure_value: &ActionFailure,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let retry = quiet_button(Button::new("scheduled-tasks-retry"), cx)
            .label(shell_copy::RETRY.get(cx))
            .disabled(self.busy())
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.catalog.update(cx, |catalog, cx| catalog.reload(cx));
            }));
        h_flex()
            .items_start()
            .gap_2()
            .child(failure("scheduled-tasks-read-failed", failure_value, cx))
            .child(retry)
            .into_any_element()
    }

    /// Whether `task`'s fire waits for Maka Desktop's delivery.
    fn awaits_desktop(&self, task: &ScheduledTask, cx: &App) -> bool {
        awaits_desktop(task, self.catalog.read(cx).is_held(&task.id), self.now.timestamp_millis())
    }

    /// One task, as Desktop's row: its state as a dot, its title, a line
    /// with how it repeats and when it runs next, and at the end how long
    /// until then, or, when it will not run, its state. The state's words
    /// are said once: on the line, or at the end.
    fn render_task_row(
        &self,
        task: &ScheduledTask,
        keyboard: bool,
        (ix, len): (usize, usize),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let id: SharedString = task.id.clone().into();
        let selected = self.detail.as_ref() == Some(&id);
        let cursor = keyboard && self.cursor.as_ref() == Some(&id);
        let RowParts { semantic, description, mono, lane, .. } = self.row_parts(task, cx);
        let label = shell_copy::parts(locale, &[&task.title, &description, &lane]);
        // A fixed lane, so the titles and the times line up row to row.
        let end = h_flex()
            .id(domain_element_id("scheduled-task-lane", &task.id))
            .test_support()
            .aria_label(lane.clone())
            .flex_shrink_0()
            .w(rems(LANE_WIDTH_REMS))
            .justify_end()
            .text_xs()
            .line_height(rems(1.25))
            .text_color(maka.ink_muted)
            .font_features(tabular_nums())
            .child(div().min_w_0().truncate().child(lane));
        let focus = self.focus.clone();
        let opened = id.clone();
        h_flex()
            .id(domain_element_id("scheduled-task-row", &task.id))
            .test_support()
            .role(Role::ListItem)
            .aria_label(label)
            .aria_selected(selected)
            .w_full()
            .min_h(rems(3.5))
            .py_2()
            .gap_3()
            .map(|this| list_row(this, ix, len))
            // Its detail opens in a modal dialog, so a selected fill would
            // only show under the scrim (review round 10): the row hovers
            // and keeps its selection for assistive technology only.
            .map(|this| selectable_row(this, false, cx))
            .when(cursor, |this| this.focus_ring_style(window, cx))
            .on_mouse_down(MouseButton::Left, move |_: &MouseDownEvent, window, cx| {
                // The list's one Tab stop keeps focus, not the row.
                window.prevent_default();
                focus.focus(window, cx);
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.open_detail(opened.clone(), window, cx);
            }))
            .child(status_dot(semantic, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().truncate().text_sm().font_medium().child(task.title.clone()))
                    .child(
                        div()
                            .id(domain_element_id("scheduled-task-description", &task.id))
                            .test_support()
                            .aria_label(description.clone())
                            .truncate()
                            .text_xs()
                            .line_height(rems(1.25))
                            .text_color(maka.ink_muted)
                            .child(with_mono(description, mono, cx)),
                    ),
            )
            .child(end)
            .into_any_element()
    }

    /// A row's dot, second line and end lane. The state's words (a fire
    /// waiting for Maka Desktop, a failed or blocked last run, a state
    /// other than scheduled) go on the line while the task will run, with
    /// the countdown at the end; once it will not (paused, or nothing
    /// next), they take the end instead. The line also says the Agent
    /// source, how it repeats, and its next or last run.
    fn row_parts(&self, task: &ScheduledTask, cx: &App) -> RowParts {
        let locale = Locale::current(cx);
        let zone = self.now.timezone();
        let last = task.runs.first();
        let exception = last.filter(|run| run.outcome != ScheduledTaskRunOutcome::Ok);
        let waiting = self.awaits_desktop(task, cx);
        let (semantic, state) = if waiting {
            (Semantic::Attention, Some(copy::WAITING_FOR_DESKTOP.in_locale(locale)))
        } else if let Some(run) = exception {
            (run_semantic(&run.outcome), Some(run_label(&run.outcome).in_locale(locale)))
        } else {
            let state = (task.status != ScheduledTaskStatus::Active)
                .then(|| status_label(&task.status).in_locale(locale));
            (status_semantic(&task.status), state)
        };
        // A paused task will not run, and a fire past its time that waits
        // on something has no countdown ("Overdue" until it is delivered).
        let now_ms = self.now.timestamp_millis();
        let countdown = task
            .next_fire_at
            .filter(|_| task.status != ScheduledTaskStatus::Paused)
            .filter(|at| state.is_none() || *at as i64 > now_ms)
            .map(|at| countdown(at, now_ms, locale));
        let mut parts: Vec<String> = Vec::new();
        if task.effect.is_agent() {
            parts.push(copy::AGENT_SOURCE.in_locale(locale).to_owned());
        }
        let lane = match countdown {
            Some(countdown) => {
                parts.extend(state.map(str::to_owned));
                countdown
            }
            // The lane's short words for the wait ("Needs Maka Desktop").
            None if waiting => copy::LANE_NEEDS_DESKTOP.in_locale(locale).to_owned(),
            None => state.map(str::to_owned).unwrap_or_default(),
        };
        // A cron rule is machine text: its expression in compact mono,
        // after the word with no colon (review round 12).
        let mut mono = None;
        if let ScheduledTaskSchedule::Cron { expression, .. } = &task.schedule {
            let word = copy::RECURRENCE_CRON_WORD.in_locale(locale);
            let separator = shared::copy::conversation::FOOTER_SEPARATOR.en();
            let before: usize = parts.iter().map(|part| part.len() + separator.len()).sum();
            let start = before + word.len() + 1;
            mono = Some(start..start + expression.len());
            parts.push(format!("{word} {expression}"));
        } else {
            parts.push(recurrence_label(task, locale));
        }
        parts.push(match (task.next_fire_at, last) {
            (Some(at), _) => copy::next_run_at(locale, &task_time(at, &zone, locale)),
            (None, Some(run)) => copy::last_run_at(locale, &task_time(run.at, &zone, locale)),
            (None, None) => copy::UNSCHEDULED.in_locale(locale).to_owned(),
        });
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        RowParts { semantic, state, description: dotted(&parts), mono, lane: lane.into() }
    }

    /// Run history: every task's runs in the range and the fires waiting
    /// for Maka Desktop, newest first.
    fn render_runs(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let zone = self.now.timezone();
        let start = self.range.start(&self.now);
        let tasks: Vec<ScheduledTask> = self.catalog.read(cx).tasks().unwrap_or_default().to_vec();
        // Newest first, as Desktop's: the fires waiting for Maka Desktop at
        // their time among the runs.
        let mut entries: Vec<(u64, AnyElement)> = tasks
            .iter()
            .filter(|task| self.awaits_desktop(task, cx))
            .map(|task| {
                let at = task.next_fire_at.unwrap_or_default();
                let time = task.next_fire_at.map(|at| task_time(at, &zone, locale));
                let row = run_row(
                    domain_element_id("scheduled-task-waiting", &task.id),
                    Semantic::Attention,
                    &task.title,
                    // A run's state in words, as a run's message: no full
                    // stop, as the task rows' fragments.
                    copy::WAITING_FOR_DESKTOP.in_locale(locale),
                    &time.unwrap_or_default(),
                    cx,
                );
                (at, row)
            })
            .collect();
        entries.extend(
            tasks
                .iter()
                .flat_map(|task| task.runs.iter().map(move |run| (task, run)))
                .filter(|(_, run)| start.is_none_or(|start| run.at as i64 >= start))
                .map(|(task, run)| {
                    let row = run_row(
                        domain_element_id("scheduled-task-run", &format!("{}:{}", task.id, run.id)),
                        run_semantic(&run.outcome),
                        &task.title,
                        &run.message,
                        &task_time(run.at, &zone, locale),
                        cx,
                    );
                    (run.at, row)
                }),
        );
        entries.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
        let rows: Vec<AnyElement> = entries.into_iter().map(|(_, row)| row).collect();
        if rows.is_empty() {
            let widen = (self.range != RunRange::All).then(|| {
                quiet_button(Button::new("scheduled-task-runs-all"), cx)
                    .label(copy::SHOW_ALL_TIME.get(cx))
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.range = RunRange::All;
                        let range = this.range;
                        this.range_select
                            .update(cx, |select, cx| select.set_selected_value(&range, window, cx));
                        cx.notify();
                    }))
                    .into_any_element()
            });
            return empty_state(
                "scheduled-task-runs-empty",
                Icon::new(AssetIcon::Clock),
                copy::NO_RUNS_TITLE.get(cx),
                Some(copy::NO_RUNS_BODY.get(cx)),
                widen,
                cx,
            );
        }
        rows_with_rules("scheduled-task-runs", copy::RUNS_LIST.get(cx), rows, cx)
    }

    /// The detail dialog of the task `self.detail` names, built every time
    /// the dialog draws, so it follows the catalog.
    fn detail_dialog(
        &mut self,
        dialog: Dialog,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Dialog {
        let width = window.rem_size() * DETAIL_WIDTH_REMS;
        let view = cx.entity().downgrade();
        let dialog = floating_surface(dialog, cx).w(width).on_close(move |_, _, cx| {
            view.update(cx, |view, cx| view.detail_closed(cx)).ok();
        });
        let Some(task_id) = self.detail.clone() else {
            return dialog;
        };
        let Some(task) = self.catalog.read(cx).task(&task_id).cloned() else {
            // It left the catalog (another client deleted it).
            return dialog
                .with_header(
                    DialogHeader::new(copy::TAB_SCHEDULED_TASKS.get(cx))
                        .id("scheduled-task-detail-title"),
                )
                .child(notice("scheduled-task-gone", copy::TASK_GONE.get(cx), cx));
        };
        self.facts_dialog(dialog, &task, cx)
    }

    fn facts_dialog(&self, dialog: Dialog, task: &ScheduledTask, cx: &mut Context<Self>) -> Dialog {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let zone = self.now.timezone();
        let id: SharedString = task.id.clone().into();
        let agent = task.effect.is_agent();
        let terminal = is_terminal(task);
        let busy = self.busy();
        let waiting = self.awaits_desktop(task, cx);
        let held = self.catalog.read(cx).is_held(&task.id);
        let running =
            |change: &TaskChange| self.pending == Some(Pending::Change(id.clone(), change.clone()));
        // The row's state, so the two never disagree; the task's own state
        // where the row names none (scheduled).
        let state = self
            .row_parts(task, cx)
            .state
            .unwrap_or_else(|| status_label(&task.status).in_locale(locale));
        let subtitle = if agent {
            dotted(&[state, copy::AGENT_SOURCE.in_locale(locale)])
        } else {
            state.to_owned()
        };
        let mut content = v_flex().id("scheduled-task-detail").test_support().gap_4();
        if let Some(feedback) = &self.feedback {
            content = content.child(failure("scheduled-task-detail-feedback", feedback, cx));
        }
        if !task.intent.body.is_empty() || agent {
            content = content.child(
                v_flex()
                    .gap_1()
                    .when(!task.intent.body.is_empty(), |this| {
                        this.child(div().text_sm().child(task.intent.body.clone()))
                    })
                    .when(agent, |this| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(maka.ink_muted)
                                .child(copy::AGENT_SOURCE_HINT.get(cx)),
                        )
                    }),
            );
        }
        if waiting {
            // The subtitle says it waits; the notice says why, in the
            // window's one banner, as the disconnected one does: a phrase
            // as its title, the sentence under it (Desktop's Banner title
            // and description).
            let title = copy::WAITING_NOTICE_TITLE.get(cx);
            let body = copy::NEEDS_DESKTOP_FIRES.get(cx);
            content = content.child(
                banner(cx)
                    .id("scheduled-task-detail-waiting")
                    .test_support()
                    .aria_label(format!("{title}. {body}"))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                banner_title(title)
                                    .id("scheduled-task-detail-waiting-title")
                                    .test_support(),
                            )
                            .child(banner_description(body)),
                    ),
            );
        } else if delivered_by_desktop(task) && !terminal {
            content = content.child(
                div()
                    .id("scheduled-task-detail-desktop")
                    .test_support()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(copy::DESKTOP_DELIVERS.get(cx)),
            );
        }
        if !terminal {
            let active = task.status == ScheduledTaskStatus::Active;
            let toggled = id.clone();
            let snoozed = id.clone();
            let triggered = id.clone();
            let enabled = {
                let (checked, disabled) = (active, busy);
                FadedSwitch::new(
                    Switch::new("scheduled-task-enabled")
                        .checked(checked)
                        .disabled(disabled)
                        .accessibility_label(copy::DETAIL_ENABLED.get(cx))
                        .on_click(cx.listener(move |this, checked: &bool, window, cx| {
                            this.change(
                                toggled.clone(),
                                TaskChange::SetEnabled(*checked),
                                window,
                                cx,
                            );
                        })),
                    checked,
                    disabled,
                )
                .on(Surface::Overlay)
            };
            let snooze_label =
                if running(&TaskChange::Snooze) { copy::SNOOZING } else { copy::SNOOZE };
            let trigger_label =
                if running(&TaskChange::TriggerNow) { copy::TRIGGERING } else { copy::TRIGGER_NOW };
            content = content.child(
                h_flex()
                    .id("scheduled-task-controls")
                    .test_support()
                    .flex_wrap()
                    .gap_3()
                    .child(
                        h_flex()
                            .flex_1()
                            .gap_2()
                            .text_sm()
                            .child(enabled)
                            .child(copy::DETAIL_ENABLED.get(cx)),
                    )
                    // Desktop passes `size="sm"` to both: 28 tall.
                    .child(
                        quiet_button(Button::new("scheduled-task-snooze"), cx)
                            .h_7()
                            .label(snooze_label.get(cx))
                            .disabled(busy || !active || task.next_fire_at.is_none())
                            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                                this.change(snoozed.clone(), TaskChange::Snooze, window, cx)
                            })),
                    )
                    .child(
                        // Desktop's default secondary: the detail has no
                        // solid button.
                        quiet_button(Button::new("scheduled-task-trigger"), cx)
                            .h_7()
                            .label(trigger_label.get(cx))
                            .disabled(busy || !active || held)
                            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                                this.change(triggered.clone(), TaskChange::TriggerNow, window, cx)
                            })),
                    ),
            );
        }
        let last = task.runs.first();
        let mut facts = vec![
            fact(
                "scheduled-task-recurrence",
                copy::DETAIL_RECURRENCE.get(cx),
                recurrence_label(task, locale),
                cx,
            ),
            fact(
                "scheduled-task-next-run",
                copy::DETAIL_NEXT_RUN.get(cx),
                task.next_fire_at.map_or_else(
                    || copy::UNSCHEDULED.in_locale(locale).to_owned(),
                    |at| task_time(at, &zone, locale),
                ),
                cx,
            ),
        ];
        if let Some(run) = last {
            facts.push(fact(
                "scheduled-task-last-run",
                copy::DETAIL_LAST_RUN.get(cx),
                task_time(run.at, &zone, locale),
                cx,
            ));
        }
        facts.push(fact(
            "scheduled-task-delivery",
            copy::DETAIL_DELIVERY.get(cx),
            delivery_label(&task.effect, locale),
            cx,
        ));
        facts.push(fact(
            "scheduled-task-created",
            copy::DETAIL_CREATED.get(cx),
            task_time(task.created_at, &zone, locale),
            cx,
        ));
        content = content.child(divider(cx)).child(fact_list(facts)).child(divider(cx));
        let cleared = id.clone();
        let clear_label =
            if running(&TaskChange::ClearHistory) { copy::CLEARING } else { copy::CLEAR_RUNS };
        let runs_header = h_flex()
            .w_full()
            .gap_2()
            .child(dialog_label(copy::DETAIL_RUNS.get(cx), cx).flex_1())
            .when(!task.runs.is_empty() && !terminal, |this| {
                this.child(
                    quiet_button(Button::new("scheduled-task-clear-runs"), cx)
                        .label(clear_label.get(cx))
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.confirm_clear(cleared.clone(), window, cx)
                        })),
                )
            });
        // Only the Host's run records: a fire waiting for Maka Desktop is
        // the notice above, not a run.
        let mut runs: Vec<AnyElement> = Vec::new();
        let mut sorted: Vec<&ScheduledTaskRun> = task.runs.iter().collect();
        sorted.sort_by_key(|run| std::cmp::Reverse(run.at));
        runs.extend(sorted.into_iter().map(|run| {
            run_row(
                domain_element_id("scheduled-task-detail-run", &run.id),
                run_semantic(&run.outcome),
                &task_time(run.at, &zone, locale),
                &run.message,
                "",
                cx,
            )
        }));
        let runs = if runs.is_empty() {
            div()
                .id("scheduled-task-no-runs")
                .test_support()
                .text_xs()
                .text_color(maka.ink_muted)
                .child(copy::DETAIL_NO_RUNS.get(cx))
                .into_any_element()
        } else {
            rows_with_rules("scheduled-task-detail-runs", copy::DETAIL_RUNS.get(cx), runs, cx)
        };
        content = content.child(v_flex().gap_2().child(runs_header).child(runs));
        let deleted = id.clone();
        let deleting = running(&TaskChange::Delete);
        let edited = id.clone();
        let duplicated = id.clone();
        let footer = h_flex()
            .w_full()
            .gap_2()
            .child(
                destructive_button(Button::new("scheduled-task-delete"), cx)
                    .label(if deleting {
                        copy::DELETING.get(cx)
                    } else {
                        shell_copy::DELETE.get(cx)
                    })
                    .disabled(busy)
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.confirm_delete(deleted.clone(), window, cx)
                    })),
            )
            .child(div().flex_1())
            .when(!agent, |this| {
                this.child(
                    quiet_button(Button::new("scheduled-task-duplicate"), cx)
                        .label(copy::DUPLICATE.get(cx))
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_edit(duplicated.clone(), true, window, cx)
                        })),
                )
                .child(
                    quiet_button(Button::new("scheduled-task-edit"), cx)
                        .label(copy::EDIT.get(cx))
                        .disabled(busy || terminal)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_edit(edited.clone(), false, window, cx)
                        })),
                )
            });
        dialog
            .with_header(
                DialogHeader::new(task.title.clone())
                    .id("scheduled-task-detail-title")
                    .subtitle(subtitle),
            )
            .child(content)
            .with_footer(footer)
    }
}

/// A run: its dot, a label over the Host's message, and a time at the end.
fn run_row(
    id: gpui_kit::ElementId,
    semantic: Semantic,
    label: &str,
    message: &str,
    at: &str,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let parts: Vec<&str> =
        [label, message, at].into_iter().filter(|part| !part.is_empty()).collect();
    h_flex()
        .id(id)
        .test_support()
        .role(Role::ListItem)
        .aria_label(shell_copy::parts(locale, &parts))
        .w_full()
        // A task row's height (Desktop's list row, 56).
        .min_h(rems(3.5))
        .py_2()
        .gap_3()
        .child(status_dot(semantic, cx))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(div().truncate().text_sm().font_medium().child(label.to_owned()))
                .when(!message.is_empty(), |this| {
                    this.child(
                        div()
                            .text_xs()
                            .line_height(rems(1.25))
                            .text_color(maka.ink_muted)
                            .line_clamp(2)
                            .child(message.to_owned()),
                    )
                }),
        )
        .when(!at.is_empty(), |this| {
            this.child(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .font_features(tabular_nums())
                    .child(at.to_owned()),
            )
        })
        .into_any_element()
}

/// A toolbar select at its own width: `Select`'s root fills its parent, so
/// the width sits on a box that does not grow or shrink.
fn sized_select(select: impl IntoElement, width_rems: f32) -> AnyElement {
    div().flex_none().w(rems(width_rems)).child(select).into_any_element()
}

fn render_skeleton() -> AnyElement {
    v_flex()
        .id("scheduled-tasks-loading")
        .test_support()
        .py_2()
        .gap_4()
        .children([0.7, 0.5, 0.6].into_iter().enumerate().map(|(ix, width)| {
            div()
                .id(("scheduled-tasks-skeleton", ix))
                .child(Skeleton::new().h_3().w(relative(width)))
        }))
        .into_any_element()
}

fn sort_choices(locale: Locale) -> Vec<Choice<TaskSort>> {
    TaskSort::ALL
        .into_iter()
        .map(|sort| Choice::new(sort, sort.label().in_locale(locale)))
        .collect()
}

fn range_choices(locale: Locale) -> Vec<Choice<RunRange>> {
    RunRange::ALL
        .into_iter()
        .map(|range| Choice::new(range, range.label().in_locale(locale)))
        .collect()
}

/// `text`, with the bytes in `mono` in the theme's mono family; the
/// size, colour and truncation are the element's.
fn with_mono(text: String, mono: Option<std::ops::Range<usize>>, cx: &App) -> AnyElement {
    let Some(mono) = mono.filter(|range| range.end <= text.len()) else {
        return text.into_any_element();
    };
    let color = cx.maka().ink_muted;
    let (sans, code) = (cx.theme().font_family.clone(), cx.theme().mono_font_family.clone());
    let runs = [(mono.start, sans.clone()), (mono.len(), code), (text.len() - mono.end, sans)]
        .into_iter()
        .filter(|(len, _)| *len > 0)
        .map(|(len, family)| TextRun {
            len,
            font: gpui_kit::font(family),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        })
        .collect::<Vec<_>>();
    StyledText::new(text).with_runs(runs).into_any_element()
}

/// What a task row says: its dot, its second line, and its end lane.
struct RowParts {
    semantic: Semantic,
    /// The state's words, when it is not plainly scheduled.
    state: Option<&'static str>,
    description: String,
    /// Where machine text sits in `description` (a cron expression).
    mono: Option<std::ops::Range<usize>>,
    lane: SharedString,
}

#[derive(Debug, Clone, Copy)]
enum CursorStep {
    Previous,
    Next,
    First,
    Last,
}

impl Focusable for AutomationsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The page on its own, as previews and tests draw it; the shell puts it
/// on the plate under the window's chrome.
impl Render for AutomationsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = self.render_page(window, cx);
        v_flex().id("automations").test_support().size_full().child(page)
    }
}
