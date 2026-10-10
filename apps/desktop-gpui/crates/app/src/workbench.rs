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

//! The main window's content: the sidebar column and the main pane (its
//! header, the conversation or the empty state, and the composer, or one of
//! the sidebar's pages with its header in the header row), or, while
//! settings show, the settings navigation in the sidebar's place and the
//! settings page on the plate.

use std::path::Path;
use std::rc::Rc;

use automations::{AutomationsEvent, AutomationsView, ScheduledTasks, ScheduledTasksEvent};
use bots::BotService;
use conversation::{
    Composer, ConversationEvent, ConversationPhase, ConversationState, ConversationView,
    NewSessionEvent, TurnActivity,
};
use extensions::{ExtensionsContext, ExtensionsView};
use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::base::TextSelection;
use gpui_kit::base::animation::{EffectTransition, ease_in_out_cubic};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, IconName, Root, Selectable as _, Sizable as _,
    StyledExt as _, ThemeStyled as _, TitleBar, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    Action as _, AnyElement, App, AppContext as _, ClickEvent, ClipboardItem, Context,
    DismissEvent, DragMoveEvent, ElementId, Empty, Entity, FocusHandle, Focusable as _, Global,
    Hsla, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Pixels, Point,
    Render, Role, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px, rems,
};
use search::{SearchPageEvent, SearchView, TaskEntry};
use session::{
    Place, SessionCatalog, SessionCatalogEvent, SessionHistory, SessionSidebar, SidebarEvent,
    SidebarPage,
};
use settings::{
    AboutFacts, AppPreferences, Appearance, DEFAULT_SIDEBAR_WIDTH, Language, NarrowSidebar,
    SIDEBAR_WIDTHS, SettingsContext, SettingsEvent, SettingsSection, SettingsView,
    clamp_sidebar_width,
};
use shared::copy::commands as palette_words;
use shared::copy::extensions as pages_copy;
use shared::copy::search as search_copy;
use shared::copy::settings as settings_copy;
use shared::copy::{self, Locale};
use shared::domain_element_id;
use shared::hop::Hops;
use shared::icons::{MakaIcon, ink};
use shared::layout::{
    COLUMN_GUTTER_REMS, COLUMN_MAX_WIDTH_REMS, ICON_BUTTON_REMS, ICON_GLYPH_REMS,
    PAGE_MAX_WIDTH_REMS, PLATE_LINE_REMS, ink_padding,
};
use shared::menu::{
    Menu, MenuEntry, MenuHeading, MenuItem, MenuPlacement, MenuSlot, menu_layer, reopens_on,
};
use shared::theme::{
    ActiveMakaPalette as _, RADIUS_MODAL, badge, banner, banner_description, floating_shadow,
    quiet_button,
};

use terminal::Terminals;

use crate::commands::palette_commands;
use crate::empty_state::EmptyState;
use crate::host_blocked::HostBlockedScreen;
use crate::palette::{PaletteCommand, PaletteEntry, Section, open_palette};
use crate::pet_companion::PetWatch;
use crate::shortcuts::open_shortcuts;
use crate::sidebar_layout::{SidebarForm, SidebarLayout};
use crate::state_root_dialog::{StateRootSetup, open_state_root_dialog, show_workbench_on};

mod context_strip;
mod side_chats;
mod workbar;

use context_strip::ContextStrip;
use workbar::Workbar;
pub use workbar::{
    NarrowWorkbarLargeStep, NarrowWorkbarStep, ResetWorkbarWidth, WORKBAR_RESIZE_CONTEXT,
    WidenWorkbarLargeStep, WidenWorkbarStep,
};
use workspace::actions::{
    AddConnection, ArchiveTask, FindInConversation, FlagTask, FocusComposer, GoBack, GoForward,
    NewSession, OpenCommandPalette, OpenExtensions, OpenProjectSettings, OpenScheduledTasks,
    OpenSettings, Reconnect, SearchAllTasks, SendMessage, ShowKeyboardShortcuts, StopTurn,
    SwitchHost, SwitchStateRoot, ToggleSidebar,
};
use workspace::{
    ConnectionCatalog, ConnectionStatus, HostDirectory, HostSession, ProjectCatalogSource,
    ProjectSelection, ProjectSelectionEvent, RetryState, path_name,
};

/// Height of the window chrome band: the main plate's header, and the part
/// of the sidebar's top strip below the plate inset, which holds the traffic
/// lights and the window controls. One measure, so the two share a centre
/// line.
pub const CHROME_HEIGHT_REMS: f32 = 3.;

/// The canvas margin around the main plate: its gap from every window edge,
/// and from the 256px sidebar column beside it, so the plate starts at
/// x 264 (review round 1, S14). The sidebar's top strip starts its band
/// below the same margin.
const PLATE_INSET_REMS: f32 = 0.5;

/// Pixels per rem at the default UI font size: a sidebar width in the
/// preferences' pixels is this many times its rems.
const DESIGN_PX_PER_REM: f32 = 16.;

/// The least the plate takes beside the expanded sidebar: the composer's
/// column, its gutters, and the canvas margin on either side of the plate.
/// A narrower plate would squeeze the composer.
const PLATE_MIN_REMS: f32 = COLUMN_MAX_WIDTH_REMS + 2. * COLUMN_GUTTER_REMS + 2. * PLATE_INSET_REMS;

/// The resize handle's hit area on the sidebar's edge, in the canvas margin
/// between the column and the plate (Desktop's grab zone is 16px; the
/// margin here is 8).
const RESIZE_HANDLE_WIDTH: f32 = 6.;

/// Moved narrower than this, in the preferences' pixels, the sidebar's
/// edge collapses the sidebar: Desktop's rule, Astryx's SideNav collapsing
/// a drag below its `COLLAPSE_THRESHOLD` of 160, 20 under the narrowest
/// width (`SIDEBAR_WIDTHS`).
const COLLAPSE_BELOW: f32 = 160.;

/// How long the width waits after the last drag step before it is saved
/// (Desktop's `LAYOUT_PERSIST_DEBOUNCE_MS`).
const WIDTH_SAVE_DELAY: std::time::Duration = std::time::Duration::from_millis(200);

/// The footer's Host name keeps this much before it gives way, and the
/// root badge beside it is at most this wide (review round 11).
const FOOTER_NAME_MIN_WIDTH: f32 = 80.;
const FOOTER_BADGE_MAX_WIDTH: f32 = 104.;

/// What the footer row leaves its name, state and badge, less than the
/// column's width: the band's 8px sides, the 4px gap and the 28px settings
/// button, the row's 8px and 12px sides, and the dot's 16px lane and its 8px
/// gap.
const FOOTER_CHROME_REMS: f32 = 1. + 0.25 + 1.75 + 1.25 + 1. + 0.5;

/// How the footer row shares its width while disconnected (review round
/// 12): the state's words never shrink; the badge gives way first, down to
/// two glyphs, and goes when that leaves the words no room; then the name
/// gives way, down to two glyphs. The row's tooltip and spoken label keep
/// the state and the endpoint.
#[derive(Debug, Clone, Copy, PartialEq)]
struct FooterFit {
    /// The least the name and the state's words take together.
    group_min: Pixels,
    /// The badge's least width, or `None` when it goes.
    badge_min: Option<Pixels>,
}

fn footer_fit(
    window: &Window,
    column_rems: f32,
    name: &str,
    word: Option<&str>,
    badge: &str,
) -> FooterFit {
    let rem = window.rem_size();
    let gap = rem * 0.5;
    let available = rem * (column_rems - FOOTER_CHROME_REMS);
    let measure = |text: &str, size: f32, weight: gpui_kit::FontWeight| {
        let mut style = window.text_style();
        style.font_weight = weight;
        let run = style.to_run(text.len());
        let width =
            window.text_system().shape_line(text.to_owned().into(), rem * size, &[run], None).width;
        // Subpixel advances round up when drawn.
        width.ceil()
    };
    let two_glyphs = |text: &str, size: f32, weight| {
        let lead: String = text.chars().take(2).collect();
        let lead = if text.chars().count() > 2 { format!("{lead}…") } else { lead };
        measure(&lead, size, weight)
    };
    let regular = gpui_kit::FontWeight::NORMAL;
    let name_width = measure(name, 0.875, regular);
    let name_floor = two_glyphs(name, 0.875, regular);
    let name_min = name_width.min(px(FOOTER_NAME_MIN_WIDTH));
    let badge_min = rem + two_glyphs(badge, 0.75, gpui_kit::FontWeight::MEDIUM);
    let Some(word) = word else {
        return FooterFit { group_min: name_min, badge_min: Some(badge_min) };
    };
    let words = gap + measure(word, 0.75, regular);
    if name_min + words + gap + badge_min <= available {
        FooterFit { group_min: name_min + words, badge_min: Some(badge_min) }
    } else {
        let name_min = name_min.min(available - words).max(name_floor);
        FooterFit { group_min: name_min + words, badge_min: None }
    }
}

/// Set for a `--passive` launch, whose windows are drawn for captures: the
/// main view's content then ignores the real pointer (no hover).
#[derive(Debug)]
pub struct PassivePointer;

impl Global for PassivePointer {}

/// A page's content width: its column less the column's 24px side padding.
const PAGE_COLUMN_REMS: f32 = PAGE_MAX_WIDTH_REMS - 3.;

/// Height of the footer row (36px); the band adds the plate inset above and
/// below it, so its fill sits as far from the hairline over the band as
/// from the window's edge, and ends level with the plate.
const FOOTER_ROW_HEIGHT_REMS: f32 = 2.25;

/// The footer menu is at least as wide as the footer row it opens from
/// (the sidebar's width less its inset, `FOOTER_MENU_INSET_REMS`), as in
/// AllSum.
const FOOTER_MENU_INSET_REMS: f32 = 1.;

/// The task header's project menu is at least this wide (224px).
const PROJECT_MENU_MIN_WIDTH_REMS: f32 = 14.;

/// Key context of the sidebar's resize handle while it has focus.
pub const SIDEBAR_RESIZE_CONTEXT: &str = "SidebarResize";

/// Key context of the sidebar while it lies over the plate.
pub const SIDEBAR_OVERLAY_CONTEXT: &str = "SidebarOverlay";

/// Key context of the task view (the plate while it shows the selected
/// task: its header, the conversation and the composer), which owns ⌘F,
/// Find in conversation. A page or settings in the plate's place have
/// contexts of their own.
pub const TASK_VIEW_CONTEXT: &str = "TaskView";

/// The most of a selection ⇧⌘F takes as the Search page's query.
const SEARCH_SEED_MAX_CHARS: usize = 200;

/// How long the sidebar takes to change width, eased in and out: the kit
/// sidebar's transition (`SIDEBAR_TRANSITION_DURATION` and
/// `ease_in_out_cubic` in gpui-component's sidebar).
const SIDEBAR_TRANSITION: std::time::Duration = std::time::Duration::from_millis(200);

/// The rail's width: its 32px buttons with 20px either side.
const RAIL_WIDTH_REMS: f32 = 4.5;

/// What the traffic lights take from their 1rem inset in the rail's top
/// band: 54 points, and 2 to spare. At small UI font sizes the rail widens
/// to this rather than let them overhang the plate.
const TRAFFIC_LIGHTS_SPAN: f32 = 56.;

/// How far an arrow key moves the sidebar's edge, and with Shift
/// (Desktop's `KEYBOARD_STEP` and `KEYBOARD_LARGE_STEP`), in the
/// preferences' pixels.
const RESIZE_STEP: i32 = 10;
const RESIZE_LARGE_STEP: i32 = 50;

gpui_kit::actions!(
    sidebar_resize,
    [
        /// Move the focused sidebar edge a step left.
        NarrowSidebarStep,
        /// Move the focused sidebar edge a step right.
        WidenSidebarStep,
        /// Move the focused sidebar edge a large step left.
        NarrowSidebarLargeStep,
        /// Move the focused sidebar edge a large step right.
        WidenSidebarLargeStep,
        /// Give the sidebar its default width again.
        ResetSidebarWidth,
        /// Close the sidebar that lies over the plate.
        CloseSidebarOverlay,
    ]
);

/// A width change of the sidebar column, or of the sidebar over the plate,
/// while it runs.
#[derive(Debug, Clone, Copy)]
struct Slide {
    from_rems: f32,
    to_rems: f32,
    /// Tells this slide's animation from the one before it.
    generation: usize,
    /// The content keeps to the trailing edge, so it slides in from the
    /// window's edge or out to it rather than being uncovered in place.
    from_edge: bool,
    /// What shows while the slot closes: the form it leaves.
    leaving: Option<SidebarForm>,
}

/// What a drag of the sidebar's edge carries: nothing; the drag's moves
/// set the width.
#[derive(Debug, Clone, Copy)]
struct SidebarResize;

