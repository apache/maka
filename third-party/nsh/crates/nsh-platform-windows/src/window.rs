//! The Win32 side of a surface: its window, the window procedure, wake-ups
//! from other threads and the frame ticker.
//!
//! - Each surface draws into one window ([`create`]): top-level for
//!   [`crate::run_app`], or a child of the embedding app's window.
//!   `GWLP_USERDATA` holds a [`WindowData`] that finds the surface.
//! - The engine thread wakes the surface with [`WM_NSH_WAKE`] ([`wake`]);
//!   worker threads run closures on a UI thread with [`UiThread::invoke`]
//!   (each UI thread has a message-only dispatcher window of its own).
//! - [`Ticker`] paces animation frames: a thread waits for the compositor's
//!   next frame (`DwmFlush`) and posts [`WM_NSH_TICK`], one at a time;
//!   while nothing composes it posts none.
//! - Mouse, touch and pen input becomes [`crate::input::PointerEvent`]s
//!   (with capture while a button is down, and double-click counting),
//!   the wheel [`crate::input::WheelEvent`]s, keys
//!   [`crate::input::KeyEvent`]s; characters and IME messages go to the
//!   focused field ([`crate::text_input`]).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use nsh_core::{NodeId, ROOT_ID};
use windows::{
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::{
            Dwm::{DWMWA_CLOAK, DWMWA_USE_IMMERSIVE_DARK_MODE, DwmFlush, DwmSetWindowAttribute},
            Gdi::{
                BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, GetDC,
                GetMonitorInfoW, InvalidateRect, MONITOR_DEFAULTTONEAREST, MONITORINFO,
                MonitorFromWindow, PAINTSTRUCT, ReleaseDC, ScreenToClient, UpdateWindow,
                ValidateRect,
            },
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Controls::WM_MOUSELEAVE,
            HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow},
            Input::{
                KeyboardAndMouse::{
                    GetKeyState, ReleaseCapture, SetCapture, SetFocus, TME_LEAVE, TRACKMOUSEEVENT,
                    TrackMouseEvent, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
                },
                Pointer::{GetPointerInfo, POINTER_INFO},
            },
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    },
    core::{PCWSTR, w},
};

use crate::{
    input::{KeyEvent, Modifiers, PointerEvent, PointerKind, WheelEvent},
    surface::Surface,
};

/// The engine sent something ([`Surface::drain`]).
pub(crate) const WM_NSH_WAKE: u32 = WM_APP + 1;
/// A frame of the ticker ([`Surface::tick`]).
pub(crate) const WM_NSH_TICK: u32 = WM_APP + 2;
/// A closure from another thread ([`UiThread::invoke`]); `lparam` owns it.
const WM_NSH_CALL: u32 = WM_APP + 3;
/// A context menu to show ([`crate::chrome::show_popup`]).
pub(crate) const WM_NSH_MENU: u32 = WM_APP + 4;
/// The embedding app's root window was shown, hidden, minimized or
/// restored ([`observe_root`]).
const WM_NSH_ROOT: u32 = WM_APP + 5;
/// The system tray's notifications ([`crate::tray`]).
pub(crate) const WM_NSH_TRAY: u32 = WM_APP + 6;
/// Closes the window, past its `closeOnPress` (`Request(Close)`, `Quit`,
/// a close press the policy let through): after the message being handled.
pub(crate) const WM_NSH_CLOSE: u32 = WM_APP + 7;
/// The engine handled the main window's close press; `wparam` names it
/// ([`crate::window_close`]).
pub(crate) const WM_NSH_CLOSE_HANDLED: u32 = WM_APP + 8;
/// A window of the app's own has its first frame laid out: it shows
/// ([`crate::app_window`]).
pub(crate) const WM_NSH_SHOW: u32 = WM_APP + 9;
/// A window of the app's own lost the focus: `closeOnBlur` is read once
/// the activation settled ([`crate::app_window`]).
pub(crate) const WM_NSH_BLUR: u32 = WM_APP + 10;
/// A window's swap chain has room for a frame again ([`crate::gfx`]): posted
/// from a pool thread, so it is handled before any `WM_PAINT` (which comes
/// last in a thread's queue and, with several windows to draw, late).
pub(crate) const WM_NSH_PAINT: u32 = WM_APP + 11;

/// How often the ticker asks for the compositor again while nothing
/// composes ([`Ticker`]): frames resume within this once it does.
const COMPOSITION_RETRY: std::time::Duration = std::time::Duration::from_millis(100);

const CLASS: PCWSTR = w!("NshWindow");
const DISPATCH_CLASS: PCWSTR = w!("NshDispatcher");

/// What a window's `GWLP_USERDATA` points to.
struct WindowData {
    surface: Weak<Surface>,
    /// Closing it ends the message loop when it is the last one.
    top_level: bool,
    /// The mouse is tracked for `WM_MOUSELEAVE`.
    tracking: Cell<bool>,
    /// Buttons held (capture is released when none is).
    buttons: Cell<u8>,
    /// The last press, for double-click counting: time (ms), point, count.
    last_press: Cell<(u32, (i32, i32), u32)>,
    /// A high surrogate waiting for its low half (`WM_CHAR`).
    surrogate: Cell<u16>,
    /// The Alt key combination just handled: its `WM_SYSCHAR` (Alt+Return
    /// makes one) must not reach `DefWindowProc`, which beeps for a menu
    /// mnemonic it cannot find.
    sys_char: Cell<bool>,
    /// Where the window was before it went full screen.
    windowed: Cell<Option<WINDOWPLACEMENT>>,
    /// Its frame's style bits before it went full screen.
    windowed_style: Cell<isize>,
    /// What it holds of the app's window API ([`crate::shell`]).
    shell: crate::shell::Shell,
    /// The embedding app's root window an embedded surface's window
    /// observes ([`observe_root`]); none for a top-level one.
    root: Cell<Option<HWND>>,
    /// The dialog root a window of the app's own shows
    /// ([`crate::app_window`]); none for the surface's window.
    window: Option<NodeId>,
}

thread_local! {
    /// Top-level windows open on this thread.
    static OPEN: Cell<usize> = const { Cell::new(0) };
    /// The dispatcher window of this thread ([`UiThread::invoke`]); 0
    /// until `register_classes` made it. Per thread, not per process: a
    /// closure touches the thread-locals of the thread that owns its
    /// surface, so it must run on that one.
    static DISPATCHER: Cell<isize> = const { Cell::new(0) };
}

pub(crate) fn instance() -> HINSTANCE {
    // SAFETY: the module handle of this executable.
    unsafe { GetModuleHandleW(None) }
        .map(|m| HINSTANCE(m.0))
        .unwrap_or_default()
}

fn register_classes() {
    thread_local! {
        static DONE: Cell<bool> = const { Cell::new(false) };
    }
    if DONE.with(|d| d.replace(true)) {
        return;
    }
    let hinstance = instance();
    // SAFETY: the class structures are valid for the calls; the window
    // procedures live for the program.
    unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: CLASS,
            hIcon: LoadIconW(Some(hinstance), PCWSTR(1 as _)).unwrap_or_default(),
            ..Default::default()
        };
        RegisterClassExW(&class);
        let dispatch = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(dispatch_proc),
            hInstance: hinstance,
            lpszClassName: DISPATCH_CLASS,
            ..Default::default()
        };
        RegisterClassExW(&dispatch);
        if let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            DISPATCH_CLASS,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance),
            None,
        ) {
            DISPATCHER.with(|d| d.set(hwnd.0 as isize));
        }
    }
}

