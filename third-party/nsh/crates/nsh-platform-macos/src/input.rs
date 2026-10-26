//! Pointer and keyboard input of a surface: hit testing, touches for the
//! JS responder system, presses, hover / pressed states, cursors, native
//! pan / pinch / rotation values, and routing mouse wheel, trackpad and
//! keyboard scrolling to the scroll views.
//!
//! The root view takes every mouse event inside it (its `hitTest:`
//! returns itself) and hands it to [`event`], except where nsh's own hit
//! testing lands on a hosted AppKit view (text fields, web views): those
//! get their own events, so presses and pans never start on them. AppKit's hit testing does not decide: it would hand a web view
//! clicks meant for a menu outside its parent's frame or a transformed
//! view nsh draws over it, and clicks on web views whose layers are
//! hidden, that animate out or that are under `pointerEvents: "none"`.
//! Wheel events a hosted view does not use come up the responder chain to
//! the root as well.
//!
//! Hit testing walks the views itself: AppKit's knows nothing of
//! `overflow: hidden`, `pointerEvents`, hit slop or layer transforms.
//! Points go into children through their frames, their parent's scroll
//! offset (the container's bounds origin) and their transforms (inverted).
//! Outside a view's bounds, only the area its descendants cover
//! (`MountItem::Overflow`: a dropdown under its field) is looked into, as
//! on iOS and Android.
//!
//! Presses follow React Native and the other backends: the innermost view
//! listening to press events gets them (or the pressable text span under
//! the pointer; how it looks while pressed is the app's `activeStyle`,
//! applied by the core from the reported states). A move beyond
//! 6 pt starts the innermost pan that takes that direction; beyond 10 pt
//! the press is over. Mouse drags never scroll: dragging the content is a
//! touchscreen's way to scroll, the mouse scrolls with the wheel, the
//! trackpad, the keyboard and the indicator, and its drags are the app's
//! (pans, responders). Mouse drags on selectable text select it
//! ([`crate::text`]) instead.
//!
//! A view with a `panActivation` around the pointer gates it
//! ([`Gate`], `PanActivation::decide` on every move): the pans around the
//! view wait until its pan fails, and never take the drag once it activates; the activation goes to JS with the move's touches
//! (`TouchEvent::activated`), where the view becomes the responder.
//!
//! A scroll stays on the scroll view it began in (a trackpad gesture and
//! its momentum until they end, mouse wheel notches while they come within
//! 200 ms), as in browsers: inner views passing under the pointer do not
//! take it over, and its view reaching an edge does not hand the rest to
//! an outer one. Trackpad pinches (`magnifyWithEvent:`) and rotations
//! (`rotateWithEvent:`) drive the native pinch / rotation values; mice
//! pinch with Control + wheel.
//!
//! The decisions over plain data (what a pointer going down may start, a
//! press's events, hover changes, hit areas, pinches, wheel latching) are
//! [`nsh_core::input`]'s, shared by the desktop backends.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use dispatch2::{DispatchQueue, DispatchTime};
use nsh_core::{
    Command, Cursor, EventKind, EventPayload, GestureValues, NodeId, PayloadValue, PointerEvents,
    ROOT_ID, TouchEvent, TouchPhase, TouchPoint, ViewKind,
    geometry::{Points, point},
    input::{
        self, Gate, HitArea, PAN_SLOP, PRESS_SLOP, VelocityTracker, ZOOM_IDLE, has_press, laid_out,
        latch_holds, transforms,
    },
    tailwind::state::{HOVERED, PRESSED},
};
use objc2::{AnyThread, ClassType, rc::Retained, sel};
use objc2_app_kit::{NSCursor, NSEvent, NSEventModifierFlags, NSEventPhase, NSEventType, NSImage};
use objc2_foundation::NSSize;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{
    surface::Surface,
    view::{NshView, ViewObj},
};

/// Points a mouse wheel line scrolls (`scrollingDeltaY` counts lines for
/// mice, accelerated by the system), as `NSScrollView`'s line scroll.
const WHEEL_LINE: f32 = 10.0;
/// The mouse's back button (`buttonNumber`), as Linux's button 8.
const BACK_BUTTON: isize = 3;

type Press = input::Press<NshView>;

/// A pinch / rotation in progress.
#[derive(Clone)]
struct Transform {
    view: NshView,
    pinch: bool,
    rotation: bool,
    scale: f32,
    degrees: f32,
}

/// Pointer state of one surface.
#[derive(Default)]
pub(crate) struct Input {
    /// The mouse, while its left button is down.
    pointer: RefCell<Option<Pointer>>,
    /// A trackpad pinch.
    pinch: RefCell<Option<Transform>>,
    /// A trackpad rotation.
    rotation: RefCell<Option<Transform>>,
    /// A pinch by Control + mouse wheel, with the generation of its end
    /// timer.
    zoom: RefCell<Option<(Transform, u64)>>,
    /// A trackpad scroll gesture.
    wheel: RefCell<Option<Wheel>>,
    /// The scroll view the system's momentum after a gesture goes to.
    momentum: RefCell<Option<NshView>>,
    /// The scroll view mouse wheel notches go to while they keep coming,
    /// whether they scroll horizontally, and when the last one came (ms).
    latch: RefCell<Option<(NshView, bool, f64)>>,
    /// Views that track `HOVERED` or listen to hover events.
    hover_tracked: RefCell<FxHashSet<NodeId>>,
    /// Views listening to mouse motion; other apps skip the extra hit test.
    mouse_tracked: RefCell<FxHashSet<NodeId>>,
    /// Views that are hovered now.
    hovered: RefCell<Vec<NshView>>,
    /// Native gesture values by view.
    gestures: RefCell<FxHashMap<NodeId, (objc2::rc::Weak<ViewObj>, GestureValues)>>,
    /// The JS responder blocks native scrolling and pans.
    js_block: Cell<bool>,
    /// Where the mouse last was (root coordinates), while over the root.
    last: Cell<Option<(f32, f32)>>,
    /// Hovered views and the cursor are picked again on the main queue
    /// (what is under the mouse moved).
    repick: Cell<bool>,
    /// The deadline the armed repick waits for (display-link ms): a burst
    /// of content moves re-arms it, so the pick lands once, settled.
    repick_at: Cell<f64>,
    /// Next touch identifier.
    next_id: Cell<u32>,
    /// Next press / zoom generation (invalidates callbacks of
    /// earlier ones).
    next_gen: Cell<u64>,
    /// Hears the modifier keys change, once a view hears hover moves.
    flags: FlagsMonitor,
}

/// A local monitor of the modifier keys (`flagsChanged`), which reach only
/// the first responder: a change while the mouse rests is a hover move
/// where it is ([`modifiers_changed`]). Removed with the surface.
#[derive(Default)]
struct FlagsMonitor(RefCell<Option<Retained<objc2::runtime::AnyObject>>>);

impl Drop for FlagsMonitor {
    fn drop(&mut self) {
        if let Some(monitor) = self.0.borrow_mut().take() {
            // SAFETY: a monitor `addLocalMonitorForEventsMatchingMask`
            // returned.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    }
}

/// What a drag on a view may start.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Candidate {
    /// A pan with these values (both when it only has listeners).
    Pan { x: bool, y: bool },
}

impl Candidate {
    /// Whether a drag by `(dx, dy)` starts it: single-axis pans take
    /// mostly-along-their-axis movements, so a horizontal pan coexists
    /// with a vertical one around it.
    fn accepts(self, dx: f32, dy: f32) -> bool {
        let horizontal = dx.abs() > dy.abs();
        match self {
            Candidate::Pan { x, y } => (x && y) || (x && horizontal) || (y && !horizontal),
        }
    }
}

/// What the pointer is doing.
#[derive(Debug, Clone, PartialEq)]
enum Mode {
    /// Not past the pan slop yet.
    Idle,
    /// Past it, with nothing to drag.
    Free,
    /// Dragging a pan view.
    Pan(NshView),
    /// Dragging a scroll view's indicator as a scroll bar's thumb, from
    /// where the drag began.
    Thumb(NshView, (f32, f32)),
    /// Selecting the text of this view (from where the drag began).
    Select(NshView),
}

/// The mouse while its button is down.
struct Pointer {
    /// Touch identifier for JS.
    id: u32,
    x: f32,
    y: f32,
    start: (f32, f32),
    time: f64,
    velocity: VelocityTracker,
    /// The innermost view under it when it went down.
    target: NshView,
    /// The views around it that listen to touches, target outwards.
    path: Vec<NodeId>,
    /// Its touches are reported to JS.
    reporting: bool,
    press: Option<Press>,
    /// What a drag may start, innermost first.
    candidates: Vec<(NshView, Candidate)>,
    /// The undecided `panActivation` around it.
    gate: Option<Gate>,
    /// Views that track `PRESSED` and are pressed by it.
    pressed: Vec<NshView>,
    mode: Mode,
    /// It moved (a JS responder granted now took it from a native press).
    moved: bool,
}

/// A trackpad scroll gesture.
struct Wheel {
    /// The scroll view it moves (none until a delta finds one).
    view: Option<NshView>,
    /// Accumulated deltas, for the velocity.
    total: (f32, f32),
    velocity: VelocityTracker,
    /// Began with fingers resting (`MayBegin`) and has not scrolled yet.
    held: bool,
}

// --- The views' hooks ---------------------------------------------------------------

/// The app stopped: forgets the pointer, hovered views and gestures.
pub(crate) fn reset(surface: &Surface) {
    crate::file_drop::reset(surface);
    let input = &surface.input;
    input.pointer.borrow_mut().take();
    input.pinch.borrow_mut().take();
    input.rotation.borrow_mut().take();
    input.zoom.borrow_mut().take();
    input.wheel.borrow_mut().take();
    input.momentum.borrow_mut().take();
    input.latch.borrow_mut().take();
    input.hover_tracked.borrow_mut().clear();
    input.mouse_tracked.borrow_mut().clear();
    input.hovered.borrow_mut().clear();
    input.gestures.borrow_mut().clear();
    input.js_block.set(false);
}

/// `TrackStates`.
pub(crate) fn track_states(surface: &Rc<Surface>, view: &NshView, states: u8) {
    {
        let mut s = view.state_mut();
        s.tracked = states;
        // The core keeps the states still tracked and forgets the rest
        // (`Core::update_tracking`): so do we, or a change it was not told
        // about (the pointer leaving a view whose hover was tracked
        // throughout) would never reach it.
        s.states &= states;
    }
    update_hover_tracking(surface, view);
}

/// Whether hovering `view` matters: for its `hover:` styles (the
/// `HOVERED` state) or its `onHoverIn` / `onHoverOut` / `onHoverMove`.
fn hoverable(view: &NshView) -> bool {
    let s = view.state();
    input::hoverable(s.tracked, s.events)
}

fn update_hover_tracking(surface: &Surface, view: &NshView) {
    let id = view.state().id;
    if view.state().events.contains(EventKind::MouseMove) {
        surface.input.mouse_tracked.borrow_mut().insert(id);
    } else {
        surface.input.mouse_tracked.borrow_mut().remove(&id);
    }
    let mut tracked = surface.input.hover_tracked.borrow_mut();
    if hoverable(view) {
        tracked.insert(id);
    } else {
        tracked.remove(&id);
        // Not hovered as far as anyone knows: picked again if hovering it
        // matters again under the pointer.
        surface.input.hovered.borrow_mut().retain(|v| v != view);
    }
}

/// Sets or clears interaction state `bit` of `view` and reports the
/// states when they changed and the view tracks the bit.
pub(crate) fn set_state(surface: &Surface, view: &NshView, bit: u8, on: bool) {
    let (id, next) = {
        let mut s = view.state_mut();
        let Some(next) = input::next_states(s.tracked, s.states, bit, on) else {
            return;
        };
        s.states = next;
        (s.id, next)
    };
    surface.control(|c| c.set_states(id, next));
}

/// `Gestures`.
pub(crate) fn gestures(surface: &Rc<Surface>, view: &NshView, values: GestureValues) {
    let id = view.state().id;
    let mut gestures = surface.input.gestures.borrow_mut();
    if values.is_empty() {
        gestures.remove(&id);
    } else {
        let obj: &ViewObj = view;
        gestures.insert(id, (objc2::rc::Weak::from(obj), values));
    }
}

/// The view's events changed (presses change its cursor, hover handlers
/// have it hovered). A handler added under the mouse hears it on the
/// batch's pick (`content_moved`).
pub(crate) fn events_changed(surface: &Rc<Surface>, view: &NshView) {
    update_hover_tracking(surface, view);
    refresh_cursor(surface);
    release_invalid_control_focus(surface, view);
}

/// The view's props changed.
pub(crate) fn props_changed(surface: &Rc<Surface>, view: &NshView) {
    // `pointerEvents`, `hitSlop` and `delayLongPress` are
    // read from the state when the pointer goes down.
    release_invalid_control_focus(surface, view);
}

fn release_invalid_control_focus(surface: &Surface, view: &NshView) {
    if view.kind() == ViewKind::Input || is_key_control(view) {
        return;
    }
    let Some(window) = view.ns().window() else {
        return;
    };
    let focused = window.firstResponder().is_some_and(|responder| {
        responder
            .downcast_ref::<objc2_app_kit::NSView>()
            .and_then(NshView::from_ns)
            .is_some_and(|focused| focused == *view)
    });
    if focused && view.id() != ROOT_ID {
        window.makeFirstResponder(Some(surface.root.ns()));
    }
}

/// The view's style changed (cursor). The cursor follows on the next mouse
/// move.
pub(crate) fn style_changed(_view: &NshView) {}

/// `SetJsResponder` / `ClearJsResponder`. Runs while the mounter applies a
/// batch: it must not write animations (that borrows the mounter).
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    match command {
        Command::SetJsResponder { block } => {
            surface.input.js_block.set(*block);
            let Some(mut p) = surface.input.pointer.borrow_mut().take() else {
                return;
            };
            // Granted on a move: the JS gesture takes over from the native
            // press (a grant when the button goes down leaves inner presses
            // be, as they would have won the negotiation in React Native).
            if p.moved {
                cancel_press(surface, &mut p);
                release_pressed(surface, &mut p);
            }
            if *block && let Mode::Pan(view) = &p.mode {
                let view = view.clone();
                pan_end(surface, &view, &p, false);
                p.mode = Mode::Free;
            }
            put(surface, p);
        }
        Command::ClearJsResponder => surface.input.js_block.set(false),
        _ => {}
    }
}

