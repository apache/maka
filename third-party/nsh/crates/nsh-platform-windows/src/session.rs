//! The end of the user's session: signing out, shutting down or restarting
//! Windows, and the Restart Manager closing the app (an installer updating
//! it), which all skip `WM_CLOSE` and come as `WM_QUERYENDSESSION`, then
//! `WM_ENDSESSION`.
//!
//! - `WM_QUERYENDSESSION`: the app is leaving. Its state turns
//!   `Background` (`lifecycle()`), as when its window is minimized, so what
//!   it keeps on leaving runs now; the engine runs that before the message
//!   is answered, [`LEAVE_TIMEOUT`] at most, so a busy app never holds the
//!   session up. The answer lets the session end: the app is not asked.
//! - `WM_ENDSESSION` ending it: the app stops as on quitting (its quit
//!   listeners run, `Application.on("quit")`), its storage written before
//!   the message is answered, after which Windows may end the process at
//!   any time; a window of its own then closes, so an app the Restart
//!   Manager closes exits.
//! - `WM_ENDSESSION` not ending it (another app refused): the app's state
//!   follows its window again.
//!
//! An embedded surface hears its root window's, which only top-level
//! windows get (`window::observe_root`).

use std::{cell::Cell, sync::mpsc, time::Duration};

use windows::Win32::{
    Foundation::{LPARAM, WPARAM},
    UI::WindowsAndMessaging::{PostMessageW, WM_ENDSESSION, WM_QUERYENDSESSION},
};

use crate::surface::Surface;

/// How long `WM_QUERYENDSESSION` waits for the engine at most.
const LEAVE_TIMEOUT: Duration = Duration::from_millis(500);

thread_local! {
    /// The session is ending: this thread's surfaces are in the background
    /// whatever their windows show.
    static ENDING: Cell<bool> = const { Cell::new(false) };
}

/// What a session message asks of the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// The session may end: the app goes to the background and keeps what
    /// it has.
    Leave,
    /// The session ends: the app stops.
    End,
    /// The session goes on after all.
    Resume,
}

/// What `msg` with `wparam` asks; `None` for other messages.
pub(crate) fn step(msg: u32, wparam: WPARAM) -> Option<Step> {
    match msg {
        WM_QUERYENDSESSION => Some(Step::Leave),
        WM_ENDSESSION if wparam.0 != 0 => Some(Step::End),
        WM_ENDSESSION => Some(Step::Resume),
        _ => None,
    }
}

/// Whether the session is ending ([`Step::Leave`] came, no
/// [`Step::Resume`] since).
pub(crate) fn ending() -> bool {
    ENDING.with(Cell::get)
}

/// Handles session message `msg` for `surface`, whose window is its own
/// top-level one when `top_level`; the message's result, `None` for other
/// messages.
pub(crate) fn message(
    surface: &Surface,
    top_level: bool,
    msg: u32,
    wparam: WPARAM,
) -> Option<isize> {
    match step(msg, wparam)? {
        Step::Leave => {
            ENDING.with(|e| e.set(true));
            crate::system::lifecycle_changed(surface);
            settle(surface);
            // TRUE: the session may end.
            Some(1)
        }
        Step::End => {
            // The engine stops (`Engine`'s drop): the quit listeners run,
            // its thread ends and the storage it held is written.
            surface.stop();
            if top_level {
                // SAFETY: posting to the surface's live window.
                let _ = unsafe {
                    PostMessageW(
                        Some(surface.hwnd()),
                        crate::window::WM_NSH_CLOSE,
                        WPARAM(0),
                        LPARAM(0),
                    )
                };
            }
            Some(0)
        }
        Step::Resume => {
            ENDING.with(|e| e.set(false));
            crate::system::lifecycle_changed(surface);
            Some(0)
        }
    }
}

/// Waits for the engine to run what is queued (the background state's
/// handlers), [`LEAVE_TIMEOUT`] at most.
fn settle(surface: &Surface) {
    let (tx, rx) = mpsc::channel();
    let mut running = false;
    surface.control(|c| {
        running = true;
        c.flush(move |_| {
            let _ = tx.send(());
        });
    });
    if running && rx.recv_timeout(LEAVE_TIMEOUT).is_err() {
        log::warn!(
            "the app did not settle in {} ms before the session ended",
            LEAVE_TIMEOUT.as_millis()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_messages_map_to_steps() {
        assert_eq!(step(WM_QUERYENDSESSION, WPARAM(0)), Some(Step::Leave));
        assert_eq!(step(WM_ENDSESSION, WPARAM(1)), Some(Step::End));
        assert_eq!(step(WM_ENDSESSION, WPARAM(0)), Some(Step::Resume));
        assert_eq!(
            step(windows::Win32::UI::WindowsAndMessaging::WM_CLOSE, WPARAM(0)),
            None
        );
    }
}
