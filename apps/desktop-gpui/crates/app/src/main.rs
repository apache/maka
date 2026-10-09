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

//! `maka-gpui [--root <state-root>] [--host local|<profile-id>] [--hosts-dir <dir>]
//! [--window-size <width>x<height>] [--session <id>]
//! [--locale en|zh-CN|zh-TW] [--appearance system|light|dark] [--pet <id>] [--hide-sidebar] [--group-by-project] [--open-page extensions|scheduled-tasks] [--open-model-menu | --open-permission-menu | --open-add-connection |
//! --open-footer-menu [language|host] | --open-task-menu | --open-folder-menu | --open-project-menu |
//! --open-settings <section> |
//! --open-command-palette [<query>] | --open-shortcuts | --press <keys>]
//! [--passive [--ui-font-size <11-22>] [--narrow-sidebar icons|hide]]`
//!
//! Opens the main window and connects to the Runtime Host of the State Root,
//! starting one (and creating the State Root) when none is registered; see
//! `docs/dev-host.md` for how the Maka checkout and Node are found.
//!
//! The State Root is `--root` when given (for this launch only; `just run`
//! passes the development root `.dev-root`), else the one chosen at an
//! earlier launch and remembered in `state-root.json` under the client's
//! config directory. Without either, the window asks, proposing
//! `maka-gpui/state-root` in the platform data directory; Maka Desktop's own
//! data is never proposed or accepted. Host > Switch Data Folder… asks again.
//!
//! The window talks to the default Runtime Host (Settings › Workspace ›
//! Runtime Host): the local Host of the State Root, or a remote one saved
//! in the client's config directory. `--host` names this launch's Host
//! instead (`local` or a remote profile's id), and `--hosts-dir` reads and
//! writes the remote Hosts and the selection in that directory for this
//! launch, so screenshots of the Host block need not touch the client's
//! own.
//!
//! `--locale` shows the interface in that language for this launch (the
//! saved preference is unchanged unless the language is switched again),
//! `--appearance` does the same for light or dark, so screenshots of either
//! need not flip the system's setting, `--pet <id>` shows that custom pet
//! from the State Root's library (`<root>/pets/v1/<id>`) for this launch,
//! `--window-size` fixes the window's size in points,
//! `--session` opens the window on that task, `--hide-sidebar` opens it
//! with the sidebar hidden, and `--group-by-project` with the task list
//! grouped by project, for reproducible screenshots. `--open-page` shows
//! the Extensions or the Scheduled tasks page on the plate instead of the
//! task (with any `--open-*` below still applied), `--open-skill <ref>`
//! opens that installed Skill's detail on the Extensions page once it is
//! listed, `--open-add-menu` opens the Extensions page's Add menu and its
//! Skill locations submenu, `--open-scheduled-runs` and
//! `--open-daily-review` show the Scheduled tasks page's Run history and
//! Daily review, `--open-scheduled-task <id>` opens that task's detail
//! once it is listed, `--open-scheduled-task-form` the New scheduled task
//! form, `--open-daily-review-report` the report of today once the Daily
//! review has one (View analysis), and `--open-model-menu`
//! and `--open-permission-menu` open the composer's model or permission mode
//! menu once the task's settings and the model catalog are read, through the
//! keyboard path (Tab from the draft to the picker, then Enter), and
//! `--open-add-connection` dispatches the `AddConnection` command once the
//! connection catalog is read (Settings at Models, with the provider
//! catalog),
//! `--open-settings general|appearance|projects|models|about` opens settings
//! on that section once the catalog is read (`connections` and `permissions`,
//! the settings dialog's ids, still open Models and General), and
//! `<section>:<target>` opens a place inside it (`settings::SettingsView::open_target`:
//! `general:end` scrolled to its end, `general:full-access` the Full
//! access question, `models:catalog`, `models:add:<provider>`,
//! `models:connection:<slug>[:end]`, `models:parameters:<slug>:<model>`,
//! `models:add-model:<slug>`,
//! `projects:manual[-ssh|-operator|-plaintext]` the manual Host form on
//! that method, `projects:directory` a remote Host's folder browser), and
//! `--open-footer-menu [language|host]` opens the sidebar footer's menu
//! and its Language submenu, or with `host` its Runtime Host submenu (the
//! Host switcher, once more than one Host is listed), `--open-task-menu` opens the selected task's context menu
//! through the keyboard path (the task list focused, then Shift-F10), and
//! `--open-folder-menu` opens the new task's project picker once projects
//! are listed (New task, then Tab from the draft to the picker and Enter),
//! `--open-project-menu` the selected task's project menu (the folder
//! button before its title) once projects are listed, and
//! `--open-command-palette` opens the command palette with ⌘K from the
//! composer once the task's settings are read, typing the optional query,
//! and `--open-shortcuts` the keyboard shortcuts sheet with ⌘/, and
//! `--press "<key> <key>…"` focuses the transcript once the task's rows
//! are drawn, presses the keys (`"tab tab enter"` opens the second Tool
//! row) and gives the focus back to the draft, for screenshots of states a
//! person reaches by clicking.
//!
//! `--passive` opens the window without focus and without activating the
//! app, for captures taken while a person works, and draws in the default
//! preferences, saving none: a capture shows neither the person's font
//! size or sidebar width nor writes anything it opens (a settings section)
//! to their preferences file. Only a passive launch takes
//! `--ui-font-size <11-22>` and `--narrow-sidebar icons|hide`, which would
//! otherwise be saved with the next preference change.

mod logging;

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use app::{StartupView, StateRootSetup, Workbench, open_state_root_dialog, show_workbench_on};
use futures_lite::future::Boxed;
use gpui_kit::component::{Root, TitleBar};
use gpui_kit::{Action as _, Focusable as _};
use gpui_kit::{
    App, AppContext as _, Bounds, Entity, KeyUpEvent, Keystroke, Pixels, PlatformInput, Size,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, point, px, size,
};
use session::{SidebarPage, TaskGrouping};
use settings::{
    AppPreferences, Appearance, Language, NarrowSidebar, PreferencesFile, PreferencesStore,
    RunNotifier, SettingsSection, TaskNames, UI_FONT_SIZES,
};
use shared::copy::Locale;
use workspace::actions::{AddConnection, NewSession};
use workspace::{
    HostDirectory, HostProjectCatalog, HostSession, LivePairing, RemoteProfileStore, StateRootFile,
    StateRootStore, WindowHost, default_state_root, desktop_data_directory,
};

const USAGE: &str = "usage: maka-gpui [--root <state-root>] [--host local|<profile-id>] \
     [--hosts-dir <dir>] [--window-size <width>x<height>] \
     [--session <id>] [--locale en|zh-CN|zh-TW] [--appearance system|light|dark] [--pet <id>] [--hide-sidebar] [--group-by-project] \
     [--open-page extensions|scheduled-tasks] [--open-skill <ref> | --open-add-menu \
     | --open-scheduled-runs | --open-daily-review | --open-scheduled-task <id> \
     | --open-scheduled-task-form | --open-daily-review-report] \
     [--open-model-menu | --open-permission-menu | --open-add-connection | --open-footer-menu [language|host] \
     | --open-task-menu | --open-folder-menu | --open-project-menu | --open-settings general|appearance|projects|models|about[:<target>] \
     | --open-command-palette [<query>] | --open-shortcuts | --scroll-to-top | --press <keys>] [--attach <file>]… [--send <text>]… \
     [--passive [--ui-font-size <11-22>] [--narrow-sidebar icons|hide]]";

