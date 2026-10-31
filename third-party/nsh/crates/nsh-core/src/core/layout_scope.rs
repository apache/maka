//! Layout animations of one node's change (`Command::LayoutAnimation` sent
//! to a node rather than the root, Rust's `ElementRef::animate_layout`): a
//! region that grows or shrinks (`nsh/base`'s reveals) animates the frames
//! that its change moves, and the rest of the commit (a list that updates,
//! live data) changes at once, as it would without the animation.
//!
//! The platforms animate the frames that follow a `MountItem::LayoutAnimation`
//! in the batch, until the next one (`MountItem::LayoutAnimation`'s docs),
//! so the scope is mounted data without a platform knowing about it: before
//! the batch is handed out, the frames are split into runs, each led by the
//! layout animation it takes (an empty one where it takes none).
//!
//! The frames a node's change moves: the node's own and those of its
//! subtree; those of the children of its ancestors (its siblings and theirs,
//! which a change of its size pushes along); and those of the children of a
//! view moved that way that changed size too (a `flex-1` sibling's content).
//! Frames are relative to the parent, so a view that only moved does not
//! move its children. Insertions and removals are not scoped: a scoped
//! animation animates frames only (its `update`). A commit that also
//! animates its whole layout (a layout animation at the root) animates
//! every frame with that one.
//!
//! A view that follows another one (`follow.rs`) moving to another element
//! scopes its own frame alone (and its subtree's): what changes around it
//! in that commit is not its doing.

use super::{Core, Key, NO_KEY};
use crate::{LayoutAnimation, LayoutTransition, MountItem, NodeId, text::TextEngine};

/// A node whose change animates the frames it moves, with `transition`.
struct Scope {
    key: Key,
    /// Its ancestors, nearest first; none when it animates its own frame
    /// alone.
    ancestors: Vec<Key>,
    transition: LayoutTransition,
}

impl<M: TextEngine> Core<M> {
    /// Node `id`'s change animates the frames it moves in the next commit
    /// with `transition`.
    pub(super) fn scope_layout_animation(&mut self, id: NodeId, transition: LayoutTransition) {
        self.scoped_layout.push((id, transition, false));
    }

    /// Node `id`'s own frame (and its subtree's) animates in the next
    /// commit with `transition`, and nothing it moves.
    pub(super) fn scope_frame_animation(&mut self, id: NodeId, transition: LayoutTransition) {
        self.scoped_layout.push((id, transition, true));
    }

    /// The frame of `key` changes in this commit, and its size with it when
    /// `resized`: noted while a scoped layout animation waits.
    #[inline]
    pub(super) fn note_resized(&mut self, key: Key, resized: bool) {
        if resized && !self.scoped_layout.is_empty() {
            self.resized.push(key);
        }
    }

    /// Leads each run of frames in the batch with the layout animation it
    /// takes: a scope's for the frames its node moves, an empty one for
    /// the others. Nothing while no scope waits, or when the batch animates
    /// all of its layout already.
    pub(super) fn split_scoped_frames(&mut self) {
        if self.scoped_layout.is_empty() {
            return;
        }
        let requested = std::mem::take(&mut self.scoped_layout);
        let mut resized = std::mem::take(&mut self.resized);
        if self
            .mount
            .iter()
            .any(|m| matches!(m, MountItem::LayoutAnimation(_)))
        {
            resized.clear();
            self.resized = resized;
            return;
        }
        let scopes: Vec<Scope> = requested
            .into_iter()
            .filter_map(|(id, transition, own)| {
                let key = self.key(id).ok()?;
                let mut ancestors = Vec::new();
                let mut k = self.nodes[key as usize].parent;
                while !own && k != NO_KEY {
                    ancestors.push(k);
                    k = self.nodes[k as usize].parent;
                }
                Some(Scope {
                    key,
                    ancestors,
                    transition,
                })
            })
            .collect();
        resized.sort_unstable();
        resized.dedup();
        if !scopes.is_empty() {
            let items = std::mem::take(&mut self.mount);
            let mut out = Vec::with_capacity(items.len() + 2);
            // What the platform animates the next frame with.
            let mut current = None;
            for item in items {
                if let MountItem::Frame { id, .. } = item {
                    let wanted = self.key(id).ok().and_then(|key| {
                        scopes
                            .iter()
                            .find(|s| self.moves(s, key, &resized))
                            .map(|s| s.transition)
                    });
                    if wanted != current {
                        out.push(MountItem::LayoutAnimation(LayoutAnimation {
                            update: wanted,
                            ..LayoutAnimation::default()
                        }));
                        current = wanted;
                    }
                }
                out.push(item);
            }
            self.mount = out;
        }
        resized.clear();
        self.resized = resized;
    }

    /// Whether `scope`'s change moves the frame of `key`: `key` is in its
    /// subtree, or reached from one of its ancestors' children through
    /// views that changed size.
    fn moves(&self, scope: &Scope, key: Key, resized: &[Key]) -> bool {
        let mut k = key;
        // Every view between `key` and `k` changed size.
        let mut carried = true;
        loop {
            if k == scope.key {
                return true;
            }
            let parent = self.nodes[k as usize].parent;
            if parent == NO_KEY {
                return false;
            }
            if carried && scope.ancestors.contains(&parent) {
                return true;
            }
            carried = carried && resized.binary_search(&parent).is_ok();
            k = parent;
        }
    }
}
