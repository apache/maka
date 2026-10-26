//! The pointer's steps: `drag(<selector>, <x>, <y>)`, a finger that lands
//! on a view, moves and lifts, and `hover(<selector>)`, the mouse coming
//! over a view; the app hears what a platform's pointer input makes of
//! them. The decisions are nsh-core's `input`, the desktop backends' own:
//! the views listening to touches hear them (the JS responder), a pan or a
//! scroll view takes the drag once it passes the slop, unless the
//! responder holds it, and the press under the finger is cancelled once
//! the finger moves away.

use std::sync::Arc;

use nsh_core::{
    EventKind, EventPayload, NodeId, Point, Points, ROOT_ID, TouchEvent, TouchPhase, TouchPoint,
    geometry::point,
    input::{
        self, Candidate, Gate, Grab, GrabOptions, PAN_SLOP, PRESS_RETENTION, PRESS_SLOP,
        SCROLL_PRESS_DELAY, VelocityTracker,
    },
};

use super::Headless;
use crate::{screen::Contact, selector::Selector};

/// How far a finger moves in one display frame, as a scroll's does.
const DRAG_STEP: Points = Points(10.0);
/// How long the finger rests where it lands before it moves, as a hand
/// does (the agents' `LANDING`): the views under it hear it land first.
const LANDING: f64 = 100.0;

/// What the drag does.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    /// Nothing started yet.
    Idle,
    /// Nothing native will: the responder took the touches, or the drag
    /// went past the slop with nothing to start.
    Free,
    /// A pan of the view.
    Pan(NodeId),
    /// The scroll view, dragged from its offset then and the finger there.
    Scroll(NodeId, Points, Point<Points>),
}

/// The finger.
struct Finger {
    start: Point<Points>,
    at: Point<Points>,
    /// Milliseconds since the drag began.
    time: f64,
    velocity: VelocityTracker,
    contact: Arc<Contact>,
    /// Where the target's bounds start in the root, for touches' locations.
    origin: Point<Points>,
    path: Vec<NodeId>,
    candidates: Vec<(NodeId, Candidate)>,
    gate: Option<Gate>,
    press: Option<input::Press<NodeId>>,
    mode: Mode,
    moved: bool,
}