/// The bundle's identifier (packaging/macos/Info.plist), which the
/// platform presents the app's notifications under.
const BUNDLE_IDENTIFIER: &str = "com.longbridge.maka-gpui";

// Window geometry is a platform boundary, so it is given in points.
/// The default window size: Maka Desktop's.
const DEFAULT_WINDOW_SIZE: (f32, f32) = (1512., 885.);
const MIN_WINDOW_SIZE: (f32, f32) = (960., 600.);
/// Where macOS draws the traffic lights (14 points tall): on the centre
/// line of the window chrome band (`app::CHROME_HEIGHT_REMS` tall, below
/// the plate's 8-point canvas margin, so centred 32 points down at the
/// default base font) and on the sidebar's content inset. The sidebar's top
/// strip holds them; while the sidebar is hidden, the plate header's leading
/// inset does.
const TRAFFIC_LIGHTS: (f32, f32) = (16., 25.);

#[derive(Debug, PartialEq)]
struct Args {
    /// `--root`: this launch's State Root, instead of the remembered one.
    root: Option<PathBuf>,
    /// `--host`: this launch's Runtime Host (`local` or a remote profile's
    /// id), instead of the default.
    host: Option<String>,
    /// `--hosts-dir`: where this launch keeps the remote Host profiles and
    /// the Host selection, instead of the client's config directory.
    hosts_dir: Option<PathBuf>,
    window_size: Option<Size<Pixels>>,
    session: Option<String>,
    /// `--locale`: this launch's interface language.
    locale: Option<Locale>,
    /// `--appearance`: this launch's appearance.
    appearance: Option<Appearance>,
    /// `--pet`: this launch's custom pet.
    pet: Option<pet::PetPackId>,
    hide_sidebar: bool,
    group_by_project: bool,
    /// `--open-page`: the page the plate shows instead of the task.
    page: Option<SidebarPage>,
    open: Option<Opening>,
    /// `--send`, repeatable: messages to send, in order, once the session is
    /// loaded.
    sends: Vec<String>,
    /// `--attach`, repeatable: files attached to the first `--send`.
    attachments: Vec<PathBuf>,
    /// `--passive`: the window opens without focus and the app does not
    /// activate, so a screenshot run never takes the keys meant for the app
    /// the person is using (a keystroke once answered a demo prompt). It
    /// also starts from the default preferences and saves none, so a
    /// capture neither shows nor changes the person's choices.
    passive: bool,
    /// `--ui-font-size`, passive launches only: this launch's UI font size.
    ui_font_size: Option<u8>,
    /// `--narrow-sidebar`, passive launches only: what this launch's
    /// sidebar collapses to.
    narrow_sidebar: Option<NarrowSidebar>,
}

/// An overlay `--open-*` opens once the window is ready.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Opening {
    ModelMenu,
    PermissionMenu,
    AddConnection,
    /// The footer menu with this item's submenu open: `language` (the
    /// default) or `host` (the Runtime Host switcher).
    FooterMenu(&'static str),
    TaskMenu,
    FolderMenu,
    /// The selected task's project menu, under the folder button before
    /// its title.
    ProjectMenu,
    /// Settings on a section, and a place inside it when asked
    /// (`<section>:<target>`).
    Settings(SettingsSection, Option<String>),
    /// The command palette, with this query typed.
    CommandPalette(String),
    /// The keyboard shortcuts sheet.
    Shortcuts,
    /// Home in the transcript until its first message shows.
    TranscriptTop,
    /// The detail of the installed Skill with this ref, on the Extensions
    /// page.
    SkillDetail(String),
    /// The Extensions page's Add menu with its Skill locations submenu.
    AddMenu,
    /// The Scheduled tasks page's Run history.
    ScheduledRuns,
    /// The Scheduled tasks page's Daily review.
    DailyReview,
    /// The Daily review's report of today, once it has one.
    DailyReviewReport,
    /// The detail of the scheduled task with this id.
    ScheduledTaskDetail(String),
    /// The New scheduled task form.
    ScheduledTaskForm,
    /// These keys pressed in the transcript, then the focus back in the
    /// draft.
    Press(Vec<String>),
}

/// How often and how long a launch opening waits for its window to be ready.
const OPENING_POLL: Duration = Duration::from_millis(200);
const OPENING_TIMEOUT: Duration = Duration::from_secs(20);

fn main() {
    logging::init();
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let Args {
        root,
        host,
        hosts_dir,
        window_size,
        session,
        locale,
        appearance,
        pet,
        hide_sidebar,
        group_by_project,
        page,
        open,
        sends,
        attachments,
        passive,
        ui_font_size,
        narrow_sidebar,
    } = args;
    let launch = Launch {
        host: WindowHost::Local,
        session,
        hide_sidebar,
        group_by_project,
        page,
        open,
        sends,
        attachments,
        passive,
    };

    gpui_kit::application().with_assets(shared::assets::AppAssets).run(move |cx| {
        // Before any window or notification, as GPUI asks.
        cx.set_app_identity(BUNDLE_IDENTIFIER, shared::copy::APP_NAME.en());
        gpui_kit::init(cx);
        app::init(cx);
        // Keep system awake applies from launch, as in Maka Desktop.
        automations::KeepSystemAwake::init_global(cx);
        // The Runtime Hosts every window can talk to; the window opens on the
        // default one (or `--host`), resolved before it opens.
        let hosts = match hosts_dir {
            Some(dir) => Some(RemoteProfileStore::new(dir)),
            None => RemoteProfileStore::in_config_directory()
                .map_err(|error| log::warn!("no remote Runtime Hosts: {error}"))
                .ok(),
        }
        .map(|store| {
            let pairing = Arc::new(LivePairing::default());
            let directory = cx.new(|cx| HostDirectory::new(store, pairing, cx));
            HostDirectory::install(directory.clone(), cx);
            directory.read(cx).launch_host(host.as_deref(), cx)
        });
        // The preferences are read before the window opens, so it opens in
        // the chosen appearance instead of switching after its first frame.
        let preferences_store = preferences_store(passive);
        let load = preferences_store.as_ref().map(|store| store.load());
        cx.spawn(async move |cx| {
            let preferences = match load {
                Some(load) => load.await.unwrap_or_else(|error| {
                    log::warn!("could not read the preferences: {error}");
                    None
                }),
                None => None,
            };
            let mut preferences = preferences.unwrap_or_default();
            if let Some(locale) = locale {
                preferences.language = Language::of(locale);
            }
            if let Some(appearance) = appearance {
                preferences.appearance = appearance;
            }
            if pet.is_some() {
                preferences.selected_pet = pet;
            }
            if let Some(size) = ui_font_size {
                preferences = preferences.with_ui_font_size(size);
            }
            if let Some(narrow) = narrow_sidebar {
                preferences = preferences.with_narrow_sidebar(narrow);
            }
            let mut launch = launch;
            if let Some(hosts) = hosts {
                launch.host = hosts.await;
            }
            cx.update(|cx| {
                AppPreferences::global(cx)
                    .update(cx, |current, cx| current.restore(preferences, preferences_store, cx));
                // The Dock shows the chosen app icon from here on.
                let icons = workspace::client_config_file(settings::CUSTOM_ICON_DIRECTORY);
                settings::install_app_icons(
                    icons,
                    Rc::new(|_, art, _| app::set_dock_icon(art)),
                    cx,
                );
                open_main_window(root, window_size, launch, cx);
            });
        })
        .detach();
    });
}

