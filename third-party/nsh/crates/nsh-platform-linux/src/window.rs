//! The app's windows (`nsh/desktop`'s `Window`, `WindowRef`): the main
//! window and the windows of the app's own, each a dialog root (a `modal`
//! node) of the same engine shown in a `gtk::Window` of its own instead of
//! over the main window. The engine, the JS runtime and the core stay one,
//! so the windows share the app's state; this module hosts the root views,
//! applies the attributes the core sends (a diff per commit), carries out
//! the requests, answers the policies the app set (close presses, Escape,
//! losing the focus) natively and reports each window's state.
//!
//! - **Opening**: a window opens hidden, its root laid out at its size
//!   first; it shows once the commit after that is mounted, so it never
//!   shows empty. Dialogs and panels are transient for their parent
//!   (`modal` makes the parent take no input).
//! - **State**: the main window's goes in the environment, the others' as
//!   window events; a resize is reported once it settles. GTK 4 tells no
//!   window's position, so a window's bounds start at the origin.
//! - **What GTK 4 has no API for** is left as it is, silently: positions
//!   (`defaultPosition`, `center`, the origin of `setBounds`), levels,
//!   the taskbar, workspaces, a largest size, an aspect ratio, focusability,
//!   backdrops, a window's own color scheme, content protection, documents
//!   and tab groups. Progress and attention go to the app's launcher entry
//!   (the Unity launcher API, which docks such as Dash to Dock and Plank
//!   listen to) where one listens.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use gtk4::{self as gtk, cairo, gdk, gio, glib, prelude::*};
use nsh_core::{
    Bounds, EdgeInsets, EventKind, EventPayload, NodeId, Points, ROOT_ID, Size,
    desktop::{
        CloseReason, DesktopCommand, Display, DisplayId, MainWindowOptions, OpenWindow, ResizeEdge,
        TitleBarOptions, TitleBarStyle, WindowAttributes, WindowCloseCause, WindowControl,
        WindowEvent, WindowFrameStyle, WindowKind, WindowMode, WindowPlacement,
        WindowPointerEvents, WindowProgress, WindowRequest, WindowState,
    },
    geometry::{point, size},
};

use crate::{surface::Surface, view::NshView};

/// A window's content size when nothing gives one, in points.
const DEFAULT_SIZE: (f32, f32) = (480.0, 360.0);
/// How long a window's size stays put before its resize is reported.
const SETTLE: Duration = Duration::from_millis(150);
/// How long a new window waits for its first frame at most.
const FIRST_FRAME: Duration = Duration::from_millis(150);
/// The hidden title bar's height at least, in points (Adwaita's header
/// bar), and the space around the window buttons.
const HEADER_HEIGHT: f32 = 46.0;
const MARGIN: i32 = 6;

thread_local! {
    /// How the close press being handled was asked for: the close key's
    /// shortcut sets it before it closes the window; anything else is the
    /// close button (GTK does not tell the window manager's close from it).
    static REASON: Cell<Option<CloseReason>> = const { Cell::new(None) };
    /// The app quits: its windows close without asking anyone.
    static QUITTING: Cell<bool> = const { Cell::new(false) };
    /// What the app's launcher entry shows.
    static LAUNCHER: RefCell<Launcher> = RefCell::default();
    /// Counts the windows shown activated ([`AppWindow::shown`]).
    static SHOWN: Cell<u64> = const { Cell::new(0) };
}

/// The header a window of the app's own shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Header {
    /// The system's: GTK's header bar, or the window manager's frame.
    #[default]
    System,
    /// A header bar of ours, for the buttons the attributes leave.
    Bar,
    /// None: the app draws its title bar, the window buttons over it.
    Hidden,
}

/// What a window's state reports keep.
#[derive(Default)]
struct Tracker {
    /// What was reported last.
    last: Option<WindowState>,
    /// The bounds of the last time it was in the normal mode.
    normal: Option<Bounds<Points>>,
    /// A resize waiting to settle.
    settle: Option<glib::SourceId>,
}

/// A window of the app's own.
pub(crate) struct AppWindow {
    window: gtk::Window,
    overlay: gtk::Overlay,
    view: glib::WeakRef<NshView>,
    /// The root node of the window that owns it.
    parent: Option<NodeId>,
    /// Its attributes, as the core sent them.
    attributes: WindowAttributes,
    /// The size last reported to the core.
    reported: Option<Size<Points>>,
    /// Not shown yet: `Some(true)` once the commit that opened it is
    /// mounted (the next one shows it).
    pending: Option<bool>,
    header: Header,
    /// The window buttons at the start and the end, while the title bar is
    /// hidden.
    controls: Option<(gtk::WindowControls, gtk::WindowControls)>,
    tracker: Tracker,
    /// It was active since it last showed (losing the focus closes it with
    /// `closeOnBlur` only then).
    active_once: bool,
    /// It lets the pointer through (an empty input region).
    no_input: bool,
    /// When it last showed activated (a count): the newest is the key
    /// window when the system tells none.
    shown: u64,
    /// The title bar area reported last (`WindowEvent::TitleBar`).
    title_bar: Option<EdgeInsets>,
}

/// What the main window keeps.
pub(crate) struct MainWindow {
    /// Its attributes: a normal window's, with what the app set over them.
    attributes: WindowAttributes,
    normal: Option<Bounds<Points>>,
    /// The app closes it (`close()`): the close is not a press.
    closing: bool,
    /// The displays are followed.
    displays_watched: bool,
    /// It lets the pointer through (an empty input region).
    no_input: bool,
}

impl Default for MainWindow {
    fn default() -> Self {
        MainWindow {
            attributes: WindowAttributes::for_kind(WindowKind::Normal),
            normal: None,
            closing: false,
            displays_watched: false,
            no_input: false,
        }
    }
}

/// What the user may do to a window (the attributes of user actions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Allowed {
    pub(crate) movable: bool,
    pub(crate) resizable: bool,
    pub(crate) minimizable: bool,
    pub(crate) maximizable: bool,
}

impl Allowed {
    fn of(a: &WindowAttributes) -> Allowed {
        Allowed {
            movable: a.movable != Some(false),
            resizable: a.resizable != Some(false),
            minimizable: a.minimizable != Some(false),
            maximizable: a.maximizable != Some(false) && a.resizable != Some(false),
        }
    }
}

/// What a close press does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    /// Nothing: the window cannot be closed by the user.
    Ignore,
    /// The app hears it and decides.
    Report,
    /// The window closes, and the app hears it.
    Close,
}

fn close_decision(a: &WindowAttributes) -> Decision {
    if a.closable == Some(false) {
        Decision::Ignore
    } else if a.close_on_press == Some(false) {
        Decision::Report
    } else {
        Decision::Close
    }
}

// --- Lookups ----------------------------------------------------------------------------

/// Whether dialog root `id` is shown in a window of its own.
pub(crate) fn is_window(surface: &Surface, id: NodeId) -> bool {
    surface.windows.borrow().contains_key(&id)
}

/// The window the surface is in.
fn main_window(surface: &Surface) -> Option<gtk::Window> {
    surface.root.root().and_downcast::<gtk::Window>()
}

/// The `gtk::Window` of window `id` (its root node).
fn gtk_window(surface: &Surface, id: NodeId) -> Option<gtk::Window> {
    if id == ROOT_ID {
        main_window(surface)
    } else {
        surface.windows.borrow().get(&id).map(|w| w.window.clone())
    }
}

/// The root node of `window`.
fn id_of(surface: &Surface, window: &gtk::Window) -> Option<NodeId> {
    if main_window(surface).as_ref() == Some(window) {
        return Some(ROOT_ID);
    }
    surface
        .windows
        .borrow()
        .iter()
        .find(|(_, w)| &w.window == window)
        .map(|(id, _)| *id)
}

/// What the user may do to `window`.
pub(crate) fn allowed(surface: &Surface, window: &gtk::Window) -> Allowed {
    match id_of(surface, window) {
        Some(ROOT_ID) | None => Allowed::of(&surface.main_window.borrow().attributes),
        Some(id) => surface
            .windows
            .borrow()
            .get(&id)
            .map_or(Allowed::of(&WindowAttributes::default()), |w| {
                Allowed::of(&w.attributes)
            }),
    }
}

fn pixels(v: f32) -> i32 {
    (v.round() as i32).max(1)
}

