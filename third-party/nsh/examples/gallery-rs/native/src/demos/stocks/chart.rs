//! The stock's chart (as the TSX gallery's `demos/stocks/Chart.tsx`): the
//! intraday time-share line with its average price, or candles with MA5 /
//! 10 / 20, both over volume. Drag sideways for the crosshair; its lines
//! move natively and the readout floats beside it.

use std::{f32::consts::TAU, rc::Rc};

use nsh_core::{
    Bounds, PanActivation, Points,
    canvas::{CanvasGradient, CanvasTextAlign, CanvasTextBaseline, LineJoin},
    element::AnimatedNode,
    prelude::*,
};

use super::{
    live,
    market::{Candle, OPEN, Quote, SESSION, compact, price, signed, time, tone_of},
    parts::{Calm, GRID, dashed, hatch, pulse, run_pulse},
};
use crate::ui::{Segment, SegmentedSize, colors, legend, lengths, pt, radius, rect, segmented};

/// What the chart shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Period {
    #[default]
    Intraday,
    M1,
    M5,
    M15,
    D1,
}

const PERIODS: [(Period, &str, &str); 5] = [
    (Period::Intraday, "Intraday", "intraday"),
    (Period::M1, "1m", "1m"),
    (Period::M5, "5m", "5m"),
    (Period::M15, "15m", "15m"),
    (Period::D1, "1D", "1D"),
];

impl Period {
    /// Candle bodies, in points.
    fn body(self) -> f32 {
        match self {
            Period::Intraday => 1.0,
            Period::M1 | Period::D1 => 5.0,
            Period::M5 => 7.0,
            Period::M15 => 9.0,
        }
    }

    /// The step between candles.
    fn step(self) -> f32 {
        self.body() + 2.0
    }
}

/// The moving averages: their spans and colors.
const AVERAGES: [(usize, AdaptiveColor); 3] =
    [(5, colors::ACCENT), (10, colors::INFO), (20, colors::WARN)];

const PAD_RIGHT: f32 = 54.0;
const PAD_TOP: f32 = 8.0;
const PAD_BOTTOM: f32 = 18.0;
/// The plot's height unless [`ChartProps::height`] says otherwise.
const HEIGHT: f32 = 216.0;
const VOL_H: f32 = 40.0;

/// The candles of a period from today's `minutes`, the `days` before and
/// the quote `q`: minutes merged into 5 / 15, or the days with today last.
fn candles(minutes: &[Candle], days: &[Candle], q: Quote, period: Period) -> Vec<Candle> {
    let span = match period {
        Period::Intraday | Period::M1 => return minutes.to_vec(),
        Period::D1 => {
            let today = Candle {
                t: 0.0,
                o: q.open,
                h: q.high,
                l: q.low,
                c: q.last,
                v: q.volume,
                a: q.turnover / q.volume,
            };
            return days.iter().copied().chain([today]).collect();
        }
        Period::M5 => 300.0,
        Period::M15 => 900.0,
    };
    let mut out: Vec<Candle> = Vec::new();
    for m in minutes {
        let t = m.t - (m.t - OPEN) % span;
        match out.last_mut() {
            Some(last) if last.t == t => {
                last.h = last.h.max(m.h);
                last.l = last.l.min(m.l);
                last.c = m.c;
                last.v += m.v;
                last.a = m.a;
            }
            _ => out.push(Candle { t, ..*m }),
        }
    }
    out
}

/// The mean close of the `n` candles ending at `i` (none before there are
/// `n`).
fn average(data: &[Candle], i: usize, n: usize) -> Option<f64> {
    if i + 1 < n || i >= data.len() {
        return None;
    }
    Some(data[i + 1 - n..=i].iter().map(|c| c.c).sum::<f64>() / n as f64)
}

fn label(c: &Candle, period: Period) -> String {
    if period == Period::D1 {
        if c.t == 0.0 {
            "Today".into()
        } else {
            format!("{}d ago", c.t)
        }
    } else {
        time(c.t, false)
    }
}

/// The geometry of one drawing, shared with the crosshair.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Frame {
    first: usize,
    count: usize,
    lo: f64,
    hi: f64,
    main_h: f32,
    vol_top: f32,
    plot_w: f32,
}

impl Frame {
    fn y(&self, v: f64) -> f32 {
        PAD_TOP + ((self.hi - v) / (self.hi - self.lo)) as f32 * self.main_h
    }
}

