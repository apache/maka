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
//! live resize once it settles. Every notification but a move's or a
//! resize's also moves the surface's display link to a window that shows
//! ([`Surface::follow_windows`]). The displays are `NSScreen.screens`, sent
//! to the engine before the app starts and again on
//! `NSApplicationDidChangeScreenParametersNotification`
//! ([`crate::system`]). Cocoa's screen coordinates go up from the primary
//! screen's bottom; NSH's go down from its top ([`to_bounds`]).
//!
//! AppKit keeps a zoomed window's frame from before the zoom to itself, so
//! the watch keeps the last frame it saw windowed: a maximized or full
//! screen window's placement. The frames a zoom animates through are not
//! windowed ones ([`will_zoom`]).

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
};

use block2::RcBlock;
use nsh_core::{
    NodeId,
    desktop::{self, Display, DisplayId, WindowMode, WindowPlacement, WindowState},
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
    NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
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
    /// A zoom is under way ([`will_zoom`]): the frames AppKit animates
    /// through are not windowed ones.
    zooming: Cell<bool>,
    /// A placement asked for while the window was in full screen: applied
    /// once it has left it.
    after_full_screen: Cell<Option<WindowPlacement>>,
    /// Its full screen transitions and a hide waiting for them ([`hide`]).
    full_screen: Cell<FullScreenHide>,
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

    /// `event` applied to the window's [`FullScreenHide`]: what to do now.
    fn full_screen_step(&self, event: impl FnOnce(&mut FullScreenHide) -> Step) -> Step {
        let mut model = self.full_screen.get();
        let step = event(&mut model);
        self.full_screen.set(model);
        step
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop();
    }
}

// --- Hiding a window in full screen -------------------------------------------------------

/// A full screen window has a space of its own. Ordered out there, it
/// leaves the space behind, empty, and the user on it: a window the app
/// hides in full screen leaves full screen first and is ordered out once
/// it is back on its desktop (shown again, it is a window there, as a
/// full screen window closed and opened again in AppKit's apps). AppKit
/// ignores `toggleFullScreen:` while a transition animates, so a hide
/// asked for then waits for its end.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FullScreenHide {
    transition: Transition,
    /// Hidden by the app: ordered out once it has left full screen.
    hide: bool,
}

/// The transition AppKit animates a window through.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Transition {
    #[default]
    None,
    Entering,
    Leaving,
}

/// What a [`FullScreenHide`] event asks of the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    /// Nothing, for now.
    Wait,
    /// It is ordered out.
    OrderOut,
    /// It leaves full screen (`toggleFullScreen:`).
    Leave,
}

impl FullScreenHide {
    /// The app hides the window (`full`: it is in full screen).
    fn hide(&mut self, full: bool) -> Step {
        match self.transition {
            Transition::None if !full => {
                self.hide = false;
                Step::OrderOut
            }
            Transition::None => {
                self.hide = true;
                Step::Leave
            }
            Transition::Entering | Transition::Leaving => {
                self.hide = true;
                Step::Wait
            }
        }
    }

    /// The window shows again: a hide still waiting is dropped, and it
    /// stays in the mode it ends its transition in.
    fn show(&mut self) -> Step {
        self.hide = false;
        Step::Wait
    }

    fn will_enter(&mut self) -> Step {
        self.transition = Transition::Entering;
        Step::Wait
    }

    fn will_leave(&mut self) -> Step {
        self.transition = Transition::Leaving;
        Step::Wait
    }

    /// It is in full screen: hidden on the way in, it leaves again.
    fn entered(&mut self) -> Step {
        self.transition = Transition::None;
        if self.hide { Step::Leave } else { Step::Wait }
    }

    /// It is back on its desktop: hidden in full screen, it goes.
    fn left(&mut self) -> Step {
        self.transition = Transition::None;
        if std::mem::take(&mut self.hide) {
            Step::OrderOut
        } else {
            Step::Wait
        }
    }
}

/// The app hides `window`, observed with `watch`: whether it is ordered
/// out now. A window in full screen (or on its way in or out) leaves it
/// first, and [`crate::window::hidden_after_full_screen`] orders it out.
pub(crate) fn hide(watch: &Watch, window: &NSWindow) -> bool {
    // Before `toggleFullScreen:`, which posts the will-exit notification
    // at once.
    match watch.full_screen_step(|m| m.hide(crate::chrome::full_screen(window))) {
        Step::OrderOut => true,
        Step::Leave => {
            window.toggleFullScreen(None);
            false
        }
        Step::Wait => false,
    }
}

