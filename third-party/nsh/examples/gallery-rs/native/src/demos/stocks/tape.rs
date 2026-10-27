//! The tape and the trade flow (as the TSX gallery's
//! `demos/stocks/Tape.tsx`).

use std::f32::consts::TAU;

use nsh_core::{
    Bounds, Points,
    animation::{Curve, EaseMode},
    canvas::{CanvasTextAlign, CanvasTextBaseline},
    prelude::*,
};

use super::{
    Live,
    detail::StockProps,
    figure, live,
    market::{self, BLOCK, BUCKETS, TAPE, TAPE_HELD, Trade, compact, price, time},
    parts::{Block, Col, GRID, head, spring_bar},
};
use crate::ui::{colors, legend, rect, tints};

/// Rows shown.
const SHOWN: usize = 8;
const ROW: f32 = 28.0;

/// The newest trades (`shown`), drawn `width` wide with prices of
/// `decimals`, slid down by `offset`.
fn draw_tape(shown: &[Trade], width: f32, decimals: u32, offset: &AnimatedValue) -> Painter {
    let height = SHOWN as f32 * ROW;
    let mut p = Painter::new()
        .save()
        .begin_path()
        .rect(rect(0.0, 0.0, width, height))
        .clip()
        .translate(0.0, offset)
        .text_baseline(CanvasTextBaseline::Middle);
    for (i, t) in shown.iter().enumerate() {
        let top = i as f32 * ROW;
        let y = top + ROW / 2.0;
        let block = t.size >= BLOCK;
        let side = if t.side > 0.0 {
            colors::UP
        } else {
            colors::DOWN
        };
        if block {
            p = p
                .fill_color(color(tints::ACCENT))
                .begin_path()
                .round_rect(rect(0.0, top + 2.0, width, ROW - 4.0), px(8.0))
                .fill();
        } else if i > 0 {
            p = p
                .stroke_color(color(GRID))
                .line_width(1.0)
                .begin_path()
                .move_to(0.0, top)
                .line_to(width, top)
                .stroke();
        }
        p = p
            .font("12px system-ui")
            .text_align(CanvasTextAlign::Left)
            .fill_color(color(colors::FAINT))
            .fill_text(&time(t.t, true), 8.0, y)
            .fill_color(color(side))
            .begin_path()
            .arc(84.0, y, 3.0, 0.0, TAU)
            .fill()
            .font("14px system-ui")
            .fill_text(&price(t.price, decimals), 96.0, y)
            .text_align(CanvasTextAlign::Right)
            .font(if block {
                "600 14px system-ui"
            } else {
                "14px system-ui"
            })
            .fill_color(color(if block { colors::ACCENT } else { colors::TEXT }))
            .fill_text(&compact(t.size), width - 8.0, y);
        if block {
            p = p
                .font("600 10px system-ui")
                .fill_text("BLOCK", width - 70.0, y);
        }
    }
    p.restore()
}

/// The tape: the newest trades on top, blocks highlighted. It is one
/// canvas drawn again four times a second (its section's totals change
/// every tick, outside it); the new rows slide in by a native offset (the
/// canvas draws itself again as the value moves).
#[component]
pub(crate) fn Tape(props: StockProps) -> impl IntoElement {
    let live = live();
    let decimals = live.market.borrow().stocks[props.stock as usize].decimals();
    let (quarter, market) = (live.quarter, live.market);
    // The newest trades as of the last quarter second.
    let shown = computed(move || {
        quarter.get();
        market.borrow().tape.clone()
    });
    let offset = animated_value(0.0);
    {
        // The newest trade shown so far (-1: none yet).
        let top = stored(-1_i64);
        effect(move || {
            // What came in since the last drawing, and the slide that shows
            // it.
            let Some(first) = shown.with(|s| s.first().map(|t| t.id as i64)) else {
                return;
            };
            let last = top.replace(first);
            let fresh = if last < 0 { 0 } else { first - last };
            // Ids are consecutive: past the trades kept, nothing old is
            // left.
            let k = if fresh >= TAPE as i64 {
                TAPE_HELD as i64
            } else {
                fresh.min(4)
            };
            if k > 0 {
                offset.set(-(k as f32) * ROW);
                let _ = offset.timing(0.0, 220.0, Easing::Curve(Curve::Cubic, EaseMode::Out));
            }
        });
    }
    let width = signal(0.0_f32);
    view().child(
        canvas(move || {
            let width = width.get();
            shown.with(|s| draw_tape(s, width, decimals, &offset))
        })
        .h(px(SHOWN as f32 * ROW))
        .label("Recent trades")
        .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0)),
    )
}

