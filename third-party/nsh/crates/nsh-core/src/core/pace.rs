//! A turn that makes hundreds of views out of sight spreads them over
//! frames, on every platform.
//!
//! A list row bound in the overscan, or a long reply staged into a chat,
//! makes its whole subtree in one batch: hundreds of native views nobody
//! sees yet, created, styled and committed by the platform in one frame
//! (423 views took one 87 ms frame on macOS). Lists pace their overscan
//! cells already ([`Core::take_paced_list_binds`]), one cell at a time;
//! this paces the views inside them, and the content of scroll views.
//!
//! Once a turn has made [`PACE_AFTER`] views, a view about to be made
//! under a scroll view or a list cell waits instead, culled as content
//! culling holds views back (`cull.rs`): the core keeps laying it out and
//! giving it a frame, and a command for it makes it at once
//! ([`Core::uncull`]). After each layout, [`Core::sync_paced`] makes the
//! waiting views that show (their frame meets the viewport of every scroll
//! view and list around them) at once, a level at a time down to their
//! leaves, so nothing visible is late. The rest come in later turns,
//! nearest the viewport first, at most [`PACE_VIEWS`] views or
//! [`PACE_TIME`] a turn; the core asks for a display frame while some
//! wait ([`Core::has_paced_mounts`]).
//!
//! Content culling's own window ([`Core::sync_culled`]) keeps the same
//! budget: the overscan it makes past [`PACE_AFTER`] waits for later turns
//! too, what shows is made at once.
//!
//! Views not made yet are not in the platform's accessibility tree, as
//! culled content is not: they are out of sight, and come within a few
//! frames. Text selection and select-all read the core's nodes, not the
//! native views. A test driver turns content culling off
//! ([`Core::set_content_culling`]), which turns pacing off: what waits is
//! made in the next commit, so its steps reach every view.
//!
//! Nothing waits that may show away from its frame or lays out on its own
//! ([`Core::never_culled`]: sticky, followers, overlays, screens, modals,
//! transformed or animated views), nor anything outside scroll views and
//! lists, whose content shows wherever its frame is.

use std::time::Duration;

use super::{Core, Key, Kind, NO_KEY};
use crate::{text::TextEngine, time::Instant};

/// Views a turn makes before views out of sight start to wait.
pub(super) const PACE_AFTER: usize = 64;

/// Waiting views out of sight a turn makes at most. Most of a view's cost
/// is the platform's (creating it, and the commit that sends its layer to
/// the compositor): about 0.2 ms a view all told on macOS, so 32 keep a
/// frame near 7 ms.
pub(super) const PACE_VIEWS: usize = 32;

/// The time a turn spends making waiting views out of sight.
pub(super) const PACE_TIME: Duration = Duration::from_millis(4);

/// What [`Core`] keeps for pacing.
#[derive(Debug, Default)]
pub(super) struct Pace {
    /// Views made in this turn.
    pub(super) made: usize,
    /// Waiting views out of sight made in this turn.
    paced: usize,
    /// When the turn began making waiting views.
    started: Option<Instant>,
    /// The engine says when a turn begins ([`Core::begin_mount_turn`]):
    /// otherwise each commit is one.
    in_turn: bool,
    /// Every view about to be made waits (while [`Core::sync_paced`]
    /// makes one: its children are ranked on their own).
    holding: bool,
    /// Waiting views whose parent is made (by key; their ids tell a slot
    /// taken by another node).
    pub(super) waiting: Vec<(Key, crate::NodeId)>,
    /// Content culling left views it would have made for the budget.
    pub(super) culled_waiting: bool,
}

impl Pace {
    /// Whether the turn may make another waiting view out of sight.
    fn left(&self) -> bool {
        self.paced < PACE_VIEWS && self.started.is_none_or(|s| s.elapsed() < PACE_TIME)
    }
}

impl<M: TextEngine> Core<M> {
    /// A turn of the engine begins: the commits up to the next one share
    /// one budget of views. Without it, every commit is a turn.
    pub fn begin_mount_turn(&mut self) {
        self.pace.in_turn = true;
        self.reset_pace();
    }

    /// Whether views wait to be made in a later turn: ask the platform for
    /// a display frame, and commit in it.
    pub fn has_paced_mounts(&self) -> bool {
        !self.pace.waiting.is_empty() || self.pace.culled_waiting
    }

    /// The start of a commit: a new budget unless the engine counts turns.
    pub(super) fn pace_commit(&mut self) {
        if !self.pace.in_turn {
            self.reset_pace();
        }
    }

    fn reset_pace(&mut self) {
        // Views waiting from an earlier turn: this one has their budget
        // only, nothing more made first.
        self.pace.made = if self.has_paced_mounts() {
            PACE_AFTER
        } else {
            0
        };
        self.pace.paced = 0;
        self.pace.started = None;
        if std::mem::take(&mut self.pace.culled_waiting) {
            self.cull_dirty = true;
        }
    }

    /// Whether content culling may make a view in its window that does not
    /// show: within the budget. Counts it when it may.
    pub(super) fn pace_overscan(&mut self) -> bool {
        if !self.culls_content || self.pace.made < PACE_AFTER {
            return true;
        }
        if self.pace.started.is_none() {
            self.pace.started = Some(Instant::now());
        }
        if self.pace.left() {
            self.pace.paced += 1;
            true
        } else {
            self.pace.culled_waiting = true;
            false
        }
    }

