//! The graph on a desktop backend's main thread, without the views: the
//! backend's frame clock ticks it, drags and scroll offsets update it, and
//! [`Animator::write`] hands each bound view its [`AnimValues`] (the
//! Android animator's design, `nsh-platform-android/src/anim.rs`). The
//! backends store the values in their views and redraw them.

use rustc_hash::FxHashMap;

use super::{AnimationProp, AnimationValue, Finished, Graph, NodeId};
use crate::{
    Color, GestureValues, MAX_TRANSFORMS, MountItem,
    geometry::{Point, Points},
};

/// Values native animations set on a view; they win over the style's.
#[non_exhaustive]
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct AnimValues {
    /// Animated opacity.
    pub opacity: Option<f32>,
    /// Animated background color.
    pub background: Option<Color>,
    /// Animated entries of the transform list (by position).
    pub transform: [Option<f32>; MAX_TRANSFORMS],
    /// Animated border color (every side).
    pub border_color: Option<Color>,
    /// Animated text color (a text view's runs, an input's text).
    pub color: Option<Color>,
    /// Animated shadow color.
    pub shadow_color: Option<Color>,
    /// Animated shadow opacity.
    pub shadow_opacity: Option<f32>,
    /// Animated shadow blur radius.
    pub shadow_radius: Option<Points>,
}

#[derive(Default)]
struct Gestures {
    values: GestureValues,
    /// Values when the gesture began: pan x, pan y, pinch, rotation.
    start: [f32; 4],
}

/// The graph of one surface, with what binds it to views, gestures and
/// scroll views.
#[non_exhaustive]
#[derive(Default)]
pub struct Animator {
    graph: Graph,
    /// Animations that finished, for the backend to report to JS.
    pub finished: Vec<Finished>,
    /// View id -> bound properties.
    bindings: FxHashMap<u32, Vec<(AnimationProp, NodeId)>>,
    gestures: FxHashMap<u32, Gestures>,
    /// Scroll view id -> (value node, horizontal).
    scrolls: FxHashMap<u32, (NodeId, bool)>,
    /// Scroll views with sticky cells that stick an animated value further
    /// in (`StickyCell::offset`): pinned again on the graph's frames.
    sticky: Vec<u32>,
    /// A view's canvas slot values while they are written (reused: written
    /// on every frame).
    canvas_args: Vec<(u16, AnimationValue)>,
}

impl Animator {
    /// Looks at one item of a batch: animation ops and bindings, gesture
    /// and scroll values, and deletions (which drop the view's entries).
    pub fn apply(&mut self, item: &MountItem) {
        match item {
            MountItem::Animation(op) => self.graph.apply(op.clone(), &mut self.finished),
            MountItem::AnimationBindings { id, bindings } => {
                if bindings.is_empty() {
                    self.bindings.remove(id);
                } else {
                    self.bindings.insert(*id, bindings.clone());
                }
            }
            MountItem::Gestures { id, values } => {
                if values.is_empty() {
                    self.gestures.remove(id);
                } else {
                    self.gestures.entry(*id).or_default().values = *values;
                }
            }
            MountItem::ScrollConfig {
                id,
                horizontal,
                scroll_value,
                ..
            } => match scroll_value {
                Some(node) => {
                    self.scrolls.insert(*id, (*node, *horizontal));
                }
                None => {
                    self.scrolls.remove(id);
                }
            },
            MountItem::StickyCells { id, cells } => {
                let animated = cells.iter().any(|c| c.offset.is_some());
                let at = self.sticky.iter().position(|v| v == id);
                match (animated, at) {
                    (true, None) => self.sticky.push(*id),
                    (false, Some(i)) => {
                        self.sticky.swap_remove(i);
                    }
                    _ => {}
                }
            }
            MountItem::Delete { id } => {
                self.bindings.remove(id);
                self.gestures.remove(id);
                self.scrolls.remove(id);
                self.sticky.retain(|v| v != id);
            }
            _ => {}
        }
    }

    /// Advances the graph to `now` (the graph's clock); true while it
    /// animates.
    pub fn tick(&mut self, now: f64) -> bool {
        self.graph.tick(now, &mut self.finished)
    }

