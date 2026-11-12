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
//! is shown). Closing is the app's (`nsh-base`'s components). A shown
//! overlay's content goes in the Tab order where the app put it, after the
//! view before it there ([`Core::order_overlays_for_tab`],
//! [`crate::ViewProps::tab_after`]), not after its root view's children.
//!
//! A hint overlay ([`OverlayConfig::hint`]) is shown by the core: its
//! anchor (its parent without one) listens to the pointer coming and going
//! while the overlay is in the view on a desktop; the pointer resting on it
//! for the hint's delay shows the hint (a task of the components' executor
//! wakes the engine then), the pointer leaving or pressing it hides it, as
//! GPUI's tooltips do. In every idiom the focus the keyboard moved shows
//! it too, as WAI-ARIA's tooltips: the focus that Tab, an arrow, a
//! shortcut or the app's `focus()` after a key brought to its anchor (or
//! into it, outside an overlay, the nearest hint's) shows it at once until
//! the focus leaves ([`Core::focus_hints`]), by `focus-visible:`'s rule
//! ([`Core::focus_shows`]) without its exception for an input that edits.
//! A press, a tap or a click that brings the focus leaves the hint to the
//! pointer, as Radix's tooltips do: the press hid it, and it shows again
//! when the pointer comes back and rests, so nothing stays up once the
//! pointer left. Escape hides a hint that is shown
//! ([`Core::overlay_escape`]). The overlay hears what it asks for (`Show`,
//! `Dismiss`, with the [`HintReason`]), so a component owning it
//! (`nsh-base`'s `Tooltip`) can decide instead ([`OverlayConfig::open`]). An element's `tooltip` is a
//! hint overlay the core makes inside the element ([`Core::set_tooltip`]).

use rustc_hash::FxHashMap;
use taffy::NodeId as LayoutId;

use super::{Core, Key, Kind, NO_KEY, definite};
use crate::{
    ContextMenuEvent, EventKind, EventPayload, NodeId, PayloadValue, PointerType, Prop, ROOT_ID,
    Tag, TextEngine, TouchEvent, TouchPhase,
    element::{
        HintReason,
        task::{Action, Task, act_after},
    },
    geometry::{Bounds, Point, Points, Size, point, px, rect},
    keymap::{KeyBinding, Keystroke, When},
    mount::MountItem,
    ops::{Op, OverlayProp},
    overlay::{
        HINT_DELAY, OverlayAnchor, OverlayConfig, Placed, Placement, TooltipContent, inset, place,
        place_fitted,
    },
    props::PointerEvents,
};

/// What the overlays have a node listen to (`Node::overlay_watched`).
pub(super) mod watch {
    /// Touches, for an overlay's `onPressOutside`.
    pub(in crate::core) const PRESS: u8 = 1;
    /// The pointer coming and going and touches, for a hint.
    pub(in crate::core) const HINT: u8 = 2;
}

/// The gap between an element and its `tooltip`, and the distance the
/// tooltip keeps from the safe area's edges.
const TOOLTIP_GAP: f32 = 4.0;

/// A hint's wait for the pointer to rest (dropping it cancels it).
pub(super) struct HintTimer(#[allow(dead_code)] Task<()>);

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
    pub(super) native_anchor: Option<crate::overlay::PlacedAnchor>,
    /// The view it follows in the Tab order while it is shown
    /// ([`crate::ViewProps::tab_after`], [`Core::order_overlays_for_tab`]).
    pub(super) tab_after: Option<NodeId>,
    /// A hint: the pointer rested on its anchor, and has not left or
    /// pressed it since.
    pub(super) hinted: bool,
    /// A hint: the pointer is on its anchor, resting until it shows.
    pub(super) waiting: Option<HintTimer>,
    /// A hint: the focus is on its anchor, whatever brought it there.
    pub(super) focus_on: bool,
    /// A hint: the focus on its anchor shows it, the keyboard having
    /// brought it there (`Core::focus_by_keyboard`), and no Escape or
    /// press hid it since.
    pub(super) focus_shown: bool,
    /// A hint on a link of a text (a span, which has no frame of its own):
    /// where the pointer came over it, in its root view's coordinates,
    /// what it is placed against ([`Core::resolved_anchor`]).
    pub(super) pointer: Option<Point<Points>>,
    /// Its `cover` view's frame in it, once that was laid out, with the
    /// overlay's size and the view's frame in its parent then.
    pub(super) covered: Option<(Bounds<Points>, Size<Points>, Bounds<Points>)>,
    /// The room `onPosition` last told it (`available`), kept while it is
    /// hidden: an overlay whose max size along its side is still that room
    /// when shown again follows it ([`Core::natural_extent`]).
    pub(super) told: Option<Size<Points>>,
    /// Its extent along its side without the room it was told, measured
    /// once per layout while that room holds it ([`Core::natural_extent`]).
    pub(super) natural: Option<Points>,
    /// The max size it was last found held to, along its side: still that
    /// room's while the app has yet to take the newer one `told` carries
    /// (the core flipped it, and told it so, in the same commit).
    pub(super) held: Option<Points>,
}

impl OverlayState {
    /// A hint the pointer or the focus the keyboard moved shows.
    fn hint_shown(&self) -> bool {
        self.hinted || self.focus_shown
    }
}

/// What the overlays add to the native side: the nodes listening to
/// touches for `onPressOutside`, and whether Escape and back are taken.
#[derive(Debug, Default)]
pub(super) struct Overlays {
    /// The shown overlays and the other nodes listening to touches for
    /// them (their anchors and root views), checked by id (keys are
    /// reused).
    pub(super) watched: Vec<(Key, NodeId)>,
    /// A shown overlay listens to `onCancel`: Escape is bound and the back
    /// button listened to.
    pub(super) cancel: bool,
    /// A hint is shown: Escape is bound (it hides it).
    pub(super) hint_escape: bool,
    /// The anchors of the hints in the view listening to the pointer
    /// (desktops), checked by id.
    pub(super) hinting: Vec<(Key, NodeId)>,
    /// The elements with a `tooltip`, by id: the nodes made for it.
    pub(super) tooltips: FxHashMap<NodeId, CoreTooltip>,
}

