//! The end of the user's session for a standalone app ([`crate::run_app`]):
//! signing out, shutting down or restarting, and a service manager
//! stopping the app, none of which closes its windows.
//!
//! - The session manager asks first where one is registered with
//!   (GtkApplication's `register-session` and `query-end`): the app is
//!   leaving ([`leave`]). Its state turns `Background` (`lifecycle()`), as
//!   when its window is minimized, so what it keeps on leaving runs now;
//!   the engine runs that before the query is answered, [`LEAVE_TIMEOUT`]
//!   at most, so a busy app never holds the session up. If the session goes
//!   on after all, the app's state follows its windows again once one of
//!   them gains the focus.
//! - The session manager ending the session ends the application's run
//!   without closing its windows: its `shutdown` stops every app still
//!   running as on quitting ([`end`]): its quit listeners run
//!   (`Application.on("quit")`) and its storage is written.
//! - systemd ends what is left of the session with SIGTERM (and SIGKILL
//!   after its stop timeout): the app leaves, then quits as its Quit item
//!   does ([`on_terminate`]). The signal is handled on the main loop, not
//!   in a signal handler; a second SIGTERM ends the process at once.

use std::{
    cell::Cell,
    ffi::c_int,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

use gtk4::glib::{self, ffi, thread_guard::ThreadGuard, translate::IntoGlib};

use crate::surface::Surface;

/// How long [`leave`] waits for the engines at most.
const LEAVE_TIMEOUT: Duration = Duration::from_millis(500);

/// The signal systemd and `kill` end a process with.
const SIGTERM: c_int = 15;

unsafe extern "C" {
    // GLib's (`glib-unix.h`), which the bindings do not wrap.
    fn g_unix_signal_add_full(
        priority: c_int,
        signum: c_int,
        handler: ffi::GSourceFunc,
        user_data: ffi::gpointer,
        notify: ffi::GDestroyNotify,
    ) -> u32;
}

thread_local! {
    /// The session may end: this thread's surfaces are in the background
    /// whatever their windows show. The value is whether one of the app's
    /// windows had the focus when last looked at, so that the focus coming
    /// back tells the session went on.
    static ENDING: Cell<Option<bool>> = const { Cell::new(None) };
}

/// Whether the session may end ([`leave`] came, and the app has not been
/// focused since).
pub(crate) fn ending() -> bool {
    ENDING.with(Cell::get).is_some()
}

/// The app is leaving: its surfaces go to the background and their engines
/// run what that queued, [`LEAVE_TIMEOUT`] at most.
pub(crate) fn leave() {
    ENDING.with(|e| e.set(Some(crate::system::app_focused())));
    crate::system::lifecycle_changed();
    settle(&crate::system::surfaces());
}

/// Whether the app's state follows its windows again: the session went on
/// after all, as one of the app's windows gained the focus (`focused`,
/// none had it before). Called as the windows' states change.
pub(crate) fn focus_changed(focused: bool) {
    ENDING.with(|e| {
        if let Some(before) = e.get() {
            e.set((!resumed(before, focused)).then_some(focused));
        }
    });
}

/// Whether the focus coming to one of the app's windows (`now`, none had
/// it `before`) shows the session went on.
fn resumed(before: bool, now: bool) -> bool {
    !before && now
}

/// The application's run ended: every app still running stops as on
/// quitting (its engine's drop runs its quit listeners and writes its
/// storage).
pub(crate) fn end() {
    for surface in crate::system::surfaces() {
        let mut running = false;
        surface.control(|_| running = true);
        if running {
            surface.stop();
        }
    }
}

/// Calls `f` on this thread's main loop, which must be the default main
/// context's, when the process gets SIGTERM, once: then SIGTERM ends the
/// process as by default again.
pub(crate) fn on_terminate(f: impl FnOnce() + 'static) {
    type Callback = ThreadGuard<Cell<Option<Box<dyn FnOnce()>>>>;

    unsafe extern "C" fn call(data: ffi::gpointer) -> ffi::gboolean {
        // SAFETY: `data` is the `Callback` boxed below, alive until the
        // source is destroyed (`drop_callback`).
        let callback = unsafe { &*(data as *const Callback) };
        if let Some(f) = callback.get_ref().take() {
            f();
        }
        // Removing the source restores SIGTERM's default action.
        glib::ControlFlow::Break.into_glib()
    }

    unsafe extern "C" fn drop_callback(data: ffi::gpointer) {
        // SAFETY: the box made below, given back once by GLib.
        drop(unsafe { Box::from_raw(data as *mut Callback) });
    }

    let context = glib::MainContext::default();
    // Its sources are dispatched on the thread that owns it: this one.
    let _owner = context
        .acquire()
        .expect("the default main context is this thread's");
    let callback: Box<Callback> = Box::new(ThreadGuard::new(Cell::new(Some(Box::new(f)))));
    // SAFETY: GLib calls `call` with the box on the default main context's
    // thread, this one, and `drop_callback` once when the source goes.
    unsafe {
        g_unix_signal_add_full(
            ffi::G_PRIORITY_DEFAULT,
            SIGTERM,
            Some(call),
            Box::into_raw(callback) as ffi::gpointer,
            Some(drop_callback),
        );
    }
}

/// Waits for the engines of `surfaces` to run what is queued (the
/// background state's handlers), [`LEAVE_TIMEOUT`] at most for all.
fn settle(surfaces: &[Rc<Surface>]) {
    let (tx, rx) = mpsc::channel();
    let mut waiting = 0;
    for surface in surfaces {
        surface.control(|c| {
            waiting += 1;
            let tx = tx.clone();
            c.flush(move |_| {
                let _ = tx.send(());
            });
        });
    }
    let deadline = Instant::now() + LEAVE_TIMEOUT;
    while waiting > 0 {
        if rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            log::warn!(
                "the app did not settle in {} ms before the session ended",
                LEAVE_TIMEOUT.as_millis()
            );
            return;
        }
        waiting -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_focus_coming_back_resumes_the_session() {
        assert!(resumed(false, true));
        assert!(!resumed(true, true));
        assert!(!resumed(false, false));
        assert!(!resumed(true, false));
    }

    #[test]
    fn sigterm_reaches_the_main_loop() {
        unsafe extern "C" {
            fn raise(sig: c_int) -> c_int;
        }
        let got = crate::gtk_test::run(|| {
            let got = Rc::new(Cell::new(0));
            let counted = got.clone();
            on_terminate(move || counted.set(counted.get() + 1));
            // SAFETY: the process's own signal, which GLib now handles.
            assert_eq!(unsafe { raise(SIGTERM) }, 0);
            let context = glib::MainContext::default();
            let deadline = Instant::now() + Duration::from_secs(5);
            while got.get() == 0 && Instant::now() < deadline {
                context.iteration(false);
            }
            got.get()
        });
        if let Some(got) = got {
            assert_eq!(got, 1);
        }
    }
}