/// Makes the window of `surface`: a top-level window of `size` points
/// titled `title`, or a child of `parent` filling it. A `transparent`
/// top-level window has no frame and no redirection bitmap: it shows only
/// what its composition draws ([`crate::compose`]).
pub(crate) fn create(
    surface: &Rc<Surface>,
    title: &str,
    size: (i32, i32),
    parent: Option<HWND>,
    transparent: bool,
) -> windows::core::Result<HWND> {
    register_classes();
    let data = Box::new(WindowData {
        surface: Rc::downgrade(surface),
        top_level: parent.is_none(),
        tracking: Cell::new(false),
        buttons: Cell::new(0),
        last_press: Cell::new((0, (0, 0), 0)),
        surrogate: Cell::new(0),
        sys_char: Cell::new(false),
        windowed: Cell::new(None),
        windowed_style: Cell::new(0),
        shell: crate::shell::Shell::new(nsh_core::desktop::WindowKind::Normal),
        root: Cell::new(None),
        window: None,
    });
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let (style, ex_style) = match parent {
        // Borderless: a system frame around see-through content would
        // draw a box nothing is in. The taskbar's menu still minimizes it.
        None if transparent => (
            WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX,
            WS_EX_NOREDIRECTIONBITMAP,
        ),
        None => (WS_OVERLAPPEDWINDOW, WINDOW_EX_STYLE(0)),
        Some(_) => (WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS, WINDOW_EX_STYLE(0)),
    };
    // SAFETY: the class is registered; `data` is handed to the window
    // (`WM_NCCREATE` stores it, `WM_NCDESTROY` frees it).
    let hwnd = unsafe {
        CreateWindowExW(
            ex_style,
            CLASS,
            PCWSTR(title.as_ptr()),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            size.0,
            size.1,
            parent,
            None,
            Some(instance()),
            Some(Box::into_raw(data) as *const _),
        )?
    };
    surface.set_hwnd(hwnd);
    if parent.is_some()
        && let Some(window) = self::data(hwnd)
    {
        window.root.set(observe_root(hwnd));
    }
    if parent.is_none() {
        OPEN.with(|o| o.set(o.get() + 1));
        // Sized in points at the window's own DPI (known once it exists).
        let dpi = dpi(hwnd);
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: (size.0 as f32 * dpi as f32 / 96.0).round() as i32,
            bottom: (size.1 as f32 * dpi as f32 / 96.0).round() as i32,
        };
        // SAFETY: plain calls on the window just made.
        unsafe {
            let _ = AdjustWindowRectExForDpi(&mut rect, style, false, ex_style, dpi);
            let _ = SetWindowPos(
                hwnd,
                None,
                0,
                0,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
    sync_size(surface, hwnd);
    Ok(hwnd)
}

/// Makes a window of the app's own ([`crate::app_window`]) showing dialog
/// root `id` of `surface`, hidden, of `kind` with `attributes` (resolved:
/// every field set), owned by `owner`; `composed`: its content is shown by
/// a composition of its own, see-through where the app draws nothing (no
/// redirection bitmap). [`crate::app_window`] sizes and places it. It is
/// not counted as one of the app's top-level windows: the surface's window
/// still ends the app.
pub(crate) fn create_app_window(
    surface: &Rc<Surface>,
    id: NodeId,
    kind: nsh_core::desktop::WindowKind,
    attributes: &nsh_core::desktop::WindowAttributes,
    owner: Option<HWND>,
    composed: bool,
) -> windows::core::Result<HWND> {
    register_classes();
    let shell = crate::shell::Shell::new(kind);
    shell.merge(attributes);
    let (style, mut ex) = crate::shell::styles(kind, &shell.attrs(), owner.is_some());
    if composed {
        ex |= WS_EX_NOREDIRECTIONBITMAP.0;
    }
    let data = Box::new(WindowData {
        surface: Rc::downgrade(surface),
        top_level: false,
        tracking: Cell::new(false),
        buttons: Cell::new(0),
        last_press: Cell::new((0, (0, 0), 0)),
        surrogate: Cell::new(0),
        sys_char: Cell::new(false),
        windowed: Cell::new(None),
        windowed_style: Cell::new(0),
        shell,
        root: Cell::new(None),
        window: Some(id),
    });
    let title = attributes.title.clone().unwrap_or_default();
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the class is registered; `data` is handed to the window
    // (`WM_NCCREATE` stores it, `WM_NCDESTROY` frees it).
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(ex),
            CLASS,
            PCWSTR(title.as_ptr()),
            WINDOW_STYLE(style),
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            owner,
            None,
            Some(instance()),
            Some(Box::into_raw(data) as *const _),
        )?
    };
    if ex & WS_EX_LAYERED.0 != 0 {
        crate::shell::opaque_layer(hwnd);
    }
    Ok(hwnd)
}

/// Gives `hwnd` an outer size that makes its client area `content`
/// pixels, whatever its frame (measured, so a hidden title bar's or no
/// frame's client area counts as it is).
pub(crate) fn fit_content(hwnd: HWND, content: (i32, i32)) {
    let (l, t, r, b) = frame_extents(hwnd);
    // SAFETY: a plain call on a live window.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            content.0.max(1) + (l + r).max(0),
            content.1.max(1) + (t + b).max(0),
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
}

/// What `hwnd`'s frame takes around its client area, in pixels: left, top,
/// right, bottom.
pub(crate) fn frame_extents(hwnd: HWND) -> (i32, i32, i32, i32) {
    let (mut window, mut client) = (RECT::default(), RECT::default());
    let mut origin = POINT::default();
    // SAFETY: queries with local out values.
    unsafe {
        if GetWindowRect(hwnd, &mut window).is_err()
            || GetClientRect(hwnd, &mut client).is_err()
            || !windows::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut origin).as_bool()
        {
            return (0, 0, 0, 0);
        }
    }
    (
        origin.x - window.left,
        origin.y - window.top,
        window.right - (origin.x + client.right),
        window.bottom - (origin.y + client.bottom),
    )
}

/// What `hwnd` holds of the app's window API.
pub(crate) fn shell(hwnd: HWND) -> Option<&'static crate::shell::Shell> {
    data(hwnd).map(|d| &d.shell)
}

/// The dialog root a window of the app's own shows (`None` for a
/// surface's window).
pub(crate) fn app_window_root(hwnd: HWND) -> Option<NodeId> {
    data(hwnd).and_then(|d| d.window)
}

/// The window's frame style bits before it went full screen, for a window
/// restyled meanwhile ([`crate::shell::apply`]): they are what it gets
/// back.
pub(crate) fn set_windowed_style(hwnd: HWND, style: isize) {
    if let Some(data) = data(hwnd) {
        data.windowed_style.set(style);
    }
}

/// The window is in full screen ([`toggle_full_screen`]).
pub(crate) fn is_full_screen(hwnd: HWND) -> bool {
    windowed(hwnd).is_some()
}

/// Where a window in full screen returns to (`None`: it is not in full
/// screen).
pub(crate) fn windowed(hwnd: HWND) -> Option<WINDOWPLACEMENT> {
    let data = data(hwnd)?;
    let placement = data.windowed.take();
    data.windowed.set(placement);
    placement
}

/// Where a window in full screen returns to, from now on.
pub(crate) fn set_windowed(hwnd: HWND, placement: WINDOWPLACEMENT) {
    if let Some(data) = data(hwnd)
        && data.windowed.take().is_some()
    {
        data.windowed.set(Some(placement));
    }
}

/// Takes a top-level window to full screen on its monitor (no frame, over
/// the taskbar), or back to where it was.
pub(crate) fn toggle_full_screen(hwnd: HWND) {
    toggle_full_screen_inner(hwnd);
    full_screen_changed(hwnd);
}

/// Puts a top-level window in full screen or out of it (doing it again
/// changes nothing).
pub(crate) fn set_full_screen(hwnd: HWND, full: bool) {
    if is_full_screen(hwnd) != full {
        toggle_full_screen(hwnd);
    }
}

fn full_screen_changed(hwnd: HWND) {
    let Some(data) = data(hwnd) else { return };
    let Some(surface) = data.surface.upgrade() else {
        return;
    };
    match data.window {
        // Neither the menu bar nor a hidden title bar's area show in full
        // screen.
        None => {
            crate::chrome::full_screen_changed(&surface, hwnd);
            crate::window_state::report_main(&surface);
        }
        Some(id) => {
            crate::chrome::full_screen_changed(&surface, hwnd);
            crate::app_window::state_changed(&surface, id);
        }
    }
}

fn toggle_full_screen_inner(hwnd: HWND) {
    let Some(data) = data(hwnd) else { return };
    if !crate::window_state::top_level(hwnd) {
        return;
    }
    let frame = (WS_OVERLAPPEDWINDOW.0 | WS_POPUP.0) as isize;
    // SAFETY: plain calls on a live window with local structures.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        match data.windowed.take() {
            None => {
                let mut placement = WINDOWPLACEMENT {
                    length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                    ..Default::default()
                };
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                if GetWindowPlacement(hwnd, &mut placement).is_err()
                    || !GetMonitorInfoW(monitor, &mut info).as_bool()
                {
                    return;
                }
                data.windowed.set(Some(placement));
                data.windowed_style.set(style & frame);
                SetWindowLongPtrW(hwnd, GWL_STYLE, (style & !frame) | WS_POPUP.0 as isize);
                let r = info.rcMonitor;
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
                );
            }
            Some(placement) => {
                // Only the frame's bits come back: the window's own
                // (visible, minimized, disabled) stay as they are now.
                SetWindowLongPtrW(
                    hwnd,
                    GWL_STYLE,
                    (style & !frame) | (data.windowed_style.get() & frame),
                );
                let _ = SetWindowPlacement(hwnd, &placement);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
                );
            }
        }
    }
}