impl Render for SidebarResize {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

/// Opens a folder in the system's file manager; tests substitute one.
type FolderOpener = Rc<dyn Fn(&Path, &mut App)>;

/// Where the selected task runs, as the header's folder button tells it:
/// its project's name, else its folder's (Desktop's
/// `deriveTitlebarProjectName`), and the folder itself.
struct TaskFolder {
    name: SharedString,
    path: SharedString,
}

/// The settings surface while it shows.
struct SettingsSurface {
    view: Entity<SettingsView>,
    /// What had focus when settings opened; it has focus again after.
    return_focus: Option<FocusHandle>,
    _subscriptions: [Subscription; 4],
}

/// Composes the window. It owns the feature entities for this window and
/// handles the window-wide Actions on its root element, delegating each to
/// the entity that owns the command, so a menu item, a key binding, and a
/// button all end in the same method. When no element has focus the same
/// Actions reach it through the app-level fallbacks `crate::init` registers.
///
/// The selected session flows one way: the catalog owns the selection and the
/// workbench hands it to the conversation state, which the transcript view
/// and the composer both present. The workbench owns no conversation
/// behavior; it only places the feature views and routes Actions.
///
/// It owns where the sidebar shows, for the life of the window only
/// ([`SidebarLayout`]), and its width, which the preferences keep. Expanded,
/// it sits beside the plate; collapsed (by the person, or by a window too
/// narrow for it beside the composer), it is a rail of icons or nothing, as
/// the Appearance preference says, and the main header takes the window
/// controls (the sidebar toggle, Back, Forward), with the traffic lights'
/// inset when nothing is beside it. While the window is narrow the toggle
/// opens the sidebar over the plate instead. Whatever it shows, the sidebar
/// entity keeps its state (folded groups, scroll position).
///
/// It also owns the window's task history: every change of the selected
/// task that Back or Forward did not make is a visit, and Back and Forward
/// select the neighbouring entries.
/// Whenever the focused element leaves the window, as when the sidebar hides
/// while its list has focus, the composer takes focus, so the keyboard
/// always has a target.
///
/// It is the main area's router: the plate shows the selected task, or one
/// of the sidebar's pages (Extensions, Scheduled tasks) with the page's
/// title and controls in the header row where the task's title sits. A
/// page's entity lives as long as the window, so going back to it finds it
/// as it was. Choosing a task in the list (even the selected one), New
/// task, Focus composer, or a task from the palette shows the task view
/// again; the selection changing by itself (a first load, a task removed)
/// does not. Back and Forward walk tasks and pages alike.
///
/// It owns whether settings show. Opening them puts the settings
/// navigation in the sidebar column and the chosen page on the plate; the
/// window's chrome stays, and the task view's entities stay as they were
/// (the task, its transcript's scroll position, the draft), so "Back to
/// app" or Escape shows them again as they were and gives focus back to
/// what had it. The commands that act on the task view (New task, Focus
/// composer, opening a task from the palette) leave settings first; the
/// ones that only make sense beside it (Send, the sidebar toggle, Back and
/// Forward) wait.
pub struct Workbench {
    host: Entity<HostSession>,
    catalog: Entity<SessionCatalog>,
    projects: Entity<ProjectSelection>,
    connections: Entity<ConnectionCatalog>,
    sidebar: Entity<SessionSidebar>,
    state: Entity<ConversationState>,
    conversation: Entity<ConversationView>,
    composer: Entity<Composer>,
    /// Whether the empty state stood in for the conversation at its last
    /// commit; a commit re-renders the window only when this flips.
    empty_state: bool,
    /// Where the sidebar shows (expanded, collapsed, over the plate) and
    /// why; not saved across launches.
    layout: SidebarLayout,
    /// What the column beside the plate shows, as last drawn; a change
    /// slides from it.
    shown_form: SidebarForm,
    /// The column's width change while it runs.
    column_slide: Option<Slide>,
    /// The sidebar over the plate sliding in or out.
    overlay_slide: Option<Slide>,
    /// How many slides have started, for their animations' ids.
    slides: usize,
    _column_slide_end: Option<Task<()>>,
    _overlay_slide_end: Option<Task<()>>,
    /// The sidebar over the plate's, to tell whether focus is in it.
    overlay_focus: FocusHandle,
    /// The rail's icons, which hop as the pointer enters them.
    rail_hops: Hops,
    /// The expanded sidebar's width in the preferences' pixels (pixels at
    /// the default UI font size), as dragged.
    sidebar_width: u16,
    /// The window's width in rems, as last measured.
    window_rems: f32,
    /// Whether the sidebar's edge is being dragged.
    resizing: bool,
    /// The resize handle's, a Tab stop after the rest of the window.
    resize_focus: FocusHandle,
    /// Saves the width once dragging pauses.
    _save_width: Option<Task<()>>,
    /// The tasks and pages this window showed, for Back and Forward.
    history: SessionHistory,
    /// The task the task view shows as of the last selection change (or
    /// the last choice of one): the place a visit leaves while no page
    /// shows. `None` right after New task left a page, so the task the
    /// new one replaces is not a visit.
    shown: Option<SharedString>,
    /// The page the plate shows instead of the task view.
    page: Option<SidebarPage>,
    /// The Extensions page, from the first time it shows.
    extensions: Option<Entity<ExtensionsView>>,
    /// The Host's scheduled tasks, read from the start: the sidebar counts
    /// the active ones, and a fire is announced whatever the plate shows.
    scheduled: Entity<ScheduledTasks>,
    /// The custom pet at the bottom right, and what it is told.
    pet: Entity<PetWatch>,
    /// The Scheduled tasks page, from the first time it shows.
    automations: Option<Entity<AutomationsView>>,
    /// The Search page, from the first time it shows: its query, results
    /// and scroll stay for Back.
    search: Option<Entity<SearchView>>,
    /// The task Back or Forward is selecting: its selection change is not
    /// a visit.
    navigating: Option<SharedString>,
    /// How Switch data folder… chooses and opens another root; without it
    /// the command does nothing (previews and tests).
    state_root_setup: Option<StateRootSetup>,
    /// The settings surface while it shows, so a second command shows the
    /// asked-for section in it.
    settings: Option<SettingsSurface>,
    /// The chat bots of the State Root, for Remote access
    /// ([`crate::link_bots`]); none in previews and tests.
    bots: Option<Entity<BotService>>,
    /// The footer menu while it is open, and what tells it closed.
    footer_menu: Option<(Entity<Menu>, Subscription)>,
    /// Where a pointer press outside the footer menu last closed it: the
    /// click that press begins on the footer row does not open it again.
    footer_menu_closed_at: Option<Point<Pixels>>,
    /// The menu of the folder button before the task's title.
    project_menu: MenuSlot,
    /// How Open project folder opens it.
    folder_opener: FolderOpener,
    /// The changes panel beside the plate, and its width.
    workbar: Workbar,
    /// The context strip over the composer.
    strip: ContextStrip,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for Workbench {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workbench").finish_non_exhaustive()
    }
}

impl Workbench {
    pub fn new(
        host: Entity<HostSession>,
        projects: Rc<dyn ProjectCatalogSource>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let catalog = cx.new(|cx| SessionCatalog::new(host.clone(), cx));
        let projects = cx.new(|cx| ProjectSelection::new(host.clone(), projects, cx));
        let sidebar =
            cx.new(|cx| SessionSidebar::new(catalog.clone(), projects.clone(), window, cx));
        let state = cx.new(|cx| ConversationState::new(host.clone(), cx));
        let selected = catalog.read(cx).selected_id().cloned();
        state.update(cx, |state, cx| state.select_session(selected.clone(), cx));
        let conversation = cx.new(|cx| ConversationView::new(state.clone(), cx));
        let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
        let composer = cx.new(|cx| {
            Composer::new(state.clone(), connections.clone(), projects.clone(), window, cx)
        });
        let scheduled = cx.new(|cx| ScheduledTasks::new(host.clone(), cx));
        let pet = cx.new(|cx| PetWatch::new(&host, &catalog, &state, cx));
        // The window's terminals, beside the conversation state whose
        // Session subscription carries their output, following its task.
        let terminals = cx.new(|cx| Terminals::new(host.clone(), state.clone(), cx));
        let subscriptions = vec![
            // The sidebar's Scheduled tasks entry counts the active tasks.
            cx.observe(&scheduled, |this, scheduled, cx| {
                let count = scheduled.read(cx).active_count();
                this.sidebar
                    .update(cx, |sidebar, cx| sidebar.set_active_scheduled_tasks(count, cx));
            }),
            // A fire Desktop announces is announced here too, with the way
            // to the page (Desktop's `scheduled-tasks:fired` toast).
            cx.subscribe_in(&scheduled, window, |_, _, event: &ScheduledTasksEvent, window, cx| {
                let ScheduledTasksEvent::Fired { title, .. } = event else {
                    return;
                };
                announce_fired(title.clone(), window, cx);
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
            // The header and the window title show the selected task.
            cx.observe_in(&catalog, window, |this, _, window, cx| {
                window.set_window_title(
                    &this.title(cx).unwrap_or_else(|| copy::APP_NAME.get(cx).into()),
                );
                // The workbar's changes follow the selected task.
                this.sync_review_target(window, cx);
                // The Search page names and matches the tasks listed.
                this.sync_search_tasks(cx);
                cx.notify();
            }),
            cx.subscribe_in(&catalog, window, {
                let state = state.clone();
                move |this, _, event: &SessionCatalogEvent, window, cx| match event {
                    SessionCatalogEvent::SelectionChanged(selected) => {
                        let selected = selected.clone();
                        this.record_selection(selected.clone(), cx);
                        state.update(cx, |state, cx| state.select_session(selected, cx));
                        this.sync_review_target(window, cx);
                    }
                    // The new task's draft is for writing in: it replaces a
                    // page on the plate (Back returns to the page, not to
                    // the task behind it), and the composer takes focus.
                    // Every way a task starts ends here: the button, ⌘N,
                    // the menu, the palette, and a project's "+".
                    SessionCatalogEvent::DraftOpened => {
                        this.leave_page(None, window, cx);
                        this.close_sidebar_overlay(window, cx);
                        this.composer.update(cx, |composer, cx| composer.focus(window, cx));
                    }
                    _ => {}
                }
            }),
            // The draft's first message creates its task: the list shows it
            // at once, and loses it again when the Host does not take the
            // message (the draft then shows again).
            cx.subscribe(&state, |this, _, event: &NewSessionEvent, cx| match event {
                NewSessionEvent::Created(item) => {
                    this.catalog.update(cx, |catalog, cx| catalog.adopt(item, cx));
                }
                NewSessionEvent::Discarded(id) => {
                    this.catalog.update(cx, |catalog, cx| catalog.discard(id, cx));
                }
                _ => {}
            }),
            // Adding a project on a remote Host shows the Host's folders.
            cx.subscribe_in(
                &projects,
                window,
                |this, _, event: &ProjectSelectionEvent, window, cx| {
                    if let ProjectSelectionEvent::ChooseHostFolder = event {
                        this.choose_host_folder(window, cx);
                    }
                },
            ),
            cx.subscribe(&state, |this, _, _: &ConversationEvent, cx| {
                let empty_state = this.shows_empty_state(cx);
                if empty_state != this.empty_state {
                    this.empty_state = empty_state;
                    cx.notify();
                }
            }),
            // The header's folder button names the selected task's project,
            // and the Search page each task's.
            cx.observe(&projects, |this, _, cx| {
                this.sync_search_tasks(cx);
                cx.notify();
            }),
            // While settings show, the section list takes it instead, and
            // on a page the page.
            cx.on_focus_lost(window, |this, window, cx| this.focus_main(window, cx)),
            // The sidebar collapses as the window narrows past the width it
            // needs beside the composer and expands as it widens again.
            cx.observe_window_bounds(window, |this, window, cx| this.sync_narrow(window, cx)),
            // The UI font size moves that width; the preference says what
            // the sidebar collapses to.
            cx.observe_in(&AppPreferences::global(cx), window, |this, _, window, cx| {
                this.sync_narrow(window, cx);
                this.sync_form(cx);
            }),
            // Choosing a task in the list shows the task view.
            cx.subscribe_in(&sidebar, window, |this, _, event: &SidebarEvent, window, cx| {
                if let SidebarEvent::TaskChosen(id) = event {
                    this.leave_page(Some(id.clone()), window, cx);
                    // A task chosen with the pointer closes the sidebar over
                    // the plate; the arrow keys walk the list in it.
                    if !window.last_input_was_keyboard() {
                        this.close_sidebar_overlay(window, cx);
                    }
                }
            }),
        ];
        let workbar = Workbar::new(terminals, host.clone(), window, cx);
        let mut this = Self {
            host,
            catalog,
            projects,
            connections,
            sidebar,
            state,
            conversation,
            composer,
            empty_state: false,
            layout: SidebarLayout::default(),
            shown_form: SidebarForm::Expanded,
            column_slide: None,
            overlay_slide: None,
            slides: 0,
            _column_slide_end: None,
            _overlay_slide_end: None,
            overlay_focus: cx.focus_handle(),
            rail_hops: Hops::new(),
            sidebar_width: AppPreferences::current(cx).sidebar_width,
            window_rems: 0.,
            resizing: false,
            resize_focus: cx.focus_handle().tab_stop(true).tab_index(1),
            _save_width: None,
            history: SessionHistory::new(),
            shown: selected,
            page: None,
            extensions: None,
            scheduled,
            pet,
            automations: None,
            search: None,
            navigating: None,
            state_root_setup: None,
            settings: None,
            bots: None,
            footer_menu: None,
            footer_menu_closed_at: None,
            project_menu: MenuSlot::new(MenuPlacement::BelowStart),
            folder_opener: Rc::new(|path, cx| cx.open_with_system(path)),
            workbar,
            strip: ContextStrip::new(cx),
            _subscriptions: subscriptions,
        };
        this.empty_state = this.shows_empty_state(cx);
        // A window too narrow for the sidebar beside the composer opens
        // with it collapsed.
        this.measure_window(window, cx);
        this.layout = SidebarLayout::new(this.window_is_narrow());
        this.shown_form = this.layout.form(narrow_sidebar(cx));
        window.set_window_title(&this.title(cx).unwrap_or_else(|| copy::APP_NAME.get(cx).into()));
        this.watch_workbar(window, cx);
        this
    }

    pub fn host(&self) -> &Entity<HostSession> {
        &self.host
    }

    pub fn sidebar(&self) -> &Entity<SessionSidebar> {
        &self.sidebar
    }

    /// The Host's projects and the one new tasks go into.
    pub fn projects(&self) -> &Entity<ProjectSelection> {
        &self.projects
    }

    pub fn composer(&self) -> &Entity<Composer> {
        &self.composer
    }

    pub fn conversation(&self) -> &Entity<ConversationView> {
        &self.conversation
    }

    /// The Host's model connections, which the model picker lists.
    pub fn connections(&self) -> &Entity<ConnectionCatalog> {
        &self.connections
    }

    /// Opens folders with `opener` instead of the system (tests).
    pub fn set_folder_opener(&mut self, opener: impl Fn(&Path, &mut App) + 'static) {
        self.folder_opener = Rc::new(opener);
    }

    /// Lets Switch data folder… choose another root and open the window on
    /// it; [`crate::show_workbench`] sets it.
    pub fn set_state_root_setup(&mut self, setup: StateRootSetup) {
        self.state_root_setup = Some(setup);
    }

    /// Whether the expanded sidebar shows, beside the plate or over it.
    pub fn sidebar_visible(&self) -> bool {
        self.layout.expanded()
    }

    /// What the column beside the plate shows.
    pub fn sidebar_form(&self) -> SidebarForm {
        self.shown_form
    }

    /// Whether the expanded sidebar lies over the plate.
    pub fn sidebar_over_plate(&self) -> bool {
        self.layout.overlay()
    }

    /// Whether the rail's icon named `key` (`new-task`, a page's key,
    /// `search`, `settings`) is hopping.
    pub fn rail_icon_hopping(&self, key: &'static str, cx: &App) -> bool {
        self.rail_hops.hopping(key, cx)
    }

    /// Expands or collapses the sidebar as the toggle does (while the
    /// window is narrow, over the plate). Focus stays where it is, unless it
    /// was in the sidebar, in which case the composer takes it.
    pub fn set_sidebar_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.layout.expanded() != visible {
            self.change_layout(SidebarLayout::toggle, cx);
        }
    }

    /// Takes the window's width in rems, at the rem it draws its next frame
    /// at.
    fn measure_window(&mut self, window: &Window, cx: &App) {
        self.window_rems = window.viewport_size().width / cx.theme().font_size;
    }

    /// Whether the window is too narrow for the expanded sidebar beside a
    /// plate that keeps the composer's column and gutters. A sidebar wider
    /// than the default gives way down to it first ([`Self::column_rems`]),
    /// so the breakpoint is the sidebar's width up to the default's beside
    /// that plate: 1040px at the default width and font size.
    fn window_is_narrow(&self) -> bool {
        let default = f32::from(DEFAULT_SIDEBAR_WIDTH) / DESIGN_PX_PER_REM;
        self.window_rems < self.sidebar_rems().min(default) + PLATE_MIN_REMS
    }

    /// The expanded sidebar's width beside the plate, in rems: its own, or
    /// what the window leaves beside the composer, down to the default.
    fn column_rems(&self) -> f32 {
        let default = f32::from(DEFAULT_SIDEBAR_WIDTH) / DESIGN_PX_PER_REM;
        let width = self.sidebar_rems();
        width.min(self.window_rems - PLATE_MIN_REMS).max(width.min(default))
    }

    /// Follows the window's width across the breakpoint.
    fn sync_narrow(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.measure_window(window, cx);
        let narrow = self.window_is_narrow();
        if narrow != self.layout.narrow() {
            let in_overlay = self.overlay_focus.contains_focused(window, cx);
            self.change_layout(|layout| layout.set_narrow(narrow), cx);
            if in_overlay && !self.layout.overlay() {
                self.focus_main(window, cx);
            }
        }
    }

    /// Changes the layout and slides the column and the sidebar over the
    /// plate to what it now says; `true` when the sidebar opened over the
    /// plate.
    fn change_layout(
        &mut self,
        change: impl FnOnce(&mut SidebarLayout),
        cx: &mut Context<Self>,
    ) -> bool {
        let before = self.layout;
        change(&mut self.layout);
        if self.layout == before {
            return false;
        }
        let overlay = self.layout.overlay();
        if overlay != before.overlay() {
            self.slide_overlay(overlay, cx);
        }
        self.sync_form(cx);
        cx.notify();
        overlay && !before.overlay()
    }

    /// Closes the sidebar over the plate, if it is open; focus in it goes
    /// back to the plate.
    pub fn close_sidebar_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.layout.overlay() {
            return;
        }
        let in_overlay = self.overlay_focus.contains_focused(window, cx);
        self.change_layout(|layout| _ = layout.close_overlay(), cx);
        if in_overlay {
            self.focus_main(window, cx);
        }
    }