/// The tape's section of stock `index`: its totals (every tick), the
/// columns and the [`Tape`] (four times a second).
pub(crate) fn tape_block(live: &Live, index: usize) -> Block {
    let quote = live.quotes[index];
    let market = live.market.clone();
    // Bought at the ask, sold at the bid, and the blocks, over the trades
    // kept.
    let totals = computed(move || {
        quote.get();
        market
            .borrow()
            .trades
            .iter()
            .fold((0.0, 0.0, 0_u32), |(b, s, k), t| {
                let block = u32::from(t.size >= BLOCK);
                if t.side > 0.0 {
                    (b + t.size, s, k + block)
                } else {
                    (b, s + t.size, k + block)
                }
            })
    });
    Block::new()
        .title("Time & sales")
        .note(format!("blocks ≥ {}", compact(BLOCK)))
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .gap_x(px(16.0))
                .gap_y(px(6.0))
                .child(legend(
                    colors::UP,
                    "At ask",
                    Some(move || compact(totals.get().0)),
                ))
                .child(legend(
                    colors::DOWN,
                    "At bid",
                    Some(move || compact(totals.get().1)),
                ))
                .child(legend(
                    colors::ACCENT,
                    "Blocks",
                    Some(move || totals.get().2.to_string()),
                )),
        )
        .child(
            view()
                .flex_row()
                .gap(px(10.0))
                .px_2()
                .child(head("TIME", Col::Fixed(80.0), false))
                .child(head("PRICE", Col::Flex, false))
                .child(head("SIZE", Col::Auto, true)),
        )
        .child(tape().stock(index as u32))
}

/// One bucket of `flow` (of its `max`): sold to the left of the middle,
/// bought to the right.
fn flow_row(
    label: &'static str,
    note: &'static str,
    bucket: usize,
    flow: Memo<market::Flow>,
    max: Memo<f64>,
) -> impl IntoElement {
    let buy = move || flow.with(|f| f.buy[bucket]);
    let sell = move || flow.with(|f| f.sell[bucket]);
    view()
        .gap_1()
        .child(
            view()
                .flex_row()
                .items_baseline()
                .gap_2()
                .child(
                    text(label)
                        .flex_1()
                        .text_size(px(13.0))
                        .text_color(colors::TEXT)
                        .child(
                            text(format!(" {note}"))
                                .text_size(px(12.0))
                                .text_color(colors::FAINT)
                                .tabular_nums(),
                        ),
                )
                .child(figure(move || compact(sell()), colors::DOWN))
                .child(figure("/", colors::FAINT))
                .child(figure(move || compact(buy()), colors::UP)),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .child(
                    view().flex_1().child(
                        spring_bar()
                            .share(move || (sell() / max.get()) as f32)
                            .color(colors::DOWN)
                            .from_right(true)
                            .height(10.0)
                            .radius(3.0),
                    ),
                )
                .child(
                    view()
                        .w(px(2.0))
                        .h(px(18.0))
                        .mx(px(2.0))
                        .rounded(px(1.0))
                        .bg(colors::BORDER),
                )
                .child(
                    view().flex_1().child(
                        spring_bar()
                            .share(move || (buy() / max.get()) as f32)
                            .color(colors::UP)
                            .height(10.0)
                            .radius(3.0),
                    ),
                ),
        )
}

/// Bought vs sold volume by order size: who is moving the price; once a
/// second.
#[component]
pub(crate) fn Flow() -> impl IntoElement {
    let live = live();
    let (second, market) = (live.second, live.market);
    // The trade flow as of the last second.
    let flow = computed(move || {
        second.get();
        market.borrow().flow.clone()
    });
    let max = computed(move || {
        flow.with(|f| f.buy.iter().chain(&f.sell).fold(1.0_f64, |m, &v| m.max(v)))
    });
    let net =
        computed(move || flow.with(|f| f.buy.iter().sum::<f64>() - f.sell.iter().sum::<f64>()));
    // Large and block orders, bought less sold.
    let big = computed(move || flow.with(|f| f.buy[2] + f.buy[3] - f.sell[2] - f.sell[3]));
    let sign = |v: f64| if v >= 0.0 { "+" } else { "" };
    Block::new()
        .title("Trade flow")
        .note("sold ← · → bought")
        .child(
            text(move || format!("{}{}", sign(net.get()), compact(net.get())))
                .text_size(px(22.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(colors::TEXT)
                .tabular_nums()
                .child(
                    text(move || {
                        let big = big.get();
                        format!(" net · {}{} large orders", sign(big), compact(big))
                    })
                    .text_size(px(13.0))
                    .font_weight(FontWeight::NORMAL)
                    .tabular_nums()
                    .text_color(move || {
                        if big.get() >= 0.0 {
                            colors::UP
                        } else {
                            colors::DOWN
                        }
                    }),
                ),
        )
        .child(
            view().gap(px(10.0)).children(
                BUCKETS
                    .iter()
                    .enumerate()
                    .map(|(i, b)| flow_row(b.label, b.note, i, flow, max)),
            ),
        )
}
