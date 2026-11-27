//! What a module's main-thread function shows system UI from: the surface
//! that ran it. Modules outside NSH (nshm) run AppKit code with
//! `run_on_main_thread`; while such a function runs, its surface is
//! current here, so a menu or a sheet a module shows opens in that
//! surface's window ([`presenting_view`]) and points at the view of the
//! element it belongs to ([`native_view`]), as the system UI NSH shows
//! itself does.

use std::{cell::RefCell, rc::Weak};

use nsh_core::{NodeId, ROOT_ID};
use objc2::{MainThreadMarker, Message, rc::Retained};
use objc2_app_kit::NSView;

use crate::surface::Surface;

thread_local! {
    /// The surface whose main-thread function runs now.
    static CURRENT: RefCell<Option<Weak<Surface>>> = const { RefCell::new(None) };
}

/// Runs `f` with `surface` as the current one.
pub(crate) fn run_for<R>(surface: Weak<Surface>, f: impl FnOnce() -> R) -> R {
    let previous = CURRENT.with_borrow_mut(|current| current.replace(surface));
    let result = f();
    CURRENT.with_borrow_mut(|current| *current = previous);
    result
}

/// The native view of element `node` (its `ref`'s node, `NodeRef` in a
/// module's arguments) of the surface whose function a module runs on the
/// main thread (`run_on_main_thread`), in whatever window of the surface
/// it is (an app window, a panel, a modal); [`ROOT_ID`] is the surface's
/// root view. For system UI that belongs to an element: a menu's or a
/// popover's positioning view. NSH's views are flipped (`isFlipped`). Take
/// it while the function runs and keep it as long as the UI needs it.
///
/// For anchoring and presenting system UI only: a module never changes,
/// re-parents, restyles or removes a view NSH owns.
///
/// `None` outside such a function, when no view of the surface carries
/// `node` (not rendered, or removed since), or, for an element other than
/// the root, while a batch is being applied to the surface. The view may
/// be out of a window (a screen not shown); check its `window()` before
/// pointing at it.
pub fn native_view(mtm: MainThreadMarker, node: NodeId) -> Option<Retained<NSView>> {
    let _ = mtm;
    let surface = current()?;
    if node == ROOT_ID {
        return Some(surface.root.ns().retain());
    }
    let mounter = surface.mounter.try_borrow().ok()?;
    mounter.views.get(&node).map(|view| view.ns().retain())
}

/// The view to show system UI from when no element anchors it, from a
/// function a module runs on the main thread (`run_on_main_thread`): the
/// content of the surface's visible window the user is in (the key one,
/// else the main one, else another), or the surface's root view when it
/// is in a visible window of its own (an embedded surface). `None` outside
/// such a function and when the surface shows in no visible window, where
/// AppKit would show nothing.
///
/// For presenting system UI only: a module never changes, re-parents,
/// restyles or removes a view NSH owns.
pub fn presenting_view(mtm: MainThreadMarker) -> Option<Retained<NSView>> {
    let _ = mtm;
    let surface = current()?;
    let view =
        crate::window::visible_container(&surface).unwrap_or_else(|| surface.root.ns().retain());
    view.window()
        .is_some_and(|window| window.isVisible())
        .then_some(view)
}

/// The surface whose main-thread function runs now, while it lives.
fn current() -> Option<std::rc::Rc<Surface>> {
    CURRENT.with_borrow(|current| current.as_ref()?.upgrade())
}
