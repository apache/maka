//! The order ticket (as the TSX gallery's `demos/stocks/Ticket.tsx`), the
//! content of a sheet: side, a limit price stepper, quantity chips and the
//! estimated cost; reviewing expands the ticket (a layout animation) and
//! placing reports [`TicketEvent::Placed`]. Nothing is sent anywhere.

use nsh_core::{
    LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition, element::PropEnum, prelude::*,
};

use super::market::{grouped, price};
use crate::ui::{
    Button, ButtonVariant, Finish, Finished, IconName, Segment, colors, icon, press, radius,
    segmented, tints,
};

/// Buying or selling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum Side {
    #[default]
    Buy,
    Sell,
}

impl Side {
    fn verb(self) -> &'static str {
        match self {
            Side::Buy => "Buy",
            Side::Sell => "Sell",
        }
    }
}

/// Simulated buying power.
const POWER: f64 = 250_000.0;
const QUANTITIES: [f64; 4] = [100.0, 500.0, 1000.0, 5000.0];

/// Reviewing and editing: the ticket's layout springs.
const EXPAND: LayoutAnimation = LayoutAnimation {
    create: Some(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 380.0)),
    update: Some(LayoutTransition {
        curve: LayoutCurve::Spring { damping: 0.86 },
        property: LayoutProperty::Opacity,
        duration_ms: 380.0,
        delay_ms: 0.0,
    }),
    delete: Some(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 380.0)),
};

/// The props of [`Ticket`].
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct TicketProps {
    pub(crate) code: SharedString,
    pub(crate) tick: f64,
    /// The last price, live.
    #[prop(default)]
    pub(crate) last: Prop<f64>,
    #[prop(default)]
    pub(crate) side: Prop<Side>,
}

/// What a [`Ticket`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum TicketEvent {
    /// The side was switched.
    Side(Side),
    /// The order was placed.
    Placed {
        title: SharedString,
        detail: SharedString,
        side: Side,
    },
}

/// A square 44 pt stepper button.
fn step(plus: bool, label: &'static str, on_press: impl Into<Listener<()>>) -> impl IntoElement {
    let on_press: Listener<()> = on_press.into();
    press().label(label).on_press(on_press).child(
        view()
            .size(px(44.0))
            .rounded(px(radius::CONTROL))
            .items_center()
            .justify_center()
            .finish(Finish::Pill)
            .border_1()
            .map(|v| {
                if plus {
                    v.child(icon().name(IconName::Plus).size(18.0).tint(colors::TEXT))
                } else {
                    v.child(
                        view()
                            .w(px(14.0))
                            .h(px(2.0))
                            .rounded(px(1.0))
                            .bg(colors::TEXT),
                    )
                }
            }),
    )
}

/// A line of the review: a label and a value.
fn line(label: &'static str, value: impl IntoReactive<SharedString>, strong: bool) -> View {
    view()
        .flex_row()
        .items_baseline()
        .min_h(px(24.0))
        .child(
            text(label)
                .flex_1()
                .text_size(px(14.0))
                .text_color(colors::MUTED),
        )
        .child(
            text(value)
                .text_size(px(if strong { 17.0 } else { 14.0 }))
                .font_weight(if strong {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::NORMAL
                })
                .text_color(colors::TEXT)
                .tabular_nums(),
        )
}

/// A caption row: a muted label, a value on the right.
fn caption(label: impl IntoReactive<SharedString>) -> View {
    view().flex_row().items_baseline().child(
        text(label)
            .flex_1()
            .text_size(px(14.0))
            .text_color(colors::MUTED),
    )
}