    /// The scroll views whose sticky cells stick an animated value further
    /// from the viewport's start: pin them again after writing a frame.
    pub fn sticky_views(&self) -> &[u32] {
        &self.sticky
    }

    /// The value of node `node` now (a sticky cell's offset; 0 for a node
    /// it does not know).
    pub fn value(&self, node: NodeId) -> f32 {
        self.graph.eval(node).number()
    }

    /// True while a driver of the graph runs.
    pub fn animating(&self) -> bool {
        self.graph.is_animating()
    }

    /// A scroll view moved to `offset`: feeds its scroll value. False if no
    /// value is bound to it.
    pub fn scrolled(&mut self, id: u32, offset: Point<Points>) -> bool {
        let Some(&(node, horizontal)) = self.scrolls.get(&id) else {
            return false;
        };
        let value = if horizontal { offset.x } else { offset.y };
        self.graph.set(node, value.0, &mut self.finished);
        true
    }

    /// Scroll view `id` came to rest (its drag and momentum ended): the
    /// snapping `diffClamp`s that follow its scroll value settle
    /// ([`super::Graph::settle`]). True if one starts moving: the platform
    /// runs its frames.
    pub fn scroll_ended(&mut self, id: u32) -> bool {
        let Some(&(node, _)) = self.scrolls.get(&id) else {
            return false;
        };
        self.graph.settle(node)
    }

    /// A drag began: grabbing an animating value stops it where it is.
    pub fn pan_began(&mut self, id: u32) {
        let graph = &self.graph;
        if let Some(g) = self.gestures.get_mut(&id) {
            g.start[0] = g.values.pan_x.and_then(|n| graph.value(n)).unwrap_or(0.0);
            g.start[1] = g.values.pan_y.and_then(|n| graph.value(n)).unwrap_or(0.0);
        }
    }

    /// The drag moved by `translation` since it began.
    pub fn pan_moved(&mut self, id: u32, translation: Point<Points>) {
        let Some(g) = self.gestures.get(&id) else {
            return;
        };
        let (x, y, start) = (g.values.pan_x, g.values.pan_y, g.start);
        if let Some(n) = x {
            self.graph
                .set(n, start[0] + translation.x.0, &mut self.finished);
        }
        if let Some(n) = y {
            self.graph
                .set(n, start[1] + translation.y.0, &mut self.finished);
        }
    }

    /// The values the drag on `id` moves (`pan.x`, `pan.y`).
    pub fn pan_values(&self, id: u32) -> (Option<f32>, Option<f32>) {
        let Some(g) = self.gestures.get(&id) else {
            return (None, None);
        };
        (
            g.values.pan_x.and_then(|n| self.graph.value(n)),
            g.values.pan_y.and_then(|n| self.graph.value(n)),
        )
    }

    /// A pinch (`rotation` false) or two-finger rotation began.
    pub fn transform_began(&mut self, id: u32, rotation: bool) {
        let graph = &self.graph;
        if let Some(g) = self.gestures.get_mut(&id) {
            let (node, slot, default) = if rotation {
                (g.values.rotation, 3, 0.0)
            } else {
                (g.values.pinch, 2, 1.0)
            };
            g.start[slot] = node.and_then(|n| graph.value(n)).unwrap_or(default);
        }
    }

    /// The pinch scale (or rotation in degrees) since the gesture began.
    pub fn transform_moved(&mut self, id: u32, rotation: bool, amount: f32) {
        let Some(g) = self.gestures.get(&id) else {
            return;
        };
        if rotation {
            if let Some(n) = g.values.rotation {
                let v = g.start[3] + amount;
                self.graph.set(n, v, &mut self.finished);
            }
        } else if let Some(n) = g.values.pinch {
            let v = g.start[2] * amount;
            self.graph.set(n, v, &mut self.finished);
        }
    }

