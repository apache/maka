//! Stocks: a live watchlist and a stock (as the TSX gallery's
//! `demos/Stocks.tsx` and `demos/stocks/`): quotes that change every 50 ms
//! under a one-line market strip, sorted filters that re-sort once a second
//! with a layout animation; a stock opens its candles, depth, the tape and
//! a ticket, pushed on phones, beside the list in the desktop layout.
//! Leaving the demo stops the market.
//!
//! The watchlist owns the market and steps it. A tick writes the signals of
//! what moved ([`Live`]): each stock's quote (only the stocks that traded
//! notify), the clock and the composite, and counters of the quarter
//! seconds and the seconds for the parts that change at those cadences. So
//! a tick runs only the bindings of what it changed: a row's price, its
//! sparkline, the strip's figures. A stock's screen is pushed into the
//! gallery's stack, outside the watchlist; the watchlist hands it the same
//! [`Live`] as a context. In the desktop layout the stock is beside the
//! watchlist, under it in the view.

mod book;
mod chart;
mod detail;
mod market;
mod parts;
mod tape;
mod ticket;

use std::{cell::RefCell, f32::consts::TAU, rc::Rc, time::Duration};

use nsh_base::nav_page;
use nsh_core::{
    LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition,
    animation::{Curve, EaseMode},
    canvas::{CanvasGradient, Composite, LineCap, LineJoin},
    element::{AccessibilityState, AnimatedNode, View},
    prelude::*,
    time::Instant,
};

use self::{
    detail::stock_view,
    market::{
        INDEX_BASE, ISSUES, Market, Quote, SECTORS, TICK_MS, grouped, price, signed, time, tone_of,
    },
    parts::{Calm, market_button, spring_bar},
};
use crate::{
    nav,
    ui::{
        IconName, PageHeader, Segment, SegmentedSize, colors, desktop, header, icon, lengths,
        motion, pane_width, pt, segmented, with_header,
    },
};

/// The market a watchlist runs, as its screens read it (a context: the
/// watchlist provides it to its own parts and to each stock's screen it
/// pushes): the simulation, plain data the watchlist steps, and the
/// signals a tick writes for what moved.
#[derive(Clone)]
pub(crate) struct Live {
    /// The simulation. Shared rather than owned by the watchlist: a stock's
    /// screen releases its focus when it goes, even after the watchlist.
    pub(crate) market: Rc<RefCell<Market>>,
    /// Each stock's quote, written every tick: it notifies when the stock
    /// traded, and its minutes and sparkline (and the focused stock's book
    /// and trades) move only then.
    pub(crate) quotes: Rc<[Signal<Quote>]>,
    /// The market time, every tick.
    pub(crate) clock: Signal<f64>,
    /// The composite, every tick.
    pub(crate) composite: Signal<f64>,
    /// Counts the quarter seconds while a stock is focused: its tape and
    /// its depth chart.
    pub(crate) quarter: Signal<u64>,
    /// Counts the seconds: breadth, the sectors, the stats, the focused
    /// stock's flow and ranges, the watchlist's order.
    pub(crate) second: Signal<u64>,
    /// The market runs.
    pub(crate) running: Signal<bool>,
}

impl Live {
    /// Steps the market, then writes what moved, together.
    fn tick(&self) {
        let (quarter, second) = {
            let mut market = self.market.borrow_mut();
            market.step();
            (
                market.focused.is_some() && market.ticks.is_multiple_of(5),
                market.on_second(),
            )
        };
        batch(|| {
            let market = self.market.borrow();
            // A stock that did not trade keeps its quote: an equal write
            // notifies no one.
            for (quote, stock) in self.quotes.iter().zip(&market.stocks) {
                quote.set(stock.quote);
            }
            self.clock.set(market.clock);
            self.composite.set(market.composite);
            if quarter {
                self.quarter.update(|n| *n += 1);
            }
            if second {
                self.second.update(|n| *n += 1);
            }
        });
    }
}

/// The market of the watchlist this view is in.
pub(crate) fn live() -> Live {
    use_context::<Live>().expect("the watchlist provides its market")
}

/// Expanding and collapsing, reordering rows: one native layout animation.
const RELAYOUT: LayoutAnimation = LayoutAnimation {
    create: Some(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 380.0)),
    update: Some(LayoutTransition {
        curve: LayoutCurve::Spring { damping: 0.84 },
        property: LayoutProperty::Opacity,
        duration_ms: 380.0,
        delay_ms: 0.0,
    }),
    delete: Some(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 380.0)),
};

