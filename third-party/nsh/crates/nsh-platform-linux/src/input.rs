//! Pointer input of a surface: hit testing, touches for the JS responder
//! system, presses, hover / pressed states, cursors, native pan / pinch /
//! rotation values, and routing wheel, touchpad and touchscreen scrolling
//! to the scroll views.
//!
//! One `EventControllerLegacy` on the root, in the capture phase, sees
//! every pointer event before the widgets under it. It never stops button,
//! motion or touch events, so hosted native widgets (text fields) still get
//! their clicks, focus and selection drags; presses, pans and scroll drags
//! simply do not start on them. Wheel and touchpad scrolls it routes are
//! stopped, unless they land on a native widget that scrolls itself.
//!
//! Hit testing walks the views itself rather than using `gtk_widget_pick`:
//! GTK's picking knows nothing of `overflow: hidden` (the views clip in
//! `snapshot`), hidden views or `box-only`. Points go into children through
//! their allocation transforms (frame, scroll offset, shift, transform).
//! Outside a view's bounds, only the area its descendants cover
//! (`MountItem::Overflow`: a dropdown under its field) is looked into, as
//! on iOS and Android. GTK still delivers events by its own picking, so
//! presses, hovers and wheels GTK would send to a web view's page where
//! nsh does not show it (clipped off, hidden) are kept from the page
//! (`shields_page`), after nsh handled them.
//!
//! Presses follow React Native and the other backends: the innermost view
//! listening to press events gets them (or the pressable text span under
//! the pointer; how it looks while pressed is the app's `activeStyle`,
//! applied by the core from the reported states); inside scroll
//! views a touch reports `onPressDown` only after ~130 ms, as it may start a
//! scroll. A move beyond 6 pt starts the innermost pan or scroll view that
//! takes that direction (only touches drag scroll views: the mouse scrolls
//! with the wheel, the touchpad, the keyboard and the indicator, and its
//! drags go to pans, responders and text selection); beyond 10 pt the
//! press is over.
//!
//! A view with a `panActivation` around the first pointer gates it
//! ([`Gate`], `PanActivation::decide` on every move): the scroll views
//! around the view wait until its pan fails, and never take the drag once
//! it activates; the activation goes to JS with the move's touches
//! (`TouchEvent::activated`), where the view becomes the responder.
//!
//! A scroll stays on the scroll view it began in (a touchpad gesture until
//! it ends, mouse wheel notches while they come within 200 ms), as in
//! browsers: inner views passing under the pointer do not take it over, and
//! its view reaching an edge does not hand the rest to an outer one.
//!
//! Real and simulated input ([`simulate`]) share the same handlers, which
//! take root coordinates and millisecond timestamps.
//!
//! The decisions over plain data (what a pointer going down may start, a
//! press's events, hover changes, hit areas, pinches, wheel latching) are
//! [`nsh_core::input`]'s, shared by the desktop backends.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use gtk4::{self as gtk, gdk, glib, glib::translate::ToGlibPtr, graphene, prelude::*};
use nsh_core::{
    Command, Cursor, EventKind, EventPayload, GestureValues, NodeId, PayloadValue, PointerEvents,
    ROOT_ID, TouchEvent, TouchPhase, TouchPoint, ViewKind,
    geometry::{Points, point},
    input::{
        self, Candidate, Gate, Grab, GrabOptions, HitArea, Link, PAN_SLOP, PRESS_SLOP, Pinch,
        SCROLL_PRESS_DELAY, VelocityTracker, ZOOM_IDLE, has_press, laid_out, latch_holds,
        transforms,
    },
    tailwind::state::{HOVERED, PRESSED},
};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{surface::Surface, view::NshView};

/// The GTK keyboard owner followed by its NSH ancestors in this surface.
pub(crate) fn focus_path(surface: &Surface, mut focus: Option<gtk::Widget>) -> Vec<NodeId> {
    let mut path = Vec::new();
    while let Some(widget) = focus {
        if let Some(view) = widget.downcast_ref::<NshView>() {
            path.push(view.id());
            if view.id() == ROOT_ID && view != &surface.root {
                return Vec::new();
            }
        }
        if &widget == surface.root.upcast_ref::<gtk::Widget>() {
            return path;
        }
        focus = widget.parent();
    }
    // AppViews embedded in one GtkWindow share its native focus, but their
    // node ids are local to their own engines. A sibling's path is not ours.
    Vec::new()
}

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

/// Two touchscreen fingers transforming a view.
struct TwoFinger {
    keys: [Key; 2],
    pinch: Pinch,
    transform: Transform,
}

/// Which device a pointer is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    /// The mouse (or touchpad clicks).
    Mouse,
    /// A touchscreen finger, by its event sequence.
    Touch(usize),
}

/// Pointer state of one surface.
#[derive(Default)]
pub(crate) struct Input {
    /// The pointers that are down.
    pointers: RefCell<Vec<Pointer>>,
    /// Two fingers pinching / rotating on the touchscreen.
    two: RefCell<Option<TwoFinger>>,
    /// A touchpad pinch.
    pinch: RefCell<Option<Transform>>,
    /// A pinch by Ctrl + mouse wheel, with the generation of its end timer.
    zoom: RefCell<Option<(Transform, u64)>>,
    /// A touchpad scroll gesture.
    wheel: RefCell<Option<Wheel>>,
    /// The scroll view mouse wheel notches go to while they keep coming,
    /// whether they scroll horizontally, and when the last one came (ms).
    latch: RefCell<Option<(NshView, bool, f64)>>,
    /// Views that track `HOVERED` or listen to hover events (hover is only
    /// tested while there are).
    hover_tracked: RefCell<FxHashSet<NodeId>>,
    /// Views listening to mouse motion; other apps skip the extra hit test.
    mouse_tracked: RefCell<FxHashSet<NodeId>>,
    /// Views that are hovered now.
    hovered: RefCell<Vec<NshView>>,
    /// Native gesture values by view.
    gestures: RefCell<FxHashMap<NodeId, (glib::WeakRef<NshView>, GestureValues)>>,
    /// The JS responder blocks native scrolling and pans.
    js_block: Cell<bool>,
    /// Where the pointer last was (root coordinates), for events GTK
    /// gives no position (wheels, touchpad gestures).
    last: Cell<Option<(f32, f32)>>,
    /// The last mouse press (time, root position, click count), for
    /// counting double and triple clicks.
    click: Cell<Option<(f64, f32, f32, u32)>>,
    /// Next touch identifier.
    next_id: Cell<u32>,
    /// Next press generation (invalidates callbacks of earlier ones).
    next_gen: Cell<u64>,
}

/// What a pointer is doing.
#[derive(Debug, Clone, PartialEq)]
enum Mode {
    /// Not past the pan slop yet.
    Idle,
    /// Past it, with nothing to drag.
    Free,
    /// Dragging a pan view.
    Pan(NshView),
    /// Scrolling a scroll view, from where the drag began.
    Scroll(NshView, (f32, f32)),
    /// Dragging a scroll view's indicator as a scroll bar's thumb (the
    /// mouse), from where the drag began.
    Thumb(NshView, (f32, f32)),
    /// One of two fingers pinching / rotating.
    TwoFinger,
}

/// A pointer that is down.
struct Pointer {
    key: Key,
    /// Touch identifier for JS.
    id: u32,
    /// Behaves like a finger (scroll drags, delayed press-in).
    touch: bool,
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
    /// The view a second finger would pinch / rotate.
    pinch: Option<NshView>,
    /// Views that track `PRESSED` and are pressed by it.
    pressed: Vec<NshView>,
    mode: Mode,
    /// It moved (a JS responder granted now took it from a native press).
    moved: bool,
}