/// Shows a top-level window (without activating it when its attributes
/// say so), and keeps it out of the taskbar if it is.
pub(crate) fn show(hwnd: HWND) {
    let activate = shell(hwnd).is_none_or(|s| {
        let a = s.attrs();
        a.activate && a.focusable
    });
    // SAFETY: plain calls on a live window.
    unsafe {
        let _ = ShowWindow(hwnd, if activate { SW_SHOW } else { SW_SHOWNOACTIVATE });
        let _ = UpdateWindow(hwnd);
    }
    crate::shell::shown(hwnd);
}

/// True when the executable has an icon of its own (resource 1, which
/// `nsh package` writes on Windows), which the window class shows.
pub(crate) fn has_own_icon() -> bool {
    // SAFETY: a plain lookup of a shared resource icon, never destroyed.
    unsafe { LoadIconW(Some(instance()), PCWSTR(1 as _)) }.is_ok()
}

/// Gives the top-level `hwnd` the app's icon from the `.ico` file `path`
/// (the large one at `SM_CXICON`, the small one at `SM_CXSMICON`, at its
/// DPI) when the executable has none of its own. The icons are loaded once
/// per file and size and kept for the process: the windows share them.
pub(crate) fn set_icon(hwnd: HWND, path: Option<&std::path::Path>) {
    thread_local! {
        static LOADED: RefCell<Vec<(std::path::PathBuf, i32, HICON)>> =
            const { RefCell::new(Vec::new()) };
    }
    let Some(path) = path.filter(|_| !has_own_icon()) else {
        return;
    };
    let dpi = dpi(hwnd);
    let load = |metric: SYSTEM_METRICS_INDEX| {
        // SAFETY: a plain query.
        let side = unsafe { windows::Win32::UI::HiDpi::GetSystemMetricsForDpi(metric, dpi) };
        let cached = LOADED.with(|l| {
            l.borrow()
                .iter()
                .find(|(p, s, _)| p == path && *s == side)
                .map(|(_, _, icon)| *icon)
        });
        if cached.is_some() {
            return cached;
        }
        // SAFETY: a NUL-terminated path; the icon is kept for the process.
        let icon = unsafe {
            LoadImageW(
                None,
                &windows::core::HSTRING::from(path.as_os_str()),
                IMAGE_ICON,
                side,
                side,
                LR_LOADFROMFILE,
            )
        };
        match icon {
            Ok(handle) => {
                let icon = HICON(handle.0);
                LOADED.with(|l| l.borrow_mut().push((path.to_owned(), side, icon)));
                Some(icon)
            }
            Err(err) => {
                log::warn!("the app's icon {}: {err}", path.display());
                None
            }
        }
    };
    for (metric, which) in [(SM_CXICON, ICON_BIG), (SM_CXSMICON, ICON_SMALL)] {
        if let Some(icon) = load(metric) {
            // SAFETY: a window of this thread and an icon that outlives it.
            unsafe {
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(which as usize)),
                    Some(LPARAM(icon.0 as isize)),
                );
            }
        }
    }
}

/// The window's DPI (96 at 100%).
pub(crate) fn dpi(hwnd: HWND) -> u32 {
    // SAFETY: plain call; 0 for an invalid window.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 { 96 } else { dpi }
}

/// Tells the surface the window's client size and scale.
fn sync_size(surface: &Rc<Surface>, hwnd: HWND) {
    let mut rect = RECT::default();
    // SAFETY: plain call with a local out value.
    let _ = unsafe { GetClientRect(hwnd, &mut rect) };
    let pixels = (
        (rect.right - rect.left).max(0) as u32,
        (rect.bottom - rect.top).max(0) as u32,
    );
    surface.resized(pixels, dpi(hwnd) as f32 / 96.0);
}

/// Wakes the surface of window `hwnd` (any thread).
pub(crate) fn wake(hwnd: isize) {
    if hwnd != 0 {
        // SAFETY: posting to a window handle is thread-safe; a window that
        // is gone makes the call fail harmlessly.
        let _ = unsafe {
            PostMessageW(
                Some(HWND(hwnd as *mut _)),
                WM_NSH_WAKE,
                WPARAM(0),
                LPARAM(0),
            )
        };
    }
}

/// Fills the window's client area with its background: before the first
/// frame, and as it is resized. Windows composites and animates a window
/// that has not painted yet with its default light surface, which flashes
/// white on a dark appearance; its swap chain does not cover that surface
/// until the first present, nor past the last frame while a resize's is on
/// its way.
pub(crate) fn fill_background(surface: &Surface, hwnd: HWND) {
    if !surface.transparent() {
        fill(hwnd, crate::system::window_background(surface));
    }
}

/// Fills the client area of `hwnd` with `color` (opaque), through GDI: what
/// DWM shows of the window where no frame of its swap chain covers it.
pub(crate) fn fill(hwnd: HWND, color: nsh_core::Color) {
    // `Color` is 0xRRGGBBAA; a GDI color is 0x00BBGGRR.
    let color = color.0;
    // SAFETY: a plain GDI call; the brush is freed below.
    let brush = unsafe {
        CreateSolidBrush(COLORREF(
            ((color >> 24) & 0xff) | ((color >> 8) & 0xff00) | ((color & 0xff00) << 8),
        ))
    };
    // SAFETY: GDI calls on a window of this thread; the brush is freed here.
    unsafe {
        let dc = GetDC(Some(hwnd));
        if !dc.is_invalid() {
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let _ = FillRect(dc, &rect, brush);
            let _ = ReleaseDC(Some(hwnd), dc);
        }
        let _ = DeleteObject(brush.into());
    }
}

/// Asks for `WM_PAINT`.
pub(crate) fn invalidate(hwnd: HWND) {
    if !hwnd.is_invalid() {
        // SAFETY: a plain call on a window of this thread.
        let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
    }
}

/// A UI thread that runs closures posted from other threads: its
/// message-only dispatcher window. Capture it on the UI thread where the
/// work starts and carry it to wherever the work finishes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct UiThread(isize);

impl UiThread {
    /// The calling thread (its dispatcher made on first use). Never call
    /// it from a worker thread: that would make a dispatcher there.
    pub(crate) fn current() -> UiThread {
        register_classes();
        UiThread(DISPATCHER.with(Cell::get))
    }

    /// Runs `f` on that thread (from any thread), in its message loop.
    /// Dropped when it has no dispatcher or the post fails (the thread is
    /// gone).
    pub(crate) fn invoke(self, f: impl FnOnce() + Send + 'static) {
        if self.0 == 0 {
            return;
        }
        let boxed: Box<Box<dyn FnOnce() + Send>> = Box::new(Box::new(f));
        let raw = Box::into_raw(boxed);
        // SAFETY: the dispatcher takes ownership of `raw` when it gets the
        // message; if posting fails it is freed here.
        unsafe {
            if PostMessageW(
                Some(HWND(self.0 as *mut _)),
                WM_NSH_CALL,
                WPARAM(0),
                LPARAM(raw as isize),
            )
            .is_err()
            {
                drop(Box::from_raw(raw));
            }
        }
    }
}

unsafe extern "system" fn dispatch_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NSH_CALL {
        // SAFETY: `UiThread::invoke` posted a leaked box of this type.
        let f = unsafe { Box::from_raw(lparam.0 as *mut Box<dyn FnOnce() + Send>) };
        f();
        return LRESULT(0);
    }
    // SAFETY: default handling.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Keeps the window out of DWM's composition (cloaked) while its first
/// background is prepared. A window shown without this is composited and
/// animated with its default light client surface before the app paints.
pub(crate) fn set_cloaked(hwnd: HWND, cloaked: bool) {
    let value: i32 = cloaked.into();
    // SAFETY: a BOOL-sized attribute value.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            &value as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        )
    };
}

/// Darkens (or not) a top-level window's title bar.
pub(crate) fn set_dark_title_bar(hwnd: HWND, dark: bool) {
    let value: i32 = dark.into();
    // SAFETY: a BOOL-sized attribute value.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &value as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        )
    };
}

/// Runs the message loop until the last top-level window closes.
pub(crate) fn run_loop() -> i32 {
    let mut msg = MSG::default();
    // SAFETY: the standard message loop.
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    msg.wParam.0 as i32
}

