//! The native animation graph on the UI thread: `Choreographer` ticks,
//! drags and scroll offsets update it; changed view properties go back to
//! Java as `[animating, (view, prop, value)*]` float arrays.

use nsh_core::{
    GestureValues, MAX_TRANSFORMS, MountItem, Shadow, Transform,
    animation::{AnimationProp, AnimationValue, Finished, Graph, NodeId},
};
use rustc_hash::FxHashMap;

// Java-side property codes (`Mounter.java`).
const OPACITY: f32 = 0.0;
const BACKGROUND: f32 = 7.0;
/// Every border side's color (ARGB bits).
const BORDER_COLOR: f32 = 11.0;
/// A text's color (ARGB bits).
const TEXT_COLOR: f32 = 12.0;
/// The shadow's color with its opacity in the alpha (ARGB bits).
const SHADOW_COLOR: f32 = 13.0;
/// The shadow's radius (points).
const SHADOW_RADIUS: f32 = 14.0;
/// How much further a sticky cell sticks (points; `StickyCell::offset`):
/// `ScrollBox.java` pins it again.
const STICKY_OFFSET: f32 = 15.0;
/// Canvas animated value slot `n` is `CANVAS_ARG + n` (a color as ARGB bits).
const CANVAS_ARG: f32 = 1000.0;
/// A native component's animated prop slot `n` holding a number is
/// `COMPONENT_NUMBER + n` (past the canvas slots' codes; exact in an f32).
const COMPONENT_NUMBER: f32 = 70000.0;
/// The same holding a color (ARGB bits) is `COMPONENT_COLOR + n`.
const COMPONENT_COLOR: f32 = 140000.0;
/// A color value as Java's ARGB bits.
fn argb(value: AnimationValue) -> f32 {
    match value {
        AnimationValue::Color(c) => f32::from_bits(c.rotate_right(8)),
        other => other.number(),
    }
}

/// Codes of the [`view_transform`] values, in order.
const TRANSFORM_CODES: [f32; 8] = [1.0, 2.0, 4.0, 5.0, 6.0, 8.0, 9.0, 10.0];

