//! What the app reads of its windows and the displays (`WindowRef.state()`,
//! `windowState()`, `displays()`) and the requests that move them
//! (`setMode`, `setBounds`, `setPlacement`, `center`), for any top-level
//! window: the main one, whose state goes into the environment (the
//! engine settles its moves), and the app's own ([`crate::app_window`]),
//! which report theirs as events.
//!
//! Screen points are laid out per monitor ([`screens`]): a window's
//! rectangle converts on the monitor it is on, at that monitor's scale.

mod screens;

use std::cell::RefCell;

use nsh_core::{
    desktop::{Display, DisplayId, WindowFrame, WindowMode, WindowPlacement, WindowState},
    geometry::{Bounds, Points, point},
};
pub(crate) use screens::{Screen, Screens};
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{ClientToScreen, MONITOR_DEFAULTTONEAREST, MonitorFromWindow},
    UI::WindowsAndMessaging::*,
};

use crate::{surface::Surface, window};

thread_local! {
    /// The monitors, read once and again when they change ([`refresh`]).
    static SCREENS: RefCell<Option<Screens>> = const { RefCell::new(None) };
}

/// Runs `f` with the monitors.
fn with_screens<R>(f: impl FnOnce(&Screens) -> R) -> R {
    SCREENS.with(|s| {
        let mut s = s.borrow_mut();
        f(s.get_or_insert_with(Screens::read))
    })
}

/// Reads the monitors again (`WM_DISPLAYCHANGE`, `WM_DPICHANGED`,
/// `WM_SETTINGCHANGE`): whether the displays changed.
pub(crate) fn refresh() -> bool {
    let next = Screens::read();
    SCREENS.with(|s| {
        let mut s = s.borrow_mut();
        let changed = s
            .as_ref()
            .is_none_or(|old| old.displays() != next.displays());
        *s = Some(next);
        changed
    })
}

/// The displays.
pub(crate) fn displays() -> Vec<Display> {
    with_screens(Screens::displays)
}

/// A top-level window, not a child of the embedding app's.
pub(crate) fn top_level(hwnd: HWND) -> bool {
    // SAFETY: a plain query of a window of this thread.
    !hwnd.is_invalid() && unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32 & WS_CHILD.0 == 0
}

fn placement_of(hwnd: HWND) -> Option<WINDOWPLACEMENT> {
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    // SAFETY: a query with a local out value.
    unsafe { GetWindowPlacement(hwnd, &mut placement) }
        .is_ok()
        .then_some(placement)
}

fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    // SAFETY: a query with a local out value.
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .is_ok()
        .then_some(rect)
}

/// What a window's rectangle takes beyond what shows of it, in pixels:
/// left, top, right, bottom.
pub(crate) type Margins = (i32, i32, i32, i32);

/// What shows of `hwnd`: its window rectangle without the part of its
/// frame that does not show. Windows 10 and 11 keep a window's resize
/// borders outside its visible edge (left, right and bottom; a few pixels
/// that take the pointer but draw nothing), and a maximized window's frame
/// hangs over its monitor's edges. A window's bounds are what the user
/// sees of it, as on the other platforms.
fn visible_rect(hwnd: HWND) -> Option<RECT> {
    let rect = window_rect(hwnd)?;
    Some(inset(rect, margins(hwnd, rect)))
}

/// What `hwnd`'s rectangle `rect` takes beyond its visible edge now.
fn margins(hwnd: HWND, rect: RECT) -> Margins {
    if window::is_full_screen(hwnd) {
        return (0, 0, 0, 0);
    }
    if zoomed(hwnd) {
        // What hangs over the work area. The compositor's frame bounds
        // follow the window's a moment later: as the window maximizes,
        // when its state is read, they are still its normal frame's.
        return work_area_of(hwnd).map_or((0, 0, 0, 0), |work| {
            (
                (work.left - rect.left).max(0),
                (work.top - rect.top).max(0),
                (rect.right - work.right).max(0),
                (rect.bottom - work.bottom).max(0),
            )
        });
    }
    frame_margins(hwnd, rect)
        .or_else(|| window::normal_margins(hwnd, window::dpi(hwnd)))
        .unwrap_or_else(|| crate::chrome::invisible_frame(hwnd))
}

/// The work area of the monitor `hwnd` is on, in pixels.
fn work_area_of(hwnd: HWND) -> Option<RECT> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: plain calls with a local out value.
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        GetMonitorInfoW(monitor, &mut info).as_bool()
    }
    .then_some(info.rcWork)
}

