//! Touches for Rust components: their `on_touch` handlers and the touch
//! responder ([`crate::element::TouchClaim`]), as `nsh-js` runs them for JS's
//! handlers (`touch.rs` there).
//!
//! The platform reports touches on the root, each finger with the nodes
//! around it that listen to touches (`TouchPoint::path`). The components'
//! nodes on that path hear them from the finger outwards, then the
//! responder is negotiated among them (React Native's rules: captures from
//! the outermost in, then from the finger outwards; once there is a
//! responder, only the nodes around it are asked, and it may keep the
//! touches). JS negotiates among its own nodes; both sides' responders
//! block native scroll views through the same command, which the core
//! sends for both ([`Core::block_native`]).

use super::Core;
use crate::{
    Command, EventKind, EventPayload, NodeId, ROOT_ID, TextEngine, TouchEvent, TouchPhase,
    TouchPoint,
    element::{
        ClaimRequest, Listener, PanGesture, ResponderEvent,
        responder::{ClaimPhase, ResponderEl},
    },
};

/// Whose responder blocks native scroll views.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Side {
    Js = 0,
    Rust = 1,
}

/// The touches the components hear and their responder.
#[derive(Default)]
pub(crate) struct TouchState {
    /// The components' listening nodes around each finger down, innermost
    /// first.
    paths: Vec<(u32, Vec<(NodeId, NodeId)>)>,
    responder: Option<(NodeId, NodeId)>,
    /// The responder whose `active:` styles hold until its touches end,
    /// wherever they go, as CSS's `:active` holds until the button is
    /// released ([`Core::hold_pressed`]).
    pub(super) pressed: Option<NodeId>,
    /// Since the first finger went down, then since the grant.
    gesture: PanGesture,
    /// The responders whose scroll views are blocked, by [`Side`].
    blocks: [Option<NodeId>; 2],
    /// The side that blocked last: it wins while both do.
    newest: usize,
}

impl TouchState {
    /// The responder whose scroll views are blocked.
    fn blocking(&self) -> Option<NodeId> {
        self.blocks[self.newest].or(self.blocks[1 - self.newest])
    }
}

/// Which listener of a responder an event goes to.
type Pick = fn(&ResponderEl) -> Option<&Listener<ResponderEvent>>;

impl<M: TextEngine> Core<M> {
    /// A touch event of the surface (`payload` is `touch`): the components'
    /// handlers on the finger's path, the negotiation, the responder's
    /// events.
    pub(super) fn touches(&mut self, payload: &EventPayload, touch: &TouchEvent) {
        let phase = touch.phase;
        let lifted = matches!(phase, TouchPhase::End | TouchPhase::Cancel);
        if phase == TouchPhase::Start {
            for p in touch.points.iter().filter(|p| p.changed) {
                let path: Vec<(NodeId, NodeId)> = p
                    .path
                    .iter()
                    .copied()
                    .flat_map(|id| {
                        self.touch_hosts(id)
                            .into_iter()
                            .flatten()
                            .map(move |host| (id, host))
                    })
                    .filter(|&(id, host)| self.hears_touches(id, host))
                    .collect();
                let paths = &mut self.components.touch.paths;
                paths.retain(|(finger, _)| *finger != p.id);
                if !path.is_empty() {
                    paths.push((p.id, path));
                }
            }
        }
        let down = touch
            .points
            .iter()
            .filter(|p| !lifted || !p.changed)
            .count();
        let state = &mut self.components.touch;
        match phase {
            // The gesture starts with the first finger.
            TouchPhase::Start if down == 1 => state.gesture = PanGesture::begin(touch),
            TouchPhase::Start | TouchPhase::Move => state.gesture.update(touch),
            TouchPhase::End | TouchPhase::Cancel => {}
        }
        let Some(about) = touch.points.iter().find(|p| p.changed) else {
            return;
        };
        let path = state
            .paths
            .iter()
            .find(|(finger, _)| *finger == about.id)
            .map(|(_, path)| path.clone())
            .unwrap_or_default();
        if path.is_empty() && state.responder.is_none() {
            self.forget_lifted(touch);
            return;
        }
        for &(id, host) in &path {
            let mut from = 0;
            while let Some((at, listener)) = self.next_handler(host, id, EventKind::Touch, from) {
                from = at + 1;
                if !self.run_listener(host, &listener, payload) {
                    break;
                }
            }
        }
        // A pan the platform activated: its element claims the touches.
        if let Some(id) = touch.activated {
            let responder = self.live_responder();
            let event = self.responder_event_now(about, touch);
            for host in self.touch_hosts(id).into_iter().flatten() {
                let target = (id, host);
                if responder != Some(target)
                    && let Some(block) = self.claims(target, ClaimPhase::Pan, false, event)
                {
                    self.take_over(target, block, responder, about, touch);
                    break;
                }
            }
        }
        match phase {
            TouchPhase::Start => self.negotiate(ClaimPhase::Start, &path, about, touch),
            TouchPhase::Move => self.negotiate(ClaimPhase::Move, &path, about, touch),
            TouchPhase::End | TouchPhase::Cancel => {}
        }
        if let Some(responder) = self.components.touch.responder {
            if phase == TouchPhase::Cancel {
                let event = self.responder_event_now(about, touch);
                self.responder_event(responder, |el| el.terminate.as_ref(), event);
                self.release_responder();
            } else {
                self.components.touch.gesture.update(touch);
                let event = self.responder_event_now(about, touch);
                let pick: Pick = match phase {
                    TouchPhase::Start => |el| el.start.as_ref(),
                    TouchPhase::Move => |el| el.moved.as_ref(),
                    _ => |el| el.end.as_ref(),
                };
                self.responder_event(responder, pick, event);
                if phase == TouchPhase::End && down == 0 {
                    self.release_responder();
                    self.responder_event(responder, |el| el.release.as_ref(), event);
                }
            }
        }
        self.forget_lifted(touch);
    }