/// What the chart draws: the period's candles at a width, and their frame
/// (none before the layout, or without candles in view).
#[derive(Debug, Clone, PartialEq)]
struct Plot {
    period: Period,
    width: f32,
    data: Rc<[Candle]>,
    frame: Option<Frame>,
}

/// The live point's pulse as the intraday line draws it: the ring's alpha
/// and radius (native: they move without a drawing).
#[derive(Clone, Copy)]
struct LivePoint {
    alpha: AnimatedNode,
    radius: AnimatedNode,
}

impl Plot {
    /// `data` of `period` at `width` × `height`, in a frame of its range;
    /// candles scroll, so their range eases in through `scale` rather than
    /// jumping.
    fn fit(
        period: Period,
        (width, height): (f32, f32),
        data: Vec<Candle>,
        prev_close: f64,
        scale: &mut Calm,
    ) -> Self {
        let mut plot = Plot {
            period,
            width,
            data: data.into(),
            frame: None,
        };
        let (first, count) = plot.view();
        let end = plot.data.len().min(first + count);
        if end <= first || width <= 0.0 {
            return plot;
        }
        let intraday = plot.intraday();
        let (mut lo, mut hi) = if intraday {
            (prev_close, prev_close)
        } else {
            (f64::INFINITY, f64::NEG_INFINITY)
        };
        for c in &plot.data[first..end] {
            lo = lo.min(c.l);
            hi = hi.max(c.h);
        }
        let margin = match (hi - lo) * 0.08 {
            0.0 => hi * 0.01,
            m => m,
        };
        // Intraday the range is the day's, which only widens.
        let (lo, hi) = if intraday {
            (lo - margin, hi + margin)
        } else {
            scale.fit(lo - margin, hi + margin)
        };
        let main_h = height - PAD_TOP - PAD_BOTTOM - VOL_H - 12.0;
        plot.frame = Some(Frame {
            first,
            count,
            lo,
            hi,
            main_h,
            vol_top: PAD_TOP + main_h + 12.0,
            plot_w: plot.plot_w(),
        });
        plot
    }

    fn intraday(&self) -> bool {
        self.period == Period::Intraday
    }

    /// Minutes the intraday axis spans: the session so far (an hour at
    /// least) and a narrow margin ahead, never past the close.
    fn span(&self) -> f32 {
        SESSION.min((self.data.len().max(60) as f64 * 1.06).ceil()) as f32
    }

    fn plot_w(&self) -> f32 {
        self.width - PAD_RIGHT
    }

    /// The candles shown: today's minutes intraday, else the newest that
    /// fit.
    fn view(&self) -> (usize, usize) {
        if self.intraday() {
            return (0, self.span() as usize);
        }
        let count = ((self.plot_w() / self.period.step()).floor() as usize).max(1);
        (self.data.len().saturating_sub(count), count)
    }

    fn x(&self, i: usize) -> f32 {
        if self.intraday() {
            return i as f32 / self.span() * self.plot_w();
        }
        let step = self.period.step();
        (i as f32 - self.view().0 as f32) * step + step / 2.0
    }

    /// The candle at `x` along the chart (none without candles).
    fn pick(&self, x: f32) -> Option<usize> {
        if self.data.is_empty() {
            return None;
        }
        let (first, _) = self.view();
        let raw = if self.intraday() {
            (x / self.plot_w() * self.span()).round() as i64
        } else {
            first as i64 + (x / self.period.step()).floor() as i64
        };
        Some(raw.clamp(first as i64, self.data.len() as i64 - 1).max(0) as usize)
    }

    /// The readout's left edge: beside the candle `i`, flipped near the
    /// right.
    fn readout_left(&self, i: usize) -> f32 {
        let x = self.x(i);
        if x > self.width / 2.0 {
            (x - 150.0).max(0.0)
        } else {
            (self.width - 140.0).min(x + 10.0)
        }
    }