impl<M: TextEngine> Core<M> {
    /// A new overlay node `key` with layout node `layout`: its wrapper.
    pub(super) fn overlay_made(&mut self, key: Key, layout: LayoutId) {
        let wrapper = self
            .layout
            .new_with_children(taffy::Style::default(), &[layout]);
        // A terminal sizes a box by its content unless told its explicit
        // size is its size: the wrapper's is its host's, the box the
        // overlay's room is measured in (without it, 0 rows, and the
        // overlay's content shrinks to a row apiece).
        self.layout.set_role(
            wrapper,
            super::terminal_layout::Role {
                sized: true,
                ..Default::default()
            },
        );
        if let Some(root) = self.nodes[key as usize].root.as_mut() {
            root.overlay = Some(Box::new(OverlayState {
                config: OverlayConfig::default(),
                wrapper,
                host: None,
                placed: None,
                native_anchor: None,
                tab_after: None,
                hinted: false,
                waiting: None,
                focus_on: false,
                focus_shown: false,
                pointer: None,
                covered: None,
                told: None,
                natural: None,
                held: None,
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
        self.set_native_overlay_anchor(key, None);
        let (id, created) = (
            self.nodes[key as usize].id,
            self.nodes[key as usize].created,
        );
        let state = self.overlay(key).map(|s| (s.host, s.wrapper));
        if let Some((Some(_), _)) = state
            && created
        {
            self.mount.push(MountItem::Remove { id });
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

    /// Whether `key` is the overlay of an element's `tooltip`, or another
    /// hint overlay inside an element (a Rust `tooltip`, a link's URL hint
    /// of `nsh-base`): not one of its children for its classes (`first:`,
    /// `last:`, ...).
    pub(super) fn is_tooltip_overlay(&self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        node.is_overlay()
            && node.parent != NO_KEY
            && (self.overlay(key).is_some_and(|s| s.config.hint.is_some())
                || self
                    .overlay_state
                    .tooltips
                    .get(&self.nodes[node.parent as usize].id)
                    .is_some_and(|t| t.overlay == node.id))
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
                let hidden = self.layout.displays_none(layout);
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
        let mut opened = Vec::new();
        // The hints in the view, whose anchors listen to the pointer.
        let mut hints = Vec::new();
        for (_, key) in order {
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
                if !state.config.open.unwrap_or(state.hint_shown()) {
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
                self.mount.push(MountItem::Remove { id });
            }
            let state = self.overlay_mut(key).expect("overlay");
            state.host = target_id;
            state.placed = None;
            let Some(host) = target_id else {
                continue;
            };
            self.ensure_created(key);
            self.mount.push(MountItem::Insert {
                parent: host,
                child: id,
                before: None,
            });
            if let Some(root) = self.nodes[key as usize].root.as_mut() {
                root.laid_out = None;
            }
            self.needs_layout = true;
            self.tab_places_stale = true;
            opened.push(key);
        }
        // Opened last, on top: in the order they were shown.
        if !opened.is_empty() {
            self.overlays.retain(|k| !opened.contains(k));
            self.overlays.extend(opened);
        }
        self.sync_overlay_listeners(&hints);
    }

    /// The touches and keys the shown overlays need, and the pointer the
    /// anchors of `hints` (in the view) follow.
    fn sync_overlay_listeners(&mut self, hints: &[Key]) {
        let mut watched: Vec<(Key, NodeId)> = Vec::new();
        let mut cancel = false;
        let mut hint_escape = false;
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
            hint_escape |= state.config.hint.is_some();
            if !watching {
                continue;
            }
            // Every shown overlay, so a press in one inside a watching one
            // tells where it is.
            watched.push((key, node.id));
            if node.events.contains(EventKind::PressOutside) {
                for id in [Some(host), anchor_node(state)].into_iter().flatten() {
                    if let Ok(k) = self.key(id) {
                        watched.push((k, self.nodes[k as usize].id));
                    }
                }
            }
        }
        watched.sort_unstable();
        watched.dedup();
        let old = std::mem::take(&mut self.overlay_state.watched);
        self.rewatch(&old, &watched, watch::PRESS);
        self.overlay_state.watched = watched;
        // Hints only follow a pointer (the desktops).
        let mut hinting: Vec<(Key, NodeId)> = Vec::new();
        if self
            .components
            .environment
            .idiom
            .desktop_on(self.components.environment.os)
        {
            for &key in hints {
                if let Some(k) = self.hint_anchor(key) {
                    hinting.push((k, self.nodes[k as usize].id));
                    // A link of a text: its block listens to touches, so a
                    // press on the link hides the hint. A span is not
                    // watched yet the first time (`is_text_span`, not
                    // `is_link_span`): watching it is what makes it one.
                    if self.is_text_span(k)
                        && let Some(block) = self.framed(k)
                    {
                        hinting.push((block, self.nodes[block as usize].id));
                    }
                }
            }
            hinting.sort_unstable();
            hinting.dedup();
        }
        let old = std::mem::take(&mut self.overlay_state.hinting);
        self.rewatch(&old, &hinting, watch::HINT);
        self.overlay_state.hinting = hinting;
        if cancel != self.overlay_state.cancel {
            self.overlay_state.cancel = cancel;
            // The root's table and back listener are made again.
            self.components.executor.keys.borrow_mut().changed = true;
            self.components.executor.back.borrow_mut().changed = true;
        }
        if hint_escape != self.overlay_state.hint_escape {
            self.overlay_state.hint_escape = hint_escape;
            self.components.executor.keys.borrow_mut().changed = true;
        }
    }

    /// The nodes of `old` not in `new` stop listening for `bit`, those of
    /// `new` not in `old` start. A link of a text listens through its text
    /// block's links ([`crate::text::TextLink::events`]): the block is
    /// merged again.
    fn rewatch(&mut self, old: &[(Key, NodeId)], new: &[(Key, NodeId)], bit: u8) {
        for &(k, id) in old {
            if !new.contains(&(k, id)) && self.nodes.get(k as usize).is_some_and(|n| n.id == id) {
                self.nodes[k as usize].overlay_watched &= !bit;
                self.mark(k, super::dirty::EVENTS);
                if self.nodes[k as usize].inline {
                    self.mark_text_block(k);
                }
            }
        }
        for &(k, id) in new {
            if !old.contains(&(k, id)) {
                self.nodes[k as usize].overlay_watched |= bit;
                self.mark(k, super::dirty::EVENTS);
                if self.nodes[k as usize].inline {
                    self.mark_text_block(k);
                }
            }
        }
    }

    /// What hint overlay `key` is placed against and whose pointer it
    /// follows: its anchor, else its parent when that is a span of a text
    /// (a link, pressable or not: once its hint watches it, the platforms
    /// report the pointer coming over its characters and leaving them),
    /// else the nearest view around it with a frame.
    fn hint_anchor(&self, key: Key) -> Option<Key> {
        match self.overlay(key)?.config.anchor {
            OverlayAnchor::Node(id)
            | OverlayAnchor::Content(id)
            | OverlayAnchor::Beside { node: id, .. } => self.key(id).ok(),
            OverlayAnchor::Point(_) | OverlayAnchor::Bounds(_) => None,
            OverlayAnchor::None => {
                let parent = self.nodes[key as usize].parent;
                // Any span, watched or not yet: the watch that makes it a
                // link of its text ([`Self::is_link_span`]) comes from
                // this answer.
                if parent != NO_KEY && self.is_text_span(parent) {
                    return Some(parent);
                }
                self.framed(parent)
            }
        }
    }

    /// Whether `key` is a nested span of a text, with no frame of its own.
    fn is_text_span(&self, key: Key) -> bool {
        let n = &self.nodes[key as usize];
        n.kind == Kind::Text && n.inline && n.layout.is_none()
    }

    /// Whether `key` is a link of a text (`AttributedText::links`): a
    /// nested span taking presses, or one a hint watches (a `RichEditor`'s
    /// link mark, whose presses are the editor's: it only hears the
    /// pointer come and go).
    fn is_link_span(&self, key: Key) -> bool {
        let n = &self.nodes[key as usize];
        self.is_text_span(key)
            && (super::pressable(n.events) || n.overlay_watched & watch::HINT != 0)
    }

    /// `key` itself, or the nearest view around it, with a frame (a link
    /// span's text block).
    fn framed(&self, mut k: Key) -> Option<Key> {
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            if n.layout.is_some() {
                return Some(k);
            }
            k = n.parent;
        }
        None
    }

    /// What overlay `key` is placed against: a hint without an anchor
    /// against the view it follows ([`Self::hint_anchor`]); one on a link
    /// of a text where the pointer came over the link (its text block
    /// for the keyboard focus, which comes with no pointer).
    fn resolved_anchor(&self, key: Key) -> OverlayAnchor {
        let Some(state) = self.overlay(key) else {
            return OverlayAnchor::None;
        };
        match state.config.anchor {
            OverlayAnchor::None if state.config.hint.is_some() => {
                let Some(k) = self.hint_anchor(key) else {
                    return OverlayAnchor::None;
                };
                if self.is_text_span(k) {
                    if let Some(at) = state.pointer.filter(|_| !state.focus_shown) {
                        return OverlayAnchor::Point(at);
                    }
                    return self.framed(k).map_or(OverlayAnchor::None, |f| {
                        OverlayAnchor::Node(self.nodes[f as usize].id)
                    });
                }
                OverlayAnchor::Node(self.nodes[k as usize].id)
            }
            anchor => anchor,
        }
    }

    /// The pointer came over node `id` or left it (`kind`), at `at` in its
    /// root view: the hints it anchors wait for it to rest, or hide.
    pub(super) fn overlay_hover(&mut self, id: NodeId, kind: EventKind, at: Option<Point<Points>>) {
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
        let span = self.is_link_span(anchor);
        for key in hints {
            match kind {
                EventKind::MouseEnter => {
                    if span && let Some(state) = self.overlay_mut(key) {
                        // Where it goes, unless it shows already.
                        if !state.hint_shown() {
                            state.pointer = at;
                        }
                    }
                    self.hint_wait(key)
                }
                _ => self.unhint(key),
            }
        }
    }

    /// The pointer is on hint `key`'s anchor: it shows once the pointer
    /// rested there for its delay ([`Self::hint_due`]).
    fn hint_wait(&mut self, key: Key) {
        let executor = self.components.executor.clone();
        let id = self.nodes[key as usize].id;
        let Some(state) = self.overlay_mut(key) else {
            return;
        };
        if state.hinted || state.waiting.is_some() {
            return;
        }
        let delay = state.config.hint.unwrap_or(HINT_DELAY);
        state.waiting = Some(HintTimer(act_after(&executor, id, delay, Action::Hint(id))));
    }

    /// Hint overlay `id`'s delay is over with the pointer on its anchor: it
    /// shows (in the commit).
    pub(super) fn hint_due(&mut self, id: NodeId) {
        let Ok(key) = self.key(id) else {
            return;
        };
        let Some(state) = self.overlay_mut(key) else {
            return;
        };
        if state.waiting.take().is_none() || state.config.hint.is_none() {
            return;
        }
        let was = state.hint_shown();
        state.hinted = true;
        if !was {
            self.hint_changed(key, true, HintReason::Pointer);
        }
    }

    /// Hint `key` stops waiting, and hides when the pointer had it shown
    /// (and the focus does not keep it).
    fn unhint(&mut self, key: Key) {
        self.hide_hint(key, false, HintReason::Pointer);
    }

    /// Scroll view or list `scroll` moved its content: a hint on a link of
    /// a text in it, placed where the pointer came over the link (a point
    /// of the root view, which does not move with the link), would show
    /// where the link was. It hides, as when the pointer leaves the link;
    /// the pointer coming over a link again shows that link's where it is.
    /// A hint the keyboard focus shows stays, placed against the link's
    /// text block, which the scroll moves.
    pub(super) fn overlay_scrolled(&mut self, scroll: Key) {
        let hints: Vec<Key> = self
            .overlays
            .iter()
            .copied()
            .filter(|&k| {
                self.overlay(k).is_some_and(|s| {
                    s.config.hint.is_some()
                        && matches!(s.config.anchor, OverlayAnchor::None)
                        && s.pointer.is_some()
                        && (s.hinted || s.waiting.is_some())
                }) && self
                    .hint_anchor(k)
                    .is_some_and(|a| self.is_text_span(a) && self.is_within(a, scroll))
            })
            .collect();
        for key in hints {
            if let Some(state) = self.overlay_mut(key) {
                state.pointer = None;
            }
            self.unhint(key);
        }
    }

    /// Whether `key` is `outer` or inside it.
    pub(super) fn is_within(&self, mut key: Key, outer: Key) -> bool {
        while key != NO_KEY {
            if key == outer {
                return true;
            }
            key = self.nodes[key as usize].parent;
        }
        false
    }

    /// Hint `key` stops waiting and the pointer's showing ends, the
    /// focus's too when `focus`: it asks to hide when it was shown.
    fn hide_hint(&mut self, key: Key, focus: bool, reason: HintReason) {
        let Some(state) = self.overlay_mut(key) else {
            return;
        };
        state.waiting = None;
        let was = state.hint_shown();
        state.hinted = false;
        if focus {
            state.focus_shown = false;
        }
        if was && !state.hint_shown() {
            self.hint_changed(key, false, reason);
        }
    }

    /// The focus moved: the hints whose anchor it came to show when the
    /// keyboard brought it there (`Core::focus_by_keyboard`), those it left
    /// hide; a move inside an anchor decides nothing again. The focus
    /// counts for the nearest hint's anchor on its chain, up to the overlay
    /// it is in (a popup's focus is not on its trigger's hint).
    pub(super) fn focus_hints(&mut self) {
        let mut target = None;
        for &(k, _) in &self.focus_chain {
            if self.overlays.iter().any(|&h| {
                self.overlay(h).is_some_and(|s| s.config.hint.is_some())
                    && self.hint_anchor(h) == Some(k)
            }) {
                target = Some(k);
                break;
            }
            if self.nodes[k as usize].is_overlay() {
                break;
            }
        }
        let hints: Vec<Key> = self
            .overlays
            .iter()
            .copied()
            .filter(|&k| self.overlay(k).is_some_and(|s| s.config.hint.is_some()))
            .collect();
        let keyboard = self.focus_by_keyboard;
        for key in hints {
            let on = target.is_some() && self.hint_anchor(key) == target;
            let Some(state) = self.overlay_mut(key) else {
                continue;
            };
            if on == state.focus_on {
                continue;
            }
            state.focus_on = on;
            let was = state.hint_shown();
            // A press that brings the focus hid the pointer's hint: showing
            // it for that focus would keep it up long after the pointer
            // left (a toolbar's tooltip after every click). Only the
            // keyboard's focus shows it, as `focus-visible:` shows a ring.
            state.focus_shown = on && keyboard;
            let now = state.hint_shown();
            if was != now {
                self.hint_changed(key, now, HintReason::Focus);
            }
        }
    }

    /// Tells hint `key` what the pointer or the focus asks for: `Show` or
    /// `Dismiss`, with why.
    fn hint_changed(&mut self, key: Key, shown: bool, reason: HintReason) {
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
                EventPayload::Map(vec![(
                    "reason",
                    PayloadValue::Str(reason.as_str().to_owned()),
                )]),
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
                    s.config.hint.is_some() && (s.hint_shown() || s.waiting.is_some())
                })
            })
            .collect();
        for key in hints {
            // A link's text block for a link of a text: a touch's path
            // holds views.
            let Some(anchor) = self
                .hint_anchor(key)
                .and_then(|k| self.framed(k))
                .map(|k| self.nodes[k as usize].id)
            else {
                continue;
            };
            let pressed = touch
                .points
                .iter()
                .any(|p| p.changed && p.path.contains(&anchor));
            if pressed {
                self.hide_hint(key, true, HintReason::Pointer);
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

    /// Escape's binding, while an overlay listens to `onCancel` or a hint
    /// is shown.
    pub(super) fn overlay_key_binding(&self) -> Option<KeyBinding> {
        if !self.overlay_state.cancel && !self.overlay_state.hint_escape {
            return None;
        }
        let escape = Keystroke::parse_with("escape", false).ok()?;
        Some(KeyBinding::new(ESCAPE_BINDING, escape, When::Always, false))
    }

    /// Escape: the top shown overlay that is a hint hides (it asks to,
    /// [`HintReason::Escape`]), else `onCancel` of the top overlay
    /// listening to it.
    pub(super) fn overlay_escape(&mut self) {
        let top = self.overlays.iter().rev().copied().find(|&k| {
            self.overlay(k).is_some_and(|s| {
                s.host.is_some()
                    && (s.config.hint.is_some()
                        || self.nodes[k as usize].events.contains(EventKind::Cancel))
            })
        });
        let Some(key) = top else {
            return;
        };
        if self.overlay(key).is_some_and(|s| s.config.hint.is_none()) {
            self.overlay_cancel();
            return;
        }
        let state = self.overlay_mut(key).expect("overlay");
        state.waiting = None;
        state.hinted = false;
        state.focus_shown = false;
        // Shown by the app (`open`) or the pointer and focus: it asks to
        // hide either way.
        self.hint_changed(key, false, HintReason::Escape);
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
            self.press_outside(point.page, &point.path);
        }
    }

    /// A context menu asked for on `id`: a secondary click goes down as a
    /// press does, so the shown overlays it is outside of hear
    /// `onPressOutside` (a menu open elsewhere closes as a new one opens).
    /// The platforms send no touch for a secondary click; a menu asked for
    /// by the keyboard or an assistive technology is no press, nor is a
    /// long press, whose touch went down already.
    ///
    /// Returns those `onPressOutside` events (each overlay and its payload)
    /// for the caller to hand out before `onContextMenu` itself, as a
    /// press outside comes before what the press does: a context menu open
    /// on the view closes before the view asks for one again, which then
    /// opens where the pointer is.
    pub fn context_menu_presses_outside(
        &mut self,
        id: NodeId,
        event: &ContextMenuEvent,
    ) -> Vec<(NodeId, EventPayload)> {
        if event.pointer_type != Some(PointerType::Mouse) || self.overlay_state.watched.is_empty() {
            return Vec::new();
        }
        let Ok(mut key) = self.key(id) else {
            return Vec::new();
        };
        let mut path = Vec::new();
        while key != NO_KEY {
            path.push(self.nodes[key as usize].id);
            key = self.nodes[key as usize].parent;
        }
        let from = self.events.len();
        self.press_outside(event.page_position, &path);
        self.events
            .drain(from..)
            .filter_map(|event| match event {
                crate::element::JsEvent::Event(id, _, payload) => Some((id, payload)),
                _ => None,
            })
            .collect()
    }

    /// A press at `page` on the views of `path` (the one pressed first):
    /// `onPressOutside` of the shown overlays watching presses that it is
    /// outside of, their anchors and the overlays inside them.
    fn press_outside(&mut self, page: Point<Points>, path: &[NodeId]) {
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
            let inside = path.iter().any(|&p| {
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
                EventPayload::Map(vec![("pagePosition", PayloadValue::Point(page))]),
            ));
        }
    }

    /// The size of the root view overlay `key` is shown in.
    fn overlay_host_size(&self, host: NodeId) -> Option<(Size<Points>, crate::EdgeInsets)> {
        if host == ROOT_ID {
            return Some((self.viewport, self.safe_area));
        }
        let key = self.key(host).ok()?;
        let root = self.nodes[key as usize].root.as_ref()?;
        // A window whose size is not known yet: as large as its content.
        let size = self
            .root_view_size(key)
            .unwrap_or(self.nodes[key as usize].frame.size);
        Some((size, root.insets))
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
        // Its content may have changed: measured again when needed.
        if let Some(state) = self.overlay_mut(key) {
            state.natural = None;
        }
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
        let resolved_anchor = self.resolved_anchor(key);
        let anchor = match resolved_anchor {
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
            OverlayAnchor::Beside { node, edges } => {
                match (self.measure(node), self.measure(edges)) {
                    (Some(n), Some(e)) => Some(if config.placement.is_horizontal() {
                        rect(
                            e.page.x.0,
                            n.page.y.0,
                            e.frame.size.width.0,
                            n.frame.size.height.0,
                        )
                    } else {
                        rect(
                            n.page.x.0,
                            e.page.y.0,
                            n.frame.size.width.0,
                            e.frame.size.height.0,
                        )
                    }),
                    (Some(n), None) => Some(Bounds {
                        origin: n.page,
                        size: n.frame.size,
                    }),
                    _ => None,
                }
            }
        };
        let Some(anchor) = anchor else {
            // A terminal stacks an overlay's boxes over the page by its
            // placement (they clear the Cells behind them): one placed by
            // its insets (a sheet's panel, a toast) is its own anchor.
            let origin = self.framed_within(key, frame, host);
            let own = self.layout.grid().map(|_| crate::overlay::PlacedAnchor {
                bounds: Bounds {
                    origin,
                    size: frame.size,
                },
                node: None,
                placement: config.placement,
            });
            self.set_native_overlay_anchor(key, own);
            return origin;
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
        // A terminal frames a popup's box one Cell outside it (a rounded
        // line, `nsh-platform-tui`): it is placed with that frame, which
        // then sits beside the trigger, never on its row, and lines up
        // with its start or end.
        let ring = self.outside_frame(key);
        let framed = Size {
            width: frame.size.width + ring.width * 2.0,
            height: frame.size.height + ring.height * 2.0,
        };
        let placed = match self.covering(key, config, framed) {
            Some(at) => {
                // Its start on the anchor's (a list as wide as its
                // trigger lines up with it), the cover view's middle on
                // the anchor's (a row taller or shorter than the trigger
                // keeps its text on the trigger's), inside the area as far
                // as it fits.
                let keep = |v: f32, lo: f32, hi: f32, len: f32| v.min(hi - len).max(lo);
                let x = keep(
                    anchor.origin.x.0,
                    area.origin.x.0,
                    area.right().0,
                    framed.width.0,
                );
                let y = keep(
                    anchor.origin.y.0 + (anchor.size.height.0 - at.size.height.0) / 2.0
                        - at.origin.y.0
                        - ring.height.0,
                    area.origin.y.0,
                    area.bottom().0,
                    framed.height.0,
                );
                Placed {
                    origin: point(Points(x), Points(y)),
                    placement: config.placement,
                    available: area.size,
                }
            }
            None => {
                // Beside its anchor (a submenu beside its item) the frame
                // takes the rows around the anchor's: the box's first row
                // is the anchor's (its last, aligned with the end), as a
                // submenu's first item lines up with its item.
                // The frame is a ring outside the box or the panel's own
                // line inside it: a row either way.
                let line = match self.layout.grid() {
                    Some(grid) if self.framed_box(key).is_some() => grid.height,
                    _ => ring.height.0,
                };
                let anchor = match config.placement.is_horizontal() {
                    true => rect(
                        anchor.origin.x.0,
                        anchor.origin.y.0 - line,
                        anchor.size.width.0,
                        anchor.size.height.0 + line * 2.0,
                    ),
                    false => anchor,
                };
                // A terminal's frame is the gap: it starts on the row (or
                // the column) after the trigger's, as rounding an offset
                // up to a Cell would leave a blank row between them.
                let config = match self.layout.grid() {
                    Some(_) => OverlayConfig {
                        offset: Points::ZERO,
                        ..config
                    },
                    None => config,
                };
                let rtl = self.nodes[key as usize].rtl;
                let horizontal = config.placement.is_horizontal();
                match self.natural_extent(key, horizontal, frame.size, area, ring) {
                    // Its size follows the room it is told: the side is
                    // chosen at its natural size.
                    Some(natural) => {
                        let natural = match horizontal {
                            true => Size {
                                width: natural + ring.width * 2.0,
                                ..framed
                            },
                            false => Size {
                                height: natural + ring.height * 2.0,
                                ..framed
                            },
                        };
                        place_fitted(anchor, natural, area, &config, rtl)
                    }
                    None => place(anchor, framed, area, &config, rtl),
                }
            }
        };
        // On the device pixel grid, as every other frame is (`round`): an
        // origin between two pixels (a context menu at the pointer, a
        // popup centred on a trigger of odd width) would have the window
        // resample the whole overlay, its text included, and draw it soft.
        let ratio = self.pixel_ratio();
        let placed = Placed {
            origin: point(
                Points(super::round((placed.origin.x + ring.width).0, ratio)),
                Points(super::round((placed.origin.y + ring.height).0, ratio)),
            ),
            available: Size {
                width: (placed.available.width - ring.width * 2.0).max(Points::ZERO),
                height: (placed.available.height - ring.height * 2.0).max(Points::ZERO),
            },
            ..placed
        };
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
                state.told = Some(placed.available);
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
        self.set_native_overlay_anchor(
            key,
            Some(crate::overlay::PlacedAnchor {
                bounds: anchor,
                node: match resolved_anchor {
                    OverlayAnchor::Node(id) => Some(id),
                    _ => None,
                },
                placement: placed.placement,
            }),
        );
        placed.origin
    }

    /// The extent of overlay `key` (laid out at `size`) along its side's
    /// axis (`horizontal`: its width) when its size follows the room it
    /// was told: its max size that way is the `available` it last heard
    /// (a select's list, an app's popup that scrolls past it). That room
    /// may be the other side's, or the side's before its content grew, so
    /// while it holds the overlay to it the core measures the overlay
    /// without it (up to `area`, as large as either side's room can be,
    /// less the terminal's frame `ring`): once per layout, only then.
    /// `None` for any other overlay: its size is its own, placed as it is.
    fn natural_extent(
        &mut self,
        key: Key,
        horizontal: bool,
        size: Size<Points>,
        area: Bounds<Points>,
        ring: Size<Points>,
    ) -> Option<Points> {
        let state = self.overlay(key)?;
        let told = state.told?;
        let layout = self.nodes[key as usize].layout?;
        let max = self.layout.style(layout).max_size;
        let (max, told, extent, room) = match horizontal {
            true => (
                max.width,
                told.width,
                size.width,
                area.size.width - ring.width * 2.0,
            ),
            false => (
                max.height,
                told.height,
                size.height,
                area.size.height - ring.height * 2.0,
            ),
        };
        // A max size of the app's own: the overlay's size is its own.
        let taffy::ExpandedLengthPercentageAuto::Length(max) = max.expand() else {
            return None;
        };
        let follows = |room: Points| (max - room.0).abs() <= 0.5;
        if !follows(told) && !state.held.is_some_and(follows) {
            return None;
        }
        let state = self.overlay_mut(key)?;
        state.held = Some(Points(max));
        let state = self.overlay(key)?;
        // Short of the max it is held to: its natural size already.
        if extent.0 < max - 0.5 {
            return Some(extent);
        }
        if let Some(natural) = state.natural {
            return Some(natural);
        }
        let measure = super::leaf_measure(&self.text_engine, &mut self.measure_cache);
        let measured = self
            .layout
            .extent_capped(layout, !horizontal, room.0.max(0.0), measure)?;
        let natural = Points(measured).max(extent);
        self.overlay_mut(key)?.natural = Some(natural);
        Some(natural)
    }

    /// Where unanchored overlay `key`, laid out at `frame` in host
    /// `host`, goes: in a terminal moved so the frame drawn outside its box
    /// (`outside_frame`) stays on the screen, as the box would at its edge
    /// (a toast at the bottom); where it is. A box across the whole screen
    /// (a bottom sheet as wide as it, a drawer as tall) is docked to the
    /// edge it is flush with: it stays there, the frame's side on that edge
    /// off the screen, rather than leave a row for a line under it.
    fn framed_within(&self, key: Key, frame: Bounds<Points>, host: NodeId) -> Point<Points> {
        let (Some((ring, inner)), Some((size, _))) =
            (self.framed_box(key), self.overlay_host_size(host))
        else {
            return frame.origin;
        };
        let spans = |extent: Points, ring: Points, room: Points| extent + ring * 2.0 > room;
        let fit = |at: Points,
                   offset: Points,
                   extent: Points,
                   ring: Points,
                   room: Points,
                   docked: bool| {
            let (first, last) = (at + offset, at + offset + extent);
            let flush = docked && (first.0.abs() < 0.5 || (room - last).0.abs() < 0.5);
            let (start, end) = (first - ring, last + ring);
            if spans(extent, ring, room) || flush {
                at
            } else if start < Points::ZERO {
                at - start
            } else if end > room {
                at - (end - room)
            } else {
                at
            }
        };
        point(
            fit(
                frame.origin.x,
                inner.origin.x,
                inner.size.width,
                ring.width,
                size.width,
                spans(inner.size.height, ring.height, size.height),
            ),
            fit(
                frame.origin.y,
                inner.origin.y,
                inner.size.height,
                ring.height,
                size.height,
                spans(inner.size.width, ring.width, size.width),
            ),
        )
    }

    /// The Cell a terminal frames overlay `key`'s box in, outside it, on
    /// each side (none elsewhere): the painter draws a rounded line around
    /// the first box in it that has a surface, unless the layout kept that
    /// box's border (a card's) inside it.
    fn outside_frame(&self, key: Key) -> Size<Points> {
        self.framed_box(key)
            .map_or_else(Size::default, |(ring, _)| ring)
    }

    /// The frame [`Self::outside_frame`] is around in a terminal, and
    /// that box's bounds in overlay `key`.
    fn framed_box(&self, key: Key) -> Option<(Size<Points>, Bounds<Points>)> {
        let grid = self.layout.grid()?;
        // A popup is its line, at every depth of color: the frame around
        // its box takes a Cell each side, and the app's fill of its panel
        // is the popup itself, which the painter does not paint again.
        let ring = Size {
            width: Points(grid.width),
            height: Points(grid.height),
        };
        let mut at = key;
        let mut origin = Point::default();
        loop {
            let n = &self.nodes[at as usize];
            let layout = n.layout.map(|l| self.layout.unrounded_layout(l));
            if at != key
                && let Some(l) = layout
            {
                origin.x += Points(l.location.x);
                origin.y += Points(l.location.y);
            }
            let w = n.view_style.borders.widths;
            let bordered = [w.top, w.right, w.bottom, w.left]
                .iter()
                .any(|&v| v > Points::ZERO);
            if bordered || n.view_style.background_color.0 & 255 != 0 {
                let kept = layout.is_some_and(|l| l.border.top > 0.0 || l.border.left > 0.0);
                let ring = if kept { Size::default() } else { ring };
                let size = layout.map_or_else(Size::default, |l| Size {
                    width: Points(l.size.width),
                    height: Points(l.size.height),
                });
                return Some((ring, Bounds { origin, size }));
            }
            // The list itself with no box of its own: its options are
            // not the popup's box (a highlighted first option's fill
            // would take the frame), so the popup is framed as below.
            let first = if self.is_options(at) {
                None
            } else {
                n.children.iter().find(|&&c| {
                    let c = &self.nodes[c as usize];
                    !c.is_overlay() && c.layout.is_some()
                })
            };
            let Some(&first) = first else {
                // No box of the app's: a popup holding a list (a select's,
                // a menu) is framed around its own box all the same, a
                // terminal's surface for the list.
                if !self.holds_list(key, 3) {
                    return None;
                }
                // The layout's own line around the list (a popup's panel
                // takes a Cell each side for it) is the frame already.
                let ring = match self.lined_panel(at, 3) {
                    true => Size::default(),
                    false => ring,
                };
                let n = &self.nodes[key as usize];
                let size = n.layout.map_or_else(Size::default, |l| {
                    let l = self.layout.unrounded_layout(l);
                    Size {
                        width: Points(l.size.width),
                        height: Points(l.size.height),
                    }
                });
                return Some((
                    ring,
                    Bounds {
                        origin: Point::default(),
                        size,
                    },
                ));
            };
            at = first;
        }
    }

    /// Whether `key` or its first view down to `depth` levels below it has
    /// a line of the layout's (a popup's panel a Cell each side): the
    /// popup's frame already, drawn inside its box.
    fn lined_panel(&self, key: Key, depth: usize) -> bool {
        let n = &self.nodes[key as usize];
        let lined = n.layout.is_some_and(|l| {
            let l = self.layout.unrounded_layout(l);
            l.border.top > 0.0 || l.border.left > 0.0
        });
        lined
            || (depth > 0
                && n.children
                    .iter()
                    .find(|&&c| {
                        let c = &self.nodes[c as usize];
                        !c.is_overlay() && c.layout.is_some()
                    })
                    .is_some_and(|&c| self.lined_panel(c, depth - 1)))
    }

    /// Whether `key` or a view `depth` levels below it is a list of
    /// options or a menu (`nsh-platform-tui` frames the same popups).
    fn holds_list(&self, key: Key, depth: usize) -> bool {
        self.is_options(key)
            || (depth > 0
                && self.nodes[key as usize]
                    .children
                    .iter()
                    .any(|&c| self.holds_list(c, depth - 1)))
    }

    /// Whether `key` is a list of options or a menu.
    fn is_options(&self, key: Key) -> bool {
        self.nodes[key as usize].props.as_ref().is_some_and(|p| {
            matches!(
                p.accessibility.role,
                crate::AccessibilityRole::Listbox | crate::AccessibilityRole::Menu
            )
        })
    }

    /// Finds where each shown overlay goes in the Tab order and mounts it
    /// where that changed ([`crate::ViewProps::tab_after`]): its native
    /// view is at the end of its root view, but its content follows what
    /// comes before it where the app put it, as WAI-ARIA's non-modal
    /// popups have it (a popover's content right after its trigger). A list
    /// of options or a menu keeps its place (a select's list, a menu: they
    /// move the focus with their own keys, and Tab leaves them for the
    /// control after their trigger).
    pub(super) fn order_overlays_for_tab(&mut self) {
        for i in 0..self.overlays.len() {
            let key = self.overlays[i];
            if self.overlay(key).is_none_or(|s| s.host.is_none())
                || !self.nodes[key as usize].created
            {
                continue;
            }
            let after = if self.holds_options(key, 3) {
                None
            } else {
                self.tab_predecessor(key)
            };
            let state = self.overlay_mut(key).expect("overlay");
            if state.tab_after == after {
                continue;
            }
            state.tab_after = after;
            let node = &self.nodes[key as usize];
            self.mount.push(MountItem::ViewProps {
                id: node.id,
                props: node.mounted_props(),
            });
        }
    }

    /// Whether `key` or a view of its own `depth` levels below it (not of
    /// an overlay inside it) is a list of options or a menu.
    fn holds_options(&self, key: Key, depth: usize) -> bool {
        self.is_options(key)
            || (depth > 0
                && self.nodes[key as usize].children.iter().any(|&c| {
                    !self.nodes[c as usize].is_overlay() && self.holds_options(c, depth - 1)
                }))
    }

    /// The native view right before `key` in the app's tree, depth first:
    /// the last one in the subtrees of the siblings before it, else its
    /// parent's, going up. Other overlays' subtrees are not where they
    /// are, so they are passed over.
    fn tab_predecessor(&self, key: Key) -> Option<NodeId> {
        let mut at = key;
        loop {
            let parent = self.nodes[at as usize].parent;
            if parent == NO_KEY {
                return None;
            }
            let siblings = &self.nodes[parent as usize].children;
            let pos = siblings.iter().position(|&c| c == at)?;
            if let Some(last) = siblings[..pos]
                .iter()
                .rev()
                .find_map(|&s| self.last_native_in(s))
            {
                return Some(last);
            }
            let p = &self.nodes[parent as usize];
            if p.created {
                return Some(p.id);
            }
            at = parent;
        }
    }

    /// The last native view in `key`'s subtree, depth first, overlays
    /// passed over. A view without one has none below it either (a culled
    /// one, a span).
    fn last_native_in(&self, key: Key) -> Option<NodeId> {
        let node = &self.nodes[key as usize];
        if node.is_overlay() || !node.created {
            return None;
        }
        node.children
            .iter()
            .rev()
            .find_map(|&c| self.last_native_in(c))
            .or(Some(node.id))
    }

    fn set_native_overlay_anchor(
        &mut self,
        key: Key,
        anchor: Option<crate::overlay::PlacedAnchor>,
    ) {
        let Some(state) = self.overlay_mut(key) else {
            return;
        };
        if state.native_anchor == anchor {
            return;
        }
        state.native_anchor = anchor;
        let node = &self.nodes[key as usize];
        if node.created {
            self.mount.push(MountItem::ViewProps {
                id: node.id,
                props: node.mounted_props(),
            });
        }
    }

    /// Where overlay `key`'s `cover` view is in it: taken once both are
    /// laid out and kept while the overlay keeps its size `size` and the
    /// view its frame in its parent, so its content scrolling moves
    /// nothing (a new width once the trigger's is known, a row inserted
    /// before it, the view growing or shrinking, take it again).
    fn covering(
        &mut self,
        key: Key,
        config: OverlayConfig,
        size: Size<Points>,
    ) -> Option<Bounds<Points>> {
        let cover = config.cover?;
        let inner = self.measure(cover)?;
        // Its frame in its parent: a scroll moves the parent's content,
        // not this; a row inserted before it does. Its size too: placed
        // while the overlay's own frame is out, the view still has its
        // former one (its frame comes out after), and the end of the
        // commit, which places the overlay again, must not keep that.
        let place = inner.frame;
        if let Some((at, kept, was)) = self.overlay(key)?.covered
            && kept == size
            && was == place
        {
            return Some(at);
        }
        let id = self.nodes[key as usize].id;
        let outer = self.measure(id)?;
        let at = Bounds {
            origin: point(inner.page.x - outer.page.x, inner.page.y - outer.page.y),
            size: inner.frame.size,
        };
        self.overlay_mut(key)?.covered = Some((at, size, place));
        Some(at)
    }

    /// The box around what view `id` draws in its root view: around its
    /// children's frames, or its own while it has none (laid out ones only).
    /// Only along an axis its style leaves the size `auto` (a wrapper its
    /// parent stretches): along one it sets (a trigger 28 points tall with
    /// its label centered), its own box is what shows.
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
                let size = self.layout.style(self.nodes[key as usize].layout?).size;
                let auto = taffy::Dimension::auto();
                let (x0, x1) = if size.width == auto {
                    (
                        (x0 - l.padding.left - l.border.left).max(left),
                        (x1 + l.padding.right + l.border.right).min(right),
                    )
                } else {
                    (left, right)
                };
                let (y0, y1) = if size.height == auto {
                    (
                        (y0 - l.padding.top - l.border.top).max(top),
                        (y1 + l.padding.bottom + l.border.bottom).min(bottom),
                    )
                } else {
                    (top, bottom)
                };
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
            // In a terminal an unanchored one is its own anchor
            // (`overlay_origin`), which its layout set.
            if !anchored && self.layout.grid().is_none() {
                self.set_native_overlay_anchor(key, None);
            }
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
        OverlayAnchor::Node(id)
        | OverlayAnchor::Content(id)
        | OverlayAnchor::Beside { node: id, .. } => Some(id),
        _ => None,
    }
}
