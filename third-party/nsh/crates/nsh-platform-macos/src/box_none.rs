//! Windows whose `pointerEvents` is `"box-none"`: each takes the pointer
//! only where it is over a view in its root that takes it (the input's own
//! picking, the root aside), and lets it through to what is below
//! elsewhere.
//!
//! AppKit picks the window a press goes to before the window sees it, so
//! the window follows the pointer and lets it through or not for where it
//! is (`ignoresMouseEvents`), again after each batch moved its views and
//! as it shows; the pointer is followed only while one of these windows
//! shows.

use std::{cell::RefCell, ptr::NonNull};

use block2::RcBlock;
use nsh_core::NodeId;
use objc2::{
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_app_kit::{NSEvent, NSEventMask, NSWindow, NSWindowDidChangeOcclusionStateNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};

use crate::surface::Surface;

/// A `"box-none"` window: its surface's key and its root's id.
struct Entry {
    window: Retained<NSWindow>,
    surface: u64,
    id: NodeId,
}

thread_local! {
    static WINDOWS: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
    /// The monitors following the pointer while one of the windows shows.
    static MONITORS: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
    /// Hears the windows show, hide and minimize while there are any.
    static OBSERVER: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
        const { RefCell::new(None) };
}

/// Window `id` of `surface` (`window`) is `"box-none"` (`on`) or no longer
/// is (the click-through flag stays as the caller left it).
pub(crate) fn set(surface: &Surface, id: NodeId, window: &NSWindow, on: bool) {
    forget(window);
    if !on {
        return;
    }
    WINDOWS.with_borrow_mut(|w| {
        w.push(Entry {
            window: Retained::from(window),
            surface: surface.key(),
            id,
        })
    });
    observe_visibility();
    follow_while_shown();
    follow(Some(key(window)));
}

/// A batch moved `surface`'s views: its `"box-none"` windows follow their
/// new layout under the pointer where it rests.
pub(crate) fn batch_applied(surface: &Surface) {
    let surface = surface.key();
    let windows: Vec<usize> = WINDOWS.with_borrow(|w| {
        w.iter()
            .filter(|e| e.surface == surface)
            .map(|e| key(&e.window))
            .collect()
    });
    for window in windows {
        follow(Some(window));
    }
}

/// `window` was ordered in: it takes the pointer for where it is now,
/// before the pointer moves.
pub(crate) fn shown(window: &NSWindow) {
    if WINDOWS.with_borrow(Vec::is_empty) {
        return;
    }
    follow_while_shown();
    follow(Some(key(window)));
}

/// `window` closes, or is no longer `"box-none"`.
pub(crate) fn forget(window: &NSWindow) {
    forget_key(key(window));
}

fn forget_key(k: usize) {
    let empty = WINDOWS.with_borrow_mut(|w| {
        w.retain(|e| key(&e.window) != k);
        w.is_empty()
    });
    follow_while_shown();
    if empty && let Some(observer) = OBSERVER.take() {
        // SAFETY: an observer the center returned.
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
    }
}

fn key(w: &NSWindow) -> usize {
    std::ptr::from_ref(w) as usize
}

fn shows(w: &NSWindow) -> bool {
    w.isVisible() && !w.isMiniaturized()
}

/// Hears every window's visibility change (shown, hidden, minimized, the
/// app hidden): the pointer is followed only while one of these windows
/// shows, and one that shows follows it from there.
fn observe_visibility() {
    if OBSERVER.with_borrow(Option::is_some) {
        return;
    }
    let block = RcBlock::new(|_: NonNull<NSNotification>| {
        follow_while_shown();
        follow(None);
    });
    // SAFETY: an immutable AppKit constant, posted on the main thread where
    // the block runs; the observer is removed with the last window.
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidChangeOcclusionStateNotification),
            None,
            None,
            &block,
        )
    };
    OBSERVER.set(Some(observer));
}

/// Watches the pointer move over every app (the global monitor) and this
/// one (the local monitor), and the buttons coming up, while one of the
/// windows shows; never from a monitor's own handler.
fn follow_while_shown() {
    let any = WINDOWS.with_borrow(|w| w.iter().any(|e| shows(&e.window)));
    if !any {
        for monitor in MONITORS.with_borrow_mut(std::mem::take) {
            // SAFETY: a monitor `NSEvent` returned.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
        return;
    }
    if MONITORS.with_borrow(|m| !m.is_empty()) {
        return;
    }
    let mask = NSEventMask::MouseMoved
        | NSEventMask::LeftMouseUp
        | NSEventMask::RightMouseUp
        | NSEventMask::OtherMouseUp;
    let local = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        follow(None);
        event.as_ptr()
    });
    let global = RcBlock::new(|_: NonNull<NSEvent>| follow(None));
    let mut monitors = Vec::new();
    // SAFETY: the block returns the event it got; the monitor is removed
    // when no window shows.
    monitors.extend(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) });
    monitors.extend(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        mask, &global,
    ));
    MONITORS.set(monitors);
}

/// Every `"box-none"` window that shows (only `only`, given one) lets the
/// pointer through unless it is over one of its views. Not while a button
/// is held: the press stays with the window it went to.
fn follow(only: Option<usize>) {
    if NSEvent::pressedMouseButtons() != 0 {
        return;
    }
    let at = NSEvent::mouseLocation();
    // Taken out first: the picking reads the views, and AppKit may call
    // back while a window changes.
    let entries: Vec<(Retained<NSWindow>, u64, NodeId)> = WINDOWS.with_borrow(|w| {
        w.iter()
            .filter(|e| only.is_none_or(|o| o == key(&e.window)))
            .map(|e| (e.window.clone(), e.surface, e.id))
            .collect()
    });
    for (window, surface, id) in entries {
        if !shows(&window) {
            continue;
        }
        let Some(surface) = Surface::with_key(surface) else {
            // Its surface is gone: forgotten on the next turn, not from a
            // monitor's own handler. A window of the app's own is
            // forgotten as it closes.
            let k = key(&window);
            crate::surface::after(0, move || forget_key(k));
            continue;
        };
        // Its root not yet (or no longer) in this window.
        let Some(root) = crate::window::root_view(&surface, id) else {
            continue;
        };
        if root.ns().window().as_deref() != Some(&*window) {
            continue;
        }
        let p = root
            .ns()
            .convertPoint_fromView(window.convertPointFromScreen(at), None);
        let takes = crate::input::takes_pointer(&root, p.x as f32, p.y as f32);
        if window.ignoresMouseEvents() == takes {
            window.setIgnoresMouseEvents(!takes);
        }
    }
}