impl Headless {
    /// The step `drag(<selector>, <by>)`: a finger lands on the middle of
    /// the view `selector` names, rests there for 100 ms, moves by `by`
    /// points, 10 points per display frame, and lifts at once (still
    /// moving). What takes the drag
    /// is what a platform's input would give it to (nsh-core `input`): the
    /// views listening to touches hear `onTouch` (the JS responder system),
    /// a pan hears `onPanStart` and `onPanEnd` and moves its `pan` values,
    /// a scroll view scrolls with the finger and refreshes when it is
    /// pulled far enough past its top, and the press under the finger is
    /// cancelled once it moves away (`onPressUp`, no `onPress`).
    pub fn drag(&mut self, selector: &str, by: Point<Points>) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("drag({selector}, {}, {})", by.x, by.y));
        let pick = self.screen.view(&parsed);
        let target = self.picked(pick, selector, "view")?;
        let bounds = self
            .screen
            .bounds_in_root(target)
            .ok_or_else(|| format!("`{selector}` is not on screen"))?;
        let start = bounds.center();
        let chain = self.screen.chain(target);
        // A finger going down ends what a responder held before.
        self.screen.reset_js_block();
        let mut grab = Grab::default();
        let options = GrabOptions::new(true, false, false, true);
        for &id in &chain {
            if let Some(link) = self.screen.link(id) {
                grab.add(&id, &link, options);
            }
        }
        let Grab {
            path,
            candidates,
            in_scroll,
            gate,
            ..
        } = grab;
        let press = self
            .screen
            .press_in_chain(&chain)
            .map(|(node, events, delay)| input::Press::new(node, node, events, delay, 0));
        let mut owners = candidates.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        owners.extend(press.as_ref().map(|press| press.node));
        owners.extend(path.iter().copied());
        if gate.is_some() {
            owners.extend(chain.iter().copied().find(|id| {
                self.screen
                    .link(*id)
                    .is_some_and(|link| link.pan_activation.is_some())
            }));
        }
        let contact = self
            .screen
            .begin_contact(1, target, owners, !path.is_empty());
        let mut finger = Finger {
            start,
            at: start,
            time: 0.0,
            velocity: VelocityTracker::default(),
            contact,
            origin: bounds.origin,
            path,
            candidates,
            gate,
            press,
            mode: Mode::Idle,
            moved: false,
        };
        finger.velocity.add(0.0, start);
        if finger.contact.reporting() {
            self.touch(TouchPhase::Start, &finger, None);
        }
        // Inside a scroll view a touch presses only once it rests: a drag
        // moves away before.
        let mut press_due = if in_scroll {
            Some(SCROLL_PRESS_DELAY as f64)
        } else {
            self.press_in(&mut finger);
            None
        };
        let frame = super::animation::FRAME.as_secs_f64() * 1000.0;
        while finger.time + frame <= LANDING {
            self.display_frame();
            if self.retired_finger(&mut finger) {
                self.screen.end_contact(&finger.contact);
                return self.done();
            }
            finger.time += frame;
            if press_due.is_some_and(|due| finger.time >= due) {
                press_due = None;
                self.press_in(&mut finger);
            }
        }
        let steps = (by.x.abs().max(by.y.abs()) / DRAG_STEP).ceil().max(1.0) as u32;
        for step in 1..=steps {
            self.display_frame();
            if self.retired_finger(&mut finger) {
                self.screen.end_contact(&finger.contact);
                return self.done();
            }
            finger.time += frame;
            if press_due.is_some_and(|due| finger.time >= due) {
                press_due = None;
                self.press_in(&mut finger);
            }
            let t = step as f32 / steps as f32;
            let at = point(start.x + by.x * t, start.y + by.y * t);
            self.finger_moved(&mut finger, at);
            self.responder_granted(&mut finger);
        }
        self.finger_lifted(finger);
        self.done()
    }

    /// A detached original target revokes its contact. A native scroll or
    /// pan already captured by a surviving ancestor may finish normally.
    fn retired_finger(&mut self, finger: &mut Finger) -> bool {
        if finger.contact.active() {
            return false;
        }
        // Its old owner is gone: even an Up would reach replacement content.
        finger.press = None;
        finger.candidates.clear();
        finger.gate = None;
        match finger.mode {
            Mode::Pan(view) | Mode::Scroll(view, ..) => finger.contact.native_owner() != Some(view),
            Mode::Idle | Mode::Free => true,
        }
    }

    /// The finger moved to `at`, as a platform's pointer move goes.
    fn finger_moved(&mut self, finger: &mut Finger, at: Point<Points>) {
        finger.at = at;
        finger.velocity.add(finger.time, at);
        let first = !std::mem::replace(&mut finger.moved, true);
        let (tx, ty) = (at.x - finger.start.x, at.y - finger.start.y);
        let activated = Gate::step(&mut finger.gate, &mut finger.candidates, tx, ty);
        // The view's JS responder takes the drag over: nothing native
        // starts meanwhile.
        if activated.is_some() && finger.mode == Mode::Idle {
            finger.mode = Mode::Free;
        }
        if finger.contact.reporting() {
            self.touch(TouchPhase::Move, finger, activated);
        }
        let distance = Points(tx.0.hypot(ty.0));
        // JS hears of the first move only now: its responder gets a chance
        // to take the gesture before a native drag starts.
        let js_pending = finger.contact.reporting() && first;
        if finger.mode == Mode::Idle && distance > PAN_SLOP && !js_pending {
            if finger.gate.is_none() {
                finger.mode = Mode::Free;
            }
            let started = if self.screen.js_block() {
                None
            } else {
                input::startable(&finger.candidates, finger.gate.as_ref(), tx, ty).cloned()
            };
            match started {
                Some((view, Candidate::Pan { .. })) => {
                    finger.gate = None;
                    self.pan_start(view, finger);
                    finger.contact.capture_native(view);
                    finger.mode = Mode::Pan(view);
                }
                Some((view, Candidate::Scroll { .. })) => {
                    // The scroll view takes the touches over from JS.
                    if finger.contact.reporting() {
                        self.touch(TouchPhase::Cancel, finger, None);
                        finger.contact.stop_reporting();
                    }
                    finger.gate = None;
                    let from = self.scroll_offset(view);
                    self.send(view, EventKind::ScrollDragStart, self.scroll_payload(view));
                    finger.contact.capture_native(view);
                    finger.mode = Mode::Scroll(view, from, at);
                }
                None => {}
            }
        }
        if matches!(finger.mode, Mode::Pan(_) | Mode::Scroll(..)) || distance > PRESS_SLOP {
            self.cancel_press(finger);
        }
        match finger.mode {
            Mode::Pan(view) => self.animator.pan_moved(view, point(tx, ty)),
            Mode::Scroll(view, from, origin) => {
                let along = if self.scroll_horizontal(view) {
                    origin.x - at.x
                } else {
                    origin.y - at.y
                };
                self.scroll_dragged(view, from + along);
            }
            Mode::Idle | Mode::Free => {}
        }
    }

    /// What a JS responder granted since the last frame does to the drag:
    /// it takes over from the press, and a blocking one ends the pan.
    fn responder_granted(&mut self, finger: &mut Finger) {
        for block in self.screen.take_js_grants() {
            if finger.moved {
                self.cancel_press(finger);
            }
            if block && let Mode::Pan(view) = finger.mode {
                self.pan_end(view, finger);
                finger.contact.capture_native(0);
                finger.mode = Mode::Free;
            }
        }
    }

    /// The finger lifted: ends what it did.
    fn finger_lifted(&mut self, mut finger: Finger) {
        if self.retired_finger(&mut finger) {
            self.screen.end_contact(&finger.contact);
            return;
        }
        if finger.contact.reporting() {
            self.touch(TouchPhase::End, &finger, None);
        }
        match finger.mode {
            Mode::Pan(view) => {
                let (tx, ty) = (finger.at.x - finger.start.x, finger.at.y - finger.start.y);
                self.animator.pan_moved(view, point(tx, ty));
                self.pan_end(view, &finger);
            }
            Mode::Scroll(view, ..) => self.scroll_released(view),
            Mode::Idle | Mode::Free => {
                if let Some(mut press) = finger.press.take() {
                    // A quick tap inside a scroll view: the press goes in now.
                    if let Some(kind) = press.press_in() {
                        self.send(press.node, kind, EventPayload::None);
                    }
                    let inside = self.screen.bounds_in_root(press.view).is_some_and(|b| {
                        let r = PRESS_RETENTION;
                        finger.at.x >= b.origin.x - r
                            && finger.at.y >= b.origin.y - r
                            && finger.at.x <= b.origin.x + b.size.width + r
                            && finger.at.y <= b.origin.y + b.size.height + r
                    });
                    for kind in press.press_out(inside) {
                        self.send(press.node, kind, EventPayload::None);
                    }
                }
            }
        }
        self.screen.end_contact(&finger.contact);
    }

    /// The press under the finger goes in (`onPressDown`).
    fn press_in(&mut self, finger: &mut Finger) {
        if let Some(press) = &mut finger.press
            && let Some(kind) = press.press_in()
        {
            self.send(press.node, kind, EventPayload::None);
        }
    }

    /// The finger moved away from its press: it ends without a press.
    fn cancel_press(&mut self, finger: &mut Finger) {
        if let Some(mut press) = finger.press.take() {
            for kind in press.press_out(false) {
                self.send(press.node, kind, EventPayload::None);
            }
        }
    }

    /// Sends the finger's touch of `phase` to the views listening to
    /// touches (the root hands it to the JS responder system).
    fn touch(&mut self, phase: TouchPhase, finger: &Finger, activated: Option<NodeId>) {
        let event = TouchEvent {
            phase,
            timestamp: finger.time,
            points: vec![TouchPoint {
                id: finger.contact.id,
                target: finger.contact.target,
                // JS keeps a finger's path from its start.
                path: if phase == TouchPhase::Start {
                    finger.path.clone()
                } else {
                    Vec::new()
                },
                page: finger.at,
                location: point(finger.at.x - finger.origin.x, finger.at.y - finger.origin.y),
                changed: true,
            }],
            activated,
        };
        self.engine.control().dispatch_event(
            ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(Box::new(event)),
        );
    }

    fn pan_payload(
        &self,
        view: NodeId,
        translation: Point<Points>,
        finger: &Finger,
    ) -> EventPayload {
        let (value_x, value_y) = self.animator.pan_values(view);
        let (velocity_x, velocity_y) = finger.velocity.velocity();
        EventPayload::Pan {
            translation,
            velocity_x,
            velocity_y,
            value_x: value_x.map(Points),
            value_y: value_y.map(Points),
        }
    }

    fn pan_start(&mut self, view: NodeId, finger: &Finger) {
        self.animator.pan_began(view);
        let payload = self.pan_payload(view, Point::default(), finger);
        self.send(view, EventKind::PanStart, payload);
    }

    fn pan_end(&mut self, view: NodeId, finger: &Finger) {
        let translation = point(finger.at.x - finger.start.x, finger.at.y - finger.start.y);
        let payload = self.pan_payload(view, translation, finger);
        self.send(view, EventKind::PanEnd, payload);
    }

    fn scroll_horizontal(&self, view: NodeId) -> bool {
        self.screen.scroll(view).is_some_and(|s| s.horizontal)
    }

    fn scroll_offset(&self, view: NodeId) -> Points {
        self.screen
            .scroll(view)
            .map_or(Points::ZERO, |s| if s.horizontal { s.x } else { s.y })
    }

    fn scroll_payload(&self, view: NodeId) -> EventPayload {
        let s = self.screen.scroll(view);
        EventPayload::Scroll(s.map_or(Point::default(), |s| point(s.x, s.y)))
    }

    /// The finger dragged the scroll view to `raw` along its axis: within
    /// its content, or past its top only as far as a pull to refresh
    /// rubber-bands it when it listens to `onRefresh`.
    fn scroll_dragged(&mut self, view: NodeId, raw: Points) {
        let end = self.screen.scroll_end(view);
        let pulls = !self.scroll_horizontal(view) && self.screen.hears(view, EventKind::Refresh);
        let dim = self
            .screen
            .bounds_in_root(view)
            .map_or(Points::ZERO, |b| b.size.height);
        let offset = if pulls && raw < Points::ZERO {
            nsh_core::scroll::dragged(raw, Points::ZERO, end, dim, true)
        } else {
            raw.clamp(Points::ZERO, end)
        };
        self.scroll_to(view, offset);
    }

    /// Lifting the finger off the scroll view: it ends its drag, refreshes
    /// when pulled far enough past its top, and settles within its content.
    fn scroll_released(&mut self, view: NodeId) {
        let offset = self.scroll_offset(view);
        self.send(view, EventKind::ScrollDragEnd, self.scroll_payload(view));
        if !self.scroll_horizontal(view)
            && self.screen.hears(view, EventKind::Refresh)
            && self
                .screen
                .scroll(view)
                .is_some_and(|s| s.behavior.refreshes(offset))
        {
            self.send(view, EventKind::Refresh, EventPayload::None);
        }
        if offset < Points::ZERO {
            self.scroll_to(view, Points::ZERO);
        }
        self.animator.scroll_ended(view);
        self.send(view, EventKind::ScrollEnd, self.scroll_payload(view));
    }

    /// Moves the scroll view's offset along its axis to `offset`, as its
    /// platform view reports it.
    fn scroll_to(&mut self, view: NodeId, offset: Points) {
        let Some(scroll) = self.screen.scroll_mut(view) else {
            return;
        };
        if scroll.horizontal {
            scroll.x = offset;
        } else {
            scroll.y = offset;
        }
        let (x, y, applied, horizontal) = (scroll.x, scroll.y, scroll.applied, scroll.horizontal);
        self.engine.control().scroll(view, point(x, y), applied);
        self.animator.scrolled(view, point(x, y));
        if !horizontal {
            self.animator.pulled(view, Points((-y.0).max(0.0)));
        }
    }

    /// The step `hover(<selector>)`: the mouse comes over the middle of the
    /// view `selector` names, as on a desktop (`open`'s `platform`): the
    /// views under it that it left hear `onHoverOut` (from the inside out),
    /// those it came over `onHoverIn` (from the outside in) and take their
    /// `hover:` styles, and the ones listening to `onHoverMove` hear where
    /// it is. A browser has one whatever its width (the web in the phone
    /// idiom included); an iOS or Android phone or tablet has none: there
    /// it fails.
    pub fn hover(&mut self, selector: &str) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("hover({selector})"));
        if !self.environment.desktop() && self.environment.os != nsh_core::platform::Os::Web {
            return Err(
                "a phone has no mouse to hover with: open the app as a desktop or the web (`platform`)"
                    .into(),
            );
        }
        let pick = self.screen.view(&parsed);
        let target = self.picked(pick, selector, "view")?;
        let bounds = self
            .screen
            .bounds_in_root(target)
            .ok_or_else(|| format!("`{selector}` is not on screen"))?;
        let at = bounds.center();
        let views = self.screen.hoverable(&self.screen.chain(target));
        let old = self.screen.set_hovered(views.clone());
        let (left, entered) = input::hover_changes(&old, &views);
        let (left, entered): (Vec<NodeId>, Vec<NodeId>) =
            (left.copied().collect(), entered.copied().collect());
        let control = self.engine.control();
        for id in left {
            if let Some(states) =
                self.screen
                    .set_state(id, nsh_core::tailwind::state::HOVERED, false)
            {
                control.set_states(id, states);
            }
            self.send(id, EventKind::HoverOut, EventPayload::None);
        }
        for id in entered {
            if let Some(states) =
                self.screen
                    .set_state(id, nsh_core::tailwind::state::HOVERED, true)
            {
                control.set_states(id, states);
            }
            self.send(id, EventKind::HoverIn, EventPayload::None);
        }
        for id in views {
            let origin = self
                .screen
                .bounds_in_root(id)
                .map_or(Point::default(), |b| b.origin);
            let event = nsh_core::HoverEvent {
                position: point(at.x - origin.x, at.y - origin.y),
                page_position: at,
                modifiers: nsh_core::keymap::Modifiers::default(),
            };
            self.send(id, EventKind::HoverMove, EventPayload::Hover(event));
        }
        self.done()
    }
}
