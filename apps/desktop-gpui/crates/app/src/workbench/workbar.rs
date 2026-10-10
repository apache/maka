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

//! The workbar: the panel of tools beside the plate, Maka Desktop's task
//! workbar (`features/workbar`), for the selected task. It holds faces:
//! the changes ([`review::ReviewPanel`]), the task's files
//! ([`files::FilesView`]), the task's trace ([`inspector::InspectorView`],
//! Desktop's Inspector), the task's side chats
//! ([`conversation::SideChatPanel`], see [`super::side_chats`]) and the
//! task's terminals ([`terminal::TerminalView`]), one shown at a time under
//! a strip of tabs.
//!
//! The shell is here: the registry of tools ([`TOOLS`], Desktop's
//! `WORKBAR_TOOL_DEFINITIONS`), the strip (a tab per open face, the [+]
//! menu of every tool, maximize and close), where the panel goes, and what
//! each task remembers. The faces are entities of their own and keep their
//! state whether shown or not; the changes' key contexts stay on its own
//! root, and a terminal face is drawn beside it, never inside it.
//!
//! Like Desktop's workbar it is open or closed per task, remembered with
//! its width and, per task, the face it shows and whether its Changes,
//! Files and Trace faces are open; terminals are the Host's, read from its inventory when a task
//! is selected, never from these preferences (a task whose remembered face
//! is a terminal shows its first live one). On a window with room it is its
//! own plate on the right, `width` wide (Desktop's 480 at first, from 340,
//! scaling with the UI font as the sidebar does), with a handle on its edge
//! that drags it as wide as leaves the conversation its least width,
//! Desktop's 400 px (`--maka-conversation-min-width`), which keeps the
//! composer's controls on one row and the transcript readable. When the
//! window cannot keep the composer's whole column beside the panel's
//! narrowest width, the panel goes below the plate, as Desktop's goes below
//! the conversation on a narrow window, 42% of the window's height up to
//! 360 px, with no handle.
//!
//! The changes work out what each turn of the task edited
//! ([`review::turns`]): the window hands them the session's edits as the
//! transcript moves on, and hands the conversation what they worked out for
//! the card under each settled turn, whose buttons open the panel on the
//! turn. While the changes show, the conversation reads the task's whole
//! history in the background, so they list every turn.
//!
//! Maximized (the strip's button, or ⇧Esc), the panel fills the plate below
//! the plate's header in the conversation's and the composer's place, which
//! keep their state, not drawn; the button or ⇧Esc (Esc in the changes)
//! give them their place back. Each task remembers it.
//!
//! The terminals' output streams in while the panel shows, whichever face
//! it shows, so their tabs keep their titles and bells; they hold their
//! controllers only while their face shows, leaving them to another window
//! or Maka Desktop meanwhile. Hidden, they let both go and their shells run
//! on. The files are read while their face shows and polled while it
//! stays, as Desktop's are; a settled turn and a subagent's writeback read
//! them again. The trace is read while its face shows and refreshed from
//! the task's own signals while it stays.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::rc::Rc;
use std::sync::Arc;

use conversation::{ConversationEvent, ConversationViewEvent};
use files::{FilesView, FilesViewEvent};
use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    Icon, Selectable as _, Sizable as _, StyledExt as _, ThemeStyled as _, h_flex, v_flex,
};
use gpui_kit::{
    Action, AnyElement, App, AppContext as _, ClickEvent, Context, DragMoveEvent, Empty, Entity,
    FocusHandle, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render,
    Role, SharedString, StatefulInteractiveElement as _, Styled as _, Task, TestSupportExt as _,
    TextRun, Window, canvas, div, prelude::FluentBuilder as _, px, rems,
};
use inspector::{InspectorView, InspectorViewEvent};
use review::git::{ReviewScope, SystemGit};
use review::{ReviewPanel, ReviewPanelEvent, ReviewTarget, ToggleMaximized};
use session::LoadState;
use settings::{
    AppPreferences, DEFAULT_REVIEW_WIDTH, REVIEW_WIDTHS, WorkbarFace, clamp_review_width,
};
use shared::copy::side_chat as side_chat_copy;
use shared::copy::{
    self as shell_copy, Locale, Text, files as files_copy, inspector as inspector_copy,
    review as review_copy, terminal as terminal_copy, workbar as copy,
};
use shared::domain_element_id;
use shared::icons::{MakaIcon, ink};
use shared::layout::{ICON_BUTTON_REMS, ICON_GLYPH_REMS, PLATE_LINE_REMS, ink_padding};
use shared::menu::{MenuEntry, MenuItem, MenuPlacement, MenuSlot};
use shared::theme::{
    ActiveMakaPalette as _, BODY_TEXT_REMS, RADIUS_CONTROL, RADIUS_MODAL, selectable_row,
};
use terminal::{
    CloseState, TerminalTab, TerminalView, TerminalViewEvent, Terminals, TerminalsShown,
};
use transcript_model::edits::{EditsKey, session_edits};
use workspace::HostSession;
use workspace::actions::{ToggleFiles, ToggleReview, ToggleSideChat, ToggleTerminal};

use super::side_chats::{SideChatTab, SideChats};
use super::{
    DESIGN_PX_PER_REM, PLATE_INSET_REMS, PLATE_MIN_REMS, RESIZE_HANDLE_WIDTH, RESIZE_LARGE_STEP,
    RESIZE_STEP, WIDTH_SAVE_DELAY, Workbench,
};

/// Key context of the workbar's edge while it has focus.
pub const WORKBAR_RESIZE_CONTEXT: &str = "WorkbarResize";

gpui_kit::actions!(
    maka_workbar,
    [
        /// Move the workbar's edge 10 px toward the plate.
        WidenWorkbarStep,
        /// Move the workbar's edge 10 px away from the plate.
        NarrowWorkbarStep,
        /// Move the workbar's edge 50 px toward the plate.
        WidenWorkbarLargeStep,
        /// Move the workbar's edge 50 px away from the plate.
        NarrowWorkbarLargeStep,
        /// Give the workbar its default width.
        ResetWorkbarWidth,
    ]
);

/// The least the plate keeps beside the panel when the panel is dragged
/// wide: Desktop's `--maka-conversation-min-width`, 400 px, and the canvas
/// margin on either side of the plate (as in `PLATE_MIN_REMS`).
const PLATE_LEAST_REMS: f32 = 400. / DESIGN_PX_PER_REM + 2. * PLATE_INSET_REMS;

/// The height of the panel below the plate: Desktop's `min(42dvh, 360px)`.
const BELOW_HEIGHT_SHARE: f32 = 0.42;
const BELOW_MAX_HEIGHT_REMS: f32 = 360. / DESIGN_PX_PER_REM;

/// The strip's height, as the changes' own bar under it.
const STRIP_HEIGHT_REMS: f32 = 3.;

/// A tab's parts, for working out whether the strip holds every label:
/// its fill's padding before the icon and after the ×, the icon, the gaps
/// between the parts, a mark, and the × button.
const TAB_LEADING_REMS: f32 = 0.5;
const TAB_TRAILING_REMS: f32 = 0.125;
const TAB_ICON_REMS: f32 = 1.;
const TAB_GAP_REMS: f32 = 0.25;
const TAB_MARK_REMS: f32 = 0.75;
const TAB_CLOSE_REMS: f32 = 1.25;
/// The gap between tabs.
const TABS_GAP_REMS: f32 = 0.125;
/// A label's widest: a long title ends in an ellipsis there (the whole of
/// it in the tab's accessible name).
const TAB_LABEL_MAX_REMS: f32 = 12.;
/// The [+] menu's least width.
const ADD_MENU_WIDTH_REMS: f32 = 14.;

/// One of the workbar's tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolKind {
    Changes,
    Files,
    Inspector,
    SideChat,
    Terminal,
}

/// A tool as the registry defines it (Desktop's `WorkbarToolDefinition`):
/// the strip, the [+] menu, the shortcuts and the preferences all read it.
#[derive(Clone, Copy)]
pub(crate) struct ToolDefinition {
    pub(crate) kind: ToolKind,
    pub(crate) label: Text,
    pub(crate) icon: MakaIcon,
    /// The action of its shortcut, which the [+] menu shows; none for a
    /// tool Desktop gives none.
    pub(crate) shortcut: Option<fn() -> Box<dyn Action>>,
    /// Whether a task remembers its face being open.
    pub(crate) persisted: bool,
    /// One face (choosing it in [+] opens or closes it), or several
    /// (choosing it adds another).
    pub(crate) singleton: bool,
}

