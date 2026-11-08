//! Windows (`nsh/desktop`'s `Window`, `WindowRef`): the main window (the
//! one the surface's root is in) and the app's windows of its own, each a
//! dialog root (a `modal` node) of the same engine shown in a window of its
//! own instead of over the main one. The engine, the JS runtime and the
//! core stay one, so the windows share the app's state; this module hosts
//! the roots, applies the attributes and requests addressed to a window's
//! root, holds its policies and reports its state and events.
//!
//! - **Kinds** pick the native class: `normal` and `dialog` are
//!   [`NshWindow`]s, `panel`, `popup` and `overlay` are [`NshPanel`]s
//!   (utility, non-activating, borderless). The core sends every attribute
//!   resolved, so the kinds' defaults live there.
//! - **Opening**: the root leaves the main window's modals
//!   ([`crate::navigation::release`]) and becomes the content of the new
//!   window, its size the root's (`set_root_size`). The window shows once a
//!   batch laid out at that size is in ([`batch_applied`]), or after
//!   [`FIRST_FRAME_MS`] if the engine is late, so it never flashes empty.
//! - **Input** reaches the surface with the window's root as the root
//!   events are picked in ([`crate::input::enter`]). A window under a
//!   modal dialog of the app's takes none ([`blocked`]).
//! - **Policies** are attributes held here and answered on the main
//!   thread: a close press closes at once with `closeOnPress` (else it is
//!   only reported), Escape and losing the focus hide the window with
//!   `closeOnEscape` / `closeOnBlur`; the app is told afterwards
//!   (`EventKind::Window`). The main window's close press waits for the
//!   engine's turn at most [`CLOSE_GRACE_MS`], so the app's handler sees
//!   the window before it goes.
//! - **State** is reported per window when it changes
//!   ([`crate::window_state`]); the main window's goes into the
//!   environment.
//! - **Progress** is the Dock tile's ([`dock`]): one per app, the last
//!   window that set one.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use dispatch2::DispatchQueue;
use nsh_core::{
    Bounds, EdgeInsets, EventKind, EventPayload, NodeId, Points, ROOT_ID, Size,
    desktop::{
        Backdrop, CloseReason, DesktopCommand, MainWindowOptions, OpenWindow, ProgressState,
        TitleBarStyle, WindowAttributes, WindowCloseCause, WindowControl, WindowEvent,
        WindowFrameStyle, WindowKind, WindowLevel, WindowMode, WindowPlacement,
        WindowPointerEvents, WindowPosition, WindowProgress, WindowRequest, WindowState,
        Workspaces,
    },
    geometry::{Edges, point},
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
};
use objc2_app_kit::{
    NSAppearanceCustomization, NSApplication, NSAutoresizingMaskOptions, NSBackingStoreType,
    NSColor, NSEvent, NSEventType, NSFloatingWindowLevel, NSNormalWindowLevel, NSPanel,
    NSProgressIndicator, NSProgressIndicatorStyle, NSRequestUserAttentionType, NSResponder,
    NSScreen, NSStatusWindowLevel, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowButton, NSWindowCollectionBehavior,
    NSWindowDelegate, NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_core_graphics::kCGDesktopIconWindowLevel;
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};

use crate::{
    chrome::TitleBar,
    surface::Surface,
    view::NshView,
    window_state::{Target, Watch},
};

/// How long a new window waits for its first frame before it shows
/// anyway.
const FIRST_FRAME_MS: u64 = 250;
/// How long the main window's close press waits for the app's turn when
/// it closes the window.
const CLOSE_GRACE_MS: u64 = 250;
/// A window's content size when the app gives none.
const DEFAULT_SIZE: NSSize = NSSize::new(480.0, 360.0);
/// How far each window opened without a position is cascaded from its
/// parent's top left corner.
const CASCADE: f64 = 24.0;

// --- Native classes -----------------------------------------------------------------------

/// What NSH's window classes keep beside AppKit's state.
#[derive(Debug)]
pub(crate) struct WindowIvars {
    /// It may become the key window (`focusable`; borderless windows
    /// cannot by default).
    focusable: Cell<bool>,
    /// It may become the main window (normal windows and dialogs).
    main: Cell<bool>,
    /// AppKit leaves its frame as asked, also taller than its screen
    /// ([`crate::AppOptions::keep_size`]).
    keep_size: Cell<bool>,
    /// Its app runs in the background ([`crate::AppOptions::background`]):
    /// presses the title bar would only take to make the window key go to
    /// the content ([`NshWindow`]).
    background: Cell<bool>,
    /// The view a left press of the title bar went to in place of the
    /// title bar's own: its drags and its release follow it there.
    passed: RefCell<Option<Retained<NSView>>>,
}

impl WindowIvars {
    fn new(focusable: bool, main: bool, keep_size: bool, background: bool) -> WindowIvars {
        WindowIvars {
            focusable: Cell::new(focusable),
            main: Cell::new(main),
            keep_size: Cell::new(keep_size),
            background: Cell::new(background),
            passed: RefCell::new(None),
        }
    }
}

define_class!(
    /// A normal window or a dialog of NSH's (the standalone app's main
    /// window too): AppKit's, with its key status set by `focusable`.
    ///
    /// In the background (`nsh test --target macos`) the window is never
    /// key (its app is never active), and AppKit gives a left press in a
    /// window that is not key only to a view that accepts the first mouse;
    /// another one only makes the window key. NSH's views all accept it,
    /// but a hidden title bar's toolbar lies over the content's top
    /// (`currentWindow().set({ titleBar: { style: "hidden", height } })`:
    /// full-size content under an empty `NSToolbar`), and where its view is
    /// what AppKit hits (macOS 15: the title bar's whole width) it does not:
    /// there a press on the app's own views was lost. The key window hands such a press on to
    /// the content under it, so this window does too: what the title bar
    /// would only take to make the window key goes to the content's view at
    /// that point, as do its drags and release.
    #[unsafe(super(NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = WindowIvars]
    #[name = "NshWindow"]
    pub(crate) struct NshWindow;

    unsafe impl NSObjectProtocol for NshWindow {}

    impl NshWindow {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            self.ivars().focusable.get()
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool {
            self.ivars().focusable.get() && self.ivars().main.get()
        }

        #[unsafe(method(constrainFrameRect:toScreen:))]
        fn constrain_frame_rect(&self, rect: NSRect, screen: Option<&NSScreen>) -> NSRect {
            if self.ivars().keep_size.get() {
                return rect;
            }
            // SAFETY: NSWindow's own constraint.
            unsafe { msg_send![super(self), constrainFrameRect: rect, toScreen: screen] }
        }

        #[unsafe(method(sendEvent:))]
        fn send_event(&self, event: &NSEvent) {
            if !self.ivars().background.get() || !self.pass_title_bar_press(event) {
                // SAFETY: NSWindow's own dispatch of the event.
                unsafe { msg_send![super(self), sendEvent: event] }
            }
        }
    }
);

impl NshWindow {
    /// Hands `event` to the content when it is a left press AppKit would
    /// only make the window key with (or the drag or release of one handed
    /// on before): true when it did.
    fn pass_title_bar_press(&self, event: &NSEvent) -> bool {
        let passed = &self.ivars().passed;
        match event.r#type() {
            NSEventType::LeftMouseDown => {
                let Some(view) = self.title_bar_press_target(event) else {
                    passed.replace(None);
                    return false;
                };
                view.mouseDown(event);
                passed.replace(Some(view));
                true
            }
            NSEventType::LeftMouseDragged => {
                let Some(view) = passed.borrow().clone() else {
                    return false;
                };
                view.mouseDragged(event);
                true
            }
            NSEventType::LeftMouseUp => {
                let Some(view) = passed.take() else {
                    return false;
                };
                view.mouseUp(event);
                true
            }
            _ => false,
        }
    }

    /// The content's view under left press `event` when, in this window
    /// that is not key, AppKit would give it to a view outside the content
    /// that does not accept the first mouse (the title bar's toolbar).
    fn title_bar_press_target(&self, event: &NSEvent) -> Option<Retained<NSView>> {
        if self.isKeyWindow() {
            return None;
        }
        let content = self.contentView()?;
        // SAFETY: a view's superview, read on the main thread.
        let frame = unsafe { content.superview() }?;
        // The frame view's superview is none: it takes window points.
        let hit = frame.hitTest(event.locationInWindow())?;
        if hit.isDescendantOf(&content) || hit.acceptsFirstMouse(Some(event)) {
            return None;
        }
        content.hitTest(frame.convertPoint_fromView(event.locationInWindow(), None))
    }
}

define_class!(
    /// A panel, popup or overlay of NSH's: an `NSPanel`, with its key status
    /// set by `focusable` (a borderless panel cannot be key by default).
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = WindowIvars]
    #[name = "NshPanel"]
    pub(crate) struct NshPanel;

    unsafe impl NSObjectProtocol for NshPanel {}

    impl NshPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            self.ivars().focusable.get()
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool {
            false
        }
    }
);

/// A new window of NSH's class for `kind`, of content size `size`.
fn make_window(
    mtm: MainThreadMarker,
    kind: WindowKind,
    style: NSWindowStyleMask,
    size: NSSize,
    focusable: bool,
) -> Retained<NSWindow> {
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
    let window: Retained<NSWindow> = if is_panel(kind) {
        let this = NshPanel::alloc(mtm).set_ivars(WindowIvars::new(focusable, false, false, false));
        // SAFETY: NSWindow's designated initializer.
        let panel: Retained<NshPanel> = unsafe {
            msg_send![
                super(this),
                initWithContentRect: rect,
                styleMask: style,
                backing: NSBackingStoreType::Buffered,
                defer: false
            ]
        };
        Retained::into_super(Retained::into_super(panel))
    } else {
        new_window(mtm, rect, style, focusable, false, false)
    };
    // SAFETY: the window is kept in `Surface::windows` until it goes.
    unsafe { window.setReleasedWhenClosed(false) };
    window
}

