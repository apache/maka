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

//! The session sidebar: the app name, "New task", the entries of the
//! pages the plate can show, and the task list grouped by day (or by
//! project) with an Archived group at the end. A task's commands (rename, flag, archive, copy its ID, delete an
//! archived one) open from its context menu.

mod entries;
mod row_menu;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use chrono::Local;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _, StyledExt as _,
    ThemeStyled as _, VirtualListScrollHandle, h_flex, v_flex, v_virtual_list,
};
use gpui_kit::{
    Action as _, AnyElement, App, AppContext as _, ClickEvent, Context, DismissEvent, ElementId,
    Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyBinding,
    MouseButton, MouseDownEvent, ParentElement as _, Pixels, Point, Render, Role, ScrollStrategy,
    SharedString, Size, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    TestSupportExt as _, Window, canvas, div, fill, prelude::FluentBuilder as _, px, relative,
    rems, size, svg,
};
use shared::copy::{
    self, Locale, automations as scheduled_copy, commands as palette_words,
    extensions as pages_copy,
};
use shared::domain_element_id;
use shared::hop::Hops;
use shared::icons::{MAKA_WORDMARK, MakaIcon};
use shared::menu::{Menu, MenuPlacement, menu_layer, reopens_on};
use shared::rows::EmptyRow;
use shared::theme::{
    ActiveMakaPalette as _, group_label_size, row_icon_button, segment, segmented_track,
    shortcut_hint, tabular_nums,
};
use workspace::actions::{FocusComposer, NewSession, OpenCommandPalette};
use workspace::{ConnectionStatus, ProjectSelection};

use crate::SidebarPage;
use crate::catalog::{LoadState, SessionCatalog};
use entries::{Entry, Folding, TaskEntry, build_entries};
pub use entries::{GROUP_ROW_LIMIT, TaskGroup, TaskGrouping};

/// Key context of the session list. Arrow keys, Home, End, Enter, Space,
/// F2, and Shift-F10 work while the list has focus.
pub const SESSION_LIST_CONTEXT: &str = "SessionList";
/// Key context of the field that renames a task in place.
pub const SESSION_RENAME_CONTEXT: &str = "SessionRename";

/// Height of a task row, a primary row, and the brand row.
const ROW_HEIGHT_REMS: f32 = 2.;
/// Height of a group heading's label line (28px).
const GROUP_LABEL_HEIGHT_REMS: f32 = 1.75;
/// Height of a group heading: its label line plus the 16px gap that
/// separates the group from the one above.
const HEADER_HEIGHT_REMS: f32 = GROUP_LABEL_HEIGHT_REMS + 1.;
/// The Maka wordmark in the brand row: 18px tall, 69px wide (its 460x120
/// view box).
const WORDMARK_HEIGHT_REMS: f32 = 1.125;
const WORDMARK_WIDTH_REMS: f32 = WORDMARK_HEIGHT_REMS * 460. / 120.;
/// How far into its view box the wordmark's first glyph starts at that
/// size (about 27 of its 460 units): the brand row pulls the mark left by
/// this much so the glyph, not the box, sits on the 16px icon column.
const WORDMARK_BEARING_REMS: f32 = 0.25;
/// The sidebar rows' inset from the column's edge, and the icon column's
/// inset inside a row: 8px each, so icons start 16px from the edge.
const ROW_INSET_REMS: f32 = 0.5;
/// Space after the last entry, inside the scrolling list: one row plus the
/// 8 px rhythm, so the last task scrolls clear of the footer.
const LIST_END_PADDING_REMS: f32 = ROW_HEIGHT_REMS + 0.5;
/// Where a task title (and "Show more") starts inside its row: 32px, so
/// titles sit 40px from the sidebar edge on the nav rows' label column,
/// under their group header at 16px (review round 4; Maka Desktop's
/// sidebar indents them the same way).
const TITLE_INSET_REMS: f32 = 2.;
/// How often row ages and day groups are brought up to date.
const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

gpui_kit::actions!(
    session_list,
    [
        /// Move to the entry above: a task or a group heading.
        SelectPreviousSession,
        /// Move to the entry below: a task or a group heading.
        SelectNextSession,
        /// Select the first visible task.
        SelectFirstSession,
        /// Select the last visible task.
        SelectLastSession,
        /// On a heading, collapse its group; on a task, move to its heading.
        CollapseSessionGroup,
        /// On a collapsed heading, expand it; on an open one, move to its
        /// first task.
        ExpandSessionGroup,
        /// On a heading, collapse or expand it; on a task, go to the
        /// composer.
        ActivateSessionEntry,
        /// Open the context menu of the task under the keyboard cursor.
        OpenSessionMenu,
        /// Rename the task under the keyboard cursor, in place.
        RenameSession,
        /// Leave the rename field without changing the name.
        CancelRename,
    ]
);

/// Binds the session list keys (and the task menu's). Call once at startup,
/// before building menus.
pub fn init(cx: &mut App) {
    shared::menu::init(cx);
    let context = Some(SESSION_LIST_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("up", SelectPreviousSession, context),
        KeyBinding::new("down", SelectNextSession, context),
        KeyBinding::new("home", SelectFirstSession, context),
        KeyBinding::new("end", SelectLastSession, context),
        KeyBinding::new("left", CollapseSessionGroup, context),
        KeyBinding::new("right", ExpandSessionGroup, context),
        KeyBinding::new("enter", ActivateSessionEntry, context),
        KeyBinding::new("space", ActivateSessionEntry, context),
        // The platform conventions for a context menu from the keyboard
        // (Shift-F10 everywhere, the Menu key on Windows and Linux).
        KeyBinding::new("shift-f10", OpenSessionMenu, context),
        KeyBinding::new("menu", OpenSessionMenu, context),
        KeyBinding::new("f2", RenameSession, context),
        KeyBinding::new("escape", CancelRename, Some(SESSION_RENAME_CONTEXT)),
    ]);
}

/// A list line the keyboard cursor is on that is not a task (on a task the
/// cursor is the selection).
#[derive(Debug, Clone, PartialEq, Eq)]
enum ListCursor {
    Header(TaskGroup),
    ShowMore(TaskGroup),
}

/// A task's open context menu.
struct RowMenu {
    task: SharedString,
    /// Where the pointer opened it, in window coordinates; `None` when the
    /// keyboard or the "…" button did, and it hangs under the row's end.
    position: Option<Point<Pixels>>,
    menu: Entity<Menu>,
    _dismiss: Subscription,
}

/// What the sidebar tells the window it sits in.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SidebarEvent {
    /// The person chose this task in the list (a click, or the keyboard
    /// moving onto it), even the one already selected: the plate shows it,
    /// not a page.
    TaskChosen(SharedString),
}

/// A task being renamed in place.
struct Renaming {
    task: SharedString,
    /// The title the field started with; committing it unchanged sends
    /// nothing.
    original: SharedString,
    input: Entity<InputState>,
    _events: Subscription,
}