/// The ticket: made when its sheet opens, it starts from the last price,
/// not reviewing.
#[component]
pub(crate) fn Ticket(props: TicketProps, cx: Scope<TicketEvent>) -> impl IntoElement {
    let (code, tick) = (props.code, props.tick);
    let decimals = super::market::decimals(tick);
    let p = move |v: f64| price(v, decimals);
    let limit = signal(props.last.get_untracked());
    let quantity = signal(500.0_f64);
    let review = signal(false);
    let expand = move |open: bool| {
        animate_layout(EXPAND);
        review.set(open);
    };
    let cost = computed(move || limit.get() * quantity.get());
    let fee = computed(move || (cost.get() * 0.0003).max(1.0));
    let buy = computed(move || props.side.get() == Side::Buy);
    let tone = move || if buy.get() { colors::UP } else { colors::DOWN };
    let verb = move || props.side.get().verb();
    let nudge = move |steps: f64| {
        move |_: &()| limit.update(|l| *l = tick.max(((*l / tick).round() + steps) * tick))
    };
    let chips = QUANTITIES.map(|q| {
        let selected = computed(move || quantity.get() == q);
        view().flex_1().child(
            press()
                .label(format!("{q} shares"))
                .selected(selected)
                .on_press(move || quantity.set(q))
                .child(
                    view()
                        .h(px(44.0))
                        .rounded(px(radius::CONTROL))
                        .items_center()
                        .justify_center()
                        .bg(move || {
                            if selected.get() {
                                tints::ACCENT
                            } else {
                                colors::RAISED
                            }
                        })
                        .border_1()
                        .border_color(move || {
                            if selected.get() {
                                colors::ACCENT
                            } else {
                                colors::BORDER
                            }
                        })
                        .child(
                            text(if q >= 1000.0 {
                                format!("{}K", q / 1000.0)
                            } else {
                                format!("{q}")
                            })
                            .text_size(px(14.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .tabular_nums()
                            .text_color(move || {
                                if selected.get() {
                                    colors::ACCENT
                                } else {
                                    colors::TEXT
                                }
                            }),
                        ),
                ),
        )
    });
    let place = {
        let code = code.clone();
        move |_: &()| {
            let side = props.side.get_untracked();
            cx.emit(TicketEvent::Placed {
                title: format!("{} order placed", side.verb()).into(),
                detail: format!(
                    "{} {} at {} · simulated",
                    grouped(quantity.get_untracked(), 0),
                    code,
                    p(limit.get_untracked())
                )
                .into(),
                side,
            });
            expand(false);
        }
    };
    let reviewing = {
        let code = code.clone();
        move || {
            let (code, place) = (code.clone(), place.clone());
            view()
                .gap_3()
                .p(px(14.0))
                .rounded(px(radius::INSET))
                .border_curve(BorderCurve::Continuous)
                .border_1()
                .border_color(tone)
                .bg(move || if buy.get() { tints::UP } else { tints::DOWN })
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(
                            text(move || {
                                format!("{} {} {}", verb(), grouped(quantity.get(), 0), code)
                            })
                            .flex_1()
                            .text_size(px(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tone),
                        )
                        .child(
                            text("LIMIT · DAY")
                                .text_size(px(12.0))
                                .text_color(colors::MUTED)
                                .tabular_nums(),
                        ),
                )
                .child(
                    view()
                        .gap(px(2.0))
                        .child(line("Limit", move || p(limit.get()), false))
                        .child(line("Fees (est.)", move || grouped(fee.get(), 2), false))
                        .child(line(
                            "Total",
                            move || {
                                let (cost, fee) = (cost.get(), fee.get());
                                grouped(if buy.get() { cost + fee } else { cost - fee }, 2)
                            },
                            true,
                        )),
                )
                .child(
                    view()
                        .flex_row()
                        .gap(px(10.0))
                        .child(
                            Button::new("Edit", move |_: &()| expand(false))
                                .variant(ButtonVariant::Secondary)
                                .flex_1(),
                        )
                        .child(
                            Button::new(
                                move || format!("Place {} order", verb().to_lowercase()),
                                place,
                            )
                            .flex_1()
                            .flex_grow(2.0),
                        ),
                )
        }
    };
    view()
        .gap_4()
        .pt_1()
        .child(
            view()
                .flex_row()
                .items_baseline()
                .gap_2()
                .child(
                    text(move || format!("{} {code}", verb()))
                        .flex_1()
                        .text_size(px(20.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT),
                )
                .child(
                    text("simulated · nothing is sent")
                        .text_size(px(12.0))
                        .text_color(colors::FAINT)
                        .tabular_nums(),
                ),
        )
        .child(
            segmented()
                .options(vec![Segment::new("Buy"), Segment::new("Sell")])
                .selected(move || u32::from(!buy.get()))
                .on_change(move |i: &u32| {
                    cx.emit(TicketEvent::Side(if *i == 0 {
                        Side::Buy
                    } else {
                        Side::Sell
                    }));
                }),
        )
        .child(
            view()
                .gap_2()
                .child(
                    caption("Limit price").child(
                        text(move || format!("use last {}", p(props.last.get())))
                            .on_press(move || limit.set(props.last.get_untracked()))
                            .role(AccessibilityRole::Button)
                            .hit_slop(EdgeInsets::all(px(10.0)))
                            .text_size(px(13.0))
                            .text_color(colors::ACCENT)
                            .tabular_nums(),
                    ),
                )
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .child(step(false, "Lower the price", nudge(-1.0)))
                        .child(
                            view()
                                .flex_1()
                                .h(px(44.0))
                                .rounded(px(radius::CONTROL))
                                .items_center()
                                .justify_center()
                                .bg(colors::INSET)
                                .border_1()
                                .border_color(colors::BORDER)
                                .child(
                                    text(move || p(limit.get()))
                                        .text_size(px(20.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::TEXT)
                                        .tabular_nums(),
                                ),
                        )
                        .child(step(true, "Raise the price", nudge(1.0))),
                ),
        )
        .child(
            view()
                .gap_2()
                .child(
                    caption("Quantity").child(
                        text(move || format!("{} sh", grouped(quantity.get(), 0)))
                            .text_size(px(13.0))
                            .text_color(colors::FAINT)
                            .tabular_nums(),
                    ),
                )
                .child(view().flex_row().gap_2().children(chips)),
        )
        .child(
            view()
                .gap(px(6.0))
                .pt(px(2.0))
                .child(
                    caption(move || {
                        format!("Estimated {}", if buy.get() { "cost" } else { "proceeds" })
                    })
                    .child(
                        text(move || grouped(cost.get(), 2))
                            .text_size(px(22.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors::TEXT)
                            .tabular_nums(),
                    ),
                )
                .child(
                    view()
                        .h(px(6.0))
                        .rounded(px(3.0))
                        .bg(colors::RAISED)
                        .overflow_hidden()
                        .child(
                            view()
                                .w(move || relative((cost.get() / POWER).min(1.0) as f32))
                                .h(px(6.0))
                                .rounded(px(3.0))
                                .bg(move || {
                                    if cost.get() > POWER {
                                        colors::DANGER
                                    } else {
                                        tone()
                                    }
                                }),
                        ),
                )
                .child(
                    text(move || {
                        format!(
                            "{:.1}% of {} buying power",
                            cost.get() / POWER * 100.0,
                            grouped(POWER, 0)
                        )
                    })
                    .text_size(px(12.0))
                    .text_color(colors::FAINT)
                    .tabular_nums(),
                ),
        )
        // Reviewing expands the ticket (its layout springs).
        .child(when(review, reviewing).otherwise(move || {
            Button::new(
                move || format!("Review {}", verb().to_lowercase()),
                move |_: &()| expand(true),
            )
        }))
}
