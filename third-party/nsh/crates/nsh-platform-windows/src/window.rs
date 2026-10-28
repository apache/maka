//! The Win32 side of a surface: its window, the window procedure, wake-ups
//! from other threads and the frame ticker.
//!
//! - Each surface draws into one window ([`create`]): top-level for
//!   [`crate::run_app`], or a child of the embedding app's window.
//!   `GWLP_USERDATA` holds a [`WindowData`] that finds the surface.
//! - The engine thread wakes the surface with [`WM_NSH_WAKE`] ([`wake`]);
//!   worker threads run closures on the main thread with [`invoke`] (a
//!   message-only dispatcher window).
//! - [`Ticker`] paces animation frames: a thread waits for the compositor's
//!   next frame (`DwmFlush`) and posts [`WM_NSH_TICK`], one at a time.
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
        atomic::{AtomicBool, AtomicIsize, Ordering},
    },
};

use windows::{
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::{
            Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmFlush, DwmSetWindowAttribute},
            Gdi::{
                BeginPaint, EndPaint, GetMonitorInfoW, InvalidateRect, MONITOR_DEFAULTTONEAREST,
                MONITORINFO, MonitorFromWindow, PAINTSTRUCT, ScreenToClient, UpdateWindow,
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
/// A closure from another thread ([`invoke`]); `lparam` owns it.
const WM_NSH_CALL: u32 = WM_APP + 3;
/// A context menu to show ([`crate::chrome::show_popup`]).
pub(crate) const WM_NSH_MENU: u32 = WM_APP + 4;

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
}

thread_local! {
    /// Top-level windows open on this thread.
    static OPEN: Cell<usize> = const { Cell::new(0) };
}

/// The dispatcher window of the main thread ([`invoke`]).
static DISPATCHER: AtomicIsize = AtomicIsize::new(0);

fn instance() -> HINSTANCE {
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
            DISPATCHER.store(hwnd.0 as isize, Ordering::Release);
        }
    }
}