/// The sidebar view. It renders [`SessionCatalog`] and [`ProjectSelection`]
/// and forwards the user's choices to them; it owns no session data, only
/// how the list is shown: which groups are folded, where the keyboard
/// cursor is, which task's menu is open, and which task is being renamed.
///
/// The switch under the page entries groups the tasks that are not
/// archived by day or by project (one group per project, headed by its
/// name, every registered project listed, then the tasks in no project);
/// the choice lasts as long as the window. Where a new task goes is chosen
/// in the new task's draft (the composer's project picker).
///
/// Keyboard: "New task" and the two grouping choices are Tab stops, and
/// the task list is one more (its own focus handle, tracked on the element around the
/// virtualized list). In the list, Up and Down move through tasks and group
/// headings; landing on a task selects it. Left and Right collapse and expand
/// a group, Enter or Space toggles a heading, and Enter on a task moves to
/// the composer. Clicking a row or heading gives the same handle focus, so
/// the list never has two focus owners. Grouped by project, each project's
/// heading ends in a "+" that starts a task there; each is a Tab stop after
/// the list, where Enter and Space are its own. The cursor is the selected task, or
/// a heading or "Show more" row while `cursor` is set; with keyboard focus
/// it shows a focus ring.
///
/// A task's context menu opens on right-click, from the "…" button its row
/// shows on hover (and under the keyboard cursor), and with Shift-F10 or the
/// Menu key. F2 or the menu's Rename turns the title into a field: Enter
/// commits (`session.metadata.update`), Escape cancels, and leaving the
/// field commits. Archived tasks leave the day groups for the Archived group
/// at the end, folded at first.
///
/// A group lists its first [`GROUP_ROW_LIMIT`] tasks and a "Show more"
/// row; Enter, Space, Right, or a click shows the rest, for as long as the
/// sidebar lives (the window). A group whose hidden rows hold the selected
/// task shows them all, so the selection is always on screen.
pub struct SessionSidebar {
    catalog: Entity<SessionCatalog>,
    projects: Entity<ProjectSelection>,
    /// The page the plate shows, whose entry is selected.
    open_page: Option<SidebarPage>,
    /// How many scheduled tasks are active, which their entry says.
    active_scheduled: usize,
    list_focus: FocusHandle,
    scroll: VirtualListScrollHandle,
    entries: Vec<Entry>,
    grouping: TaskGrouping,
    /// The group of every listed task, folded or not.
    groups: HashMap<SharedString, TaskGroup>,
    collapsed: HashSet<TaskGroup>,
    /// Groups whose "Show more" was chosen: they list every task.
    expanded: HashSet<TaskGroup>,
    /// The heading or "Show more" row the keyboard cursor is on, instead of
    /// the selected task.
    cursor: Option<ListCursor>,
    /// Entry heights for the virtual list and the rem size they were
    /// computed at. Cleared whenever the entries change.
    sizes: Option<(Pixels, Rc<Vec<Size<Pixels>>>)>,
    /// The selection last scrolled into view.
    scrolled_to: Option<SharedString>,
    /// The task row under the pointer, which shows its "…" button.
    hovered: Option<SharedString>,
    /// The icons of New task, the pages, and search, which hop as the
    /// pointer enters them.
    hops: Hops,
    row_menu: Option<RowMenu>,
    /// The task whose menu a pointer press outside it last closed, and
    /// where: the click that press begins on the task's "…" button does not
    /// open the menu again.
    closed_menu: Option<(SharedString, Point<Pixels>)>,
    renaming: Option<Renaming>,
    _delete_prompt: Option<Task<()>>,
    _refresh: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SessionSidebar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionSidebar").finish_non_exhaustive()
    }
}

