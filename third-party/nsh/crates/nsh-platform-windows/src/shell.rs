//! What a native window holds of `nsh/desktop`'s window API: one [`Shell`]
//! per window, the main one and every window of the app's own
//! ([`crate::app_window`]).
//!
//! - **Attributes** ([`Attrs`]): the window's kind's defaults with the
//!   app's over them, applied as the core sends what changed
//!   (`DesktopCommand::SetAttributes`, [`apply`]): window styles, the
//!   level, the taskbar, the system backdrop, capture protection, the
//!   taskbar button's progress, the title bar.
//! - **Policies** (`closeOnPress`, `closeOnEscape`, `closeOnBlur`) are
//!   read here when the user closes the window, presses Escape or the
//!   window loses the focus: answered on the spot, JS hears about it
//!   afterwards.
//! - **Limits** the window procedure enforces: the minimum and maximum
//!   size (`WM_GETMINMAXINFO`), what the
//!   user may do (`WM_SYSCOMMAND`).
//! - **Hit testing** ([`hit`]): the views marked `windowDrag`,
//!   `windowControl` and `windowResize` answer as the system's caption,
//!   buttons and borders, so the system moves, snaps and resizes the
//!   window (Windows 11 shows its snap layouts over a maximize control).

use std::cell::Cell;

use nsh_core::{
    desktop::{
        Backdrop, CloseReason, ProgressState, ResizeEdge, TitleBarOptions, TitleBarStyle,
        WindowAttributes, WindowControl, WindowFrameStyle, WindowKind, WindowLevel,
        WindowPointerEvents, WindowProgress, WindowRequest,
    },
    geometry::{Edges, Points, Size},
    platform::Appearance,
};
use windows::Win32::{
    Foundation::{COLORREF, HWND, POINT, RECT},
    Graphics::Dwm::{
        DWMWA_NCRENDERING_POLICY, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_WINDOW_CORNER_PREFERENCE,
        DwmExtendFrameIntoClientArea, DwmSetWindowAttribute,
    },
    UI::{Controls::MARGINS, WindowsAndMessaging::*},
};

use crate::surface::Surface;

/// What a window has now of the attributes: its kind's defaults with what
/// the app set over them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Attrs {
    pub(crate) title_bar: TitleBarOptions,
    pub(crate) frame: WindowFrameStyle,
    pub(crate) min_size: Option<Size<Points>>,
    pub(crate) max_size: Option<Size<Points>>,
    pub(crate) resizable: bool,
    pub(crate) movable: bool,
    pub(crate) minimizable: bool,
    pub(crate) maximizable: bool,
    pub(crate) closable: bool,
    pub(crate) focusable: bool,
    pub(crate) activate: bool,
    pub(crate) close_on_press: bool,
    pub(crate) close_on_escape: bool,
    pub(crate) close_on_blur: bool,
    pub(crate) level: WindowLevel,
    pub(crate) taskbar: bool,
    /// `pointerEvents: "none"`.
    pub(crate) click_through: bool,
    pub(crate) transparent: bool,
    pub(crate) backdrop: Backdrop,
    pub(crate) shadow: bool,
    pub(crate) progress: Option<WindowProgress>,
}

impl Default for Attrs {
    /// A normal window's.
    fn default() -> Attrs {
        let mut attrs = Attrs {
            title_bar: TitleBarOptions::default(),
            frame: WindowFrameStyle::Default,
            min_size: None,
            max_size: None,
            resizable: true,
            movable: true,
            minimizable: true,
            maximizable: true,
            closable: true,
            focusable: true,
            activate: true,
            close_on_press: true,
            close_on_escape: false,
            close_on_blur: false,
            level: WindowLevel::Normal,
            taskbar: true,
            click_through: false,
            transparent: false,
            backdrop: Backdrop::None,
            shadow: true,
            progress: None,
        };
        attrs.merge(&WindowAttributes::for_kind(WindowKind::Normal));
        attrs
    }
}

impl Attrs {
    /// `kind`'s defaults.
    pub(crate) fn of_kind(kind: WindowKind) -> Attrs {
        let mut attrs = Attrs::default();
        attrs.merge(&WindowAttributes::for_kind(kind));
        attrs
    }

    /// The fields `diff` sets, over these.
    pub(crate) fn merge(&mut self, diff: &WindowAttributes) {
        macro_rules! take {
            ($($field:ident),*) => {$(
                if let Some(v) = diff.$field {
                    self.$field = v;
                }
            )*};
        }
        take!(
            title_bar,
            frame,
            min_size,
            max_size,
            resizable,
            movable,
            minimizable,
            maximizable,
            closable,
            focusable,
            activate,
            close_on_press,
            close_on_escape,
            close_on_blur,
            level,
            taskbar,
            transparent,
            backdrop,
            shadow,
            progress
        );
        if let Some(pointer) = diff.pointer_events {
            self.click_through = pointer == WindowPointerEvents::None;
        }
    }

    /// The app draws the window's title bar: hidden, or no frame at all.
    pub(crate) fn custom_caption(&self) -> bool {
        self.frameless() || self.title_bar.style == TitleBarStyle::Hidden
    }

    /// No system frame: none asked for, or a see-through window (a frame
    /// around content the desktop shows through would draw a box nothing
    /// is in).
    pub(crate) fn frameless(&self) -> bool {
        self.frame == WindowFrameStyle::None || self.transparent
    }

    /// The system frame stays but its title bar is the app's: the caption
    /// buttons are drawn over the app ([`crate::chrome::draw`]).
    pub(crate) fn hidden_title_bar(&self) -> bool {
        !self.frameless() && self.title_bar.style == TitleBarStyle::Hidden
    }

