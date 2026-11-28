//! The app's own windows besides its main one (`<Window>`, `window()`,
//! `Window.open`): each shows a dialog root (a `modal` node, anywhere in
//! the tree) of the same engine in a top-level window of its own instead of
//! over the main window. The engine, the JS runtime and the core stay one,
//! so the windows share the app's state.
//!
//! - **Opening** ([`open`]): the root view leaves the main window's tree and
//!   is the root of a tree of its own, whose changes ask its window to draw
//!   ([`NshView::set_invalidate`]), and which [`crate::render::window_frame`]
//!   draws whole into the window's own swap chain (composed, see-through,
//!   for a transparent window or one with a system backdrop). The window's
//!   kind picks its native class of window ([`crate::shell::styles`]): an
//!   owned window for dialogs, a tool window for panels, popups and
//!   overlays; a modal dialog disables its owner while it shows. It opens
//!   hidden, at its size and place (or the placement the core kept), and
//!   shows once its first frame is drawn.
//! - Its size is reported to the core as the root's
//!   (`EngineControl::set_root_size`), which lays the root out at it.
//! - Its input is the surface's: while one of its messages is handled, the
//!   surface's input picks views in its root ([`enter`],
//!   [`Surface::input_root`]).
//! - **Native content**: web views and the windows of native components
//!   inside it belong to it: a web view is composed in the window's own
//!   composition ([`compose`], made with its first web view) and parented
//!   to it, a component's window is its child, each placed where its frame
//!   drew the view. Each window exposes its own accessibility tree.
//! - **Closing**: the user's close is reported (`ClosePress`) and, with
//!   `closeOnPress`, carried out at once: the window hides and reports
//!   `Closed`, and the app removes the root, which destroys it
//!   ([`removed`]). Escape, losing the focus and the parent closing hide it
//!   the same way when its policies say so. Windows it owns are let go of
//!   first, so they stay until the app removes them too.
//! - **State**: its mode, bounds, focus and display are reported as
//!   `WindowEvent::State` on its root; a move or a resize once it settles.
//!   The area of its hidden title bar goes before it
//!   (`WindowEvent::TitleBar`): reported as soon as the window is made, so
//!   the app's first frame reserves it, and again whenever it changes.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use nsh_core::{
    Bounds, Color, EdgeInsets, EventKind, EventPayload, NodeId, Points, ROOT_ID, Size,
    desktop::{
        Backdrop, CloseReason, DesktopCommand, OpenWindow, WindowCloseCause, WindowEvent,
        WindowKind, WindowPosition, WindowRequest, WindowState,
    },
    geometry::Edges,
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Gdi::{BeginPaint, EndPaint, PAINTSTRUCT},
    UI::{
        Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled},
        WindowsAndMessaging::*,
    },
};

use crate::{
    compose::Composition,
    input::KeyEvent,
    surface::Surface,
    view::{Hosted, NshView},
};

/// The timer that shows a window whose first frame did not come in time.
const SHOW_TIMER: usize = 1;
/// How long a window waits for its first frame at most.
const SHOW_WAIT_MS: u32 = 500;
/// The timer that reports a moved or resized window once it settles.
const STATE_TIMER: usize = 2;
/// How long a window must stay put before its new bounds are reported.
const STATE_WAIT_MS: u32 = 150;

/// A window of the app's own.
pub(crate) struct AppWindow {
    /// The dialog root it shows.
    id: NodeId,
    hwnd: HWND,
    view: NshView,
    /// Its owner, which it stays above (and disables while it is modal).
    owner: Option<HWND>,
    modal: bool,
    /// What shows it, see-through where the app draws nothing (transparent
    /// windows, system backdrops, click-through windows).
    composition: Option<Rc<Composition>>,
    /// The composition of its web views and composed components while it
    /// has some (each holds it): the see-through one, else one over its
    /// swap chain.
    web: RefCell<Weak<Composition>>,
    /// The hosted items and the composed items (web views) its last frame
    /// drew.
    placed: RefCell<Vec<(Rc<dyn Hosted>, RECT)>>,
    composed: RefCell<Vec<Rc<dyn Hosted>>>,
    swap: RefCell<Option<crate::gfx::SwapChain>>,
    /// The scale of the swap chain's target.
    target_scale: Cell<f32>,
    /// Its client area in pixels, and its scale.
    pixels: Cell<(u32, u32)>,
    scale: Cell<f32>,
    /// The proposed client size whose frame was presented during `WM_SIZING`.
    prepared_size: Cell<Option<(u32, u32)>>,
    /// A `WM_PAINT` is asked for.
    invalid: Cell<bool>,
    repaint_after_frame: Cell<bool>,
    /// What changed since its last frame: the next frame draws only that.
    damage: crate::surface::Damage,
    /// It was sized and placed as the app opened it ([`place`]): until
    /// then its size is the system's default, which is reported to nobody.
    positioned: Cell<bool>,
    /// The size last reported to the core.
    reported: Cell<Option<Size<Points>>>,
    /// It was shown once (its first frame drawn).
    opened: Cell<bool>,
    /// `focus()` came while it waited for its first frame.
    focus_on_show: Cell<bool>,
    /// The app hid it before its first show (`WindowRef.hide()` while its
    /// root rendered): the first show does not show it.
    hidden: Cell<bool>,
    /// A policy hid it, reported as `Closed`: it waits for the app to
    /// remove its root.
    closed: Cell<bool>,
    /// The state last reported.
    state: Cell<Option<WindowState>>,
}

/// The window showing dialog root `id`.
fn get(surface: &Surface, id: NodeId) -> Option<Rc<AppWindow>> {
    surface
        .windows
        .borrow()
        .iter()
        .find(|w| w.id == id)
        .cloned()
}

/// Whether dialog root `id` is shown in a window of its own.
pub(crate) fn is_window(surface: &Surface, id: NodeId) -> bool {
    surface.windows.borrow().iter().any(|w| w.id == id)
}

/// The dialog roots shown in windows of their own.
pub(crate) fn ids(surface: &Surface) -> Vec<NodeId> {
    surface.windows.borrow().iter().map(|w| w.id).collect()
}

/// The native window showing dialog root `id`.
pub(crate) fn hwnd_of(surface: &Surface, id: NodeId) -> Option<HWND> {
    get(surface, id).map(|w| w.hwnd)
}

/// Every native window the app currently has open on `surface`.
pub(crate) fn hwnds(surface: &Surface) -> Vec<HWND> {
    surface.windows.borrow().iter().map(|w| w.hwnd).collect()
}

/// The app window with the keyboard focus (the host is not one): what test
/// steps act on, and what owns a module's system UI
/// ([`crate::presenting_window`]).
pub(crate) fn focused_hwnd(surface: &Surface) -> Option<HWND> {
    surface
        .windows
        .borrow()
        .iter()
        .find(|w| w.state.get().is_some_and(|state| state.focused))
        .map(|w| w.hwnd)
}