    fn draw(&self, prev_close: f64, decimals: u32, live: &LivePoint) -> Painter {
        let Some(f) = self.frame else {
            return Painter::new();
        };
        let p_of = |v: f64| price(v, decimals);
        let width = self.width;
        let intraday = self.intraday();

        // The grid and the price axis (percent from the close intraday).
        let mut p = Painter::new()
            .font("11px system-ui")
            .text_baseline(CanvasTextBaseline::Middle)
            .text_align(CanvasTextAlign::Left)
            .line_width(1.0);
        for k in 0..=4 {
            let v = f.hi - (f.hi - f.lo) * k as f64 / 4.0;
            let y = f.y(v);
            let label = if intraday {
                format!("{}%", signed((v - prev_close) / prev_close * 100.0, 2))
            } else {
                p_of(v)
            };
            p = p
                .stroke_color(color(GRID))
                .begin_path()
                .move_to(0.0, y)
                .line_to(f.plot_w, y)
                .stroke()
                .fill_color(color(colors::FAINT))
                .text_align(CanvasTextAlign::Right)
                .fill_text(&label, width, y);
        }
        p = p
            .stroke_color(color(GRID))
            .begin_path()
            .move_to(0.0, f.vol_top + VOL_H)
            .line_to(f.plot_w, f.vol_top + VOL_H)
            .stroke();

        p = if intraday {
            self.draw_intraday(p, prev_close, &f, live)
        } else {
            self.draw_candles(p, &f)
        };

        // The last price on the axis.
        let d = &self.data;
        let last = d[d.len() - 1];
        let ly = f.y(last.c).clamp(PAD_TOP + 8.0, PAD_TOP + f.main_h - 8.0);
        let tone = tone_of(if intraday {
            last.c - prev_close
        } else {
            last.c - last.o
        });
        if !intraday {
            p = dashed(
                p,
                0.0,
                f.plot_w,
                ly,
                color(tone.opacity(0.7)),
                &lengths([3.0, 3.0]),
            );
        }
        p.fill_color(color(tone))
            .begin_path()
            .round_rect(
                rect(f.plot_w + 2.0, ly - 9.0, PAD_RIGHT - 2.0, 18.0),
                px(5.0),
            )
            .fill()
            .fill_color(color(colors::INSET))
            .text_align(CanvasTextAlign::Right)
            .text_baseline(CanvasTextBaseline::Middle)
            .font("600 11px system-ui")
            .fill_text(&p_of(last.c), width - 4.0, ly)
    }

    fn draw_intraday(&self, p: Painter, prev_close: f64, f: &Frame, live: &LivePoint) -> Painter {
        let d = &self.data;
        let now = self.x(d.len() - 1);
        let last = d[d.len() - 1].c;
        let tone = tone_of(last - prev_close);
        let bottom = PAD_TOP + f.main_h;
        let mut p = hatch(
            p,
            now + 4.0,
            PAD_TOP,
            f.plot_w - now - 4.0,
            f.main_h,
            color(GRID),
            7.0,
        );
        p = dashed(
            p,
            0.0,
            f.plot_w,
            f.y(prev_close),
            color(colors::FAINT),
            &lengths([3.0, 4.0]),
        );
        // The price area and line.
        let fill = CanvasGradient::linear(pt(0.0, PAD_TOP), pt(0.0, bottom))
            .add_color_stop(percentage(0.0), color(tone.opacity(0.26)))
            .add_color_stop(percentage(1.0), color(tone.opacity(0.0)));
        p = p.begin_path().move_to(self.x(0), bottom);
        for (i, candle) in d.iter().enumerate() {
            p = p.line_to(self.x(i), f.y(candle.c));
        }
        p = p
            .line_to(now, bottom)
            .close_path()
            .fill_style(fill)
            .fill()
            .line_join(LineJoin::Round);
        let line = |p: Painter, y: &dyn Fn(&Candle) -> f64| {
            let mut p = p.begin_path().move_to(self.x(0), f.y(y(&d[0])));
            for (i, candle) in d.iter().enumerate().skip(1) {
                p = p.line_to(self.x(i), f.y(y(candle)));
            }
            p
        };
        p = line(p, &|c| c.c)
            .stroke_color(color(tone))
            .line_width(1.5)
            .stroke();
        // The day's average price.
        p = line(p, &|c| c.a)
            .stroke_color(color(colors::WARN))
            .line_width(1.1)
            .stroke();
        // Volume.
        let vw = (f.plot_w / self.span() - 0.8).max(1.0);
        let vmax = d.iter().fold(0.0_f64, |m, c| m.max(c.v));
        let vmax = if vmax == 0.0 { 1.0 } else { vmax };
        for (i, candle) in d.iter().enumerate() {
            let h = (candle.v / vmax) as f32 * VOL_H;
            let tint = if candle.c >= candle.o {
                colors::UP
            } else {
                colors::DOWN
            };
            p = p.fill_color(color(tint.opacity(0.6))).fill_rect(
                self.x(i) - vw / 2.0,
                f.vol_top + VOL_H - h,
                vw,
                h,
            );
        }
        // The live point, pulsing natively.
        let ly = f.y(last);
        p = p
            .fill_color(color(tone))
            .global_alpha(&live.alpha)
            .begin_path()
            .arc(now, ly, &live.radius, 0.0, TAU)
            .fill()
            .global_alpha(1.0)
            .begin_path()
            .arc(now, ly, 3.0, 0.0, TAU)
            .fill();
        // The open, the middle and the end of the span.
        p = p
            .fill_color(color(colors::FAINT))
            .text_baseline(CanvasTextBaseline::Top);
        for (k, align) in [
            (0.0, CanvasTextAlign::Left),
            (0.5, CanvasTextAlign::Center),
            (1.0, CanvasTextAlign::Right),
        ] {
            let at = OPEN + (k * self.span() as f64).round() * 60.0;
            p = p.text_align(align).fill_text(
                &time(at, false),
                k as f32 * f.plot_w,
                f.vol_top + VOL_H + 5.0,
            );
        }
        p
    }

