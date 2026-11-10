//! A window's state (`WindowRef.state()`, the main window's in the
//! environment's `window_state`), the displays (`displays()`) and the
//! requests that change the mode and the bounds, on AppKit.
//!
//! Each window is observed ([`Watch`]): a move, a resize,
//! (de)miniaturizing, entering or leaving full screen, a change of screen,
//! of key status and being ordered onto the screen or off it read its
//! state again. The main window's goes into the environment (the engine
//! holds a move back until the window stops); a window of the app's own
//! reports it on its root ([`crate::window::state_changed`]), a move or a
//! live resize once it settles. The displays are `NSScreen.screens`, sent
//! to the engine before the app starts and again on
//! `NSApplicationDidChangeScreenParametersNotification`
//! ([`crate::system`]). Cocoa's screen coordinates go up from the primary
//! screen's bottom; NSH's go down from its top ([`to_bounds`]).
//!
//! AppKit keeps a zoomed window's frame from before the zoom to itself, so
//! the watch keeps the last frame it saw windowed: a maximized or full
//! screen window's placement.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
};

use block2::RcBlock;
use nsh_core::{
    NodeId,
    desktop::{Display, DisplayId, WindowMode, WindowPlacement, WindowState},
    geometry::{Bounds, Points, point, px, size},
};
use objc2::{
    MainThreadMarker, Message,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_app_kit::{
    NSApplication, NSScreen, NSWindow, NSWindowDidBecomeKeyNotification,
    NSWindowDidChangeOcclusionStateNotification, NSWindowDidChangeScreenNotification,
    NSWindowDidDeminiaturizeNotification, NSWindowDidEndLiveResizeNotification,
    NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
    NSWindowDidMiniaturizeNotification, NSWindowDidMoveNotification,
    NSWindowDidResignKeyNotification, NSWindowDidResizeNotification,
};
use objc2_core_graphics::{
    CGDisplayModelNumber, CGDisplaySerialNumber, CGDisplayUnitNumber, CGDisplayVendorNumber,
};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNumber, NSObjectProtocol, NSPoint, NSRect, NSSize,
    ns_string,
};

use crate::surface::Surface;

/// How long a window of the app's own stays still before its move or
/// resize is reported.
const SETTLE_MS: u64 = 150;

/// Which window of a surface a [`Watch`] observes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    /// The window the surface's root is in (the main window, or the
    /// embedding app's).
    Main,
    /// A window of the app's own, by its root node.
    Own(NodeId),
}

/// What is kept of an observed window.
#[derive(Default)]
pub(crate) struct Watch {
    /// The window observed.
    window: RefCell<Option<Weak<NSWindow>>>,
    /// Its notifications' observers (tokens of the default center).
    observers: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>>,
    /// Its frame when last seen windowed (Cocoa coordinates).
    windowed: Cell<Option<NSRect>>,
    /// A placement asked for while the window was in full screen: applied
    /// once it has left it.
    after_full_screen: Cell<Option<WindowPlacement>>,
    /// Counts moves and resizes, so only the last one of a burst reports.
    settle: Cell<u64>,
}