/// The window a dialog the app raised without naming a window
/// (`AlertDialog.show`) shows over: the app window with the keyboard
/// focus, else the oldest one; `ROOT_ID` when the app has none (a dialog
/// of the host itself).
pub(crate) fn dialog_window(surface: &Surface) -> NodeId {
    let windows = surface.windows.borrow();
    windows
        .iter()
        .find(|w| w.state.get().is_some_and(|state| state.focused))
        .or_else(|| windows.first())
        .map_or(ROOT_ID, |w| w.id)
}

/// Candidate window state used to pick which window a notification press
/// activates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ActivationCandidate {
    hwnd: HWND,
    visible: bool,
    enabled: bool,
    focusable: bool,
    minimized: bool,
}

fn select_activation_target(
    candidates: impl IntoIterator<Item = ActivationCandidate>,
    foreground: HWND,
) -> Option<HWND> {
    candidates
        .into_iter()
        .filter(|c| c.visible && c.enabled && c.focusable)
        .min_by_key(|c| (c.hwnd != foreground, c.minimized))
        .map(|c| c.hwnd)
}

/// The focused window, else the oldest shown and focusable window (preferring
/// unminimized windows before minimized ones), with the embedding host as a
/// fallback.
pub(crate) fn activation_target(surface: &Surface, host: HWND) -> Option<HWND> {
    let foreground = crate::window::foreground();
    let windows = surface.windows.borrow();
    let candidates = windows.iter().map(|w| w.hwnd).chain([host]).map(|hwnd| {
        // SAFETY: plain queries; a missing window is not visible.
        let (visible, enabled, minimized) = unsafe {
            (
                IsWindowVisible(hwnd).as_bool(),
                IsWindowEnabled(hwnd).as_bool(),
                IsIconic(hwnd).as_bool(),
            )
        };
        ActivationCandidate {
            hwnd,
            visible,
            enabled,
            focusable: crate::window::shell(hwnd).is_none_or(|s| s.attrs().focusable),
            minimized,
        }
    });
    select_activation_target(candidates, foreground)
}

/// The root view of the window showing dialog root `id`: what its
/// overlays and the dialogs presented in it are inserted into.
pub(crate) fn root_view(surface: &Surface, id: NodeId) -> Option<NshView> {
    get(surface, id).map(|w| w.view.clone())
}

/// The window `view` shows in: the dialog root of the window of the app's
/// own its tree is in, else `ROOT_ID` (the main window's tree, or none).
pub(crate) fn window_of(surface: &Surface, view: &NshView) -> NodeId {
    let mut top = view.clone();
    while let Some(p) = top.parent_view() {
        top = p;
    }
    if top != surface.root && is_window(surface, top.id()) {
        top.id()
    } else {
        ROOT_ID
    }
}

/// The native window `view` shows in (the main window's when it is in
/// none of the app's own).
pub(crate) fn hwnd_showing(surface: &Surface, view: &NshView) -> HWND {
    match window_of(surface, view) {
        ROOT_ID => surface.hwnd(),
        id => hwnd_of(surface, id).unwrap_or_else(|| surface.hwnd()),
    }
}

/// The composition the web views and composed components of the window
/// showing dialog root `id` are in, and its native window: made with the
/// first of them.
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
pub(crate) fn compose(
    surface: &Surface,
    id: NodeId,
) -> windows::core::Result<(HWND, Rc<Composition>)> {
    let Some(window) = get(surface, id) else {
        return Err(windows::core::Error::from_hresult(
            windows::Win32::Foundation::E_HANDLE,
        ));
    };
    if let Some(c) = window.composition.clone() {
        *window.web.borrow_mut() = Rc::downgrade(&c);
        return Ok((window.hwnd, c));
    }
    if let Some(c) = window.web.borrow().upgrade() {
        return Ok((window.hwnd, c));
    }
    let c = Composition::new(window.hwnd)?;
    *window.web.borrow_mut() = Rc::downgrade(&c);
    invalidate(&window);
    Ok((window.hwnd, c))
}

/// The native window of window `id` (`ROOT_ID`: the main one).
fn window_hwnd(surface: &Surface, id: NodeId) -> Option<HWND> {
    if id == ROOT_ID {
        let hwnd = surface.hwnd();
        return crate::window_state::top_level(hwnd).then_some(hwnd);
    }
    hwnd_of(surface, id)
}

fn report(surface: &Surface, id: NodeId, event: WindowEvent) {
    surface.event(id, EventKind::Window, EventPayload::Window(Box::new(event)));
}

/// A desktop command addressed to dialog root `id`.
pub(crate) fn command(
    surface: &Rc<Surface>,
    id: NodeId,
    view: Option<&NshView>,
    command: &DesktopCommand,
) {
    if let DesktopCommand::OpenWindow(open_window) = command {
        let Some(view) = view else {
            return log::warn!("window: no view {id}");
        };
        return open(surface, view, open_window);
    }
    let Some(window) = get(surface, id) else {
        return log::debug!("window: no window for {id}");
    };
    let hwnd = window.hwnd;
    match command {
        DesktopCommand::SetAttributes(diff) => crate::shell::apply(surface, hwnd, diff),
        DesktopCommand::Request(request) => match request {
            // The app closes its windows by removing their roots; a close
            // asked for anyway is carried out as the user's.
            WindowRequest::Close => closed(surface, id, WindowCloseCause::ClosePress),
            WindowRequest::Hide => {
                // Asked before its first show: it opens hidden.
                window.hidden.set(true);
                release_owner(&window);
                // SAFETY: a plain call on the window, alive while listed.
                let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
            }
            // It shows with its first frame, and takes the keyboard then.
            WindowRequest::Focus if !window.opened.get() => {
                window.closed.set(false);
                hold_owner(&window);
                window.focus_on_show.set(true);
            }
            WindowRequest::Show | WindowRequest::Focus => {
                window.closed.set(false);
                window.hidden.set(false);
                hold_owner(&window);
                crate::shell::request(hwnd, request);
            }
            request => {
                crate::shell::request(hwnd, request);
            }
        },
        // A context menu belongs to this window: it is owned by its HWND,
        // and points are converted with its client origin.
        DesktopCommand::PopupMenu { items, at } => crate::chrome::popup(
            surface,
            hwnd,
            surface
                .chrome
                .app_popup(items.clone(), at.map(|p| (p.x.0, p.y.0))),
        ),
        // The application menu, the tray and shortcuts are the host's.
        _ => {}
    }
}

