//! Views with `position: sticky`: laid out in the flow as `relative`, they
//! stay their `top` (in a horizontal scroll view, `left`) from the start of
//! the viewport of the scroll view around them while their parent shows,
//! as far as the end of their parent's content box, as in a browser.
//!
//! The scroll view moves its content on the main thread, without the
//! engine, so stickiness is mounted data: each sticky view's range of
//! travel in the scroll view's offsets (`MountItem::StickyCells`, which the
//! platforms pin on every scroll as they pin a list's sticky rows). The
//! ranges depend on layout only, so they are worked out again after a
//! layout or when sticky views come, go or move, and sent with the scroll
//! view's lists' sticky rows ([`Core::send_page_sticky`]). A sticky view
//! draws above its siblings of the same `zIndex` (`Node::stack_rank`): in
//! NSH every view is positioned, where a page's in-flow boxes are not.
//!
//! The scroll view is the nearest scroll view or list of its own around
//! the view, whatever its axis (CSS's nearest scroll container): one that
//! scrolls the other way keeps it in place. `bottom` and `right` are not
//! supported (a warning, once), nor a zoomable scroll view.

use super::{Core, Key, Kind, NO_KEY, list::StickyRange};
use crate::{animation::AnimationProp, text::TextEngine};

impl<M: TextEngine> Core<M> {
    /// `key`'s style made it sticky with `insets`, or not sticky.
    pub(super) fn set_sticky(
        &mut self,
        key: Key,
        insets: Option<Box<taffy::Rect<taffy::LengthPercentageAuto>>>,
    ) {
        let node = &mut self.nodes[key as usize];
        let was = node.sticky.is_some();
        node.sticky = insets;
        let is = node.sticky.is_some();
        if is && !was {
            self.sticky_nodes.push(key);
        } else if was && !is {
            self.sticky_nodes.retain(|&k| k != key);
        }
        self.sticky_changed = true;
        if was != is {
            self.restack(key);
        }
    }

    /// Works out the sticky views' ranges after a layout (`relayout`) or
    /// when they changed, and marks the scroll views whose set changed.
    pub(super) fn update_sticky_views(&mut self, relayout: bool) {
        if !relayout && !std::mem::take(&mut self.sticky_changed) {
            return;
        }
        self.sticky_changed = false;
        let mut ranges: Vec<(Key, StickyRange)> = Vec::new();
        for i in 0..self.sticky_nodes.len() {
            let key = self.sticky_nodes[i];
            if let Some(found) = self.sticky_range(key) {
                ranges.push(found);
            }
        }
        let mut views: Vec<Key> = ranges.iter().map(|r| r.0).collect();
        views.extend_from_slice(&self.sticky_scrollers);
        views.sort_unstable();
        views.dedup();
        let mut scrollers = Vec::new();
        for view in views {
            let mut set: Vec<StickyRange> =
                ranges.iter().filter(|r| r.0 == view).map(|r| r.1).collect();
            set.sort_by_key(|r| r.cell);
            let Some(scroll) = self
                .nodes
                .get_mut(view as usize)
                .and_then(|n| n.scroll.as_mut())
            else {
                continue;
            };
            if !set.is_empty() {
                scrollers.push(view);
            }
            if scroll.view_sticky != set {
                scroll.view_sticky = set;
                self.sticky_views.push(view);
            }
        }
        self.sticky_scrollers = scrollers;
    }

