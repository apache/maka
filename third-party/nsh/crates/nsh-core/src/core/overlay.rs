//! Overlays ([`crate::overlay`]): an `<overlay>` node stays where the app
//! put it (its parent's child for the reactive graph, events, lifetime,
//! inherited text styles), while its native view is in the root view
//! around it (the surface, or the nearest modal), above that root view's
//! own children and the overlays shown before it.
//!
//! Each commit [`Core::sync_overlays`] works out which overlays are shown
//! (every view around them is, and the overlays around them are) and in
//! which root view, and moves their native views there: one opened later
//! goes on top. An overlay is a layout root of its own, laid out in a box
//! the size of its root view (`position: fixed`), and placed against its
//! anchor when it has one ([`crate::overlay::place`]); it follows the
//! anchor as it moves ([`Core::place_overlays`], after the lists and
//! scroll offsets of the commit). The core also routes what dismissing
//! takes: presses outside (`onPressOutside`: the overlays watching them,
//! their anchors and root views listen to touches while they are shown)
//! and Escape / the back button (`onCancel`, to the top overlay listening:
//! a binding of the root's table and the root's back listener while one
//! is shown). Closing is the app's (`nsh-base`'s components).
//!
//! A hint overlay ([`OverlayConfig::hint`]) is shown by the core: its
//! anchor (its parent without one) listens to the pointer coming and going
//! while the overlay is in the view on a desktop; the pointer resting on it
//! for the hint's delay shows the hint (a task of the components' executor
//! wakes the engine then), the pointer leaving or pressing it hides it, as
//! GPUI's tooltips do. The overlay hears what it asks for (`Show`,
//! `Dismiss`), so a component owning it (`nsh-base`'s `Tooltip`) can
//! decide instead ([`OverlayConfig::open`]). An element's `tooltip` is a
//! hint overlay the core makes inside the element ([`Core::set_tooltip`]).

use rustc_hash::FxHashMap;
use taffy::NodeId as LayoutId;

use super::{Core, Key, Kind, NO_KEY, definite};
use crate::{
    EventKind, EventPayload, NodeId, PayloadValue, Prop, ROOT_ID, Tag, TextEngine, TouchEvent,
    TouchPhase,
    element::task::{Action, Task, act_after},
    geometry::{Bounds, Point, Points, Size, px, rect},
    keymap::{KeyBinding, Keystroke, When},
    ops::{Op, OverlayProp},
    overlay::{
        HINT_DELAY, HintObservation, HintWatchToken, OverlayAnchor, OverlayConfig, Placed,
        Placement, TooltipContent, inset, place,
    },
    props::PointerEvents,
};

/// What the overlays have a node listen to (`Node::overlay_watched`).
pub(super) mod watch {
    /// Touches, for an overlay's `onPressOutside`.
    pub(in crate::core) const PRESS: u8 = 1;
    /// The pointer coming and going and touches, for a hint.
    pub(in crate::core) const HINT: u8 = 2;
    /// A hint has a show/dismiss listener, beyond native presentation.
    pub(in crate::core) const HINT_CALLBACK: u8 = 4;
    /// Native anchor focus also controls hint presentation.
    pub(in crate::core) const HINT_FOCUS: u8 = 8;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Watch {
    pub(super) key: Key,
    id: NodeId,
    kinds: u8,
    layout: u64,
    hints: Vec<(NodeId, u64, u64)>,
    pub(super) token: Option<HintWatchToken>,
}

/// The gap between an element and its `tooltip`, and the distance the
/// tooltip keeps from the safe area's edges.
const TOOLTIP_GAP: f32 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HintOrigin {
    Event,
    Observation(HintWatchToken),
}

/// A hint's wait for the pointer to rest (dropping it cancels it).
pub(super) struct HintTimer {
    #[allow(dead_code)]
    task: Task<()>,
    origin: HintOrigin,
}

impl std::fmt::Debug for HintTimer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HintTimer")
    }
}

/// The nodes the core made for an element's `tooltip`.
#[derive(Debug, Clone, Copy)]
pub(super) struct CoreTooltip {
    /// The hint overlay, a child of the element.
    pub(super) overlay: NodeId,
    /// The element shown as the tooltip, inside the overlay (JS's).
    content: Option<NodeId>,
}

/// The binding id of Escape while an overlay listens to `onCancel`: above
/// any JS gives and any view's ([`crate::element::keys::FIRST_ID`] counts up).
pub(super) const ESCAPE_BINDING: u32 = u32::MAX;

/// An overlay's own state.
#[derive(Debug)]
pub(super) struct OverlayState {
    /// How it is placed.
    pub(super) config: OverlayConfig,
    /// A layout node the size of the root view, holding the overlay's as
    /// an absolutely placed child: what its insets and percentages are
    /// against.
    pub(super) wrapper: LayoutId,
    /// The root view its native view is in, while it is shown.
    pub(super) host: Option<NodeId>,
    /// Where it was placed last, as `onPosition` reported it.
    pub(super) placed: Option<(Placed, Bounds<Points>)>,
    /// A hint: the pointer rested on its anchor, and has not left or
    /// pressed it since.
    pub(super) hinted: Option<HintOrigin>,
    /// A hint: the pointer is on its anchor, resting until it shows.
    pub(super) waiting: Option<HintTimer>,
}