    fn close_overlay_action(
        &mut self,
        _: &CloseSidebarOverlay,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_sidebar_overlay(window, cx);
    }

    /// Gives focus to what the window shows: the settings navigation, the
    /// page, or the composer (as whenever focus leaves the window).
    fn focus_main(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.settings {
            Some(settings) => settings.view.update(cx, |view, cx| view.focus_nav(window, cx)),
            None if self.page.is_some() => self.focus_page(window, cx),
            None if self.workbar_maximized(cx) => self.focus_workbar_face(window, cx),
            None => self.composer.update(cx, |composer, cx| composer.focus(window, cx)),
        }
    }

    /// Brings the column to the form the layout says, sliding from the one
    /// it showed (at once with motion reduced).
    fn sync_form(&mut self, cx: &mut Context<Self>) {
        let form = self.layout.form(narrow_sidebar(cx));
        if form == self.shown_form {
            return;
        }
        let from = std::mem::replace(&mut self.shown_form, form);
        cx.notify();
        if cx.reduce_motion() {
            self.column_slide = None;
            return;
        }
        let generation = self.next_slide();
        self.column_slide = Some(Slide {
            from_rems: self.form_rems(from, cx),
            to_rems: self.form_rems(form, cx),
            generation,
            from_edge: from == SidebarForm::Hidden || form == SidebarForm::Hidden,
            // Sliding out to nothing, it keeps showing what leaves.
            leaving: (form == SidebarForm::Hidden).then_some(from),
        });
        self._column_slide_end =
            Some(self.end_slide(generation, |this| &mut this.column_slide, cx));
    }

    /// Slides the sidebar over the plate in (`open`) or out.
    fn slide_overlay(&mut self, open: bool, cx: &mut Context<Self>) {
        if cx.reduce_motion() {
            self.overlay_slide = None;
            return;
        }
        // The column's copy of the expanded sidebar sliding out goes, so the
        // sidebar is drawn once.
        if open
            && self.column_slide.is_some_and(|slide| slide.leaving == Some(SidebarForm::Expanded))
        {
            self.column_slide = None;
        }
        let width = self.sidebar_rems();
        let generation = self.next_slide();
        self.overlay_slide = Some(Slide {
            from_rems: if open { 0. } else { width },
            to_rems: if open { width } else { 0. },
            generation,
            from_edge: true,
            leaving: (!open).then_some(SidebarForm::Expanded),
        });
        self._overlay_slide_end =
            Some(self.end_slide(generation, |this| &mut this.overlay_slide, cx));
    }

    fn next_slide(&mut self) -> usize {
        self.slides += 1;
        self.slides
    }