/// Where the preferences are read and saved: the client's preferences
/// file, or nowhere for a passive launch. A passive launch draws for
/// captures beside the person's own windows, so it starts from the defaults
/// and nothing it shows or opens (a settings section, a flag's font size)
/// reaches the person's file.
fn preferences_store(passive: bool) -> Option<Rc<dyn PreferencesStore>> {
    if passive {
        return None;
    }
    match PreferencesFile::default_location() {
        Some(file) => Some(Rc::new(file)),
        None => {
            log::warn!("no config directory: preferences are not remembered");
            None
        }
    }
}

/// Where the traffic lights go at the UI font size `size`: [`TRAFFIC_LIGHTS`]
/// at the default, scaled with the rem the chrome band is measured in (their
/// 14 points stay 14 points).
fn traffic_lights(size: u8) -> gpui_kit::Point<Pixels> {
    let scale = f32::from(size) / f32::from(shared::theme::DEFAULT_UI_FONT_SIZE);
    let (x, y) = TRAFFIC_LIGHTS;
    // The lights' centre is 7 points below their top.
    point(px(x * scale), px((y + 7.) * scale - 7.))
}

/// Opens the main window on `root` (else the remembered State Root, else
/// the State Root dialog) and applies the command line's `launch` options.
fn open_main_window(
    root: Option<PathBuf>,
    window_size: Option<Size<Pixels>>,
    launch: Launch,
    cx: &mut App,
) {
    let store: Rc<dyn StateRootStore> = match StateRootFile::default_location() {
        Some(file) => Rc::new(file),
        None => {
            log::warn!("no config directory: the State Root choice is not remembered");
            Rc::new(Unremembered)
        }
    };
    let setup = StateRootSetup::new(
        store.clone(),
        default_state_root().unwrap_or_default(),
        desktop_data_directory(),
        Rc::new(build_workbench),
    );
    let (width, height) = DEFAULT_WINDOW_SIZE;
    let window_size = window_size.unwrap_or(size(px(width), px(height)));
    let bounds = Bounds::centered(None, window_size, cx);
    let (min_width, min_height) = MIN_WINDOW_SIZE;
    let lights = traffic_lights(AppPreferences::current(cx).ui_font_size);
    let passive = launch.passive;
    if passive {
        cx.set_global(app::PassivePointer);
    }
    let options = WindowOptions {
        focus: !passive,
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(min_width), px(min_height))),
        // No native title bar: the sidebar's top strip and the main
        // pane's header draw the chrome and move the window.
        titlebar: Some(TitlebarOptions {
            traffic_light_position: Some(lights),
            ..TitleBar::title_bar_options()
        }),
        ..TitleBar::window_options()
    };
    let opened = cx.open_window(options, |window, cx| {
        // The chosen appearance; "System" follows the window's appearance,
        // now and when it changes.
        let appearance = AppPreferences::current(cx).appearance;
        settings::apply_appearance(appearance, Some(window), cx);
        window.observe_window_appearance(settings::follow_system_appearance).detach();
        // The chrome band scales with the UI font size; the traffic lights
        // stay on its centre line and on the sidebar's inset.
        let preferences = AppPreferences::global(cx);
        window
            .observe(&preferences, cx, |preferences, window, cx| {
                let size = preferences.read(cx).preferences().ui_font_size;
                window.set_traffic_light_position(traffic_lights(size));
            })
            .detach();
        // Until the State Root is known the window shows only its chrome.
        let startup = cx.new(|_| StartupView);
        cx.new(|cx| app::window_root(startup, window, cx))
    });
    let window = match opened {
        Ok(window) => window,
        Err(error) => {
            log::error!("failed to open the main window: {error:#}");
            cx.quit();
            return;
        }
    };
    match root {
        Some(root) => {
            cx.update_window(window.into(), |_, window, cx| {
                let workbench = show_workbench_on(&setup, root, launch.host.clone(), window, cx);
                launch.apply(&workbench, cx);
            })
            .ok();
            launch.show_page(window, cx);
            if let Some(opening) = launch.open.clone() {
                open_when_ready(window, opening, cx);
            }
            if !launch.sends.is_empty() || !launch.attachments.is_empty() {
                send_when_ready(window, launch.sends.clone(), launch.attachments.clone(), cx);
            }
        }
        None => open_remembered_root(window, store, setup, launch, cx),
    }
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();
    if !passive {
        cx.activate(true);
    }
}

