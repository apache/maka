//! The order book and the depth chart (as the TSX gallery's
//! `demos/stocks/Book.tsx`).

use nsh_core::{
    Bounds, LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition, Points,
    canvas::{CanvasTextAlign, CanvasTextBaseline},
    prelude::*,
};

use super::{
    detail::StockProps,
    figure, live,
    market::{Book, LEVELS, Level, compact, price, tone_of},
    parts::{Block, Calm, Col, GRID, hatch, head, spring_bar},
};
use crate::ui::{colors, legend, lengths, press, radius};

const ROW: f32 = 26.0;
/// Ticks either side of the mid price the depth chart spans.
const SPAN: f64 = LEVELS as f64 + 2.0;

/// Sizes summed outward from the best price.
fn cumulative(levels: &[Level]) -> Vec<f64> {
    let mut sum = 0.0;
    levels
        .iter()
        .map(|l| {
            sum += l.size;
            sum
        })
        .collect()
}

/// What the book's rows show: the levels shown on each side, the book,
/// its running totals (bids, asks), the bars' scale, and the stock's
/// previous close and decimals.
#[derive(Clone, Copy)]
struct Ladder {
    depth: Signal<usize>,
    book: Memo<Book>,
    sums: Memo<(Vec<f64>, Vec<f64>)>,
    max: Memo<f64>,
    prev_close: f64,
    decimals: u32,
}

/// One level on a side: its label, price, size and running total, over a
/// bar of the running total from the right edge (a depth ladder). A row is
/// kept by its place on its side (`slot`), as the TSX demo's `Each` over
/// the places: more levels add rows at the inside of each side, and the
/// level a place shows follows the depth.
fn level_row(bid: bool, slot: usize, ladder: Ladder) -> impl IntoElement {
    let Ladder {
        depth,
        book,
        sums,
        max,
        prev_close,
        decimals,
    } = ladder;
    let tint = if bid { colors::UP } else { colors::DOWN }.opacity(0.1);
    // The level shown (0 the best) and its number.
    let k = move || {
        if bid {
            slot
        } else {
            depth.get().saturating_sub(slot + 1)
        }
    };
    let n = move || if bid { slot + 1 } else { depth.get() - slot };
    let level = move || book.with(|b| if bid { &b.bids } else { &b.asks }.get(k()).copied());
    let total = move || {
        sums.with(|(bids, asks)| {
            if bid { bids } else { asks }
                .get(k())
                .copied()
                .unwrap_or(0.0)
        })
    };
    view()
        .h(px(ROW))
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .child(
            view()
                .absolute()
                .right_0()
                .top(px(1.0))
                .bottom(px(1.0))
                .w(move || relative((total() / max.get()).min(1.0) as f32))
                .bg(tint),
        )
        .child(
            text(move || format!("{}{}", if bid { "B" } else { "A" }, n()))
                .w(px(28.0))
                .text_size(px(12.0))
                .text_color(colors::FAINT)
                .tabular_nums(),
        )
        .child(
            text(move || level().map_or("–".into(), |l| price(l.price, decimals)))
                .flex_1()
                .text_size(px(14.0))
                .text_color(move || tone_of(level().map_or(0.0, |l| l.price) - prev_close))
                .tabular_nums(),
        )
        .child(
            text(move || level().map_or(String::new(), |l| compact(l.size)))
                .w(px(64.0))
                .text_right()
                .text_size(px(14.0))
                .text_color(colors::TEXT)
                .tabular_nums(),
        )
        .child(
            text(move || compact(total()))
                .w(px(64.0))
                .pr(px(6.0))
                .text_right()
                .text_size(px(12.0))
                .text_color(colors::FAINT)
                .tabular_nums(),
        )
}

/// Showing five levels or ten: the change springs the layout.
const RELEVEL: LayoutAnimation = LayoutAnimation {
    create: Some(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 360.0)),
    update: Some(LayoutTransition {
        curve: LayoutCurve::Spring { damping: 0.85 },
        property: LayoutProperty::Opacity,
        duration_ms: 360.0,
        delay_ms: 0.0,
    }),
    delete: Some(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 360.0)),
};

