//! The native animation graph on the browser's main thread:
//! `requestAnimationFrame` ticks, drags and scroll offsets update it;
//! bound view properties go to the DOM as `["a", view, prop, value]`
//! items (the Android animator's design, `nsh-platform-android/src/animation.rs`).
//! After a batch every bound value goes; on a frame or a gesture only the
//! ones that changed since they last went ([`UiAnimation::outputs`]).

use nsh_core::{
    Color, GestureValues, MAX_TRANSFORMS, MountItem, Transform,
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

/// A bound property a value was sent for ([`UiAnimation::outputs`]).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    BorderColor,
    Color,
    Opacity,
    BackgroundColor,
    Canvas(u16),
    Transform,
    /// A sticky cell's offset (on the cell).
    Sticky,
}

/// What was last sent for a slot: a value, or a transform's animated
/// entries (its static ones come with the view's style, in a batch).
#[derive(Clone, Copy, PartialEq)]
enum Sent {
    Value(AnimationValue),
    Transform([Option<f32>; MAX_TRANSFORMS]),
}

#[derive(Default)]
pub(crate) struct UiAnimation {
    graph: Graph,
    pub(crate) finished: Vec<Finished>,
    /// View id -> bound properties.
    bindings: FxHashMap<u32, Vec<(AnimationProp, NodeId)>>,
    /// Views' CSS properties written inline that are bound no more (a view
    /// taken over by an element without them): the next outputs clear them,
    /// so the view shows its own style again.
    unbound: Vec<(u32, &'static str)>,
    /// View id -> static transform list, whose animated entries the
    /// bindings replace.
    statics: FxHashMap<u32, Transform>,
    gestures: FxHashMap<u32, Gestures>,
    /// Scroll view id -> (value node, horizontal).
    scrolls: FxHashMap<u32, (NodeId, bool)>,
    /// Vertical scroll view id -> pull value node.
    pulls: FxHashMap<u32, NodeId>,
    /// Scroll view id -> its sticky cells that stick an animated value
    /// further in, with that value's node.
    sticky: FxHashMap<u32, Vec<(u32, NodeId)>>,
    /// View id -> what [`UiAnimation::outputs`] last sent for each of its
    /// slots.
    sent: FxHashMap<u32, Vec<(Slot, Sent)>>,
}

/// Whether `value` goes for `view`'s `slot`: always when `all`, else when
/// it differs from what went last. It is what went last from then on.
fn changed(
    sent: &mut FxHashMap<u32, Vec<(Slot, Sent)>>,
    view: u32,
    slot: Slot,
    value: Sent,
    all: bool,
) -> bool {
    let slots = sent.entry(view).or_default();
    match slots.iter_mut().find(|(s, _)| *s == slot) {
        Some((_, last)) if !all && *last == value => false,
        Some((_, last)) => {
            *last = value;
            true
        }
        None => {
            slots.push((slot, value));
            true
        }
    }
}

/// The CSS property `nsh.js` writes a bound property into (`op_a`), for
/// those it writes inline.
fn inline_property(prop: AnimationProp) -> Option<&'static str> {
    match prop {
        AnimationProp::Opacity => Some("opacity"),
        AnimationProp::BackgroundColor => Some("background-color"),
        AnimationProp::BorderColor => Some("border-color"),
        AnimationProp::Color => Some("color"),
        AnimationProp::Transform(_) => Some("transform"),
        _ => None,
    }
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
                let kept = |css| {
                    bindings
                        .iter()
                        .any(|&(p, _)| inline_property(p) == Some(css))
                };
                for &(prop, _) in self.bindings.get(id).into_iter().flatten() {
                    if let Some(css) = inline_property(prop)
                        && !kept(css)
                        && !self.unbound.contains(&(*id, css))
                    {
                        self.unbound.push((*id, css));
                    }
                }
                if bindings.is_empty() {
                    self.bindings.remove(id);
                } else {
                    self.bindings.insert(*id, bindings.clone());
                }
                self.sent.remove(id);
            }
            MountItem::ViewStyle { id, style } => {
                self.statics.insert(*id, style.transform);
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
                self.sent.remove(id);
            }
            _ => {}
        }
    }

    /// Steps the graph to `now`: a display frame (`drawn`) or a deadline's
    /// tick while frames stop, which keeps the real time
    /// ([`Graph::tick_frame`]).
    pub(crate) fn tick(&mut self, now: f64, drawn: bool) -> bool {
        if drawn {
            self.graph.tick_frame(now, &mut self.finished)
        } else {
            self.graph.tick(now, &mut self.finished)
        }
    }

    pub(crate) fn animating(&self) -> bool {
        self.graph.is_animating()
    }

    /// When the graph next has an animation that ends by itself to end
    /// (seconds, the clock [`UiAnimation::tick`] is given): what the page
    /// ticks it at while no animation frames come ([`Graph::deadline`]).
    pub(crate) fn deadline(&self, now: f64) -> Option<f64> {
        self.graph.deadline(now)
    }

    /// Whether the graph runs an animation that ends by itself (not one
    /// looping forever, which no test step waits for).
    #[cfg(feature = "dev")]
    pub(crate) fn finishing(&self) -> bool {
        self.graph.is_finishing()
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

    /// The bound properties' current values, after clearing the ones bound
    /// no more (`nsh.js` removes an inline property set to ""). `all` after
    /// a batch: every value, so views it inserted (again) and inline styles
    /// navigation wrote get theirs. Otherwise (a frame, a gesture, a scroll)
    /// only the values that changed since they last went: a page whose
    /// views hold many bound values, most of them still, costs the frame
    /// only what moves.
    pub(crate) fn outputs(&mut self, out: &mut Out, all: bool) {
        for (view, css) in self.unbound.drain(..) {
            out.animation(view, css, "");
        }
        for (&view, bindings) in &self.bindings {
            let mut overrides = [None; MAX_TRANSFORMS];
            let mut transformed = false;
            for &(prop, node) in bindings {
                let value = self.graph.eval(node);
                let (slot, css) = match prop {
                    // `nsh.js` puts these on the border overlay and the
                    // text's runs.
                    AnimationProp::BorderColor => (Slot::BorderColor, "border-color"),
                    AnimationProp::Color => (Slot::Color, "color"),
                    AnimationProp::Opacity => (Slot::Opacity, "opacity"),
                    AnimationProp::BackgroundColor => (Slot::BackgroundColor, "background-color"),
                    AnimationProp::CanvasArg(k) => {
                        if changed(
                            &mut self.sent,
                            view,
                            Slot::Canvas(k),
                            Sent::Value(value),
                            all,
                        ) {
                            out.animation(view, &format!("canvas:{k}"), &value_css(value));
                        }
                        continue;
                    }
                    AnimationProp::Transform(i) => {
                        if let Some(o) = overrides.get_mut(i as usize) {
                            *o = Some(value.number());
                            transformed = true;
                        }
                        continue;
                    }
                    // The scroll view's (`sticky` below), never bound.
                    AnimationProp::StickyTop | AnimationProp::StickyLeft => continue,
                    // No registered native components on the web.
                    AnimationProp::ComponentSlot(_) => continue,
                };
                if changed(&mut self.sent, view, slot, Sent::Value(value), all) {
                    let text = match prop {
                        AnimationProp::Opacity => value.number().to_string(),
                        _ => value_css(value),
                    };
                    out.animation(view, css, &text);
                }
            }
            if transformed
                && changed(
                    &mut self.sent,
                    view,
                    Slot::Transform,
                    Sent::Transform(overrides),
                    all,
                )
            {
                let statics = self
                    .statics
                    .get(&view)
                    .copied()
                    .unwrap_or(Transform::IDENTITY);
                let css = css_transform(&statics, |i| overrides[i]);
                out.animation(view, "transform", css.trim_end());
            }
        }
        // Sticky cells that stick an animated value further in (`nsh.js`
        // moves their sticky inset).
        for cells in self.sticky.values() {
            for &(cell, node) in cells {
                let value = self.graph.eval(node);
                if changed(&mut self.sent, cell, Slot::Sticky, Sent::Value(value), all) {
                    out.animation(cell, "sticky-offset", &value.number().to_string());
                }
            }
        }
    }
}