// --- Commands ---------------------------------------------------------------------------

/// A desktop command addressed to dialog root `id`.
pub(crate) fn command(
    surface: &Rc<Surface>,
    id: NodeId,
    view: Option<&NshView>,
    command: &DesktopCommand,
) {
    match command {
        DesktopCommand::OpenWindow(open_window) => match view {
            Some(view) => open(surface, view, open_window),
            None => log::warn!("window: no view {id}"),
        },
        DesktopCommand::SetAttributes(attributes) => set_attributes(surface, id, attributes),
        DesktopCommand::Request(r) => request(surface, id, r),
        // Menus, the tray and shortcuts are the root's.
        _ => {}
    }
}

/// Shows dialog root `view` in a new window, hidden until its first frame
/// is mounted.
fn open(surface: &Rc<Surface>, view: &NshView, open: &OpenWindow) {
    let id = view.id();
    if is_window(surface, id) {
        return;
    }
    // Presented over the main window by its insertion, earlier in the
    // batch: it leaves the surface's modals.
    crate::navigation::release(surface, id);
    if view.parent().is_some() {
        view.unparent();
    }
    let options = &open.options;
    let window = gtk::Window::new();
    let main = main_window(surface);
    if let Some(app) = main.as_ref().and_then(|w| w.application()) {
        window.set_application(Some(&app));
    }
    let parent = open.parent.and_then(|p| gtk_window(surface, p));
    if let Some(parent) = &parent {
        window.set_transient_for(Some(parent));
    }
    window.set_modal(options.modal && parent.is_some());
    let content = open
        .placement
        .map(|p| p.bounds.size)
        .or(options.default_size)
        .unwrap_or(size(Points(DEFAULT_SIZE.0), Points(DEFAULT_SIZE.1)));
    window.set_default_size(pixels(content.width.0), pixels(content.height.0));
    let mode = open
        .placement
        .map(|p| p.mode)
        .or(options.default_mode)
        .unwrap_or_default();
    match mode {
        WindowMode::Normal => {}
        WindowMode::Maximized => window.maximize(),
        WindowMode::FullScreen => match options.display.and_then(monitor) {
            Some(monitor) => window.fullscreen_on_monitor(&monitor),
            None => window.fullscreen(),
        },
    }
    let overlay = gtk::Overlay::new();
    view.set_hexpand(true);
    view.set_vexpand(true);
    overlay.set_child(Some(view));
    window.set_child(Some(&overlay));
    connect(surface, id, &window, view);
    crate::input::install_on(surface, view, Some(view));
    surface.windows.borrow_mut().insert(
        id,
        AppWindow {
            window: window.clone(),
            overlay,
            view: view.downgrade(),
            parent: open.parent,
            attributes: WindowAttributes::default(),
            reported: None,
            pending: Some(false),
            header: Header::System,
            controls: None,
            tracker: Tracker::default(),
            active_once: false,
            no_input: false,
            shown: 0,
            title_bar: None,
        },
    );
    set_attributes(surface, id, &options.attributes);
    // The root is laid out at the window's size before it shows (the
    // allocation corrects it once mapped).
    resize(surface, view, content.width.0, content.height.0);
    let weak = Rc::downgrade(surface);
    glib::timeout_add_local_once(FIRST_FRAME, move || {
        if let Some(surface) = weak.upgrade() {
            show_first(&surface, id);
        }
    });
}

/// Follows window `id`'s size, state, focus and close presses.
fn connect(surface: &Rc<Surface>, id: NodeId, window: &gtk::Window, view: &NshView) {
    // Its own focus chain: Tab stops, focus events, a stop's keys.
    crate::key_focus::watch(surface, window);
    // The app's shortcuts, with the focus in its content first.
    crate::keymap::attach(surface, view);
    // The keyboard scrolls its scroll views.
    crate::scroll::watch_keys(surface, window, view);
    // The mouse's back button goes back in it, as Escape does.
    let back = gtk::GestureClick::new();
    back.set_button(8);
    let weak = Rc::downgrade(surface);
    back.connect_pressed(move |gesture, _, _, _| {
        if let Some(surface) = weak.upgrade()
            && crate::navigation::go_back_in(&surface, id)
        {
            gesture.set_state(gtk::EventSequenceState::Claimed);
        }
    });
    window.add_controller(back);
    let weak = Rc::downgrade(surface);
    let resized = view.downgrade();
    view.on_resize(move |width, height| {
        if let (Some(surface), Some(view)) = (weak.upgrade(), resized.upgrade()) {
            resize(&surface, &view, width, height);
            pass_pointer(&surface, id);
            state_changed(&surface, id);
        }
    });
    let changed = move |surface: &Rc<Surface>| {
        let weak = Rc::downgrade(surface);
        move |_: &gtk::Window| {
            if let Some(surface) = weak.upgrade() {
                state_changed(&surface, id);
            }
        }
    };
    window.connect_maximized_notify(changed(surface));
    window.connect_fullscreened_notify(changed(surface));
    window.connect_visible_notify(changed(surface));
    let weak = Rc::downgrade(surface);
    window.connect_is_active_notify(move |window| {
        if let Some(surface) = weak.upgrade() {
            active_changed(&surface, id, window.is_active());
            state_changed(&surface, id);
        }
    });
    let weak = Rc::downgrade(surface);
    window.connect_realize(move |window| {
        let Some(gdk_surface) = window.surface() else {
            return;
        };
        let follow = |weak: std::rc::Weak<Surface>| {
            move || {
                if let Some(surface) = weak.upgrade() {
                    state_changed(&surface, id);
                }
            }
        };
        let f = follow(weak.clone());
        gdk_surface.connect_scale_notify(move |_| f());
        let f = follow(weak.clone());
        gdk_surface.connect_enter_monitor(move |_, _| f());
        if let Some(toplevel) = gdk_surface.downcast_ref::<gdk::Toplevel>() {
            let f = follow(weak.clone());
            toplevel.connect_state_notify(move |_| f());
        }
    });
    let weak = Rc::downgrade(surface);
    window.connect_map(move |_| {
        let weak = weak.clone();
        // After GTK set the surface's own input region.
        glib::idle_add_local_once(move || {
            if let Some(surface) = weak.upgrade() {
                pass_pointer(&surface, id);
            }
        });
    });
    let weak = Rc::downgrade(surface);
    window.connect_close_request(move |_| {
        let Some(surface) = weak.upgrade() else {
            return glib::Propagation::Proceed;
        };
        if QUITTING.get() || !is_window(&surface, id) {
            return glib::Propagation::Proceed;
        }
        close_press(&surface, id, take_reason());
        glib::Propagation::Stop
    });
    let weak = Rc::downgrade(surface);
    let keys = gtk::EventControllerKey::new();
    keys.connect_key_pressed(move |_, key, _, state| match weak.upgrade() {
        Some(surface) if window_key(&surface, id, key, state) => glib::Propagation::Stop,
        _ => glib::Propagation::Proceed,
    });
    window.add_controller(keys);
    close_shortcut(window);
    // The main window takes its windows with it.
    if let Some(main) = main_window(surface) {
        let weak = window.downgrade();
        main.connect_destroy(move |_| {
            if let Some(window) = weak.upgrade() {
                window.destroy();
            }
        });
    }
}

/// A key nothing in window `id` of the app's own used: going back among
/// its modals and stacks first (Escape, Alt+Left), then `closeOnEscape`.
/// Whether it was taken.
fn window_key(surface: &Rc<Surface>, id: NodeId, key: gdk::Key, state: gdk::ModifierType) -> bool {
    if crate::navigation::key_pressed_in(surface, id, key, state) {
        return true;
    }
    let plain = !state.intersects(
        gdk::ModifierType::CONTROL_MASK
            | gdk::ModifierType::ALT_MASK
            | gdk::ModifierType::SHIFT_MASK
            | gdk::ModifierType::SUPER_MASK,
    );
    let escape = key == gdk::Key::Escape
        && plain
        && surface
            .windows
            .borrow()
            .get(&id)
            .is_some_and(|w| w.attributes.close_on_escape == Some(true));
    if escape {
        policy_close(surface, id, WindowCloseCause::Escape);
    }
    escape
}