/// A touchpad scroll gesture.
struct Wheel {
    view: NshView,
    /// Accumulated deltas, for the velocity.
    total: (f32, f32),
    velocity: VelocityTracker,
    /// Began with a hold (fingers resting) and has not scrolled yet.
    held: bool,
}

// --- Installation and the views' hooks ----------------------------------------------

/// Installs the event controllers on the surface's root view.
pub(crate) fn install(surface: &Rc<Surface>) {
    let root = &surface.root;
    let legacy = gtk::EventControllerLegacy::new();
    legacy.set_propagation_phase(gtk::PropagationPhase::Capture);
    let weak = Rc::downgrade(surface);
    legacy.connect_event(move |_, event| match weak.upgrade() {
        Some(surface) => handle(&surface, event),
        None => glib::Propagation::Proceed,
    });
    root.add_controller(legacy);

    // Crossing events do not reach legacy controllers.
    let motion = gtk::EventControllerMotion::new();
    let weak = Rc::downgrade(surface);
    motion.connect_leave(move |_| {
        if let Some(surface) = weak.upgrade() {
            set_hovered(&surface, Vec::new());
        }
    });
    root.add_controller(motion);
}

/// The app stopped: forgets its pointers, hovered views and gestures.
pub(crate) fn reset(surface: &Surface) {
    crate::file_drop::reset(surface);
    let input = &surface.input;
    input.pointers.borrow_mut().clear();
    input.two.borrow_mut().take();
    input.pinch.borrow_mut().take();
    input.zoom.borrow_mut().take();
    input.wheel.borrow_mut().take();
    input.latch.borrow_mut().take();
    input.hover_tracked.borrow_mut().clear();
    input.mouse_tracked.borrow_mut().clear();
    input.hovered.borrow_mut().clear();
    input.gestures.borrow_mut().clear();
    input.js_block.set(false);
}

/// Ends a retiring row's input before its node ids can be reused.
pub(crate) fn retire_cell(surface: &Rc<Surface>, cell: &NshView) {
    let inside = |view: &NshView| {
        let mut current = Some(view.clone());
        while let Some(view) = current {
            if view == *cell {
                return true;
            }
            current = view.parent_view();
        }
        false
    };
    let input = &surface.input;
    let mut ids = FxHashSet::default();
    let mut pending = vec![cell.clone()];
    while let Some(view) = pending.pop() {
        ids.insert(view.id());
        crate::file_drop::invalidate(surface, view.id());
        pending.extend(view.child_views());
    }
    let keys: Vec<_> = input
        .pointers
        .borrow()
        .iter()
        .filter(|p| {
            inside(&p.target)
                || p.press
                    .as_ref()
                    .is_some_and(|press| inside(&press.view) || ids.contains(&press.node))
                || p.candidates.iter().any(|(view, _)| inside(view))
                || p.pressed.iter().any(&inside)
                || p.pinch.as_ref().is_some_and(&inside)
                || p.gate.as_ref().is_some_and(|gate| ids.contains(&gate.id()))
                || (p.reporting && p.path.iter().any(|id| ids.contains(id)))
                || match &p.mode {
                    Mode::Pan(view) | Mode::Scroll(view, _) | Mode::Thumb(view, _) => inside(view),
                    Mode::TwoFinger => input
                        .two
                        .borrow()
                        .as_ref()
                        .is_some_and(|two| inside(&two.transform.view)),
                    Mode::Idle | Mode::Free => false,
                }
        })
        .map(|p| p.key)
        .collect();
    for key in keys {
        let Some(mut p) = take(surface, key) else {
            continue;
        };
        let active = match &p.mode {
            Mode::Pan(view) | Mode::Scroll(view, _) | Mode::Thumb(view, _) => Some(view.clone()),
            Mode::TwoFinger => input
                .two
                .borrow()
                .as_ref()
                .map(|two| two.transform.view.clone()),
            Mode::Idle | Mode::Free => None,
        };
        if let Some(owner) = active.filter(|owner| !inside(owner)) {
            // The surrounding scroll/pan already owns this gesture. The
            // original row may disappear without stopping that live owner.
            if p.reporting {
                report(surface, TouchPhase::Cancel, &p, None);
                p.reporting = false;
            }
            cancel_press(surface, &mut p);
            release_pressed(surface, &mut p);
            p.target = owner;
            p.path.clear();
            p.candidates.clear();
            p.gate = None;
            p.pinch = None;
            put(surface, p);
        } else {
            if let Mode::Pan(view) = &p.mode {
                pan_end(surface, view, &p, false);
                p.mode = Mode::Free;
            }
            finish(surface, p, true);
        }
    }
    if input
        .two
        .borrow()
        .as_ref()
        .is_some_and(|two| inside(&two.transform.view))
    {
        end_two_finger(surface);
    }
    let pinch = {
        let mut pinch = input.pinch.borrow_mut();
        if pinch.as_ref().is_some_and(|t| inside(&t.view)) {
            pinch.take()
        } else {
            None
        }
    };
    if let Some(transform) = pinch {
        transform_end(surface, &transform);
    }
    let zoom = {
        let mut zoom = input.zoom.borrow_mut();
        if zoom.as_ref().is_some_and(|(t, _)| inside(&t.view)) {
            zoom.take()
        } else {
            None
        }
    };
    if let Some((transform, _)) = zoom {
        transform_end(surface, &transform);
    }
    if input
        .wheel
        .borrow()
        .as_ref()
        .is_some_and(|wheel| inside(&wheel.view))
    {
        input.wheel.borrow_mut().take();
    }
    if input
        .latch
        .borrow()
        .as_ref()
        .is_some_and(|(view, _, _)| inside(view))
    {
        input.latch.borrow_mut().take();
    }
    let hovered = input
        .hovered
        .borrow()
        .iter()
        .filter(|view| !inside(view))
        .cloned()
        .collect();
    set_hovered(surface, hovered);
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
        gestures.insert(id, (view.downgrade(), values));
    }
}

/// The view's events changed (hover handlers have it hovered, from the
/// next mouse move).
pub(crate) fn events_changed(surface: &Rc<Surface>, view: &NshView) {
    update_hover_tracking(surface, view);
    update_cursor(view);
}

/// The view's props changed.
pub(crate) fn props_changed(_surface: &Rc<Surface>, _view: &NshView) {
    // `pointerEvents`, `hitSlop` and `delayLongPress` are read from the state when a pointer goes down.
}

/// The view's style changed (cursor).
pub(crate) fn style_changed(view: &NshView) {
    update_cursor(view);
}

/// `SetJsResponder` / `ClearJsResponder`. Runs while the mounter applies a
/// batch: it must not write animations (that borrows the mounter).
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    match command {
        Command::SetJsResponder { block } => {
            surface.input.js_block.set(*block);
            let mut pointers = std::mem::take(&mut *surface.input.pointers.borrow_mut());
            for p in &mut pointers {
                // Granted on a move: the JS gesture takes over from the native
                // press (a grant when the finger lands leaves inner presses be,
                // as they would have won the negotiation in React Native).
                if p.moved {
                    cancel_press(surface, p);
                    release_pressed(surface, p);
                }
                if *block && let Mode::Pan(view) = &p.mode {
                    let view = view.clone();
                    pan_end(surface, &view, p, false);
                    p.mode = Mode::Free;
                }
            }
            let mut current = surface.input.pointers.borrow_mut();
            pointers.append(&mut current);
            *current = pointers;
        }
        Command::ClearJsResponder => surface.input.js_block.set(false),
        _ => {}
    }
}

