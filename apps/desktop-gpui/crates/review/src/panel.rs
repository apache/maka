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

//! The changes panel: Maka Desktop's Workbar `review` tool for the selected
//! task's workspace, laid out as Claude Code's changes panel. A bar on top:
//! the file tree's toggle, the base branch (a picker) → the current branch
//! (a turn's prompt while a turn shows), a "⋯" menu, maximize and close.
//! Below it the changed files as a tree, the scopes, the task's turns that
//! edited files and the branch's commits under it, beside every file of
//! the chosen scope in one continuous diff; above it where the panel is
//! narrow.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::diff::{
    Diff, DiffAnnotation, DiffEvent, DiffFile, DiffHunkSeparator, DiffInlineUnit, DiffLinePosition,
    DiffMode, DiffSide, DiffState,
};
use gpui_kit::component::resizable::{h_resizable, resizable_panel};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState};
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, IconName, Selectable as _, Sizable as _,
    StyledExt as _, ThemeStyled as _, VirtualListScrollHandle, h_flex, v_flex, v_virtual_list,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Entity, EventEmitter,
    FocusHandle, Focusable as _, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Render, Role, ScrollStrategy, SharedString, Size,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _,
    UniformListScrollHandle, WeakEntity, Window, canvas, div, prelude::FluentBuilder as _, px,
    relative, rems, size, uniform_list,
};
use shared::copy::review as copy;
use shared::copy::{Locale, Text};
use shared::diff::DiffSide as UnifiedSide;
use shared::domain_element_id;
use shared::icons::{MakaIcon, ink};
use shared::layout::{ICON_BUTTON_REMS, ICON_GLYPH_REMS, PLATE_LINE_REMS, ink_padding};
use shared::menu::{MenuEntry, MenuItem, MenuPlacement, MenuSlot};
use shared::rows::StatusLine;
use shared::theme::{ActiveMakaPalette as _, RADIUS_MODAL, RADIUS_SURFACE, selectable_row};

use crate::git::{
    BaseBranch, BranchContext, FailureReason, FilePatch, FileStatus, GitError, GitRunner, Origin,
    PatchBatch, ReviewFailure, ReviewFile, ReviewRead, ReviewScope, ReviewSnapshot, read_patches,
    read_review, read_whole_file,
};
use crate::refit::DiffRefit;
use crate::shown::{DiffInput, DiffSource, ShownFile, prepare};
use crate::summary::ChangeTotals;
use crate::sync::{HeaderMarks, InView, StickyHeader, header_probe};
use crate::tree::{
    FileTree, ROW_REMS, RowContext, TreeFile, TreeKey, TreeNode, counts_label, file_counts,
    status_word,
};
use crate::turns::{ChangeKind, FileView, TurnChange, TurnChanges};

mod scopes;
use crate::{
    FILES_CONTEXT, FirstRow, FocusDiff, FoldFolder, LastRow, NextChange, NextFile, NextRow,
    NextScope, OpenRow, PANEL_CONTEXT, PreviousChange, PreviousFile, PreviousRow, PreviousScope,
    RestoreSplit, SCOPES_CONTEXT, UnfoldFolder,
};

/// The most lines of one file's diff shown before its "Show all"
/// (Desktop's `REVIEW_DIFF_LINE_CAP` is 500).
pub const DIFF_LINE_CAP: usize = 3000;
/// The panel's width from which the tree goes beside the diff rather than
/// above it: 720 px at the default rem.
pub const WIDE_LAYOUT_REMS: f32 = 45.;
/// The diff column's width from which a diff opens split rather than
/// unified, until the person picks one: 900 px at the default rem.
pub const SPLIT_DIFF_REMS: f32 = 56.25;
/// The tree's column beside the diff: 260 px at first, 192 to 480 as
/// dragged.
const FILE_LIST_REMS: f32 = 16.25;
const FILE_LIST_MIN_REMS: f32 = 12.;
const FILE_LIST_MAX_REMS: f32 = 30.;
/// The least the diff column keeps beside the tree.
const DIFF_MIN_REMS: f32 = 20.;
/// The tree and the commits above the diff take at most this share of
/// the panel's height.
const STACKED_LIST_SHARE: f32 = 0.4;
/// The commits take at most this share of the tree's column.
const SCOPES_SHARE: f32 = 0.45;
/// A commit's row: its subject over its hash, author and time.
const COMMIT_ROW_REMS: f32 = 2.75;
/// The commits section's heading.
const SCOPES_HEADING_REMS: f32 = 2.;
/// Frames a file chosen in the tree stays chosen while its header is not
/// in view and another file is at the top: the frames the diff takes to
/// settle on it.
const PIN_FRAMES: u8 = 3;
/// The "⋯" menu's least width.
const MENU_WIDTH_REMS: f32 = 13.;

/// Whose changes the panel shows: a task and its folder on this machine,
/// or a task on a Host elsewhere, whose folder this machine cannot read
/// (Desktop answers `workspace_unavailable` for a Host workspace).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewTarget {
    session_id: SharedString,
    workspace: Option<PathBuf>,
    /// The task's folder, on whichever machine its Host is: what the
    /// paths of its turns' edits are shown relative to.
    folder: Option<PathBuf>,
}

impl ReviewTarget {
    /// Task `session_id`, running in `workspace` on this machine.
    pub fn local(session_id: impl Into<SharedString>, workspace: impl Into<PathBuf>) -> Self {
        let workspace = workspace.into();
        Self {
            session_id: session_id.into(),
            folder: Some(workspace.clone()),
            workspace: Some(workspace),
        }
    }

    /// Task `session_id`, on a Host that is not this machine.
    pub fn remote(session_id: impl Into<SharedString>) -> Self {
        Self { session_id: session_id.into(), workspace: None, folder: None }
    }

    /// The task's folder on its Host, for a task on a Host elsewhere: its
    /// turns' edits show paths relative to it.
    pub fn with_task_folder(mut self, folder: impl Into<PathBuf>) -> Self {
        self.folder = Some(folder.into());
        self
    }

    pub fn session_id(&self) -> &SharedString {
        &self.session_id
    }

    /// The task's folder on this machine; none on a Host elsewhere.
    pub fn workspace(&self) -> Option<&Path> {
        self.workspace.as_deref()
    }

    /// The task's folder on its Host, wherever that is.
    pub fn folder(&self) -> Option<&Path> {
        self.folder.as_deref()
    }
}

/// What the panel asks its owner to do, or tells it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReviewPanelEvent {
    /// Remember `base_branch` (a fully qualified ref) as the branch task
    /// `session_id` compares against, or forget it (`None`, when the branch
    /// it named is gone).
    BaseBranchChanged { session_id: SharedString, base_branch: Option<String> },
    /// Give the conversation its place back (`false`): Esc while the
    /// panel is maximized. Maximizing, restoring and closing are the
    /// owner's (the workbar's strip, ⇧Esc as [`ToggleMaximized`]).
    MaximizeRequested(bool),
    /// A read of task `session_id`'s All changes landed, saying this of
    /// them: what the context strip shows, without a read of its own.
    ChangesRead { session_id: SharedString, totals: Option<ChangeTotals> },
}

/// A base branch as the picker lists it.
#[derive(Debug, Clone, PartialEq)]
struct BranchChoice(BaseBranch);

impl SelectItem for BranchChoice {
    type Value = String;

    fn title(&self) -> SharedString {
        self.0.label.clone().into()
    }

    fn value(&self) -> &String {
        &self.0.value
    }
}

type BranchPicker = SelectState<SearchableVec<BranchChoice>>;

/// Reading the listed files' patches: how many files of how many are
/// read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Reading {
    done: usize,
    total: usize,
}

/// What the Diff's files were read for. Files listed for another
/// repository, scope or base branch empty the Diff as they land, rather
/// than leave the files before beside the tree of the files after while
/// their patches are read; so does another turn.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DiffKey {
    Git { root: PathBuf, scope: ReviewScope, base_branch: Option<String> },
    Turn(SharedString),
}

impl DiffKey {
    fn of(snapshot: &ReviewSnapshot) -> Self {
        Self::Git {
            root: snapshot.repository_root.clone(),
            scope: snapshot.scope.clone(),
            base_branch: snapshot.base_branch.clone(),
        }
    }
}

