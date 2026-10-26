//! What a Rust component gives a slot the app fills from TSX
//! (`props.trigger.place(|t| t.on_press(..))`), and where it goes.
//!
//! JS makes a holder view per slot the app passes (`componentSlot`), whose
//! children are the app's JSX. The slot's element styles that holder: its
//! box in the component's layout. Everything else the element gives (its
//! accessibility, `disabled`, `focusable` and other host props, listeners,
//! touch responder and element ref: [`split`]) goes to the app's element
//! when the holder holds exactly one (any element but raw text, a
//! component's host or a list: [`Core::slot_target_of`]), else to the
//! holder. So the app's `active:`, `focus:` and `disabled:` classes and
//! state styles on its own element follow the presses, focus and
//! `disabled` the component gives it, and a ref the component anchors a
//! popup to measures the app's element.
//!
//! On the app's element the two sides combine ([`merged`]): what the
//! component sets wins and the app's props fill in the rest, field by
//! field (`accessibilityState`'s one by one); `disabled`, the state flags
//! and the projected states hold when either side sets them. Both sides'
//! listeners run, the component's first (the core's dispatch comes before
//! JS's). JS's ops on the element go through the core
//! ([`Core::js_slot_prop`]), which keeps JS's own values and sends the
//! combination; when the component stops giving the element its props (the
//! element leaves the holder, another joins it, the slot or the component
//! goes), JS's values come back. JS's values from before the element became
//! the slot's are read from its node: its accessibility, `disabled`,
//! `pointerEvents`, `focusable` and projected states (another host prop
//! the component sets too goes back to its default when the component
//! drops it, unless JS set it since).
//!
//! The bindings of the slot's element are live, as on the component's own
//! nodes ([`Core::bind_parts`]): their patches ([`super::views::Patch`])
//! reach the holder and the app's element the same way.

use super::{Core, Kind, components::Instance};
use crate::{
    EventKind, EventMask, NodeId, Op, Prop, TextEngine,
    element::{Attrs, ElNode, SharedString},
    props::{AccessibilityProp, AccessibilityRole, AccessibilityState, PointerEvents},
    tailwind::state,
};

/// Where the non-style part of a slot's element is ([`split`]), and what
/// was applied there.
pub(super) struct SlotTarget {
    /// The component whose slot it is.
    host: NodeId,
    /// The node it is on: the holder's one element, else the holder.
    node: NodeId,
    /// The component's part, as applied.
    own: Attrs,
    /// The events the component listens to on it.
    events: EventMask,
    /// JS's own props on `node` that combine with the component's (none on
    /// the holder).
    js: Attrs,
    /// The events JS listens to on `node`.
    js_events: EventMask,
}

/// `attrs` of a slot's element as (the holder's, the target's): the
/// styles and what shapes the holder's box stay on the holder.
pub(super) fn split(attrs: &Attrs) -> (Attrs, Attrs) {
    let target = Attrs {
        disabled: attrs.disabled,
        accessible: attrs.accessible,
        label: attrs.label.clone(),
        hint: attrs.hint.clone(),
        role: attrs.role,
        state: attrs.state,
        value: attrs.value.clone(),
        pointer_events: attrs.pointer_events,
        props: attrs.props.clone(),
        element_ref: attrs.element_ref.clone(),
        bound: attrs.bound.clone(),
        projected_states: attrs.projected_states,
        ..Attrs::default()
    };
    let holder = Attrs {
        inline: attrs.inline.clone(),
        animated: attrs.animated.clone(),
        class: attrs.class.clone(),
        inset_padding: attrs.inset_padding,
        inset_margin: attrs.inset_margin,
        number_of_lines: attrs.number_of_lines,
        src: attrs.src.clone(),
        drawing: attrs.drawing.clone(),
        selectable_view: attrs.selectable_view,
        render: attrs.render.clone(),
        ..Attrs::default()
    };
    (holder, target)
}