/// A new [`NshWindow`] (the standalone app's main window, a normal window
/// or a dialog of the app's own). `background`: its app runs in the
/// background ([`crate::AppOptions::background`]).
pub(crate) fn new_window(
    mtm: MainThreadMarker,
    rect: NSRect,
    style: NSWindowStyleMask,
    focusable: bool,
    keep_size: bool,
    background: bool,
) -> Retained<NSWindow> {
    let this =
        NshWindow::alloc(mtm).set_ivars(WindowIvars::new(focusable, true, keep_size, background));
    // SAFETY: NSWindow's designated initializer.
    let window: Retained<NshWindow> = unsafe {
        msg_send![
            super(this),
            initWithContentRect: rect,
            styleMask: style,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ]
    };
    Retained::into_super(window)
}

/// Sets whether `window` may become key, when it is one of NSH's.
fn set_focusable(window: &NSWindow, focusable: bool) {
    if let Some(w) = window.downcast_ref::<NshWindow>() {
        w.ivars().focusable.set(focusable);
    } else if let Some(w) = window.downcast_ref::<NshPanel>() {
        w.ivars().focusable.set(focusable);
    }
}

fn is_panel(kind: WindowKind) -> bool {
    matches!(
        kind,
        WindowKind::Panel | WindowKind::Popup | WindowKind::Overlay
    )
}

// --- What a window holds ------------------------------------------------------------------

/// What NSH keeps of a window beside AppKit: the attributes AppKit has no
/// place for (the policies, ...) and the views it added.
pub(crate) struct Held {
    /// A close press closes the window at once.
    close_on_press: Cell<bool>,
    /// Escape closes (hides) it.
    close_on_escape: Cell<bool>,
    /// Losing the focus closes (hides) it.
    close_on_blur: Cell<bool>,
    /// Showing and focusing it activates the app.
    activate: Cell<bool>,
    /// What decides its collection behavior.
    level: Cell<WindowLevel>,
    workspaces: Cell<Workspaces>,
    taskbar: Cell<bool>,
    maximizable: Cell<bool>,
    /// Style mask inputs.
    frame: Cell<WindowFrameStyle>,
    resizable: Cell<bool>,
    minimizable: Cell<bool>,
    closable: Cell<bool>,
    /// The window shows through (`transparent`, or a `backdrop`): nothing
    /// is painted behind the root.
    transparent: Cell<bool>,
    /// Its backdrop under the root.
    backdrop: RefCell<Option<Retained<NSVisualEffectView>>>,
    /// Its title bar.
    pub(crate) title_bar: TitleBar,
    /// The main window's close press waiting for the app's turn: its
    /// serial and whether it closes the window.
    pending_close: Cell<Option<(u64, bool)>>,
    serial: Cell<u64>,
    /// Whether it was focused when last seen (the main window's blur).
    focused: Cell<bool>,
}

impl Default for Held {
    fn default() -> Self {
        Held {
            close_on_press: Cell::new(true),
            close_on_escape: Cell::new(false),
            close_on_blur: Cell::new(false),
            activate: Cell::new(true),
            level: Cell::new(WindowLevel::Normal),
            workspaces: Cell::new(Workspaces::Current),
            taskbar: Cell::new(true),
            maximizable: Cell::new(true),
            frame: Cell::new(WindowFrameStyle::Default),
            resizable: Cell::new(true),
            minimizable: Cell::new(true),
            closable: Cell::new(true),
            transparent: Cell::new(false),
            backdrop: RefCell::new(None),
            title_bar: TitleBar::default(),
            pending_close: Cell::new(None),
            serial: Cell::new(0),
            focused: Cell::new(false),
        }
    }
}

impl Held {
    /// The main window's held values go back to their defaults (a new app
    /// in the surface).
    pub(crate) fn reset(&self) {
        self.close_on_press.set(true);
        self.close_on_escape.set(false);
        self.close_on_blur.set(false);
        self.activate.set(true);
        self.pending_close.set(None);
        // `serial` stays: a queued reply may belong to the old app.
    }

    /// Whether nothing is painted behind the root.
    pub(crate) fn transparent(&self) -> bool {
        self.transparent.get()
    }
}

/// Where a new window first shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Showing {
    /// Shown, or hidden by the app.
    Done,
    /// Waiting for its first frame; the batches applied since it opened.
    Waiting(u8),
}

/// A window of the app's own.
pub(crate) struct AppWindow {
    window: Retained<NSWindow>,
    /// The window's delegate (AppKit holds it weakly).
    _delegate: Retained<WindowDelegate>,
    /// The dialog root it shows.
    view: NshView,
    /// The view holding the root (and the backdrop under it).
    container: Retained<NSView>,
    kind: WindowKind,
    /// The window it belongs to (its root node).
    parent: Option<NodeId>,
    /// It takes its parent's input while it shows.
    modal: bool,
    held: Held,
    watch: Watch,
    /// The size last reported to the core.
    reported: Cell<Option<Size<Points>>>,
    /// The state last reported to the app.
    state: Cell<Option<WindowState>>,
    /// The title bar area last reported to the app.
    title_bar_area: Cell<Option<Edges<Points>>>,
    showing: Cell<Showing>,
    /// The mode it opens in, applied once it shows.
    open_mode: Cell<Option<WindowMode>>,
}

/// The state of window `id` (the main window's for the root) as it is now;
/// `None` when no such window is open.
#[cfg(feature = "dev")]
pub(crate) fn state(surface: &Surface, id: NodeId) -> Option<WindowState> {
    if id == ROOT_ID {
        return crate::window_state::read(surface);
    }
    let windows = surface.windows.try_borrow().ok()?;
    let w = windows.get(&id)?;
    Some(crate::window_state::read_window(&w.watch, &w.window))
}

/// The root of the surface's window that has the keyboard (the main
/// window's when none of the app's own has it): where an announcement
/// goes, so VoiceOver reads it in the window the user is in.
pub(crate) fn key_root(surface: &Surface) -> NshView {
    surface
        .windows
        .try_borrow()
        .ok()
        .and_then(|windows| {
            windows
                .values()
                .find(|w| is_key(&w.window))
                .map(|w| w.view.clone())
        })
        .unwrap_or_else(|| surface.root.clone())
}

/// The window a sheet (an open or save panel, an alert) the user asked
/// for slides down from: the app's own window that has the keyboard when
/// it has a title bar to hang it from, else the main window.
pub(crate) fn sheet_window(surface: &Surface) -> Option<Retained<NSWindow>> {
    let own = surface.windows.try_borrow().ok().and_then(|windows| {
        windows
            .values()
            .find(|w| is_key(&w.window) && w.window.styleMask().contains(NSWindowStyleMask::Titled))
            .map(|w| w.window.clone())
    });
    own.or_else(|| surface.root.ns().window())
}

/// The root view window `id` shows (the surface's root for the main
/// window).
pub(crate) fn root_view(surface: &Surface, id: NodeId) -> Option<NshView> {
    if id == ROOT_ID {
        return Some(surface.root.clone());
    }
    let windows = surface.windows.try_borrow().ok()?;
    windows.get(&id).map(|w| w.view.clone())
}

/// The surface's window that has the keyboard: its key window, else (an
/// app in the background has none) the frontmost of its windows on the
/// screen, else the main window.
#[cfg(feature = "dev")]
pub(crate) fn key_window(surface: &Surface) -> Option<Retained<NSWindow>> {
    let main = surface.root.ns().window();
    let own: Vec<Retained<NSWindow>> = surface
        .windows
        .try_borrow()
        .map(|windows| windows.values().map(|w| w.window.clone()).collect())
        .unwrap_or_default();
    let ours = || main.iter().chain(own.iter());
    if let Some(key) = ours().find(|w| is_key(w)) {
        return Some(key.clone());
    }
    let app = NSApplication::sharedApplication(surface.mtm);
    // SAFETY: `orderedWindows` returns the app's windows, front to back.
    let ordered: Retained<objc2_foundation::NSArray<NSWindow>> =
        unsafe { msg_send![&*app, orderedWindows] };
    let front = ordered
        .iter()
        .find(|w| w.isVisible() && ours().any(|o| **o == **w));
    front.or(main)
}

/// The test agent's press on window `id`'s close button (`nsh test`): the
/// button's own click, so it goes where a user's press goes (the window's
/// close policy, the reason `closeButton`).
#[cfg(feature = "dev")]
pub(crate) fn press_close_button(surface: &Surface, id: NodeId) -> Result<(), String> {
    let window = window_of(surface, id).ok_or("no such window is open")?;
    let button = window
        .standardWindowButton(NSWindowButton::CloseButton)
        .filter(|b| !b.isHiddenOrHasHiddenAncestor())
        .ok_or("the window has no close button")?;
    if !button.isEnabled() {
        return Err("the window's close button is disabled".into());
    }
    CLOSE_BUTTON_PRESS.set(true);
    // SAFETY: a click of a button of the window, on the main thread.
    unsafe { button.performClick(None) };
    CLOSE_BUTTON_PRESS.set(false);
    Ok(())
}

/// Whether dialog root `id` is shown in a window of its own.
pub(crate) fn is_window(surface: &Surface, id: NodeId) -> bool {
    surface
        .windows
        .try_borrow()
        .is_ok_and(|windows| windows.contains_key(&id))
}

/// The window showing root `id` (the main window's for the root).
pub(crate) fn window_of(surface: &Surface, id: NodeId) -> Option<Retained<NSWindow>> {
    if id == ROOT_ID {
        return surface.root.ns().window();
    }
    surface
        .windows
        .try_borrow()
        .ok()?
        .get(&id)
        .map(|w| w.window.clone())
}

