//! What the market's screens share (as the TSX gallery's
//! `demos/stocks/parts.tsx`): bars and dots that move natively, the market
//! button, a calm axis range, and the flat blocks a stock's screen is made
//! of.

use nsh_core::{
    Bounds, Points,
    animation::{Curve, EaseMode},
    element::AnyElement,
    prelude::*,
};

use super::live;
use crate::ui::{Finish, Finished, IconName, Tint, colors, icon, press, rect};

/// Grid lines of charts: the hairline color, a step darker on the light
/// page.
pub(crate) const GRID: AdaptiveColor = AdaptiveColor {
    light: colors::BORDER.light,
    dark: colors::LINE.dark,
};

/// The props of [`SpringBar`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct SpringBarProps {
    /// How much of the track it fills, 0..1.
    #[prop(default)]
    pub(crate) share: Prop<f32>,
    /// Its color.
    pub(crate) color: Tint,
    /// It grows from the right edge.
    #[prop(default)]
    pub(crate) from_right: bool,
    /// Its height.
    #[prop(default = 8.0)]
    pub(crate) height: f32,
    /// Its corners (half the height without one).
    pub(crate) radius: Option<f32>,
}

/// A bar that grows from one edge of its track to `share` (0..1) with a
/// native spring: the bar is the track's width and slides in, clipped.
#[component]
pub(crate) fn SpringBar(props: SpringBarProps) -> impl IntoElement {
    let x = animated_value(0.0);
    // The track's width as laid out (0 before), and whether the bar was
    // placed (the first place jumps, later ones spring).
    let width = stored(0.0_f32);
    let placed = stored(false);
    let from_right = props.from_right;
    let place = move |share: f32| {
        let width = width.get();
        if width <= 0.0 {
            return;
        }
        let share = share.clamp(0.0, 1.0);
        let to = if from_right { 1.0 } else { -1.0 } * (1.0 - share) * width;
        if placed.replace(true) {
            let _ = x.spring(
                to,
                Spring {
                    stiffness: 180.0,
                    damping: 22.0,
                    ..Spring::default()
                },
            );
        } else {
            x.set(to);
        }
    };
    effect(move || {
        let share = props.share.get();
        untracked(|| place(share));
    });
    let radius = props.radius.unwrap_or(props.height / 2.0);
    let color = AdaptiveColor::new(props.color.light, props.color.dark);
    view()
        .h(px(props.height))
        .overflow_hidden()
        .rounded(px(radius))
        .on_layout(move |frame: &Bounds<Points>| {
            if width.replace(frame.size.width.0) != frame.size.width.0 {
                place(props.share.get_untracked());
            }
        })
        .child(
            view()
                .absolute()
                .inset_0()
                .rounded(px(radius))
                .bg(color)
                .bind_translate_x(&x),
        )
}

/// The props of [`LiveDot`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct LiveDotProps {
    /// The market runs.
    #[prop(default)]
    pub(crate) running: Prop<bool>,
    /// The dot's size.
    #[prop(default = 8.0)]
    pub(crate) size: f32,
}

/// A value that pulses 0 → 1 over 1.4 s, looped (started by
/// [`run_pulse`]).
pub(crate) fn pulse() -> (AnimatedValue, Animation) {
    let v = animated_value(0.0);
    let looped = Animation::timing(
        &v,
        1.0,
        Timing::new(1400.0, Easing::Curve(Curve::Cubic, EaseMode::Out)),
    )
    .looped(None);
    (v, looped)
}

/// Runs a [`pulse`] while `running`; stopped, it fades back to 0.
pub(crate) fn run_pulse((v, looped): &(AnimatedValue, Animation), running: bool) {
    if running {
        let _ = looped.start();
    } else {
        looped.stop();
        let _ = v.timing(0.0, 200.0, Easing::EaseInOut);
    }
}

/// A dot with a ring that pulses natively while the market runs: 0 → 1
/// over 1.4 s, looped.
#[component]
pub(crate) fn LiveDot(props: LiveDotProps) -> impl IntoElement {
    let pulse = pulse();
    let p = pulse.0;
    effect(move || run_pulse(&pulse, props.running.get()));
    let size = props.size;
    view()
        .size(px(size * 2.5))
        .items_center()
        .justify_center()
        .child(
            view()
                .absolute()
                .size(px(size))
                .rounded(px(size / 2.0))
                .bg(colors::ACCENT)
                .bind_opacity(&p.interpolate(&[0.0, 1.0], &[0.55, 0.0]))
                .bind_scale(&p.interpolate(&[0.0, 1.0], &[1.0, 2.5])),
        )
        .child(view().size(px(size)).rounded(px(size / 2.0)).bg(move || {
            if props.running.get() {
                colors::ACCENT
            } else {
                colors::FAINT
            }
        }))
}