/// The Workbench of a window for the State Root at `root`: a Host session
/// that connects, starting a Host when none is registered, the notifier
/// that posts a system notification when one of its tasks ends while the
/// window is in the background, and the State Root's chat bots. The
/// notifier and the bots live as long as the workbench.
fn build_workbench(
    root: PathBuf,
    host: WindowHost,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Workbench> {
    let host = cx.new(|cx| HostSession::open(root, host, cx));
    let workbench =
        cx.new(|cx| Workbench::new(host.clone(), Rc::new(HostProjectCatalog), window, cx));
    // The context strip over the composer reads the task's changes with
    // the system's `git`, as the changes panel does.
    workbench.update(cx, |workbench, cx| {
        workbench.read_changes_with(std::sync::Arc::new(review::git::SystemGit), cx);
    });
    let catalog = workbench.read(cx).sidebar().read(cx).catalog().clone();
    let task_names: TaskNames =
        Rc::new(move |id, cx| catalog.read(cx).row(id).map(|row| row.name.clone()));
    let notifier = cx.new(|cx| RunNotifier::new(host, task_names, window, cx));
    cx.observe_release(&workbench, move |_, _| drop(notifier)).detach();
    app::link_bots(&workbench, cx);
    workbench
}

/// What the command line asks of the first Workbench.
#[derive(Debug, Clone)]
struct Launch {
    /// The Host it talks to: the default, or `--host`.
    host: WindowHost,
    session: Option<String>,
    hide_sidebar: bool,
    group_by_project: bool,
    page: Option<SidebarPage>,
    open: Option<Opening>,
    sends: Vec<String>,
    attachments: Vec<PathBuf>,
    passive: bool,
}

impl Launch {
    fn apply(&self, workbench: &Entity<Workbench>, cx: &mut App) {
        if let Some(session) = self.session.clone() {
            let catalog = workbench.read(cx).sidebar().read(cx).catalog().clone();
            catalog.update(cx, |catalog, cx| catalog.select_when_listed(session, cx));
        }
        if self.hide_sidebar {
            workbench.update(cx, |workbench, cx| workbench.set_sidebar_visible(false, cx));
        }
        if self.group_by_project {
            let sidebar = workbench.read(cx).sidebar().clone();
            sidebar.update(cx, |sidebar, cx| sidebar.set_grouping(TaskGrouping::ByProject, cx));
        }
    }

    /// Shows the `--open-page` page, once the window's workbench is up.
    fn show_page(&self, window: WindowHandle<Root>, cx: &mut App) {
        let Some(page) = self.page else {
            return;
        };
        cx.update_window(window.into(), |view, window, cx| {
            let workbench = view
                .downcast::<Root>()
                .ok()
                .and_then(|root| root.read(cx).view().clone().downcast::<Workbench>().ok());
            if let Some(workbench) = workbench {
                workbench.update(cx, |workbench, cx| workbench.show_page(page, window, cx));
            }
        })
        .ok();
    }
}

/// Reads the remembered State Root and opens the window on it, or asks for
/// one when there is none. The command-line options apply only to a
/// remembered root; a first launch has nothing to open them on yet.
fn open_remembered_root(
    window: WindowHandle<Root>,
    store: Rc<dyn StateRootStore>,
    setup: StateRootSetup,
    launch: Launch,
    cx: &mut App,
) {
    let load = store.load();
    cx.spawn(async move |cx| {
        let remembered = match load.await {
            Ok(remembered) => remembered,
            Err(error) => {
                log::warn!("could not read the remembered State Root: {error}");
                None
            }
        };
        let opened_workbench = cx
            .update_window(window.into(), |_, window, cx| match remembered {
                Some(root) => {
                    let workbench =
                        show_workbench_on(&setup, root, launch.host.clone(), window, cx);
                    launch.apply(&workbench, cx);
                    true
                }
                None => {
                    open_state_root_dialog(setup, None, window, cx);
                    false
                }
            })
            .unwrap_or(false);
        if opened_workbench {
            cx.update(|cx| launch.show_page(window, cx));
        }
        if opened_workbench && let Some(opening) = launch.open.clone() {
            cx.update(|cx| open_when_ready(window, opening, cx));
        }
        if opened_workbench && (!launch.sends.is_empty() || !launch.attachments.is_empty()) {
            cx.update(|cx| {
                send_when_ready(window, launch.sends.clone(), launch.attachments.clone(), cx)
            });
        }
    })
    .detach();
}

/// A store for a platform without a config directory: nothing is
/// remembered, so every launch asks.
struct Unremembered;

impl StateRootStore for Unremembered {
    fn load(&self) -> Boxed<std::io::Result<Option<PathBuf>>> {
        Box::pin(async { Ok(None) })
    }

    fn remember(&self, _: PathBuf) -> Boxed<std::io::Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

/// Opens `opening` in `window` once what it shows has been read, polling
/// every [`OPENING_POLL`] for up to [`OPENING_TIMEOUT`].
fn open_when_ready(window: WindowHandle<Root>, opening: Opening, cx: &mut App) {
    cx.spawn(async move |cx| {
        let mut waited = Duration::ZERO;
        while waited < OPENING_TIMEOUT {
            cx.background_executor().timer(OPENING_POLL).await;
            waited += OPENING_POLL;
            // Through the untyped handle, which leaves the Root entity free
            // for the keystrokes' handlers (the typed one would lease it).
            let opened = cx
                .update_window(window.into(), |view, window, cx| {
                    let workbench = view
                        .downcast::<Root>()
                        .ok()
                        .and_then(|root| root.read(cx).view().clone().downcast::<Workbench>().ok());
                    match workbench {
                        Some(workbench) => try_open(&workbench, &opening, window, cx),
                        None => true,
                    }
                })
                .unwrap_or(true);
            if opened {
                return;
            }
        }
        log::warn!("--open: the window was not ready within {} s", OPENING_TIMEOUT.as_secs());
    })
    .detach();
}

/// Types each `--send` text into the composer and presses Enter, one at a
/// time, as soon as the composer takes a message (the session is loaded and
/// the previous message answered): messages sent back to back, the way a
/// person does it. The `--attach` files are added first and go with the
/// first message.
fn send_when_ready(
    window: WindowHandle<Root>,
    texts: Vec<String>,
    attachments: Vec<PathBuf>,
    cx: &mut App,
) {
    cx.spawn(async move |cx| {
        let mut texts = texts.into_iter().peekable();
        let mut attachments = Some(attachments).filter(|files| !files.is_empty());
        let expected = attachments.as_ref().map_or(0, Vec::len);
        let mut waited = Duration::ZERO;
        while (texts.peek().is_some() || attachments.is_some()) && waited < OPENING_TIMEOUT {
            cx.background_executor().timer(OPENING_POLL).await;
            waited += OPENING_POLL;
            let _ = cx.update_window(window.into(), |view, window, cx| {
                let Some(workbench) = view
                    .downcast::<Root>()
                    .ok()
                    .and_then(|root| root.read(cx).view().clone().downcast::<Workbench>().ok())
                else {
                    return;
                };
                let state = workbench.read(cx).conversation().read(cx).state().clone();
                let ready = {
                    let state = state.read(cx);
                    state.turn_activity().is_sendable() && !state.is_submitting()
                };
                if !ready {
                    return;
                }
                let composer = workbench.read(cx).composer().clone();
                if let Some(files) = attachments.take() {
                    composer.update(cx, |composer, cx| composer.add_files(files, cx));
                    return;
                }
                if expected > 0 && composer.read(cx).attachments().len() < expected {
                    return;
                }
                let Some(text) = texts.next() else { return };
                composer.update(cx, |composer, cx| composer.fill(&text, window, cx));
                if let Ok(keystroke) = Keystroke::parse("enter") {
                    window.dispatch_keystroke(keystroke, cx);
                }
                waited = Duration::ZERO;
            });
        }
        if texts.peek().is_some() {
            log::warn!("--send: the composer did not take every message");
        }
    })
    .detach();
}

/// Opens `opening` if the window is ready for it; returns whether it did.
fn try_open(
    workbench: &gpui_kit::Entity<Workbench>,
    opening: &Opening,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let composer = workbench.read(cx).composer().clone();
    let catalog_read = workbench.read(cx).connections().read(cx).list().is_some();
    // The pickers follow the draft and "+" in Tab order: model, thinking
    // level (when the model has levels), then permission mode.
    let keys: &[&str] = match opening {
        Opening::SkillDetail(skill_ref) => {
            let Some(view) = workbench.read(cx).extensions_view().cloned() else {
                workbench.update(cx, |workbench, cx| {
                    workbench.show_page(session::SidebarPage::Extensions, window, cx)
                });
                return false;
            };
            let listed =
                view.read(cx).catalog().read(cx).installed().items().iter().any(|item| {
                    item.governance().is_some_and(|skill| &skill.skill_ref == skill_ref)
                });
            if listed {
                let skill_ref = skill_ref.clone().into();
                view.update(cx, |view, cx| view.open_detail(skill_ref, window, cx));
            }
            return listed;
        }
        Opening::ScheduledRuns
        | Opening::DailyReview
        | Opening::DailyReviewReport
        | Opening::ScheduledTaskDetail(_)
        | Opening::ScheduledTaskForm => return open_scheduled(workbench, opening, window, cx),
        Opening::AddMenu => {
            let Some(view) = workbench.read(cx).extensions_view().cloned() else {
                workbench.update(cx, |workbench, cx| {
                    workbench.show_page(session::SidebarPage::Extensions, window, cx)
                });
                return false;
            };
            if view.read(cx).catalog().read(cx).installed().listing().is_none() {
                return false;
            }
            // The menu, then (the next poll, once it has drawn) its Skill
            // locations submenu.
            return view.update(cx, |view, cx| view.open_add_menu(window, cx));
        }
        Opening::AddConnection => {
            if catalog_read {
                window.dispatch_action(AddConnection.boxed_clone(), cx);
            }
            return catalog_read;
        }
        Opening::Settings(section, target) => {
            let (section, target) = (*section, target.clone());
            if catalog_read {
                workbench.update(cx, |workbench, cx| {
                    let then = move |view: &mut settings::SettingsView,
                                     window: &mut Window,
                                     cx: &mut gpui_kit::Context<settings::SettingsView>| {
                        if let Some(target) = target
                            && !view.open_target(&target, window, cx)
                        {
                            log::warn!("--open-settings: nothing to open at {target:?}");
                        }
                    };
                    workbench.show_settings(section, then, window, cx)
                });
            }
            return catalog_read;
        }
        Opening::FooterMenu(submenu) => {
            // Opened and shown directly rather than through keys, so it
            // does not hang on where focus happens to be: the menu, then
            // (the next poll, once it has drawn) the submenu. The Host
            // switcher waits until the directory lists more than one Host.
            if let Some(menu) = workbench.read(cx).footer_menu().cloned() {
                return menu.update(cx, |menu, cx| menu.open_submenu_of(submenu, cx));
            }
            let hosts = HostDirectory::global(cx)
                .and_then(|directory| directory.read(cx).list().map(|list| list.choices().len()))
                .unwrap_or(0);
            if *submenu == "runtime-host" && hosts < 2 {
                return false;
            }
            workbench.update(cx, |workbench, cx| workbench.open_footer_menu(window, cx));
            return false;
        }
        Opening::TaskMenu => {
            let sidebar = workbench.read(cx).sidebar().clone();
            if sidebar.read(cx).catalog().read(cx).selected_row().is_none() {
                return false;
            }
            let list = sidebar.read(cx).focus_handle(cx);
            window.focus(&list, cx);
            if let Ok(keystroke) = Keystroke::parse("shift-f10") {
                window.dispatch_keystroke(keystroke, cx);
            }
            return true;
        }
        Opening::FolderMenu => {
            if workbench.read(cx).projects().read(cx).active_projects().next().is_none() {
                return false;
            }
            // The project picker shows in the new task's draft: open that
            // first, then (the next poll) Tab from the draft past "+", the
            // model, the thinking level and the permission mode to it.
            let catalog = workbench.read(cx).sidebar().read(cx).catalog().clone();
            if !catalog.read(cx).is_draft() {
                window.dispatch_action(NewSession.boxed_clone(), cx);
                return false;
            }
            if !composer.read(cx).shows_settings(cx) {
                return false;
            }
            // Past the thinking level picker too, when the model has one.
            let tabs = if composer.read(cx).shows_thinking_level(cx) { 5 } else { 4 };
            composer.update(cx, |composer, cx| composer.focus(window, cx));
            for key in std::iter::repeat_n("tab", tabs).chain(["enter"]) {
                if let Ok(keystroke) = Keystroke::parse(key) {
                    window.dispatch_keystroke(keystroke, cx);
                }
            }
            return true;
        }
        Opening::ProjectMenu => {
            // The menu names the task's project once the projects are read.
            if workbench.read(cx).projects().read(cx).active_projects().next().is_none() {
                return false;
            }
            return workbench.update(cx, |workbench, cx| workbench.open_project_menu(window, cx));
        }
        Opening::CommandPalette(query) => {
            if !composer.read(cx).shows_settings(cx) || !catalog_read {
                return false;
            }
            composer.update(cx, |composer, cx| composer.focus(window, cx));
            if let Ok(keystroke) = Keystroke::parse("cmd-k") {
                window.dispatch_keystroke(keystroke, cx);
            }
            if !query.is_empty() {
                // The palette opens one effect cycle later; type once it has.
                let query = query.clone();
                window.defer(cx, move |window, cx| {
                    window.defer(cx, move |window, cx| {
                        for character in query.chars() {
                            // `key->text`: the key and the text it types.
                            let key = match character {
                                ' ' => "space-> ".to_owned(),
                                other => format!("{other}->{other}"),
                            };
                            if let Ok(keystroke) = Keystroke::parse(&key) {
                                window.dispatch_keystroke(keystroke, cx);
                            }
                        }
                    });
                });
            }
            return true;
        }
        Opening::Shortcuts => {
            if !composer.read(cx).shows_settings(cx) {
                return false;
            }
            composer.update(cx, |composer, cx| composer.focus(window, cx));
            if let Ok(keystroke) = Keystroke::parse("cmd-/") {
                window.dispatch_keystroke(keystroke, cx);
            }
            return true;
        }
        Opening::TranscriptTop => {
            // Home, as a reader would press it, until older history has been
            // read back to the first message; the last press shows it.
            let conversation = workbench.read(cx).conversation().clone();
            let state = conversation.read(cx).state().read(cx);
            if state.transcript().is_none() {
                return false;
            }
            let more = matches!(
                state.older_history(),
                conversation::OlderHistory::Available | conversation::OlderHistory::Loading
            );
            let transcript = conversation.read(cx).focus_handle(cx);
            window.focus(&transcript, cx);
            if let Ok(keystroke) = Keystroke::parse("home") {
                window.dispatch_keystroke(keystroke, cx);
            }
            return !more;
        }
        Opening::Press(keys) => {
            let conversation = workbench.read(cx).conversation().clone();
            if conversation.read(cx).state().read(cx).transcript().is_none() {
                return false;
            }
            // A poll apart, as a person types: the rows the transcript just
            // brought are drawn before Tab looks for them, and each key is
            // released, since a button acts on the release.
            let keys = keys.clone();
            let transcript = conversation.read(cx).focus_handle(cx);
            window
                .spawn(cx, async move |cx| {
                    cx.update(|window, cx| window.focus(&transcript, cx)).ok();
                    for key in &keys {
                        cx.background_executor().timer(OPENING_POLL).await;
                        let Ok(keystroke) = Keystroke::parse(key) else {
                            log::warn!("--press: {key:?} is not a key");
                            continue;
                        };
                        cx.update(|window, cx| {
                            window.dispatch_keystroke(keystroke.clone(), cx);
                            window
                                .dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke }), cx);
                        })
                        .ok();
                    }
                    cx.background_executor().timer(OPENING_POLL).await;
                    cx.update(|window, cx| {
                        composer.update(cx, |composer, cx| composer.focus(window, cx))
                    })
                    .ok();
                })
                .detach();
            return true;
        }
        Opening::ModelMenu => &["tab", "tab", "enter"],
        // Past the thinking level picker too, when the model has one.
        Opening::PermissionMenu if composer.read(cx).shows_thinking_level(cx) => {
            &["tab", "tab", "tab", "tab", "enter"]
        }
        Opening::PermissionMenu => &["tab", "tab", "tab", "enter"],
    };
    if !composer.read(cx).shows_settings(cx) || !catalog_read {
        return false;
    }
    composer.update(cx, |composer, cx| composer.focus(window, cx));
    for key in keys {
        if let Ok(keystroke) = Keystroke::parse(key) {
            window.dispatch_keystroke(keystroke, cx);
        }
    }
    true
}