// --- Cursors ------------------------------------------------------------------------

/// The cursor a view asks for, `None` to inherit its parent's.
fn cursor_of(cursor: Cursor) -> Option<Cursor> {
    match cursor {
        Cursor::Auto => None,
        other => Some(other),
    }
}

/// The AppKit cursor of `cursor` (AppKit has no public wait, progress or
/// help cursors: those show the arrow).
fn ns_cursor(cursor: Cursor) -> Retained<NSCursor> {
    // Zoom cursors are newer than the rest (macOS 15).
    let zoom = |sel| NSCursor::class().responds_to(sel);
    match cursor {
        Cursor::Pointer => NSCursor::pointingHandCursor(),
        Cursor::Text => NSCursor::IBeamCursor(),
        Cursor::Crosshair => NSCursor::crosshairCursor(),
        Cursor::Move | Cursor::Grab => NSCursor::openHandCursor(),
        Cursor::Grabbing => NSCursor::closedHandCursor(),
        Cursor::NotAllowed => NSCursor::operationNotAllowedCursor(),
        Cursor::ZoomIn if zoom(sel!(zoomInCursor)) => NSCursor::zoomInCursor(),
        Cursor::ZoomOut if zoom(sel!(zoomOutCursor)) => NSCursor::zoomOutCursor(),
        // Their replacements are macOS 15's.
        #[allow(deprecated)]
        Cursor::ColResize => NSCursor::resizeLeftRightCursor(),
        #[allow(deprecated)]
        Cursor::RowResize => NSCursor::resizeUpDownCursor(),
        Cursor::None => invisible_cursor(),
        _ => NSCursor::arrowCursor(),
    }
}

/// A cursor that shows nothing (`cursor: none`).
fn invisible_cursor() -> Retained<NSCursor> {
    thread_local! {
        static NONE: Retained<NSCursor> = {
            let image = NSImage::initWithSize(NSImage::alloc(), NSSize::new(1.0, 1.0));
            NSCursor::initWithImage_hotSpot(
                NSCursor::alloc(),
                &image,
                objc2_foundation::NSPoint::new(0.0, 0.0),
            )
        };
    }
    NONE.with(Clone::clone)
}

/// The cursor over `hit`: the innermost view's that asks for one (the
/// I-beam over selectable text).
fn cursor_at(hit: &Hit) -> Cursor {
    chain(&hit.view)
        .iter()
        .find_map(|v| {
            let s = v.state();
            cursor_of(s.style.cursor)
                .or_else(|| crate::text::selectable(&s).then_some(Cursor::Text))
                .or_else(|| {
                    (v == &hit.view && crate::selection_area::is_area_text(v, &s))
                        .then_some(Cursor::Text)
                })
        })
        .unwrap_or(Cursor::Default)
}

/// Sets the cursor for the mouse at `(x, y)` (hosted views set their own).
fn update_cursor(surface: &Surface, x: f32, y: f32) {
    set_cursor_at(surface, x, y, true);
}

/// [`update_cursor`]; unless `always`, only when the app's cursor is
/// another one. `-[NSCursor set]` costs milliseconds even for the cursor
/// already set (with a customized pointer size or color it renders the
/// cursor image again: ~3 ms on macOS 26), so what calls it while the mouse
/// is still (batches, scroll steps, AppKit's cursor updates) skips it; a
/// mouse that moves sets it, as it may come from another app's cursor.
fn set_cursor_at(surface: &Surface, x: f32, y: f32, always: bool) {
    if surface.input.pointer.borrow().is_some() {
        // A drag keeps the cursor it began with.
        return;
    }
    let cursor = match pick(&surface.root, x, y) {
        Some(hit) if hit.native => return,
        Some(hit) => cursor_at(&hit),
        None => Cursor::Default,
    };
    let cursor = ns_cursor(cursor);
    if always || NSCursor::currentCursor() != cursor {
        cursor.set();
    }
}

/// Sets the cursor again where the mouse is (what is under it changed).
fn refresh_cursor(surface: &Surface) {
    if let Some((x, y)) = surface.input.last.get() {
        set_cursor_at(surface, x, y, false);
    }
}

/// AppKit asks the view under the mouse for its cursor (`cursorUpdate:`,
/// after views moved or were added): NSH's, which AppKit's default (the
/// arrow, set again on every update) would replace.
pub(crate) fn cursor_update(surface: &Surface) {
    refresh_cursor(surface);
}

/// A repick waits this long after the last content move (ms): each repick
/// is a full hit test, and a scroll calls `content_moved` per step — the
/// burst re-arms the deadline so the pick lands once, when it settles.
const REPICK_MS: f64 = 120.0;

/// What is under the mouse may have moved (`scrolled`: a scroll step, else
/// a batch): hovered views and the cursor follow it, as AppKit's tracking
/// areas do, though the mouse did not move. Once per main-queue turn,
/// however many scroll views moved or batches came — and during a scroll
/// burst it defers to `repick_at`, one trailing pick rather than a hit
/// test per step.
pub(crate) fn content_moved(surface: &Surface, scrolled: bool) {
    let input = &surface.input;
    if input.last.get().is_none() {
        return;
    }
    let t = crate::scroll::now();
    let armed = input.repick.replace(true);
    let at = repick_deadline(armed, input.repick_at.get(), t, scrolled);
    input.repick_at.set(at);
    if armed {
        return;
    }
    let key = surface.key();
    later((at - t).max(0.0) as u64, move || repick(key));
}

/// When the repick lands, `content_moved` at `t`: a scroll step pushes it
/// [`REPICK_MS`] on; a batch keeps an armed one's (batches every 50 ms
/// would push it on for good), else it picks on the next turn.
fn repick_deadline(armed: bool, at: f64, t: f64, scrolled: bool) -> f64 {
    if scrolled {
        t + REPICK_MS
    } else if armed {
        at
    } else {
        t
    }
}

/// The armed repick: waits out the deadline `content_moved` keeps pushing
/// while content still moves under the mouse, then picks once.
fn repick(key: u64) {
    let Some(surface) = Surface::with_key(key) else {
        return;
    };
    let wait = surface.input.repick_at.get() - crate::scroll::now();
    if wait > 1.0 {
        later(wait.max(2.0) as u64, move || repick(key));
        return;
    }
    surface.input.repick.set(false);
    if let Some((x, y)) = surface.input.last.get() {
        crate::surface::quiet(|| hover(&surface, x, y));
        set_cursor_at(&surface, x, y, false);
    }
}

// --- AppKit events ------------------------------------------------------------------