/// The CSS name of the pointer over a view, `None` to inherit its parent's.
fn cursor_name(cursor: Cursor) -> Option<&'static str> {
    Some(match cursor {
        Cursor::Auto => return None,
        Cursor::Default => "default",
        Cursor::Pointer => "pointer",
        Cursor::Text => "text",
        Cursor::Wait => "wait",
        Cursor::Progress => "progress",
        Cursor::Help => "help",
        Cursor::Crosshair => "crosshair",
        Cursor::Move => "move",
        Cursor::Grab => "grab",
        Cursor::Grabbing => "grabbing",
        Cursor::NotAllowed => "not-allowed",
        Cursor::ZoomIn => "zoom-in",
        Cursor::ZoomOut => "zoom-out",
        Cursor::ColResize => "col-resize",
        Cursor::RowResize => "row-resize",
        Cursor::None => "none",
    })
}

fn update_cursor(view: &NshView) {
    let name = {
        let s = view.state();
        // Selectable text and the texts of selectable views show the
        // I-beam (a press target its pointer).
        cursor_name(s.style.cursor).or_else(|| {
            let selects = crate::text::selectable(&s)
                || (s.text.is_some() && crate::selectable_view::takes_part(view));
            selects.then_some("text")
        })
    };
    let current = view.cursor().and_then(|c| c.name());
    if current.as_deref() != name {
        view.set_cursor_from_name(name);
    }
}

// --- GDK events ---------------------------------------------------------------------

fn handle(surface: &Rc<Surface>, event: &gdk::Event) -> glib::Propagation {
    // Decided before nsh's own handling moves anything.
    let shielded = shields_page(surface, event);
    let propagation = dispatch(surface, event);
    if shielded {
        glib::Propagation::Stop
    } else {
        propagation
    }
}

/// Whether `event` would reach a web view's page where nsh does not show
/// it: GTK picks widgets by their allocations and knows nothing of
/// `overflow: hidden`, `hidden` or `pointerEvents`, so without this a
/// page clipped by a parent would take clicks, hovers and wheels outside
/// what is drawn of it. nsh's own handling of the event goes on (the view
/// actually under the pointer gets it); only the page is kept from it.
fn shields_page(surface: &Surface, event: &gdk::Event) -> bool {
    use gdk::EventType as T;
    if !surface.native.has_pages() {
        return false;
    }
    let buttons = gdk::ModifierType::BUTTON1_MASK
        | gdk::ModifierType::BUTTON2_MASK
        | gdk::ModifierType::BUTTON3_MASK;
    let point = match event.event_type() {
        T::ButtonPress | T::TouchBegin => root_point(&surface.root, event),
        // Drags that started in the page stay with it.
        T::MotionNotify if !event.modifier_state().intersects(buttons) => {
            root_point(&surface.root, event)
        }
        T::Scroll => root_point(&surface.root, event).or_else(|| surface.input.last.get()),
        _ => None,
    };
    let Some((x, y)) = point else {
        return false;
    };
    let Some(page) = surface
        .root
        .pick(x as f64, y as f64, gtk::PickFlags::DEFAULT)
        .and_then(|target| crate::native::page_of(&target))
    else {
        return false;
    };
    let shown = pick(&surface.root, x, y)
        .and_then(|hit| hit.native)
        .is_some_and(|native| native == page || native.is_ancestor(&page));
    !shown
}

fn dispatch(surface: &Rc<Surface>, event: &gdk::Event) -> glib::Propagation {
    use gdk::EventType as T;
    let ty = event.event_type();
    match ty {
        T::ButtonPress
        | T::ButtonRelease
        | T::MotionNotify
        | T::TouchBegin
        | T::TouchUpdate
        | T::TouchEnd
        | T::TouchCancel
        | T::Scroll
        | T::TouchpadPinch
        | T::TouchpadHold => {}
        T::GrabBroken => {
            cancel_all(surface);
            return glib::Propagation::Proceed;
        }
        T::KeyPress | T::KeyRelease => {
            modifiers_changed(surface, event, ty == T::KeyPress);
            return glib::Propagation::Proceed;
        }
        _ => return glib::Propagation::Proceed,
    }
    // Scroll and touchpad gesture events carry no position in GTK 4: they
    // happen where the pointer is.
    let point = match root_point(&surface.root, event) {
        Some(p) => {
            surface.input.last.set(Some(p));
            Some(p)
        }
        None if matches!(ty, T::Scroll | T::TouchpadPinch | T::TouchpadHold) => {
            surface.input.last.get()
        }
        None => None,
    };
    let Some((x, y)) = point else {
        return glib::Propagation::Proceed;
    };
    let time = event.time() as f64;
    let button = || event.downcast_ref::<gdk::ButtonEvent>().map(|b| b.button());
    match ty {
        // Touchscreens report touches; pointer events emulated from them
        // would press twice.
        T::ButtonPress | T::ButtonRelease | T::MotionNotify if event.is_pointer_emulated() => {}
        // On a view that drags the window: the window's, not the app's.
        T::ButtonPress if crate::chrome::press(surface, event, x, y) => {
            return glib::Propagation::Stop;
        }
        T::ButtonPress if button() == Some(gdk::BUTTON_PRIMARY) => {
            down(surface, Key::Mouse, x, y, time, event.modifier_state())
        }
        T::ButtonPress
            if button() == Some(gdk::BUTTON_SECONDARY)
                && context_menu(surface, x, y, event.modifier_state()) =>
        {
            return glib::Propagation::Stop;
        }
        T::ButtonRelease if button() == Some(gdk::BUTTON_PRIMARY) => {
            up(surface, Key::Mouse, x, y, time, false)
        }
        T::MotionNotify => {
            if event.device_tool().is_none()
                && !event.device().is_some_and(|device| {
                    matches!(
                        device.source(),
                        gdk::InputSource::Pen
                            | gdk::InputSource::Touchscreen
                            | gdk::InputSource::TabletPad
                    )
                })
            {
                mouse_moved(surface, x, y);
            }
            motion(surface, Key::Mouse, x, y, time);
            let state = event.modifier_state();
            let buttons = gdk::ModifierType::BUTTON1_MASK
                | gdk::ModifierType::BUTTON2_MASK
                | gdk::ModifierType::BUTTON3_MASK;
            if !state.intersects(buttons) {
                hover_moved(surface, x, y, state);
            }
        }
        T::TouchBegin => down(
            surface,
            touch_key(event),
            x,
            y,
            time,
            event.modifier_state(),
        ),
        T::TouchUpdate => motion(surface, touch_key(event), x, y, time),
        T::TouchEnd => up(surface, touch_key(event), x, y, time, false),
        T::TouchCancel => up(surface, touch_key(event), x, y, time, true),
        T::Scroll => {
            if let Some(scroll) = event.downcast_ref::<gdk::ScrollEvent>() {
                return scroll_event(surface, scroll, x, y, time);
            }
        }
        T::TouchpadPinch | T::TouchpadHold => {
            if let Some(pad) = event.downcast_ref::<gdk::TouchpadEvent>() {
                let handled = if ty == T::TouchpadPinch {
                    touchpad_pinch(surface, pad, x, y)
                } else {
                    touchpad_hold(surface, pad.gesture_phase(), x, y)
                };
                if handled {
                    return glib::Propagation::Stop;
                }
            }
        }
        _ => {}
    }
    glib::Propagation::Proceed
}