/// Shows dialog root `view` in a new window.
fn open(surface: &Rc<Surface>, view: &NshView, open: &OpenWindow) {
    let id = view.id();
    if is_window(surface, id) {
        return;
    }
    let options = &open.options;
    // Presented over the main window by its insertion, earlier in the
    // batch: it leaves the main window's modals and tree.
    crate::navigation::release(surface, view);
    let mut attributes = options.attributes.clone();
    if attributes.title.is_none() {
        attributes.title = Some(main_title(surface));
    }
    let resolved = {
        let mut attrs = crate::shell::Attrs::of_kind(options.kind);
        attrs.merge(&attributes);
        attrs
    };
    let owner = open.parent.and_then(|parent| window_hwnd(surface, parent));
    let composed = resolved.transparent
        || resolved.backdrop != Backdrop::None
        || resolved.click_through
        || resolved.box_none;
    let hwnd = match crate::window::create_app_window(
        surface,
        id,
        options.kind,
        &attributes,
        owner,
        composed,
    ) {
        Ok(hwnd) => hwnd,
        Err(err) => return log::error!("window: cannot create a window: {err}"),
    };
    let composition = if composed {
        match crate::compose::Composition::new(hwnd) {
            Ok(c) => Some(c),
            Err(err) => {
                log::warn!("window: no composition, the window is opaque: {err}");
                None
            }
        }
    } else {
        None
    };
    let window = Rc::new(AppWindow {
        id,
        hwnd,
        view: view.clone(),
        owner,
        modal: options.modal && owner.is_some(),
        composition,
        web: RefCell::default(),
        placed: RefCell::default(),
        composed: RefCell::default(),
        swap: RefCell::new(None),
        target_scale: Cell::new(0.0),
        pixels: Cell::new((0, 0)),
        scale: Cell::new(1.0),
        prepared_size: Cell::new(None),
        invalid: Cell::new(false),
        repaint_after_frame: Cell::new(false),
        damage: Default::default(),
        positioned: Cell::new(false),
        reported: Cell::new(None),
        opened: Cell::new(false),
        focus_on_show: Cell::new(false),
        closed: Cell::new(false),
        hidden: Cell::new(false),
        state: Cell::new(None),
    });
    let weak = Rc::downgrade(&window);
    view.set_invalidate(Rc::new(move |view, rect| {
        if let Some(window) = weak.upgrade() {
            match rect {
                Some(rect) => window.damage.view_rect(view, rect),
                None => window.damage.view(view),
            }
            request_paint(&window);
        }
    }));
    surface.windows.borrow_mut().push(window.clone());
    crate::file_drop::window_opened(surface, id, hwnd);
    crate::shell::sync(surface, hwnd, None, resolved);
    place(&window, open);
    window.positioned.set(true);
    hold_owner(&window);
    resized(surface, &window);
    // Shown once the engine has laid out and drawn what it shows: after
    // the batches of the size just reported ([`first_show`]), or after a
    // while if they do not come.
    let target = hwnd.0 as isize;
    surface.control(|c| {
        c.flush(move |_| {
            // SAFETY: posting by handle; a window gone meanwhile ignores it.
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(target as *mut _)),
                    crate::window::WM_NSH_SHOW,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
        })
    });
    // SAFETY: a timer on the window just made.
    unsafe { SetTimer(Some(hwnd), SHOW_TIMER, SHOW_WAIT_MS, None) };
}

/// Sizes and places a window opening: the placement the core kept, else
/// its default size (its content's), position and display; the mode it
/// opens in waits until it shows.
fn place(window: &AppWindow, open: &OpenWindow) {
    let hwnd = window.hwnd;
    let options = &open.options;
    if let Some(placement) = open.placement {
        crate::window_state::set_placement(hwnd, placement);
        return;
    }
    if let Some(mode) = options.default_mode {
        crate::window_state::set_mode(hwnd, mode);
    }
    let content = options
        .default_size
        .filter(|s| s.width.0 >= 1.0 && s.height.0 >= 1.0)
        .unwrap_or(Size::new(Points(480.0), Points(360.0)));
    let position = options.default_position.or_else(|| {
        // Dialogs open over their parent, as the system's do.
        (options.kind == WindowKind::Dialog && window.owner.is_some())
            .then_some(WindowPosition::ParentCenter)
    });
    let (origin, center_on) = match position {
        Some(WindowPosition::At(at)) => (Some(at), None),
        Some(WindowPosition::ParentCenter) => {
            (None, window.owner.and_then(crate::window_state::bounds_of))
        }
        Some(WindowPosition::Center) => (None, None),
        None if options.display.is_some() => (None, None),
        // Where the system places it.
        None => return crate::window_state::size_content(hwnd, content),
    };
    crate::window_state::open_at(hwnd, content, origin, center_on, options.display);
}

/// A modal window takes the input from its owner while it shows.
fn hold_owner(window: &AppWindow) {
    let (Some(owner), true) = (window.owner, window.modal) else {
        return;
    };
    if let Some(shell) = crate::window::shell(window.hwnd)
        && shell.disabled_owner.replace(Some(owner)).is_none()
    {
        // SAFETY: a plain call on a live window.
        let _ = unsafe { EnableWindow(owner, false) };
    }
}

/// A modal window gives its owner the input back (before it hides, so
/// that the system activates the owner).
fn release_owner(window: &AppWindow) {
    if let Some(shell) = crate::window::shell(window.hwnd)
        && let Some(owner) = shell.disabled_owner.take()
    {
        // SAFETY: a plain call; a window gone meanwhile ignores it.
        let _ = unsafe { EnableWindow(owner, true) };
    }
}

/// The first frame was drawn (or did not come in time): the window shows,
/// in the mode it opens in.
fn first_show(surface: &Rc<Surface>, window: &AppWindow) {
    // SAFETY: the timer of this window, if it runs.
    let _ = unsafe { KillTimer(Some(window.hwnd), SHOW_TIMER) };
    if window.opened.replace(true) || window.closed.get() {
        return;
    }
    if window.hidden.get() {
        // It opened hidden: the app reads that it is not visible.
        report_now(surface, window);
        return;
    }
    // What the engine sent so far, then a frame of it.
    surface.drain();
    paint(surface, window);
    crate::window::show(window.hwnd);
    if window.focus_on_show.take() {
        crate::shell::request(window.hwnd, &WindowRequest::Focus);
    }
    report_now(surface, window);
}

/// The main window's title (the app's name).
fn main_title(surface: &Surface) -> String {
    let mut text = [0u16; 256];
    // SAFETY: a plain call into a local buffer; 0 for no title.
    let n = unsafe { GetWindowTextW(surface.hwnd(), &mut text) };
    String::from_utf16_lossy(&text[..n.max(0) as usize])
}

/// Asks for the whole of `window` to be drawn again (once, however often
/// asked before it is).
fn invalidate(window: &AppWindow) {
    window.damage.whole();
    request_paint(window);
}

/// Asks for `area` (DIPs) of the window of the app's own `hwnd` to be drawn
/// again: what is drawn there besides its views (its caption buttons).
/// False when `hwnd` is not one.
pub(crate) fn invalidate_area(
    surface: &Surface,
    hwnd: HWND,
    area: crate::view::WindowRect,
) -> bool {
    let Ok(windows) = surface.windows.try_borrow() else {
        return false;
    };
    let Some(window) = windows.iter().find(|w| w.hwnd == hwnd) else {
        return false;
    };
    window.damage.area(area);
    request_paint(window);
    true
}

/// Asks for a `WM_PAINT` of `window`, which draws what changed.
fn request_paint(window: &AppWindow) {
    if !window.invalid.replace(true) {
        crate::window::invalidate(window.hwnd);
    }
}

