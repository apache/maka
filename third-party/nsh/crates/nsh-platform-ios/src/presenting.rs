//! What a module's main-thread function shows system UI over: the surface
//! that ran it ([`presenting_controller`]). Modules outside NSH (nshm) run
//! UIKit code with `run_on_main_thread`; while such a function runs, its
//! surface's root view is current here, so a camera or a share sheet a
//! module presents covers that surface's window, as the system UI NSH
//! shows itself does.

use std::cell::RefCell;

use objc2::{MainThreadMarker, rc::Retained};
use objc2_ui_kit::{UIApplication, UIView, UIViewController, UIWindow, UIWindowScene};

thread_local! {
    /// The root view of the surface whose main-thread function runs now.
    static CURRENT: RefCell<Option<Retained<UIView>>> = const { RefCell::new(None) };
}

/// Runs `f` with `root` as the current surface's root view.
pub(crate) fn run_for(root: Option<Retained<UIView>>, f: impl FnOnce()) {
    let previous = CURRENT.with_borrow_mut(|current| std::mem::replace(current, root));
    f();
    CURRENT.with_borrow_mut(|current| *current = previous);
}

/// The controller to present system UI over from a function a module runs
/// on the main thread (`run_on_main_thread`): the top one of the window of
/// the surface that ran it, else of the application's key window. `None`
/// when there is no window to present over.
pub fn presenting_controller(mtm: MainThreadMarker) -> Option<Retained<UIViewController>> {
    if let Some(view) = CURRENT.with_borrow(Clone::clone)
        && let Some(top) = crate::system::top_controller(&view)
    {
        return Some(top);
    }
    let window = key_window(mtm)?;
    crate::system::top_controller(&window)
}

/// The key window of the application's foreground scenes.
fn key_window(mtm: MainThreadMarker) -> Option<Retained<UIWindow>> {
    let app = UIApplication::sharedApplication(mtm);
    let scenes = app.connectedScenes();
    for scene in scenes.iter() {
        let Ok(scene) = scene.downcast::<UIWindowScene>() else {
            continue;
        };
        if let Some(window) = scene.windows().iter().find(|w| w.isKeyWindow()) {
            return Some(window);
        }
    }
    None
}