/// A secondary click at `(x, y)` (root coordinates): the nearest view
/// around the one under it that listens to `onContextMenu` hears it (true:
/// the click is taken). Text fields are GTK's widgets, which show their
/// own menu.
fn context_menu(surface: &Surface, x: f32, y: f32, state: gdk::ModifierType) -> bool {
    let Some(hit) = pick(&surface.root, x, y) else {
        return false;
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
                modifiers: modifiers(state),
            };
            surface.event(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
            return true;
        }
        if input {
            return false;
        }
    }
    false
}

/// The event's position in the root's coordinates (`None` for events of
/// other surfaces, such as popovers of hosted widgets).
fn root_point(root: &NshView, event: &gdk::Event) -> Option<(f32, f32)> {
    let (x, y) = event.position()?;
    let native = root.native()?;
    if event.surface() != native.surface() {
        return None;
    }
    let (sx, sy) = native.surface_transform();
    let p = native.compute_point(
        root,
        &graphene::Point::new((x - sx) as f32, (y - sy) as f32),
    )?;
    Some((p.x(), p.y()))
}

fn touch_key(event: &gdk::Event) -> Key {
    let sequence = event.event_sequence();
    let ptr: *const gdk::ffi::GdkEventSequence = sequence.to_glib_none().0;
    Key::Touch(ptr as usize)
}

/// How a scroll event scrolls.
#[derive(Debug, Clone, Copy, PartialEq)]
enum WheelInput {
    /// A mouse wheel step: notches (`true`, scaled to the view) or
    /// points.
    Step { notches: bool },
    /// A touchpad gesture moved by points.
    Touchpad,
    /// The touchpad gesture ended.
    Stop,
}

fn scroll_event(
    surface: &Rc<Surface>,
    event: &gdk::ScrollEvent,
    x: f32,
    y: f32,
    time: f64,
) -> glib::Propagation {
    let notches = WheelInput::Step { notches: true };
    let (kind, mut dx, mut dy) = match event.direction() {
        gdk::ScrollDirection::Up => (notches, 0.0, -1.0),
        gdk::ScrollDirection::Down => (notches, 0.0, 1.0),
        gdk::ScrollDirection::Left => (notches, -1.0, 0.0),
        gdk::ScrollDirection::Right => (notches, 1.0, 0.0),
        _ => {
            let (dx, dy) = event.deltas();
            let kind = if event.is_stop() {
                WheelInput::Stop
            } else if event.unit() == gdk::ScrollUnit::Wheel {
                notches
            } else {
                WheelInput::Touchpad
            };
            (kind, dx as f32, dy as f32)
        }
    };
    let modifiers = event.modifier_state();
    // Mice have no pinch: Ctrl + wheel pinches, as it zooms on desktops.
    if let WheelInput::Step { .. } = kind
        && modifiers.contains(gdk::ModifierType::CONTROL_MASK)
        && dy != 0.0
        && wheel_zoom(surface, x, y, dy)
    {
        return glib::Propagation::Stop;
    }
    if kind == notches && dx == 0.0 && modifiers.contains(gdk::ModifierType::SHIFT_MASK) {
        (dx, dy) = (dy, dx);
    }
    if wheel_input(surface, x, y, dx, dy, time, kind) {
        glib::Propagation::Stop
    } else {
        glib::Propagation::Proceed
    }
}

// --- Simulation ---------------------------------------------------------------------

/// A simulated pointer action of the mouse ([`crate::synth`]), in root
/// coordinates.
#[cfg(feature = "dev")]
#[derive(Debug, Clone, Copy)]
pub(crate) enum Simulated {
    /// A press at `(x, y)`.
    Down(f32, f32),
    /// A release at `(x, y)`.
    Up(f32, f32),
    /// The pointer moved to `(x, y)` with its button down (a drag).
    Move(f32, f32),
    /// A wheel / touchpad scroll at `(x, y)` by `(dx, dy)` points.
    Wheel(f32, f32, f32, f32),
    /// The pointer moved to `(x, y)` without a button (hover).
    Hover(f32, f32),
    /// The secondary button pressed at `(x, y)` (a context menu).
    ContextMenu(f32, f32),
}

/// Feeds a simulated pointer action through the same path as real input.
#[cfg(feature = "dev")]
pub(crate) fn simulate(surface: &Rc<Surface>, action: Simulated) {
    let time = glib::monotonic_time() as f64 / 1000.0;
    match action {
        Simulated::Down(x, y) => down(surface, Key::Mouse, x, y, time, gdk::ModifierType::empty()),
        Simulated::Up(x, y) => {
            up(surface, Key::Mouse, x, y, time, false);
            // GTK never sees simulated input: a release on a hosted widget
            // (a text field) focuses it, as a real click would.
            if let Some(native) = pick(&surface.root, x, y).and_then(|hit| hit.native) {
                focus_native(&native);
            }
        }
        Simulated::Move(x, y) => {
            mouse_moved(surface, x, y);
            motion(surface, Key::Mouse, x, y, time);
        }
        Simulated::Wheel(x, y, dx, dy) => {
            let step = WheelInput::Step { notches: false };
            wheel_input(surface, x, y, dx, dy, time, step);
        }
        Simulated::Hover(x, y) => {
            mouse_moved(surface, x, y);
            hover(surface, x, y);
            hover_moved(surface, x, y, gdk::ModifierType::empty());
        }
        Simulated::ContextMenu(x, y) => {
            context_menu(surface, x, y, gdk::ModifierType::empty());
        }
    }
}

/// Focuses `widget` or the first focusable widget inside it.
#[cfg(feature = "dev")]
fn focus_native(widget: &gtk::Widget) {
    if widget.grab_focus() {
        return;
    }
    let mut child = widget.first_child();
    while let Some(c) = child {
        if c.is_focusable() && c.grab_focus() {
            return;
        }
        focus_native(&c);
        child = c.next_sibling();
    }
}

// --- Hit testing --------------------------------------------------------------------

/// Where the pointer last was (root coordinates).
pub(crate) fn last_pointer(surface: &Surface) -> Option<(f32, f32)> {
    surface.input.last.get()
}

/// Pressing `(x, y)` (root coordinates) drags the window: the nearest view
/// that sets `windowDrag` says so, unless a text field, a hosted widget or
/// a view with press or touch handlers is nearer.
pub(crate) fn window_drag(surface: &Surface, x: f32, y: f32) -> bool {
    let Some(hit) = pick(&surface.root, x, y) else {
        return false;
    };
    if hit.native.is_some() {
        return false;
    }
    for view in chain(&hit.view) {
        let s = view.state();
        if let Some(drag) = s.props.window_drag {
            return drag;
        }
        if s.kind == ViewKind::Input || has_press(s.events) || s.events.contains(EventKind::Touch) {
            return false;
        }
    }
    false
}

/// What is under a point.
struct Hit {
    /// The innermost view.
    view: NshView,
    /// The hosted native widget the point is on.
    native: Option<gtk::Widget>,
}

/// The innermost view at `(x, y)` (root coordinates).
fn pick(root: &NshView, x: f32, y: f32) -> Option<Hit> {
    pick_in(root, graphene::Point::new(x, y))
}