    /// The window can be maximized by the user.
    pub(crate) fn can_maximize(&self) -> bool {
        self.maximizable && self.resizable
    }
}

/// The caption buttons a hidden title bar draws, from the right: close,
/// maximize (when it can), minimize (when it can).
pub(crate) fn caption_buttons(attrs: &Attrs) -> Vec<u32> {
    let mut buttons = vec![HTCLOSE];
    if attrs.can_maximize() {
        buttons.push(HTMAXBUTTON);
    }
    if attrs.minimizable {
        buttons.push(HTMINBUTTON);
    }
    buttons
}

/// The style bits [`styles`] decides; the others (visible, minimized,
/// maximized, disabled, child, clipping) are the window's own.
const STYLE_MASK: u32 = WS_POPUP.0
    | WS_CAPTION.0
    | WS_SYSMENU.0
    | WS_THICKFRAME.0
    | WS_MINIMIZEBOX.0
    | WS_MAXIMIZEBOX.0;

/// The extended style bits [`styles`] decides.
const EX_MASK: u32 = WS_EX_TOOLWINDOW.0
    | WS_EX_APPWINDOW.0
    | WS_EX_NOACTIVATE.0
    | WS_EX_LAYERED.0
    | WS_EX_TRANSPARENT.0
    | WS_EX_DLGMODALFRAME.0;

/// A window's styles for its kind and attributes (`owned`: it has an owner
/// window, so the taskbar leaves it out unless asked).
pub(crate) fn styles(kind: WindowKind, attrs: &Attrs, owned: bool) -> (u32, u32) {
    let mut style = if attrs.frameless() {
        // No frame: the system menu stays for the taskbar's menu, and
        // `WS_THICKFRAME` for the system's resizing and snapping (its
        // border is part of the client area: `WM_NCCALCSIZE`).
        WS_POPUP.0 | WS_SYSMENU.0
    } else {
        WS_CAPTION.0 | WS_SYSMENU.0
    };
    if attrs.resizable {
        style |= WS_THICKFRAME.0;
    }
    if attrs.minimizable {
        style |= WS_MINIMIZEBOX.0;
    }
    if attrs.can_maximize() {
        style |= WS_MAXIMIZEBOX.0;
    }
    let mut ex = 0;
    match kind {
        WindowKind::Normal => {}
        WindowKind::Dialog => {
            // The dialog frame, without the icon in its title bar.
            if attrs.frame == WindowFrameStyle::Default {
                ex |= WS_EX_DLGMODALFRAME.0;
            }
        }
        WindowKind::Panel | WindowKind::Popup | WindowKind::Overlay => ex |= WS_EX_TOOLWINDOW.0,
    }
    if !attrs.focusable {
        ex |= WS_EX_NOACTIVATE.0;
    }
    if attrs.click_through {
        // Clicks go to the windows below, of any process: only a layered
        // window's `WS_EX_TRANSPARENT` passes them on.
        ex |= WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0;
    }
    if attrs.taskbar && (owned || ex & WS_EX_TOOLWINDOW.0 != 0) {
        // In the taskbar although owned, or a tool window.
        ex &= !WS_EX_TOOLWINDOW.0;
        ex |= WS_EX_APPWINDOW.0;
    }
    (style, ex)
}

/// `current` with the bits [`styles`] decides replaced by `next`'s.
pub(crate) fn restyled(current: (u32, u32), next: (u32, u32)) -> (u32, u32) {
    (
        (current.0 & !STYLE_MASK) | (next.0 & STYLE_MASK),
        (current.1 & !EX_MASK) | (next.1 & EX_MASK),
    )
}

/// The system backdrop for `backdrop` (`DWMWA_SYSTEMBACKDROP_TYPE`'s
/// values: none 1, Mica 2, Acrylic 3, Mica Alt 4).
pub(crate) fn backdrop_type(backdrop: Backdrop) -> i32 {
    match backdrop {
        Backdrop::None => 1,
        Backdrop::Window => 2,
        Backdrop::Sidebar => 4,
        Backdrop::Popover | Backdrop::Hud => 3,
    }
}

/// The taskbar button's progress (`ITaskbarList3`): its state flags
/// (`TBPF_*`) and the share done in ten thousandths, if it has one.
pub(crate) fn progress_flags(progress: Option<WindowProgress>) -> (i32, Option<u64>) {
    const NOPROGRESS: i32 = 0;
    const INDETERMINATE: i32 = 1;
    const NORMAL: i32 = 2;
    const ERROR: i32 = 4;
    const PAUSED: i32 = 8;
    let Some(progress) = progress else {
        return (NOPROGRESS, None);
    };
    let value = progress
        .value
        .filter(|v| v.0.is_finite())
        .map(|v| (v.0.clamp(0.0, 1.0) * 10_000.0).round() as u64);
    let flags = match (progress.state, value) {
        (ProgressState::Indeterminate, _) | (ProgressState::Normal, None) => INDETERMINATE,
        (ProgressState::Normal, Some(_)) => NORMAL,
        (ProgressState::Paused, _) => PAUSED,
        (ProgressState::Error, _) => ERROR,
    };
    // A paused or failed bar without a share shows full.
    let value = match flags {
        INDETERMINATE => None,
        _ => Some(value.unwrap_or(10_000)),
    };
    (flags, value)
}