    /// The fingers lifted in `touch` leave their paths.
    fn forget_lifted(&mut self, touch: &TouchEvent) {
        if matches!(touch.phase, TouchPhase::End | TouchPhase::Cancel) {
            self.components
                .touch
                .paths
                .retain(|(finger, _)| !touch.points.iter().any(|p| p.changed && p.id == *finger));
        }
    }

    /// The component's own root is inside the slot's listeners, even
    /// though both occupy the same platform node.
    fn touch_hosts(&self, id: NodeId) -> [Option<NodeId>; 2] {
        if self.is_host(id) {
            let own = self.base_of(id);
            let slot = self.adopted_host(id).filter(|&host| host != own);
            [Some(own), slot]
        } else {
            [
                self.host_of(id)
                    .or_else(|| self.components.slot_hosts.get(&id).copied())
                    .or_else(|| self.adopted_host(id)),
                None,
            ]
        }
    }

    fn hears_touches(&self, id: NodeId, host: NodeId) -> bool {
        self.next_handler(host, id, EventKind::Touch, 0).is_some()
            || self.responder_el(host, id).is_some()
    }

    fn responder_event_now(&self, about: &TouchPoint, touch: &TouchEvent) -> ResponderEvent {
        ResponderEvent::new(about, touch.timestamp, self.components.touch.gesture)
    }

    /// Asks the nodes of `path` (innermost first) whether one claims the
    /// touches in `phase`: the nodes around both the finger and the
    /// current responder, the responder excluded.
    fn negotiate(
        &mut self,
        phase: ClaimPhase,
        path: &[(NodeId, NodeId)],
        about: &TouchPoint,
        touch: &TouchEvent,
    ) {
        let responder = self.live_responder();
        let mut from = 0;
        if let Some(r) = responder {
            let around = |(id, _): (NodeId, NodeId)| match (self.key(id), self.key(r.0)) {
                (Ok(a), Ok(k)) => self.is_ancestor(a, k),
                _ => false,
            };
            while from < path.len() && !around(path[from]) {
                from += 1;
            }
            if let Some(at) = path[from..].iter().position(|&target| target == r) {
                from += at + 1;
            }
        }
        let asked = &path[from.min(path.len())..];
        let event = self.responder_event_now(about, touch);
        let mut wanting = None;
        for &id in asked.iter().rev() {
            if let Some(block) = self.claims(id, phase, true, event) {
                wanting = Some((id, block));
                break;
            }
        }
        if wanting.is_none() {
            for &id in asked {
                if let Some(block) = self.claims(id, phase, false, event) {
                    wanting = Some((id, block));
                    break;
                }
            }
        }
        let Some((wanting, block)) = wanting else {
            return;
        };
        if Some(wanting) == responder {
            return;
        }
        self.take_over(wanting, block, responder, about, touch);
    }