/// Asks for every window of the app's own to be drawn again (the theme
/// changed, the device was lost, ...).
pub(crate) fn invalidate_all(surface: &Surface) {
    let Ok(windows) = surface.windows.try_borrow() else {
        return;
    };
    for window in windows.iter() {
        invalidate(window);
    }
}

/// The app's appearance changed: the windows' frames follow it.
pub(crate) fn appearance_changed(surface: &Surface) {
    let Ok(windows) = surface.windows.try_borrow() else {
        return;
    };
    for window in windows.iter() {
        crate::shell::set_color_scheme(
            surface,
            window.hwnd,
            nsh_core::platform::Appearance::System,
        );
        invalidate(window);
    }
}

/// The color behind the views of the window showing root `id`: none where
/// the window is see-through (the desktop or its backdrop shows), else the
/// default theme's background in the window's scheme.
pub(crate) fn background(surface: &Surface, id: NodeId) -> Color {
    let Some(window) = get(surface, id) else {
        return crate::system::window_background(surface);
    };
    let attrs = crate::window::shell(window.hwnd).map(|s| s.attrs());
    let clear = window.composition.is_some()
        && attrs.is_some_and(|a| a.transparent || a.backdrop != Backdrop::None);
    if clear {
        Color::TRANSPARENT
    } else if crate::shell::dark(surface, window.hwnd) {
        Color(0x0a0a_0aff)
    } else {
        Color(0xffff_ffff)
    }
}

/// Fills the redirection surface of window `hwnd` (root `id`) with its
/// background, unless it is see-through.
fn fill_background(surface: &Surface, id: NodeId, hwnd: HWND) {
    let color = background(surface, id);
    if color.0 & 0xff != 0 {
        crate::window::fill(hwnd, color);
    }
}

/// The window's client area was resized or moved to another scale: the
/// root view takes its size, which the core lays the root out at.
fn resized(surface: &Rc<Surface>, window: &AppWindow) {
    resize_to(surface, window, client_pixels(window.hwnd));
}

fn client_pixels(hwnd: HWND) -> (u32, u32) {
    let mut rect = RECT::default();
    // SAFETY: plain call with a local out value.
    let _ = unsafe { GetClientRect(hwnd, &mut rect) };
    rect_pixels(rect)
}

fn rect_pixels(rect: RECT) -> (u32, u32) {
    (
        (rect.right - rect.left).max(0) as u32,
        (rect.bottom - rect.top).max(0) as u32,
    )
}

fn resize_to(surface: &Rc<Surface>, window: &AppWindow, pixels: (u32, u32)) {
    // Made at the system's default size (`CW_USEDEFAULT`, most of the
    // screen), which its styles report before it is placed: the app would
    // lay itself out for a window nobody sees.
    if !window.positioned.get() {
        return;
    }
    let scale = crate::window::dpi(window.hwnd) as f32 / 96.0;
    window.pixels.set(pixels);
    window.scale.set(scale);
    // Minimized: the root keeps its size.
    if pixels.0 == 0 || pixels.1 == 0 {
        return;
    }
    let size = Size::new(
        Points(pixels.0 as f32 / scale),
        Points(pixels.1 as f32 / scale),
    );
    let frame = Bounds::new(Default::default(), size);
    if std::mem::replace(&mut window.view.state_mut().frame, frame) != frame {
        window.view.moved();
    }
    if window.reported.replace(Some(size)) != Some(size) {
        surface.control(|c| c.set_root_size(window.id, size, EdgeInsets::default()));
        // Drawn at the new size rather than the last layout clipped or
        // short of the edge, as the main window's.
        surface.await_layout(window.id, size);
        // The dialogs presented in it follow its size.
        crate::navigation::surface_resized(surface, size.width.0, size.height.0);
        crate::system::window_resized(surface, window.id, size.width.0, size.height.0);
    }
    // The primary window's size and scale are the app's `windowSize()`.
    surface.window_environment();
    invalidate(window);
}

/// Prepare the newly exposed pixels before the window bounds grow.
pub(crate) fn prepare_resize(surface: &Rc<Surface>, id: NodeId, rect: RECT) {
    let Some(window) = get(surface, id) else {
        return;
    };
    if !window.opened.get() {
        return;
    }
    let hwnd = window.hwnd;
    // SAFETY: querying the mode of a live window.
    if unsafe { IsZoomed(hwnd) }.as_bool() || crate::window::is_full_screen(hwnd) {
        return;
    }
    // A normal frameless window's proposed outer rectangle is its client area.
    let pixels = rect_pixels(rect);
    let current = window.pixels.get();
    if pixels == current || pixels.0 < current.0 || pixels.1 < current.1 {
        return;
    }
    window.prepared_size.set(None);
    resize_to(surface, &window, pixels);
    paint(surface, &window);
    let swap = window.swap.borrow();
    if swap
        .as_ref()
        .is_some_and(|chain| chain.size == pixels && chain.shows_a_frame())
    {
        window.prepared_size.set(Some(pixels));
    }
}

/// Draws `window` (`WM_PAINT`, and at once when resized).
fn paint(surface: &Rc<Surface>, window: &AppWindow) {
    window.invalid.set(false);
    let Ok(mut swap) = window.swap.try_borrow_mut() else {
        window.repaint_after_frame.set(true);
        return;
    };
    let web = window.web.borrow().upgrade();
    // Deferred: the swap chain posts `WM_NSH_PAINT` when it has room, so
    // `invalid` stays set (no second `WM_PAINT` meanwhile).
    let deferred = crate::render::window_frame(
        surface,
        crate::render::WindowFrame {
            root: &window.view,
            hwnd: window.hwnd,
            base: window.composition.as_deref(),
            composition: web.as_deref(),
            swap: &mut swap,
            target_scale: &window.target_scale,
            size: window.pixels.get(),
            scale: window.scale.get(),
            placed: &window.placed,
            composed: &window.composed,
            damage: &window.damage,
        },
    );
    drop(swap);
    let repaint = window.repaint_after_frame.take();
    if deferred {
        window.invalid.set(true);
    } else if repaint {
        invalidate(window);
    }
}

// --- Policies ---------------------------------------------------------------------------

/// The user asked to close window `id` (`WM_CLOSE`), as `reason` says: the
/// app hears it, and with `closeOnPress` the window closes at once.
pub(crate) fn close_press(surface: &Surface, id: NodeId, reason: CloseReason) {
    let Some(window) = get(surface, id) else {
        return;
    };
    let closes = crate::window::shell(window.hwnd).is_none_or(|s| s.attrs().close_on_press);
    report(surface, id, WindowEvent::ClosePress { reason });
    if closes {
        closed(surface, id, WindowCloseCause::ClosePress);
    }
}