/// A mouse, wheel or trackpad event over the root view.
pub(crate) fn event(surface: &Rc<Surface>, event: &NSEvent) {
    surface.control(|control| control.set_focus_path(focus_path(surface)));
    let ty = event.r#type();
    let p = surface
        .root
        .ns()
        .convertPoint_fromView(event.locationInWindow(), None);
    let (x, y) = (p.x as f32, p.y as f32);
    let time = event.timestamp() * 1000.0;
    let input = &surface.input;
    match ty {
        // Control-click is the secondary click on macOS.
        NSEventType::LeftMouseDown
            if event
                .modifierFlags()
                .contains(NSEventModifierFlags::Control) =>
        {
            context_menu(surface, x, y, event.modifierFlags());
        }
        NSEventType::RightMouseDown => context_menu(surface, x, y, event.modifierFlags()),
        NSEventType::LeftMouseDown => {
            // A title bar of the app's own moves the window.
            if crate::chrome::mouse_down(surface, event, x, y) {
                return;
            }
            input.last.set(Some((x, y)));
            down(
                surface,
                x,
                y,
                time,
                event.clickCount().max(1) as usize,
                event.modifierFlags(),
            );
        }
        NSEventType::LeftMouseDragged
        | NSEventType::RightMouseDragged
        | NSEventType::OtherMouseDragged => {
            mouse_moved(surface, x, y);
            input.last.set(Some((x, y)));
            motion(surface, x, y, time);
        }
        NSEventType::LeftMouseUp => {
            input.last.set(Some((x, y)));
            up(surface, x, y, time);
            update_cursor(surface, x, y);
        }
        NSEventType::MouseMoved | NSEventType::MouseEntered => {
            input.last.set(Some((x, y)));
            hover(surface, x, y);
            if ty == NSEventType::MouseMoved {
                mouse_moved(surface, x, y);
            }
            hover_moved(surface, x, y, event.modifierFlags());
            reveal_indicators(surface, x, y);
            update_cursor(surface, x, y);
        }
        NSEventType::MouseExited => {
            input.last.set(None);
            if input.pointer.borrow().is_none() {
                set_hovered(surface, Vec::new());
            }
        }
        NSEventType::OtherMouseDown if event.buttonNumber() == BACK_BUTTON => {
            crate::navigation::go_back(surface);
        }
        NSEventType::ScrollWheel => scroll_event(surface, event, x, y, time),
        NSEventType::Magnify => magnify(surface, event, x, y),
        NSEventType::Rotate => rotate(surface, event, x, y),
        _ => {}
    }
}

/// A secondary click at `(x, y)` (root coordinates): the nearest view
/// around the one under it that listens to `onContextMenu` hears it. Text
/// fields are AppKit's views, which show their own menu.
fn context_menu(surface: &Surface, x: f32, y: f32, flags: NSEventModifierFlags) {
    let Some(hit) = pick(&surface.root, x, y) else {
        return;
    };
    for v in chain(&hit.view) {
        let (id, listens, input) = {
            let s = v.state();
            (
                s.id,
                s.events.contains(EventKind::ContextMenu),
                s.kind == ViewKind::Input,
            )
        };
        if listens {
            let (location_x, location_y) = local(surface, &v, x, y);
            let event = nsh_core::ContextMenuEvent {
                position: point(Points(location_x), Points(location_y)),
                page_position: point(Points(x), Points(y)),
                modifiers: modifiers(flags),
            };
            surface.event(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
            return;
        }
        if input {
            return;
        }
    }
}

/// A key went down (`down`) or up; true if it was handled: the text
/// selection's keys, going back (Escape, Command+[, Option+Left) and
/// keyboard scrolling (arrows by a line, Page Up / Page Down, Option+Up /
/// Option+Down and Space / Shift+Space by a page, Home / End and
/// Command+Up / Command+Down to the edges) of the innermost
/// scroll view around the focused view, or else under the mouse, that can
/// move that way. Fields keep their keys (they reach the root only when
/// they do not use them).
pub(crate) fn key(surface: &Rc<Surface>, event: &NSEvent, down: bool) -> bool {
    surface.control(|control| control.set_focus_path(focus_path(surface)));
    if let Some(view) = control_activation_target(surface, event) {
        if down && !event.isARepeat() {
            let events = view.state().events;
            for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
                if events.contains(kind) {
                    // From the keyboard: no pointer to report.
                    log::debug!(target: "nsh::input", "{} on {} (keyboard)", kind.prop_name(), view.id());
                    surface.event(view.id(), kind, EventPayload::None);
                }
            }
        }
        return true;
    }
    if !down {
        return false;
    }
    if crate::text::selection_key(surface, event) {
        return true;
    }
    if crate::navigation::key_pressed(surface, event) {
        return true;
    }
    if tab(surface, event) {
        return true;
    }
    let flags = event.modifierFlags();
    let cmd = flags.contains(NSEventModifierFlags::Command);
    let ctrl = flags.contains(NSEventModifierFlags::Control);
    let opt = flags.contains(NSEventModifierFlags::Option);
    let shift = flags.contains(NSEventModifierFlags::Shift);
    // Command+Up / Down go to the top / bottom and Option+Up / Down move
    // by a page, as in AppKit's scroll views and Safari.
    const HOME: u16 = 115;
    const PAGE_UP: u16 = 116;
    const END: u16 = 119;
    const PAGE_DOWN: u16 = 121;
    const DOWN: u16 = 125;
    const UP: u16 = 126;
    let (code, shortcut) = match (event.keyCode(), cmd, opt, ctrl) {
        (UP, true, false, false) => (HOME, false),
        (DOWN, true, false, false) => (END, false),
        (UP, false, true, false) => (PAGE_UP, false),
        (DOWN, false, true, false) => (PAGE_DOWN, false),
        (code, ..) => (code, cmd || ctrl || opt),
    };
    let Some((horizontal, m)) = crate::scroll::key_move(code, shift, shortcut) else {
        return false;
    };
    let root = &surface.root;
    let focus = root.ns().window().and_then(|w| w.firstResponder());
    let from_focus = match &focus {
        Some(r) => match r.downcast_ref::<ViewObj>() {
            Some(obj) => {
                let view = NshView::from_ns(obj).filter(|v| v != root);
                // A view of another surface.
                if view.is_none() && !std::ptr::eq(obj, &**root) {
                    return false;
                }
                view
            }
            // A field or a hosted view keeps its keys.
            None => return false,
        },
        None => None,
    };
    if let Some(view) = from_focus
        && crate::scroll::key_scroll(surface, &view, horizontal, m)
    {
        return true;
    }
    let (x, y) = input_point(surface);
    let Some(hit) = pick(root, x, y) else {
        return false;
    };
    crate::scroll::key_scroll(surface, &hit.view, horizontal, m)
}

/// A mounted ordinary view that can be reached and activated by keyboard.
pub(crate) fn is_key_control(view: &NshView) -> bool {
    let state = view.state();
    state.kind != ViewKind::Input
        && state.events.contains(EventKind::Press)
        && state.props.focusable != Some(false)
        && !state.props.accessibility.state.disabled
        && view.can_target()
        && !view.ns().isHiddenOrHasHiddenAncestor()
}

/// Current AppKit keyboard focus, from the responder through its native
/// ancestors. No mounter borrow: native callbacks may run during a mount.
pub(crate) fn focus_path(surface: &Surface) -> Vec<NodeId> {
    let root = surface.root.ns();
    let Some(responder) = root.window().and_then(|window| window.firstResponder()) else {
        return Vec::new();
    };
    let Ok(mut view) = responder.downcast::<objc2_app_kit::NSView>() else {
        return Vec::new();
    };
    if !view.isDescendantOf(root) {
        return Vec::new();
    }
    let mut path = Vec::new();
    loop {
        // The shared field editor is a child of its native input while it
        // edits. Walking actual superviews covers it and hosted controls.
        if let Some(node) = NshView::from_ns(&view) {
            path.push(node.id());
        }
        if &*view == root {
            break;
        }
        let Some(parent) = crate::view::superview(&view) else {
            break;
        };
        view = parent;
    }
    path
}

/// Enter or Space addressed to a focused control inside the current modal.
/// The keymap leaves these keys to the responder so a global Enter binding
/// cannot activate an unrelated control underneath keyboard focus.
pub(crate) fn control_activation_target(surface: &Surface, event: &NSEvent) -> Option<NshView> {
    if !matches!(event.keyCode(), 36 | 49 | 76)
        || event.modifierFlags().intersects(
            NSEventModifierFlags::Command
                | NSEventModifierFlags::Control
                | NSEventModifierFlags::Option,
        )
    {
        return None;
    }
    let responder = surface.root.ns().window()?.firstResponder()?;
    let native = responder.downcast_ref::<objc2_app_kit::NSView>()?;
    if !native.isDescendantOf(&crate::navigation::focus_scope(surface)) {
        return None;
    }
    NshView::from_ns(native).filter(is_key_control)
}

/// Tab / Shift+Tab (or with Control) with the root focused: moves into
/// AppKit's key view loop (fields and pressable views), from the first or last, so
/// focus never gets stuck on the root.
fn tab(surface: &Surface, event: &NSEvent) -> bool {
    const TAB: u16 = 48;
    let flags = event.modifierFlags();
    if event.keyCode() != TAB
        || flags.intersects(NSEventModifierFlags::Command | NSEventModifierFlags::Option)
    {
        return false;
    }
    // Into the controls of the newest modal, if one is shown.
    let responder = surface
        .root
        .ns()
        .window()
        .and_then(|window| window.firstResponder());
    let from = responder
        .as_ref()
        .and_then(|responder| responder.downcast_ref::<objc2_app_kit::NSView>())
        .filter(|view| NshView::from_ns(view).is_some_and(|view| is_key_control(&view)))
        .unwrap_or(surface.root.ns());
    crate::text_input::tab(surface, from, flags.contains(NSEventModifierFlags::Shift));
    true
}

/// The key of a shortcut (`event` with Command or Control): the character
/// its key types without modifiers, in lower case; on a layout that types
/// no ASCII there (Cyrillic, Greek, ...), the US layout's character of its
/// key, as menus' key equivalents match it.
pub(crate) fn shortcut_key(event: &NSEvent) -> Option<char> {
    let typed = event
        .charactersIgnoringModifiers()
        .and_then(|s| s.to_string().chars().next())?;
    if typed.is_ascii() {
        return Some(typed.to_ascii_lowercase());
    }
    us_key(event.keyCode())
}

/// The ANSI keyboard's virtual key codes (`kVK_ANSI_*`), by the character
/// their key types on the US layout without Shift (`\0`: not a character
/// key).
const US_KEYS: &[u8; 51] = b"asdfhgzxcv\0bqweryt123465=97-80]ou[ip\0lj'k;\\,/nm.\0\0`";

/// The character the key of virtual key code `code` types on the US
/// layout without Shift (letters, digits, punctuation).
pub(crate) fn us_key(code: u16) -> Option<char> {
    US_KEYS
        .get(usize::from(code))
        .filter(|&&c| c != 0)
        .map(|&c| c as char)
}

/// The virtual key code of the key typing `c` on the US layout (without
/// Shift), for synthesized key events.
#[cfg(feature = "dev")]
pub(crate) fn us_key_code(c: char) -> Option<u16> {
    let c = u8::try_from(c.to_ascii_lowercase())
        .ok()
        .filter(|&c| c != 0)?;
    US_KEYS.iter().position(|&k| k == c).map(|i| i as u16)
}