    /// The responder, if its node still exists.
    fn live_responder(&self) -> Option<(NodeId, NodeId)> {
        self.components.touch.responder.filter(|&(id, host)| {
            self.key(id).is_ok() && self.components.instances.contains_key(&host)
        })
    }

    /// Node `wanting` claimed the touches from `responder`: it becomes the
    /// responder unless the responder keeps them.
    fn take_over(
        &mut self,
        wanting: (NodeId, NodeId),
        block: bool,
        responder: Option<(NodeId, NodeId)>,
        about: &TouchPoint,
        touch: &TouchEvent,
    ) {
        let event = self.responder_event_now(about, touch);
        if let Some(r) = responder {
            let keeps = self.responder_el(r.1, r.0).is_some_and(|el| el.keep);
            if keeps {
                self.responder_event(wanting, |el| el.reject.as_ref(), event);
                return;
            }
            self.responder_event(r, |el| el.terminate.as_ref(), event);
        }
        self.grant(wanting, block, about, touch);
    }

    /// Whether node `id` claims the touches in `phase` (its claims of that
    /// kind, in order): with whether it blocks native scroll views. An
    /// element waiting for its pan ([`crate::element::TouchClaim::on_pan`]) only
    /// claims when the platform activates it.
    fn claims(
        &mut self,
        (id, host): (NodeId, NodeId),
        phase: ClaimPhase,
        capture: bool,
        event: ResponderEvent,
    ) -> Option<bool> {
        let el = self.responder_el(host, id)?;
        let gated = el.claims.iter().any(|c| c.phase == ClaimPhase::Pan);
        if gated != (phase == ClaimPhase::Pan) {
            return None;
        }
        for claim in el
            .claims
            .iter()
            .filter(|c| c.phase == phase && (gated || c.capture == capture))
        {
            match &claim.ask {
                None => return Some(claim.block_native),
                Some(ask) => {
                    let request = ClaimRequest::new(event);
                    self.run_listener(host, ask, &request);
                    if request.claimed() {
                        return Some(claim.block_native);
                    }
                }
            }
        }
        None
    }

    /// Node `id` becomes the responder; the gesture starts again here.
    fn grant(
        &mut self,
        target: (NodeId, NodeId),
        block: bool,
        about: &TouchPoint,
        touch: &TouchEvent,
    ) {
        let id = target.0;
        let state = &mut self.components.touch;
        state.responder = Some(target);
        state.gesture = PanGesture::begin(touch);
        self.hold_pressed(Some(id));
        let event = self.responder_event_now(about, touch);
        self.responder_event(target, |el| el.grant.as_ref(), event);
        self.block_native(Side::Rust, block.then_some(id));
    }

    fn release_responder(&mut self) {
        self.components.touch.responder = None;
        self.hold_pressed(None);
        self.block_native(Side::Rust, None);
    }

    /// Runs the listener `pick` chooses of node `id`'s responder part.
    fn responder_event(&mut self, (id, host): (NodeId, NodeId), pick: Pick, event: ResponderEvent) {
        let Some(el) = self.responder_el(host, id) else {
            return;
        };
        if let Some(listener) = pick(&el) {
            self.run_listener(host, listener, &event);
        }
    }

    /// `side`'s responder `node` blocks native scroll views around it (or
    /// none does). The platform blocks around one responder at a time:
    /// the one that blocked last, while the other side's goes on.
    pub(super) fn block_native(&mut self, side: Side, node: Option<NodeId>) {
        let state = &mut self.components.touch;
        let before = state.blocking();
        state.blocks[side as usize] = node;
        if node.is_some() {
            state.newest = side as usize;
        }
        let after = state.blocking();
        if after == before {
            return;
        }
        self.commands.push(match after {
            Some(id) => (id, Command::SetJsResponder { block: true }),
            None => (ROOT_ID, Command::ClearJsResponder),
        });
    }
}