/// The Scheduled tasks page's openings; each shows the page first, then
/// waits for what it opens to be read.
fn open_scheduled(
    workbench: &gpui_kit::Entity<Workbench>,
    opening: &Opening,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    use automations::{HubTab, TasksView};
    let Some(view) = workbench.read(cx).automations_view().cloned() else {
        workbench.update(cx, |workbench, cx| {
            workbench.show_page(SidebarPage::ScheduledTasks, window, cx)
        });
        return false;
    };
    let listed = |id: &str, cx: &App| view.read(cx).catalog().read(cx).task(id).is_some();
    match opening {
        Opening::ScheduledRuns => {
            view.update(cx, |view, cx| view.set_view(TasksView::Runs, cx));
            true
        }
        Opening::DailyReview => {
            view.update(cx, |view, cx| view.set_tab(HubTab::DailyReview, cx));
            true
        }
        Opening::DailyReviewReport => {
            view.update(cx, |view, cx| view.set_tab(HubTab::DailyReview, cx));
            let review = view.read(cx).review().clone();
            if review.read(cx).report().is_some() {
                return true;
            }
            review.update(cx, |review, cx| review.open_archive(window, cx));
            false
        }
        Opening::ScheduledTaskDetail(id) => {
            if !listed(id, cx) {
                return false;
            }
            let id = id.clone().into();
            view.update(cx, |view, cx| view.open_detail(id, window, cx));
            true
        }
        Opening::ScheduledTaskForm => {
            if view.read(cx).catalog().read(cx).tasks().is_none() {
                return false;
            }
            view.update(cx, |view, cx| view.open_create(window, cx));
            true
        }
        _ => true,
    }
}