    /// Evaluates every bound property: for each view `find` knows, `set`
    /// gets its values and the values of its canvas slots.
    pub fn write<V>(
        &mut self,
        mut find: impl FnMut(u32) -> Option<V>,
        mut set: impl FnMut(V, AnimValues, &[(u16, AnimationValue)]),
    ) {
        let canvas = &mut self.canvas_args;
        for (&id, bindings) in &self.bindings {
            let Some(view) = find(id) else {
                continue;
            };
            let mut values = AnimValues::default();
            canvas.clear();
            for &(prop, node) in bindings {
                let value = self.graph.eval(node);
                match prop {
                    AnimationProp::Opacity => values.opacity = Some(value.number()),
                    AnimationProp::BackgroundColor => values.background = Some(color(value)),
                    AnimationProp::BorderColor => values.border_color = Some(color(value)),
                    AnimationProp::Color => values.color = Some(color(value)),
                    AnimationProp::ShadowColor => values.shadow_color = Some(color(value)),
                    AnimationProp::ShadowOpacity => values.shadow_opacity = Some(value.number()),
                    AnimationProp::ShadowRadius => {
                        values.shadow_radius = Some(Points(value.number()))
                    }
                    AnimationProp::Transform(i) => {
                        if let Some(t) = values.transform.get_mut(i as usize) {
                            *t = Some(value.number());
                        }
                    }
                    AnimationProp::CanvasArg(k) => canvas.push((k, value)),
                    // The scroll view's (`sticky_views`), never bound.
                    AnimationProp::StickyTop | AnimationProp::StickyLeft => {}
                }
            }
            set(view, values, canvas);
        }
    }
}

/// A bound color: animated colors are `0xRRGGBBAA` values.
fn color(value: AnimationValue) -> Color {
    match value {
        AnimationValue::Color(c) => Color(c),
        other => Color(other.number() as u32),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        StickyCell,
        animation::AnimationOp,
        geometry::{Points, point, px},
    };

    #[test]
    fn sticky_views_with_animated_offsets_are_pinned_on_frames() {
        let mut a = Animator::default();
        a.apply(&MountItem::Animation(AnimationOp::CreateValue {
            node: 2,
            value: 56.0,
        }));
        let cell = |offset| StickyCell {
            cell: 9,
            start: Points(0.0),
            end: Points(100.0),
            offset,
        };
        a.apply(&MountItem::StickyCells {
            id: 4,
            cells: vec![cell(Some(2))],
        });
        assert_eq!(a.sticky_views(), [4]);
        assert_eq!(a.value(2), 56.0);
        // Its scroll value moves the offset.
        a.apply(&MountItem::ScrollConfig {
            id: 4,
            horizontal: false,
            scrollbar_visible: true,
            scroll_value: Some(2),
            keyboard_dismiss: Default::default(),
            mirrored: false,
        });
        a.scrolled(4, point(px(0.0), px(12.0)));
        assert_eq!(a.value(2), 12.0);
        // No animated offset any more.
        a.apply(&MountItem::StickyCells {
            id: 4,
            cells: vec![cell(None)],
        });
        assert!(a.sticky_views().is_empty());
    }

    #[test]
    fn a_scroll_view_at_rest_settles_the_values_that_follow_it() {
        let mut a = Animator::default();
        a.apply(&MountItem::Animation(AnimationOp::CreateValue {
            node: 2,
            value: 0.0,
        }));
        a.apply(&MountItem::Animation(AnimationOp::CreateDiffClamp {
            node: 3,
            input: 2,
            min: 0.0,
            max: 50.0,
            snap: true,
        }));
        a.apply(&MountItem::ScrollConfig {
            id: 4,
            horizontal: false,
            scrollbar_visible: true,
            scroll_value: Some(2),
            keyboard_dismiss: Default::default(),
            mirrored: false,
        });
        for y in [0.0, 200.0, 190.0] {
            a.scrolled(
                4,
                crate::geometry::point(crate::Points(0.0), crate::Points(y)),
            );
            a.graph.eval(3);
        }
        // Another scroll view's end settles nothing.
        assert!(!a.scroll_ended(5));
        assert!(a.scroll_ended(4));
        assert!(a.animating());
        a.tick(1.0);
        a.tick(1.3);
        assert_eq!(a.graph.eval(3).number(), 50.0);
        assert!(!a.animating());
    }
}