/// Where keys look for a scroll view: the mouse, or the middle.
fn input_point(surface: &Surface) -> (f32, f32) {
    surface.input.last.get().unwrap_or_else(|| {
        let f = surface.root.state().frame;
        (f.size.width.0 / 2.0, f.size.height.0 / 2.0)
    })
}

// --- Hit testing --------------------------------------------------------------------

/// What is under a point.
struct Hit {
    /// The innermost view.
    view: NshView,
    /// The point is on a hosted AppKit view of it.
    native: bool,
}

/// The innermost view at `(x, y)` (root coordinates).
fn pick(root: &NshView, x: f32, y: f32) -> Option<Hit> {
    pick_in(root, (x, y))
}

fn pick_in(view: &NshView, p: (f32, f32)) -> Option<Hit> {
    // Hidden (screens under the top one, `hidden`), animating out, or
    // `pointerEvents: none`: neither it nor its subtree.
    if !view.can_target() {
        return None;
    }
    let (pe, in_slop, children) = {
        let s = view.state();
        let HitArea {
            in_slop, children, ..
        } = input::hit_area(
            point(Points(p.0), Points(p.1)),
            s.frame.size,
            s.props.hit_slop,
            s.overflow,
            s.clips(),
            laid_out(s.kind, s.id),
        );
        (s.props.pointer_events, in_slop, children)
    };
    let own = || {
        (pe != PointerEvents::BoxNone && in_slop).then(|| Hit {
            view: view.clone(),
            native: false,
        })
    };
    if !children {
        return own();
    }
    if pe != PointerEvents::BoxOnly {
        // Hosted views and children in their AppKit order, topmost first:
        // hosted views are usually above the children, but not always (a
        // modal is above the image of one leaving, which the root hosts).
        let container = view.container_view();
        let subviews: Vec<_> = view.ns().subviews().iter().collect();
        for sub in subviews.into_iter().rev() {
            if container.as_deref() == Some(&*sub) {
                if let Some(hit) = pick_children(view, p) {
                    return Some(hit);
                }
            } else if let Some(child) = NshView::from_ns(&sub) {
                if let Some(hit) = into_child(&child, p).and_then(|cp| pick_in(&child, cp)) {
                    return Some(hit);
                }
            } else if on_native(view, &sub, p) {
                return Some(Hit {
                    view: view.clone(),
                    native: true,
                });
            }
        }
    }
    own()
}

/// The innermost view at `p` (`view`'s coordinates) among the children
/// in `view`'s container.
fn pick_children(view: &NshView, p: (f32, f32)) -> Option<Hit> {
    let offset = container_offset(view);
    let p = (p.0 + offset.0, p.1 + offset.1);
    view.child_views()
        .iter()
        .rev()
        .find_map(|child| into_child(child, p).and_then(|cp| pick_in(child, cp)))
}

/// Whether `p` (`view`'s coordinates) is on `sub`, a hosted view of
/// `view`'s.
fn on_native(view: &NshView, sub: &objc2_app_kit::NSView, p: (f32, f32)) -> bool {
    let (x, y) = p;
    view.state().natives.iter().any(|n| {
        let r = n.rect;
        &*n.view == sub
            && !n.view.isHidden()
            && x >= r.origin.x.0
            && y >= r.origin.y.0
            && x < r.origin.x.0 + r.size.width.0
            && y < r.origin.y.0 + r.size.height.0
    })
}

/// The origin of `view`'s container's bounds (its scroll offset): the
/// scroll state, not the bounds — while scrolling the offset shows as a
/// layer transform and the bounds catch up when it settles.
fn container_offset(view: &NshView) -> (f32, f32) {
    if view.container_view().is_none() {
        return (0.0, 0.0);
    }
    crate::scroll::bounds_origin(view)
}

/// A point in the coordinates of `child`'s parent's container in
/// `child`'s: its frame's origin and its transform, inverted.
fn into_child(child: &NshView, p: (f32, f32)) -> Option<(f32, f32)> {
    let origin = child.ns().frame().origin;
    let d = (p.0 - origin.x as f32, p.1 - origin.y as f32);
    match child.state().transform() {
        Some(m) => unproject(&m, d),
        None => Some(d),
    }
}

