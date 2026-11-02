//! `PlotLabel`: texts at values of a plot's scales (`gpui-base`'s
//! `PlotLabel`, `plot/label.rs`).

use nsh_core::{element::TextPartStyle, prelude::*};

use super::{PlotContext, layer};

/// Where a [`PlotText`] sits along the x axis from its point (`gpui-base`'s
/// `TextAlign`, as its `PlotLabel` paints a line): the text starts at the
/// point, centers on it or ends at it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PlotTextAlign {
    /// The text starts at the point.
    #[default]
    Left,
    /// The text is centered on the point.
    Center,
    /// The text ends at the point.
    Right,
}

/// A text a [`PlotLabel`] draws (`gpui-base`'s `Text`): what it reads, the
/// point its box's top edge is at, as values of the plot's scales, and how
/// it sits along x from that point. Its font, color and weight are the
/// label's classes (which its texts inherit) or its own `class` and
/// `style`, as `gpui-base`'s per-text `color`, `font_size` and
/// `font_weight`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct PlotText {
    /// What it reads.
    pub text: SharedString,
    /// Where it goes along the x axis: a value of the plot's x scale (a
    /// row's index on a `point` scale, the middle of a row's band on a
    /// `band` one).
    pub x: f64,
    /// Where its top edge goes along the y axis: a value of the plot's y
    /// scale.
    pub y: f64,
    /// How it sits along x from its point: `"left"` (the default) starts
    /// it there, `"center"` centers it on it, `"right"` ends it there.
    #[prop(default)]
    pub align: PlotTextAlign,
    /// Its Tailwind classes, over what it inherits from the label: its
    /// font and color, and its distance from the point (`pl-2`, or
    /// `-translate-y-full` to put it above the point).
    pub class: Option<SharedString>,
    /// Its style, over `class` (text styles too).
    #[prop(default)]
    pub style: TextPartStyle,
}

impl PlotText {
    /// A text reading `text`, its top left at `x` and `y` of the plot's
    /// scales (`gpui-base`'s `Text::new`).
    pub fn new(text: impl Into<SharedString>, x: f64, y: f64) -> Self {
        Self {
            text: text.into(),
            x,
            y,
            ..Self::default()
        }
    }

    /// How it sits along x from its point ([`PlotText::align`]).
    pub fn align(mut self, align: PlotTextAlign) -> Self {
        self.align = align;
        self
    }

    /// Its Tailwind classes ([`PlotText::class`]).
    pub fn class(mut self, class: impl Into<SharedString>) -> Self {
        self.class = Some(class.into());
        self
    }

    /// Its style ([`PlotText::style`]).
    pub fn style(mut self, style: impl Into<TextPartStyle>) -> Self {
        self.style = style.into();
        self
    }
}

/// The props of [`PlotLabel`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct PlotLabelProps {
    /// The texts it draws (`gpui-base`'s `PlotLabel(Vec<Text>)`), each at
    /// its own point: `{ text, x, y, align?, class?, style? }`.
    #[prop(default)]
    pub texts: Prop<Vec<PlotText>>,
}

/// Texts at points of a [`Plot`](super::Plot) (`gpui-base`'s
/// `PlotLabel`): each of its `texts` at its `x` and `y`, values of the
/// plot's scales (a row's index on a `point` or `band` scale, a value on a
/// `linear` one), its box's top edge on the point and its `align` placing
/// it along x, as `gpui-base` places a text at its origin. A text over a
/// peak, a tag at a line's last point, a caption at a grid line's end. The
/// layout places the texts, so they follow the plot's size; they glide
/// with the scales' domains (`motion.update`), fade in with the plot's
/// appear, and take no pointer. Their look is the app's: the label's
/// `class` gives them the text styles they inherit, each its own `class`
/// and `style`. Screen readers hear the plot, not its labels.
#[component]
pub fn PlotLabel(props: PlotLabelProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let label = layer().pointer_events(PointerEvents::None);
    let Some(plot) = PlotContext::of("PlotLabel") else {
        return label;
    };
    let texts = props.texts;
    // Where text `i`'s point is on the plot, and how it sits there.
    let place = move |i: usize| {
        let (x, y, align) = texts.with(|t| t.get(i).map(|t| (t.x, t.y, t.align)))?;
        let x = plot.x_map.get().tick(x).filter(|x| x.is_finite())?;
        let y = plot.y_map.get().tick(y).filter(|y| y.is_finite())?;
        Some((x, y, align))
    };
    let indices = move || (0..texts.with(|t| t.len())).collect::<Vec<usize>>();

    label.child(when(
        move || plot.is_sized(),
        move || {
            each(
                indices,
                |i| *i,
                move |i, _| {
                    let i = i.get_untracked();
                    // While a domain glides (`motion.update`), the text moves
                    // from where the layout puts it (its place on the new
                    // scales) to where the domains shown put it, as the axes'
                    // ticks do.
                    let (x, y) = (animated_value(0.0), animated_value(0.0));
                    effect(move || {
                        let along = (plot.x_tween.moving.get(), plot.y_tween.moving.get());
                        if let Some((at_x, at_y, _)) = place(i).filter(|_| along.0 || along.1) {
                            x.set(at_x);
                            y.set(at_y);
                        }
                    });
                    // As the bars' labels, it fades in with the plot's appear.
                    let shown = untracked(|| plot.appear.progress());
                    let read = move |f: fn(&PlotText) -> Option<SharedString>| {
                        texts.with(|t| t.get(i).and_then(f))
                    };
                    // A point with no size whose text does not shrink: the
                    // text keeps its own size and overflows the point on the
                    // side its alignment gives it.
                    view()
                        .absolute()
                        .w(px(0.0))
                        .h(px(0.0))
                        .flex_row()
                        .items_start()
                        .pointer_events(PointerEvents::None)
                        .bind_translate_x(&plot.x_tween.moved(&x))
                        .bind_translate_y(&plot.y_tween.moved(&y))
                        .bind_opacity(&shown)
                        .style_with(move |s| {
                            let Some((x, y, align)) = place(i) else {
                                return s.hidden();
                            };
                            let s = s.left(px(x)).top(px(y));
                            match align {
                                PlotTextAlign::Left => s.justify_start(),
                                PlotTextAlign::Center => s.justify_center(),
                                PlotTextAlign::Right => s.justify_end(),
                            }
                        })
                        .child(
                            text(move || read(|t| Some(t.text.clone())).unwrap_or_default())
                                .flex_none()
                                .app_class(move || read(|t| t.class.clone()))
                                .inline_style(move || {
                                    texts
                                        .with(|t| t.get(i).map(|t| t.style.0.clone()))
                                        .unwrap_or_default()
                                }),
                        )
                },
            )
        },
    ))
}
