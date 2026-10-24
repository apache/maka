//! Where views are: measuring a node for `ref.measure()`, and the areas
//! descendants cover outside their parents' bounds, which platforms
//! hit-test ([`MountItem::Overflow`]).

use super::{Core, Key, Kind, NO_KEY};
use crate::{
    EventPayload, JsonValue, PayloadValue,
    geometry::{Bounds, Point, Points, point, rect},
    mount::MountItem,
    ops::NodeId,
    text::TextEngine,
};

/// Where a view is, from the last layout (`ref.measure()`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Measurement {
    /// The frame relative to the parent view, as `onLayout` reports it.
    pub frame: Bounds<Points>,
    /// The top left corner in the coordinates of the root view the view is
    /// in (the surface, or the modal it is shown in): those of touches'
    /// `pageX` / `pageY` (`pagePosition`). Scroll offsets and zoom scales of the scroll
    /// views and lists around it are applied; transforms are not.
    pub page: Point<Points>,
}

impl Measurement {
    /// The JS object `ref.measure()` resolves to.
    pub(crate) fn to_json(self) -> JsonValue {
        serde_json::json!({
            "bounds": {
                "origin": { "x": self.frame.origin.x.0, "y": self.frame.origin.y.0 },
                "size": { "width": self.frame.size.width.0, "height": self.frame.size.height.0 },
            },
            "pagePosition": { "x": self.page.x.0, "y": self.page.y.0 },
        })
    }
}

/// Descendants reaching less than this far out of a view do not count
/// (rounding).
const OVERFLOW_EPSILON: f32 = 0.5;

fn valid(r: &Bounds<Points>) -> bool {
    !(r.origin.x.0.is_nan()
        || r.origin.y.0.is_nan()
        || r.size.width.0.is_nan()
        || r.size.height.0.is_nan())
}

impl<M: TextEngine> Core<M> {
    /// Where view `id` is, from the last layout; `None` when it is not in
    /// the tree or was never laid out.
    pub fn measure(&self, id: NodeId) -> Option<Measurement> {
        let key = self.key(id).ok()?;
        let node = &self.nodes[key as usize];
        if !node.created || node.layout.is_none() || !valid(&node.frame) {
            return None;
        }
        // Detached (not in the tree): no position.
        if key != self.root && !self.in_tree(key) {
            return None;
        }
        let (mut x, mut y) = (0.0f32, 0.0f32);
        let mut k = key;
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            // Modals (and the views UIKit places) are root views of their
            // own: positions are in them. A screen fills its stack.
            if matches!(
                n.kind,
                Kind::Modal | Kind::HeaderItem | Kind::InputAccessory
            ) {
                break;
            }
            // Spans and raw text have no view; text attachments are placed
            // in their text block.
            if n.layout.is_some() && valid(&n.frame) {
                x += n.frame.origin.x.0;
                y += n.frame.origin.y.0;
            }
            // An overlay is placed in its root view.
            if n.is_overlay() {
                break;
            }
            let parent = n.parent;
            if parent == NO_KEY {
                break;
            }
            // In a scroll view's content: where the content is now.
            if let Some(scroll) = self.nodes[parent as usize].scroll.as_deref() {
                x = x * scroll.zoom - scroll.offset.0;
                y = y * scroll.zoom - scroll.offset.1;
            }
            k = parent;
        }
        Some(Measurement {
            frame: node.frame,
            page: point(Points(x), Points(y)),
        })
    }

    /// Completes an input's `onCaretMove` payload from its platform: adds
    /// `pageBounds`, its `bounds` (in the input) moved by where the input is
    /// in its root view. The platforms know the caret in their text views,
    /// the core where the input is (`ref.measure()`'s `pagePosition`, with
    /// the scroll views around it).
    pub fn locate_caret(&self, id: NodeId, payload: &mut EventPayload) {
        if matches!(payload, EventPayload::None) {
            *payload = EventPayload::Map(Vec::new());
        }
        let EventPayload::Map(fields) = payload else {
            return;
        };
        if fields.iter().any(|(k, _)| *k == "pageBounds") {
            return;
        }
        // A platform that could not place the caret reports an empty one.
        let caret = match fields.iter().find(|(k, _)| *k == "bounds") {
            Some(&(_, PayloadValue::Bounds(caret))) => caret,
            _ => {
                fields.retain(|(k, _)| *k != "bounds");
                fields.push(("bounds", PayloadValue::Bounds(Bounds::default())));
                Bounds::default()
            }
        };
        let page = self.measure(id).map_or(Point::default(), |m| m.page);
        fields.push((
            "pageBounds",
            PayloadValue::Bounds(Bounds {
                origin: point(page.x + caret.origin.x, page.y + caret.origin.y),
                size: caret.size,
            }),
        ));
    }

    /// Whether `key` hangs from the main tree's root or a root view that
    /// does.
    pub(super) fn in_tree(&self, mut key: Key) -> bool {
        while key != NO_KEY {
            if key == self.root {
                return true;
            }
            key = self.nodes[key as usize].parent;
        }
        false
    }

    /// Answers `ref.measure()` call `call` on `id` (null when it is not
    /// laid out).
    pub(super) fn answer_measure(&mut self, id: NodeId, call: u32) {
        let value = self
            .measure(id)
            .map_or(JsonValue::Null, Measurement::to_json);
        self.settle(call, Ok(Box::new(value)));
    }

    /// Updates the area `key`'s descendants cover outside its bounds (its
    /// children's frames and areas are current), and mounts it when it
    /// changed. Clipping views have none: what is outside is not drawn.
    pub(super) fn update_overflow(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        if !node.created || key == self.root {
            return;
        }
        let clips = node.view_style.overflow_hidden
            || matches!(node.kind, Kind::Scroll | Kind::List | Kind::Stack);
        let extent = if clips || !valid(&node.frame) || node.children.is_empty() {
            None
        } else {
            let (w, h) = (node.frame.size.width.0, node.frame.size.height.0);
            let (mut x0, mut y0, mut x1, mut y1) = (0.0f32, 0.0f32, w, h);
            for &child in &node.children {
                let c = &self.nodes[child as usize];
                if c.is_layout_root() || c.layout.is_none() || !c.created || !valid(&c.frame) {
                    continue;
                }
                let f = c.frame;
                if f.size.width.0 > 0.0 && f.size.height.0 > 0.0 {
                    x0 = x0.min(f.origin.x.0);
                    y0 = y0.min(f.origin.y.0);
                    x1 = x1.max(f.origin.x.0 + f.size.width.0);
                    y1 = y1.max(f.origin.y.0 + f.size.height.0);
                }
                if let Some(e) = c.overflow {
                    x0 = x0.min(f.origin.x.0 + e.origin.x.0);
                    y0 = y0.min(f.origin.y.0 + e.origin.y.0);
                    x1 = x1.max(f.origin.x.0 + e.origin.x.0 + e.size.width.0);
                    y1 = y1.max(f.origin.y.0 + e.origin.y.0 + e.size.height.0);
                }
            }
            let out = x0 < -OVERFLOW_EPSILON
                || y0 < -OVERFLOW_EPSILON
                || x1 > w + OVERFLOW_EPSILON
                || y1 > h + OVERFLOW_EPSILON;
            out.then_some(rect(x0, y0, x1 - x0, y1 - y0))
        };
        let node = &mut self.nodes[key as usize];
        if node.overflow != extent {
            node.overflow = extent;
            let id = node.id;
            self.mount.push(MountItem::Overflow { id, extent });
        }
    }
}