impl Watch {
    pub(crate) fn stop(&self) {
        let center = NSNotificationCenter::defaultCenter();
        for observer in self.observers.borrow_mut().drain(..) {
            // SAFETY: an observer token of the default center.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
        self.window.replace(None);
    }

    /// The window observed, while there is one.
    fn window(&self) -> Option<Retained<NSWindow>> {
        self.window.borrow().as_ref().and_then(Weak::load)
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The watch of `target`, borrowed for `f`.
fn with_watch<R>(surface: &Surface, target: Target, f: impl FnOnce(&Watch) -> R) -> Option<R> {
    match target {
        Target::Main => Some(f(&surface.window)),
        Target::Own(id) => crate::window::with_watch(surface, id, f),
    }
}

/// The root moved to a window (or out of one): observes that window.
pub(crate) fn watch(surface: &Rc<Surface>) {
    let window = surface.root.ns().window();
    observe(surface, Target::Main, &surface.window, window.as_deref());
}

/// Observes `window` (or nothing) as `target`'s, with `watch`.
pub(crate) fn observe(surface: &Surface, target: Target, watch: &Watch, window: Option<&NSWindow>) {
    let watched = watch.window();
    if window.map(|w| w as *const NSWindow) == watched.as_deref().map(|w| w as *const _) {
        return;
    }
    watch.stop();
    watch.windowed.set(None);
    let Some(window) = window else {
        return;
    };
    let key = surface.key();
    let changed_block = RcBlock::new(move |_: NonNull<NSNotification>| {
        if let Some(surface) = Surface::with_key(key) {
            if let Target::Own(_) = target {
                with_watch(&surface, target, |w| w.settle.set(w.settle.get() + 1));
            }
            report(&surface, target);
        }
    });
    let settling_block = RcBlock::new(move |_: NonNull<NSNotification>| {
        let Some(surface) = Surface::with_key(key) else {
            return;
        };
        match target {
            // The engine holds the main window's moves back itself.
            Target::Main => report(&surface, target),
            Target::Own(_) => {
                let Some(generation) = with_watch(&surface, target, |w| {
                    w.settle.set(w.settle.get() + 1);
                    w.settle.get()
                }) else {
                    return;
                };
                crate::surface::after(SETTLE_MS, move || {
                    if let Some(surface) = Surface::with_key(key)
                        && with_watch(&surface, target, |w| w.settle.get()) == Some(generation)
                    {
                        report(&surface, target);
                    }
                });
            }
        }
    });
    let left_full_screen = RcBlock::new(move |_: NonNull<NSNotification>| {
        let Some(surface) = Surface::with_key(key) else {
            return;
        };
        let pending = with_watch(&surface, target, |w| {
            (w.after_full_screen.take(), w.window())
        });
        if let Some((Some(placement), Some(window))) = pending {
            with_watch(&surface, target, |w| {
                set_placement(w, &window, placement);
            });
        }
        crate::window::left_full_screen(&surface, target);
        report(&surface, target);
    });
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: immutable AppKit constants.
    let (changes, settling) = unsafe {
        (
            [
                NSWindowDidEndLiveResizeNotification,
                NSWindowDidMiniaturizeNotification,
                NSWindowDidDeminiaturizeNotification,
                NSWindowDidEnterFullScreenNotification,
                NSWindowDidChangeScreenNotification,
                NSWindowDidBecomeKeyNotification,
                NSWindowDidResignKeyNotification,
                // Ordered onto the screen or off it.
                NSWindowDidChangeOcclusionStateNotification,
            ],
            [NSWindowDidMoveNotification, NSWindowDidResizeNotification],
        )
    };
    let mut observers = Vec::with_capacity(changes.len() + settling.len() + 1);
    let mut add = |name, block: &RcBlock<dyn Fn(NonNull<NSNotification>)>| {
        // SAFETY: AppKit posts these on the main thread, where the block
        // runs (no queue: at once, so the state is current after a
        // command that moved the window); the observer is removed in
        // `stop`.
        observers.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), Some(window), None, block)
        });
    };
    for name in changes {
        add(name, &changed_block);
    }
    for name in settling {
        add(name, &settling_block);
    }
    // SAFETY: an immutable AppKit constant.
    add(
        unsafe { NSWindowDidExitFullScreenNotification },
        &left_full_screen,
    );
    watch.observers.replace(observers);
    watch
        .window
        .replace(Some(Weak::from_retained(&window.retain())));
}

/// `target`'s window changed: its state is read and reported.
pub(crate) fn report(surface: &Surface, target: Target) {
    match target {
        Target::Main => changed(surface),
        Target::Own(id) => crate::window::state_changed(surface, id),
    }
}

/// The main window changed: the environment gets its state. Its title
/// bar's controls go back where the app put them.
pub(crate) fn changed(surface: &Surface) {
    // Full screen, another screen or a resize: AppKit laid out the title
    // bar again, and its area may have changed.
    crate::chrome::update_area(surface);
    let state = read(surface);
    crate::window::main_changed(surface, state.as_ref());
    let mut env = surface.environment.get();
    if env.window_state != state {
        env.window_state = state;
        surface.set_environment(env);
    }
}

/// The state of the surface's main window, `None` without one.
pub(crate) fn read(surface: &Surface) -> Option<WindowState> {
    let window = surface.root.ns().window()?;
    Some(read_window(&surface.window, &window))
}

