//! A stock (as the TSX gallery's `demos/stocks/Detail.tsx`): quote and
//! chart on the first screen, then the book, the tape, depth, the flow and
//! the ranges, all live. Buy / Sell at the bottom open the order ticket in
//! a sheet. Pushed on phones; beside the watchlist in the desktop layout.

use std::f32::consts::TAU;

use nsh_base::dialog;
use nsh_core::{
    Bounds, ModalPresentation, Points,
    animation::{Curve, EaseMode},
    canvas::{CanvasTextAlign, CanvasTextBaseline, LineCap},
    prelude::*,
};

use super::{
    book::{depth, order_book},
    chart::chart,
    live,
    market::{HORIZONS, Quote, Range, compact, price, signed, time, tone_of},
    parts::{Block, live_dot},
    tape::{flow, tape_block},
    ticket::{Side, TicketEvent},
};
use crate::ui::{
    Button, ButtonVariant, Finish, Finished, IconName, Stat, colors, icon, lengths, radius, sheet,
};

/// The props of a part of a stock's screen.
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct StockProps {
    /// The stock's index in the market.
    pub(crate) stock: u32,
}

/// The props of [`StockView`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct StockViewProps {
    /// The stock's index in the market.
    pub(crate) stock: u32,
    /// The desktop layout: beside the watchlist, whose strip has the pause
    /// button.
    #[prop(default)]
    pub(crate) wide: bool,
    /// Wide, with the room for the book, the tape, depth and flow in a
    /// column of their own.
    #[prop(default)]
    pub(crate) split: Prop<bool>,
}

