//! A [`Treemap`](super::Treemap)'s labels (a leaf's name and value, a
//! group's name in its band) and its hover box.

use std::{rc::Rc, sync::Arc};

use nsh_core::{
    element::{RowText, Rows, Style, TextPartStyle},
    prelude::*,
};

use super::{Layout, Spot, TreemapLabelPlacement, TreemapPose};
use crate::plot::{PlotContext, cell::is_dark, moves::Moves, series};

/// The texts `text` reads of `rows`, once known.
pub(super) fn texts(
    rows: impl Fn() -> Rows + 'static,
    text: Prop<Option<RowText>>,
) -> Signal<Option<Arc<[SharedString]>>> {
    series::texts(rows, move || text.get())
}

/// What the labels need.
#[derive(Clone)]
pub(super) struct Labels {
    pub(super) moves: Moves<TreemapPose>,
    pub(super) names: Signal<Option<Arc<[SharedString]>>>,
    pub(super) values: Signal<Option<Arc<[SharedString]>>>,
    pub(super) group_names: Signal<Option<Arc<[SharedString]>>>,
    pub(super) placement: Prop<TreemapLabelPlacement>,
    pub(super) class: Prop<Option<SharedString>>,
    pub(super) style: Prop<TextPartStyle>,
    pub(super) value_class: Prop<Option<SharedString>>,
    pub(super) style_value: Prop<TextPartStyle>,
    pub(super) group_class: Prop<Option<SharedString>>,
    pub(super) group_style: Prop<TextPartStyle>,
    /// How much a node's label shows of the plot's appear (`None`: the
    /// plot does not appear now), by its top-level node's place.
    pub(super) grown: Rc<dyn Fn(usize) -> Option<AnimatedNode>>,
    /// The opacity of the node spanning `first` to `last` (animated values)
    /// while one is hovered (`None`: nothing fades).
    pub(super) dimmed: Rc<Dimmed>,
}

/// The opacity of a node by its span of the layout ([`Labels::dimmed`]).
pub(super) type Dimmed = dyn Fn(&AnimatedValue, &AnimatedValue) -> Option<AnimatedNode>;

/// A label's key: its row, and whether it is a group's (in its band) or
/// a leaf's.
type Key = (usize, bool);

/// The labels of the nodes of the pose shown that have one: a leaf with a
/// name, a group with a band and a name.
pub(super) fn labels(labels: Labels) -> AnyElement {
    let Labels {
        moves,
        names,
        group_names,
        ..
    } = labels.clone();
    let keys = computed(move || -> Vec<Key> {
        let Some((to, _)) = moves.shown() else {
            return Vec::new();
        };
        let has = |texts: Signal<Option<Arc<[SharedString]>>>, row: usize| {
            texts.with(|t| {
                t.as_ref()
                    .is_some_and(|t| t.get(row).is_some_and(|t| !t.is_empty()))
            })
        };
        to.0.iter()
            .filter(|s| match s.group {
                true => s.header > 0.0 && has(group_names, s.row),
                false => has(names, s.row),
            })
            .map(|s| (s.row, s.group))
            .collect()
    });
    each(
        move || keys.get(),
        |k| *k,
        move |key, _| label(labels.clone(), key.get_untracked()),
    )
}

