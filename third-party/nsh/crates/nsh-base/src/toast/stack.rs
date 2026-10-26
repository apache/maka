//! `ToastStack`: measures its toasts and lays them out as overlapping
//! layers or, expanded, a list, moving them with springs.

use nsh_core::{TouchEvent, TouchPhase, TransformKind, element::Spring, prelude::*};

use super::ToastMotion;

/// The edge of the viewport a [`ToastStack`]'s geometry is anchored to:
/// the newest toast nearest it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum Anchor {
    /// The top left corner.
    TopLeft,
    /// The middle of the top edge.
    TopCenter,
    /// The top right corner.
    #[default]
    TopRight,
    /// The bottom left corner.
    BottomLeft,
    /// The middle of the bottom edge.
    BottomCenter,
    /// The bottom right corner.
    BottomRight,
    /// The middle of the left edge.
    LeftCenter,
    /// The middle of the right edge.
    RightCenter,
}

impl Anchor {
    /// Anchored to the bottom: the stack grows upward.
    fn bottom(self) -> bool {
        matches!(
            self,
            Anchor::BottomLeft | Anchor::BottomCenter | Anchor::BottomRight
        )
    }
}

/// The props of [`ToastStack`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ToastStackProps {
    /// Its motion tokens (Sonner's by default; fields left out keep theirs).
    #[prop(default)]
    pub motion: Prop<ToastMotion>,
    /// The edge its geometry is anchored to (default `"topRight"`): the
    /// newest toast is nearest it. The app places the stack itself (an
    /// `Overlay` at that edge, inside the safe area).
    #[prop(default)]
    pub placement: Prop<Anchor>,
    /// Escape and the Android back button are heard while it holds toasts
    /// (`onCancel`; default true).
    #[prop(default = true)]
    pub close_on_escape: Prop<bool>,
    /// The toasts, oldest first: each child is an item, keyed by its node.
    pub children: Prop<Children>,
}

/// The events of a [`ToastStack`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ToastStackEvent {
    /// Interaction expanded or collapsed it: the pointer on it, or a finger
    /// down on it. While expanded, pass `paused` to the manager's
    /// `advance`.
    #[args(expanded)]
    ExpandedChange(bool),
    /// Escape or the Android back button while it holds toasts: dismiss
    /// the newest.
    Cancel,
}

/// Whether a [`ToastStack`] is expanded, as `gpui-base`'s
/// `ToastStackState` (Rust; TS: `onExpandedChange`): made with the view,
/// given to the stack with [`ToastStackElement::state`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToastStackState {
    expanded: Signal<bool>,
}

impl ToastStackState {
    /// A state of the current owner, collapsed.
    pub fn new() -> Self {
        Self {
            expanded: signal(false),
        }
    }

    /// Interaction expanded the stack (tracked).
    pub fn is_expanded(&self) -> bool {
        self.expanded.get()
    }
}

impl Default for ToastStackState {
    fn default() -> Self {
        Self::new()
    }
}

impl ToastStackElement {
    /// Keeps `state` up to date with the stack (its `onExpandedChange`).
    pub fn state(self, state: ToastStackState) -> Self {
        self.on_expanded_change(move |expanded: &bool| state.expanded.set(*expanded))
    }
}

/// An item of the stack: its key, its place, its measured height.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Item {
    key: u64,
    index: usize,
    height: Points,
}

/// The stack's height collapsed and expanded, for items of `heights`
/// (oldest first), as `gpui-base`'s.
fn stack_heights(heights: &[Points], gap: Points, peek: Points) -> (Points, Points) {
    let count = heights.len();
    let expanded =
        heights.iter().map(|h| h.0).sum::<f32>() + gap.0 * count.saturating_sub(1) as f32;
    let front = heights.last().map_or(0.0, |h| h.0);
    let collapsed = heights
        .iter()
        .enumerate()
        .map(|(i, h)| h.0 + peek.0 * (count - 1 - i) as f32)
        .fold(front + peek.0 * count.saturating_sub(1) as f32, f32::max);
    (Points(collapsed), Points(expanded))
}

/// How far item `index` of `heights` is from the anchored edge, collapsed
/// and expanded.
fn distance(heights: &[Points], index: usize, gap: Points, peek: Points) -> (Points, Points) {
    let count = heights.len();
    let rank = count.saturating_sub(1 + index) as f32;
    let newer: f32 = heights
        .get(index + 1..)
        .unwrap_or(&[])
        .iter()
        .map(|h| h.0)
        .sum();
    (Points(peek.0 * rank), Points(newer + gap.0 * rank))
}

/// A critically damped spring whose response is `duration` (no overshoot:
/// a height or an opacity past its target reads as a glitch).
fn spring_of(motion: ToastMotion) -> Spring {
    let response = motion.duration.as_secs_f32().max(0.01);
    let stiffness = (std::f32::consts::TAU / response).powi(2);
    Spring {
        stiffness,
        damping: 2.0 * stiffness.sqrt(),
        mass: 1.0,
        velocity: None,
    }
}

