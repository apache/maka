//! Scroll views keep what they show in place through a resize, as a
//! browser's scroll anchoring does. A narrower window wraps the text above
//! the viewport onto more lines, so at the same offset other content shows.
//!
//! Before a layout that follows a change of the viewport (one resize, or
//! each commit of a burst and the one that ends it, when the text that
//! waited catches up all at once) every plain vertical scroll view scrolled
//! past its start notes the first view it shows; after the layout it scrolls
//! by as much as that view moved, in the same batch. Lists anchor their own
//! rows (`ListState::measured`), and so do the lists virtualized against a
//! scroll view.

use super::*;

/// The view a scroll view keeps in place, where it was in its content.
pub(super) struct ResizeAnchor {
    view: Key,
    anchor: Key,
    at: f32,
}

impl<M: TextEngine> Core<M> {
    /// What the scroll views show now, from where the last commit put it.
    pub(super) fn resize_anchors(&self) -> Vec<ResizeAnchor> {
        self.nodes
            .iter()
            .filter_map(|(view, node)| {
                let scroll = node.scroll.as_deref()?;
                let offset = scroll.offset.1;
                let plain = node.kind == Kind::Scroll
                    && !scroll.horizontal
                    && node.list.is_none()
                    && scroll.dependents.is_empty();
                if !plain || offset <= 0.0 {
                    return None;
                }
                let view = view as Key;
                let (anchor, at) = self.first_shown(view, offset)?;
                Some(ResizeAnchor { view, anchor, at })
            })
            .collect()
    }

    /// The first view shown at `offset` in scroll view `view` and where it
    /// is in the content: down through what the viewport's start cuts, to
    /// the first view wholly shown or the innermost one cut.
    fn first_shown(&self, view: Key, offset: f32) -> Option<(Key, f32)> {
        let mut found = None;
        let (mut parent, mut base) = (view, 0.0);
        loop {
            let top = offset - base;
            let next = self.nodes[parent as usize]
                .children
                .iter()
                .find_map(|&key| {
                    let node = &self.nodes[key as usize];
                    let (y, height) = (node.frame.origin.y.0, node.frame.size.height.0);
                    // `Bounds::UNSET` is NaN: not placed, or inside a text.
                    let shown = height > 0.0 && y + height > top;
                    (shown && !node.is_layout_root() && !self.is_out_of_flow(node)).then_some((
                        key,
                        y,
                        node.scroll.is_some(),
                    ))
                });
            let Some((key, y, scrolls)) = next else {
                return found;
            };
            found = Some((key, base + y));
            if y >= top || scrolls {
                return found;
            }
            parent = key;
            base += y;
        }
    }

    /// Whether `node` is placed apart from the flow: where it is says
    /// nothing of where the content around it went.
    fn is_out_of_flow(&self, node: &Node) -> bool {
        node.layout
            .is_some_and(|layout| self.layout.style(layout).position == Position::Absolute)
    }

    /// Where view `key` is in the content of scroll view `view`, if it is
    /// still inside.
    fn content_y(&self, view: Key, mut key: Key) -> Option<f32> {
        let mut y = 0.0;
        while key != view {
            let node = self.nodes.get(key as usize)?;
            if node.parent == NO_KEY {
                return None;
            }
            y += node.frame.origin.y.0;
            key = node.parent;
        }
        Some(y)
    }

    /// Scrolls by as much as the anchors moved in this layout, within the
    /// content.
    pub(super) fn keep_resize_anchors(&mut self, anchors: Vec<ResizeAnchor>) {
        for ResizeAnchor { view, anchor, at } in anchors {
            let Some(y) = self.content_y(view, anchor).filter(|y| !y.is_nan()) else {
                continue;
            };
            let node = &mut self.nodes[view as usize];
            let viewport = node.frame.size.height.0;
            let Some(scroll) = node.scroll.as_deref_mut() else {
                continue;
            };
            let content = scroll.content.map_or(0.0, |c| c.height.0);
            let offset = scroll.offset.1;
            let to = (offset + y - at).min(content - viewport).max(0.0);
            let by = to - offset;
            if by.abs() < 0.01 {
                continue;
            }
            // Reports of the platform follow; what the next commit picks
            // should not wait for them.
            scroll.offset.1 = to;
            self.ask_outer(view, None, by);
        }
    }
}