    /// Clears the slide `slot` holds once it has run, unless another took
    /// its place.
    fn end_slide(
        &self,
        generation: usize,
        slot: fn(&mut Self) -> &mut Option<Slide>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SIDEBAR_TRANSITION).await;
            this.update(cx, |this, cx| {
                let slide = slot(this);
                if slide.is_some_and(|slide| slide.generation == generation) {
                    *slide = None;
                    cx.notify();
                }
            })
            .ok();
        })
    }

    /// The column's width in rems when it shows `form`.
    fn form_rems(&self, form: SidebarForm, cx: &App) -> f32 {
        match form {
            SidebarForm::Expanded => self.column_rems(),
            SidebarForm::Rail => rail_rems(cx),
            SidebarForm::Hidden => 0.,
        }
    }

    /// The expanded sidebar's width in the preferences' pixels (pixels at
    /// the default UI font size).
    pub fn sidebar_width(&self) -> u16 {
        self.sidebar_width
    }

    /// Sets the expanded sidebar's width (in the preferences' pixels) within
    /// [`SIDEBAR_WIDTHS`] and within what leaves the plate the composer's
    /// width in this window, and saves it once it has stayed a moment.
    pub fn set_sidebar_width(&mut self, width: u16, window: &Window, cx: &mut Context<Self>) {
        let width = clamp_sidebar_width(width.min(self.widest_sidebar(window)));
        if width == self.sidebar_width {
            return;
        }
        self.sidebar_width = width;
        cx.notify();
        self._save_width = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(WIDTH_SAVE_DELAY).await;
            this.update(cx, |this, cx| {
                let width = this.sidebar_width;
                AppPreferences::global(cx)
                    .update(cx, |preferences, cx| preferences.set_sidebar_width(width, cx));
            })
            .ok();
        }));
    }

    /// The widest the sidebar can be in `window` with the plate keeping the
    /// composer's width, in the preferences' pixels (at least the narrowest
    /// width, which a window that narrow collapses instead).
    fn widest_sidebar(&self, window: &Window) -> u16 {
        let rem = window.rem_size();
        let room = window.viewport_size().width / rem - PLATE_MIN_REMS;
        let room = (room * DESIGN_PX_PER_REM).floor().max(0.);
        // Within u16 once clamped.
        room.min(f32::from(*SIDEBAR_WIDTHS.end())) as u16
    }

    /// The expanded sidebar's width in rems.
    fn sidebar_rems(&self) -> f32 {
        f32::from(self.sidebar_width) / DESIGN_PX_PER_REM
    }

    /// A drag of the sidebar's edge to `position`: the edge follows the
    /// pointer, which holds the handle at the canvas margin's middle.
    fn drag_sidebar_edge(
        &mut self,
        event: &DragMoveEvent<SidebarResize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let rem = window.rem_size();
        let edge = event.event.position.x - rem * (PLATE_INSET_REMS / 2.);
        let width = (edge / rem * DESIGN_PX_PER_REM).round();
        self.resizing = true;
        self.move_sidebar_edge(width, window, cx);
        cx.notify();
    }

    /// Moves the sidebar's edge to `width` in the preferences' pixels, as
    /// dragged or stepped to. The expanded sidebar takes the width within
    /// [`SIDEBAR_WIDTHS`], or collapses to the form the setting chooses below
    /// [`COLLAPSE_BELOW`], sliding there as the toggle does and keeping the
    /// width it had; that is the person's collapse, so widening the window
    /// leaves it collapsed. The collapsed one expands at the width once that
    /// reaches the narrowest, so one drag can collapse it and bring it back.
    fn move_sidebar_edge(&mut self, width: f32, window: &Window, cx: &mut Context<Self>) {
        // Within u16 once clamped to the widths there are.
        let to = width.clamp(0., f32::from(*SIDEBAR_WIDTHS.end())) as u16;
        if self.layout.expanded() {
            if width < COLLAPSE_BELOW {
                self.change_layout(|layout| layout.set_collapsed_by_person(true), cx);
            } else {
                self.set_sidebar_width(to, window, cx);
            }
        } else if to >= *SIDEBAR_WIDTHS.start() {
            // The width first, so the column slides out to it.
            self.set_sidebar_width(to, window, cx);
            self.change_layout(|layout| layout.set_collapsed_by_person(false), cx);
        }
    }

    /// Moves the sidebar's edge by `step` of the preferences' pixels (the
    /// focused handle's arrow keys): a step that takes the edge below
    /// [`COLLAPSE_BELOW`] collapses the sidebar, as Desktop's does. On the
    /// collapsed form's edge a step out expands it at its width.
    fn step_sidebar_width(&mut self, step: i32, window: &Window, cx: &mut Context<Self>) {
        if !self.layout.expanded() {
            if step > 0 {
                self.change_layout(|layout| layout.set_collapsed_by_person(false), cx);
            }
            return;
        }
        // The steps are tens of pixels.
        self.move_sidebar_edge(f32::from(self.sidebar_width) + step as f32, window, cx);
    }

    /// Gives the sidebar its default width (a double-click on the handle,
    /// or Enter on it), expanding it if it is collapsed.
    fn restore_sidebar_width(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.set_sidebar_width(DEFAULT_SIDEBAR_WIDTH, window, cx);
        self.change_layout(|layout| layout.set_collapsed_by_person(false), cx);
    }

    fn narrow_sidebar_step(
        &mut self,
        _: &NarrowSidebarStep,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.step_sidebar_width(-RESIZE_STEP, window, cx);
    }

    fn widen_sidebar_step(
        &mut self,
        _: &WidenSidebarStep,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.step_sidebar_width(RESIZE_STEP, window, cx);
    }

    fn narrow_sidebar_large_step(
        &mut self,
        _: &NarrowSidebarLargeStep,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.step_sidebar_width(-RESIZE_LARGE_STEP, window, cx);
    }

    fn widen_sidebar_large_step(
        &mut self,
        _: &WidenSidebarLargeStep,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.step_sidebar_width(RESIZE_LARGE_STEP, window, cx);
    }

    fn reset_sidebar_width(
        &mut self,
        _: &ResetSidebarWidth,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.restore_sidebar_width(window, cx);
    }

    /// Whether Back has a task to show.
    pub fn can_go_back(&self) -> bool {
        self.history.can_go_back()
    }

    /// Whether Forward has a task to show.
    pub fn can_go_forward(&self) -> bool {
        self.history.can_go_forward()
    }

    /// Records a change of the selected task: a visit unless Back or
    /// Forward made it, or a page shows (the page stays; the task is behind
    /// it).
    fn record_selection(&mut self, selected: Option<SharedString>, cx: &mut Context<Self>) {
        let previous = std::mem::replace(&mut self.shown, selected.clone());
        let navigated = self.navigating.take().is_some_and(|target| Some(target) == selected);
        if !navigated && previous != selected && self.page.is_none() {
            self.history.visit(previous.map(Place::Task));
        }
        cx.notify();
    }

    /// What the plate shows now, as history records it.
    fn place(&self) -> Option<Place> {
        match self.page {
            Some(page) => Some(Place::Page(page)),
            None => self.shown.clone().map(Place::Task),
        }
    }

    pub(crate) fn go_back(&mut self, _: &GoBack, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.is_none() {
            self.navigate(true, window, cx);
        }
    }

    pub(crate) fn go_forward(
        &mut self,
        _: &GoForward,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_none() {
            self.navigate(false, window, cx);
        }
    }

    /// Shows the history entry before (`back`) or after the current place,
    /// skipping tasks the catalog no longer lists.
    fn navigate(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let catalog = self.catalog.read(cx);
        let current = self.place();
        let listed = |place: &Place| match place {
            Place::Task(id) => catalog.rows().iter().any(|row| &row.id == id),
            Place::Page(_) => true,
        };
        let target = if back {
            self.history.back(current, listed)
        } else {
            self.history.forward(current, listed)
        };
        match target {
            Some(Place::Page(page)) => self.set_page(Some(page), window, cx),
            Some(Place::Task(id)) => {
                self.set_page(None, window, cx);
                if self.catalog.read(cx).selected_id() != Some(&id) {
                    self.navigating = Some(id.clone());
                    self.catalog.update(cx, |catalog, cx| catalog.select(Some(&id), cx));
                }
                self.shown = Some(id);
            }
            None => {}
        }
        cx.notify();
    }

    /// The page the plate shows instead of the task view.
    pub fn page(&self) -> Option<SidebarPage> {
        self.page
    }

    /// The Extensions page, once it has shown.
    pub fn extensions_view(&self) -> Option<&Entity<ExtensionsView>> {
        self.extensions.as_ref()
    }

    /// The Search page, once it has shown.
    pub fn search_view(&self) -> Option<&Entity<SearchView>> {
        self.search.as_ref()
    }

    /// The Host's scheduled tasks.
    pub fn scheduled_tasks(&self) -> &Entity<ScheduledTasks> {
        &self.scheduled
    }

    /// The Scheduled tasks page, once it has shown.
    pub fn automations_view(&self) -> Option<&Entity<AutomationsView>> {
        self.automations.as_ref()
    }

    /// Shows `page` on the plate, a visit from what showed before, and
    /// gives it focus. From settings, it leaves them first.
    pub fn show_page(&mut self, page: SidebarPage, window: &mut Window, cx: &mut Context<Self>) {
        self.close_settings(window, cx);
        self.close_sidebar_overlay(window, cx);
        if self.page != Some(page) {
            self.history.visit(self.place());
            self.set_page(Some(page), window, cx);
        }
        self.focus_page(window, cx);
    }

    pub(crate) fn open_extensions(
        &mut self,
        _: &OpenExtensions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.show_page(SidebarPage::Extensions, window, cx);
    }

    pub(crate) fn open_scheduled_tasks(
        &mut self,
        _: &OpenScheduledTasks,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.show_page(SidebarPage::ScheduledTasks, window, cx);
    }

    /// ⇧⌘F: shows the Search page and focuses its field, its text
    /// selected; text selected in the window (in a reply, or in the draft)
    /// becomes the query and is searched at once. From settings, it leaves
    /// them first.
    pub(crate) fn search_all_tasks(
        &mut self,
        _: &SearchAllTasks,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let seed = self.selection_seed(window, cx);
        self.show_page(SidebarPage::Search, window, cx);
        if let Some(view) = &self.search {
            view.update(cx, |view, cx| match &seed {
                Some(seed) => view.search_for(seed, window, cx),
                None => view.focus_query(window, cx),
            });
        }
    }

    /// The text selected in the window, as a query: the transcript's
    /// selection, else the draft's while it has focus, its whitespace
    /// folded and cut to [`SEARCH_SEED_MAX_CHARS`].
    fn selection_seed(&self, window: &mut Window, cx: &mut App) -> Option<String> {
        let mut text = TextSelection::selected_text(window, cx);
        if text.trim().is_empty() {
            let draft = self.composer.read(cx).draft().read(cx);
            if draft.focus_handle(cx).is_focused(window) {
                text = draft.selected_value().to_string();
            }
        }
        let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
        (!folded.is_empty()).then(|| folded.chars().take(SEARCH_SEED_MAX_CHARS).collect())
    }

    /// Hands the Search page the tasks the catalog lists, as the sidebar
    /// names them, with their projects.
    fn sync_search_tasks(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.search.clone() else { return };
        let locale = Locale::current(cx);
        let projects = self.projects.read(cx);
        let tasks: Vec<TaskEntry> = self
            .catalog
            .read(cx)
            .rows()
            .iter()
            .map(|row| {
                let project = projects
                    .registered_project(row.project_id.as_deref())
                    .map(|project| project.label())
                    .filter(|label| !label.is_empty());
                TaskEntry::new(row.id.clone(), copy::task_title(locale, &row.name).to_owned())
                    .with_project(project)
                    .archived(row.is_archived)
                    .with_activity_at(row.activity_at)
            })
            .collect();
        // Side chats' forks copy their task's words; their passages go: those
        // the catalog lists, and this client's own before it lists them.
        let mut hidden: std::collections::HashSet<SharedString> =
            self.catalog.read(cx).side_conversations().cloned().collect();
        let ledger = conversation::SideChatLedger::global(cx);
        hidden.extend(
            ledger.read(cx).entries().iter().map(|entry| entry.target_session_id.clone().into()),
        );
        view.update(cx, |view, cx| {
            view.set_tasks(tasks, cx);
            view.set_hidden_sessions(hidden, cx);
        });
    }

    /// What the Search page asks of the window: a task by its title, as
    /// the sidebar opens one; a passage's task, at its message with the
    /// find bar on its term; or, Escape with nothing typed, the task view.
    /// Back returns to the page as it was.
    fn search_event(
        &mut self,
        _: &Entity<SearchView>,
        event: &SearchPageEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SearchPageEvent::OpenTask(id) => {
                self.leave_page(Some(id.clone()), window, cx);
                self.catalog.update(cx, |catalog, cx| catalog.select_when_listed(id.clone(), cx));
                self.composer.update(cx, |composer, cx| composer.focus(window, cx));
            }
            SearchPageEvent::OpenPassage(target) => {
                let id = target.session_id().clone();
                self.leave_page(Some(id.clone()), window, cx);
                self.catalog.update(cx, |catalog, cx| catalog.select_when_listed(id, cx));
                self.conversation
                    .update(cx, |view, cx| view.open_at_passage(target.clone(), window, cx));
            }
            SearchPageEvent::Leave => self.focus_composer(&FocusComposer, window, cx),
            _ => {}
        }
    }

    /// Puts `page` (or the task view) on the plate without recording a
    /// visit; the sidebar marks its entry. The Extensions page is made the
    /// first time and reads its catalog then.
    fn set_page(&mut self, page: Option<SidebarPage>, window: &mut Window, cx: &mut Context<Self>) {
        if page == Some(SidebarPage::Extensions) && self.extensions.is_none() {
            // A remote Host's Skill folders are not this machine's: no local
            // import or Skill locations there.
            let context = ExtensionsContext::new(self.host.clone(), self.projects.clone())
                .local_paths(!self.host.read(cx).is_remote());
            let view = cx.new(|cx| ExtensionsView::new(context, window, cx));
            self._subscriptions.push(cx.observe(&view, |_, _, cx| cx.notify()));
            self.extensions = Some(view);
        }
        if let (Some(SidebarPage::Extensions), Some(view)) = (page, &self.extensions) {
            view.update(cx, |view, cx| view.activate(cx));
        }
        if page == Some(SidebarPage::ScheduledTasks) && self.automations.is_none() {
            let view = cx.new(|cx| AutomationsView::new(self.scheduled.clone(), window, cx));
            self._subscriptions.push(cx.observe(&view, |_, _, cx| cx.notify()));
            self._subscriptions.push(cx.subscribe_in(&view, window, Self::automations_event));
            self.automations = Some(view);
        }
        if let (Some(SidebarPage::ScheduledTasks), Some(view)) = (page, &self.automations) {
            view.update(cx, |view, cx| view.activate(cx));
        }
        if page == Some(SidebarPage::Search) && self.search.is_none() {
            let view = cx.new(|cx| SearchView::new(self.host.clone(), window, cx));
            self._subscriptions.push(cx.observe(&view, |_, _, cx| cx.notify()));
            self._subscriptions.push(cx.subscribe_in(&view, window, Self::search_event));
            self.search = Some(view);
        }
        self.page = page;
        if page.is_some() {
            // A passage still being read for the task view waits no more.
            self.conversation.update(cx, |view, _| view.cancel_landing());
        }
        if page == Some(SidebarPage::Search) {
            self.sync_search_tasks(cx);
        }
        self.sidebar.update(cx, |sidebar, cx| sidebar.set_open_page(page, cx));
        window.set_window_title(&self.title(cx).unwrap_or_else(|| copy::APP_NAME.get(cx).into()));
        cx.notify();
    }

    /// Leaves a page for the task view: a visit from the page. `chosen` is
    /// the task chosen to show, which the history takes as shown already.
    fn leave_page(
        &mut self,
        chosen: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(page) = self.page else {
            return;
        };
        self.history.visit(Some(Place::Page(page)));
        if chosen.is_some() {
            self.shown = chosen;
        }
        self.set_page(None, window, cx);
    }

    /// Gives the page on the plate focus.
    fn focus_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match (self.page, &self.extensions, &self.automations) {
            (Some(SidebarPage::Extensions), Some(view), _) => {
                view.update(cx, |view, cx| view.focus(window, cx))
            }
            (Some(SidebarPage::ScheduledTasks), _, Some(view)) => {
                view.update(cx, |view, cx| view.focus(window, cx))
            }
            (Some(SidebarPage::Search), _, _) => {
                if let Some(view) = &self.search {
                    view.update(cx, |view, cx| view.focus(window, cx));
                }
            }
            _ => {}
        }
    }

    /// What the Scheduled tasks page asks of the window: a task from the
    /// Daily review, the report added to the draft (the page stays, as in
    /// Desktop), or the Daily review settings.
    fn automations_event(
        &mut self,
        _: &Entity<AutomationsView>,
        event: &AutomationsEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            AutomationsEvent::OpenTask(id) => {
                self.leave_page(Some(id.clone()), window, cx);
                self.catalog.update(cx, |catalog, cx| catalog.select(Some(id), cx));
                self.composer.update(cx, |composer, cx| composer.focus(window, cx));
            }
            AutomationsEvent::AppendToComposer(text) => {
                let text = text.clone();
                self.composer.update(cx, |composer, cx| {
                    composer.draft().update(cx, |draft, cx| {
                        let draft_text = append_to_draft(&draft.value(), &text);
                        let end = draft_text.len();
                        draft.set_value(draft_text, window, cx);
                        draft.set_selected_range(end..end, cx);
                    });
                    cx.notify();
                });
            }
            AutomationsEvent::OpenDailyReviewSettings => {
                self.show_settings(SettingsSection::DailyReview, |_, _, _| {}, window, cx);
            }
            _ => {}
        }
    }

    /// Opens the new task's draft: no task selected, the header reads New
    /// task, and the composer takes focus; it replaces a page. Nothing is
    /// asked of the Host: the draft's first message creates the task. From
    /// settings, it leaves them first.
    pub(crate) fn new_session(
        &mut self,
        _: &NewSession,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_settings(window, cx);
        self.sidebar.update(cx, |sidebar, cx| sidebar.new_session(cx));
    }

    pub(crate) fn focus_composer(
        &mut self,
        _: &FocusComposer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_settings(window, cx);
        self.leave_page(None, window, cx);
        self.close_sidebar_overlay(window, cx);
        self.restore_workbar(window, cx);
        self.composer.update(cx, |composer, cx| composer.focus(window, cx));
    }

    /// Sends the draft; not while settings, a page or the maximized changes
    /// panel hide it.
    pub(crate) fn send_message(
        &mut self,
        _: &SendMessage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_none() && self.page.is_none() && !self.workbar_maximized(cx) {
            self.composer.update(cx, |composer, cx| composer.send(window, cx));
        }
    }

    pub(crate) fn stop_turn(&mut self, _: &StopTurn, _: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |composer, cx| composer.stop(cx));
    }

    pub(crate) fn reconnect(&mut self, _: &Reconnect, _: &mut Window, cx: &mut Context<Self>) {
        self.host.update(cx, |host, cx| host.reconnect(cx));
    }

    /// The settings surface, while it shows.
    /// The custom pet and what it is told.
    pub fn pet(&self) -> &Entity<PetWatch> {
        &self.pet
    }

    pub fn settings_view(&self) -> Option<Entity<SettingsView>> {
        self.settings.as_ref().map(|settings| settings.view.clone())
    }

    /// What the settings surface works on in this window.
    fn settings_context(&self) -> SettingsContext {
        let context = SettingsContext::new(
            self.host.clone(),
            self.connections.clone(),
            self.projects.clone(),
            AboutFacts::new(env!("CARGO_PKG_VERSION")),
        );
        match &self.bots {
            Some(bots) => context.with_bots(bots.clone()),
            None => context,
        }
    }

    /// The chat bots Remote access configures.
    pub fn set_bots(&mut self, bots: Entity<BotService>) {
        self.bots = Some(bots);
    }

    /// Shows settings on `section` (or that section in the settings that
    /// show) and runs `then` on them. It happens one effect cycle later, so
    /// that a menu the command came from has closed and given focus back to
    /// its trigger first: that trigger (the footer row, when the command came
    /// from its menu through the keyboard) is what has focus again after
    /// settings, rather than the menu that is about to disappear.
    pub fn show_settings(
        &mut self,
        section: SettingsSection,
        then: impl FnOnce(&mut SettingsView, &mut Window, &mut Context<SettingsView>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.defer_in(window, move |this, window, cx| {
            let view = match this.settings_view() {
                Some(view) => {
                    view.update(cx, |view, cx| view.select(section, cx));
                    view
                }
                None => this.open_settings_surface(section, window, cx),
            };
            view.update(cx, |view, cx| then(view, window, cx));
        });
    }

    /// Puts the settings surface on `section` in place of the sidebar and
    /// the task view, with the section list focused.
    fn open_settings_surface(
        &mut self,
        section: SettingsSection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SettingsView> {
        self.close_sidebar_overlay(window, cx);
        let return_focus = window.focused(cx);
        let context = self.settings_context();
        let view = cx.new(|cx| SettingsView::new(context, section, window, cx));
        let subscriptions = [
            cx.subscribe_in(&view, window, |this, _, event: &SettingsEvent, window, cx| {
                if matches!(event, SettingsEvent::BackToApp) {
                    this.close_settings(window, cx);
                }
            }),
            // A Host the Runtime Host block or the header's picker chose.
            cx.subscribe_in(&view, window, |this, _, event: &settings::SwitchHost, window, cx| {
                this.switch_host(event.profile_id.clone(), window, cx);
            }),
            // A task the Usage page's activity log names: leave settings
            // for it, as the Scheduled tasks page does.
            cx.subscribe_in(&view, window, |this, _, event: &settings::OpenTask, window, cx| {
                // A side chat's fork is no task the window shows: its row
                // opens the task it forks.
                let id = event.session_id.clone();
                let id = this.catalog.read(cx).side_conversation_source(&id).cloned().unwrap_or(id);
                this.close_settings(window, cx);
                this.leave_page(Some(id.clone()), window, cx);
                this.catalog.update(cx, |catalog, cx| catalog.select(Some(&id), cx));
            }),
            // The workbench draws the surface's two halves.
            cx.observe(&view, |_, _, cx| cx.notify()),
        ];
        view.update(cx, |view, cx| view.focus_nav(window, cx));
        self.settings = Some(SettingsSurface {
            view: view.clone(),
            return_focus,
            _subscriptions: subscriptions,
        });
        cx.notify();
        view
    }

    /// Whether settings show.
    pub fn settings_open(&self) -> bool {
        self.settings.is_some()
    }

    /// Leaves settings for the app as it was, giving focus back to what had
    /// it when they opened. A control whose focus lives in its entity (the
    /// draft, the task list, the transcript) takes it again; a button keeps
    /// its focus only while it is drawn, so after one (the footer row, a
    /// composer picker) the composer takes focus, through the focus-lost
    /// fallback.
    pub fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(settings) = self.settings.take() else {
            return;
        };
        match settings.return_focus {
            Some(focus) => window.focus(&focus, cx),
            None => self.composer.update(cx, |composer, cx| composer.focus(window, cx)),
        }
        cx.notify();
    }

    /// Opens settings on the section shown last (Models at first, as Maka
    /// Desktop does), like every settings command one effect cycle later
    /// (see [`Self::show_settings`]).
    pub(crate) fn open_settings(
        &mut self,
        _: &OpenSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let section = settings::remembered_settings_section(cx);
        self.show_settings(section, |_, _, _| {}, window, cx);
    }

    /// Opens settings at Models with the "Add connection" form, its first
    /// field focused; like Settings…, one effect cycle later, so focus
    /// returns to the model picker the command came from.
    pub(crate) fn add_connection(
        &mut self,
        _: &AddConnection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.show_settings(
            SettingsSection::Models,
            |view, window, cx| view.show_add_connection(window, cx),
            window,
            cx,
        );
    }

    /// Opens settings at Workspace, where the projects are (the project
    /// picker's "Manage projects…"), like Settings…, one effect cycle later.
    pub(crate) fn open_project_settings(
        &mut self,
        _: &OpenProjectSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.show_settings(SettingsSection::Projects, |_, _, _| {}, window, cx);
    }

    /// Switches the window to the Runtime Host `profile_id` names (`local`
    /// or a remote profile's id): builds its content again for that Host,
    /// as Switch data folder… does for a State Root, so the sessions,
    /// projects, and connections are read from it, and settings show again
    /// on the same section when they were showing. A Host that cannot be
    /// used (no credential) leaves everything as it was and says why.
    pub fn switch_host(
        &mut self,
        profile_id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(setup), Some(directory)) =
            (self.state_root_setup.clone(), HostDirectory::global(cx))
        else {
            log::info!("switching Runtime Host is not available in this window");
            return;
        };
        if self.host.read(cx).host().profile_id() == profile_id.as_ref() {
            return;
        }
        let root = self.host.read(cx).root().to_owned();
        let section = self.settings_view().map(|view| view.read(cx).section());
        let resolved = directory.read(cx).resolve(&profile_id, cx);
        cx.spawn_in(window, async move |_, cx| {
            let host = resolved.await;
            cx.update(|window, cx| match host {
                Ok(host) => {
                    let workbench = show_workbench_on(&setup, root, host, window, cx);
                    if let Some(section) = section {
                        workbench.update(cx, |workbench, cx| {
                            workbench.show_settings(section, |_, _, _| {}, window, cx)
                        });
                    }
                }
                Err(refusal) => {
                    log::warn!("could not switch to Runtime Host {profile_id}: {refusal:?}");
                    let locale = Locale::current(cx);
                    let title = copy::remote_hosts::SWITCH_FAILED.get(cx);
                    let message = settings::host_refusal_text(&refusal, locale);
                    window.push_notification(
                        gpui_kit::component::notification::Notification::error(message)
                            .title(title),
                        cx,
                    );
                }
            })
            .ok();
        })
        .detach();
    }

    /// [`SwitchHost`] from the footer menu.
    pub(crate) fn switch_host_action(
        &mut self,
        action: &SwitchHost,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch_host(action.profile_id().clone(), window, cx);
    }

    /// Shows a remote Host's folders to add a project from (New project on
    /// a remote Host).
    fn choose_host_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if window.has_active_dialog(cx) {
            return;
        }
        let name = self.host.read(cx).remote_name().unwrap_or_default();
        settings::RemoteDirectoryDialog::open(self.projects.clone(), name, window, cx);
    }

    /// Opens the State Root dialog on the root in use. Like Add Connection,
    /// one effect cycle later, so a menu it came from has closed first.
    pub(crate) fn switch_state_root(
        &mut self,
        _: &SwitchStateRoot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(setup) = self.state_root_setup.clone() else {
            log::info!("Switch data folder is not available in this window");
            return;
        };
        let current = self.host.read(cx).root().to_owned();
        cx.defer_in(window, move |_, window, cx| {
            open_state_root_dialog(setup, Some(current), window, cx);
        });
    }

    /// Expands or collapses the sidebar (while the window is narrow, opens
    /// it over the plate or closes it); not while settings take its place.
    /// Opened over the plate, its task list takes focus; closed, focus that
    /// was in it goes back to the plate.
    pub(crate) fn toggle_sidebar(
        &mut self,
        _: &ToggleSidebar,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() {
            return;
        }
        if self.layout.overlay() {
            self.close_sidebar_overlay(window, cx);
        } else if self.change_layout(SidebarLayout::toggle, cx) {
            let list = self.sidebar.focus_handle(cx);
            list.focus(window, cx);
        }
    }

    /// Opens the command palette over the window, unless a dialog is
    /// already open (overlays do not stack). Like Settings…, one effect
    /// cycle later, so a menu it came from has closed and focus returns to
    /// its trigger when the palette closes.
    pub(crate) fn open_command_palette(
        &mut self,
        _: &OpenCommandPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.defer_in(window, |this, window, cx| {
            if window.has_active_dialog(cx) {
                return;
            }
            let entries = this.palette_entries(cx);
            open_palette(entries, cx.entity().downgrade(), window, cx);
        });
    }

    /// Shows the keyboard shortcuts sheet, unless a dialog is already open.
    /// One effect cycle later, like the palette, so a menu or the palette
    /// it came from has closed first.
    pub(crate) fn show_keyboard_shortcuts(
        &mut self,
        _: &ShowKeyboardShortcuts,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.defer_in(window, |_, window, cx| {
            if !window.has_active_dialog(cx) {
                open_shortcuts(window, cx);
            }
        });
    }

    /// ⌘F: shows the find bar over the conversation and focuses its query,
    /// while the plate shows a conversation to find in.
    pub(crate) fn find_in_conversation(
        &mut self,
        _: &FindInConversation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.shows_conversation(cx) {
            self.conversation.update(cx, |view, cx| view.open_find(window, cx));
        }
    }

    /// ⌘G and ⇧⌘G from the rest of the task view (the composer): the next
    /// or previous match while the find bar shows; else the key goes on.
    fn select_next_match(
        &mut self,
        _: &search::SelectNextMatch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.conversation.update(cx, |view, cx| view.step_find(true, window, cx)) {
            cx.propagate();
        }
    }

    fn select_previous_match(
        &mut self,
        _: &search::SelectPreviousMatch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.conversation.update(cx, |view, cx| view.step_find(false, window, cx)) {
            cx.propagate();
        }
    }

    /// Whether the plate shows the selected task's conversation: no
    /// settings, page, Host blocker, maximized changes panel or empty state
    /// in its place.
    fn shows_conversation(&self, cx: &App) -> bool {
        self.settings.is_none()
            && self.page.is_none()
            && self.host.read(cx).blocker().is_none()
            && !self.workbar_maximized(cx)
            && !self.shows_empty_state(cx)
            && self.conversation.read(cx).has_rows()
    }

    /// Archives the selected task, or unarchives it.
    pub(crate) fn archive_task(&mut self, _: &ArchiveTask, _: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.catalog.read(cx).selected_row() else {
            return;
        };
        let (id, archived) = (row.id.clone(), row.is_archived);
        self.sidebar.update(cx, |sidebar, cx| sidebar.set_archived(&id, !archived, cx));
    }

    /// Flags the selected task, or unflags it.
    pub(crate) fn flag_task(&mut self, _: &FlagTask, _: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.catalog.read(cx).selected_row() else {
            return;
        };
        let (id, flagged) = (row.id.clone(), row.is_flagged);
        self.catalog.update(cx, |catalog, cx| catalog.set_flagged(&id, !flagged, cx));
    }

    /// What the palette lists now: the commands of the table that can run
    /// (Stop only while a turn runs, Back only with somewhere to go back
    /// to, …), then the pickers' choices with the current one checked, the
    /// settings sections, and the tasks by title.
    pub(crate) fn palette_entries(&self, cx: &App) -> Vec<PaletteEntry> {
        let locale = Locale::current(cx);
        let catalog = self.catalog.read(cx);
        let selected = catalog.selected_row();
        let composer = self.composer.read(cx);
        let activity = self.state.read(cx).turn_activity();
        let english = |text: shared::copy::Text| SharedString::from(text.en());
        let mut entries = Vec::new();
        for spec in palette_commands() {
            let mut label = spec.label;
            let icon = spec.icon();
            let runs = match spec.id {
                "archive-task" => selected.is_some_and(|row| {
                    if row.is_archived {
                        label = palette_words::UNARCHIVE_TASK;
                    }
                    true
                }),
                "flag-task" => selected.is_some_and(|row| {
                    if row.is_flagged {
                        label = palette_words::UNFLAG_TASK;
                    }
                    true
                }),
                // What waits while settings show is not offered then.
                "toggle-sidebar" | "go-back" | "go-forward" | "send-message"
                    if self.settings.is_some() =>
                {
                    false
                }
                "toggle-sidebar" => {
                    label = if self.layout.expanded() {
                        copy::SIDEBAR_HIDE
                    } else {
                        copy::SIDEBAR_SHOW
                    };
                    true
                }
                "go-back" => self.history.can_go_back(),
                "go-forward" => self.history.can_go_forward(),
                "stop-turn" => activity == TurnActivity::Running,
                "send-message" if self.page.is_some() => false,
                "send-message" => matches!(
                    composer.action(cx),
                    conversation::ComposerAction::Send { enabled: true, .. }
                ),
                "switch-state-root" => self.state_root_setup.is_some(),
                "find-in-conversation" => self.shows_conversation(cx),
                _ => true,
            };
            if !runs {
                continue;
            }
            let heading = spec.group.heading();
            entries.push(
                PaletteEntry::new(
                    format!("command:{}", spec.id),
                    Section::Commands(spec.group),
                    label.in_locale(locale),
                    icon,
                    PaletteCommand::Action(spec.action()),
                )
                .keywords([english(label), english(spec.label), english(heading)])
                .shortcut(spec.action(), spec.context),
            );
        }
        if composer.model_switchable(cx) {
            for choice in composer.model_choices(cx) {
                entries.push(
                    PaletteEntry::new(
                        format!("model:{}/{}", choice.connection_id, choice.model_id),
                        Section::Model,
                        choice.label.clone(),
                        // A model comes through a connection: the plug.
                        Icon::new(MakaIcon::ToolPlug),
                        PaletteCommand::Model {
                            connection: choice.connection_id.clone(),
                            model: choice.model_id.clone(),
                        },
                    )
                    .keywords([
                        choice.connection.clone(),
                        choice.model_id.clone(),
                        english(palette_words::GROUP_MODEL),
                    ])
                    .checked(choice.current),
                );
            }
        }
        if let Some(current) = composer.permission_mode(cx) {
            for mode in conversation::PERMISSION_MODES {
                entries.push(
                    PaletteEntry::new(
                        format!("permission:{}", mode.as_str()),
                        Section::PermissionMode,
                        conversation::permission_mode_label(&mode, locale),
                        Icon::new(AssetIcon::ShieldCheck),
                        PaletteCommand::PermissionMode(mode.clone()),
                    )
                    .keywords([
                        conversation::permission_mode_label(&mode, Locale::English),
                        english(palette_words::GROUP_PERMISSION_MODE),
                    ])
                    .checked(mode == current),
                );
            }
        }
        let preferences = AppPreferences::current(cx);
        for appearance in Appearance::ALL {
            entries.push(
                PaletteEntry::new(
                    format!("appearance:{}", appearance.key()),
                    Section::Appearance,
                    appearance.label().in_locale(locale),
                    Icon::new(IconName::Palette),
                    PaletteCommand::Appearance(appearance),
                )
                .keywords([english(appearance.label()), english(palette_words::GROUP_APPEARANCE)])
                .checked(appearance == preferences.appearance),
            );
        }
        for language in Language::ALL {
            entries.push(
                PaletteEntry::new(
                    format!("language:{}", language.key()),
                    Section::Language,
                    language.label(locale),
                    Icon::new(AssetIcon::Languages),
                    PaletteCommand::Language(language),
                )
                .keywords([
                    SharedString::from(language.label(Locale::English)),
                    english(palette_words::GROUP_LANGUAGE),
                ])
                .checked(language == preferences.language),
            );
        }
        for section in SettingsSection::listed() {
            entries.push(
                PaletteEntry::new(
                    format!("settings:{}", section.key()),
                    Section::Settings,
                    section.label().in_locale(locale),
                    section.icon(),
                    PaletteCommand::Settings(section),
                )
                .keywords([english(section.label()), english(settings_copy::SETTINGS)]),
            );
        }
        for row in catalog.rows().iter().filter(|row| !row.is_archived) {
            entries.push(
                PaletteEntry::new(
                    format!("task:{}", row.id),
                    Section::Tasks,
                    copy::task_title(locale, &row.name).to_owned(),
                    Icon::new(AssetIcon::MessageSquare),
                    PaletteCommand::OpenTask(row.id.clone()),
                )
                .keywords([english(palette_words::GROUP_OPEN_TASK)])
                .checked(selected.is_some_and(|selected| selected.id == row.id)),
            );
        }
        entries
    }

    /// Runs what the palette chose, after it closed and focus returned.
    pub(crate) fn run_palette_command(
        &mut self,
        command: PaletteCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match command {
            // Dispatched to what has focus now, as its key binding would be.
            PaletteCommand::Action(action) => window.dispatch_action(action, cx),
            PaletteCommand::OpenTask(id) => {
                self.close_settings(window, cx);
                self.leave_page(Some(id.clone()), window, cx);
                self.catalog.update(cx, |catalog, cx| catalog.select(Some(&id), cx));
                self.composer.update(cx, |composer, cx| composer.focus(window, cx));
            }
            PaletteCommand::Settings(section) => {
                self.show_settings(section, |_, _, _| {}, window, cx);
            }
            PaletteCommand::Model { connection, model } => {
                self.composer
                    .update(cx, |composer, cx| composer.select_model(&connection, &model, cx));
            }
            PaletteCommand::PermissionMode(mode) => {
                self.composer.update(cx, |composer, cx| composer.select_permission_mode(mode, cx));
            }
            PaletteCommand::Appearance(appearance) => settings::choose_appearance(appearance, cx),
            PaletteCommand::Language(language) => settings::choose_language(language, cx),
        }
    }

    /// Whether the main pane shows the empty state instead of the
    /// conversation: no task is selected, or the selected task's transcript
    /// has loaded without a turn and nothing is starting.
    fn shows_empty_state(&self, cx: &App) -> bool {
        let state = self.state.read(cx);
        match state.phase() {
            ConversationPhase::Idle => true,
            ConversationPhase::Failed(_) | ConversationPhase::Ended(_) => false,
            _ => {
                let empty = state.transcript().is_some_and(|transcript| {
                    transcript.turns().is_empty() && !transcript.has_older_history()
                });
                empty
                    && matches!(
                        state.turn_activity(),
                        TurnActivity::Idle | TurnActivity::Unavailable
                    )
            }
        }
    }

    /// The selected task's title, as the header and the window title show
    /// it, New task for the new task's draft, or the page's while one
    /// shows.
    fn title(&self, cx: &App) -> Option<SharedString> {
        if let Some(page) = self.page {
            return Some(page.title().get(cx).into());
        }
        let catalog = self.catalog.read(cx);
        if catalog.selected_id().is_none() {
            return Some(copy::NEW_TASK.get(cx).into());
        }
        let row = catalog.selected_row()?;
        Some(copy::task_title(Locale::current(cx), &row.name).to_owned().into())
    }

    /// The window controls beside the traffic lights: the sidebar toggle,
    /// Back, and Forward, as 28px ghost icon buttons in muted ink, with
    /// accessible names and tooltips that carry the shortcut. They sit in
    /// the sidebar's top strip, or in the plate header while the sidebar is
    /// hidden.
    fn render_window_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        // One plain panel icon in both states, as AllSum draws it; the
        // accessible name and the tooltip say what a click does.
        let label = if self.layout.expanded() { copy::SIDEBAR_HIDE } else { copy::SIDEBAR_SHOW };
        let label = label.get(cx);
        let maka = cx.maka();
        // The icon's colour is set here, so a control with nowhere to go
        // takes the disabled ink itself (gpui-kit's own dimming does not
        // reach an icon given a colour).
        let control = |id: &'static str, icon: MakaIcon, enabled: bool| {
            let ink = if enabled { maka.ink_muted } else { maka.ink_disabled };
            Button::new(id)
                .ghost()
                .small()
                .size_7()
                .disabled(!enabled)
                .icon(Icon::new(icon).size_4().text_color(ink))
        };
        h_flex()
            .id("window-controls")
            .flex_shrink_0()
            .gap_0p5()
            .child(
                control("sidebar-toggle", MakaIcon::Sidebar, true)
                    .accessibility_label(label)
                    .tooltip_with_action(label, &ToggleSidebar, None)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_sidebar(&ToggleSidebar, window, cx);
                    })),
            )
            .child(
                control("go-back", MakaIcon::ChevronLeft, self.history.can_go_back())
                    .accessibility_label(copy::GO_BACK.get(cx))
                    .tooltip_with_action(copy::GO_BACK.get(cx), &GoBack, None)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.go_back(&GoBack, window, cx);
                    })),
            )
            .child(
                control("go-forward", MakaIcon::ChevronRight, self.history.can_go_forward())
                    .accessibility_label(copy::GO_FORWARD.get(cx))
                    .tooltip_with_action(copy::GO_FORWARD.get(cx), &GoForward, None)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.go_forward(&GoForward, window, cx);
                    })),
            )
            .into_any_element()
    }

    /// Where the selected task runs, or `None` with no task, or for a
    /// task in no project whose folder has no name (a root such as `/`),
    /// where Desktop's title bar shows no project either.
    fn task_folder(&self, cx: &App) -> Option<TaskFolder> {
        let row = self.catalog.read(cx).selected_row()?;
        let name = self
            .projects
            .read(cx)
            .registered_project(row.project_id.as_deref())
            .map(|project| project.label())
            .filter(|name| !name.is_empty())
            .or_else(|| path_name(&row.workspace_path).map(|name| name.to_owned().into()))?;
        Some(TaskFolder { name, path: row.workspace_path.clone() })
    }

    /// The ghost folder button before the task's title (Desktop's
    /// `TitlebarSessionIdentity`): a 28px icon button in muted ink, named
    /// and tipped Project information, that opens the project menu below
    /// it.
    fn render_project_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.task_folder(cx)?;
        let label = copy::PROJECT_INFO.get(cx);
        let button = Button::new("project-info")
            .ghost()
            .small()
            .size_7()
            .icon(Icon::new(MakaIcon::Folder).size_4().text_color(cx.maka().ink_muted))
            .accessibility_label(label)
            .tooltip(label)
            .selected(self.project_menu.is_open())
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                let width = window.rem_size() * PROJECT_MENU_MIN_WIDTH_REMS;
                MenuSlot::toggle(
                    this,
                    |this| &mut this.project_menu,
                    event,
                    |this, cx| this.project_menu_entries(cx),
                    width,
                    window,
                    cx,
                );
            }));
        Some(
            div()
                .relative()
                .flex_shrink_0()
                .child(button)
                .children(self.project_menu.layer())
                .into_any_element(),
        )
    }

    /// The project menu, as Desktop's: the project's name over its folder
    /// (when the folder reads differently), Open project folder while the
    /// window's Host is on this machine, and Copy path.
    fn project_menu_entries(&self, cx: &App) -> Vec<MenuEntry> {
        let Some(TaskFolder { name, path }) = self.task_folder(cx) else {
            return Vec::new();
        };
        let mut heading = MenuHeading::new(name.clone());
        if !path.is_empty() && path != name {
            heading = heading.path(path.clone());
        }
        let mut entries = vec![heading.into()];
        if path.is_empty() {
            return entries;
        }
        if !self.host.read(cx).is_remote() {
            let (opener, path) = (self.folder_opener.clone(), path.clone());
            entries.push(
                MenuItem::new("open-project-folder", copy::OPEN_PROJECT_FOLDER.get(cx))
                    .icon(Icon::new(AssetIcon::FolderOpen))
                    .on_select(move |_, cx| opener(Path::new(path.as_ref()), cx))
                    .into(),
            );
        }
        entries.push(
            MenuItem::new("copy-project-path", copy::COPY_PROJECT_PATH.get(cx))
                .icon(Icon::new(MakaIcon::Copy))
                .on_select(move |_, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(path.to_string()));
                })
                .into(),
        );
        entries
    }

    /// Opens the selected task's project menu, as a click on its folder
    /// button does (for `--open-project-menu` captures); `false` while the
    /// task has no folder button.
    pub fn open_project_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.task_folder(cx).is_none() {
            return false;
        }
        let entries = self.project_menu_entries(cx);
        let width = window.rem_size() * PROJECT_MENU_MIN_WIDTH_REMS;
        MenuSlot::open(self, |this| &mut this.project_menu, entries, width, window, cx);
        true
    }

    /// The project menu, while it is open.
    pub fn project_menu_open(&self) -> bool {
        self.project_menu.is_open()
    }

    /// The main pane's header: the selected task's title after the folder
    /// button that says where it runs, and the window's drag region.
    /// Beside the sidebar, whose top strip holds the traffic lights and the
    /// window controls, it shows only those two. While the sidebar is
    /// hidden the header starts at the window's edge, keeps `TitleBar`'s
    /// own leading inset for the traffic lights (macOS), and takes the
    /// window controls first.
    ///
    /// While a page shows, the row is window chrome only: the page draws
    /// its own title, count and controls at the top of its column, as the
    /// settings pages do (review round 9).
    ///
    /// While settings show, it is only the drag region above the page: the
    /// page has its own title, and the navigation holds the way back.
    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = self.settings.is_some();
        let chrome_only = settings || self.page.is_some();
        let title =
            if chrome_only { SharedString::default() } else { self.title(cx).unwrap_or_default() };
        // Beside a rail or nothing, the header holds the window controls;
        // the sidebar over the plate has its own.
        let collapsed = self.shown_form != SidebarForm::Expanded;
        let controls = (collapsed && !self.layout.overlay() && !settings)
            .then(|| self.render_window_controls(cx));
        // The changes panel's button ends the task view's header.
        let review = (!chrome_only).then(|| self.render_review_button(cx)).flatten();
        // The plate shows through: a header fill would paint square corners
        // over the plate's rounded ones. No divider under it. The changes
        // panel's button at its end puts its glyph's ink on the plate's 16 px
        // line, as the panel's own bar does.
        let trailing =
            ink_padding(PLATE_LINE_REMS, ICON_BUTTON_REMS, ICON_GLYPH_REMS, ink::FILE_DIFF);
        div().id("main-header").test_support().child(
            TitleBar::new()
                .h(rems(CHROME_HEIGHT_REMS))
                .when(self.shown_form != SidebarForm::Hidden || settings, |this| this.pl_5())
                .pr(rems(trailing))
                .bg(cx.theme().transparent)
                .border_b_0()
                .child(h_flex().flex_1().min_w_0().gap_2().children(controls).map(|this| {
                    if chrome_only {
                        return this.child(div().flex_1());
                    }
                    this.children(self.render_project_button(cx))
                        .child(
                            div()
                                .id("session-title")
                                .test_support()
                                .role(Role::Heading)
                                .aria_label(title.clone())
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_sm()
                                .font_semibold()
                                .text_color(cx.maka().ink)
                                .child(title),
                        )
                        .children(review)
                })),
        )
    }

    /// What the footer row (and the rail's Host button) says the Host's
    /// state is: the spoken label, which names the Host, its state and its
    /// data folder, and the dot's colour.
    fn host_status(&self, cx: &App) -> (String, Hsla) {
        let host = self.host.read(cx);
        let status = host.status();
        let root = host.host_badge();
        let locale = Locale::current(cx);
        let label = match host.remote_name() {
            Some(name) => copy::remote_hosts::remote_footer_label(
                locale,
                &name,
                status.label().get(cx),
                &root,
            ),
            None => copy::footer_label(locale, status.label().get(cx), &root),
        };
        let maka = cx.maka();
        let dot = match status {
            ConnectionStatus::Connected => maka.success,
            ConnectionStatus::Disconnected { retry: RetryState::Suspended, .. } => maka.destructive,
            _ => maka.warning,
        };
        (label, dot)
    }

    /// The sidebar footer: one row that says which Host the window talks
    /// to and whether it is connected, with the State Root's folder name as
    /// a badge. The state is an 8px dot (success connected, warning while
    /// connecting or reconnecting, destructive once retrying stopped) and
    /// words whenever it is not connected, so it never rests on colour
    /// alone; the disconnected strip in the main pane says what to do.
    ///
    /// The row is a Button: a click, or Enter or Space once it has focus,
    /// opens the footer menu above it; Escape closes the menu and focus
    /// returns to where it was (the row, on the keyboard path).
    fn render_footer(
        &self,
        width_rems: f32,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (label, dot) = self.host_status(cx);
        let host = self.host.read(cx);
        let status = host.status();
        // The State Root's folder for the local Host, where a remote one
        // points for a remote Host.
        let root = host.host_badge();
        let name: SharedString =
            host.remote_name().unwrap_or_else(|| copy::HOST_LOCAL_SHORT.get(cx).into());
        // Where the Host is: a remote one's endpoint, the local one's data
        // folder in full.
        let endpoint: SharedString =
            if host.is_remote() { root.clone() } else { host.root().display().to_string().into() };
        let word = (!status.is_connected()).then(|| status.label().get(cx));
        let fit = footer_fit(window, width_rems, &name, word, &root);
        let maka = cx.maka();
        let row = Button::new("sidebar-footer")
            .ghost()
            .w_full()
            .h(rems(FOOTER_ROW_HEIGHT_REMS))
            // The dot sits 12px in (centred in its 16px lane past the 8px
            // side), so the badge ends 12px in as well.
            .pl_2()
            .pr_3()
            .justify_start()
            .accessibility_label(label)
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_2()
                    .text_sm()
                    .text_color(maka.ink)
                    .child(
                        h_flex().size_4().flex_shrink_0().justify_center().child(
                            div()
                                .id("host-status-dot")
                                .test_support()
                                .size_2()
                                .rounded_full_style(cx)
                                .bg(dot),
                        ),
                    )
                    .child(
                        // The name comes first and keeps 80px (or what
                        // `footer_fit` leaves it); the state's words never
                        // shrink.
                        h_flex()
                            .flex_1()
                            .min_w(fit.group_min)
                            .gap_2()
                            .child(div().min_w_0().truncate().child(name))
                            .children(word.map(|word| {
                                div()
                                    .id("host-status-word")
                                    .test_support()
                                    .flex_shrink_0()
                                    .text_xs()
                                    .text_color(maka.ink_muted)
                                    .child(word)
                            })),
                    )
                    // At the row's end, at most 104px with its own ellipsis,
                    // and the first to give way; the whole of it is the
                    // row's tooltip.
                    .children(fit.badge_min.map(|least| {
                        badge(root.clone(), cx)
                            .id("host-status-badge")
                            .test_support()
                            .flex_shrink(1.)
                            .min_w(least)
                            .max_w(px(FOOTER_BADGE_MAX_WIDTH))
                    })),
            )
            .tooltip(endpoint)
            .selected(self.footer_menu.is_some())
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                this.toggle_footer_menu(event, window, cx);
            }));
        // Settings one click away, where Maka Desktop's footer has it; the
        // row's menu keeps Language, Appearance and the data folder.
        let settings_label = settings_copy::SETTINGS.get(cx);
        let settings = Button::new("footer-settings")
            .ghost()
            .small()
            .size_7()
            .flex_shrink_0()
            .icon(Icon::new(MakaIcon::Settings).size_4().text_color(maka.ink_muted))
            .accessibility_label(settings_label)
            .tooltip_with_action(settings_label, &OpenSettings, None)
            .on_click(cx.listener(|this, _, window, cx| {
                this.open_settings(&OpenSettings, window, cx);
            }));
        // A column, so the row takes the width; its insets above and below
        // match the plate's. The menu hangs 8px above the row.
        v_flex()
            .id("host-status")
            .test_support()
            .flex_shrink_0()
            .px_2()
            .py(rems(PLATE_INSET_REMS))
            .justify_center()
            .child(
                h_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .relative()
                            .flex_1()
                            .min_w_0()
                            .child(row)
                            .when_some(self.footer_menu.as_ref(), |this, (menu, _)| {
                                this.child(menu_layer(menu, MenuPlacement::Above))
                            }),
                    )
                    .child(settings),
            )
    }

    /// The footer menu, while it is open.
    pub fn footer_menu(&self) -> Option<&Entity<Menu>> {
        self.footer_menu.as_ref().map(|(menu, _)| menu)
    }

    /// Whether the footer menu is open.
    pub fn footer_menu_open(&self) -> bool {
        self.footer_menu.is_some()
    }

    /// The footer row's click: opens the footer menu, or closes it when it
    /// is open (a press on the row that closed it counts as open).
    fn toggle_footer_menu(
        &mut self,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some((menu, _)) = self.footer_menu.take() {
            menu.update(cx, |menu, cx| menu.close(window, cx));
            cx.notify();
            return;
        }
        if !reopens_on(event, self.footer_menu_closed_at.take()) {
            return;
        }
        self.open_footer_menu(window, cx);
    }

    /// Opens the footer menu (closing nothing; see `toggle_footer_menu`).
    pub fn open_footer_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.footer_menu.is_some() {
            return;
        }
        let width = window.rem_size() * (self.column_rems() - FOOTER_MENU_INSET_REMS);
        let current = self.host.read(cx).host().profile_id().to_owned();
        let menu = Menu::new(footer_menu_entries(&current, cx), cx).min_w(width).open(window, cx);
        let dismiss = cx.subscribe(&menu, |this, menu, _: &DismissEvent, cx| {
            if this.footer_menu.take_if(|(open, _)| *open == menu).is_some() {
                this.footer_menu_closed_at = menu.read(cx).closed_by_press_at();
                cx.notify();
            }
        });
        self.footer_menu = Some((menu, dismiss));
        cx.notify();
    }

    /// The sidebar column: a top strip that holds the traffic lights and
    /// the window controls and moves the window, the sidebar view, and the
    /// Host footer. It owns the width. It sits on the canvas with no divider:
    /// the plate's fill step is the separator.
    /// A copy sliding out to nothing (`controls` false) leaves the window
    /// controls to the header, which has them already.
    fn render_sidebar(
        &self,
        width_rems: f32,
        controls: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let controls = controls.then(|| self.render_window_controls(cx));
        v_flex()
            .id("sidebar-column")
            .test_support()
            .w(rems(width_rems))
            .h_full()
            .flex_shrink_0()
            .bg(cx.maka().canvas)
            .child(self.render_chrome_strip("sidebar-chrome", controls, cx))
            .child(v_flex().flex_1().min_h_0().child(self.sidebar.clone()))
            .child(self.render_footer(width_rems, window, cx))
    }

    /// The handle on the edge of the column beside the plate, the expanded
    /// sidebar or the rail: a 6px hit area in the canvas margin between the
    /// column and the plate, below the chrome band (whose drag moves the
    /// window), with the column-resize cursor. Nothing shows until the
    /// pointer is on it or it has keyboard focus; then Desktop's grip, a 3
    /// by 32 pill in the border tone, stronger while it is dragged. A drag
    /// moves the edge ([`Self::move_sidebar_edge`]: past the narrowest width
    /// it collapses the sidebar, and from the rail it expands it again), a
    /// double-click restores the default width. Focused (a Tab stop after
    /// the rest of the window), Left and Right move the edge by 10, with
    /// Shift by 50, and Enter restores the default width.
    fn render_resize_handle(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let rem = window.rem_size();
        let middle = rem * (self.form_rems(self.shown_form, cx) + PLATE_INSET_REMS / 2.);
        let dragging = self.resizing && cx.has_active_drag();
        let keyboard = self.resize_focus.is_focused(window) && window.last_input_was_keyboard();
        let pill = div()
            .w(px(3.))
            .h(rems(2.))
            .rounded_full()
            .bg(if dragging { maka.border_strong } else { maka.border })
            .when(!dragging && !keyboard, |this| {
                this.invisible().group_hover("sidebar-resize", |this| this.visible())
            });
        div()
            .id("sidebar-resize")
            .test_support()
            .role(Role::Splitter)
            .aria_label(copy::RESIZE_SIDEBAR.get(cx))
            .track_focus(&self.resize_focus)
            .key_context(SIDEBAR_RESIZE_CONTEXT)
            .on_action(cx.listener(Self::narrow_sidebar_step))
            .on_action(cx.listener(Self::widen_sidebar_step))
            .on_action(cx.listener(Self::narrow_sidebar_large_step))
            .on_action(cx.listener(Self::widen_sidebar_large_step))
            .on_action(cx.listener(Self::reset_sidebar_width))
            .absolute()
            .top(rems(CHROME_HEIGHT_REMS + PLATE_INSET_REMS))
            .bottom_0()
            .left(middle - px(RESIZE_HANDLE_WIDTH / 2.))
            .w(px(RESIZE_HANDLE_WIDTH))
            .flex()
            .items_center()
            .justify_center()
            .group("sidebar-resize")
            .cursor_col_resize()
            .when(keyboard, |this| this.focus_ring_style(window, cx))
            .on_drag(SidebarResize, |drag, _, _, cx| cx.new(|_| *drag))
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                if event.click_count() >= 2 {
                    this.restore_sidebar_width(window, cx);
                }
            }))
            .child(pill)
            .into_any_element()
    }

    /// The column beside the plate: the sidebar, the rail, or nothing, and
    /// while it changes, the slot sliding between their widths (the kit
    /// sidebar's clip-width transition: the new content at its own width at
    /// once, the slot's width eased; sliding out to nothing, what leaves
    /// stays until the slot has closed).
    fn render_column(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let slide = self.column_slide;
        let content = match slide.and_then(|slide| slide.leaving).unwrap_or(self.shown_form) {
            SidebarForm::Expanded => {
                let controls = self.shown_form == SidebarForm::Expanded;
                let width = self.column_rems();
                Some(self.render_sidebar(width, controls, window, cx).into_any_element())
            }
            SidebarForm::Rail => Some(self.render_rail(window, cx)),
            SidebarForm::Hidden => None,
        };
        let Some(slide) = slide else {
            return content;
        };
        let rem = window.rem_size();
        let slot = div()
            .id("sidebar-slot")
            .test_support()
            .flex()
            .h_full()
            .flex_shrink_0()
            .overflow_hidden()
            .when(slide.from_edge, |this| this.justify_end())
            .children(content);
        Some(
            EffectTransition::new(SIDEBAR_TRANSITION)
                .ease(ease_in_out_cubic)
                .width(rem * slide.from_rems, rem * slide.to_rems)
                .apply(
                    slot,
                    ElementId::NamedInteger("sidebar-slot".into(), slide.generation as u64),
                )
                .into_any_element(),
        )
    }

    /// The sidebar collapsed to its icons. The top band holds the traffic
    /// lights (the window controls move to the plate's header, as when the
    /// sidebar hides); then New task, Extensions, Scheduled tasks and
    /// Search, and at the foot the Host's state (its dot) and Settings:
    /// 32px ghost buttons named and tipped with what they do and their
    /// shortcut. The page the plate shows has the selected fill. The Host
    /// button opens the footer menu above it.
    fn render_rail(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let new_task: SharedString = copy::NEW_TASK.get(cx).into();
        let compose = Icon::new(MakaIcon::Compose);
        let new_task = self
            .rail_button("rail-new-task".into(), "new-task", compose, new_task.clone(), window, cx)
            .tooltip_with_action(new_task, &NewSession, None)
            .on_click(cx.listener(|this, _, window, cx| this.new_session(&NewSession, window, cx)));
        let new_task = self.rail_hop("new-task", new_task, cx);
        let mut pages = Vec::new();
        for page in SidebarPage::LISTED {
            let title: SharedString = page.title().get(cx).into();
            let id = domain_element_id("rail-page", page.key());
            let button = self
                .rail_button(id, page.key(), page.icon(), title.clone(), window, cx)
                .tooltip_with_action(title, page.action().as_ref(), None)
                .selected(self.page == Some(page))
                .on_click(move |_, window, cx| window.dispatch_action(page.action(), cx));
            pages.push(self.rail_hop(page.key(), button, cx));
        }
        let search: SharedString = search_copy::SEARCH_ALL_TASKS.get(cx).into();
        let magnifier = Icon::new(MakaIcon::Search);
        let search = self
            .rail_button("rail-search".into(), "search", magnifier, search.clone(), window, cx)
            .tooltip_with_action(search, &SearchAllTasks, None)
            .selected(self.page == Some(SidebarPage::Search))
            .on_click(|_, window, cx| window.dispatch_action(SearchAllTasks.boxed_clone(), cx));
        let search = self.rail_hop("search", search, cx);
        let (label, dot) = self.host_status(cx);
        let host = Button::new("rail-host-status")
            .ghost()
            .small()
            .size_8()
            .accessibility_label(label.clone())
            .tooltip(label)
            .selected(self.footer_menu.is_some())
            .child(div().id("rail-host-dot").test_support().size_2().rounded_full_style(cx).bg(dot))
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                this.toggle_footer_menu(event, window, cx);
            }));
        // Over the plate, the sidebar's own footer holds the menu.
        let menu = self.footer_menu.as_ref().filter(|_| !self.layout.overlay());
        let settings_label: SharedString = settings_copy::SETTINGS.get(cx).into();
        let gear = Icon::new(MakaIcon::Settings);
        let settings = self
            .rail_button(
                "rail-settings".into(),
                "settings",
                gear,
                settings_label.clone(),
                window,
                cx,
            )
            .tooltip_with_action(settings_label, &OpenSettings, None)
            .on_click(
                cx.listener(|this, _, window, cx| this.open_settings(&OpenSettings, window, cx)),
            );
        let settings = self.rail_hop("settings", settings, cx);
        v_flex()
            .id("sidebar-rail")
            .test_support()
            .aria_label(pages_copy::MAIN_NAVIGATION.get(cx))
            .w(rems(rail_rems(cx)))
            .h_full()
            .flex_shrink_0()
            .bg(maka.canvas)
            .child(self.render_chrome_strip("rail-chrome", None, cx))
            .child(v_flex().items_center().gap_1().child(new_task).children(pages).child(search))
            .child(div().flex_1())
            .child(
                v_flex()
                    .items_center()
                    .gap_1()
                    .pb(rems(PLATE_INSET_REMS))
                    .child(div().relative().child(host).when_some(menu, |this, (menu, _)| {
                        this.child(menu_layer(menu, MenuPlacement::Above))
                    }))
                    .child(settings),
            )
            .into_any_element()
    }

    /// One of the rail's 32px ghost buttons: `icon` in muted ink (where its
    /// hop, as `key`, has it), named `label`. [`Self::rail_hop`] puts it in
    /// the box that starts the hop.
    fn rail_button(
        &self,
        id: ElementId,
        key: &'static str,
        icon: Icon,
        label: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Button {
        let icon = icon.size_4().text_color(cx.maka().ink_muted);
        Button::new(id)
            .ghost()
            .small()
            .size_8()
            .icon(self.rail_hops.icon(key, icon, window, cx))
            .accessibility_label(label)
    }

    /// `button` in a box that hops its icon (`key`) as the pointer enters:
    /// the button's tooltip takes the button's own hover.
    fn rail_hop(&self, key: &'static str, button: Button, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id(ElementId::Name(format!("rail-hop-{key}").into()))
            .flex()
            .on_hover(cx.listener(move |this, entered: &bool, _, cx| {
                if *entered && this.rail_hops.enter(key, cx) {
                    cx.notify();
                }
            }))
            .child(button)
            .into_any_element()
    }

    /// The expanded sidebar over the plate, opened while the window is
    /// narrow (the kit's offcanvas sidebar): it slides in from the window's
    /// edge over a clear layer that closes it on a press, and Escape closes
    /// it too.
    fn render_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let open = self.layout.overlay();
        let slide = self.overlay_slide;
        if self.settings.is_some() || (!open && slide.is_none()) {
            return Vec::new();
        }
        let maka = cx.maka();
        let mut layers = Vec::new();
        if open {
            let close = |this: &mut Self,
                         _: &gpui_kit::MouseDownEvent,
                         window: &mut Window,
                         cx: &mut Context<Self>| {
                this.close_sidebar_overlay(window, cx);
            };
            layers.push(
                div()
                    .id("sidebar-overlay-scrim")
                    .test_support()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .occlude()
                    .on_mouse_down(MouseButton::Left, cx.listener(close))
                    .on_mouse_down(MouseButton::Right, cx.listener(close))
                    .into_any_element(),
            );
        }
        let panel = div()
            .id("sidebar-overlay")
            .test_support()
            .key_context(SIDEBAR_OVERLAY_CONTEXT)
            .track_focus(&self.overlay_focus)
            .on_action(cx.listener(Self::close_overlay_action))
            .absolute()
            .top_0()
            .left_0()
            .h_full()
            .flex()
            .justify_end()
            .overflow_hidden()
            .occlude()
            .shadow(floating_shadow(&maka, cx.theme().is_dark()))
            .when(slide.is_none(), |this| this.w(rems(self.sidebar_rems())))
            .child(self.render_sidebar(self.sidebar_rems(), true, window, cx));
        layers.push(match slide {
            Some(slide) => {
                let rem = window.rem_size();
                EffectTransition::new(SIDEBAR_TRANSITION)
                    .ease(ease_in_out_cubic)
                    .width(rem * slide.from_rems, rem * slide.to_rems)
                    .apply(
                        panel,
                        ElementId::NamedInteger("sidebar-overlay".into(), slide.generation as u64),
                    )
                    .into_any_element()
            }
            None => panel.into_any_element(),
        });
        layers
    }

    /// The top of the sidebar column: the band that holds the traffic
    /// lights (and `controls` beside them) and moves the window. The band
    /// starts below the plate inset, so the traffic lights and the controls
    /// share the header's centre line; the inset above it still moves the
    /// window.
    fn render_chrome_strip(
        &self,
        id: &'static str,
        controls: Option<AnyElement>,
        cx: &App,
    ) -> impl IntoElement {
        let canvas = cx.maka().canvas;
        div().id(id).test_support().child(
            TitleBar::new()
                .h(rems(CHROME_HEIGHT_REMS + PLATE_INSET_REMS))
                .pt(rems(PLATE_INSET_REMS))
                .bg(canvas)
                .border_b_0()
                .child(h_flex().flex_1().children(controls)),
        )
    }

    /// The sidebar column while settings show: the same strip (without the
    /// task view's controls, which wait) over the settings navigation, which
    /// ends on the plate's inset.
    fn render_settings_column(
        &self,
        settings: &Entity<SettingsView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let nav = settings.update(cx, |view, cx| view.render_nav(window, cx));
        v_flex()
            .id("settings-column")
            .test_support()
            .w_64()
            .h_full()
            .flex_shrink_0()
            .bg(cx.maka().canvas)
            .child(self.render_chrome_strip("sidebar-chrome", None, cx))
            .child(v_flex().flex_1().min_h_0().pb(rems(PLATE_INSET_REMS)).child(nav))
    }

    /// The page on the plate, under the header row; its title is the
    /// header's.
    fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match (self.page, &self.extensions, &self.automations) {
            (Some(SidebarPage::Extensions), Some(view), _) => {
                view.update(cx, |view, cx| view.render_page(window, cx))
            }
            (Some(SidebarPage::ScheduledTasks), _, Some(view)) => {
                view.update(cx, |view, cx| view.render_page(window, cx))
            }
            (Some(SidebarPage::Search), _, _) if let Some(view) = &self.search => {
                view.update(cx, |view, cx| view.render_page(window, cx))
            }
            _ => div().flex_1().min_h_0().into_any_element(),
        }
    }

    /// The screen that explains a [`workspace::HostBlocker`], when the Host
    /// session has one.
    fn render_host_blocked(&self, cx: &App) -> Option<AnyElement> {
        let host = self.host.read(cx);
        let blocker = host.blocker()?.clone();
        let retrying = matches!(
            host.status(),
            ConnectionStatus::Disconnected { retry: RetryState::Attempting { .. }, .. }
        );
        let checkout = host.maka_checkout().map(ToOwned::to_owned);
        Some(HostBlockedScreen::new(blocker, checkout, retrying).into_any_element())
    }

    /// The non-blocking strip shown while there is no connection: a spinner
    /// while the window starts a Host for its State Root, otherwise why the
    /// last attempt failed, Retry, and the manual command as a fallback. The
    /// rest of the window keeps its last content.
    /// The connection's state over the plate's content, in its column
    /// (`column_rems` wide, the reading column or the page's), with no
    /// line under it: while a Host starts, a muted spinner line; once it is
    /// disconnected, DESIGN.md's tinted surface (the warning's 0.24 tint, a
    /// `border` ring, radius 10, padding 12/16) whose icon alone is in
    /// warning ink and whose words are in ink: the title 14/600 with Retry
    /// at its end, what happens next at 14, the reason as machine text
    /// (compact mono 12/20), and for the local Host the command that starts
    /// one by hand.
    fn render_connection_strip(
        &self,
        column_rems: f32,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let maka = cx.maka();
        let host = self.host.read(cx);
        let column = |content: AnyElement| {
            div()
                .flex_shrink_0()
                .w_full()
                .px_6()
                .pb_2()
                .child(div().w_full().max_w(rems(column_rems)).mx_auto().child(content))
                .into_any_element()
        };
        let (reason, retry) = match host.status() {
            ConnectionStatus::Starting => {
                return Some(column(
                    h_flex()
                        .id("host-starting")
                        .test_support()
                        .aria_label(copy::HOST_STARTING.get(cx))
                        .h_8()
                        .gap_2()
                        .text_sm()
                        .text_color(maka.ink_muted)
                        .child(Spinner::new().small().color(maka.ink_muted))
                        .child(copy::HOST_STARTING.get(cx))
                        .into_any_element(),
                ));
            }
            ConnectionStatus::Disconnected { reason, retry } => (reason, retry),
            _ => return None,
        };
        let next = match retry {
            RetryState::Attempting { .. } => copy::STATUS_RECONNECTING.get(cx).to_owned(),
            RetryState::Waiting { delay, .. } => {
                copy::retry_in(Locale::current(cx), delay.as_secs().max(1))
            }
            RetryState::Suspended => copy::DISCONNECTED_SUSPENDED.get(cx).to_owned(),
            _ => String::new(),
        };
        let attempting = matches!(retry, RetryState::Attempting { .. });
        // Starting a Host by hand helps only with the local one.
        let local = !host.is_remote();
        let command = copy::serve_command(host.root());
        let title = copy::DISCONNECTED_TITLE.get(cx);
        let mono = cx.theme().mono_font_family.clone();
        let machine_text = |text: SharedString| {
            div()
                .min_w_0()
                .font_family(mono.clone())
                .text_xs()
                .line_height(px(20.))
                .text_color(maka.ink)
                .child(text)
        };
        let banner = banner(cx)
            .id("host-disconnected")
            .test_support()
            .role(Role::Alert)
            .aria_label(title)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .h_5()
                            .gap_3()
                            .child(div().flex_1().min_w_0().truncate().font_semibold().child(title))
                            .child(
                                // Desktop's `size="sm"`, 28px, centred on
                                // the 20px title line. Label only, as
                                // Desktop's retry buttons.
                                quiet_button(Button::new("reconnect"), cx)
                                    .flex_shrink_0()
                                    .h_7()
                                    .label(copy::RETRY.get(cx))
                                    .loading(attempting)
                                    .tooltip_with_action(copy::RETRY.get(cx), &Reconnect, None)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.host.update(cx, |host, cx| host.reconnect(cx));
                                    })),
                            ),
                    )
                    .when(!next.is_empty(), |this| this.child(banner_description(next)))
                    .when(!reason.is_empty(), |this| {
                        this.child(
                            machine_text(reason.clone())
                                .id("host-disconnected-reason")
                                .test_support()
                                .mt_1(),
                        )
                    })
                    .when(local, |this| {
                        this.child(banner_description(copy::DISCONNECTED_START_HINT.get(cx)).mt_3())
                            .child(
                                h_flex()
                                    .mt_1()
                                    .gap_1()
                                    .child(
                                        machine_text(command.clone().into())
                                            .id("serve-command")
                                            .test_support()
                                            .flex_1(),
                                    )
                                    .child(
                                        Clipboard::new("copy-serve-command")
                                            .value(command)
                                            .tooltip(copy::COPY_COMMAND.get(cx)),
                                    ),
                            )
                    }),
            );
        Some(column(banner.into_any_element()))
    }
}