fn pick_in(view: &NshView, p: graphene::Point) -> Option<Hit> {
    if !view.is_visible() || !view.can_target() {
        return None;
    }
    let (pe, in_slop, children) = {
        let s = view.state();
        if s.style.hidden || s.props.pointer_events == PointerEvents::None {
            return None;
        }
        let clip = s.style.overflow_hidden
            || matches!(
                s.kind,
                ViewKind::Scroll | ViewKind::Image | ViewKind::Stack | ViewKind::Input
            );
        let HitArea {
            in_slop, children, ..
        } = input::hit_area(
            point(Points(p.x()), Points(p.y())),
            s.frame.size,
            s.props.hit_slop,
            s.overflow,
            clip,
            laid_out(s.kind, s.id),
        );
        (s.props.pointer_events, in_slop, children)
    };
    let own = || (pe != PointerEvents::BoxNone && in_slop).then(|| hit(view, None));
    if !children {
        return own();
    }
    if pe != PointerEvents::BoxOnly {
        let mut child = view.last_child();
        while let Some(widget) = child {
            child = widget.prev_sibling();
            if !widget.is_visible() || !widget.can_target() {
                continue;
            }
            let Some(cp) = view.compute_point(&widget, &p) else {
                continue;
            };
            match widget.downcast_ref::<NshView>() {
                Some(child) => {
                    if let Some(hit) = pick_in(child, cp) {
                        return Some(hit);
                    }
                }
                // A hosted native widget.
                None => {
                    if let Some(native) =
                        widget.pick(cp.x() as f64, cp.y() as f64, gtk::PickFlags::DEFAULT)
                    {
                        return Some(hit(view, Some(native)));
                    }
                }
            }
        }
    }
    own()
}

fn hit(view: &NshView, native: Option<gtk::Widget>) -> Hit {
    Hit {
        view: view.clone(),
        native,
    }
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
fn local(surface: &Surface, view: &NshView, x: f32, y: f32) -> (f32, f32) {
    surface
        .root
        .compute_point(view, &graphene::Point::new(x, y))
        .map_or((x, y), |p| (p.x(), p.y()))
}

fn gesture_values(surface: &Surface, view: &NshView, id: NodeId) -> GestureValues {
    surface
        .input
        .gestures
        .borrow()
        .get(&id)
        .filter(|(weak, _)| weak.upgrade().as_ref() == Some(view))
        .map(|(_, values)| *values)
        .unwrap_or_default()
}

// --- Pointers -----------------------------------------------------------------------

fn take(surface: &Surface, key: Key) -> Option<Pointer> {
    let mut pointers = surface.input.pointers.borrow_mut();
    let i = pointers.iter().position(|p| p.key == key)?;
    Some(pointers.swap_remove(i))
}

fn put(surface: &Surface, p: Pointer) {
    surface.input.pointers.borrow_mut().push(p);
}

fn down(surface: &Rc<Surface>, key: Key, x: f32, y: f32, time: f64, modifiers: gdk::ModifierType) {
    // A release we never saw (the window lost the grab).
    if let Some(stale) = take(surface, key) {
        finish(surface, stale, true);
    }
    let Some(hit) = pick(&surface.root, x, y) else {
        return;
    };
    let input = &surface.input;
    if input.pointers.borrow().is_empty() {
        input.js_block.set(false);
    }
    let touch = key != Key::Mouse;
    let native = hit.native.is_some();
    let views = chain(&hit.view);
    // The mouse drags an indicator as a scroll bar: its thumb follows the
    // pointer, where a drag on the content moves the content with it.
    let thumb = (!touch && !native)
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
            key,
            id,
            touch,
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
            pinch: None,
            pressed: Vec::new(),
            mode: Mode::Thumb(view.clone(), (x, y)),
            moved: false,
        };
        p.velocity.add(time, point(Points(x), Points(y)));
        crate::scroll::thumb_begin(surface, view);
        put(surface, p);
        return;
    }
    // A press clears a selection anywhere else; the mouse selects in the
    // selectable view it presses in (`selectable_view.rs`).
    let area = crate::selectable_view::pressed(surface, &hit.view, !touch, native);
    // Mouse drags over selectable text or in a selectable view select it
    // (`text.rs`) rather than pan.
    let selects =
        area.is_some() || (!touch && !native && crate::text::selectable(&hit.view.state()));
    // The gate follows the first pointer only, as on the other platforms.
    let first = input.pointers.borrow().is_empty();
    let options = GrabOptions::new(touch, native, selects, first);
    let mut grab = Grab::default();
    for v in &views {
        let s = v.state();
        let link = Link::new(
            s.id,
            s.events,
            s.tracked,
            gesture_values(surface, v, s.id),
            s.scroll.as_ref().map(|scroll| scroll.horizontal),
            s.props.pan_activation,
        );
        grab.add(v, &link, options);
    }
    let Grab {
        path,
        candidates,
        pinch,
        pressed,
        in_scroll,
        gate,
        ..
    } = grab;
    let press = if native {
        None
    } else {
        let clicks = if touch {
            1
        } else {
            click_count(input, x, y, time)
        };
        find_press(surface, &hit.view, &views, x, y)
            .map(|p| p.clicked(self::modifiers(modifiers), clicks))
    };
    if let Some(area) = &area {
        // Over a press target in the area a drag selects only once the
        // press is over.
        let over_press = press
            .as_ref()
            .is_some_and(|p| p.view == *area || p.view.is_ancestor(area));
        crate::selectable_view::begin(surface, area, (x, y), time, modifiers, over_press);
    }
    let id = input.next_id.get();
    input.next_id.set(id.wrapping_add(1));
    let mut p = Pointer {
        key,
        id,
        touch,
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
        pinch,
        pressed,
        mode: Mode::Idle,
        moved: false,
    };
    p.velocity.add(time, point(Points(x), Points(y)));
    if p.reporting {
        report(surface, TouchPhase::Start, &p, None);
    }
    for v in &p.pressed {
        set_state(surface, v, PRESSED, true);
    }
    if touch && start_two_finger(surface, &mut p) {
        put(surface, p);
        return;
    }
    if let Some(press) = &mut p.press {
        let generation = press.generation;
        if touch && in_scroll {
            after(
                surface,
                key,
                generation,
                SCROLL_PRESS_DELAY,
                |surface, p| {
                    if let Some(press) = &mut p.press {
                        press_in(surface, press, (p.x, p.y));
                    }
                },
            );
        } else {
            press_in(surface, press, (x, y));
        }
        if press.events.contains(EventKind::LongPress) {
            let delay = press.long_delay.max(0.0) as u64;
            after(surface, key, generation, delay, |surface, p| {
                let Some(press) = &mut p.press else { return };
                press_in(surface, press, (p.x, p.y));
                press.long = true;
                press_event(surface, press, EventKind::LongPress, (p.x, p.y));
            });
        }
    }
    put(surface, p);
}