/// Makes the window of `surface`: a top-level window of `size` points
/// titled `title`, or a child of `parent` filling it.
pub(crate) fn create(
    surface: &Rc<Surface>,
    title: &str,
    size: (i32, i32),
    parent: Option<HWND>,
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
    });
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let (style, ex_style) = match parent {
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

/// The window is in full screen ([`toggle_full_screen`]).
pub(crate) fn is_full_screen(hwnd: HWND) -> bool {
    data(hwnd).is_some_and(|d| {
        let placement = d.windowed.take();
        let full = placement.is_some();
        d.windowed.set(placement);
        full
    })
}

/// Takes a top-level window to full screen on its monitor (no frame, over
/// the taskbar), or back to where it was.
pub(crate) fn toggle_full_screen(hwnd: HWND) {
    toggle_full_screen_inner(hwnd);
    // Neither the menu bar nor a hidden title bar's area show in full
    // screen.
    if let Some(surface) = surface_of(hwnd) {
        crate::chrome::full_screen_changed(&surface);
    }
}

fn toggle_full_screen_inner(hwnd: HWND) {
    let Some(data) = data(hwnd) else { return };
    if !data.top_level {
        return;
    }
    let frame = WS_OVERLAPPEDWINDOW.0 as isize;
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
                SetWindowLongPtrW(hwnd, GWL_STYLE, style & !frame);
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
                SetWindowLongPtrW(hwnd, GWL_STYLE, style | frame);
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

/// Shows a top-level window.
pub(crate) fn show(hwnd: HWND) {
    // SAFETY: plain calls on a live window.
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = UpdateWindow(hwnd);
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

/// Asks for `WM_PAINT`.
pub(crate) fn invalidate(hwnd: HWND) {
    if !hwnd.is_invalid() {
        // SAFETY: a plain call on a window of this thread.
        let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
    }
}

/// Runs `f` on the main thread (from any thread), in the message loop.
/// Dropped when there is no main thread (no window was ever made).
pub(crate) fn invoke(f: impl FnOnce() + Send + 'static) {
    let hwnd = DISPATCHER.load(Ordering::Acquire);
    if hwnd == 0 {
        return;
    }
    let boxed: Box<Box<dyn FnOnce() + Send>> = Box::new(Box::new(f));
    let raw = Box::into_raw(boxed);
    // SAFETY: the dispatcher takes ownership of `raw` when it gets the
    // message; if posting fails it is freed here.
    unsafe {
        if PostMessageW(
            Some(HWND(hwnd as *mut _)),
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

unsafe extern "system" fn dispatch_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NSH_CALL {
        // SAFETY: `invoke` posted a leaked box of this type.
        let f = unsafe { Box::from_raw(lparam.0 as *mut Box<dyn FnOnce() + Send>) };
        f();
        return LRESULT(0);
    }
    // SAFETY: default handling.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
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

fn data(hwnd: HWND) -> Option<&'static WindowData> {
    // SAFETY: the pointer was stored by `WM_NCCREATE` and is freed only in
    // `WM_NCDESTROY`, after which the slot is cleared.
    unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowData).as_ref() }
}

fn lo(l: isize) -> i32 {
    (l & 0xFFFF) as i16 as i32
}

fn hi(l: isize) -> i32 {
    ((l >> 16) & 0xFFFF) as i16 as i32
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
    if let Some(surface) = surface
        && let Some(result) = handle(&surface, data, hwnd, msg, wparam, lparam)
    {
        return result;
    }
    if msg == WM_DESTROY && data.top_level {
        let left = OPEN.with(|o| {
            o.set(o.get().saturating_sub(1));
            o.get()
        });
        if left == 0 {
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
    let scale = surface.scale();
    let point = |l: LPARAM| (lo(l.0) as f32 / scale, hi(l.0) as f32 / scale);
    match msg {
        WM_NSH_WAKE => surface.drain(),
        WM_NSH_TICK => surface.tick(),
        WM_NSH_MENU => crate::chrome::show_popup(surface),
        WM_NCCALCSIZE => return crate::chrome::nc_calc_size(surface, hwnd, wparam, lparam),
        WM_NCHITTEST if data.top_level => {
            return crate::chrome::nc_hit_test(surface, hwnd, lparam);
        }
        WM_NCMOUSEMOVE | WM_NCMOUSELEAVE | WM_NCLBUTTONDOWN | WM_NCLBUTTONUP
        | WM_NCLBUTTONDBLCLK => {
            return crate::chrome::nc_mouse(surface, hwnd, msg, wparam);
        }
        WM_NCACTIVATE if data.top_level => {
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
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            // SAFETY: paired Begin / EndPaint on this window.
            unsafe { BeginPaint(hwnd, &mut ps) };
            surface.paint();
            // SAFETY: as above.
            let _ = unsafe { EndPaint(hwnd, &ps) };
        }
        WM_ERASEBKGND => return Some(LRESULT(1)),
        WM_SIZE => {
            sync_size(surface, hwnd);
            // Drawn now, so that the window never shows stretched or
            // stale pixels while it is resized.
            surface.paint();
        }
        WM_DPICHANGED => {
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
            sync_size(surface, hwnd);
        }
        WM_GETMINMAXINFO => {
            // SAFETY: `lparam` is the window's MINMAXINFO.
            let info = unsafe { &mut *(lparam.0 as *mut MINMAXINFO) };
            let s = dpi(hwnd) as f32 / 96.0;
            info.ptMinTrackSize = POINT {
                x: (200.0 * s) as i32,
                y: (150.0 * s) as i32,
            };
            return Some(LRESULT(0));
        }
        WM_MOUSEMOVE => {
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
            crate::chrome::client_mouse_moved(surface);
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
            let mut p = POINT::default();
            // SAFETY: plain calls with local out values.
            unsafe {
                let _ = GetCursorPos(&mut p);
                let _ = ScreenToClient(hwnd, &mut p);
            }
            let cursor = crate::input::cursor(surface, p.x as f32 / scale, p.y as f32 / scale);
            set_cursor(cursor);
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
        WM_SETFOCUS => crate::text_input::window_focus(surface, true),
        WM_KILLFOCUS => crate::text_input::window_focus(surface, false),
        WM_GETOBJECT => return crate::access::get_object(surface, hwnd, wparam, lparam),
        WM_SETTINGCHANGE | WM_THEMECHANGED | WM_SYSCOLORCHANGE | WM_DWMCOLORIZATIONCOLORCHANGED => {
            crate::system::settings_changed(surface);
        }
        WM_DESTROY => {
            surface.stop();
            surface.set_hwnd(HWND::default());
        }
        _ => {}
    }
    None
}

/// True when a mouse message was synthesized from touch or pen input,
/// which comes as `WM_POINTER*` messages too.
fn from_touch() -> bool {
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
/// last one is still in the queue.
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
                    // SAFETY: plain call; fails when composition is off
                    // (a locked or remote session), then a timer paces.
                    if unsafe { DwmFlush() }.is_err() {
                        std::thread::sleep(std::time::Duration::from_millis(16));
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

/// The surface of a window, if it has one (other modules' window
/// procedures, tests).
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