/// `f` with the watch of window `id`.
pub(crate) fn with_watch<R>(
    surface: &Surface,
    id: NodeId,
    f: impl FnOnce(&Watch) -> R,
) -> Option<R> {
    let windows = surface.windows.try_borrow().ok()?;
    windows.get(&id).map(|w| f(&w.watch))
}

/// `f` with the title bar of window `id` (the main window's for the root).
pub(crate) fn with_title_bar<R>(
    surface: &Surface,
    id: NodeId,
    f: impl FnOnce(&TitleBar) -> R,
) -> Option<R> {
    with_held(surface, id, |held| f(&held.title_bar))
}

/// `f` with what is held of window `id` (the main window's for the root).
fn with_held<R>(surface: &Surface, id: NodeId, f: impl FnOnce(&Held) -> R) -> Option<R> {
    if id == ROOT_ID {
        return Some(f(&surface.main_window));
    }
    let windows = surface.windows.try_borrow().ok()?;
    windows.get(&id).map(|w| f(&w.held))
}

/// The root node of the window `window` is, if it is the surface's.
fn id_of(surface: &Surface, window: &NSWindow) -> Option<NodeId> {
    if surface.root.ns().window().as_deref() == Some(window) {
        return Some(ROOT_ID);
    }
    let windows = surface.windows.try_borrow().ok()?;
    windows
        .iter()
        .find(|(_, w)| &*w.window == window)
        .map(|(id, _)| *id)
}

/// The window an event of root `root` (`None`: the surface's) happened in,
/// as a root node id.
fn event_window(surface: &Surface) -> NodeId {
    let root = crate::input::event_root(surface);
    if root.ns() == surface.root.ns() {
        ROOT_ID
    } else {
        root.id()
    }
}

// --- Commands -----------------------------------------------------------------------------

/// A window command addressed to root node `id` (the main window's is the
/// root): opening a window, its attributes or a request.
pub(crate) fn command(
    surface: &Rc<Surface>,
    id: NodeId,
    view: Option<&NshView>,
    command: &DesktopCommand,
) {
    match command {
        DesktopCommand::OpenWindow(open) if id != ROOT_ID => {
            let Some(view) = view else {
                return log::warn!("window: no view {id}");
            };
            open_window(surface, view, open);
        }
        DesktopCommand::OpenWindow(_) => log::warn!("window: the main window is open already"),
        DesktopCommand::SetAttributes(attributes) => set_attributes(surface, id, attributes),
        DesktopCommand::Request(request) => self::request(surface, id, request),
        _ => {}
    }
}

/// Applies the attributes that are set in `a` to window `id`.
fn set_attributes(surface: &Rc<Surface>, id: NodeId, a: &WindowAttributes) {
    let Some(window) = window_of(surface, id) else {
        return log::debug!("window: no window for {id}");
    };
    let kind = if id == ROOT_ID {
        WindowKind::Normal
    } else {
        surface
            .windows
            .borrow()
            .get(&id)
            .map_or(WindowKind::Normal, |w| w.kind)
    };
    with_held(surface, id, |held| {
        apply(surface, id, &window, kind, held, a)
    });
    report(surface, id);
}

/// Applies `a` (its fields that are set) to `window`, of `kind`, holding
/// what AppKit has no place for in `held`.
fn apply(
    surface: &Surface,
    id: NodeId,
    window: &NSWindow,
    kind: WindowKind,
    held: &Held,
    a: &WindowAttributes,
) {
    if let Some(title) = &a.title {
        window.setTitle(&NSString::from_str(title));
    }
    // What the style mask is made of.
    let mut style = false;
    for (value, cell) in [
        (a.resizable, &held.resizable),
        (a.minimizable, &held.minimizable),
        (a.closable, &held.closable),
    ] {
        if let Some(v) = value {
            cell.set(v);
            style = true;
        }
    }
    if let Some(frame) = a.frame {
        held.frame.set(frame);
        style = true;
    }
    if let Some(activate) = a.activate {
        held.activate.set(activate);
        style |= is_panel(kind);
    }
    if style {
        let hidden = held.title_bar.style.get() == TitleBarStyle::Hidden;
        window.setStyleMask(style_mask(&StyleInputs {
            kind,
            frame: held.frame.get(),
            title_bar_hidden: hidden,
            resizable: held.resizable.get(),
            minimizable: held.minimizable.get(),
            closable: held.closable.get(),
            activate: held.activate.get(),
        }));
    }
    if let Some(title_bar) = &a.title_bar {
        crate::chrome::set_title_bar(surface, id, &held.title_bar, window, title_bar);
    }
    if let Some(min) = a.min_size {
        window.setContentMinSize(min.map_or(NSSize::new(0.0, 0.0), ns_size));
    }
    if let Some(max) = a.max_size {
        window.setContentMaxSize(max.map_or(NSSize::new(f64::MAX, f64::MAX), ns_size));
    }
    if let Some(movable) = a.movable {
        window.setMovable(movable);
    }
    if let Some(focusable) = a.focusable {
        set_focusable(window, focusable);
    }
    if let Some(v) = a.close_on_press {
        held.close_on_press.set(v);
    }
    if let Some(v) = a.close_on_escape {
        held.close_on_escape.set(v);
    }
    if let Some(v) = a.close_on_blur {
        held.close_on_blur.set(v);
    }
    let mut behavior = false;
    if let Some(level) = a.level {
        held.level.set(level);
        window.setLevel(ns_level(level));
        behavior = true;
    }
    if let Some(taskbar) = a.taskbar {
        held.taskbar.set(taskbar);
        window.setExcludedFromWindowsMenu(!taskbar);
        behavior = true;
    }
    if let Some(workspaces) = a.workspaces {
        held.workspaces.set(workspaces);
        behavior = true;
    }
    if let Some(maximizable) = a.maximizable {
        held.maximizable.set(maximizable);
        if let Some(zoom) = window.standardWindowButton(NSWindowButton::ZoomButton) {
            zoom.setEnabled(maximizable);
        }
        behavior = true;
    }
    if behavior {
        window.setCollectionBehavior(collection_behavior(
            held.level.get(),
            held.workspaces.get(),
            held.taskbar.get(),
            held.maximizable.get(),
        ));
    }
    if let Some(pointer) = a.pointer_events {
        window.setIgnoresMouseEvents(pointer == WindowPointerEvents::None);
    }
    if let Some(shadow) = a.shadow {
        window.setHasShadow(shadow);
    }
    if a.transparent.is_some() || a.backdrop.is_some() {
        let transparent = a.transparent.unwrap_or(held.transparent.get());
        let backdrop = match a.backdrop {
            Some(b) => b,
            None => held
                .backdrop
                .borrow()
                .as_ref()
                .map_or(Backdrop::None, |v| backdrop_of(v.material())),
        };
        set_look(surface, id, window, held, transparent, backdrop);
    }
    if let Some(progress) = a.progress {
        dock::set(surface.key(), id, progress);
    }
}

/// The inputs of a window's style mask.
#[derive(Debug, Clone, Copy)]
struct StyleInputs {
    kind: WindowKind,
    frame: WindowFrameStyle,
    title_bar_hidden: bool,
    resizable: bool,
    minimizable: bool,
    closable: bool,
    activate: bool,
}

/// The style mask of a window.
fn style_mask(s: &StyleInputs) -> NSWindowStyleMask {
    let mut mask = match s.frame {
        WindowFrameStyle::None => NSWindowStyleMask::Borderless,
        _ => {
            let mut mask = NSWindowStyleMask::Titled;
            if s.closable {
                mask |= NSWindowStyleMask::Closable;
            }
            if s.minimizable {
                mask |= NSWindowStyleMask::Miniaturizable;
            }
            if s.kind == WindowKind::Panel {
                mask |= NSWindowStyleMask::UtilityWindow;
            }
            if s.title_bar_hidden {
                mask |= NSWindowStyleMask::FullSizeContentView;
            }
            mask
        }
    };
    if s.resizable {
        mask |= NSWindowStyleMask::Resizable;
    }
    if is_panel(s.kind) && !s.activate {
        mask |= NSWindowStyleMask::NonactivatingPanel;
    }
    mask
}

/// The AppKit level of `level`.
fn ns_level(level: WindowLevel) -> isize {
    match level {
        WindowLevel::Normal => NSNormalWindowLevel,
        WindowLevel::Floating => NSFloatingWindowLevel,
        // Above the Dock and the menu bar.
        WindowLevel::AboveDock => NSStatusWindowLevel,
        WindowLevel::DesktopIcon => kCGDesktopIconWindowLevel as isize,
    }
}

/// A window's collection behavior: which spaces it is on, whether it
/// takes part in Cmd+` and full screen.
fn collection_behavior(
    level: WindowLevel,
    workspaces: Workspaces,
    taskbar: bool,
    maximizable: bool,
) -> NSWindowCollectionBehavior {
    // A desktop widget is a part of the desktop, not a window: it sits on
    // every space, Mission Control does not list it (it could never be
    // raised above normal windows anyway) and Cmd+` cycles past it.
    if level == WindowLevel::DesktopIcon {
        return NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::IgnoresCycle;
    }
    let mut behavior = if workspaces == Workspaces::All {
        // Over other apps' full screen spaces too.
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
    } else if level != WindowLevel::Normal {
        // A floating window comes along to the space the app is used in.
        NSWindowCollectionBehavior::MoveToActiveSpace
    } else {
        NSWindowCollectionBehavior::empty()
    };
    if !taskbar {
        behavior |= NSWindowCollectionBehavior::IgnoresCycle;
    }
    if workspaces != Workspaces::All {
        behavior |= if maximizable {
            NSWindowCollectionBehavior::FullScreenPrimary
        } else {
            NSWindowCollectionBehavior::FullScreenNone
        };
    }
    behavior
}

