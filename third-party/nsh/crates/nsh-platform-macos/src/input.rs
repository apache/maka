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
//! pinch with Control + wheel. Over a zoomable scroll view nearer than a
//! view that pinches, both zoom it around the pointer
//! ([`crate::scroll::pinch`]).
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
    Command, Cursor, EventKind, EventPayload, GestureValues, MouseButton, MouseEvent, NodeId,
    PayloadValue, PinchEvent, PinchPhase, PointerEvents, ROOT_ID, TouchEvent, TouchPhase,
    TouchPoint, ViewKind,
    desktop::{ResizeEdge, WindowControl},
    geometry::{Points, point},
    input::{
        self, Candidate, ContextMenuTarget, Gate, HitArea, PAN_SLOP, PRESS_SLOP, TOUCHPAD_IDLE,
        VelocityTracker, WheelLatch, WheelStep, ZOOM_IDLE, has_press, laid_out, latch_holds,
        transforms,
    },
    platform::InputModality,
    tailwind::state::{FOCUSED, HOVERED, PRESSED},
};
use objc2::{AnyThread, ClassType, Message, rc::Retained, sel};
use objc2_app_kit::{
    NSCursor, NSCursorFrameResizeDirections, NSCursorFrameResizePosition, NSEvent, NSEventMask,
    NSEventModifierFlags, NSEventPhase, NSEventTrackingRunLoopMode, NSEventType, NSImage, NSView,
    NSWindow,
};
use objc2_foundation::{NSDate, NSSize};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{
    surface::Surface,
    view::{NshView, ViewObj},
};

/// Points a mouse wheel line scrolls (`scrollingDeltaY` counts lines for
/// mice, accelerated by the system), as `NSScrollView`'s line scroll. A
/// view's `wheelLineHeight` takes its place ([`crate::scroll::wheel`]).
pub(crate) const WHEEL_LINE: f32 = 10.0;
/// Movement in points before a window press becomes a native drag.
const WINDOW_DRAG_SLOP: f64 = 3.0;
/// The mouse's middle button (`buttonNumber`).
const MIDDLE_BUTTON: isize = 2;
/// The mouse's back button (`buttonNumber`), as Linux's button 8.
const BACK_BUTTON: isize = 3;
/// The mouse's forward button (`buttonNumber`), as Linux's button 9.
const FORWARD_BUTTON: isize = 4;

type Press = input::Press<NshView>;

/// A pinch / rotation in progress.
#[derive(Clone)]
struct Transform {
    view: NshView,
    pinch: bool,
    rotation: bool,
    /// It zooms `view`, a zoomable scroll view, rather than driving its
    /// pinch values.
    zoom: bool,
    scale: f32,
    degrees: f32,
    /// Where the pointer is (root coordinates).
    at: (f32, f32),
}

/// A left press on a drag region ([`window_press`]): a drag past the slop moves the
/// window, a release within it is the app's click.
pub(crate) struct WindowPress {
    view: NshView,
    /// Where it was pressed (root coordinates), when, with which modifiers.
    x: f32,
    y: f32,
    time: f64,
    modifiers: NSEventModifierFlags,
}

/// Pointer state of one surface.
#[derive(Default)]
pub(crate) struct Input {
    /// A press on a draggable background, waiting to be a click or a drag.
    window_press: RefCell<Option<WindowPress>>,
    /// The root view of the window the event being handled happened in: a
    /// window of the app's own (`Window.open`, [`crate::window`]), or
    /// `None` for the surface's root ([`enter`]).
    window_root: RefCell<Option<NshView>>,
    /// The `windowControl` view pressed, which acts when the press ends
    /// over it.
    window_control: RefCell<Option<(NshView, WindowControl)>>,
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
    /// When the gesture that set [`Self::momentum`] ended or its last
    /// momentum event came (ms). A gesture whose fingers stop before they
    /// lift gets no momentum events, so `momentum` outlives it: only this
    /// says whether a glide can still be going on.
    momentum_last: Cell<f64>,
    /// The scroll view mouse wheel notches go to while they keep coming,
    /// whether they scroll horizontally, and when the last one came (ms).
    latch: RefCell<Option<(NshView, bool, f64)>>,
    /// The `onWheel` listener a scroll went to, which keeps the rest of it.
    wheel_listener: RefCell<WheelLatch<NshView>>,
    /// The `onPinch` listener a trackpad pinch went to, to its end.
    pinch_listener: RefCell<WheelLatch<NshView>>,
    /// The scroll under way has no scroll view of this surface under it:
    /// it goes to the view the surface is in (an embedded app's host).
    forward_scroll: Cell<bool>,
    /// Views that track `HOVERED` or listen to the mouse's events
    /// (`onMouseEnter`, `onMouseLeave`, `onMouseMove`).
    hover_tracked: RefCell<FxHashSet<NodeId>>,
    /// Views that are hovered now (innermost first). Those listening hear
    /// `onMouseMove`: a move needs no hit test past the hover's.
    hovered: RefCell<Vec<NshView>>,
    /// The link of a text the mouse is over, with its text view
    /// ([`hover_link`]).
    link_hovered: RefCell<Option<(NshView, nsh_core::TextLink)>>,
    /// Native gesture values by view.
    gestures: RefCell<FxHashMap<NodeId, (objc2::rc::Weak<ViewObj>, GestureValues)>>,
    /// The JS responder blocks native scrolling and pans.
    js_block: Cell<bool>,
    /// Where the mouse last was, in the coordinates of its own window root.
    last: Cell<Option<PointerPosition>>,
    /// The cursor this surface last set (`None`: another may show, a
    /// hosted view's or another app's) — `NSCursor::currentCursor` is
    /// another object than the one set when the pointer is customized.
    cursor: Cell<Option<Cursor>>,
    /// Cursor-affecting state changed during a batch and needs one
    /// synchronous refresh at [`content_moved`].
    cursor_dirty: Cell<bool>,
    /// A Control-click (the secondary click) is down: its left-button
    /// release is the secondary button's (`onMouseUp` reports `right`).
    control_click: Cell<bool>,
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
    /// Hears the modifier keys change, once a view hears mouse moves.
    flags: EventMonitor,
    /// Observes primary pointer events over hosted AppKit views, whose
    /// `hitTest:` bypasses the root view's responder handlers.
    hosted: EventMonitor,
    /// True while a hosted AppKit view tracks a left-button press.
    hosted_left_down: Cell<bool>,
    /// Latest hosted mouse event observed, avoiding duplicate handling when
    /// a hosted view forwards up the responder chain or a synthetic test
    /// invokes `mouseDown:` directly.
    hosted_last: Cell<Option<MouseMark>>,
}

#[derive(Clone, Copy)]
struct PointerPosition {
    root: NodeId,
    x: f32,
    y: f32,
}

/// A local `NSEvent` monitor removed when the surface's input drops.
#[derive(Default)]
struct EventMonitor(RefCell<Option<Retained<objc2::runtime::AnyObject>>>);