/// The modifiers held now.
pub(crate) fn modifiers() -> Modifiers {
    // SAFETY: plain state queries.
    let down = |vk: u16| unsafe { GetKeyState(vk as i32) } < 0;
    Modifiers {
        shift: down(VK_SHIFT.0),
        ctrl: down(VK_CONTROL.0),
        alt: down(VK_MENU.0),
        meta: down(VK_LWIN.0) || down(VK_RWIN.0),
    }
}

/// The [`WindowData`] of `hwnd`, when it is one of this process's windows
/// of [`CLASS`]: callers pass windows they did not make too (the foreground
/// window, which may be another app's), whose `GWLP_USERDATA` is theirs,
/// not a `WindowData`.
fn data(hwnd: HWND) -> Option<&'static WindowData> {
    use windows::Win32::{
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{GCLP_WNDPROC, GetClassLongPtrW, GetWindowThreadProcessId},
    };
    let mut process = 0;
    // SAFETY: plain queries; an out value for the process id.
    let ours = unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process)) != 0
            && process == GetCurrentProcessId()
            && GetClassLongPtrW(hwnd, GCLP_WNDPROC) == window_proc as *const () as usize
    };
    if !ours {
        return None;
    }
    // SAFETY: a window of `CLASS` in this process: the pointer was stored by
    // `WM_NCCREATE` and is freed only in `WM_NCDESTROY`, after which the
    // slot is cleared.
    unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowData).as_ref() }
}

fn lo(l: isize) -> i32 {
    (l & 0xFFFF) as i16 as i32
}

fn hi(l: isize) -> i32 {
    ((l >> 16) & 0xFFFF) as i16 as i32
}

/// Has the embedding app's root window tell `child`, an embedded surface's
/// window, what the app's state follows: `WM_ACTIVATEAPP`, which only
/// top-level windows get, and [`WM_NSH_ROOT`] when the root is shown,
/// hidden, minimized or restored, which `child`'s own messages do not say.
/// Returns the root it observes (`None` when `child` has none, or the root
/// is another thread's, which cannot be subclassed).
fn observe_root(child: HWND) -> Option<HWND> {
    // SAFETY: plain calls on live windows; the subclass is removed when
    // `child` is destroyed ([`unobserve_root`]) or the root is.
    unsafe {
        let root = GetAncestor(child, GA_ROOT);
        if root.is_invalid() || root == child {
            return None;
        }
        SetWindowSubclass(root, Some(root_proc), child.0 as usize, child.0 as usize)
            .as_bool()
            .then_some(root)
    }
}

/// `child` stops observing `root` ([`observe_root`]).
fn unobserve_root(root: HWND, child: HWND) {
    // SAFETY: removes the subclass `observe_root` installed, if the root
    // still has it.
    unsafe {
        let _ = RemoveWindowSubclass(root, Some(root_proc), child.0 as usize);
    }
}

/// The root window's messages, for the embedded window `child`
/// ([`observe_root`]), after the root's own handling.
unsafe extern "system" fn root_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    child: usize,
) -> LRESULT {
    // SAFETY: the root's own handling, then sends to `child`, which lives
    // until it removes this subclass.
    unsafe {
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        let child = HWND(child as *mut _);
        match msg {
            WM_ACTIVATEAPP => {
                SendMessageW(child, WM_ACTIVATEAPP, Some(wparam), Some(lparam));
            }
            WM_WINDOWPOSCHANGED => {
                SendMessageW(child, WM_NSH_ROOT, None, None);
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(root_proc), id);
            }
            _ => {}
        }
        result
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCCREATE {
        // SAFETY: `lparam` is the CREATESTRUCTW of this window; its
        // `lpCreateParams` is the `WindowData` box `create` leaked.
        unsafe {
            let cs = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize);
        }
    }
    let Some(data) = data(hwnd) else {
        // SAFETY: default handling.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    };
    if msg == WM_NCDESTROY {
        // SAFETY: frees the box stored at `WM_NCCREATE`, once.
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Box::from_raw(data as *const WindowData as *mut WindowData));
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
    }
    let surface = data.surface.upgrade();
    let terminal = surface
        .as_ref()
        .is_some_and(|surface| surface.terminal_active.get().is_some());
    if let Some(surface) = surface
        && let Some(result) = handle(&surface, data, hwnd, msg, wparam, lparam)
    {
        return result;
    }
    if msg == WM_DESTROY
        && let Some(root) = data.root.take()
    {
        unobserve_root(root, hwnd);
    }
    if msg == WM_DESTROY && data.top_level {
        let left = OPEN.with(|o| {
            o.set(o.get().saturating_sub(1));
            o.get()
        });
        if left == 0 && !terminal {
            // Terminal hosts reuse their UI thread; only a desktop app owns its message loop.
            // SAFETY: plain call.
            unsafe { PostQuitMessage(0) };
        }
    }
    // SAFETY: default handling.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Handles `msg` for `surface`; `None` for default handling.