/// The state of `window`, observed with `watch`.
pub(crate) fn read_window(watch: &Watch, window: &NSWindow) -> WindowState {
    let mtm = MainThreadMarker::from(window);
    let primary = primary_height(mtm);
    let frame = window.frame();
    let full = crate::chrome::full_screen(window);
    let zoomed = !full && window.isZoomed();
    let minimized = window.isMiniaturized();
    // A minimized window is not hidden: it is `minimized` alone.
    let hidden =
        !minimized && (NSApplication::sharedApplication(mtm).isHidden() || !window.isVisible());
    if !full && !zoomed && !minimized {
        watch.windowed.set(Some(frame));
    }
    let bounds = to_bounds(frame, primary);
    let windowed = to_bounds(watch.windowed.get().unwrap_or(frame), primary);
    let mode = if full {
        WindowMode::FullScreen
    } else if zoomed {
        WindowMode::Maximized
    } else {
        WindowMode::Normal
    };
    let placement = WindowPlacement::new(
        mode,
        if mode == WindowMode::Normal {
            bounds
        } else {
            windowed
        },
    );
    let mut state = WindowState::new(bounds, placement);
    state.minimized = minimized;
    state.visible = !hidden && !minimized;
    state.focused = crate::window::is_key(window);
    state.content_bounds = to_bounds(window.contentRectForFrameRect(frame), primary);
    state.display = window
        .screen()
        .and_then(|s| screen_number(&s))
        .map(stable_id);
    state.scale_factor = window.backingScaleFactor() as f32;
    state
}

/// The displays, the primary one first.
pub(crate) fn displays(mtm: MainThreadMarker) -> Vec<Display> {
    let primary = primary_height(mtm);
    NSScreen::screens(mtm)
        .iter()
        .map(|s| display(&s, primary))
        .collect()
}

/// The screen of display `id`, if it is connected.
pub(crate) fn screen(mtm: MainThreadMarker, id: DisplayId) -> Option<Retained<NSScreen>> {
    NSScreen::screens(mtm)
        .iter()
        .find(|s| screen_number(s).map(stable_id) == Some(id))
}

/// `WindowRef.setPlacement`: the window restored to `placement`'s bounds,
/// then zoomed or in full screen as its mode says. Leaving full screen
/// takes AppKit's animation: the bounds apply once it is done.
pub(crate) fn set_placement(watch: &Watch, window: &NSWindow, placement: WindowPlacement) {
    let primary = primary_height(MainThreadMarker::from(window));
    let frame = from_bounds(placement.bounds, primary);
    let full = crate::chrome::full_screen(window);
    match placement.mode {
        WindowMode::FullScreen if full => {
            // Where it returns to.
            watch.windowed.set(Some(frame));
        }
        WindowMode::FullScreen => {
            window.setFrame_display(frame, true);
            watch.windowed.set(Some(frame));
            window.toggleFullScreen(None);
        }
        _ if full => {
            watch.after_full_screen.set(Some(placement));
            window.toggleFullScreen(None);
        }
        WindowMode::Normal => {
            if window.isZoomed() {
                window.zoom(None);
            }
            window.setFrame_display(frame, true);
        }
        WindowMode::Maximized => {
            if window.isZoomed() {
                window.zoom(None);
            }
            window.setFrame_display(frame, true);
            watch.windowed.set(Some(frame));
            window.zoom(None);
        }
    }
}

/// `WindowRef.setMode`: puts the window in `mode`, keeping its windowed
/// bounds (an intent: asking for the mode it is in changes nothing).
pub(crate) fn set_mode(watch: &Watch, window: &NSWindow, mode: WindowMode) {
    let full = crate::chrome::full_screen(window);
    let zoomed = !full && window.isZoomed();
    match mode {
        WindowMode::FullScreen if !full => window.toggleFullScreen(None),
        WindowMode::Maximized if full => {
            let primary = primary_height(MainThreadMarker::from(window));
            let windowed = watch.windowed.get().unwrap_or_else(|| window.frame());
            watch.after_full_screen.set(Some(WindowPlacement::new(
                WindowMode::Maximized,
                to_bounds(windowed, primary),
            )));
            window.toggleFullScreen(None);
        }
        WindowMode::Maximized if !zoomed => window.zoom(None),
        WindowMode::Normal if full => window.toggleFullScreen(None),
        WindowMode::Normal if zoomed => window.zoom(None),
        _ => {}
    }
}

/// Centers `window` on `screen`'s visible part (below the menu bar,
/// beside the Dock), its title bar on it when the window is taller.
pub(crate) fn center_on(window: &NSWindow, screen: &NSScreen) {
    window.setFrameOrigin(centered(window.frame().size, screen.visibleFrame()));
}