/// The material of a backdrop.
fn material(backdrop: Backdrop) -> Option<NSVisualEffectMaterial> {
    match backdrop {
        Backdrop::Window => Some(NSVisualEffectMaterial::WindowBackground),
        Backdrop::Sidebar => Some(NSVisualEffectMaterial::Sidebar),
        Backdrop::Popover => Some(NSVisualEffectMaterial::Popover),
        Backdrop::Hud => Some(NSVisualEffectMaterial::HUDWindow),
        _ => None,
    }
}

/// The backdrop of a material.
fn backdrop_of(material: NSVisualEffectMaterial) -> Backdrop {
    match material {
        NSVisualEffectMaterial::WindowBackground => Backdrop::Window,
        NSVisualEffectMaterial::Sidebar => Backdrop::Sidebar,
        NSVisualEffectMaterial::Popover => Backdrop::Popover,
        NSVisualEffectMaterial::HUDWindow => Backdrop::Hud,
        _ => Backdrop::None,
    }
}

/// The window's background: transparent and its backdrop.
fn set_look(
    surface: &Surface,
    id: NodeId,
    window: &NSWindow,
    held: &Held,
    transparent: bool,
    backdrop: Backdrop,
) {
    let see_through = transparent || backdrop != Backdrop::None;
    held.transparent.set(see_through);
    window.setOpaque(!see_through);
    // The root's container: the view the root and the backdrop are in.
    let root = if id == ROOT_ID {
        Some(surface.root.clone())
    } else {
        surface
            .windows
            .try_borrow()
            .ok()
            .and_then(|w| w.get(&id).map(|w| w.view.clone()))
    };
    let container = root.as_ref().and_then(|r| crate::view::superview(r.ns()));
    if see_through {
        window.setBackgroundColor(Some(&NSColor::clearColor()));
        if let Some(layer) = container.as_ref().and_then(|c| c.layer()) {
            crate::surface::quiet(|| layer.setBackgroundColor(None));
        }
    } else if let Some(color) = surface.background.get() {
        window.setBackgroundColor(Some(&ns_color(color)));
        if let Some(layer) = container.as_ref().and_then(|c| c.layer()) {
            crate::surface::quiet(|| layer.setBackgroundColor(Some(&crate::text::cg_color(color))));
        }
    }
    let mut effect = held.backdrop.borrow_mut();
    match (material(backdrop), container) {
        (Some(material), Some(container)) => {
            let view = effect.get_or_insert_with(|| {
                let view = NSVisualEffectView::initWithFrame(
                    NSVisualEffectView::alloc(surface.mtm),
                    container.bounds(),
                );
                view.setAutoresizingMask(
                    NSAutoresizingMaskOptions::ViewWidthSizable
                        | NSAutoresizingMaskOptions::ViewHeightSizable,
                );
                view.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                // Under every subview.
                container.addSubview_positioned_relativeTo(
                    &view,
                    NSWindowOrderingMode::Below,
                    None,
                );
                view
            });
            view.setMaterial(material);
            // A popover's and a HUD's material shows active also in an
            // inactive window, as AppKit's own popovers and panels do.
            view.setState(match backdrop {
                Backdrop::Popover | Backdrop::Hud => NSVisualEffectState::Active,
                _ => NSVisualEffectState::FollowsWindowActiveState,
            });
        }
        _ => {
            if let Some(view) = effect.take() {
                view.removeFromSuperview();
            }
        }
    }
}

/// A request to window `id`.
fn request(surface: &Rc<Surface>, id: NodeId, request: &WindowRequest) {
    let Some(window) = window_of(surface, id) else {
        return log::debug!("window: no window for {id}");
    };
    let mtm = surface.mtm;
    match request {
        WindowRequest::Show => show(surface, id, &window, false),
        WindowRequest::Hide => {
            if let Some(w) = surface.windows.borrow().get(&id) {
                w.showing.set(Showing::Done);
            }
            window.orderOut(None);
            lost_key(surface, &window);
        }
        WindowRequest::Focus => show(surface, id, &window, true),
        WindowRequest::Close => close_request(surface, id, &window),
        WindowRequest::Minimize => {
            window.miniaturize(None);
            lost_key(surface, &window);
        }
        WindowRequest::Restore => {
            if window.isMiniaturized() {
                window.deminiaturize(None);
            }
        }
        WindowRequest::SetMode(mode) => {
            with_target_watch(surface, id, |watch| {
                crate::window_state::set_mode(watch, &window, *mode)
            });
        }
        WindowRequest::SetBounds(frame) => crate::chrome::set_frame(&window, frame),
        WindowRequest::SetContentSize { width, height } => {
            let frame = window.frame();
            let mut content = window.contentRectForFrameRect(frame);
            if let Some(width) = width {
                content.size.width = f64::from(width.0);
            }
            if let Some(height) = height {
                content.size.height = f64::from(height.0);
            }
            let size = window.frameRectForContentRect(content).size;
            // Cocoa's origin is the bottom left corner: the top left stays.
            let origin = NSPoint::new(
                frame.origin.x,
                frame.origin.y + frame.size.height - size.height,
            );
            window.setFrame_display(NSRect::new(origin, size), true);
        }
        WindowRequest::SetPlacement(placement) => {
            with_target_watch(surface, id, |watch| {
                crate::window_state::set_placement(watch, &window, *placement)
            });
        }
        WindowRequest::Center { display } => {
            let screen = display
                .and_then(|d| crate::window_state::screen(mtm, d))
                .or_else(|| window.screen())
                .or_else(|| NSScreen::mainScreen(mtm));
            if let Some(screen) = screen {
                crate::window_state::center_on(&window, &screen);
            }
        }
        WindowRequest::RequestAttention { critical } => {
            NSApplication::sharedApplication(mtm).requestUserAttention(if *critical {
                NSRequestUserAttentionType::CriticalRequest
            } else {
                NSRequestUserAttentionType::InformationalRequest
            });
        }
    }
    report(surface, id);
}

/// `f` with the watch of window `id` (the main window's for the root).
fn with_target_watch(surface: &Surface, id: NodeId, f: impl FnOnce(&Watch)) {
    if id == ROOT_ID {
        f(&surface.window);
    } else {
        with_watch(surface, id, f);
    }
}

/// Shows window `id` (`focus`: and makes it key); a new window waiting for
/// its first frame shows with it.
fn show(surface: &Surface, id: NodeId, window: &NSWindow, focus: bool) {
    if let Some(w) = surface.windows.borrow().get(&id)
        && let Showing::Waiting(_) = w.showing.get()
    {
        // It shows with its first frame.
        return;
    }
    let (activate, focusable) = with_held(surface, id, |h| h.activate.get())
        .map(|activate| (activate, window.canBecomeKeyWindow()))
        .unwrap_or((true, true));
    // A window that does not activate (a panel) shows without taking the
    // keyboard, unless the app focuses it.
    order_front(
        surface,
        window,
        activate,
        focus || (focusable && activate),
        focus,
    );
}

/// Orders `window` front: the app activates first when it may (ordering a
/// window front in an inactive app leaves it behind the front app's), the
/// window becomes key when it may.
fn order_front(surface: &Surface, window: &NSWindow, activate: bool, key: bool, focus: bool) {
    let app = NSApplication::sharedApplication(surface.mtm);
    if focus && window.isMiniaturized() {
        window.deminiaturize(None);
    }
    if activate && !app.isActive() {
        app.activate();
    }
    if key && window.canBecomeKeyWindow() {
        window.makeKeyAndOrderFront(None);
        became_key(surface, window);
    } else {
        window.orderFront(None);
    }
    if !app.isActive() {
        // A window the app opens while another app is in front still
        // shows (a test's app never activates).
        window.orderFrontRegardless();
    }
}

/// `close()`: closes window `id` whatever `closeOnPress` says.
fn close_request(surface: &Rc<Surface>, id: NodeId, window: &NSWindow) {
    if id == ROOT_ID {
        // After the batch, as Windows posts WM_CLOSE and GTK waits for
        // idle: closing runs windowWillClose: at once, which stops the
        // surface while this batch still holds its mounter.
        let key = surface.key();
        DispatchQueue::main().exec_async(move || {
            if let Some(surface) = Surface::with_key(key)
                && !crate::app::close_main_window(key)
                && let Some(window) = surface.root.ns().window()
            {
                window.performClose(None);
            }
        });
        return;
    }
    // A window of the app's own goes when the app removes its root: it
    // hides until then.
    let _ = window;
    dismiss(surface, id, WindowCloseCause::ClosePress);
}

// --- Opening ------------------------------------------------------------------------------

