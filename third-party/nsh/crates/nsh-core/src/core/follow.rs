//! Views whose frame follows another view's (`View::follow`): a tab
//! list's indicator on the selected tab, a segmented control's highlight,
//! a marker on the current page. Along the main axis of its parent (a
//! flex column's: vertical; otherwise horizontal) the view spans the
//! frame of the element it follows, inside its own margins on that axis;
//! across it, it keeps the frame its style lays out (`bottom-0 h-[2px]`
//! for an underline, `inset-y-1` for a pill), so it is absolutely
//! positioned. While it follows nothing (the element is not rendered or
//! not laid out), its style alone places it.
//!
//! It is placed after layout, from the frames layout gave, with no layout
//! of its own: following another element changes only its frame, one
//! `MountItem::Frame`, and a layout that moves or resizes the element
//! places it again in the same batch. The element may be anywhere inside
//! the view's parent; its frame there is the frames summed up to the
//! parent (a scroll view in between counts as unscrolled).
//!
//! A move to another element runs with its `follow_transition`, as a
//! layout animation of that frame alone (`layout_scope.rs`): the platform
//! moves it natively, and the rest of the batch (the tabs' own styles,
//! the content they switch) changes at once. Following an element for
//! the first time, and a resize, place it at once, as does showing it
//! again after it was hidden (`display: none`).
//!
//! Nothing runs while no view follows an element: the pass returns at
//! once on an empty `followers`, and `set_frame` only notes a change
//! while there is one.

use super::{Core, Key, Kind, NO_KEY};
use crate::{
    LayoutTransition, NodeId,
    element::FollowTarget,
    geometry::{Bounds, Points, px},
    text::TextEngine,
};

/// What a view that follows an element holds.
#[derive(Debug, Default)]
pub(super) struct Following {
    /// The element it follows.
    target: Option<FollowTarget>,
    /// How it moves to another element; `None` jumps.
    transition: Option<LayoutTransition>,
    /// The frame layout gave it (its cross axis), `None` while hidden or
    /// not laid out.
    laid: Option<Bounds<Points>>,
    /// Its parent lays out a column: it follows vertically.
    vertical: bool,
    /// Its margins along that axis, start and end.
    margins: (f32, f32),
    /// The node it was last placed at, 0 when none: following another one
    /// moves it with `transition`.
    placed_at: NodeId,
}

impl<M: TextEngine> Core<M> {
    /// The view `key` follows `target`, or nothing.
    pub(super) fn set_follow_target(&mut self, key: Key, target: Option<FollowTarget>) {
        let following = self.following(key, target.is_some());
        let Some(f) = following else { return };
        if f.target != target {
            f.target = target;
            self.follow_changed = true;
        }
    }

    /// How the view `key` moves when it follows another element.
    pub(super) fn set_follow_transition(&mut self, key: Key, transition: Option<LayoutTransition>) {
        if let Some(f) = self.following(key, transition.is_some()) {
            f.transition = transition;
        }
    }

    /// `key`'s following state, made when `make` (else `None` when it has
    /// none).
    fn following(&mut self, key: Key, make: bool) -> Option<&mut Following> {
        if self.nodes[key as usize].follow.is_none() {
            if !make {
                return None;
            }
            self.nodes[key as usize].follow = Some(Box::default());
            self.followers.push(key);
            // Placed by `place_followers` from now on, which takes the
            // frame layout gives it: a view laid out already is laid out
            // again to hand it over (once).
            if let Some(layout) = self.nodes[key as usize].layout
                && self.nodes[key as usize].created
            {
                self.layout.mark_dirty(layout);
                self.needs_layout = true;
            }
        }
        self.nodes[key as usize].follow.as_deref_mut()
    }