/// The props of the app's element: the component's `own` over JS's `js`.
pub(super) fn merged(js: &Attrs, own: &Attrs) -> Attrs {
    let mut props = own.props.clone();
    props.extend(
        js.props
            .iter()
            .filter(|p| {
                !own.props
                    .iter()
                    .any(|o| crate::element::host::same_kind(o, p))
            })
            .cloned(),
    );
    Attrs {
        disabled: own.disabled || js.disabled,
        accessible: own.accessible.or(js.accessible),
        label: own.label.clone().or_else(|| js.label.clone()),
        hint: own.hint.clone().or_else(|| js.hint.clone()),
        role: if own.role == AccessibilityRole::None {
            js.role
        } else {
            own.role
        },
        state: AccessibilityState {
            disabled: own.state.disabled || js.state.disabled,
            selected: own.state.selected || js.state.selected,
            checked: own.state.checked.or(js.state.checked),
            busy: own.state.busy || js.state.busy,
            expanded: own.state.expanded.or(js.state.expanded),
        },
        value: own.value.clone().or_else(|| js.value.clone()),
        pointer_events: if own.pointer_events == PointerEvents::default() {
            js.pointer_events
        } else {
            own.pointer_events
        },
        props,
        element_ref: own.element_ref.clone(),
        bound: own.bound.clone(),
        projected_states: own.projected_states | js.projected_states,
        ..Attrs::default()
    }
}

/// What JS's `prop` changes of its side of the combined props, if it is
/// one of them (false: it passes as it is).
fn absorb(js: &mut Attrs, prop: &Prop) -> bool {
    use AccessibilityProp as A;
    match prop {
        Prop::Native(crate::NativeProp::Disabled(d)) => js.disabled = *d,
        Prop::Accessibility(A::Accessible(v)) => js.accessible = *v,
        Prop::Accessibility(A::Label(v)) => js.label = v.clone().map(SharedString::from),
        Prop::Accessibility(A::Hint(v)) => js.hint = v.clone().map(SharedString::from),
        Prop::Accessibility(A::Role(v)) => js.role = *v,
        Prop::Accessibility(A::State(v)) => js.state = *v,
        Prop::Accessibility(A::Value(v)) => js.value = v.clone(),
        Prop::PointerEvents(v) => js.pointer_events = *v,
        Prop::ProjectedStates(v) => js.projected_states = *v,
        p if crate::element::host::reset(p).is_some() => {
            crate::element::host::set_in(&mut js.props, p.clone())
        }
        _ => return false,
    }
    true
}

impl<M: TextEngine> Core<M> {
    /// The node slot holder `holder`'s props go to: its one element, else
    /// itself (no child, several, raw text, a component's host, a slot or
    /// a render's holder; a list's cells are its rows, never a target).
    pub(super) fn slot_target_of(&self, holder: NodeId) -> NodeId {
        let Ok(k) = self.key(holder) else {
            return holder;
        };
        if self.nodes[k as usize].kind == Kind::List {
            return holder;
        }
        let [child] = self.nodes[k as usize].children[..] else {
            return holder;
        };
        let node = &self.nodes[child as usize];
        let id = node.id;
        if node.kind == Kind::RawText
            || self.is_host(id)
            || self.components.slot_hosts.contains_key(&id)
            || self.is_render_holder(id)
        {
            return holder;
        }
        id
    }

    /// The component whose slot's props app element `id` has.
    pub(super) fn adopted_host(&self, id: NodeId) -> Option<NodeId> {
        let holder = self.components.adopted.get(&id)?;
        self.components.slot_targets.get(holder).map(|t| t.host)
    }

    /// JS's own props of app element `id` that combine with a component's,
    /// read from its node, and the events JS listens to on it.
    fn js_side(&self, id: NodeId) -> (Attrs, EventMask) {
        let Ok(key) = self.key(id) else {
            return (Attrs::default(), EventMask::default());
        };
        let node = &self.nodes[key as usize];
        let mut js = Attrs {
            disabled: node.states & state::DISABLED != 0,
            projected_states: node.projected,
            ..Attrs::default()
        };
        if let Some(props) = &node.props {
            let a = &props.accessibility;
            js.accessible = a.accessible;
            js.label = a.label.clone().map(SharedString::from);
            js.hint = a.hint.clone().map(SharedString::from);
            js.role = a.role;
            js.state = a.state;
            js.value = a.value.clone();
            js.pointer_events = props.pointer_events;
            if props.focusable.is_some() {
                js.props.push(Prop::Focusable(props.focusable));
            }
        }
        (js, node.events)
    }