/// Every tool, in the order the [+] menu lists them and the strip shows
/// their faces.
pub(crate) const TOOLS: [ToolDefinition; 5] = [
    ToolDefinition {
        kind: ToolKind::Changes,
        label: review_copy::CHANGES,
        icon: MakaIcon::FileDiff,
        shortcut: Some(|| Box::new(ToggleReview)),
        persisted: true,
        singleton: true,
    },
    ToolDefinition {
        kind: ToolKind::Files,
        label: files_copy::FILES,
        icon: MakaIcon::Folder,
        shortcut: Some(|| Box::new(ToggleFiles)),
        persisted: true,
        singleton: true,
    },
    // Desktop's `inspector` tool: persisted, one face, no shortcut, the
    // `activity` glyph.
    ToolDefinition {
        kind: ToolKind::Inspector,
        label: inspector_copy::TRACE,
        icon: MakaIcon::Activity,
        shortcut: None,
        persisted: true,
        singleton: true,
    },
    // Desktop's `side-chat` tool: not persisted, several faces, its
    // `mod+alt+s`, the chat glyph (Desktop's `message-circle-question`).
    // After Trace here, where Desktop lists it first.
    ToolDefinition {
        kind: ToolKind::SideChat,
        label: side_chat_copy::SIDE_CHAT,
        icon: MakaIcon::Chat,
        shortcut: Some(|| Box::new(ToggleSideChat)),
        persisted: false,
        singleton: false,
    },
    ToolDefinition {
        kind: ToolKind::Terminal,
        label: terminal_copy::TERMINAL,
        icon: MakaIcon::ToolTerminal,
        shortcut: Some(|| Box::new(ToggleTerminal)),
        persisted: false,
        singleton: false,
    },
];

fn tool(kind: ToolKind) -> &'static ToolDefinition {
    TOOLS.iter().find(|tool| tool.kind == kind).unwrap_or(&TOOLS[0])
}

/// Where the panel goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum WorkbarPlacement {
    /// On the right of the plate, this many rems wide.
    Beside(f32),
    /// Below the plate, the plate's width.
    Below,
}

impl WorkbarPlacement {
    /// For a window `window_rems` wide whose sidebar column takes
    /// `column_rems`, a panel `width` wide (the preferences' pixels): beside
    /// the plate when its narrowest width leaves the plate the composer's
    /// whole column, at its width up to what leaves the conversation its
    /// least; else below.
    pub(crate) fn of(window_rems: f32, column_rems: f32, width: u16) -> Self {
        let beside = window_rems - column_rems - PLATE_INSET_REMS;
        let narrowest = f32::from(*REVIEW_WIDTHS.start()) / DESIGN_PX_PER_REM;
        if beside - PLATE_MIN_REMS < narrowest {
            return Self::Below;
        }
        Self::Beside((f32::from(width) / DESIGN_PX_PER_REM).min(beside - PLATE_LEAST_REMS))
    }
}

/// What a drag of the panel's edge carries: nothing; its moves set the
/// width.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WorkbarResize;

impl Render for WorkbarResize {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

/// A face the strip shows a tab for.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Face {
    Changes,
    Files,
    Inspector,
    SideChat(SideChatTab),
    Terminal(TerminalTab),
}

impl Face {
    /// Stable within the strip: the tab's element ids derive from it.
    fn key(&self) -> SharedString {
        match self {
            Self::Changes => "changes".into(),
            Self::Files => "files".into(),
            Self::Inspector => "inspector".into(),
            Self::SideChat(tab) => format!("side-chat:{}", tab.id).into(),
            Self::Terminal(tab) => tab.resource_ref.clone(),
        }
    }

    fn kind(&self) -> ToolKind {
        match self {
            Self::Changes => ToolKind::Changes,
            Self::Files => ToolKind::Files,
            Self::Inspector => ToolKind::Inspector,
            Self::SideChat(_) => ToolKind::SideChat,
            Self::Terminal(_) => ToolKind::Terminal,
        }
    }

    fn name(&self, cx: &App) -> SharedString {
        match self {
            Self::Changes => review_copy::CHANGES.get(cx).into(),
            Self::Files => files_copy::FILES.get(cx).into(),
            Self::Inspector => inspector_copy::TRACE.get(cx).into(),
            Self::SideChat(tab) => {
                side_chat_copy::numbered(Locale::current(cx), tab.ordinal).into()
            }
            Self::Terminal(tab) => tab.title.clone(),
        }
    }
}

/// The panel, its faces and what the window keeps about it.
pub(crate) struct Workbar {
    panel: Entity<ReviewPanel>,
    terminals: Entity<Terminals>,
    terminal: Entity<TerminalView>,
    files: Entity<FilesView>,
    inspector: Entity<InspectorView>,
    /// The files the selected task's last turn said a subagent wrote back,
    /// by task and turn: more of them reads the files again.
    artifact_mentions: Option<(String, String, usize)>,
    /// The width in the preferences' pixels, as dragged.
    width: u16,
    resizing: bool,
    /// The edge's handle, a Tab stop.
    resize_focus: FocusHandle,
    /// Whether a turn of the selected task ran at the last commit.
    turn_running: bool,
    add_menu: MenuSlot,
    /// The width the tabs had at the last frame: whether every label fits.
    tabs_width: Rc<Cell<Pixels>>,
    /// Every task's side chats, alive across task switches.
    pub(super) side_chats: SideChats,
    _save_width: Option<Task<()>>,
}

impl Workbar {
    pub(crate) fn new(
        terminals: Entity<Terminals>,
        host: Entity<HostSession>,
        window: &mut Window,
        cx: &mut Context<Workbench>,
    ) -> Self {
        let terminal = cx.new(|cx| TerminalView::new(terminals.clone(), window, cx));
        Self {
            panel: cx.new(|cx| ReviewPanel::new(Arc::new(SystemGit), window, cx)),
            terminals,
            terminal,
            files: cx.new(|cx| FilesView::new(host.clone(), window, cx)),
            inspector: cx.new(|cx| InspectorView::new(host, window, cx)),
            artifact_mentions: None,
            width: AppPreferences::current(cx).review_width,
            resizing: false,
            resize_focus: cx.focus_handle().tab_stop(true).tab_index(1),
            turn_running: false,
            add_menu: MenuSlot::new(MenuPlacement::BelowStart),
            tabs_width: Rc::new(Cell::new(Pixels::ZERO)),
            side_chats: SideChats::default(),
            _save_width: None,
        }
    }
}

