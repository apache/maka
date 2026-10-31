//! The labels of a [`Sankey`](super::Sankey)'s nodes, the `nodeLabel`
//! part: the value over the name, placed as `gpui-component`'s
//! `SankeyChart` places them (`chart/sankey_chart.rs:658-718`), left of a
//! node in the first column, right of one in the last, centered above one
//! between them; beside a node, kept between the plot's top and bottom.
//! Each is a point with no size the layout places, its content on its
//! side, so its gap is the app's padding and its cut the app's classes.

use std::sync::Arc as Shared;

use nsh_core::{
    element::{Rows, TextPartStyle},
    prelude::*,
};

use super::{
    PlotContext, SankeyValueLabel,
    pose::{Moves, Side},
};

/// The app's styles of the labels.
#[derive(Clone, Copy)]
pub(super) struct Parts {
    pub(super) class: Prop<Option<SharedString>>,
    pub(super) style: Prop<TextPartStyle>,
    pub(super) value_class: Prop<Option<SharedString>>,
    pub(super) value_style: Prop<TextPartStyle>,
}

/// The value texts `label` gives the nodes of `rows` and their throughput
/// `raw`, once known: at once for a Rust function, in the next JS turn
/// for the app's.
pub(super) fn values(
    rows: impl Fn() -> Rows + 'static,
    raw: Memo<Shared<[f64]>>,
    label: impl Fn() -> Option<SankeyValueLabel> + 'static,
) -> Signal<Option<Shared<[SharedString]>>> {
    let out = signal(None::<Shared<[SharedString]>>);
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let (rows, raw, label) = (rows(), raw.get(), label());
        let run = generation.get() + 1;
        generation.replace(run);
        let value = |i: usize| raw.get(i).copied().unwrap_or(0.0);
        match label {
            None => out.set(None),
            Some(SankeyValueLabel::Rust(f)) => {
                out.set(Some((0..rows.len()).map(|i| f(i, value(i))).collect()))
            }
            Some(SankeyValueLabel::Js(f)) => {
                let answers: Vec<_> = (0..rows.len())
                    .filter_map(|i| {
                        rows.row(i)
                            .map(|row| f.call_async((row, value(i), i as u32)))
                    })
                    .collect();
                spawn(async move {
                    let mut texts = Vec::with_capacity(answers.len());
                    for answer in answers {
                        texts.push(answer.await.unwrap_or_default());
                    }
                    if generation.get() == run {
                        out.set(Some(texts.into()));
                    }
                });
            }
        }
    });
    out
}

/// A label per node of `graph`.
#[allow(clippy::too_many_arguments)]
pub(super) fn labels(
    plot: PlotContext,
    moves: Moves,
    count: Memo<usize>,
    names: Signal<Option<Shared<[SharedString]>>>,
    values: Signal<Option<Shared<[SharedString]>>>,
    has_value: impl Fn() -> bool + Copy + 'static,
    has_name: impl Fn() -> bool + Copy + 'static,
    parts: Parts,
) -> AnyElement {
    each(
        move || (0..count.get() as u32).collect::<Vec<_>>(),
        |i| *i,
        move |i, _| {
            let i = i.get_untracked() as usize;
            let text_of = move |texts: Signal<Option<Shared<[SharedString]>>>| {
                move || {
                    texts
                        .with(|t| t.as_ref().and_then(|t| t.get(i).cloned()))
                        .unwrap_or_default()
                }
            };
            label(plot, moves, i, parts, |content| {
                content
                    .child(when(has_value, move || {
                        text(text_of(values))
                            .flex_none()
                            .app_class(parts.value_class)
                            .inline_style(move || parts.value_style.get().0)
                    }))
                    .child(when(has_name, move || text(text_of(names)).flex_none()))
            })
        },
    )
}

/// Node `i`'s label: its place beside the node, and the box `lines` fills.
/// It rides its node through `motion.update` (from where it is drawn, on
/// the animator, with the node's move) and fades in with the plot's
/// appear. It takes no pointer.
fn label(
    plot: PlotContext,
    moves: Moves,
    i: usize,
    parts: Parts,
    lines: impl FnOnce(View) -> View,
) -> View {
    let place = computed(move || {
        let (pose, _) = moves.shown()?;
        let n = pose.node(i)?;
        let (x, y) = n.side.anchor(n.rect);
        Some((n.side, x, y))
    });
    // How far it is from its place while its node moves there: the
    // distance at the move's start, less as the move goes.
    let away = point(animated_value(0.0), animated_value(0.0));
    effect(move || {
        let (dx, dy) = moves
            .shown()
            .and_then(|(pose, from)| {
                let n = pose.node(i)?;
                let (from, _) = from?;
                let (x, y) = n.side.anchor(from.node_from(i, n.rect));
                let (to_x, to_y) = n.side.anchor(n.rect);
                Some((x - to_x, y - to_y))
            })
            .unwrap_or((0.0, 0.0));
        away.x.set(dx);
        away.y.set(dy);
    });
    let left = moves.progress().mul(-1.0).add(1.0);
    let offset = point(left.mul(&away.x), left.mul(&away.y));
    let height = signal(0.0_f32);
    let side = move || place.get().map_or(Side::After, |p| p.0);
    let content = view()
        .flex_none()
        .on_layout(move |b: &Bounds<Points>| {
            if height.get_untracked() != b.size.height.0 {
                height.set(b.size.height.0);
            }
        })
        .style_with(move |s| match side() {
            Side::Before => s.items_end(),
            Side::After => s.items_start(),
            Side::Above => s.items_center(),
        })
        .app_class(parts.class)
        .inline_style(move || parts.style.get().0);
    let content = lines(content);
    view()
        .absolute()
        .w(px(0.0))
        .h(px(0.0))
        .pointer_events(PointerEvents::None)
        .bind_translate_x(&offset.x)
        .bind_translate_y(&offset.y)
        .bind_opacity(&plot.appear.progress())
        .style_with(move |s| {
            let Some((side, x, y)) = place.get() else {
                return s;
            };
            // Beside a node, its middle on the node's, kept inside the
            // plot (`gpui-component` clamps the block into it).
            let y = match side {
                Side::Above => y,
                _ => {
                    let half = height.get() / 2.0;
                    y.min(plot.size.get().height.0 - half).max(half)
                }
            };
            let s = s.left(px(x)).top(px(y));
            // Always a row, so the content takes its own width (a column
            // of no width would narrow it to its narrowest, a character
            // a line where text breaks anywhere, as on the web).
            match side {
                Side::Before => s.flex_row().justify_end().items_center(),
                Side::After => s.flex_row().justify_start().items_center(),
                Side::Above => s.flex_row().justify_center().items_end(),
            }
        })
        .child(content)
}