fn motion(surface: &Rc<Surface>, key: Key, x: f32, y: f32, time: f64) {
    if key == Key::Mouse {
        hover(surface, x, y);
    }
    let Some(mut p) = take(surface, key) else {
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
    if key == Key::Mouse && crate::selectable_view::dragged(surface, x, y) {
        cancel_press(surface, &mut p);
        release_pressed(surface, &mut p);
    }
    let (tx, ty) = (x - p.start.0, y - p.start.1);
    let activated = Gate::step(&mut p.gate, &mut p.candidates, Points(tx), Points(ty));
    // The view's JS responder takes the drag over: nothing native starts
    // meanwhile.
    if activated.is_some() && p.mode == Mode::Idle {
        p.mode = Mode::Free;
    }
    if p.reporting {
        report(surface, TouchPhase::Move, &p, activated);
    }
    if p.mode == Mode::TwoFinger {
        put(surface, p);
        two_finger_moved(surface);
        return;
    }
    let distance = tx.hypot(ty);
    // JS hears of the first move only now: give its responder a chance to
    // take the gesture (and block native drags) before one starts.
    let js_pending = p.reporting && !moved;
    if p.mode == Mode::Idle && distance > PAN_SLOP.0 && !js_pending {
        // While the gate decides, the candidates around it wait (the
        // pointer stays idle and they are asked again on the next move).
        if p.gate.is_none() {
            p.mode = Mode::Free;
        }
        let started = if surface.input.js_block.get() {
            None
        } else {
            input::startable(&p.candidates, p.gate.as_ref(), Points(tx), Points(ty)).cloned()
        };
        match started {
            Some((view, Candidate::Pan { .. })) => {
                p.gate = None;
                pan_start(surface, &view, &p);
                p.mode = Mode::Pan(view);
            }
            Some((view, Candidate::Scroll { .. })) => {
                // The scroll view takes the touches over from JS.
                if p.reporting {
                    report(surface, TouchPhase::Cancel, &p, None);
                    p.reporting = false;
                }
                p.gate = None;
                crate::scroll::drag_begin(surface, &view);
                p.mode = Mode::Scroll(view, (x, y));
            }
            None => {}
        }
    }
    if matches!(p.mode, Mode::Pan(_) | Mode::Scroll(..)) || distance > PRESS_SLOP.0 {
        cancel_press(surface, &mut p);
        release_pressed(surface, &mut p);
    }
    match &p.mode {
        Mode::Pan(view) => {
            let view = view.clone();
            pan_move(surface, &view, tx, ty);
        }
        Mode::Scroll(view, origin) => {
            crate::scroll::drag_move(surface, view, x - origin.0, y - origin.1);
        }
        Mode::Thumb(view, origin) => {
            crate::scroll::thumb_move(surface, view, x - origin.0, y - origin.1);
        }
        _ => {}
    }
    put(surface, p);
}

fn up(surface: &Rc<Surface>, key: Key, x: f32, y: f32, time: f64, cancelled: bool) {
    let Some(mut p) = take(surface, key) else {
        return;
    };
    p.x = x;
    p.y = y;
    p.time = time;
    p.velocity.add(time, point(Points(x), Points(y)));
    finish(surface, p, cancelled);
}

/// The pointer lifted (or was cancelled): ends what it did.
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
    if p.key == Key::Mouse {
        crate::selectable_view::released(surface);
    }
    let mode = std::mem::replace(&mut p.mode, Mode::Free);
    match mode {
        Mode::TwoFinger => end_two_finger(surface),
        Mode::Pan(view) => {
            pan_move(surface, &view, p.x - p.start.0, p.y - p.start.1);
            pan_end(surface, &view, &p, true);
        }
        Mode::Scroll(view, _) => {
            let (vx, vy) = p.velocity.velocity();
            crate::scroll::drag_end(surface, &view, vx, vy);
        }
        Mode::Thumb(view, _) => crate::scroll::thumb_end(surface, &view),
        Mode::Idle | Mode::Free => {
            if let Some(mut press) = p.press.take() {
                let at = (p.x, p.y);
                if cancelled {
                    press_out(surface, &mut press, false, at);
                } else {
                    // A quick tap inside a scroll view: the press in now.
                    press_in(surface, &mut press, at);
                    let inside = released_inside(surface, &press.view, p.x, p.y);
                    press_out(surface, &mut press, inside, at);
                }
            }
        }
    }
}

/// Cancels every pointer (the grab broke).
fn cancel_all(surface: &Rc<Surface>) {
    let pointers = std::mem::take(&mut *surface.input.pointers.borrow_mut());
    for p in pointers {
        // Each with the others gone: JS hears one cancel per finger.
        finish(surface, p, true);
    }
}

/// Sends the touches of the reporting pointers, `changed` being the one
/// that `phase` is about (it is not in the list while it is handled), and
/// the view whose pan activation fired with it.
fn report(surface: &Surface, phase: TouchPhase, changed: &Pointer, activated: Option<NodeId>) {
    let points = {
        let pointers = surface.input.pointers.borrow();
        pointers
            .iter()
            .chain(std::iter::once(changed))
            .filter(|p| p.reporting)
            .map(|p| {
                let is_changed = std::ptr::eq(p, changed);
                let (lx, ly) = local(surface, &p.target, p.x, p.y);
                TouchPoint {
                    id: p.id,
                    target: p.target.id(),
                    // JS keeps a finger's path from its start.
                    path: if phase == TouchPhase::Start && is_changed {
                        p.path.clone()
                    } else {
                        Vec::new()
                    },
                    page: point(Points(p.x), Points(p.y)),
                    location: point(Points(lx), Points(ly)),
                    changed: is_changed,
                }
            })
            .collect()
    };
    let event = TouchEvent {
        phase,
        timestamp: changed.time,
        points,
        activated,
    };
    surface.event(
        ROOT_ID,
        EventKind::Touch,
        EventPayload::Touch(Box::new(event)),
    );
}