/// What `rect` takes beyond the frame the desktop compositor shows of
/// `hwnd`: `None` without its answer, or with one that is not of this
/// rectangle (a frame not inside it, or past a frame's width from it).
fn frame_margins(hwnd: HWND, rect: RECT) -> Option<Margins> {
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    let mut frame = RECT::default();
    // SAFETY: a RECT out value, as the attribute is.
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .is_ok();
    let m = (
        frame.left - rect.left,
        frame.top - rect.top,
        rect.right - frame.right,
        rect.bottom - frame.bottom,
    );
    // A frame's resize border is a few pixels at most (8 at 100%), the
    // same on the left and the right: anything else is a frame the
    // compositor has not caught up with yet (one that just moved).
    let limit = 8 * window::dpi(hwnd) as i32 / 96 + 1;
    let fits = |v: i32| (0..=limit).contains(&v);
    (ok && m.0 == m.2 && fits(m.0) && fits(m.1) && fits(m.3)).then_some(m)
}

/// What `hwnd`'s rectangle takes beyond its visible edge in the normal
/// mode: what its normal rectangle (`rcNormalPosition`, a whole window
/// rectangle) gives and takes. A maximized or full screen window's frame
/// is not its normal one; what it was the last time the window was in
/// the normal mode is ([`crate::window::normal_margins`]), else what the
/// system's frame leaves invisible.
fn normal_margins(hwnd: HWND) -> Margins {
    let dpi = window::dpi(hwnd);
    if !zoomed(hwnd)
        && !window::is_full_screen(hwnd)
        && let Some(m) = window_rect(hwnd).and_then(|rect| frame_margins(hwnd, rect))
    {
        window::set_normal_margins(hwnd, m, dpi);
        return m;
    }
    window::normal_margins(hwnd, dpi).unwrap_or_else(|| crate::chrome::invisible_frame(hwnd))
}

fn inset(rect: RECT, (l, t, r, b): Margins) -> RECT {
    RECT {
        left: rect.left + l,
        top: rect.top + t,
        right: rect.right - r,
        bottom: rect.bottom - b,
    }
}

fn outset(rect: RECT, (l, t, r, b): Margins) -> RECT {
    inset(rect, (-l, -t, -r, -b))
}

/// `WINDOWPLACEMENT`'s rectangles are in workspace coordinates (from the
/// work area's corner) for windows that are not tool windows: the offset
/// to screen pixels on `screen`.
fn workspace_offset(hwnd: HWND, screen: &Screen) -> (i32, i32) {
    // SAFETY: a plain query.
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        (0, 0)
    } else {
        (
            screen.work.left - screen.native.left,
            screen.work.top - screen.native.top,
        )
    }
}

fn offset(rect: RECT, (dx, dy): (i32, i32)) -> RECT {
    RECT {
        left: rect.left + dx,
        top: rect.top + dy,
        right: rect.right + dx,
        bottom: rect.bottom + dy,
    }
}

/// The monitor `hwnd` is on.
fn screen_of(screens: &Screens, hwnd: HWND, rect: RECT) -> Option<Screen> {
    // SAFETY: a plain query.
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    screens
        .of(monitor)
        .or_else(|| screens.native_screen(rect))
        .cloned()
}

/// What `hwnd` is now: its mode, bounds, normal bounds and display.
pub(crate) fn state(hwnd: HWND) -> Option<WindowState> {
    if !top_level(hwnd) {
        return None;
    }
    let rect = visible_rect(hwnd)?;
    let placement = placement_of(hwnd)?;
    let normal_margins = normal_margins(hwnd);
    with_screens(|screens| {
        let screen = screen_of(screens, hwnd, rect)?;
        // SAFETY: plain queries on a live window.
        let (minimized, shown) =
            unsafe { (IsIconic(hwnd).as_bool(), IsWindowVisible(hwnd).as_bool()) };
        // In a background app: the window that would have the keyboard.
        let foreground = window::foreground() == hwnd;
        let full = window::is_full_screen(hwnd);
        let maximized = !full
            && (zoomed(hwnd) || (minimized && placement.flags.contains(WPF_RESTORETOMAXIMIZED)));
        let mode = if full {
            WindowMode::FullScreen
        } else if maximized {
            WindowMode::Maximized
        } else {
            WindowMode::Normal
        };
        // Where it is, or returns to, in the normal mode.
        let normal = match window::windowed(hwnd) {
            Some(windowed) if full => {
                let on = screens
                    .native_screen(windowed.rcNormalPosition)
                    .cloned()
                    .unwrap_or_else(|| screen.clone());
                let rect = offset(windowed.rcNormalPosition, workspace_offset(hwnd, &on));
                inset(rect, normal_margins)
            }
            _ if !minimized && !maximized && !full => rect,
            _ => inset(
                offset(placement.rcNormalPosition, workspace_offset(hwnd, &screen)),
                normal_margins,
            ),
        };
        let normal_bounds = screens
            .native_screen(normal)
            .unwrap_or(&screen)
            .bounds(normal);
        let mut state = WindowState::new(
            screen.bounds(rect),
            WindowPlacement::new(mode, normal_bounds),
        );
        state.mode = mode;
        state.minimized = minimized;
        state.visible = shown && !minimized;
        // A window hidden while it had the keyboard can stay the foreground
        // one: the user sees nothing take keys there.
        state.focused = foreground && shown;
        state.content_bounds = content_bounds(hwnd, &screen).unwrap_or(state.bounds);
        state.display = Some(screen.display.id);
        state.scale_factor = window::dpi(hwnd) as f32 / 96.0;
        Some(state)
    })
}