/// Where the tree's files and their diffs come from: a Git scope's listing,
/// or a turn's changes.
#[derive(Clone, Copy)]
enum Source<'a> {
    Git(&'a ReviewSnapshot),
    Turn(&'a TurnChange),
}

/// What a file's header in the Diff says beyond the tree's row: which of
/// the turn's edits of the file it is, when they show one after another.
#[derive(Debug, Clone)]
struct Header {
    file: TreeFile,
    step: Option<(usize, usize)>,
}

/// What the last frame measured of the panel, for the layout that depends
/// on its width; the probes that measure it notify the panel when that
/// layout should change.
#[derive(Debug, Default)]
struct Measured {
    /// The panel is wide enough for the tree beside the diff.
    wide: Cell<bool>,
    /// The diff column is wide enough to open split.
    split: Cell<Option<bool>>,
}

/// A file chosen in the tree or with the keys, which the diff was scrolled
/// to: the tree keeps it while its header is in view, though another file
/// may fill the top (the last files, which the diff cannot scroll to its
/// top).
#[derive(Debug, Clone)]
struct Pin {
    path: SharedString,
    frames: u8,
}

/// A file's diff read again with its whole text ("Show more lines"), kept
/// while the patch it was read for stays the same.
#[derive(Debug, Clone)]
struct WholeText {
    read_for: Arc<str>,
    text: Arc<str>,
}

/// The selected task's Git changes (Desktop's `SessionReviewPanel`, laid
/// out as Claude Code's changes panel): every changed file of the chosen
/// [`ReviewScope`], however many, in a tree, the scopes and every commit of
/// the branch under it, and every file's diff in one continuous kit Diff,
/// each under its header. The tree sits beside the diff where the panel is
/// at least [`WIDE_LAYOUT_REMS`] wide, above it otherwise; a diff opens
/// split where its column is at least [`SPLIT_DIFF_REMS`] wide, unified
/// otherwise, until the person picks one.
///
/// Behavior owner for the read: [`Self::refresh`] lists the scope's files
/// on the background executor through the [`GitRunner`], and the tree and
/// the totals show them at once; then it reads their patches batch by
/// batch, the panel saying how many it has read, parses them off the main
/// thread and gives the Diff the whole scope at once. A generation drops
/// any read the panel has moved past, and the last result stays on screen
/// while the next one runs. The owner (the window) says which task to follow
/// ([`Self::set_target`]), when to read again (the panel opening, a turn
/// ending, the window coming back to the front) and whether the panel is
/// maximized ([`Self::set_maximized`]), and keeps what the panel asks it to
/// remember ([`ReviewPanelEvent`]).
///
/// The selection is the file in view: a click in the tree scrolls the diff
/// to the file, and scrolling the diff moves the tree's highlight to the
/// file at its top (`crate::sync`). It is the file's path, so a read that
/// changes nothing keeps the file, the diff's scroll and its folds.
///
/// The task's turns that edited files are scopes too ([`TurnChanges`],
/// which the panel owns and the owner feeds): a turn shows its files with
/// their net diffs (or their edits one after another), and needs no Git.
/// Where Git cannot show the folder's changes (no repository, no `git`, a
/// Host elsewhere) the panel shows the newest turn and lists only the
/// turns; the Git scopes and the base picker show only where Git works.
/// While the owner reads the task's earlier history, a quiet line under the
/// turns says so ([`Self::set_reading_turns`]).
pub struct ReviewPanel {
    git: Arc<dyn GitRunner>,
    target: Option<ReviewTarget>,
    /// The branch the person picked for this task, if any.
    base_branch: Option<String>,
    /// The scope the person chose: all changes at first.
    scope: ReviewScope,
    /// The last read's listing: its files and commits.
    read: Option<ReviewRead>,
    /// The branches of the last read that got as far as listing them.
    branches: Option<BranchContext>,
    /// A listing is being read.
    loading: bool,
    /// The patches of the last listing's files, by path, as they are read.
    patches: HashMap<SharedString, FilePatch>,
    /// The last listing's patches are being read.
    reading: Option<Reading>,
    /// Git failed reading the patches of the files it listed.
    patches_failed: bool,
    /// The Diff's next files are being prepared off the main thread.
    preparing: bool,
    /// A pick of another base branch or scope is being read; what it
    /// changes dims until it lands.
    switching: bool,
    generation: u64,
    /// The last read's files as the tree shows them.
    tree: Rc<FileTree>,
    /// The folders folded in the tree, by path.
    folded: HashSet<SharedString>,
    /// The file in view; the first file when it is gone.
    selected: Option<SharedString>,
    /// The tree's keyboard row when it is a folder; on the selected file
    /// otherwise.
    cursor: Option<TreeKey>,
    pin: Option<Pin>,
    /// Files whose whole diff shows, past [`DIFF_LINE_CAP`].
    whole: HashSet<SharedString>,
    /// Files read again with their whole text, by path.
    more: HashMap<SharedString, WholeText>,
    /// The file whose whole text is being read.
    reading_more: Option<SharedString>,
    /// The files the Diff holds, in its order.
    shown: Vec<ShownFile>,
    /// What the Diff's files were read for.
    diff_key: Option<DiffKey>,
    /// Each shown file's place in the Diff, by its path there.
    diff_order: Rc<HashMap<SharedString, usize>>,
    /// What each shown file's header says, by its path in the Diff.
    headers: Rc<HashMap<SharedString, Header>>,
    diff: Entity<DiffState>,
    /// The person's Unified or Split; none follows the column's width.
    chosen_mode: Option<DiffMode>,
    tree_visible: bool,
    /// The panel took the focus for its tree while a read was in flight:
    /// the tree takes it once the read lands with files.
    focus_tree_on_read: bool,
    maximized: bool,
    /// When the last read landed, and the zone, for the commits' times.
    read_at: (u64, i32),
    /// The panel's own focus, where keys go when it has no tree.
    focus: FocusHandle,
    files_focus: FocusHandle,
    scopes_focus: FocusHandle,
    files_scroll: UniformListScrollHandle,
    scopes_scroll: VirtualListScrollHandle,
    /// The scopes list's row heights, by the rem and the rows they were
    /// measured for.
    scope_sizes: Option<((Pixels, scopes::Layout), Rc<Vec<Size<Pixels>>>)>,
    measured: Rc<Measured>,
    refit: Rc<DiffRefit>,
    marks: Rc<HeaderMarks>,
    picker: Entity<BranchPicker>,
    picker_options: Vec<BaseBranch>,
    menu: MenuSlot,
    /// What each turn of the task edited.
    turns: Entity<TurnChanges>,
    /// The task's settled turns that edited files, oldest first, as
    /// `turns` last worked them out.
    turn_list: Arc<Vec<TurnChange>>,
    /// The turn the person chose to see; none shows the Git scope, or the
    /// newest turn where Git cannot show the folder's changes.
    chosen_turn: Option<SharedString>,
    /// When the turn list was taken, and the zone, for the turns' times.
    turns_at: (u64, i32),
    /// `turns` is working out what the turns changed.
    turns_computing: bool,
    /// The task's earlier history is being read, so the turns listed are
    /// not all of them yet; the owner says so ([`Self::set_reading_turns`]).
    reading_turns: bool,
    _load: Option<Task<()>>,
    _prepare: Option<Task<()>>,
    _more: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ReviewPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReviewPanel")
            .field("target", &self.target)
            .field("scope", &self.scope)
            .field("loading", &self.loading)
            .field("selected", &self.selected)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<ReviewPanelEvent> for ReviewPanel {}

impl ReviewPanel {
    pub fn new(git: Arc<dyn GitRunner>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let diff = cx.new(|cx| {
            DiffState::new([], cx)
                .with_inline_unit(Some(DiffInlineUnit::Word))
                .with_inline_max_line_length(1000)
        });
        let picker = cx.new(|cx| {
            SelectState::new(SearchableVec::new(Vec::new()), None, window, cx).searchable(true)
        });
        let turns = cx.new(|_| TurnChanges::new());
        let subscriptions = vec![
            cx.observe(&diff, |_, _, cx| cx.notify()),
            cx.observe(&turns, |this, _, cx| this.sync_turns(cx)),
            // A file too large to show has no rows: its header stays
            // folded, the notice under it saying why.
            cx.subscribe(&diff, |this, diff, event: &DiffEvent, cx| {
                if let DiffEvent::FileExpanded(path) = event
                    && this
                        .shown
                        .iter()
                        .any(|shown| &shown.diff_path == path && shown.is_too_large())
                {
                    diff.update(cx, |diff, cx| diff.set_file_collapsed(path, true, cx));
                }
            }),
            cx.subscribe_in(
                &picker,
                window,
                |this, _, event: &SelectEvent<SearchableVec<BranchChoice>>, window, cx| {
                    if let SelectEvent::Confirm(Some(branch)) = event {
                        this.choose_base_branch(branch.clone(), window, cx);
                    }
                },
            ),
        ];
        Self {
            git,
            target: None,
            base_branch: None,
            scope: ReviewScope::All,
            read: None,
            branches: None,
            loading: false,
            patches: HashMap::new(),
            reading: None,
            patches_failed: false,
            preparing: false,
            switching: false,
            generation: 0,
            tree: Rc::default(),
            folded: HashSet::new(),
            selected: None,
            cursor: None,
            pin: None,
            whole: HashSet::new(),
            more: HashMap::new(),
            reading_more: None,
            shown: Vec::new(),
            diff_key: None,
            diff_order: Rc::default(),
            headers: Rc::default(),
            diff,
            chosen_mode: None,
            tree_visible: true,
            focus_tree_on_read: false,
            maximized: false,
            read_at: (0, 0),
            focus: cx.focus_handle(),
            files_focus: cx.focus_handle().tab_stop(true),
            scopes_focus: cx.focus_handle().tab_stop(true),
            files_scroll: UniformListScrollHandle::new(),
            scopes_scroll: VirtualListScrollHandle::new(),
            scope_sizes: None,
            measured: Rc::default(),
            refit: Rc::default(),
            marks: Rc::default(),
            picker,
            picker_options: Vec::new(),
            menu: MenuSlot::new(MenuPlacement::BelowEnd),
            turns,
            turn_list: Arc::default(),
            chosen_turn: None,
            turns_at: (0, 0),
            turns_computing: false,
            reading_turns: false,
            _load: None,
            _prepare: None,
            _more: None,
            _subscriptions: subscriptions,
        }
    }

    /// The task the panel follows, or none (a draft has nothing to review),
    /// with the base branch remembered for it. Another task starts afresh:
    /// all changes, no result, nothing selected; a read in flight for the
    /// one before is dropped. Reading is the owner's call
    /// ([`Self::refresh`]).
    pub fn set_target(
        &mut self,
        target: Option<ReviewTarget>,
        base_branch: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.target == target {
            return;
        }
        self.turns.update(cx, |turns, cx| turns.set_target(target.as_ref(), cx));
        self.target = target;
        self.base_branch = base_branch;
        self.scope = ReviewScope::All;
        self.read = None;
        self.branches = None;
        self.loading = false;
        self.patches.clear();
        self.reading = None;
        self.patches_failed = false;
        self.switching = false;
        self.generation += 1;
        self.selected = None;
        self.cursor = None;
        self.pin = None;
        self.folded.clear();
        self.whole.clear();
        self.more.clear();
        self.reading_more = None;
        self.focus_tree_on_read = false;
        self.chosen_turn = None;
        self.reading_turns = false;
        self._load = None;
        self._more = None;
        self.sync_picker(window, cx);
        self.sync_turns(cx);
        self.sync_files();
        self.clear_diff(cx);
        cx.notify();
    }

    /// Reads with `git` from now on (tests give a fake).
    pub fn set_git_runner(&mut self, git: Arc<dyn GitRunner>) {
        self.git = git;
    }

    pub fn target(&self) -> Option<&ReviewTarget> {
        self.target.as_ref()
    }

    /// What each turn of the followed task edited: the owner hands it the
    /// session's edits ([`TurnChanges::set_edits`]).
    pub fn turn_changes(&self) -> &Entity<TurnChanges> {
        &self.turns
    }

    /// The Git scope the panel shows, or last showed while it shows a
    /// turn.
    pub fn scope(&self) -> &ReviewScope {
        &self.scope
    }

    /// The turn whose changes the panel shows, by id: the one chosen, or
    /// the newest where Git cannot show the folder's changes.
    pub fn shown_turn(&self) -> Option<&SharedString> {
        self.turn_shown().map(TurnChange::turn_id)
    }

    /// The task's settled turns that edited files, oldest first.
    pub fn turn_list(&self) -> &[TurnChange] {
        &self.turn_list
    }

    /// Whether the task's earlier history is being read, so that the turn
    /// list will grow: a quiet line under the turns says so. The owner,
    /// who reads it, keeps this in step.
    pub fn set_reading_turns(&mut self, reading: bool, cx: &mut Context<Self>) {
        if self.reading_turns != reading {
            self.reading_turns = reading;
            cx.notify();
        }
    }

    /// Whether the panel says earlier turns are being read.
    pub fn is_reading_turns(&self) -> bool {
        self.reading_turns
    }

    fn turn_shown(&self) -> Option<&TurnChange> {
        let chosen = self
            .chosen_turn
            .as_ref()
            .and_then(|id| self.turn_list.iter().find(|turn| turn.turn_id() == id));
        chosen.or_else(|| self.git_unavailable().then(|| self.turn_list.last()).flatten())
    }

    /// The last read found no repository changes to show: no folder here,
    /// not a repository, no `git`, or Git failing.
    fn git_unavailable(&self) -> bool {
        matches!(self.read, Some(Err(_)))
    }

    /// Where the tree's files and their diffs come from now.
    fn source(&self) -> Option<Source<'_>> {
        match self.turn_shown() {
            Some(turn) => Some(Source::Turn(turn)),
            None => self.snapshot().map(Source::Git),
        }
    }

    /// What the Diff's files are for now.
    fn source_key(&self) -> Option<DiffKey> {
        match self.source()? {
            Source::Git(snapshot) => Some(DiffKey::of(snapshot)),
            Source::Turn(turn) => Some(DiffKey::Turn(turn.turn_id().clone())),
        }
    }

    /// Takes the turns `turns` last worked out: the list of turn scopes,
    /// and the shown turn's files and diffs when they changed.
    fn sync_turns(&mut self, cx: &mut Context<Self>) {
        let turns = self.turns.read(cx);
        let computing = turns.is_computing();
        let list: Vec<TurnChange> = turns
            .turns()
            .iter()
            .filter(|turn| turn.is_settled() && !turn.files().is_empty())
            .cloned()
            .collect();
        if std::mem::replace(&mut self.turns_computing, computing) != computing {
            cx.notify();
        }
        if *self.turn_list == list {
            return;
        }
        let shown = self.turn_shown().cloned();
        self.turn_list = Arc::new(list);
        self.turns_at = (now_ms(), shared::time::local_utc_offset());
        if self.turn_shown() != shown.as_ref() {
            self.show_source(cx);
        }
        cx.notify();
    }

    /// Shows what [`Self::source`] gives in the tree and the Diff: another
    /// source empties the Diff until its files are ready.
    fn show_source(&mut self, cx: &mut Context<Self>) {
        if self.diff_key.is_some() && self.diff_key != self.source_key() {
            self.clear_diff(cx);
        }
        self.sync_files();
        if matches!(self.source(), Some(Source::Turn(_))) {
            self.load_diff(None, cx);
        }
    }

    /// Shows turn `turn_id`'s changes, scrolled to the file at `path` (as
    /// the turn shows it) when given: the card under the turn's "View
    /// changes" and its file rows. A Git read in flight is dropped.
    pub fn show_turn(
        &mut self,
        turn_id: impl Into<SharedString>,
        path: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        let turn_id = turn_id.into();
        if self.chosen_turn.as_ref() != Some(&turn_id) || self.reading.is_some() {
            self.chosen_turn = Some(turn_id);
            // Patches being read for the Git scope stop; the listing in
            // flight still lands, for the scopes and the strip.
            self.reading = None;
            self.patches.clear();
            self.patches_failed = false;
            self.switching = false;
            if !self.loading {
                self.generation += 1;
                self._load = None;
            }
            self.show_source(cx);
            self.reveal_scope(cx);
        }
        if let Some(path) = path {
            self.select_file(path, cx);
        }
        cx.notify();
    }

    /// Reads the target's changes in the chosen scope again, keeping the
    /// last result on screen until the new one lands: first the list of
    /// files, which the tree and the totals show at once, then their
    /// patches, batch by batch, which the Diff shows once they are all read
    /// and parsed. On a Host elsewhere there is nothing to read: the panel
    /// says the folder is unavailable.
    pub fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.target.clone() else { return };
        self.generation += 1;
        let Some(workspace) = target.workspace else {
            self.finish(Err(ReviewFailure::new(FailureReason::WorkspaceUnavailable)), window, cx);
            return;
        };
        let generation = self.generation;
        self.loading = true;
        cx.notify();
        let (git, base, scope) = (self.git.clone(), self.base_branch.clone(), self.scope.clone());
        let list = cx.background_spawn({
            let git = git.clone();
            async move { read_review(&workspace, base.as_deref(), &scope, git).await }
        });
        self._load = Some(cx.spawn_in(window, async move |this, cx| {
            let listing = list.await;
            let batches = this
                .update_in(cx, |this, window, cx| {
                    (this.generation == generation)
                        .then(|| this.finish(listing, window, cx))
                        .flatten()
                })
                .ok()
                .flatten();
            let Some(batches) = batches else { return };
            for batch in batches {
                let read = cx.background_spawn(read_patches(batch, git.clone())).await;
                let go_on = this.update(cx, |this, cx| this.take_patches(generation, read, cx));
                if !matches!(go_on, Ok(true)) {
                    return;
                }
            }
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.reading = None;
                    this.load_diff(None, cx);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// Takes a listing (Desktop's `load`): a base branch that is gone is
    /// forgotten and the read made once more without it, which cannot fail
    /// that way again. A listing of All changes tells the owner what the
    /// context strip says. Gives the batches its patches are to be read in.
    fn finish(
        &mut self,
        result: ReviewRead,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Vec<PatchBatch>> {
        if let Err(failure) = &result
            && failure.reason == FailureReason::InvalidBaseBranch
            && self.base_branch.is_some()
        {
            if let Some(branches) = &failure.branches {
                self.branches = Some(branches.clone());
            }
            self.base_branch = None;
            if let Some(target) = &self.target {
                cx.emit(ReviewPanelEvent::BaseBranchChanged {
                    session_id: target.session_id.clone(),
                    base_branch: None,
                });
            }
            self.sync_picker(window, cx);
            self.refresh(window, cx);
            return None;
        }
        if let Ok(snapshot) = &result {
            // A commit gone from the branch read as all changes.
            self.scope = snapshot.scope.clone();
        }
        let git_ok = result.is_ok();
        if self.scope == ReviewScope::All
            && let Some(target) = &self.target
        {
            cx.emit(ReviewPanelEvent::ChangesRead {
                session_id: target.session_id.clone(),
                totals: ChangeTotals::of(&result),
            });
        }
        self.branches = match &result {
            Ok(snapshot) => Some(snapshot.branches.clone()),
            Err(failure) => failure.branches.clone(),
        };
        // A turn shown, chosen or where Git shows nothing: the listing
        // serves the scopes, the picker and the strip; no patch is read.
        let turn_shown = self
            .chosen_turn
            .as_ref()
            .is_some_and(|id| self.turn_list.iter().any(|turn| turn.turn_id() == id))
            || (!git_ok && !self.turn_list.is_empty());
        let batches = match &result {
            _ if turn_shown => {
                self.reading = None;
                None
            }
            Ok(snapshot) => {
                if self.diff_key.as_ref().is_some_and(|key| *key != DiffKey::of(snapshot)) {
                    self.clear_diff(cx);
                }
                self.reading = Some(Reading { done: 0, total: snapshot.files.len() });
                Some(snapshot.patch_batches())
            }
            Err(_) => {
                self.reading = None;
                self.clear_diff(cx);
                None
            }
        };
        // Files prepared for the Diff from an earlier listing are prepared
        // again from this one's patches.
        self.preparing = false;
        self._prepare = None;
        self.patches.clear();
        self.patches_failed = false;
        self.read = Some(result);
        self.read_at = (now_ms(), shared::time::local_utc_offset());
        self.loading = false;
        self.switching = false;
        self.sync_picker(window, cx);
        self.show_source(cx);
        if std::mem::take(&mut self.focus_tree_on_read)
            && self.focus.is_focused(window)
            && self.tree_visible
            && self.tree.files().next().is_some()
        {
            self.files_focus.focus(window, cx);
        }
        cx.notify();
        batches
    }

    /// Takes a batch's patches, read for the listing of `generation`;
    /// whether to read on. Git failing past the listing stops the read: the
    /// panel says so and offers to read again.
    fn take_patches(
        &mut self,
        generation: u64,
        read: Result<Vec<(String, FilePatch)>, GitError>,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.generation != generation {
            return false;
        }
        let Ok(patches) = read else {
            self.reading = None;
            self.patches_failed = true;
            cx.notify();
            return false;
        };
        for (path, patch) in patches {
            // A path both staged and changed again, before the first
            // commit, has a patch from each comparison.
            match self.patches.entry(path.into()) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(patch);
                }
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    let joined = match (entry.get(), patch) {
                        (FilePatch::Text(first), FilePatch::Text(second)) => {
                            FilePatch::Text(format!("{first}{second}").into())
                        }
                        _ => FilePatch::TooLarge,
                    };
                    entry.insert(joined);
                }
            }
        }
        if let Some(reading) = &mut self.reading {
            reading.done = self.patches.len().min(reading.total);
        }
        cx.notify();
        true
    }

    /// Compares against `branch` from now on (Desktop's
    /// `selectBaseBranch`), remembered for the task, and reads again.
    pub fn choose_base_branch(
        &mut self,
        branch: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.base_branch.as_ref() == Some(&branch) {
            return;
        }
        self.base_branch = Some(branch.clone());
        if let Some(target) = &self.target {
            cx.emit(ReviewPanelEvent::BaseBranchChanged {
                session_id: target.session_id.clone(),
                base_branch: Some(branch),
            });
        }
        self.switching = true;
        self.refresh(window, cx);
    }

    /// Shows `scope`'s changes: all of them, the uncommitted ones, or one
    /// of the branch's commits; reads them. From a turn, the scope it left
    /// is read again.
    pub fn choose_scope(
        &mut self,
        scope: ReviewScope,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let from_turn = self.chosen_turn.take().is_some();
        if self.scope == scope && !from_turn {
            return;
        }
        self.scope = scope;
        self.switching = true;
        if from_turn {
            self.show_source(cx);
        }
        self.refresh(window, cx);
    }

    /// Shows the file at `path` (a path the read lists): scrolls the diff to
    /// its header and highlights it in the tree, unfolding its folders. A
    /// file whose patch is still being read is highlighted, and the Diff
    /// opens at it once it has it.
    pub fn select_file(&mut self, path: impl Into<SharedString>, cx: &mut Context<Self>) {
        let path = path.into();
        let key = TreeKey::File(path.clone());
        if !self.tree.files().any(|file| file.path == path) {
            return;
        }
        for folder in self.tree.ancestors_of(&key).to_vec() {
            self.folded.remove(&folder);
        }
        self.selected = Some(path.clone());
        self.cursor = None;
        if let Some(shown) = self.shown.iter().find(|shown| *shown.path() == path) {
            let diff_path = shown.diff_path.clone();
            self.pin = Some(Pin { path, frames: PIN_FRAMES });
            self.marks.set_eager(true);
            self.diff.update(cx, |diff, cx| diff.scroll_to_file(&diff_path, cx));
        }
        self.reveal_row(&key);
        cx.notify();
    }

    /// The diff shows `view`: the tree's highlight follows the file at its
    /// top, unless a file just chosen is still being scrolled to or in view.
    pub(crate) fn follow_diff(&mut self, view: &InView, cx: &mut Context<Self>) {
        let Some(top) = self.shown.get(view.top).map(|shown| shown.path().clone()) else { return };
        if let Some(pin) = &mut self.pin {
            let pinned = self.shown.iter().position(|shown| *shown.path() == pin.path);
            if pinned == Some(view.top) {
                self.pin = None;
                self.marks.set_eager(false);
            } else if pinned.is_some_and(|ix| view.headers.contains(&ix)) {
                return;
            } else if pin.frames > 0 {
                pin.frames -= 1;
                return;
            } else {
                self.pin = None;
                self.marks.set_eager(false);
            }
        }
        if self.selected.as_ref() != Some(&top) {
            self.selected = Some(top.clone());
            self.cursor = None;
            self.reveal_row(&TreeKey::File(top));
            cx.notify();
        }
    }

    /// Scrolls the tree to `key`'s row, if it shows.
    fn reveal_row(&self, key: &TreeKey) {
        let rows = self.tree.visible(&self.folded);
        if let Some(ix) = rows.iter().position(|node| &node.key() == key) {
            self.files_scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
        }
    }

    /// The selected file's path.
    pub fn selected_file(&self) -> Option<&SharedString> {
        self.selected.as_ref()
    }

    /// How many files the scope has: every file the read lists.
    pub fn file_count(&self) -> usize {
        match self.source() {
            Some(Source::Git(snapshot)) => snapshot.files.len(),
            Some(Source::Turn(turn)) => turn.files().len(),
            None => 0,
        }
    }

    /// The listed files' patches are being read: how many of how many are
    /// read.
    pub fn reading_progress(&self) -> Option<(usize, usize)> {
        self.reading.map(|reading| (reading.done, reading.total))
    }

    /// Folds the tree's folder at `path`, or unfolds it.
    pub fn toggle_folder(&mut self, path: &SharedString, cx: &mut Context<Self>) {
        if !self.folded.remove(path) {
            self.folded.insert(path.clone());
        }
        self.cursor = Some(TreeKey::Folder(path.clone()));
        cx.notify();
    }

    pub fn is_folder_folded(&self, path: &str) -> bool {
        self.folded.contains(path)
    }

    /// Shows the tree and the commits, or hides them for the diff alone.
    pub fn toggle_tree(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.tree_visible = !self.tree_visible;
        if !self.tree_visible
            && (self.files_focus.contains_focused(window, cx)
                || self.scopes_focus.contains_focused(window, cx))
        {
            self.focus.focus(window, cx);
        }
        cx.notify();
    }

    pub fn is_tree_visible(&self) -> bool {
        self.tree_visible
    }

    /// Shows the file `step` files after the one in view (before, for a
    /// negative step) in the tree's order, stopping at either end.
    fn move_file(&mut self, step: isize, cx: &mut Context<Self>) {
        let files: Vec<&SharedString> = self.tree.files().map(|file| &file.path).collect();
        let Some(last) = files.len().checked_sub(1) else { return };
        let ix = self
            .selected
            .as_ref()
            .and_then(|selected| files.iter().position(|path| *path == selected))
            .unwrap_or(0);
        let next = ix.saturating_add_signed(step).min(last);
        let path = files[next].clone();
        self.select_file(path, cx);
    }

    /// The tree's keyboard row: the folder the cursor is on, or the
    /// selected file's row (its folder's, while folded away).
    fn cursor_ix(&self, rows: &[TreeNode]) -> Option<usize> {
        let find = |key: &TreeKey| rows.iter().position(|node| &node.key() == key);
        if let Some(ix) = self.cursor.as_ref().and_then(find) {
            return Some(ix);
        }
        let selected = TreeKey::File(self.selected.clone()?);
        find(&selected).or_else(|| {
            self.tree
                .ancestors_of(&selected)
                .iter()
                .rev()
                .find_map(|folder| find(&TreeKey::Folder(folder.clone())))
        })
    }

    /// Moves the tree's keyboard row to `ix`: a file's row shows the file.
    fn move_cursor_to(&mut self, ix: usize, rows: &[TreeNode], cx: &mut Context<Self>) {
        match rows.get(ix) {
            Some(TreeNode::File { file, .. }) => self.select_file(file.path.clone(), cx),
            Some(node @ TreeNode::Folder { .. }) => {
                let key = node.key();
                self.files_scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
                self.cursor = Some(key);
                cx.notify();
            }
            None => {}
        }
    }

    fn move_cursor(&mut self, step: isize, cx: &mut Context<Self>) {
        let rows = self.tree.visible(&self.folded);
        let Some(last) = rows.len().checked_sub(1) else { return };
        let ix = match self.cursor_ix(&rows) {
            Some(ix) => ix.saturating_add_signed(step).min(last),
            None => 0,
        };
        self.move_cursor_to(ix, &rows, cx);
    }

    /// ←: folds the folder the keyboard is on, else goes up to its folder.
    fn fold_folder(&mut self, cx: &mut Context<Self>) {
        let rows = self.tree.visible(&self.folded);
        let Some(node) = self.cursor_ix(&rows).map(|ix| rows[ix].clone()) else { return };
        match &node {
            TreeNode::Folder { path, .. } if !self.folded.contains(path) => {
                self.toggle_folder(path, cx);
            }
            _ => {
                if let Some(parent) = node.parent() {
                    let key = TreeKey::Folder(parent.clone());
                    if let Some(ix) = rows.iter().position(|node| node.key() == key) {
                        self.move_cursor_to(ix, &rows, cx);
                    }
                }
            }
        }
    }

    /// →: unfolds the folder the keyboard is on, else goes into it.
    fn unfold_folder(&mut self, cx: &mut Context<Self>) {
        let rows = self.tree.visible(&self.folded);
        let Some(ix) = self.cursor_ix(&rows) else { return };
        if let TreeNode::Folder { path, .. } = &rows[ix] {
            if self.folded.contains(path) {
                let path = path.clone();
                self.toggle_folder(&path, cx);
            } else {
                self.move_cursor_to(ix + 1, &rows, cx);
            }
        }
    }

    /// Enter: folds or unfolds the folder the keyboard is on, or moves into
    /// the diff from a file.
    fn open_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rows = self.tree.visible(&self.folded);
        match self.cursor_ix(&rows).map(|ix| &rows[ix]) {
            Some(TreeNode::Folder { path, .. }) => {
                let path = path.clone();
                self.toggle_folder(&path, cx);
            }
            Some(TreeNode::File { .. }) => self.focus_diff(&FocusDiff, window, cx),
            None => {}
        }
    }

    /// Unified or split, as the person picks it: the pick holds from now
    /// on, whatever the column's width.
    pub fn set_mode(&mut self, mode: DiffMode, cx: &mut Context<Self>) {
        self.chosen_mode = Some(mode);
        self.diff.update(cx, |diff, cx| diff.set_mode(mode, cx));
        cx.notify();
    }

    pub fn mode(&self, cx: &App) -> DiffMode {
        self.diff.read(cx).mode()
    }

    /// Opens split where the diff's column is wide enough, unified where it
    /// is not, unless the person picked one.
    fn follow_diff_width(&mut self, split: bool, cx: &mut Context<Self>) {
        if self.chosen_mode.is_some() {
            return;
        }
        let mode = if split { DiffMode::Split } else { DiffMode::Unified };
        self.diff.update(cx, |diff, cx| diff.set_mode(mode, cx));
    }

    /// Whether the panel is maximized, as the owner keeps it for the task.
    pub fn set_maximized(&mut self, maximized: bool, cx: &mut Context<Self>) {
        if self.maximized != maximized {
            self.maximized = maximized;
            cx.notify();
        }
    }

    pub fn is_maximized(&self) -> bool {
        self.maximized
    }

    /// Gives the file tree keyboard focus, or the panel while it shows no
    /// tree or no files; the tree once the read in flight lands with
    /// files, if the panel still has the focus then.
    pub fn focus_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tree.files().next().is_none() || !self.tree_visible {
            self.focus.focus(window, cx);
            self.focus_tree_on_read = self.loading;
        } else {
            self.files_focus.focus(window, cx);
        }
    }

    fn restore_split(&mut self, _: &RestoreSplit, _: &mut Window, cx: &mut Context<Self>) {
        if self.maximized {
            cx.emit(ReviewPanelEvent::MaximizeRequested(false));
        } else {
            cx.propagate();
        }
    }

    fn focus_diff(&mut self, _: &FocusDiff, window: &mut Window, cx: &mut Context<Self>) {
        if !self.shown.is_empty() {
            self.diff.read(cx).focus_handle(cx).focus(window, cx);
        }
    }

    /// Unfolds every run of unchanged lines in the diff (`true`), or folds
    /// them all again.
    pub fn set_unchanged_expanded(&mut self, expanded: bool, cx: &mut Context<Self>) {
        self.diff.update(cx, |diff, cx| {
            if expanded { diff.expand_unchanged(cx) } else { diff.collapse_unchanged(cx) }
        });
        cx.notify();
    }

    /// Shows the rest of the diff of the file at `path`, past
    /// [`DIFF_LINE_CAP`], keeping the line that was last in view.
    fn show_whole_file(&mut self, path: &SharedString, cx: &mut Context<Self>) {
        let Some(shown) = self.shown.iter().find(|shown| shown.path() == path) else {
            return;
        };
        let anchor = shown.last_line.map(|(side, line)| {
            DiffLinePosition::new(shown.diff_path.clone(), diff_side(side), line as usize)
        });
        self.whole.insert(path.clone());
        self.load_diff(anchor, cx);
        cx.notify();
    }

    /// Reads the file at `path` again with its whole text around its
    /// changes ("Show more lines"), which the Diff then folds for the
    /// reader to unfold, keeping its last line in view.
    fn show_more_lines(&mut self, path: &SharedString, cx: &mut Context<Self>) {
        let (Some(snapshot), Some(shown)) =
            (self.snapshot(), self.shown.iter().find(|shown| shown.path() == path))
        else {
            return;
        };
        let Some(file) = snapshot.files.iter().find(|file| file.path == path.as_ref()) else {
            return;
        };
        let Some(FilePatch::Text(read_for)) = self.patches.get(path).cloned() else { return };
        let (root, scope, merge_base) =
            (snapshot.repository_root.clone(), snapshot.scope.clone(), snapshot.merge_base.clone());
        let (file_path, previous) = (file.path.clone(), file.previous_path.clone());
        let anchor = shown.more_at.map(|(side, line)| {
            DiffLinePosition::new(shown.diff_path.clone(), diff_side(side), line as usize)
        });
        let (git, generation, path) = (self.git.clone(), self.generation, path.clone());
        self.reading_more = Some(path.clone());
        cx.notify();
        let read = cx.background_spawn(async move {
            read_whole_file(
                &root,
                &scope,
                merge_base.as_deref(),
                &file_path,
                previous.as_deref(),
                git,
            )
            .await
        });
        self._more = Some(cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.reading_more = None;
                // Nothing more to give, or Git failed: the diff it had is
                // the whole of what it can show.
                let text = result.ok().flatten().map_or_else(|| read_for.clone(), Arc::from);
                this.more.insert(path, WholeText { read_for, text });
                this.load_diff(anchor, cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// A read is in flight: its listing, its patches, or the Diff's files
    /// being prepared from them; or the turns' changes being worked out.
    pub fn is_loading(&self) -> bool {
        self.loading || self.reading.is_some() || self.preparing || self.turns_computing
    }

    /// The last read's result, `None` before the first one.
    pub fn result(&self) -> Option<&ReviewRead> {
        self.read.as_ref()
    }

    /// The Diff every file of the scope shows in.
    pub fn diff(&self) -> &Entity<DiffState> {
        &self.diff
    }

    fn snapshot(&self) -> Option<&ReviewSnapshot> {
        self.read.as_ref()?.as_ref().ok()
    }

    /// Builds the tree of the shown files (the last listing's, or the shown
    /// turn's), and keeps the selected file when it is still there (else
    /// selects the first).
    fn sync_files(&mut self) {
        let tree = match self.source() {
            Some(Source::Git(snapshot)) => FileTree::new(&snapshot.files),
            Some(Source::Turn(turn)) => turn_tree(turn),
            None => FileTree::default(),
        };
        if *self.tree != tree {
            self.tree = Rc::new(tree);
        }
        let kept =
            self.selected.clone().filter(|path| self.tree.files().any(|file| &file.path == path));
        if kept.is_none() {
            self.pin = None;
            self.marks.set_eager(false);
        }
        self.selected = kept.or_else(|| self.tree.files().next().map(|file| file.path.clone()));
    }

    /// Empties the Diff, and drops any files being prepared for it.
    fn clear_diff(&mut self, cx: &mut Context<Self>) {
        self.preparing = false;
        self._prepare = None;
        self.diff_key = None;
        if self.shown.is_empty() {
            return;
        }
        self.shown.clear();
        self.diff_order = Rc::default();
        self.headers = Rc::default();
        self.marks.reset();
        self.diff.update(cx, |diff, cx| diff.set_files([], cx));
    }

    /// What the Diff is to show of each listed file, in the tree's order:
    /// its patch (its whole text once read for "Show more lines"), cut to
    /// [`DIFF_LINE_CAP`] lines unless it shows whole. A turn's file shows
    /// its net diff, or each of its edits one after another.
    fn diff_inputs(&self) -> Vec<DiffInput> {
        if let Some(Source::Turn(turn)) = self.source() {
            return self.turn_inputs(turn);
        }
        self.tree
            .files()
            .map(|file| {
                let source = match self.patches.get(&file.path) {
                    _ if file.unread_size.is_some() => DiffSource::TooLarge,
                    Some(FilePatch::TooLarge) => DiffSource::TooLarge,
                    Some(FilePatch::Text(text)) => DiffSource::Text(text.clone()),
                    None => DiffSource::Text(Arc::from("")),
                };
                let whole_text = match &source {
                    DiffSource::Text(patch) => self
                        .more
                        .get(&file.path)
                        .filter(|whole| whole.read_for == *patch)
                        .map(|whole| whole.text.clone()),
                    DiffSource::TooLarge => None,
                };
                let cap = if self.whole.contains(&file.path) { usize::MAX } else { DIFF_LINE_CAP };
                DiffInput {
                    path: file.path.clone(),
                    status: file.status,
                    whole_text: whole_text.is_some(),
                    more: true,
                    step: None,
                    source: whole_text.map_or(source, DiffSource::Text),
                    cap,
                }
            })
            .collect()
    }

    /// The Diff's inputs for `turn`'s files, in the tree's order.
    fn turn_inputs(&self, turn: &TurnChange) -> Vec<DiffInput> {
        let mut inputs = Vec::new();
        for file in self.tree.files() {
            let Some(change) = turn.file(&file.path) else { continue };
            let cap = if self.whole.contains(&file.path) { usize::MAX } else { DIFF_LINE_CAP };
            let input = |patch: &Arc<str>, step| DiffInput {
                path: file.path.clone(),
                status: file.status,
                source: DiffSource::Text(patch.clone()),
                whole_text: false,
                more: false,
                step,
                cap,
            };
            match change.view() {
                FileView::Net(patch) => inputs.push(input(patch, None)),
                FileView::Steps(steps) => {
                    let total = steps.len();
                    inputs.extend(
                        steps
                            .iter()
                            .enumerate()
                            .map(|(ix, step)| input(&step.patch, Some((ix + 1, total)))),
                    );
                }
            }
        }
        inputs
    }

    /// Gives the Diff every listed file in the tree's order, once their
    /// patches are read: the files whose diffs are new are prepared and
    /// parsed on the background executor, the rest kept as they are. A
    /// read that changes nothing keeps the Diff as it is, with its scroll
    /// and folds; `anchor`, the line to keep in view, else the selected
    /// file shows from its top.
    fn load_diff(&mut self, anchor: Option<DiffLinePosition>, cx: &mut Context<Self>) {
        let ready = match self.source() {
            Some(Source::Git(_)) => self.reading.is_none() && !self.patches_failed,
            Some(Source::Turn(_)) => true,
            None => false,
        };
        if !ready {
            return;
        }
        let kept: HashMap<(&SharedString, Option<(usize, usize)>), &ShownFile> =
            self.shown.iter().map(|shown| ((shown.path(), shown.input.step), shown)).collect();
        let mut next = Vec::new();
        let mut fresh = Vec::new();
        for (ix, input) in self.diff_inputs().into_iter().enumerate() {
            match kept.get(&(&input.path, input.step)).filter(|shown| shown.input == input) {
                Some(shown) => next.push(Some((*shown).clone())),
                None => {
                    next.push(None);
                    fresh.push((ix, input));
                }
            }
        }
        if fresh.is_empty() {
            self.preparing = false;
            self._prepare = None;
            self.install(next.into_iter().flatten().collect(), anchor, cx);
            return;
        }
        self.preparing = true;
        let prepared = cx.background_spawn(async move {
            fresh.into_iter().map(|(ix, input)| (ix, prepare(input))).collect::<Vec<_>>()
        });
        let generation = self.generation;
        self._prepare = Some(cx.spawn(async move |this, cx| {
            let prepared = prepared.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                for (ix, shown) in prepared {
                    next[ix] = Some(shown);
                }
                this.preparing = false;
                this.install(next.into_iter().flatten().collect(), anchor, cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Gives the Diff `next`, unless it holds exactly that already; a file
    /// too large to show stays folded to its header.
    fn install(
        &mut self,
        next: Vec<ShownFile>,
        anchor: Option<DiffLinePosition>,
        cx: &mut Context<Self>,
    ) {
        self.diff_key = self.source_key();
        let tree_files: HashMap<&SharedString, &TreeFile> =
            self.tree.files().map(|file| (&file.path, file)).collect();
        let headers = next
            .iter()
            .filter_map(|shown| {
                let file = (*tree_files.get(shown.path())?).clone();
                Some((shown.diff_path.clone(), Header { file, step: shown.input.step }))
            })
            .collect();
        self.headers = Rc::new(headers);
        let same = next.len() == self.shown.len()
            && next.iter().zip(&self.shown).all(|(next, shown)| next.input == shown.input);
        if same {
            return;
        }
        let order = next
            .iter()
            .enumerate()
            .rev()
            .map(|(ix, shown)| (shown.diff_path.clone(), ix))
            .collect();
        let top = self
            .selected
            .as_ref()
            .and_then(|selected| next.iter().find(|shown| shown.path() == selected))
            .or(next.first())
            .map(|shown| shown.diff_path.clone());
        let files: Vec<DiffFile> = next.iter().map(|shown| shown.file.clone()).collect();
        let too_large = |shown: &[ShownFile]| -> HashSet<SharedString> {
            shown
                .iter()
                .filter(|shown| shown.is_too_large())
                .map(|shown| shown.diff_path.clone())
                .collect()
        };
        let (was_too_large, too_large) = (too_large(&self.shown), too_large(&next));
        self.shown = next;
        self.diff_order = Rc::new(order);
        self.marks.reset();
        if let Some(top) = top {
            self.refit.files_changed(top);
        }
        if anchor.is_some() {
            self.refit.keep_position();
        }
        self.diff.update(cx, |diff, cx| {
            diff.set_files(files, cx);
            // The Diff keeps a path's fold across new files: a file that
            // was too large to show and is no longer opens again.
            for path in was_too_large.difference(&too_large) {
                diff.set_file_collapsed(path, false, cx);
            }
            for path in &too_large {
                diff.set_file_collapsed(path, true, cx);
            }
            if let Some(anchor) = anchor {
                diff.scroll_to_line(anchor, cx);
            }
        });
    }

    /// Lists the branches of the last read in the picker, and the branch
    /// compared against as its value.
    fn sync_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let options =
            self.branches.as_ref().map(|b| b.base_branch_options.clone()).unwrap_or_default();
        let selected = self
            .base_branch
            .clone()
            .or_else(|| self.snapshot().and_then(|snapshot| snapshot.base_branch.clone()));
        let refill = options != self.picker_options;
        self.picker_options = options.clone();
        self.picker.update(cx, |picker, cx| {
            if refill {
                let choices: Vec<BranchChoice> = options.into_iter().map(BranchChoice).collect();
                picker.set_items(SearchableVec::new(choices), window, cx);
            }
            match &selected {
                Some(selected) => picker.set_selected_value(selected, window, cx),
                None => picker.set_selected_index(None, window, cx),
            }
        });
    }

    /// Why there is nothing to show, in Desktop's words; Git failing past
    /// the listing is a failure to read too.
    ///
    /// Where the task's turns show instead, or are being read, a folder
    /// that is no repository, is not on this machine, or has no `git` to
    /// read it says nothing: the turns are the changes there are to show.
    fn failure_text(&self) -> Option<Text> {
        if self.patches_failed && self.turn_shown().is_none() {
            return Some(copy::GIT_FAILED);
        }
        let Some(Err(failure)) = &self.read else { return None };
        if (self.turn_shown().is_some() || self.reading_turns)
            && matches!(
                failure.reason,
                FailureReason::NotGitRepository
                    | FailureReason::WorkspaceUnavailable
                    | FailureReason::GitMissing
            )
        {
            return None;
        }
        Some(match failure.reason {
            FailureReason::NotGitRepository => copy::NOT_GIT_REPOSITORY,
            FailureReason::WorkspaceUnavailable => copy::WORKSPACE_UNAVAILABLE,
            FailureReason::UnbornRepository => copy::UNBORN_REPOSITORY,
            FailureReason::InvalidBaseBranch
            | FailureReason::GitFailed
            | FailureReason::GitMissing => copy::GIT_FAILED,
        })
    }

    /// The "⋯" menu: the diff's layout as a choice, every run of unchanged
    /// lines unfolded or folded, and the file and change keys.
    fn menu_entries(&self, cx: &mut Context<Self>) -> Vec<MenuEntry> {
        let mode = self.mode(cx);
        let panel = cx.entity().downgrade();
        let has_files = !self.shown.is_empty();
        let command = |key: &'static str,
                       label: Text,
                       run: fn(&mut ReviewPanel, &mut Context<ReviewPanel>),
                       cx: &App| {
            let panel = panel.clone();
            MenuItem::new(key, label.get(cx)).on_select(move |_, cx| {
                panel.update(cx, run).ok();
            })
        };
        vec![
            command("unified", copy::UNIFIED, |this, cx| this.set_mode(DiffMode::Unified, cx), cx)
                .checked(mode == DiffMode::Unified)
                .into(),
            command("split", copy::SPLIT, |this, cx| this.set_mode(DiffMode::Split, cx), cx)
                .checked(mode == DiffMode::Split)
                .into(),
            MenuEntry::Separator,
            command(
                "expand-all",
                copy::EXPAND_ALL,
                |this, cx| this.set_unchanged_expanded(true, cx),
                cx,
            )
            .disabled(!has_files)
            .into(),
            command(
                "collapse-all",
                copy::COLLAPSE_ALL,
                |this, cx| this.set_unchanged_expanded(false, cx),
                cx,
            )
            .disabled(!has_files)
            .into(),
            MenuEntry::Separator,
            MenuItem::new("next-file", copy::NEXT_FILE.get(cx))
                .action(Box::new(NextFile))
                .disabled(!has_files)
                .into(),
            MenuItem::new("previous-file", copy::PREVIOUS_FILE.get(cx))
                .action(Box::new(PreviousFile))
                .disabled(!has_files)
                .into(),
            MenuItem::new("next-change", copy::NEXT_CHANGE.get(cx))
                .action(Box::new(NextChange))
                .disabled(!has_files)
                .into(),
            MenuItem::new("previous-change", copy::PREVIOUS_CHANGE.get(cx))
                .action(Box::new(PreviousChange))
                .disabled(!has_files)
                .into(),
        ]
    }

    /// Opens the "⋯" menu below its button, as a click on it does.
    pub fn open_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let entries = self.menu_entries(cx);
        let width = window.rem_size() * MENU_WIDTH_REMS;
        MenuSlot::open(self, |this| &mut this.menu, entries, width, window, cx);
    }

    /// The bar on top, under the workbar's strip: the tree's toggle, the
    /// base branch → the current branch (the panel's name while there are
    /// none), then the "⋯" menu.
    fn render_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let icon = |glyph: Icon| glyph.size_4().text_color(maka.ink_muted);
        let tree =
            if self.tree_visible { copy::HIDE_TREE.get(cx) } else { copy::SHOW_TREE.get(cx) };
        let more = copy::MORE_ACTIONS.get(cx);
        let bar_button =
            |id: &'static str| Button::new(id).ghost().small().size_7().flex_shrink_0();
        // The tree's toggle and the "⋯" button put their glyphs' ink on the
        // plate's 16 px line, where the rows' icons and the scopes' text
        // start; the title keeps its gap after the toggle.
        let edge =
            |share| rems(ink_padding(PLATE_LINE_REMS, ICON_BUTTON_REMS, ICON_GLYPH_REMS, share));
        h_flex()
            .id("review-bar")
            .test_support()
            .h(rems(3.))
            .flex_shrink_0()
            .pl(edge(ink::LIST_TREE_LEADING))
            .pr(edge(ink::MORE))
            .gap_1()
            .border_b_1()
            .border_color(maka.border_soft)
            .child(
                bar_button("review-tree-toggle")
                    .icon(icon(Icon::new(AssetIcon::ListTree)))
                    .accessibility_label(tree)
                    .tooltip(tree)
                    .selected(self.tree_visible)
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_tree(window, cx))),
            )
            .child(self.render_branches(cx))
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        bar_button("review-more")
                            .icon(icon(Icon::new(MakaIcon::More)))
                            .accessibility_label(more)
                            .tooltip(more)
                            .selected(self.menu.is_open())
                            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                                let width = window.rem_size() * MENU_WIDTH_REMS;
                                MenuSlot::toggle(
                                    this,
                                    |this| &mut this.menu,
                                    event,
                                    |this, cx| this.menu_entries(cx),
                                    width,
                                    window,
                                    cx,
                                );
                            })),
                    )
                    .children(self.menu.layer()),
            )
    }

    /// Claude Code's "main → staging": the picker of the base branch, which
    /// reads like the branch beside it rather than a call to action, an
    /// arrow, and the current branch in mono. The panel's name while the
    /// read knows no branches.
    fn render_branches(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        if let Some(turn) = self.turn_shown() {
            let label: SharedString = if turn.prompt().is_empty() {
                copy::UNTITLED_TURN.get(cx).into()
            } else {
                turn.prompt().clone()
            };
            return div()
                .id("review-turn-label")
                .test_support()
                .aria_label(label.clone())
                .flex_1()
                .min_w_0()
                .pl_1()
                .truncate()
                .text_sm()
                .font_semibold()
                .text_color(maka.ink)
                .child(label)
                .into_any_element();
        }
        let Some(branches) = self.branches.as_ref().filter(|b| !b.base_branch_options.is_empty())
        else {
            return div()
                .flex_1()
                .min_w_0()
                .pl_1()
                .truncate()
                .text_sm()
                .font_semibold()
                .text_color(maka.ink)
                .child(copy::CHANGES.get(cx))
                .into_any_element();
        };
        let label = copy::BASE_BRANCH.get(cx);
        h_flex()
            .id("review-branches")
            .test_support()
            .flex_1()
            .min_w_0()
            .gap_1()
            .text_xs()
            .text_color(maka.ink_muted)
            .child(
                div().min_w_0().flex_shrink(1.).child(
                    Select::new(&self.picker)
                        .id("review-base-branch")
                        .small()
                        .appearance(false)
                        .placeholder(label)
                        .accessibility_label(label)
                        .search_placeholder(shared::copy::settings::SETTINGS_SEARCH.get(cx))
                        .menu_width(rems(17.5))
                        .menu_max_h(rems(18.))
                        .disabled(self.switching),
                ),
            )
            .when_some(branches.current_branch.clone(), |this, current| {
                this.child(
                    Icon::new(AssetIcon::ArrowRight)
                        .size_3p5()
                        .flex_shrink_0()
                        .text_color(maka.ink_muted),
                )
                .child(
                    div()
                        .id("review-current-branch")
                        .test_support()
                        .aria_label(current.clone())
                        .min_w_0()
                        .flex_shrink(1.)
                        .pl_1()
                        .truncate()
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_color(maka.ink)
                        .child(current),
                )
            })
            .into_any_element()
    }

    /// The tree's column: the tree, then the scopes and the commits under
    /// it. Beside the diff the column reaches the plate's bottom, where its
    /// lists stop the plate's radius short of the edge, outside their
    /// scrolling, so no row reaches into the plate's bottom corner at any
    /// scroll.
    fn render_left(&self, wide: bool, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .id("review-left")
            .test_support()
            .size_full()
            .min_h_0()
            .when(wide, |this| this.pb(RADIUS_MODAL))
            .child(div().flex_1().min_h(rems(ROW_REMS * 2.)).child(self.render_tree(window, cx)))
            .when(self.scopes_height() > 0., |this| this.child(self.render_scopes(cx)))
            .into_any_element()
    }

    /// Every changed file in its folders, one row each, in a list that
    /// draws only the rows in view; the tree is one Tab stop.
    fn render_tree(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let keyboard = self.files_focus.is_focused(window) && window.last_input_was_keyboard();
        let rows: Rc<[TreeNode]> = self.tree.visible(&self.folded).into();
        let cursor = self
            .cursor_ix(&rows)
            .map(|ix| rows[ix].key())
            .or_else(|| self.selected.clone().map(TreeKey::File));
        let context = RowContext {
            rows: rows.clone(),
            folded: Rc::new(self.folded.clone()),
            selected: self.selected.clone(),
            cursor,
            keyboard,
            deletions: self.tree.has_deletions(),
            focus: self.files_focus.clone(),
            panel: cx.entity().downgrade(),
        };
        div()
            .id("review-files")
            .test_support()
            .role(Role::Tree)
            .aria_label(copy::FILES.get(cx))
            .track_focus(&self.files_focus)
            .key_context(FILES_CONTEXT)
            .on_action(cx.listener(|this, _: &NextRow, _, cx| this.move_cursor(1, cx)))
            .on_action(cx.listener(|this, _: &PreviousRow, _, cx| this.move_cursor(-1, cx)))
            .on_action(cx.listener(|this, _: &FirstRow, _, cx| this.move_cursor(isize::MIN, cx)))
            .on_action(cx.listener(|this, _: &LastRow, _, cx| this.move_cursor(isize::MAX, cx)))
            .on_action(cx.listener(|this, _: &FoldFolder, _, cx| this.fold_folder(cx)))
            .on_action(cx.listener(|this, _: &UnfoldFolder, _, cx| this.unfold_folder(cx)))
            .on_action(cx.listener(|this, _: &OpenRow, window, cx| this.open_row(window, cx)))
            .relative()
            .size_full()
            .child(
                uniform_list("review-file-rows", rows.len(), move |range, window, cx| {
                    range.map(|ix| context.render(ix, window, cx)).collect::<Vec<_>>()
                })
                .size_full()
                // The rows' fills 8 px in from the plate's sides, their
                // first row level with the diff's box.
                .px_2()
                .pt_2()
                .pb_1()
                .track_scroll(&self.files_scroll),
            )
            .child(Scrollbar::vertical(&self.files_scroll))
            .into_any_element()
    }

    /// The tree's column and the diff on one surface: the column beside
    /// the diff, resizable, where the panel is wide; above it, at most
    /// [`STACKED_LIST_SHARE`] of the height, where it is narrow. The
    /// tree's toggle hides the column. The diff sits in its box 8 px in
    /// from the plate's sides and bottom, and from the column.
    fn render_review(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let rem = window.rem_size();
        let diff = div().size_full().min_w_0().min_h_0().p_2().child(self.render_diff_box(cx));
        let surface = div()
            .id("review-area")
            .test_support()
            .flex_1()
            .min_h_0()
            .w_full()
            .when(self.switching, |this| this.opacity(0.5));
        if !self.tree_visible {
            return surface.child(diff).into_any_element();
        }
        let wide = self.measured.wide.get();
        let left = self.render_left(wide, window, cx);
        if wide {
            surface
                .child(
                    h_resizable("review-columns")
                        .child(
                            resizable_panel()
                                .size(rem * FILE_LIST_REMS)
                                .size_range(rem * FILE_LIST_MIN_REMS..rem * FILE_LIST_MAX_REMS)
                                .child(left),
                        )
                        .child(
                            resizable_panel()
                                .size_range(rem * DIFF_MIN_REMS..rem * 400.)
                                .child(diff),
                        ),
                )
                .into_any_element()
        } else {
            // The column's own height, up to its share: the visible rows,
            // the 8 px above and 4 px below them, and the scopes. The box
            // under it takes the rest, its own 8 px gap above it in place
            // of a divider.
            let rows = self.tree.visible(&self.folded).len();
            let height = rows as f32 * ROW_REMS + 0.75 + self.scopes_height();
            surface
                .child(
                    v_flex()
                        .size_full()
                        .child(
                            div()
                                .w_full()
                                .flex_none()
                                .h(rems(height))
                                .max_h(relative(STACKED_LIST_SHARE))
                                .child(left),
                        )
                        .child(div().flex_1().min_h_0().w_full().child(diff)),
                )
                .into_any_element()
        }
    }

    /// The continuous diff's box, as Desktop's `.maka-session-review-diff`:
    /// a rounded surface in the transcript's code-block fill, the diff 8 px
    /// in at its sides and the box's radius in above and below, outside
    /// the diff's scrolling, so the scroller's clip keeps every row clear
    /// of the box's corners at any scroll.
    fn render_diff_box(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("review-diff-box")
            .test_support()
            .size_full()
            .min_w_0()
            .min_h_0()
            .rounded(RADIUS_SURFACE)
            .bg(cx.maka().code)
            .px_2()
            .py(RADIUS_SURFACE)
            .child(self.render_diff_column(cx))
    }

    /// Every file of the scope in the kit's Diff, one after another: each
    /// under its header (fold chevron, file icon, name, folder, counts),
    /// changed lines with word-level highlights, unchanged runs folded to
    /// three lines around each change for the reader to unfold, long lines
    /// wrapped, line numbers, the code in the palette's syntax colours by the
    /// file's extension. Where a file's diff was cut, a note under its
    /// last shown line gives Desktop's "n more lines not shown" and a Show
    /// all; where Git has lines of a file the diff does not carry, "Show
    /// more lines" at its end.
    fn render_diff_column(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let column =
            v_flex().id("review-diff").test_support().relative().size_full().min_w_0().min_h_0();
        if self.shown.is_empty() {
            let listed = self.source().map(|_| self.file_count());
            let reading = listed.is_some_and(|files| files > 0) && self.is_loading();
            let empty = listed == Some(0) && !self.loading;
            return column
                .when(reading, |this| this.child(loading_state()))
                .when(empty, |this| this.child(empty_state(cx)))
                .into_any_element();
        }
        let mut notes: HashMap<ElementId, Note> = HashMap::new();
        let mut annotations = Vec::new();
        for shown in &self.shown {
            if shown.is_too_large() {
                let id = domain_element_id("review-too-large", &shown.diff_path);
                annotations.push(DiffAnnotation::file(id.clone(), shown.diff_path.clone()));
                notes.insert(id, Note::TooLarge { path: shown.path().clone() });
            } else if shown.hidden_lines > 0
                && let Some((side, line)) = shown.last_line
            {
                let id = domain_element_id("review-hidden-lines", &shown.diff_path);
                let at =
                    DiffLinePosition::new(shown.diff_path.clone(), diff_side(side), line as usize);
                annotations.push(DiffAnnotation::line(id.clone(), at));
                let text = copy::hidden_lines(locale, shown.hidden_lines).into();
                notes.insert(id, Note::Cut { path: shown.path().clone(), text });
            } else if let Some((side, line)) = shown.more_at {
                let id = domain_element_id("review-more-lines", &shown.diff_path);
                let at =
                    DiffLinePosition::new(shown.diff_path.clone(), diff_side(side), line as usize);
                annotations.push(DiffAnnotation::line(id.clone(), at));
                let loading = self.reading_more.as_ref() == Some(shown.path());
                notes.insert(id, Note::More { path: shown.path().clone(), loading });
            }
        }
        let notes = Rc::new(notes);
        let show_all: SharedString = copy::SHOW_ALL.get(cx).into();
        let show_more: SharedString = copy::SHOW_MORE_LINES.get(cx).into();
        let panel = cx.entity().downgrade();
        let headers = self.headers.clone();
        let marks = self.marks.clone();
        let diff = Diff::new(&self.diff)
            .soft_wrap(true)
            .line_number(true)
            .hunk_separator(DiffHunkSeparator::Simple)
            .render_header(move |file, _, cx| {
                let id = domain_element_id("review-file-header", file.path());
                render_header(file, headers.get(file.path()), Some(&marks), id, cx)
            })
            .annotations(annotations)
            .render_annotation(move |annotation, _, cx| {
                render_note(notes.get(annotation.id()), &panel, &show_all, &show_more, cx)
            })
            .flex_1()
            .min_h_0()
            .w_full()
            .border_0()
            .bg(maka.code);
        column
            .child(diff)
            .child(self.refit.probe(&self.diff))
            .child(self.split_probe(cx))
            .child(self.marks.probe(self.diff_order.clone(), cx.entity().downgrade()))
            .children(self.render_sticky_header(cx))
            .into_any_element()
    }

    /// The diff's sticky header, as GitHub's: over the top of the diff, a
    /// copy of the header of the file at the top (the rule the tree's
    /// highlight follows, without its pin on a file just chosen), drawn
    /// while that file's own header is above the diff's top and gone once
    /// any of it is in view ([`StickyHeader`]). The kit's header row around
    /// the same content, in the box's fill with a hairline under it; its
    /// chevron folds the file as the header's own does.
    fn render_sticky_header(&self, cx: &mut Context<Self>) -> Option<StickyHeader> {
        let maka = cx.maka();
        let sticky = self.marks.sticky()?;
        let shown = self.shown.get(sticky.file)?;
        let path = shown.diff_path.clone();
        let folded = self.diff.read(cx).is_file_collapsed(&path);
        let name = self.headers.get(&path).map_or_else(|| path.clone(), |h| h.file.name.clone());
        let label = copy::fold_file(Locale::current(cx), &name, folded);
        let content = render_header(
            &shown.file,
            self.headers.get(&path),
            None,
            "review-sticky-file".into(),
            cx,
        );
        let panel = cx.entity().downgrade();
        let header = div()
            .id("review-sticky-header")
            .test_support()
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .block_mouse_except_scroll()
            .bg(maka.code)
            .border_b_1()
            .border_color(maka.border)
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .pl_1()
                    .pr_3()
                    .py_1()
                    .gap_1()
                    .child(
                        Button::new("review-sticky-fold")
                            .ghost()
                            .xsmall()
                            .icon(if folded {
                                IconName::ChevronRight
                            } else {
                                IconName::ChevronDown
                            })
                            .accessibility_label(label)
                            .on_click(move |_, _, cx| {
                                panel
                                    .update(cx, |panel, cx| panel.fold_from_sticky(&path, cx))
                                    .ok();
                            }),
                    )
                    .child(div().flex_1().min_w_0().child(content)),
            );
        Some(StickyHeader::new(header, sticky.file, &self.marks))
    }

    /// The sticky header's chevron: folds the file at `path` (the Diff's)
    /// to its header, which then shows at the top, as a fold from the
    /// header's own chevron leaves it in view; or unfolds it, unless it is
    /// too large to show.
    fn fold_from_sticky(&mut self, path: &SharedString, cx: &mut Context<Self>) {
        let too_large =
            self.shown.iter().any(|shown| &shown.diff_path == path && shown.is_too_large());
        self.diff.update(cx, |diff, cx| {
            let folded = diff.is_file_collapsed(path);
            if folded && too_large {
                return;
            }
            diff.set_file_collapsed(path, !folded, cx);
            diff.scroll_to_file(path, cx);
        });
        cx.notify();
    }

    /// Measures the diff's column each frame and opens the diff split or
    /// unified as it crosses [`SPLIT_DIFF_REMS`].
    fn split_probe(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let measured = self.measured.clone();
        let panel = cx.entity().downgrade();
        canvas(
            move |bounds, window, cx| {
                let split = bounds.size.width >= window.rem_size() * SPLIT_DIFF_REMS;
                if measured.split.replace(Some(split)) != Some(split) {
                    let panel = panel.clone();
                    cx.defer(move |cx| {
                        panel.update(cx, |panel, cx| panel.follow_diff_width(split, cx)).ok();
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// Measures the panel's width each frame and draws the panel again when
    /// it crosses [`WIDE_LAYOUT_REMS`].
    fn width_probe(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let measured = self.measured.clone();
        let panel = cx.entity().downgrade();
        canvas(
            move |bounds, window, cx| {
                let wide = bounds.size.width >= window.rem_size() * WIDE_LAYOUT_REMS;
                if measured.wide.replace(wide) != wide {
                    let panel = panel.clone();
                    cx.defer(move |cx| {
                        panel.update(cx, |_, cx| cx.notify()).ok();
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// What an annotation under a file's line, or its header, says.
#[derive(Debug, Clone)]
enum Note {
    /// The diff was cut here: how many lines are left out, and Show all.
    Cut { path: SharedString, text: SharedString },
    /// Git has lines of the file the diff does not carry: Show more lines.
    More { path: SharedString, loading: bool },
    /// Under the header of a file whose patch is too large to hold.
    TooLarge { path: SharedString },
}

/// A file's header, after the Diff's fold chevron: the file's icon, its
/// name, its folder muted, how it changed (when not a modification), and
/// the lines it adds and deletes (an untracked file's size when too large
/// to read); with the probe that tells the tree where the header is. One of
/// a turn's edits shown one after another says which it is, and its own
/// lines.
fn render_header(
    file: &DiffFile,
    header: Option<&Header>,
    marks: Option<&Rc<HeaderMarks>>,
    id: ElementId,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let info = header.map(|header| &header.file);
    let step = header.filter(|header| header.file.stepwise).map(|header| header.step);
    let mark = step.map(|step| {
        let (n, total) = step.unwrap_or((1, 1));
        copy::step_mark(locale, n, total)
    });
    // A step's own lines, from its diff; the file's otherwise.
    let counts = match (info, step) {
        (Some(info), Some(_)) => {
            let (added, deleted) = (file.additions() as u32, file.deletions() as u32);
            let mut info = info.clone();
            (info.additions, info.deletions, info.unread_size) = (added, deleted, None);
            Some(info)
        }
        (info, None) => info.cloned(),
        (None, Some(_)) => None,
    };
    let (name, folder) = match info {
        Some(info) => (info.name.clone(), info.folder.clone()),
        None => (file.path().clone(), SharedString::default()),
    };
    let status = info
        .map(|info| info.status)
        .filter(|status| !matches!(status, FileStatus::Modified | FileStatus::Unknown));
    h_flex()
        .id(id)
        .test_support()
        .aria_label(file.path().clone())
        .relative()
        .w_full()
        .min_w_0()
        .gap_2()
        .child(Icon::new(AssetIcon::File).size_4().flex_none().text_color(maka.ink_muted))
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .gap_2()
                .child(
                    div()
                        .flex_none()
                        .max_w(relative(0.7))
                        .truncate()
                        .text_sm()
                        .font_medium()
                        .text_color(maka.ink)
                        .child(name),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .text_color(maka.ink_muted)
                        .child(folder),
                ),
        )
        .when_some(mark, |this, mark| {
            this.child(
                div()
                    .id(domain_element_id("review-step-mark", file.path()))
                    .test_support()
                    .aria_label(mark.clone())
                    .flex_none()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(mark),
            )
        })
        .when_some(status, |this, status| {
            this.child(
                div()
                    .flex_none()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(status_word(status).get(cx)),
            )
        })
        .when_some(counts, |this, info| {
            this.child(
                div()
                    .id(domain_element_id("review-header-counts", file.path()))
                    .test_support()
                    .aria_label(counts_label(&info, locale))
                    .flex_none()
                    .child(file_counts(&info, true, cx)),
            )
        })
        .children(marks.map(|marks| header_probe(marks, file.path().clone())))
        .into_any_element()
}

/// The content of an annotation under a file's line.
fn render_note(
    note: Option<&Note>,
    panel: &WeakEntity<ReviewPanel>,
    show_all: &SharedString,
    show_more: &SharedString,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let row = h_flex().gap_2().text_xs().text_color(maka.ink_muted);
    match note {
        Some(Note::Cut { path, text }) => {
            let (panel, path) = (panel.clone(), path.clone());
            row.id(domain_element_id("review-cut", &path))
                .test_support()
                .aria_label(text.clone())
                .child(text.clone())
                .child(
                    Button::new("review-show-all")
                        .ghost()
                        .xsmall()
                        .label(show_all.clone())
                        .on_click(move |_, _, cx| {
                            panel.update(cx, |panel, cx| panel.show_whole_file(&path, cx)).ok();
                        }),
                )
                .into_any_element()
        }
        Some(Note::More { path, loading }) => {
            let (panel, path) = (panel.clone(), path.clone());
            row.child(
                Button::new(domain_element_id("review-show-more", &path))
                    .ghost()
                    .xsmall()
                    .icon(Icon::new(AssetIcon::ChevronsUpDown))
                    .label(show_more.clone())
                    .loading(*loading)
                    .disabled(*loading)
                    .on_click(move |_, _, cx| {
                        panel.update(cx, |panel, cx| panel.show_more_lines(&path, cx)).ok();
                    }),
            )
            .into_any_element()
        }
        Some(Note::TooLarge { path }) => {
            let text = copy::TOO_LARGE.get(cx);
            row.id(domain_element_id("review-too-large-note", path))
                .test_support()
                .aria_label(text)
                .child(text)
                .into_any_element()
        }
        None => div().into_any_element(),
    }
}

/// A turn's changed files as the tree shows them: each with how the turn
/// left it and its lines, marked when its edits show one after another.
fn turn_tree(turn: &TurnChange) -> FileTree {
    let files: Vec<ReviewFile> = turn
        .files()
        .iter()
        .map(|file| {
            let (additions, deletions) = file.counts().unwrap_or_default();
            ReviewFile {
                path: file.path().to_string(),
                previous_path: None,
                status: match file.kind() {
                    ChangeKind::Created => FileStatus::Added,
                    ChangeKind::Deleted => FileStatus::Deleted,
                    _ => FileStatus::Modified,
                },
                additions,
                deletions,
                binary: false,
                unread_size: None,
                origin: Origin::Compared(Vec::new()),
            }
        })
        .collect();
    let mut tree = FileTree::new(&files);
    let paths = |pick: fn(&crate::turns::FileChange) -> bool| -> HashSet<SharedString> {
        turn.files().iter().filter(|file| pick(file)).map(|file| file.path().clone()).collect()
    };
    tree.mark_turn_files(&paths(|file| file.is_stepwise()), &paths(|file| file.counts().is_none()));
    tree
}

/// The Diff's side for the unified reader's.
fn diff_side(side: UnifiedSide) -> DiffSide {
    match side {
        UnifiedSide::Old => DiffSide::Original,
        UnifiedSide::New => DiffSide::Modified,
    }
}

/// The wall clock, for the commits' times: read once per read, never in
/// `render`.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// Desktop's empty state: the branch icon, the title, and the line under
/// it.
fn empty_state(cx: &App) -> AnyElement {
    let maka = cx.maka();
    let title = copy::EMPTY.get(cx);
    v_flex()
        .id("review-empty")
        .test_support()
        .aria_label(title)
        .w_full()
        .items_center()
        .py_8()
        .px_4()
        .gap_2()
        .child(Icon::new(AssetIcon::GitBranch).size_6().text_color(maka.ink_muted))
        .child(div().text_sm().font_medium().text_color(maka.ink).child(title))
        .child(
            div()
                .max_w(rems(20.))
                .text_center()
                .text_xs()
                .text_color(maka.ink_muted)
                .child(copy::EMPTY_HELP.get(cx)),
        )
        .into_any_element()
}

/// The placeholder while the first read runs: four lines for files.
fn loading_state() -> AnyElement {
    v_flex()
        .id("review-loading")
        .test_support()
        .p_4()
        .gap_2()
        .child(Skeleton::new().w(relative(0.42)).h_4())
        .children((0..4).map(|_| Skeleton::new().w_full().h_9()))
        .into_any_element()
}

impl Render for ReviewPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_scope_sizes(window.rem_size());
        let maka = cx.maka();
        let failure = self.failure_text();
        let reading = self
            .reading
            .filter(|reading| reading.total > 0)
            .map(|reading| copy::reading_changes(Locale::current(cx), reading.done, reading.total));
        let retry = copy::RETRY.get(cx);
        let notices = v_flex()
            .flex_none()
            .px_4()
            .gap_2()
            .when(failure.is_some() || reading.is_some(), |this| this.py_3())
            .when_some(failure, |this, failure| {
                this.child(
                    StatusLine::error("review-failure", failure.get(cx)).centred().action(
                        Button::new("review-retry")
                            .ghost()
                            .small()
                            .label(retry)
                            .loading(self.loading)
                            .disabled(self.loading)
                            .on_click(cx.listener(|this, _, window, cx| this.refresh(window, cx))),
                    ),
                )
            })
            .when_some(reading, |this, reading| {
                this.child(StatusLine::info("review-reading", reading))
            });
        v_flex()
            .id("review-panel")
            .test_support()
            .role(Role::Region)
            .aria_label(copy::PANEL_LABEL.get(cx))
            .key_context(PANEL_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &NextFile, _, cx| this.move_file(1, cx)))
            .on_action(cx.listener(|this, _: &PreviousFile, _, cx| this.move_file(-1, cx)))
            .on_action(cx.listener(|this, _: &NextChange, _, cx| {
                this.diff.update(cx, |diff, cx| diff.next_change(cx));
            }))
            .on_action(cx.listener(|this, _: &PreviousChange, _, cx| {
                this.diff.update(cx, |diff, cx| diff.previous_change(cx));
            }))
            .on_action(cx.listener(Self::focus_diff))
            .on_action(cx.listener(Self::restore_split))
            .relative()
            .size_full()
            .min_w_0()
            // A plate wherever it sits: beside the conversation, below it,
            // or in its place. Nothing in it reaches into the corners (GPUI
            // clips no child to a radius): the bar's controls and the rows
            // stay inside, and the diff scrolls in its own box.
            .rounded(RADIUS_MODAL)
            .bg(maka.plate)
            .text_color(maka.ink)
            .child(self.render_bar(cx))
            .child(notices)
            .when(self.loading && self.read.is_none() && self.source().is_none(), |this| {
                this.child(loading_state())
            })
            // Where Git cannot show the folder's changes, the turns being
            // read show in the scopes before any is listed.
            .when(
                self.source().is_some() || (self.reading_turns && self.git_unavailable()),
                |this| this.child(self.render_review(window, cx)),
            )
            .child(self.width_probe(cx))
    }
}