/// Shows dialog root `view` in a new window.
fn open_window(surface: &Rc<Surface>, view: &NshView, open: &OpenWindow) {
    let id = view.id();
    if is_window(surface, id) {
        return;
    }
    let options = &open.options;
    let a = &options.attributes;
    let mtm = surface.mtm;
    // Presented over the main window by an insertion earlier in the batch:
    // it leaves the surface's modals.
    crate::navigation::release(surface, id);
    if view.has_parent() {
        view.unparent();
    }
    let kind = options.kind;
    let held = Held::default();
    held.frame.set(a.frame.unwrap_or_default());
    held.resizable.set(a.resizable.unwrap_or(true));
    held.minimizable.set(a.minimizable.unwrap_or(true));
    held.closable.set(a.closable.unwrap_or(true));
    held.activate.set(a.activate.unwrap_or(true));
    let hidden_bar = a
        .title_bar
        .is_some_and(|t| t.style == TitleBarStyle::Hidden);
    let style = style_mask(&StyleInputs {
        kind,
        frame: held.frame.get(),
        title_bar_hidden: hidden_bar,
        resizable: held.resizable.get(),
        minimizable: held.minimizable.get(),
        closable: held.closable.get(),
        activate: held.activate.get(),
    });
    let content = options.default_size.map_or(DEFAULT_SIZE, ns_size);
    let window = make_window(mtm, kind, style, content, a.focusable.unwrap_or(true));
    if let Some(panel) = window.downcast_ref::<NSPanel>() {
        // A panel stays when the app is not in front: a test's app never
        // is, and an inspector next to another app's window is common.
        panel.setHidesOnDeactivate(false);
        panel.setFloatingPanel(false);
        panel.setBecomesKeyOnlyIfNeeded(kind == WindowKind::Overlay);
    }
    // VoiceOver reads a dialog window as a dialog; the other kinds keep
    // their class's (standard, floating) subrole.
    if kind == WindowKind::Dialog {
        // SAFETY: an immutable AppKit constant.
        objc2_app_kit::NSAccessibility::setAccessibilitySubrole(
            &*window,
            Some(unsafe { objc2_app_kit::NSAccessibilityDialogSubrole }),
        );
    }
    let delegate: Retained<WindowDelegate> = {
        let d = WindowDelegate::alloc(mtm).set_ivars((surface.key(), id));
        // SAFETY: NSObject's initializer.
        unsafe { msg_send![super(d), init] }
    };
    window.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    crate::system::open_window(&window, surface.appearance.get());
    // The root sits in a container, the backdrop under it.
    let container = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), content),
    );
    container.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    container.setWantsLayer(true);
    view.ns()
        .setFrame(NSRect::new(NSPoint::new(0.0, 0.0), content));
    view.ns().setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    container.addSubview(view.ns());
    window.setContentView(Some(&container));
    // Nothing is focused until the user or the app focuses it: the root
    // holds the keyboard, so becoming key (a press, `focus()`) never lets
    // AppKit pick the first key view (a field, its text selected).
    window.setInitialFirstResponder(Some(view.ns()));
    window.makeFirstResponder(Some(view.ns()));
    let parent = open.parent;
    let parent_window = parent.and_then(|p| window_of(surface, p));
    // Where it opens.
    match &open.placement {
        Some(placement) => {
            let primary = crate::window_state::primary_height(mtm);
            window.setFrame_display(
                crate::window_state::from_bounds(placement.bounds, primary),
                false,
            );
        }
        None => place(
            surface,
            &window,
            options.default_position,
            options.display,
            kind,
            parent_window.as_deref(),
        ),
    }
    let open_mode = open
        .placement
        .map(|p| p.mode)
        .or(options.default_mode)
        .filter(|m| *m != WindowMode::Normal);
    surface.windows.borrow_mut().insert(
        id,
        AppWindow {
            window: window.clone(),
            _delegate: delegate,
            view: view.clone(),
            container,
            kind,
            parent,
            modal: options.modal && parent.is_some(),
            held,
            watch: Watch::default(),
            reported: Cell::new(None),
            state: Cell::new(None),
            title_bar_area: Cell::new(None),
            showing: Cell::new(Showing::Waiting(0)),
            open_mode: Cell::new(open_mode),
        },
    );
    {
        let windows = surface.windows.borrow();
        let w = windows.get(&id).expect("just inserted");
        apply(surface, id, &window, kind, &w.held, a);
        // It takes the app's appearance, as the main window's root does.
        window.setAppearance(surface.root.ns().appearance().as_deref());
        crate::window_state::observe(surface, Target::Own(id), &w.watch, Some(&window));
    }
    // A dialog stays above its parent and moves with it.
    if kind == WindowKind::Dialog
        && let Some(parent) = &parent_window
    {
        // SAFETY: both windows are AppKit's, alive while this runs.
        unsafe { parent.addChildWindow_ordered(&window, NSWindowOrderingMode::Above) };
    }
    // The view's own place is the window's: the core only sizes it.
    let size = window.contentRectForFrameRect(window.frame()).size;
    view.state_mut().frame = Bounds::new(
        point(Points(0.0), Points(0.0)),
        Size::new(Points(size.width as f32), Points(size.height as f32)),
    );
    view.set_window_of(Rc::downgrade(surface));
    if let Some(appearance) = surface.root.ns().appearance() {
        view.ns().setAppearance(Some(&appearance));
    }
    if crate::file_drop::accepting(surface) {
        crate::file_drop::register(view.ns());
    }
    resized(surface, view);
    // Shown with its first frame, or late.
    let key = surface.key();
    crate::surface::after(FIRST_FRAME_MS, move || {
        if let Some(surface) = Surface::with_key(key) {
            first_frame(&surface, id);
        }
    });
    report(surface, id);
}

/// Places a new window: at `position`, on `display`, by its `kind` and
/// over its parent.
fn place(
    surface: &Surface,
    window: &NSWindow,
    position: Option<WindowPosition>,
    display: Option<nsh_core::desktop::DisplayId>,
    kind: WindowKind,
    parent: Option<&NSWindow>,
) {
    let mtm = surface.mtm;
    let screen = display
        .and_then(|d| crate::window_state::screen(mtm, d))
        .or_else(|| parent.and_then(|p| p.screen()))
        .or_else(|| surface.root.ns().window().and_then(|w| w.screen()))
        .or_else(|| NSScreen::mainScreen(mtm));
    let position = position.unwrap_or(match kind {
        WindowKind::Dialog if parent.is_some() => WindowPosition::ParentCenter,
        WindowKind::Popup | WindowKind::Overlay => WindowPosition::Center,
        _ if display.is_some() => WindowPosition::Center,
        _ => {
            // Cascaded from the parent's (or the main window's) top left.
            let step = CASCADE * (surface.windows.borrow().len() % 8 + 1) as f64;
            let from = parent
                .map(|p| p.frame())
                .or_else(|| surface.root.ns().window().map(|w| w.frame()));
            let top_left = from.map_or(NSPoint::new(step, step), |f| {
                NSPoint::new(f.origin.x + step, f.origin.y + f.size.height - step)
            });
            window.setFrameTopLeftPoint(top_left);
            return;
        }
    });
    match position {
        WindowPosition::At(p) => {
            let primary = crate::window_state::primary_height(mtm);
            window.setFrameTopLeftPoint(NSPoint::new(f64::from(p.x.0), primary - f64::from(p.y.0)));
        }
        WindowPosition::ParentCenter if parent.is_some() => {
            let p = parent.expect("checked").frame();
            window.setFrameOrigin(crate::window_state::centered(window.frame().size, p));
        }
        _ => {
            if let Some(screen) = screen {
                crate::window_state::center_on(window, &screen);
            }
        }
    }
}

/// A batch was applied: the windows waiting for their first frame show
/// once one laid out at their size is in.
pub(crate) fn batch_applied(surface: &Surface) {
    let ready: Vec<NodeId> = {
        let Ok(windows) = surface.windows.try_borrow() else {
            return;
        };
        windows
            .iter()
            .filter_map(|(id, w)| match w.showing.get() {
                Showing::Waiting(n) if n >= 1 => Some(*id),
                Showing::Waiting(n) => {
                    w.showing.set(Showing::Waiting(n + 1));
                    None
                }
                Showing::Done => None,
            })
            .collect()
    };
    for id in ready {
        first_frame(surface, id);
    }
}

/// Window `id` has its first frame (or waited long enough): it shows, in
/// the mode it opens in.
fn first_frame(surface: &Surface, id: NodeId) {
    let Some((window, activate, mode)) = surface.windows.try_borrow().ok().and_then(|windows| {
        let w = windows.get(&id)?;
        if w.showing.get() == Showing::Done {
            return None;
        }
        w.showing.set(Showing::Done);
        Some((w.window.clone(), w.held.activate.get(), w.open_mode.take()))
    }) else {
        return;
    };
    // A window that does not activate (a panel) shows without taking the
    // keyboard.
    let key = window.canBecomeKeyWindow() && activate;
    // The root has held the keyboard since the window was made (a field
    // the app focused meanwhile keeps it).
    order_front(surface, &window, activate, key, false);
    if let Some(mode) = mode {
        with_watch(surface, id, |watch| {
            crate::window_state::set_mode(watch, &window, mode)
        });
    }
    report(surface, id);
}

/// The standalone app's main window is made: nsh.json `window`'s
/// attributes, size and place apply before it shows (`kept`: where the
/// user left it, `restoreBounds`).
pub(crate) fn launch_main(
    surface: &Surface,
    window: &NSWindow,
    launch: &MainWindowOptions,
    kept: Option<WindowPlacement>,
) {
    let mtm = surface.mtm;
    apply(
        surface,
        ROOT_ID,
        window,
        WindowKind::Normal,
        &surface.main_window,
        &launch.attributes,
    );
    if let Some(kept) = kept {
        let primary = crate::window_state::primary_height(mtm);
        window.setFrame_display(
            crate::window_state::from_bounds(kept.bounds, primary),
            false,
        );
        return;
    }
    let screen = launch
        .display
        .and_then(|d| crate::window_state::screen(mtm, d));
    match launch.default_position {
        Some(WindowPosition::At(p)) => {
            let primary = crate::window_state::primary_height(mtm);
            window.setFrameTopLeftPoint(NSPoint::new(f64::from(p.x.0), primary - f64::from(p.y.0)));
        }
        _ => match screen {
            Some(screen) => crate::window_state::center_on(window, &screen),
            None => window.center(),
        },
    }
}

/// The standalone app's main window shows: it takes the mode it opens in.
pub(crate) fn launched_main(surface: &Surface, mode: Option<WindowMode>) {
    if let Some(mode) = mode.filter(|m| *m != WindowMode::Normal)
        && let Some(window) = surface.root.ns().window()
    {
        crate::window_state::set_mode(&surface.window, &window, mode);
    }
}

// --- Reports ------------------------------------------------------------------------------

/// Reads window `id`'s state again and tells the app (the main window's
/// goes into the environment).
fn report(surface: &Surface, id: NodeId) {
    if id == ROOT_ID {
        crate::window_state::changed(surface);
    } else {
        state_changed(surface, id);
    }
}