/// The client area of `hwnd` in screen points.
fn content_bounds(hwnd: HWND, screen: &Screen) -> Option<Bounds<Points>> {
    let mut client = RECT::default();
    let mut origin = POINT::default();
    // SAFETY: queries with local out values.
    unsafe {
        GetClientRect(hwnd, &mut client).ok()?;
        ClientToScreen(hwnd, &mut origin).ok().ok()?;
    }
    Some(screen.bounds(offset(client, (origin.x, origin.y))))
}

fn zoomed(hwnd: HWND) -> bool {
    // SAFETY: a plain query.
    unsafe { IsZoomed(hwnd) }.as_bool()
}

/// The main window's state, into the environment (the engine holds back
/// moves until they settle).
pub(crate) fn report_main(surface: &Surface) {
    let hwnd = surface.hwnd();
    if !top_level(hwnd) {
        return;
    }
    let state = state(hwnd);
    let mut env = surface.environment.get();
    if env.window_state != state {
        env.window_state = state;
        surface.set_environment(env);
    }
}

/// The displays changed (or may have): tells the engine, and reports the
/// main window again.
pub(crate) fn displays_changed(surface: &Surface) {
    if refresh() {
        let displays = displays();
        surface.control(|c| c.set_displays(displays));
    }
    report_main(surface);
}

/// Puts `hwnd` in `mode` (doing it again changes nothing). A minimized
/// window stays minimized and comes back in that mode.
pub(crate) fn set_mode(hwnd: HWND, mode: WindowMode) {
    if !top_level(hwnd) {
        return;
    }
    // SAFETY: plain calls on a live window.
    unsafe {
        if IsIconic(hwnd).as_bool() && mode != WindowMode::FullScreen {
            if let Some(mut placement) = placement_of(hwnd) {
                if mode == WindowMode::Maximized {
                    placement.flags |= WPF_RESTORETOMAXIMIZED;
                } else {
                    placement.flags &= !WPF_RESTORETOMAXIMIZED;
                }
                placement.showCmd = SW_SHOWMINIMIZED.0 as u32;
                let _ = SetWindowPlacement(hwnd, &placement);
            }
            return;
        }
        match mode {
            WindowMode::FullScreen => {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
                window::set_full_screen(hwnd, true);
            }
            WindowMode::Maximized => {
                window::set_full_screen(hwnd, false);
                if !zoomed(hwnd) {
                    let _ = ShowWindow(hwnd, SW_MAXIMIZE);
                }
            }
            WindowMode::Normal => {
                window::set_full_screen(hwnd, false);
                if zoomed(hwnd) {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
            }
        }
    }
}

/// Moves and sizes `hwnd` (screen points; a field left out keeps its
/// value), out of full screen and maximized first.
pub(crate) fn set_bounds(hwnd: HWND, frame: &WindowFrame) {
    if !top_level(hwnd) {
        return;
    }
    if frame.x.is_none() && frame.y.is_none() && frame.width.is_none() && frame.height.is_none() {
        return;
    }
    window::set_full_screen(hwnd, false);
    // SAFETY: plain calls on a live window.
    unsafe {
        if zoomed(hwnd) || IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
    }
    let Some(rect) = window_rect(hwnd) else {
        return;
    };
    let margins = margins(hwnd, rect);
    let visible = inset(rect, margins);
    let target = with_screens(|screens| {
        let current = screen_of(screens, hwnd, visible)?;
        let bounds = moved(current.bounds(visible), frame);
        let target = screens.logical_screen(bounds).unwrap_or(&current);
        Some(outset(target.native_bounds(bounds), margins))
    });
    let Some(target) = target else {
        return;
    };
    let mut flags = SWP_NOZORDER | SWP_NOACTIVATE;
    if frame.x.is_none() && frame.y.is_none() {
        flags |= SWP_NOMOVE;
    }
    // SAFETY: a plain call on a live window; SWP_NOZORDER keeps its level.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            target.left,
            target.top,
            target.right - target.left,
            target.bottom - target.top,
            flags,
        )
    };
}