/// Closes window `id` by itself, for `cause`: it hides (the windows it
/// owns with it) and tells the app, which removes its root.
pub(crate) fn closed(surface: &Surface, id: NodeId, cause: WindowCloseCause) {
    let Some(window) = get(surface, id) else {
        return;
    };
    if window.closed.replace(true) {
        return;
    }
    release_children(surface, window.hwnd, true);
    release_owner(&window);
    // SAFETY: a plain call on the window, alive while listed.
    let _ = unsafe { ShowWindow(window.hwnd, SW_HIDE) };
    report(surface, id, WindowEvent::Closed { cause });
}

/// The windows of the app's own that `owner` owns: they close with it
/// (`report`: told as `ParentClose`), and are let go of, so that the system
/// does not destroy them with it before the app removes their roots.
fn release_children(surface: &Surface, owner: HWND, report: bool) {
    let children: Vec<Rc<AppWindow>> = surface
        .windows
        .borrow()
        .iter()
        .filter(|w| w.owner == Some(owner))
        .cloned()
        .collect();
    for child in children {
        if report {
            closed(surface, child.id, WindowCloseCause::ParentClose);
        } else {
            release_children(surface, child.hwnd, false);
        }
        // SAFETY: a plain call on a live window of this thread.
        unsafe {
            SetWindowLongPtrW(child.hwnd, GWLP_HWNDPARENT, 0);
        }
    }
}

/// Escape in a window with `closeOnEscape` closes it (the keys the app
/// binds come first). True when it did.
pub(crate) fn escape(surface: &Surface, event: &KeyEvent) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    let m = event.modifiers;
    if event.vk != VK_ESCAPE.0 || event.repeat || m.ctrl || m.alt || m.shift || m.meta {
        return false;
    }
    let id = surface.input_root().id();
    let Some(window) = get(surface, id) else {
        return false;
    };
    if !crate::window::shell(window.hwnd).is_some_and(|s| s.attrs().close_on_escape) {
        return false;
    }
    closed(surface, id, WindowCloseCause::Escape);
    true
}

/// Window `hwnd` lost the focus, once the activation settled: with
/// `closeOnBlur` it closes, unless the focus went to a window it owns (a
/// popup of its own) or nowhere of the system's (a menu of its own).
fn blur(surface: &Surface, window: &AppWindow) {
    let hwnd = window.hwnd;
    // SAFETY: a plain query.
    let visible = unsafe { IsWindowVisible(hwnd).as_bool() };
    // In a background app: the window that would have the keyboard.
    let mut active = crate::window::foreground();
    if !visible || window.closed.get() {
        return;
    }
    if !crate::window::shell(hwnd).is_some_and(|s| s.attrs().close_on_blur) {
        return;
    }
    while !active.is_invalid() {
        if active == hwnd {
            return;
        }
        // SAFETY: a plain query.
        active = unsafe { GetWindow(active, GW_OWNER) }.unwrap_or_default();
    }
    closed(surface, window.id, WindowCloseCause::Blur);
}

// --- State ------------------------------------------------------------------------------

/// Window `id` moved, was resized, shown, hidden, focused or put in another
/// mode: reported at once, except a move or a resize, reported once it
/// settles (the end of the user's drag, or a moment without another).
pub(crate) fn state_changed(surface: &Surface, id: NodeId) {
    let Some(window) = get(surface, id) else {
        return;
    };
    if !window.opened.get() {
        return;
    }
    let hwnd = window.hwnd;
    if crate::window::shell(hwnd).is_some_and(|s| s.sizing.get()) {
        return;
    }
    let Some(next) = crate::window_state::state(hwnd) else {
        return;
    };
    let settled = window.state.get().is_some_and(|last| {
        last.mode == next.mode
            && last.minimized == next.minimized
            && last.visible == next.visible
            && last.focused == next.focused
            && last.display == next.display
            && last.scale_factor == next.scale_factor
    });
    if settled {
        // SAFETY: a timer on a live window, restarted by each change.
        unsafe { SetTimer(Some(hwnd), STATE_TIMER, STATE_WAIT_MS, None) };
    } else {
        report_now(surface, &window);
    }
}

fn report_now(surface: &Surface, window: &AppWindow) {
    // SAFETY: the timer of this window, if it runs.
    let _ = unsafe { KillTimer(Some(window.hwnd), STATE_TIMER) };
    // Its title bar's area, before its first state.
    title_bar_changed(
        surface,
        window.id,
        crate::chrome::title_bar_area(window.hwnd),
    );
    let Some(state) = crate::window_state::state(window.hwnd) else {
        return;
    };
    if window.state.replace(Some(state)) != Some(state) {
        report(surface, window.id, WindowEvent::State(Box::new(state)));
    }
}

/// The area of window `id`'s hidden title bar is now `area`.
pub(crate) fn title_bar_changed(surface: &Surface, id: NodeId, area: Edges<Points>) {
    let Some(window) = get(surface, id) else {
        return;
    };
    let Some(shell) = crate::window::shell(window.hwnd) else {
        return;
    };
    // Reported as soon as the window exists (its creation sets the
    // attributes), not once it shows: the app's first frame reserves the
    // area, as it can on macOS and Linux. Its state still follows once it
    // shows.
    if shell.title_bar.replace(Some(area)) != Some(area) {
        report(surface, id, WindowEvent::TitleBar(area));
    }
}

/// What window `id` is now, as the app reads it (the test agent).
#[cfg(feature = "dev")]
pub(crate) fn state(surface: &Surface, id: NodeId) -> Option<WindowState> {
    crate::window_state::state(get(surface, id)?.hwnd)
}

// --- Messages ---------------------------------------------------------------------------