impl SessionSidebar {
    pub fn new(
        catalog: Entity<SessionCatalog>,
        projects: Entity<ProjectSelection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let list_focus = cx.focus_handle().tab_stop(true);
        let host = catalog.read(cx).host().clone();
        let subscriptions = vec![
            cx.observe(&catalog, |this, _, cx| this.sync_rows(cx)),
            cx.observe_in(&projects, window, |this, _, window, cx| this.sync_projects(window, cx)),
            cx.observe(&host, |_, _, cx| cx.notify()),
            // Group headings, "now", and "Untitled task" are words.
            cx.observe_global::<Locale>(|this, cx| this.rebuild_entries(cx)),
        ];
        // Ages and day groups move with the clock, not only with the catalog.
        let refresh = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(REFRESH_INTERVAL).await;
                if this.update(cx, |this, cx| this.rebuild_entries(cx)).is_err() {
                    break;
                }
            }
        });
        let mut this = Self {
            catalog,
            projects,
            open_page: None,
            active_scheduled: 0,
            list_focus,
            scroll: VirtualListScrollHandle::new(),
            entries: Vec::new(),
            grouping: TaskGrouping::ByTime,
            groups: HashMap::new(),
            // Archived tasks are out of the way until asked for.
            collapsed: HashSet::from([TaskGroup::Archived]),
            expanded: HashSet::new(),
            cursor: None,
            sizes: None,
            scrolled_to: None,
            hovered: None,
            hops: Hops::new(),
            row_menu: None,
            closed_menu: None,
            renaming: None,
            _delete_prompt: None,
            _refresh: refresh,
            _subscriptions: subscriptions,
        };
        this.sync_rows(cx);
        this.sync_projects(window, cx);
        this
    }

    pub fn catalog(&self) -> &Entity<SessionCatalog> {
        &self.catalog
    }

    /// The page the plate shows instead of a task, whose entry is selected.
    pub fn open_page(&self) -> Option<SidebarPage> {
        self.open_page
    }

    /// Marks `page` as the one the plate shows (`None`: a task).
    pub fn set_open_page(&mut self, page: Option<SidebarPage>, cx: &mut Context<Self>) {
        if self.open_page != page {
            self.open_page = page;
            cx.notify();
        }
    }

    /// How many scheduled tasks are active: their entry reads "Scheduled
    /// tasks, 3 active" while any are (Desktop's `pendingTasks`).
    pub fn set_active_scheduled_tasks(&mut self, count: usize, cx: &mut Context<Self>) {
        if self.active_scheduled != count {
            self.active_scheduled = count;
            cx.notify();
        }
    }

    /// Opens the new task's draft (the button, the menu item, and the key
    /// binding all end here). Nothing is asked of the Host, offline too:
    /// the draft's first message creates the task, in the project chosen
    /// then.
    pub fn new_session(&mut self, cx: &mut Context<Self>) {
        self.catalog.update(cx, |catalog, cx| catalog.open_draft(cx));
    }

    /// Whether the task list is taller than its viewport, as of the last
    /// layout. Only then does a hairline separate it from the footer.
    pub fn list_overflows(&self) -> bool {
        !self.entries.is_empty() && overflows(&self.scroll)
    }

    /// How the list groups the tasks that are not archived.
    pub fn grouping(&self) -> TaskGrouping {
        self.grouping
    }

    /// Groups the list by day or by project. Folded groups and "Show more"
    /// choices of either grouping are kept for when it comes back.
    pub fn set_grouping(&mut self, grouping: TaskGrouping, cx: &mut Context<Self>) {
        if self.grouping != grouping {
            self.grouping = grouping;
            self.cursor = None;
            self.rebuild_entries(cx);
            self.scroll_cursor_into_view(cx);
        }
    }

    /// Whether the group is folded to its heading.
    pub fn is_collapsed(&self, group: impl Into<TaskGroup>) -> bool {
        self.collapsed.contains(&group.into())
    }

    /// Folds a group to its heading, or unfolds it.
    pub fn toggle_group(&mut self, group: impl Into<TaskGroup>, cx: &mut Context<Self>) {
        let group = group.into();
        // A project with no task has nothing to fold.
        let empty = self.entries.iter().any(
            |entry| matches!(entry, Entry::Header { group: g, empty: true, .. } if *g == group),
        );
        if empty {
            return;
        }
        if !self.collapsed.remove(&group) {
            self.collapsed.insert(group);
        }
        self.rebuild_entries(cx);
    }

    /// Whether the icon named `key` (`new-task`, `search`, or a page's key)
    /// is hopping.
    pub fn icon_hopping(&self, key: &'static str, cx: &App) -> bool {
        self.hops.hopping(key, cx)
    }

    /// A hover listener that hops the icon named `key` when the pointer
    /// enters its row.
    fn hop_on_entry(
        &self,
        key: &'static str,
        cx: &mut Context<Self>,
    ) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
        cx.listener(move |this, entered: &bool, _, cx| {
            if *entered && this.hops.enter(key, cx) {
                cx.notify();
            }
        })
    }

    /// The task whose context menu is open.
    pub fn menu_task(&self) -> Option<&SharedString> {
        self.row_menu.as_ref().map(|menu| &menu.task)
    }

    /// The task being renamed in place.
    pub fn renaming_task(&self) -> Option<&SharedString> {
        self.renaming.as_ref().map(|renaming| &renaming.task)
    }

    /// Mirrors the catalog: the rows and the selection.
    fn sync_rows(&mut self, cx: &mut Context<Self>) {
        let catalog = self.catalog.read(cx);
        let selected_id = catalog.selected_id().cloned();
        let selection_changed = selected_id != self.scrolled_to;
        self.scrolled_to = selected_id;
        if selection_changed {
            self.cursor = None;
        }
        self.rebuild_entries(cx);
        if selection_changed {
            self.scroll_cursor_into_view(cx);
        }
    }

    /// Groups the catalog rows with their ages, as of now. Reads the clock,
    /// so it runs from events and the refresh timer, never `render`.
    fn rebuild_entries(&mut self, cx: &mut Context<Self>) {
        let (entries, groups) = {
            let catalog = self.catalog.read(cx);
            let projects = self.projects.read(cx);
            let folding = Folding {
                collapsed: &self.collapsed,
                expanded: &self.expanded,
                selected: catalog.selected_id(),
            };
            let locale = Locale::current(cx);
            build_entries(
                locale,
                catalog.rows(),
                self.grouping,
                projects.projects().unwrap_or_default(),
                folding,
                &Local::now(),
            )
        };
        self.groups = groups;
        if entries != self.entries {
            self.entries = entries;
            self.sizes = None;
        }
        if let Some(cursor) = self.cursor.clone()
            && self.cursor_entry_ix(&cursor).is_none()
        {
            self.cursor = None;
        }
        // A menu or a rename whose task left the catalog goes with it.
        let listed = |task: &SharedString| self.groups.contains_key(task);
        if self.row_menu.as_ref().is_some_and(|menu| !listed(&menu.task)) {
            self.row_menu = None;
        }
        if self.renaming.as_ref().is_some_and(|renaming| !listed(&renaming.task)) {
            self.renaming = None;
        }
        cx.notify();
    }

    /// Whether the group lists all its tasks rather than the first
    /// [`GROUP_ROW_LIMIT`].
    pub fn is_expanded(&self, group: impl Into<TaskGroup>) -> bool {
        self.expanded.contains(&group.into())
    }

    /// Shows all of the group's tasks ("Show more").
    pub fn show_more(&mut self, group: impl Into<TaskGroup>, cx: &mut Context<Self>) {
        if self.expanded.insert(group.into()) {
            self.rebuild_entries(cx);
        }
    }

    fn show_more_ix(&self, group: &TaskGroup) -> Option<usize> {
        self.entries
            .iter()
            .position(|entry| matches!(entry, Entry::ShowMore { group: g, .. } if g == group))
    }

    fn cursor_entry_ix(&self, cursor: &ListCursor) -> Option<usize> {
        match cursor {
            ListCursor::Header(group) => self.header_ix(group),
            ListCursor::ShowMore(group) => self.show_more_ix(group),
        }
    }

    /// "Show more" from the keyboard: the group lists everything and the
    /// first task it revealed is selected, as Down would.
    fn activate_show_more(&mut self, group: TaskGroup, cx: &mut Context<Self>) {
        let Some(ix) = self.show_more_ix(&group) else {
            return;
        };
        self.show_more(group, cx);
        self.move_cursor_to(ix, cx);
    }

    fn header_ix(&self, group: &TaskGroup) -> Option<usize> {
        self.entries
            .iter()
            .position(|entry| matches!(entry, Entry::Header { group: g, .. } if g == group))
    }

    /// Where the keyboard cursor is in the entries: the heading it is on,
    /// the selected task, or the heading of the folded group that holds the
    /// selected task.
    fn cursor_ix(&self, cx: &App) -> Option<usize> {
        if let Some(cursor) = &self.cursor {
            return self.cursor_entry_ix(cursor);
        }
        let selected = self.catalog.read(cx).selected_id()?;
        self.entries
            .iter()
            .position(|entry| matches!(entry, Entry::Session(task) if &task.id == selected))
            .or_else(|| self.header_ix(self.groups.get(selected)?))
    }

    /// The task under the keyboard cursor, if the cursor is on one.
    fn cursor_task(&self, cx: &App) -> Option<SharedString> {
        match self.entries.get(self.cursor_ix(cx)?)? {
            Entry::Session(task) => Some(task.id.clone()),
            _ => None,
        }
    }

    /// Moves the cursor to entry `ix`: a heading takes the cursor, a task is
    /// selected.
    fn move_cursor_to(&mut self, ix: usize, cx: &mut Context<Self>) {
        match self.entries.get(ix).cloned() {
            Some(Entry::Header { group, .. }) => {
                self.cursor = Some(ListCursor::Header(group));
                cx.notify();
            }
            Some(Entry::ShowMore { group, .. }) => {
                self.cursor = Some(ListCursor::ShowMore(group));
                cx.notify();
            }
            Some(Entry::Session(task)) => {
                self.cursor = None;
                cx.emit(SidebarEvent::TaskChosen(task.id.clone()));
                self.catalog.update(cx, |catalog, cx| catalog.select(Some(&task.id), cx));
                cx.notify();
            }
            None => return,
        }
        self.scroll.scroll_to_item(ix, ScrollStrategy::Top);
    }

    fn scroll_cursor_into_view(&mut self, cx: &mut Context<Self>) {
        if let Some(ix) = self.cursor_ix(cx) {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Top);
        }
    }

    fn step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(last) = self.entries.len().checked_sub(1) else {
            return;
        };
        let target = match (self.cursor_ix(cx), forward) {
            (Some(ix), true) => (ix + 1).min(last),
            (Some(ix), false) => ix.saturating_sub(1),
            (None, true) => 0,
            (None, false) => last,
        };
        self.move_cursor_to(target, cx);
    }

    fn select_previous(
        &mut self,
        _: &SelectPreviousSession,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.step(false, cx);
    }

    fn select_next(&mut self, _: &SelectNextSession, _: &mut Window, cx: &mut Context<Self>) {
        self.step(true, cx);
    }

    fn select_first(&mut self, _: &SelectFirstSession, _: &mut Window, cx: &mut Context<Self>) {
        let first = self.entries.iter().position(|entry| matches!(entry, Entry::Session(_)));
        if let Some(ix) = first {
            self.move_cursor_to(ix, cx);
        }
    }

    fn select_last(&mut self, _: &SelectLastSession, _: &mut Window, cx: &mut Context<Self>) {
        let last = self.entries.iter().rposition(|entry| matches!(entry, Entry::Session(_)));
        if let Some(ix) = last {
            self.move_cursor_to(ix, cx);
        }
    }

    fn collapse_group(&mut self, _: &CollapseSessionGroup, _: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = self.cursor_ix(cx).and_then(|ix| self.entries.get(ix)).cloned() else {
            return;
        };
        match entry {
            Entry::Header { group, collapsed: false, .. } => {
                self.cursor = Some(ListCursor::Header(group.clone()));
                self.toggle_group(group, cx);
            }
            Entry::Header { collapsed: true, .. } => {}
            Entry::Session(task) => {
                if let Some(group) = self.groups.get(&task.id).cloned() {
                    self.cursor = Some(ListCursor::Header(group));
                    self.scroll_cursor_into_view(cx);
                    cx.notify();
                }
            }
            Entry::ShowMore { group, .. } => {
                self.cursor = Some(ListCursor::Header(group));
                self.scroll_cursor_into_view(cx);
                cx.notify();
            }
        }
    }

    fn expand_group(&mut self, _: &ExpandSessionGroup, _: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.cursor_ix(cx) else {
            return;
        };
        match self.entries.get(ix).cloned() {
            Some(Entry::Header { group, collapsed: true, .. }) => {
                self.cursor = Some(ListCursor::Header(group.clone()));
                self.toggle_group(group, cx);
            }
            Some(Entry::Header { collapsed: false, .. }) => self.move_cursor_to(ix + 1, cx),
            Some(Entry::ShowMore { group, .. }) => self.activate_show_more(group, cx),
            Some(Entry::Session(_)) | None => {}
        }
    }

    fn activate_entry(
        &mut self,
        _: &ActivateSessionEntry,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A control in a row (a project heading's "+") has focus: Enter and
        // Space are its own.
        if !self.list_focus.is_focused(window) {
            cx.propagate();
            return;
        }
        match self.cursor_ix(cx).and_then(|ix| self.entries.get(ix)).cloned() {
            Some(Entry::Header { group, .. }) => {
                self.cursor = Some(ListCursor::Header(group.clone()));
                self.toggle_group(group, cx);
            }
            Some(Entry::ShowMore { group, .. }) => self.activate_show_more(group, cx),
            Some(Entry::Session(_)) => window.dispatch_action(FocusComposer.boxed_clone(), cx),
            None => {}
        }
    }

    fn open_menu_for_cursor(
        &mut self,
        _: &OpenSessionMenu,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(task) = self.cursor_task(cx) {
            self.open_row_menu(&task, None, window, cx);
        }
    }

    fn rename_cursor_task(
        &mut self,
        _: &RenameSession,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(task) = self.cursor_task(cx) {
            self.start_rename(&task, window, cx);
        }
    }

    fn cancel_rename(&mut self, _: &CancelRename, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_rename(false, true, window, cx);
    }

    /// Opens task `task`'s context menu, at `position` (a right-click) or
    /// under the row's end (the "…" button, Shift-F10). The menu takes
    /// focus; dismissed, it gives focus back to the list.
    pub fn open_row_menu(
        &mut self,
        task: &SharedString,
        position: Option<Point<Pixels>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let catalog = self.catalog.read(cx);
        let Some(row) = catalog.row(task) else {
            return;
        };
        let facts = row_menu::MenuTask {
            id: row.id.clone(),
            flagged: row.is_flagged,
            archived: row.is_archived,
            busy: catalog.pending_command(task).is_some(),
        };
        let entries = row_menu::entries(
            facts,
            cx.entity().downgrade(),
            self.catalog.clone(),
            Locale::current(cx),
        );
        let menu =
            Menu::new(entries, cx).restore_focus_to(self.list_focus.clone()).open(window, cx);
        let dismiss = cx.subscribe_in(&menu, window, |this, menu, _: &DismissEvent, _, cx| {
            if let Some(open) = this.row_menu.take_if(|open| &open.menu == menu) {
                this.closed_menu =
                    menu.read(cx).closed_by_press_at().map(|position| (open.task, position));
                cx.notify();
            }
        });
        self.closed_menu = None;
        self.row_menu = Some(RowMenu { task: task.clone(), position, menu, _dismiss: dismiss });
        cx.notify();
    }

    /// The "…" button of task `task`: opens its menu, or closes it when it
    /// is open (a press on the button that closed it counts as open).
    fn toggle_row_menu(
        &mut self,
        task: &SharedString,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(open) = self.row_menu.take_if(|open| &open.task == task) {
            open.menu.update(cx, |menu, cx| menu.close(window, cx));
            cx.notify();
            return;
        }
        let closed = self.closed_menu.take().filter(|(closed, _)| closed == task);
        if reopens_on(event, closed.map(|(_, position)| position)) {
            self.open_row_menu(task, None, window, cx);
        }
    }

    /// Turns task `task`'s title into a field holding it, focused with the
    /// text selected.
    pub fn start_rename(
        &mut self,
        task: &SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(renaming) = self.renaming.as_ref().filter(|renaming| &renaming.task == task) {
            renaming.input.update(cx, |input, cx| input.focus(window, cx));
            return;
        }
        let Some(row) = self.catalog.read(cx).row(task) else {
            return;
        };
        let original: SharedString =
            copy::task_title(Locale::current(cx), &row.name).to_owned().into();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(original.clone()));
        let events = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            match event {
                InputEvent::PressEnter { .. } => this.finish_rename(true, true, window, cx),
                // Leaving the field (a click elsewhere, Tab) keeps the edit.
                InputEvent::Blur => this.finish_rename(true, false, window, cx),
                _ => {}
            }
        });
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        self.renaming = Some(Renaming { task: task.clone(), original, input, _events: events });
        self.row_menu = None;
        self.scroll_cursor_into_view(cx);
        cx.notify();
    }

    /// Leaves the rename field, sending the new name when `commit` and it
    /// changed, and gives focus back to the list when `refocus`.
    fn finish_rename(
        &mut self,
        commit: bool,
        refocus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(renaming) = self.renaming.take() else {
            return;
        };
        let name = renaming.input.read(cx).value();
        if commit && name.trim() != renaming.original.as_ref() {
            self.catalog.update(cx, |catalog, cx| catalog.rename(&renaming.task, &name, cx));
        }
        if refocus {
            self.list_focus.focus(window, cx);
        }
        cx.notify();
    }

    /// Archives task `task` or makes it active again. Archiving the selected
    /// task selects its neighbour in the list, so the window moves on with
    /// the task that leaves.
    pub fn set_archived(&mut self, task: &SharedString, archived: bool, cx: &mut Context<Self>) {
        if archived && self.catalog.read(cx).selected_id() == Some(task) {
            let next = self.neighbour(task, cx);
            self.catalog.update(cx, |catalog, cx| catalog.select(next.as_deref(), cx));
        }
        self.catalog.update(cx, |catalog, cx| catalog.set_archived(task, archived, cx));
    }

    /// The task after `task` among those not archived, as listed, else the
    /// one before it, else the newest other one.
    fn neighbour(&self, task: &SharedString, cx: &App) -> Option<SharedString> {
        let listed: Vec<&TaskEntry> = self
            .entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Session(entry) if !entry.archived => Some(entry),
                _ => None,
            })
            .collect();
        let near = listed.iter().position(|entry| &entry.id == task).and_then(|ix| {
            listed.get(ix + 1).or_else(|| ix.checked_sub(1).and_then(|ix| listed.get(ix)))
        });
        match near {
            Some(entry) => Some(entry.id.clone()),
            None => self
                .catalog
                .read(cx)
                .rows()
                .iter()
                .find(|row| !row.is_archived && &row.id != task)
                .map(|row| row.id.clone()),
        }
    }

    /// Asks whether to delete task `task` (offered only once it is
    /// archived): the Host says first how many subtasks would move to the
    /// archive, then an alert dialog names the task.
    pub fn confirm_delete(
        &mut self,
        task: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let catalog = self.catalog.read(cx);
        let Some(row) = catalog.row(&task) else {
            return;
        };
        let title: SharedString =
            copy::task_title(Locale::current(cx), &row.name).to_owned().into();
        let preview = catalog.preview_remove(&task, cx);
        let catalog = self.catalog.clone();
        self._delete_prompt = Some(cx.spawn_in(window, async move |_, cx| {
            let subtasks = match preview.await {
                Ok(count) => Some(count),
                Err(error) => {
                    log::warn!("session.remove.preview failed: {error}");
                    None
                }
            };
            cx.update(|window, cx| {
                row_menu::open_delete_dialog(catalog, task, title, subtasks, window, cx)
            })
            .ok();
        }));
    }

    /// Follows the project catalog: project names head the groups when
    /// grouping by project.
    fn sync_projects(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.rebuild_entries(cx);
    }

    /// The app name, "New task", the page entries, and the grouping
    /// switch.
    fn render_header(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shortcut = Kbd::global_binding_for_action(&NewSession, window);
        let maka = cx.maka();
        let icon = Icon::new(MakaIcon::Compose).size_4().text_color(maka.ink_muted);
        let icon = self.hops.icon("new-task", icon, window, cx).into_any_element();
        let search = Icon::new(MakaIcon::Search).size_4().text_color(maka.ink_muted);
        let search = self.hops.icon("search", search, window, cx);
        v_flex()
            .flex_shrink_0()
            .px_2()
            .pt_2()
            .child(
                // The brand row: the wordmark in brand blue (named for
                // listeners by the app name), and search at the far edge.
                h_flex()
                    .id("app-name")
                    .test_support()
                    .aria_label(copy::APP_NAME.get(cx))
                    .h(rems(ROW_HEIGHT_REMS))
                    .mb_2()
                    .pl(rems(ROW_INSET_REMS - WORDMARK_BEARING_REMS))
                    .gap_2()
                    .child(
                        svg()
                            .path(MAKA_WORDMARK)
                            .flex_shrink_0()
                            .w(rems(WORDMARK_WIDTH_REMS))
                            .h(rems(WORDMARK_HEIGHT_REMS))
                            .text_color(maka.brand),
                    )
                    .child(div().flex_1())
                    // Search opens the command palette, which finds tasks too
                    // (AllSum's search icon beside the app name). Its tooltip
                    // takes the button's hover, so the icon's hop listens
                    // on a box around it.
                    .child(
                        div()
                            .id("search-hop")
                            .flex()
                            .flex_shrink_0()
                            .on_hover(self.hop_on_entry("search", cx))
                            .child(
                                Button::new("command-palette-button")
                                    .ghost()
                                    .small()
                                    .size_7()
                                    .icon(search)
                                    .accessibility_label(palette_words::SEARCH.get(cx))
                                    .tooltip_with_action(
                                        palette_words::SEARCH.get(cx),
                                        &OpenCommandPalette,
                                        None,
                                    )
                                    .on_click(|_, window, cx| {
                                        window.dispatch_action(OpenCommandPalette.boxed_clone(), cx)
                                    }),
                            ),
                    ),
            )
            // Enabled offline, as Desktop's and as Extensions and Scheduled
            // tasks beside it: the draft opens, and its composer says why
            // nothing can be sent yet (review round 13).
            .child(
                sidebar_row_button("new-session")
                    .child(row_icon(icon))
                    .child(div().flex_1().min_w_0().truncate().child(copy::NEW_TASK.get(cx)))
                    .when_some(shortcut, |this, shortcut| this.child(shortcut_hint(shortcut, cx)))
                    .on_hover(self.hop_on_entry("new-task", cx))
                    .on_click(cx.listener(|this, _, _, cx| this.new_session(cx))),
            )
            .child(self.render_pages(window, cx))
            .child(self.render_grouping(cx))
    }

    /// Desktop's entries under New task, in its order and row geometry:
    /// each opens its page on the plate, and the one the plate shows has
    /// the selected fill.
    fn render_pages(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        v_flex()
            .id("sidebar-pages")
            .test_support()
            .aria_label(pages_copy::MAIN_NAVIGATION.get(cx))
            .children(SidebarPage::ALL.map(|page| {
                let title: SharedString = page.title().get(cx).into();
                // The active scheduled tasks: a count at the row's end, and
                // the whole sentence for the accessible name.
                let active = (page == SidebarPage::ScheduledTasks && self.active_scheduled > 0)
                    .then_some(self.active_scheduled);
                let label: SharedString = match active {
                    Some(count) => {
                        scheduled_copy::sidebar_active(Locale::current(cx), count).into()
                    }
                    None => title.clone(),
                };
                let icon = page.icon().size_4().text_color(maka.ink_muted);
                sidebar_row_button(domain_element_id("sidebar-page", page.key()))
                    .accessibility_label(label)
                    .selected(self.open_page == Some(page))
                    .on_hover(self.hop_on_entry(page.key(), cx))
                    .child(row_icon(
                        self.hops.icon(page.key(), icon, window, cx).into_any_element(),
                    ))
                    .child(
                        div()
                            .id(domain_element_id("sidebar-page-title", page.key()))
                            .test_support()
                            .aria_label(title.clone())
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(title),
                    )
                    // A counter, one step under its label (DESIGN.md §9):
                    // 12/20 muted, tabular, at the end of the 40px lane the
                    // task rows keep their ages in.
                    .when_some(active, |this, count| {
                        this.child(
                            h_flex().min_w_10().flex_shrink_0().justify_end().child(
                                div()
                                    .id(domain_element_id("sidebar-page-count", page.key()))
                                    .test_support()
                                    .aria_label(count.to_string())
                                    .text_xs()
                                    .line_height(rems(1.25))
                                    .text_color(maka.ink_muted)
                                    .font_features(tabular_nums())
                                    .child(count.to_string()),
                            ),
                        )
                    })
                    .on_click(move |_, window, cx| window.dispatch_action(page.action(), cx))
            }))
    }

    /// The By time / By project switch: a 28px segmented row of two
    /// buttons on the sunken track, full width, each a Tab stop with Enter or
    /// Space. The current one sits on the plate with a soft ring and a 1px
    /// shadow; the other's label is muted. 8px below the page entries; the
    /// first group heading's own 16px gap follows it.
    fn render_grouping(&self, cx: &mut Context<Self>) -> impl IntoElement {
        segmented_track(cx)
            .id("task-grouping")
            .test_support()
            .aria_label(copy::GROUPING_LABEL.get(cx))
            .mt_2()
            .children(TaskGrouping::ALL.map(|grouping| {
                let button = Button::new(domain_element_id("task-grouping", grouping.key()));
                segment(button, grouping.label().get(cx), self.grouping == grouping, cx)
                    .on_click(cx.listener(move |this, _, _, cx| this.set_grouping(grouping, cx)))
            }))
    }

    fn render_list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let catalog = self.catalog.read(cx);
        let load_error = match catalog.load_state() {
            LoadState::Failed(message) => Some(message.clone()),
            _ => None,
        };
        let command_error = catalog.command_error().cloned();
        // Nothing loaded yet: placeholder rows while the first attempt (or
        // one the person asked for) runs, or the load once connected; after
        // a failed attempt, say the Host is not reached (review round 12).
        // A list loaded before keeps showing.
        let waiting = catalog.rows().is_empty()
            && matches!(catalog.load_state(), LoadState::Idle | LoadState::Loading);
        let attempting = matches!(
            catalog.host().read(cx).status(),
            ConnectionStatus::Connecting | ConnectionStatus::Starting | ConnectionStatus::Connected
        );
        let loading = waiting && attempting;
        let offline = waiting && !attempting;
        let empty = catalog.rows().is_empty() && !waiting && load_error.is_none();
        let rem = window.rem_size();
        let sizes = match &self.sizes {
            Some((at, sizes)) if *at == rem => sizes.clone(),
            _ => {
                let sizes = Rc::new(entry_sizes(&self.entries, rem));
                self.sizes = Some((rem, sizes.clone()));
                sizes
            }
        };
        v_flex()
            .flex_1()
            .min_h_0()
            .when_some(load_error, |this, message| {
                this.child(
                    v_flex()
                        .id("session-load-error")
                        .test_support()
                        .flex_shrink_0()
                        .gap_1()
                        .px_4()
                        .pt_4()
                        .text_xs()
                        .child(
                            div()
                                .text_color(cx.theme().danger)
                                .child(copy::TASKS_LOAD_FAILED.get(cx)),
                        )
                        .child(div().text_color(cx.theme().muted_foreground).child(message))
                        .child(
                            Button::new("reload-sessions")
                                .xsmall()
                                .ghost()
                                .label(copy::RETRY.get(cx))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.catalog.update(cx, |catalog, cx| catalog.reload(cx));
                                })),
                        ),
                )
            })
            .when_some(command_error, |this, message| {
                this.child(
                    div()
                        .id("session-command-error")
                        .test_support()
                        .aria_label(message.clone())
                        .flex_shrink_0()
                        .px_4()
                        .py_1()
                        .text_xs()
                        .text_color(cx.theme().danger)
                        .child(message),
                )
            })
            .child(
                div()
                    .id("session-list")
                    .test_support()
                    .role(Role::List)
                    .track_focus(&self.list_focus)
                    // While a title is a field, keys go to the field, not
                    // to list navigation (Space, arrows, Enter).
                    .when(self.renaming.is_none(), |this| this.key_context(SESSION_LIST_CONTEXT))
                    .on_action(cx.listener(Self::select_previous))
                    .on_action(cx.listener(Self::select_next))
                    .on_action(cx.listener(Self::select_first))
                    .on_action(cx.listener(Self::select_last))
                    .on_action(cx.listener(Self::collapse_group))
                    .on_action(cx.listener(Self::expand_group))
                    .on_action(cx.listener(Self::activate_entry))
                    .on_action(cx.listener(Self::open_menu_for_cursor))
                    .on_action(cx.listener(Self::rename_cursor_task))
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .when(loading, |this| this.child(render_skeleton()))
                    // An empty list and an offline one say so in the same
                    // line: the inline empty row (12/20 muted).
                    .when(offline, |this| {
                        this.child(
                            div().px_4().pt_2().child(EmptyRow::new(
                                "session-offline",
                                copy::TASKS_OFFLINE.get(cx),
                            )),
                        )
                    })
                    .when(empty, |this| {
                        this.child(
                            div()
                                .px_4()
                                .pt_2()
                                .child(EmptyRow::new("session-empty", copy::TASKS_EMPTY.get(cx))),
                        )
                    })
                    .when(!self.entries.is_empty(), |this| {
                        this.child(
                            v_virtual_list(
                                cx.entity(),
                                "session-entries",
                                sizes,
                                |this, range, window, cx| {
                                    // The keyboard cursor, drawn only with
                                    // keyboard focus.
                                    let cursor = (this.list_focus.is_focused(window)
                                        && window.last_input_was_keyboard())
                                    .then(|| this.cursor_ix(cx))
                                    .flatten();
                                    range
                                        .map(|ix| {
                                            this.render_entry(ix, cursor == Some(ix), window, cx)
                                        })
                                        .collect()
                                },
                            )
                            .track_scroll(&self.scroll)
                            .px_2()
                            .pb(rems(LIST_END_PADDING_REMS)),
                        )
                        .child(Scrollbar::vertical(&self.scroll))
                        .child(render_top_hairline(&self.scroll, cx))
                        .child(render_footer_hairline(&self.scroll, cx))
                    }),
            )
    }

    fn render_entry(
        &self,
        ix: usize,
        cursor: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(entry) = self.entries.get(ix) else {
            return div().into_any_element();
        };
        let radius = cx.theme().radius;
        let maka = cx.maka();
        match entry {
            Entry::Header { group, label, count, collapsed, empty } => {
                let toggled = group.clone();
                let chevron =
                    if *collapsed { MakaIcon::ChevronRight } else { MakaIcon::ChevronDown };
                // A project with no task is a heading alone: no chevron,
                // nothing to fold (Desktop's project row without a
                // disclosure).
                let empty = *empty;
                // A project's heading starts a task in it; the tasks in no
                // project have none.
                let new_task = match group {
                    TaskGroup::Project(project) => {
                        Some(self.render_new_task_in(project, label, cx))
                    }
                    _ => None,
                };
                // A project's heading, and the tasks in no project's, start
                // with an open folder in the icon column (Desktop's
                // `FolderOpen`), which puts the name on the task titles' edge.
                let folder =
                    matches!(group, TaskGroup::Project(_) | TaskGroup::NoProject).then(|| {
                        div()
                            .id(domain_element_id("session-group-folder", &group.key()))
                            .test_support()
                            .flex_shrink_0()
                            .child(row_icon(
                                Icon::new(MakaIcon::FolderOpen).size_4().into_any_element(),
                            ))
                    });
                v_flex()
                    .w_full()
                    .h(rems(HEADER_HEIGHT_REMS))
                    .justify_end()
                    .child(
                        h_flex()
                            .id(domain_element_id("session-group", &group.key()))
                            .test_support()
                            .aria_label(match count {
                                Some(count) => {
                                    copy::parts(Locale::current(cx), &[label, &count.to_string()])
                                        .into()
                                }
                                None => label.clone(),
                            })
                            .when(!empty, |this| this.aria_expanded(!collapsed))
                            .h(rems(GROUP_LABEL_HEIGHT_REMS))
                            .px_2()
                            .gap_1()
                            .rounded(radius)
                            .text_size(group_label_size(Locale::current(cx)))
                            .font_medium()
                            .text_color(maka.ink_muted)
                            .when(!empty, |this| this.hover(|this| this.text_color(maka.ink)))
                            .when(cursor, |this| this.focus_ring_style(window, cx))
                            .on_mouse_down(MouseButton::Left, self.keep_list_focus())
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                this.cursor = Some(ListCursor::Header(toggled.clone()));
                                this.toggle_group(toggled.clone(), cx);
                                cx.notify();
                            }))
                            .children(folder)
                            .child(div().min_w_0().truncate().child(label.clone()))
                            .when_some(*count, |this, count| {
                                this.child(
                                    div().font_features(tabular_nums()).child(count.to_string()),
                                )
                            })
                            .when(!empty, |this| this.child(Icon::new(chevron).size_3()))
                            .when_some(new_task, |this, new_task| {
                                this.child(div().flex_1()).child(new_task)
                            }),
                    )
                    .into_any_element()
            }
            Entry::ShowMore { group, hidden } => {
                let shown = group.clone();
                h_flex()
                    .id(domain_element_id("session-show-more", &group.key()))
                    .test_support()
                    .role(Role::Button)
                    .aria_label(copy::show_more_label(
                        Locale::current(cx),
                        *hidden,
                        &header_label(&self.entries, group),
                    ))
                    .w_full()
                    .h(rems(ROW_HEIGHT_REMS))
                    .pl(rems(TITLE_INSET_REMS))
                    .pr_2()
                    .rounded(radius)
                    .text_sm()
                    .text_color(maka.ink_muted)
                    .hover(|this| this.bg(maka.hover).text_color(maka.ink))
                    .when(cursor, |this| this.focus_ring_style(window, cx))
                    .on_mouse_down(MouseButton::Left, self.keep_list_focus())
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.cursor = None;
                        this.show_more(shown.clone(), cx);
                    }))
                    .child(copy::SHOW_MORE.get(cx))
                    .into_any_element()
            }
            Entry::Session(task) => self.render_task(task, cursor, window, cx),
        }
    }

    /// The "+" at the end of a project's heading (the person's reference;
    /// Desktop's heading menu has New task): a small ghost icon button in
    /// muted ink, named and tipped "New task in <project>", a Tab stop. It
    /// chooses the project and opens the new task's draft, without folding
    /// the group. Disabled for a project that cannot take a task (its
    /// folder is gone, or the catalog does not list it).
    fn render_new_task_in(
        &self,
        project: &SharedString,
        name: &SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let usable = self.projects.read(cx).project(project).is_some_and(|p| p.is_usable());
        let label: SharedString = copy::new_task_in(Locale::current(cx), name).into();
        let maka = cx.maka();
        let ink = if usable { maka.ink_muted } else { maka.ink_disabled };
        let chosen = project.clone();
        row_icon_button(Button::new(domain_element_id("session-group-new-task", project)), cx)
            .xsmall()
            .flex_shrink_0()
            .icon(Icon::new(MakaIcon::Plus).size_3p5().text_color(ink))
            .accessibility_label(label.clone())
            .tooltip(label)
            .disabled(!usable)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                cx.stop_propagation();
                this.new_task_in(&chosen, cx);
            }))
            .into_any_element()
    }

    /// Chooses project `project` and opens the new task's draft in it (a
    /// project heading's "+").
    pub fn new_task_in(&mut self, project: &str, cx: &mut Context<Self>) {
        self.projects.update(cx, |projects, cx| projects.select_project(project, cx));
        self.new_session(cx);
    }

    /// A mouse-down handler that keeps focus on the list's Tab stop, not on
    /// the row.
    fn keep_list_focus(&self) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static {
        let list_focus = self.list_focus.clone();
        move |_, window, cx| {
            window.prevent_default();
            list_focus.focus(window, cx);
        }
    }

    /// One task: its title (or the field renaming it), then a fixed 40px
    /// lane at the end: the flag when it is flagged, then its age, or the
    /// waiting or running mark in its place. While the pointer is on the
    /// row, its menu is open, or the keyboard cursor is on it, the "…"
    /// button takes the age's place, and a waiting or running mark stays
    /// beside it. The lane keeps every title's end on one edge.
    fn render_task(
        &self,
        task: &TaskEntry,
        cursor: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let maka = cx.maka();
        let id = &task.id;
        // One selected row per sidebar: while a page shows, its entry is
        // the selected one and the task row rests until the task shows again.
        let selected = self.open_page.is_none() && self.catalog.read(cx).selected_id() == Some(id);
        let renaming = self.renaming.as_ref().filter(|renaming| &renaming.task == id);
        let menu = self.row_menu.as_ref().filter(|menu| &menu.task == id);
        let show_actions =
            renaming.is_none() && (menu.is_some() || self.hovered.as_ref() == Some(id) || cursor);
        let mut spoken = vec![task.title.to_string()];
        if task.running {
            spoken.push(copy::TASK_RUNNING.get(cx).to_owned());
        }
        if task.flagged {
            spoken.push(copy::TASK_FLAGGED.get(cx).to_owned());
        }
        let label = (spoken.len() > 1).then(|| spoken.join(", "));
        // A state the task is in (waiting on the user, running) stays in the
        // lane while the pointer is on the row; the "…" button takes only
        // the age's place, before it (review round 7).
        let state_glyph = if task.waiting {
            // Waiting on the user is `attention`, not `active`: the waiting
            // glyph in the warning ink, still, where the age would be.
            Some(
                div()
                    .id(domain_element_id("session-waiting", id))
                    .test_support()
                    .child(Icon::new(MakaIcon::StatusWaiting).size_3p5().text_color(maka.warning))
                    .into_any_element(),
            )
        } else if task.running {
            // A running task's age is "now"; the running mark takes
            // its place in the lane, turning unless motion is reduced.
            Some(
                div()
                    .id(domain_element_id("session-running", id))
                    .test_support()
                    .child(Spinner::new().icon(MakaIcon::StatusRunning).small().color(maka.primary))
                    .into_any_element(),
            )
        } else {
            None
        };
        let actions = show_actions.then(|| {
            let opened = id.clone();
            row_icon_button(Button::new(domain_element_id("session-actions", id)), cx)
                .xsmall()
                .icon(Icon::new(MakaIcon::More).size_3p5().text_color(maka.ink_muted))
                .tab_stop(false)
                .selected(menu.is_some())
                .accessibility_label(copy::task_actions_label(Locale::current(cx), &task.title))
                .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                    cx.stop_propagation();
                    this.toggle_row_menu(&opened, event, window, cx);
                }))
                .into_any_element()
        });
        let age = (actions.is_none() && state_glyph.is_none()).then(|| {
            div()
                .text_xs()
                .text_color(maka.ink_muted)
                .font_features(tabular_nums())
                .child(task.age.clone())
                .into_any_element()
        });
        // The flag sits 6px before the age, inside the lane, so it reads
        // with it rather than floating between title and age.
        let trailing = h_flex()
            .id(domain_element_id("session-lane", id))
            .test_support()
            // 40px holds every compact age ("now", "11m", "2w", "Sep 30");
            // anything wider widens the lane rather than run into the title.
            .min_w_10()
            .flex_shrink_0()
            .justify_end()
            .gap(px(6.))
            .when(task.flagged, |this| {
                this.child(
                    div()
                        .id(domain_element_id("session-flag", id))
                        .test_support()
                        .child(Icon::new(MakaIcon::Flag).size_3().text_color(maka.ink_muted)),
                )
            })
            .children(actions)
            .children(state_glyph)
            .children(age);
        let title = match renaming {
            Some(renaming) => div()
                .id(domain_element_id("session-rename", id))
                .test_support()
                .flex_1()
                .min_w_0()
                .key_context(SESSION_RENAME_CONTEXT)
                .on_action(cx.listener(Self::cancel_rename))
                .child(
                    Input::new(&renaming.input).small().aria_label(copy::TASK_NAME_FIELD.get(cx)),
                )
                .into_any_element(),
            None => {
                div().flex_1().min_w_0().truncate().child(task.title.clone()).into_any_element()
            }
        };
        let hovered = id.clone();
        let selected_id = id.clone();
        let menu_id = id.clone();
        h_flex()
            .id(domain_element_id("session-row", id))
            .test_support()
            .role(Role::ListItem)
            .aria_selected(selected)
            .when_some(label, |this, label| this.aria_label(label))
            .relative()
            .w_full()
            .h(rems(ROW_HEIGHT_REMS))
            .pl(rems(TITLE_INSET_REMS))
            .pr_2()
            .gap_2()
            .rounded(theme.radius)
            .text_sm()
            .text_color(maka.ink)
            .map(|this| {
                if selected {
                    this.bg(maka.selected)
                } else {
                    this.hover(|this| this.bg(maka.hover))
                }
            })
            .when(cursor, |this| this.focus_ring_style(window, cx))
            .on_hover(cx.listener(move |this, hovering: &bool, _, cx| {
                let was = this.hovered.clone();
                if *hovering {
                    this.hovered = Some(hovered.clone());
                } else if this.hovered.as_ref() == Some(&hovered) {
                    this.hovered = None;
                }
                if was != this.hovered {
                    cx.notify();
                }
            }))
            // The field being edited keeps its own pointer handling.
            .when(renaming.is_none(), |this| {
                this.on_mouse_down(MouseButton::Left, self.keep_list_focus())
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            this.open_row_menu(&menu_id, Some(event.position), window, cx);
                        }),
                    )
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.cursor = None;
                        cx.emit(SidebarEvent::TaskChosen(selected_id.clone()));
                        this.catalog
                            .update(cx, |catalog, cx| catalog.select(Some(&selected_id), cx));
                    }))
            })
            .child(title)
            .child(trailing)
            .when_some(menu, |this, menu| this.child(render_row_menu(menu)))
            .into_any_element()
    }
}