/// The hit test code of a view of the app's title bar marked
/// `windowControl`, when the window lets the user do it (else the client
/// area's).
pub(crate) fn control_code(control: WindowControl, attrs: &Attrs) -> u32 {
    match control {
        WindowControl::Minimize if attrs.minimizable => HTMINBUTTON,
        WindowControl::Maximize if attrs.can_maximize() => HTMAXBUTTON,
        WindowControl::Close => HTCLOSE,
        _ => HTCLIENT,
    }
}

/// The hit test code of an edge or corner (`windowResize`).
pub(crate) fn edge_code(edge: ResizeEdge) -> u32 {
    match edge {
        ResizeEdge::Top => HTTOP,
        ResizeEdge::Bottom => HTBOTTOM,
        ResizeEdge::Left => HTLEFT,
        ResizeEdge::Right => HTRIGHT,
        ResizeEdge::TopLeft => HTTOPLEFT,
        ResizeEdge::TopRight => HTTOPRIGHT,
        ResizeEdge::BottomLeft => HTBOTTOMLEFT,
        ResizeEdge::BottomRight => HTBOTTOMRIGHT,
    }
}

/// What a frameless, resizable window's own border answers at `p` (client
/// pixels) in a client area of `size` pixels with a border `border`
/// pixels thick: an edge or a corner, `None` inside.
pub(crate) fn border_code(p: POINT, size: (i32, i32), border: i32) -> Option<u32> {
    let (w, h) = size;
    let corner = border * 2;
    let left = p.x < border;
    let right = p.x >= w - border;
    let top = p.y < border;
    let bottom = p.y >= h - border;
    let near_left = p.x < corner;
    let near_right = p.x >= w - corner;
    let near_top = p.y < corner;
    let near_bottom = p.y >= h - corner;
    Some(match () {
        _ if (top && near_left) || (left && near_top) => HTTOPLEFT,
        _ if (top && near_right) || (right && near_top) => HTTOPRIGHT,
        _ if (bottom && near_left) || (left && near_bottom) => HTBOTTOMLEFT,
        _ if (bottom && near_right) || (right && near_bottom) => HTBOTTOMRIGHT,
        _ if top => HTTOP,
        _ if bottom => HTBOTTOM,
        _ if left => HTLEFT,
        _ if right => HTRIGHT,
        _ => return None,
    })
}

/// Whether the window lets the user act on what hit test `code` names
/// (a border resizes only a resizable window, a caption moves only a
/// movable one); the client area's code otherwise.
pub(crate) fn allowed(code: u32, attrs: &Attrs, zoomed: bool) -> u32 {
    let resizes = matches!(
        code,
        HTLEFT | HTRIGHT | HTTOP | HTTOPLEFT | HTTOPRIGHT | HTBOTTOM | HTBOTTOMLEFT | HTBOTTOMRIGHT
    );
    if resizes && (!attrs.resizable || zoomed) {
        return HTCLIENT;
    }
    if code == HTCAPTION && !attrs.movable {
        return HTCLIENT;
    }
    code
}

/// Whether the window lets the user carry out system command `command`
/// (`WM_SYSCOMMAND`'s `wparam` with its low four bits cleared).
pub(crate) fn command_allowed(command: u32, attrs: &Attrs) -> bool {
    match command {
        SC_MOVE => attrs.movable,
        SC_SIZE => attrs.resizable,
        SC_MINIMIZE => attrs.minimizable,
        SC_MAXIMIZE => attrs.can_maximize(),
        SC_CLOSE => attrs.closable,
        _ => true,
    }
}

/// A window's minimum and maximum outer sizes in pixels (`None`: unset).
pub(crate) type TrackSizes = (Option<(i32, i32)>, Option<(i32, i32)>);

/// The minimum and maximum outer sizes (pixels) of a window whose frame
/// takes `extra` pixels, at `scale` pixels per point; `None` where the
/// app sets none.
pub(crate) fn track_sizes(attrs: &Attrs, scale: f32, extra: (i32, i32)) -> TrackSizes {
    let outer = |s: Size<Points>| {
        (
            (s.width.0 * scale).round() as i32 + extra.0,
            (s.height.0 * scale).round() as i32 + extra.1,
        )
    };
    (attrs.min_size.map(outer), attrs.max_size.map(outer))
}

/// How the user asked to close a window, from what came before its
/// `WM_CLOSE`: `key` (Alt+F4 was pressed), `command` (a `SC_CLOSE` system
/// command: whether its point is on the window's close button, or none
/// for the keyboard), `caption` (the app's title bar's close button).
pub(crate) fn close_reason(key: bool, command: Option<SysClose>, caption: bool) -> CloseReason {
    if caption {
        return CloseReason::CloseButton;
    }
    if key {
        return CloseReason::Shortcut;
    }
    match command {
        Some(SysClose::Button) => CloseReason::CloseButton,
        Some(SysClose::Menu) => CloseReason::Menu,
        Some(SysClose::Elsewhere) => CloseReason::Taskbar,
        // A `WM_CLOSE` from outside the window: another program, the
        // system.
        None => CloseReason::System,
    }
}

/// Where a `SC_CLOSE` system command came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SysClose {
    /// The window's close button.
    Button,
    /// The window's system menu (with the mouse or the keyboard).
    Menu,
    /// Somewhere off the window: the taskbar's button, its thumbnail, the
    /// window switcher.
    Elsewhere,
}