/// `--root <path>` (default: the remembered State Root, or ask),
/// `--window-size <width>x<height>`, `--session <id>`, `--hide-sidebar`,
/// `--group-by-project`, `--open-page <page>`,
/// `--open-model-menu`, `--open-permission-menu`, `--open-add-connection`,
/// `--open-footer-menu [language|host]`, `--open-task-menu`, `--open-folder-menu`,
/// `--open-settings <section>`, `--scroll-to-top`, `--press <keys>`,
/// `--attach <file>` and
/// `--send <text>` (both repeatable).
fn parse_args(args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut args = args.peekable();
    let mut root = None;
    let mut host = None;
    let mut hosts_dir = None;
    let mut window_size = None;
    let mut session = None;
    let mut locale = None;
    let mut appearance = None;
    let mut pet = None;
    let mut hide_sidebar = false;
    let mut passive = false;
    let mut ui_font_size = None;
    let mut narrow_sidebar = None;
    let mut group_by_project = false;
    let mut page = None;
    let mut open = None;
    let mut sends = Vec::new();
    let mut attachments = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => {
                let path = args.next().ok_or("--root needs a path")?;
                root = Some(PathBuf::from(path));
            }
            "--host" => {
                host = Some(args.next().ok_or("--host needs local or a Host profile's id")?);
            }
            "--hosts-dir" => {
                let path = args.next().ok_or("--hosts-dir needs a directory")?;
                hosts_dir = Some(PathBuf::from(path));
            }
            "--window-size" => {
                let value = args.next().ok_or("--window-size needs <width>x<height>")?;
                window_size = Some(parse_window_size(&value)?);
            }
            "--session" => {
                session = Some(args.next().ok_or("--session needs a session id")?);
            }
            "--locale" => {
                let tag = args.next().ok_or("--locale needs en, zh-CN, or zh-TW")?;
                locale = Some(
                    Locale::from_tag(&tag)
                        .ok_or_else(|| format!("--locale {tag:?}: en, zh-CN, or zh-TW"))?,
                );
            }
            "--appearance" => {
                let value = args.next().ok_or("--appearance needs system, light, or dark")?;
                appearance = Some(
                    Appearance::ALL
                        .into_iter()
                        .find(|choice| choice.key() == value)
                        .ok_or_else(|| format!("--appearance {value:?}: system, light, or dark"))?,
                );
            }
            "--pet" => {
                let id = args.next().ok_or("--pet needs a pet pack's id")?;
                let parsed = pet::PetPackId::parse(&id);
                pet = Some(parsed.ok_or_else(|| format!("--pet {id:?} is not a pet pack id"))?);
            }
            "--hide-sidebar" => hide_sidebar = true,
            "--passive" => passive = true,
            "--ui-font-size" => {
                let value = args.next().ok_or("--ui-font-size needs a size, 11 to 22")?;
                let size = value.parse::<u8>().ok().filter(|size| UI_FONT_SIZES.contains(size));
                ui_font_size =
                    Some(size.ok_or_else(|| format!("--ui-font-size {value:?}: 11 to 22"))?);
            }
            "--narrow-sidebar" => {
                let value = args.next().ok_or("--narrow-sidebar needs icons or hide")?;
                let narrow = NarrowSidebar::ALL.into_iter().find(|narrow| narrow.key() == value);
                narrow_sidebar = Some(
                    narrow.ok_or_else(|| format!("--narrow-sidebar {value:?}: icons or hide"))?,
                );
            }
            "--group-by-project" => group_by_project = true,
            "--open-page" => {
                let value = args.next().ok_or("--open-page needs extensions or scheduled-tasks")?;
                page = Some(SidebarPage::from_key(&value).ok_or_else(|| {
                    format!("--open-page {value:?}: extensions or scheduled-tasks")
                })?);
            }
            "--open-model-menu" => open = Some(Opening::ModelMenu),
            "--open-permission-menu" => open = Some(Opening::PermissionMenu),
            "--open-add-connection" => open = Some(Opening::AddConnection),
            "--open-footer-menu" => {
                // An optional target: whose submenu shows.
                let target = match args.peek().map(String::as_str) {
                    Some("host") => Some("runtime-host"),
                    Some("language") => Some("language"),
                    _ => None,
                };
                if target.is_some() {
                    args.next();
                }
                open = Some(Opening::FooterMenu(target.unwrap_or("language")));
            }
            "--open-task-menu" => open = Some(Opening::TaskMenu),
            "--open-folder-menu" => open = Some(Opening::FolderMenu),
            "--open-project-menu" => open = Some(Opening::ProjectMenu),
            "--scroll-to-top" => open = Some(Opening::TranscriptTop),
            "--open-skill" => {
                let skill_ref = args.next().ok_or("--open-skill needs a Skill's ref")?;
                open = Some(Opening::SkillDetail(skill_ref));
            }
            "--open-add-menu" => open = Some(Opening::AddMenu),
            "--open-scheduled-runs" => open = Some(Opening::ScheduledRuns),
            "--open-daily-review" => open = Some(Opening::DailyReview),
            "--open-daily-review-report" => open = Some(Opening::DailyReviewReport),
            "--open-scheduled-task-form" => open = Some(Opening::ScheduledTaskForm),
            "--open-scheduled-task" => {
                let id = args.next().ok_or("--open-scheduled-task needs a task's id")?;
                open = Some(Opening::ScheduledTaskDetail(id));
            }
            "--open-shortcuts" => open = Some(Opening::Shortcuts),
            "--press" => {
                let keys = args.next().ok_or("--press needs keys, for example \"tab enter\"")?;
                open = Some(Opening::Press(keys.split_whitespace().map(str::to_owned).collect()));
            }
            "--open-command-palette" => {
                let query = args.next_if(|arg| !arg.starts_with("--")).unwrap_or_default();
                open = Some(Opening::CommandPalette(query));
            }
            "--send" => sends.push(args.next().ok_or("--send needs a message")?),
            "--attach" => {
                attachments.push(PathBuf::from(args.next().ok_or("--attach needs a file")?))
            }
            "--open-settings" => {
                let value = args.next().ok_or("--open-settings needs a section")?;
                // `<section>:<target>` opens a place inside it.
                let (key, target) = match value.split_once(':') {
                    Some((key, target)) => (key, Some(target.to_owned())),
                    None => (value.as_str(), None),
                };
                let section = SettingsSection::from_key(key).ok_or_else(|| {
                    let keys: Vec<&str> = SettingsSection::listed().map(|s| s.key()).collect();
                    format!("--open-settings {value:?}: {}", keys.join(", "))
                })?;
                open = Some(Opening::Settings(section, target));
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    // These change what a person would keep as a preference; a passive
    // launch saves none, so they are allowed only there.
    if !passive && (ui_font_size.is_some() || narrow_sidebar.is_some()) {
        return Err(
            "--ui-font-size and --narrow-sidebar are for captures and need --passive".into()
        );
    }
    Ok(Args {
        root,
        host,
        hosts_dir,
        window_size,
        session,
        locale,
        appearance,
        pet,
        hide_sidebar,
        group_by_project,
        page,
        open,
        sends,
        attachments,
        passive,
        ui_font_size,
        narrow_sidebar,
    })
}

/// `1512x885` as a size in points, no smaller than the minimum window.
fn parse_window_size(value: &str) -> Result<Size<Pixels>, String> {
    let invalid =
        || format!("--window-size {value:?} is not <width>x<height>, for example 1512x885");
    let (width, height) = value.split_once('x').ok_or_else(invalid)?;
    let width: u32 = width.parse().map_err(|_| invalid())?;
    let height: u32 = height.parse().map_err(|_| invalid())?;
    let (min_width, min_height) = MIN_WINDOW_SIZE;
    if (width as f32) < min_width || (height as f32) < min_height {
        return Err(format!(
            "--window-size {value:?} is below the minimum window, {min_width}x{min_height}"
        ));
    }
    Ok(size(px(width as f32), px(height as f32)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, String> {
        parse_args(args.iter().map(|arg| arg.to_string()))
    }

    #[test]
    fn the_root_comes_from_the_flag_or_is_left_to_the_remembered_choice() {
        assert_eq!(
            parse(&["--root", "/tmp/r"]).map(|args| args.root),
            Ok(Some(PathBuf::from("/tmp/r")))
        );
        assert_eq!(parse(&[]).expect("no flag").root, None);
        assert!(parse(&["--root"]).is_err());
        assert!(parse(&["--bogus"]).is_err());
    }

    #[test]
    fn the_window_size_is_width_by_height_in_points() {
        let args = parse(&["--window-size", "1512x885", "--root", "/tmp/r"]).expect("args");
        assert_eq!(args.window_size, Some(size(px(1512.), px(885.))));
        assert_eq!(parse(&["--root", "/tmp/r"]).expect("args").window_size, None);
        for bad in ["1512", "1512x", "x885", "wide", "1512x885x2", "800x600"] {
            assert!(parse(&["--window-size", bad]).is_err(), "{bad}");
        }
        assert!(parse(&["--window-size"]).is_err());
    }

    #[test]
    fn a_launch_can_choose_its_host_and_where_hosts_are_kept() {
        let args = parse(&["--host", "remote-1", "--hosts-dir", "/tmp/hosts"]).expect("args");
        assert_eq!(args.host.as_deref(), Some("remote-1"));
        assert_eq!(args.hosts_dir, Some(PathBuf::from("/tmp/hosts")));
        assert_eq!(parse(&[]).expect("args").host, None);
        assert!(parse(&["--host"]).is_err());
        assert!(parse(&["--hosts-dir"]).is_err());
    }

    #[test]
    fn the_sidebar_can_start_hidden() {
        assert!(parse(&["--hide-sidebar"]).expect("args").hide_sidebar);
        assert!(parse(&["--passive"]).expect("args").passive);
        assert!(!parse(&[]).expect("args").passive);
        assert!(!parse(&[]).expect("args").hide_sidebar);
    }

    #[test]
    fn a_passive_launch_neither_reads_nor_saves_the_preferences() {
        assert!(preferences_store(true).is_none());
    }

    #[test]
    fn a_passive_launch_can_choose_its_font_size_and_narrow_sidebar() {
        let args = parse(&["--passive", "--ui-font-size", "11", "--narrow-sidebar", "hide"])
            .expect("args");
        assert_eq!(args.ui_font_size, Some(11));
        assert_eq!(args.narrow_sidebar, Some(NarrowSidebar::Hide));
        let args = parse(&["--narrow-sidebar", "icons", "--passive"]).expect("args");
        assert_eq!(args.narrow_sidebar, Some(NarrowSidebar::Icons));
        assert_eq!(parse(&["--passive"]).expect("args").ui_font_size, None);
        for bad in ["10", "23", "big", ""] {
            assert!(parse(&["--passive", "--ui-font-size", bad]).is_err(), "{bad:?}");
        }
        assert!(parse(&["--passive", "--narrow-sidebar", "rail"]).is_err());
        assert!(parse(&["--passive", "--ui-font-size"]).is_err());
        // Without --passive they would ride along into a later save.
        assert!(parse(&["--ui-font-size", "11"]).is_err());
        assert!(parse(&["--narrow-sidebar", "hide"]).is_err());
    }

    #[test]
    fn the_task_list_can_start_grouped_by_project() {
        assert!(parse(&["--group-by-project"]).expect("args").group_by_project);
        assert!(!parse(&[]).expect("args").group_by_project);
    }

    #[test]
    fn a_launch_can_open_a_composer_menu() {
        assert_eq!(parse(&["--open-model-menu"]).expect("args").open, Some(Opening::ModelMenu));
        assert_eq!(
            parse(&["--open-permission-menu"]).expect("args").open,
            Some(Opening::PermissionMenu)
        );
        assert_eq!(
            parse(&["--open-add-connection"]).expect("args").open,
            Some(Opening::AddConnection)
        );
        assert_eq!(
            parse(&["--open-footer-menu"]).expect("args").open,
            Some(Opening::FooterMenu("language"))
        );
        assert_eq!(
            parse(&["--open-footer-menu", "host", "--passive"]).expect("args").open,
            Some(Opening::FooterMenu("runtime-host"))
        );
        assert_eq!(parse(&["--open-task-menu"]).expect("args").open, Some(Opening::TaskMenu));
        assert_eq!(parse(&["--open-folder-menu"]).expect("args").open, Some(Opening::FolderMenu));
        assert_eq!(parse(&["--open-project-menu"]).expect("args").open, Some(Opening::ProjectMenu));
        assert_eq!(parse(&["--open-shortcuts"]).expect("args").open, Some(Opening::Shortcuts));
        assert_eq!(
            parse(&["--press", "tab  enter"]).expect("args").open,
            Some(Opening::Press(vec!["tab".into(), "enter".into()]))
        );
        assert!(parse(&["--press"]).is_err());
        assert_eq!(
            parse(&["--open-command-palette", "dark"]).expect("args").open,
            Some(Opening::CommandPalette("dark".into()))
        );
        assert_eq!(
            parse(&["--open-command-palette", "--hide-sidebar"]).expect("args").open,
            Some(Opening::CommandPalette(String::new()))
        );
        for (key, section) in [
            ("about", SettingsSection::About),
            ("appearance", SettingsSection::Appearance),
            ("models", SettingsSection::Models),
            // The settings dialog's ids, for scripts written against it.
            ("connections", SettingsSection::Models),
            ("permissions", SettingsSection::General),
            ("projects", SettingsSection::Projects),
        ] {
            assert_eq!(
                parse(&["--open-settings", key]).expect("args").open,
                Some(Opening::Settings(section, None)),
                "{key}"
            );
        }
        assert_eq!(
            parse(&["--open-settings", "general:end"]).expect("args").open,
            Some(Opening::Settings(SettingsSection::General, Some("end".into())))
        );
        assert_eq!(
            parse(&["--open-settings", "models:parameters:my-relay:m1"]).expect("args").open,
            Some(Opening::Settings(SettingsSection::Models, Some("parameters:my-relay:m1".into())))
        );
        assert!(parse(&["--open-settings", "external-agents"]).is_err(), "not built yet");
        assert!(parse(&["--open-settings", "nope"]).is_err());
        assert!(parse(&["--open-settings"]).is_err());
        assert_eq!(parse(&[]).expect("args").open, None);
    }

    #[test]
    fn a_launch_can_open_a_page() {
        assert_eq!(
            parse(&["--open-page", "extensions"]).expect("args").page,
            Some(SidebarPage::Extensions)
        );
        assert_eq!(
            parse(&["--open-page", "scheduled-tasks", "--open-shortcuts"]).expect("args").page,
            Some(SidebarPage::ScheduledTasks)
        );
        assert_eq!(parse(&[]).expect("args").page, None);
        assert!(parse(&["--open-page", "mcp"]).is_err(), "not a page of this client");
        assert_eq!(
            parse(&["--open-skill", "user:maka:brief"]).expect("args").open,
            Some(Opening::SkillDetail("user:maka:brief".into()))
        );
        assert!(parse(&["--open-skill"]).is_err());
        assert_eq!(parse(&["--open-add-menu"]).expect("args").open, Some(Opening::AddMenu));
        assert!(parse(&["--open-page"]).is_err());
        for (flag, opening) in [
            ("--open-scheduled-runs", Opening::ScheduledRuns),
            ("--open-daily-review", Opening::DailyReview),
            ("--open-daily-review-report", Opening::DailyReviewReport),
            ("--open-scheduled-task-form", Opening::ScheduledTaskForm),
        ] {
            assert_eq!(parse(&[flag]).expect("args").open, Some(opening), "{flag}");
        }
        assert_eq!(
            parse(&["--open-scheduled-task", "t1"]).expect("args").open,
            Some(Opening::ScheduledTaskDetail("t1".into()))
        );
        assert!(parse(&["--open-scheduled-task"]).is_err());
    }

    #[test]
    fn the_traffic_lights_follow_the_chrome_band_as_the_font_size_scales_it() {
        assert_eq!(traffic_lights(14), point(px(16.), px(25.)));
        // The band's centre line, 32 points down at the default, at 1.5×.
        assert_eq!(traffic_lights(21), point(px(24.), px(32. * 1.5 - 7.)));
        // And at Desktop's smallest size: the 14-point lights stay inside
        // the 38-point band, and end (about x 67) well before the window
        // controls after the title bar's 80-point inset.
        let scale = 11. / 14.;
        assert_eq!(traffic_lights(11), point(px(16. * scale), px(32. * scale - 7.)));
    }

    #[test]
    fn a_launch_can_choose_the_language() {
        assert_eq!(
            parse(&["--locale", "zh-CN"]).expect("args").locale,
            Some(Locale::SimplifiedChinese)
        );
        assert_eq!(
            parse(&["--locale", "zh-Hant"]).expect("args").locale,
            Some(Locale::TraditionalChinese)
        );
        assert_eq!(parse(&[]).expect("args").locale, None);
        assert!(parse(&["--locale", "fr"]).is_err());
        assert!(parse(&["--locale"]).is_err());
    }

    #[test]
    fn a_launch_can_choose_the_appearance() {
        assert_eq!(
            parse(&["--appearance", "dark"]).expect("args").appearance,
            Some(Appearance::Dark)
        );
        assert_eq!(parse(&[]).expect("args").appearance, None);
        assert!(parse(&["--appearance", "sepia"]).is_err());
        assert!(parse(&["--appearance"]).is_err());
    }

    #[test]
    fn a_launch_can_show_a_pet() {
        let id = parse(&["--pet", "likun.maodie"]).expect("args").pet;
        assert_eq!(id.map(|id| id.to_string()).as_deref(), Some("likun.maodie"));
        assert!(parse(&["--pet", "../up"]).is_err());
        assert!(parse(&["--pet"]).is_err());
    }

    #[test]
    fn a_session_can_be_named() {
        assert_eq!(parse(&["--session", "s1"]).expect("args").session.as_deref(), Some("s1"));
        assert_eq!(parse(&[]).expect("args").session, None);
        assert!(parse(&["--session"]).is_err());
    }
}