    /// Applies the slot element's attributes `new` (its last ones `old`)
    /// to slot holder `holder` of `host`'s view: its styles' part to the
    /// holder, the rest to the slot's target. `inst` is `host`'s instance
    /// when it is out of the instances (its view being reconciled).
    pub(super) fn apply_slot_attrs(
        &mut self,
        holder: NodeId,
        host: NodeId,
        new: &Attrs,
        old: &Attrs,
        inst: Option<&mut Instance>,
    ) {
        let (holder_new, own) = split(new);
        let (holder_old, _) = split(old);
        self.apply_attrs(holder, &holder_new, &holder_old);
        if own == Attrs::default() && !self.components.slot_targets.contains_key(&holder) {
            return;
        }
        self.ensure_slot_target(holder, host, inst);
        let Some(target) = self.components.slot_targets.get_mut(&holder) else {
            return;
        };
        let before = merged(&target.js, &target.own);
        let after = merged(&target.js, &own);
        target.own = own;
        let node = target.node;
        self.apply_attrs(node, &after, &before);
    }

    /// Gives the slot's target the handlers and touch responder of the
    /// slot element `el` (`holder`'s, of `host`'s view): the component's,
    /// replacing those it gave it last. The events the component listens
    /// to there.
    pub(super) fn apply_slot_handlers(
        &mut self,
        holder: NodeId,
        host: NodeId,
        el: &ElNode,
        inst: &mut Instance,
    ) -> EventMask {
        if el.handlers.is_empty()
            && el.responder.is_none()
            && !self.components.slot_targets.contains_key(&holder)
        {
            return EventMask::default();
        }
        self.ensure_slot_target(holder, host, Some(&mut *inst));
        let Some(target) = self.components.slot_targets.get_mut(&holder) else {
            return EventMask::default();
        };
        let node = target.node;
        inst.handlers.retain(|(n, _, _)| *n != node && *n != holder);
        inst.responders.retain(|(n, _)| *n != node && *n != holder);
        let mut mask = EventMask::default();
        for (kind, handler) in &el.handlers {
            mask.set(*kind, true);
            inst.handlers.push((node, *kind, handler.clone()));
        }
        if let Some(responder) = &el.responder {
            mask.set(EventKind::Touch, true);
            inst.responders.push((node, responder.clone()));
        }
        let old = std::mem::replace(&mut target.events, mask);
        let js = target.js_events;
        self.listen_changes(node, old, mask, js);
        mask
    }

    /// Sends the events that change on `node` as the component's go from
    /// `old` to `new`, JS listening to `js`.
    fn listen_changes(&mut self, node: NodeId, old: EventMask, new: EventMask, js: EventMask) {
        let mut changed = (old.bits() ^ new.bits()) & !js.bits();
        while changed != 0 {
            let kind = EventKind::ALL[changed.trailing_zeros() as usize];
            changed &= changed - 1;
            let _ = self.apply_op(Op::Listen {
                id: node,
                event: kind,
                enabled: new.contains(kind),
            });
        }
    }

    /// Makes `holder`'s target record if it has none, then follows the
    /// holder's content.
    fn ensure_slot_target(&mut self, holder: NodeId, host: NodeId, inst: Option<&mut Instance>) {
        self.components
            .slot_targets
            .entry(holder)
            .or_insert_with(|| SlotTarget {
                host,
                node: holder,
                own: Attrs::default(),
                events: EventMask::default(),
                js: Attrs::default(),
                js_events: EventMask::default(),
            });
        self.retarget_slot(holder, inst);
    }

    /// Moves what the component gives slot `holder`'s target to the node
    /// that is its target now (the holder's content changed): the node it
    /// leaves gets JS's own props and listeners back, the one it joins
    /// combines them with the component's. `inst` as in
    /// [`Self::apply_slot_attrs`].
    pub(super) fn retarget_slot(&mut self, holder: NodeId, inst: Option<&mut Instance>) {
        let Some(target) = self.components.slot_targets.get(&holder) else {
            return;
        };
        let new = self.slot_target_of(holder);
        if new == target.node {
            return;
        }
        let old = target.node;
        let host = target.host;
        self.leave_slot_target(holder);
        let (js, js_events) = if new == holder {
            (Attrs::default(), EventMask::default())
        } else {
            self.components.adopted.insert(new, holder);
            self.js_side(new)
        };
        let target = self
            .components
            .slot_targets
            .get_mut(&holder)
            .expect("a slot's target");
        target.node = new;
        target.js = js;
        target.js_events = js_events;
        // The node has JS's own props: the component's join them.
        let (applied, js, events) = (
            merged(&target.js, &target.own),
            target.js.clone(),
            target.events,
        );
        self.apply_attrs(new, &applied, &js);
        self.listen_changes(new, EventMask::default(), events, js_events);
        // Its handlers follow it.
        let handlers = match inst {
            Some(inst) => Some(inst),
            None => self.components.instances.get_mut(&host).map(|i| &mut **i),
        };
        if let Some(inst) = handlers {
            for (n, _, _) in &mut inst.handlers {
                if *n == old {
                    *n = new;
                }
            }
            for (n, _) in &mut inst.responders {
                if *n == old {
                    *n = new;
                }
            }
        }
    }