/// What one native window holds of the app's window API.
pub(crate) struct Shell {
    /// Its kind (normal for the main window).
    pub(crate) kind: Cell<WindowKind>,
    /// Its attributes now.
    attrs: Cell<Attrs>,
    /// The window it is owned by and has disabled while it is modal.
    pub(crate) disabled_owner: Cell<Option<HWND>>,
    /// The hidden title bar's caption buttons: the one under the mouse
    /// (`HT*`, 0 for none), the one pressed.
    pub(crate) hover: Cell<u32>,
    pub(crate) pressed: Cell<u32>,
    /// The mouse is tracked for `WM_NCMOUSELEAVE`.
    pub(crate) nc_tracking: Cell<bool>,
    /// The window is inactive (its caption buttons dim).
    pub(crate) inactive: Cell<bool>,
    /// The mouse is over a view of the app's title bar that is not the
    /// client area (`windowControl`, `windowDrag`): the views hear it move
    /// there.
    pub(crate) view_hover: Cell<bool>,
    /// Inside the system's move or resize loop.
    pub(crate) sizing: Cell<bool>,
    /// Alt+F4 was pressed, for the `WM_CLOSE` it makes.
    pub(crate) close_key: Cell<bool>,
    /// The `SC_CLOSE` the `WM_CLOSE` comes from.
    pub(crate) close_command: Cell<Option<SysClose>>,
    /// The app's caption close button was pressed.
    pub(crate) close_caption: Cell<bool>,
    /// The taskbar tab was deleted ([`Attrs::taskbar`] false on a window the
    /// taskbar would show): deleted again whenever the window is shown.
    pub(crate) tab_deleted: Cell<bool>,
    /// The main window's close was pressed and it closes once the app heard
    /// it ([`crate::window_close`]).
    pub(crate) closing: Cell<bool>,
    /// The title bar's area last reported (windows of the app's own).
    pub(crate) title_bar: Cell<Option<Edges<Points>>>,
}

impl Shell {
    /// A window of `kind` with its defaults.
    pub(crate) fn new(kind: WindowKind) -> Shell {
        Shell {
            kind: Cell::new(kind),
            attrs: Cell::new(Attrs::of_kind(kind)),
            disabled_owner: Cell::new(None),
            hover: Cell::new(0),
            pressed: Cell::new(0),
            nc_tracking: Cell::new(false),
            inactive: Cell::new(false),
            view_hover: Cell::new(false),
            sizing: Cell::new(false),
            close_key: Cell::new(false),
            close_command: Cell::new(None),
            close_caption: Cell::new(false),
            tab_deleted: Cell::new(false),
            closing: Cell::new(false),
            title_bar: Cell::new(None),
        }
    }

    /// Replaces its attributes.
    pub(crate) fn set(&self, attrs: Attrs) {
        self.attrs.set(attrs);
    }

    /// Its attributes now.
    pub(crate) fn attrs(&self) -> Attrs {
        self.attrs.get()
    }

    /// Takes `diff` over its attributes; the attributes before.
    pub(crate) fn merge(&self, diff: &WindowAttributes) -> Attrs {
        let before = self.attrs.get();
        let mut next = before;
        next.merge(diff);
        self.attrs.set(next);
        before
    }

    /// How the user asked to close it, read once for the `WM_CLOSE` they
    /// made.
    pub(crate) fn take_close_reason(&self) -> CloseReason {
        close_reason(
            self.close_key.take(),
            self.close_command.take(),
            self.close_caption.take(),
        )
    }
}

// --- On the native window ---------------------------------------------------------------

/// The level's place in the z-order: floating windows (and those above the
/// taskbar, which Windows has no level of its own for) are topmost, the
/// desktop's icons' level the bottom of the normal windows.
fn level_order(level: WindowLevel) -> HWND {
    match level {
        WindowLevel::Normal => HWND_NOTOPMOST,
        WindowLevel::Floating | WindowLevel::AboveDock => HWND_TOPMOST,
        WindowLevel::DesktopIcon => HWND_BOTTOM,
    }
}

/// Makes a layered window (click-through) show its content as it is: a
/// layered window draws nothing until it is given an opacity.
pub(crate) fn opaque_layer(hwnd: HWND) {
    // SAFETY: a plain call on a live window.
    let _ = unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA) };
}

/// `hwnd` was shown: the taskbar adds a tab for a window being shown, and
/// forgets the progress of a button it made again.
pub(crate) fn shown(hwnd: HWND) {
    let Some(shell) = crate::window::shell(hwnd) else {
        return;
    };
    if shell.tab_deleted.get() {
        set_tab(hwnd, false);
    }
    let attrs = shell.attrs();
    if attrs.progress.is_some() {
        set_progress(hwnd, attrs.progress);
    }
}

/// The taskbar made the window's button (again): its progress shows on it.
pub(crate) fn button_created(hwnd: HWND) {
    shown(hwnd);
}

/// Takes `diff`, the attributes the app changed, on top-level window
/// `hwnd`: the fields set are carried out.
pub(crate) fn apply(surface: &Surface, hwnd: HWND, diff: &WindowAttributes) {
    let Some(shell) = crate::window::shell(hwnd) else {
        return;
    };
    if !crate::window_state::top_level(hwnd) {
        return;
    }
    let before = shell.merge(diff);
    let mut after = shell.attrs();
    if after.transparent != before.transparent {
        // What shows the window is chosen when it is made.
        log::warn!("window: `transparent` is set when a window opens; the change is ignored");
        after.transparent = before.transparent;
        shell.set(after);
    }
    if let Some(title) = &diff.title {
        // SAFETY: a plain call with a NUL-terminated string.
        let _ = unsafe { SetWindowTextW(hwnd, &windows::core::HSTRING::from(title.as_str())) };
    }
    sync(surface, hwnd, Some(before), after);
}