/// The messages of the window showing dialog root `id` that are not the
/// surface's input: `Some(result)` when handled here (`Some(None)`: the
/// system's default handling), `None` for the surface's input handling.
pub(crate) fn handle(
    surface: &Rc<Surface>,
    id: NodeId,
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<Option<LRESULT>> {
    let window = get(surface, id);
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            // SAFETY: paired Begin / EndPaint on this window.
            unsafe { BeginPaint(hwnd, &mut ps) };
            if let Some(window) = &window {
                paint(surface, window);
            }
            // SAFETY: as above.
            let _ = unsafe { EndPaint(hwnd, &ps) };
            Some(Some(LRESULT(0)))
        }
        crate::window::WM_NSH_PAINT => {
            // Drawn now: a pending `WM_PAINT` would only draw the same frame
            // again.
            // SAFETY: a plain call on this window.
            let _ = unsafe { windows::Win32::Graphics::Gdi::ValidateRect(Some(hwnd), None) };
            if let Some(window) = &window {
                paint(surface, window);
            }
            Some(Some(LRESULT(0)))
        }
        WM_ERASEBKGND => Some(Some(LRESULT(1))),
        WM_EXITSIZEMOVE => {
            if let Some(window) = &window {
                window.prepared_size.set(None);
                // Windows can end a drag without applying its last proposal.
                let pixels = client_pixels(hwnd);
                if window.pixels.get() != pixels {
                    resize_to(surface, window, pixels);
                    paint(surface, window);
                }
            }
            None
        }
        WM_SIZE => {
            // The frame's material follows the zoom state.
            crate::shell::zoom_changed(hwnd);
            if let Some(window) = &window {
                let pixels = client_pixels(hwnd);
                if window.prepared_size.take() == Some(pixels)
                    && window.scale.get() == crate::window::dpi(hwnd) as f32 / 96.0
                {
                    return Some(Some(LRESULT(0)));
                }
                // What DWM shows past the last frame meanwhile, as the main
                // window's.
                fill_background(surface, id, hwnd);
                resize_to(surface, window, pixels);
                // Drawn now, so that it never shows stretched or stale
                // pixels while it is resized.
                paint(surface, window);
            }
            Some(Some(LRESULT(0)))
        }
        WM_DPICHANGED => {
            // In full screen it keeps covering its monitor.
            if !crate::window::is_full_screen(hwnd) {
                // SAFETY: `lparam` is the suggested window rectangle.
                let r = unsafe { &*(lparam.0 as *const RECT) };
                // SAFETY: plain call on this window.
                let _ = unsafe {
                    SetWindowPos(
                        hwnd,
                        None,
                        r.left,
                        r.top,
                        r.right - r.left,
                        r.bottom - r.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    )
                };
            }
            if let Some(window) = &window {
                resized(surface, window);
            }
            Some(Some(LRESULT(0)))
        }
        crate::window::WM_NSH_SHOW => {
            if let Some(window) = &window {
                first_show(surface, window);
            }
            Some(Some(LRESULT(0)))
        }
        crate::window::WM_NSH_BLUR => {
            if let Some(window) = &window {
                blur(surface, window);
            }
            Some(Some(LRESULT(0)))
        }
        // The window's own handling: its mouse leave tracking.
        WM_TIMER if wparam.0 == crate::chrome::RECHECK_TIMER => None,
        WM_TIMER => {
            if let Some(window) = &window {
                match wparam.0 {
                    SHOW_TIMER => first_show(surface, window),
                    STATE_TIMER => report_now(surface, window),
                    _ => return Some(None),
                }
            }
            Some(Some(LRESULT(0)))
        }
        // Its own tree: the views of its dialog root.
        WM_GETOBJECT => Some(crate::access::get_object(surface, id, hwnd, wparam, lparam)),
        // A context menu this window asked for (`Menu.popup` in it).
        crate::window::WM_NSH_MENU => {
            crate::chrome::show_popup(surface, hwnd);
            Some(Some(LRESULT(0)))
        }
        // The main window's: its menu bar, lifecycle and engine.
        WM_NCPAINT | 0x0091 | 0x0092 | WM_COMMAND | WM_DESTROY => Some(None),
        m if m >= WM_APP => Some(None),
        _ => None,
    }
}

/// While the window showing dialog root `id` handles input, the surface's
/// input picks views in its root.
pub(crate) fn enter(surface: &Surface, id: NodeId) -> Option<InputRoot<'_>> {
    let view = get(surface, id)?.view.clone();
    let outer = surface.input_root.replace(Some(view));
    Some(InputRoot { surface, outer })
}

/// Restores the surface's input root when dropped ([`enter`]).
pub(crate) struct InputRoot<'a> {
    surface: &'a Surface,
    outer: Option<NshView>,
}

impl Drop for InputRoot<'_> {
    fn drop(&mut self) {
        *self.surface.input_root.borrow_mut() = self.outer.take();
    }
}

/// Dialog root `view` was removed: its window goes. Whether it had one.
pub(crate) fn removed(surface: &Surface, view: &NshView) -> bool {
    let window = {
        let mut windows = surface.windows.borrow_mut();
        let Some(i) = windows.iter().position(|w| w.id == view.id()) else {
            return false;
        };
        windows.remove(i)
    };
    // The windows it owns close with it, and stay until their roots go.
    release_children(surface, window.hwnd, !window.closed.get());
    destroy(surface, &window);
    // Another window may be the primary one now.
    surface.window_environment();
    // It no longer counts as shown.
    crate::system::lifecycle_changed(surface);
    true
}

/// The size and scale of the app's primary window: the first of its own
/// windows still open that has a size (not minimized when it opened).
/// `None` while it shows none.
pub(crate) fn primary(surface: &Surface) -> Option<(Size<Points>, f32)> {
    surface
        .windows
        .borrow()
        .iter()
        .find_map(|w| w.reported.get().map(|size| (size, w.scale.get())))
}

/// Closes every window of the app's own (the app stopped).
pub(crate) fn close_all(surface: &Surface) {
    let windows = std::mem::take(&mut *surface.windows.borrow_mut());
    for window in &windows {
        destroy(surface, window);
    }
    surface.window_environment();
    crate::system::lifecycle_changed(surface);
}