/// `bounds` with what `frame` gives.
pub(crate) fn moved(mut bounds: Bounds<Points>, frame: &WindowFrame) -> Bounds<Points> {
    let finite = |v: Option<Points>| v.filter(|v| v.0.is_finite());
    let positive = |v: Option<Points>| finite(v).filter(|v| v.0 >= 1.0);
    if let Some(x) = finite(frame.x) {
        bounds.origin.x = x;
    }
    if let Some(y) = finite(frame.y) {
        bounds.origin.y = y;
    }
    if let Some(w) = positive(frame.width) {
        bounds.size.width = w;
    }
    if let Some(h) = positive(frame.height) {
        bounds.size.height = h;
    }
    bounds
}

/// Puts `hwnd` in `placement`'s mode with its normal bounds (already
/// fitted on the displays by the core). A hidden window stays hidden and
/// shows in that placement.
pub(crate) fn set_placement(hwnd: HWND, placement: WindowPlacement) {
    if !top_level(hwnd) {
        return;
    }
    let Some(mut native) = placement_of(hwnd) else {
        return;
    };
    let Some(normal) = with_screens(|screens| {
        let screen = screens.logical_screen(placement.bounds)?.clone();
        let rect = outset(screen.native_bounds(placement.bounds), normal_margins(hwnd));
        let workspace = workspace_offset(hwnd, &screen);
        Some(offset(rect, (-workspace.0, -workspace.1)))
    }) else {
        return;
    };
    // SAFETY: plain calls on a live window.
    unsafe {
        let visible = IsWindowVisible(hwnd).as_bool();
        let full = window::is_full_screen(hwnd);
        native.flags = WINDOWPLACEMENT_FLAGS(0);
        native.rcNormalPosition = normal;
        let shown = match placement.mode {
            WindowMode::Maximized => SW_SHOWMAXIMIZED,
            _ => SW_SHOWNORMAL,
        };
        native.showCmd = if visible { shown } else { SW_HIDE }.0 as u32;
        match placement.mode {
            WindowMode::FullScreen if full => {
                // Back to these bounds when it leaves full screen.
                native.showCmd = SW_SHOWNORMAL.0 as u32;
                window::set_windowed(hwnd, native);
            }
            WindowMode::FullScreen => {
                native.showCmd = if visible { SW_SHOWNORMAL } else { SW_HIDE }.0 as u32;
                let _ = SetWindowPlacement(hwnd, &native);
                window::set_full_screen(hwnd, true);
            }
            _ => {
                if full {
                    window::set_windowed(hwnd, native);
                    window::set_full_screen(hwnd, false);
                }
                let _ = SetWindowPlacement(hwnd, &native);
            }
        }
    }
}