/// What the sidebar collapses to (the Appearance preference).
fn narrow_sidebar(cx: &App) -> NarrowSidebar {
    AppPreferences::current(cx).narrow_sidebar
}

/// The rail's width in rems at the rem the window draws at: its own, or
/// wider at small UI font sizes, so the traffic lights keep to its band.
fn rail_rems(cx: &App) -> f32 {
    let rem = cx.theme().font_size;
    RAIL_WIDTH_REMS.max(1. + px(TRAFFIC_LIGHTS_SPAN) / rem)
}

/// The footer menu: Settings…, the preferences as submenus with the
/// current choice checked (applied at once, and saved), the Runtime Hosts
/// the window can switch to (the one it talks to, `current`, checked) once
/// there is more than one, then Switch data folder…. Built each time it
/// opens, so the checks follow the preferences.
fn footer_menu_entries(current: &str, cx: &App) -> Vec<MenuEntry> {
    let preferences = AppPreferences::current(cx);
    let locale = Locale::current(cx);
    let languages = Language::ALL
        .map(|language| {
            MenuItem::new(format!("language:{}", language.key()), language.label(locale))
                .checked(language == preferences.language)
                .on_select(move |_, cx| settings::choose_language(language, cx))
                .into()
        })
        .into();
    let appearances = Appearance::ALL
        .map(|appearance| {
            MenuItem::new(format!("appearance:{}", appearance.key()), appearance.label().get(cx))
                .checked(appearance == preferences.appearance)
                .on_select(move |_, cx| settings::choose_appearance(appearance, cx))
                .into()
        })
        .into();
    let mut entries: Vec<MenuEntry> = vec![
        MenuItem::new("settings", copy::SETTINGS_ITEM.get(cx))
            .icon(Icon::new(MakaIcon::Settings))
            .action(Box::new(OpenSettings))
            .into(),
        MenuItem::new("language", settings_copy::LANGUAGE.get(cx))
            .icon(Icon::new(AssetIcon::Languages))
            .submenu(languages)
            .into(),
        MenuItem::new("appearance", settings_copy::APPEARANCE.get(cx))
            .icon(Icon::new(IconName::Palette))
            .submenu(appearances)
            .into(),
    ];
    let hosts = HostDirectory::global(cx)
        .and_then(|directory| directory.read(cx).list().map(|list| list.choices()))
        .unwrap_or_default();
    if hosts.len() > 1 {
        let local = copy::HOST_LOCAL.get(cx);
        let items = hosts
            .into_iter()
            .map(|choice| {
                let label = choice.name.clone().unwrap_or_else(|| local.into());
                MenuItem::new(format!("host:{}", choice.profile_id), label)
                    .checked(choice.profile_id.as_ref() == current)
                    .action(Box::new(SwitchHost::new(choice.profile_id)))
                    .into()
            })
            .collect();
        entries.push(
            MenuItem::new("runtime-host", copy::remote_hosts::HOST_BLOCK_TITLE.get(cx))
                .icon(Icon::new(MakaIcon::Host))
                .submenu(items)
                .into(),
        );
    }
    entries.extend([
        MenuEntry::Separator,
        MenuItem::new("switch-data-folder", copy::SWITCH_STATE_ROOT.get(cx))
            .icon(Icon::new(AssetIcon::FolderSync))
            .action(Box::new(SwitchStateRoot))
            .into(),
    ]);
    entries
}