    /// A follower `key` was laid out with `frame` (its parent's main axis
    /// vertical when `vertical`, its margins along it `margins`), or
    /// hidden (`None`): placed by [`Core::place_followers`] instead of
    /// now. Hidden, it forgets where it was: shown again, it is placed at
    /// once rather than moved from there.
    pub(super) fn laid_follower(
        &mut self,
        key: Key,
        frame: Option<Bounds<Points>>,
        vertical: bool,
        margins: (f32, f32),
    ) {
        if let Some(f) = self.nodes[key as usize].follow.as_deref_mut() {
            if frame.is_none() {
                f.placed_at = 0;
            }
            f.laid = frame;
            f.vertical = vertical;
            f.margins = margins;
            self.follow_changed = true;
        }
    }

    /// Places the views that follow elements, after a layout (`relayout`)
    /// or when what they follow or the frames around them changed.
    pub(super) fn place_followers(&mut self, relayout: bool) {
        if self.followers.is_empty() || !(relayout || self.follow_changed) {
            return;
        }
        for i in 0..self.followers.len() {
            let key = self.followers[i];
            self.place_follower(key);
        }
        // Its own frames set it again.
        self.follow_changed = false;
    }

    fn place_follower(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        let Some(f) = node.follow.as_deref() else {
            return;
        };
        let Some(mut frame) = f.laid else { return };
        let (id, parent) = (node.id, node.parent);
        let target = (f.target.as_ref())
            .and_then(FollowTarget::node)
            .and_then(|id| self.key(id).ok())
            .filter(|&t| t != key);
        let span = target.and_then(|t| self.frame_in(t, parent));
        let (vertical, (start, end), transition, before) =
            (f.vertical, f.margins, f.transition, f.placed_at);
        let at = match (target, span) {
            (Some(t), Some(span)) => {
                if vertical {
                    frame.origin.y = span.origin.y + px(start);
                    frame.size.height = (span.size.height - px(start + end)).max(px(0.0));
                } else {
                    frame.origin.x = span.origin.x + px(start);
                    frame.size.width = (span.size.width - px(start + end)).max(px(0.0));
                }
                self.nodes[t as usize].id
            }
            _ => 0,
        };
        let node = &mut self.nodes[key as usize];
        if let Some(f) = node.follow.as_deref_mut() {
            f.placed_at = at;
        }
        if node.frame == frame {
            return;
        }
        // To another element: the move runs natively, its frame alone.
        if before != 0
            && at != 0
            && before != at
            && let Some(transition) = transition
        {
            self.scope_frame_animation(id, transition);
        }
        self.set_frame(key, frame);
        if parent != NO_KEY {
            self.update_overflow(parent);
        }
    }

    /// The frame of `key` in the coordinates of `ancestor`: its frame and
    /// those of the views between them summed; `None` when `ancestor` is
    /// not around it, or a view on the way is not laid out or a root
    /// (a screen, a list cell placed on its own).
    fn frame_in(&self, key: Key, ancestor: Key) -> Option<Bounds<Points>> {
        let node = &self.nodes[key as usize];
        if !node.created || !valid(&node.frame) {
            return None;
        }
        let mut frame = node.frame;
        let mut k = node.parent;
        while k != ancestor {
            if k == NO_KEY {
                return None;
            }
            let n = &self.nodes[k as usize];
            if n.is_layout_root() || n.kind == Kind::List || !valid(&n.frame) {
                return None;
            }
            frame.origin += n.frame.origin;
            k = n.parent;
        }
        Some(frame)
    }

    /// Forgets follower `key`, being released.
    pub(super) fn release_follower(&mut self, key: Key) {
        self.followers.retain(|&k| k != key);
        if self.followers.is_empty() {
            self.follow_changed = false;
        }
    }
}

/// A frame layout gave (not NaN, as before the first layout).
fn valid(r: &Bounds<Points>) -> bool {
    !(r.origin.x.0.is_nan()
        || r.origin.y.0.is_nan()
        || r.size.width.0.is_nan()
        || r.size.height.0.is_nan())
}