/// Ctrl+W closes `window` as a press of the close key (a bubble-phase
/// shortcut: the app's own Ctrl+W comes first).
pub(crate) fn close_shortcut(window: &gtk::Window) {
    let close = gtk::ShortcutController::new();
    close.set_propagation_phase(gtk::PropagationPhase::Bubble);
    close.add_shortcut(gtk::Shortcut::new(
        gtk::ShortcutTrigger::parse_string("<Control>w"),
        Some(gtk::CallbackAction::new(|widget, _| {
            if let Some(window) = widget.downcast_ref::<gtk::Window>() {
                press_close(window, CloseReason::Shortcut);
            }
            glib::Propagation::Stop
        })),
    ));
    window.add_controller(close);
}

/// Closes `window` as the user pressing `reason` would (its policies
/// apply).
pub(crate) fn press_close(window: &gtk::Window, reason: CloseReason) {
    REASON.set(Some(reason));
    window.close();
    REASON.set(None);
}

fn take_reason() -> CloseReason {
    REASON.take().unwrap_or(CloseReason::CloseButton)
}

/// The app quits: windows close without their policies.
pub(crate) fn set_quitting() {
    QUITTING.set(true);
}

/// The window's root view was given `width` × `height`: the core lays the
/// root out at that size.
fn resize(surface: &Surface, view: &NshView, width: f32, height: f32) {
    let id = view.id();
    let size = Size::new(Points(width), Points(height));
    {
        let mut windows = surface.windows.borrow_mut();
        let Some(w) = windows.get_mut(&id) else {
            return;
        };
        if w.reported == Some(size) {
            return;
        }
        w.reported = Some(size);
    }
    let frame = Bounds::new(point(Points(0.0), Points(0.0)), size);
    if std::mem::replace(&mut view.state_mut().frame, frame) != frame {
        view.queue_allocate();
    }
    surface.control(|c| c.set_root_size(id, size, EdgeInsets::default()));
    // The dialogs shown in it follow.
    crate::navigation::resize_modals(surface);
    crate::system::root_resized(view, width, height);
}

/// A batch was mounted: the windows whose first frame it holds show.
pub(crate) fn batch_applied(surface: &Rc<Surface>) {
    let ready: Vec<NodeId> = {
        let mut windows = surface.windows.borrow_mut();
        if windows.is_empty() {
            return;
        }
        windows
            .iter_mut()
            .filter_map(|(id, w)| match w.pending {
                Some(false) => {
                    w.pending = Some(true);
                    None
                }
                Some(true) => Some(*id),
                None => None,
            })
            .collect()
    };
    for id in ready {
        show_first(surface, id);
    }
}

/// Shows window `id` the first time, unless it showed or was hidden.
fn show_first(surface: &Rc<Surface>, id: NodeId) {
    let first = surface
        .windows
        .borrow_mut()
        .get_mut(&id)
        .is_some_and(|w| w.pending.take().is_some());
    if first {
        show(surface, id);
    }
}

/// Shows window `id`, activating it when its `activate` says so.
fn show(surface: &Surface, id: NodeId) {
    let Some((window, activate)) = surface.windows.borrow_mut().get_mut(&id).map(|w| {
        w.pending = None;
        w.active_once = false;
        let activate = w.attributes.activate != Some(false);
        if activate {
            SHOWN.set(SHOWN.get() + 1);
            w.shown = SHOWN.get();
        }
        (w.window.clone(), activate)
    }) else {
        return;
    };
    if activate {
        window.present();
    } else {
        window.set_visible(true);
    }
}

/// Hides window `id`.
fn hide(surface: &Surface, id: NodeId) {
    let Some(window) = surface.windows.borrow_mut().get_mut(&id).map(|w| {
        w.pending = None;
        w.window.clone()
    }) else {
        return;
    };
    window.set_visible(false);
}

// --- Attributes -------------------------------------------------------------------------

/// The attributes of window `id` that changed.
fn set_attributes(surface: &Rc<Surface>, id: NodeId, diff: &WindowAttributes) {
    let Some((window, view, full)) = surface.windows.borrow_mut().get_mut(&id).map(|w| {
        w.attributes.merge(diff);
        (w.window.clone(), w.view.upgrade(), w.attributes.clone())
    }) else {
        return log::debug!("window: no window for {id}");
    };
    if let Some(title) = &diff.title {
        // The app's name until it gives one.
        let main_title = main_window(surface).and_then(|w| w.title());
        match main_title {
            Some(main) if title.is_empty() => window.set_title(Some(&main)),
            _ => window.set_title(Some(title)),
        }
    }
    if let Some(view) = &view {
        apply(surface, &window, view.upcast_ref(), &full, diff);
    }
    if diff.title_bar.is_some()
        || diff.frame.is_some()
        || diff.minimizable.is_some()
        || diff.maximizable.is_some()
        || diff.closable.is_some()
        || diff.resizable.is_some()
    {
        update_header(surface, id);
    }
    if diff.pointer_events.is_some() {
        pass_pointer(surface, id);
    }
}

/// Window `id` of the app's own takes the app's appearance (the root's
/// background, the menus in it).
fn apply_scheme(surface: &Surface, id: NodeId) {
    let Some(root) = surface
        .windows
        .borrow()
        .get(&id)
        .and_then(|w| w.view.upgrade())
    else {
        return;
    };
    let (add, remove) = if main_dark(surface) {
        ("nsh-dark", "nsh-light")
    } else {
        ("nsh-light", "nsh-dark")
    };
    root.remove_css_class(remove);
    root.add_css_class(add);
}

/// Whether the app's content is dark (its appearance).
pub(crate) fn main_dark(surface: &Surface) -> bool {
    surface.environment.get().color_scheme == nsh_core::platform::ColorScheme::Dark
}

/// The app's appearance changed: every window of its own follows.
pub(crate) fn schemes_applied(surface: &Surface) {
    let ids: Vec<NodeId> = surface.windows.borrow().keys().copied().collect();
    for id in ids {
        apply_scheme(surface, id);
    }
}

/// What the main window and the others apply alike: `content` is the
/// widget the app's root fills.
fn apply(
    surface: &Surface,
    window: &gtk::Window,
    content: &gtk::Widget,
    full: &WindowAttributes,
    diff: &WindowAttributes,
) {
    if let Some(frame) = diff.frame {
        window.set_decorated(frame != WindowFrameStyle::None);
    }
    if let Some(resizable) = diff.resizable {
        window.set_resizable(resizable);
    }
    if diff.min_size.is_some() || diff.resizable.is_some() {
        size_request(window, content, full, None);
    }
    if let Some(closable) = diff.closable {
        window.set_deletable(closable);
    }
    if let Some(transparent) = diff.transparent {
        set_class(window, "nsh-transparent", transparent);
    }
    if let Some(shadow) = diff.shadow {
        set_class(window, "nsh-no-shadow", !shadow);
    }
    if let Some(progress) = &diff.progress {
        launcher_progress(surface, *progress);
    }
}

fn set_class(window: &gtk::Window, class: &str, on: bool) {
    if on {
        window.add_css_class(class);
    } else {
        window.remove_css_class(class);
    }
}

/// The least size of the content: `minSize`, and a window the user may
/// not resize keeps `fixed` (or the size it has).
fn size_request(
    window: &gtk::Window,
    content: &gtk::Widget,
    a: &WindowAttributes,
    fixed: Option<(i32, i32)>,
) {
    let (mut width, mut height) = a.min_size.flatten().map_or((-1, -1), |s| {
        (s.width.0.ceil() as i32, s.height.0.ceil() as i32)
    });
    if a.resizable == Some(false) {
        let (w, h) = fixed.unwrap_or_else(|| {
            let (w, h) = (content.width(), content.height());
            if w > 0 && h > 0 {
                (w, h)
            } else {
                window.default_size()
            }
        });
        width = width.max(w);
        height = height.max(h);
    }
    content.set_size_request(width, height);
}