/// Carries out on `hwnd` what differs between `before` and `after`
/// (everything without `before`: a window opening).
pub(crate) fn sync(surface: &Surface, hwnd: HWND, before: Option<Attrs>, after: Attrs) {
    let Some(shell) = crate::window::shell(hwnd) else {
        return;
    };
    let changed = |f: &dyn Fn(&Attrs) -> bool| before.as_ref().is_none_or(f);
    let frame = changed(&|b| {
        b.title_bar != after.title_bar
            || b.frame != after.frame
            || b.resizable != after.resizable
            || b.minimizable != after.minimizable
            || b.maximizable != after.maximizable
    });
    restyle(hwnd, shell, &after);
    if frame {
        crate::chrome::frame_changed(surface, hwnd);
    }
    if changed(&|b| b.min_size != after.min_size || b.max_size != after.max_size)
        && (before.is_some() || after.min_size.is_some() || after.max_size.is_some())
    {
        clamp_size(hwnd, &after);
    }
    if changed(&|b| b.level != after.level)
        && (before.is_some() || after.level != WindowLevel::Normal)
    {
        set_level(hwnd, after.level);
    }
    if changed(&|b| b.taskbar != after.taskbar) {
        shell.tab_deleted.set(!after.taskbar);
        // SAFETY: a plain query.
        if unsafe { IsWindowVisible(hwnd) }.as_bool() {
            set_tab(hwnd, after.taskbar);
        }
    }
    if changed(&|b| {
        b.backdrop != after.backdrop
            || b.shadow != after.shadow
            || b.frameless() != after.frameless()
    }) && (before.is_some() || after.backdrop != Backdrop::None || after.frameless())
    {
        set_material(hwnd, &after);
    }
    if before.is_none() {
        set_color_scheme(surface, hwnd, Appearance::System);
    }
    if changed(&|b| b.progress != after.progress) && (before.is_some() || after.progress.is_some())
    {
        set_progress(hwnd, after.progress);
    }
    if changed(&|b| b.closable != after.closable) {
        set_closable(hwnd, after.closable);
    }
    if changed(&|b| b.closable != after.closable || b.minimizable != after.minimizable) {
        crate::window::invalidate(hwnd);
    }
}

/// Gives `hwnd` the styles of its kind and attributes; in full screen,
/// the frame it gets back.
fn restyle(hwnd: HWND, shell: &Shell, attrs: &Attrs) {
    // SAFETY: plain queries and calls on a live window of this thread.
    unsafe {
        let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
        let next = styles(shell.kind.get(), attrs, owned);
        let current = (
            GetWindowLongPtrW(hwnd, GWL_STYLE) as u32,
            GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32,
        );
        let (mut style, ex) = restyled(current, next);
        if crate::window::is_full_screen(hwnd) {
            crate::window::set_windowed_style(hwnd, (style & STYLE_MASK) as isize);
            style = current.0;
        }
        if (style, ex) == current {
            return;
        }
        SetWindowLongPtrW(hwnd, GWL_STYLE, style as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize);
        if ex & WS_EX_LAYERED.0 != 0 && current.1 & WS_EX_LAYERED.0 == 0 {
            opaque_layer(hwnd);
        }
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// Keeps the window's content within its minimum and maximum sizes and its
/// aspect ratio, as resizing it would.
fn clamp_size(hwnd: HWND, attrs: &Attrs) {
    // SAFETY: plain queries.
    let free = unsafe { !IsZoomed(hwnd).as_bool() && !IsIconic(hwnd).as_bool() };
    if !free || crate::window::is_full_screen(hwnd) {
        return;
    }
    let mut client = RECT::default();
    // SAFETY: a query with a local out value.
    if unsafe { GetClientRect(hwnd, &mut client) }.is_err() {
        return;
    }
    let scale = crate::window::dpi(hwnd) as f32 / 96.0;
    let current = (client.right - client.left, client.bottom - client.top);
    let next = clamped(current, attrs, scale);
    if next != current {
        crate::window::fit_content(hwnd, next);
    }
}

/// A content size of `size` pixels within `attrs`' limits at `scale`.
pub(crate) fn clamped(size: (i32, i32), attrs: &Attrs, scale: f32) -> (i32, i32) {
    let px = |v: Points| (v.0 * scale).round() as i32;
    let (mut w, mut h) = size;
    if let Some(min) = attrs.min_size {
        w = w.max(px(min.width));
        h = h.max(px(min.height));
    }
    if let Some(max) = attrs.max_size {
        w = w.min(px(max.width).max(1));
        h = h.min(px(max.height).max(1));
    }
    (w.max(1), h.max(1))
}

fn set_level(hwnd: HWND, level: WindowLevel) {
    // SAFETY: a plain call on a live window.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(level_order(level)),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

/// Shows the window's taskbar button, or takes it away. The taskbar
/// forgets a deleted tab when the window is shown again (or Explorer
/// restarts): [`shown`] deletes it again.
fn set_tab(hwnd: HWND, show: bool) {
    use windows::Win32::{
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
        UI::Shell::{ITaskbarList, TaskbarList},
    };
    // SAFETY: COM is initialized on the UI thread (`OleInitialize`); plain
    // calls on a live window.
    let result = unsafe {
        CoCreateInstance::<_, ITaskbarList>(&TaskbarList, None, CLSCTX_INPROC_SERVER).and_then(
            |taskbar| {
                taskbar.HrInit()?;
                if show {
                    taskbar.AddTab(hwnd)
                } else {
                    taskbar.DeleteTab(hwnd)
                }
            },
        )
    };
    if let Err(err) = result {
        log::warn!("window: taskbar: {err}");
    }
}

/// The system backdrop (Windows 11 22H2's Mica and Acrylic; nothing
/// before), the shadow of a frameless window and its corners.
fn set_material(hwnd: HWND, attrs: &Attrs) {
    let frameless = attrs.frameless();
    let backdrop = attrs.backdrop != Backdrop::None;
    // A frameless window's shadow is the frame's, extended by a pixel;
    // a backdrop shows through the whole client area.
    let margin = if backdrop {
        -1
    } else if frameless && attrs.shadow && !attrs.transparent {
        1
    } else {
        0
    };
    let margins = MARGINS {
        cxLeftWidth: margin,
        cxRightWidth: margin,
        cyTopHeight: margin,
        cyBottomHeight: margin,
    };
    let kind = backdrop_type(attrs.backdrop);
    // No shadow and square corners: a frameless window without a shadow
    // (or see-through) is only what the app draws.
    let bare = frameless && (!attrs.shadow || attrs.transparent);
    let policy: i32 = if bare { 1 } else { 0 };
    let corners: i32 = if bare { 1 } else { 0 };
    let set = |attribute, value: &i32| {
        // SAFETY: an i32-sized attribute value.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                value as *const i32 as *const _,
                std::mem::size_of::<i32>() as u32,
            )
        }
    };
    // Each fails quietly where the system lacks it.
    let _ = set(DWMWA_SYSTEMBACKDROP_TYPE, &kind);
    let _ = set(DWMWA_NCRENDERING_POLICY, &policy);
    let _ = set(DWMWA_WINDOW_CORNER_PREFERENCE, &corners);
    // SAFETY: a plain call with a local structure.
    let _ = unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) };
}

