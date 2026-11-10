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
    let rect = window_rect(hwnd)?;
    let placement = placement_of(hwnd)?;
    with_screens(|screens| {
        let screen = screen_of(screens, hwnd, rect)?;
        // SAFETY: plain queries on a live window.
        let (minimized, shown, foreground) = unsafe {
            (
                IsIconic(hwnd).as_bool(),
                IsWindowVisible(hwnd).as_bool(),
                GetForegroundWindow() == hwnd,
            )
        };
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
                offset(windowed.rcNormalPosition, workspace_offset(hwnd, &on))
            }
            _ if !minimized && !maximized && !full => rect,
            _ => offset(placement.rcNormalPosition, workspace_offset(hwnd, &screen)),
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
        state.focused = foreground;
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
    let target = with_screens(|screens| {
        let current = screen_of(screens, hwnd, rect)?;
        let bounds = moved(current.bounds(rect), frame);
        let target = screens.logical_screen(bounds).unwrap_or(&current);
        Some(target.native_bounds(bounds))
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
        let rect = screen.native_bounds(placement.bounds);
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
        Some(target.native_bounds(centered))
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
/// (points) gets at `origin` (screen points; centered on `center_on`'s
/// work area, a rectangle in points, without it) on the display there,
/// its frame `frame` pixels (left, top, right, bottom) at that display's
/// scale: what opening a window asks for.
pub(crate) fn opening_rect(
    content: nsh_core::geometry::Size<Points>,
    origin: Option<nsh_core::geometry::Point<Points>>,
    center_on: Option<Bounds<Points>>,
    display: Option<DisplayId>,
    frame: impl Fn(f32) -> (i32, i32, i32, i32),
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
        let area = center_on.unwrap_or(screen.display.visible_bounds);
        let at = origin.unwrap_or(point(
            area.origin.x + (area.size.width - content.width) / 2.0,
            area.origin.y + (area.size.height - content.height) / 2.0,
        ));
        let inner = screen.native_bounds(Bounds::new(at, content));
        let (l, t, r, b) = frame(screen.scale);
        Some(RECT {
            left: inner.left - l,
            top: inner.top - t,
            right: inner.right + r,
            bottom: inner.bottom + b,
        })
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
        let frame = |at: f32| {
            let k = at / scale;
            let e = |v: i32| (v as f32 * k).round() as i32;
            (e(extents.0), e(extents.1), e(extents.2), e(extents.3))
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
    let rect = window_rect(hwnd)?;
    with_screens(|screens| Some(screen_of(screens, hwnd, rect)?.bounds(rect)))
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