    fn draw_candles(&self, p: Painter, f: &Frame) -> Painter {
        let d = &self.data;
        let body = self.period.body();
        let end = d.len().min(f.first + f.count);
        let vmax = d[f.first..end].iter().fold(0.0_f64, |m, c| m.max(c.v));
        let vmax = if vmax == 0.0 { 1.0 } else { vmax };
        let mut p = p;
        for (i, candle) in d.iter().enumerate().take(end).skip(f.first) {
            let x = self.x(i);
            let up = candle.c >= candle.o;
            let tint = if up { colors::UP } else { colors::DOWN };
            let top = f.y(candle.o.max(candle.c));
            let h = (f.y(candle.o.min(candle.c)) - top).max(1.0);
            p = p
                .stroke_color(color(tint))
                .line_width(1.0)
                .begin_path()
                .move_to(x, f.y(candle.h))
                .line_to(x, f.y(candle.l))
                .stroke()
                .fill_color(color(if up { colors::INSET } else { tint }))
                .fill_rect(x - body / 2.0, top, body, h);
            if up {
                p = p.stroke_rect(rect(
                    x - body / 2.0 + 0.5,
                    top + 0.5,
                    body - 1.0,
                    (h - 1.0).max(0.0),
                ));
            }
            let vh = (candle.v / vmax) as f32 * VOL_H;
            p = p.fill_color(color(tint.opacity(0.5))).fill_rect(
                x - body / 2.0,
                f.vol_top + VOL_H - vh,
                body,
                vh,
            );
        }
        p = p.line_width(1.2).line_join(LineJoin::Round);
        for (n, tint) in AVERAGES {
            p = p.stroke_color(color(tint)).begin_path();
            let mut started = false;
            for i in f.first..end {
                let Some(v) = average(d, i, n) else { continue };
                p = if started {
                    p.line_to(self.x(i), f.y(v))
                } else {
                    p.move_to(self.x(i), f.y(v))
                };
                started = true;
            }
            p = p.stroke();
        }
        p = p
            .fill_color(color(colors::FAINT))
            .text_baseline(CanvasTextBaseline::Top);
        let n = end - f.first;
        for (k, align) in [
            (0, CanvasTextAlign::Left),
            (n / 2, CanvasTextAlign::Center),
            (n - 1, CanvasTextAlign::Right),
        ] {
            let i = f.first + k;
            p = p.text_align(align).fill_text(
                &label(&d[i], self.period),
                self.x(i).clamp(0.0, f.plot_w),
                f.vol_top + VOL_H + 5.0,
            );
        }
        p
    }
}

/// The props of [`Chart`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct ChartProps {
    /// The stock's index in the market.
    pub(crate) stock: u32,
    /// The plot's height (the desktop layout draws it taller).
    #[prop(default = HEIGHT)]
    pub(crate) height: f32,
}