/// Asks above bids, five levels or ten (the change animates the layout),
/// the bid / ask balance springing natively on top. The book moves every
/// tick (with the stock's quote).
#[component]
pub(crate) fn OrderBook(props: StockProps) -> impl IntoElement {
    let live = live();
    let index = props.stock as usize;
    let quote = live.quotes[index];
    let decimals = live.market.borrow().stocks[index].decimals();
    let prev_close = quote.get_untracked().prev_close;
    // Levels shown on each side.
    let depth = signal(5_usize);
    let book = {
        let market = live.market.clone();
        computed(move || {
            quote.get();
            market.borrow().book.clone()
        })
    };
    let sums = computed(move || book.with(|b| (cumulative(&b.bids), cumulative(&b.asks))));
    // The totals at the depth shown, bids and asks.
    let totals = computed(move || {
        let n = depth.get() - 1;
        sums.with(|(bids, asks)| {
            let at = |sums: &Vec<f64>| sums.get(n).copied().unwrap_or(0.0);
            (at(bids), at(asks))
        })
    });
    // The bars' scale: the deeper side's total, eased (it changes every
    // tick).
    let scale = stored(Calm::new(0.05));
    let max = computed(move || {
        let (bids, asks) = totals.get();
        scale.with(|s| s.fit(0.0, bids.max(asks).max(1.0)).1)
    });
    let share = computed(move || {
        let (bids, asks) = totals.get();
        if bids + asks > 0.0 {
            bids / (bids + asks)
        } else {
            0.5
        }
    });
    let spread = computed(move || {
        book.with(|b| match (b.asks.first(), b.bids.first()) {
            (Some(a), Some(b)) => a.price - b.price,
            _ => 0.0,
        })
    });
    let toggle = move |_: &()| {
        animate_layout(RELEVEL);
        depth.update(|d| *d = if *d == 5 { LEVELS } else { 5 });
    };
    let five = move || depth.get() == 5;
    let ladder = Ladder {
        depth,
        book,
        sums,
        max,
        prev_close,
        decimals,
    };
    let side = move |bid: bool| {
        each(
            move || (0..depth.get()).collect::<Vec<usize>>(),
            |slot: &usize| *slot,
            move |slot, _| level_row(bid, slot.get_untracked(), ladder),
        )
    };
    Block::new()
        .title("Order book")
        .right(
            press()
                .hit_slop(8.0)
                .label(move || {
                    Some(
                        if five() {
                            "Show ten levels"
                        } else {
                            "Show five levels"
                        }
                        .into(),
                    )
                })
                .on_press(toggle)
                .child(
                    view()
                        .h(px(30.0))
                        .px_3()
                        .rounded(px(radius::CONTROL))
                        .justify_center()
                        .bg(colors::RAISED)
                        .child(
                            text(move || if five() { "5 → 10" } else { "10 → 5" })
                                .text_size(px(12.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT)
                                .tabular_nums(),
                        ),
                ),
        )
        .child(
            view()
                .gap(px(5.0))
                .child(
                    view()
                        .h(px(6.0))
                        .rounded(px(3.0))
                        .overflow_hidden()
                        .bg(colors::DOWN)
                        .child(
                            spring_bar()
                                .share(move || share.get() as f32)
                                .color(colors::UP)
                                .height(6.0)
                                .radius(0.0),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .child(
                            figure(
                                move || format!("BID {:.0}%", share.get() * 100.0),
                                colors::UP,
                            )
                            .flex_1(),
                        )
                        .child(figure(
                            move || format!("spread {}", price(spread.get(), decimals)),
                            colors::FAINT,
                        ))
                        .child(
                            figure(
                                move || format!("{:.0}% ASK", (1.0 - share.get()) * 100.0),
                                colors::DOWN,
                            )
                            .flex_1()
                            .text_right(),
                        ),
                ),
        )
        .child(
            view()
                .child(
                    view()
                        .flex_row()
                        .gap(px(10.0))
                        .pb_1()
                        .child(head("LVL", Col::Fixed(28.0), false))
                        .child(head("PRICE", Col::Flex, false))
                        .child(head("SIZE", Col::Fixed(64.0), true))
                        .child(head("TOTAL", Col::Fixed(64.0), true)),
                )
                .child(side(false))
                .child(view().h(px(1.0)).my(px(3.0)).bg(colors::BORDER))
                .child(side(true)),
        )
}

/// Ticks either side of the mid price the depth chart spans, drawn
/// `width` wide with sizes up to `ymax`.
fn draw_depth(book: &Book, width: f32, ymax: f64, tick: f64, decimals: u32) -> Painter {
    let height = 120.0;
    let (Some(best_bid), Some(best_ask)) = (book.bids.first(), book.asks.first()) else {
        return Painter::new();
    };
    if width <= 0.0 {
        return Painter::new();
    }
    let c = |tint: AdaptiveColor| color(tint);
    let (bids, asks) = (cumulative(&book.bids), cumulative(&book.asks));
    let mid = (best_bid.price + best_ask.price) / 2.0;
    let (lo, hi) = (mid - SPAN * tick, mid + SPAN * tick);
    let (pad_top, pad_bottom) = (4.0, 18.0);
    let h = height - pad_top - pad_bottom;
    let x_of = |p: f64| ((p - lo) / (hi - lo)) as f32 * width;
    let y_of = |v: f64| pad_top + h - (v / ymax) as f32 * h;
    let mut p = Painter::new().stroke_color(c(GRID)).line_width(1.0);
    for k in 1..=3 {
        let y = pad_top + h * k as f32 / 4.0;
        p = p.begin_path().move_to(0.0, y).line_to(width, y).stroke();
    }
    let (bx, ax) = (x_of(best_bid.price), x_of(best_ask.price));
    p = hatch(p, bx, pad_top, ax - bx, h, c(colors::BORDER), 4.0);
    // A side: a step line out from the best price, filled below.
    let side = |p: Painter, levels: &[Level], sums: &[f64], tint: AdaptiveColor, left: bool| {
        let mut y = y_of(sums[0]);
        let mut p = p
            .begin_path()
            .move_to(x_of(levels[0].price), pad_top + h)
            .line_to(x_of(levels[0].price), y);
        for i in 1..levels.len() {
            p = p.line_to(x_of(levels[i].price), y);
            y = y_of(sums[i]);
            p = p.line_to(x_of(levels[i].price), y);
        }
        let edge = if left { 0.0 } else { width };
        p.line_to(edge, y)
            .line_to(edge, pad_top + h)
            .close_path()
            .fill_color(c(tint.opacity(0.16)))
            .fill()
            .stroke_color(c(tint))
            .line_width(1.5)
            .stroke()
    };
    p = side(p, &book.bids, &bids, colors::UP, true);
    p = side(p, &book.asks, &asks, colors::DOWN, false);
    let label_y = pad_top + h + 5.0;
    p.stroke_color(c(colors::MUTED))
        .line_dash(&lengths([2.0, 3.0]))
        .begin_path()
        .move_to(x_of(mid), pad_top)
        .line_to(x_of(mid), pad_top + h)
        .stroke()
        .line_dash(&[])
        .font("11px system-ui")
        .fill_color(c(colors::FAINT))
        .text_baseline(CanvasTextBaseline::Top)
        .text_align(CanvasTextAlign::Left)
        .fill_text(&price(lo, decimals), 0.0, label_y)
        .text_align(CanvasTextAlign::Right)
        .fill_text(&price(hi, decimals), width, label_y)
        .text_align(CanvasTextAlign::Center)
        .fill_color(c(colors::TEXT))
        .fill_text(
            &format!("mid {}", price(mid, decimals)),
            width / 2.0,
            label_y,
        )
}

/// Cumulative depth: bids stepping down to the left, asks to the right,
/// the spread hatched and the mid price dashed. It is calm on purpose: it
/// redraws four times a second (the book as of the last quarter second),
/// the price axis is a fixed span around the mid, and the size axis widens
/// at once but narrows over about a second.
#[component]
pub(crate) fn Depth(props: StockProps) -> impl IntoElement {
    let live = live();
    let (tick, decimals) = {
        let market = live.market.borrow();
        let stock = &market.stocks[props.stock as usize];
        (stock.tick, stock.decimals())
    };
    let (quarter, market) = (live.quarter, live.market);
    let book = computed(move || {
        quarter.get();
        market.borrow().depth.clone()
    });
    let total = |levels: &[Level]| levels.iter().map(|l| l.size).sum::<f64>();
    let totals = computed(move || book.with(|b| (total(&b.bids), total(&b.asks))));
    let top = stored(Calm::new(0.25));
    let ymax = computed(move || {
        let (bids, asks) = totals.get();
        top.with(|t| t.fit(0.0, bids.max(asks) * 1.1).1)
    });
    let width = signal(0.0_f32);
    Block::new()
        .title("Depth")
        .note(format!("±{SPAN} ticks · cumulative"))
        .child(
            canvas(move || {
                let (width, ymax) = (width.get(), ymax.get());
                book.with(|b| draw_depth(b, width, ymax, tick, decimals))
            })
            .h(px(120.0))
            .label("Depth chart")
            .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0)),
        )
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .gap_x(px(16.0))
                .gap_y(px(6.0))
                .child(legend(
                    colors::UP,
                    "Bids",
                    Some(move || compact(totals.get().0)),
                ))
                .child(legend(
                    colors::DOWN,
                    "Asks",
                    Some(move || compact(totals.get().1)),
                ))
                .child(legend(
                    colors::BORDER,
                    "Imbalance",
                    Some(move || {
                        let (bids, asks) = totals.get();
                        let imbalance = if bids + asks > 0.0 {
                            (bids - asks) / (bids + asks)
                        } else {
                            0.0
                        };
                        format!(
                            "{}{:.0}%",
                            if imbalance >= 0.0 { "+" } else { "" },
                            imbalance * 100.0
                        )
                    }),
                )),
        )
}