/// The origin of a frame `size` centered in `area` (Cocoa coordinates),
/// its top kept inside when it is taller.
pub(crate) fn centered(size: NSSize, area: NSRect) -> NSPoint {
    let x = area.origin.x + ((area.size.width - size.width) / 2.0).max(0.0);
    let y = area.origin.y + area.size.height - size.height;
    let y = y - ((area.size.height - size.height) / 2.0).max(0.0);
    NSPoint::new(x, y)
}

/// The height of the primary screen, whose bottom left corner Cocoa's
/// screen coordinates start from.
pub(crate) fn primary_height(mtm: MainThreadMarker) -> f64 {
    NSScreen::screens(mtm)
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height)
}

/// `screen` as a display.
fn display(screen: &NSScreen, primary_height: f64) -> Display {
    let frame = screen.frame();
    let id = screen_number(screen).map_or(DisplayId::default(), stable_id);
    let mut display = Display::new(
        id,
        to_bounds(frame, primary_height),
        to_bounds(screen.visibleFrame(), primary_height),
        frame.origin.x == 0.0 && frame.origin.y == 0.0,
    );
    display.name = screen.localizedName().to_string();
    display.scale_factor = screen.backingScaleFactor() as f32;
    let rate = screen.maximumFramesPerSecond();
    display.refresh_rate = (rate > 0).then_some(rate as f32);
    display
}

/// The screen's display id (`CGDirectDisplayID`).
fn screen_number(screen: &NSScreen) -> Option<u32> {
    let number = screen
        .deviceDescription()
        .objectForKey(ns_string!("NSScreenNumber"))?;
    let number = number.downcast::<NSNumber>().ok()?;
    Some(number.unsignedIntValue())
}

/// An id of display `number` that stays from one launch to the next: its
/// vendor, model and serial number (the unit number for a display that has
/// no serial number, telling identical ones apart), where the display id
/// itself may change.
fn stable_id(number: u32) -> DisplayId {
    let vendor = CGDisplayVendorNumber(number);
    let model = CGDisplayModelNumber(number);
    let serial = CGDisplaySerialNumber(number);
    let name = if serial != 0 {
        format!("{vendor:x}:{model:x}:{serial:x}")
    } else {
        format!("{vendor:x}:{model:x}:unit{}", CGDisplayUnitNumber(number))
    };
    DisplayId::from_name(name.as_bytes())
}

/// A Cocoa screen rectangle (from the primary screen's bottom, `y` up) in
/// NSH's coordinates (from its top, `y` down).
pub(crate) fn to_bounds(rect: NSRect, primary_height: f64) -> Bounds<Points> {
    let top = primary_height - (rect.origin.y + rect.size.height);
    Bounds::new(
        point(px(rect.origin.x as f32), px(top as f32)),
        size(px(rect.size.width as f32), px(rect.size.height as f32)),
    )
}

/// [`to_bounds`]' inverse.
pub(crate) fn from_bounds(bounds: Bounds<Points>, primary_height: f64) -> NSRect {
    let height = f64::from(bounds.size.height.0);
    NSRect::new(
        NSPoint::new(
            f64::from(bounds.origin.x.0),
            primary_height - f64::from(bounds.origin.y.0) - height,
        ),
        NSSize::new(f64::from(bounds.size.width.0), height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_rectangles_flip_to_the_primary_screens_top() {
        // A window 600 tall whose top is 100 below a 900 tall primary
        // screen's top.
        let rect = NSRect::new(NSPoint::new(40.0, 200.0), NSSize::new(800.0, 600.0));
        let bounds = to_bounds(rect, 900.0);
        assert_eq!(
            bounds,
            Bounds::new(point(px(40.0), px(100.0)), size(px(800.0), px(600.0)))
        );
        assert_eq!(from_bounds(bounds, 900.0), rect);
        // A display above the primary one has negative `y`s.
        let above = NSRect::new(NSPoint::new(0.0, 900.0), NSSize::new(1920.0, 1080.0));
        assert_eq!(to_bounds(above, 900.0).origin.y, px(-1080.0));
    }

    #[test]
    fn centered_frames_keep_their_top_on_the_area() {
        let area = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1000.0, 800.0));
        assert_eq!(
            centered(NSSize::new(400.0, 200.0), area),
            NSPoint::new(300.0, 300.0)
        );
        // Taller than the area: its top at the area's top.
        assert_eq!(
            centered(NSSize::new(400.0, 1000.0), area),
            NSPoint::new(300.0, -200.0)
        );
    }
}