/// Gives window `id` the header its title bar, frame and buttons ask for,
/// and the window buttons over a hidden title bar.
fn update_header(surface: &Rc<Surface>, id: NodeId) {
    let Some((window, overlay, a, current)) = surface.windows.borrow().get(&id).map(|w| {
        (
            w.window.clone(),
            w.overlay.clone(),
            w.attributes.clone(),
            w.header,
        )
    }) else {
        return;
    };
    let title_bar = a.title_bar.unwrap_or_default();
    let allowed = Allowed::of(&a);
    let layout = decoration_layout(
        &system_layout(),
        allowed.minimizable,
        allowed.maximizable,
        a.closable != Some(false),
    );
    let want = if title_bar.style == TitleBarStyle::Hidden {
        Header::Hidden
    } else if !allowed.minimizable || !allowed.maximizable {
        Header::Bar
    } else {
        Header::System
    };
    if want != current {
        let titlebar: Option<gtk::Widget> = match want {
            Header::System => None,
            Header::Bar => Some(gtk::HeaderBar::new().upcast()),
            Header::Hidden => {
                let empty = gtk::Box::new(gtk::Orientation::Horizontal, 0);
                empty.set_visible(false);
                Some(empty.upcast())
            }
        };
        if window.is_realized() {
            crate::chrome::set_titlebar(&window, titlebar.as_ref());
        } else {
            window.set_titlebar(titlebar.as_ref());
        }
    }
    if let Some(bar) = window.titlebar().and_downcast::<gtk::HeaderBar>() {
        bar.set_decoration_layout(Some(&layout));
    }
    let controls = if want == Header::Hidden {
        let existing = surface
            .windows
            .borrow()
            .get(&id)
            .and_then(|w| w.controls.clone());
        let controls = existing.unwrap_or_else(|| {
            let make = |pack: gtk::PackType, align: gtk::Align| {
                let controls = gtk::WindowControls::new(pack);
                controls.set_halign(align);
                controls.set_valign(gtk::Align::Start);
                controls.set_margin_start(MARGIN);
                controls.set_margin_end(MARGIN);
                overlay.add_overlay(&controls);
                controls
            };
            (
                make(gtk::PackType::Start, gtk::Align::Start),
                make(gtk::PackType::End, gtk::Align::End),
            )
        });
        for c in [&controls.0, &controls.1] {
            c.set_decoration_layout(Some(&layout));
        }
        place_controls(&controls, title_bar);
        // Measured again once styled: the buttons' sizes come from the
        // theme.
        let again = controls.clone();
        glib::idle_add_local_once(move || place_controls(&again, title_bar));
        Some(controls)
    } else {
        let taken = surface
            .windows
            .borrow_mut()
            .get_mut(&id)
            .and_then(|w| w.controls.take());
        if let Some((start, end)) = taken {
            overlay.remove_overlay(&start);
            overlay.remove_overlay(&end);
        }
        None
    };
    if let Some(w) = surface.windows.borrow_mut().get_mut(&id) {
        w.header = want;
        w.controls = controls;
    }
    title_bar_changed(surface, id);
    // Again once the buttons are styled (their sizes come from the theme).
    let weak = Rc::downgrade(surface);
    glib::idle_add_local_once(move || {
        if let Some(surface) = weak.upgrade() {
            title_bar_changed(&surface, id);
        }
    });
}

/// The area the app's title bar takes in window `id`: its height and the
/// widths of the window buttons over it; nothing while the system shows
/// its title bar or the window is in full screen.
fn title_bar_area(surface: &Surface, id: NodeId) -> EdgeInsets {
    let windows = surface.windows.borrow();
    let Some(w) = windows.get(&id) else {
        return EdgeInsets::default();
    };
    let Some(controls) = w.controls.as_ref() else {
        return EdgeInsets::default();
    };
    if w.header != Header::Hidden || w.window.is_fullscreen() {
        return EdgeInsets::default();
    }
    let bar = w.attributes.title_bar.unwrap_or_default();
    let width = |c: &gtk::WindowControls| {
        if !c.is_visible() || c.is_empty() {
            return 0.0;
        }
        let measured = c.measure(gtk::Orientation::Horizontal, -1).1;
        // With its margins: the app keeps its own content clear of both.
        measured.max(0) as f32
    };
    EdgeInsets {
        top: Points(bar_height(controls, &bar)),
        left: Points(width(&controls.0)),
        right: Points(width(&controls.1)),
        bottom: Points(0.0),
    }
}

/// Reports window `id`'s title bar area when it changed.
fn title_bar_changed(surface: &Surface, id: NodeId) {
    let area = title_bar_area(surface, id);
    {
        let mut windows = surface.windows.borrow_mut();
        let Some(w) = windows.get_mut(&id) else {
            return;
        };
        if w.title_bar == Some(area) {
            return;
        }
        w.title_bar = Some(area);
    }
    report(surface, id, WindowEvent::TitleBar(area));
}

/// The height of window buttons `w`, without their margins.
fn controls_height(w: &gtk::WindowControls) -> i32 {
    let measured = w.measure(gtk::Orientation::Vertical, -1).1;
    (measured - w.margin_top() - w.margin_bottom()).max(0)
}

/// The app's title bar's height: the one it set, else a header bar's,
/// tall enough for the buttons.
fn bar_height(controls: &(gtk::WindowControls, gtk::WindowControls), bar: &TitleBarOptions) -> f32 {
    bar.height.map_or_else(
        || {
            let buttons = controls_height(&controls.0).max(controls_height(&controls.1));
            HEADER_HEIGHT.max((buttons + 2 * MARGIN) as f32)
        },
        |h| h.0,
    )
}

/// Centers the window buttons in the app's title bar.
fn place_controls(controls: &(gtk::WindowControls, gtk::WindowControls), bar: TitleBarOptions) {
    let top = bar_height(controls, &bar);
    for c in [&controls.0, &controls.1] {
        c.set_visible(!c.is_empty());
        c.set_margin_top(((top - controls_height(c) as f32) / 2.0).round().max(0.0) as i32);
    }
}

/// The desktop's window buttons (`gtk-decoration-layout`).
fn system_layout() -> String {
    gtk::Settings::default()
        .and_then(|s| s.gtk_decoration_layout())
        .map_or_else(|| ":minimize,maximize,close".to_owned(), |l| l.to_string())
}

