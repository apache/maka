//! Canvas: 2D drawing on cards: a dial whose needle and sweep follow one
//! animated value, an area chart and a ridgeline that sweep in natively, a
//! dot matrix with a pulsing dot, a dumbbell plot whose dots travel, a
//! clock, SVG paths, compositing and touch drawing (as the TSX gallery's
//! `demos/CanvasDemo.tsx`).

use std::{
    cell::Cell,
    f32::consts::{FRAC_PI_2, PI, TAU},
};

use nsh_core::{
    Bounds, Points,
    animation::{Curve, EaseMode},
    canvas::{
        CanvasGradient, CanvasOp, CanvasTextAlign, CanvasTextBaseline, Composite, FillRule,
        LineCap, LineJoin, Num, PathOp, svg_path,
    },
    element::Animation,
    prelude::*,
};

use crate::ui::{
    Button, ButtonVariant, Card, DemoPage, Figure, Finish, Finished, IconName, Segment, Stat, Tone,
    caption, colors, hint, legend, lengths, pt, rect, segmented,
};

/// A canvas font of the system family (TS `SANS(size, weight)`).
fn sans(size: f32, weight: u32) -> String {
    format!("{weight} {size}px system-ui")
}

/// A number in `0..1` (TS: `Math.random()`): xorshift, seeded by the clock.
fn random() -> f64 {
    thread_local! {
        static STATE: Cell<u64> = Cell::new(
            (nsh_core::time::unix_ms() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1,
        );
    }
    STATE.with(|state| {
        let mut x = state.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        state.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

/// A small seeded random generator (TS `seeded`, mulberry32), so the
/// fictional data is stable and the same as the TSX gallery's.
fn seeded(seed: u32) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = s.wrapping_add(0x6d2b_79f5);
        let mut t = s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

/// JS's `Math.round`.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The palette for the appearance shown: a canvas takes one color each.
#[derive(Clone, Copy)]
struct Palette {
    dark: bool,
    surface: Hsla,
    inset: Hsla,
    raised: Hsla,
    border: Hsla,
    line: Hsla,
    text: Hsla,
    muted: Hsla,
    faint: Hsla,
    accent: Hsla,
    accent_fill: Hsla,
    info: Hsla,
    warn: Hsla,
    danger: Hsla,
}

impl Palette {
    /// The palette of the appearance now (read in a canvas's binding, it
    /// draws again when the appearance changes).
    fn now() -> Self {
        Self {
            dark: dark(),
            surface: color(colors::SURFACE),
            inset: color(colors::INSET),
            raised: color(colors::RAISED),
            border: color(colors::BORDER),
            line: color(colors::LINE),
            text: color(colors::TEXT),
            muted: color(colors::MUTED),
            faint: color(colors::FAINT),
            accent: color(colors::ACCENT),
            accent_fill: color(colors::ACCENT_FILL),
            info: color(colors::INFO),
            warn: color(colors::WARN),
            danger: color(colors::DANGER),
        }
    }
}

/// `color` at alpha `a` (TS `alpha(color, a)`; the palette's colors are
/// opaque).
fn alpha(color: impl Into<Hsla>, a: f32) -> Hsla {
    color.into().opacity(a)
}

/// Diagonal hatching over the current clip (inside save / clip / restore).
fn hatch(mut p: Painter, (x, y, w, h): (f32, f32, f32, f32), color: Hsla, gap: f32) -> Painter {
    p = p.stroke_color(color).line_width(1.0).begin_path();
    let mut i = -h;
    while i < w {
        p = p.move_to(x + i, y + h).line_to(x + i + h, y);
        i += gap;
    }
    p.stroke()
}

/// A dashed horizontal or vertical reference line.
fn dashed(p: Painter, (x0, y0): (f32, f32), (x1, y1): (f32, f32), color: Hsla) -> Painter {
    p.save()
        .line_dash(&lengths([3.0, 4.0]))
        .stroke_color(color)
        .line_width(1.0)
        .begin_path()
        .move_to(x0, y0)
        .line_to(x1, y1)
        .stroke()
        .restore()
}

/// A rectangle whose width is an animated value (the reveals' clips).
fn rect_of(mut p: Painter, x: f32, y: f32, w: &AnimatedNode, h: f32) -> Painter {
    let w = p.num(w);
    p.op(CanvasOp::Path(PathOp::Rect([
        Num::Const(x),
        Num::Const(y),
        w,
        Num::Const(h),
    ])))
}

/// A canvas `height` tall, drawn by `draw(palette, width)` once laid out,
/// and again when its width, the appearance or what `draw` reads changes.
fn measured(height: f32, draw: impl Fn(Palette, f32) -> Painter + 'static) -> CanvasView {
    let width = signal(0.0_f32);
    canvas(move || {
        let width = width.get();
        if width > 0.0 {
            draw(Palette::now(), width)
        } else {
            Painter::new()
        }
    })
    .h(px(height))
    .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
}

/// A value that sweeps 0 → 1 once mounted and again on [`replay`]:
/// canvases clip to it.
fn reveal(duration: f32) -> AnimatedValue {
    let t = animated_value(0.0);
    replay(&t, duration);
    t
}

fn replay(t: &AnimatedValue, duration: f32) {
    t.set(0.0);
    t.timing(1.0, duration, Easing::Curve(Curve::Cubic, EaseMode::Out));
}

/// A secondary button of a card's header.
fn header_button(label: &'static str, on_press: impl Into<Listener<()>>) -> Button {
    Button::new(label, on_press).variant(ButtonVariant::Secondary)
}

/// A row of legends.
fn legends(items: impl IntoIterator<Item = (AdaptiveColor, &'static str)>) -> View {
    view().flex_row().gap_4().children(
        items
            .into_iter()
            .map(|(color, label)| legend(color, label, None::<&str>)),
    )
}

// ---------------------------------------------------------------------------
// A dial: a tick ring, a hatched red zone, a gradient sweep and a needle, all
// bound to one animated value. Springing it moves the needle on the UI thread.

/// The dial's presets: label and load.
const PRESETS: [(&str, u32); 3] = [("Idle", 18), ("Cruise", 57), ("Peak", 91)];

/// The load of preset `preset`.
fn load_of(preset: u32) -> u32 {
    PRESETS[preset as usize].1
}

/// The dial at `load`, its needle and sweep bound to `needle`.
fn draw_dial(c: Palette, width: f32, height: f32, needle: &AnimatedValue, load: u32) -> Painter {
    let (a0, a1) = (0.75 * PI, 2.25 * PI);
    let angle = needle.interpolate(&[0.0, 100.0], &[a0, a1]);
    let (cx, cy) = (width / 2.0, height * 0.54);
    let r = (width / 2.0 - 8.0).min(height * 0.5) - 6.0;
    let at = |v: f32| a0 + v / 100.0 * (a1 - a0);
    // The red zone: an annular sector, hatched.
    let mut p = Painter::new()
        .save()
        .begin_path()
        .arc(cx, cy, r + 2.0, at(85.0), a1)
        .arc_counterclockwise(cx, cy, r - 20.0, a1, at(85.0))
        .close_path()
        .clip()
        .fill_color(alpha(c.danger, 0.08));
    // The zone sits right of the hub, from just above it to 45° below.
    let zone = (cx + 0.6 * r, cy - 0.2 * r, 0.4 * r + 4.0, r);
    p = p.fill_rect(zone.0, zone.1, zone.2, zone.3);
    p = hatch(p, zone, alpha(c.danger, 0.55), 5.0).restore();
    // The tick ring.
    for i in 0..=50 {
        let a = at(i as f32 * 2.0);
        let major = i % 10 == 0;
        let inner = r - if major { 14.0 } else { 8.0 };
        p = p
            .stroke_color(if i * 2 >= 85 {
                c.danger
            } else if major {
                c.muted
            } else {
                c.faint
            })
            .line_width(if major { 2.0 } else { 1.0 })
            .line_cap(LineCap::Round)
            .begin_path()
            .move_to(cx + a.cos() * inner, cy + a.sin() * inner)
            .line_to(cx + a.cos() * r, cy + a.sin() * r)
            .stroke();
        if major {
            p = p
                .font(&sans(11.0, 400))
                .fill_color(c.faint)
                .text_align(CanvasTextAlign::Center)
                .text_baseline(CanvasTextBaseline::Middle)
                .fill_text(
                    &(i * 2).to_string(),
                    cx + a.cos() * (r - 28.0),
                    cy + a.sin() * (r - 28.0),
                );
        }
    }
    // The sweep: a track, then a conic gradient arc ending at the needle.
    let sr = r + 12.0;
    p = p
        .line_width(5.0)
        .line_cap(LineCap::Round)
        .stroke_color(c.raised)
        .begin_path()
        .arc(cx, cy, sr, a0, a1)
        .stroke()
        .stroke_style(
            CanvasGradient::conic(Radians(a0 - 0.2), pt(cx, cy))
                .add_color_stop(percentage(0.0), c.info)
                .add_color_stop(percentage(0.45), c.accent)
                .add_color_stop(percentage(0.75), c.warn)
                .add_color_stop(percentage(0.8), c.danger),
        )
        .begin_path()
        .arc(cx, cy, sr, a0, &angle)
        .stroke();
    // The readout (redrawn only when the preset changes).
    p = p
        .text_align(CanvasTextAlign::Center)
        .text_baseline(CanvasTextBaseline::Alphabetic)
        .font(&sans(40.0, 600))
        .fill_color(c.text)
        .fill_text(&load.to_string(), cx, cy + r * 0.62)
        .font(&sans(11.0, 400))
        .fill_color(c.faint)
        .fill_text("% load", cx, cy + r * 0.62 + 18.0);
    // The needle, rotated natively.
    let shade = if c.dark {
        rgba(0x0000_0099).into()
    } else {
        alpha(rgb(0x14140a), 0.3)
    };
    p.save()
        .translate(cx, cy)
        .rotate(&angle)
        .shadow(shade, px(6.0), pt(0.0, 0.0))
        .fill_color(c.text)
        .begin_path()
        .move_to(-14.0, -3.0)
        .line_to(r - 18.0, 0.0)
        .line_to(-14.0, 3.0)
        .close_path()
        .fill()
        .restore()
        .fill_color(c.raised)
        .stroke_color(c.text)
        .line_width(2.0)
        .begin_path()
        .arc(cx, cy, 7.0, 0.0, TAU)
        .fill()
        .stroke()
}

/// The dial's card: a preset springs the needle there.
#[component]
fn Dial() -> impl IntoElement {
    let preset = signal(1_u32);
    let needle = animated_value(0.0);
    needle.spring(load_of(1) as f32, spring(90.0, 9.0));
    let height = 230.0;
    let load = computed(move || load_of(preset.get()));
    let zone = computed(move || {
        let load = load.get();
        if load >= 85 {
            ("Redline", Tone::Danger)
        } else if load >= 60 {
            ("High", Tone::Warn)
        } else {
            ("Nominal", Tone::Up)
        }
    });
    Card::new()
        .icon(IconName::Spark)
        .title("Turbine 3 load")
        .subtitle("Needle and sweep on one animated value")
        .child(measured(height, move |c, width| {
            draw_dial(c, width, height, &needle, load.get())
        }))
        .child(
            segmented()
                .options(PRESETS.map(|(label, _)| Segment::new(label)))
                .selected(preset)
                .on_change(move |&to: &u32| {
                    preset.set(to);
                    needle.spring(load_of(to) as f32, spring(140.0, 11.0));
                }),
        )
        .child(
            view()
                .flex_row()
                .child(
                    Stat::new("Zone", move || zone.get().0)
                        .tone(move || zone.get().1)
                        .width(0.33),
                )
                .child(
                    Stat::new("Spool", move || {
                        format!("{} rpm", grouped(load.get() * 128))
                    })
                    .width(0.33),
                )
                .child(Stat::new("Limit", "85 %").tone(Tone::Danger).width(0.33)),
        )
}

fn spring(stiffness: f32, damping: f32) -> Spring {
    Spring {
        stiffness,
        damping,
        mass: 1.0,
        velocity: None,
    }
}

/// 7296 → "7,296".
fn grouped(n: u32) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// An area chart: gradient fill, a line, a dashed average, a hatched window,
// labels measured with measure_text. New data sweeps in natively.

/// Fourteen days of data (TS `fresh`).
fn fresh(mut rand: impl FnMut() -> f64) -> Vec<f64> {
    (0..14)
        .map(|i| round(28.0 + 40.0 * (i as f64 / 2.2).sin().powi(2) + rand() * 26.0))
        .collect()
}

/// The data's average.
fn avg(data: &[f64]) -> f64 {
    round(data.iter().sum::<f64>() / data.len() as f64)
}

/// The data's last value.
fn last(data: &[f64]) -> f64 {
    data[data.len() - 1]
}

/// The area chart of `data`, its data clipped to `sweep`.
fn draw_area(c: Palette, width: f32, height: f32, data: &[f64], sweep: &AnimatedValue) -> Painter {
    let values: Vec<f32> = data.iter().map(|v| *v as f32).collect();
    let font = sans(11.0, 400);
    let measure = |s: &str| measure_text(&font, s).0;
    let (left, right, top, bottom) = (measure("100") + 8.0, 4.0, 16.0, 20.0);
    let w = width - left - right;
    let h = height - top - bottom;
    let x = |i: usize| left + i as f32 / (values.len() - 1) as f32 * w;
    let y = |v: f32| top + h - v / 100.0 * h;
    // Grid and labels.
    let mut p = Painter::new()
        .font(&font)
        .text_baseline(CanvasTextBaseline::Middle);
    for v in [0.0, 50.0, 100.0] {
        p = dashed(p, (left, y(v)), (width - right, y(v)), c.line);
        let label = format!("{v}");
        p = p
            .fill_color(c.faint)
            .fill_text(&label, left - 8.0 - measure(&label), y(v));
    }
    // The deploy window: hatched.
    let (wx, ww) = (x(9), x(11) - x(9));
    p = p.save().begin_path().rect(rect(wx, top, ww, h)).clip();
    p = hatch(p, (wx, top, ww, h), alpha(c.warn, 0.28), 6.0)
        .restore()
        .fill_color(c.warn)
        .text_baseline(CanvasTextBaseline::Alphabetic)
        .fill_text("deploy", wx + 2.0, top - 4.0);
    // Day labels.
    p = p.fill_color(c.faint);
    for i in [0, 7, 13] {
        let label = if i == 13 {
            "now".to_owned()
        } else {
            format!("d-{}", 13 - i)
        };
        let lw = measure(&label);
        p = p.fill_text(
            &label,
            (width - right - lw).min(left.max(x(i) - lw / 2.0)),
            height - 4.0,
        );
    }
    // Everything data-driven sweeps in left to right (a native clip).
    p = p.save().begin_path();
    p = rect_of(p, left - 6.0, 0.0, &sweep.mul(w + 12.0), height).clip();
    p = p.begin_path().move_to(x(0), y(values[0]));
    for (i, v) in values.iter().enumerate().skip(1) {
        p = p.line_to(x(i), y(*v));
    }
    p = p
        .line_to(x(values.len() - 1), top + h)
        .line_to(x(0), top + h)
        .close_path()
        .fill_style(
            CanvasGradient::linear(pt(0.0, top), pt(0.0, top + h))
                .add_color_stop(percentage(0.0), alpha(c.accent, 0.26))
                .add_color_stop(percentage(1.0), alpha(c.accent, 0.0)),
        )
        .fill()
        .begin_path();
    for (i, v) in values.iter().enumerate() {
        p = if i == 0 {
            p.move_to(x(i), y(*v))
        } else {
            p.line_to(x(i), y(*v))
        };
    }
    p = p
        .stroke_color(c.accent)
        .line_width(2.0)
        .line_join(LineJoin::Round)
        .stroke();
    for (i, v) in values.iter().enumerate() {
        p = p
            .begin_path()
            .arc(
                x(i),
                y(*v),
                if i == values.len() - 1 { 4.5 } else { 2.5 },
                0.0,
                TAU,
            )
            .fill_color(c.inset)
            .fill()
            .stroke_color(c.accent)
            .line_width(1.5)
            .stroke();
    }
    p = p.restore();
    // The average, with a pill label measured to fit.
    let mean = avg(data) as f32;
    p = dashed(p, (left, y(mean)), (width - right, y(mean)), c.muted);
    let label = format!("avg {mean}");
    let lw = measure(&label) + 12.0;
    p.fill_color(c.raised)
        .begin_path()
        .round_rect(rect(width - right - lw, y(mean) - 9.0, lw, 18.0), px(9.0))
        .fill()
        .fill_color(c.text)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(&label, width - right - lw + 6.0, y(mean))
}

/// The area chart's card: "New" sweeps new data in.
#[component]
fn AreaChart() -> impl IntoElement {
    let data = signal(fresh(seeded(7)));
    let sweep = reveal(1100.0);
    let height = 180.0;
    let figures = computed(move || data.with(|data| (last(data), avg(data))));
    let up = computed(move || {
        let (last, avg) = figures.get();
        last >= avg
    });
    Card::new()
        .icon(IconName::Stocks)
        .title("Relay throughput")
        .subtitle("Area · average · hatching")
        .right(header_button("New", move |_: &()| {
            data.set(fresh(random));
            replay(&sweep, 1100.0);
        }))
        .child(
            Figure::new(move || {
                let last = figures.get().0;
                format!("{last}.{}", (last * 7.0) % 10.0)
            })
            .unit("k/s")
            .note(move || {
                let (last, avg) = figures.get();
                format!(
                    "{}{} vs. average",
                    if up.get() { "+" } else { "−" },
                    (last - avg).abs()
                )
            })
            .tone(move || if up.get() { Tone::Up } else { Tone::Down }),
        )
        .child(measured(height, move |c, width| {
            data.with(|data| draw_area(c, width, height, data, &sweep))
        }))
        .child(legends([
            (colors::ACCENT, "Messages"),
            (colors::MUTED, "Average"),
            (colors::WARN, "Deploy"),
        ]))
}

// ---------------------------------------------------------------------------
// A ridgeline: one smooth curve per day, overlapping, each a low-alpha fill.

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// Each day's footfall by hour (25 points, as the TSX gallery's).
fn ridges() -> Vec<Vec<f32>> {
    (0..DAYS.len())
        .map(|d| {
            let mut rand = seeded(100 + d as u32);
            let peaks = [6.0 + rand() * 4.0, 12.0 + rand() * 3.0, 17.0 + rand() * 4.0];
            let weights = [0.5 + rand() * 0.5, 0.4 + rand() * 0.6, 0.3 + rand() * 0.7]
                .map(|w| if d >= 5 { w * 0.55 } else { w });
            (0..25)
                .map(|h| {
                    peaks.iter().zip(weights).fold(0.04, |s, (p, w)| {
                        s + w * (-((h as f64 - p).powi(2)) / 6.0).exp()
                    }) as f32
                })
                .collect()
        })
        .collect()
}

/// The ridgeline, its curves clipped to `sweep`.
fn draw_ridges(c: Palette, width: f32, height: f32, sweep: &AnimatedValue) -> Painter {
    let font = sans(11.0, 400);
    let measure = |s: &str| measure_text(&font, s).0;
    let left = measure("Mon") + 10.0;
    let bottom = 18.0;
    let step = (height - bottom - 30.0) / (DAYS.len() - 1) as f32;
    let x = |h: f32| left + h / 24.0 * (width - left);
    // Peak window and hour labels.
    let mut p = Painter::new().font(&font);
    p = dashed(p, (x(12.0), 0.0), (x(12.0), height - bottom), c.border);
    p = dashed(p, (x(14.0), 0.0), (x(14.0), height - bottom), c.border);
    p = p
        .fill_color(c.faint)
        .text_baseline(CanvasTextBaseline::Alphabetic);
    for h in [0, 6, 12, 18, 24] {
        let label = format!("{h:02}");
        let lw = measure(&label);
        p = p.fill_text(
            &label,
            (width - lw).min(left.max(x(h as f32) - lw / 2.0)),
            height - 3.0,
        );
    }
    p = p.save().begin_path();
    p = rect_of(p, 0.0, 0.0, &sweep.mul(width), height).clip();
    for (d, series) in ridges().iter().enumerate() {
        let base = 30.0 + d as f32 * step;
        let y = |v: f32| base - v * 46.0;
        p = p
            .begin_path()
            .move_to(x(0.0), base)
            .line_to(x(0.0), y(series[0]));
        for h in 1..series.len() {
            let (x0, x1) = (x(h as f32 - 1.0), x(h as f32));
            p = p.quadratic_curve_to(
                pt(x0, y(series[h - 1])),
                pt((x0 + x1) / 2.0, (y(series[h - 1]) + y(series[h])) / 2.0),
            );
        }
        let weekend = d >= 5;
        // Occlude the ridge behind, then a low-alpha fill and the line.
        p = p
            .line_to(x(24.0), y(series[24]))
            .line_to(x(24.0), base)
            .close_path()
            .fill_color(c.inset)
            .fill()
            .fill_color(if weekend {
                alpha(c.info, 0.18)
            } else {
                alpha(c.accent, 0.1 + d as f32 * 0.025)
            })
            .fill()
            .stroke_color(if weekend { c.info } else { c.accent })
            .line_width(1.25)
            .stroke();
    }
    p = p.restore().fill_color(c.muted);
    for (d, day) in DAYS.iter().enumerate() {
        p = p.fill_text(day, 0.0, 30.0 + d as f32 * step - 2.0);
    }
    p
}

/// The ridgeline's card: "Replay" sweeps it in again.
#[component]
fn Ridgeline() -> impl IntoElement {
    let sweep = reveal(1400.0);
    let height = 210.0;
    Card::new()
        .icon(IconName::Animation)
        .title("Footfall by hour")
        .subtitle("Ridgeline, one curve a day")
        .right(header_button("Replay", move |_: &()| {
            replay(&sweep, 1400.0)
        }))
        .child(caption("Gate B, last week", Some("Peak 12:00–14:00")))
        .child(measured(height, move |c, width| {
            draw_ridges(c, width, height, &sweep)
        }))
        .child(legends([
            (colors::ACCENT, "Weekday"),
            (colors::INFO, "Weekend"),
        ]))
}

// ---------------------------------------------------------------------------
// A dot matrix: uptime per hour block, a pulse on the newest dot (native
// loop).

/// The dot levels, from none to full.
fn levels() -> [AdaptiveColor; 5] {
    [
        colors::RAISED,
        colors::ACCENT.opacity(0.22),
        colors::ACCENT.opacity(0.45),
        colors::ACCENT.opacity(0.7),
        colors::ACCENT,
    ]
}

/// The dot matrix, its newest dot pulsing with `pulse`.
fn draw_dots(c: Palette, width: f32, height: f32, pulse: &AnimatedValue) -> Painter {
    let levels = levels().map(color);
    let (rows, gap) = (7, 12.5);
    let cols = (width / gap).floor() as i32;
    let ox = (width - (cols - 1) as f32 * gap) / 2.0;
    let oy = (height - (rows - 1) as f32 * gap) / 2.0;
    let mut rand = seeded(42);
    let (mut last_x, mut last_y) = (0.0, 0.0);
    let mut p = Painter::new();
    for col in 0..cols {
        for row in 0..rows {
            let n = rand() as f32;
            let incident =
                (col == 6 && row == 2) || (col == 17 && row == 5) || (col == cols - 4 && row == 3);
            let level = ((n * n * 5.0 + col as f32 / cols as f32 * 1.6).floor() as usize).min(4);
            last_x = ox + col as f32 * gap;
            last_y = oy + row as f32 * gap;
            p = p
                .fill_color(if incident { c.danger } else { levels[level] })
                .begin_path()
                .arc(last_x, last_y, 3.6, 0.0, TAU)
                .fill();
        }
    }
    // The pulse: radius and alpha follow a native loop.
    p.save()
        .global_alpha(&pulse.interpolate(&[0.0, 1.0], &[0.9, 0.0]))
        .stroke_color(c.accent)
        .line_width(1.5)
        .begin_path()
        .arc(
            last_x,
            last_y,
            &pulse.interpolate(&[0.0, 1.0], &[4.0, 11.0]),
            0.0,
            TAU,
        )
        .stroke()
        .restore()
}

/// The dot matrix's card.
#[component]
fn DotMatrix() -> impl IntoElement {
    let pulse = animated_value(0.0);
    let looped = Animation::timing(
        &pulse,
        1.0,
        Timing::new(1400.0, Easing::Curve(Curve::Quad, EaseMode::Out)),
    )
    .looped(None);
    looped.start();
    // Kept with the card: dropping the last handle releases the loop.
    stored(looped);
    let height = 96.0;
    let quiet = |s: &'static str| text(s).text_size(px(13.0)).text_color(colors::MUTED);
    Card::new()
        .icon(IconName::Bell)
        .title("Beacon uptime")
        .subtitle("Dot matrix, one column a day")
        .child(
            Figure::new("99.94")
                .unit("%")
                .note("3 incidents")
                .tone(Tone::Danger),
        )
        .child(measured(height, move |c, width| {
            draw_dots(c, width, height, &pulse)
        }))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(quiet("Less"))
                .children(levels().map(|color| view().size(px(9.0)).rounded(px(2.5)).bg(color)))
                .child(quiet("More").flex_1())
                .child(legend(colors::DANGER, "Incident", None::<&str>)),
        )
}

// ---------------------------------------------------------------------------
// A dumbbell plot: before → after per row, the after dots travel natively
// (one value, staggered through each row's input range).

/// Each route's latency before and after, in ms.
const ROUTES: [(&str, f32, f32); 6] = [
    ("North Gate", 182.0, 96.0),
    ("Harbor", 240.0, 131.0),
    ("Old Mill", 128.0, 104.0),
    ("Ridge", 205.0, 88.0),
    ("Lowfield", 96.0, 71.0),
    ("Quarry", 151.0, 160.0),
];

/// The dumbbell plot, its after dots travelling with `t`.
fn draw_dumbbell(c: Palette, width: f32, height: f32, t: &AnimatedValue) -> Painter {
    let (name_font, small) = (sans(13.0, 400), sans(11.0, 400));
    let left = ROUTES
        .iter()
        .map(|r| measure_text(&name_font, r.0).0)
        .fold(0.0, f32::max)
        + 12.0;
    let right = measure_text(&small, "+00%").0 + 10.0;
    let max = 250.0;
    let x = |ms: f32| left + ms / max * (width - left - right);
    let mut p = Painter::new()
        .font(&small)
        .text_baseline(CanvasTextBaseline::Alphabetic);
    for ms in [0.0, 100.0, 200.0] {
        p = dashed(p, (x(ms), 0.0), (x(ms), height - 18.0), c.line);
        let label = format!("{ms}");
        p = p.fill_color(c.faint).fill_text(
            &label,
            x(ms) - measure_text(&small, &label).0 / 2.0,
            height - 3.0,
        );
    }
    for (i, &(name, before, after)) in ROUTES.iter().enumerate() {
        let cy = 15.0 + i as f32 * 30.0;
        let start = i as f32 * 0.07;
        let to = t.interpolate(&[start, start + 0.6], &[x(before), x(after)]);
        let worse = after > before;
        let tone = if worse { c.danger } else { c.accent };
        let pct = round(((after - before) / before * 100.0) as f64) as i32;
        let label = format!("{}{pct}%", if pct > 0 { "+" } else { "" });
        p = p
            .font(&name_font)
            .fill_color(c.muted)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(name, 0.0, cy)
            .stroke_color(if worse {
                alpha(c.danger, 0.5)
            } else {
                alpha(c.accent, 0.45)
            })
            .line_width(3.0)
            .line_cap(LineCap::Round)
            .begin_path()
            .move_to(x(before), cy)
            .line_to(&to, cy)
            .stroke()
            .fill_color(c.inset)
            .stroke_color(c.muted)
            .line_width(1.5)
            .begin_path()
            .arc(x(before), cy, 4.5, 0.0, TAU)
            .fill()
            .stroke()
            .fill_color(tone)
            .begin_path()
            .arc(&to, cy, 5.5, 0.0, TAU)
            .fill()
            .font(&small)
            .fill_color(tone)
            .fill_text(&label, width - measure_text(&small, &label).0, cy);
    }
    p
}

/// Moves the after dots from the before ones again.
fn play(t: &AnimatedValue) {
    t.set(0.0);
    t.timing(1.0, 1500.0, Easing::Curve(Curve::Cubic, EaseMode::Out));
}

/// The dumbbell plot's card: "Replay" moves its dots again.
#[component]
fn Dumbbell() -> impl IntoElement {
    let t = animated_value(0.0);
    play(&t);
    let height = 30.0 * ROUTES.len() as f32 + 24.0;
    Card::new()
        .icon(IconName::Physics)
        .title("Route latency")
        .subtitle("Dumbbell, before → after")
        .right(header_button("Replay", move |_: &()| play(&t)))
        .child(measured(height, move |c, width| {
            draw_dumbbell(c, width, height, &t)
        }))
        .child(legends([
            (colors::MUTED, "Before"),
            (colors::ACCENT, "After"),
            (colors::DANGER, "Regressed"),
        ]))
}

// ---------------------------------------------------------------------------
// A clock: transforms, save / restore, a second hand rotating natively.

/// The clock's face, its second hand turned by `seconds`.
fn draw_clock(c: Palette, size: f32, seconds: &AnimatedValue) -> Painter {
    let r = size / 2.0;
    let mut p = Painter::new()
        .translate(r, r)
        .fill_color(c.surface)
        .stroke_color(c.border)
        .line_width(1.5)
        .begin_path()
        .arc(0.0, 0.0, r - 2.0, 0.0, TAU)
        .fill()
        .stroke();
    for i in 0..60 {
        let hour = i % 5 == 0;
        p = p
            .save()
            .rotate(i as f32 / 60.0 * TAU)
            .stroke_color(if hour { c.muted } else { c.faint })
            .line_width(if hour { 2.0 } else { 1.0 })
            .begin_path()
            .move_to(r - 8.0, 0.0)
            .line_to(r - if hour { 17.0 } else { 12.0 }, 0.0)
            .stroke()
            .restore();
    }
    let hand = |p: Painter, angle: f32, length: f32, width: f32| {
        p.save()
            .rotate(angle - FRAC_PI_2)
            .stroke_color(c.text)
            .line_width(width)
            .line_cap(LineCap::Round)
            .begin_path()
            .move_to(-8.0, 0.0)
            .line_to(length, 0.0)
            .stroke()
            .restore()
    };
    p = hand(p, 10.0 / 12.0 * TAU, r * 0.48, 4.5);
    p = hand(p, 10.0 / 60.0 * TAU, r * 0.7, 3.0);
    p.save()
        .rotate(&seconds.mul(TAU / 60.0))
        .rotate(-FRAC_PI_2)
        .stroke_color(c.accent)
        .line_width(1.5)
        .begin_path()
        .move_to(-14.0, 0.0)
        .line_to(r * 0.8, 0.0)
        .stroke()
        .restore()
        .fill_color(c.accent)
        .begin_path()
        .arc(0.0, 0.0, 4.0, 0.0, TAU)
        .fill()
}

/// The clock's card.
#[component]
fn Clock() -> impl IntoElement {
    let seconds = animated_value(0.0);
    let spin =
        Animation::timing(&seconds, 60.0, Timing::new(60_000.0, Easing::Linear)).looped(None);
    spin.start();
    // Kept with the card: dropping the last handle releases the loop.
    stored(spin);
    let size = 150.0;
    Card::new()
        .icon(IconName::Search)
        .title("Transforms")
        .subtitle("translate · rotate · save / restore")
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_4()
                .child(canvas(move || draw_clock(Palette::now(), size, &seconds)).size(px(size)))
                .child(
                    view()
                        .flex_1()
                        .gap_2()
                        .child(caption("Ticks", Some("60 rotations")))
                        .child(caption("Hands", Some("save, restore")))
                        .child(caption("Second hand", Some("Native loop"))),
                ),
        )
}

// ---------------------------------------------------------------------------
// Path2D: SVG path data, filled or stroked.

/// The glyphs: name, SVG path data, color, stroked.
const GLYPHS: [(&str, &str, AdaptiveColor, bool); 4] = [
    (
        "Heart",
        "M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z",
        colors::DANGER,
        false,
    ),
    (
        "Star",
        "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01z",
        colors::WARN,
        false,
    ),
    ("Bolt", "M13 2L3 14h7l-1 8 10-12h-7z", colors::INFO, false),
    ("Check", "M20 6L9 17l-5-5", colors::ACCENT, true),
];

/// SVG paths, each drawn in its color.
#[component]
fn Glyphs() -> impl IntoElement {
    let glyphs = GLYPHS.map(|(name, d, tint, stroke)| {
        let path = svg_path(d);
        // Drawn again in the appearance's color.
        let glyph = move || {
            let color = color(tint);
            let p = Painter::new().scale(30.0 / 24.0, 30.0 / 24.0);
            if stroke {
                p.stroke_color(color)
                    .line_width(2.5)
                    .line_cap(LineCap::Round)
                    .line_join(LineJoin::Round)
                    .stroke_path(&path)
            } else {
                p.fill_color(color).fill_path(&path, FillRule::NonZero)
            }
        };
        view()
            .items_center()
            .gap_2()
            .child(
                view()
                    .size(px(60.0))
                    .rounded(px(18.0))
                    .border_curve(BorderCurve::Continuous)
                    .bg(colors::RAISED)
                    .finish(Finish::Raised)
                    .border_1()
                    .border_color(colors::BORDER)
                    .items_center()
                    .justify_center()
                    .child(canvas(glyph).size(px(30.0))),
            )
            .child(text(name).text_size(px(13.0)).text_color(colors::MUTED))
    });
    Card::new()
        .icon(IconName::Star)
        .title("Path2D")
        .subtitle("SVG path data, parsed natively")
        .child(view().flex_row().justify_between().children(glyphs))
}

// ---------------------------------------------------------------------------
// Images, clipping, shadows, compositing, dashes, radial gradients.

/// The compositing samples.
fn draw_compositing(c: Palette, width: f32, height: f32) -> Painter {
    let cy = height / 2.0;
    // An image clipped to a circle, with a ring.
    let p = Painter::new()
        .save()
        .begin_path()
        .arc(46.0, cy, 42.0, 0.0, TAU)
        .clip()
        .fill_color(c.raised)
        .fill_rect(0.0, 0.0, 92.0, height)
        .draw_image(crate::assets::LOGO.url, rect(10.0, cy - 36.0, 72.0, 72.0))
        .restore()
        .stroke_color(c.border)
        .line_width(1.5)
        .begin_path()
        .arc(46.0, cy, 42.0, 0.0, TAU)
        .stroke();
    // A shadowed card with a hole punched through (destination-out).
    let cx = width / 2.0;
    let shade = if c.dark {
        rgba(0x0000_00b3).into()
    } else {
        alpha(rgb(0x14140a), 0.25)
    };
    let p = p
        .save()
        .shadow(shade, px(14.0), pt(0.0, 6.0))
        .fill_style(
            CanvasGradient::linear(pt(cx - 46.0, 0.0), pt(cx + 46.0, height))
                .add_color_stop(percentage(0.0), c.accent_fill)
                .add_color_stop(percentage(1.0), rgb(0x7fbf3a)),
        )
        .begin_path()
        .round_rect(rect(cx - 46.0, cy - 40.0, 92.0, 80.0), px(16.0))
        .fill()
        .restore()
        .composite(Composite::DestinationOut)
        .begin_path()
        .arc(cx, cy, 18.0, 0.0, TAU)
        .fill()
        .composite(Composite::SourceOver);
    // A radial gradient with a dashed outline.
    let rx = width - 46.0;
    p.fill_style(
        CanvasGradient::radial(pt(rx - 10.0, cy - 12.0), px(4.0), pt(rx, cy), px(40.0))
            .add_color_stop(percentage(0.0), rgb(0xffe2a8))
            .add_color_stop(percentage(0.55), c.warn)
            .add_color_stop(percentage(1.0), alpha(c.danger, 0.2)),
    )
    .begin_path()
    .arc(rx, cy, 38.0, 0.0, TAU)
    .fill()
    .line_dash(&lengths([5.0, 5.0]))
    .stroke_color(c.warn)
    .line_width(1.5)
    .begin_path()
    .arc(rx, cy, 43.0, 0.0, TAU)
    .stroke()
}

/// The compositing card.
#[component]
fn Compositing() -> impl IntoElement {
    let height = 120.0;
    let label = |s: &'static str| text(s).text_size(px(13.0)).text_color(colors::MUTED);
    Card::new()
        .icon(IconName::Image)
        .title("Compositing")
        .subtitle("Clip, shadow, destination-out, dashes")
        .child(measured(height, move |c, width| {
            draw_compositing(c, width, height)
        }))
        .child(
            view()
                .flex_row()
                .justify_between()
                .child(label("Clipped image"))
                .child(label("Cut-out"))
                .child(label("Radial gradient")),
        )
}

// ---------------------------------------------------------------------------
// Touch drawing: each move draws again. The canvas claims the touches and
// keeps them: the page around it does not scroll while drawing.

/// The sketch over its dot grid, `width` wide (0 before its layout).
fn draw_sketch(c: Palette, width: f32, height: f32, strokes: &[Vec<(f32, f32)>]) -> Painter {
    // A dot grid to draw on.
    let mut p = Painter::new().fill_color(c.border);
    let mut x = 8.0;
    while x < width {
        let mut y = 8.0;
        while y < height {
            p = p.fill_rect(x - 0.75, y - 0.75, 1.5, 1.5);
            y += 16.0;
        }
        x += 16.0;
    }
    if strokes.is_empty() && width > 0.0 {
        p = p
            .font(&sans(14.0, 400))
            .fill_color(c.faint)
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text("Draw here", width / 2.0, height / 2.0);
    }
    p = p
        .stroke_color(c.accent)
        .line_width(3.0)
        .line_cap(LineCap::Round)
        .line_join(LineJoin::Round);
    for stroke in strokes {
        p = p.begin_path();
        for (i, &(x, y)) in stroke.iter().enumerate() {
            p = if i == 0 {
                p.move_to(x, y)
            } else {
                p.line_to(x, y)
            };
        }
        p = p.stroke();
    }
    p
}

/// Touch drawing: each move draws again.
#[component]
fn Sketch() -> impl IntoElement {
    let strokes = signal(Vec::<Vec<(f32, f32)>>::new());
    let width = signal(0.0_f32);
    let height = 200.0;
    let sketch = canvas(move || {
        strokes.with(|strokes| draw_sketch(Palette::now(), width.get(), height, strokes))
    })
    .h(px(height))
    .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
    .claim_touches(TouchClaim::on_start())
    .keep_touches(true)
    .on_responder_grant(move |e: &ResponderEvent| {
        strokes.update(|s| s.push(vec![(e.location.x.0, e.location.y.0)]));
    })
    .on_responder_move(move |e: &ResponderEvent| {
        if strokes.with_untracked(|s| !s.is_empty()) {
            strokes.update(|s| {
                if let Some(stroke) = s.last_mut() {
                    stroke.push((e.location.x.0, e.location.y.0));
                }
            });
        }
    });
    Card::new()
        .icon(IconName::Gestures)
        .title("Sketch")
        .subtitle(hint("Touch → draw from Rust", "Drag → draw from Rust"))
        .right(
            header_button("Clear", move |_: &()| strokes.set(Vec::new()))
                .disabled(Prop::bind(move || strokes.with(Vec::is_empty))),
        )
        .child(sketch)
        .child(caption(
            "Strokes",
            Some(move || {
                strokes.with(|strokes| {
                    let points: usize = strokes.iter().map(Vec::len).sum();
                    format!("{} · {points} points", strokes.len())
                })
            }),
        ))
}

/// The demo's page.
#[component]
pub(crate) fn CanvasDemo() -> impl IntoElement {
    DemoPage::new()
        .columns(3)
        .card(dial)
        .card(area_chart)
        .card(ridgeline)
        .card(dot_matrix)
        .card(dumbbell)
        .card(clock)
        .card(glyphs)
        .card(compositing)
        .card(sketch)
}