    /// Holds back `child`, about to be made in its made parent, when the
    /// turn has made enough views and it may wait; whether it was.
    pub(super) fn pace_hold(&mut self, child: Key) -> bool {
        if !self.culls_content
            || (!self.pace.holding && self.pace.made < PACE_AFTER)
            || self.nodes[child as usize].created
            || self.never_culled(child)
            || !self.paces_in(self.nodes[child as usize].parent)
        {
            return false;
        }
        let node = &mut self.nodes[child as usize];
        node.culled = true;
        let id = node.id;
        self.pace.waiting.push((child, id));
        true
    }

    /// Whether views made in `parent` may wait: it is in a scroll view or a
    /// list's cell, whose content shows only within its viewport.
    fn paces_in(&self, mut key: Key) -> bool {
        // A terminal's views are its Cells, as cheap as the core's nodes.
        if self.layout.grid().is_some() {
            return false;
        }
        while key != NO_KEY {
            let node = &self.nodes[key as usize];
            if node.kind == Kind::Scroll || node.kind == Kind::Cell {
                return true;
            }
            if node.is_layout_root() {
                return false;
            }
            key = node.parent;
        }
        false
    }

    /// How far waiting `key`'s frame is from showing, in points: 0 when it
    /// meets the viewport of every scroll view and list around it, or when
    /// that cannot be told (it is empty, or a transform or a zoom is
    /// between it and the viewport), so it is made now; the most when it
    /// has no frame (not laid out).
    fn sight(&self, key: Key) -> f32 {
        let node = &self.nodes[key as usize];
        let f = node.frame;
        let (x, y, w, h) = (f.origin.x.0, f.origin.y.0, f.size.width.0, f.size.height.0);
        // Not laid out (a cell the list did not place): last, within the
        // budget.
        if !(x.is_finite() && y.is_finite()) {
            return f32::MAX;
        }
        // Empty: what it holds may overflow it.
        if w <= 0.0 || h <= 0.0 {
            return 0.0;
        }
        let mut r = (x, y, x + w, y + h);
        let mut far = 0.0f32;
        let mut k = node.parent;
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            let f = n.frame;
            if !n.created
                || !(f.origin.x.0.is_finite() && f.origin.y.0.is_finite())
                || !n.animated.is_empty()
                || !n.view_style.transform.ops().is_empty()
            {
                // Past the viewports met so far, nothing moves the view
                // within them.
                return far;
            }
            let (w, h) = (f.size.width.0, f.size.height.0);
            let (mut ox, mut oy) = (0.0, 0.0);
            if let Some(list) = n.list.as_ref().filter(|l| !l.parent) {
                // A list's cells are placed in its content.
                let inf = f32::INFINITY;
                let view = if list.horizontal {
                    ox = list.offset;
                    (list.offset, -inf, list.offset + w, inf)
                } else {
                    oy = list.offset;
                    (-inf, list.offset, inf, list.offset + h)
                };
                far = far.max(gap(r, view));
            } else if n.kind == Kind::Scroll {
                let Some(scroll) = n.scroll.as_deref() else {
                    return far;
                };
                if scroll.behavior.zooms() {
                    return far;
                }
                (ox, oy) = scroll.offset;
                far = far.max(gap(r, (ox, oy, ox + w, oy + h)));
            }
            let (dx, dy) = (f.origin.x.0 - ox, f.origin.y.0 - oy);
            r = (r.0 + dx, r.1 + dy, r.2 + dx, r.3 + dy);
            if n.is_layout_root() && n.kind != Kind::Cell {
                break;
            }
            k = n.parent;
        }
        far
    }

    /// Makes the waiting views that show, down to their leaves, then as
    /// many of the others as the budget allows, nearest first; whether it
    /// made any (their styles, texts and images go out in another round).
    pub(super) fn sync_paced(&mut self) -> bool {
        let mut made = false;
        let mut ranked: Vec<(f32, Key)> = Vec::new();
        loop {
            let waiting = std::mem::take(&mut self.pace.waiting);
            if waiting.is_empty() {
                break;
            }
            ranked.clear();
            for (key, id) in waiting {
                let Some(node) = self.nodes.get(key as usize) else {
                    continue;
                };
                // Made by now, gone, or its parent given up (its parent
                // holds it back again when it is made).
                if node.id != id
                    || node.created
                    || !node.culled
                    || node.layout.is_none()
                    || !self.nodes[node.parent as usize].created
                    || !self.in_tree(key)
                {
                    continue;
                }
                let far = if self.culls_content {
                    self.sight(key)
                } else {
                    0.0
                };
                ranked.push((far, key));
            }
            ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut shown = false;
            for &(far, key) in &ranked {
                if far > 0.0 {
                    if self.pace.started.is_none() {
                        self.pace.started = Some(Instant::now());
                    }
                    if !self.pace.left() {
                        let id = self.nodes[key as usize].id;
                        self.pace.waiting.push((key, id));
                        continue;
                    }
                    self.pace.paced += 1;
                } else {
                    shown = true;
                }
                // One view: its children wait, ranked in the next pass.
                self.pace.holding = true;
                let parent = self.nodes[key as usize].parent;
                self.make_culled(parent, key);
                self.pace.holding = false;
                made = true;
            }
            // Only what shows goes down a level in this turn; the rest
            // waits for the budget.
            if !shown {
                break;
            }
        }
        made
    }
}

/// How far rect `r` is from rect `view` (left, top, right, bottom), in
/// points: 0 when they meet.
fn gap(r: (f32, f32, f32, f32), view: (f32, f32, f32, f32)) -> f32 {
    (view.0 - r.2)
        .max(r.0 - view.2)
        .max(view.1 - r.3)
        .max(r.1 - view.3)
        .max(0.0)
}