impl Render for Workbench {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        // While settings show, their navigation takes the sidebar's place and
        // their page the plate's; the task view's entities keep their state.
        let mut task_view = false;
        let (column, plate): (Option<AnyElement>, Vec<AnyElement>) = match self.settings_view() {
            Some(settings) => (
                Some(self.render_settings_column(&settings, window, cx).into_any_element()),
                vec![
                    self.render_header(cx).into_any_element(),
                    settings.update(cx, |view, cx| view.render_page(window, cx)),
                ],
            ),
            // Nothing the task view or a page shows can work until the
            // blocker is fixed, so its screen stands in for them; their
            // entities keep their state (a draft included).
            None if let Some(blocked) = self.render_host_blocked(cx) => {
                let plate = vec![self.render_header(cx).into_any_element(), blocked];
                (self.render_column(window, cx), plate)
            }
            None if self.page.is_some() => {
                let mut plate = vec![self.render_header(cx).into_any_element()];
                plate.extend(self.render_connection_strip(PAGE_COLUMN_REMS, cx));
                plate.push(self.render_page(window, cx));
                (self.render_column(window, cx), plate)
            }
            // The changes panel maximized for the task: the conversation and
            // the composer keep their state and leave the plate to it.
            None if self.workbar_maximized(cx) => {
                let mut plate = vec![self.render_header(cx).into_any_element()];
                plate.extend(self.render_connection_strip(COLUMN_MAX_WIDTH_REMS, cx));
                plate.push(self.render_workbar_maximized(window, cx));
                (self.render_column(window, cx), plate)
            }
            None => {
                task_view = true;
                // The conversation keeps its slot; the empty state stands in
                // for it while there is nothing to read.
                let body = if self.shows_empty_state(cx) {
                    EmptyState.into_any_element()
                } else {
                    self.conversation.clone().into_any_element()
                };
                let mut plate = vec![self.render_header(cx).into_any_element()];
                plate.extend(self.render_connection_strip(COLUMN_MAX_WIDTH_REMS, cx));
                plate.push(body);
                plate.extend(self.render_context_strip(cx));
                plate.push(self.composer.clone().into_any_element());
                (self.render_column(window, cx), plate)
            }
        };
        // The edge's handle, while the sidebar shows beside the plate or the
        // person collapsed it to the rail (a narrow window keeps the rail).
        // It stays through the column's slides at the edge they reach, so a
        // focused handle keeps focus when its keys collapse or expand.
        let edge = match self.shown_form {
            SidebarForm::Expanded => true,
            SidebarForm::Rail => !self.layout.narrow(),
            SidebarForm::Hidden => false,
        };
        let handle =
            (self.settings.is_none() && edge).then(|| self.render_resize_handle(window, cx));
        let overlay = self.render_overlay(window, cx);
        // The one reading plate. In light mode the fill step from the
        // canvas is the only separator; in dark the step is small, so a
        // soft ring stands in for it.
        let main = v_flex()
            .id("main-pane")
            .test_support()
            .when(task_view, |this| this.key_context(TASK_VIEW_CONTEXT))
            .size_full()
            .bg(maka.plate)
            .rounded(RADIUS_MODAL)
            .children(plate)
            .into_any_element();
        // Beside the task view, the selected task's changes panel, unless
        // it fills the plate.
        let beside = self.workbar_shown(cx) && !self.workbar_maximized(cx);
        let review = if beside { self.with_workbar(main, window, cx) } else { main };
        h_flex()
            .id("workbench")
            .size_full()
            .items_stretch()
            .bg(maka.canvas)
            .text_color(maka.ink)
            .on_action(cx.listener(Self::new_session))
            .on_action(cx.listener(Self::focus_composer))
            .on_action(cx.listener(Self::send_message))
            .on_action(cx.listener(Self::stop_turn))
            .on_action(cx.listener(Self::reconnect))
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::go_back))
            .on_action(cx.listener(Self::go_forward))
            .on_action(cx.listener(Self::open_settings))
            .on_action(cx.listener(Self::add_connection))
            .on_action(cx.listener(Self::open_project_settings))
            .on_action(cx.listener(Self::switch_state_root))
            .on_action(cx.listener(Self::switch_host_action))
            .on_action(cx.listener(Self::open_command_palette))
            .on_action(cx.listener(Self::archive_task))
            .on_action(cx.listener(Self::flag_task))
            .on_action(cx.listener(Self::show_keyboard_shortcuts))
            .on_action(cx.listener(Self::open_extensions))
            .on_action(cx.listener(Self::open_scheduled_tasks))
            .on_action(cx.listener(Self::search_all_tasks))
            .on_action(cx.listener(Self::close_overlay_action))
            .on_action(cx.listener(Self::toggle_review))
            .on_action(cx.listener(Self::toggle_terminal))
            .on_action(cx.listener(Self::toggle_files))
            .on_action(cx.listener(Self::toggle_side_chat))
            .on_action(cx.listener(Self::toggle_workbar_maximized))
            .on_action(cx.listener(Self::find_in_conversation))
            .on_action(cx.listener(Self::select_next_match))
            .on_action(cx.listener(Self::select_previous_match))
            .on_drag_move(cx.listener(Self::drag_sidebar_edge))
            .on_drag_move(cx.listener(Self::drag_workbar_edge))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    if std::mem::take(&mut this.resizing) {
                        cx.notify();
                    }
                    this.end_workbar_drag(cx);
                }),
            )
            .children(column)
            .child(
                // The canvas margin around the plate.
                div().flex_1().min_w_0().h_full().p(rems(PLATE_INSET_REMS)).child(review),
            )
            .children(handle)
            .children(overlay)
            // A passive launch draws for captures: a clear layer over the
            // content takes the real pointer, so nothing under it shows
            // hover. Menus and dialogs draw above it.
            .when(cx.has_global::<PassivePointer>(), |this| {
                this.child(
                    div()
                        .id("passive-pointer")
                        .test_support()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .occlude(),
                )
            })
            // The custom pet: decoration above the plate, out of sight
            // while settings or a dialog cover the app (Desktop's
            // `shellObscured`), under every overlay (`Root` draws the
            // window's sheets, dialogs and notifications above this view).
            .when(
                self.settings.is_none()
                    && !window.has_active_dialog(cx)
                    && !window.has_active_sheet(cx),
                |this| this.child(self.pet.read(cx).companion().clone()),
            )
    }
}