/// Pauses or resumes the market: a pill while it runs, citrus while it
/// is paused.
#[component]
pub(crate) fn MarketButton() -> impl IntoElement {
    let running = live().running;
    // In a view: the press takes the styles a parent gives the button.
    view().child(
        press()
            .hit_slop(6.0)
            .label(move || {
                Some(
                    if running.get() {
                        "Pause the market"
                    } else {
                        "Resume the market"
                    }
                    .into(),
                )
            })
            .on_press(move || running.update(|r| *r = !*r))
            .child(
                view()
                    .size(px(32.0))
                    .rounded(px(16.0))
                    .items_center()
                    .justify_center()
                    .style_when(running, |v| v.finish(Finish::Pill).border_1())
                    .style_when(move || !running.get(), |v| v.finish(Finish::Accent))
                    .child(
                        icon()
                            .name(move || {
                                if running.get() {
                                    IconName::Pause
                                } else {
                                    IconName::Play
                                }
                            })
                            .size(13.0)
                            .tint(move || {
                                if running.get() {
                                    colors::MUTED
                                } else {
                                    colors::ON_ACCENT
                                }
                            }),
                    ),
            ),
    )
}

/// An axis range that follows its data calmly: it widens at once (nothing
/// is clipped) and narrows by `rate` of the gap per fit, so a redraw never
/// jumps the scale. [`Calm::reset`] forgets it (another period, another
/// stock).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Calm {
    rate: f64,
    range: Option<(f64, f64)>,
}

impl Calm {
    pub(crate) fn new(rate: f64) -> Self {
        Self { rate, range: None }
    }

    pub(crate) fn fit(&mut self, l: f64, h: f64) -> (f64, f64) {
        let next = match self.range {
            None => (l, h),
            Some((lo, hi)) => (
                if l < lo { l } else { lo + (l - lo) * self.rate },
                if h > hi { h } else { hi + (h - hi) * self.rate },
            ),
        };
        self.range = Some(next);
        next
    }

    pub(crate) fn reset(&mut self) {
        self.range = None;
    }
}

/// Diagonal stripes over a rectangle (projections, zones).
#[allow(clippy::too_many_arguments)]
pub(crate) fn hatch(p: Painter, x: f32, y: f32, w: f32, h: f32, color: Hsla, gap: f32) -> Painter {
    if w <= 0.0 || h <= 0.0 {
        return p;
    }
    let mut p = p
        .save()
        .begin_path()
        .rect(rect(x, y, w, h))
        .clip()
        .stroke_color(color)
        .line_width(1.0)
        .begin_path();
    let mut i = -h;
    while i < w {
        p = p.move_to(x + i, y + h).line_to(x + i + h, y);
        i += gap;
    }
    p.stroke().restore()
}

/// A dashed horizontal line.
pub(crate) fn dashed(
    p: Painter,
    x0: f32,
    x1: f32,
    y: f32,
    color: Hsla,
    dash: &[Points],
) -> Painter {
    p.stroke_color(color)
        .line_width(1.0)
        .line_dash(dash)
        .begin_path()
        .move_to(x0, y)
        .line_to(x1, y)
        .stroke()
        .line_dash(&[])
}

/// A flat section of a screen: a title with a faint note (or a control) on
/// the right, the content below, a hairline above all but the first.
pub(crate) struct Block {
    title: Option<SharedString>,
    note: Option<SharedString>,
    right: Option<AnyElement>,
    first: bool,
    gap: f32,
    content: Vec<AnyElement>,
}

impl Block {
    pub(crate) fn new() -> Self {
        Self {
            title: None,
            note: None,
            right: None,
            first: false,
            gap: 10.0,
            content: Vec::new(),
        }
    }

    pub(crate) fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub(crate) fn note(mut self, note: impl Into<SharedString>) -> Self {
        self.note = Some(note.into());
        self
    }

    pub(crate) fn right(mut self, right: impl IntoElement) -> Self {
        self.right = Some(right.into_element());
        self
    }

    pub(crate) fn child(mut self, child: impl IntoElement) -> Self {
        self.content.push(child.into_element());
        self
    }
}

impl IntoElement for Block {
    fn into_element(self) -> AnyElement {
        let header = self.title.map(|title| {
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .min_h(px(22.0))
                .child(
                    text(title)
                        .flex_1()
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT),
                )
                .children(self.note.map(|note| {
                    text(note)
                        .text_size(px(12.0))
                        .text_color(colors::FAINT)
                        .tabular_nums()
                }))
                .children(self.right)
        });
        view()
            .px_4()
            .py(px(14.0))
            .gap(px(self.gap))
            .when(!self.first, |v| v.border_t_1().border_t_color(colors::LINE))
            .children(header)
            .children(self.content)
            .into_element()
    }
}

/// How wide a column is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Col {
    /// This wide.
    Fixed(f32),
    /// The rest of the row.
    Flex,
    /// As wide as its label.
    Auto,
}

/// A quiet header for columns ("PRICE", "SIZE"), on the right with
/// `right`.
pub(crate) fn head(label: &'static str, col: Col, right: bool) -> Text {
    text(label)
        .map(|t| match col {
            Col::Fixed(w) => t.w(px(w)),
            Col::Flex => t.flex_1(),
            Col::Auto => t,
        })
        .when(right, |t| t.text_right())
        .text_size(px(11.0))
        .text_color(colors::FAINT)
        .tabular_nums()
        .letter_spacing(px(0.6))
}