/// The open menu, drawn above everything: at the pointer for a right-click,
/// else hanging 8px under the row's end, and kept inside the window.
fn render_row_menu(menu: &RowMenu) -> AnyElement {
    let placement = match menu.position {
        Some(position) => MenuPlacement::At(position),
        None => MenuPlacement::BelowEnd,
    };
    menu_layer(&menu.menu, placement)
}

/// The label of `group`'s heading in `entries`.
fn header_label(entries: &[Entry], group: &TaskGroup) -> SharedString {
    entries
        .iter()
        .find_map(|entry| match entry {
            Entry::Header { group: g, label, .. } if g == group => Some(label.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// A full-width quiet row with the sidebar's row geometry. It is a ghost
/// Button, so it keeps the focus ring, keyboard activation, and disabled
/// state.
fn sidebar_row_button(id: impl Into<ElementId>) -> Button {
    Button::new(id).ghost().small().w_full().h(rems(ROW_HEIGHT_REMS)).px_2().justify_start()
}

/// The fixed icon slot at the start of a sidebar row, followed by the label:
/// labels share one leading edge whatever the icon.
fn row_icon(icon: AnyElement) -> impl IntoElement {
    h_flex().size_4().mr_1().flex_shrink_0().justify_center().child(icon)
}

/// The virtual list's entry heights at `rem`: the same measures the entries
/// render with.
fn entry_sizes(entries: &[Entry], rem: Pixels) -> Vec<Size<Pixels>> {
    entries
        .iter()
        .map(|entry| {
            let height = match entry {
                Entry::Header { .. } => HEADER_HEIGHT_REMS,
                Entry::Session(_) | Entry::ShowMore { .. } => ROW_HEIGHT_REMS,
            };
            size(px(0.), rems(height).to_pixels(rem))
        })
        .collect()
}

/// Whether the list can scroll: its entries and end padding are taller than
/// its viewport.
fn overflows(scroll: &VirtualListScrollHandle) -> bool {
    scroll.max_offset().y > px(0.)
}

/// A hairline along the list's bottom edge, over the footer, while the list
/// overflows, so the rows cut off there read as scrolled away. It is drawn at
/// paint time, after the list has laid out in the same frame, so it follows a
/// change in the entries or the window without waiting for another render.
fn render_footer_hairline(scroll: &VirtualListScrollHandle, cx: &App) -> impl IntoElement {
    let scroll = scroll.clone();
    let color = cx.theme().sidebar_border;
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            if overflows(&scroll) {
                window.paint_quad(fill(bounds, color));
            }
        },
    )
    .absolute()
    .left_0()
    .bottom_0()
    .w_full()
    .h(px(1.))
}

/// A hairline along the list's top edge, under the fixed rows, once the
/// list has scrolled under them, so the cut-off row reads as scrolled away.
/// Painted over the list rather than laid out as a border, so it takes no
/// room from the 16px between the grouping switch and the first heading.
fn render_top_hairline(scroll: &VirtualListScrollHandle, cx: &App) -> impl IntoElement {
    let scroll = scroll.clone();
    let color = cx.theme().sidebar_border;
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            if scroll.offset().y < px(0.) {
                window.paint_quad(fill(bounds, color));
            }
        },
    )
    .absolute()
    .left_0()
    .top_0()
    .w_full()
    .h(px(1.))
}

/// Placeholder rows while the first catalog load runs.
fn render_skeleton() -> impl IntoElement {
    v_flex().px_4().pt_4().gap_3().children([0.8, 0.6, 0.7].into_iter().enumerate().map(
        |(ix, width)| {
            div()
                .id(("session-skeleton", ix))
                .test_support()
                .child(Skeleton::new().h_3().w(relative(width)))
        },
    ))
}

impl EventEmitter<SidebarEvent> for SessionSidebar {}

/// Focusing the sidebar focuses its session list.
impl Focusable for SessionSidebar {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.list_focus.clone()
    }
}

impl Render for SessionSidebar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        v_flex()
            .id("session-sidebar")
            .size_full()
            .min_h_0()
            .bg(maka.canvas)
            .text_color(maka.ink)
            .child(self.render_header(window, cx))
            .child(self.render_list(window, cx))
    }
}