fn destroy(surface: &Surface, window: &AppWindow) {
    // The dialogs it showed go with it, answered as dismissed.
    crate::system::window_closing(surface, window.id);
    // Its views keep their trees, but the window that showed them is gone:
    // no view of it holds the keyboard focus any more.
    crate::keyboard::forget_window(surface, window.id);
    window.view.clear_invalidate();
    // What it hosts does not go with its native window: web views close,
    // components' windows go back to the main window, hidden.
    crate::native::window_closing(surface, window.hwnd);
    window.placed.borrow_mut().clear();
    window.composed.borrow_mut().clear();
    window.swap.borrow_mut().take();
    crate::file_drop::window_closing(surface, window.hwnd);
    crate::box_none::forget(window.hwnd);
    // SAFETY: plain calls on a window of this thread, if it is still there
    // (the system destroys owned windows with their owner).
    unsafe {
        if IsWindow(Some(window.hwnd)).as_bool() {
            let _ = DestroyWindow(window.hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        ViewKind,
        desktop::{TitleBarOptions, TitleBarStyle, WindowAttributes},
    };

    use super::*;

    /// A window's hidden title bar is known when the window is made, not
    /// only once it shows: the platform reports it then, so the app's first
    /// frame reserves the controls. Its first state still comes once it
    /// shows.
    #[test]
    fn a_hidden_title_bar_is_known_before_the_window_shows() {
        let app = crate::app::AppView::new(None, Default::default()).unwrap();
        let surface = app.surface();
        let id: NodeId = 7;
        let view = NshView::new(id, ViewKind::Modal);
        let mut title_bar = TitleBarOptions::default();
        title_bar.style = TitleBarStyle::Hidden;
        title_bar.height = Some(Points(40.0));
        let mut attributes = WindowAttributes::default();
        attributes.title_bar = Some(title_bar);
        let hwnd = crate::window::create_app_window(
            surface,
            id,
            WindowKind::Normal,
            &attributes,
            None,
            false,
        )
        .unwrap();
        surface.windows.borrow_mut().push(Rc::new(AppWindow {
            id,
            hwnd,
            view,
            owner: None,
            modal: false,
            composition: None,
            web: RefCell::default(),
            placed: RefCell::default(),
            composed: RefCell::default(),
            swap: RefCell::new(None),
            target_scale: Cell::new(0.0),
            pixels: Cell::new((0, 0)),
            scale: Cell::new(1.0),
            prepared_size: Cell::new(None),
            invalid: Cell::new(false),
            repaint_after_frame: Cell::new(false),
            damage: Default::default(),
            positioned: Cell::new(true),
            reported: Cell::new(None),
            opened: Cell::new(false),
            focus_on_show: Cell::new(false),
            closed: Cell::new(false),
            hidden: Cell::new(false),
            state: Cell::new(None),
        }));
        // Its attributes, as `open` sets them.
        let mut resolved = crate::shell::Attrs::of_kind(WindowKind::Normal);
        resolved.merge(&attributes);
        crate::shell::sync(surface, hwnd, None, resolved);
        let area = crate::chrome::title_bar_area(hwnd);
        assert!(area.top.0 > 0.0 && area.right.0 > 0.0, "{area:?}");
        assert_eq!(
            crate::window::shell(hwnd).unwrap().title_bar.get(),
            Some(area),
            "the area is reported before the first show"
        );
        assert!(!get(surface, id).unwrap().opened.get(), "not shown yet");
        assert_eq!(
            crate::file_requests::dialog_owner(surface),
            hwnd,
            "modal file/folder dialogs must target the visible app window rather than the hidden host"
        );
        // SAFETY: the test's own window.
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        surface.windows.borrow_mut().clear();
        assert_eq!(
            crate::file_requests::dialog_owner(surface),
            surface.hwnd(),
            "embedded hosts without app windows fall back to the host HWND"
        );
    }

    #[test]
    fn only_the_window_of_the_focused_field_takes_the_ime() {
        use nsh_core::InputConfig;
        use windows::Win32::UI::{
            Input::Ime::{ImmGetContext, ImmReleaseContext},
            WindowsAndMessaging::{GetSystemMetrics, SM_IMMENABLED},
        };

        // SAFETY: plain system metric query.
        assert_ne!(
            unsafe { GetSystemMetrics(SM_IMMENABLED) },
            0,
            "IMM is not enabled on this machine"
        );

        let has_ime = |hwnd: HWND| -> bool {
            // SAFETY: checks whether `hwnd` currently holds an associated IMC.
            unsafe {
                let himc = ImmGetContext(hwnd);
                if himc.is_invalid() {
                    return false;
                }
                let _ = ImmReleaseContext(hwnd, himc);
                true
            }
        };

        let make_window = |surface: &Rc<Surface>, id: NodeId| -> (HWND, NshView) {
            let view = NshView::new(id, ViewKind::Modal);
            view.set_invalidate(Rc::new(|_, _| {}));
            let attributes = WindowAttributes::default();
            let hwnd = crate::window::create_app_window(
                surface,
                id,
                WindowKind::Normal,
                &attributes,
                None,
                false,
            )
            .unwrap();
            surface.windows.borrow_mut().push(Rc::new(AppWindow {
                id,
                hwnd,
                view: view.clone(),
                owner: None,
                modal: false,
                composition: None,
                web: RefCell::default(),
                placed: RefCell::default(),
                composed: RefCell::default(),
                swap: RefCell::new(None),
                target_scale: Cell::new(0.0),
                pixels: Cell::new((0, 0)),
                scale: Cell::new(1.0),
                prepared_size: Cell::new(None),
                invalid: Cell::new(false),
                repaint_after_frame: Cell::new(false),
                damage: Default::default(),
                positioned: Cell::new(true),
                reported: Cell::new(None),
                opened: Cell::new(false),
                focus_on_show: Cell::new(false),
                closed: Cell::new(false),
                hidden: Cell::new(false),
                state: Cell::new(None),
            }));
            (hwnd, view)
        };

        let app = crate::app::AppView::new(None, Default::default()).unwrap();
        let surface = app.surface();
        let host = surface.hwnd();
        let (hwnd_a, root_a) = make_window(surface, 7);
        let (hwnd_b, root_b) = make_window(surface, 8);

        let input_a = NshView::new(10, ViewKind::Input);
        input_a.insert_before(&root_a, None);
        crate::text_input::create(surface, &input_a);

        let input_b = NshView::new(11, ViewKind::Input);
        input_b.insert_before(&root_b, None);
        crate::text_input::create(surface, &input_b);

        crate::text_input::focus(&input_a);
        assert!(has_ime(hwnd_a), "focused field's window must have IME");
        assert!(has_ime(host), "host window must keep IME for RichEdit");
        assert!(!has_ime(hwnd_b), "unfocused window B must not have IME");

        crate::text_input::config(
            surface,
            &input_b,
            &InputConfig {
                secure: true,
                ..Default::default()
            },
        );
        crate::text_input::focus(&input_b);
        assert!(!has_ime(hwnd_a), "window A must detach on secure focus");
        assert!(
            !has_ime(hwnd_b),
            "secure field's window B must not have IME"
        );
        assert!(!has_ime(host), "host must detach on secure focus");

        crate::text_input::focus(&input_a);
        assert!(has_ime(hwnd_a) && has_ime(host));
        crate::text_input::blur(&input_a);
        assert!(!has_ime(hwnd_a));
        assert!(!has_ime(hwnd_b));
        assert!(!has_ime(host));

        let (hwnd_c, _root_c) = make_window(surface, 9);
        crate::text_input::window_focus(surface, true);
        assert!(!has_ime(hwnd_c), "new unfocused window C must detach IME");

        crate::text_input::stopped(surface);
        // SAFETY: the test's own windows.
        unsafe {
            let _ = DestroyWindow(hwnd_a);
            let _ = DestroyWindow(hwnd_b);
            let _ = DestroyWindow(hwnd_c);
        }
        surface.windows.borrow_mut().clear();
    }

    #[test]
    fn activation_target_ranks_focused_unminimized_and_minimized_windows() {
        let hwnd = |id: isize| HWND(id as *mut _);
        let window = |id: isize| ActivationCandidate {
            hwnd: hwnd(id),
            visible: true,
            enabled: true,
            focusable: true,
            minimized: false,
        };

        // Focused window wins over an older visible window.
        assert_eq!(
            select_activation_target([window(1), window(2)], hwnd(2)),
            Some(hwnd(2))
        );

        // Skips hidden, disabled (modal owner), and non-focusable (overlay) windows.
        assert_eq!(
            select_activation_target(
                [
                    ActivationCandidate {
                        visible: false,
                        ..window(1)
                    },
                    ActivationCandidate {
                        enabled: false,
                        ..window(2)
                    },
                    ActivationCandidate {
                        focusable: false,
                        ..window(3)
                    },
                    window(4),
                ],
                hwnd(99),
            ),
            Some(hwnd(4))
        );

        // Prefers an unminimized visible window over an older minimized window.
        assert_eq!(
            select_activation_target(
                [
                    ActivationCandidate {
                        minimized: true,
                        ..window(1)
                    },
                    window(2),
                ],
                hwnd(99),
            ),
            Some(hwnd(2))
        );

        // Falls back to the oldest minimized window when none is open on screen.
        assert_eq!(
            select_activation_target(
                [
                    ActivationCandidate {
                        minimized: true,
                        ..window(1)
                    },
                    ActivationCandidate {
                        minimized: true,
                        ..window(2)
                    },
                ],
                hwnd(99),
            ),
            Some(hwnd(1))
        );

        // Falls back to the embedding host when app windows are unavailable, and
        // returns None when all windows (including the hidden host) are hidden.
        assert_eq!(
            select_activation_target(
                [
                    ActivationCandidate {
                        visible: false,
                        ..window(1)
                    },
                    window(10),
                ],
                hwnd(99),
            ),
            Some(hwnd(10))
        );
        assert_eq!(
            select_activation_target(
                [
                    ActivationCandidate {
                        visible: false,
                        ..window(1)
                    },
                    ActivationCandidate {
                        visible: false,
                        ..window(10)
                    },
                ],
                hwnd(99),
            ),
            None
        );
    }

    /// A view in a window of the app's own (`<Window>`) that listens for
    /// file drops makes that window an OLE drop destination, not only the
    /// main window: Explorer looks the destination up on the window under
    /// the pointer (#3395).
    #[test]
    fn a_window_of_the_apps_own_takes_file_drops() {
        use windows::{
            Win32::{System::Ole::OleInitialize, UI::WindowsAndMessaging::GetPropW},
            core::w,
        };

        // SAFETY: OLE on this test's thread, as the app's UI thread has it.
        let _ = unsafe { OleInitialize(None) };
        let app = crate::app::AppView::new(None, Default::default()).unwrap();
        let surface = app.surface();
        let id: NodeId = 7;
        let view = NshView::new(id, ViewKind::Modal);
        let hwnd = crate::window::create_app_window(
            surface,
            id,
            WindowKind::Normal,
            &WindowAttributes::default(),
            None,
            false,
        )
        .unwrap();
        surface.windows.borrow_mut().push(Rc::new(AppWindow {
            id,
            hwnd,
            view: view.clone(),
            owner: None,
            modal: false,
            composition: None,
            web: RefCell::default(),
            placed: RefCell::default(),
            composed: RefCell::default(),
            swap: RefCell::new(None),
            target_scale: Cell::new(0.0),
            pixels: Cell::new((0, 0)),
            scale: Cell::new(1.0),
            prepared_size: Cell::new(None),
            invalid: Cell::new(false),
            repaint_after_frame: Cell::new(false),
            damage: Default::default(),
            positioned: Cell::new(true),
            reported: Cell::new(None),
            opened: Cell::new(false),
            focus_on_show: Cell::new(false),
            closed: Cell::new(false),
            hidden: Cell::new(false),
            state: Cell::new(None),
        }));
        let registered = |hwnd: HWND| {
            // SAFETY: reads the property OLE's RegisterDragDrop sets.
            !unsafe { GetPropW(hwnd, w!("OleDropTargetInterface")) }.is_invalid()
        };
        view.state_mut().events.set(EventKind::FileDrop, true);
        crate::file_drop::events_changed(surface, &view);
        assert!(registered(hwnd), "the window showing the view takes drops");

        let window = get(surface, id).unwrap();
        destroy(surface, &window);
        surface.windows.borrow_mut().clear();
        crate::file_drop::reset(surface);
    }

    #[test]
    fn activation_target_skips_hidden_host_and_hidden_app_windows() {
        let app = crate::app::AppView::new(None, Default::default()).unwrap();
        let surface = app.surface();
        let id: NodeId = 7;
        let view = NshView::new(id, ViewKind::Modal);
        let hwnd = crate::window::create_app_window(
            surface,
            id,
            WindowKind::Normal,
            &WindowAttributes::default(),
            None,
            false,
        )
        .unwrap();
        surface.windows.borrow_mut().push(Rc::new(AppWindow {
            id,
            hwnd,
            view,
            owner: None,
            modal: false,
            composition: None,
            web: RefCell::default(),
            placed: RefCell::default(),
            composed: RefCell::default(),
            swap: RefCell::new(None),
            target_scale: Cell::new(0.0),
            pixels: Cell::new((0, 0)),
            scale: Cell::new(1.0),
            prepared_size: Cell::new(None),
            invalid: Cell::new(false),
            repaint_after_frame: Cell::new(false),
            damage: Default::default(),
            positioned: Cell::new(true),
            reported: Cell::new(None),
            opened: Cell::new(false),
            focus_on_show: Cell::new(false),
            closed: Cell::new(false),
            hidden: Cell::new(false),
            state: Cell::new(None),
        }));
        assert_eq!(activation_target(surface, surface.hwnd()), None);
        // SAFETY: the test's own window.
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        surface.windows.borrow_mut().clear();
    }

    /// A window of the app's own shows the app's icon (`nsh.json`'s, which
    /// `nsh run` hands over as an `.ico` file) before it first shows, as the
    /// hidden host window does: in a `mount(App)` or `<Window>` app it is the
    /// window with the taskbar button (#3280).
    #[test]
    fn an_app_window_has_the_apps_icon() {
        use windows::Win32::UI::WindowsAndMessaging::{
            ICON_BIG, ICON_SMALL, SendMessageW, WM_GETICON,
        };
        if crate::window::has_own_icon() {
            // The executable's icon is the class's; nothing is set.
            return;
        }
        // A 16×16 32-bit icon, opaque blue: header, one entry, the bitmap
        // (twice the height for the AND mask), its pixels and its mask.
        let mut ico = vec![0, 0, 1, 0, 1, 0];
        let image = 40 + 16 * 16 * 4 + 16 * 4;
        ico.extend([16, 16, 0, 0, 1, 0, 32, 0]);
        ico.extend((image as u32).to_le_bytes());
        ico.extend(22u32.to_le_bytes());
        ico.extend(40u32.to_le_bytes());
        ico.extend(16i32.to_le_bytes());
        ico.extend(32i32.to_le_bytes());
        ico.extend([1, 0, 32, 0]);
        ico.extend([0; 24]);
        for _ in 0..16 * 16 {
            ico.extend([0xff, 0, 0, 0xff]);
        }
        ico.extend([0; 16 * 4]);
        let path = std::env::temp_dir().join(format!("nsh-test-icon-{}.ico", std::process::id()));
        std::fs::write(&path, &ico).unwrap();

        let options = crate::AppOptions {
            icon: Some(path.clone()),
            ..Default::default()
        };
        let app = crate::app::AppView::new(None, options).unwrap();
        let surface = app.surface();
        let hwnd = crate::window::create_app_window(
            surface,
            7,
            WindowKind::Normal,
            &WindowAttributes::default(),
            None,
            false,
        )
        .unwrap();
        let icon = |which: u32| {
            // SAFETY: a plain query of the test's own window.
            unsafe { SendMessageW(hwnd, WM_GETICON, Some(WPARAM(which as usize)), None) }.0
        };
        assert_ne!(icon(ICON_BIG), 0, "the taskbar's icon");
        assert_ne!(icon(ICON_SMALL), 0, "the title bar's icon");
        // SAFETY: the test's own window.
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        let _ = std::fs::remove_file(path);
    }
}