/// The label of the node of `key`: a box as big as its leaf (or its
/// band), at its place, riding its node through `motion.update`, its
/// lines shown where they fit.
fn label(labels: Labels, (row, group): Key) -> View {
    let Labels {
        moves,
        names,
        values,
        group_names,
        placement,
        ..
    } = labels.clone();
    let spot = computed(move || -> Option<Spot> {
        let (to, _) = moves.shown()?;
        to.0.iter()
            .find(|s| s.row == row && s.group == group)
            .cloned()
    });
    // Its box at rest, and the one it holds while its node moves: no
    // bigger than its node is at any time of the move.
    let boxes = computed(move || -> Option<([f32; 4], [f32; 2], [f32; 2])> {
        let (to, from) = moves.shown()?;
        let at = to.0.iter().find(|s| s.row == row && s.group == group)?;
        let band = |s: &Spot| match group {
            true => [s.rect[0], s.rect[1], s.rect[2], s.rect[1] + s.header],
            false => s.rect,
        };
        let b = band(at);
        let was = from.and_then(|(f, _)| f.0.iter().find(|s| s.id == at.id).map(band));
        let a = was.unwrap_or(b);
        let size = [
            (b[2] - b[0]).min(a[2] - a[0]),
            (b[3] - b[1]).min(a[3] - a[1]),
        ];
        Some((b, size, [a[0] - b[0], a[1] - b[1]]))
    });
    // How far it is from its place while its node moves there.
    let away = (animated_value(0.0), animated_value(0.0));
    effect(move || {
        let (dx, dy) = boxes.get().map_or((0.0, 0.0), |(_, _, d)| (d[0], d[1]));
        away.0.set(dx);
        away.1.set(dy);
    });
    let left = moves.progress().mul(-1.0).add(1.0);
    let (offset_x, offset_y) = (left.mul(&away.0), left.mul(&away.1));
    // Its node's span of the layout, on the animator, for the hover's fade.
    let span = (animated_value(0.0), animated_value(0.0));
    effect(move || {
        if let Some(s) = spot.get() {
            span.0.set(s.first as f32);
            span.1.set(s.last as f32);
        }
    });
    let opacity = {
        let root = untracked(|| spot.get().map_or(0, |s| s.root));
        let grown = (labels.grown)(root);
        let dimmed = (labels.dimmed)(&span.0, &span.1);
        // A node new to the layout fades in as it grows.
        let new = untracked(|| {
            moves.shown().is_some_and(|(to, from)| {
                from.is_some_and(|(f, _)| {
                    to.0.iter()
                        .find(|s| s.row == row && s.group == group)
                        .is_some_and(|s| !f.0.iter().any(|w| w.id == s.id))
                })
            })
        });
        let entering = new.then(|| *moves.progress().node());
        [grown, dimmed, entering]
            .into_iter()
            .flatten()
            .reduce(|a, b| a.mul(&b))
    };
    let dark = move || spot.with(|s| s.as_ref().and_then(|s| s.color).is_some_and(is_dark));
    let text_of = move |texts: Signal<Option<Arc<[SharedString]>>>| {
        move || {
            texts
                .with(|t| t.as_ref().and_then(|t| t.get(row).cloned()))
                .unwrap_or_default()
        }
    };

    // What decides which lines show: the lines' sizes in the box.
    let content = signal(Size::<Points>::default());
    let name = signal(Bounds::<Points>::default());
    let value = signal(Bounds::<Points>::default());
    let measure = |into: Signal<_>| {
        move |b: &Bounds<Points>| {
            if into.get_untracked() != *b {
                into.set(*b);
            }
        }
    };
    let name_fits = computed(move || {
        let (c, n) = (content.get(), name.get());
        let h = n.size.height.0;
        h > 0.0 && h <= c.height.0 + 0.5 && c.width.0 >= 2.0 * h
    });
    let value_fits = computed(move || {
        let (c, n, v) = (content.get(), name.get(), value.get());
        name_fits.get()
            && v.size.height.0 > 0.0
            && n.size.height.0 + v.size.height.0 <= c.height.0 + 0.5
            && v.size.width.0 <= c.width.0 + 0.5
    });
    let center = move || !group && placement.get() == TreemapLabelPlacement::Center;
    let (class, style) = match group {
        true => (labels.group_class, labels.group_style),
        false => (labels.class, labels.style),
    };
    let (value_class, value_style) = (labels.value_class, labels.style_value);
    let lines = view()
        .flex_1()
        .flex_col()
        .overflow_hidden()
        .on_layout(move |b: &Bounds<Points>| {
            if content.get_untracked() != b.size {
                content.set(b.size);
            }
        })
        .style_with(move |s| match center() {
            true => s.justify_center().items_center(),
            false => s.justify_start().items_start(),
        })
        .child(
            text(text_of(match group {
                true => group_names,
                false => names,
            }))
            .truncate()
            .max_w(relative(1.0))
            .on_layout(measure(name))
            .style_with(move |s| match name_fits.get() {
                true => s,
                false => s.opacity(0.0),
            }),
        )
        .child(when(
            move || !group && values.with(Option::is_some),
            move || {
                // A number is shown whole or not at all; where it does not
                // fit, it leaves the name its place.
                view()
                    .flex_row()
                    .items_start()
                    .style_with(move |s| match value_fits.get() {
                        true => s,
                        false => s.h(px(0.0)).opacity(0.0),
                    })
                    .child(
                        text(text_of(values))
                            .flex_none()
                            .on_layout(measure(value))
                            .app_class(value_class)
                            .inline_style(move || value_style.get().0),
                    )
            },
        ));
    let view = view()
        .absolute()
        .flex_col()
        .overflow_hidden()
        .pointer_events(PointerEvents::None)
        .bind_translate_x(&offset_x)
        .bind_translate_y(&offset_y)
        .project_data("dark", dark)
        .app_class(class)
        .inline_style(move || style.get().0)
        .style_with(move |s| match boxes.get() {
            Some((b, size, _)) => s
                .left(px(b[0]))
                .top(px(b[1]))
                .w(px(size[0].max(0.0)))
                .h(px(size[1].max(0.0))),
            None => s.hidden(),
        })
        .child(lines);
    match opacity {
        Some(o) => view.bind_opacity(&o),
        None => view,
    }
}