/// Window `id` of the app's own changed: its title bar area and its state,
/// those that are new, go to the app on its root (the area first, so the
/// app has it with the state).
pub(crate) fn state_changed(surface: &Surface, id: NodeId) {
    let (area, state) = {
        let Ok(windows) = surface.windows.try_borrow() else {
            return;
        };
        let Some(w) = windows.get(&id) else {
            return;
        };
        crate::chrome::place_controls(surface, id, &w.held.title_bar, &w.window);
        let area = crate::chrome::title_bar_area(&w.held.title_bar, &w.window);
        let state = crate::window_state::read_window(&w.watch, &w.window);
        (
            (w.title_bar_area.replace(Some(area)) != Some(area)).then_some(area),
            (w.state.replace(Some(state)) != Some(state)).then_some(state),
        )
    };
    if let Some(area) = area {
        send(surface, id, WindowEvent::TitleBar(area));
    }
    if let Some(state) = state {
        send(surface, id, WindowEvent::State(Box::new(state)));
    }
}

/// The main window's state was read: its controls go back where the app
/// put them, and losing the focus closes it with `closeOnBlur`.
pub(crate) fn main_changed(surface: &Surface, state: Option<&WindowState>) {
    let Some(window) = surface.root.ns().window() else {
        return;
    };
    crate::chrome::place_controls(surface, ROOT_ID, &surface.main_window.title_bar, &window);
    let focused = state.is_some_and(|s| s.focused);
    let was = surface.main_window.focused.replace(focused);
    if was && !focused && surface.main_window.close_on_blur.get() {
        let key = surface.key();
        DispatchQueue::main().exec_async(move || {
            if let Some(surface) = Surface::with_key(key) {
                crate::app::close_main_window(surface.key());
            }
        });
    }
}

/// A window left full screen.
pub(crate) fn left_full_screen(surface: &Surface, target: Target) {
    match target {
        Target::Main => {
            if let Some(window) = surface.root.ns().window() {
                crate::chrome::place_controls(
                    surface,
                    ROOT_ID,
                    &surface.main_window.title_bar,
                    &window,
                );
            }
        }
        Target::Own(id) => {
            if let Some(w) = surface.windows.borrow().get(&id) {
                crate::chrome::place_controls(surface, id, &w.held.title_bar, &w.window);
            }
        }
    }
}

fn send(surface: &Surface, id: NodeId, event: WindowEvent) {
    surface.event(id, EventKind::Window, EventPayload::Window(Box::new(event)));
}

/// The root view of a window of the app's own was resized (it fills the
/// window's content view): the core lays the root out at its size.
pub(crate) fn resized(surface: &Surface, view: &NshView) {
    let id = view.id();
    let size = {
        let windows = surface.windows.borrow();
        let Some(w) = windows.get(&id) else {
            return;
        };
        // The window's content (the container the root fills), whatever
        // set the root's own frame.
        let bounds = w.container.bounds();
        if view.ns().frame() != bounds {
            view.ns().setFrame(bounds);
        }
        let size = Size::new(
            Points(bounds.size.width as f32),
            Points(bounds.size.height as f32),
        );
        if w.reported.replace(Some(size)) == Some(size) {
            return;
        }
        size
    };
    view.state_mut().frame = Bounds::new(point(Points(0.0), Points(0.0)), size);
    surface.control(|c| c.set_root_size(id, size, EdgeInsets::default()));
    crate::navigation::window_resized(surface, view);
}

/// The displays changed: the windows of the app's own read their state
/// again.
pub(crate) fn screens_changed(surface: &Surface) {
    let ids: Vec<NodeId> = surface
        .windows
        .try_borrow()
        .map(|w| w.keys().copied().collect())
        .unwrap_or_default();
    for id in ids {
        state_changed(surface, id);
    }
}

// --- The key window in the background -----------------------------------------------------

thread_local! {
    /// The window that has the keyboard while the app runs in the
    /// background (`AppOptions::background`, `nsh test`'s): AppKit makes
    /// no window of an app that never activates key, so the app keeps
    /// which one would be, the one the test agent's keys go to.
    static BACKGROUND_KEY: RefCell<Option<objc2::rc::Weak<NSWindow>>> = const { RefCell::new(None) };
}

/// Whether the app runs in the background: it never activates, and AppKit
/// gives none of its windows the keyboard.
fn in_background(mtm: MainThreadMarker) -> bool {
    NSApplication::sharedApplication(mtm).activationPolicy()
        == objc2_app_kit::NSApplicationActivationPolicy::Prohibited
}

fn background_key() -> Option<Retained<NSWindow>> {
    BACKGROUND_KEY.with(|k| k.borrow().as_ref().and_then(|w| w.load()))
}

/// The app's window that has the keyboard: AppKit's key window, or the one
/// that would be in a background app.
fn app_key_window(mtm: MainThreadMarker) -> Option<Retained<NSWindow>> {
    NSApplication::sharedApplication(mtm)
        .keyWindow()
        .or_else(|| in_background(mtm).then(background_key).flatten())
}

/// Whether `window` has the keyboard (`WindowState.focused`): it is the
/// key window, or the one that would be in a background app.
pub(crate) fn is_key(window: &NSWindow) -> bool {
    window.isKeyWindow()
        || (in_background(MainThreadMarker::from(window))
            && background_key().is_some_and(|k| &*k == window))
}

/// `window` was made key (shown, focused, pressed). In a background app
/// AppKit leaves it as it was: it becomes the window that would be key,
/// and both it and the one that was report their state, as AppKit's key
/// changes do; the one that was hears that it lost the keyboard.
pub(crate) fn became_key(surface: &Surface, window: &NSWindow) {
    if !in_background(surface.mtm) || !window.canBecomeKeyWindow() {
        return;
    }
    let old = background_key();
    if old.as_deref() == Some(window) {
        return;
    }
    BACKGROUND_KEY.with(|k| *k.borrow_mut() = Some(objc2::rc::Weak::from(window)));
    if let Some(old) = old
        && let Some(id) = id_of(surface, &old)
    {
        report(surface, id);
        if id != ROOT_ID {
            resigned_key(surface, id);
        }
    }
    if let Some(id) = id_of(surface, window) {
        report(surface, id);
    }
}

/// `window` hid, minimized or closed: in a background app, when it was the
/// window that would be key, the main window becomes it, as AppKit gives
/// the keyboard to the next window.
fn lost_key(surface: &Surface, window: &NSWindow) {
    if !in_background(surface.mtm) || background_key().as_deref() != Some(window) {
        return;
    }
    BACKGROUND_KEY.with(|k| k.borrow_mut().take());
    match surface.root.ns().window() {
        Some(main) if main.isVisible() && !main.isMiniaturized() => became_key(surface, &main),
        _ => {}
    }
}

// --- Closing ------------------------------------------------------------------------------

/// How the user asked to close a window, from the event being handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Asked {
    /// A key (Cmd+W, as the Close item's key equivalent).
    Key,
    /// A press in the window (its close button, a `windowControl`).
    MouseInWindow,
    /// A press elsewhere (a menu's item).
    MouseElsewhere,
    /// Nothing the user did right now (the system).
    Other,
}

fn close_reason(asked: Asked) -> CloseReason {
    match asked {
        Asked::Key => CloseReason::Shortcut,
        Asked::MouseInWindow => CloseReason::CloseButton,
        Asked::MouseElsewhere => CloseReason::Menu,
        Asked::Other => CloseReason::System,
    }
}

#[cfg(feature = "dev")]
thread_local! {
    /// The test agent is clicking a close button ([`press_close_button`]),
    /// with no event of the user's to tell it by.
    static CLOSE_BUTTON_PRESS: Cell<bool> = const { Cell::new(false) };
}

/// How the event being handled asked to close `window`.
fn asked(mtm: MainThreadMarker, window: &NSWindow) -> Asked {
    #[cfg(feature = "dev")]
    if CLOSE_BUTTON_PRESS.get() {
        return Asked::MouseInWindow;
    }
    let Some(event) = NSApplication::sharedApplication(mtm).currentEvent() else {
        return Asked::Other;
    };
    match event.r#type() {
        NSEventType::KeyDown => Asked::Key,
        NSEventType::LeftMouseDown | NSEventType::LeftMouseUp => {
            if event.window(mtm).as_deref() == Some(window) {
                Asked::MouseInWindow
            } else {
                Asked::MouseElsewhere
            }
        }
        _ => Asked::Other,
    }
}

/// The user asked to close window `id` (its close button, Cmd+W, the
/// menu): with `closeOnPress` it closes at once, and the app hears of the
/// press either way. Whether AppKit may close it now.
fn close_press(surface: &Rc<Surface>, id: NodeId, window: &NSWindow) -> bool {
    if blocked_window(surface, id) {
        bring_modal(surface, id);
        return false;
    }
    let reason = close_reason(asked(surface.mtm, window));
    if id == ROOT_ID {
        return main_close_press(surface, reason);
    }
    let close = with_held(surface, id, |h| h.close_on_press.get()).unwrap_or(true);
    send(surface, id, WindowEvent::ClosePress { reason });
    if close {
        dismiss(surface, id, WindowCloseCause::ClosePress);
    }
    false
}

