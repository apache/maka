//! What a module's main-thread function shows system UI from: the surface
//! that ran it. Modules outside NSH (nshm) run Win32 code with
//! `run_on_main_thread`; while such a function runs, its surface is
//! current here, so a menu or a dialog a module shows is owned by that
//! surface's window ([`presenting_window`]) and points at the element it
//! belongs to ([`element_bounds`]), as the system UI NSH shows itself does.
//!
//! NSH draws its elements into its windows: they are no windows of their
//! own, so an element is given as the window it shows in and its bounds
//! there, where Apple's backends give its view.

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

use nsh_core::{Bounds, NodeId, Points, Size, geometry::point};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, IsWindowVisible},
};

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

/// Where an element shows ([`element_bounds`]).
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct ElementBounds {
    /// The window the element shows in: the surface's (a child of the
    /// embedding app's window when the surface is embedded) or a window of
    /// the app's own (`Window.open`). Its client area holds [`Self::bounds`];
    /// `ClientToScreen` on it gives screen coordinates.
    pub window: HWND,
    /// The element's bounds in the window's client area, from its top-left
    /// corner: its layout box as it is drawn (moved by scrolling and its
    /// transforms; the box around it when rotated).
    pub bounds: Bounds<Points>,
    /// Pixels per point in the window: `bounds` times it is in client
    /// pixels, what Win32 takes.
    pub scale_factor: f32,
}

/// Where element `node` (its `ref`'s node, `NodeRef` in a module's
/// arguments) of the surface whose function a module runs on the main
/// thread (`run_on_main_thread`) shows, in whatever window of the surface
/// it is (the surface's, a modal over it, a window of the app's own);
/// [`ROOT_ID`](nsh_core::ROOT_ID) is the surface's root. For system UI that
/// belongs to an element: where a menu opens (`TrackPopupMenuEx`'s point
/// and excluded rectangle), what a flyout points at. Read it while the
/// function runs: a later layout moves the element.
///
/// NSH draws its elements itself: they are no windows a module could take.
/// This is for anchoring and presenting system UI only: a module never
/// changes, re-parents, restyles or removes a window NSH owns, nor draws
/// into it.
///
/// `None` outside such a function, when no view of the surface carries
/// `node` (not rendered, or removed since), or when its view is in no
/// window's tree (a screen not shown).
pub fn element_bounds(node: NodeId) -> Option<ElementBounds> {
    let surface = current()?;
    let view = surface.view(node)?;
    let (width, height) = {
        let state = view.try_state()?;
        (state.frame.size.width.0, state.frame.size.height.0)
    };
    let (x, y, w, h) = view.to_root()?.bounds(0.0, 0.0, width, height)?;
    let window = crate::app_window::hwnd_showing(&surface, &view);
    if window.is_invalid() {
        return None;
    }
    // A window of the app's own has the scale of the display it is on,
    // which can differ from the surface's.
    let scale_factor = if window == surface.hwnd() {
        surface.scale()
    } else {
        crate::window::dpi(window) as f32 / 96.0
    };
    Some(ElementBounds {
        window,
        bounds: Bounds::new(point(Points(x), Points(y)), Size::new(Points(w), Points(h))),
        scale_factor,
    })
}

/// The top-level window to own system UI that no element anchors (a
/// dialog's owner, a menu's window), from a function a module runs on the
/// main thread (`run_on_main_thread`): the surface's visible window the
/// user is in (the one with the focus, else the window the surface is in,
/// else another window of the app's own). `None` outside such a function
/// and when the surface shows in no visible window, where Windows would
/// show the UI ownerless.
///
/// For owning and presenting system UI only: a module never changes,
/// re-parents, restyles or destroys a window NSH owns.
pub fn presenting_window() -> Option<HWND> {
    let surface = current()?;
    let visible = |hwnd: &HWND| {
        // SAFETY: a plain query; a stale handle is not visible.
        !hwnd.is_invalid() && unsafe { IsWindowVisible(*hwnd) }.as_bool()
    };
    if let Some(focused) = crate::app_window::focused_hwnd(&surface).filter(visible) {
        return Some(focused);
    }
    let own = surface.hwnd();
    if !own.is_invalid() {
        // SAFETY: a plain query on a window of this thread.
        let top = unsafe { GetAncestor(own, GA_ROOT) };
        let top = if top.is_invalid() { own } else { top };
        if visible(&top) {
            return Some(top);
        }
    }
    crate::app_window::hwnds(&surface).into_iter().find(visible)
}