/// The chart, its plot 216 pt tall unless `height` says otherwise.
#[component]
pub(crate) fn Chart(props: ChartProps) -> impl IntoElement {
    let live = live();
    let index = props.stock as usize;
    let height = props.height;
    let quote = live.quotes[index];
    let (code, decimals) = {
        let market = live.market.borrow();
        let stock = &market.stocks[index];
        (stock.code, stock.decimals())
    };
    let prev_close = quote.get_untracked().prev_close;
    let p_of = move |v: f64| price(v, decimals);
    let period = signal(Period::default());
    // The candle under the finger.
    let cursor = signal(None::<usize>);
    let width = signal(0.0_f32);
    // Candles scroll: their range eases in rather than jumping.
    let scale = stored(Calm::new(0.06));
    // The live point's ring, pulsing while the market runs.
    let pulse = pulse();
    let ring = LivePoint {
        alpha: pulse.0.interpolate(&[0.0, 1.0], &[0.45, 0.0]),
        radius: pulse.0.interpolate(&[0.0, 1.0], &[3.0, 13.0]),
    };
    let running = live.running;
    effect(move || run_pulse(&pulse, running.get()));
    // The crosshair: where it is, and whether it shows.
    let [cross_x, cross_y, shown] = [
        animated_value(0.0),
        animated_value(0.0),
        animated_value(0.0),
    ];
    // The data and its frame, after a tick that moved the stock (its
    // minutes moved with its quote), the period or the width changed.
    let plot = {
        let market = live.market.clone();
        computed(move || {
            let (q, period, width) = (quote.get(), period.get(), width.get());
            let data = {
                let market = market.borrow();
                let stock = &market.stocks[index];
                candles(&stock.minutes, &stock.days, q, period)
            };
            scale.with(|scale| Plot::fit(period, (width, height), data, prev_close, scale))
        })
    };
    let intraday = computed(move || period.get() == Period::Intraday);
    // The candle the legends and the readout show: under the finger, else
    // the newest.
    let focus_at = computed(move || {
        plot.with(|p| {
            let last = p.data.len().checked_sub(1);
            cursor.get().map(|i| i.min(last.unwrap_or(0))).or(last)
        })
    });
    let focus = computed(move || {
        let at = focus_at.get();
        plot.with(|p| at.and_then(|i| p.data.get(i)).copied().unwrap_or_default())
    });
    let pick = move |x: Option<f32>| {
        let Some(x) = x else {
            cursor.set(None);
            let _ = shown.timing(0.0, 180.0, Easing::EaseInOut);
            return;
        };
        let picked = plot.with_untracked(|p| {
            p.pick(x)
                .map(|i| (i, p.x(i), p.frame.map(|f| f.y(p.data[i].c))))
        });
        let Some((i, at_x, at_y)) = picked else {
            return;
        };
        if cursor.get_untracked().is_none() {
            let _ = shown.timing(1.0, 140.0, Easing::EaseInOut);
        }
        cursor.set(Some(i));
        cross_x.set(at_x);
        if let Some(y) = at_y {
            cross_y.set(y);
        }
    };
    let price_tone = computed(move || tone_of(focus.get().c - prev_close));
    // The legends: an intraday period's or the averages, made when the
    // period's kind changes; their colors and figures are bound.
    let legends = dynamic(move || {
        if intraday.get() {
            vec![
                legend(price_tone, "Price", Some(move || p_of(focus.get().c))),
                legend(colors::WARN, "Avg", Some(move || p_of(focus.get().a))),
                legend(colors::FAINT, "Vol", Some(move || compact(focus.get().v))),
            ]
        } else {
            AVERAGES
                .iter()
                .map(|&(n, tint)| {
                    let value = move || {
                        let at = focus_at.get().unwrap_or(0);
                        plot.with(|p| average(&p.data, at, n))
                            .map_or("–".into(), p_of)
                    };
                    legend(tint, format!("MA{n}"), Some(value))
                })
                .collect()
        }
    });
    let change = computed(move || (focus.get().c - prev_close) / prev_close * 100.0);
    let readout = when(
        move || cursor.get().is_some(),
        move || {
            view()
                .absolute()
                .top(px(PAD_TOP + 2.0))
                .left(move || {
                    let at = focus_at.get().unwrap_or(0);
                    px(plot.with(|p| p.readout_left(at)))
                })
                .w(px(140.0))
                .p(px(10.0))
                .gap(px(3.0))
                .rounded(px(radius::CONTROL))
                .border_curve(BorderCurve::Continuous)
                .bg(colors::SURFACE.opacity(0.94))
                .border_1()
                .border_color(colors::BORDER)
                .child(
                    text(move || label(&focus.get(), period.get()))
                        .text_size(px(12.0))
                        .text_color(colors::MUTED)
                        .tabular_nums(),
                )
                .child(
                    text(move || p_of(focus.get().c))
                        .text_size(px(17.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT)
                        .tabular_nums()
                        .child(
                            text(move || format!(" {}%", signed(change.get(), 2)))
                                .text_size(px(12.0))
                                .font_weight(FontWeight::NORMAL)
                                .tabular_nums()
                                .text_color(price_tone),
                        ),
                )
                .child(
                    when(intraday, move || {
                        text(move || {
                            let c = focus.get();
                            format!("avg {} · vol {}", p_of(c.a), compact(c.v))
                        })
                        .text_size(px(11.0))
                        .text_color(colors::MUTED)
                        .tabular_nums()
                    })
                    .otherwise(move || {
                        text(move || {
                            let c = focus.get();
                            format!(
                                "O {} H {}\nL {} V {}",
                                p_of(c.o),
                                p_of(c.h),
                                p_of(c.l),
                                compact(c.v)
                            )
                        })
                        .text_size(px(11.0))
                        .line_height(px(15.0))
                        .text_color(colors::MUTED)
                        .tabular_nums()
                    }),
                )
        },
    );
    view()
        .gap(px(10.0))
        .child(
            segmented()
                .options(
                    PERIODS
                        .iter()
                        .map(|p| Segment::new(p.1))
                        .collect::<Vec<_>>(),
                )
                .selected(move || {
                    PERIODS
                        .iter()
                        .position(|p| p.0 == period.get())
                        .unwrap_or(0) as u32
                })
                .size(SegmentedSize::Small)
                .on_change(move |i: &u32| {
                    scale.with(Calm::reset);
                    period.set(PERIODS[*i as usize].0);
                }),
        )
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .gap_x(px(14.0))
                .gap_y(px(6.0))
                .child(legends),
        )
        .child(
            view()
                .h(px(height))
                .child(
                    canvas(move || plot.with(|p| p.draw(prev_close, decimals, &ring)))
                        .h(px(height))
                        .label(move || {
                            let name = PERIODS
                                .iter()
                                .find(|p| p.0 == period.get())
                                .map_or("", |p| p.2);
                            format!("{code} {name} chart")
                        })
                        .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
                        // The platform gives the chart the finger only once
                        // it has moved sideways, so vertical drags still
                        // scroll the page.
                        .claim_touches(TouchClaim::on_pan(PanActivation::horizontal(
                            px(6.0),
                            px(8.0),
                        )))
                        .keep_touches(true)
                        .on_responder_grant(move |e: &ResponderEvent| pick(Some(e.location.x.0)))
                        .on_responder_move(move |e: &ResponderEvent| pick(Some(e.location.x.0)))
                        .on_responder_release(move |_: &ResponderEvent| pick(None))
                        .on_responder_terminate(move |_: &ResponderEvent| pick(None)),
                )
                // The crosshair over the canvas, moved by animated values.
                .child(
                    view()
                        .pointer_events(PointerEvents::None)
                        .absolute()
                        .inset_0()
                        .bind_opacity(&shown)
                        .child(
                            view()
                                .absolute()
                                .top(px(PAD_TOP))
                                .bottom(px(PAD_BOTTOM))
                                .left_0()
                                .w(px(1.0))
                                .bg(colors::MUTED)
                                .bind_translate_x(&cross_x),
                        )
                        .child(
                            view()
                                .absolute()
                                .left_0()
                                .right(px(PAD_RIGHT))
                                .top_0()
                                .h(px(1.0))
                                .bg(colors::MUTED.opacity(0.6))
                                .bind_translate_y(&cross_y),
                        )
                        .child(
                            view()
                                .absolute()
                                .top(px(-4.0))
                                .left(px(-4.0))
                                .size(px(9.0))
                                .rounded(px(4.5))
                                .bg(colors::TEXT)
                                .border_2()
                                .border_color(colors::INSET)
                                .bind_translate_x(&cross_x)
                                .bind_translate_y(&cross_y),
                        )
                        .child(readout),
                ),
        )
}