/// `layout` (GTK's `start:end` lists of buttons) without the buttons the
/// window does not allow.
fn decoration_layout(layout: &str, minimize: bool, maximize: bool, close: bool) -> String {
    layout
        .split(':')
        .map(|side| {
            side.split(',')
                .filter(|item| match item.trim() {
                    "minimize" => minimize,
                    "maximize" => maximize,
                    "close" => close,
                    _ => true,
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join(":")
}

/// Lets the pointer through window `id` (`pointerEvents: "none"`) with an
/// empty input region, or gives it back.
fn pass_pointer(surface: &Surface, id: NodeId) {
    let none = |a: &WindowAttributes| a.pointer_events == Some(WindowPointerEvents::None);
    // Whether it lets the pointer through, and whether it did.
    let (window, none, was) = if id == ROOT_ID {
        let Some(window) = main_window(surface) else {
            return;
        };
        let mut main = surface.main_window.borrow_mut();
        let now = none(&main.attributes);
        (window, now, std::mem::replace(&mut main.no_input, now))
    } else {
        let mut windows = surface.windows.borrow_mut();
        let Some(w) = windows.get_mut(&id) else {
            return;
        };
        let now = none(&w.attributes);
        (
            w.window.clone(),
            now,
            std::mem::replace(&mut w.no_input, now),
        )
    };
    let Some(gdk_surface) = window.surface() else {
        return;
    };
    if none {
        // Again after every allocation: GTK sets the surface's input
        // region itself (client-side shadows).
        gdk_surface.set_input_region(Some(&cairo::Region::create()));
    } else if was {
        gdk_surface.set_input_region(None);
        // GTK sets its own again at the next allocation.
        window.queue_resize();
    }
}

// --- Requests ---------------------------------------------------------------------------

/// A request to window `id` of the app's own.
fn request(surface: &Rc<Surface>, id: NodeId, request: &WindowRequest) {
    let Some((window, content)) = surface
        .windows
        .borrow()
        .get(&id)
        .map(|w| (w.window.clone(), w.view.upgrade()))
    else {
        return log::debug!("window: no window for {id}");
    };
    match request {
        WindowRequest::Show => show(surface, id),
        WindowRequest::Hide => hide(surface, id),
        WindowRequest::Focus | WindowRequest::Restore => {
            if let Some(w) = surface.windows.borrow_mut().get_mut(&id) {
                w.pending = None;
                SHOWN.set(SHOWN.get() + 1);
                w.shown = SHOWN.get();
            }
            window.present();
        }
        // The app closes its windows by removing their roots; one asked
        // to close otherwise goes as the app closing it, policies aside.
        WindowRequest::Close => {
            hide(surface, id);
            report(
                surface,
                id,
                WindowEvent::Closed {
                    cause: WindowCloseCause::Close,
                },
            );
            parent_closed(surface, id);
        }
        WindowRequest::Minimize => window.minimize(),
        WindowRequest::SetMode(mode) => set_mode(&window, *mode),
        WindowRequest::SetBounds(frame) => {
            let a = surface
                .windows
                .borrow()
                .get(&id)
                .map(|w| w.attributes.clone());
            if let (Some(content), Some(a)) = (content, a) {
                set_size(&window, content.upcast_ref(), &a, frame.width, frame.height);
            }
        }
        WindowRequest::SetContentSize { width, height } => {
            let a = surface
                .windows
                .borrow()
                .get(&id)
                .map(|w| w.attributes.clone());
            if let (Some(content), Some(a)) = (content, a) {
                set_content_size(&window, content.upcast_ref(), &a, *width, *height);
            }
        }
        WindowRequest::SetPlacement(placement) => {
            let a = surface
                .windows
                .borrow()
                .get(&id)
                .map(|w| w.attributes.clone());
            if let (Some(content), Some(a)) = (content, a) {
                set_placement(&window, content.upcast_ref(), &a, placement);
            }
        }
        // GTK 4 places windows itself.
        WindowRequest::Center { .. } => {}
        WindowRequest::RequestAttention { .. } => launcher_urgent(surface, true),
    }
}

/// Puts `window` in `mode`.
fn set_mode(window: &gtk::Window, mode: WindowMode) {
    match mode {
        WindowMode::Normal => {
            if window.is_fullscreen() {
                window.unfullscreen();
            }
            if window.is_maximized() {
                window.unmaximize();
            }
        }
        WindowMode::Maximized => {
            if window.is_fullscreen() {
                window.unfullscreen();
            }
            window.maximize();
        }
        WindowMode::FullScreen => window.fullscreen(),
    }
}

/// Sizes `window`, merging with its requested size: GTK applies it
/// asynchronously, so the allocation may still be an earlier one's.
fn set_size(
    window: &gtk::Window,
    content: &gtk::Widget,
    a: &WindowAttributes,
    width: Option<Points>,
    height: Option<Points>,
) {
    if width.is_none() && height.is_none() {
        return;
    }
    let (w, h) = window.default_size();
    let size = (
        width.map_or(w, |v| pixels(v.0)),
        height.map_or(h, |v| pixels(v.0)),
    );
    window.set_default_size(size.0, size.1);
    if a.resizable == Some(false) {
        size_request(window, content, a, Some(size));
    }
}

/// Sizes `window`'s content (`content`, what its root fills): the window's
/// size is the content's with what the window adds around it (a system
/// title bar), as it is laid out now.
fn set_content_size(
    window: &gtk::Window,
    content: &gtk::Widget,
    a: &WindowAttributes,
    width: Option<Points>,
    height: Option<Points>,
) {
    let (extra_w, extra_h) = content_extra(window, content);
    set_size(
        window,
        content,
        a,
        width.map(|w| Points(w.0 + extra_w)),
        height.map(|h| Points(h.0 + extra_h)),
    );
}

/// What `window`'s size has beside `content`'s: a system title bar's
/// height. Before it is laid out, the title bar's natural height.
fn content_extra(window: &gtk::Window, content: &gtk::Widget) -> (f32, f32) {
    if content.width() > 0 && content.height() > 0 {
        return (
            (window.width() - content.width()).max(0) as f32,
            (window.height() - content.height()).max(0) as f32,
        );
    }
    let bar = window
        .titlebar()
        .filter(|t| t.is_visible() && window.is_decorated())
        .map_or(0, |t| t.measure(gtk::Orientation::Vertical, -1).1);
    (0.0, bar.max(0) as f32)
}

/// Puts `window` in `placement`'s mode with its size (GTK 4 places it).
fn set_placement(
    window: &gtk::Window,
    content: &gtk::Widget,
    a: &WindowAttributes,
    placement: &WindowPlacement,
) {
    set_mode(window, WindowMode::Normal);
    let size = placement.bounds.size;
    set_size(window, content, a, Some(size.width), Some(size.height));
    set_mode(window, placement.mode);
}

// --- Policies ---------------------------------------------------------------------------

/// The user asked to close window `id`.
fn close_press(surface: &Surface, id: NodeId, reason: CloseReason) {
    let Some(decision) = surface
        .windows
        .borrow()
        .get(&id)
        .map(|w| close_decision(&w.attributes))
    else {
        return;
    };
    match decision {
        Decision::Ignore => {}
        Decision::Report => report(surface, id, WindowEvent::ClosePress { reason }),
        Decision::Close => {
            report(surface, id, WindowEvent::ClosePress { reason });
            policy_close(surface, id, WindowCloseCause::ClosePress);
        }
    }
}

/// Closes window `id` by a policy: it hides, the app hears why and removes
/// its root; the windows it owns close with it.
fn policy_close(surface: &Surface, id: NodeId, cause: WindowCloseCause) {
    hide(surface, id);
    report(surface, id, WindowEvent::Closed { cause });
    parent_closed(surface, id);
}

/// Window `id` closed: the shown windows it owns close too.
fn parent_closed(surface: &Surface, id: NodeId) {
    let children: Vec<NodeId> = surface
        .windows
        .borrow()
        .iter()
        .filter(|(_, w)| w.parent == Some(id) && (w.window.is_visible() || w.pending.is_some()))
        .map(|(child, _)| *child)
        .collect();
    for child in children {
        policy_close(surface, child, WindowCloseCause::ParentClose);
    }
}

/// Window `id` became active or stopped being: `closeOnBlur`.
fn active_changed(surface: &Surface, id: NodeId, active: bool) {
    if active {
        launcher_urgent(surface, false);
    }
    let blur = {
        let mut windows = surface.windows.borrow_mut();
        let Some(w) = windows.get_mut(&id) else {
            return;
        };
        if active {
            w.active_once = true;
            false
        } else {
            w.active_once && w.window.is_visible() && w.attributes.close_on_blur == Some(true)
        }
    };
    if blur {
        policy_close(surface, id, WindowCloseCause::Blur);
    }
}

fn report(surface: &Surface, id: NodeId, event: WindowEvent) {
    surface.event(id, EventKind::Window, EventPayload::Window(Box::new(event)));
}

// --- State ------------------------------------------------------------------------------

/// The mode of a window in full screen or maximized.
fn mode_of(fullscreen: bool, maximized: bool) -> WindowMode {
    if fullscreen {
        WindowMode::FullScreen
    } else if maximized {
        WindowMode::Maximized
    } else {
        WindowMode::Normal
    }
}

/// Whether `next` differs from `last` only by where the window is or its
/// size: reported once it settles.
fn moved_only(last: &WindowState, next: &WindowState) -> bool {
    last.mode == next.mode
        && last.minimized == next.minimized
        && last.visible == next.visible
        && last.focused == next.focused
        && last.display == next.display
        && last.scale_factor == next.scale_factor
}

/// The state of `window`, whose app content is `content`; `normal` keeps
/// its bounds in the normal mode. `None` before it has a size.
fn state_of(
    window: &gtk::Window,
    content: &gtk::Widget,
    normal: &mut Option<Bounds<Points>>,
) -> Option<WindowState> {
    let (width, height) = (window.width(), window.height());
    if width <= 0 || height <= 0 {
        return None;
    }
    let bounds = Bounds::new(
        point(Points(0.0), Points(0.0)),
        size(Points(width as f32), Points(height as f32)),
    );
    let content_bounds = content.compute_bounds(window).map_or(bounds, |r| {
        Bounds::new(
            point(Points(r.x()), Points(r.y())),
            size(Points(r.width()), Points(r.height())),
        )
    });
    let gdk_surface = window.surface();
    let minimized = gdk_surface
        .as_ref()
        .and_then(|s| s.downcast_ref::<gdk::Toplevel>().map(|t| t.state()))
        .is_some_and(|s| s.contains(gdk::ToplevelState::MINIMIZED));
    let mode = mode_of(window.is_fullscreen(), window.is_maximized());
    if mode == WindowMode::Normal && !minimized {
        *normal = Some(bounds);
    }
    let mut state = WindowState::new(bounds, WindowPlacement::new(mode, normal.unwrap_or(bounds)));
    state.mode = mode;
    state.minimized = minimized;
    state.visible = window.is_visible() && !minimized;
    state.focused = window.is_active();
    state.content_bounds = content_bounds;
    state.display = gdk_surface
        .as_ref()
        .and_then(|s| s.display().monitor_at_surface(s))
        .map(|m| monitor_id(&m));
    state.scale_factor = gdk_surface.as_ref().map_or(1.0, |s| s.scale() as f32);
    Some(state)
}

/// Window `id`'s state may have changed: reported at once, or once a
/// resize settles.
fn state_changed(surface: &Rc<Surface>, id: NodeId) {
    // A change of mode or display may change the title bar; it goes first.
    title_bar_changed(surface, id);
    let Some((window, view, mut normal)) = surface
        .windows
        .borrow()
        .get(&id)
        .map(|w| (w.window.clone(), w.view.upgrade(), w.tracker.normal))
    else {
        return;
    };
    let Some(view) = view else {
        return;
    };
    let next = state_of(&window, view.upcast_ref(), &mut normal);
    let mut windows = surface.windows.borrow_mut();
    let Some(w) = windows.get_mut(&id) else {
        return;
    };
    w.tracker.normal = normal;
    let Some(next) = next else {
        return;
    };
    if w.tracker.last == Some(next) {
        return;
    }
    if let Some(timer) = w.tracker.settle.take() {
        timer.remove();
    }
    if w.tracker.last.is_some_and(|last| moved_only(&last, &next)) {
        let weak = Rc::downgrade(surface);
        w.tracker.settle = Some(glib::timeout_add_local_once(SETTLE, move || {
            let Some(surface) = weak.upgrade() else {
                return;
            };
            let latest = {
                let mut windows = surface.windows.borrow_mut();
                let Some(w) = windows.get_mut(&id) else {
                    return;
                };
                // Fired: not removed again.
                w.tracker.settle = None;
                w.tracker.last = Some(next);
                next
            };
            report(&surface, id, WindowEvent::State(Box::new(latest)));
            // What changed while it settled.
            state_changed(&surface, id);
        }));
        return;
    }
    w.tracker.last = Some(next);
    drop(windows);
    report(surface, id, WindowEvent::State(Box::new(next)));
}

/// The main window's state may have changed: the environment's (the
/// engine holds a resize back until it settles).
pub(crate) fn main_state_changed(surface: &Surface) {
    let Some(window) = main_window(surface) else {
        return;
    };
    let mut normal = surface.main_window.borrow().normal;
    let next = state_of(&window, surface.root.upcast_ref(), &mut normal);
    surface.main_window.borrow_mut().normal = normal;
    let mut env = surface.environment.get();
    if next.is_some() && env.window_state != next {
        env.window_state = next;
        surface.set_environment(env);
    }
}

/// Follows the main window's state (once per window: `chrome`'s watch).
pub(crate) fn watch_main(surface: &Rc<Surface>, window: &gtk::Window) {
    let changed = move |surface: &Rc<Surface>| {
        let weak = Rc::downgrade(surface);
        move |_: &gtk::Window| {
            if let Some(surface) = weak.upgrade() {
                main_state_changed(&surface);
            }
        }
    };
    window.connect_maximized_notify(changed(surface));
    window.connect_visible_notify(changed(surface));
    let weak = Rc::downgrade(surface);
    window.connect_is_active_notify(move |window| {
        if let Some(surface) = weak.upgrade() {
            if window.is_active() {
                launcher_urgent(&surface, false);
            }
            main_state_changed(&surface);
        }
    });
    if let Some(gdk_surface) = window.surface() {
        let weak = Rc::downgrade(surface);
        gdk_surface.connect_scale_notify(move |_| {
            if let Some(surface) = weak.upgrade() {
                main_state_changed(&surface);
            }
        });
        let weak = Rc::downgrade(surface);
        gdk_surface.connect_enter_monitor(move |_, _| {
            if let Some(surface) = weak.upgrade() {
                main_state_changed(&surface);
            }
        });
        if let Some(toplevel) = gdk_surface.downcast_ref::<gdk::Toplevel>() {
            let weak = Rc::downgrade(surface);
            toplevel.connect_state_notify(move |_| {
                if let Some(surface) = weak.upgrade() {
                    main_state_changed(&surface);
                }
            });
        }
    }
    pass_pointer(surface, ROOT_ID);
    main_state_changed(surface);
}

/// The surface's root was resized.
pub(crate) fn main_resized(surface: &Surface) {
    pass_pointer(surface, ROOT_ID);
    main_state_changed(surface);
}

// --- The main window --------------------------------------------------------------------

/// The main window's attributes that changed.
pub(crate) fn main_attributes(surface: &Rc<Surface>, diff: &WindowAttributes) {
    let full = {
        let mut main = surface.main_window.borrow_mut();
        main.attributes.merge(diff);
        main.attributes.clone()
    };
    if let Some(title_bar) = &diff.title_bar {
        crate::chrome::set_title_bar(surface, title_bar);
    }
    let Some(window) = main_window(surface) else {
        return;
    };
    if let Some(title) = &diff.title {
        window.set_title(Some(title));
    }
    apply(surface, &window, surface.root.upcast_ref(), &full, diff);
    if diff.pointer_events.is_some() {
        pass_pointer(surface, ROOT_ID);
    }
}

/// A request to the main window.
pub(crate) fn main_request(surface: &Rc<Surface>, request: &WindowRequest) {
    let Some(window) = main_window(surface) else {
        return;
    };
    let a = surface.main_window.borrow().attributes.clone();
    match request {
        WindowRequest::Show => {
            if a.activate != Some(false) {
                window.present();
            } else {
                window.set_visible(true);
            }
        }
        WindowRequest::Hide => window.set_visible(false),
        WindowRequest::Focus | WindowRequest::Restore => window.present(),
        WindowRequest::Close => {
            surface.main_window.borrow_mut().closing = true;
            crate::chrome::close(surface);
        }
        WindowRequest::Minimize => window.minimize(),
        WindowRequest::SetMode(mode) => set_mode(&window, *mode),
        WindowRequest::SetBounds(frame) => set_size(
            &window,
            surface.root.upcast_ref(),
            &a,
            frame.width,
            frame.height,
        ),
        WindowRequest::SetContentSize { width, height } => {
            set_content_size(&window, surface.root.upcast_ref(), &a, *width, *height)
        }
        WindowRequest::SetPlacement(placement) => {
            set_placement(&window, surface.root.upcast_ref(), &a, placement)
        }
        WindowRequest::Center { .. } => {}
        WindowRequest::RequestAttention { .. } => launcher_urgent(surface, true),
    }
}

/// The user asked to close the main window of a standalone app: whether
/// it closes (`closeOnPress`); the app hears it either way.
pub(crate) fn main_close_request(surface: &Surface) -> glib::Propagation {
    let reason = take_reason();
    if QUITTING.get() || std::mem::take(&mut surface.main_window.borrow_mut().closing) {
        return glib::Propagation::Proceed;
    }
    let decision = close_decision(&surface.main_window.borrow().attributes);
    match decision {
        Decision::Ignore => glib::Propagation::Stop,
        Decision::Report => {
            report(surface, ROOT_ID, WindowEvent::ClosePress { reason });
            glib::Propagation::Stop
        }
        Decision::Close => {
            report(surface, ROOT_ID, WindowEvent::ClosePress { reason });
            glib::Propagation::Proceed
        }
    }
}

/// Applies nsh.json `window` to the main window of a standalone app
/// before it shows: its attributes and the mode it opens in (`kept`: the
/// one it closed in, with `restoreBounds`). The runner gave it its size.
pub(crate) fn launch_main(
    surface: &Rc<Surface>,
    window: &gtk::Window,
    launch: &MainWindowOptions,
    kept: Option<WindowMode>,
) {
    if !launch.attributes.is_empty() {
        main_attributes(surface, &launch.attributes);
    }
    match kept.or(launch.default_mode).unwrap_or_default() {
        WindowMode::Normal => {}
        WindowMode::Maximized => window.maximize(),
        WindowMode::FullScreen => match launch.display.and_then(monitor) {
            Some(monitor) => window.fullscreen_on_monitor(&monitor),
            None => window.fullscreen(),
        },
    }
}

// --- Title bar views --------------------------------------------------------------------

/// A view marked `windowControl` was pressed and released in `window`:
/// does what the system's button does.
pub(crate) fn control(surface: &Surface, window: &gtk::Window, control: WindowControl) {
    let allowed = allowed(surface, window);
    match control {
        WindowControl::Minimize if allowed.minimizable => window.minimize(),
        WindowControl::Maximize if allowed.maximizable => {
            if window.is_maximized() {
                window.unmaximize();
            } else {
                window.maximize();
            }
        }
        WindowControl::Close => press_close(window, CloseReason::CloseButton),
        _ => {}
    }
}

/// A primary press on a view marked `windowResize`: the window manager
/// resizes `window` by `edge` from there.
pub(crate) fn begin_resize(
    surface: &Surface,
    window: &gtk::Window,
    event: &gdk::Event,
    edge: ResizeEdge,
) {
    if !allowed(surface, window).resizable {
        return;
    }
    let Some(toplevel) = window.surface().and_downcast::<gdk::Toplevel>() else {
        return;
    };
    let Some((x, y)) = event.position() else {
        return;
    };
    let edge = match edge {
        ResizeEdge::Top => gdk::SurfaceEdge::North,
        ResizeEdge::Bottom => gdk::SurfaceEdge::South,
        ResizeEdge::Left => gdk::SurfaceEdge::West,
        ResizeEdge::Right => gdk::SurfaceEdge::East,
        ResizeEdge::TopLeft => gdk::SurfaceEdge::NorthWest,
        ResizeEdge::TopRight => gdk::SurfaceEdge::NorthEast,
        ResizeEdge::BottomLeft => gdk::SurfaceEdge::SouthWest,
        ResizeEdge::BottomRight => gdk::SurfaceEdge::SouthEast,
    };
    toplevel.begin_resize(
        edge,
        event.device().as_ref(),
        gdk::BUTTON_PRIMARY as i32,
        x,
        y,
        event.time(),
    );
}

// --- The test agent (`nsh test --target linux`) ------------------------------------------

/// The root view of window `id` (the surface's root for the main window).
pub(crate) fn root_view(surface: &Surface, id: NodeId) -> Option<NshView> {
    if id == ROOT_ID {
        Some(surface.root.clone())
    } else {
        surface.windows.borrow().get(&id)?.view.upgrade()
    }
}

/// The root view of the window `view` is in.
pub(crate) fn root_of(surface: &Surface, view: &NshView) -> NshView {
    let roots: Vec<NshView> = surface
        .windows
        .borrow()
        .values()
        .filter_map(|w| w.view.upgrade())
        .collect();
    roots
        .into_iter()
        .find(|root| root == view || view.is_ancestor(root))
        .unwrap_or_else(|| surface.root.clone())
}

/// The root view things shown in window `id` go in: that window's of the
/// app's own while it is open, else the surface's (the main window's).
pub(crate) fn host_root(surface: &Surface, id: NodeId) -> NshView {
    root_view(surface, id).unwrap_or_else(|| surface.root.clone())
}

/// The root view of the window whose GDK surface is `gdk_surface`.
pub(crate) fn root_at(surface: &Surface, gdk_surface: &gdk::Surface) -> Option<NshView> {
    if main_window(surface).and_then(|w| w.surface()).as_ref() == Some(gdk_surface) {
        return Some(surface.root.clone());
    }
    surface
        .windows
        .borrow()
        .values()
        .find(|w| w.window.surface().as_ref() == Some(gdk_surface))
        .and_then(|w| w.view.upgrade())
}

/// The root views of the app's windows of its own, by window.
pub(crate) fn roots(surface: &Surface) -> Vec<(NodeId, NshView)> {
    surface
        .windows
        .borrow()
        .iter()
        .filter_map(|(id, w)| Some((*id, w.view.upgrade()?)))
        .collect()
}

/// Whether `view` is one of the surface's (in its main window or one of
/// the app's own), not the root views themselves.
pub(crate) fn holds(surface: &Surface, view: &NshView) -> bool {
    let root = root_of(surface, view);
    &root != view && view.is_ancestor(&root)
}

/// The root view of the window keys go to: where announcements come from,
/// so the screen reader reads them in the window the user is in.
pub(crate) fn key_root(surface: &Surface) -> NshView {
    let Some(window) = key_window(surface) else {
        return surface.root.clone();
    };
    match id_of(surface, &window).filter(|&id| id != ROOT_ID) {
        Some(id) => surface
            .windows
            .borrow()
            .get(&id)
            .and_then(|w| w.view.upgrade())
            .unwrap_or_else(|| surface.root.clone()),
        None => surface.root.clone(),
    }
}

/// The `gtk::Window` of window `id`.
#[cfg(feature = "dev")]
pub(crate) fn native_window(surface: &Surface, id: NodeId) -> Option<gtk::Window> {
    gtk_window(surface, id)
}

/// The window keys go to: the active one, else the window of the app's
/// own shown activated last that still shows, else the main window.
pub(crate) fn key_window(surface: &Surface) -> Option<gtk::Window> {
    let main = main_window(surface);
    if main.as_ref().is_some_and(|w| w.is_active()) {
        return main;
    }
    let windows = surface.windows.borrow();
    let shown = windows.values().filter(|w| w.window.is_visible());
    if let Some(active) = shown.clone().find(|w| w.window.is_active()) {
        return Some(active.window.clone());
    }
    shown
        .filter(|w| w.shown > 0)
        .max_by_key(|w| w.shown)
        .map(|w| w.window.clone())
        .or(main)
}

/// A key pressed in `window` (one of the app's own) that nothing in it
/// used: as `window_key`. Whether it was taken.
#[cfg(feature = "dev")]
pub(crate) fn press_key(
    surface: &Rc<Surface>,
    window: &gtk::Window,
    key: gdk::Key,
    state: gdk::ModifierType,
) -> bool {
    match id_of(surface, window).filter(|&id| id != ROOT_ID) {
        Some(id) => window_key(surface, id, key, state),
        None => false,
    }
}

/// Window `id`'s state as it is now: `None` when no such window is open.
#[cfg(feature = "dev")]
pub(crate) fn current_state(surface: &Surface, id: NodeId) -> Option<WindowState> {
    if id == ROOT_ID {
        let window = main_window(surface)?;
        let mut normal = surface.main_window.borrow().normal;
        return state_of(&window, surface.root.upcast_ref(), &mut normal)
            .or(surface.environment.get().window_state);
    }
    let (window, view, mut normal, last) = surface.windows.borrow().get(&id).map(|w| {
        (
            w.window.clone(),
            w.view.upgrade(),
            w.tracker.normal,
            w.tracker.last,
        )
    })?;
    let now = view.and_then(|view| state_of(&window, view.upcast_ref(), &mut normal));
    // Not shown yet: no size of its own.
    Some(now.or(last).unwrap_or_else(|| {
        let mut state = WindowState::new(Bounds::default(), WindowPlacement::default());
        state.visible = false;
        state
    }))
}

// --- Removal ----------------------------------------------------------------------------

/// Dialog root `view` was removed: its window goes, and the shown windows
/// it owns close. Whether it had one.
pub(crate) fn removed(surface: &Surface, view: &NshView) -> bool {
    let id = view.id();
    if !is_window(surface, id) {
        return false;
    }
    parent_closed(surface, id);
    let Some(w) = surface.windows.borrow_mut().remove(&id) else {
        return false;
    };
    if let Some(timer) = w.tracker.settle {
        timer.remove();
    }
    w.overlay.set_child(None::<&gtk::Widget>);
    w.window.destroy();
    true
}

/// The app stopped: its windows go.
pub(crate) fn clear(surface: &Surface) {
    let windows: Vec<AppWindow> = surface
        .windows
        .borrow_mut()
        .drain()
        .map(|(_, w)| w)
        .collect();
    for w in windows {
        if let Some(timer) = w.tracker.settle {
            timer.remove();
        }
        w.overlay.set_child(None::<&gtk::Widget>);
        w.window.destroy();
    }
    let mut main = surface.main_window.borrow_mut();
    let watched = main.displays_watched;
    *main = MainWindow {
        displays_watched: watched,
        ..MainWindow::default()
    };
}

// --- Displays ---------------------------------------------------------------------------

/// The id of `monitor`: the same in the app's next launch while it stays
/// plugged in the same connector.
fn monitor_id(monitor: &gdk::Monitor) -> DisplayId {
    let name = monitor
        .connector()
        .map(|c| c.to_string())
        .or_else(|| monitor.model().map(|m| m.to_string()))
        .unwrap_or_default();
    DisplayId::from_name(name.as_bytes())
}

/// The monitor of display `id`.
fn monitor(id: DisplayId) -> Option<gdk::Monitor> {
    let display = gdk::Display::default()?;
    let monitors = display.monitors();
    (0..monitors.n_items())
        .filter_map(|i| monitors.item(i).and_downcast::<gdk::Monitor>())
        .find(|m| monitor_id(m) == id)
}

/// The displays (GDK's monitors; the first one is the primary, as GTK 4
/// knows none).
pub(crate) fn displays() -> Vec<Display> {
    let Some(display) = gdk::Display::default() else {
        return Vec::new();
    };
    let monitors = display.monitors();
    (0..monitors.n_items())
        .filter_map(|i| monitors.item(i).and_downcast::<gdk::Monitor>())
        .enumerate()
        .map(|(i, m)| {
            let g = m.geometry();
            let bounds = Bounds::new(
                point(Points(g.x() as f32), Points(g.y() as f32)),
                size(Points(g.width() as f32), Points(g.height() as f32)),
            );
            let mut d = Display::new(monitor_id(&m), bounds, bounds, i == 0);
            d.name = m
                .description()
                .or_else(|| m.model())
                .or_else(|| m.connector())
                .map(|s| s.to_string())
                .unwrap_or_default();
            d.scale_factor = m.scale() as f32;
            d.refresh_rate = (m.refresh_rate() > 0).then(|| m.refresh_rate() as f32 / 1000.0);
            d
        })
        .collect()
}

/// Reports the displays to the engine whenever they change (once per
/// surface).
pub(crate) fn watch_displays(surface: &Rc<Surface>) {
    if std::mem::replace(&mut surface.main_window.borrow_mut().displays_watched, true) {
        return;
    }
    let Some(display) = gdk::Display::default() else {
        return;
    };
    let weak = Rc::downgrade(surface);
    display.monitors().connect_items_changed(move |_, _, _, _| {
        if let Some(surface) = weak.upgrade() {
            let list = displays();
            surface.control(|c| c.set_displays(list));
        }
    });
}

// --- The launcher entry -----------------------------------------------------------------

/// What the app's launcher entry shows: the progress last set (of any
/// window) and whether it asks for attention.
#[derive(Debug, Default)]
struct Launcher {
    progress: Option<WindowProgress>,
    urgent: bool,
}

fn launcher_progress(surface: &Surface, progress: Option<WindowProgress>) {
    let changed = LAUNCHER.with(|l| {
        let mut l = l.borrow_mut();
        std::mem::replace(&mut l.progress, progress) != progress
    });
    if changed {
        launcher_update(surface);
    }
}

fn launcher_urgent(surface: &Surface, urgent: bool) {
    let changed =
        LAUNCHER.with(|l| std::mem::replace(&mut l.borrow_mut().urgent, urgent) != urgent);
    if changed {
        launcher_update(surface);
    }
}

/// Sends the launcher entry's `Update` signal, where there is a session
/// bus (nothing listens without a dock that shows it).
fn launcher_update(surface: &Surface) {
    let app_id = main_window(surface)
        .and_then(|w| w.application())
        .and_then(|a| a.application_id())
        .map(|id| id.to_string())
        .or_else(|| glib::prgname().map(|p| p.to_string()));
    let Some(app_id) = app_id else {
        return;
    };
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
        return;
    };
    let params = LAUNCHER.with(|l| {
        let l = l.borrow();
        launcher_params(&app_id, l.progress, l.urgent)
    });
    let path = format!("/com/canonical/unity/launcherentry/{}", path_key(&app_id));
    if let Err(e) = bus.emit_signal(
        None,
        &path,
        "com.canonical.Unity.LauncherEntry",
        "Update",
        Some(&params),
    ) {
        log::debug!("window: launcher entry: {e}");
    }
}

/// A D-Bus path element for `app_id`.
fn path_key(app_id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    app_id.hash(&mut h);
    h.finish()
}

/// The `Update` signal's parameters: `(sa{sv})`, the app's `.desktop` URI
/// and what changed.
fn launcher_params(app_id: &str, progress: Option<WindowProgress>, urgent: bool) -> glib::Variant {
    let props = glib::VariantDict::new(None);
    props.insert("progress-visible", progress.is_some());
    let value = progress
        .and_then(|p| p.value)
        .map_or(0.0, |v| f64::from(v.0));
    props.insert("progress", value);
    props.insert("urgent", urgent);
    glib::Variant::tuple_from_iter([
        format!("application://{app_id}.desktop").to_variant(),
        props.end(),
    ])
}

#[cfg(test)]
mod tests {
    use nsh_core::desktop::ProgressState;

    use super::*;

    fn state(width: f32) -> WindowState {
        let bounds = Bounds::new(
            point(Points(0.0), Points(0.0)),
            size(Points(width), Points(300.0)),
        );
        WindowState::new(bounds, WindowPlacement::new(WindowMode::Normal, bounds))
    }

    #[test]
    fn modes_from_the_windows_flags() {
        assert_eq!(mode_of(false, false), WindowMode::Normal);
        assert_eq!(mode_of(false, true), WindowMode::Maximized);
        assert_eq!(mode_of(true, true), WindowMode::FullScreen);
    }

    #[test]
    fn only_moves_and_resizes_settle() {
        let last = state(400.0);
        assert!(moved_only(&last, &state(500.0)));
        let mut focused = state(400.0);
        focused.focused = true;
        assert!(!moved_only(&last, &focused));
        let mut maximized = state(500.0);
        maximized.mode = WindowMode::Maximized;
        assert!(!moved_only(&last, &maximized));
    }

    #[test]
    fn layouts_lose_the_buttons_not_allowed() {
        let layout = "icon:minimize,maximize,close";
        assert_eq!(decoration_layout(layout, true, true, true), layout);
        assert_eq!(decoration_layout(layout, false, false, true), "icon:close");
        assert_eq!(
            decoration_layout("close,minimize:", false, true, false),
            ":"
        );
        assert_eq!(
            decoration_layout("appmenu:close", false, false, true),
            "appmenu:close"
        );
    }

    #[test]
    fn close_presses_follow_the_policy() {
        let mut a = WindowAttributes::for_kind(WindowKind::Normal);
        assert_eq!(close_decision(&a), Decision::Close);
        a.close_on_press = Some(false);
        assert_eq!(close_decision(&a), Decision::Report);
        a.closable = Some(false);
        assert_eq!(close_decision(&a), Decision::Ignore);
        // The main window before the app set anything: a normal window's.
        assert_eq!(
            close_decision(&MainWindow::default().attributes),
            Decision::Close
        );
    }

    #[test]
    fn user_actions_follow_the_attributes() {
        let dialog = Allowed::of(&WindowAttributes::for_kind(WindowKind::Dialog));
        assert!(!dialog.minimizable && !dialog.maximizable && dialog.resizable);
        let popup = Allowed::of(&WindowAttributes::for_kind(WindowKind::Popup));
        // Not resizable: not maximizable either.
        assert!(!popup.resizable && !popup.maximizable);
        let overlay = Allowed::of(&WindowAttributes::for_kind(WindowKind::Overlay));
        assert!(!overlay.movable);
    }

    #[test]
    fn launcher_entries_carry_progress_and_urgency() {
        let mut progress = WindowProgress::default();
        progress.value = Some(nsh_core::geometry::Percentage(0.25));
        progress.state = ProgressState::Normal;
        let params = launcher_params("com.example.app", Some(progress), true);
        assert_eq!(params.type_().as_str(), "(sa{sv})");
        let uri = params.child_value(0).get::<String>().unwrap();
        assert_eq!(uri, "application://com.example.app.desktop");
        let dict = glib::VariantDict::new(Some(&params.child_value(1)));
        assert_eq!(dict.lookup::<f64>("progress").unwrap(), Some(0.25));
        assert_eq!(dict.lookup::<bool>("progress-visible").unwrap(), Some(true));
        assert_eq!(dict.lookup::<bool>("urgent").unwrap(), Some(true));
        let none = launcher_params("a", None, false);
        let dict = glib::VariantDict::new(Some(&none.child_value(1)));
        assert_eq!(
            dict.lookup::<bool>("progress-visible").unwrap(),
            Some(false)
        );
    }
}