impl Workbench {
    /// Follows the faces' requests and what should read the changes again:
    /// the selected task's turn ending, and the window coming back to the
    /// front.
    pub(super) fn watch_workbar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let panel = self.workbar.panel.clone();
        let terminal = self.workbar.terminal.clone();
        let files = self.workbar.files.clone();
        let inspector = self.workbar.inspector.clone();
        let subscriptions = [
            cx.subscribe_in(&panel, window, |this, _, event: &ReviewPanelEvent, window, cx| {
                match event {
                    ReviewPanelEvent::BaseBranchChanged { session_id, base_branch } => {
                        let (id, branch) = (session_id.to_string(), base_branch.clone());
                        AppPreferences::global(cx).update(cx, |preferences, cx| {
                            preferences.set_review_base_branch(&id, branch.clone(), cx);
                        });
                        // The strip counts against the same base: from the
                        // panel's next read of All changes, or its own.
                        let summary = this.strip.summary.clone();
                        summary.update(cx, |summary, _| summary.set_base_branch(branch));
                        if !this.review_feeds_strip(cx) {
                            summary.update(cx, |summary, cx| summary.refresh(cx));
                        }
                    }
                    ReviewPanelEvent::ChangesRead { session_id, totals } => {
                        let (id, totals) = (session_id.clone(), totals.clone());
                        this.strip
                            .summary
                            .update(cx, |summary, cx| summary.accept(&id, totals, cx));
                    }
                    ReviewPanelEvent::MaximizeRequested(maximized) => {
                        this.set_workbar_maximized(*maximized, window, cx);
                    }
                    _ => {}
                }
            }),
            cx.subscribe_in(&terminal, window, |this, _, event: &TerminalViewEvent, window, cx| {
                match event {
                    // A terminal this window started: its face shows, with
                    // the focus.
                    TerminalViewEvent::Started => {
                        if this.catalog.read(cx).selected_id().is_some() {
                            this.set_workbar_face(ToolKind::Terminal, cx);
                            this.set_workbar_open(true, window, cx);
                            this.workbar.terminal.update(cx, |view, cx| view.focus(window, cx));
                        }
                    }
                    TerminalViewEvent::TabsChanged => {
                        this.hide_empty_workbar(window, cx);
                        cx.notify();
                    }
                    _ => {}
                }
            }),
            cx.subscribe_in(
                &self.state.clone(),
                window,
                |this, state, _: &ConversationEvent, window, cx| {
                    this.sync_turn_edits(cx);
                    this.sync_history_reading(cx);
                    let running = !matches!(
                        state.read(cx).turn_activity(),
                        conversation::TurnActivity::Idle | conversation::TurnActivity::Unavailable
                    );
                    let ended =
                        std::mem::replace(&mut this.workbar.turn_running, running) && !running;
                    if ended {
                        this.refresh_review(window, cx);
                        this.workbar.files.update(cx, |files, cx| files.refresh(cx));
                    }
                    this.sync_artifact_mentions(cx);
                },
            ),
            // Escape in the file list gives the conversation its place
            // back: a maximized panel restored, else the panel hidden and
            // the composer focused.
            cx.subscribe_in(&files, window, |this, _, event: &FilesViewEvent, window, cx| {
                if matches!(event, FilesViewEvent::Dismiss) {
                    if this.workbar_maximized(cx) {
                        this.set_workbar_maximized(false, window, cx);
                    } else {
                        this.set_workbar_open(false, window, cx);
                        this.composer.update(cx, |composer, cx| composer.focus(window, cx));
                    }
                }
            }),
            // Escape in the trace does what it does in the file list.
            cx.subscribe_in(
                &inspector,
                window,
                |this, _, event: &InspectorViewEvent, window, cx| {
                    if matches!(event, InspectorViewEvent::Dismiss) {
                        if this.workbar_maximized(cx) {
                            this.set_workbar_maximized(false, window, cx);
                        } else {
                            this.set_workbar_open(false, window, cx);
                            this.composer.update(cx, |composer, cx| composer.focus(window, cx));
                        }
                    }
                },
            ),
            cx.observe(&self.strip.summary.clone(), |_, _, cx| cx.notify()),
            // The card under each settled turn lists what the panel worked
            // out for it.
            cx.observe(&panel.read(cx).turn_changes().clone(), |this, changes, cx| {
                let edited = changes.read(cx).edited_turns();
                this.conversation.update(cx, |view, cx| view.set_edited_turns(edited, cx));
            }),
            cx.subscribe_in(
                &self.conversation.clone(),
                window,
                |this, _, event: &ConversationViewEvent, window, cx| match event {
                    ConversationViewEvent::ShowTurnChanges { turn_id, path } => {
                        this.show_turn_changes(turn_id.clone(), path.clone(), window, cx);
                    }
                    // The transcript's "Ask in side chat": the selection
                    // as the menu opened on it.
                    ConversationViewEvent::AskInSideChat { text, turn_id } => {
                        let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
                        if !folded.is_empty() {
                            this.stage_side_quote(folded, turn_id.clone(), window, cx);
                        }
                    }
                    _ => {}
                },
            ),
            cx.observe_window_activation(window, |this, window, cx| {
                let active = window.is_window_active();
                if active {
                    this.refresh_review(window, cx);
                }
                // The files are polled only while the window is active.
                this.workbar.files.update(cx, |files, cx| files.set_window_active(active, cx));
            }),
            // Desktop's `retain-sessions`: once the catalog is read, the
            // workbar state of tasks it no longer lists goes, and so do the
            // side chats of a deleted task.
            cx.observe(&self.catalog.clone(), |this, catalog, cx| {
                this.retire_side_chats_of_deleted_tasks(cx);
                let catalog = catalog.read(cx);
                if *catalog.load_state() != LoadState::Loaded {
                    return;
                }
                let ids: BTreeSet<String> =
                    catalog.rows().iter().map(|row| row.id.to_string()).collect();
                AppPreferences::global(cx)
                    .update(cx, |preferences, cx| preferences.retain_review_tasks(&ids, cx));
            }),
            // The Terminal group of Settings: Option as Meta and the
            // blinking cursor.
            cx.observe(&AppPreferences::global(cx), |this, preferences, cx| {
                let preferences = preferences.read(cx);
                let option_as_meta = preferences.terminal_option_as_meta();
                let cursor_blink = preferences.terminal_cursor_blink();
                this.workbar.terminal.update(cx, |view, cx| {
                    view.set_option_as_meta(option_as_meta);
                    view.set_cursor_blink(cursor_blink, cx);
                });
            }),
            // Whatever moved the panel or a face in or out of sight (it
            // opened or closed, another face or task, a page or settings
            // over it), the terminals follow, streaming while it shows and
            // attached while their face does, the files, read and polled
            // while their face shows, and the trace, read and refreshed
            // while its face shows.
            cx.observe_self(|this, cx| {
                this.sync_terminals_shown(cx);
                this.sync_files_shown(cx);
                this.sync_inspector_shown(cx);
            }),
        ];
        self._subscriptions.extend(subscriptions);
        // The task's conversation offers "Ask in side chat" on a right-click.
        self.conversation.update(cx, |view, _| view.set_side_chat_menu(true));
        self.watch_side_chat_ledger(cx);
        let preferences = AppPreferences::current(cx);
        terminal.update(cx, |view, cx| {
            view.set_option_as_meta(preferences.terminal_option_as_meta);
            view.set_cursor_blink(preferences.terminal_cursor_blink, cx);
        });
        let active = window.is_window_active();
        self.workbar.files.update(cx, |files, cx| files.set_window_active(active, cx));
        self.sync_review_target(window, cx);
        self.sync_terminals_shown(cx);
        self.sync_files_shown(cx);
        self.sync_inspector_shown(cx);
    }

    /// The changes panel.
    pub fn review_panel(&self) -> &Entity<ReviewPanel> {
        &self.workbar.panel
    }

    /// The terminal face.
    pub fn terminal_view(&self) -> &Entity<TerminalView> {
        &self.workbar.terminal
    }

    /// The window's terminals.
    pub fn terminals(&self) -> &Entity<Terminals> {
        &self.workbar.terminals
    }

    /// The files face.
    pub fn files_view(&self) -> &Entity<FilesView> {
        &self.workbar.files
    }

    /// The trace face.
    pub fn inspector_view(&self) -> &Entity<InspectorView> {
        &self.workbar.inspector
    }

    /// The strip's tabs: each face's key and name, and whether it shows.
    #[cfg(test)]
    pub(crate) fn strip_tabs(&self, cx: &App) -> Vec<(String, String, bool)> {
        let shown = self.shown_face(cx);
        let active = self.workbar.terminal.read(cx).active_ref(cx);
        self.faces(cx)
            .iter()
            .map(|face| {
                let showing = match face {
                    Face::Changes => shown == ToolKind::Changes,
                    Face::Files => shown == ToolKind::Files,
                    Face::Inspector => shown == ToolKind::Inspector,
                    Face::SideChat(tab) => {
                        shown == ToolKind::SideChat
                            && self.shown_side_chat_id(cx).as_ref() == Some(&tab.id)
                    }
                    Face::Terminal(tab) => {
                        shown == ToolKind::Terminal && active.as_ref() == Some(&tab.resource_ref)
                    }
                };
                (face.key().to_string(), face.name(cx).to_string(), showing)
            })
            .collect()
    }

    /// Whether the selected task's workbar is open.
    pub fn workbar_open(&self, cx: &App) -> bool {
        self.catalog
            .read(cx)
            .selected_id()
            .is_some_and(|id| AppPreferences::global(cx).read(cx).is_review_open(id))
    }

    /// Whether the panel shows: open, beside the task view (not settings,
    /// a page, or a blocked Host's screen).
    pub fn workbar_shown(&self, cx: &App) -> bool {
        self.settings.is_none()
            && self.page.is_none()
            && self.host.read(cx).blocker().is_none()
            && self.workbar_open(cx)
    }

    /// The terminals' output streams in while the panel shows, for their
    /// tabs; they take their controllers only while their face shows.
    fn sync_terminals_shown(&mut self, cx: &mut Context<Self>) {
        let shown = if !self.workbar_shown(cx) {
            TerminalsShown::Hidden
        } else if self.shown_face(cx) == ToolKind::Terminal {
            TerminalsShown::Face
        } else {
            TerminalsShown::Tabs
        };
        if self.workbar.terminals.read(cx).shown() != shown {
            self.workbar.terminals.update(cx, |terminals, cx| terminals.set_shown(shown, cx));
        }
    }

    /// The files follow the selected task, and are read and polled while
    /// their face shows.
    fn sync_files_shown(&mut self, cx: &mut Context<Self>) {
        let session = self.selected_task(cx);
        let shown = self.workbar_shown(cx) && self.shown_face(cx) == ToolKind::Files;
        self.workbar.files.update(cx, |files, cx| {
            files.set_session(session, cx);
            files.set_shown(shown, cx);
        });
    }

    /// The trace follows the selected task, and is read and refreshed while
    /// its face shows.
    fn sync_inspector_shown(&mut self, cx: &mut Context<Self>) {
        let session = self.selected_task(cx);
        let shown = self.workbar_shown(cx) && self.shown_face(cx) == ToolKind::Inspector;
        self.workbar.inspector.update(cx, |inspector, cx| inspector.follow(session, shown, cx));
    }

    /// Reads the files again when the selected task's last turn says a
    /// subagent wrote more back (`subagent` and `agent_swarm` results'
    /// `artifactIds`): writebacks land while the turn runs.
    fn sync_artifact_mentions(&mut self, cx: &mut Context<Self>) {
        let (session, turn, count) = {
            let state = self.state.read(cx);
            let Some(transcript) = state.transcript() else { return };
            let Some(turn) = transcript.turns().last() else { return };
            (
                transcript.session_id().to_owned(),
                turn.turn_id.clone(),
                files::policy::artifact_mentions(turn),
            )
        };
        let previous =
            self.workbar.artifact_mentions.replace((session.clone(), turn.clone(), count));
        let more =
            match previous {
                Some((was_session, was_turn, was)) if was_session == session => {
                    if was_turn == turn { count > was } else { count > 0 }
                }
                _ => false,
            };
        if more {
            self.workbar.files.update(cx, |files, cx| files.refresh(cx));
        }
    }

    /// The panel's width in the preferences' pixels.
    pub fn workbar_width(&self) -> u16 {
        self.workbar.width
    }

    /// Where the panel goes in this window.
    pub(super) fn workbar_placement(&self, cx: &App) -> WorkbarPlacement {
        let column = self.form_rems(self.shown_form, cx);
        WorkbarPlacement::of(self.window_rems, column, self.workbar.width)
    }

    // The faces.

    pub(super) fn selected_task(&self, cx: &App) -> Option<SharedString> {
        self.catalog.read(cx).selected_id().cloned()
    }

    /// Whether the selected task's Changes face is open.
    fn changes_face_open(&self, cx: &App) -> bool {
        self.selected_task(cx)
            .is_some_and(|id| AppPreferences::global(cx).read(cx).is_changes_face_open(&id))
    }

    /// Whether the selected task's Files face is open.
    fn files_face_open(&self, cx: &App) -> bool {
        self.selected_task(cx)
            .is_some_and(|id| AppPreferences::global(cx).read(cx).is_files_face_open(&id))
    }

    /// Whether the selected task's Trace face is open.
    fn inspector_face_open(&self, cx: &App) -> bool {
        self.selected_task(cx)
            .is_some_and(|id| AppPreferences::global(cx).read(cx).is_inspector_face_open(&id))
    }

    /// The faces the strip shows a tab for, in the registry's order (each
    /// tool's faces in the order they opened).
    fn faces(&self, cx: &App) -> Vec<Face> {
        let mut faces = Vec::new();
        for tool in &TOOLS {
            match tool.kind {
                ToolKind::Changes if self.changes_face_open(cx) => faces.push(Face::Changes),
                ToolKind::Files if self.files_face_open(cx) => faces.push(Face::Files),
                ToolKind::Inspector if self.inspector_face_open(cx) => {
                    faces.push(Face::Inspector);
                }
                ToolKind::SideChat => faces.extend(
                    self.selected_task(cx)
                        .map(|task| self.workbar.side_chats.tabs_of(&task, cx))
                        .unwrap_or_default()
                        .into_iter()
                        .map(Face::SideChat),
                ),
                ToolKind::Terminal => faces.extend(
                    self.workbar.terminal.read(cx).tabs(cx).into_iter().map(Face::Terminal),
                ),
                _ => {}
            }
        }
        faces
    }

    /// Whether the terminal face has anything to show: a terminal, or the
    /// task's terminals being read, a start under way or refused.
    fn terminal_face_open(&self, cx: &App) -> bool {
        let view = self.workbar.terminal.read(cx);
        view.has_terminals(cx) || view.has_pending_state(cx)
    }

    /// The face the panel shows: the one the task remembers while it has
    /// something to show (the terminal face too while no other is open),
    /// else the first open one in the registry's order.
    pub(crate) fn shown_face(&self, cx: &App) -> ToolKind {
        let changes = self.changes_face_open(cx);
        let files = self.files_face_open(cx);
        let inspector = self.inspector_face_open(cx);
        let side_chat = self.side_chat_face_open(cx);
        let remembered = match self
            .selected_task(cx)
            .map(|id| AppPreferences::global(cx).read(cx).workbar_face(&id))
            .unwrap_or_default()
        {
            WorkbarFace::Changes => ToolKind::Changes,
            WorkbarFace::Files => ToolKind::Files,
            WorkbarFace::Inspector => ToolKind::Inspector,
            WorkbarFace::SideChat => ToolKind::SideChat,
            _ => ToolKind::Terminal,
        };
        let open = match remembered {
            ToolKind::Changes => changes,
            ToolKind::Files => files,
            ToolKind::Inspector => inspector,
            ToolKind::SideChat => side_chat,
            ToolKind::Terminal => {
                self.terminal_face_open(cx) || (!changes && !files && !inspector && !side_chat)
            }
        };
        if open {
            remembered
        } else if changes {
            ToolKind::Changes
        } else if files {
            ToolKind::Files
        } else if inspector {
            ToolKind::Inspector
        } else if side_chat {
            ToolKind::SideChat
        } else {
            ToolKind::Terminal
        }
    }

    /// Remembers which face the selected task's panel shows.
    pub(super) fn set_workbar_face(&mut self, kind: ToolKind, cx: &mut Context<Self>) {
        let Some(id) = self.selected_task(cx) else { return };
        let face = match kind {
            ToolKind::Changes => WorkbarFace::Changes,
            ToolKind::Files => WorkbarFace::Files,
            ToolKind::Inspector => WorkbarFace::Inspector,
            ToolKind::SideChat => WorkbarFace::SideChat,
            ToolKind::Terminal => WorkbarFace::Terminal,
        };
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_workbar_face(&id, face, cx));
        // The whole history is read only while the changes show.
        self.sync_history_reading(cx);
        cx.notify();
    }

    /// Opens or closes the selected task's Changes face; only a persisted
    /// tool's face is remembered.
    fn set_changes_face_open(&mut self, open: bool, cx: &mut Context<Self>) {
        let Some(id) = self.selected_task(cx) else { return };
        if tool(ToolKind::Changes).persisted {
            AppPreferences::global(cx)
                .update(cx, |preferences, cx| preferences.set_changes_face_open(&id, open, cx));
        }
        cx.notify();
    }

    /// Opens or closes the selected task's Files face, remembered for the
    /// task (a persisted tool).
    fn set_files_face_open(&mut self, open: bool, cx: &mut Context<Self>) {
        let Some(id) = self.selected_task(cx) else { return };
        if tool(ToolKind::Files).persisted {
            AppPreferences::global(cx)
                .update(cx, |preferences, cx| preferences.set_files_face_open(&id, open, cx));
        }
        cx.notify();
    }

    /// Opens or closes the selected task's Trace face, remembered for the
    /// task (a persisted tool).
    fn set_inspector_face_open(&mut self, open: bool, cx: &mut Context<Self>) {
        let Some(id) = self.selected_task(cx) else { return };
        if tool(ToolKind::Inspector).persisted {
            AppPreferences::global(cx)
                .update(cx, |preferences, cx| preferences.set_inspector_face_open(&id, open, cx));
        }
        cx.notify();
    }

    /// Hides the panel once no face is left in it (its last tab closed, or a
    /// task shown again whose remembered terminals are gone).
    pub(super) fn hide_empty_workbar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.workbar_open(cx)
            && !self.changes_face_open(cx)
            && !self.files_face_open(cx)
            && !self.inspector_face_open(cx)
            && !self.side_chat_face_open(cx)
            && !self.terminal_face_open(cx)
        {
            self.set_workbar_open(false, window, cx);
        }
    }

    /// Shows the files: their face opened, shown, the panel open, and the
    /// focus on their list.
    fn show_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_files_face_open(true, cx);
        self.set_workbar_face(ToolKind::Files, cx);
        if !self.workbar_open(cx) {
            self.set_workbar_open(true, window, cx);
        }
        self.sync_files_shown(cx);
        self.workbar.files.update(cx, |files, cx| files.focus(window, cx));
        cx.notify();
    }

    /// Shows the trace: its face opened, shown, the panel open, and the
    /// focus in it.
    fn show_inspector(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_inspector_face_open(true, cx);
        self.set_workbar_face(ToolKind::Inspector, cx);
        if !self.workbar_open(cx) {
            self.set_workbar_open(true, window, cx);
        }
        self.sync_inspector_shown(cx);
        self.workbar.inspector.update(cx, |inspector, cx| inspector.focus(window, cx));
        cx.notify();
    }

    /// ⌘P (Desktop's `toggleTool('files')`): opens the selected task's
    /// files and focuses them, or hides the panel while it shows them.
    /// With no task, or behind settings, nothing.
    pub(crate) fn toggle_files(
        &mut self,
        _: &ToggleFiles,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() || self.selected_task(cx).is_none() {
            return;
        }
        if self.workbar_shown(cx) && self.shown_face(cx) == ToolKind::Files {
            self.set_workbar_open(false, window, cx);
            return;
        }
        if self.page.is_some() {
            let selected = self.selected_task(cx);
            self.leave_page(selected, window, cx);
        }
        self.show_files(window, cx);
    }

    /// Shows the changes: their face opened, shown, and the panel open.
    pub(super) fn show_changes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_changes_face_open(true, cx);
        self.set_workbar_face(ToolKind::Changes, cx);
        if !self.workbar_open(cx) {
            self.set_workbar_open(true, window, cx);
        } else {
            self.sync_history_reading(cx);
            self.refresh_review(window, cx);
        }
    }

    /// Opens the selected task's changes, or hides the panel while it shows
    /// them (the header button, ⌃⇧G, Desktop's `toggleTool('review')`).
    /// With no task, or while settings cover the window, it does nothing,
    /// as Desktop's shortcut does without an active Session or behind the
    /// settings.
    pub(crate) fn toggle_review(
        &mut self,
        _: &ToggleReview,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() || self.selected_task(cx).is_none() {
            return;
        }
        if self.workbar_shown(cx) && self.shown_face(cx) == ToolKind::Changes {
            self.set_workbar_open(false, window, cx);
            return;
        }
        if self.page.is_some() {
            let selected = self.selected_task(cx);
            self.leave_page(selected, window, cx);
        }
        self.show_changes(window, cx);
    }

    /// Ctrl+`: with the panel hidden or on another face, shows the most
    /// recently active terminal (starting one when the task has none) and
    /// focuses it; with a terminal focused, hides the panel, its faces
    /// kept. With no task, or behind settings, nothing.
    pub(crate) fn toggle_terminal(
        &mut self,
        _: &ToggleTerminal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() || self.selected_task(cx).is_none() {
            return;
        }
        let focused = self.workbar.terminal.read(cx).is_focused(window, cx);
        if focused && self.workbar_shown(cx) {
            self.set_workbar_open(false, window, cx);
            self.composer.update(cx, |composer, cx| composer.focus(window, cx));
            return;
        }
        if self.page.is_some() {
            let selected = self.selected_task(cx);
            self.leave_page(selected, window, cx);
        }
        self.set_workbar_face(ToolKind::Terminal, cx);
        self.workbar.terminal.update(cx, |view, cx| view.ensure_terminal(cx));
        if !self.workbar_open(cx) {
            self.set_workbar_open(true, window, cx);
        }
        self.workbar.terminal.update(cx, |view, cx| view.focus(window, cx));
        cx.notify();
    }

    /// A tool chosen in the [+] menu: Changes, Files and Trace open or
    /// close (one face each), Terminal always adds a terminal.
    fn choose_tool(&mut self, kind: ToolKind, window: &mut Window, cx: &mut Context<Self>) {
        let definition = tool(kind);
        match kind {
            ToolKind::Changes if definition.singleton && self.changes_face_open(cx) => {
                self.close_face(&Face::Changes, window, cx);
            }
            ToolKind::Changes => self.show_changes(window, cx),
            ToolKind::Files if definition.singleton && self.files_face_open(cx) => {
                self.close_face(&Face::Files, window, cx);
            }
            ToolKind::Files => self.show_files(window, cx),
            ToolKind::Inspector if definition.singleton && self.inspector_face_open(cx) => {
                self.close_face(&Face::Inspector, window, cx);
            }
            ToolKind::Inspector => self.show_inspector(window, cx),
            ToolKind::SideChat => {
                self.new_side_chat(window, cx);
            }
            ToolKind::Terminal => {
                self.set_workbar_face(ToolKind::Terminal, cx);
                self.workbar.terminal.update(cx, |view, cx| view.new_terminal(cx));
                self.workbar.terminal.update(cx, |view, cx| view.focus(window, cx));
            }
        }
        cx.notify();
    }

    /// A tab chosen: its face shows; a terminal's takes the focus.
    fn activate_face(&mut self, face: &Face, window: &mut Window, cx: &mut Context<Self>) {
        match face {
            Face::Changes => {
                self.set_workbar_face(ToolKind::Changes, cx);
                self.refresh_review(window, cx);
            }
            Face::Files => {
                self.set_workbar_face(ToolKind::Files, cx);
                self.sync_files_shown(cx);
                self.workbar.files.update(cx, |files, cx| files.focus(window, cx));
            }
            Face::Inspector => {
                self.set_workbar_face(ToolKind::Inspector, cx);
                self.sync_inspector_shown(cx);
                self.workbar.inspector.update(cx, |inspector, cx| inspector.focus(window, cx));
            }
            Face::SideChat(tab) => self.show_side_chat(&tab.id, window, cx),
            Face::Terminal(tab) => {
                self.set_workbar_face(ToolKind::Terminal, cx);
                let resource_ref = tab.resource_ref.clone();
                self.workbar.terminal.update(cx, |view, cx| {
                    view.activate(&resource_ref, cx);
                    view.focus(window, cx);
                });
            }
        }
        cx.notify();
    }

    /// A tab's ×, or unmarking it in [+]: the Changes face closes; a
    /// terminal stops (no confirmation: the model cannot see what runs in
    /// it) and its tab goes once the Host confirms. The last face closed
    /// hides the panel.
    fn close_face(&mut self, face: &Face, window: &mut Window, cx: &mut Context<Self>) {
        match face {
            Face::Changes => {
                self.set_changes_face_open(false, cx);
                self.sync_history_reading(cx);
                self.hide_empty_workbar(window, cx);
            }
            Face::Files => {
                self.set_files_face_open(false, cx);
                self.hide_empty_workbar(window, cx);
            }
            Face::Inspector => {
                self.set_inspector_face_open(false, cx);
                self.hide_empty_workbar(window, cx);
            }
            Face::SideChat(tab) => self.close_side_chat(&tab.id, window, cx),
            Face::Terminal(tab) => {
                let resource_ref = tab.resource_ref.clone();
                self.workbar.terminal.update(cx, |view, cx| view.close(&resource_ref, cx));
            }
        }
        cx.notify();
    }

    /// Opens or closes the selected task's panel, remembering it for the
    /// task; opening reads its changes.
    pub(super) fn set_workbar_open(
        &mut self,
        open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.selected_task(cx) else { return };
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_review_open(&id, open, cx));
        if open {
            self.sync_review_target(window, cx);
            self.refresh_review(window, cx);
        }
        self.sync_history_reading(cx);
        cx.notify();
    }

    /// Points the panel and the context strip at the selected task (its
    /// folder, or a Host elsewhere), with the base branch remembered for
    /// it, and reads it if it is a different task (the panel only while it
    /// shows).
    pub(super) fn sync_review_target(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let remote = self.host.read(cx).is_remote();
        let target = self.catalog.read(cx).selected_row().map(|row| {
            if remote {
                ReviewTarget::remote(row.id.clone()).with_task_folder(row.workspace_path.as_ref())
            } else {
                ReviewTarget::local(row.id.clone(), row.workspace_path.as_ref())
            }
        });
        let panel = self.workbar.panel.clone();
        self.sync_workbar_maximized(cx);
        self.sync_files_shown(cx);
        self.sync_inspector_shown(cx);
        if panel.read(cx).target() == target.as_ref() {
            return;
        }
        let base = target.as_ref().and_then(|target| {
            AppPreferences::global(cx).read(cx).review_base_branch(target.session_id())
        });
        self.strip.summary.update(cx, |summary, cx| {
            summary.set_target(target.clone(), base.clone(), cx);
        });
        panel.update(cx, |panel, cx| panel.set_target(target, base, window, cx));
        self.sync_turn_edits(cx);
        self.sync_history_reading(cx);
        self.refresh_review(window, cx);
    }

    /// Whether the changes show: the panel shows, on its Changes face.
    fn changes_shown(&self, cx: &App) -> bool {
        self.workbar_shown(cx) && self.shown_face(cx) == ToolKind::Changes
    }

    /// While the changes show the selected task, has the conversation read
    /// the task's whole history in the background, so they list every turn
    /// and not only those of the transcript's tail (the Host has no cheaper
    /// way: `session.turns.query` and `session.turn_landmarks.query` list
    /// turns and where they lie, not what their calls edited); and tells
    /// the panel while earlier turns are being read.
    fn sync_history_reading(&mut self, cx: &mut Context<Self>) {
        let followed =
            self.workbar.panel.read(cx).target().map(|target| target.session_id().clone());
        let wanted = self.changes_shown(cx)
            && followed.is_some()
            && self.state.read(cx).session_id() == followed.as_ref();
        self.state.update(cx, |state, cx| state.set_whole_history_wanted(wanted, cx));
        let reading = self.state.read(cx).is_reading_whole_history();
        self.workbar.panel.update(cx, |panel, cx| panel.set_reading_turns(reading, cx));
    }

    /// Hands the panel the session's edits when the transcript moved on
    /// since it last had them (another row, turn, or turn state); the panel
    /// keeps them only for the task it follows.
    fn sync_turn_edits(&mut self, cx: &mut Context<Self>) {
        let changes = self.workbar.panel.read(cx).turn_changes().clone();
        let (key, edits) = {
            let state = self.state.read(cx);
            let Some(transcript) = state.transcript() else { return };
            let key = EditsKey::of(transcript);
            if changes.read(cx).key() == Some(&key) {
                return;
            }
            (key, session_edits(transcript))
        };
        changes.update(cx, |changes, cx| changes.set_edits(key, edits, cx));
    }

    /// Shows the selected task's changes on turn `turn_id`'s, at the file
    /// at `path` when given: the card under the turn.
    fn show_turn_changes(
        &mut self,
        turn_id: SharedString,
        path: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.changes_shown(cx) {
            self.show_changes(window, cx);
        }
        self.workbar.panel.update(cx, |panel, cx| panel.show_turn(turn_id, path, cx));
        cx.notify();
    }

    /// Whether the selected task's panel shows filling the plate, in the
    /// conversation's place: open, shown, and maximized for the task.
    pub fn workbar_maximized(&self, cx: &App) -> bool {
        self.workbar_shown(cx) && self.workbar_maximized_for_task(cx)
    }

    /// Whether the selected task's panel is maximized when it shows.
    fn workbar_maximized_for_task(&self, cx: &App) -> bool {
        self.catalog
            .read(cx)
            .selected_id()
            .is_some_and(|id| AppPreferences::global(cx).read(cx).is_review_maximized(id))
    }

    /// ⇧Esc: the shown panel fills the plate, or gives the conversation its
    /// place back. With the panel closed it does nothing.
    pub(crate) fn toggle_workbar_maximized(
        &mut self,
        _: &ToggleMaximized,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.workbar_shown(cx) {
            let maximized = !self.workbar_maximized(cx);
            self.set_workbar_maximized(maximized, window, cx);
        }
    }

    /// Maximizes the selected task's panel or restores it, remembering it
    /// for the task. Maximizing moves focus into the face it shows, as the
    /// conversation and the composer leave the window (their state stays:
    /// they are only not drawn).
    pub(crate) fn set_workbar_maximized(
        &mut self,
        maximized: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.selected_task(cx) else { return };
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_review_maximized(&id, maximized, cx));
        self.sync_workbar_maximized(cx);
        if maximized {
            self.focus_workbar_face(window, cx);
        }
        cx.notify();
    }

    /// Gives the face the panel shows the focus: the changes' file list, or
    /// the terminal.
    pub(super) fn focus_workbar_face(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.shown_face(cx) {
            ToolKind::Changes => {
                self.workbar.panel.update(cx, |panel, cx| panel.focus_files(window, cx));
            }
            ToolKind::Files => {
                self.workbar.files.update(cx, |files, cx| files.focus(window, cx));
            }
            ToolKind::Inspector => {
                self.workbar.inspector.update(cx, |inspector, cx| inspector.focus(window, cx));
            }
            ToolKind::SideChat => self.focus_side_chat(window, cx),
            ToolKind::Terminal => {
                self.workbar.terminal.update(cx, |view, cx| view.focus(window, cx));
            }
        }
    }

    /// Tells the changes whether the panel is maximized, for Esc.
    fn sync_workbar_maximized(&mut self, cx: &mut Context<Self>) {
        let maximized = self.workbar_maximized_for_task(cx);
        self.workbar.panel.update(cx, |panel, cx| panel.set_maximized(maximized, cx));
    }

    /// Gives the conversation its place back, for a command that needs the
    /// composer.
    pub(super) fn restore_workbar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.workbar_maximized(cx) {
            self.set_workbar_maximized(false, window, cx);
        }
    }

    /// Reads the changes again while they show, and the context strip's,
    /// unless the changes' read of All changes gives them.
    fn refresh_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.changes_shown(cx) {
            self.workbar.panel.update(cx, |panel, cx| panel.refresh(window, cx));
        }
        if !self.review_feeds_strip(cx) {
            self.strip.summary.update(cx, |summary, cx| summary.refresh(cx));
        }
    }

    /// Whether the changes' reads tell the context strip its counts: while
    /// they show All changes.
    fn review_feeds_strip(&self, cx: &App) -> bool {
        self.changes_shown(cx) && *self.workbar.panel.read(cx).scope() == ReviewScope::All
    }

    /// The header's button for the changes: Desktop's `file-diff` glyph,
    /// pressed while the panel shows them, named and tipped with its
    /// shortcut.
    pub(super) fn render_review_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.catalog.read(cx).selected_id()?;
        let label = review_copy::CHANGES.get(cx);
        let shown = self.workbar_open(cx) && self.shown_face(cx) == ToolKind::Changes;
        Some(
            Button::new("review-toggle")
                .ghost()
                .small()
                .size_7()
                .flex_shrink_0()
                .icon(Icon::new(MakaIcon::FileDiff).size_4().text_color(cx.maka().ink_muted))
                .accessibility_label(label)
                .tooltip_with_action(label, &ToggleReview, None)
                .selected(shown)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_review(&ToggleReview, window, cx);
                }))
                .into_any_element(),
        )
    }

    // Rendering.

    /// The panel filling the plate below its header, in the conversation's
    /// and the composer's place.
    pub(super) fn render_workbar_maximized(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div().flex_1().min_h_0().w_full().child(self.render_workbar(window, cx)).into_any_element()
    }

    /// The panel: the strip of tabs over the face it shows, on its own
    /// plate wherever it sits.
    fn render_workbar(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let face: AnyElement = match self.shown_face(cx) {
            ToolKind::Changes => self.workbar.panel.clone().into_any_element(),
            ToolKind::Files => self.workbar.files.clone().into_any_element(),
            ToolKind::Inspector => self.workbar.inspector.clone().into_any_element(),
            ToolKind::SideChat => match self.shown_side_chat_panel(cx) {
                Some(panel) => panel.into_any_element(),
                None => Empty.into_any_element(),
            },
            ToolKind::Terminal => self.workbar.terminal.clone().into_any_element(),
        };
        v_flex()
            .id("workbar-pane")
            .test_support()
            .role(Role::Region)
            .aria_label(copy::WORKBAR.get(cx))
            .size_full()
            .min_w_0()
            .bg(cx.maka().plate)
            .rounded(RADIUS_MODAL)
            .text_color(cx.maka().ink)
            .child(self.render_strip(window, cx))
            .child(div().flex_1().min_h_0().w_full().child(face))
            .into_any_element()
    }

    /// Whether the strip is too narrow for every tab's label at
    /// `available` wide: then the inactive tabs drop theirs.
    fn strip_overflows(
        &self,
        faces: &[Face],
        available: Pixels,
        window: &Window,
        cx: &App,
    ) -> bool {
        if available <= Pixels::ZERO {
            return false;
        }
        let rem = window.rem_size();
        let font_size = rem * BODY_TEXT_REMS;
        let font = gpui_kit::font(gpui_kit::component::ActiveTheme::theme(cx).font_family.clone());
        let mut needed = Pixels::ZERO;
        for face in faces {
            let name = face.name(cx);
            let run = TextRun {
                len: name.len(),
                font: font.clone(),
                color: cx.maka().ink,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let label = window.text_system().layout_line(name.as_ref(), font_size, &[run], None);
            let marks = match face {
                Face::Terminal(tab) => usize::from(tab.bell) + usize::from(tab.exited),
                Face::Changes | Face::Files | Face::Inspector | Face::SideChat(_) => 0,
            };
            needed += label.width.min(rem * TAB_LABEL_MAX_REMS)
                + rem
                    * (TAB_LEADING_REMS
                        + TAB_ICON_REMS
                        + TAB_GAP_REMS * (2. + marks as f32)
                        + TAB_MARK_REMS * marks as f32
                        + TAB_CLOSE_REMS
                        + TAB_TRAILING_REMS
                        + TABS_GAP_REMS);
        }
        // The [+] button after the tabs.
        needed += rem * (ICON_BUTTON_REMS + TABS_GAP_REMS);
        needed > available
    }

    /// The strip: a tab per open face, then [+]; maximize and close at its
    /// end. Tabs keep their order; when they overflow, the inactive ones
    /// drop their labels (the name in a tooltip) and the active one keeps
    /// it. No horizontal scrolling.
    fn render_strip(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let faces = self.faces(cx);
        let shown = self.shown_face(cx);
        let active_terminal = self.workbar.terminal.read(cx).active_ref(cx);
        let compact = self.strip_overflows(&faces, self.workbar.tabs_width.get(), window, cx);
        let maximized = self.workbar_maximized_for_task(cx);
        let (maximize, glyph) = if maximized {
            (review_copy::RESTORE_SPLIT.get(cx), AssetIcon::Minimize2)
        } else {
            (copy::MAXIMIZE.get(cx), AssetIcon::Maximize2)
        };
        let close = review_copy::CLOSE_PANEL.get(cx);
        let icon = |glyph: Icon| glyph.size_4().text_color(maka.ink_muted);
        let bar_button =
            |id: &'static str| Button::new(id).ghost().small().size_7().flex_shrink_0();
        let tabs: Vec<AnyElement> = faces
            .iter()
            .map(|face| {
                let active = match face {
                    Face::Changes => shown == ToolKind::Changes,
                    Face::Files => shown == ToolKind::Files,
                    Face::Inspector => shown == ToolKind::Inspector,
                    Face::SideChat(tab) => {
                        shown == ToolKind::SideChat
                            && self.shown_side_chat_id(cx).as_ref() == Some(&tab.id)
                    }
                    Face::Terminal(tab) => {
                        shown == ToolKind::Terminal
                            && active_terminal.as_ref() == Some(&tab.resource_ref)
                    }
                };
                self.render_tab(face, active, compact && !active, cx)
            })
            .collect();
        let add = self.workbar.add_menu.is_open();
        let tabs_width = self.workbar.tabs_width.clone();
        let workbench = cx.entity().downgrade();
        // The probe measures the room the tabs have each frame and draws the
        // strip again when it changed.
        let probe = canvas(
            move |bounds, _, cx| {
                if tabs_width.replace(bounds.size.width) != bounds.size.width {
                    let workbench = workbench.clone();
                    cx.defer(move |cx| {
                        workbench.update(cx, |_, cx| cx.notify()).ok();
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        // The close button puts its glyph's ink on the plate's 16 px line;
        // the first tab's fill sits half way, 8 px in, so its icon lands on
        // the line too.
        let trailing = ink_padding(PLATE_LINE_REMS, ICON_BUTTON_REMS, ICON_GLYPH_REMS, ink::CLOSE);
        h_flex()
            .id("workbar-strip")
            .test_support()
            .h(rems(STRIP_HEIGHT_REMS))
            .flex_shrink_0()
            .w_full()
            .pl_2()
            .pr(rems(trailing))
            .gap_1()
            .border_b_1()
            .border_color(maka.border_soft)
            .child(
                h_flex()
                    .id("workbar-tabs")
                    .test_support()
                    .role(Role::TabList)
                    .aria_label(copy::TABS.get(cx))
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .gap(rems(TABS_GAP_REMS))
                    .child(probe)
                    .children(tabs)
                    .child(
                        div()
                            .relative()
                            .flex_shrink_0()
                            .child(
                                bar_button("workbar-add")
                                    .icon(icon(Icon::new(MakaIcon::Plus)))
                                    .accessibility_label(copy::ADD_PANEL.get(cx))
                                    .tooltip(copy::ADD_PANEL.get(cx))
                                    .selected(add)
                                    .on_click(cx.listener(
                                        |this, event: &ClickEvent, window, cx| {
                                            let width = window.rem_size() * ADD_MENU_WIDTH_REMS;
                                            MenuSlot::toggle(
                                                this,
                                                |this| &mut this.workbar.add_menu,
                                                event,
                                                |this, cx| this.add_menu_entries(cx),
                                                width,
                                                window,
                                                cx,
                                            );
                                        },
                                    )),
                            )
                            .children(self.workbar.add_menu.layer()),
                    ),
            )
            .child(
                bar_button("workbar-maximize")
                    .icon(icon(Icon::new(glyph)))
                    .accessibility_label(maximize)
                    .tooltip_with_action(maximize, &ToggleMaximized, None)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.set_workbar_maximized(!maximized, window, cx);
                    })),
            )
            .child(
                bar_button("workbar-close")
                    .icon(icon(Icon::new(MakaIcon::Close)))
                    .accessibility_label(close)
                    .tooltip(close)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.set_workbar_open(false, window, cx);
                    })),
            )
            .into_any_element()
    }

    /// The [+] menu: every tool, the open ones checked, with its shortcut
    /// when it has one.
    fn add_menu_entries(&self, cx: &mut Context<Self>) -> Vec<MenuEntry> {
        let workbench = cx.entity().downgrade();
        TOOLS
            .iter()
            .map(|tool| {
                let open = match tool.kind {
                    ToolKind::Changes => self.changes_face_open(cx),
                    ToolKind::Files => self.files_face_open(cx),
                    ToolKind::Inspector => self.inspector_face_open(cx),
                    ToolKind::SideChat => self.side_chat_face_open(cx),
                    ToolKind::Terminal => self.workbar.terminal.read(cx).has_terminals(cx),
                };
                let kind = tool.kind;
                let workbench = workbench.clone();
                let key = match kind {
                    ToolKind::Changes => "workbar-tool-changes",
                    ToolKind::Files => "workbar-tool-files",
                    ToolKind::Inspector => "workbar-tool-inspector",
                    ToolKind::SideChat => "workbar-tool-side-chat",
                    ToolKind::Terminal => "workbar-tool-terminal",
                };
                let mut item =
                    MenuItem::new(key, tool.label.get(cx)).icon(Icon::new(tool.icon)).checked(open);
                if let Some(shortcut) = tool.shortcut {
                    item = item.shortcut(shortcut());
                }
                item.on_select(move |window, cx| {
                    workbench.update(cx, |this, cx| this.choose_tool(kind, window, cx)).ok();
                })
                .into()
            })
            .collect()
    }

    /// A face's tab: its icon and name (a terminal's title, its bell and
    /// exited marks), the selected fill while it shows; its × while it is
    /// active or under the pointer, which does what unmarking it in [+]
    /// does. A terminal being closed shows a spinner there; one whose close
    /// failed, a way to close it again. `bare` drops the label (the strip
    /// overflows), the name then in a tooltip.
    fn render_tab(
        &self,
        face: &Face,
        active: bool,
        bare: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let key = face.key();
        let name = face.name(cx);
        let group: SharedString = format!("workbar-tab-{key}").into();
        let (bell, exited, close_state) = match face {
            Face::Terminal(tab) => (tab.bell, tab.exited, tab.close.clone()),
            Face::Changes | Face::Files | Face::Inspector | Face::SideChat(_) => {
                (false, false, CloseState::Open)
            }
        };
        let mut spoken = vec![name.to_string()];
        if bell {
            spoken.push(terminal_copy::BELL.get(cx).to_owned());
        }
        if exited {
            spoken.push(terminal_copy::EXITED.get(cx).to_owned());
        }
        if close_state == CloseState::Closing {
            spoken.push(terminal_copy::CLOSING.get(cx).to_owned());
        }
        let spoken: SharedString =
            shell_copy::parts(locale, &spoken.iter().map(String::as_str).collect::<Vec<_>>())
                .into();
        let transparent = |cx: &App| {
            ButtonCustomVariant::new(cx)
                .color(Hsla::transparent_black())
                .foreground(maka.ink)
                .hover(Hsla::transparent_black())
                .active(Hsla::transparent_black())
                .shadow(false)
        };
        let tint = if active { maka.ink } else { maka.ink_muted };
        let face_for_click = face.clone();
        let main = Button::new(domain_element_id("workbar-tab-button", &key))
            .custom(transparent(cx))
            .small()
            .h_7()
            .pl(rems(TAB_LEADING_REMS))
            .pr_0p5()
            .gap(rems(TAB_GAP_REMS))
            .role(Role::Tab)
            .selected(active)
            .accessibility_label(spoken.clone())
            .when(bare, |this| this.tooltip(name.clone()))
            .child(Icon::new(tool(face.kind()).icon).size_4().flex_none().text_color(tint))
            .when(!bare, |this| {
                this.child(
                    div()
                        .id(domain_element_id("workbar-tab-label", &key))
                        .test_support()
                        .text_sm()
                        .when(active, |this| this.font_medium())
                        .text_color(tint)
                        .max_w(rems(TAB_LABEL_MAX_REMS))
                        .truncate()
                        .child(name.clone()),
                )
            })
            .when(bell, |this| {
                this.child(
                    div()
                        .id(domain_element_id("workbar-tab-bell", &key))
                        .test_support()
                        .flex_none()
                        .child(Icon::new(AssetIcon::Bell).size_3().text_color(maka.ink_muted)),
                )
            })
            .when(exited, |this| {
                this.child(
                    div()
                        .id(domain_element_id("workbar-tab-exited", &key))
                        .test_support()
                        .flex_none()
                        .child(
                            Icon::new(MakaIcon::StatusStopped).size_3().text_color(maka.ink_muted),
                        ),
                )
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.activate_face(&face_for_click, window, cx);
            }));
        let trailing: AnyElement = match &close_state {
            CloseState::Closing => div()
                .id(domain_element_id("workbar-tab-closing", &key))
                .test_support()
                .size(rems(TAB_CLOSE_REMS))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(Spinner::new().xsmall().color(maka.ink_muted))
                .into_any_element(),
            CloseState::Failed(reason) => {
                let face = face.clone();
                let label = shell_copy::sentences(
                    locale,
                    terminal_copy::CLOSE_FAILED.get(cx),
                    terminal_copy::RETRY_CLOSE.get(cx),
                );
                let tooltip =
                    shell_copy::failure(locale, terminal_copy::CLOSE_FAILED.get(cx), reason);
                Button::new(domain_element_id("workbar-tab-retry-close", &key))
                    .custom(transparent(cx))
                    .xsmall()
                    .size(rems(TAB_CLOSE_REMS))
                    .flex_none()
                    .icon(Icon::new(MakaIcon::StatusFailed).size_3p5().text_color(maka.destructive))
                    .accessibility_label(label)
                    .tooltip(tooltip)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.close_face(&face, window, cx);
                    }))
                    .into_any_element()
            }
            _ => {
                let face = face.clone();
                let label = copy::close_tab(locale, &name);
                Button::new(domain_element_id("workbar-tab-close", &key))
                    .custom(
                        ButtonCustomVariant::new(cx)
                            .color(Hsla::transparent_black())
                            .foreground(maka.ink_muted)
                            .hover(maka.wash)
                            .active(maka.selected)
                            .shadow(false),
                    )
                    .xsmall()
                    .size(rems(TAB_CLOSE_REMS))
                    .flex_none()
                    .icon(Icon::new(MakaIcon::Close).size_3p5())
                    .accessibility_label(label)
                    .when(!active, |this| {
                        this.invisible().group_hover(group.clone(), |this| this.visible())
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.close_face(&face, window, cx);
                    }))
                    .into_any_element()
            }
        };
        let tab = h_flex()
            .id(domain_element_id("workbar-tab", &key))
            .test_support()
            .aria_label(spoken)
            .group(group.clone())
            .flex_shrink_0()
            .h_7()
            .pr(rems(TAB_TRAILING_REMS))
            .rounded(RADIUS_CONTROL)
            .child(main)
            .child(trailing);
        selectable_row(tab, active, cx).into_any_element()
    }

    /// The panel's own plate.
    fn render_workbar_plate(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        div().size_full().min_w_0().child(self.render_workbar(window, cx)).into_any_element()
    }

    /// `main` (the plate) with the panel beside it or below it.
    pub(super) fn with_workbar(
        &self,
        main: AnyElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let gap = rems(PLATE_INSET_REMS);
        match self.workbar_placement(cx) {
            WorkbarPlacement::Beside(width) => h_flex()
                .size_full()
                .items_stretch()
                .child(div().flex_1().min_w_0().h_full().child(main))
                .child(
                    div()
                        .w(gap)
                        .h_full()
                        .flex_shrink_0()
                        .relative()
                        .child(self.render_workbar_handle(window, cx)),
                )
                .child(
                    div()
                        .w(rems(width))
                        .h_full()
                        .flex_shrink_0()
                        .child(self.render_workbar_plate(window, cx)),
                )
                .into_any_element(),
            WorkbarPlacement::Below => {
                let rem = window.rem_size();
                let height = (window.viewport_size().height / rem * BELOW_HEIGHT_SHARE)
                    .min(BELOW_MAX_HEIGHT_REMS);
                v_flex()
                    .size_full()
                    .child(div().flex_1().min_h_0().w_full().child(main))
                    .child(div().h(gap).flex_shrink_0())
                    .child(
                        div()
                            .h(rems(height))
                            .w_full()
                            .flex_shrink_0()
                            .child(self.render_workbar_plate(window, cx)),
                    )
                    .into_any_element()
            }
        }
    }

    /// The handle on the panel's edge, in the gap between the plates, as
    /// the sidebar's: a 6 px hit area below the chrome band with the
    /// column-resize cursor, Desktop's grip on hover, focus or drag. A drag
    /// moves the edge from the narrowest width to what leaves the
    /// conversation its least; a double-click restores the default.
    /// Focused, Left and Right move the edge by 10 (Shift: 50), Enter
    /// restores it.
    fn render_workbar_handle(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let dragging = self.workbar.resizing && cx.has_active_drag();
        let keyboard =
            self.workbar.resize_focus.is_focused(window) && window.last_input_was_keyboard();
        let pill = div()
            .w(px(3.))
            .h(rems(2.))
            .rounded_full()
            .bg(if dragging { maka.border_strong } else { maka.border })
            .when(!dragging && !keyboard, |this| {
                this.invisible().group_hover("workbar-resize", |this| this.visible())
            });
        div()
            .id("workbar-resize")
            .test_support()
            .role(Role::Splitter)
            .aria_label(review_copy::RESIZE_PANEL.get(cx))
            .track_focus(&self.workbar.resize_focus)
            .key_context(WORKBAR_RESIZE_CONTEXT)
            .on_action(cx.listener(|this, _: &WidenWorkbarStep, window, cx| {
                this.step_workbar_width(RESIZE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &NarrowWorkbarStep, window, cx| {
                this.step_workbar_width(-RESIZE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &WidenWorkbarLargeStep, window, cx| {
                this.step_workbar_width(RESIZE_LARGE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &NarrowWorkbarLargeStep, window, cx| {
                this.step_workbar_width(-RESIZE_LARGE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &ResetWorkbarWidth, window, cx| {
                this.set_workbar_width(DEFAULT_REVIEW_WIDTH, window, cx);
            }))
            .absolute()
            .top(rems(super::CHROME_HEIGHT_REMS))
            .bottom_0()
            .left(window.rem_size() * (PLATE_INSET_REMS / 2.) - px(RESIZE_HANDLE_WIDTH / 2.))
            .w(px(RESIZE_HANDLE_WIDTH))
            .flex()
            .items_center()
            .justify_center()
            .group("workbar-resize")
            .cursor_col_resize()
            .when(keyboard, |this| this.focus_ring_style(window, cx))
            .on_drag(WorkbarResize, |drag, _, _, cx| cx.new(|_| *drag))
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                if event.click_count() >= 2 {
                    this.set_workbar_width(DEFAULT_REVIEW_WIDTH, window, cx);
                }
            }))
            .child(pill)
            .into_any_element()
    }

    /// A drag of the panel's edge to the pointer, which holds the handle in
    /// the middle of the gap between the plates.
    pub(super) fn drag_workbar_edge(
        &mut self,
        event: &DragMoveEvent<WorkbarResize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let rem = window.rem_size();
        let right = window.viewport_size().width - rem * PLATE_INSET_REMS;
        let edge = event.event.position.x + rem * (PLATE_INSET_REMS / 2.);
        let width = ((right - edge) / rem * DESIGN_PX_PER_REM).round().max(0.);
        self.workbar.resizing = true;
        // Within u16 once clamped.
        let width = width.min(f32::from(u16::MAX)) as u16;
        self.set_workbar_width(width, window, cx);
        cx.notify();
    }

    /// A drag of the edge ended.
    pub(super) fn end_workbar_drag(&mut self, cx: &mut Context<Self>) {
        if std::mem::take(&mut self.workbar.resizing) {
            cx.notify();
        }
    }

    /// Moves the edge by `step` of the preferences' pixels; a positive
    /// step widens the panel.
    fn step_workbar_width(&mut self, step: i32, window: &Window, cx: &mut Context<Self>) {
        let width = (i32::from(self.workbar.width) + step).clamp(0, i32::from(u16::MAX));
        // Within u16 once clamped.
        self.set_workbar_width(width as u16, window, cx);
    }

    /// Sets the panel's width, from its narrowest to what leaves the
    /// conversation its least width beside it, and saves it once it has
    /// stayed a moment.
    pub fn set_workbar_width(&mut self, width: u16, window: &Window, cx: &mut Context<Self>) {
        let rem = window.rem_size();
        let column = self.form_rems(self.shown_form, cx);
        let room =
            window.viewport_size().width / rem - column - PLATE_LEAST_REMS - PLATE_INSET_REMS;
        let room = (room * DESIGN_PX_PER_REM).floor().clamp(0., f32::from(u16::MAX));
        // Within u16 once clamped.
        let width = clamp_review_width(width.min(room as u16));
        if width == self.workbar.width {
            return;
        }
        self.workbar.width = width;
        cx.notify();
        self.workbar._save_width = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(WIDTH_SAVE_DELAY).await;
            this.update(cx, |this, cx| {
                let width = this.workbar.width;
                AppPreferences::global(cx)
                    .update(cx, |preferences, cx| preferences.set_review_width(width, cx));
            })
            .ok();
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// At the default font: the plate with the composer's column takes 49
    /// rems (784 px), with the least conversation 26 (400 px), the gap
    /// 0.5; both count the plate's margins.
    #[test]
    fn the_panel_goes_below_when_the_plate_would_lose_the_composers_width() {
        // A 1440 px window beside a 256 px sidebar: the panel takes its
        // 30 rems, up to the 47.5 that leave a 400 px conversation.
        assert_eq!(WorkbarPlacement::of(90., 16., 480), WorkbarPlacement::Beside(30.));
        assert_eq!(WorkbarPlacement::of(90., 16., 1200), WorkbarPlacement::Beside(47.5));
        assert_eq!(WorkbarPlacement::of(120., 16., 1200), WorkbarPlacement::Beside(75.));
        // Less room than the narrowest 340 px (21.25 rems) beside the
        // composer's column: below.
        assert_eq!(WorkbarPlacement::of(85., 16., 480), WorkbarPlacement::Below);
        // A collapsed sidebar gives the panel its room back.
        assert_eq!(WorkbarPlacement::of(85., 0., 480), WorkbarPlacement::Beside(30.));
    }

    #[test]
    fn the_registry_lists_changes_files_trace_side_chat_then_terminal() {
        let kinds: Vec<ToolKind> = TOOLS.iter().map(|tool| tool.kind).collect();
        assert_eq!(
            kinds,
            [
                ToolKind::Changes,
                ToolKind::Files,
                ToolKind::Inspector,
                ToolKind::SideChat,
                ToolKind::Terminal
            ]
        );
        let shortcut = |kind| tool(kind).shortcut.map(|shortcut| shortcut().name());
        assert!(tool(ToolKind::Changes).persisted && tool(ToolKind::Changes).singleton);
        assert!(tool(ToolKind::Files).persisted && tool(ToolKind::Files).singleton);
        assert_eq!(tool(ToolKind::Files).icon, MakaIcon::Folder);
        assert_eq!(shortcut(ToolKind::Files), Some(ToggleFiles.name()));
        // Desktop's `inspector`: persisted, one face, the activity glyph,
        // no shortcut.
        assert!(tool(ToolKind::Inspector).persisted && tool(ToolKind::Inspector).singleton);
        assert_eq!(tool(ToolKind::Inspector).icon, MakaIcon::Activity);
        assert_eq!(shortcut(ToolKind::Inspector), None);
        // Desktop's `side-chat`: not persisted, several faces, ⌥⌘S.
        assert!(!tool(ToolKind::SideChat).persisted && !tool(ToolKind::SideChat).singleton);
        assert_eq!(tool(ToolKind::SideChat).icon, MakaIcon::Chat);
        assert_eq!(shortcut(ToolKind::SideChat), Some(ToggleSideChat.name()));
        assert!(!tool(ToolKind::Terminal).persisted && !tool(ToolKind::Terminal).singleton);
        assert_eq!(tool(ToolKind::Terminal).icon, MakaIcon::ToolTerminal);
        assert_eq!(shortcut(ToolKind::Changes), Some(ToggleReview.name()));
    }
}