/// The point of a view's plane (z = 0) that row-vector transform `m`
/// shows at `p`, perspective included; `None` when `m` flattens the view
/// to a line.
fn unproject(m: &nsh_core::Matrix, p: (f32, f32)) -> Option<(f32, f32)> {
    let m = &m.0;
    // [x y 1] · H = [X Y W] maps the plane to the screen.
    let h = [
        [m[0], m[1], m[3]],
        [m[4], m[5], m[7]],
        [m[12], m[13], m[15]],
    ];
    let det = h[0][0] * (h[1][1] * h[2][2] - h[1][2] * h[2][1])
        - h[0][1] * (h[1][0] * h[2][2] - h[1][2] * h[2][0])
        + h[0][2] * (h[1][0] * h[2][1] - h[1][1] * h[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    // The inverse: the adjugate over the determinant.
    let inv = [
        [
            (h[1][1] * h[2][2] - h[1][2] * h[2][1]) / det,
            (h[0][2] * h[2][1] - h[0][1] * h[2][2]) / det,
            (h[0][1] * h[1][2] - h[0][2] * h[1][1]) / det,
        ],
        [
            (h[1][2] * h[2][0] - h[1][0] * h[2][2]) / det,
            (h[0][0] * h[2][2] - h[0][2] * h[2][0]) / det,
            (h[0][2] * h[1][0] - h[0][0] * h[1][2]) / det,
        ],
        [
            (h[1][0] * h[2][1] - h[1][1] * h[2][0]) / det,
            (h[0][1] * h[2][0] - h[0][0] * h[2][1]) / det,
            (h[0][0] * h[1][1] - h[0][1] * h[1][0]) / det,
        ],
    ];
    let (x, y) = (p.0 as f64, p.1 as f64);
    let lx = x * inv[0][0] + y * inv[1][0] + inv[2][0];
    let ly = x * inv[0][1] + y * inv[1][1] + inv[2][1];
    let w = x * inv[0][2] + y * inv[1][2] + inv[2][2];
    if w.abs() < 1e-12 {
        return None;
    }
    Some(((lx / w) as f32, (ly / w) as f32))
}

/// `view` and its ancestors, innermost first.
fn chain(view: &NshView) -> Vec<NshView> {
    let mut out = vec![view.clone()];
    let mut current = view.parent_view();
    while let Some(v) = current {
        current = v.parent_view();
        out.push(v);
    }
    out
}

/// A point in root coordinates in `view`'s.
pub(crate) fn local(_surface: &Surface, view: &NshView, x: f32, y: f32) -> (f32, f32) {
    let views = chain(view);
    let mut p = (x, y);
    // From the outermost (the root) inwards.
    for pair in views.windows(2).rev() {
        let (child, parent) = (&pair[0], &pair[1]);
        let o = container_offset(parent);
        match into_child(child, (p.0 + o.0, p.1 + o.1)) {
            Some(cp) => p = cp,
            None => return (x, y),
        }
    }
    p
}

fn gesture_values(surface: &Surface, view: &NshView, id: NodeId) -> GestureValues {
    surface
        .input
        .gestures
        .borrow()
        .get(&id)
        .filter(|(weak, _)| {
            weak.load()
                .is_some_and(|v| std::ptr::eq(&*v, &**view as *const ViewObj))
        })
        .map(|(_, values)| *values)
        .unwrap_or_default()
}

// --- The pointer --------------------------------------------------------------------

fn take(surface: &Surface) -> Option<Pointer> {
    surface.input.pointer.borrow_mut().take()
}

fn put(surface: &Surface, p: Pointer) {
    *surface.input.pointer.borrow_mut() = Some(p);
}

fn down(
    surface: &Rc<Surface>,
    x: f32,
    y: f32,
    time: f64,
    clicks: usize,
    flags: NSEventModifierFlags,
) {
    let shift = flags.contains(NSEventModifierFlags::Shift);
    // A release we never saw.
    if let Some(stale) = take(surface) {
        finish(surface, stale, true);
    }
    let hit = pick(&surface.root, x, y);
    // A selection area around the view selects across its texts; else a
    // selectable text selects alone.
    let selecting = hit.as_ref().filter(|h| !h.native).and_then(|h| {
        crate::selection_area::target(&h.view)
            .or_else(|| crate::text::selectable(&h.view.state()).then(|| h.view.clone()))
    });
    let Some(hit) = hit else {
        crate::text::selection_down(surface, None, 0.0, 0.0, clicks, shift, false);
        return;
    };
    let input = &surface.input;
    input.js_block.set(false);
    let native = hit.native;
    let views = chain(&hit.view);
    // The mouse drags an indicator as a scroll bar: its thumb follows the
    // pointer, where a drag on the content moves the content with it.
    let thumb = (!native)
        .then(|| {
            views.iter().find(|v| {
                let (lx, ly) = local(surface, v, x, y);
                crate::scroll::grabs_thumb(v, lx, ly)
            })
        })
        .flatten();
    if let Some(view) = thumb {
        let id = input.next_id.get();
        input.next_id.set(id.wrapping_add(1));
        let mut p = Pointer {
            id,
            x,
            y,
            start: (x, y),
            time,
            velocity: VelocityTracker::default(),
            target: view.clone(),
            path: Vec::new(),
            reporting: false,
            press: None,
            candidates: Vec::new(),
            gate: None,
            pressed: Vec::new(),
            mode: Mode::Thumb(view.clone(), (x, y)),
            moved: false,
        };
        p.velocity.add(time, point(Points(x), Points(y)));
        crate::scroll::thumb_begin(surface, view);
        put(surface, p);
        return;
    }
    let mut path = Vec::new();
    let mut candidates = Vec::new();
    let mut pressed = Vec::new();
    let mut gate = None;
    for v in &views {
        let s = v.state();
        if s.events.contains(EventKind::Touch) {
            path.push(s.id);
        }
        if s.tracked & PRESSED != 0 {
            pressed.push(v.clone());
        }
        let values = gesture_values(surface, v, s.id);
        if !native
            && selecting.is_none()
            && (values.pan_x.is_some()
                || values.pan_y.is_some()
                || s.events.contains(EventKind::PanStart)
                || s.events.contains(EventKind::PanEnd))
        {
            let (x, y) = match (values.pan_x.is_some(), values.pan_y.is_some()) {
                (false, false) => (true, true),
                axes => axes,
            };
            candidates.push((v.clone(), Candidate::Pan { x, y }));
        }
        if gate.is_none()
            && !native
            && let Some(activation) = s.props.pan_activation
        {
            gate = Some(Gate::new(s.id, activation, candidates.len()));
        }
    }
    // A click that stops a glide is no press, as a finger catching one on
    // iOS.
    let mut caught = false;
    for v in views.iter().filter(|v| v.kind() == ViewKind::Scroll) {
        caught |= crate::scroll::catch(surface, v);
    }
    let press = if native || caught {
        None
    } else {
        find_press(surface, &hit.view, &views, x, y)
            .map(|p| p.clicked(modifiers(flags), clicks as u32))
    };
    match &selecting {
        Some(area) if crate::selection_area::is_area(area) => {
            crate::selection_area::down(surface, area, x, y, clicks, shift, press.is_some());
        }
        Some(view) => {
            let (lx, ly) = local(surface, view, x, y);
            crate::text::selection_down(
                surface,
                Some(view),
                lx,
                ly,
                clicks,
                shift,
                press.is_some(),
            );
        }
        None => crate::text::selection_down(surface, None, 0.0, 0.0, clicks, shift, false),
    }
    let id = input.next_id.get();
    input.next_id.set(id.wrapping_add(1));
    let mut p = Pointer {
        id,
        x,
        y,
        start: (x, y),
        time,
        velocity: VelocityTracker::default(),
        target: hit.view,
        reporting: !path.is_empty(),
        path,
        press,
        candidates,
        gate,
        pressed,
        mode: match selecting {
            Some(view) => Mode::Select(view),
            None => Mode::Idle,
        },
        moved: false,
    };
    p.velocity.add(time, point(Points(x), Points(y)));
    if p.reporting {
        report(surface, TouchPhase::Start, &p, None);
    }
    for v in &p.pressed {
        set_state(surface, v, PRESSED, true);
    }
    if let Some(press) = &mut p.press {
        let generation = press.generation;
        press_in(surface, press, (x, y));
        if press.events.contains(EventKind::LongPress) {
            let delay = press.long_delay.max(0.0) as u64;
            after(surface, generation, delay, |surface, p| {
                let Some(press) = &mut p.press else { return };
                press_in(surface, press, (p.x, p.y));
                press.long = true;
                press_event(surface, press, EventKind::LongPress, (p.x, p.y));
            });
        }
    }
    put(surface, p);
}

fn motion(surface: &Rc<Surface>, x: f32, y: f32, time: f64) {
    hover(surface, x, y);
    let Some(mut p) = take(surface) else {
        return;
    };
    if p.x == x && p.y == y {
        put(surface, p);
        return;
    }
    p.x = x;
    p.y = y;
    p.time = time;
    p.velocity.add(time, point(Points(x), Points(y)));
    let moved = std::mem::replace(&mut p.moved, true);
    let (tx, ty) = (x - p.start.0, y - p.start.1);
    if let Mode::Select(view) = &p.mode {
        let view = view.clone();
        let selects = if crate::selection_area::is_area(&view) {
            crate::selection_area::drag(surface, &view, tx, ty, x, y)
        } else {
            let (lx, ly) = local(surface, &view, x, y);
            crate::text::selection_drag(&view, tx, ty, lx, ly)
        };
        if selects {
            // The drag selects: no press, as text editors do.
            cancel_press(surface, &mut p);
            release_pressed(surface, &mut p);
        }
    }
    let activated = Gate::step(&mut p.gate, &mut p.candidates, Points(tx), Points(ty));
    // The view's JS responder takes the drag over: nothing native starts
    // meanwhile.
    if activated.is_some() && p.mode == Mode::Idle {
        p.mode = Mode::Free;
    }
    if p.reporting {
        report(surface, TouchPhase::Move, &p, activated);
    }
    let distance = tx.hypot(ty);
    // JS hears of the first move only now: give its responder a chance to
    // take the gesture (and block native drags) before one starts.
    let js_pending = p.reporting && !moved;
    if p.mode == Mode::Idle && distance > PAN_SLOP.0 && !js_pending {
        // While the gate decides, the candidates around it wait (the
        // pointer stays idle and they are asked again on the next move).
        let waiting = p.gate.as_ref().map(Gate::outer);
        if waiting.is_none() {
            p.mode = Mode::Free;
        }
        let started = if surface.input.js_block.get() {
            None
        } else {
            let open = waiting.unwrap_or(p.candidates.len());
            p.candidates[..open]
                .iter()
                .find(|(_, c)| c.accepts(tx, ty))
                .cloned()
        };
        if let Some((view, Candidate::Pan { .. })) = started {
            p.gate = None;
            pan_start(surface, &view, &p);
            p.mode = Mode::Pan(view);
        }
    }
    if matches!(p.mode, Mode::Pan(_)) || distance > PRESS_SLOP.0 {
        cancel_press(surface, &mut p);
        release_pressed(surface, &mut p);
    }
    match &p.mode {
        Mode::Pan(view) => {
            let view = view.clone();
            pan_move(surface, &view, tx, ty);
        }
        Mode::Thumb(view, origin) => {
            crate::scroll::thumb_move(surface, view, x - origin.0, y - origin.1);
        }
        _ => {}
    }
    put(surface, p);
}

fn up(surface: &Rc<Surface>, x: f32, y: f32, time: f64) {
    let Some(mut p) = take(surface) else {
        return;
    };
    p.x = x;
    p.y = y;
    p.time = time;
    p.velocity.add(time, point(Points(x), Points(y)));
    finish(surface, p, false);
}

/// Cancels the press in progress, whose release will not come: a menu
/// that popped up during it tracked the mouse and took the release.
pub(crate) fn cancel_pointer(surface: &Rc<Surface>) {
    if let Some(p) = take(surface) {
        finish(surface, p, true);
    }
}

/// Ends every input capture into a recycling cell before its owner may be
/// released. An ancestor pan/selection keeps its gesture while losing the
/// retired child's touch path and press.
pub(crate) fn retiring(surface: &Rc<Surface>, cell: &NshView) {
    crate::text_input::cancel_auto_focus(cell);
    let inside = |view: &NshView| view == cell || view.ns().isDescendantOf(cell.ns());
    let mut owned = FxHashSet::default();
    let mut pending = vec![cell.clone()];
    while let Some(view) = pending.pop() {
        owned.insert(view.id());
        pending.extend(view.child_views());
    }
    // Drag destinations also retain their last native owner between OS
    // drag events; release it before the subtree's identity is terminated.
    for &id in &owned {
        crate::file_drop::invalidate(surface, id);
    }
    let affected = surface
        .input
        .pointer
        .borrow()
        .as_ref()
        .is_some_and(|pointer| {
            inside(&pointer.target)
                || pointer
                    .press
                    .as_ref()
                    .is_some_and(|press| inside(&press.view))
                || match &pointer.mode {
                    Mode::Pan(view) | Mode::Thumb(view, _) | Mode::Select(view) => inside(view),
                    Mode::Idle | Mode::Free => false,
                }
                || pointer.candidates.iter().any(|(view, _)| inside(view))
                || pointer.pressed.iter().any(inside)
                || pointer.path.iter().any(|id| owned.contains(id))
                || pointer.gate.is_some_and(|gate| owned.contains(&gate.id()))
        });
    if affected && let Some(mut pointer) = take(surface) {
        if pointer.reporting {
            report(surface, TouchPhase::Cancel, &pointer, None);
            pointer.reporting = false;
        }
        cancel_press(surface, &mut pointer);
        release_pressed(surface, &mut pointer);
        let active = match &pointer.mode {
            Mode::Pan(view) | Mode::Thumb(view, _) | Mode::Select(view) if !inside(view) => {
                Some(view.clone())
            }
            _ => None,
        };
        if let Some(active) = active {
            pointer.target = active;
            pointer.path.clear();
            pointer.candidates.retain(|(view, _)| !inside(view));
            pointer.gate = None;
            put(surface, pointer);
        } else if let Mode::Pan(view) = &pointer.mode {
            // Mount owns the mounter borrow, so final values cannot be
            // written through Surface::write_animations here.
            pan_end(surface, view, &pointer, false);
        } else {
            finish(surface, pointer, true);
        }
    }
    let hovered = surface
        .input
        .hovered
        .borrow()
        .iter()
        .filter(|view| !inside(view))
        .cloned()
        .collect();
    set_hovered(surface, hovered);
    for slot in [&surface.input.pinch, &surface.input.rotation] {
        let affected = slot
            .borrow()
            .as_ref()
            .is_some_and(|transform| inside(&transform.view));
        if affected && let Some(transform) = slot.borrow_mut().take() {
            transform_end(surface, &transform);
        }
    }
    let zoomed = surface
        .input
        .zoom
        .borrow()
        .as_ref()
        .is_some_and(|(transform, _)| inside(&transform.view));
    if zoomed && let Some((transform, _)) = surface.input.zoom.borrow_mut().take() {
        transform_end(surface, &transform);
    }
    let wheeled = surface
        .input
        .wheel
        .borrow()
        .as_ref()
        .and_then(|wheel| wheel.view.as_ref())
        .is_some_and(inside);
    if wheeled
        && let Some(view) = surface
            .input
            .wheel
            .borrow_mut()
            .take()
            .and_then(|wheel| wheel.view)
    {
        crate::scroll::wheel_end(surface, &view, 0.0, 0.0);
    }
    if surface.input.momentum.borrow().as_ref().is_some_and(inside) {
        end_momentum(surface);
    }
    if surface
        .input
        .latch
        .borrow()
        .as_ref()
        .is_some_and(|(view, _, _)| inside(view))
    {
        surface.input.latch.borrow_mut().take();
    }
}

/// The button lifted (or the press was cancelled): ends what it did.
fn finish(surface: &Rc<Surface>, mut p: Pointer, cancelled: bool) {
    if p.reporting {
        let phase = if cancelled {
            TouchPhase::Cancel
        } else {
            TouchPhase::End
        };
        report(surface, phase, &p, None);
    }
    release_pressed(surface, &mut p);
    let mode = std::mem::replace(&mut p.mode, Mode::Free);
    match mode {
        Mode::Pan(view) => {
            pan_move(surface, &view, p.x - p.start.0, p.y - p.start.1);
            pan_end(surface, &view, &p, true);
        }
        Mode::Thumb(view, _) => crate::scroll::thumb_end(surface, &view),
        Mode::Idle | Mode::Free | Mode::Select(_) => {
            if let Mode::Select(view) = &mode
                && selection_up(surface, view)
            {
                // A selecting drag ended: no press.
                cancel_press(surface, &mut p);
            }
            if let Some(mut press) = p.press.take() {
                let at = (p.x, p.y);
                if cancelled {
                    press_out(surface, &mut press, false, at);
                } else {
                    let inside = released_inside(surface, &press.view, p.x, p.y);
                    press_out(surface, &mut press, inside, at);
                }
            }
        }
    }
}

/// The button pressed on selecting `view` (an area's or a text's) went
/// up. True if it ended a selecting drag.
fn selection_up(surface: &Surface, view: &NshView) -> bool {
    if crate::selection_area::is_area(view) {
        crate::selection_area::up(surface)
    } else {
        crate::text::selection_up(view)
    }
}

/// Sends the pointer's touch, which `phase` is about, and the view whose
/// pan activation fired with it.
fn report(surface: &Surface, phase: TouchPhase, p: &Pointer, activated: Option<NodeId>) {
    let (lx, ly) = local(surface, &p.target, p.x, p.y);
    let point = TouchPoint {
        id: p.id,
        target: p.target.id(),
        // JS keeps a finger's path from its start.
        path: if phase == TouchPhase::Start {
            p.path.clone()
        } else {
            Vec::new()
        },
        page: point(Points(p.x), Points(p.y)),
        location: point(Points(lx), Points(ly)),
        changed: true,
    };
    let event = TouchEvent {
        phase,
        timestamp: p.time,
        points: vec![point],
        activated,
    };
    surface.event(
        ROOT_ID,
        EventKind::Touch,
        EventPayload::Touch(Box::new(event)),
    );
}

/// Runs `f` on the pointer after `ms` unless its press `generation` ended.
fn after(surface: &Rc<Surface>, generation: u64, ms: u64, f: fn(&Rc<Surface>, &mut Pointer)) {
    let key = surface.key();
    later(ms, move || {
        let Some(surface) = Surface::with_key(key) else {
            return;
        };
        let Some(mut p) = take(&surface) else {
            return;
        };
        if p.press
            .as_ref()
            .is_some_and(|press| press.generation == generation)
        {
            crate::surface::quiet(|| f(&surface, &mut p));
        }
        put(&surface, p);
    });
}

/// Runs `f` on the main queue after `ms` milliseconds.
pub(crate) fn later(ms: u64, f: impl FnOnce() + Send + 'static) {
    let when = DispatchTime::NOW.time(Duration::from_millis(ms).as_nanos() as i64);
    if let Err(err) = DispatchQueue::main().after(when, f) {
        log::warn!("input: cannot schedule a timer: {err:?}");
    }
}

fn release_pressed(surface: &Surface, p: &mut Pointer) {
    for v in p.pressed.drain(..) {
        set_state(surface, &v, PRESSED, false);
    }
}

// --- Presses ------------------------------------------------------------------------

/// The press a pointer down at `(x, y)` on `target` starts: the pressable
/// text span under it, else the innermost enabled view listening to
/// presses.
fn find_press(
    surface: &Surface,
    target: &NshView,
    views: &[NshView],
    x: f32,
    y: f32,
) -> Option<Press> {
    let generation = surface.input.next_gen.get();
    surface.input.next_gen.set(generation + 1);
    {
        let (lx, ly) = local(surface, target, x, y);
        let s = target.state();
        if let Some(link) = crate::text::link_at(&s, lx, ly)
            && has_press(link.events)
        {
            return Some(Press::new(
                target.clone(),
                link.node,
                link.events,
                s.props.long_press_delay,
                generation,
            ));
        }
    }
    views.iter().find_map(|v| {
        let s = v.state();
        (has_press(s.events) && !s.props.accessibility.state.disabled).then(|| {
            Press::new(
                v.clone(),
                s.id,
                s.events,
                s.props.long_press_delay,
                generation,
            )
        })
    })
}

/// Presses in: `onPressDown`, the first time. `at` is the pointer in root
/// coordinates.
fn press_in(surface: &Rc<Surface>, press: &mut Press, at: (f32, f32)) {
    if let Some(kind) = press.press_in() {
        press_event(surface, press, kind, at);
    }
}

/// Ends a press: `onPressUp`, then `onPress` if `fire` (released inside)
/// and it was no long press.
fn press_out(surface: &Rc<Surface>, press: &mut Press, fire: bool, at: (f32, f32)) {
    for kind in press.press_out(fire) {
        press_event(surface, press, kind, at);
    }
}

/// Sends `kind` of `press` with the pointer at `(x, y)` (root coordinates).
fn press_event(surface: &Surface, press: &Press, kind: EventKind, (x, y): (f32, f32)) {
    log::debug!(target: "nsh::input", "{} on {}", kind.prop_name(), press.node);
    let (location_x, location_y) = local(surface, &press.view, x, y);
    let event = nsh_core::PressEvent {
        position: point(Points(location_x), Points(location_y)),
        page_position: point(Points(x), Points(y)),
        modifiers: press.modifiers,
        clicks: press.clicks,
    };
    surface.event(press.node, kind, EventPayload::Press(event));
}

fn cancel_press(surface: &Rc<Surface>, p: &mut Pointer) {
    if let Some(mut press) = p.press.take() {
        press_out(surface, &mut press, false, (p.x, p.y));
    }
}

/// The modifier keys of AppKit's `flags`.
fn modifiers(flags: NSEventModifierFlags) -> nsh_core::keymap::Modifiers {
    nsh_core::keymap::Modifiers {
        ctrl: flags.contains(NSEventModifierFlags::Control),
        alt: flags.contains(NSEventModifierFlags::Option),
        shift: flags.contains(NSEventModifierFlags::Shift),
        cmd: flags.contains(NSEventModifierFlags::Command),
    }
}

/// Whether a release at `(x, y)` (root coordinates) is on `view`, its hit
/// slop and a small tolerance around them.
fn released_inside(surface: &Surface, view: &NshView, x: f32, y: f32) -> bool {
    let (lx, ly) = local(surface, view, x, y);
    let s = view.state();
    input::released_inside(
        point(Points(lx), Points(ly)),
        s.frame.size,
        s.props.hit_slop,
    )
}

// --- Pans ---------------------------------------------------------------------------

fn pan_payload(surface: &Surface, id: NodeId, t: (f32, f32), v: (f32, f32)) -> EventPayload {
    let (value_x, value_y) = surface.anim.borrow().pan_values(id);
    EventPayload::Pan {
        translation: point(Points(t.0), Points(t.1)),
        velocity_x: v.0,
        velocity_y: v.1,
        value_x: value_x.map(Points),
        value_y: value_y.map(Points),
    }
}

fn pan_start(surface: &Rc<Surface>, view: &NshView, p: &Pointer) {
    let (id, events) = {
        let s = view.state();
        (s.id, s.events)
    };
    surface.anim.borrow_mut().pan_began(id);
    if events.contains(EventKind::PanStart) {
        let payload = pan_payload(surface, id, (0.0, 0.0), p.velocity.velocity());
        surface.event(id, EventKind::PanStart, payload);
    }
}

fn pan_move(surface: &Rc<Surface>, view: &NshView, tx: f32, ty: f32) {
    let id = view.state().id;
    surface.anim.borrow_mut().pan_moved(id, tx, ty);
    crate::surface::quiet(|| surface.write_animations());
    surface.ensure_ticking();
}

/// Reports the end of a pan (`write`: the values may be written now; not
/// while a batch is applied).
fn pan_end(surface: &Rc<Surface>, view: &NshView, p: &Pointer, write: bool) {
    let (id, events) = {
        let s = view.state();
        (s.id, s.events)
    };
    if write {
        crate::surface::quiet(|| surface.write_animations());
    }
    if events.contains(EventKind::PanEnd) {
        let t = (p.x - p.start.0, p.y - p.start.1);
        let payload = pan_payload(surface, id, t, p.velocity.velocity());
        surface.event(id, EventKind::PanEnd, payload);
    }
}

// --- Pinch and rotation -------------------------------------------------------------

fn transform_payload(key: &'static str, amount: f32) -> EventPayload {
    EventPayload::Map(vec![
        (key, PayloadValue::Number(amount as f64)),
        ("velocity", PayloadValue::Number(0.0)),
    ])
}

/// The innermost view at `(x, y)` that pinches (`rotation` false) or
/// rotates, as a transform of that one kind.
fn transform_at(surface: &Surface, x: f32, y: f32, rotation: bool) -> Option<Transform> {
    let hit = pick(&surface.root, x, y)?;
    chain(&hit.view).into_iter().find_map(|v| {
        let (id, events) = {
            let s = v.state();
            (s.id, s.events)
        };
        let (pinch, rotates) = transforms(&gesture_values(surface, &v, id), events);
        let takes = if rotation { rotates } else { pinch };
        takes.then(|| Transform {
            view: v,
            pinch: !rotation,
            rotation,
            scale: 1.0,
            degrees: 0.0,
        })
    })
}

fn transform_begin(surface: &Surface, t: &Transform) {
    let (id, events) = {
        let s = t.view.state();
        (s.id, s.events)
    };
    {
        let mut anim = surface.anim.borrow_mut();
        if t.pinch {
            anim.transform_began(id, false);
        }
        if t.rotation {
            anim.transform_began(id, true);
        }
    }
    if t.pinch && events.contains(EventKind::PinchStart) {
        surface.event(id, EventKind::PinchStart, transform_payload("scale", 1.0));
    }
    if t.rotation && events.contains(EventKind::RotationStart) {
        let payload = transform_payload("rotation", 0.0);
        surface.event(id, EventKind::RotationStart, payload);
    }
}

fn transform_move(surface: &Rc<Surface>, t: &Transform) {
    let id = t.view.state().id;
    {
        let mut anim = surface.anim.borrow_mut();
        if t.pinch {
            anim.transform_moved(id, false, t.scale);
        }
        if t.rotation {
            anim.transform_moved(id, true, t.degrees);
        }
    }
    crate::surface::quiet(|| surface.write_animations());
    surface.ensure_ticking();
}

fn transform_end(surface: &Surface, t: &Transform) {
    let (id, events) = {
        let s = t.view.state();
        (s.id, s.events)
    };
    if t.pinch && events.contains(EventKind::PinchEnd) {
        surface.event(id, EventKind::PinchEnd, transform_payload("scale", t.scale));
    }
    if t.rotation && events.contains(EventKind::RotationEnd) {
        let payload = transform_payload("rotation", t.degrees);
        surface.event(id, EventKind::RotationEnd, payload);
    }
}

/// A trackpad gesture event that began, changed or ended `slot`'s
/// transform; `change` updates it.
fn trackpad_transform(
    surface: &Rc<Surface>,
    event: &NSEvent,
    x: f32,
    y: f32,
    rotation: bool,
    change: impl FnOnce(&mut Transform),
) {
    let slot = if rotation {
        &surface.input.rotation
    } else {
        &surface.input.pinch
    };
    let phase = event.phase();
    if phase.contains(NSEventPhase::Began) {
        if let Some(old) = slot.borrow_mut().take() {
            transform_end(surface, &old);
        }
        let Some(t) = transform_at(surface, x, y, rotation) else {
            return;
        };
        transform_begin(surface, &t);
        *slot.borrow_mut() = Some(t);
    }
    if phase.intersects(NSEventPhase::Began | NSEventPhase::Changed) {
        let t = {
            let mut slot = slot.borrow_mut();
            let Some(t) = slot.as_mut() else { return };
            change(t);
            t.clone()
        };
        transform_move(surface, &t);
    }
    if phase.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled)
        && let Some(t) = slot.borrow_mut().take()
    {
        transform_end(surface, &t);
    }
}

/// `magnifyWithEvent:`: a trackpad pinch.
fn magnify(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32) {
    let m = event.magnification() as f32;
    trackpad_transform(surface, event, x, y, false, |t| {
        t.scale = (t.scale * (1.0 + m)).max(0.01);
    });
}

/// `rotateWithEvent:`: a trackpad rotation (AppKit counts degrees
/// counterclockwise; views turn clockwise with positive angles).
fn rotate(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32) {
    let r = event.rotation();
    trackpad_transform(surface, event, x, y, true, |t| t.degrees -= r);
}

/// A Control + wheel step of `dy` lines (negative: zooms in) at `(x, y)`:
/// pinches the view under it that pinches, ending once the steps stop.
/// Returns whether a view took it.
fn wheel_zoom(surface: &Rc<Surface>, x: f32, y: f32, dy: f32) -> bool {
    let input = &surface.input;
    let generation = input.next_gen.get();
    input.next_gen.set(generation + 1);
    let current = input.zoom.borrow_mut().take();
    let mut t = match current {
        Some((t, _)) => t,
        None => {
            let Some(t) = transform_at(surface, x, y, false) else {
                return false;
            };
            transform_begin(surface, &t);
            t
        }
    };
    t.scale *= input::zoom_factor(dy);
    transform_move(surface, &t);
    *input.zoom.borrow_mut() = Some((t, generation));
    let key = surface.key();
    later(ZOOM_IDLE, move || {
        let Some(surface) = Surface::with_key(key) else {
            return;
        };
        let ended = {
            let mut zoom = surface.input.zoom.borrow_mut();
            match zoom.as_ref() {
                Some((_, g)) if *g == generation => zoom.take(),
                _ => None,
            }
        };
        if let Some((t, _)) = ended {
            transform_end(&surface, &t);
        }
    });
    true
}

// --- Hover --------------------------------------------------------------------------

/// The mouse moved to `(x, y)`: updates `HOVERED` and raises `onHoverIn` /
/// `onHoverOut` along the views under it.
fn hover(surface: &Surface, x: f32, y: f32) {
    let input = &surface.input;
    if input.hover_tracked.borrow().is_empty() && input.hovered.borrow().is_empty() {
        return;
    }
    let views = match pick(&surface.root, x, y) {
        Some(hit) => chain(&hit.view).into_iter().filter(hoverable).collect(),
        None => Vec::new(),
    };
    set_hovered(surface, views);
}

/// The scroll views under the mouse at `(x, y)` show their indicators.
fn reveal_indicators(surface: &Rc<Surface>, x: f32, y: f32) {
    if let Some(hit) = pick(&surface.root, x, y) {
        for v in chain(&hit.view)
            .iter()
            .filter(|v| v.kind() == ViewKind::Scroll)
        {
            crate::scroll::hovered(surface, v);
        }
    }
}

/// The views under the mouse are `views` (innermost first): those it left
/// hear so from the inside out, then those it came over from the outside
/// in, as with the DOM's `pointerleave` / `pointerenter`.
fn set_hovered(surface: &Surface, views: Vec<NshView>) {
    let old = std::mem::replace(&mut *surface.input.hovered.borrow_mut(), views.clone());
    let (left, entered) = input::hover_changes(&old, &views);
    for v in left {
        set_state(surface, v, HOVERED, false);
        hover_event(surface, v, EventKind::HoverOut);
    }
    for v in entered {
        set_state(surface, v, HOVERED, true);
        hover_event(surface, v, EventKind::HoverIn);
    }
}

/// Real mouse motion only: content re-picking must not synthesize moves.
fn mouse_moved(surface: &Surface, x: f32, y: f32) {
    if surface.input.mouse_tracked.borrow().is_empty() {
        return;
    }
    let Some(hit) = pick(&surface.root, x, y) else {
        return;
    };
    for view in chain(&hit.view) {
        let id = {
            let state = view.state();
            if !state.events.contains(EventKind::MouseMove) {
                continue;
            }
            state.id
        };
        let (x, y) = local(surface, &view, x, y);
        surface.event(
            id,
            EventKind::MouseMove,
            EventPayload::Map(vec![
                ("x", PayloadValue::Number(f64::from(x))),
                ("y", PayloadValue::Number(f64::from(y))),
            ]),
        );
    }
}

/// `onHoverMove` of the hovered views that listen, with the mouse at
/// `(x, y)` (root coordinates) in each.
fn hover_moved(surface: &Surface, x: f32, y: f32, flags: NSEventModifierFlags) {
    let hovered = surface.input.hovered.borrow().clone();
    for v in hovered {
        let id = {
            let s = v.state();
            if !s.events.contains(EventKind::HoverMove) {
                continue;
            }
            s.id
        };
        watch_flags(surface);
        let (location_x, location_y) = local(surface, &v, x, y);
        let event = nsh_core::HoverEvent {
            position: point(Points(location_x), Points(location_y)),
            page_position: point(Points(x), Points(y)),
            modifiers: modifiers(flags),
        };
        surface.event(id, EventKind::HoverMove, EventPayload::Hover(event));
    }
}

/// Installs the surface's [`FlagsMonitor`], unless it is there.
fn watch_flags(surface: &Surface) {
    let monitor = &surface.input.flags.0;
    if monitor.borrow().is_some() {
        return;
    }
    let key = surface.key();
    let block = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event.
        let e = unsafe { event.as_ref() };
        if let Some(surface) = Surface::with_key(key) {
            modifiers_changed(&surface, e);
        }
        event.as_ptr()
    });
    // SAFETY: the block returns the event it got (never consumed); the
    // monitor is removed with the surface's input.
    *monitor.borrow_mut() = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            objc2_app_kit::NSEventMask::FlagsChanged,
            &block,
        )
    };
}