/// The window's frame dark or light: its own scheme, else the app's.
pub(crate) fn set_color_scheme(surface: &Surface, hwnd: HWND, scheme: Appearance) {
    let dark = match scheme {
        Appearance::Dark => true,
        Appearance::Light => false,
        _ => crate::system::dark(surface),
    };
    crate::window::set_dark_title_bar(hwnd, dark);
    crate::window::invalidate(hwnd);
}

/// Draws window `hwnd` (its caption buttons) dark: the app's scheme.
pub(crate) fn dark(surface: &Surface, _hwnd: HWND) -> bool {
    crate::system::dark(surface)
}

/// The progress on the window's taskbar button.
fn set_progress(hwnd: HWND, progress: Option<WindowProgress>) {
    use windows::Win32::{
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
        UI::Shell::{ITaskbarList3, TBPFLAG, TaskbarList},
    };
    let (flags, value) = progress_flags(progress);
    // SAFETY: COM is initialized on the UI thread; plain calls on a live
    // window (they fail before the taskbar made its button).
    let result = unsafe {
        CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER).and_then(
            |taskbar| {
                taskbar.HrInit()?;
                if let Some(value) = value {
                    taskbar.SetProgressValue(hwnd, value, 10_000)?;
                }
                taskbar.SetProgressState(hwnd, TBPFLAG(flags))
            },
        )
    };
    if let Err(err) = result {
        log::debug!("window: progress: {err}");
    }
}

/// The window menu's Close greyed, as the close button is with it.
fn set_closable(hwnd: HWND, closable: bool) {
    // SAFETY: plain calls on a live window's own menu.
    unsafe {
        let menu = GetSystemMenu(hwnd, false);
        if !menu.is_invalid() {
            let flags = if closable {
                MF_ENABLED
            } else {
                MF_GRAYED | MF_DISABLED
            };
            let _ = EnableMenuItem(menu, SC_CLOSE, MF_BYCOMMAND | flags);
        }
    }
}