/// Runs `f` on pointer `key` after `ms` unless its press `generation` ended.
fn after(
    surface: &Rc<Surface>,
    key: Key,
    generation: u64,
    ms: u64,
    f: impl FnOnce(&Rc<Surface>, &mut Pointer) + 'static,
) {
    let weak = Rc::downgrade(surface);
    glib::timeout_add_local_once(Duration::from_millis(ms), move || {
        let Some(surface) = weak.upgrade() else {
            return;
        };
        let Some(mut p) = take(&surface, key) else {
            return;
        };
        if p.press
            .as_ref()
            .is_some_and(|press| press.generation == generation)
        {
            f(&surface, &mut p);
        }
        put(&surface, p);
    });
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
        let s = target.state();
        if let Some(text) = &s.text
            && !text.text.links.is_empty()
        {
            let (lx, ly) = local(surface, target, x, y);
            let link = crate::text::char_at(&s, lx, ly).and_then(|i| text.text.link_at(i));
            if let Some(link) = link
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

/// The modifier keys of GDK's `state`.
fn modifiers(state: gdk::ModifierType) -> nsh_core::keymap::Modifiers {
    nsh_core::keymap::Modifiers {
        ctrl: state.contains(gdk::ModifierType::CONTROL_MASK),
        alt: state.contains(gdk::ModifierType::ALT_MASK),
        shift: state.contains(gdk::ModifierType::SHIFT_MASK),
        cmd: state.contains(gdk::ModifierType::SUPER_MASK),
    }
}

/// A mouse press's click count: 2 or 3 when it follows the last one
/// quickly and close by, as GTK counts double clicks.
fn click_count(input: &Input, x: f32, y: f32, time: f64) -> u32 {
    let settings = gtk::Settings::default();
    let interval = settings.as_ref().map_or(400, |s| s.gtk_double_click_time()) as f64;
    let distance = settings
        .as_ref()
        .map_or(5, |s| s.gtk_double_click_distance()) as f32;
    let count = match input.click.get() {
        Some((t, cx, cy, n))
            if time - t >= 0.0
                && time - t <= interval
                && (x - cx).abs() <= distance
                && (y - cy).abs() <= distance =>
        {
            (n % 3) + 1
        }
        _ => 1,
    };
    input.click.set(Some((time, x, y, count)));
    count
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
    surface.write_animations();
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
        surface.write_animations();
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

fn transform_view(surface: &Surface, view: &NshView) -> Transform {
    let (id, events) = {
        let s = view.state();
        (s.id, s.events)
    };
    let (pinch, rotation) = transforms(&gesture_values(surface, view, id), events);
    Transform {
        view: view.clone(),
        pinch,
        rotation,
        scale: 1.0,
        degrees: 0.0,
    }
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
    surface.write_animations();
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

/// A second finger went down (`p`, not in the list yet): pinches /
/// rotates the view either finger would, ending what the first one did.
fn start_two_finger(surface: &Rc<Surface>, p: &mut Pointer) -> bool {
    let other = {
        let pointers = surface.input.pointers.borrow();
        let mut touches = pointers.iter().filter(|o| o.touch);
        match (touches.next(), touches.next()) {
            (Some(o), None) => o.key,
            _ => return false,
        }
    };
    let Some(mut o) = take(surface, other) else {
        return false;
    };
    let Some(view) = p.pinch.clone().or_else(|| o.pinch.clone()) else {
        put(surface, o);
        return false;
    };
    for q in [&mut *p, &mut o] {
        cancel_press(surface, q);
        release_pressed(surface, q);
    }
    match std::mem::replace(&mut o.mode, Mode::TwoFinger) {
        Mode::Pan(pan) => pan_end(surface, &pan, &o, true),
        Mode::Scroll(scroll, _) => crate::scroll::drag_end(surface, &scroll, 0.0, 0.0),
        _ => {}
    }
    p.mode = Mode::TwoFinger;
    let transform = transform_view(surface, &view);
    transform_begin(surface, &transform);
    *surface.input.two.borrow_mut() = Some(TwoFinger {
        keys: [o.key, p.key],
        pinch: Pinch::new(
            point(Points(o.x), Points(o.y)),
            point(Points(p.x), Points(p.y)),
        ),
        transform,
    });
    put(surface, o);
    true
}

fn two_finger_moved(surface: &Rc<Surface>) {
    let transform = {
        let mut two = surface.input.two.borrow_mut();
        let Some(t) = two.as_mut() else { return };
        let positions = {
            let pointers = surface.input.pointers.borrow();
            let at = |key: Key| {
                let p = pointers.iter().find(|p| p.key == key)?;
                Some(point(Points(p.x), Points(p.y)))
            };
            at(t.keys[0]).zip(at(t.keys[1]))
        };
        let Some((a, b)) = positions else { return };
        let (scale, rotation) = t.pinch.at(a, b);
        t.transform.scale = scale;
        t.transform.degrees = rotation.0.to_degrees();
        t.transform.clone()
    };
    transform_move(surface, &transform);
}

/// A finger of the pair lifted: the gesture ends, the other finger does
/// nothing more until it lifts.
fn end_two_finger(surface: &Rc<Surface>) {
    let Some(t) = surface.input.two.borrow_mut().take() else {
        return;
    };
    for p in surface.input.pointers.borrow_mut().iter_mut() {
        if t.keys.contains(&p.key) {
            p.mode = Mode::Free;
        }
    }
    transform_end(surface, &t.transform);
}

fn touchpad_pinch(surface: &Rc<Surface>, event: &gdk::TouchpadEvent, x: f32, y: f32) -> bool {
    match event.gesture_phase() {
        gdk::TouchpadGesturePhase::Begin => {
            let Some(hit) = pick(&surface.root, x, y) else {
                return false;
            };
            let view = chain(&hit.view).into_iter().find(|v| {
                let s = v.state();
                transforms(&gesture_values(surface, v, s.id), s.events) != (false, false)
            });
            let Some(view) = view else { return false };
            let t = transform_view(surface, &view);
            transform_begin(surface, &t);
            *surface.input.pinch.borrow_mut() = Some(t);
            true
        }
        gdk::TouchpadGesturePhase::Update => {
            let t = {
                let mut pinch = surface.input.pinch.borrow_mut();
                let Some(t) = pinch.as_mut() else {
                    return false;
                };
                t.scale = event.pinch_scale() as f32;
                t.degrees += event.pinch_angle_delta().to_degrees() as f32;
                t.clone()
            };
            transform_move(surface, &t);
            true
        }
        _ => {
            let Some(t) = surface.input.pinch.borrow_mut().take() else {
                return false;
            };
            transform_end(surface, &t);
            true
        }
    }
}

/// A Ctrl + wheel step of `dy` notches (negative: zooms in) at `(x, y)`:
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
            let Some(hit) = pick(&surface.root, x, y) else {
                return false;
            };
            let view = chain(&hit.view).into_iter().find(|v| {
                let s = v.state();
                transforms(&gesture_values(surface, v, s.id), s.events).0
            });
            let Some(view) = view else { return false };
            let mut t = transform_view(surface, &view);
            t.rotation = false;
            transform_begin(surface, &t);
            t
        }
    };
    t.scale *= input::zoom_factor(dy);
    transform_move(surface, &t);
    *input.zoom.borrow_mut() = Some((t, generation));
    let weak = Rc::downgrade(surface);
    glib::timeout_add_local_once(Duration::from_millis(ZOOM_IDLE), move || {
        let Some(surface) = weak.upgrade() else {
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
fn hover(surface: &Rc<Surface>, x: f32, y: f32) {
    let input = &surface.input;
    let views = pick(&surface.root, x, y)
        .map(|hit| chain(&hit.view))
        .unwrap_or_default();
    // Reveal only the scroll thumb under the pointer, including in nested scroll views.
    for v in views.iter().filter(|v| v.kind() == ViewKind::Scroll) {
        let (lx, ly) = local(surface, v, x, y);
        crate::scroll::hovered(surface, v, lx, ly);
    }
    if input.hover_tracked.borrow().is_empty() && input.hovered.borrow().is_empty() {
        return;
    }
    let views = views.into_iter().filter(hoverable).collect();
    set_hovered(surface, views);
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
fn hover_moved(surface: &Surface, x: f32, y: f32, state: gdk::ModifierType) {
    let hovered = surface.input.hovered.borrow().clone();
    for v in hovered {
        let id = {
            let s = v.state();
            if !s.events.contains(EventKind::HoverMove) {
                continue;
            }
            s.id
        };
        let (location_x, location_y) = local(surface, &v, x, y);
        let event = nsh_core::HoverEvent {
            position: point(Points(location_x), Points(location_y)),
            page_position: point(Points(x), Points(y)),
            modifiers: modifiers(state),
        };
        surface.event(id, EventKind::HoverMove, EventPayload::Hover(event));
    }
}

/// A modifier key pressed or released while the mouse rests: the hovered
/// views that listen hear `onHoverMove` again where it is, with the
/// modifiers as they are now (an editor underlines a definition while
/// Control is held), as they would on the next move.
fn modifiers_changed(surface: &Surface, event: &gdk::Event, pressed: bool) {
    let Some(key) = event.downcast_ref::<gdk::KeyEvent>() else {
        return;
    };
    let mask = match key.keyval() {
        gdk::Key::Control_L | gdk::Key::Control_R => gdk::ModifierType::CONTROL_MASK,
        gdk::Key::Shift_L | gdk::Key::Shift_R => gdk::ModifierType::SHIFT_MASK,
        gdk::Key::Alt_L | gdk::Key::Alt_R | gdk::Key::Meta_L | gdk::Key::Meta_R => {
            gdk::ModifierType::ALT_MASK
        }
        gdk::Key::Super_L | gdk::Key::Super_R => gdk::ModifierType::SUPER_MASK,
        _ => return,
    };
    let Some((x, y)) = surface.input.last.get() else {
        return;
    };
    // A key event's state is the one before it.
    let mut state = event.modifier_state();
    state.set(mask, pressed);
    let buttons = gdk::ModifierType::BUTTON1_MASK
        | gdk::ModifierType::BUTTON2_MASK
        | gdk::ModifierType::BUTTON3_MASK;
    if !state.intersects(buttons) {
        hover_moved(surface, x, y, state);
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

// --- Wheel and touchpad scrolling ---------------------------------------------------

/// Whether hosted widget `widget` (or one around it inside its view)
/// scrolls by itself.
fn scrolls_itself(widget: &gtk::Widget) -> bool {
    let mut current = Some(widget.clone());
    while let Some(w) = current {
        if w.is::<NshView>() {
            return false;
        }
        let ty = w.type_();
        if ty.name().contains("WebView") {
            // A page with `scrollable: false` leaves wheels to the
            // scroll views around it.
            return !w.has_css_class(crate::native::UNSCROLLABLE);
        }
        if ty.is_a(gtk::Scrollable::static_type()) || ty.is_a(gtk::ScrolledWindow::static_type()) {
            return true;
        }
        current = w.parent();
    }
    false
}

/// The innermost scroll view at `(x, y)` that can move by `(dx, dy)`
/// (nested views fall through to outer ones at their edges; `None` too
/// when a hosted widget there scrolls itself). Scroll views along the
/// wheel's axis take it: a vertical wheel over a carousel scrolls the page
/// around it, as in browsers; horizontal views take vertical wheels only
/// where nothing around scrolls vertically.
fn scroll_target(surface: &Surface, x: f32, y: f32, dx: f32, dy: f32) -> Option<NshView> {
    let hit = pick(&surface.root, x, y)?;
    if hit.native.as_ref().is_some_and(scrolls_itself) {
        return None;
    }
    input::scroll_target(
        chain(&hit.view),
        Points(dx),
        Points(dy),
        |v| v.state().scroll.as_ref().map(|s| s.horizontal),
        |v| v.kind() == ViewKind::Scroll && crate::scroll::can_scroll(v, dx, dy),
    )
}

/// Points one wheel notch scrolls a view `extent` points long, as
/// GtkScrolledWindow does.
fn notch(extent: f32) -> f32 {
    extent.max(1.0).powf(2.0 / 3.0)
}

/// A scroll event at `(x, y)`; returns whether a scroll view took it.
fn wheel_input(
    surface: &Rc<Surface>,
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
    time: f64,
    kind: WheelInput,
) -> bool {
    let input = &surface.input;
    match kind {
        WheelInput::Step { notches } => {
            if dx == 0.0 && dy == 0.0 {
                return false;
            }
            // One scroll stays on its view, as in browsers: an inner view
            // passing under the pointer does not take it over, and the view
            // reaching its edge does not hand the rest to an outer one.
            let horizontal = dx.abs() > dy.abs();
            let latched = match &*input.latch.borrow() {
                Some((view, h, last))
                    if latch_holds(*h, *last, horizontal, time) && view.is_mapped() =>
                {
                    Some(view.clone())
                }
                _ => None,
            };
            let Some(view) = latched.or_else(|| scroll_target(surface, x, y, dx, dy)) else {
                input.latch.borrow_mut().take();
                return false;
            };
            *input.latch.borrow_mut() = Some((view.clone(), horizontal, time));
            let (dx, dy) = if notches {
                let s = view.state();
                (
                    dx * notch(s.frame.size.width.0),
                    dy * notch(s.frame.size.height.0),
                )
            } else {
                (dx, dy)
            };
            // Without a begin, the scroll module takes it as a mouse wheel:
            // it settles (and snaps) by itself once the notches stop.
            crate::scroll::wheel(surface, &view, dx, dy);
            true
        }
        WheelInput::Touchpad => {
            if dx == 0.0 && dy == 0.0 {
                return input.wheel.borrow().is_some();
            }
            // After a hold the scroll goes where it points: the held view
            // keeps it only if it scrolls that way.
            let held = match &*input.wheel.borrow() {
                Some(w) if w.held => Some(w.view.clone()),
                _ => None,
            };
            if let Some(held) = held {
                let target = scroll_target(surface, x, y, dx, dy);
                if target.as_ref() == Some(&held) {
                    *input.wheel.borrow_mut() = Some(new_wheel(held, time));
                } else {
                    input.wheel.borrow_mut().take();
                    crate::scroll::wheel_end(surface, &held, 0.0, 0.0);
                }
            }
            if input.wheel.borrow().is_none() {
                let Some(view) = scroll_target(surface, x, y, dx, dy) else {
                    return false;
                };
                *input.wheel.borrow_mut() = Some(new_wheel(view.clone(), time));
                crate::scroll::wheel_begin(surface, &view);
            }
            let view = {
                let mut wheel = input.wheel.borrow_mut();
                let Some(w) = wheel.as_mut() else {
                    return false;
                };
                w.total.0 += dx;
                w.total.1 += dy;
                w.velocity
                    .add(time, point(Points(w.total.0), Points(w.total.1)));
                w.view.clone()
            };
            crate::scroll::wheel(surface, &view, dx, dy);
            true
        }
        WheelInput::Stop => {
            let Some(mut w) = input.wheel.borrow_mut().take() else {
                return false;
            };
            w.velocity
                .add(time, point(Points(w.total.0), Points(w.total.1)));
            let (vx, vy) = w.velocity.velocity();
            crate::scroll::wheel_end(surface, &w.view, vx, vy);
            true
        }
    }
}

fn new_wheel(view: NshView, time: f64) -> Wheel {
    let mut velocity = VelocityTracker::default();
    velocity.add(time, point(Points(0.0), Points(0.0)));
    Wheel {
        view,
        total: (0.0, 0.0),
        velocity,
        held: false,
    }
}

/// Fingers resting on the touchpad stop a glide; lifting them without
/// scrolling ends that.
fn touchpad_hold(surface: &Rc<Surface>, phase: gdk::TouchpadGesturePhase, x: f32, y: f32) -> bool {
    let input = &surface.input;
    if phase == gdk::TouchpadGesturePhase::Begin {
        if input.wheel.borrow().is_some() {
            return false;
        }
        let Some(hit) = pick(&surface.root, x, y) else {
            return false;
        };
        let scroll = chain(&hit.view)
            .into_iter()
            .find(|v| v.kind() == ViewKind::Scroll);
        let Some(view) = scroll else {
            return false;
        };
        let mut wheel = new_wheel(view.clone(), 0.0);
        wheel.held = true;
        *input.wheel.borrow_mut() = Some(wheel);
        crate::scroll::wheel_begin(surface, &view);
        return true;
    }
    let held = input.wheel.borrow().as_ref().is_some_and(|w| w.held);
    if !held {
        return false;
    }
    if let Some(w) = input.wheel.borrow_mut().take() {
        crate::scroll::wheel_end(surface, &w.view, 0.0, 0.0);
    }
    true
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
    fn cursors() {
        assert_eq!(cursor_name(Cursor::Auto), None);
        assert_eq!(cursor_name(Cursor::Default), Some("default"));
        assert_eq!(cursor_name(Cursor::Pointer), Some("pointer"));
        assert_eq!(cursor_name(Cursor::NotAllowed), Some("not-allowed"));
    }

    #[test]
    fn wheel_notches_scale_with_the_view() {
        assert!((notch(1000.0) - 100.0).abs() < 0.01);
        assert_eq!(notch(0.0), 1.0);
    }
}