/// Centers `hwnd` on display `display`'s work area (the one it is on
/// without it).
pub(crate) fn center(hwnd: HWND, display: Option<DisplayId>) {
    if !top_level(hwnd) {
        return;
    }
    let Some(rect) = window_rect(hwnd) else {
        return;
    };
    let margins = margins(hwnd, rect);
    let rect = inset(rect, margins);
    let target = with_screens(|screens| {
        let current = screen_of(screens, hwnd, rect)?;
        let target = display
            .and_then(|id| screens.by_id(id).cloned())
            .unwrap_or(current.clone());
        // Its size in points stays as it moves to another scale.
        let bounds = current.bounds(rect);
        let area = target.display.visible_bounds;
        let centered = Bounds::new(
            point(
                area.origin.x + (area.size.width - bounds.size.width) / 2.0,
                area.origin.y + (area.size.height - bounds.size.height) / 2.0,
            ),
            bounds.size,
        );
        Some(outset(target.native_bounds(centered), margins))
    });
    if let Some(r) = target {
        // SAFETY: a plain call on a live window.
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
}

/// The outer rectangle (pixels) that a window with content `content`
/// (points) gets with its visible top left corner at `origin` (screen
/// points; what shows of it centered on `center_on`'s work area, a
/// rectangle in points, without it) on the display there, its frame
/// `frame` pixels (left, top, right, bottom) at that display's scale, of
/// which `hidden` do not show ([`visible_rect`]): what opening a window
/// asks for.
pub(crate) fn opening_rect(
    content: nsh_core::geometry::Size<Points>,
    origin: Option<nsh_core::geometry::Point<Points>>,
    center_on: Option<Bounds<Points>>,
    display: Option<DisplayId>,
    frame: impl Fn(f32) -> (Margins, Margins),
) -> Option<RECT> {
    with_screens(|screens| {
        let screen = match (origin, center_on, display) {
            (Some(at), ..) => screens.logical_screen(Bounds::new(at, content)),
            (None, Some(area), _) => screens.logical_screen(area),
            (None, None, Some(id)) => screens.by_id(id),
            (None, None, None) => None,
        }
        .or(display.and_then(|id| screens.by_id(id)))
        .or(screens.primary())?;
        let (extents, hidden) = frame(screen.scale);
        // The frame that shows, in points.
        let shown = |a: i32, b: i32| Points((a - b).max(0) as f32 / screen.scale);
        let (l, t) = (shown(extents.0, hidden.0), shown(extents.1, hidden.1));
        let (r, b) = (shown(extents.2, hidden.2), shown(extents.3, hidden.3));
        let area = center_on.unwrap_or(screen.display.visible_bounds);
        let at = origin.unwrap_or(point(
            area.origin.x + (area.size.width - (l + content.width + r)) / 2.0,
            area.origin.y + (area.size.height - (t + content.height + b)) / 2.0,
        ));
        let inner = screen.native_bounds(Bounds::new(point(at.x + l, at.y + t), content));
        Some(outset(inner, extents))
    })
}

/// Sizes `hwnd` to a content of `content` points and places it at `origin`
/// (screen points), centered on `center_on` (screen points) or on the
/// work area of `display` (else the primary one's): what opening a window
/// asks for.
pub(crate) fn open_at(
    hwnd: HWND,
    content: nsh_core::geometry::Size<Points>,
    origin: Option<nsh_core::geometry::Point<Points>>,
    center_on: Option<Bounds<Points>>,
    display: Option<DisplayId>,
) {
    // Twice: moved to a monitor of another scale, the window is scaled
    // with it (`WM_DPICHANGED`); the second time it is at the scale its
    // size is reckoned in.
    for _ in 0..2 {
        let scale = window::dpi(hwnd) as f32 / 96.0;
        let extents = window::frame_extents(hwnd);
        let hidden = normal_margins(hwnd);
        let frame = |at: f32| {
            let k = at / scale;
            let e = |(l, t, r, b): Margins| {
                let e = |v: i32| (v as f32 * k).round() as i32;
                (e(l), e(t), e(r), e(b))
            };
            (e(extents), e(hidden))
        };
        let Some(rect) = opening_rect(content, origin, center_on, display, frame) else {
            return;
        };
        // SAFETY: a plain call on a live window.
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                None,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
    }
}

/// Sizes `hwnd` to a content of `content` points where it is.
pub(crate) fn size_content(hwnd: HWND, content: nsh_core::geometry::Size<Points>) {
    let scale = window::dpi(hwnd) as f32 / 96.0;
    window::fit_content(
        hwnd,
        (
            (content.width.0 * scale).round() as i32,
            (content.height.0 * scale).round() as i32,
        ),
    );
}

/// The bounds of `hwnd` in screen points, if it is on a display.
pub(crate) fn bounds_of(hwnd: HWND) -> Option<Bounds<Points>> {
    let rect = visible_rect(hwnd)?;
    with_screens(|screens| Some(screen_of(screens, hwnd, rect)?.bounds(rect)))
}

/// `rect` (screen pixels) in screen points, converted on the monitor with
/// most of it: a tray icon's, whose taskbar may be on another monitor than
/// the app's window.
pub(crate) fn screen_bounds(rect: RECT) -> Option<Bounds<Points>> {
    with_screens(|screens| Some(screens.native_screen(rect)?.bounds(rect)))
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{point, px, size};

    use super::*;

    #[test]
    fn bounds_change_by_the_fields_given() {
        let start = Bounds::new(point(px(10.0), px(20.0)), size(px(300.0), px(200.0)));
        let frame = WindowFrame {
            width: Some(px(500.0)),
            ..Default::default()
        };
        let next = moved(start, &frame);
        assert_eq!(next.origin, start.origin);
        assert_eq!(next.size, size(px(500.0), px(200.0)));
        let frame = WindowFrame {
            x: Some(px(-40.0)),
            height: Some(px(f32::NAN)),
            ..Default::default()
        };
        let next = moved(start, &frame);
        assert_eq!(next.origin.x, px(-40.0));
        assert_eq!(next.size.height, px(200.0), "not a number keeps the height");
        let frame = WindowFrame {
            width: Some(px(0.0)),
            ..Default::default()
        };
        assert_eq!(moved(start, &frame).size.width, px(300.0));
    }
}
