//! Closing the main window: the user's close (its close button, Alt+F4,
//! the taskbar, the window menu, the system) and the app's
//! (`Request(Close)`, `Quit`).
//!
//! A close the user asks for is reported to the app first (`ClosePress` on
//! the root). With `closeOnPress` (the default) the window then closes by
//! itself, once the engine has run the app's handlers for it: the engine
//! is asked to flush, and the window closes when it answers, or after
//! [`FALLBACK`] when it does not (an app busy in a long call). Without
//! `closeOnPress` the app decides: it closes the window later, or not.
//! The app's own close is carried out at once.

use std::time::Duration;

use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    desktop::{CloseReason, WindowEvent},
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    UI::WindowsAndMessaging::{DestroyWindow, KillTimer, PostMessageW, SetTimer},
};

use crate::{
    surface::Surface,
    window::{WM_NSH_CLOSE, WM_NSH_CLOSE_HANDLED},
};

/// How long a close waits for the app's handlers at most.
const FALLBACK: Duration = Duration::from_millis(250);

/// The timer of [`FALLBACK`] (`SetTimer`'s id on the main window).
const TIMER: usize = 0x4e53_4843;

/// The user asked to close the main window, as `reason` says.
pub(crate) fn close_press(surface: &Surface, reason: CloseReason) {
    let hwnd = surface.hwnd();
    let Some(shell) = crate::window::shell(hwnd) else {
        return;
    };
    let closes = shell.attrs().close_on_press;
    let mut running = false;
    surface.control(|_| running = true);
    if !running {
        // No app to ask: it closes as any window does.
        if closes {
            destroy(hwnd);
        }
        return;
    }
    surface.event(
        ROOT_ID,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::ClosePress { reason })),
    );
    if !closes || shell.closing.replace(true) {
        return;
    }
    let target = hwnd.0 as isize;
    surface.control(|c| {
        c.flush(move |_| {
            // SAFETY: posting to a window by its handle; a window gone
            // meanwhile ignores it (`PostMessageW` fails).
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(target as *mut _)),
                    WM_NSH_CLOSE_HANDLED,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
        })
    });
    // SAFETY: a timer on the surface's live window.
    unsafe { SetTimer(Some(hwnd), TIMER, FALLBACK.as_millis() as u32, None) };
}

/// The engine ran the app's handlers of the close press.
pub(crate) fn handled(surface: &Surface, _: usize) {
    finish(surface);
}

/// A `WM_TIMER` of the main window: true when it was [`FALLBACK`]'s, and
/// the window closes.
pub(crate) fn timed_out(surface: &Surface, timer: usize) -> bool {
    if timer != TIMER {
        return false;
    }
    finish(surface);
    true
}

fn finish(surface: &Surface) {
    let hwnd = surface.hwnd();
    // SAFETY: the timer of this window, if it runs.
    let _ = unsafe { KillTimer(Some(hwnd), TIMER) };
    if crate::window::shell(hwnd).is_some_and(|s| s.closing.replace(false)) {
        destroy(hwnd);
    }
}

/// Closes the main window without asking (`Request(Close)`, `Quit`):
/// after the batch being applied, from the message loop.
pub(crate) fn close(surface: &Surface) {
    let hwnd = surface.hwnd();
    // SAFETY: posting to the surface's live window.
    let _ = unsafe { PostMessageW(Some(hwnd), WM_NSH_CLOSE, WPARAM(0), LPARAM(0)) };
}

fn destroy(hwnd: HWND) {
    // SAFETY: the surface's own window, on its thread.
    let _ = unsafe { DestroyWindow(hwnd) };
}

/// The main window is going: nothing waits to close it any more.
pub(crate) fn destroyed(surface: &Surface) {
    let hwnd = surface.hwnd();
    if let Some(shell) = crate::window::shell(hwnd) {
        shell.closing.set(false);
    }
    // SAFETY: the timer of this window, if it runs.
    let _ = unsafe { KillTimer(Some(hwnd), TIMER) };
}