/// The modifier keys changed (`event`, a `flagsChanged`): while the mouse
/// rests over the surface's window with no button down, the hovered views
/// that listen hear `onHoverMove` again where it is, with the modifiers as
/// they are now (an editor underlines a definition while Command is held),
/// as they would on the next move.
fn modifiers_changed(surface: &Surface, event: &NSEvent) {
    let Some(window) = surface.root.ns().window() else {
        return;
    };
    if event.window(surface.mtm).as_deref() != Some(&*window) {
        return;
    }
    let input = &surface.input;
    if input.pointer.borrow().is_some() {
        return;
    }
    if let Some((x, y)) = input.last.get() {
        hover_moved(surface, x, y, event.modifierFlags());
    }
}

/// `onHoverIn` / `onHoverOut` of `view`, if it listens.
fn hover_event(surface: &Surface, view: &NshView, kind: EventKind) {
    let (id, listens) = {
        let s = view.state();
        (s.id, s.events.contains(kind))
    };
    if listens {
        surface.event(id, kind, EventPayload::None);
    }
}

// --- Wheel and trackpad scrolling ---------------------------------------------------

/// The innermost scroll view at `(x, y)` that can move by `(dx, dy)`
/// (nested views fall through to outer ones at their edges). Scroll views
/// along the wheel's axis take it: a vertical wheel over a carousel
/// scrolls the page around it, as in browsers; horizontal views take
/// vertical wheels only where nothing around scrolls vertically.
fn scroll_target(surface: &Surface, x: f32, y: f32, dx: f32, dy: f32) -> Option<NshView> {
    let hit = pick(&surface.root, x, y)?;
    let views = chain(&hit.view);
    let horizontal = dx.abs() > dy.abs();
    let along = |v: &NshView| {
        v.state()
            .scroll
            .as_ref()
            .is_some_and(|s| s.horizontal == horizontal)
    };
    let any_along = views.iter().any(along);
    views.into_iter().find(|v| {
        v.kind() == ViewKind::Scroll
            && (!any_along || along(v))
            && crate::scroll::can_scroll(v, dx, dy)
    })
}