/// The window observed with `watch` shows: a hide waiting for full screen
/// to end is dropped.
pub(crate) fn shown(watch: &Watch) {
    watch.full_screen_step(FullScreenHide::show);
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
    watch.zooming.set(false);
    watch.full_screen.set(FullScreenHide::default());
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
            // Shown, hidden, minimized, covered, on another screen or the
            // key one: the display link follows a window that shows.
            surface.follow_windows();
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
        // Hidden in full screen: it goes now that it is back on the
        // desktop it came from.
        if with_watch(&surface, target, |w| {
            w.full_screen_step(FullScreenHide::left)
        }) == Some(Step::OrderOut)
        {
            crate::window::hidden_after_full_screen(&surface, target);
        }
    });
    let entered_full_screen = RcBlock::new(move |_: NonNull<NSNotification>| {
        let Some(surface) = Surface::with_key(key) else {
            return;
        };
        // Hidden on its way into full screen: it leaves at once.
        let leave = with_watch(&surface, target, |w| {
            (w.full_screen_step(FullScreenHide::entered) == Step::Leave)
                .then(|| w.window())
                .flatten()
        });
        if let Some(Some(window)) = leave {
            window.toggleFullScreen(None);
        }
        report(&surface, target);
        surface.follow_windows();
    });
    let will_enter = RcBlock::new(move |_: NonNull<NSNotification>| {
        if let Some(surface) = Surface::with_key(key) {
            with_watch(&surface, target, |w| {
                w.full_screen_step(FullScreenHide::will_enter)
            });
        }
    });
    let will_leave = RcBlock::new(move |_: NonNull<NSNotification>| {
        if let Some(surface) = Surface::with_key(key) {
            with_watch(&surface, target, |w| {
                w.full_screen_step(FullScreenHide::will_leave)
            });
        }
    });
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: immutable AppKit constants.
    let (changes, settling) = unsafe {
        (
            [
                NSWindowDidEndLiveResizeNotification,
                NSWindowDidMiniaturizeNotification,
                NSWindowDidDeminiaturizeNotification,
                NSWindowDidChangeScreenNotification,
                NSWindowDidBecomeKeyNotification,
                NSWindowDidResignKeyNotification,
                // Ordered onto the screen or off it.
                NSWindowDidChangeOcclusionStateNotification,
            ],
            [NSWindowDidMoveNotification, NSWindowDidResizeNotification],
        )
    };
    let mut observers = Vec::with_capacity(changes.len() + settling.len() + 4);
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
    // SAFETY: immutable AppKit constants.
    unsafe {
        add(NSWindowWillEnterFullScreenNotification, &will_enter);
        add(NSWindowDidEnterFullScreenNotification, &entered_full_screen);
        add(NSWindowWillExitFullScreenNotification, &will_leave);
        add(NSWindowDidExitFullScreenNotification, &left_full_screen);
    }
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
    if full || zoomed || minimized {
        watch.zooming.set(false);
    } else if !watch.zooming.get() {
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

/// `window` is about to zoom or leave its zoom (its delegate's
/// `windowShouldZoom:toFrame:`, which every `zoom:` asks: the zoom button,
/// the Window menu, a double click on the title bar, [`set_mode`]). AppKit
/// animates the frame, and the moves on the way are reported while the
/// window is not zoomed yet: zooming in keeps the frame it has now as its
/// windowed frame, until it is zoomed.
pub(crate) fn will_zoom(watch: &Watch, window: &NSWindow) {
    if window.isZoomed() || crate::chrome::full_screen(window) {
        return;
    }
    watch.windowed.set(Some(window.frame()));
    watch.zooming.set(true);
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
    display.cutouts = notch(
        screen.auxiliaryTopLeftArea(),
        screen.auxiliaryTopRightArea(),
        screen.safeAreaInsets().top,
        frame,
        primary_height,
    )
    .into_iter()
    .collect();
    display
}

/// The notch of a screen of `frame` (Cocoa coordinates), in NSH's, from
/// `NSScreen`'s auxiliary top areas (`left`, `right`) and its safe area's
/// top inset: [`nsh_core::desktop::notch`], which the GPUI backend computes
/// it with too.
fn notch(
    left: NSRect,
    right: NSRect,
    safe_top: f64,
    frame: NSRect,
    primary_height: f64,
) -> Option<Bounds<Points>> {
    let area = |r: NSRect| size(px(r.size.width as f32), px(r.size.height as f32));
    desktop::notch(
        to_bounds(frame, primary_height),
        area(left),
        area(right),
        px(safe_top as f32),
    )
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

    fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }

    fn bounds(x: f32, y: f32, width: f32, height: f32) -> Bounds<Points> {
        Bounds::new(point(px(x), px(y)), size(px(width), px(height)))
    }

    #[test]
    fn a_screens_notch_is_read_in_screen_coordinates() {
        // The built-in screen right of a 2560 × 1440 primary display, its
        // bottom 200 points below the primary's (Cocoa's y grows up), its
        // auxiliary areas in Cocoa coordinates.
        let frame = rect(2560.0, -200.0, 1512.0, 982.0);
        let left = rect(2560.0, 750.0, 664.0, 32.0);
        let right = rect(3409.0, 750.0, 663.0, 32.0);
        // Its top is 1440 - 782 = 658 points below the primary's.
        assert_eq!(
            notch(left, right, 32.0, frame, 1440.0),
            Some(bounds(3224.0, 658.0, 185.0, 32.0)),
        );
        assert_eq!(notch(NSRect::ZERO, NSRect::ZERO, 0.0, frame, 1440.0), None);
    }

    #[test]
    fn a_window_hides_at_once_out_of_full_screen() {
        let mut m = FullScreenHide::default();
        assert_eq!(m.hide(false), Step::OrderOut);
        // Nothing waits: a later exit from full screen hides nothing.
        assert_eq!(m.will_leave(), Step::Wait);
        assert_eq!(m.left(), Step::Wait);
    }

    #[test]
    fn a_full_screen_window_leaves_full_screen_before_it_hides() {
        let mut m = FullScreenHide::default();
        assert_eq!(m.hide(true), Step::Leave);
        // A second hide while it leaves asks for nothing more.
        assert_eq!(m.will_leave(), Step::Wait);
        assert_eq!(m.hide(true), Step::Wait);
        assert_eq!(m.left(), Step::OrderOut);
        // Hidden once: entering and leaving again keeps it shown.
        assert_eq!(m.will_enter(), Step::Wait);
        assert_eq!(m.entered(), Step::Wait);
        assert_eq!(m.will_leave(), Step::Wait);
        assert_eq!(m.left(), Step::Wait);
    }

    #[test]
    fn a_window_hidden_on_its_way_into_full_screen_leaves_once_in() {
        let mut m = FullScreenHide::default();
        assert_eq!(m.will_enter(), Step::Wait);
        // `toggleFullScreen:` would be ignored mid-transition.
        assert_eq!(m.hide(true), Step::Wait);
        assert_eq!(m.entered(), Step::Leave);
        assert_eq!(m.will_leave(), Step::Wait);
        assert_eq!(m.left(), Step::OrderOut);
    }

    #[test]
    fn a_window_hidden_while_the_user_leaves_full_screen_hides_after() {
        let mut m = FullScreenHide::default();
        assert_eq!(m.will_leave(), Step::Wait);
        // The mask may already be off: the transition decides.
        assert_eq!(m.hide(false), Step::Wait);
        assert_eq!(m.left(), Step::OrderOut);
    }

    #[test]
    fn showing_again_drops_a_hide_that_waits() {
        let mut m = FullScreenHide::default();
        assert_eq!(m.hide(true), Step::Leave);
        assert_eq!(m.will_leave(), Step::Wait);
        assert_eq!(m.show(), Step::Wait);
        // It ends windowed and shown.
        assert_eq!(m.left(), Step::Wait);

        let mut m = FullScreenHide::default();
        assert_eq!(m.will_enter(), Step::Wait);
        assert_eq!(m.hide(true), Step::Wait);
        assert_eq!(m.show(), Step::Wait);
        // It stays in full screen.
        assert_eq!(m.entered(), Step::Wait);
    }

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
