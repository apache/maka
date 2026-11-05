//! What the tests that make GTK widgets share. GTK takes the thread that
//! first initializes it as its main thread for good, and each test runs on
//! a thread of its own, so they all run on one thread of their own
//! ([`run`]). Without a display they do not run; `xvfb-run -a cargo test`
//! gives them a virtual one, as CI does.

use std::{
    panic::{self, AssertUnwindSafe},
    rc::Rc,
    sync::{OnceLock, mpsc},
    thread,
    time::{Duration, Instant},
};

use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{
    Bounds, MountItem, NodeId, Points,
    geometry::{bounds, point, size},
};

use crate::{surface::Surface, view::NshView};

/// A test's work for the GTK thread.
type Job = Box<dyn FnOnce() + Send>;

/// Runs `f` on the tests' GTK thread and returns what it returns; `None`
/// where no display can be opened (it does not run). A display that is set
/// but does not open fails the test.
pub(crate) fn run<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    static JOBS: OnceLock<Option<mpsc::Sender<Job>>> = OnceLock::new();
    let jobs = JOBS.get_or_init(|| {
        let (jobs, queue) = mpsc::channel::<Job>();
        let (ready, started) = mpsc::channel();
        thread::Builder::new()
            .name("gtk".into())
            .spawn(move || {
                let initialized = gtk::init().is_ok();
                let _ = ready.send(initialized);
                if initialized {
                    for job in queue {
                        job();
                    }
                }
            })
            .expect("the GTK thread starts");
        started.recv().unwrap_or(false).then_some(jobs)
    });
    let Some(jobs) = jobs else {
        let display = std::env::var_os("DISPLAY").or_else(|| std::env::var_os("WAYLAND_DISPLAY"));
        assert!(display.is_none(), "GTK cannot open the display {display:?}");
        return None;
    };
    let (done, result) = mpsc::channel();
    jobs.send(Box::new(move || {
        // The thread lives on for the other tests.
        let _ = done.send(panic::catch_unwind(AssertUnwindSafe(f)));
    }))
    .expect("the GTK thread takes work");
    match result.recv().expect("the GTK thread answers") {
        Ok(value) => Some(value),
        Err(panic) => panic::resume_unwind(panic),
    }
}

/// A surface with no app and no GPU device (the tests open none).
pub(crate) fn surface() -> Rc<Surface> {
    let surface = Surface::new(Default::default());
    surface.without_shader_renderer();
    surface
}

/// Applies `items` to `surface`'s views as a batch applies them, without
/// its end.
pub(crate) fn apply(surface: &Rc<Surface>, items: &[MountItem]) {
    for item in items {
        surface.mounter.borrow_mut().apply(surface, item);
    }
}

/// The view of node `id`.
pub(crate) fn view(surface: &Surface, id: NodeId) -> NshView {
    surface
        .mounter
        .borrow()
        .views
        .get(&id)
        .cloned()
        .expect("the view")
}

/// The frame at `x`, `y` (points) of `width` × `height`.
pub(crate) fn frame(x: f32, y: f32, width: f32, height: f32) -> Bounds<Points> {
    bounds(
        point(Points(x), Points(y)),
        size(Points(width), Points(height)),
    )
}

/// A window of 200 × 200 points showing `surface`, presented.
pub(crate) fn show(surface: &Surface) -> gtk::Window {
    let window = gtk::Window::new();
    window.set_default_size(200, 200);
    window.set_child(Some(&surface.root));
    window.present();
    window
}

/// Runs the GTK thread's main loop until `done`, for five seconds at most:
/// whether it is done.
pub(crate) fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    let cx = glib::MainContext::default();
    let until = Instant::now() + Duration::from_secs(5);
    while !done() {
        if Instant::now() >= until {
            return false;
        }
        if !cx.iteration(false) {
            thread::sleep(Duration::from_millis(2));
        }
    }
    true
}
