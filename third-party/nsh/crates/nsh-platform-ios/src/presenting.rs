//! What a module's main-thread function shows system UI over: the surface
//! that ran it. Modules outside NSH (nshm) run UIKit code with
//! `run_on_main_thread`; while such a function runs, its surface is
//! current here, so a camera or a share sheet a module presents covers
//! that surface's window ([`presenting_controller`]) and a popover points
//! at the view of the element it belongs to ([`native_view`]), as the
//! system UI NSH shows itself does.

use std::cell::RefCell;

use nsh_core::{NodeId, ROOT_ID};
use objc2::{MainThreadMarker, rc::Retained};
use objc2_ui_kit::{UIApplication, UIView, UIViewController, UIWindow, UIWindowScene};

use crate::mount::SharedMounter;

thread_local! {
    /// The mounter of the surface whose main-thread function runs now.
    static CURRENT: RefCell<Option<SharedMounter>> = const { RefCell::new(None) };
}

/// Runs `f` with `mounter`'s surface as the current one.
pub(crate) fn run_for(mounter: SharedMounter, f: impl FnOnce()) {
    let previous = CURRENT.with_borrow_mut(|current| current.replace(mounter));
    f();
    CURRENT.with_borrow_mut(|current| *current = previous);
}

/// The native view of element `node` (its `ref`'s node, `NodeRef` in a
/// module's arguments) of the surface whose function a module runs on the
/// main thread (`run_on_main_thread`), in the surface or in one of its
/// modals; [`ROOT_ID`] is the surface's root view. For system UI that
/// belongs to an element: a popover's source view, a menu's anchor. Take
/// it while the function runs and keep it as long as the UI needs it.
///
/// For anchoring and presenting system UI only: a module never changes,
/// re-parents, restyles or removes a view NSH owns.
///
/// `None` outside such a function, when no view of the surface carries
/// `node` (not rendered, or removed since), or while a batch is being
/// applied to the surface. The view may be out of a window (a screen not
/// shown); check its `window()` before pointing at it.
pub fn native_view(mtm: MainThreadMarker, node: NodeId) -> Option<Retained<UIView>> {
    let mounter = CURRENT.with_borrow(Clone::clone)?;
    let mounter = mounter.get(mtm).try_borrow().ok()?;
    mounter.as_ref()?.ui_view(node)
}

/// The controller to present system UI over from a function a module runs
/// on the main thread (`run_on_main_thread`): the top one of the window of
/// the surface that ran it, else of the application's key window. `None`
/// when there is no window to present over.
///
/// For presenting system UI only: a module presents over it and never
/// changes, re-parents, restyles or removes a view NSH owns.
pub fn presenting_controller(mtm: MainThreadMarker) -> Option<Retained<UIViewController>> {
    if let Some(view) = native_view(mtm, ROOT_ID)
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
