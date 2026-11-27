//! What a module's main-thread function shows system UI from: the surface
//! that ran it. Modules outside NSH (nshm) run GTK code with
//! `run_on_main_thread`; while such a function runs, its surface is
//! current here, so a dialog a module shows is transient for that
//! surface's window ([`presenting_window`]) and a popover points at the
//! widget of the element it belongs to ([`native_view`]), as the system UI
//! NSH shows itself does.

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

use gtk4::{self as gtk, prelude::*};
use nsh_core::NodeId;

use crate::surface::Surface;

thread_local! {
    /// The surface whose main-thread function runs now.
    static CURRENT: RefCell<Option<Weak<Surface>>> = const { RefCell::new(None) };
}

/// Runs `f` with `surface` as the current one.
pub(crate) fn run_for(surface: Weak<Surface>, f: impl FnOnce()) {
    let previous = CURRENT.with_borrow_mut(|current| current.replace(surface));
    f();
    CURRENT.with_borrow_mut(|current| *current = previous);
}

/// The widget of element `node` (its `ref`'s node, `NodeRef` in a module's
/// arguments) of the surface whose function a module runs on the main
/// thread (`run_on_main_thread`), in whatever window of the surface it is
/// (the surface's, a modal over it, a window of the app's own);
/// [`ROOT_ID`](nsh_core::ROOT_ID) is the surface's root widget. For system
/// UI that belongs to an element: a popover's parent (unparented again
/// once it closes, as NSH's own menus are), the rectangle a portal dialog
/// points at (`compute_bounds` in its window). Take it while the function
/// runs and keep it as long as the UI needs it.
///
/// For anchoring and presenting system UI only: a module never changes,
/// re-parents, restyles or removes a widget NSH owns.
///
/// `None` outside such a function, when no view of the surface carries
/// `node` (not rendered, or removed since), or while a batch is being
/// applied to the surface. The widget may be out of a window (a screen not
/// shown); check its `root()` before pointing at it.
pub fn native_view(node: NodeId) -> Option<gtk::Widget> {
    let surface = current()?;
    let mounter = surface.mounter.try_borrow().ok()?;
    mounter.views.get(&node).map(|view| view.clone().upcast())
}

/// The window to make system UI that no element anchors transient for (a
/// dialog's parent), from a function a module runs on the main thread
/// (`run_on_main_thread`): the surface's visible window the user is in
/// (the one with the focus, else the window the surface is in, else
/// another window of the app's own). `None` outside such a function and
/// when the surface shows in no visible window, where the dialog would
/// have no parent.
///
/// For presenting system UI only: a module never changes, re-parents,
/// restyles or closes a window NSH owns.
pub fn presenting_window() -> Option<gtk::Window> {
    let surface = current()?;
    crate::window::presenting_window(&surface)
}

/// The surface whose main-thread function runs now, while it lives.
fn current() -> Option<Rc<Surface>> {
    CURRENT.with_borrow(|current| current.as_ref()?.upgrade())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use nsh_core::{ROOT_ID, prelude::*};

    use super::*;
    use crate::gtk_test::{run, show, wait_until};

    /// What the main-thread function found.
    #[derive(Debug, Clone, PartialEq)]
    struct Seen {
        /// The anchor's widget: its bounds in the root widget, and whether
        /// it is in a window.
        anchor: Option<((f32, f32, f32, f32), bool)>,
        /// Whether the presenting window is the root's window.
        presenting_is_window: bool,
        /// Whether a node no view carries found a widget.
        stray: bool,
    }

    static SEEN: Mutex<Option<Seen>> = Mutex::new(None);

    /// A node no view carries.
    const STRAY: NodeId = u32::MAX - 1;

    #[component]
    fn Anchored() -> impl IntoElement {
        let anchor = element_ref();
        spawn(async move {
            // Laid out and mounted: two frames on.
            next_frame().await;
            next_frame().await;
            let node = anchor.node().expect("the anchor is rendered");
            let _ = run_on_main_thread(move || {
                let root = native_view(ROOT_ID).expect("the root widget");
                let window = root.root().and_downcast::<gtk::Window>();
                let anchor = native_view(node).map(|widget| {
                    let b = widget
                        .compute_bounds(&root)
                        .map(|b| (b.x(), b.y(), b.width(), b.height()))
                        .unwrap_or_default();
                    (b, widget.root().is_some())
                });
                *SEEN.lock().unwrap() = Some(Seen {
                    anchor,
                    presenting_is_window: window.is_some() && presenting_window() == window,
                    stray: native_view(STRAY).is_some(),
                });
            })
            .await;
        });
        view().size_full().child(
            view()
                .mt(px(30.0))
                .ml(px(20.0))
                .w(px(120.0))
                .h(px(40.0))
                .element_ref(&anchor),
        )
    }

    /// A module's main-thread function finds its element's widget (at its
    /// layout box in the root, in the window), the window the surface
    /// is in to present from, nothing for a node no view carries, and
    /// nothing outside such a function.
    #[test]
    fn a_main_thread_function_finds_its_surfaces_widgets() {
        run(|| {
            *SEEN.lock().unwrap() = None;
            assert!(native_view(ROOT_ID).is_none());
            assert!(presenting_window().is_none());
            let surface = crate::gtk_test::surface();
            let root = nsh_engine::Root::of::<Anchored>();
            surface.start(nsh_engine::EngineConfig::new(root));
            let window = show(&surface);
            assert!(
                wait_until(|| SEEN.lock().unwrap().is_some()),
                "the main-thread function never ran"
            );
            surface.stop();
            window.destroy();
            assert!(native_view(ROOT_ID).is_none());
            let seen = SEEN.lock().unwrap().clone().unwrap();
            assert_eq!(seen.anchor, Some(((20.0, 30.0, 120.0, 40.0), true)));
            assert!(seen.presenting_is_window);
            assert!(!seen.stray);
        });
    }
}