/// What the overlays add to the native side: the nodes listening to
/// touches for `onPressOutside`, and whether Escape and back are taken.
#[derive(Debug, Default)]
pub(super) struct Overlays {
    /// The shown overlays and the other nodes listening to touches for
    /// them (their anchors and root views), checked by id (keys are
    /// reused).
    pub(super) watched: Vec<Watch>,
    /// A shown overlay listens to `onCancel`: Escape is bound and the back
    /// button listened to.
    pub(super) cancel: bool,
    /// The anchors of the hints in the view listening to the pointer
    /// (desktops), checked by id.
    pub(super) hinting: Vec<Watch>,
    /// The elements with a `tooltip`, by id: the nodes made for it.
    pub(super) tooltips: FxHashMap<NodeId, CoreTooltip>,
}

impl<M: TextEngine> Core<M> {
    /// A new overlay node `key` with layout node `layout`: its wrapper.
    pub(super) fn overlay_made(&mut self, key: Key, layout: LayoutId) {
        let wrapper = self
            .layout
            .new_with_children(taffy::Style::default(), &[layout]);
        if let Some(root) = self.nodes[key as usize].root.as_mut() {
            root.overlay = Some(Box::new(OverlayState {
                config: OverlayConfig::default(),
                wrapper,
                host: None,
                placed: None,
                hinted: None,
                waiting: None,
            }));
        }
        self.overlays.push(key);
    }

    /// The views whose `position: fixed` changed become overlays (laid out
    /// in their root view's box, shown above its children, as CSS places
    /// a fixed box against the viewport), or views in their parents again.
    pub(super) fn sync_fixed(&mut self) {
        if self.fixed_changed.is_empty() {
            return;
        }
        for (key, id) in std::mem::take(&mut self.fixed_changed) {
            let Some(node) = self.nodes.get(key as usize) else {
                continue;
            };
            if node.id != id {
                continue;
            }
            let parent = node.parent;
            let at = (parent != NO_KEY).then(|| {
                let siblings = &self.nodes[parent as usize].children;
                let i = siblings.iter().position(|&c| c == key).expect("child");
                let next = siblings.get(i + 1).map(|&c| self.nodes[c as usize].id);
                (self.nodes[parent as usize].id, next)
            });
            if self.fix_or_unfix(key)
                && let Some((parent, before)) = at
            {
                let _ = self.insert(parent, id, before);
            }
        }
    }

    /// Makes view `key` an overlay when its style says `position: fixed`,
    /// or a view again when it no longer does; whether it changed.
    pub(super) fn fix_or_unfix(&mut self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        let fixed = node.wants_fixed
            && !node.kind.is_root()
            && (node.layout.is_some() || node.kind == Kind::Text);
        if fixed == node.fixed_view {
            return false;
        }
        if fixed {
            self.fix_view(key);
        } else {
            self.unfix_view(key);
        }
        true
    }

    /// View `key` becomes an overlay of no anchor: out of its parent's
    /// layout and native view, shown by `sync_overlays` in its root view.
    fn fix_view(&mut self, key: Key) {
        if self.nodes[key as usize].parent != NO_KEY {
            self.unlink(key, true);
        }
        self.set_inline(key, false);
        let node = &mut self.nodes[key as usize];
        node.fixed_view = true;
        node.root = Some(Box::default());
        let layout = node.layout.expect("a view has a layout");
        let style = self.layout.style(layout).clone();
        self.nodes[key as usize].base_layout = Some(Box::new(style));
        self.roots.push(key);
        self.overlay_made(key, layout);
        self.sync_layout_style(key);
    }

    /// Overlay `key`, a view `position: fixed` made one, is a view again:
    /// out of its root view, laid out in its parent.
    fn unfix_view(&mut self, key: Key) {
        let (id, created) = (
            self.nodes[key as usize].id,
            self.nodes[key as usize].created,
        );
        let state = self.overlay(key).map(|s| (s.host, s.wrapper));
        if let Some((Some(_), _)) = state
            && created
        {
            self.emit_remove(id);
        }
        if self.nodes[key as usize].parent != NO_KEY {
            self.unlink(key, false);
        }
        let layout = self.nodes[key as usize]
            .layout
            .expect("a view has a layout");
        if let Some((_, wrapper)) = state {
            self.layout.remove_child(wrapper, layout);
            self.overlay_released(key, wrapper);
        }
        self.roots.retain(|&k| k != key);
        let node = &mut self.nodes[key as usize];
        node.fixed_view = false;
        node.root = None;
        if let Some(base) = node.base_layout.as_deref() {
            self.layout.set_style(layout, base.clone());
        }
        if !node.kind.derives_layout() {
            node.base_layout = None;
        }
        self.needs_layout = true;
    }

    /// Overlay `key` is released: forgets it and drops its wrapper (its own
    /// layout node is gone already).
    pub(super) fn overlay_released(&mut self, key: Key, wrapper: LayoutId) {
        self.overlays.retain(|&k| k != key);
        self.layout.remove(wrapper);
    }

    /// Node `id` is released: the nodes made for its `tooltip` go with it.
    pub(super) fn tooltip_released(&mut self, id: NodeId) {
        if let Some(made) = self.overlay_state.tooltips.remove(&id) {
            self.release_tooltip(made);
        }
    }

    /// Whether `key` is the overlay of an element's `tooltip`: not one of
    /// its children for its classes (`first:`, `last:`, ...).
    pub(super) fn is_tooltip_overlay(&self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        node.is_overlay()
            && node.parent != NO_KEY
            && self
                .overlay_state
                .tooltips
                .get(&self.nodes[node.parent as usize].id)
                .is_some_and(|t| t.overlay == node.id)
    }

    pub(super) fn overlay(&self, key: Key) -> Option<&OverlayState> {
        self.nodes[key as usize]
            .root
            .as_ref()
            .and_then(|r| r.overlay.as_deref())
    }

    fn overlay_mut(&mut self, key: Key) -> Option<&mut OverlayState> {
        self.nodes[key as usize]
            .root
            .as_mut()
            .and_then(|r| r.overlay.as_deref_mut())
    }