/// Desktop's `appendPromptContextDraft`: the text after the draft, a blank
/// line between, both trimmed at the seam.
fn append_to_draft(draft: &str, text: &str) -> String {
    let (base, next) = (draft.trim_end(), text.trim());
    match (base.is_empty(), next.is_empty()) {
        (true, _) => next.to_owned(),
        (false, true) => base.to_owned(),
        (false, false) => format!("{base}\n\n{next}"),
    }
}

/// Announces a scheduled task's fire in the window: its title, and View
/// scheduled tasks (Desktop's toast; an action keeps it until dismissed).
fn announce_fired(title: SharedString, window: &mut Window, cx: &mut App) {
    use gpui_kit::component::notification::Notification;
    use shared::copy::automations as scheduled_copy;
    let notification =
        Notification::info(title).title(scheduled_copy::FIRED_TITLE.get(cx)).action(|_, _, cx| {
            Button::new("scheduled-task-fired-view")
                .ghost()
                .small()
                .label(scheduled_copy::VIEW_SCHEDULED_TASKS.get(cx))
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(OpenScheduledTasks), cx);
                })
        });
    window.push_notification(notification, cx);
}

/// Runs `f` on the Workbench of the active window (or the first window when
/// none is active). Used by the app-level Action fallbacks, which run when
/// no element in the window has focus.
pub(crate) fn with_active_workbench(
    cx: &mut App,
    f: impl FnOnce(&mut Workbench, &mut Window, &mut Context<Workbench>) + 'static,
) {
    let window = cx
        .active_window()
        .and_then(|window| window.downcast::<Root>())
        .or_else(|| cx.windows().iter().find_map(|window| window.downcast::<Root>()));
    let Some(window) = window else {
        return;
    };
    window
        .update(cx, |root, window, cx| {
            if let Ok(workbench) = root.view().clone().downcast::<Workbench>() {
                workbench.update(cx, |workbench, cx| f(workbench, window, cx));
            }
        })
        .ok();
}