    /// The component's part leaves `holder`'s target node: JS's own props
    /// and listeners come back to it (when it is still there). The record
    /// stays, on no node until it is given one.
    fn leave_slot_target(&mut self, holder: NodeId) {
        let Some(target) = self.components.slot_targets.get(&holder) else {
            return;
        };
        let (node, js, js_events, events) = (
            target.node,
            target.js.clone(),
            target.js_events,
            target.events,
        );
        let applied = merged(&target.js, &target.own);
        if node != holder {
            self.components.adopted.remove(&node);
        }
        if self.key(node).is_ok() {
            self.apply_attrs(node, &js, &applied);
            self.listen_changes(node, events, EventMask::default(), js_events);
        }
    }

    /// Slot holder `holder` stops being placed (its element went, the
    /// holder left its component, or the component went): its target gets
    /// JS's own props and listeners back and the component's handlers on
    /// it go.
    pub(super) fn drop_slot_target(&mut self, holder: NodeId) {
        if !self.components.slot_targets.contains_key(&holder) {
            return;
        }
        self.leave_slot_target(holder);
        if let Some(target) = self.components.slot_targets.remove(&holder)
            && let Some(inst) = self.components.instances.get_mut(&target.host)
        {
            inst.handlers.retain(|(n, _, _)| *n != target.node);
            inst.responders.retain(|(n, _)| *n != target.node);
        }
    }

    /// An op from JS on app element `id`, the target of a slot's props:
    /// JS's side of the props they share is kept and their combination
    /// sent; its listeners join the component's. `Some` passes as it is.
    pub(super) fn js_slot_op(&mut self, op: Op) -> Option<Op> {
        match op {
            Op::SetProp { id, prop } => {
                let holder = *self.components.adopted.get(&id)?;
                let target = self.components.slot_targets.get_mut(&holder)?;
                // `importantForAccessibility` sets whether it is an element
                // (combined) and whether its subtree is hidden (JS's).
                let (prop, hidden) = match prop {
                    Prop::Accessibility(AccessibilityProp::Important(accessible, hidden)) => (
                        Prop::Accessibility(AccessibilityProp::Accessible(accessible)),
                        Some(hidden),
                    ),
                    prop => (prop, None),
                };
                let before = merged(&target.js, &target.own);
                if !absorb(&mut target.js, &prop) {
                    return Some(Op::SetProp { id, prop });
                }
                let after = merged(&target.js, &target.own);
                if let Some(hidden) = hidden {
                    let _ = self.apply_op(Op::SetProp {
                        id,
                        prop: Prop::Accessibility(AccessibilityProp::Hidden(hidden)),
                    });
                }
                self.apply_attrs(id, &after, &before);
                None
            }
            Op::Listen { id, event, enabled } => {
                let holder = *self.components.adopted.get(&id)?;
                let target = self.components.slot_targets.get_mut(&holder)?;
                target.js_events.set(event, enabled);
                let own = target.events.contains(event);
                Some(Op::Listen {
                    id,
                    event,
                    enabled: enabled || own,
                })
            }
            Op::Release { id } => {
                // The element goes: the holder takes the component's part
                // (it has no element now).
                if let Some(holder) = self.components.adopted.remove(&id)
                    && let Some(target) = self.components.slot_targets.get_mut(&holder)
                {
                    target.node = holder;
                    target.js = Attrs::default();
                    target.js_events = EventMask::default();
                    let (applied, events, host) = (target.own.clone(), target.events, target.host);
                    self.apply_attrs(holder, &applied, &Attrs::default());
                    self.listen_changes(holder, EventMask::default(), events, EventMask::default());
                    if let Some(inst) = self.components.instances.get_mut(&host) {
                        for (n, _, _) in &mut inst.handlers {
                            if *n == id {
                                *n = holder;
                            }
                        }
                        for (n, _) in &mut inst.responders {
                            if *n == id {
                                *n = holder;
                            }
                        }
                    }
                }
                Some(Op::Release { id })
            }
            op => Some(op),
        }
    }
}