/// The main window's close press: the app hears of it; with
/// `closeOnPress` the window closes once the app's turn is over (at most
/// [`CLOSE_GRACE_MS`] later), so its handler sees the window. Whether
/// AppKit may close it now (never: it closes later or not).
fn main_close_press(surface: &Surface, reason: CloseReason) -> bool {
    let held = &surface.main_window;
    if held.pending_close.get().is_some() {
        return false;
    }
    let serial = held.serial.get() + 1;
    held.serial.set(serial);
    let close = held.close_on_press.get();
    held.pending_close.set(Some((serial, close)));
    // Handlers read the actual last frame, a move still settling included.
    crate::window_state::changed(surface);
    let key = surface.key();
    let sent = Cell::new(false);
    surface.control(|control| {
        sent.set(true);
        control.dispatch_event(
            ROOT_ID,
            EventKind::Window,
            EventPayload::Window(Box::new(WindowEvent::ClosePress { reason })),
        );
        control.flush(move |_| {
            DispatchQueue::main().exec_async(move || complete_close(key, serial));
        });
    });
    if !sent.get() {
        // Out of windowShouldClose: before the close's own callbacks run.
        DispatchQueue::main().exec_async(move || complete_close(key, serial));
    } else if close {
        crate::surface::after(CLOSE_GRACE_MS, move || complete_close(key, serial));
    }
    false
}

/// The main window's close press `serial` is answered: it closes when its
/// policy said so.
fn complete_close(key: u64, serial: u64) {
    let Some(surface) = Surface::with_key(key) else {
        return;
    };
    let held = &surface.main_window;
    let Some((pending, close)) = held.pending_close.get() else {
        return;
    };
    if pending != serial {
        return;
    }
    held.pending_close.set(None);
    if close {
        crate::app::close_main_window(key);
    }
}

/// The standalone app's main window is asked to close (`windowShouldClose:`).
/// Whether AppKit may close it now.
pub(crate) fn main_should_close(surface: &Rc<Surface>, window: &NSWindow) -> bool {
    close_press(surface, ROOT_ID, window)
}

/// Window `id` of the app's own closes without the app closing it (a
/// close press, Escape, losing the focus, its parent closing): it hides,
/// the windows it owns close with it, and the app is told, which removes
/// the root (the window goes then, [`removed`]).
fn dismiss(surface: &Surface, id: NodeId, cause: WindowCloseCause) {
    let Some(window) = window_of(surface, id) else {
        return;
    };
    if let Some(w) = surface.windows.borrow().get(&id) {
        w.showing.set(Showing::Done);
    }
    window.orderOut(None);
    lost_key(surface, &window);
    for child in children(surface, id) {
        dismiss(surface, child, WindowCloseCause::ParentClose);
    }
    send(surface, id, WindowEvent::Closed { cause });
    state_changed(surface, id);
}

/// The windows of the app's own that window `id` owns.
fn children(surface: &Surface, id: NodeId) -> Vec<NodeId> {
    surface
        .windows
        .try_borrow()
        .map(|w| {
            w.iter()
                .filter(|(_, w)| w.parent == Some(id))
                .map(|(child, _)| *child)
                .collect()
        })
        .unwrap_or_default()
}

/// Escape reached window `id` with nothing in it taking it: with
/// `closeOnEscape` it closes. Whether it did.
pub(crate) fn escape(surface: &Rc<Surface>) -> bool {
    let id = event_window(surface);
    if !with_held(surface, id, |h| h.close_on_escape.get()).unwrap_or(false) {
        return false;
    }
    if id == ROOT_ID {
        crate::app::close_main_window(surface.key())
    } else {
        dismiss(surface, id, WindowCloseCause::Escape);
        true
    }
}

/// Window `id` stopped being the key window: with `closeOnBlur` it
/// closes, unless the focus went to a window it owns.
fn resigned_key(surface: &Surface, id: NodeId) {
    if !with_held(surface, id, |h| h.close_on_blur.get()).unwrap_or(false) {
        return;
    }
    let Some(window) = window_of(surface, id) else {
        return;
    };
    if !window.isVisible() {
        return;
    }
    let key = app_key_window(surface.mtm);
    let to_child = key
        .as_deref()
        .and_then(|k| id_of(surface, k))
        .is_some_and(|k| {
            surface
                .windows
                .borrow()
                .get(&k)
                .is_some_and(|w| w.parent == Some(id))
        });
    if !to_child {
        dismiss(surface, id, WindowCloseCause::Blur);
    }
}

/// Dialog root `view` was removed: its window goes, and the windows it
/// owns close. Whether it had one.
pub(crate) fn removed(surface: &Surface, view: &NshView) -> bool {
    let id = view.id();
    let Some(w) = surface.windows.borrow_mut().remove(&id) else {
        return false;
    };
    for child in children(surface, id) {
        dismiss(surface, child, WindowCloseCause::ParentClose);
    }
    dock::set(surface.key(), id, None);
    let window = w.window.clone();
    close(w);
    lost_key(surface, &window);
    true
}

/// The surface stops (its main window closed, or its app ended): its
/// windows go with it.
pub(crate) fn close_all(surface: &Surface) {
    let windows: Vec<(NodeId, AppWindow)> = surface.windows.borrow_mut().drain().collect();
    for (id, w) in windows {
        dock::set(surface.key(), id, None);
        close(w);
    }
    dock::set(surface.key(), ROOT_ID, None);
    surface.main_window.reset();
}

fn close(w: AppWindow) {
    w.watch.stop();
    w.view.set_window_of(std::rc::Weak::new());
    w.view.ns().unregisterDraggedTypes();
    if let Some(parent) = w.window.parentWindow() {
        parent.removeChildWindow(&w.window);
    }
    w.window.setDelegate(None);
    w.window.orderOut(None);
    w.view.ns().removeFromSuperview();
    w.window.setContentView(None);
    w.window.close();
    drop(w.container);
}

// --- Modal dialogs ------------------------------------------------------------------------

/// Whether window `id` is under a modal dialog of the app's own that
/// shows.
fn blocked_window(surface: &Surface, id: NodeId) -> bool {
    surface.windows.try_borrow().is_ok_and(|windows| {
        windows
            .values()
            .any(|w| w.modal && w.parent == Some(id) && w.window.isVisible())
    })
}

/// Whether the window of root `root` (`None`: the surface's own) is under
/// a modal dialog, without the beep [`blocked`] gives a press (a query, as
/// AppKit's `hitTest:`).
pub(crate) fn is_blocked(surface: &Surface, root: Option<&NshView>) -> bool {
    blocked_window(surface, root.map_or(ROOT_ID, |r| r.id()))
}

/// Whether an event of the root `root` (`None`: the surface's own) is held
/// back: its window is under a modal dialog. A press there beeps and
/// brings the dialog forward, as AppKit does for its modal windows.
pub(crate) fn blocked(surface: &Surface, root: Option<&NshView>) -> bool {
    let id = root.map_or(ROOT_ID, |r| r.id());
    if !blocked_window(surface, id) {
        return false;
    }
    let pressed = NSApplication::sharedApplication(surface.mtm)
        .currentEvent()
        .is_some_and(|e| {
            matches!(
                e.r#type(),
                NSEventType::LeftMouseDown | NSEventType::RightMouseDown
            )
        });
    if pressed {
        bring_modal(surface, id);
    }
    true
}

/// Beeps and brings the modal dialog over window `id` forward.
fn bring_modal(surface: &Surface, id: NodeId) {
    let dialog = surface.windows.try_borrow().ok().and_then(|windows| {
        windows
            .values()
            .find(|w| w.modal && w.parent == Some(id) && w.window.isVisible())
            .map(|w| w.window.clone())
    });
    if let Some(dialog) = dialog {
        objc2_app_kit::NSBeep();
        dialog.makeKeyAndOrderFront(None);
        became_key(surface, &dialog);
    }
}

// --- The app's look -----------------------------------------------------------------------

/// The root views of the surface's windows of the app's own.
pub(crate) fn roots(surface: &Surface) -> Vec<NshView> {
    surface
        .windows
        .try_borrow()
        .map(|windows| windows.values().map(|w| w.view.clone()).collect())
        .unwrap_or_default()
}

/// The root `window` shows, if it is one of the surface's windows.
pub(crate) fn root_in(surface: &Surface, window: &NSWindow) -> Option<NshView> {
    if surface.root.ns().window().as_deref() == Some(window) {
        return Some(surface.root.clone());
    }
    let windows = surface.windows.try_borrow().ok()?;
    windows
        .values()
        .find(|w| &*w.window == window)
        .map(|w| w.view.clone())
}

/// The root of the window `view` is in: the surface's, or that of a
/// window of the app's own; `None` for another surface's view (or one in
/// no window's tree).
pub(crate) fn root_containing(surface: &Surface, view: &NshView) -> Option<NshView> {
    if view.ns().isDescendantOf(surface.root.ns()) {
        return Some(surface.root.clone());
    }
    let windows = surface.windows.try_borrow().ok()?;
    windows
        .values()
        .find(|w| view.ns().isDescendantOf(w.view.ns()))
        .map(|w| w.view.clone())
}

/// The app's appearance changed (`setColorScheme`): its windows follow, as
/// the main window's root does.
pub(crate) fn set_appearance(surface: &Surface, appearance: Option<&objc2_app_kit::NSAppearance>) {
    let Ok(windows) = surface.windows.try_borrow() else {
        return;
    };
    for w in windows.values() {
        w.window.setAppearance(appearance);
        w.view.ns().setAppearance(appearance);
    }
}

/// The surface's background behind the app (the color scheme's, or the
/// app's own that fills the main window): its windows show it behind their
/// root, as the main window does behind its root, but for those that show
/// through.
pub(crate) fn set_background(surface: &Surface, color: nsh_core::Color) {
    let ns = ns_color(color);
    let Ok(windows) = surface.windows.try_borrow() else {
        return;
    };
    for w in windows.values().filter(|w| !w.held.transparent.get()) {
        w.window.setBackgroundColor(Some(&ns));
        if let Some(layer) = w.container.layer() {
            crate::surface::quiet(|| layer.setBackgroundColor(Some(&crate::text::cg_color(color))));
        }
    }
}

fn ns_color(color: nsh_core::Color) -> Retained<NSColor> {
    let c = color.0;
    let f = |shift: u32| f64::from((c >> shift) & 0xff) / 255.0;
    NSColor::colorWithSRGBRed_green_blue_alpha(f(24), f(16), f(8), f(0))
}