/// A stock: it focuses the stock while it is shown. `wide` heads it with
/// the code, draws the chart taller and, while `split` holds, puts the
/// book, the tape, depth and flow in a column right of the quote, chart and
/// ranges; the ticket is then a card in the window instead of a sheet.
#[component]
pub(crate) fn StockView(props: StockViewProps, cx: Scope<NoEvent>) -> impl IntoElement {
    let live = live();
    let index = props.stock as usize;
    let (wide, split) = (props.wide, props.split);
    let stock = props.stock;
    // The market keeps the stock's book, tape and flow while it is shown.
    live.market.borrow_mut().focus(Some(index));
    {
        let market = live.market.clone();
        // Another stock may be focused already (the desktop layout shows
        // the next one as this one goes): only this one's focus ends.
        cleanup(move || {
            let mut market = market.borrow_mut();
            if market.focused == Some(index) {
                market.focus(None);
            }
        });
    }
    let quote = live.quotes[index];
    let (code, tick, decimals) = {
        let market = live.market.borrow();
        let stock = &market.stocks[index];
        (stock.code, stock.tick, stock.decimals())
    };
    let side = signal(Side::default());
    let ticket = signal(false);
    // The confirmation: what it says, and its motion (0 hidden, 1 shown).
    let message = signal((SharedString::default(), SharedString::default(), Side::Buy));
    let banner = animated_value(0.0);
    let banner_run = stored(None::<Animation>);
    // The confirmation drops in from the top and leaves by itself.
    let show_banner = move |title: SharedString, detail: SharedString, side: Side| {
        message.set((title, detail, side));
        let run = Animation::sequence([
            Animation::spring(
                &banner,
                1.0,
                Spring {
                    stiffness: 260.0,
                    damping: 22.0,
                    ..Spring::default()
                },
            ),
            Animation::delay(2200.0),
            Animation::timing(
                &banner,
                0.0,
                Timing::new(260.0, Easing::Curve(Curve::Cubic, EaseMode::In)),
            ),
        ]);
        let _ = run.start();
        banner_run.replace(Some(run));
    };
    let trade = move |chosen: Side| {
        move |_: &()| {
            side.set(chosen);
            ticket.set(true);
        }
    };
    let bottom = move || cx.insets().bottom.0;
    let (second, market) = (live.second, live.market.clone());
    let footer = text(move || {
        second.get();
        let stats = market.borrow().stats;
        format!(
            "simulated · {:.2} ms Rust/tick · {} quotes/s",
            stats.ms, stats.updates
        )
    })
    .px_4()
    .pt_2()
    .pb(move || px(96.0 + bottom()))
    .text_size(px(12.0))
    .text_color(colors::FAINT)
    .tabular_nums();
    let chart_block = move |height: f32| Block::new().child(chart().stock(stock).height(height));
    let content = if wide {
        scroll()
            .flex_1()
            .child(
                text(code)
                    .px_4()
                    .pt(px(14.0))
                    .text_size(px(22.0))
                    .font_weight(FontWeight::BOLD)
                    .letter_spacing(px(-0.3))
                    .text_color(colors::TEXT),
            )
            .child(
                view()
                    .style_when(split, |s| s.flex_row().items_start())
                    .child(
                        view()
                            .min_w(px(0.0))
                            .style_when(split, |s| s.flex_1())
                            .child(quote_section().stock(stock))
                            .child(chart_block(340.0))
                            .child(ranges().stock(stock)),
                    )
                    .child(
                        view()
                            .border_l_color(colors::LINE)
                            .style_when(split, |s| s.w(px(380.0)).border_l_1())
                            .child(order_book().stock(stock))
                            .child(tape_block(&live, index))
                            .child(depth().stock(stock))
                            .child(flow()),
                    ),
            )
            .child(footer)
    } else {
        scroll()
            .flex_1()
            .child(quote_section().stock(stock))
            .child(Block::new().child(chart().stock(stock)))
            .child(order_book().stock(stock))
            .child(tape_block(&live, index))
            .child(depth().stock(stock))
            .child(flow())
            .child(ranges().stock(stock))
            .child(footer)
    };
    let change = computed(move || quote.get().percent());
    // The trade bar, over the content.
    let bar = view()
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .px_4()
        .pt(px(10.0))
        .pb(move || px(10.0 + bottom()))
        // Glass: the page shows through, blurred, as it scrolls under.
        .finish(Finish::Glass)
        .border_t_1()
        .when_some(Finish::Glass.border_color(), |v, c| v.border_t_color(c))
        .child(
            view()
                .w(px(92.0))
                .gap(px(1.0))
                .child(
                    text(move || price(quote.get().last, decimals))
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT)
                        .tabular_nums(),
                )
                .child(
                    text(move || format!("{}%", signed(change.get(), 2)))
                        .text_size(px(12.0))
                        .tabular_nums()
                        .text_color(move || tone_of(change.get())),
                ),
        )
        .child(
            Button::new("Sell", trade(Side::Sell))
                .variant(ButtonVariant::Secondary)
                .flex_1(),
        )
        .child(Button::new("Buy", trade(Side::Buy)).flex_1());
    let banner = view()
        .pointer_events(PointerEvents::None)
        .absolute()
        .top(px(10.0))
        .left_4()
        .right_4()
        .flex_row()
        .items_center()
        .gap_3()
        .p(px(14.0))
        .rounded(px(radius::INSET + 3.0))
        .border_curve(BorderCurve::Continuous)
        .bg(colors::LIGHT)
        .bind_opacity(&banner.interpolate(&[0.0, 0.3, 1.0], &[0.0, 1.0, 1.0]))
        .bind_translate_y(&banner.interpolate(&[0.0, 1.0], &[-90.0, 0.0]))
        .bind_scale(&banner.interpolate(&[0.0, 1.0], &[0.92, 1.0]))
        .child(
            view()
                .size(px(34.0))
                .rounded(px(17.0))
                .items_center()
                .justify_center()
                .bg(move || {
                    if message.with(|m| m.2) == Side::Buy {
                        colors::UP
                    } else {
                        colors::DOWN
                    }
                })
                .child(
                    icon()
                        .name(IconName::Check)
                        .size(18.0)
                        .tint(colors::ON_LIGHT),
                ),
        )
        .child(
            view()
                .flex_1()
                .gap(px(2.0))
                .child(
                    text(move || message.with(|m| m.0.clone()))
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::ON_LIGHT),
                )
                .child(
                    text(move || message.with(|m| m.1.clone()))
                        .number_of_lines(1)
                        .text_size(px(13.0))
                        .text_color(AdaptiveColor::new(rgb(0xa4a8ae), rgb(0x4a4e55))),
                ),
        );
    // The ticket: made fresh each time it opens.
    let ticket_view = move || {
        super::ticket::ticket()
            .code(code)
            .tick(tick)
            .last(move || quote.get().last)
            .side(side)
            .on_side(move |chosen: &Side| side.set(*chosen))
            .on_placed(move |e: &TicketEvent| {
                if let TicketEvent::Placed {
                    title,
                    detail,
                    side,
                } = e
                {
                    ticket.set(false);
                    show_banner(title.clone(), detail.clone(), *side);
                }
            })
    };
    // A bottom sheet on phones, a card in the window on desktops (Escape or
    // a click outside closes it).
    let ticket_shown = if wide {
        when(ticket, move || {
            dialog()
                .when(is_desktop(), |m| {
                    m.presentation(ModalPresentation::FormSheet)
                })
                .on_cancel(move || ticket.set(false))
                .child(
                    view()
                        .flex_1()
                        .p_5()
                        .bg(colors::SURFACE)
                        .child(ticket_view()),
                )
        })
        .into_element()
    } else {
        sheet()
            .open(ticket)
            .on_close(move || ticket.set(false))
            .child(ticket_view())
            .into_element()
    };
    view()
        .flex_1()
        .bg(colors::BACKGROUND)
        .child(content)
        .child(bar)
        .child(banner)
        .child(ticket_shown)
}