/// The scroll view a trackpad gesture by `(dx, dy)` at `(x, y)` moves:
/// the one [`scroll_target`] picks, else, at the edges, the innermost one
/// along the gesture that bounces, which stretches as on macOS.
fn gesture_target(surface: &Surface, x: f32, y: f32, dx: f32, dy: f32) -> Option<NshView> {
    scroll_target(surface, x, y, dx, dy).or_else(|| {
        let hit = pick(&surface.root, x, y)?;
        chain(&hit.view)
            .into_iter()
            .find(|v| crate::scroll::can_bounce(v, dx, dy))
    })
}

/// A `scrollWheel:` event at `(x, y)`.
fn scroll_event(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32, time: f64) {
    let precise = event.hasPreciseScrollingDeltas();
    // AppKit's deltas move the content (positive: down / right); ours move
    // the offset.
    let (mut dx, mut dy) = (
        -event.scrollingDeltaX() as f32,
        -event.scrollingDeltaY() as f32,
    );
    let phase = event.phase();
    let momentum = event.momentumPhase();
    if !momentum.is_empty() {
        return momentum_event(surface, momentum, dx, dy, time);
    }
    if phase.is_empty() {
        if !precise {
            // Mice have no pinch: Control + wheel pinches, as it zooms on
            // desktops.
            if event
                .modifierFlags()
                .contains(NSEventModifierFlags::Control)
                && dy != 0.0
                && wheel_zoom(surface, x, y, dy)
            {
                return;
            }
            dx *= WHEEL_LINE;
            dy *= WHEEL_LINE;
        }
        wheel_step(surface, x, y, dx, dy, time);
        return;
    }
    gesture_event(surface, phase, x, y, dx, dy, time);
}

/// A mouse wheel step (or a precise scroll outside a gesture) of `(dx,
/// dy)` points: one scroll stays on its view while steps keep coming.
fn wheel_step(surface: &Rc<Surface>, x: f32, y: f32, dx: f32, dy: f32, time: f64) {
    if dx == 0.0 && dy == 0.0 {
        return;
    }
    let input = &surface.input;
    // One scroll stays on its view, as in browsers: an inner view passing
    // under the pointer does not take it over, and the view reaching its
    // edge does not hand the rest to an outer one.
    let horizontal = dx.abs() > dy.abs();
    let latched = match &*input.latch.borrow() {
        Some((view, h, last))
            if latch_holds(*h, *last, horizontal, time) && view.ns().window().is_some() =>
        {
            Some(view.clone())
        }
        _ => None,
    };
    let Some(view) = latched.or_else(|| scroll_target(surface, x, y, dx, dy)) else {
        input.latch.borrow_mut().take();
        return;
    };
    *input.latch.borrow_mut() = Some((view.clone(), horizontal, time));
    // Without a begin, the scroll module takes it as a mouse wheel: it
    // settles (and snaps) by itself once the steps stop.
    crate::scroll::wheel(surface, &view, dx, dy, time);
}