fn ns_size(size: Size<Points>) -> NSSize {
    NSSize::new(
        f64::from(size.width.0.max(1.0)),
        f64::from(size.height.0.max(1.0)),
    )
}

// --- View props ---------------------------------------------------------------------------

/// A `windowControl` view was pressed and released over it: it acts as
/// the system's button of its window.
pub(crate) fn control(surface: &Rc<Surface>, control: WindowControl, event: &NSEvent) {
    let option = event
        .modifierFlags()
        .contains(objc2_app_kit::NSEventModifierFlags::Option);
    if let Some(window) = window_of(surface, event_window(surface)) {
        control_window(surface, &window, control, option);
    }
}

/// `control` of `window` (`option`: with Option held), as the system's
/// button does it.
pub(crate) fn control_window(
    surface: &Rc<Surface>,
    window: &NSWindow,
    control: WindowControl,
    option: bool,
) {
    let Some(id) = id_of(surface, window) else {
        return;
    };
    match control {
        WindowControl::Minimize => window.miniaturize(None),
        WindowControl::Maximize => {
            // The green button: full screen, zoom with Option (or where
            // full screen is not allowed).
            let full_screen = !window
                .collectionBehavior()
                .contains(NSWindowCollectionBehavior::FullScreenNone);
            if option || !full_screen {
                window.zoom(None);
            } else {
                window.toggleFullScreen(None);
            }
        }
        WindowControl::Close => {
            if close_press(surface, id, window) {
                window.close();
            }
        }
    }
}

// --- Delegate -----------------------------------------------------------------------------

define_class!(
    /// The delegate of a window of the app's own: the user's close press,
    /// losing the focus.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = (u64, NodeId)]
    #[name = "NshOwnWindowDelegate"]
    struct WindowDelegate;

    unsafe impl NSObjectProtocol for WindowDelegate {}

    unsafe impl NSWindowDelegate for WindowDelegate {
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, window: &NSWindow) -> Bool {
            let (key, id) = *self.ivars();
            let Some(surface) = Surface::with_key(key) else {
                return Bool::YES;
            };
            if !is_window(&surface, id) {
                return Bool::YES;
            }
            Bool::new(close_press(&surface, id, window))
        }

        #[unsafe(method(windowDidResignKey:))]
        fn window_did_resign_key(&self, _notification: &objc2_foundation::NSNotification) {
            let (key, id) = *self.ivars();
            // After AppKit picked the next key window.
            DispatchQueue::main().exec_async(move || {
                if let Some(surface) = Surface::with_key(key) {
                    resigned_key(&surface, id);
                }
            });
        }
    }
);

// --- The Dock tile's progress -------------------------------------------------------------

/// The Dock tile shows the progress of the window that set one last: the
/// Dock has one tile per app, not one per window.
pub(crate) mod dock {
    use super::*;

    thread_local! {
        static DOCK: RefCell<Dock> = RefCell::new(Dock::default());
    }

    #[derive(Default)]
    struct Dock {
        /// The windows' progress (surface key, root node), the last set
        /// last.
        entries: Vec<(u64, NodeId, WindowProgress)>,
        indicator: Option<Retained<NSProgressIndicator>>,
    }

    /// Window `id` of surface `key` shows `progress` (`None`: none).
    pub(crate) fn set(key: u64, id: NodeId, progress: Option<WindowProgress>) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        DOCK.with(|dock| {
            let mut dock = dock.borrow_mut();
            let had = !dock.entries.is_empty();
            dock.entries.retain(|(k, i, _)| !(*k == key && *i == id));
            if let Some(progress) = progress {
                dock.entries.push((key, id, progress));
            }
            if !had && dock.entries.is_empty() {
                return;
            }
            let shown = dock.entries.last().map(|(_, _, p)| *p);
            show(mtm, &mut dock, shown);
        });
    }

    fn show(mtm: MainThreadMarker, dock: &mut Dock, progress: Option<WindowProgress>) {
        let tile = NSApplication::sharedApplication(mtm).dockTile();
        let Some(progress) = progress else {
            dock.indicator = None;
            tile.setContentView(None);
            tile.display();
            return;
        };
        let indicator = dock.indicator.get_or_insert_with(|| {
            let size = tile.size();
            let view = TileView::view(mtm, NSRect::new(NSPoint::new(0.0, 0.0), size));
            let bar = NSProgressIndicator::initWithFrame(
                NSProgressIndicator::alloc(mtm),
                NSRect::new(
                    NSPoint::new(size.width * 0.1, size.height * 0.06),
                    NSSize::new(size.width * 0.8, size.height * 0.14),
                ),
            );
            bar.setStyle(NSProgressIndicatorStyle::Bar);
            bar.setMinValue(0.0);
            bar.setMaxValue(1.0);
            view.addSubview(&bar);
            tile.setContentView(Some(&view));
            bar
        });
        let indeterminate =
            progress.state == ProgressState::Indeterminate || progress.value.is_none();
        indicator.setIndeterminate(indeterminate);
        if let Some(value) = progress.value {
            indicator.setDoubleValue(f64::from(value.0));
        }
        tile.display();
    }

    define_class!(
        /// The Dock tile's view: the app's icon, under the progress bar.
        #[unsafe(super(NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "NshDockTileView"]
        struct TileView;

        unsafe impl NSObjectProtocol for TileView {}

        impl TileView {
            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                if let Some(icon) = NSApplication::sharedApplication(self.mtm()).applicationIconImage() {
                    icon.drawInRect(self.bounds());
                }
            }
        }
    );

    impl TileView {
        fn view(mtm: MainThreadMarker, frame: NSRect) -> Retained<NSView> {
            let this = TileView::alloc(mtm).set_ivars(());
            // SAFETY: NSView's designated initializer.
            let view: Retained<TileView> = unsafe { msg_send![super(this), initWithFrame: frame] };
            Retained::into_super(view)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(kind: WindowKind) -> StyleInputs {
        StyleInputs {
            kind,
            frame: WindowFrameStyle::Default,
            title_bar_hidden: false,
            resizable: true,
            minimizable: true,
            closable: true,
            activate: true,
        }
    }

    #[test]
    fn style_masks_follow_the_frame_and_the_buttons() {
        let normal = style_mask(&inputs(WindowKind::Normal));
        assert_eq!(
            normal,
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable
                | NSWindowStyleMask::Resizable
        );
        let dialog = style_mask(&StyleInputs {
            minimizable: false,
            resizable: false,
            title_bar_hidden: true,
            ..inputs(WindowKind::Dialog)
        });
        assert_eq!(
            dialog,
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::FullSizeContentView
        );
        // A panel's title bar is the small one; one that does not activate
        // the app is non-activating.
        let panel = style_mask(&StyleInputs {
            activate: false,
            ..inputs(WindowKind::Panel)
        });
        assert!(panel.contains(NSWindowStyleMask::UtilityWindow));
        assert!(panel.contains(NSWindowStyleMask::NonactivatingPanel));
        // Frameless: no title bar, its buttons with it.
        let popup = style_mask(&StyleInputs {
            frame: WindowFrameStyle::None,
            resizable: false,
            activate: false,
            ..inputs(WindowKind::Popup)
        });
        assert_eq!(popup, NSWindowStyleMask::NonactivatingPanel);
        // Only panels are non-activating.
        let normal = style_mask(&StyleInputs {
            activate: false,
            ..inputs(WindowKind::Normal)
        });
        assert!(!normal.contains(NSWindowStyleMask::NonactivatingPanel));
    }

    #[test]
    fn collection_behaviors_follow_the_level_and_the_workspaces() {
        let normal = collection_behavior(WindowLevel::Normal, Workspaces::Current, true, true);
        assert_eq!(normal, NSWindowCollectionBehavior::FullScreenPrimary);
        let popup = collection_behavior(WindowLevel::Floating, Workspaces::All, false, false);
        assert!(popup.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(popup.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(popup.contains(NSWindowCollectionBehavior::IgnoresCycle));
        assert!(!popup.contains(NSWindowCollectionBehavior::FullScreenPrimary));
        let panel = collection_behavior(WindowLevel::Floating, Workspaces::Current, false, false);
        assert!(panel.contains(NSWindowCollectionBehavior::MoveToActiveSpace));
        assert!(panel.contains(NSWindowCollectionBehavior::FullScreenNone));
        let widget = collection_behavior(WindowLevel::DesktopIcon, Workspaces::Current, true, true);
        assert!(widget.contains(NSWindowCollectionBehavior::Stationary));
    }

    #[test]
    fn levels_rise_from_normal_to_above_the_dock() {
        assert!(ns_level(WindowLevel::Floating) > ns_level(WindowLevel::Normal));
        // The Dock is level 20, the menu bar 24.
        assert!(ns_level(WindowLevel::AboveDock) > 24);
        assert!(ns_level(WindowLevel::DesktopIcon) < ns_level(WindowLevel::Normal));
    }

    #[test]
    fn close_reasons_follow_what_the_user_did() {
        assert_eq!(close_reason(Asked::Key), CloseReason::Shortcut);
        assert_eq!(close_reason(Asked::MouseInWindow), CloseReason::CloseButton);
        assert_eq!(close_reason(Asked::MouseElsewhere), CloseReason::Menu);
        assert_eq!(close_reason(Asked::Other), CloseReason::System);
    }

    #[test]
    fn backdrops_map_to_materials_and_back() {
        for backdrop in [
            Backdrop::Window,
            Backdrop::Sidebar,
            Backdrop::Popover,
            Backdrop::Hud,
        ] {
            assert_eq!(backdrop_of(material(backdrop).unwrap()), backdrop);
        }
        assert_eq!(material(Backdrop::None), None);
    }
}
