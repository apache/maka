//! The native animation graph on the browser's main thread:
//! `requestAnimationFrame` ticks, drags and scroll offsets update it;
//! bound view properties go to the DOM as `["a", view, prop, value]`
//! items (the Android animator's design, `nsh-platform-android/src/animation.rs`).

use nsh_core::{
    Color, GestureValues, MAX_TRANSFORMS, MountItem, Shadow, Transform,
    animation::{AnimationProp, AnimationValue, Finished, Graph, NodeId},
};
use rustc_hash::FxHashMap;

use crate::encode::{Out, css_color, css_transform};

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

fn value_css(v: AnimationValue) -> String {
    match v {
        AnimationValue::Color(c) => css_color(Color(c)),
        other => other.number().to_string(),
    }
}

impl UiAnimation {
    /// Takes the animation items of a batch; true if the item was one
    /// (only animation items are consumed; the others are also looked at).
    pub(crate) fn apply(&mut self, item: &MountItem) {
        match item {
            MountItem::Animation(op) => self.graph.apply(op.clone(), &mut self.finished),
            MountItem::AnimationBindings { id, bindings } => {
                if bindings.is_empty() {
                    self.bindings.remove(id);
                } else {
                    self.bindings.insert(*id, bindings.clone());
                }
            }
            MountItem::ViewStyle { id, style } => {
                self.statics.insert(*id, (style.transform, style.shadow));
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
                pull_value,
                ..
            } => {
                match scroll_value {
                    Some(node) => {
                        self.scrolls.insert(*id, (*node, *horizontal));
                    }
                    None => {
                        self.scrolls.remove(id);
                    }
                }
                match pull_value.filter(|_| !*horizontal) {
                    Some(node) => {
                        self.pulls.insert(*id, node);
                    }
                    None => {
                        self.pulls.remove(id);
                    }
                }
            }
            MountItem::StickyCells { id, cells } => {
                let animated: Vec<(u32, NodeId)> = cells
                    .iter()
                    .filter_map(|c| Some((c.cell, c.offset?)))
                    .collect();
                if animated.is_empty() {
                    self.sticky.remove(id);
                } else {
                    self.sticky.insert(*id, animated);
                }
            }
            MountItem::Delete { id } => {
                self.bindings.remove(id);
                self.statics.remove(id);
                self.gestures.remove(id);
                self.scrolls.remove(id);
                self.pulls.remove(id);
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
    /// scroll value settle (the next frame request runs them).
    pub(crate) fn scroll_ended(&mut self, id: u32) {
        if let Some(&(node, _)) = self.scrolls.get(&id) {
            self.graph.settle(node);
        }
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

    /// A vertical scroll view is pulled `distance` past its top: feeds its
    /// pull value.
    pub(crate) fn pulled(&mut self, id: u32, distance: f32) -> bool {
        let Some(&node) = self.pulls.get(&id) else {
            return false;
        };
        self.graph.set(node, distance.max(0.0), &mut self.finished);
        true
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

    /// Every bound property's current value.
    pub(crate) fn outputs(&self, out: &mut Out) {
        for (&view, bindings) in &self.bindings {
            let mut overrides = [None; MAX_TRANSFORMS];
            let mut transformed = false;
            let statics = self.statics.get(&view).copied();
            let mut shadow: Option<Shadow> = None;
            let static_shadow = statics.map_or(Shadow::DEFAULT, |s| s.1);
            for &(prop, node) in bindings {
                match prop {
                    // `nsh.js` puts these on the border overlay and the
                    // text's runs.
                    AnimationProp::BorderColor => {
                        out.animation(view, "border-color", &value_css(self.graph.eval(node)));
                    }
                    AnimationProp::Color => {
                        out.animation(view, "color", &value_css(self.graph.eval(node)));
                    }
                    AnimationProp::ShadowColor => {
                        if let AnimationValue::Color(c) = self.graph.eval(node) {
                            shadow.get_or_insert(static_shadow).color = Color(c);
                        }
                    }
                    AnimationProp::ShadowOpacity => {
                        shadow.get_or_insert(static_shadow).opacity =
                            self.graph.eval(node).number().clamp(0.0, 1.0);
                    }
                    AnimationProp::ShadowRadius => {
                        shadow.get_or_insert(static_shadow).radius =
                            nsh_core::Points(self.graph.eval(node).number().max(0.0));
                    }
                    AnimationProp::Opacity => {
                        out.animation(view, "opacity", &self.graph.eval(node).number().to_string());
                    }
                    AnimationProp::BackgroundColor => {
                        out.animation(view, "background-color", &value_css(self.graph.eval(node)));
                    }
                    AnimationProp::CanvasArg(k) => {
                        out.animation(
                            view,
                            &format!("canvas:{k}"),
                            &value_css(self.graph.eval(node)),
                        );
                    }
                    AnimationProp::Transform(i) => {
                        if let Some(o) = overrides.get_mut(i as usize) {
                            *o = Some(self.graph.eval(node).number());
                            transformed = true;
                        }
                    }
                    // The scroll view's (`sticky` below), never bound.
                    AnimationProp::StickyTop | AnimationProp::StickyLeft => {}
                    // No registered native components on the web.
                    AnimationProp::ComponentSlot(_) => {}
                }
            }
            if let Some(s) = shadow {
                // The view's `box-shadow` (layered `boxShadow`s are not
                // kept while its shadow is bound).
                let c = s.color.0;
                let alpha = ((c & 0xff) as f32 * s.opacity).round().clamp(0.0, 255.0) as u32;
                let css = format!(
                    "{}px {}px {}px {}",
                    s.offset_x,
                    s.offset_y,
                    s.radius,
                    css_color(Color((c & !0xff) | alpha))
                );
                out.animation(view, "box-shadow", &css);
            }
            if transformed {
                let statics = statics.map_or(Transform::IDENTITY, |s| s.0);
                let css = css_transform(&statics, |i| overrides[i]);
                out.animation(view, "transform", css.trim_end());
            }
        }
        // Sticky cells that stick an animated value further in (`nsh.js`
        // moves their sticky inset).
        for cells in self.sticky.values() {
            for &(cell, node) in cells {
                let value = self.graph.eval(node).number().to_string();
                out.animation(cell, "sticky-offset", &value);
            }
        }
    }
}