/// The figures under the quote: their labels.
const FIGURES: [&str; 8] = [
    "Open",
    "Prev close",
    "Avg price",
    "Amplitude",
    "Volume",
    "Turnover",
    "120d high",
    "120d low",
];

/// The quote: a big figure, a direction arrow that turns over natively,
/// the day's range and figures.
#[component]
fn QuoteSection(props: StockProps) -> impl IntoElement {
    let live = live();
    let index = props.stock as usize;
    let quote = live.quotes[index];
    let (name, sector, decimals, (year_lo, year_hi)) = {
        let market = live.market.borrow();
        let stock = &market.stocks[index];
        let year = stock
            .days
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), d| {
                (lo.min(d.l), hi.max(d.h))
            });
        (stock.name, stock.sector.label(), stock.decimals(), year)
    };
    let p = move |v: f64| price(v, decimals);
    let change = computed(move || {
        let q = quote.get();
        q.last - q.prev_close
    });
    let tone = computed(move || tone_of(change.get()));
    // The day is down: the arrow turns over.
    let down = computed(move || change.get() < 0.0);
    let turn = animated_value(if down.get_untracked() { 1.0 } else { 0.0 });
    {
        let shown = stored(down.get_untracked());
        effect(move || {
            let down = down.get();
            if shown.replace(down) != down {
                let _ = turn.spring(
                    if down { 1.0 } else { 0.0 },
                    Spring {
                        stiffness: 300.0,
                        damping: 18.0,
                        ..Spring::default()
                    },
                );
            }
        });
    }
    let figure = move |k: usize| {
        let q = quote.get();
        match k {
            0 => p(q.open),
            1 => p(q.prev_close),
            2 => p(q.turnover / if q.volume == 0.0 { 1.0 } else { q.volume }),
            3 => format!("{:.2}%", (q.high - q.low) / q.prev_close * 100.0),
            4 => compact(q.volume),
            5 => compact(q.turnover),
            6 => p(year_hi),
            _ => p(year_lo),
        }
    };
    let clock = live.clock;
    view()
        .px_4()
        .pt_3()
        .pb(px(14.0))
        .gap(px(10.0))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(
                    text(name)
                        .number_of_lines(1)
                        .flex_1()
                        .text_size(px(15.0))
                        .text_color(colors::MUTED),
                )
                .child(text(sector).text_size(px(13.0)).text_color(colors::FAINT))
                .child(live_dot().running(live.running).size(6.0))
                .child(
                    text(move || time(clock.get(), true))
                        .text_size(px(12.0))
                        .text_color(colors::MUTED)
                        .tabular_nums(),
                ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(
                    text(move || p(quote.get().last))
                        .text_size(px(36.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .letter_spacing(px(-1.0))
                        .text_color(tone)
                        .tabular_nums(),
                )
                .child(
                    view()
                        .bind_rotate(&turn.interpolate(&[0.0, 1.0], &[0.0, 180.0]))
                        .child(
                            icon()
                                .name(IconName::ArrowUp)
                                .size(20.0)
                                .tint(move || tone.get()),
                        ),
                )
                .child(
                    view()
                        .flex_1()
                        .items_end()
                        .gap(px(1.0))
                        .child(
                            text(move || format!("{}%", signed(quote.get().percent(), 2)))
                                .text_size(px(15.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .tabular_nums()
                                .text_color(tone),
                        )
                        .child(
                            text(move || {
                                format!("{} today", signed(change.get(), decimals as usize))
                            })
                            .text_size(px(12.0))
                            .tabular_nums()
                            .text_color(tone),
                        ),
                ),
        )
        .child(day_range().stock(props.stock))
        .child(
            view().flex_row().flex_wrap().children(
                FIGURES
                    .iter()
                    .enumerate()
                    .map(|(k, label)| Stat::new(*label, move || figure(k)).width(0.25)),
            ),
        )
}

/// Where `v` sits in the day of `q`, 0..1 (a span of at least one `tick`).
fn day_at(q: &Quote, tick: f64, v: f64) -> f32 {
    let lo = q.low.min(q.prev_close);
    let hi = q.high.max(q.prev_close);
    let hi = if hi > lo { hi } else { lo + tick };
    ((v - lo) / (hi - lo)) as f32
}

/// A label at an end of the day's range.
fn range_label(value: impl IntoReactive<SharedString>) -> Text {
    text(value)
        .text_size(px(12.0))
        .text_color(colors::MUTED)
        .tabular_nums()
}

/// Where the last price sits in the day, in one line: the low–high span
/// filled, the previous close marked, the last price a knob that springs
/// natively.
#[component]
fn DayRange(props: StockProps) -> impl IntoElement {
    let live = live();
    let index = props.stock as usize;
    let quote = live.quotes[index];
    let (tick, decimals) = {
        let market = live.market.borrow();
        let stock = &market.stocks[index];
        (stock.tick, stock.decimals())
    };
    let p = move |v: f64| price(v, decimals);
    let at = move |v: fn(&Quote) -> f64| {
        let q = quote.get();
        day_at(&q, tick, v(&q))
    };
    let x = animated_value(0.0);
    // The track's width as laid out (0 before), and whether the knob was
    // placed (the first place jumps, later ones spring).
    let width = stored(0.0_f32);
    let placed = stored(false);
    let place = move |q: Quote| {
        let width = width.get();
        if width <= 0.0 {
            return;
        }
        let to = day_at(&q, tick, q.last) * width;
        if placed.replace(true) {
            let _ = x.spring(
                to,
                Spring {
                    stiffness: 220.0,
                    damping: 24.0,
                    ..Spring::default()
                },
            );
        } else {
            x.set(to);
        }
    };
    effect(move || {
        let q = quote.get();
        untracked(|| place(q));
    });
    view()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .child(range_label(move || format!("L {}", p(quote.get().low))))
        .child(
            view()
                .on_layout(move |frame: &Bounds<Points>| {
                    if width.replace(frame.size.width.0) != frame.size.width.0 {
                        place(quote.get_untracked());
                    }
                })
                .label(move || {
                    let q = quote.get();
                    format!("Day range {} to {}", p(q.low), p(q.high))
                })
                .flex_1()
                .h(px(16.0))
                .justify_center()
                .child(view().h(px(4.0)).rounded(px(2.0)).bg(colors::RAISED))
                .child(
                    view()
                        .absolute()
                        .left(move || relative(at(|q| q.low)))
                        .w(move || relative(at(|q| q.high) - at(|q| q.low)))
                        .h(px(4.0))
                        .rounded(px(2.0))
                        .bg(colors::BORDER),
                )
                .child(
                    view()
                        .absolute()
                        .left(move || relative(at(|q| q.prev_close)))
                        .w(px(2.0))
                        .h(px(12.0))
                        .ml(px(-1.0))
                        .rounded(px(1.0))
                        .bg(colors::MUTED),
                )
                .child(
                    view()
                        .absolute()
                        .left(px(-7.0))
                        .size(px(14.0))
                        .rounded(px(7.0))
                        .border(px(3.0))
                        .border_color(colors::BACKGROUND)
                        .bg(move || {
                            let q = quote.get();
                            tone_of(q.last - q.prev_close)
                        })
                        .bind_translate_x(&x),
                ),
        )
        .child(range_label(move || format!("H {}", p(quote.get().high))))
}

/// The ranges over 5 to 120 days (`r`), the last price and the previous
/// close, drawn `width` wide with prices of `decimals`.
fn draw_ranges(r: &[Range], last: f64, prev_close: f64, width: f32, decimals: u32) -> Painter {
    if r.is_empty() || width <= 0.0 {
        return Painter::new();
    }
    let lo = r.iter().fold(f64::INFINITY, |m, x| m.min(x.lo));
    let hi = r.iter().fold(f64::NEG_INFINITY, |m, x| m.max(x.hi));
    let (left, right) = (40.0, 6.0);
    let span = if hi - lo == 0.0 { 1.0 } else { hi - lo };
    let x_of = |v: f64| left + ((v - lo) / span) as f32 * (width - left - right);
    let p_of = |v: f64| price(v, decimals);
    let mut p = Painter::new()
        .font("11px system-ui")
        .text_baseline(CanvasTextBaseline::Middle);
    for (i, row) in r.iter().enumerate() {
        let y = 10.0 + i as f32 * 34.0;
        p = p
            .fill_color(color(colors::MUTED))
            .text_align(CanvasTextAlign::Left)
            .fill_text(&format!("{}d", row.n), 0.0, y)
            .stroke_color(color(colors::BORDER))
            .line_width(3.0)
            .line_cap(LineCap::Round)
            .begin_path()
            .move_to(x_of(row.lo), y)
            .line_to(x_of(row.hi), y)
            .stroke();
        for (v, tone) in [(row.lo, colors::DOWN), (row.hi, colors::UP)] {
            p = p
                .fill_color(color(tone))
                .begin_path()
                .arc(x_of(v), y, 4.5, 0.0, TAU)
                .fill();
        }
        p = p
            .fill_color(color(colors::FAINT))
            .text_align(CanvasTextAlign::Left)
            .fill_text(&p_of(row.lo), x_of(row.lo) - 4.0, y + 13.0)
            .text_align(CanvasTextAlign::Right)
            .fill_text(&p_of(row.hi), x_of(row.hi) + 4.0, y + 13.0);
    }
    let bottom = HORIZONS.len() as f32 * 34.0;
    p.stroke_color(color(colors::FAINT))
        .line_width(1.0)
        .line_dash(&lengths([3.0, 4.0]))
        .begin_path()
        .move_to(x_of(prev_close), 0.0)
        .line_to(x_of(prev_close), bottom)
        .stroke()
        .line_dash(&[])
        .stroke_color(color(colors::ACCENT))
        .line_width(2.0)
        .begin_path()
        .move_to(x_of(last), 0.0)
        .line_to(x_of(last), bottom)
        .stroke()
        .fill_color(color(colors::ACCENT))
        .text_align(CanvasTextAlign::Center)
        .fill_text(
            &format!("last {}", p_of(last)),
            (left + 30.0).max((width - 40.0).min(x_of(last))),
            bottom + 8.0,
        )
}

/// Ranges over 5 to 120 days as dumbbells (low → high), the last price a
/// line across them and the previous close dashed; once a second.
#[component]
fn Ranges(props: StockProps) -> impl IntoElement {
    let live = live();
    let decimals = live.market.borrow().stocks[props.stock as usize].decimals();
    let (second, market) = (live.second, live.market);
    let ranges = computed(move || {
        second.get();
        market.borrow().ranges.clone()
    });
    let width = signal(0.0_f32);
    Block::new()
        .title("Ranges")
        .note("low → high · each second")
        .child(
            canvas(move || {
                let width = width.get();
                ranges.with(|(rows, q)| draw_ranges(rows, q.last, q.prev_close, width, decimals))
            })
            .h(px(HORIZONS.len() as f32 * 34.0 + 16.0))
            .label("Price ranges")
            .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0)),
        )
}