impl Drop for EventMonitor {
    fn drop(&mut self) {
        if let Some(monitor) = self.0.borrow_mut().take() {
            // SAFETY: a monitor `addLocalMonitorForEventsMatchingMask`
            // returned.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    }
}

/// Identifies an `NSEvent` already observed through [`Input::hosted`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MouseMark {
    event: usize,
    kind: NSEventType,
    time_bits: u64,
}

impl MouseMark {
    fn of(event: &NSEvent) -> Self {
        Self {
            event: event as *const NSEvent as usize,
            kind: event.r#type(),
            time_bits: event.timestamp().to_bits(),
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
    /// The down event's timestamp; `time` follows moves and the release.
    down_time: f64,
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
    /// The modifier keys held when it went down (for JS touches).
    modifiers: nsh_core::keymap::Modifiers,
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
    input.window_press.borrow_mut().take();
    input.window_root.borrow_mut().take();
    input.window_control.borrow_mut().take();
    input.pointer.borrow_mut().take();
    input.hosted_left_down.set(false);
    input.hosted_last.set(None);
    input.pinch.borrow_mut().take();
    input.rotation.borrow_mut().take();
    input.zoom.borrow_mut().take();
    input.wheel.borrow_mut().take();
    input.momentum.borrow_mut().take();
    input.latch.borrow_mut().take();
    input.wheel_listener.borrow_mut().clear();
    input.pinch_listener.borrow_mut().clear();
    input.hover_tracked.borrow_mut().clear();
    input.hovered.borrow_mut().clear();
    input.link_hovered.borrow_mut().take();
    input.last.set(None);
    input.cursor.set(None);
    input.gestures.borrow_mut().clear();
    input.js_block.set(false);
}

/// `TrackStates`.
pub(crate) fn track_states(surface: &Rc<Surface>, view: &NshView, states: u16) {
    {
        let mut s = view.state_mut();
        s.tracked = states;
        // The core keeps the states still reported and forgets the rest
        // (`Core::update_tracking`): so do we, or a change it was not told
        // about (the pointer leaving a view whose hover was tracked
        // throughout) would never reach it. The focus is reported
        // whatever is tracked, so it stays.
        s.states &= input::reported_states(states);
    }
    view.settle_leaf();
    update_hover_tracking(surface, view);
}

/// Whether hovering `view` matters: for its `hover:` styles (the
/// `HOVERED` state) or its `onMouseEnter` / `onMouseLeave` /
/// `onMouseMove`.
fn hoverable(view: &NshView) -> bool {
    let s = view.state();
    input::hoverable(s.tracked, s.events)
}

fn update_hover_tracking(surface: &Surface, view: &NshView) {
    let id = view.state().id;
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

/// `view` leaves the tree (`Remove`, `Delete`): it and the views inside it
/// leave the hover and the keyboard focus, their states cleared and
/// reported, without a leave or blur, as a removed DOM element. A removed
/// view can outlive its component (a JS cycle through its ref), whose
/// handlers must not run.
pub(crate) fn removed(surface: &Surface, view: &NshView) {
    let input = &surface.input;
    let inside = |v: &NshView| v.is_within(view.ns());
    if !input.hovered.borrow().is_empty() {
        let left: Vec<NshView> = input
            .hovered
            .borrow_mut()
            .extract_if(.., |v| inside(v))
            .collect();
        for v in &left {
            set_state(surface, v, HOVERED, false);
        }
    }
    if input
        .link_hovered
        .borrow()
        .as_ref()
        .is_some_and(|(v, _)| inside(v))
    {
        input.link_hovered.borrow_mut().take();
    }
    let Some(window) = view.ns().window() else {
        return;
    };
    let Some(responder) = window.firstResponder() else {
        return;
    };
    if !responder
        .downcast_ref::<NSView>()
        .is_some_and(|r| r.isDescendantOf(view.ns()))
    {
        return;
    }
    // AppKit gives the focus of a view leaving its window to the window
    // without a resign, but ends a field's editing (its blur): the window
    // takes it now, the focus reported gone first so the resign is silent.
    match responder
        .downcast_ref::<ViewObj>()
        .and_then(|obj| NshView::from_ns(obj))
    {
        Some(focused) => set_state(surface, &focused, FOCUSED, false),
        None => crate::text_input::taken_out(&window),
    }
    window.makeFirstResponder(None);
    // Then the root, as when the view hides or is blurred (the page's body
    // in a browser): left on the window, the focus reaches no responder of
    // the root's keys and actions (Copy of a page selection, Escape,
    // scrolling keys), and a press on a page text does not take it back.
    // Not when the root leaves with the view (its window closes).
    let root = root_in(surface, &window);
    if !root.ns().isDescendantOf(view.ns()) {
        window.makeFirstResponder(Some(root.ns()));
    }
}

/// Sets or clears interaction state `bit` of `view` and reports the
/// states when they changed and the view tracks the bit.
pub(crate) fn set_state(surface: &Surface, view: &NshView, bit: u16, on: bool) {
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

/// The view's events changed (presses change its cursor, mouse handlers
/// have it hovered). A handler added under the mouse hears it on the
/// batch's pick (`content_moved`).
pub(crate) fn events_changed(surface: &Rc<Surface>, view: &NshView) {
    update_hover_tracking(surface, view);
    surface.input.cursor_dirty.set(true);
    release_invalid_control_focus(surface, view);
}

/// The view's props changed (`pointerEvents`, `windowResize`, `disabled`).
pub(crate) fn props_changed(surface: &Rc<Surface>, view: &NshView, old: &nsh_core::ViewProps) {
    let cursor_affected = {
        let new = &view.state().props;
        old.pointer_events != new.pointer_events
            || old.window_resize != new.window_resize
            || old.accessibility.state.disabled != new.accessibility.state.disabled
    };
    if cursor_affected {
        surface.input.cursor_dirty.set(true);
    }
    release_invalid_control_focus(surface, view);
}

fn release_invalid_control_focus(surface: &Surface, view: &NshView) {
    let Some(window) = view.ns().window() else {
        return;
    };
    let Some(responder) = window
        .firstResponder()
        .and_then(|r| r.downcast::<objc2_app_kit::NSView>().ok())
    else {
        return;
    };
    let root = root_in(surface, &window);
    if &*responder == root.ns() || !responder.isDescendantOf(view.ns()) {
        return;
    }
    let valid = match NshView::from_ns(&responder) {
        Some(focused) => is_key_stop(&focused),
        None => crate::view::enclosing(&responder).is_some_and(|owner| owner.can_reach()),
    };
    if !valid {
        crate::text_input::to_root(&window, surface);
    }
}

/// A batch is applied: the keyboard focus leaves a stop, or a field (an
/// input's, a hosted view) in a view of ours, that it hid
/// ([`NshView::seen_by_keys`]: `display: none` or `visibility: hidden`
/// around it), for the root of its window, as it leaves a screen that
/// hides. AppKit keeps a hidden view focused, and the keys would still act
/// on what the user cannot see.
pub(crate) fn release_hidden_focus(surface: &Surface) {
    for root in std::iter::once(surface.root.clone()).chain(crate::window::roots(surface)) {
        let Some(window) = root.ns().window() else {
            continue;
        };
        let Some(mut at) = window
            .firstResponder()
            .and_then(|responder| responder.downcast::<objc2_app_kit::NSView>().ok())
        else {
            continue;
        };
        if !at.isDescendantOf(root.ns()) {
            continue;
        }
        // The stop itself, or the view of ours holding the field (a field
        // that edits has the window's field editor in it).
        let view = loop {
            if let Some(view) = NshView::from_ns(&at) {
                break Some(view);
            }
            match crate::view::superview(&at) {
                Some(up) => at = up,
                None => break None,
            }
        };
        if let Some(view) = view
            && view != root
            && !view.seen_by_keys()
        {
            window.makeFirstResponder(Some(root.ns()));
        }
    }
}

/// The view's style changed (`cursor`, `visibility`). Batched updates
/// refresh once at [`content_moved`].
pub(crate) fn style_changed(surface: &Rc<Surface>, view: &NshView, old: &nsh_core::ViewStyle) {
    release_invalid_control_focus(surface, view);
    let cursor_affected = {
        let new = &view.state().style;
        old.cursor != new.cursor || old.hidden != new.hidden
    };
    if cursor_affected {
        surface.input.cursor_dirty.set(true);
    }
}

/// Cursor-affecting non-style state changed (e.g. text selectability).
pub(crate) fn cursor_changed(surface: &Surface) {
    surface.input.cursor_dirty.set(true);
}

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
    // Zoom and diagonal resize cursors need macOS 15. They are class
    // methods: the metaclass answers for them (the class itself answers
    // for its instances' methods).
    let supported = |sel| NSCursor::class().metaclass().responds_to(sel);
    match cursor {
        Cursor::Pointer => NSCursor::pointingHandCursor(),
        Cursor::Text => NSCursor::IBeamCursor(),
        Cursor::Crosshair => NSCursor::crosshairCursor(),
        Cursor::Move | Cursor::Grab => NSCursor::openHandCursor(),
        Cursor::Grabbing => NSCursor::closedHandCursor(),
        Cursor::NotAllowed => NSCursor::operationNotAllowedCursor(),
        Cursor::ZoomIn if supported(sel!(zoomInCursor)) => NSCursor::zoomInCursor(),
        Cursor::ZoomOut if supported(sel!(zoomOutCursor)) => NSCursor::zoomOutCursor(),
        // Their replacements are macOS 15's.
        #[allow(deprecated)]
        Cursor::ColResize => NSCursor::resizeLeftRightCursor(),
        #[allow(deprecated)]
        Cursor::RowResize => NSCursor::resizeUpDownCursor(),
        Cursor::NwseResize | Cursor::NeswResize
            if supported(sel!(frameResizeCursorFromPosition:inDirections:)) =>
        {
            let position = if cursor == Cursor::NwseResize {
                NSCursorFrameResizePosition::TopLeft
            } else {
                NSCursorFrameResizePosition::TopRight
            };
            NSCursor::frameResizeCursorFromPosition_inDirections(
                position,
                NSCursorFrameResizeDirections::All,
            )
        }
        // macOS 14 keeps the move cursor used before diagonal axes were distinct.
        Cursor::NwseResize | Cursor::NeswResize => NSCursor::openHandCursor(),
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
                .or_else(|| s.props.window_resize.map(resize_cursor))
                .or_else(|| crate::text::selectable(&s).then_some(Cursor::Text))
                .or_else(|| {
                    (v == &hit.view
                        && crate::selectable_view::is_area_text(v, &s)
                        && !crate::selectable_view::cursor_above(v))
                    .then_some(Cursor::Text)
                })
        })
        .unwrap_or(Cursor::Default)
}

/// Whether `(x, y)` (root coordinates) is on a pressable link span of text
/// view `view` that sets no cursor of its own: the pointer there wins over
/// the I-beam of selectable text, as on the other desktops.
fn over_link(surface: &Surface, view: &NshView, x: f32, y: f32) -> bool {
    {
        let s = view.state();
        if cursor_of(s.style.cursor).is_some()
            || s.text.as_ref().is_none_or(|t| t.text.links.is_empty())
        {
            return false;
        }
    }
    let (lx, ly) = local(surface, view, x, y);
    crate::text::link_at(&view.state(), lx, ly).is_some_and(|link| has_press(link.events))
}

/// Sets the cursor for the mouse at `(x, y)` (hosted views set their own).
/// Unless `always`, only sets the cursor when the app's cursor is
/// another one. `-[NSCursor set]` costs milliseconds even for the cursor
/// already set (with a customized pointer size or color it renders the
/// cursor image again: ~3 ms on macOS 26), so only the mouse coming in
/// (it may bring another app's cursor) and a press's end set it always.
fn set_cursor_at(surface: &Surface, root: &NshView, x: f32, y: f32, always: bool) {
    if surface.input.pointer.borrow().is_some() {
        // A drag keeps the cursor it began with.
        return;
    }
    let hit = pick(root, x, y);
    // The same pick says which link of a text the mouse is over.
    hover_link(
        surface,
        hit.as_ref().filter(|h| h.native.is_none()).map(|h| &h.view),
        x,
        y,
    );
    let cursor = match hit {
        // the hosted view sets its own: the next one is set again
        Some(hit) if hit.native.is_some() => return surface.input.cursor.set(None),
        Some(hit) => {
            if over_link(surface, &hit.view, x, y) {
                Cursor::Pointer
            } else {
                cursor_at(&hit)
            }
        }
        None => Cursor::Default,
    };
    if let Some(cursor) = cursor_to_set(always, surface.input.cursor.get(), cursor) {
        ns_cursor(cursor).set();
        surface.input.cursor.set(Some(cursor));
    }
}

/// The cursor to set where the app's is `cursor`, after this surface last
/// set `set` (`None`: another may show, a hosted view's or another app's):
/// none when it shows already, unless `always`.
fn cursor_to_set(always: bool, set: Option<Cursor>, cursor: Cursor) -> Option<Cursor> {
    (always || set != Some(cursor)).then_some(cursor)
}

/// The mouse at `(x, y)` (root coordinates) is over `view` (none: off the
/// root, or on a hosted view): a link of its text listening hears
/// `onMouseEnter` when the mouse comes over the link's characters and
/// `onMouseLeave` when it leaves them, as a view does (the core shows a
/// link's hint, its URL, by them).
fn hover_link(surface: &Surface, view: Option<&NshView>, x: f32, y: f32) {
    let link = view.and_then(|v| {
        if v.state()
            .text
            .as_ref()
            .is_none_or(|t| t.text.links.is_empty())
        {
            return None;
        }
        let (lx, ly) = local(surface, v, x, y);
        crate::text::link_at(&v.state(), lx, ly).map(|link| (v.clone(), link))
    });
    let input = &surface.input;
    let same = input.link_hovered.borrow().as_ref().map(|(_, l)| l.node)
        == link.as_ref().map(|(_, l)| l.node);
    if same {
        return;
    }
    let mouse = Mouse::now();
    let old = input.link_hovered.replace(link.clone());
    for (kind, hovered) in [(EventKind::MouseLeave, old), (EventKind::MouseEnter, link)] {
        if let Some((v, l)) = hovered
            && l.events.contains(kind)
        {
            let (lx, ly) = local(surface, &v, x, y);
            let event = MouseEvent::new(
                point(Points(lx), Points(ly)),
                point(Points(x), Points(y)),
                mouse.modifiers,
                mouse.pressed,
            );
            surface.event(l.node, kind, EventPayload::Mouse(event));
        }
    }
}

/// Where the event window last saw the mouse, in that root's coordinates.
pub(crate) fn pointer_location(surface: &Surface) -> Option<(f32, f32)> {
    let position = surface.input.last.get()?;
    (position.root == event_root(surface).id()).then_some((position.x, position.y))
}

/// Records the point with the window that delivered it. An enter in a
/// second window can arrive before the old window's exit.
fn remember_pointer(surface: &Surface, position: PointerPosition, event: &NSEvent) {
    if let Some(previous) = surface.input.last.get()
        && previous.root != position.root
    {
        leave_pointer_root(surface, previous.root, Mouse::of(event));
    }
    surface.input.last.set(Some(position));
}

fn leave_pointer_root(surface: &Surface, root: NodeId, mouse: Mouse) {
    let input = &surface.input;
    let Some(previous) = input.last.get().filter(|p| p.root == root) else {
        return;
    };
    input.last.set(None);
    input.cursor.set(None);
    set_hovered(surface, Vec::new(), previous.x, previous.y, mouse);
    hover_link(surface, None, previous.x, previous.y);
}

/// A hidden, minimized or removed window no longer owns the pointer.
pub(crate) fn window_hidden(surface: &Surface, root: NodeId) {
    leave_pointer_root(surface, root, Mouse::now());
}

fn pointer_root(surface: &Surface) -> Option<(PointerPosition, NshView)> {
    let position = surface.input.last.get()?;
    let root = crate::window::root_view(surface, position.root)?;
    // The terminal surface deliberately renders in a hidden window.
    let window = root.ns().window()?;
    if !surface.terminal.get() && (!window.isVisible() || window.isMiniaturized()) {
        return None;
    }
    Some((position, root))
}

/// Sets the cursor again after content changed under the last pointer.
fn refresh_cursor(surface: &Surface) {
    if let Some((position, root)) = pointer_root(surface) {
        set_cursor_at(surface, &root, position.x, position.y, false);
    }
}

/// AppKit asks the view under the mouse for its cursor (`cursorUpdate:`,
/// after views moved or were added, or the pointer left a window edge's
/// resize cursor): NSH's, which AppKit's default (the arrow, set again on
/// every update) would replace. Only the root that owns the pointer may use it.
pub(crate) fn cursor_update(surface: &Surface, root: &NshView, event: Option<&NSEvent>) {
    let position = event
        .filter(|e| {
            e.window(surface.mtm)
                .is_some_and(|w| root.ns().window().as_deref() == Some(&*w))
        })
        .map(|e| {
            let p = root.ns().convertPoint_fromView(e.locationInWindow(), None);
            let pos = PointerPosition {
                root: root.id(),
                x: p.x as f32,
                y: p.y as f32,
            };
            surface.input.last.set(Some(pos));
            pos
        })
        .or_else(|| surface.input.last.get().filter(|p| p.root == root.id()));
    if let Some(position) = position {
        set_cursor_at(surface, root, position.x, position.y, true);
    }
}

/// A repick waits this long after the last content move (ms): each repick
/// is a full hit test, and a scroll calls `content_moved` per step — the
/// burst re-arms the deadline so the pick lands once, when it settles.
const REPICK_MS: f64 = 120.0;

/// A scroll step clears hover inside the moving content at once, so a
/// tooltip does not follow its old trigger. A scroll burst still gets one
/// trailing hit test to pick what ended up under the mouse. Non-scroll
/// batches also update the cursor immediately so nested hover updates never
/// wait a frame.
pub(crate) fn content_moved(surface: &Surface, scrolled: Option<&NshView>) {
    let input = &surface.input;
    let Some(position) = input.last.get() else {
        input.cursor_dirty.set(false);
        return;
    };
    if let Some(scroll) = scrolled {
        let kept = {
            let hovered = input.hovered.borrow();
            let moved = hovered
                .iter()
                .take_while(|view| *view != scroll && view.ns().isDescendantOf(scroll.ns()))
                .count();
            (moved > 0).then(|| hovered[moved..].to_vec())
        };
        if let Some(kept) = kept {
            set_hovered(surface, kept, position.x, position.y, Mouse::now());
        }
    }
    let t = crate::scroll::now();
    let armed = input.repick.replace(true);
    let at = repick_deadline(armed, input.repick_at.get(), t, scrolled.is_some());
    input.repick_at.set(at);
    if scrolled.is_none() && input.cursor_dirty.replace(false) && (!armed || at <= t) {
        refresh_cursor(surface);
    }
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
    if let Some((position, root)) = pointer_root(&surface) {
        crate::surface::quiet(|| hover(&surface, &root, position.x, position.y, Mouse::now()));
        set_cursor_at(&surface, &root, position.x, position.y, false);
    }
}

/// An event reaches `surface` through `window`'s root view: a window of
/// the app's own (`Window.open`), or `None` for the surface's root. What it
/// picks, converts and focuses is in that window until the next event.
/// Returns the window the input was in before, so an event that does not
/// move the pointer (the test agent's file drop) can hand it back.
pub(crate) fn enter(surface: &Surface, window: Option<NshView>) -> Option<NshView> {
    surface.input.window_root.replace(window)
}

/// A window of the app's own closed (its root `root`): when it was the
/// input's, the input goes back to the surface's root, so a repick never
/// picks in a detached root.
pub(crate) fn window_closed(surface: &Surface, root: &NshView) {
    let mut window_root = surface.input.window_root.borrow_mut();
    if window_root.as_ref() == Some(root) {
        *window_root = None;
    }
}

/// The root view `window` shows: the surface's, or that of a window of the
/// app's own. What runs outside an event (a commit's `blur()`, a page
/// leaving) finds the root by the window, never by [`event_root`], which
/// is the last event's.
pub(crate) fn root_in(surface: &Surface, window: &objc2_app_kit::NSWindow) -> NshView {
    crate::window::roots(surface)
        .into_iter()
        .find(|root| root.ns().window().as_deref() == Some(window))
        .unwrap_or_else(|| surface.root.clone())
}

/// The root view of the window the event being handled happened in
/// ([`enter`]).
pub(crate) fn event_root(surface: &Surface) -> NshView {
    surface
        .input
        .window_root
        .borrow()
        .clone()
        .unwrap_or_else(|| surface.root.clone())
}

// --- AppKit events ------------------------------------------------------------------

/// A mouse, wheel or trackpad event over the root view.
pub(crate) fn event(surface: &Rc<Surface>, event: &NSEvent) {
    surface.control(|control| control.set_focus_path(focus_path(surface)));
    let ty = event.r#type();
    pen_sample(event, ty);
    let root = event_root(surface);
    let p = root
        .ns()
        .convertPoint_fromView(event.locationInWindow(), None);
    let (x, y) = (p.x as f32, p.y as f32);
    let position = PointerPosition {
        root: root.id(),
        x,
        y,
    };
    let time = event.timestamp() * 1000.0;
    let input = &surface.input;
    // Every button's press and release puts the mouse there, the secondary
    // ones' too: a menu the app opens on a right click without a place
    // (`Menu.popup()`) opens where that click was, not where an earlier
    // press left it (`chrome::popup`).
    if matches!(
        ty,
        NSEventType::RightMouseDown
            | NSEventType::RightMouseUp
            | NSEventType::OtherMouseDown
            | NSEventType::OtherMouseUp
    ) {
        remember_pointer(surface, position, event);
    }
    if matches!(
        ty,
        NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown
    ) {
        // Before the press acts: the focus it moves does not show.
        surface.control(|c| c.set_input_modality(InputModality::Pointer));
        // A press in a window gives it the keyboard (AppKit does it itself,
        // but for an app in the background).
        if let Some(window) = event.window(surface.mtm) {
            crate::window::became_key(surface, &window);
        }
    }
    match ty {
        // Control-click is the secondary click on macOS.
        NSEventType::LeftMouseDown
            if event
                .modifierFlags()
                .contains(NSEventModifierFlags::Control) =>
        {
            remember_pointer(surface, position, event);
            input.control_click.set(true);
            context_menu(surface, x, y, event.modifierFlags());
        }
        NSEventType::RightMouseDown => context_menu(surface, x, y, event.modifierFlags()),
        NSEventType::LeftMouseDown => {
            // Every plain press clears the latch: a text context menu tracks
            // the mouse synchronously and consumes its release, so a
            // Control-click's latch can outlive its press and would
            // otherwise report this release as the secondary button.
            input.control_click.set(false);
            // A press on a drag region left waiting (its release went elsewhere: the
            // window closed under it) must not take this press's drags.
            input.window_press.borrow_mut().take();
            if !surface.terminal.get()
                && (window_part_press(surface, event, x, y)
                    || window_press(surface, event, x, y, time)
                    || crate::chrome::mouse_down(surface, event, x, y))
            {
                return;
            }
            remember_pointer(surface, position, event);
            down(
                surface,
                x,
                y,
                time,
                event.clickCount().max(1) as usize,
                event.modifierFlags(),
            );
        }
        NSEventType::LeftMouseDragged if input.window_press.borrow().is_some() => {
            window_press_drag(surface, event, x, y);
        }
        NSEventType::LeftMouseUp if input.window_press.borrow().is_some() => {
            window_press_up(surface, x, y, time);
        }
        NSEventType::LeftMouseDragged
        | NSEventType::RightMouseDragged
        | NSEventType::OtherMouseDragged => {
            remember_pointer(surface, position, event);
            // Entered and left before the move, as in the DOM: a view the
            // drag came over hears it move there.
            let mouse = Mouse::of(event);
            hover(surface, &root, x, y, mouse);
            mouse_moved(surface, x, y, mouse);
            motion(surface, x, y, time);
        }
        NSEventType::LeftMouseUp => {
            remember_pointer(surface, position, event);
            let button = if input.control_click.replace(false) {
                MouseButton::Right
            } else {
                MouseButton::Left
            };
            mouse_up(surface, x, y, Mouse::of(event), button);
            up(surface, x, y, time);
            set_cursor_at(surface, &root, x, y, true);
            let control = input.window_control.borrow_mut().take();
            if let Some((view, control)) = control
                && pick(&event_root(surface), x, y)
                    .is_some_and(|hit| chain(&hit.view).contains(&view))
            {
                crate::window::control(surface, control, event);
            }
        }
        NSEventType::RightMouseUp => {
            remember_pointer(surface, position, event);
            mouse_up(surface, x, y, Mouse::of(event), MouseButton::Right);
        }
        NSEventType::OtherMouseUp => {
            remember_pointer(surface, position, event);
            if let Some(button) = other_button(event.buttonNumber()) {
                mouse_up(surface, x, y, Mouse::of(event), button);
            }
        }
        NSEventType::MouseMoved | NSEventType::MouseEntered => {
            remember_pointer(surface, position, event);
            let mouse = Mouse::of(event);
            hover(surface, &root, x, y, mouse);
            mouse_moved(surface, x, y, mouse);
            reveal_indicators(surface, x, y);
            // Set always as the mouse comes in (it may bring another app's
            // cursor); while it moves, only when it changes: setting it
            // on every move kept a customized pointer re-rendering
            // (~95% of the main thread's time over a chat's rows).
            set_cursor_at(surface, &root, x, y, ty == NSEventType::MouseEntered);
        }
        NSEventType::MouseExited => {
            leave_pointer_root(surface, root.id(), Mouse::of(event));
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

/// The innermost span hearing a context menu at this UTF-16 character.
/// Hover-only inner spans leave the surrounding span's action reachable.
fn context_link(links: &[nsh_core::TextLink], at: u32) -> Option<nsh_core::TextLink> {
    links
        .iter()
        .filter(|link| {
            link.start <= at && at < link.end && link.events.contains(EventKind::ContextMenu)
        })
        .min_by_key(|link| link.end - link.start)
        .copied()
}

/// A secondary click at `(x, y)` (root coordinates): the nearest view
/// around the one under it that listens to `onContextMenu` hears it,
/// unless selectable text is nearer: that shows its edit menu, but where
/// its selectable view, or a view between them, listens
/// ([`nsh_core::input::context_menu_target`], as on Linux and Windows).
/// Text fields are AppKit's views, which show their own menu.
fn context_menu(surface: &Surface, x: f32, y: f32, flags: NSEventModifierFlags) {
    let Some(hit) = pick(&event_root(surface), x, y) else {
        return;
    };
    if hit.native.is_none() {
        let (lx, ly) = local(surface, &hit.view, x, y);
        let span = {
            let state = hit.view.state();
            crate::text::char_at(&state, lx, ly).and_then(|at| {
                state
                    .text
                    .as_ref()
                    .and_then(|text| context_link(&text.text.links, at))
            })
        };
        if let Some(link) = span {
            let event = nsh_core::ContextMenuEvent::new(
                point(Points(lx), Points(ly)),
                point(Points(x), Points(y)),
                modifiers(flags),
                Some(nsh_core::PointerType::Mouse),
            );
            surface.event(
                link.node,
                EventKind::ContextMenu,
                EventPayload::ContextMenu(event),
            );
            return;
        }
    }
    let views = chain(&hit.view);
    let hops: Vec<_> = views.iter().map(|v| context_menu_hop(&v.state())).collect();
    match input::context_menu_target(&hops) {
        Some(ContextMenuTarget::Listener(i)) => {
            let v = &views[i];
            let (location_x, location_y) = local(surface, v, x, y);
            let event = nsh_core::ContextMenuEvent::new(
                point(Points(location_x), Points(location_y)),
                point(Points(x), Points(y)),
                modifiers(flags),
                Some(nsh_core::PointerType::Mouse),
            );
            surface.event(
                v.id(),
                EventKind::ContextMenu,
                EventPayload::ContextMenu(event),
            );
        }
        Some(ContextMenuTarget::EditMenu(i)) => {
            let area = crate::selectable_view::area_of(&views[i]);
            crate::text::context_menu(surface, area.as_ref());
        }
        Some(ContextMenuTarget::Field(_)) | None => {}
    }
}

/// What `state`'s view is to a secondary click's menu.
fn context_menu_hop(state: &crate::view::ViewState) -> input::ContextMenuHop {
    input::ContextMenuHop {
        listens: state.events.contains(EventKind::ContextMenu),
        field: state.kind == ViewKind::Input,
        selectable_text: crate::text::selectable(state),
        selectable_view: state.props.selectable_view,
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
    // Before the key acts: the focus it moves shows (`focus-visible:`).
    // A modifier alone is a `flagsChanged`, never a key down.
    if down {
        surface.control(|c| c.set_input_modality(InputModality::Keyboard));
    }
    surface.control(|control| control.set_focus_path(focus_path(surface)));
    if let Some(view) = control_activation_target(surface, event) {
        if down && !event.isARepeat() {
            activate(surface, view.id(), view.state().events, "keyboard");
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
    let root = &event_root(surface);
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

/// A view the app made `focusable` (and not disabled, nor an input, which
/// focuses its editor): a press on it moves the keyboard focus there, as
/// the other desktops' widgets do on a press.
fn explicitly_focusable(view: &NshView) -> bool {
    let state = view.state();
    view.id() != ROOT_ID
        && state.kind != ViewKind::Input
        && !state.props.accessibility.state.disabled
        && state.props.focusable == Some(true)
        && view.can_target()
}

/// A mounted ordinary view the keyboard focus stops at (Tab): one that
/// takes presses, or any `focusable` one ([`nsh_core::ViewProps::focus_stop`]),
/// shown ([`NshView::seen_by_keys`]) and reachable by the pointer.
pub(crate) fn is_key_stop(view: &NshView) -> bool {
    let is_stop = view.try_state().is_some_and(|state| {
        state.kind != ViewKind::Input
            && state
                .props
                .focus_stop(state.events.contains(EventKind::Press))
    });
    is_stop && view.can_reach() && view.seen_by_keys()
}

/// A stop that Return and Space press ([`is_key_stop`] taking presses): a
/// stop that takes none hears its keys through the app's keymap.
pub(crate) fn is_key_control(view: &NshView) -> bool {
    is_key_stop(view)
        && view
            .try_state()
            .is_some_and(|s| s.events.contains(EventKind::Press))
}

/// Current AppKit keyboard focus, from the responder through its native
/// ancestors. No mounter borrow: native callbacks may run during a mount.
pub(crate) fn focus_path(surface: &Surface) -> Vec<NodeId> {
    let root = if surface.terminal.get() {
        // A terminal surface is embedded in a hidden AppKit window.
        surface.root.clone()
    } else {
        let Some(root) = crate::window::app_key_window(surface.mtm)
            .and_then(|window| crate::window::root_in(surface, &window))
        else {
            return Vec::new();
        };
        root
    };
    let root = root.ns();
    let Some(window) = root.window() else {
        return Vec::new();
    };
    // AppKit can host its shared field editor outside the input's own subtree.
    let mut view = if let Some(input) = crate::text_input::focused_input_view(surface, &window) {
        input.ns().retain()
    } else {
        let Some(view) = window
            .firstResponder()
            .and_then(|responder| responder.downcast::<objc2_app_kit::NSView>().ok())
        else {
            return Vec::new();
        };
        view
    };
    if !view.isDescendantOf(root) {
        return Vec::new();
    }
    let mut path = Vec::new();
    loop {
        if let Some(node) = NshView::from_ns(&view) {
            if path.is_empty() {
                if &*view != root && !node.can_reach() {
                    return Vec::new();
                }
            } else if !node.can_target()
                || node
                    .try_state()
                    .is_none_or(|s| s.props.pointer_events == PointerEvents::BoxOnly)
            {
                return Vec::new();
            }
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

/// `focus()` on a view that is not an input: the keyboard focus moves to
/// it as Tab moves it there (its `becomeFirstResponder` sets `focus:` and
/// reports `onFocus`), if it is a stop of Tab ([`is_key_stop`]).
pub(crate) fn focus_control(surface: &Surface, view: &NshView) {
    if !is_key_stop(view)
        || has_key_focus(view)
        || !crate::navigation::in_focus_scope(surface, view.ns())
    {
        return;
    }
    let Some(window) = view.ns().window() else {
        return;
    };
    // A field that edits keeps the focus while a click is handled (the
    // view refuses it then): the window takes it first, as `blur()` does.
    if crate::text_input::editing_in(&root_in(surface, &window)) {
        window.makeFirstResponder(None);
    }
    window.makeFirstResponder(Some(view.ns()));
}

/// `blur()` on a view that is not an input and has the keyboard focus:
/// the surface's root takes it, as when an input is blurred.
pub(crate) fn blur_control(surface: &Surface, view: &NshView) {
    if let Some(window) = view.ns().window()
        && has_key_focus(view)
    {
        window.makeFirstResponder(Some(root_in(surface, &window).ns()));
    }
}

/// Whether `view` itself is its window's first responder.
fn has_key_focus(view: &NshView) -> bool {
    view.ns()
        .window()
        .and_then(|window| window.firstResponder())
        .is_some_and(|responder| {
            responder
                .downcast_ref::<objc2_app_kit::NSView>()
                .is_some_and(|v| v == view.ns())
        })
}

/// Enter or Space addressed to a focused control inside the current modal.
/// The keymap leaves these keys to the responder, but for the bindings of
/// the focus itself (`Keymap::find_at`), so a global Enter binding cannot
/// activate an unrelated control underneath keyboard focus.
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
    let responder = event_root(surface).ns().window()?.firstResponder()?;
    let native = responder.downcast_ref::<objc2_app_kit::NSView>()?;
    if !native.isDescendantOf(&crate::navigation::focus_scope(surface)) {
        return None;
    }
    NshView::from_ns(native).filter(is_key_control)
}

/// Whether the keyboard focus is on a view of the window the newest modal
/// over it covers: a focus the app left there (a popup closing gave it
/// back to its trigger as a dialog opened). That view's own bindings take
/// no keys ([`nsh_core::keymap::KeyFocus::covered`]).
pub(crate) fn focus_covered(surface: &Surface) -> bool {
    let root = event_root(surface);
    let Some(responder) = root.ns().window().and_then(|w| w.firstResponder()) else {
        return false;
    };
    let Some(native) = responder.downcast_ref::<objc2_app_kit::NSView>() else {
        return false;
    };
    native.isDescendantOf(root.ns())
        && !native.isDescendantOf(&crate::navigation::focus_scope(surface))
}

/// Presses `view` with no pointer to report, as Return and Space press a
/// focused control and `AXPress` presses any: its `onPressDown`,
/// `onPressUp` and `onPress`. `from` names the source in the log.
fn activate(surface: &Surface, node: nsh_core::NodeId, events: nsh_core::EventMask, from: &str) {
    for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
        if events.contains(kind) {
            log::debug!(target: "nsh::input", "{} on {} ({from})", kind.prop_name(), node);
            surface.event(node, kind, EventPayload::None);
        }
    }
}

/// Whether `AXPress` presses `view`: it takes presses, is not disabled, the
/// pointer could reach it and it is inside the newest modal, as Return and
/// Space need ([`control_activation_target`]). Other views do not offer
/// the action.
pub(crate) fn takes_accessibility_press(surface: &Surface, view: &NshView) -> bool {
    let (window_control, pressable) = view.try_state().map_or((false, false), |s| {
        let enabled = !s.props.accessibility.state.disabled && !s.props.accessibility.hidden;
        (
            enabled && s.props.window_control.is_some(),
            enabled && s.events.contains(EventKind::Press),
        )
    });
    (window_control || pressable)
        && view.can_reach()
        && !crate::access::hidden_in_subtree(view)
        && crate::navigation::in_focus_scope(surface, view.ns())
}

/// `AXPress` from an accessibility client (VoiceOver's VO-Space, UI
/// automation): presses a view [`takes_accessibility_press`] allows, as
/// Return does when it has the keyboard focus. Returns whether it did.
pub(crate) fn accessibility_press(surface: &Surface, view: &NshView) -> bool {
    if !takes_accessibility_press(surface, view) {
        return false;
    }
    // A view standing for a window button acts as that button.
    let control = view.state().props.window_control;
    if let Some(control) = control
        && let Some(window) = view.ns().window()
        && let Some(surface) = Surface::with_key(surface.key())
    {
        crate::window::control_window(&surface, &window, control, false);
        return true;
    }
    activate(surface, view.id(), view.state().events, "accessibility");
    true
}

/// An accessible inline link uses the same node and events as a pointer
/// press, while retaining the input's keyboard focus.
pub(crate) fn accessibility_span_events(
    surface: &Surface,
    view: &NshView,
    node: nsh_core::NodeId,
) -> Option<nsh_core::EventMask> {
    if !view.can_target()
        || !view
            .ns()
            .isDescendantOf(&crate::navigation::focus_scope(surface))
    {
        return None;
    }
    let state = view.try_state()?;
    if state.props.accessibility.state.disabled {
        return None;
    }
    state
        .text
        .as_ref()?
        .text
        .links
        .iter()
        .find(|link| link.node == node && link.events.contains(EventKind::Press))
        .map(|link| link.events)
}

pub(crate) fn accessibility_span_press(
    surface: &Surface,
    view: &NshView,
    node: nsh_core::NodeId,
) -> bool {
    let Some(events) = accessibility_span_events(surface, view, node) else {
        return false;
    };
    activate(surface, node, events, "accessibility");
    true
}

/// Whether an assistive technology's "show menu" (`AXShowMenu`, VoiceOver's
/// VO-Shift-M) opens a context menu on `view`: it listens to
/// `onContextMenu` and is inside the newest modal. Other views do not
/// offer the action.
pub(crate) fn takes_accessibility_show_menu(surface: &Surface, view: &NshView) -> bool {
    view.state().events.contains(EventKind::ContextMenu)
        && crate::navigation::in_focus_scope(surface, view.ns())
}

/// `AXShowMenu` on `view`: it hears `onContextMenu` with no pointer, at its
/// bottom-start corner ([`nsh_core::input::context_menu_anchor`]), where a
/// menu opened below it starts. AppKit has no keyboard key for context
/// menus (Shift+F10 is Windows' and GTK's), so this is how the keyboard
/// reaches them on a Mac: VoiceOver and the other clients that perform
/// `AXShowMenu`.
pub(crate) fn accessibility_show_menu(surface: &Surface, view: &NshView) -> bool {
    if !takes_accessibility_show_menu(surface, view) {
        return false;
    }
    let rtl = surface.mounter.try_borrow().is_ok_and(|m| m.rtl);
    let (id, size) = {
        let s = view.state();
        (s.id, s.frame.size)
    };
    let position = nsh_core::input::context_menu_anchor(size, rtl);
    let root = view
        .ns()
        .window()
        .map_or_else(|| surface.root.clone(), |window| root_in(surface, &window));
    let page = view.ns().convertPoint_toView(
        objc2_foundation::NSPoint::new(f64::from(position.x.0), f64::from(position.y.0)),
        Some(root.ns()),
    );
    let event = nsh_core::ContextMenuEvent::new(
        position,
        point(Points(page.x as f32), Points(page.y as f32)),
        Default::default(),
        None,
    );
    log::debug!(target: "nsh::input", "onContextMenu on {id} (accessibility)");
    surface.event(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
    true
}

/// Tab / Shift+Tab (or with Control) with the root focused: moves into
/// AppKit's key view loop (fields and the views [`is_key_stop`] takes), from
/// the first or last, so focus never gets stuck on the root.
fn tab(surface: &Surface, event: &NSEvent) -> bool {
    const TAB: u16 = 48;
    let flags = event.modifierFlags();
    if event.keyCode() != TAB
        || flags.intersects(NSEventModifierFlags::Command | NSEventModifierFlags::Option)
    {
        return false;
    }
    // Into the controls of the newest modal, if one is shown.
    let responder = event_root(surface)
        .ns()
        .window()
        .and_then(|window| window.firstResponder());
    let root = event_root(surface);
    let from = responder
        .as_ref()
        .and_then(|responder| responder.downcast_ref::<objc2_app_kit::NSView>())
        .filter(|view| NshView::from_ns(view).is_some_and(|view| is_key_stop(&view)))
        .unwrap_or(root.ns());
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
pub(crate) fn us_key_code(c: char) -> Option<u16> {
    let c = u8::try_from(c.to_ascii_lowercase())
        .ok()
        .filter(|&c| c != 0)?;
    US_KEYS.iter().position(|&k| k == c).map(|i| i as u16)
}

/// A virtual key code no key has, for what no US key types: WebKit names
/// it no key (`code` "Unidentified"), where 0 would be A.
pub(crate) const NO_KEY: u16 = 0xffff;

/// The key, and whether Shift is down, that type `c` on the US layout:
/// letters, digits, space, Return (`\r`), Tab and punctuation, shifted ones
/// (`A`, `!`, `?`) on their unshifted key. `None` for what no US key types.
pub(crate) fn us_typing_key(c: char) -> Option<(u16, bool)> {
    match c {
        ' ' => return Some((49, false)),
        '\r' => return Some((36, false)),
        '\t' => return Some((48, false)),
        _ => {}
    }
    if let Some(code) = us_key_code(c) {
        return Some((code, c.is_ascii_uppercase()));
    }
    US_KEYS
        .iter()
        .position(|&k| k != 0 && nsh_core::keymap::shifted(k as char) == c)
        .map(|i| (i as u16, true))
}

/// Where keys look for a scroll view: the mouse, or the middle.
fn input_point(surface: &Surface) -> (f32, f32) {
    pointer_location(surface).unwrap_or_else(|| {
        let f = event_root(surface).state().frame;
        (f.size.width.0 / 2.0, f.size.height.0 / 2.0)
    })
}

// --- Hit testing --------------------------------------------------------------------

/// What is under a point.
struct Hit {
    /// The innermost view; for a hosted view, the view whose input it
    /// edits, which is not the view hosting it when an input's pad is
    /// lifted above a transform (`crate::text_input::pad_owner`).
    view: NshView,
    /// The hosted AppKit view the point is on, as picking found it in its
    /// host's stacking order and coordinates.
    native: Option<Retained<objc2_app_kit::NSView>>,
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
        let at = point(Points(p.0), Points(p.1));
        let HitArea {
            in_slop, children, ..
        } = input::hit_area(
            at,
            s.frame.size,
            s.props.hit_slop,
            s.overflow,
            s.clips(),
            laid_out(s.kind, s.id),
        )
        .clipped(s.style.clip_path(), at, s.frame.size);
        (s.props.pointer_events, in_slop, children)
    };
    let own = || {
        (pe != PointerEvents::BoxNone && in_slop).then(|| Hit {
            view: view.clone(),
            native: None,
        })
    };
    if !children {
        return own();
    }
    if pe != PointerEvents::BoxOnly {
        // Leaves (#2066) are its only children when it has them.
        if !view.leaf_children().is_empty() {
            return pick_children(view, p).or_else(own);
        }
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
            } else if let Some(hit) = native_hit(view, &sub, p) {
                return Some(hit);
            }
        }
    }
    own()
}

/// The innermost view at `p` (`view`'s coordinates) among the children in
/// `view`'s container, and any native raised among them (a lifted input's
/// pad, which stacks there rather than over the whole view).
fn pick_children(view: &NshView, p: (f32, f32)) -> Option<Hit> {
    let cp = into_container(view, p);
    let leaves = view.leaf_children();
    if !leaves.is_empty() {
        return leaves
            .iter()
            .rev()
            .find_map(|child| into_child(child, cp).and_then(|c| pick_in(child, c)));
    }
    let container = view.container();
    let subviews: Vec<_> = container.subviews().iter().collect();
    subviews
        .into_iter()
        .rev()
        .find_map(|sub| match NshView::from_ns(&sub) {
            Some(child) => into_child(&child, cp).and_then(|c| pick_in(&child, c)),
            None => native_hit(view, &sub, p),
        })
}

/// Test geometry in the host, but dispatch from the input when its pad is lifted.
fn native_hit(view: &NshView, sub: &objc2_app_kit::NSView, p: (f32, f32)) -> Option<Hit> {
    view.state()
        .natives
        .iter()
        .any(|n| &*n.view == sub && native_contains(n, p))
        .then(|| Hit {
            view: crate::text_input::pad_owner(sub).unwrap_or_else(|| view.clone()),
            native: Some(Retained::from(sub)),
        })
}

fn native_contains(n: &crate::view::Native, p: (f32, f32)) -> bool {
    let (x, y) = p;
    let r = n.rect;
    let sub = &n.view;
    !sub.isHidden()
        && x >= r.origin.x.0
        && y >= r.origin.y.0
        && x < r.origin.x.0 + r.size.width.0
        && y < r.origin.y.0 + r.size.height.0
        && crate::text_input::pad_contains(
            sub,
            objc2_foundation::NSPoint::new(
                ((x - r.origin.x.0) / r.size.width.0) as f64 * sub.bounds().size.width,
                ((y - r.origin.y.0) / r.size.height.0) as f64 * sub.bounds().size.height,
            ),
        )
}

/// The origin of `view`'s container's bounds (its scroll offset) and its
/// zoom: the scroll state, not the bounds — while scrolling the offset
/// shows as a layer transform and the bounds catch up when it settles.
pub(crate) fn container_offset(view: &NshView) -> ((f32, f32), f32) {
    if view.container_view().is_none() {
        return ((0.0, 0.0), 1.0);
    }
    (
        crate::scroll::bounds_origin(view),
        crate::scroll::zoom(view),
    )
}

/// A point in `view`'s coordinates in its container's (its children's
/// parent space).
fn into_container(view: &NshView, p: (f32, f32)) -> (f32, f32) {
    let (o, z) = container_offset(view);
    (p.0 / z + o.0, p.1 / z + o.1)
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
pub(crate) fn unproject(m: &nsh_core::Matrix, p: (f32, f32)) -> Option<(f32, f32)> {
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
        match into_child(child, into_container(parent, p)) {
            Some(cp) => p = cp,
            None => return (x, y),
        }
    }
    p
}

/// A point in `view`'s coordinates in those of its outermost ancestor:
/// the frames' origins, the scroll offsets and, with `transforms`, the
/// transforms on the way (layer transforms, which AppKit's conversions
/// leave out), as [`local`] undoes them. `None` when a transform's
/// perspective puts the point at infinity.
#[cfg(feature = "dev")]
pub(crate) fn to_top(view: &NshView, p: (f32, f32), transforms: bool) -> Option<(f32, f32)> {
    let mut p = p;
    for pair in chain(view).windows(2) {
        let (child, parent) = (&pair[0], &pair[1]);
        if transforms && let Some(m) = child.state().transform() {
            p = project(&m, p)?;
        }
        let origin = child.ns().frame().origin;
        let (o, z) = container_offset(parent);
        p = (
            (p.0 + origin.x as f32 - o.0) * z,
            (p.1 + origin.y as f32 - o.1) * z,
        );
    }
    Some(p)
}

/// Where row-vector transform `m` shows point `p` of a view's plane
/// (z = 0), perspective included: what [`unproject`] inverts.
#[cfg(feature = "dev")]
fn project(m: &nsh_core::Matrix, p: (f32, f32)) -> Option<(f32, f32)> {
    let m = &m.0;
    let (x, y) = (p.0 as f64, p.1 as f64);
    let w = x * m[3] + y * m[7] + m[15];
    if w.abs() < 1e-12 {
        return None;
    }
    Some((
        ((x * m[0] + y * m[4] + m[12]) / w) as f32,
        ((x * m[1] + y * m[5] + m[13]) / w) as f32,
    ))
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
    let hit = pick(&event_root(surface), x, y);
    // A selectable view around the view selects across its texts; else a
    // selectable text selects alone.
    let selecting = hit.as_ref().filter(|h| h.native.is_none()).and_then(|h| {
        crate::selectable_view::target(&h.view)
            .or_else(|| crate::text::selectable(&h.view.state()).then(|| h.view.clone()))
    });
    let Some(hit) = hit else {
        crate::text::selection_down(surface, None, 0.0, 0.0, clicks, shift, false);
        return;
    };
    // A press moves the keyboard focus to an explicitly `focusable` view
    // under it that takes no presses (a chart that takes keys), as the
    // other desktops' widgets and browsers do. A control, a view that
    // takes presses (a button, a select's trigger, a slider), takes no
    // focus from a pointer, as AppKit's and Safari's do, so Return and
    // Space stay the app's shortcuts. A field that edits keeps the focus
    // (the root refuses the first responder during a press,
    // `NshView::acceptsFirstResponder`), and a press on a view that is not
    // focusable leaves it where it is.
    if hit.native.is_none()
        && let Some(window) = hit.view.ns().window()
        && let Some(target) = chain(&hit.view)
            .into_iter()
            .take_while(|view| !view.state().events.contains(EventKind::Press))
            .find(explicitly_focusable)
    {
        window.makeFirstResponder(Some(target.ns()));
    }
    let input = &surface.input;
    input.js_block.set(false);
    // A press stops the momentum a trackpad flick left running, wherever
    // it lands; the press still registers (`catch` below is for the app's
    // own glides on views under the pointer, and swallows it).
    end_momentum(surface);
    let native = hit.native.is_some();
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
            down_time: time,
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
            modifiers: modifiers(flags),
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
    // An edge pan's edges are those of the root the pointer is measured in.
    let root_size = event_root(surface).state().frame.size;
    for v in &views {
        let s = v.state();
        if s.events.contains(EventKind::Touch) {
            path.push(s.id);
        }
        if s.tracked & PRESSED != 0 {
            pressed.push(v.clone());
        }
        // A pointer away from an edge pan's edge starts neither of its pans.
        let activation = s.props.pan_activation;
        if activation.is_some_and(|a| !a.starts_at(point(Points(x), Points(y)), root_size)) {
            continue;
        }
        let values = gesture_values(surface, v, s.id);
        if !native
            && selecting.is_none()
            && let Some(pan) = Candidate::pan(&values, s.events, activation)
        {
            candidates.push((v.clone(), pan));
        }
        if gate.is_none()
            && !native
            && let Some(activation) = input::gate_activation(&values, s.events, activation)
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
    if selecting.is_some()
        && !caught
        && let Some(window) = event_root(surface).ns().window()
    {
        // Selecting output owns Copy and Select All instead of the field
        // that was editing before the mouse press.
        crate::text_input::to_root(&window, surface);
    }
    match &selecting {
        Some(area) if crate::selectable_view::is_area(area) => {
            crate::selectable_view::down(surface, area, x, y, clicks, shift, press.is_some());
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
        down_time: time,
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
        modifiers: modifiers(flags),
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

/// The mouse moved to `(x, y)` with its button down (the caller hovered
/// what is under it).
fn motion(surface: &Rc<Surface>, x: f32, y: f32, time: f64) {
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
        let selects = if crate::selectable_view::is_area(&view) {
            crate::selectable_view::drag(surface, &view, tx, ty, x, y)
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
    // meanwhile, but the view's own pan.
    if p.mode == Mode::Idle && input::activation_frees(activated, &p.candidates) {
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
        // While the gate decides, or a pan's `panActivation`, the candidates
        // around wait (the pointer stays idle and they are asked again on
        // the next move).
        let (dx, dy) = (Points(tx), Points(ty));
        if !input::waits(&p.candidates, p.gate.as_ref(), dx, dy) {
            p.mode = Mode::Free;
        }
        let started = if surface.input.js_block.get() {
            None
        } else {
            input::startable(&p.candidates, p.gate.as_ref(), dx, dy).cloned()
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

/// A left press on a drag region: it waits for the mouse ([`window_press_drag`],
/// [`window_press_up`]), as a title bar's press does. True when it is one.
fn window_press(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32, time: f64) -> bool {
    if event.clickCount() != 1 || !window_drag(surface, x, y) {
        return false;
    }
    let Some(hit) = pick(&event_root(surface), x, y) else {
        return false;
    };
    cancel_pointer(surface);
    *surface.input.window_press.borrow_mut() = Some(WindowPress {
        view: hit.view,
        x,
        y,
        time,
        modifiers: event.modifierFlags(),
    });
    true
}

/// The pressed drag region's mouse moved: past the slop, the window server moves the
/// window from this drag on, as it moves one by its title bar (in step with the pointer,
/// with edge snapping). It takes the drag event AppKit is delivering, as GPUI's
/// `start_window_move` takes the current event: a press whose drags were already taken off
/// the queue (a tracking loop) no longer moves it (#2274).
fn window_press_drag(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32) {
    let far = surface
        .input
        .window_press
        .borrow()
        .as_ref()
        .is_some_and(|p| (x - p.x).hypot(y - p.y) as f64 >= WINDOW_DRAG_SLOP);
    if !far {
        return;
    }
    surface.input.window_press.borrow_mut().take();
    if let Some(window) = event_root(surface).ns().window() {
        window.performWindowDragWithEvent(event);
    }
}

/// The pressed drag region was released without a drag: the press and its release reach
/// the app as a click, where it was pressed (an overlay closes).
fn window_press_up(surface: &Rc<Surface>, x: f32, y: f32, time: f64) {
    let Some(p) = surface.input.window_press.borrow_mut().take() else {
        return;
    };
    let root = event_root(surface);
    let same_view = pick(&root, p.x, p.y).is_some_and(|hit| hit.view == p.view);
    let close = (x - p.x).hypot(y - p.y) < WINDOW_DRAG_SLOP as f32;
    if close && same_view && window_drag(surface, p.x, p.y) {
        surface.input.last.set(Some(PointerPosition {
            root: root.id(),
            x: p.x,
            y: p.y,
        }));
        down(surface, p.x, p.y, p.time, 1, p.modifiers);
        up(surface, p.x, p.y, time);
    }
}

/// What part of its window a view the app drew stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowPart {
    /// One of the window's buttons (`windowControl`).
    Control(WindowControl),
    /// An edge or corner it is resized by (`windowResize`).
    Resize(ResizeEdge),
}

/// The window part at `(x, y)` (root coordinates): the nearest view that
/// sets `windowControl` or `windowResize`, unless a text field, a hosted
/// AppKit view or a view with press or touch handlers is nearer.
fn window_part(surface: &Surface, x: f32, y: f32) -> Option<(NshView, WindowPart)> {
    let hit = pick(&event_root(surface), x, y)?;
    if hit.native.is_some() {
        return None;
    }
    let mut view = Some(hit.view);
    while let Some(v) = view {
        {
            let s = v.state();
            if let Some(control) = s.props.window_control {
                return Some((v.clone(), WindowPart::Control(control)));
            }
            if let Some(edge) = s.props.window_resize {
                return Some((v.clone(), WindowPart::Resize(edge)));
            }
            if s.kind == ViewKind::Input
                || has_press(s.events)
                || s.events.contains(EventKind::Touch)
            {
                return None;
            }
        }
        view = v.parent_view();
    }
    None
}

/// A left press on a window part: a `windowControl` view acts as the
/// window's button when the press ends over it (the press still reaches
/// the app, for its pressed look); a `windowResize` view resizes the
/// window by its edge while the button is down. True when the press is not
/// the app's.
fn window_part_press(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32) -> bool {
    match window_part(surface, x, y) {
        Some((view, WindowPart::Control(control))) => {
            *surface.input.window_control.borrow_mut() = Some((view, control));
            false
        }
        Some((_, WindowPart::Resize(edge))) => {
            let Some(window) = event_root(surface).ns().window() else {
                return false;
            };
            cancel_pointer(surface);
            let _ = event;
            resize_window(&window, edge);
            true
        }
        None => false,
    }
}

/// Resizes `window` by `edge` with the mouse until its button goes up,
/// within the window's content size limits.
fn resize_window(window: &NSWindow, edge: ResizeEdge) {
    let start = window.frame();
    let from = NSEvent::mouseLocation();
    let limits = |size: objc2_foundation::NSSize| {
        window
            .frameRectForContentRect(objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(0.0, 0.0),
                size,
            ))
            .size
    };
    let min = limits(window.contentMinSize());
    let max = window.contentMaxSize();
    let max = if max.width >= f64::from(f32::MAX) || max.height >= f64::from(f32::MAX) {
        objc2_foundation::NSSize::new(f64::MAX, f64::MAX)
    } else {
        limits(max)
    };
    // SAFETY: AppKit's immutable mouse-tracking run-loop mode.
    let mode = unsafe { NSEventTrackingRunLoopMode };
    while let Some(next) = window.nextEventMatchingMask_untilDate_inMode_dequeue(
        NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
        Some(&NSDate::distantFuture()),
        mode,
        true,
    ) {
        let at = NSEvent::mouseLocation();
        let frame = resized_frame(start, edge, at.x - from.x, at.y - from.y, min, max);
        if frame != window.frame() {
            window.setFrame_display(frame, true);
        }
        if next.r#type() == NSEventType::LeftMouseUp {
            break;
        }
    }
}

/// `start` (Cocoa screen coordinates, `y` up) resized by `edge` moved by
/// `(dx, dy)`, its size kept within `min` and `max`: the opposite edges stay.
pub(crate) fn resized_frame(
    start: objc2_foundation::NSRect,
    edge: ResizeEdge,
    dx: f64,
    dy: f64,
    min: objc2_foundation::NSSize,
    max: objc2_foundation::NSSize,
) -> objc2_foundation::NSRect {
    let (left, right, top, bottom) = match edge {
        ResizeEdge::Left => (true, false, false, false),
        ResizeEdge::Right => (false, true, false, false),
        ResizeEdge::Top => (false, false, true, false),
        ResizeEdge::Bottom => (false, false, false, true),
        ResizeEdge::TopLeft => (true, false, true, false),
        ResizeEdge::TopRight => (false, true, true, false),
        ResizeEdge::BottomLeft => (true, false, false, true),
        ResizeEdge::BottomRight => (false, true, false, true),
    };
    let clamp = |v: f64, lo: f64, hi: f64| v.max(lo).min(hi.max(lo));
    let mut x = start.origin.x;
    let mut y = start.origin.y;
    let mut width = start.size.width;
    let mut height = start.size.height;
    if right {
        width = clamp(start.size.width + dx, min.width, max.width);
    } else if left {
        width = clamp(start.size.width - dx, min.width, max.width);
        x = start.origin.x + start.size.width - width;
    }
    // `y` goes up: the top edge is the frame's maximum.
    if top {
        height = clamp(start.size.height + dy, min.height, max.height);
    } else if bottom {
        height = clamp(start.size.height - dy, min.height, max.height);
        y = start.origin.y + start.size.height - height;
    }
    objc2_foundation::NSRect::new(
        objc2_foundation::NSPoint::new(x, y),
        objc2_foundation::NSSize::new(width, height),
    )
}

/// The cursor over a `windowResize` view.
fn resize_cursor(edge: ResizeEdge) -> Cursor {
    match edge {
        ResizeEdge::Left | ResizeEdge::Right => Cursor::ColResize,
        ResizeEdge::Top | ResizeEdge::Bottom => Cursor::RowResize,
        ResizeEdge::TopLeft | ResizeEdge::BottomRight => Cursor::NwseResize,
        ResizeEdge::TopRight | ResizeEdge::BottomLeft => Cursor::NeswResize,
    }
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
    surface.input.hosted_left_down.set(false);
    if let Some(p) = take(surface) {
        finish(surface, p, true);
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
    // Double-click and Shift-click can select without a move event. End
    // selection before deciding whether this release deserves a tap pulse.
    let selected = matches!(&p.mode, Mode::Select(view) if selection_up(surface, view));
    finish_pressed(surface, &mut p, cancelled || selected);
    let mode = std::mem::replace(&mut p.mode, Mode::Free);
    match mode {
        Mode::Pan(view) => {
            pan_move(surface, &view, p.x - p.start.0, p.y - p.start.1);
            pan_end(surface, &view, &p, true);
        }
        Mode::Thumb(view, _) => crate::scroll::thumb_end(surface, &view),
        Mode::Idle | Mode::Free | Mode::Select(_) => {
            if selected {
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
    if crate::selectable_view::is_area(view) {
        crate::selectable_view::up(surface)
    } else {
        crate::text::selection_up(view)
    }
}

/// A pen's state at the latest mouse event: pressure (0 to 1), tilt
/// in degrees, its eraser end and barrel button, `None` for a mouse.
#[derive(Clone, Copy)]
struct Pen {
    pressure: f32,
    tilt: (f32, f32),
    eraser: bool,
    barrel: bool,
}

thread_local! {
    static PEN: std::cell::Cell<Option<Pen>> = const { std::cell::Cell::new(None) };
    /// The pen in proximity of the tablet is its eraser end (only a
    /// proximity event tells).
    static ERASER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Keeps which end of the pen proximity `event` (a tablet-proximity event,
/// or a mouse event of that subtype) brought near the tablet.
pub(crate) fn pen_proximity(event: &NSEvent) {
    ERASER.set(
        event.isEnteringProximity()
            && event.pointingDeviceType() == objc2_app_kit::NSPointingDeviceType::Eraser,
    );
}

/// Keeps the pen state of mouse `event` of type `ty`: a tablet sends mouse
/// events with the tablet-point subtype, carrying pressure and tilt.
fn pen_sample(event: &NSEvent, ty: NSEventType) {
    let mouse = matches!(
        ty,
        NSEventType::LeftMouseDown
            | NSEventType::LeftMouseUp
            | NSEventType::LeftMouseDragged
            | NSEventType::RightMouseDown
            | NSEventType::RightMouseUp
            | NSEventType::RightMouseDragged
            | NSEventType::OtherMouseDown
            | NSEventType::OtherMouseUp
            | NSEventType::OtherMouseDragged
            | NSEventType::MouseMoved
    );
    if ty == NSEventType::TabletProximity
        || (mouse && event.subtype() == objc2_app_kit::NSEventSubtype::TabletProximity)
    {
        pen_proximity(event);
    }
    if !mouse && ty != NSEventType::TabletPoint {
        return;
    }
    let pen = (ty == NSEventType::TabletPoint
        || event.subtype() == objc2_app_kit::NSEventSubtype::TabletPoint)
        .then(|| {
            let tilt = event.tilt();
            Pen {
                pressure: event.pressure().clamp(0.0, 1.0),
                // AppKit's tilt runs -1 to 1, positive y toward the bottom.
                tilt: (tilt.x as f32 * 90.0, tilt.y as f32 * 90.0),
                eraser: ERASER.get(),
                barrel: event.buttonMask().intersects(
                    objc2_app_kit::NSEventButtonMask::PenLowerSide
                        | objc2_app_kit::NSEventButtonMask::PenUpperSide,
                ),
            }
        });
    PEN.set(pen);
}

/// `event` with the pen's state, when a pen sent the latest mouse event.
fn with_pen(event: MouseEvent) -> MouseEvent {
    match PEN.get() {
        Some(pen) => event.with_pointer(
            nsh_core::PointerType::Pen,
            pen.pressure,
            pen.tilt.0,
            pen.tilt.1,
        ),
        None => event,
    }
}

/// Sends the pointer's touch, which `phase` is about, and the view whose
/// pan activation fired with it.
fn report(surface: &Surface, phase: TouchPhase, p: &Pointer, activated: Option<NodeId>) {
    let (lx, ly) = local(surface, &p.target, p.x, p.y);
    let pen = PEN.get();
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
        pointer_type: if pen.is_some() {
            nsh_core::PointerType::Pen
        } else {
            nsh_core::PointerType::Mouse
        },
        pressure: pen.map_or_else(
            || TouchPoint::default_pressure(phase, true),
            |pen| {
                if matches!(phase, TouchPhase::End | TouchPhase::Cancel) {
                    0.0
                } else {
                    pen.pressure
                }
            },
        ),
        tilt_x: pen.map_or(0.0, |pen| pen.tilt.0),
        tilt_y: pen.map_or(0.0, |pen| pen.tilt.1),
        coalesced: Vec::new(),
        eraser: pen.is_some_and(|pen| pen.eraser),
        barrel: pen.is_some_and(|pen| pen.barrel),
    };
    let event = TouchEvent {
        phase,
        timestamp: p.time,
        points: vec![point],
        modifiers: p.modifiers,
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

/// A recognized trackpad tap delivers down and up in the same RunLoop turn.
/// Clear the view's local `PRESSED` bit immediately while asking the core to
/// hold `:active` feedback briefly on its own clock. Press and touch
/// callbacks still run at release, with no retained views on the main thread.
fn finish_pressed(surface: &Rc<Surface>, p: &mut Pointer, cancelled: bool) {
    let delta_ms = p.time - p.down_time;
    let elapsed = if delta_ms.is_finite() && delta_ms > 0.0 {
        Duration::from_secs_f64(delta_ms / 1000.0)
    } else {
        Duration::ZERO
    };
    let delay = nsh_core::input::tap_feedback_delay(
        elapsed,
        cancelled || !matches!(p.mode, Mode::Idle | Mode::Select(_)),
        surface.environment.get().reduce_motion || surface.testing(),
    );
    for v in p.pressed.drain(..) {
        let hold = delay.filter(|_| released_inside(surface, &v, p.x, p.y));
        let (id, next) = {
            let mut s = v.state_mut();
            let Some(next) = input::next_states(s.tracked, s.states, PRESSED, false) else {
                continue;
            };
            s.states = next;
            (s.id, next)
        };
        match hold {
            Some(hold) => surface.control(|c| c.release_states_after(id, next, hold)),
            None => surface.control(|c| c.set_states(id, next)),
        }
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
    nsh_core::input::pick_press(
        views.iter().map(|v| {
            let s = v.state();
            (
                v.clone(),
                s.id,
                s.events,
                s.props.long_press_delay,
                s.props.accessibility.state.disabled,
            )
        }),
        generation,
    )
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
    surface.event(press.target(kind), kind, EventPayload::Press(event));
}

fn cancel_press(surface: &Rc<Surface>, p: &mut Pointer) {
    if let Some(mut press) = p.press.take() {
        press_out(surface, &mut press, false, (p.x, p.y));
    }
}

/// The modifier keys of AppKit's `flags`.
pub(crate) fn modifiers(flags: NSEventModifierFlags) -> nsh_core::keymap::Modifiers {
    nsh_core::keymap::Modifiers {
        ctrl: flags.contains(NSEventModifierFlags::Control),
        alt: flags.contains(NSEventModifierFlags::Option),
        shift: flags.contains(NSEventModifierFlags::Shift),
        cmd: flags.contains(NSEventModifierFlags::Command),
        alt_graph: false,
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

fn pan_payload(surface: &Surface, id: NodeId, p: &Pointer, t: (f32, f32)) -> EventPayload {
    let (value_x, value_y) = surface.anim.borrow().pan_values(id);
    let v = p.velocity.velocity();
    EventPayload::Pan {
        origin: point(Points(p.start.0), Points(p.start.1)),
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
        let payload = pan_payload(surface, id, p, (0.0, 0.0));
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
        let payload = pan_payload(surface, id, p, t);
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
/// rotates, as a transform of that one kind; a pinch also zooms the
/// innermost zoomable scroll view.
fn transform_at(surface: &Surface, x: f32, y: f32, rotation: bool) -> Option<Transform> {
    let hit = pick(&event_root(surface), x, y)?;
    chain(&hit.view).into_iter().find_map(|v| {
        let zoom = !rotation && crate::scroll::pinches(&v);
        let (id, events) = {
            let s = v.state();
            (s.id, s.events)
        };
        let (pinch, rotates) = transforms(&gesture_values(surface, &v, id), events);
        let takes = zoom || if rotation { rotates } else { pinch };
        takes.then(|| Transform {
            view: v,
            pinch: !rotation,
            rotation,
            zoom,
            scale: 1.0,
            degrees: 0.0,
            at: (x, y),
        })
    })
}

fn transform_begin(surface: &Rc<Surface>, t: &Transform) {
    if t.zoom {
        return crate::scroll::pinch_begin(surface, &t.view);
    }
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

/// `t` moved; a zoom past the limits rubber-bands when `rubber` (fingers).
fn transform_move(surface: &Rc<Surface>, t: &Transform, rubber: bool) {
    if t.zoom {
        let at = local(surface, &t.view, t.at.0, t.at.1);
        return crate::scroll::pinch(surface, &t.view, t.scale, at, rubber);
    }
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

fn transform_end(surface: &Rc<Surface>, t: &Transform) {
    if t.zoom {
        let at = local(surface, &t.view, t.at.0, t.at.1);
        return crate::scroll::pinch_end(surface, &t.view, at);
    }
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
            t.at = (x, y);
            t.clone()
        };
        transform_move(surface, &t, true);
    }
    if phase.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled)
        && let Some(t) = slot.borrow_mut().take()
    {
        transform_end(surface, &t);
    }
}

/// `magnifyWithEvent:`: a trackpad pinch.
fn magnify(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32) {
    if pinch_event(surface, event, x, y) {
        return;
    }
    let m = event.magnification() as f32;
    trackpad_transform(surface, event, x, y, false, |t| {
        t.scale = (t.scale * (1.0 + m)).max(0.01);
    });
}

/// `onPinch` for a trackpad pinch step (`magnifyWithEvent:`) at `(x, y)`
/// (root coordinates): the nearest view around the one under it that
/// listens hears the pinch from its start to its end ([`WheelLatch`]).
/// Returns whether that view takes it ([`input::wheel_listener`]: no view
/// that pinches natively is nearer, nor is it one), so nothing pinches
/// natively.
fn pinch_event(surface: &Rc<Surface>, event: &NSEvent, x: f32, y: f32) -> bool {
    let phase = event.phase();
    let (step, pinch_phase) = if phase.contains(NSEventPhase::Began) {
        (WheelStep::Begin, PinchPhase::Start)
    } else if phase.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled) {
        (WheelStep::End, PinchPhase::End)
    } else if phase.contains(NSEventPhase::Changed) {
        (WheelStep::Continue, PinchPhase::Move)
    } else {
        return false;
    };
    let routed = surface.input.pinch_listener.borrow_mut().route(
        step,
        true,
        false,
        |view| view.ns().window().is_some() && view.state().events.contains(EventKind::Pinch),
        || {
            let hit = pick(&event_root(surface), x, y)?;
            input::wheel_listener(
                chain(&hit.view),
                |v| v.state().events.contains(EventKind::Pinch),
                |v| {
                    let (id, events) = {
                        let s = v.state();
                        (s.id, s.events)
                    };
                    transforms(&gesture_values(surface, v, id), events).0
                        || crate::scroll::pinches(v)
                },
            )
        },
    );
    let Some((view, takes)) = routed else {
        return false;
    };
    let (location_x, location_y) = local(surface, &view, x, y);
    let pinch = PinchEvent::new(
        point(Points(location_x), Points(location_y)),
        point(Points(x), Points(y)),
        nsh_core::geometry::Percentage(event.magnification() as f32),
        pinch_phase,
        modifiers(event.modifierFlags()),
    );
    let id = view.state().id;
    surface.event(id, EventKind::Pinch, EventPayload::Pinch(pinch));
    takes
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
    t.at = (x, y);
    transform_move(surface, &t, false);
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

// --- Hover and the mouse's events -------------------------------------------------

/// What the mouse's events say besides where it is.
#[derive(Clone, Copy)]
struct Mouse {
    modifiers: nsh_core::keymap::Modifiers,
    pressed: Option<MouseButton>,
}

impl Mouse {
    /// As `event` has it: a drag names its button by its type (and, for
    /// the other buttons, `buttonNumber`); a move has none down; enters and
    /// exits ask what is held now.
    fn of(event: &NSEvent) -> Self {
        let pressed = match event.r#type() {
            NSEventType::LeftMouseDragged => Some(MouseButton::Left),
            NSEventType::RightMouseDragged => Some(MouseButton::Right),
            NSEventType::OtherMouseDragged => other_button(event.buttonNumber()),
            NSEventType::MouseMoved => None,
            _ => held_button(),
        };
        Self {
            modifiers: modifiers(event.modifierFlags()),
            pressed,
        }
    }

    /// As it is now, with no event to ask (content moved under it).
    fn now() -> Self {
        Self {
            modifiers: modifiers(NSEvent::modifierFlags_class()),
            pressed: held_button(),
        }
    }
}

/// The button of AppKit's other-button `buttonNumber`: the ones the DOM and
/// GPUI name, none for the rest.
fn other_button(number: isize) -> Option<MouseButton> {
    match number {
        MIDDLE_BUTTON => Some(MouseButton::Middle),
        BACK_BUTTON => Some(MouseButton::Back),
        FORWARD_BUTTON => Some(MouseButton::Forward),
        _ => None,
    }
}

/// The button held down now (the first of them, bit `n` of
/// `pressedMouseButtons` being `buttonNumber` `n`).
fn held_button() -> Option<MouseButton> {
    let held = NSEvent::pressedMouseButtons();
    if held & 1 != 0 {
        return Some(MouseButton::Left);
    }
    if held & 2 != 0 {
        return Some(MouseButton::Right);
    }
    (MIDDLE_BUTTON..=FORWARD_BUTTON)
        .find(|&n| held & (1 << n) != 0)
        .and_then(other_button)
}

/// The mouse moved to `(x, y)`: updates `HOVERED` and raises
/// `onMouseEnter` / `onMouseLeave` along the views under it.
fn hover(surface: &Surface, root: &NshView, x: f32, y: f32, mouse: Mouse) {
    let input = &surface.input;
    if input.hover_tracked.borrow().is_empty() && input.hovered.borrow().is_empty() {
        return;
    }
    let views = match pick(root, x, y) {
        Some(hit) => chain(&hit.view).into_iter().filter(hoverable).collect(),
        None => Vec::new(),
    };
    set_hovered(surface, views, x, y, mouse);
}

/// The scroll views under the mouse at `(x, y)` show their indicators.
fn reveal_indicators(surface: &Rc<Surface>, x: f32, y: f32) {
    if let Some(hit) = pick(&event_root(surface), x, y) {
        for v in chain(&hit.view)
            .iter()
            .filter(|v| v.kind() == ViewKind::Scroll)
        {
            crate::scroll::hovered(surface, v);
        }
    }
}

/// The views under the mouse at `(x, y)` (root coordinates) are `views`
/// (innermost first): those it left hear so from the inside out, then
/// those it came over from the outside in, as with the DOM's `mouseleave`
/// / `mouseenter`.
fn set_hovered(surface: &Surface, views: Vec<NshView>, x: f32, y: f32, mouse: Mouse) {
    let old = std::mem::replace(&mut *surface.input.hovered.borrow_mut(), views.clone());
    let (left, entered) = input::hover_changes(&old, &views);
    for v in left {
        set_state(surface, v, HOVERED, false);
        mouse_event(surface, v, EventKind::MouseLeave, x, y, mouse);
    }
    for v in entered {
        set_state(surface, v, HOVERED, true);
        mouse_event(surface, v, EventKind::MouseEnter, x, y, mouse);
    }
}

/// `onMouseMove` of the hovered views that listen (the views under the
/// mouse and the views they are inside, inside out), with the mouse at
/// `(x, y)` (root coordinates) in each. Only for the mouse's own moves and
/// modifier changes: content moving under it (a repick) moves nothing.
fn mouse_moved(surface: &Surface, x: f32, y: f32, mouse: Mouse) {
    // Collected so no borrow is held while the events go out; empty (no
    // allocation) when none listens, as on most moves.
    let listeners: Vec<NshView> = surface
        .input
        .hovered
        .borrow()
        .iter()
        .filter(|v| v.state().events.contains(EventKind::MouseMove))
        .cloned()
        .collect();
    if listeners.is_empty() {
        return;
    }
    watch_flags(surface);
    for v in &listeners {
        mouse_event(surface, v, EventKind::MouseMove, x, y, mouse);
    }
}

/// `onMouseUp` of the views under the mouse at `(x, y)` (root coordinates)
/// and the views they are inside, inside out, each with the mouse in it and
/// the button that was released.
fn mouse_up(surface: &Surface, x: f32, y: f32, mouse: Mouse, button: MouseButton) {
    let Some(hit) = pick(&event_root(surface), x, y) else {
        return;
    };
    for view in chain(&hit.view) {
        let id = {
            let state = view.state();
            if !state.events.contains(EventKind::MouseUp) {
                continue;
            }
            state.id
        };
        let (location_x, location_y) = local(surface, &view, x, y);
        let event = nsh_core::MouseEvent::released(
            point(Points(location_x), Points(location_y)),
            point(Points(x), Points(y)),
            mouse.modifiers,
            button,
        );
        surface.event(id, EventKind::MouseUp, EventPayload::Mouse(with_pen(event)));
    }
}

/// Installs the surface's hosted-view pointer monitor. Hosted AppKit views
/// (`NSTextField`, `NSTextView`, `WKWebView`) receive mouse events directly
/// via `ViewObj::root_hit`, and text editors consume `LeftMouseDragged` and
/// `LeftMouseUp` inside a modal `NSEventTrackingRunLoopMode` loop; observing
/// them here gives hosted subtrees `:active` state, pointer modality, momentum
/// stop, and `TouchPhase::Start` (`PressOutside` for anchored popovers).
pub(crate) fn install(surface: &Rc<Surface>) {
    let monitor = &surface.input.hosted.0;
    if monitor.borrow().is_some() {
        return;
    }
    let key = surface.key();
    let block = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event.
        let raw = unsafe { event.as_ref() };
        if let Some(surface) = Surface::with_key(key) {
            hosted_mouse(&surface, raw);
        }
        event.as_ptr()
    });
    let mask =
        NSEventMask::LeftMouseDown | NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp;
    // SAFETY: the block returns the event unmodified; the monitor is removed
    // when the surface's input drops.
    *monitor.borrow_mut() =
        unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
}

/// True when `event` was already observed by [`hosted_mouse`],
/// [`hosted_press_began`] or [`report_hosted`], preventing duplicate
/// dispatch if a hosted view forwards the event up the responder chain.
pub(crate) fn saw_hosted(surface: &Surface, event: &NSEvent) -> bool {
    surface.input.hosted_last.get() == Some(MouseMark::of(event))
}

/// Reports a mouse event a hosted input's pad observed to the surface,
/// unless the event monitor or the editor's press tracking already did:
/// one press is one press for the views around it (an overlay's
/// `onPressOutside` counts it). A press it reports is tracked as theirs
/// are, so whichever path sees the release ends it once.
pub(crate) fn report_hosted(surface: &Rc<Surface>, root: Option<NshView>, event: &NSEvent) {
    if saw_hosted(surface, event) {
        return;
    }
    let input = &surface.input;
    match event.r#type() {
        NSEventType::LeftMouseDown => input.hosted_left_down.set(
            !event
                .modifierFlags()
                .contains(NSEventModifierFlags::Control),
        ),
        NSEventType::LeftMouseDragged if input.hosted_left_down.get() => {}
        NSEventType::LeftMouseUp if input.hosted_left_down.replace(false) => {}
        _ => return,
    }
    input.hosted_last.set(Some(MouseMark::of(event)));
    enter(surface, root);
    self::event(surface, event);
}

fn window_root_for(surface: &Surface, window: &NSWindow) -> Option<Option<NshView>> {
    if surface.root.ns().window().as_deref() == Some(window) {
        return Some(None);
    }
    crate::window::roots(surface)
        .into_iter()
        .find(|r| r.ns().window().as_deref() == Some(window))
        .map(Some)
}

fn hosted_mouse(surface: &Rc<Surface>, raw: &NSEvent) {
    #[cfg(feature = "dev")]
    let placed = crate::synth::placed(raw);
    #[cfg(feature = "dev")]
    let e = placed.as_deref().unwrap_or(raw);
    #[cfg(not(feature = "dev"))]
    let e = raw;

    let Some(window) = e.window(surface.mtm) else {
        return;
    };
    let Some(window_root) = window_root_for(surface, &window) else {
        return;
    };
    #[cfg(feature = "dev")]
    if surface.testing() && crate::view::scripted_type().is_none() && !crate::synth::from_agent(e) {
        return;
    }
    match e.r#type() {
        NSEventType::LeftMouseDown => {
            if crate::window::is_blocked(surface, window_root.as_ref()) {
                return;
            }
            let root = window_root.clone().unwrap_or_else(|| surface.root.clone());
            let p = root.ns().convertPoint_fromView(e.locationInWindow(), None);
            if native_at(&root, p.x as f32, p.y as f32).is_none() {
                surface.input.hosted_left_down.set(false);
                return;
            }
            surface.input.hosted_last.set(Some(MouseMark::of(raw)));
            let tracks_left = !e.modifierFlags().contains(NSEventModifierFlags::Control);
            surface.input.hosted_left_down.set(tracks_left);
            enter(surface, window_root);
            surface.measure(false, || event(surface, e));
        }
        NSEventType::LeftMouseDragged => {
            if surface.input.hosted_left_down.get() {
                surface.input.hosted_last.set(Some(MouseMark::of(raw)));
                enter(surface, window_root);
                surface.measure(true, || {
                    event(surface, e);
                    crate::surface::quiet(|| surface.revisit());
                });
            }
        }
        NSEventType::LeftMouseUp if surface.input.hosted_left_down.replace(false) => {
            surface.input.hosted_last.set(Some(MouseMark::of(raw)));
            enter(surface, window_root);
            surface.measure(false, || event(surface, e));
        }
        _ => {}
    }
}

/// Fallback when a synthetic test invokes `NSWindow::sendEvent` directly on a
/// hosted input without going through AppKit's event queue (`_DPSNextEvent`).
pub(crate) fn hosted_press_began(surface: &Rc<Surface>, view: &NshView, down: &NSEvent) {
    if down.r#type() != NSEventType::LeftMouseDown
        || surface.input.hosted_left_down.get()
        || saw_hosted(surface, down)
    {
        return;
    }
    #[cfg(feature = "dev")]
    if surface.testing()
        && crate::view::scripted_type().is_none()
        && !crate::synth::from_agent(down)
    {
        return;
    }
    let Some(window) = view.ns().window() else {
        return;
    };
    let Some(window_root) = window_root_for(surface, &window) else {
        return;
    };
    if crate::window::is_blocked(surface, window_root.as_ref()) {
        return;
    }
    surface.input.hosted_last.set(Some(MouseMark::of(down)));
    let tracks_left = !down.modifierFlags().contains(NSEventModifierFlags::Control);
    surface.input.hosted_left_down.set(tracks_left);
    enter(surface, window_root);
    surface.measure(false, || event(surface, down));
}

/// Completes a hosted input press if its release bypassed [`hosted_mouse`].
pub(crate) fn hosted_press_ended(
    surface: &Rc<Surface>,
    view: &NshView,
    end_event: Option<&NSEvent>,
) {
    if !surface.input.hosted_left_down.replace(false) {
        return;
    }
    if let Some(up) = end_event.filter(|e| e.r#type() == NSEventType::LeftMouseUp)
        && let Some(window) = view.ns().window()
        && let Some(window_root) = window_root_for(surface, &window)
    {
        surface.input.hosted_last.set(Some(MouseMark::of(up)));
        enter(surface, window_root);
        surface.measure(false, || event(surface, up));
    } else {
        cancel_pointer(surface);
    }
}

/// Installs the surface's [`EventMonitor`] for `flagsChanged`, unless present.
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
/// that listen hear `onMouseMove` again where it is, with the modifiers as
/// they are now (an editor underlines a definition while Command is held),
/// as they would on the next move.
fn modifiers_changed(surface: &Surface, event: &NSEvent) {
    let input = &surface.input;
    if input.pointer.borrow().is_some() || held_button().is_some() {
        return;
    }
    if let Some(position) = input.last.get()
        && let Some(window) = crate::window::window_of(surface, position.root)
        && event.window(surface.mtm).as_deref() == Some(&*window)
    {
        let mouse = Mouse {
            modifiers: modifiers(event.modifierFlags()),
            pressed: None,
        };
        mouse_moved(surface, position.x, position.y, mouse);
    }
}

/// `onMouseEnter`, `onMouseMove` or `onMouseLeave` of `view`, if it
/// listens, with the mouse at `(x, y)` (root coordinates) in it.
fn mouse_event(surface: &Surface, view: &NshView, kind: EventKind, x: f32, y: f32, mouse: Mouse) {
    let (id, listens) = {
        let s = view.state();
        (s.id, s.events.contains(kind))
    };
    if !listens {
        return;
    }
    let (local_x, local_y) = local(surface, view, x, y);
    let event = MouseEvent::new(
        point(Points(local_x), Points(local_y)),
        point(Points(x), Points(y)),
        mouse.modifiers,
        mouse.pressed,
    );
    surface.event(id, kind, EventPayload::Mouse(with_pen(event)));
}

// --- Wheel and trackpad scrolling ---------------------------------------------------

/// The innermost scroll view at `(x, y)` that can move by `(dx, dy)`
/// (nested views fall through to outer ones at their edges). Scroll views
/// along the wheel's axis take it: a vertical wheel over a carousel
/// scrolls the page around it, as in browsers; horizontal views take
/// vertical wheels only where nothing around scrolls vertically.
fn scroll_target(surface: &Surface, x: f32, y: f32, dx: f32, dy: f32) -> Option<NshView> {
    let hit = pick(&event_root(surface), x, y)?;
    input::scroll_target(
        chain(&hit.view),
        Points(dx),
        Points(dy),
        |v| v.state().scroll.as_ref().map(|s| s.horizontal),
        |v| v.kind() == ViewKind::Scroll && crate::scroll::can_scroll(v, dx, dy),
        crate::scroll::listens_to_scroll_intent,
    )
}

/// The scroll view a trackpad gesture by `(dx, dy)` at `(x, y)` moves:
/// the one [`scroll_target`] picks, else, at the edges, the view
/// [`crate::scroll::bounce_target`] picks, which stretches as on macOS.
fn gesture_target(surface: &Surface, x: f32, y: f32, dx: f32, dy: f32) -> Option<NshView> {
    scroll_target(surface, x, y, dx, dy).or_else(|| {
        let hit = pick(&event_root(surface), x, y)?;
        let views = chain(&hit.view);
        crate::scroll::bounce_target(&views, dx, dy)
    })
}

/// A wheel by `(dx, dy)` (`precise`: points, else lines) at `(x, y)`
/// (root coordinates), from `event` at `time` (ms): the nearest view around
/// the one under it that listens to `onWheel` hears it
/// ([`input::wheel_listener`]), and one scroll stays where it went
/// ([`WheelLatch`]): a trackpad gesture and its momentum on the view its
/// first move found, notches on theirs while they keep coming, and a
/// scroll going on in a scroll view is only observed. Returns whether that
/// view takes the wheel, so nothing scrolls natively; a hosted AppKit view
/// under the pointer (a web page, a text view) keeps it.
#[allow(clippy::too_many_arguments)]
fn wheel_event(
    surface: &Rc<Surface>,
    event: &NSEvent,
    x: f32,
    y: f32,
    precise: bool,
    dx: f32,
    dy: f32,
    time: f64,
) -> bool {
    let input = &surface.input;
    let phase = event.phase();
    let momentum = event.momentumPhase();
    let step = if !momentum.is_empty() {
        if momentum.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled) {
            WheelStep::End
        } else {
            WheelStep::Continue
        }
    } else if phase.is_empty() {
        WheelStep::Discrete {
            horizontal: dx.abs() > dy.abs(),
            precise,
            time,
        }
    } else if phase.contains(NSEventPhase::MayBegin) {
        // Fingers resting on the trackpad: a new touch, for which the
        // scroll views stop their glides.
        input.wheel_listener.borrow_mut().clear();
        return false;
    } else if phase.contains(NSEventPhase::Began) {
        WheelStep::Begin
    } else {
        WheelStep::Continue
    };
    let moved = dx != 0.0 || dy != 0.0;
    // A momentum view counts while its glide can still be going on: one
    // left behind by fingers that stopped before lifting must not keep
    // later mouse notches from reaching a listener.
    let scrolling = input.wheel.borrow().is_some()
        || (input.momentum.borrow().is_some() && time - input.momentum_last.get() < TOUCHPAD_IDLE)
        || input
            .latch
            .borrow()
            .as_ref()
            .is_some_and(|(view, h, last)| {
                latch_holds(*h, *last, dx.abs() > dy.abs(), time) && view.ns().window().is_some()
            });
    // Whether a listener had this scroll before (a new gesture has none
    // yet, whatever the last one left).
    let took = step != WheelStep::Begin && input.wheel_listener.borrow().taker().is_some();
    let routed = input.wheel_listener.borrow_mut().route(
        step,
        moved,
        scrolling,
        |view| view.ns().window().is_some() && view.state().events.contains(EventKind::Wheel),
        || {
            let hit = pick(&event_root(surface), x, y)?;
            let (view, takes) = input::wheel_listener(
                chain(&hit.view),
                |v| v.state().events.contains(EventKind::Wheel),
                |v| v.kind() == ViewKind::Scroll,
            )?;
            let along = input::wheel_along(
                view.state().props.pan_activation,
                dx.abs() > dy.abs(),
                event
                    .modifierFlags()
                    .contains(NSEventModifierFlags::Control),
            );
            Some((view, takes && along && hit.native.is_none()))
        },
    );
    let Some((view, takes)) = routed else {
        return false;
    };
    if takes && !took && !phase.is_empty() {
        // The scroll views held this gesture for the resting fingers, or
        // began it before it moved: they let go.
        if let Some(w) = input.wheel.borrow_mut().take()
            && let Some(held) = w.view
        {
            crate::scroll::wheel_end(surface, &held, 0.0, 0.0);
        }
    }
    if moved {
        let delta = if precise {
            nsh_core::WheelDelta::Points(point(Points(dx), Points(dy)))
        } else {
            nsh_core::WheelDelta::Lines(point(dx, dy))
        };
        let (location_x, location_y) = local(surface, &view, x, y);
        let wheel = nsh_core::WheelEvent::new(
            point(Points(location_x), Points(location_y)),
            point(Points(x), Points(y)),
            delta,
            modifiers(event.modifierFlags()),
        );
        let id = view.state().id;
        surface.event(id, EventKind::Wheel, EventPayload::Wheel(wheel));
    }
    takes
}

/// Whether `event` belongs to a scroll this surface does not take, so its
/// view passes it up the responder chain: the app is embedded in another
/// view's content ([`embedded`]) and no scroll view of it that can move
/// ([`crate::scroll::movable`]: enabled, with content overflowing its
/// viewport) is under the pointer when the scroll begins. The host then
/// scrolls, as a page scrolls under an iframe that cannot; an embedded
/// app whose scroll view is switched off or whose content fits takes no
/// scroll either. Decided when a gesture begins (or per mouse wheel notch
/// with nothing latched) and kept for the gesture's changes, end and
/// momentum.
pub(crate) fn forwards_scroll(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    let input = &surface.input;
    let phase = event.phase();
    let momentum = event.momentumPhase();
    let starts = if momentum.is_empty() {
        if phase.is_empty() {
            input.latch.borrow().is_none()
        } else {
            phase.intersects(NSEventPhase::MayBegin | NSEventPhase::Began)
        }
    } else {
        false
    };
    if starts {
        // The root of the window the scroll came to: the app's own, or
        // one of the windows it opened.
        let root = event_root(surface);
        let p = root
            .ns()
            .convertPoint_fromView(event.locationInWindow(), None);
        let forward = embedded(root.ns())
            && !pick(&root, p.x as f32, p.y as f32).is_some_and(|hit| {
                chain(&hit.view)
                    .into_iter()
                    .any(|v| v.kind() == ViewKind::Scroll && crate::scroll::movable(&v))
            });
        if forward {
            // Fingers on the trackpad stop what moves, as in
            // `gesture_event`: the momentum of an earlier flick here would
            // otherwise wait for events that now go to the host.
            end_momentum(surface);
        }
        input.forward_scroll.set(forward);
    }
    input.forward_scroll.get()
}

/// Whether `root`'s app is in another view's content: its view
/// ([`crate::AppView::view`]) is not its window's content view, so a
/// view above it can take the scrolls it passes on. A window's own app
/// keeps them all (its views still bounce where their content fits).
fn embedded(root: &objc2_app_kit::NSView) -> bool {
    let Some(window) = root.window() else {
        return false;
    };
    crate::view::superview(root).is_some_and(|app| window.contentView().as_ref() != Some(&app))
}

/// Whether a scroll of `surface` is under way at `event`: a trackpad
/// gesture, its glide, or wheel steps latched to a view.
pub(crate) fn scrolling(surface: &Surface, event: &NSEvent) -> bool {
    let input = &surface.input;
    let time = event.timestamp() * 1000.0;
    let horizontal = event.scrollingDeltaX().abs() > event.scrollingDeltaY().abs();
    input.wheel.borrow().is_some()
        || (input.momentum.borrow().is_some() && time - input.momentum_last.get() < TOUCHPAD_IDLE)
        || input
            .latch
            .borrow()
            .as_ref()
            .is_some_and(|(view, h, last)| {
                latch_holds(*h, *last, horizontal, time) && view.ns().window().is_some()
            })
}

/// Hands `ns_event`, which reached a hosted AppKit view, into the surface's
/// input path as the root's `scrollWheel:` does (not by sending it to the
/// root, which can no-op when re-entered from a nested AppKit handler).
pub(crate) fn forward_scroll(surface: &Rc<Surface>, ns_event: &NSEvent) {
    surface.measure(true, || {
        event(surface, ns_event);
        crate::surface::quiet(|| surface.revisit());
    });
}

/// Begins a trackpad gesture on the surface at `ns_event` (a change of
/// it), for a gesture that began on a hosted view which then passed it on:
/// the surface sees a begin before the changes, as for its own gestures.
pub(crate) fn begin_gesture(surface: &Rc<Surface>, ns_event: &NSEvent) {
    let p = event_root(surface)
        .ns()
        .convertPoint_fromView(ns_event.locationInWindow(), None);
    let time = ns_event.timestamp() * 1000.0;
    gesture_event(
        surface,
        NSEventPhase::Began,
        p.x as f32,
        p.y as f32,
        0.0,
        0.0,
        time,
    );
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
    // A view listening to `onWheel` nearer than the scroll views under the
    // pointer takes the wheel, Control + wheel and momentum included (a
    // canvas zooming or panning); a gesture going on still ends.
    if wheel_event(surface, event, x, y, precise, dx, dy, time) {
        if phase.contains(NSEventPhase::Ended) || phase.contains(NSEventPhase::Cancelled) {
            gesture_event(surface, phase, x, y, 0.0, 0.0, time);
        }
        return;
    }
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
        wheel_step(surface, x, y, dx, dy, !precise, time);
        return;
    }
    gesture_event(surface, phase, x, y, dx, dy, time);
}

/// A mouse wheel step (`notched`) or a precise scroll outside a gesture of
/// `(dx, dy)` points: one scroll stays on its view while steps keep coming.
fn wheel_step(surface: &Rc<Surface>, x: f32, y: f32, dx: f32, dy: f32, notched: bool, time: f64) {
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
    crate::scroll::wheel(surface, &view, dx, dy, notched, time);
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
        let scroll = pick(&event_root(surface), x, y).and_then(|hit| {
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
            wheel_step(surface, x, y, dx, dy, false, time);
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
            crate::scroll::wheel(surface, &view, dx, dy, false, time);
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
        input.momentum_last.set(time);
    }
}

/// The system's momentum after a gesture: it goes to the gesture's view.
fn momentum_event(surface: &Rc<Surface>, phase: NSEventPhase, dx: f32, dy: f32, time: f64) {
    let input = &surface.input;
    let Some(view) = input.momentum.borrow().clone() else {
        return;
    };
    input.momentum_last.set(time);
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
    let Some(hit) = pick(&event_root(surface), x, y) else {
        return false;
    };
    if hit.native.is_some() {
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
    // Nothing decided: the strip of a hidden title bar drags the window,
    // as the system's bar would (#2274).
    in_hidden_title_bar(surface, y)
}

/// Whether `y` (root coordinates) is in the main window's hidden title bar.
fn in_hidden_title_bar(surface: &Surface, y: f32) -> bool {
    if surface.input.window_root.borrow().is_some() {
        return false;
    }
    let top = surface.environment.get().title_bar.top.0;
    top > 0.0 && y >= 0.0 && y < top
}

/// The hosted AppKit view (a text field, a web view) under `(x, y)` (root
/// coordinates) when nsh's own picking lands on one: the root's `hitTest:`
/// hands it the mouse, past app views that let the pointer through
/// (`pointerEvents: none` overlays), which AppKit's picking would stop at.
/// The view picking found, not one looked up again in the hit view's own
/// hosted views: a lifted input's pad is hosted by the view above the
/// transform, and its input's view hosts nothing.
pub(crate) fn native_at(root: &NshView, x: f32, y: f32) -> Option<Retained<objc2_app_kit::NSView>> {
    pick(root, x, y)?.native
}

/// The closest file-drop listener under the pointer, within its modal root.
pub(crate) fn file_drop_target(surface: &Surface, x: f32, y: f32) -> Option<NshView> {
    let mut view = pick(&event_root(surface), x, y)?.view;
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
    #[test]
    fn inline_context_menu_ignores_hover_only_nested_spans() {
        let link = |start, end, node, kind| {
            let mut events = nsh_core::EventMask::default();
            events.set(kind, true);
            nsh_core::TextLink {
                start,
                end,
                node,
                events,
                focus_stop: false,
            }
        };
        let outer = link(0, 10, 2, nsh_core::EventKind::ContextMenu);
        let hover = link(2, 8, 3, nsh_core::EventKind::MouseEnter);
        let inner = link(3, 7, 4, nsh_core::EventKind::ContextMenu);
        assert_eq!(
            super::context_link(&[outer, hover], 4).map(|l| l.node),
            Some(2)
        );
        assert_eq!(
            super::context_link(&[outer, hover, inner], 4).map(|l| l.node),
            Some(4)
        );
        assert!(super::context_link(&[outer, hover], 10).is_none());
    }

    use super::*;

    #[test]
    fn frames_resize_by_their_edge_within_their_limits() {
        use objc2_foundation::{NSPoint, NSRect};
        let start = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(400.0, 300.0));
        let min = NSSize::new(200.0, 150.0);
        let max = NSSize::new(f64::MAX, f64::MAX);
        // The right edge follows the mouse; the left one stays.
        assert_eq!(
            resized_frame(start, ResizeEdge::Right, 50.0, 0.0, min, max),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(450.0, 300.0))
        );
        // The top left corner: `y` goes up, so the bottom edge stays.
        assert_eq!(
            resized_frame(start, ResizeEdge::TopLeft, -20.0, 30.0, min, max),
            NSRect::new(NSPoint::new(80.0, 100.0), NSSize::new(420.0, 330.0))
        );
        // The bottom edge moving up stops at the minimum height, the top
        // edge where it was.
        assert_eq!(
            resized_frame(start, ResizeEdge::Bottom, 0.0, 400.0, min, max),
            NSRect::new(NSPoint::new(100.0, 250.0), NSSize::new(400.0, 150.0))
        );
    }

    #[test]
    fn typing_keys_follow_the_us_layout() {
        // a, space, b and a shifted 1: each its own key, Shift only for "!".
        let keys: Vec<_> = "a b!".chars().map(us_typing_key).collect();
        assert_eq!(
            keys,
            [
                Some((0, false)),
                Some((49, false)),
                Some((11, false)),
                Some((18, true))
            ]
        );
        assert_eq!(us_typing_key('N'), Some((45, true)));
        assert_eq!(us_typing_key('?'), Some((44, true)));
        assert_eq!(us_typing_key('\r'), Some((36, false)));
        assert_eq!(us_typing_key('é'), None);
        // Without Shift, a shifted character's key types its own.
        assert_eq!(us_key(18), Some('1'));
    }

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
        let pans = |values: GestureValues| {
            let mut events = nsh_core::EventMask::default();
            events.set(EventKind::PanEnd, true);
            Candidate::pan(&values, events, None).unwrap()
        };
        let horizontal = pans(GestureValues {
            pan_x: Some(1),
            ..GestureValues::default()
        });
        assert!(horizontal.accepts(Points(8.0), Points(2.0)));
        assert!(!horizontal.accepts(Points(2.0), Points(8.0)));
        let vertical = pans(GestureValues {
            pan_y: Some(1),
            ..GestureValues::default()
        });
        assert!(vertical.accepts(Points(1.0), Points(-7.0)));
        assert!(!vertical.accepts(Points(-7.0), Points(1.0)));
    }

    #[test]
    fn the_cursor_is_set_only_when_it_changes() {
        // A move over views of the same cursor sets nothing.
        assert_eq!(
            cursor_to_set(false, Some(Cursor::Pointer), Cursor::Pointer),
            None
        );
        // A move onto another cursor sets it.
        assert_eq!(
            cursor_to_set(false, Some(Cursor::Pointer), Cursor::Text),
            Some(Cursor::Text)
        );
        // After a hosted view's or another app's cursor, it is set again.
        assert_eq!(
            cursor_to_set(false, None, Cursor::Pointer),
            Some(Cursor::Pointer)
        );
        // The mouse coming in, a press's end and AppKit's cursor updates set
        // it always.
        assert_eq!(
            cursor_to_set(true, Some(Cursor::Pointer), Cursor::Pointer),
            Some(Cursor::Pointer)
        );
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

    #[cfg(feature = "dev")]
    #[test]
    fn projects_points_where_hit_testing_finds_them() {
        // A quarter turn, nonuniform scale and translation, with perspective.
        let mut m = nsh_core::Matrix::IDENTITY;
        m.0[0] = 0.0;
        m.0[1] = 2.0;
        m.0[4] = -3.0;
        m.0[5] = 0.0;
        m.0[12] = 10.0;
        m.0[13] = 20.0;
        m.0[3] = 0.01;
        m.0[7] = 0.02;
        // (10, 20) maps to (-50, 40), divided by w = 1.5.
        let shown = project(&m, (10.0, 20.0)).unwrap();
        assert!((shown.0 + 50.0 / 1.5).abs() < 0.0001);
        assert!((shown.1 - 40.0 / 1.5).abs() < 0.0001);
        let local = unproject(&m, shown).unwrap();
        assert!((local.0 - 10.0).abs() < 0.0001);
        assert!((local.1 - 20.0).abs() < 0.0001);
    }

    #[cfg(feature = "dev")]
    #[test]
    fn projection_at_infinity_has_no_test_target() {
        let mut m = nsh_core::Matrix::IDENTITY;
        m.0[3] = -0.5;
        assert_eq!(project(&m, (2.0, 3.0)), None);
    }
}