fn handle(
    surface: &Rc<Surface>,
    data: &WindowData,
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<LRESULT> {
    // What the app's window API asks of a top-level window: its limits,
    // policies and state.
    if (data.top_level || data.window.is_some())
        && let Some(result) = window_api(surface, data, hwnd, msg, wparam, lparam)
    {
        return result;
    }
    // A window of the app's own handles its frame itself; its input is
    // the surface's, in its root view.
    let _root = match data.window {
        Some(id) => match crate::app_window::handle(surface, id, hwnd, msg, wparam, lparam) {
            Some(result) => return result,
            None => crate::app_window::enter(surface, id),
        },
        None => None,
    };
    let scale = match data.window {
        Some(_) => dpi(hwnd) as f32 / 96.0,
        None => surface.scale(),
    };
    let point = |l: LPARAM| (lo(l.0) as f32 / scale, hi(l.0) as f32 / scale);
    // Registered, so not a constant to match on.
    if msg == crate::notifications::taskbar_button_created() {
        if data.top_level {
            crate::notifications::button_created(surface);
        }
        crate::shell::button_created(hwnd);
        return None;
    }
    if data.top_level && msg == crate::tray::taskbar_created() {
        crate::tray::readd(hwnd);
        return None;
    }
    match msg {
        WM_NSH_WAKE => surface.drain(),
        WM_NSH_TICK => surface.tick(),
        WM_NSH_MENU => crate::chrome::show_popup(surface),
        crate::tray::WM_NSH_TRAY => {
            crate::tray::message(surface, hwnd, wparam, lparam);
            return Some(LRESULT(0));
        }
        WM_HOTKEY => {
            crate::global_shortcut::pressed(hwnd, wparam);
            return Some(LRESULT(0));
        }
        WM_NCCALCSIZE if data.top_level || data.window.is_some() => {
            return crate::chrome::nc_calc_size(hwnd, wparam, lparam);
        }
        WM_NCHITTEST if data.top_level || data.window.is_some() => {
            return crate::chrome::nc_hit_test(surface, hwnd, lparam);
        }
        WM_NCMOUSEMOVE | WM_NCMOUSELEAVE | WM_NCLBUTTONDOWN | WM_NCLBUTTONUP
        | WM_NCLBUTTONDBLCLK => {
            return crate::chrome::nc_mouse(surface, hwnd, msg, wparam, lparam);
        }
        WM_NCACTIVATE if data.top_level || data.window.is_some() => {
            return crate::chrome::nc_activate(surface, hwnd, wparam, lparam);
        }
        WM_NCPAINT if data.top_level => {
            // SAFETY: default handling, then the dark menu bar's line.
            let r = unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
            crate::chrome::paint_menu_bar_line(surface, hwnd);
            return Some(r);
        }
        // `WM_UAHDRAWMENU`, `WM_UAHDRAWMENUITEM`: the menu bar.
        0x0091 | 0x0092 => return crate::chrome::draw_menu_bar(surface, hwnd, msg, lparam),
        WM_COMMAND if (wparam.0 >> 16) & 0xFFFF == 0 && lparam.0 == 0 => {
            crate::chrome::menu_command(surface, (wparam.0 & 0xFFFF) as u16);
            return Some(LRESULT(0));
        }
        WM_NSH_PAINT => {
            // Drawn now: a pending `WM_PAINT` of the window would only draw
            // the same frame again.
            // SAFETY: a plain call on this window.
            let _ = unsafe { ValidateRect(Some(hwnd), None) };
            surface.paint();
            return Some(LRESULT(0));
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            // SAFETY: paired Begin / EndPaint on this window.
            unsafe { BeginPaint(hwnd, &mut ps) };
            surface.paint();
            // SAFETY: as above.
            let _ = unsafe { EndPaint(hwnd, &ps) };
            // Handled: `DefWindowProcW` would validate the window again and
            // drop an invalidation made while the frame was drawn, leaving
            // `invalid` set and no `WM_PAINT` to come (#1594).
            return Some(LRESULT(0));
        }
        WM_ERASEBKGND => return Some(LRESULT(1)),
        WM_SIZE if surface.terminal_active.get().is_none() => {
            // SAFETY: querying the foreground window does not retain its handle.
            surface.activation_changed(
                wparam.0 != SIZE_MINIMIZED as usize && unsafe { GetForegroundWindow() } == hwnd,
            );
            fill_background(surface, hwnd);
            sync_size(surface, hwnd);
            // The frame's material follows the zoom state.
            crate::shell::zoom_changed(hwnd);
            // Drawn now, so that the window never shows stretched or
            // stale pixels while it is resized.
            surface.paint();
        }
        WM_DPICHANGED if surface.terminal_active.get().is_none() => {
            // In full screen it keeps covering its monitor.
            if !is_full_screen(hwnd) {
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
            sync_size(surface, hwnd);
            crate::chrome::dpi_changed(surface);
            crate::tray::refresh(hwnd);
            crate::window_state::displays_changed(surface);
        }
        WM_MOUSEMOVE => {
            if crate::chrome::press_moved(surface, hwnd, lparam) {
                return Some(LRESULT(0));
            }
            if !data.tracking.replace(true) {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                // SAFETY: a valid structure for this window.
                let _ = unsafe { TrackMouseEvent(&mut track) };
            }
            crate::chrome::client_mouse_moved(surface, hwnd);
            let (x, y) = point(lparam);
            let held = held_buttons(wparam);
            crate::input::pointer(
                surface,
                mouse_event(PointerKind::Move, x, y, 0, held, 1, surface),
            );
        }
        WM_MOUSELEAVE => {
            data.tracking.set(false);
            crate::input::pointer(
                surface,
                mouse_event(PointerKind::Leave, -1.0, -1.0, 0, 0, 0, surface),
            );
        }
        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_LBUTTONDBLCLK
        | WM_RBUTTONDBLCLK | WM_MBUTTONDBLCLK | WM_XBUTTONDBLCLK => {
            if from_touch() {
                return Some(LRESULT(0));
            }
            let button = button_of(msg, wparam);
            if data.buttons.get() == 0 {
                // SAFETY: plain call on this window.
                unsafe { SetCapture(hwnd) };
            }
            data.buttons.set(data.buttons.get() | (1 << button));
            let clicks = count_clicks(data, lparam);
            let (x, y) = point(lparam);
            // The window takes the keyboard when clicked (an embedded
            // child window does not get it by itself), unless a web view
            // is clicked: it takes the keyboard itself.
            if !crate::input::raw_at(surface, x, y) {
                // SAFETY: plain call.
                let _ = unsafe { SetFocus(Some(hwnd)) };
            }
            let held = held_buttons(wparam);
            crate::input::pointer(
                surface,
                mouse_event(PointerKind::Down, x, y, button, held, clicks, surface),
            );
            return Some(LRESULT(0));
        }
        WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP => {
            if from_touch() {
                return Some(LRESULT(0));
            }
            let button = button_of(msg, wparam);
            if msg == WM_LBUTTONUP && crate::chrome::press_released(surface, hwnd, point(lparam)) {
                return Some(LRESULT(0));
            }
            data.buttons.set(data.buttons.get() & !(1 << button));
            if data.buttons.get() == 0 {
                // SAFETY: plain call.
                let _ = unsafe { ReleaseCapture() };
            }
            let (x, y) = point(lparam);
            let held = held_buttons(wparam);
            crate::input::pointer(
                surface,
                mouse_event(PointerKind::Up, x, y, button, held, 1, surface),
            );
            // X buttons must return TRUE.
            return Some(LRESULT(1));
        }
        WM_CAPTURECHANGED => {
            crate::chrome::press_cancelled(surface, hwnd);
            if data.buttons.replace(0) != 0 {
                crate::input::pointer(
                    surface,
                    mouse_event(PointerKind::Cancel, -1.0, -1.0, 0, 0, 0, surface),
                );
            }
        }
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            let mut p = POINT {
                x: lo(lparam.0),
                y: hi(lparam.0),
            };
            // SAFETY: plain call; wheel positions are in screen pixels.
            let _ = unsafe { ScreenToClient(hwnd, &mut p) };
            let delta = ((wparam.0 >> 16) & 0xFFFF) as i16 as f32;
            // One notch (120) scrolls three lines of 16 points, as the
            // system's default; deltas that are not whole notches come from
            // precision touchpads and high-resolution wheels.
            let points = delta / 120.0 * lines_per_notch() * 16.0;
            let precise = (delta as i32) % 120 != 0;
            let (dx, dy) = if msg == WM_MOUSEHWHEEL {
                (points, 0.0)
            } else {
                (0.0, -points)
            };
            crate::input::wheel(
                surface,
                WheelEvent {
                    x: p.x as f32 / scale,
                    y: p.y as f32 / scale,
                    dx,
                    dy,
                    precise,
                    modifiers: modifiers(),
                    time: surface.clock(),
                },
            );
            return Some(LRESULT(0));
        }
        WM_POINTERDOWN | WM_POINTERUPDATE | WM_POINTERUP | WM_POINTERCAPTURECHANGED => {
            let id = (wparam.0 & 0xFFFF) as u32;
            let mut info = POINTER_INFO::default();
            // SAFETY: a local out value; fails for ids that are gone.
            if unsafe { GetPointerInfo(id, &mut info) }.is_err() {
                return None;
            }
            // PT_MOUSE (4) comes as mouse messages.
            if info.pointerType.0 == 4 {
                return None;
            }
            let mut p = info.ptPixelLocation;
            // SAFETY: plain call.
            let _ = unsafe { ScreenToClient(hwnd, &mut p) };
            let kind = match msg {
                WM_POINTERDOWN => PointerKind::Down,
                WM_POINTERUP => PointerKind::Up,
                WM_POINTERCAPTURECHANGED => PointerKind::Cancel,
                _ => PointerKind::Move,
            };
            crate::input::pointer(
                surface,
                PointerEvent {
                    kind,
                    x: p.x as f32 / scale,
                    y: p.y as f32 / scale,
                    button: 0,
                    buttons: 0,
                    pointer: id + 2,
                    touch: info.pointerType.0 == 2,
                    pen: info.pointerType.0 == 3,
                    time: surface.clock(),
                    modifiers: modifiers(),
                    clicks: 1,
                },
            );
            return Some(LRESULT(0));
        }
        WM_SETCURSOR if lo(lparam.0) == HTCLIENT as i32 => {
            update_cursor(surface, hwnd, scale);
            return Some(LRESULT(1));
        }
        WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP => {
            let down = matches!(msg, WM_KEYDOWN | WM_SYSKEYDOWN);
            let event = KeyEvent {
                vk: wparam.0 as u16,
                down,
                repeat: down && (lparam.0 >> 30) & 1 == 1,
                modifiers: modifiers(),
            };
            let handled = crate::input::key(surface, event);
            if msg == WM_SYSKEYDOWN {
                data.sys_char.set(handled);
            }
            if handled {
                return Some(LRESULT(0));
            }
            // Alt+F4 and the system menu keep working.
        }
        WM_SYSCHAR if data.sys_char.replace(false) => return Some(LRESULT(0)),
        WM_CHAR => {
            let unit = wparam.0 as u16;
            if (0xD800..0xDC00).contains(&unit) {
                data.surrogate.set(unit);
                return Some(LRESULT(0));
            }
            let text = if (0xDC00..0xE000).contains(&unit) {
                String::from_utf16_lossy(&[data.surrogate.replace(0), unit])
            } else {
                String::from_utf16_lossy(&[unit])
            };
            crate::text_input::char_input(surface, &text);
            return Some(LRESULT(0));
        }
        WM_IME_SETCONTEXT
        | WM_IME_STARTCOMPOSITION
        | WM_IME_COMPOSITION
        | WM_IME_ENDCOMPOSITION
        | WM_IME_NOTIFY
        | WM_IME_REQUEST => {
            return crate::text_input::ime(surface, hwnd, msg, wparam, lparam);
        }
        WM_ACTIVATE => surface.activation_changed(activation_active(wparam)),
        WM_SETFOCUS if surface.terminal_active.get().is_none() => {
            crate::text_input::window_focus(surface, true)
        }
        WM_KILLFOCUS if surface.terminal_active.get().is_none() => {
            crate::text_input::window_focus(surface, false)
        }
        WM_GETOBJECT => return crate::access::get_object(surface, ROOT_ID, hwnd, wparam, lparam),
        // `WM_TIMECHANGE`: the time zone changed (`localeSettings()`).
        WM_SETTINGCHANGE
        | WM_THEMECHANGED
        | WM_SYSCOLORCHANGE
        | WM_DWMCOLORIZATIONCOLORCHANGED
        | WM_TIMECHANGE => {
            crate::system::settings_changed(surface);
            // The taskbar moved, or the work area changed.
            if msg == WM_SETTINGCHANGE {
                crate::window_state::displays_changed(surface);
            }
        }
        WM_ACTIVATEAPP => crate::system::app_activated(surface, wparam.0 != 0),
        // Shown, hidden, minimized or restored (before default handling
        // sends `WM_SIZE`).
        WM_WINDOWPOSCHANGED if data.top_level => {
            crate::window_state::report_main(surface);
            crate::system::lifecycle_changed(surface);
        }
        // An embedded surface's: its root window's ([`observe_root`]).
        WM_NSH_ROOT => crate::system::lifecycle_changed(surface),
        WM_DESTROY => {
            surface.activation_changed(false);
            crate::window_close::destroyed(surface);
            crate::tray::destroyed(hwnd);
            crate::global_shortcut::destroyed(hwnd);
            surface.stop();
            surface.set_hwnd(HWND::default());
        }
        _ => {}
    }
    None
}

/// The messages of a top-level window (the surface's or one of the app's
/// own) that the app's window API answers: `Some(result)` when handled
/// here (`Some(None)`: the system's default handling), `None` for the
/// window's other handling.
fn window_api(
    surface: &Rc<Surface>,
    data: &WindowData,
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<Option<LRESULT>> {
    let shell = &data.shell;
    let main = data.window.is_none();
    match msg {
        WM_GETMINMAXINFO => {
            // SAFETY: `lparam` is the window's MINMAXINFO.
            let info = unsafe { &mut *(lparam.0 as *mut MINMAXINFO) };
            let attrs = shell.attrs();
            let scale = dpi(hwnd) as f32 / 96.0;
            let (l, t, r, b) = frame_extents(hwnd);
            crate::chrome::nc_max_size(hwnd, info);
            let (min, max) = crate::shell::track_sizes(&attrs, scale, (l + r, t + b));
            match min {
                Some((x, y)) => info.ptMinTrackSize = POINT { x, y },
                // The main window stays big enough to show something.
                None if main => {
                    info.ptMinTrackSize = POINT {
                        x: (200.0 * scale) as i32,
                        y: (150.0 * scale) as i32,
                    }
                }
                None => {}
            }
            if let Some((x, y)) = max {
                info.ptMaxTrackSize = POINT { x, y };
            }
            Some(Some(LRESULT(0)))
        }
        WM_SYSCOMMAND => {
            let command = (wparam.0 & 0xFFF0) as u32;
            let attrs = shell.attrs();
            if !crate::shell::command_allowed(command, &attrs) {
                return Some(Some(LRESULT(0)));
            }
            if command == SC_CLOSE && shell.close_command.get().is_none() {
                shell.close_command.set(Some(sys_close(hwnd, lparam)));
            }
            None
        }
        WM_SYSKEYDOWN if wparam.0 == 0x73 => {
            // Alt+F4: the `WM_CLOSE` it makes says so.
            shell.close_key.set(true);
            None
        }
        WM_SYSKEYUP | WM_KEYUP => {
            shell.close_key.set(false);
            None
        }
        WM_MOUSEACTIVATE if !shell.attrs().focusable => Some(Some(LRESULT(MA_NOACTIVATE as isize))),
        WM_ENTERSIZEMOVE => {
            shell.sizing.set(true);
            None
        }
        WM_EXITSIZEMOVE => {
            shell.sizing.set(false);
            match data.window {
                Some(id) => crate::app_window::state_changed(surface, id),
                None => crate::window_state::report_main(surface),
            }
            None
        }
        WM_ACTIVATE => {
            let active = (wparam.0 & 0xFFFF) != 0;
            match data.window {
                Some(id) => {
                    crate::app_window::state_changed(surface, id);
                    if !active && shell.attrs().close_on_blur {
                        // Read once the activation settled: the window
                        // activated may be one of its own.
                        // SAFETY: posting to this live window.
                        let _ =
                            unsafe { PostMessageW(Some(hwnd), WM_NSH_BLUR, WPARAM(0), LPARAM(0)) };
                    }
                }
                None => crate::window_state::report_main(surface),
            }
            None
        }
        WM_WINDOWPOSCHANGED => {
            if let Some(id) = data.window {
                crate::app_window::state_changed(surface, id);
            }
            None
        }
        WM_DISPLAYCHANGE => {
            crate::window_state::displays_changed(surface);
            None
        }
        WM_CLOSE => {
            let reason = shell.take_close_reason();
            match data.window {
                Some(id) => crate::app_window::close_press(surface, id, reason),
                None => crate::window_close::close_press(surface, reason),
            }
            Some(Some(LRESULT(0)))
        }
        WM_NSH_CLOSE => {
            match data.window {
                Some(id) => crate::app_window::closed(
                    surface,
                    id,
                    nsh_core::desktop::WindowCloseCause::ClosePress,
                ),
                // SAFETY: the surface's own window, on its thread.
                None => {
                    let _ = unsafe { DestroyWindow(hwnd) };
                }
            }
            Some(Some(LRESULT(0)))
        }
        WM_NSH_CLOSE_HANDLED if main => {
            crate::window_close::handled(surface, wparam.0);
            Some(Some(LRESULT(0)))
        }
        WM_TIMER if main && crate::window_close::timed_out(surface, wparam.0) => {
            Some(Some(LRESULT(0)))
        }
        _ => None,
    }
}

/// Where the `SC_CLOSE` with `lparam` (the pointer, in screen pixels, or
/// 0 from the keyboard) came from.
fn sys_close(hwnd: HWND, lparam: LPARAM) -> crate::shell::SysClose {
    use crate::shell::SysClose;
    if lparam.0 == 0 || lparam.0 == -1 {
        return SysClose::Menu;
    }
    let p = POINT {
        x: lo(lparam.0),
        y: hi(lparam.0),
    };
    let mut rect = RECT::default();
    // SAFETY: plain queries on a live window.
    unsafe {
        if GetWindowRect(hwnd, &mut rect).is_err()
            || p.x < rect.left
            || p.x >= rect.right
            || p.y < rect.top
            || p.y >= rect.bottom
        {
            return SysClose::Elsewhere;
        }
        let code = SendMessageW(hwnd, WM_NCHITTEST, None, Some(lparam)).0 as u32;
        if code == HTCLOSE {
            SysClose::Button
        } else {
            SysClose::Menu
        }
    }
}

/// True when a mouse message was synthesized from touch or pen input,
/// which comes as `WM_POINTER*` messages too.
pub(crate) fn from_touch() -> bool {
    // MI_WP_SIGNATURE in the extra info marks synthesized mouse messages.
    // SAFETY: plain call.
    let extra = unsafe { GetMessageExtraInfo() }.0 as usize;
    extra & 0xFFFF_FF00 == 0xFF51_5700
}

fn button_of(msg: u32, wparam: WPARAM) -> u8 {
    match msg {
        WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK => 0,
        WM_RBUTTONDOWN | WM_RBUTTONUP | WM_RBUTTONDBLCLK => 1,
        WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MBUTTONDBLCLK => 2,
        // XBUTTON1 (back) is 3, XBUTTON2 (forward) 4.
        _ => {
            if (wparam.0 >> 16) & 0xFFFF == 1 {
                3
            } else {
                4
            }
        }
    }
}

fn count_clicks(data: &WindowData, lparam: LPARAM) -> u32 {
    // SAFETY: plain system queries.
    let (time, max_ms, max_x, max_y) = unsafe {
        (
            GetMessageTime() as u32,
            windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime(),
            GetSystemMetrics(SM_CXDOUBLECLK),
            GetSystemMetrics(SM_CYDOUBLECLK),
        )
    };
    let p = (lo(lparam.0), hi(lparam.0));
    let (last, lp, count) = data.last_press.get();
    let near = (p.0 - lp.0).abs() <= max_x / 2 && (p.1 - lp.1).abs() <= max_y / 2;
    let clicks = if near && time.wrapping_sub(last) <= max_ms {
        count + 1
    } else {
        1
    };
    data.last_press.set((time, p, clicks));
    clicks
}

/// The mouse buttons a mouse message's `wparam` holds (`MK_LBUTTON`,
/// `MK_RBUTTON`, `MK_MBUTTON`, `MK_XBUTTON1`, `MK_XBUTTON2`), bit `n` for
/// button `n` as [`PointerEvent::button`] numbers them.
fn held_buttons(wparam: WPARAM) -> u8 {
    const BUTTON_KEYS: [usize; 5] = [0x1, 0x2, 0x10, 0x20, 0x40];
    (0..5)
        .filter(|&b| wparam.0 & BUTTON_KEYS[b] != 0)
        .fold(0, |held, b| held | 1 << b)
}

fn mouse_event(
    kind: PointerKind,
    x: f32,
    y: f32,
    button: u8,
    buttons: u8,
    clicks: u32,
    surface: &Surface,
) -> PointerEvent {
    PointerEvent {
        kind,
        x,
        y,
        button,
        buttons,
        pointer: 1,
        touch: false,
        pen: false,
        time: surface.clock(),
        modifiers: modifiers(),
        clicks,
    }
}

/// A click of the primary button that the window held back
/// ([`crate::chrome::WindowPress`]): down at `from`, up at `to` (client
/// points).
pub(crate) fn click(surface: &Rc<Surface>, from: (f32, f32), to: (f32, f32)) {
    let down = mouse_event(PointerKind::Down, from.0, from.1, 0, 1, 1, surface);
    crate::input::pointer(surface, down);
    let up = mouse_event(PointerKind::Up, to.0, to.1, 0, 0, 1, surface);
    crate::input::pointer(surface, up);
}

/// The pointer moved over a view of the app's title bar that answers as
/// the frame (`windowDrag`, `windowControl`) at `at` (client points), or
/// left it (`None`): the views hear it as the client area's moves, for
/// their hover styles.
pub(crate) fn nc_pointer(surface: &Rc<Surface>, at: Option<(f32, f32)>) {
    let event = match at {
        Some((x, y)) => mouse_event(PointerKind::Move, x, y, 0, 0, 1, surface),
        None => mouse_event(PointerKind::Leave, -1.0, -1.0, 0, 0, 0, surface),
    };
    crate::input::pointer(surface, event);
}

/// Lines one wheel notch scrolls (the user's setting, 3 by default).
pub(crate) fn lines_per_notch() -> f32 {
    thread_local! {
        static LINES: Cell<Option<f32>> = const { Cell::new(None) };
    }
    if let Some(l) = LINES.with(Cell::get) {
        return l;
    }
    let mut lines: u32 = 3;
    // SAFETY: a u32 out value, as SPI_GETWHEELSCROLLLINES expects.
    let _ = unsafe {
        SystemParametersInfoW(
            SPI_GETWHEELSCROLLLINES,
            0,
            Some(&mut lines as *mut u32 as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    // "One screen at a time" (u32::MAX) scrolls a generous amount.
    let l = if lines == u32::MAX {
        20.0
    } else {
        lines.clamp(1, 20) as f32
    };
    LINES.with(|c| c.set(Some(l)));
    l
}

/// Sets the cursor of what is under the mouse in the client area.
fn update_cursor(surface: &Rc<Surface>, hwnd: HWND, scale: f32) {
    let mut p = POINT::default();
    // SAFETY: plain calls with local out values.
    unsafe {
        let _ = GetCursorPos(&mut p);
        let _ = ScreenToClient(hwnd, &mut p);
    }
    set_cursor(crate::input::cursor(
        surface,
        p.x as f32 / scale,
        p.y as f32 / scale,
    ));
}

/// A style batch does not trigger `WM_SETCURSOR`: apply its cursor at the
/// resting mouse, keeping other windows and non-client cursors intact.
pub(crate) fn refresh_cursor(surface: &Rc<Surface>) {
    let hwnd = surface.hwnd();
    let mut p = POINT::default();
    // SAFETY: plain calls with a local value; the hit test is the window's
    // own (a custom title bar's caption is not the client area).
    let over = unsafe {
        GetCursorPos(&mut p).is_ok()
            && WindowFromPoint(p) == hwnd
            && SendMessageW(
                hwnd,
                WM_NCHITTEST,
                None,
                Some(LPARAM(((p.y as u16 as isize) << 16) | p.x as u16 as isize)),
            )
            .0 as u32
                == HTCLIENT
    };
    if over {
        update_cursor(surface, hwnd, surface.scale());
    }
}

/// Sets the cursor shown over the window.
pub(crate) fn set_cursor(cursor: crate::input::Cursor) {
    use crate::input::Cursor;
    let id = match cursor {
        Cursor::Hidden => {
            // SAFETY: plain call; no cursor is shown over the window.
            unsafe { SetCursor(None) };
            return;
        }
        Cursor::Native(handle) => {
            // SAFETY: a cursor handle WebView2 gave (system cursors and its
            // own stay valid while it shows them).
            unsafe { SetCursor(Some(HCURSOR(handle as *mut _))) };
            return;
        }
        Cursor::Arrow => IDC_ARROW,
        Cursor::Hand => IDC_HAND,
        Cursor::Text => IDC_IBEAM,
        Cursor::Crosshair => IDC_CROSS,
        Cursor::Move => IDC_SIZEALL,
        Cursor::NotAllowed => IDC_NO,
        Cursor::ResizeEw => IDC_SIZEWE,
        Cursor::ResizeNs => IDC_SIZENS,
        Cursor::ResizeNwse => IDC_SIZENWSE,
        Cursor::ResizeNesw => IDC_SIZENESW,
        Cursor::Wait => IDC_WAIT,
        Cursor::Progress => IDC_APPSTARTING,
        Cursor::Help => IDC_HELP,
    };
    // SAFETY: system cursors are shared resources.
    unsafe {
        if let Ok(c) = LoadCursorW(None, id) {
            SetCursor(Some(c));
        }
    }
}

struct TickerShared {
    hwnd: isize,
    /// Frames are wanted.
    running: AtomicBool,
    /// A tick is posted and not handled yet.
    pending: AtomicBool,
    /// The ticker is dropped: the thread ends.
    quit: AtomicBool,
}

/// Paces animation frames to the compositor: while running, a thread waits
/// for each composition (`DwmFlush`) and posts [`WM_NSH_TICK`] unless the
/// last one is still in the queue. While nothing composes (`DwmFlush`
/// fails: a locked or remote session) no frames are shown, so none are
/// ticked: the thread asks again every [`COMPOSITION_RETRY`], and the
/// surface keeps the times its animations end with a timer meanwhile
/// (`Surface::keep_deadline`), which pauses the ticker once nothing is
/// left.
pub(crate) struct Ticker {
    shared: Arc<TickerShared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Ticker {
    /// A running ticker for `hwnd` (`None` without a window).
    pub(crate) fn start(hwnd: HWND) -> Option<Ticker> {
        if hwnd.is_invalid() {
            return None;
        }
        let shared = Arc::new(TickerShared {
            hwnd: hwnd.0 as isize,
            running: AtomicBool::new(true),
            pending: AtomicBool::new(false),
            quit: AtomicBool::new(false),
        });
        let s = shared.clone();
        let thread = std::thread::Builder::new()
            .name("nsh-ticker".into())
            .spawn(move || {
                while !s.quit.load(Ordering::Acquire) {
                    if !s.running.load(Ordering::Acquire) {
                        std::thread::park();
                        continue;
                    }
                    // SAFETY: plain call; fails when nothing composes (a
                    // locked or remote session).
                    if unsafe { DwmFlush() }.is_err() {
                        // No ticks at a rate of its own: that would be a
                        // second clock beside the compositor's. Dropping
                        // the ticker wakes it at once.
                        std::thread::park_timeout(COMPOSITION_RETRY);
                        continue;
                    }
                    if !s.pending.swap(true, Ordering::AcqRel) {
                        // SAFETY: posting is thread-safe.
                        let posted = unsafe {
                            PostMessageW(
                                Some(HWND(s.hwnd as *mut _)),
                                WM_NSH_TICK,
                                WPARAM(0),
                                LPARAM(0),
                            )
                        };
                        if posted.is_err() {
                            break;
                        }
                    }
                }
            })
            .ok()?;
        Some(Ticker {
            shared,
            thread: Some(thread),
        })
    }

    /// The posted tick was handled.
    pub(crate) fn ticked(&self) {
        self.shared.pending.store(false, Ordering::Release);
    }

    /// No frames are wanted until [`Ticker::resume`].
    pub(crate) fn pause(&self) {
        self.shared.pending.store(false, Ordering::Release);
        self.shared.running.store(false, Ordering::Release);
    }

    /// Frames are wanted again.
    pub(crate) fn resume(&self) {
        if !self.shared.running.swap(true, Ordering::AcqRel)
            && let Some(t) = &self.thread
        {
            t.thread().unpark();
        }
    }
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.shared.quit.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            t.thread().unpark();
            let _ = t.join();
        }
    }
}

/// The surface window `hwnd` (its own or one of the app's own) is of
/// (other modules' window procedures, tests, the test agent).
#[allow(dead_code)]
pub(crate) fn surface_of(hwnd: HWND) -> Option<Rc<Surface>> {
    data(hwnd).and_then(|d| d.surface.upgrade())
}

/// Keeps a value alive as long as the thread (tests and the app keep
/// their views here).
#[allow(dead_code)]
pub(crate) fn keep<T: 'static>(value: T) {
    thread_local! {
        static KEPT: RefCell<Vec<Box<dyn std::any::Any>>> = RefCell::default();
    }
    KEPT.with(|k| k.borrow_mut().push(Box::new(value)));
}

fn activation_active(wparam: WPARAM) -> bool {
    (wparam.0 & 0xffff) != WA_INACTIVE as usize && ((wparam.0 >> 16) & 0xffff) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        /// What the test's windows heard: window, message, `wparam` and
        /// `lparam` (the root's own procedure records too).
        static HEARD: RefCell<Vec<(isize, u32, usize, isize)>> = const { RefCell::new(Vec::new()) };
    }

    unsafe extern "system" fn recording_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if matches!(msg, WM_ACTIVATEAPP | WM_NSH_ROOT) {
            HEARD.with(|h| {
                h.borrow_mut()
                    .push((hwnd.0 as isize, msg, wparam.0, lparam.0))
            });
        }
        // SAFETY: default handling.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    #[test]
    fn an_embedded_window_hears_its_root_window() {
        // SAFETY: a class registered and two windows made on this thread,
        // never shown, destroyed at the end.
        unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(recording_proc),
                hInstance: instance(),
                lpszClassName: w!("NshTestEmbedding"),
                ..Default::default()
            };
            RegisterClassExW(&class);
            let make = |style, parent| {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("NshTestEmbedding"),
                    w!(""),
                    style,
                    0,
                    0,
                    100,
                    100,
                    parent,
                    None,
                    Some(instance()),
                    None,
                )
                .unwrap()
            };
            let root = make(WS_OVERLAPPEDWINDOW, None);
            let child = make(WS_CHILD, Some(root));
            assert_eq!(observe_root(child), Some(root));
            // What the child heard. The desktop may send activations of its
            // own: the test's carry a thread no app has (`WM_ACTIVATEAPP`'s
            // `lparam`).
            const MARK: isize = 0x004E_5348;
            let id = child.0 as isize;
            let ours = |heard: &[(isize, u32, usize, isize)]| -> Vec<usize> {
                heard
                    .iter()
                    .filter(|h| h.0 == id && h.1 == WM_ACTIVATEAPP && h.3 == MARK)
                    .map(|h| h.2)
                    .collect()
            };
            let moved = |heard: &[(isize, u32, usize, isize)]| {
                heard.iter().any(|h| h.0 == id && h.1 == WM_NSH_ROOT)
            };
            let resize = |width, height| {
                SetWindowPos(
                    root,
                    None,
                    0,
                    0,
                    width,
                    height,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
                )
                .unwrap()
            };
            // The app activated, then another app.
            SendMessageW(root, WM_ACTIVATEAPP, Some(WPARAM(1)), Some(LPARAM(MARK)));
            SendMessageW(root, WM_ACTIVATEAPP, Some(WPARAM(0)), Some(LPARAM(MARK)));
            let heard = HEARD.with(|h| h.take());
            assert_eq!(ours(&heard), [1, 0], "{heard:?}");
            // Its position changed, as when it is minimized, hidden or
            // restored.
            resize(200, 150);
            let heard = HEARD.with(|h| h.take());
            assert!(moved(&heard), "{heard:?}");
            // Once it stops observing, neither reaches it.
            unobserve_root(root, child);
            SendMessageW(root, WM_ACTIVATEAPP, Some(WPARAM(1)), Some(LPARAM(MARK)));
            resize(300, 200);
            let heard = HEARD.with(|h| h.take());
            assert!(ours(&heard).is_empty() && !moved(&heard), "{heard:?}");
            DestroyWindow(root).unwrap();
        }
    }

    /// Asks once, while it is drawn, for the window to be drawn again, as a
    /// web view that leaves does. Counts its frames.
    struct AsksOnce {
        surface: std::rc::Weak<Surface>,
        armed: Cell<bool>,
        drawn: Cell<u32>,
    }

    impl crate::view::Hosted for AsksOnce {
        fn draw(&self, _cx: &mut crate::render::DrawCx<'_>, _size: (f32, f32)) {
            self.drawn.set(self.drawn.get() + 1);
            if self.armed.replace(false)
                && let Some(surface) = self.surface.upgrade()
            {
                surface.invalidate();
            }
        }
    }

    fn pump_for(ms: u64) {
        let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        let mut msg = MSG::default();
        while std::time::Instant::now() < until {
            // SAFETY: the test thread's own queue.
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn a_paint_asked_for_while_drawing_comes() {
        if crate::gfx::get().is_err() {
            return;
        }
        let surface = Surface::new(Default::default());
        let hwnd = create(&surface, "NSH paint test", (200, 150), None, false).unwrap();
        let asks = Rc::new(AsksOnce {
            surface: Rc::downgrade(&surface),
            armed: Cell::new(false),
            drawn: Cell::new(0),
        });
        let item: Rc<dyn crate::view::Hosted> = asks.clone();
        surface
            .root
            .set_native(&item, crate::geom::rect(0.0, 0.0, 50.0, 50.0));
        // SAFETY: plain calls on the test's window.
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        pump_for(200);
        let before = asks.drawn.get();
        asks.armed.set(true);
        // SAFETY: as above.
        unsafe {
            let _ = InvalidateRect(Some(hwnd), None, false);
            let _ = UpdateWindow(hwnd);
        }
        assert_eq!(asks.drawn.get() - before, 1, "drawn by the WM_PAINT");
        pump_for(200);
        let after = asks.drawn.get() - before;
        // SAFETY: as above.
        unsafe { DestroyWindow(hwnd).unwrap() };
        assert!(after >= 2, "the frame asked for while drawing never came");
    }

    #[test]
    fn minimized_activation_does_not_report_foreground() {
        assert!(activation_active(WPARAM(WA_ACTIVE as usize)));
        assert!(!activation_active(WPARAM(WA_INACTIVE as usize)));
        assert!(!activation_active(WPARAM((1 << 16) | WA_ACTIVE as usize)));
        assert!(!activation_active(WPARAM(
            (1 << 16) | WA_CLICKACTIVE as usize
        )));
    }

    #[test]
    fn held_buttons_number_the_buttons_as_presses_do() {
        assert_eq!(held_buttons(WPARAM(0)), 0);
        // MK_LBUTTON with MK_SHIFT and MK_CONTROL, which are no buttons.
        assert_eq!(held_buttons(WPARAM(0x1 | 0x4 | 0x8)), 0b1);
        // MK_RBUTTON, MK_MBUTTON, MK_XBUTTON1, MK_XBUTTON2.
        assert_eq!(held_buttons(WPARAM(0x2)), 0b10);
        assert_eq!(held_buttons(WPARAM(0x10)), 0b100);
        assert_eq!(held_buttons(WPARAM(0x20)), 0b1000);
        assert_eq!(held_buttons(WPARAM(0x40)), 0b1_0000);
    }

    unsafe extern "system" fn plain_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // SAFETY: default handling.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// A window the app did not make (the foreground window can be another
    /// app's) keeps what it likes in `GWLP_USERDATA`: it is never read as a
    /// `WindowData`, which crashed the test agent's typing on Windows on Arm.
    #[test]
    fn a_window_of_another_class_has_no_window_data() {
        // SAFETY: a class registered and a window made on this thread, never
        // shown, destroyed at the end; its user data is set and never read.
        unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(plain_proc),
                hInstance: instance(),
                lpszClassName: w!("NshTestForeign"),
                ..Default::default()
            };
            RegisterClassExW(&class);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("NshTestForeign"),
                w!(""),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                100,
                100,
                None,
                None,
                Some(instance()),
                None,
            )
            .unwrap();
            // An address nothing is mapped at, as another app's pointer is.
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0x0000_7FFF_FFFF_0000);
            assert!(surface_of(hwnd).is_none());
            assert_eq!(app_window_root(hwnd), None);
            assert!(shell(hwnd).is_none());
            DestroyWindow(hwnd).unwrap();
        }
        assert!(surface_of(HWND::default()).is_none());
    }
}