    /// Changes how overlay `key` is placed.
    pub(super) fn set_overlay_config(&mut self, key: Key, f: impl FnOnce(&mut OverlayConfig)) {
        if let Some(state) = self.overlay_mut(key) {
            let before = state.config;
            f(&mut state.config);
            if state.config != before {
                state.placed = None;
                // Placed again with its size, or laid out again (no anchor:
                // its insets place it).
                if let Some(root) = self.nodes[key as usize].root.as_mut() {
                    root.laid_out = None;
                }
                self.needs_layout = true;
            }
        }
    }

    /// The first overlay shown in root view `parent`: the native sibling
    /// its own children go below.
    pub(super) fn first_overlay_in(&self, parent: Key) -> Option<NodeId> {
        let id = self.nodes[parent as usize].id;
        self.overlays
            .iter()
            .find_map(|&k| (self.overlay(k)?.host == Some(id)).then(|| self.nodes[k as usize].id))
    }

    /// The root view overlay `key` is shown in, or `None` while it is not
    /// shown: a view around it is not (out of the tree, its native view
    /// not made, `display: none`), or the overlay around it is not.
    fn overlay_host(&self, key: Key) -> Option<Key> {
        let mut modal = None;
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            if k == self.root {
                return Some(modal.unwrap_or(self.root));
            }
            let n = &self.nodes[k as usize];
            if let Some(layout) = n.layout {
                if !n.created {
                    return None;
                }
                let hidden = self.layout.style(layout).display == taffy::Display::None;
                if hidden && !n.is_overlay() {
                    return None;
                }
            }
            match n.kind {
                Kind::Modal if modal.is_none() => modal = Some(k),
                _ if n.is_overlay() => {
                    // Shown in its root view, which is this one's unless a
                    // modal is between them.
                    let host = self.overlay(k)?.host?;
                    return Some(modal.unwrap_or(self.key(host).ok()?));
                }
                _ => {}
            }
            k = n.parent;
        }
        None
    }

    /// The overlays around `key`.
    fn overlay_depth(&self, key: Key) -> u32 {
        let mut depth = 0;
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            if self.nodes[k as usize].is_overlay() {
                depth += 1;
            }
            k = self.nodes[k as usize].parent;
        }
        depth
    }

    fn sync_overlay_focus_return(&mut self, key: Key) {
        let parent = self
            .overlay(key)
            .filter(|s| s.config.focus_return)
            .map(|_| {
                let mut parent = self.nodes[key as usize].parent;
                while parent != NO_KEY {
                    if self.nodes[parent as usize].kind == Kind::Modal
                        || self.overlay(parent).is_some_and(|s| s.config.focus_return)
                    {
                        return self.nodes[parent as usize].id;
                    }
                    parent = self.nodes[parent as usize].parent;
                }
                self.nodes[self.root as usize].id
            });
        let node = &mut self.nodes[key as usize];
        if node.props.as_ref().and_then(|p| p.focus_return_parent) != parent {
            node.props
                .get_or_insert_with(Default::default)
                .focus_return_parent = parent;
            self.mark(key, super::dirty::VIEW_PROPS);
        }
    }

    /// Shows the overlays whose views around them are shown, in their root
    /// views, and hides the others (and the hints the pointer has not
    /// asked for); then what they listen to (once per commit, before the
    /// dirty views are flushed).
    pub(super) fn sync_overlays(&mut self) {
        if self.overlays.is_empty()
            && self.overlay_state.watched.is_empty()
            && self.overlay_state.hinting.is_empty()
        {
            return;
        }
        // The overlays around one first: theirs say where it goes.
        if !self.overlay_state.tooltips.is_empty() {
            self.adopt_hint_tooltips();
        }
        let mut order: Vec<(u32, Key)> = self
            .overlays
            .iter()
            .map(|&k| (self.overlay_depth(k), k))
            .collect();
        order.sort_by_key(|&(depth, _)| depth);
        // The hints in the view, whose anchors listen to the pointer.
        let mut hints = Vec::new();
        for (_, key) in order {
            self.sync_overlay_focus_return(key);
            let origin = self.overlay(key).and_then(|state| {
                state
                    .hinted
                    .or_else(|| state.waiting.as_ref().map(|timer| timer.origin))
            });
            if matches!(origin, Some(HintOrigin::Observation(token)) if self.matching_hint_watch(token).is_none())
            {
                self.unhint(key);
            }
            let mut target = self.overlay_host(key);
            let Some(state) = self.overlay(key) else {
                continue;
            };
            if state.config.hint.is_some() {
                if target.is_some() {
                    hints.push(key);
                } else {
                    // Out of the view: the pointer starts again.
                    self.unhint(key);
                }
                let state = self.overlay(key).expect("overlay");
                let focused = state.config.hint_on_focus
                    && self.hint_anchor(key).is_some_and(|anchor| {
                        self.nodes[anchor as usize].states & crate::tailwind::state::FOCUSED != 0
                    });
                if !state
                    .config
                    .open
                    .unwrap_or(state.hinted.is_some() || focused)
                {
                    target = None;
                }
            }
            let target_id = target.map(|h| self.nodes[h as usize].id);
            let current = self.overlay(key).expect("overlay").host;
            if current == target_id {
                continue;
            }
            let id = self.nodes[key as usize].id;
            if let Some(old) = current
                && self.key(old).is_ok_and(|h| self.nodes[h as usize].created)
                && self.nodes[key as usize].created
            {
                if target_id.is_none() {
                    self.remove_owned_roots(key);
                } else {
                    self.emit_remove(id);
                }
            }
            let state = self.overlay_mut(key).expect("overlay");
            state.host = target_id;
            state.placed = None;
            let Some(host) = target_id else {
                continue;
            };
            // Publish the new presentation order before taking the native
            // following-root snapshot. Restoring a parked root does not
            // pass here and keeps its original slot.
            self.overlays.retain(|&overlay| overlay != key);
            self.overlays.push(key);
            self.ensure_created(key);
            self.emit_insert(host, id, None);
            if let Some(root) = self.nodes[key as usize].root.as_mut() {
                root.laid_out = None;
            }
            self.needs_layout = true;
        }
        self.sync_overlay_listeners(&hints);
    }

    /// The touches and keys the shown overlays need, and the pointer the
    /// anchors of `hints` (in the view) follow.
    fn sync_overlay_listeners(&mut self, hints: &[Key]) {
        let mut watched = Vec::new();
        let mut cancel = false;
        let watching = self.overlays.iter().any(|&k| {
            self.overlay(k).is_some_and(|s| s.host.is_some())
                && self.nodes[k as usize]
                    .events
                    .contains(EventKind::PressOutside)
        });
        for &key in &self.overlays {
            let Some(state) = self.overlay(key) else {
                continue;
            };
            let Some(host) = state.host else { continue };
            let node = &self.nodes[key as usize];
            cancel |= node.events.contains(EventKind::Cancel);
            if !watching {
                continue;
            }
            // Every shown overlay, so a press in one inside a watching one
            // tells where it is.
            watched.push(Watch {
                key,
                id: node.id,
                kinds: watch::PRESS,
                layout: 0,
                hints: Vec::new(),
                token: None,
            });
            if node.events.contains(EventKind::PressOutside) {
                for id in [Some(host), anchor_node(state)].into_iter().flatten() {
                    if let Ok(k) = self.key(id) {
                        watched.push(Watch {
                            key: k,
                            id: self.nodes[k as usize].id,
                            kinds: watch::PRESS,
                            layout: 0,
                            hints: Vec::new(),
                            token: None,
                        });
                    }
                }
            }
        }
        watched.sort_unstable_by_key(|entry| (entry.key, entry.id));
        watched.dedup();
        let old = std::mem::take(&mut self.overlay_state.watched);
        self.rewatch(&old, &watched);
        self.overlay_state.watched = watched;
        // Hints only follow a pointer (the desktops).
        let mut hinting = Vec::new();
        if self
            .components
            .environment
            .idiom
            .desktop_on(self.components.environment.os)
        {
            for &key in hints {
                if let Some(k) = self.hint_anchor(key) {
                    let events = self.nodes[key as usize].events;
                    let callback = events.contains(EventKind::Show)
                        || events.contains(EventKind::Dismiss)
                        || self.hint_scope_has_callbacks(k);
                    let layout = self.nodes[k as usize]
                        .layout
                        .map(|layout| self.layout.lifetime(layout))
                        .unwrap_or(0);
                    hinting.push(Watch {
                        key: k,
                        id: self.nodes[k as usize].id,
                        kinds: watch::HINT
                            | if self.overlay(key).is_some_and(|s| s.config.hint_on_focus) {
                                watch::HINT_FOCUS
                            } else {
                                0
                            }
                            | if callback || layout == 0 {
                                watch::HINT_CALLBACK
                            } else {
                                0
                            },
                        layout,
                        hints: vec![(
                            self.nodes[key as usize].id,
                            self.nodes[key as usize]
                                .layout
                                .map(|layout| self.layout.lifetime(layout))
                                .unwrap_or(0),
                            self.overlay_host(key)
                                .and_then(|host| self.nodes[host as usize].layout)
                                .map(|layout| self.layout.lifetime(layout))
                                .unwrap_or(0),
                        )],
                        token: None,
                    });
                }
            }
            hinting.sort_unstable_by_key(|entry| (entry.key, entry.id));
            hinting.dedup_by(|next, previous| {
                if next.key != previous.key || next.id != previous.id {
                    return false;
                }
                previous.kinds |= next.kinds;
                previous.hints.append(&mut next.hints);
                true
            });
        }
        let old = std::mem::take(&mut self.overlay_state.hinting);
        for entry in &mut hinting {
            entry.hints.sort_unstable();
            entry.hints.dedup();
            if entry.kinds & watch::HINT_CALLBACK == 0 {
                entry.token = old
                    .iter()
                    .find(|previous| {
                        previous.key == entry.key
                            && previous.id == entry.id
                            && previous.kinds == entry.kinds
                            && previous.layout == entry.layout
                            && previous.hints == entry.hints
                    })
                    .and_then(|previous| previous.token)
                    .or_else(|| Some(HintWatchToken::new(entry.layout, self.batches)));
            }
        }
        self.rewatch(&old, &hinting);
        self.overlay_state.hinting = hinting;
        if cancel != self.overlay_state.cancel {
            self.overlay_state.cancel = cancel;
            // The root's table and back listener are made again.
            self.components.executor.keys.borrow_mut().changed = true;
            self.components.executor.back.borrow_mut().changed = true;
        }
    }

    /// Watch ownership or callback capability changed: remount the anchor's
    /// event facts even when its aggregate event bits stay the same.
    fn rewatch(&mut self, old: &[Watch], new: &[Watch]) {
        for entry in old {
            if !new.contains(entry)
                && self
                    .nodes
                    .get(entry.key as usize)
                    .is_some_and(|n| n.id == entry.id)
            {
                self.nodes[entry.key as usize].overlay_watched &= !entry.kinds;
                self.mark(entry.key, super::dirty::EVENTS);
                self.update_tracking(entry.key);
            }
        }
        for entry in new {
            if !old.contains(entry) {
                self.nodes[entry.key as usize].overlay_watched |= entry.kinds;
                self.mark(entry.key, super::dirty::EVENTS);
                self.update_tracking(entry.key);
            }
        }
    }

    /// What hint overlay `key` is placed against and whose pointer it
    /// follows: its anchor, else the nearest view around it with a frame
    /// (its parent, unless that is a span of text).
    fn hint_anchor(&self, key: Key) -> Option<Key> {
        match self.overlay(key)?.config.anchor {
            OverlayAnchor::Node(id) | OverlayAnchor::Content(id) => self.key(id).ok(),
            OverlayAnchor::Point(_) | OverlayAnchor::Bounds(_) => None,
            OverlayAnchor::None => {
                let mut k = self.nodes[key as usize].parent;
                while k != NO_KEY {
                    let n = &self.nodes[k as usize];
                    if n.layout.is_some() {
                        return Some(k);
                    }
                    k = n.parent;
                }
                None
            }
        }
    }

    /// What overlay `key` is placed against: a hint without an anchor
    /// against the view it follows ([`Self::hint_anchor`]).
    fn resolved_anchor(&self, key: Key) -> OverlayAnchor {
        let Some(state) = self.overlay(key) else {
            return OverlayAnchor::None;
        };
        match state.config.anchor {
            OverlayAnchor::None if state.config.hint.is_some() => {
                self.hint_anchor(key).map_or(OverlayAnchor::None, |k| {
                    OverlayAnchor::Node(self.nodes[k as usize].id)
                })
            }
            anchor => anchor,
        }
    }

    /// The pointer came over node `id` or left it (`kind`): the hints it
    /// anchors wait for it to rest, or hide.
    pub(super) fn overlay_hover(&mut self, id: NodeId, kind: EventKind) {
        let Ok(anchor) = self.key(id) else {
            return;
        };
        if self.nodes[anchor as usize].overlay_watched & watch::HINT == 0 {
            return;
        }
        let hints: Vec<Key> = self
            .overlays
            .iter()
            .copied()
            .filter(|&k| {
                self.overlay(k).is_some_and(|s| s.config.hint.is_some())
                    && self.hint_anchor(k) == Some(anchor)
            })
            .collect();
        for key in hints {
            match kind {
                EventKind::MouseEnter => self.hint_wait(key, HintOrigin::Event),
                _ => self.unhint(key),
            }
        }
    }

    /// Applies a native hint observation without routing an input event to
    /// application listeners: subscriptions may have changed since sampling.
    pub fn observe_hint(&mut self, observation: HintObservation) {
        let entering = matches!(&observation, HintObservation::Enter(_));
        let anchors = match &observation {
            HintObservation::Enter(id) | HintObservation::Leave(id) => std::slice::from_ref(id),
            HintObservation::Press(path) => path.as_slice(),
        };
        for &token in anchors {
            let Some(anchor) = self.matching_hint_watch(token) else {
                continue;
            };
            let hints: Vec<_> = self
                .overlays
                .iter()
                .copied()
                .filter(|&key| {
                    self.overlay(key)
                        .is_some_and(|state| state.config.hint.is_some())
                        && self.hint_anchor(key) == Some(anchor)
                })
                .collect();
            for key in hints {
                if entering {
                    self.hint_wait(key, HintOrigin::Observation(token));
                } else {
                    self.unhint(key);
                }
            }
        }
    }

    fn matching_hint_watch(&self, token: HintWatchToken) -> Option<Key> {
        let watch = self
            .overlay_state
            .hinting
            .iter()
            .find(|watch| watch.token == Some(token))?;
        let anchor = self.nodes.get(watch.key as usize)?;
        if anchor.id != watch.id
            || anchor.layout.map(|layout| self.layout.lifetime(layout)) != Some(watch.layout)
            || !self.passive_hint_anchor(watch.key)
        {
            return None;
        }
        let mut current: Vec<_> = self
            .overlays
            .iter()
            .copied()
            .filter(|&key| {
                self.overlay(key)
                    .is_some_and(|state| state.config.hint.is_some())
                    && self.hint_anchor(key) == Some(watch.key)
                    && self.overlay_host(key).is_some()
            })
            .map(|key| {
                let hint = &self.nodes[key as usize];
                (
                    hint.id,
                    hint.layout
                        .map(|layout| self.layout.lifetime(layout))
                        .unwrap_or(0),
                    self.overlay_host(key)
                        .and_then(|host| self.nodes[host as usize].layout)
                        .map(|layout| self.layout.lifetime(layout))
                        .unwrap_or(0),
                )
            })
            .collect();
        current.sort_unstable();
        current.dedup();
        (current == watch.hints).then_some(watch.key)
    }

    fn passive_hint_anchor(&self, anchor: Key) -> bool {
        if self.nodes[anchor as usize].overlay_watched & watch::HINT == 0 {
            return false;
        }
        !self.hint_scope_has_callbacks(anchor)
            && self.overlays.iter().copied().all(|key| {
                self.overlay(key).is_none_or(|state| {
                    state.config.hint.is_none()
                        || self.hint_anchor(key) != Some(anchor)
                        || self.overlay_host(key).is_none()
                        || (!self.nodes[key as usize].events.contains(EventKind::Show)
                            && !self.nodes[key as usize].events.contains(EventKind::Dismiss))
                })
            })
    }

    fn hint_scope_has_callbacks(&self, anchor: Key) -> bool {
        let mut at = anchor;
        while at != NO_KEY {
            let node = &self.nodes[at as usize];
            if node.overlay_watched & watch::PRESS != 0
                || [
                    EventKind::Touch,
                    EventKind::MouseEnter,
                    EventKind::MouseLeave,
                ]
                .into_iter()
                .any(|kind| node.events.contains(kind))
            {
                return true;
            }
            at = node.parent;
        }
        false
    }

    /// The pointer is on hint `key`'s anchor: it shows once the pointer
    /// rested there for its delay ([`Self::hint_due`]).
    fn hint_wait(&mut self, key: Key, origin: HintOrigin) {
        let executor = self.components.executor.clone();
        let id = self.nodes[key as usize].id;
        let Some(state) = self.overlay_mut(key) else {
            return;
        };
        if state.hinted.is_some() || state.waiting.is_some() {
            return;
        }
        let delay = state.config.hint.unwrap_or(HINT_DELAY);
        state.waiting = Some(HintTimer {
            task: act_after(&executor, id, delay, Action::Hint(id)),
            origin,
        });
    }

    /// Hint overlay `id`'s delay is over with the pointer on its anchor: it
    /// shows (in the commit).
    pub(super) fn hint_due(&mut self, id: NodeId) {
        let Ok(key) = self.key(id) else {
            return;
        };
        let Some(timer) = self.overlay_mut(key).and_then(|state| state.waiting.take()) else {
            return;
        };
        if let HintOrigin::Observation(token) = timer.origin {
            let anchor = self.matching_hint_watch(token);
            if anchor.is_none() || self.hint_anchor(key) != anchor {
                return;
            }
        }
        let state = self.overlay_mut(key).expect("the waiting hint");
        if state.config.hint.is_none() {
            return;
        }
        state.hinted = Some(timer.origin);
        if timer.origin == HintOrigin::Event {
            self.hint_changed(key, true);
        }
    }

    /// Hint `key` stops waiting, and hides when the pointer had it shown.
    fn unhint(&mut self, key: Key) {
        let Some(state) = self.overlay_mut(key) else {
            return;
        };
        state.waiting = None;
        if state.hinted.take() == Some(HintOrigin::Event) {
            self.hint_changed(key, false);
        }
    }

    /// Tells hint `key` what the pointer asks for: `Show` or `Dismiss`.
    fn hint_changed(&mut self, key: Key, shown: bool) {
        let node = &self.nodes[key as usize];
        let kind = if shown {
            EventKind::Show
        } else {
            EventKind::Dismiss
        };
        if node.events.contains(kind) {
            self.events.push(crate::element::JsEvent::Event(
                node.id,
                kind,
                EventPayload::None,
            ));
        }
    }

    /// A finger or button went down: the hints whose anchors it is on hide
    /// (and wait for the pointer to come again).
    fn hint_touches(&mut self, touch: &TouchEvent) {
        let hints: Vec<Key> = self
            .overlays
            .iter()
            .copied()
            .filter(|&k| {
                self.overlay(k).is_some_and(|s| {
                    s.config.hint.is_some() && (s.hinted.is_some() || s.waiting.is_some())
                })
            })
            .collect();
        for key in hints {
            let Some(anchor) = self.hint_anchor(key).map(|k| self.nodes[k as usize].id) else {
                continue;
            };
            let pressed = touch
                .points
                .iter()
                .any(|p| p.changed && p.path.contains(&anchor));
            if pressed {
                self.unhint(key);
            }
        }
    }

    /// Sets the `tooltip` of node `key`: a hint overlay the core makes
    /// inside it, showing the element JS made.
    pub(super) fn set_tooltip(&mut self, key: Key, content: TooltipContent) {
        let id = self.nodes[key as usize].id;
        let mut made = self.overlay_state.tooltips.get(&id).copied();
        // The element was the hint overlay itself: anything else starts
        // again from a hint overlay of the core's.
        if let Some(adopted) = made.filter(|m| m.content == Some(m.overlay)) {
            if content == TooltipContent::Node(adopted.overlay) {
                return;
            }
            self.overlay_state.tooltips.remove(&id);
            self.release_tooltip(adopted);
            made = None;
        }
        let made = match (content, made) {
            (TooltipContent::None, made) => {
                if let Some(made) = made {
                    self.overlay_state.tooltips.remove(&id);
                    self.release_tooltip(made);
                }
                return;
            }
            (TooltipContent::Node(node), made) => {
                let mut made = match made {
                    Some(made) => made,
                    None => match self.make_tooltip(id) {
                        Some(made) => made,
                        None => return,
                    },
                };
                if made.content == Some(node) {
                    return;
                }
                if let Some(old) = made.content.take() {
                    self.detach_tooltip_content(old);
                }
                match self.insert(made.overlay, node, None) {
                    Ok(()) => made.content = Some(node),
                    Err(e) => log::error!(target: "js", "a tooltip's element is not shown: {e:?}"),
                }
                made
            }
        };
        self.overlay_state.tooltips.insert(id, made);
    }

    /// A hint overlay inside element `id`, above it, for its `tooltip`.
    fn make_tooltip(&mut self, id: NodeId) -> Option<CoreTooltip> {
        let overlay = self.components.alloc();
        let gap = px(TOOLTIP_GAP);
        let ops = [
            Op::Create {
                id: overlay,
                tag: Tag::Overlay,
            },
            // Never in the way of the pointer: the element works as without.
            Op::SetProp {
                id: overlay,
                prop: Prop::PointerEvents(PointerEvents::None),
            },
            Op::SetProp {
                id: overlay,
                prop: Prop::Overlay(OverlayProp::Hint(Some(HINT_DELAY))),
            },
            Op::SetProp {
                id: overlay,
                prop: Prop::Overlay(OverlayProp::Placement(Placement::Top)),
            },
            Op::SetProp {
                id: overlay,
                prop: Prop::Overlay(OverlayProp::Offset(gap)),
            },
            Op::SetProp {
                id: overlay,
                prop: Prop::Overlay(OverlayProp::Margin(gap)),
            },
        ];
        for op in ops {
            if let Err(e) = self.apply_op(op) {
                log::error!(target: "js", "a tooltip is not made: {e:?}");
                return None;
            }
        }
        // Into the element itself, wherever a component places its
        // children.
        if let Err(e) = self.insert(id, overlay, None) {
            log::error!(target: "js", "a tooltip is not made: {e:?}");
            let _ = self.release(overlay);
            return None;
        }
        Some(CoreTooltip {
            overlay,
            content: None,
        })
    }

    /// The elements of `tooltip`s that are hint overlays themselves (a
    /// `Tooltip` of `nsh-base`, whose root its view made one) take the place
    /// of the core's: in the element, with their own placement, delay and
    /// look (after the components rendered, before the overlays are shown).
    fn adopt_hint_tooltips(&mut self) {
        let adoptable: Vec<(NodeId, CoreTooltip)> = self
            .overlay_state
            .tooltips
            .iter()
            .filter(|(_, m)| {
                m.content.is_some_and(|c| {
                    c != m.overlay
                        && self.key(c).is_ok_and(|k| {
                            self.nodes[k as usize].is_overlay()
                                && self.overlay(k).is_some_and(|s| s.config.hint.is_some())
                        })
                })
            })
            .map(|(&id, &m)| (id, m))
            .collect();
        for (id, mut made) in adoptable {
            let content = made.content.expect("content");
            if let Err(e) = self.insert(id, content, None) {
                log::error!(target: "js", "a tooltip's element is not shown: {e:?}");
                continue;
            }
            let _ = self.release(made.overlay);
            made.overlay = content;
            self.overlay_state.tooltips.insert(id, made);
        }
    }

    /// The element shown as a tooltip leaves it (it stays JS's).
    fn detach_tooltip_content(&mut self, content: NodeId) {
        if let Ok(k) = self.key(content)
            && self.nodes[k as usize].parent != NO_KEY
        {
            self.detach(k);
        }
    }

    /// Releases the nodes made for a `tooltip`.
    fn release_tooltip(&mut self, made: CoreTooltip) {
        if let Some(content) = made.content {
            self.detach_tooltip_content(content);
            if content == made.overlay {
                // The element's own (a `Tooltip`'s): JS's to release.
                return;
            }
        }
        let _ = self.release(made.overlay);
    }

    /// Escape's binding, while an overlay listens to `onCancel`.
    pub(super) fn overlay_key_binding(&self) -> Option<KeyBinding> {
        if !self.overlay_state.cancel {
            return None;
        }
        let escape = Keystroke::parse_with("escape", false).ok()?;
        Some(KeyBinding::new(ESCAPE_BINDING, escape, When::Always, false))
    }

    /// Escape or back: `onCancel` of the top overlay listening to it;
    /// whether one took it.
    pub(super) fn overlay_cancel(&mut self) -> bool {
        let top = self.overlays.iter().rev().copied().find(|&k| {
            self.overlay(k).is_some_and(|s| s.host.is_some())
                && self.nodes[k as usize].events.contains(EventKind::Cancel)
        });
        let Some(key) = top else {
            return false;
        };
        let id = self.nodes[key as usize].id;
        self.events.push(crate::element::JsEvent::Event(
            id,
            EventKind::Cancel,
            EventPayload::None,
        ));
        true
    }

    /// A touch on the surface: `onPressOutside` of the shown overlays
    /// watching presses that a finger went down outside of.
    pub(super) fn overlay_touches(&mut self, touch: &TouchEvent) {
        if touch.phase != TouchPhase::Start {
            return;
        }
        if !self.overlay_state.hinting.is_empty() {
            self.hint_touches(touch);
        }
        if self.overlay_state.watched.is_empty() {
            return;
        }
        for point in touch.points.iter().filter(|p| p.changed) {
            for i in 0..self.overlays.len() {
                let key = self.overlays[i];
                let node = &self.nodes[key as usize];
                let Some(state) = self.overlay(key) else {
                    continue;
                };
                if state.host.is_none() || !node.events.contains(EventKind::PressOutside) {
                    continue;
                }
                let id = node.id;
                let anchor = anchor_node(state);
                let inside = point.path.iter().any(|&p| {
                    p == id
                        || Some(p) == anchor
                        || self.key(p).is_ok_and(|k| {
                            self.nodes[k as usize].is_overlay() && self.is_ancestor(key, k)
                        })
                });
                if inside {
                    continue;
                }
                self.events.push(crate::element::JsEvent::Event(
                    id,
                    EventKind::PressOutside,
                    EventPayload::Map(vec![("pagePosition", PayloadValue::Point(point.page))]),
                ));
            }
        }
    }

    /// The size of the root view overlay `key` is shown in.
    fn overlay_host_size(&self, host: NodeId) -> Option<(Size<Points>, crate::EdgeInsets)> {
        if host == ROOT_ID {
            return Some((self.viewport, self.safe_area));
        }
        let root = self.nodes[self.key(host).ok()? as usize].root.as_ref()?;
        Some((root.reported.unwrap_or(self.viewport), root.insets))
    }

    /// Lays out shown overlay `key` in a box the size of its root view,
    /// when that size or its content changed, and places it.
    pub(super) fn layout_overlay(&mut self, key: Key) {
        let Some(state) = self.overlay(key) else {
            return;
        };
        let (Some(host), wrapper) = (state.host, state.wrapper) else {
            return;
        };
        let Some((size, _)) = self.overlay_host_size(host) else {
            return;
        };
        let root = self.nodes[key as usize].root.as_ref().expect("root state");
        let changed = root.laid_out != Some((size, 0.0));
        if !changed && !self.layout.dirty(wrapper) {
            return;
        }
        if changed {
            let style = taffy::Style {
                size: taffy::Size {
                    width: taffy::Dimension::length(size.width.0),
                    height: taffy::Dimension::length(size.height.0),
                },
                ..taffy::Style::default()
            };
            self.layout.set_style(wrapper, style);
        }
        self.nodes[key as usize]
            .root
            .as_mut()
            .expect("root state")
            .laid_out = Some((size, 0.0));
        self.layout_root(wrapper, definite(size));
        self.emit_frames(key);
    }

    /// Where overlay `key` of `frame` (as laid out in its root view) goes:
    /// against its anchor when it has one it can find. Reports a new
    /// placement to `onPosition`.
    pub(super) fn overlay_origin(&mut self, key: Key, frame: Bounds<Points>) -> Point<Points> {
        let Some(state) = self.overlay(key) else {
            return frame.origin;
        };
        let (config, Some(host)) = (state.config, state.host) else {
            return frame.origin;
        };
        let anchor = match self.resolved_anchor(key) {
            OverlayAnchor::None => None,
            OverlayAnchor::Point(p) => Some(Bounds {
                origin: p,
                size: Size::default(),
            }),
            OverlayAnchor::Bounds(bounds) => Some(bounds),
            OverlayAnchor::Node(id) => self.measure(id).map(|m| Bounds {
                origin: m.page,
                size: m.frame.size,
            }),
            OverlayAnchor::Content(id) => self.content_bounds(self.content_anchor(id)),
        };
        let Some(anchor) = anchor else {
            return frame.origin;
        };
        let Some((size, insets)) = self.overlay_host_size(host) else {
            return frame.origin;
        };
        let m = config.margin.0;
        let area = inset(
            rect(0.0, 0.0, size.width.0, size.height.0),
            [
                insets.top.0 + m,
                insets.right.0 + m,
                insets.bottom.0 + m,
                insets.left.0 + m,
            ],
        );
        let placed = place(
            anchor,
            frame.size,
            area,
            &config,
            self.nodes[key as usize].rtl,
        );
        let bounds = Bounds {
            origin: placed.origin,
            size: frame.size,
        };
        let node = &self.nodes[key as usize];
        let (id, listens) = (node.id, node.events.contains(EventKind::Position));
        let state = self.overlay_mut(key).expect("overlay");
        if state.placed != Some((placed, bounds)) {
            state.placed = Some((placed, bounds));
            if listens {
                self.events.push(crate::element::JsEvent::Event(
                    id,
                    EventKind::Position,
                    EventPayload::Map(vec![
                        (
                            "placement",
                            PayloadValue::Str(placed.placement.name().into()),
                        ),
                        ("bounds", PayloadValue::Bounds(bounds)),
                        ("available", PayloadValue::Size(placed.available)),
                    ]),
                ));
            }
        }
        placed.origin
    }

    /// The box around what view `id` draws in its root view: around its
    /// children's frames, or its own while it has none (laid out ones only).
    fn content_bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        let own = self.measure(id)?;
        let key = self.key(id).ok()?;
        let mut out: Option<(f32, f32, f32, f32)> = None;
        for &c in &self.nodes[key as usize].children {
            let n = &self.nodes[c as usize];
            if n.is_overlay() || n.layout.is_none() {
                continue;
            }
            let Some(m) = self.measure(n.id) else {
                continue;
            };
            let (x0, y0) = (m.page.x.0, m.page.y.0);
            let (x1, y1) = (x0 + m.frame.size.width.0, y0 + m.frame.size.height.0);
            out = Some(match out {
                None => (x0, y0, x1, y1),
                Some((a, b, c, d)) => (a.min(x0), b.min(y0), c.max(x1), d.max(y1)),
            });
        }
        Some(match out {
            // Around the children, and the view's own padding and border
            // around them (a trigger draws those too), within its frame.
            Some((x0, y0, x1, y1)) => {
                let l = self.rounded_layout(self.nodes[key as usize].layout?);
                let (left, top) = (own.page.x.0, own.page.y.0);
                let (right, bottom) =
                    (left + own.frame.size.width.0, top + own.frame.size.height.0);
                let x0 = (x0 - l.padding.left - l.border.left).max(left);
                let y0 = (y0 - l.padding.top - l.border.top).max(top);
                let x1 = (x1 + l.padding.right + l.border.right).min(right);
                let y1 = (y1 + l.padding.bottom + l.border.bottom).min(bottom);
                rect(x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
            }
            None => Bounds {
                origin: own.page,
                size: own.frame.size,
            },
        })
    }

    /// Places the shown overlays with an anchor again, at the end of the
    /// commit: their anchors may have moved (the layout, the lists,
    /// scrolling).
    pub(super) fn place_overlays(&mut self) {
        for i in 0..self.overlays.len() {
            let key = self.overlays[i];
            let anchored = self.overlay(key).is_some_and(|s| s.host.is_some())
                && self.resolved_anchor(key) != OverlayAnchor::None;
            let frame = self.nodes[key as usize].frame;
            if !anchored || !self.nodes[key as usize].created || frame.size.width.0.is_nan() {
                continue;
            }
            let origin = self.overlay_origin(key, frame);
            if origin != frame.origin {
                self.set_frame(
                    key,
                    Bounds {
                        origin,
                        size: frame.size,
                    },
                );
            }
        }
    }
}

/// The view an overlay is anchored to.
fn anchor_node(state: &OverlayState) -> Option<NodeId> {
    match state.config.anchor {
        OverlayAnchor::Node(id) | OverlayAnchor::Content(id) => Some(id),
        _ => None,
    }
}