/// The watchlist's filters.
const FILTERS: [&str; 4] = ["All", "Gainers", "Losers", "Active"];

/// The stocks filter `filter` shows, in order.
fn ordered(market: &Market, filter: usize) -> Vec<usize> {
    let change = |i: &usize| market.stocks[*i].quote.percent();
    let all = 0..market.stocks.len();
    let mut next: Vec<usize> = match filter {
        1 => all.filter(|i| change(i) > 0.0).collect(),
        2 => all.filter(|i| change(i) < 0.0).collect(),
        _ => all.collect(),
    };
    match filter {
        1 => next.sort_by(|a, b| change(b).total_cmp(&change(a))),
        2 => next.sort_by(|a, b| change(a).total_cmp(&change(b))),
        3 => {
            let turnover = |i: &usize| market.stocks[*i].quote.turnover;
            next.sort_by(|a, b| turnover(b).total_cmp(&turnover(a)));
            next.truncate(10);
        }
        _ => {}
    }
    next
}

/// Gainers and losers.
fn counts(market: &Market) -> (u32, u32) {
    market
        .stocks
        .iter()
        .map(|s| s.quote.percent())
        .fold((0, 0), |(up, down), c| {
            (up + u32::from(c > 0.0), down + u32::from(c < 0.0))
        })
}

/// Pushes the screen of stock `index`.
fn open(live: &Live, index: usize) {
    let code = live.market.borrow().stocks[index].code;
    let live = live.clone();
    nav::push(format!("stock:{code}"), move || {
        // The screen is outside the watchlist: it gets the market here.
        provide_context(live.clone());
        with_header(
            header(nav_page().title(code)).header_right(market_button()),
            || PageHeader::new(code).right(market_button()),
        )
        .child(stock_view().stock(index as u32))
    });
}

/// The watchlist's width beside the stock in the desktop layout.
const WATCHLIST: f32 = 380.0;

/// The watchlist: it owns the market. A stock opens its details, pushed on
/// phones, beside the list on desktops.
#[component]
pub(crate) fn Stocks() -> impl IntoElement {
    // The shell is made again when the layout changes: read once.
    let wide = untracked(desktop);
    let market = Market::new();
    let quotes: Rc<[Signal<Quote>]> = market.stocks.iter().map(|s| signal(s.quote)).collect();
    let live = Live {
        clock: signal(market.clock),
        composite: signal(market.composite),
        quarter: signal(0),
        second: signal(0),
        running: signal(true),
        quotes,
        market: Rc::new(RefCell::new(market)),
    };
    provide_context(live.clone());
    // A tick every 50 ms while the market runs (the interval goes with the
    // run, and with the watchlist).
    {
        let live = live.clone();
        effect(move || {
            if live.running.get() {
                let live = live.clone();
                set_interval(Duration::from_millis(TICK_MS), move || live.tick());
            }
        });
    }
    let filter = signal(0_usize);
    // The stocks shown, in order: again each second and when the filter
    // changes; a change animates.
    let rows = signal(ordered(&live.market.borrow(), 0));
    {
        let live = live.clone();
        effect(move || {
            let filter = filter.get();
            live.second.get();
            let next = ordered(&live.market.borrow(), filter);
            if rows.with_untracked(|rows| *rows != next) {
                animate_layout(RELAYOUT);
                rows.set(next);
            }
        });
    }
    // Gainers and losers, once a second.
    let counts = {
        let live = live.clone();
        computed(move || {
            live.second.get();
            counts(&live.market.borrow())
        })
    };
    let listed = live.quotes.len() as u32;
    let options = Prop::bind(move || {
        let (up, down) = counts.get();
        FILTERS
            .iter()
            .enumerate()
            .map(|(i, label)| {
                let segment = Segment::new(*label);
                match i {
                    0 => segment.count(listed),
                    1 => segment.count(up),
                    2 => segment.count(down),
                    _ => segment,
                }
            })
            .collect::<Vec<_>>()
    });
    // Desktop: the stock beside the list.
    let shown = signal(0_usize);
    let stocks = {
        let live = live.clone();
        each(
            move || rows.get(),
            |i: &usize| *i,
            move |i, at| {
                let index = i.get_untracked();
                let live = live.clone();
                stock_row()
                    .index(index as u32)
                    .first(move || at.get() == 0)
                    .wide(wide)
                    .active(move || wide && shown.get() == index)
                    .on_press(move || {
                        if wide {
                            shown.set(index);
                        } else {
                            open(&live, index);
                        }
                    })
            },
        )
    };
    let second = live.second;
    let footer = move || {
        second.get();
        let stats = live.market.borrow().stats;
        format!(
            "Simulated, fictional companies · tick {TICK_MS} ms · {:.2} ms Rust/tick · {} quotes/s",
            stats.ms, stats.updates
        )
    };
    let watchlist = view()
        .flex_1()
        .bg(colors::BACKGROUND)
        .child(market_strip())
        .child(
            view().px_4().pb(px(6.0)).child(
                segmented()
                    .options(options)
                    .selected(move || filter.get() as u32)
                    .size(SegmentedSize::Small)
                    .on_change(move |i: &u32| {
                        filter.set(*i as usize);
                    }),
            ),
        )
        .child(
            scroll()
                .flex_1()
                .child(view().child(stocks).child(when(
                    move || rows.with(Vec::is_empty),
                    || {
                        text("Nothing here right now")
                            .py(px(32.0))
                            .text_center()
                            .text_size(px(14.0))
                            .text_color(colors::MUTED)
                    },
                )))
                .child(
                    text(footer)
                        .px_4()
                        .pt_4()
                        .pb(px(40.0))
                        .text_size(px(12.0))
                        .line_height(px(17.0))
                        .text_color(colors::FAINT)
                        .tabular_nums(),
                ),
        );
    if !wide {
        return watchlist.into_element();
    }
    // The book and the tape go beside the chart when the stock has the room.
    let split = computed(|| pane_width() - WATCHLIST >= 860.0);
    view()
        .flex_1()
        .flex_row()
        .bg(colors::BACKGROUND)
        .child(
            view()
                .w(px(WATCHLIST))
                .border_r_1()
                .border_r_color(colors::LINE)
                .child(watchlist),
        )
        // A new stock view when another stock is shown.
        .child(view().flex_1().child(dynamic(move || {
            let stock = shown.get() as u32;
            untracked(|| stock_view().stock(stock).wide(true).split(split))
        })))
        .into_element()
}