/// The hover box's part (`hoverClass` / `hoverStyle`).
#[derive(Clone, Copy)]
pub(super) struct HoverBox {
    pub(super) class: Prop<Option<SharedString>>,
    pub(super) style: Prop<Style>,
}

impl HoverBox {
    fn is_set(&self) -> bool {
        self.class.with(Option::is_some) || self.style.with(|s| *s != Style::default())
    }
}

/// The hover box: as big as the hovered node and over it, taking the
/// first node at once, gliding to the next on the plot's pointer spring
/// when the keys step there and moving with the pointer in the same
/// frame, faded with the hover; none unless the app styles it.
pub(super) fn hover_box(
    plot: PlotContext,
    laid: Memo<Option<Arc<Layout>>>,
    own: HoverBox,
) -> impl IntoElement {
    let (x, y) = (animated_value(0.0), animated_value(0.0));
    // Shown while the hovered row is one of this treemap's nodes.
    let mine = animated_value(0.0);
    let on = stored(None::<u32>);
    effect(move || {
        let hovered = plot.hovered.get();
        let found = hovered.and_then(|row| laid.with(|l| l.as_ref()?.of(row as usize).copied()));
        let Some(node) = found else {
            if hovered.is_some() {
                mine.set(0.0);
            }
            on.replace(None);
            return;
        };
        mine.set(1.0);
        let was = on.get();
        on.replace(hovered);
        let glide = was.is_some() && was != hovered && plot.keyed.get() && !reduce_motion();
        let spring = untracked(|| plot.motion.get().and_then(|m| m.pointer));
        for (value, to) in [(x, node.x0), (y, node.y0)] {
            match spring.filter(|_| glide) {
                Some(spring) => drop(value.spring(to, spring)),
                None => value.set(to),
            }
        }
    });
    when(
        move || plot.interactive.get() && own.is_set(),
        move || {
            // A box of one point scaled to the node's size would scale its
            // border and outline too: the box is laid out at the node's
            // size, moved on the animator.
            let size = computed(move || {
                plot.hovered.get().and_then(|row| {
                    laid.with(|l| {
                        let n = l.as_ref()?.of(row as usize)?;
                        Some((n.width(), n.height()))
                    })
                })
            });
            view()
                .absolute()
                .left(px(0.0))
                .top(px(0.0))
                .pointer_events(PointerEvents::None)
                .bind_translate_x(&x)
                .bind_translate_y(&y)
                .bind_opacity(&plot.fade.mul(&mine))
                .style_with(move |s| match size.get() {
                    Some((w, h)) => s.w(px(w)).h(px(h)),
                    None => s,
                })
                .child(view().flex_1().app_class(own.class).inline_style(own.style))
        },
    )
}