/// A transform list as Android view properties: translation x / y (dp),
/// scale x / y, rotation, rotation x / y (degrees) and the perspective
/// term (`-1 / distance`, 0 for none; Java turns it into a camera
/// distance). `value(i)` overrides entry `i` (an animated value). Skew has
/// no view property and is dropped.
pub(crate) fn view_transform(t: &Transform, value: impl Fn(usize) -> Option<f32>) -> [f32; 8] {
    match t.matrix(value).decompose() {
        Some(d) => [
            d.translate[0].0,
            d.translate[1].0,
            d.scale[0] as f32,
            d.scale[1] as f32,
            d.rotate[2].to_degrees(),
            d.rotate[0].to_degrees(),
            d.rotate[1].to_degrees(),
            d.perspective.map_or(0.0, |distance| -1.0 / distance.0),
        ],
        // A zero scale: invisible.
        None => [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    }
}

#[derive(Default)]
struct Gestures {
    values: GestureValues,
    /// Values when the gesture began: pan x, pan y, pinch, rotation.
    start: [f32; 4],
}

#[derive(Default)]
pub(crate) struct UiAnimation {
    graph: Graph,
    pub(crate) finished: Vec<Finished>,
    /// View id -> bound properties.
    bindings: FxHashMap<u32, Vec<(AnimationProp, NodeId)>>,
    /// View id -> static transform list, whose animated entries the
    /// bindings replace, and shadow, whose bound parts they replace.
    statics: FxHashMap<u32, (Transform, Shadow)>,
    gestures: FxHashMap<u32, Gestures>,
    /// Scroll view id -> (value node, horizontal).
    scrolls: FxHashMap<u32, (NodeId, bool)>,
    /// Vertical scroll view id -> pull value node.
    pulls: FxHashMap<u32, NodeId>,
    /// Scroll view id -> its sticky cells that stick an animated value
    /// further in, with that value's node.
    sticky: FxHashMap<u32, Vec<(u32, NodeId)>>,
}

impl UiAnimation {
    pub(crate) fn apply(&mut self, item: MountItem) {
        match item {
            MountItem::Animation(op) => self.graph.apply(op, &mut self.finished),
            MountItem::AnimationBindings { id, bindings } => {
                if bindings.is_empty() {
                    self.bindings.remove(&id);
                } else {
                    self.bindings.insert(id, bindings);
                }
            }
            MountItem::ViewStyle { id, style } => {
                self.statics.insert(id, (style.transform, style.shadow));
            }
            MountItem::Gestures { id, values } => {
                if values.is_empty() {
                    self.gestures.remove(&id);
                } else {
                    self.gestures.entry(id).or_default().values = values;
                }
            }
            MountItem::ScrollConfig {
                id,
                horizontal,
                scroll_value,
                pull_value,
                ..
            } => {
                match scroll_value {
                    Some(node) => {
                        self.scrolls.insert(id, (node, horizontal));
                    }
                    None => {
                        self.scrolls.remove(&id);
                    }
                }
                match pull_value.filter(|_| !horizontal) {
                    Some(node) => {
                        self.pulls.insert(id, node);
                    }
                    None => {
                        self.pulls.remove(&id);
                    }
                }
            }
            MountItem::StickyCells { id, cells } => {
                let animated: Vec<(u32, NodeId)> = cells
                    .iter()
                    .filter_map(|c| Some((c.cell, c.offset?)))
                    .collect();
                if animated.is_empty() {
                    self.sticky.remove(&id);
                } else {
                    self.sticky.insert(id, animated);
                }
            }
            MountItem::Delete { id } => {
                self.bindings.remove(&id);
                self.statics.remove(&id);
                self.gestures.remove(&id);
                self.scrolls.remove(&id);
                self.pulls.remove(&id);
                self.sticky.remove(&id);
            }
            _ => {}
        }
    }

    pub(crate) fn tick(&mut self, now: f64) -> bool {
        self.graph.tick(now, &mut self.finished)
    }

    pub(crate) fn animating(&self) -> bool {
        self.graph.is_animating()
    }

    /// Scroll view `id` came to rest: the snapping values that follow its
    /// scroll value settle. True if one starts moving.
    pub(crate) fn scroll_ended(&mut self, id: u32) -> bool {
        let Some(&(node, _)) = self.scrolls.get(&id) else {
            return false;
        };
        self.graph.settle(node)
    }

    /// A scroll view moved: feeds its scroll value.
    pub(crate) fn scrolled(&mut self, id: u32, x: f32, y: f32) -> bool {
        let Some(&(node, horizontal)) = self.scrolls.get(&id) else {
            return false;
        };
        self.graph
            .set(node, if horizontal { x } else { y }, &mut self.finished);
        true
    }

    /// A vertical scroll view is pulled `distance` points past its top:
    /// feeds its pull value.
    pub(crate) fn pulled(&mut self, id: u32, distance: f32) -> bool {
        let Some(&node) = self.pulls.get(&id) else {
            return false;
        };
        self.graph.set(node, distance.max(0.0), &mut self.finished);
        true
    }

    /// Whether view `id` is dragged by animated values.
    pub(crate) fn has_pan(&self, id: u32) -> bool {
        self.gestures
            .get(&id)
            .is_some_and(|g| g.values.pan_x.is_some() || g.values.pan_y.is_some())
    }

    /// A drag began: grabbing an animating value stops it where it is.
    pub(crate) fn pan_began(&mut self, id: u32) {
        let graph = &self.graph;
        if let Some(g) = self.gestures.get_mut(&id) {
            g.start[0] = g.values.pan_x.and_then(|n| graph.value(n)).unwrap_or(0.0);
            g.start[1] = g.values.pan_y.and_then(|n| graph.value(n)).unwrap_or(0.0);
        }
    }

    /// The drag moved by `(tx, ty)` points since it began.
    pub(crate) fn pan_moved(&mut self, id: u32, tx: f32, ty: f32) {
        let Some(g) = self.gestures.get(&id) else {
            return;
        };
        let (x, y, start) = (g.values.pan_x, g.values.pan_y, g.start);
        if let Some(n) = x {
            self.graph.set(n, start[0] + tx, &mut self.finished);
        }
        if let Some(n) = y {
            self.graph.set(n, start[1] + ty, &mut self.finished);
        }
    }

    /// The values the drag on `id` moves (`pan.x`, `pan.y`).
    pub(crate) fn pan_values(&self, id: u32) -> (Option<f32>, Option<f32>) {
        let Some(g) = self.gestures.get(&id) else {
            return (None, None);
        };
        (
            g.values.pan_x.and_then(|n| self.graph.value(n)),
            g.values.pan_y.and_then(|n| self.graph.value(n)),
        )
    }

    /// A pinch (`rotation` false) or two-finger rotation began.
    pub(crate) fn transform_began(&mut self, id: u32, rotation: bool) {
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
    pub(crate) fn transform_moved(&mut self, id: u32, rotation: bool, amount: f32) {
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

    /// `[animating, (view, prop, value)*]` for every bound property.
    pub(crate) fn outputs(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(1 + self.bindings.len() * 12);
        out.push(if self.animating() { 1.0 } else { 0.0 });
        for (&view, bindings) in &self.bindings {
            let v = f32::from_bits(view);
            let mut overrides = [None; MAX_TRANSFORMS];
            let mut transformed = false;
            let mut shadow: Option<Shadow> = None;
            let statics = self.statics.get(&view).copied();
            let static_shadow = statics.map_or(Shadow::DEFAULT, |s| s.1);
            for &(prop, node) in bindings {
                match prop {
                    AnimationProp::BorderColor | AnimationProp::Color => {
                        let code = if prop == AnimationProp::Color {
                            TEXT_COLOR
                        } else {
                            BORDER_COLOR
                        };
                        out.extend_from_slice(&[v, code, argb(self.graph.eval(node))]);
                    }
                    AnimationProp::ShadowColor => {
                        if let AnimationValue::Color(c) = self.graph.eval(node) {
                            shadow.get_or_insert(static_shadow).color = nsh_core::Color(c);
                        }
                    }
                    AnimationProp::ShadowOpacity => {
                        shadow.get_or_insert(static_shadow).opacity =
                            self.graph.eval(node).number();
                    }
                    AnimationProp::ShadowRadius => {
                        let radius = self.graph.eval(node).number().max(0.0);
                        out.extend_from_slice(&[v, SHADOW_RADIUS, radius]);
                    }
                    AnimationProp::Opacity => {
                        out.extend_from_slice(&[v, OPACITY, self.graph.eval(node).number()]);
                    }
                    AnimationProp::BackgroundColor => {
                        let value = match self.graph.eval(node) {
                            AnimationValue::Color(c) => f32::from_bits(c.rotate_right(8)),
                            other => other.number(),
                        };
                        out.extend_from_slice(&[v, BACKGROUND, value]);
                    }
                    AnimationProp::CanvasArg(k) => {
                        let value = match self.graph.eval(node) {
                            AnimationValue::Color(c) => f32::from_bits(c.rotate_right(8)),
                            other => other.number(),
                        };
                        out.extend_from_slice(&[v, CANVAS_ARG + k as f32, value]);
                    }
                    AnimationProp::Transform(i) => {
                        if let Some(o) = overrides.get_mut(i as usize) {
                            *o = Some(self.graph.eval(node).number());
                            transformed = true;
                        }
                    }
                    // The scroll view's (`sticky` below), never bound.
                    AnimationProp::StickyTop | AnimationProp::StickyLeft => {}
                    // Java hands it to the component when it changed.
                    AnimationProp::ComponentSlot(k) => match self.graph.eval(node) {
                        AnimationValue::Color(c) => out.extend_from_slice(&[
                            v,
                            COMPONENT_COLOR + k as f32,
                            f32::from_bits(c.rotate_right(8)),
                        ]),
                        other => {
                            out.extend_from_slice(&[v, COMPONENT_NUMBER + k as f32, other.number()])
                        }
                    },
                }
            }
            if let Some(s) = shadow {
                // As `Mounter.java` takes a style's shadow: the opacity
                // scales the color's alpha.
                let c = s.color.0;
                let alpha = ((c & 0xff) as f32 * s.opacity.clamp(0.0, 1.0)).round() as u32;
                let argb = (alpha << 24) | (c >> 8);
                out.extend_from_slice(&[v, SHADOW_COLOR, f32::from_bits(argb)]);
            }
            if transformed {
                let statics = statics.map_or(Transform::IDENTITY, |s| s.0);
                let values = view_transform(&statics, |i| overrides[i]);
                for (code, value) in TRANSFORM_CODES.iter().zip(values) {
                    out.extend_from_slice(&[v, *code, value]);
                }
            }
        }
        // Sticky cells that stick an animated value further in.
        for cells in self.sticky.values() {
            for &(cell, node) in cells {
                let value = self.graph.eval(node).number();
                out.extend_from_slice(&[f32::from_bits(cell), STICKY_OFFSET, value]);
            }
        }
        out
    }
}