    /// Where sticky view `key` travels: the scroll view around it and its
    /// range there; `None` when it does not stick (no scroll view around
    /// it, its inset on that axis `auto`, not laid out).
    fn sticky_range(&mut self, key: Key) -> Option<(Key, StickyRange)> {
        let node = &self.nodes[key as usize];
        if !node.created || node.frame.size.width.0.is_nan() {
            return None;
        }
        let insets = **node.sticky.as_ref()?;
        let (view, horizontal) = self.sticky_scroller(key)?;
        let main = |x: f32, y: f32| if horizontal { x } else { y };
        let v = &self.nodes[view as usize];
        let viewport = main(v.frame.size.width.0, v.frame.size.height.0);
        let (lead, trail) = if horizontal {
            (insets.left, insets.right)
        } else {
            (insets.top, insets.bottom)
        };
        // An animated inset: the platforms add its value as they pin.
        let prop = if horizontal {
            AnimationProp::StickyLeft
        } else {
            AnimationProp::StickyTop
        };
        let offset = (self.nodes[key as usize].animated.iter())
            .find(|(p, _)| *p == prop)
            .map(|&(_, n)| n);
        let across = (self.nodes[key as usize].animated.iter()).any(|(p, _)| {
            matches!(p, AnimationProp::StickyTop | AnimationProp::StickyLeft) && *p != prop
        });
        if across && !self.inset_warned {
            self.inset_warned = true;
            log::warn!(
                target: "js",
                "an animated `top` moves a sticky view in a vertical scroll view and `left` in a horizontal one; the other is ignored on view {}",
                self.nodes[key as usize].id
            );
        }
        use taffy::style::ExpandedLengthPercentageAuto as Inset;
        let inset = match lead.expand() {
            Inset::Length(v) => v,
            // Of the scroll view's viewport, as of a scrollport.
            Inset::Percent(p) => p * viewport,
            Inset::Auto if offset.is_some() => 0.0,
            Inset::Auto => {
                if !matches!(trail.expand(), Inset::Auto) && !self.sticky_warned {
                    self.sticky_warned = true;
                    log::warn!(
                        target: "js",
                        "position: sticky sticks at `top` (`left` in a horizontal scroll view); `bottom` and `right` are not supported"
                    );
                }
                return None;
            }
        };
        let at = self.offset_in(key, view)?;
        let node = &self.nodes[key as usize];
        let size = main(node.frame.size.width.0, node.frame.size.height.0);
        // As far as the end of the parent's content box (a scroll view's
        // own children: of its content).
        let parent = node.parent;
        let bound = if parent == view {
            let v = &self.nodes[view as usize];
            match (&v.list, v.scroll.as_ref().and_then(|s| s.content)) {
                (Some(list), _) => list.content_len(),
                (None, Some(content)) => main(content.width.0, content.height.0),
                (None, None) => f32::INFINITY,
            }
        } else {
            let p = &self.nodes[parent as usize];
            let l = self.rounded_layout(p.layout?);
            let end = if horizontal {
                l.size.width - l.border.right - l.padding.right
            } else {
                l.size.height - l.border.bottom - l.padding.bottom
            };
            self.offset_in(parent, view)? + end
        };
        let start = at - inset;
        let end = start + (bound - at - size).max(0.0);
        Some((
            view,
            StickyRange {
                cell: node.id,
                start,
                end,
                offset,
            },
        ))
    }

    /// The scroll view around `key` (a `Scroll`, or a list of its own) and
    /// whether it scrolls sideways; `None` at a root view.
    fn sticky_scroller(&self, key: Key) -> Option<(Key, bool)> {
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            if k == self.root || n.kind.is_root() {
                return None;
            }
            match n.kind {
                Kind::Scroll => return Some((k, n.scroll.as_ref()?.horizontal)),
                Kind::List if n.list.as_ref().is_some_and(|l| !l.parent) => {
                    return Some((k, n.list.as_ref()?.horizontal));
                }
                _ => {}
            }
            k = n.parent;
        }
        None
    }

    /// Where `key` is in the content of `view` around it, along `view`'s
    /// axis: its frames summed up to it.
    fn offset_in(&self, key: Key, view: Key) -> Option<f32> {
        let horizontal = self.nodes[view as usize]
            .scroll
            .as_ref()
            .is_some_and(|s| s.horizontal);
        let mut at = 0.0;
        let mut k = key;
        while k != view {
            let n = &self.nodes[k as usize];
            let o = if horizontal {
                n.frame.origin.x.0
            } else {
                n.frame.origin.y.0
            };
            if o.is_nan() || n.parent == NO_KEY {
                return None;
            }
            at += o;
            k = n.parent;
        }
        Some(at)
    }
}