/// The surface whose main-thread function runs now, while it lives.
fn current() -> Option<Rc<Surface>> {
    CURRENT.with_borrow(|current| current.as_ref()?.upgrade())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Mutex,
        time::{Duration, Instant},
    };

    use nsh_core::{ROOT_ID, prelude::*};
    use nsh_engine::{EngineConfig, Environment};
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, SW_SHOWNOACTIVATE,
        ShowWindow, TranslateMessage,
    };

    use super::*;

    /// What the main-thread function found.
    #[derive(Debug, Clone, PartialEq)]
    struct Seen {
        /// The anchor's bounds, and whether its window is the surface's.
        anchor: Option<(Bounds<Points>, bool)>,
        /// The root's bounds.
        root: Option<Bounds<Points>>,
        /// Whether the presenting window is the test's window.
        presenting_is_window: bool,
        /// Whether a node no view carries was found.
        stray: bool,
    }

    static SEEN: Mutex<Option<Seen>> = Mutex::new(None);

    /// A node no view carries.
    const STRAY: NodeId = u32::MAX - 1;

    /// The test's window, as an integer: the main-thread function compares
    /// it with what it finds.
    static WINDOW: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

    #[component]
    fn Anchored() -> impl IntoElement {
        let anchor = element_ref();
        spawn(async move {
            // Laid out and mounted: two frames on.
            next_frame().await;
            next_frame().await;
            let node = anchor.node().expect("the anchor is rendered");
            let _ = run_on_main_thread(move || {
                let window = HWND(WINDOW.load(std::sync::atomic::Ordering::Acquire) as *mut _);
                let anchor = element_bounds(node).map(|e| (e.bounds, e.window == window));
                let root = element_bounds(ROOT_ID).map(|e| e.bounds);
                *SEEN.lock().unwrap() = Some(Seen {
                    anchor,
                    root,
                    presenting_is_window: presenting_window() == Some(window),
                    stray: element_bounds(STRAY).is_some(),
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

    fn pump() {
        let mut msg = MSG::default();
        // SAFETY: dispatching messages taken from this thread's queue.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    /// A module's main-thread function finds where its element shows (in
    /// the surface's window, at its layout box) and the root's bounds, the
    /// surface's top-level window to present from, nothing for a node no
    /// view carries, and nothing outside such a function.
    #[test]
    fn a_main_thread_function_finds_its_surfaces_elements() {
        *SEEN.lock().unwrap() = None;
        assert!(element_bounds(ROOT_ID).is_none());
        assert!(presenting_window().is_none());
        let surface = Surface::new(Environment::default());
        let hwnd =
            crate::window::create(&surface, "NSH presenting", (320, 240), None, false).unwrap();
        WINDOW.store(hwnd.0 as isize, std::sync::atomic::Ordering::Release);
        // Shown without taking the focus: the window to present from.
        // SAFETY: the test's own window.
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        pump();
        surface.start(EngineConfig::new(nsh_engine::App::Rust(
            nsh_core::element::Root::new::<Anchored>(|| ()),
        )));
        let end = Instant::now() + Duration::from_secs(5);
        let seen = loop {
            if let Some(seen) = SEEN.lock().unwrap().clone() {
                break seen;
            }
            assert!(Instant::now() < end, "the main-thread function never ran");
            pump();
            std::thread::sleep(Duration::from_millis(5));
        };
        surface.stop();
        // SAFETY: the test's own window.
        let _ = unsafe { DestroyWindow(hwnd) };
        assert!(element_bounds(ROOT_ID).is_none());
        let at =
            |x, y, w, h| Bounds::new(point(Points(x), Points(y)), Size::new(Points(w), Points(h)));
        assert_eq!(seen.anchor, Some((at(20.0, 30.0, 120.0, 40.0), true)));
        assert_eq!(
            seen.root.map(|r| r.origin),
            Some(point(Points(0.0), Points(0.0)))
        );
        assert!(seen.presenting_is_window);
        assert!(!seen.stray);
    }
}
