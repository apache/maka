//! A list's rows under a layout animation (`LayoutAnimation.configureNext`
//! before its items change), as UIKit's batch updates and React Native's
//! lists animate them: the rows already shown slide to their new places and
//! a row that comes in appears in its own.
//!
//! Two things in the list's commit would otherwise defeat that. The core
//! scrolls the list to keep what shows in place (`ScrollBy`: an inverted
//! list keeping its distance from the end as a row arrives at the bottom, a
//! list keeping its visible rows as rows arrive above them), and the
//! platforms apply a scroll at once: the rows, whose frames in the content
//! need not change, jump with it. And cells are recycled: the one a new row
//! takes had its frame at another row's place, which the platforms would
//! animate it from.
//!
//! So, while a turn's layout animation moves frames, each list's commit
//! leads a run of frames that apply at once (an empty layout animation, as
//! `layout_scope.rs` scopes them): the rows that stay at where they showed
//! when the turn began, moved by what the core scrolled the list since, so
//! the scroll leaves them where they were on screen; and the cells placed
//! for another row (or for the first time) at their new place, with their
//! content. After the scroll, the turn's animation leads the rows' new
//! frames, which they slide to. The platforms know nothing of it: they
//! animate each frame with the layout animation before it, from where the
//! view shows. A turn is the engine's (`Core::begin_mount_turn`), whose
//! commits reach the platform as one batch.

use rustc_hash::{FxHashMap, FxHashSet};

use super::{Core, Key, NO_KEY};
use crate::{
    LayoutAnimation, MountItem, NodeId,
    geometry::{Bounds, Points},
    text::TextEngine,
};

/// What this turn's layout animation needs to know about lists.
#[derive(Default)]
pub(super) struct ListMotion {
    /// The turn's layout animation, while it moves frames.
    layout: Option<LayoutAnimation>,
    /// Where each cell was when the turn began (when its list was first
    /// updated in it).
    start: FxHashMap<Key, Bounds<Points>>,
    /// How far the core scrolled each list in the turn, along its axis.
    scrolled: FxHashMap<Key, f32>,
    /// The cells placed for another row in the turn: they stay put.
    appeared: FxHashSet<Key>,
}

impl ListMotion {
    /// The turn's layout animation, when it moves frames.
    pub(super) fn active(&self) -> bool {
        self.layout.is_some()
    }
}

/// A list's cells placed in this round ([`Core::move_list_cells`]).
#[derive(Default)]
pub(super) struct Placed {
    /// Cells that show the row they showed: they slide.
    pub(super) kept: Vec<Key>,
    /// Cells placed for another row, or for the first time: they appear.
    pub(super) new: Vec<Key>,
}

impl<M: TextEngine> Core<M> {
    /// A turn of commits begins: what lists noted of the last one is done.
    pub(super) fn reset_list_motion(&mut self) {
        let motion = &mut self.list_motion;
        motion.layout = None;
        motion.start.clear();
        motion.scrolled.clear();
        motion.appeared.clear();
    }

    /// The commit animates its layout with `animation`.
    pub(super) fn note_list_motion(&mut self, animation: LayoutAnimation) {
        self.list_motion.layout = animation.update.is_some().then_some(animation);
    }

    /// Notes where `cells` are before their list places them, the first
    /// time the turn sees them.
    pub(super) fn note_cell_starts(&mut self, cells: impl IntoIterator<Item = Key>) {
        for cell in cells {
            if cell == u32::MAX {
                continue;
            }
            let frame = self.nodes[cell as usize].frame;
            self.list_motion.start.entry(cell).or_insert(frame);
        }
    }

    /// List `list` (node `id`) placed `placed` and scrolled by `scrolled`
    /// along its axis in this round: the frames that slide and the ones
    /// that apply at once, around the list's `ScrollBy`.
    pub(super) fn move_list_cells(
        &mut self,
        list: Key,
        id: NodeId,
        horizontal: bool,
        scrolled: f32,
        placed: Placed,
    ) {
        let Some(layout) = self.list_motion.layout else {
            return;
        };
        let motion = &mut self.list_motion;
        motion.appeared.extend(placed.new.iter().copied());
        let total = {
            let s = motion.scrolled.entry(list).or_insert(0.0);
            *s += scrolled;
            *s
        };
        let (new, kept): (Vec<Key>, Vec<Key>) = placed
            .kept
            .into_iter()
            .chain(placed.new)
            .partition(|c| motion.appeared.contains(c));
        // Rows placed at another row's place show their content there too.
        let mut instant: FxHashSet<NodeId> = FxHashSet::default();
        if !new.is_empty() {
            let cells: FxHashSet<Key> = new.iter().copied().collect();
            for item in &self.mount {
                if let MountItem::Frame { id: f, .. } = *item
                    && let Ok(key) = self.key(f)
                    && self.within(key, list, &cells)
                {
                    instant.insert(f);
                }
            }
        }
        if scrolled == 0.0 && instant.is_empty() {
            return;
        }
        let sliding: FxHashSet<NodeId> = if scrolled == 0.0 {
            FxHashSet::default()
        } else {
            kept.iter().map(|&c| self.nodes[c as usize].id).collect()
        };
        let mut at_once = vec![MountItem::LayoutAnimation(LayoutAnimation::default())];
        let mut slide = vec![MountItem::LayoutAnimation(layout)];
        // The new rows' content, in its order.
        self.mount.retain(|item| match *item {
            MountItem::Frame { id, frame } if instant.contains(&id) => {
                at_once.push(MountItem::Frame { id, frame });
                false
            }
            MountItem::Frame { id, .. } => !sliding.contains(&id),
            _ => true,
        });
        if scrolled != 0.0 {
            for &cell in &kept {
                let node = &self.nodes[cell as usize];
                let to = node.frame;
                let start = self.list_motion.start.get(&cell).copied();
                let Some(mut from) = start.filter(|s| !s.size.width.0.is_nan()) else {
                    at_once.push(MountItem::Frame {
                        id: node.id,
                        frame: to,
                    });
                    continue;
                };
                if horizontal {
                    from.origin.x.0 += total;
                } else {
                    from.origin.y.0 += total;
                }
                at_once.push(MountItem::Frame {
                    id: node.id,
                    frame: from,
                });
                if from != to {
                    slide.push(MountItem::Frame {
                        id: node.id,
                        frame: to,
                    });
                }
            }
        }
        let at = self
            .mount
            .iter()
            .rposition(|m| matches!(m, MountItem::ScrollBy { id: s, .. } if *s == id))
            .filter(|_| scrolled != 0.0);
        match at {
            Some(at) => {
                self.mount.splice(at + 1..at + 1, slide);
                self.mount.splice(at..at, at_once);
            }
            None => {
                self.mount.extend(at_once);
                self.mount.extend(slide);
            }
        }
    }

    /// Whether `key` is one of `cells` of list `list`, or inside one.
    fn within(&self, mut key: Key, list: Key, cells: &FxHashSet<Key>) -> bool {
        while key != NO_KEY && key != list {
            if cells.contains(&key) {
                return true;
            }
            key = self.nodes[key as usize].parent;
        }
        false
    }
}