/// A deep toast stack, as `gpui-base`'s `ToastStack`: it measures its
/// toasts (its children, oldest first) and lays them out from its
/// `placement`'s edge, the newest nearest it. Collapsed, they overlap as
/// layers `collapsedPeek` apart, each narrower by `collapsedScaleStep` and
/// only `collapsedVisible` shown; expanded (the pointer on it, a finger
/// down on it: `onExpandedChange`), they are a list `expandedGap` apart.
/// Arrivals, departures and expansion move them with springs of the
/// motion's `duration`. It hears Escape and back while it holds toasts
/// (`onCancel`). It looks like nothing: its `class` and `style` give its
/// width; the app places it.
#[component]
pub fn ToastStack(props: ToastStackProps, cx: Scope<ToastStackEvent>) -> impl IntoElement {
    let hovered = signal(false);
    let touched = signal(false);
    let expanded = computed(move || hovered.get() || touched.get());
    {
        let was = stored(false);
        effect(move || {
            let now = expanded.get();
            if was.replace(now) != now {
                untracked(|| cx.emit(ToastStackEvent::ExpandedChange(now)));
            }
        });
    }
    let items = signal(Vec::<Item>::new());
    let next = stored(0u64);
    // The measured heights, oldest first.
    let heights = computed(move || {
        let mut all = items.get();
        all.sort_by_key(|i| i.index);
        all.into_iter().map(|i| i.height).collect::<Vec<_>>()
    });
    let height = move || {
        let m = props.motion.get();
        let (collapsed, full) =
            heights.with(|h| stack_heights(h, m.expanded_gap, m.collapsed_peek));
        if expanded.get() { full } else { collapsed }
    };
    let any = move || !props.children.get().is_empty();

    view()
        .relative()
        .style_with(move |s| s.h(height()))
        .on_hover_in(move || hovered.set(true))
        .on_hover_out(move || hovered.set(false))
        // Observed, never claimed: the toasts' presses and swipes go on.
        .on_touch(move |e: &TouchEvent| match e.phase {
            TouchPhase::Start => touched.set(true),
            TouchPhase::End | TouchPhase::Cancel => touched.set(false),
            TouchPhase::Move => {}
        })
        .children_each(props.children, move |child, at| {
            let key = next.with(|n| *n);
            next.replace(key + 1);
            items.update(|v| {
                v.push(Item {
                    key,
                    index: untracked(|| at.index()),
                    height: Points::ZERO,
                })
            });
            effect(move || {
                let index = at.index();
                untracked(|| {
                    if items.with(|v| v.iter().any(|i| i.key == key && i.index != index)) {
                        items.update(|v| {
                            if let Some(i) = v.iter_mut().find(|i| i.key == key) {
                                i.index = index;
                            }
                        });
                    }
                });
            });
            cleanup(move || {
                let _ = items.try_get().map(|mut v| {
                    v.retain(|i| i.key != key);
                    items.try_set(v);
                });
            });
            let y = animated_value(0.0);
            let scale_x = animated_value(1.0);
            let opacity = animated_value(1.0);
            let shown = signal(true);
            let first = stored(true);
            effect(move || {
                let m = props.motion.get();
                let bottom = props.placement.get().bottom();
                let open = expanded.get();
                let (index, count) = (at.index(), at.count());
                let (collapsed, full) = heights.with(|h| {
                    // Heights not measured yet count as nothing.
                    let mut h = h.clone();
                    h.resize(count, Points::ZERO);
                    distance(&h, index, m.expanded_gap, m.collapsed_peek)
                });
                let rank = count.saturating_sub(1 + index);
                let visible = m.collapsed_visible.max(1);
                let d = if open { full } else { collapsed };
                let ty = if bottom { -d.0 } else { d.0 };
                let sx = if open {
                    1.0
                } else {
                    1.0 - m.collapsed_scale_step * rank.min(visible - 1) as f32
                };
                let on = open || rank < visible;
                untracked(|| {
                    shown.set(on);
                    let op = if on { 1.0 } else { 0.0 };
                    if first.replace(false) || reduce_motion() {
                        y.set(ty);
                        scale_x.set(sx);
                        opacity.set(op);
                    } else {
                        let spring = spring_of(m);
                        y.spring(ty, spring);
                        scale_x.spring(sx, spring);
                        opacity.spring(op, spring);
                    }
                });
            });
            view()
                .absolute()
                .left_0()
                .right_0()
                .style_with(move |s| {
                    if props.placement.get().bottom() {
                        s.bottom_0()
                    } else {
                        s.top_0()
                    }
                })
                .bind_translate_y(&y)
                .bind_transform(TransformKind::ScaleX, &scale_x)
                .bind_opacity(&opacity)
                .pointer_events(move || {
                    if shown.get() {
                        PointerEvents::BoxNone
                    } else {
                        PointerEvents::None
                    }
                })
                .on_layout(move |frame: &Bounds<Points>| {
                    let h = frame.size.height;
                    if items.with_untracked(|v| v.iter().any(|i| i.key == key && i.height != h)) {
                        items.update(|v| {
                            if let Some(i) = v.iter_mut().find(|i| i.key == key) {
                                i.height = h;
                            }
                        });
                    }
                })
                .child(child)
        })
        // Escape and back, only while it holds toasts: an overlay of no
        // size, so nothing else loses them to an empty stack.
        .child(when(
            move || any() && props.close_on_escape.get(),
            move || {
                overlay()
                    .size_0()
                    .pointer_events(PointerEvents::None)
                    .focusable(false)
                    .on_cancel(move || cx.emit(ToastStackEvent::Cancel))
            },
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_geometry_anchors_the_newest_and_takes_any_heights() {
        let heights = [Points(40.0), Points(60.0), Points(80.0)];
        let (gap, peek) = (Points(12.0), Points(12.0));
        assert_eq!(
            stack_heights(&heights, gap, peek),
            (Points(104.0), Points(204.0))
        );
        let at = |i| distance(&heights, i, gap, peek);
        assert_eq!(at(0), (Points(24.0), Points(164.0)));
        assert_eq!(at(1), (Points(12.0), Points(92.0)));
        assert_eq!(at(2), (Points(0.0), Points(0.0)));
    }
}