fn new_wheel(view: Option<NshView>, time: f64) -> Wheel {
    let mut velocity = VelocityTracker::default();
    velocity.add(time, point(Points(0.0), Points(0.0)));
    Wheel {
        view,
        total: (0.0, 0.0),
        velocity,
        held: false,
    }
}

/// A trackpad scroll gesture's event (`phase` is not empty).
fn gesture_event(
    surface: &Rc<Surface>,
    phase: NSEventPhase,
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
    time: f64,
) {
    let input = &surface.input;
    if phase.contains(NSEventPhase::MayBegin) {
        // Fingers resting on the trackpad stop what moves; lifting them
        // without scrolling ends that (`Cancelled`).
        end_momentum(surface);
        if let Some(w) = input.wheel.borrow_mut().take()
            && let Some(view) = w.view
        {
            crate::scroll::wheel_end(surface, &view, 0.0, 0.0);
        }
        let scroll = pick(&surface.root, x, y).and_then(|hit| {
            chain(&hit.view)
                .into_iter()
                .find(|v| v.kind() == ViewKind::Scroll)
        });
        if let Some(view) = scroll {
            crate::scroll::wheel_begin(surface, &view);
            let mut wheel = new_wheel(Some(view), time);
            wheel.held = true;
            *input.wheel.borrow_mut() = Some(wheel);
        }
        return;
    }
    if phase.contains(NSEventPhase::Began) {
        end_momentum(surface);
        let held = input.wheel.borrow().as_ref().is_some_and(|w| w.held);
        if !held {
            if let Some(w) = input.wheel.borrow_mut().take()
                && let Some(view) = w.view
            {
                crate::scroll::wheel_end(surface, &view, 0.0, 0.0);
            }
            *input.wheel.borrow_mut() = Some(new_wheel(None, time));
        }
    }
    if phase.intersects(NSEventPhase::Began | NSEventPhase::Changed) {
        if input.wheel.borrow().is_none() {
            // Changes without a begin (synthesized events): steps.
            wheel_step(surface, x, y, dx, dy, time);
            return;
        }
        if dx == 0.0 && dy == 0.0 {
            return;
        }
        // After resting fingers the scroll goes where it points: the held
        // view keeps it only if it scrolls that way.
        let held = match &*input.wheel.borrow() {
            Some(w) if w.held => w.view.clone(),
            _ => None,
        };
        if let Some(held) = held {
            let target = gesture_target(surface, x, y, dx, dy);
            if target.as_ref() == Some(&held) {
                if let Some(w) = input.wheel.borrow_mut().as_mut() {
                    w.held = false;
                }
            } else {
                crate::scroll::wheel_end(surface, &held, 0.0, 0.0);
                *input.wheel.borrow_mut() = Some(new_wheel(None, time));
            }
        }
        let needs_view = input
            .wheel
            .borrow()
            .as_ref()
            .is_some_and(|w| w.view.is_none());
        if needs_view {
            let Some(view) = gesture_target(surface, x, y, dx, dy) else {
                return;
            };
            crate::scroll::wheel_begin(surface, &view);
            if let Some(w) = input.wheel.borrow_mut().as_mut() {
                w.view = Some(view);
            }
        }
        let view = {
            let mut wheel = input.wheel.borrow_mut();
            let Some(w) = wheel.as_mut() else { return };
            w.total.0 += dx;
            w.total.1 += dy;
            w.velocity
                .add(time, point(Points(w.total.0), Points(w.total.1)));
            w.view.clone()
        };
        if let Some(view) = view {
            crate::scroll::wheel(surface, &view, dx, dy, time);
        }
    }
    if phase.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled) {
        let Some(mut w) = input.wheel.borrow_mut().take() else {
            return;
        };
        let Some(view) = w.view.take() else { return };
        w.velocity
            .add(time, point(Points(w.total.0), Points(w.total.1)));
        let (vx, vy) = w.velocity.velocity();
        crate::scroll::wheel_end(surface, &view, vx, vy);
        *input.momentum.borrow_mut() = Some(view);
    }
}

/// The system's momentum after a gesture: it goes to the gesture's view.
fn momentum_event(surface: &Rc<Surface>, phase: NSEventPhase, dx: f32, dy: f32, time: f64) {
    let input = &surface.input;
    let Some(view) = input.momentum.borrow().clone() else {
        return;
    };
    if phase.contains(NSEventPhase::Began) && !crate::scroll::momentum_begin(surface, &view) {
        // The view springs back or snaps instead.
        input.momentum.borrow_mut().take();
        return;
    }
    if phase.intersects(NSEventPhase::Began | NSEventPhase::Changed) && (dx != 0.0 || dy != 0.0) {
        crate::scroll::momentum(surface, &view, dx, dy, time);
    }
    if phase.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled) {
        end_momentum(surface);
    }
}

/// Ends the system's momentum on its view (it ended, or fingers touched
/// the trackpad again).
fn end_momentum(surface: &Rc<Surface>) {
    let view = surface.input.momentum.borrow_mut().take();
    if let Some(view) = view {
        crate::scroll::momentum_end(surface, &view);
    }
}

/// Pressing `(x, y)` (root coordinates) drags the window: the nearest view
/// that sets `windowDrag` says so, unless a text field, a hosted AppKit
/// view (header buttons, fields) or a view with press or touch handlers is
/// nearer.
pub(crate) fn window_drag(surface: &Surface, x: f32, y: f32) -> bool {
    let Some(hit) = pick(&surface.root, x, y) else {
        return false;
    };
    if hit.native {
        return false;
    }
    let mut view = Some(hit.view);
    while let Some(v) = view {
        {
            let s = v.state();
            if let Some(drag) = s.props.window_drag {
                return drag;
            }
            if s.kind == ViewKind::Input
                || has_press(s.events)
                || s.events.contains(EventKind::Touch)
            {
                return false;
            }
        }
        view = v.parent_view();
    }
    false
}

/// The hosted AppKit view (a text field, a web view) under `(x, y)` (root
/// coordinates) when nsh's own picking lands on one: the root's `hitTest:`
/// hands it the mouse, past app views that let the pointer through
/// (`pointerEvents: none` overlays), which AppKit's picking would stop at.
pub(crate) fn native_at(
    surface: &Surface,
    x: f32,
    y: f32,
) -> Option<Retained<objc2_app_kit::NSView>> {
    let hit = pick(&surface.root, x, y)?;
    if !hit.native {
        return None;
    }
    let local = hit.view.ns().convertPoint_fromView(
        objc2_foundation::NSPoint::new(x as f64, y as f64),
        Some(surface.root.ns()),
    );
    let (lx, ly) = (local.x as f32, local.y as f32);
    let s = hit.view.state();
    s.natives
        .iter()
        .rev()
        .find(|n| {
            let r = n.rect;
            !n.view.isHidden()
                && lx >= r.origin.x.0
                && ly >= r.origin.y.0
                && lx < r.origin.x.0 + r.size.width.0
                && ly < r.origin.y.0 + r.size.height.0
        })
        .map(|n| n.view.clone())
}

/// The closest file-drop listener under the pointer, within its modal root.
pub(crate) fn file_drop_target(surface: &Surface, x: f32, y: f32) -> Option<NshView> {
    let mut view = pick(&surface.root, x, y)?.view;
    loop {
        if view.state().events.contains(EventKind::FileDrop) {
            return Some(view);
        }
        if view.kind() == ViewKind::Modal || view.id() == ROOT_ID {
            return None;
        }
        view = view.parent_view()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_do_not_push_the_repick_on() {
        // Scroll steps push it on: one pick once they stop.
        let at = repick_deadline(false, 0.0, 1000.0, true);
        assert_eq!(at, 1000.0 + REPICK_MS);
        assert_eq!(repick_deadline(true, at, 1050.0, true), 1050.0 + REPICK_MS);
        // A batch keeps the armed deadline, however often batches come...
        let mut deadline = at;
        for t in [1050.0, 1100.0, 1150.0] {
            deadline = repick_deadline(true, deadline, t, false);
        }
        assert_eq!(deadline, at);
        // ...and alone picks on the next turn.
        assert_eq!(repick_deadline(false, 0.0, 2000.0, false), 2000.0);
    }

    #[test]
    fn shortcut_keys_on_any_layout() {
        let key = |chars: &str, code: u16| {
            let s = objc2_foundation::NSString::from_str(chars);
            let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                NSEventType::KeyDown,
                objc2_foundation::NSPoint::new(0.0, 0.0),
                NSEventModifierFlags::Command,
                0.0,
                0,
                None,
                &s,
                &s,
                false,
                code,
            )
            .unwrap();
            shortcut_key(&event)
        };
        // US, and Dvorak's own letters.
        assert_eq!(key("C", 8), Some('c'));
        assert_eq!(key("j", 8), Some('j'));
        // Russian: the US layout's key.
        assert_eq!(key("\u{441}", 8), Some('c'));
        assert_eq!(key("\u{43a}", 15), Some('r'));
        assert_eq!(key("\u{445}", 33), Some('['));
        assert_eq!(key("\u{44d}", 39), Some('\''));
        assert_eq!(key("\u{44d}", 36), None);
    }

    #[test]
    fn candidates_take_their_axis() {
        let horizontal = Candidate::Pan { x: true, y: false };
        assert!(horizontal.accepts(8.0, 2.0));
        assert!(!horizontal.accepts(2.0, 8.0));
        let vertical = Candidate::Pan { x: false, y: true };
        assert!(vertical.accepts(1.0, -7.0));
        assert!(!vertical.accepts(-7.0, 1.0));
    }

    #[test]
    fn cursors() {
        assert_eq!(cursor_of(Cursor::Auto), None);
        assert_eq!(cursor_of(Cursor::Default), Some(Cursor::Default));
        assert_eq!(cursor_of(Cursor::Pointer), Some(Cursor::Pointer));
    }

    #[test]
    fn unprojects_transforms() {
        // Scaled by 2 and moved by (10, 20) (row vectors).
        let mut m = nsh_core::Matrix::IDENTITY;
        m.0[0] = 2.0;
        m.0[5] = 2.0;
        (m.0[12], m.0[13]) = (10.0, 20.0);
        assert_eq!(unproject(&m, (30.0, 60.0)), Some((10.0, 20.0)));
        assert_eq!(
            unproject(&nsh_core::Matrix::IDENTITY, (3.0, 4.0)),
            Some((3.0, 4.0))
        );
        // Flattened to a line.
        let mut flat = nsh_core::Matrix::IDENTITY;
        flat.0[5] = 0.0;
        assert_eq!(unproject(&flat, (1.0, 1.0)), None);
    }
}