/// The market in one line, on the 16 pt gutters: the composite and its
/// change, the clock, pause. A tap opens breadth and sectors (a layout
/// animation; the chevron turns natively).
#[component]
fn MarketStrip() -> impl IntoElement {
    let live = live();
    let opened = signal(false);
    let turn = animated_value(0.0);
    let toggle = move |_: &()| {
        animate_layout(RELAYOUT);
        opened.update(|o| *o = !*o);
        let to = if opened.get_untracked() { 1.0 } else { 0.0 };
        let _ = turn.spring(to, motion::SETTLE);
    };
    let (composite, clock) = (live.composite, live.clock);
    let change = computed(move || (composite.get() - INDEX_BASE) / INDEX_BASE * 100.0);
    view()
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .px_4()
                .h(px(56.0))
                .child(
                    view()
                        .on_press(toggle)
                        .role(AccessibilityRole::Button)
                        .label(move || {
                            if opened.get() {
                                "Hide breadth"
                            } else {
                                "Show breadth"
                            }
                        })
                        .flex_1()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .h(px(56.0))
                        .child(
                            text("Composite")
                                .number_of_lines(1)
                                .text_size(px(13.0))
                                .text_color(colors::MUTED),
                        )
                        .child(
                            text(move || grouped(composite.get(), 2))
                                .number_of_lines(1)
                                .text_size(px(15.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT)
                                .tabular_nums(),
                        )
                        .child(
                            text(move || format!("{}%", signed(change.get(), 2)))
                                .text_size(px(13.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(move || tone_of(change.get()))
                                .tabular_nums(),
                        )
                        .child(
                            view()
                                .bind_rotate(&turn.interpolate(&[0.0, 1.0], &[90.0, -90.0]))
                                .child(
                                    icon()
                                        .name(IconName::Chevron)
                                        .size(12.0)
                                        .tint(colors::FAINT),
                                ),
                        ),
                )
                .child(
                    text(move || time(clock.get(), true))
                        .text_size(px(12.0))
                        .text_color(colors::FAINT)
                        .tabular_nums(),
                )
                .child(market_button()),
        )
        .child(when(opened, move || breadth(&live)))
}

/// Advancers vs decliners across the composite and the sectors' moves:
/// what the strip opens to (once a second).
fn breadth(live: &Live) -> View {
    let second = live.second;
    let b = {
        let market = live.market.clone();
        computed(move || {
            second.get();
            market.borrow().breadth
        })
    };
    let sectors = {
        let market = live.market.clone();
        computed(move || {
            second.get();
            market.borrow().sectors
        })
    };
    let scale = computed(move || sectors.get().iter().fold(0.5_f64, |m, c| m.max(c.abs())) * 1.1);
    view()
        .px_4()
        .pb(px(14.0))
        .gap(px(10.0))
        .child(
            view()
                .gap(px(6.0))
                .child(
                    view()
                        .flex_row()
                        .h(px(6.0))
                        .rounded(px(3.0))
                        .overflow_hidden()
                        .gap(px(2.0))
                        .child(
                            view()
                                .flex_1()
                                .flex_grow(move || b.get().up as f32)
                                .bg(colors::UP),
                        )
                        .child(
                            view()
                                .flex_1()
                                .flex_grow(move || b.get().flat as f32)
                                .bg(colors::FAINT),
                        )
                        .child(
                            view()
                                .flex_1()
                                .flex_grow(move || b.get().down as f32)
                                .bg(colors::DOWN),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .child(figure(move || format!("{} up", b.get().up), colors::UP).flex_1())
                        .child(figure(
                            move || format!("{} flat · {ISSUES} issues", b.get().flat),
                            colors::FAINT,
                        ))
                        .child(
                            figure(move || format!("{} down", b.get().down), colors::DOWN)
                                .flex_1()
                                .text_right(),
                        ),
                ),
        )
        .child(view().gap(px(2.0)).children(
            SECTORS.iter().enumerate().map(|(i, (_, label))| {
                sector_bar(label, computed(move || sectors.get()[i]), scale)
            }),
        ))
}

/// A small figure in `color`.
pub(crate) fn figure(value: impl IntoReactive<SharedString>, color: AdaptiveColor) -> Text {
    text(value)
        .text_size(px(12.0))
        .tabular_nums()
        .text_color(color)
}

/// A sector's mean change as a bar diverging from the middle.
fn sector_bar(label: &'static str, change: Memo<f64>, scale: Memo<f64>) -> View {
    let share = move || (change.get().abs() / scale.get()).min(1.0);
    view()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .h(px(22.0))
        .child(
            text(label)
                .number_of_lines(1)
                .w(px(84.0))
                .text_size(px(13.0))
                .text_color(colors::MUTED),
        )
        .child(
            view()
                .flex_1()
                .flex_row()
                .items_center()
                .child(
                    view().flex_1().child(
                        spring_bar()
                            .share(move || {
                                if change.get() < 0.0 {
                                    share() as f32
                                } else {
                                    0.0
                                }
                            })
                            .color(colors::DOWN)
                            .from_right(true)
                            .radius(2.0),
                    ),
                )
                .child(view().w(px(1.0)).h(px(14.0)).bg(colors::BORDER))
                .child(
                    view().flex_1().child(
                        spring_bar()
                            .share(move || {
                                if change.get() > 0.0 {
                                    share() as f32
                                } else {
                                    0.0
                                }
                            })
                            .color(colors::UP)
                            .radius(2.0),
                    ),
                ),
        )
        .child(
            text(move || format!("{}%", signed(change.get(), 2)))
                .w(px(56.0))
                .text_right()
                .text_size(px(12.0))
                .tabular_nums()
                .text_color(move || tone_of(change.get())),
        )
}

/// The newest point's ring at its widest: the canvas reaches this far past
/// the plot on every side, so the ring is never clipped.
const RING: f32 = 10.0;
/// The sparkline's plot.
const SPARK_W: f32 = 104.0;
const SPARK_H: f32 = 38.0;
/// The shortest time between two pulses of a row: each one completes.
const PULSE_GAP: Duration = Duration::from_millis(600);

/// The newest point's pulse as a sparkline draws it: the ring's radius,
/// the halo's and the ring's alpha (native: they move without a drawing).
#[derive(Clone, Copy)]
struct Ring {
    radius: AnimatedNode,
    halo: AnimatedNode,
    stroke: AnimatedNode,
}

/// Today in 104 × 38 pt: a smooth line through a moving average of the
/// minutes' closes (`ys`) ending at the live price, a soft fill under it
/// that fades in from the left and down from the line, the previous close
/// dotted and a dot at the newest point that rings natively on each change.
/// `range` is the y range.
fn sparkline(ys: &[f64], q: Quote, (lo, hi): (f64, f64), ring: &Ring) -> Painter {
    let n = ys.len();
    if n == 0 {
        return Painter::new();
    }
    let (width, height) = (SPARK_W + RING * 2.0, SPARK_H + RING * 2.0);
    let (left, right, bottom) = (RING, width - RING, height - RING);
    let span = if hi - lo == 0.0 { 1.0 } else { hi - lo };
    let y_of = |v: f64| RING + 2.0 + ((hi - v) / span) as f32 * (bottom - RING - 4.0);
    let x_of = |k: usize| left + k as f32 / (n.max(2) - 1) as f32 * (right - left);
    let tone = tone_of(q.last - q.prev_close);
    let tone_color = color(tone);
    // A smooth curve: quadratic segments through the midpoints.
    let curve = |p: Painter| {
        let mut p = p.move_to(x_of(0), y_of(ys[0]));
        for k in 1..n.saturating_sub(1) {
            p = p.quadratic_curve_to(
                pt(x_of(k), y_of(ys[k])),
                pt(
                    (x_of(k) + x_of(k + 1)) / 2.0,
                    (y_of(ys[k]) + y_of(ys[k + 1])) / 2.0,
                ),
            );
        }
        p.line_to(x_of(n - 1), y_of(ys[n - 1]))
    };

    // The fill: down from the line's top, strictly under the curve...
    let top = ys.iter().fold(bottom, |t, &v| t.min(y_of(v)));
    let fill = CanvasGradient::linear(pt(0.0, top), pt(0.0, bottom))
        .add_color_stop(percentage(0.0), color(tone.opacity(0.22)))
        .add_color_stop(percentage(1.0), color(tone.opacity(0.0)));
    let p = curve(Painter::new().begin_path())
        .line_to(x_of(n - 1), bottom)
        .line_to(x_of(0), bottom)
        .close_path()
        .fill_style(fill)
        .fill();
    // ...and faded in over the first fifth (erased, not overdrawn).
    let fade_to = left + (right - left) * 0.2;
    let fade = CanvasGradient::linear(pt(left, 0.0), pt(fade_to, 0.0))
        .add_color_stop(percentage(0.0), rgb(0x000000))
        .add_color_stop(percentage(1.0), transparent_black());
    let p = p
        .composite(Composite::DestinationOut)
        .fill_style(fade)
        .fill_rect(0.0, 0.0, fade_to, height)
        .composite(Composite::SourceOver);

    // The previous close, dotted.
    let p = p
        .stroke_color(color(colors::MUTED.opacity(0.4)))
        .line_width(1.0)
        .line_dash(&lengths([1.0, 3.0]))
        .begin_path()
        .move_to(left, y_of(q.prev_close))
        .line_to(right, y_of(q.prev_close))
        .stroke()
        .line_dash(&[]);

    let p = curve(p.begin_path())
        .stroke_color(tone_color)
        .line_width(1.75)
        .line_join(LineJoin::Round)
        .line_cap(LineCap::Round)
        .stroke();

    // The newest point and its pulse: a soft halo and a ring that grow and
    // fade natively (the canvas has room for them on every side).
    let (x, y) = (x_of(n - 1), y_of(ys[n - 1]));
    p.fill_color(tone_color)
        .stroke_color(tone_color)
        .global_alpha(&ring.halo)
        .begin_path()
        .arc(x, y, &ring.radius, 0.0, TAU)
        .fill()
        .global_alpha(&ring.stroke)
        .line_width(1.5)
        .begin_path()
        .arc(x, y, &ring.radius, 0.0, TAU)
        .stroke()
        .global_alpha(1.0)
        .begin_path()
        .arc(x, y, 3.0, 0.0, TAU)
        .fill()
}

/// The props of [`StockRow`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
struct StockRowProps {
    /// The stock's index in the market.
    index: u32,
    /// The first row: no hairline above it.
    #[prop(default)]
    first: Prop<bool>,
    /// The desktop layout: the row shown beside the list is `active`, and
    /// the others light up under the pointer.
    #[prop(default)]
    wide: bool,
    /// The row's stock is shown beside the list.
    #[prop(default)]
    active: Prop<bool>,
}

/// What a [`StockRow`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
enum StockRowEvent {
    /// The row was pressed.
    Press,
}

/// A watchlist row: code and name, today's sparkline, the price and its
/// change, plain text on a flat row. A tick that moved the stock runs its
/// texts and its sparkline; the others' stay as they are. In the desktop
/// layout the row shown beside the list is `active`, and the others light
/// up under the pointer.
#[component]
fn StockRow(props: StockRowProps, cx: Scope<StockRowEvent>) -> impl IntoElement {
    let live = live();
    let index = props.index as usize;
    let quote = live.quotes[index];
    let (code, name, decimals) = {
        let market = live.market.borrow();
        let stock = &market.stocks[index];
        (stock.code, stock.name, stock.decimals())
    };
    // The sparkline's y range, easing instead of jumping: fitted once per
    // change.
    let scale = stored(Calm::new(0.1));
    let range = {
        let market = live.market.clone();
        computed(move || {
            let q = quote.get();
            let (lo, hi) = market.borrow().stocks[index]
                .spark
                .iter()
                .fold((q.prev_close, q.prev_close), |(lo, hi), &v| {
                    (lo.min(v), hi.max(v))
                });
            scale.with(|s| s.fit(lo, hi))
        })
    };
    // The newest point's pulse: 0 → 1 on a change, at most every 600 ms so
    // each one plays out.
    let ring = animated_value(1.0);
    {
        let seen = stored(quote.get_untracked().changed_at);
        let fired = stored(None::<Instant>);
        effect(move || {
            let changed_at = quote.get().changed_at;
            if seen.replace(changed_at) == changed_at {
                return;
            }
            if fired.with(|at| at.is_none_or(|at| at.elapsed() >= PULSE_GAP)) {
                fired.replace(Some(Instant::now()));
                ring.set(0.0);
                let _ = ring.timing(1.0, 700.0, Easing::Curve(Curve::Cubic, EaseMode::Out));
            }
        });
    }
    let ring = Ring {
        radius: ring.interpolate(&[0.0, 1.0], &[3.0, RING]),
        halo: ring.interpolate(&[0.0, 1.0], &[0.35, 0.0]),
        stroke: ring.interpolate(&[0.0, 1.0], &[0.9, 0.0]),
    };
    let change = computed(move || quote.get().percent());
    let market = live.market;
    let active = props.active;
    // TS: `bg-accent` when active, `hover:bg-card` otherwise (the gallery
    // theme's tokens).
    let fill = AdaptiveColor::new(colors::BORDER.light, colors::RAISED.dark);
    view()
        .h(px(64.0))
        .flex_row()
        .items_center()
        .gap_3()
        .px_4()
        .on_press(move || cx.emit(StockRowEvent::Press))
        // Pressed, the row shows the surface under its content.
        .active(|s| s.bg(colors::SURFACE))
        .role(AccessibilityRole::Button)
        .label(name)
        .when(props.wide, |v| {
            v.cursor_pointer()
                .accessibility_state(move || AccessibilityState {
                    selected: active.get(),
                    ..AccessibilityState::default()
                })
                .style_when(active, |s| s.bg(fill))
                .hover(|s| s.bg(move || if active.get() { fill } else { colors::SURFACE }))
        })
        .child(when(active, || {
            view()
                .absolute()
                .top(px(14.0))
                .bottom(px(14.0))
                .left_0()
                .w(px(3.0))
                .rounded(px(1.5))
                .bg(colors::ACCENT)
        }))
        // The hairline above all rows but the first (it stays: rows move).
        .child(
            view()
                .absolute()
                .top_0()
                .left(px(16.0))
                .right_0()
                .h(px(1.0))
                .bg(move || {
                    if props.first.get() {
                        AdaptiveColor::TRANSPARENT
                    } else {
                        colors::LINE
                    }
                }),
        )
        .child(
            view()
                .flex_1()
                .gap(px(3.0))
                .child(
                    text(code)
                        .number_of_lines(1)
                        .text_size(px(16.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT),
                )
                .child(
                    text(name)
                        .number_of_lines(1)
                        .text_size(px(13.0))
                        .text_color(colors::MUTED),
                ),
        )
        .child(
            canvas(move || {
                let (q, range) = (quote.get(), range.get());
                sparkline(&market.borrow().stocks[index].spark, q, range, &ring)
            })
            .pointer_events(PointerEvents::None)
            .w(px(SPARK_W + RING * 2.0))
            .h(px(SPARK_H + RING * 2.0))
            .m(px(-RING)),
        )
        .child(
            view()
                .w(px(84.0))
                .items_end()
                .gap(px(3.0))
                .child(
                    text(move || price(quote.get().last, decimals))
                        .number_of_lines(1)
                        .text_size(px(16.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT)
                        .tabular_nums(),
                )
                .child(
                    text(move || format!("{}%", signed(change.get(), 2)))
                        .number_of_lines(1)
                        .text_size(px(13.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(move || tone_of(change.get()))
                        .tabular_nums(),
                ),
        )
}