/// Carries out `request` on top-level window `hwnd`; false for
/// [`WindowRequest::Close`], which the window's owner carries out.
pub(crate) fn request(hwnd: HWND, request: &WindowRequest) -> bool {
    use crate::window_state;
    if !window_state::top_level(hwnd) {
        return true;
    }
    // SAFETY: plain calls on a live window of this thread.
    unsafe {
        match request {
            WindowRequest::Show => {
                if !IsWindowVisible(hwnd).as_bool() {
                    crate::window::show(hwnd);
                }
            }
            WindowRequest::Hide => {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            WindowRequest::Focus => {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                } else if !IsWindowVisible(hwnd).as_bool() {
                    crate::window::show(hwnd);
                }
                if crate::window::shell(hwnd).is_none_or(|s| s.attrs().focusable) {
                    let _ = SetForegroundWindow(hwnd);
                }
            }
            WindowRequest::Close => return false,
            WindowRequest::Minimize => {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
            WindowRequest::Restore => {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
            }
            WindowRequest::SetMode(mode) => window_state::set_mode(hwnd, *mode),
            WindowRequest::SetBounds(frame) => window_state::set_bounds(hwnd, frame),
            WindowRequest::SetContentSize { width, height } => {
                set_content_size(hwnd, *width, *height)
            }
            WindowRequest::SetPlacement(placement) => window_state::set_placement(hwnd, *placement),
            WindowRequest::Center { display } => window_state::center(hwnd, *display),
            WindowRequest::RequestAttention { critical } => request_attention(hwnd, *critical),
        }
    }
    true
}

/// Sizes the window's content area (its top left corner stays): what
/// `sizeToContent` asks for. A maximized window or one in full screen keeps
/// the size its mode gives it.
fn set_content_size(hwnd: HWND, width: Option<Points>, height: Option<Points>) {
    // SAFETY: plain queries.
    let free = unsafe { !IsZoomed(hwnd).as_bool() && !IsIconic(hwnd).as_bool() };
    if !free || crate::window::is_full_screen(hwnd) {
        return;
    }
    let mut client = RECT::default();
    // SAFETY: a query with a local out value.
    if unsafe { GetClientRect(hwnd, &mut client) }.is_err() {
        return;
    }
    let scale = crate::window::dpi(hwnd) as f32 / 96.0;
    let px = |v: Option<Points>, or: i32| {
        v.filter(|v| v.0.is_finite() && v.0 > 0.0)
            .map_or(or, |v| (v.0 * scale).ceil() as i32)
    };
    let next = (
        px(width, client.right - client.left),
        px(height, client.bottom - client.top),
    );
    if next != (client.right - client.left, client.bottom - client.top) {
        crate::window::fit_content(hwnd, next);
    }
}

/// Flashes the window's taskbar button: until the user comes to it when
/// `critical`, else a few times.
fn request_attention(hwnd: HWND, critical: bool) {
    let info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd,
        dwFlags: if critical {
            FLASHW_ALL | FLASHW_TIMERNOFG
        } else {
            FLASHW_TRAY
        },
        uCount: if critical { 0 } else { 3 },
        dwTimeout: 0,
    };
    // SAFETY: a valid structure for a live window.
    let _ = unsafe { FlashWindowEx(&info) };
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        desktop::WindowAttributes,
        geometry::{Percentage, px, size},
    };

    use super::*;

    #[test]
    fn kinds_have_their_styles() {
        let normal = styles(
            WindowKind::Normal,
            &Attrs::of_kind(WindowKind::Normal),
            false,
        );
        assert_eq!(
            normal.0 & STYLE_MASK,
            WS_OVERLAPPEDWINDOW.0 & STYLE_MASK,
            "a normal window has the whole frame"
        );
        assert_eq!(normal.1, 0);

        let dialog = styles(
            WindowKind::Dialog,
            &Attrs::of_kind(WindowKind::Dialog),
            true,
        );
        assert_eq!(dialog.0 & (WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0), 0);
        assert_ne!(dialog.0 & WS_CAPTION.0, 0);
        assert_ne!(dialog.1 & WS_EX_DLGMODALFRAME.0, 0);
        assert_eq!(dialog.1 & WS_EX_APPWINDOW.0, 0, "not in the taskbar");

        let panel = styles(WindowKind::Panel, &Attrs::of_kind(WindowKind::Panel), true);
        assert_ne!(panel.1 & WS_EX_TOOLWINDOW.0, 0, "a small caption");

        let popup = styles(WindowKind::Popup, &Attrs::of_kind(WindowKind::Popup), true);
        assert_ne!(popup.0 & WS_POPUP.0, 0);
        assert_eq!(popup.0 & (WS_CAPTION.0 | WS_THICKFRAME.0), 0);

        let overlay = styles(
            WindowKind::Overlay,
            &Attrs::of_kind(WindowKind::Overlay),
            true,
        );
        let wanted =
            WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0;
        assert_eq!(overlay.1 & wanted, wanted);
        assert_ne!(overlay.0 & WS_POPUP.0, 0);
    }

    #[test]
    fn attributes_change_the_styles() {
        let mut attrs = Attrs::of_kind(WindowKind::Normal);
        let mut diff = WindowAttributes::default();
        diff.resizable = Some(false);
        attrs.merge(&diff);
        let (style, _) = styles(WindowKind::Normal, &attrs, false);
        assert_eq!(style & (WS_THICKFRAME.0 | WS_MAXIMIZEBOX.0), 0);
        assert_ne!(style & WS_MINIMIZEBOX.0, 0);

        // An owned window asked into the taskbar.
        let mut dialog = Attrs::of_kind(WindowKind::Dialog);
        let mut diff = WindowAttributes::default();
        diff.taskbar = Some(true);
        dialog.merge(&diff);
        assert_ne!(
            styles(WindowKind::Dialog, &dialog, true).1 & WS_EX_APPWINDOW.0,
            0
        );

        // A panel asked into the taskbar loses its tool window style.
        let mut panel = Attrs::of_kind(WindowKind::Panel);
        panel.merge(&diff);
        let (_, ex) = styles(WindowKind::Panel, &panel, true);
        assert_eq!(ex & WS_EX_TOOLWINDOW.0, 0);
        assert_ne!(ex & WS_EX_APPWINDOW.0, 0);
    }

    #[test]
    fn restyling_keeps_the_windows_own_bits() {
        let current = (
            WS_OVERLAPPEDWINDOW.0 | WS_VISIBLE.0 | WS_MAXIMIZE.0 | WS_DISABLED.0,
            WS_EX_NOREDIRECTIONBITMAP.0,
        );
        let next = (WS_POPUP.0 | WS_SYSMENU.0, WS_EX_TOOLWINDOW.0);
        let (style, ex) = restyled(current, next);
        assert_eq!(
            style,
            WS_POPUP.0 | WS_SYSMENU.0 | WS_VISIBLE.0 | WS_MAXIMIZE.0 | WS_DISABLED.0
        );
        assert_eq!(ex, WS_EX_TOOLWINDOW.0 | WS_EX_NOREDIRECTIONBITMAP.0);
    }

    #[test]
    fn backdrops_map_to_the_system_materials() {
        assert_eq!(backdrop_type(Backdrop::None), 1);
        assert_eq!(backdrop_type(Backdrop::Window), 2);
        assert_eq!(backdrop_type(Backdrop::Sidebar), 4);
        assert_eq!(backdrop_type(Backdrop::Popover), 3);
        assert_eq!(backdrop_type(Backdrop::Hud), 3);
    }

    #[test]
    fn progress_maps_to_the_taskbar_states() {
        let progress = |value: Option<f32>, state| {
            let mut p = WindowProgress::default();
            p.value = value.map(Percentage);
            p.state = state;
            Some(p)
        };
        assert_eq!(progress_flags(None), (0, None));
        assert_eq!(
            progress_flags(progress(Some(0.25), ProgressState::Normal)),
            (2, Some(2500))
        );
        assert_eq!(
            progress_flags(progress(None, ProgressState::Normal)),
            (1, None)
        );
        assert_eq!(
            progress_flags(progress(Some(0.5), ProgressState::Indeterminate)),
            (1, None)
        );
        assert_eq!(
            progress_flags(progress(Some(2.0), ProgressState::Paused)),
            (8, Some(10_000))
        );
        assert_eq!(
            progress_flags(progress(None, ProgressState::Error)),
            (4, Some(10_000))
        );
    }

    #[test]
    fn controls_and_edges_hit_test_as_the_systems() {
        let normal = Attrs::of_kind(WindowKind::Normal);
        assert_eq!(control_code(WindowControl::Maximize, &normal), HTMAXBUTTON);
        assert_eq!(control_code(WindowControl::Minimize, &normal), HTMINBUTTON);
        assert_eq!(control_code(WindowControl::Close, &normal), HTCLOSE);
        let dialog = Attrs::of_kind(WindowKind::Dialog);
        assert_eq!(control_code(WindowControl::Maximize, &dialog), HTCLIENT);
        assert_eq!(edge_code(ResizeEdge::BottomRight), HTBOTTOMRIGHT);
        assert_eq!(allowed(HTBOTTOMRIGHT, &normal, false), HTBOTTOMRIGHT);
        assert_eq!(allowed(HTBOTTOMRIGHT, &normal, true), HTCLIENT, "maximized");
        let popup = Attrs::of_kind(WindowKind::Popup);
        assert_eq!(allowed(HTLEFT, &popup, false), HTCLIENT, "not resizable");
        assert_eq!(allowed(HTCAPTION, &popup, false), HTCAPTION);
        let overlay = Attrs::of_kind(WindowKind::Overlay);
        assert_eq!(allowed(HTCAPTION, &overlay, false), HTCLIENT, "not movable");
    }

    #[test]
    fn a_frameless_border_has_edges_and_corners() {
        let at = |x, y| border_code(POINT { x, y }, (400, 300), 8);
        assert_eq!(at(200, 150), None);
        assert_eq!(at(2, 150), Some(HTLEFT));
        assert_eq!(at(398, 150), Some(HTRIGHT));
        assert_eq!(at(200, 1), Some(HTTOP));
        assert_eq!(at(200, 299), Some(HTBOTTOM));
        assert_eq!(at(3, 3), Some(HTTOPLEFT));
        assert_eq!(
            at(12, 2),
            Some(HTTOPLEFT),
            "the corner reaches along the edge"
        );
        assert_eq!(at(397, 290), Some(HTBOTTOMRIGHT));
    }

    #[test]
    fn system_commands_follow_the_attributes() {
        let overlay = Attrs::of_kind(WindowKind::Overlay);
        for command in [SC_MOVE, SC_SIZE, SC_MINIMIZE, SC_MAXIMIZE, SC_CLOSE] {
            assert!(!command_allowed(command, &overlay), "{command:x}");
            assert!(command_allowed(command, &Attrs::default()), "{command:x}");
        }
        assert!(command_allowed(SC_RESTORE, &overlay));
    }

    #[test]
    fn size_limits_are_outer_pixels() {
        let attrs = Attrs {
            min_size: Some(size(px(300.0), px(200.0))),
            ..Default::default()
        };
        let (min, max) = track_sizes(&attrs, 1.5, (16, 39));
        assert_eq!(min, Some((466, 339)));
        assert_eq!(max, None);
    }

    #[test]
    fn close_reasons_follow_what_came_first() {
        assert_eq!(close_reason(false, None, true), CloseReason::CloseButton);
        assert_eq!(
            close_reason(true, Some(SysClose::Menu), false),
            CloseReason::Shortcut
        );
        assert_eq!(
            close_reason(false, Some(SysClose::Button), false),
            CloseReason::CloseButton
        );
        assert_eq!(
            close_reason(false, Some(SysClose::Menu), false),
            CloseReason::Menu
        );
        assert_eq!(
            close_reason(false, Some(SysClose::Elsewhere), false),
            CloseReason::Taskbar
        );
        assert_eq!(close_reason(false, None, false), CloseReason::System);
    }

    #[test]
    fn shells_merge_diffs() {
        let shell = Shell::new(WindowKind::Popup);
        assert!(shell.attrs().close_on_blur);
        let mut diff = WindowAttributes::default();
        diff.close_on_blur = Some(false);
        diff.pointer_events = Some(WindowPointerEvents::None);
        let before = shell.merge(&diff);
        assert!(before.close_on_blur);
        assert!(!shell.attrs().close_on_blur);
        assert!(shell.attrs().click_through);
        assert!(shell.attrs().custom_caption(), "a popup has no frame");
        assert_eq!(caption_buttons(&shell.attrs()), vec![HTCLOSE]);
        assert_eq!(
            caption_buttons(&Attrs::default()),
            vec![HTCLOSE, HTMAXBUTTON, HTMINBUTTON]
        );
    }
}
