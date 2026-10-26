//! Animations: native loops, easing curves plotted and raced, composed
//! animations (sequence, parallel, stagger, loop) with stop and reset,
//! springs plotted with their live values, interpolation, `diff_clamp` and
//! layout animation (as the TSX gallery's `demos/Animations.tsx`).

use std::{
    cell::Cell,
    f32::consts::{FRAC_PI_2, PI, TAU},
    rc::Rc,
};

use nsh_core::{
    Bounds, Points,
    canvas::{CanvasTextAlign, CanvasTextBaseline, LineJoin},
    element::{
        Animation, LayoutAnimation, LayoutCurve, LayoutTransition, sample_easing, sample_spring,
    },
    prelude::*,
};

use crate::ui::{
    Badge, Button, ButtonVariant, Card, DemoPage, Finish, Finished, IconName, MONO, PressRole,
    Segment, SegmentedSize, Tone, caption, colors, icon, legend, lengths, press, radius, rect,
    segmented, tints,
};

/// The tones of the demos' dots and tiles.
const TONES: [AdaptiveColor; 5] = [
    colors::ACCENT,
    colors::INFO,
    colors::WARN,
    colors::DANGER,
    colors::UP,
];

/// Text on a tone's fill.
const ON_TONE: AdaptiveColor = AdaptiveColor::rgb(0xffffff, 0x13160c);

/// `Easing.inOut(Easing.cubic)`.
const CUBIC_IN_OUT: Easing = Easing::Curve(Curve::Cubic, EaseMode::InOut);

/// `Easing.out(Easing.back())`.
const BACK_OUT: Easing = Easing::Curve(Curve::Back(1.70158), EaseMode::Out);

/// `Easing.inOut(Easing.sin)`.
const SIN_IN_OUT: Easing = Easing::Curve(Curve::Sin, EaseMode::InOut);

/// `Easing.out(Easing.quad)`.
const QUAD_OUT: Easing = Easing::Curve(Curve::Quad, EaseMode::Out);

/// The curves, by name.
const CURVES: [(&str, Easing); 10] = [
    ("linear", Easing::Linear),
    // React Native's `Easing.ease` (CSS `ease`).
    ("ease", Easing::Bezier(0.25, 0.1, 0.25, 1.0)),
    ("quad out", QUAD_OUT),
    ("cubic inOut", CUBIC_IN_OUT),
    ("sin in", Easing::Curve(Curve::Sin, EaseMode::In)),
    ("circle out", Easing::Curve(Curve::Circle, EaseMode::Out)),
    ("exp inOut", Easing::Curve(Curve::Exp, EaseMode::InOut)),
    ("back out", BACK_OUT),
    (
        "elastic out",
        Easing::Curve(Curve::Elastic(1.0), EaseMode::Out),
    ),
    ("bounce out", Easing::Curve(Curve::Bounce, EaseMode::Out)),
];

/// A spring of stiffness `k` and damping `c`, mass 1.
const fn spring(k: f32, c: f32) -> Spring {
    Spring {
        stiffness: k,
        damping: c,
        mass: 1.0,
        velocity: None,
    }
}

/// `Animated.timing`'s curve when it names none.
fn ms(duration_ms: f32) -> Timing {
    Timing {
        duration_ms,
        ..Timing::default()
    }
}

/// A number in `0..1` (TS: `Math.random()`): xorshift, seeded by the clock.
fn random() -> f32 {
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
        (x >> 40) as f32 / (1u64 << 24) as f32
    })
}

/// A plain label with the API it uses, in code type.
fn api(label: &'static str, api: &'static str) -> View {
    view()
        .flex_row()
        .items_baseline()
        .gap_2()
        .child(
            text(label)
                .flex_1()
                .text_size(px(13.0))
                .text_color(colors::MUTED),
        )
        .child(
            text(api)
                .text_size(px(12.0))
                .font_family(MONO)
                .text_color(colors::FAINT),
        )
}

/// A selectable capsule (36 pt, with hit slop up to 44), lit while
/// `active`.
fn chip(
    label: &'static str,
    active: Memo<bool>,
    on_press: impl Into<Listener<()>>,
) -> impl IntoElement {
    let on_press: Listener<()> = on_press.into();
    press()
        .hit_slop(4.0)
        .role(PressRole::Tab)
        .selected(move || active.get())
        .on_press(on_press)
        .child(
            view()
                .h(px(36.0))
                .px(px(14.0))
                .rounded(px(18.0))
                .justify_center()
                .style_when(
                    move || !active.get(),
                    |s| {
                        s.bg(colors::RAISED)
                            .finish(Finish::Raised)
                            .border_1()
                            .border_color(colors::BORDER)
                    },
                )
                .style_when(active, |s| s.bg(colors::LIGHT).finish(Finish::Light))
                .child(
                    text(label)
                        .text_size(px(13.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(move || {
                            if active.get() {
                                colors::ON_LIGHT
                            } else {
                                colors::TEXT
                            }
                        }),
                ),
        )
}

// --- Hero -------------------------------------------------------------------

/// The hero's size.
const S: f32 = 188.0;

/// An orbit of `size` turning by `angle`, with a dot of `dot` on it.
fn orbit(size: f32, angle: &AnimatedNode, color: AdaptiveColor, dot: f32) -> View {
    view()
        .pointer_events(PointerEvents::None)
        .absolute()
        .left(px((S - size) / 2.0))
        .top(px((S - size) / 2.0))
        .size(px(size))
        .rounded(px(size / 2.0))
        .border_1()
        .border_color(colors::LINE)
        .bind_rotate(angle)
        .child(
            view()
                .absolute()
                .left(px(size / 2.0 - dot / 2.0))
                .top(px(-dot / 2.0))
                .size(px(dot))
                .rounded(px(dot / 2.0))
                .bg(color)
                .finish(Finish::Knob),
        )
}

/// An orbit, pulsing rings and a breathing core: three loops, started
/// once.
#[component]
fn Hero() -> impl IntoElement {
    let spin = animated_value(0.0);
    let rings: Vec<AnimatedValue> = (0..3).map(|_| animated_value(0.0)).collect();
    let breathe = animated_value(0.0);
    let all = Animation::parallel([
        Animation::timing(&spin, 360.0, Timing::new(3200.0, Easing::Linear)).looped(None),
        Animation::stagger(
            800.0,
            rings.iter().map(|r| {
                Animation::timing(
                    r,
                    1.0,
                    Timing::new(2400.0, Easing::Curve(Curve::Cubic, EaseMode::Out)),
                )
                .looped(None)
            }),
        ),
        Animation::sequence([
            Animation::timing(&breathe, 1.0, Timing::new(1300.0, SIN_IN_OUT)),
            Animation::timing(&breathe, 0.0, Timing::new(1300.0, SIN_IN_OUT)),
        ])
        .looped(None),
    ]);
    let _ = all.start();
    cleanup(move || all.stop());
    let rings = rings.iter().map(|r| {
        view()
            .pointer_events(PointerEvents::None)
            .absolute()
            .left(px(34.0))
            .top(px(34.0))
            .size(px(S - 68.0))
            .rounded(px((S - 68.0) / 2.0))
            .border(px(1.5))
            .border_color(colors::ACCENT)
            .bind_opacity(&r.interpolate(&[0.0, 0.15, 1.0], &[0.0, 0.6, 0.0]))
            .bind_scale(&r.interpolate(&[0.0, 1.0], &[0.35, 1.45]))
    });
    // The core's colors follow the appearance natively.
    let core = {
        view()
            .absolute()
            .left(px(S / 2.0 - 26.0))
            .top(px(S / 2.0 - 26.0))
            .size(px(52.0))
            .rounded(px(26.0))
            .items_center()
            .justify_center()
            .bind_background(
                &breathe.interpolate_colors(&[0.0, 1.0], &[colors::ACCENT_FILL, colors::UP]),
            )
            .finish_shadow(Finish::Accent)
            .bind_scale(&breathe.interpolate(&[0.0, 1.0], &[0.9, 1.08]))
            .child(
                icon()
                    .name(IconName::Animation)
                    .size(22.0)
                    .tint(colors::ON_ACCENT),
            )
    };
    Card::new()
        .icon(IconName::Animation)
        .title("Native motion")
        .subtitle("Three loops, started once, run on the UI thread")
        .child(
            view().h(px(S + 8.0)).items_center().justify_center().child(
                view()
                    .size(px(S))
                    .children(rings)
                    .child(orbit(S - 12.0, spin.node(), colors::ACCENT, 10.0))
                    .child(orbit(S - 64.0, &spin.mul(-1.6), colors::INFO, 8.0))
                    .child(core),
            ),
        )
        .child(
            view()
                .gap_2()
                .child(api("Orbits, one turn in 3.2 s", "Animated.loop"))
                .child(api("Rings, 0.8 s apart", "Animated.stagger"))
                .child(api("Core, in and out", "Animated.sequence")),
        )
}

// --- Easing -----------------------------------------------------------------

/// Diagonal hatching inside a rectangle.
fn hatch(p: Painter, color: Hsla, (x, y, w, h): (f32, f32, f32, f32)) -> Painter {
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
        i += 7.0;
    }
    p.stroke().restore()
}

/// The plot's height.
const PLOT: f32 = 196.0;

/// The plot of curve `selected`, `width` wide, its playhead and dot at
/// `px`, `py`.
fn draw_plot(width: f32, selected: usize, px: &AnimatedValue, py: &AnimatedValue) -> Painter {
    let (lo, hi) = (-0.18, 1.24);
    let height = PLOT;
    let (l, r, t, b) = (30.0, width - 12.0, 8.0, height - 8.0);
    let y = |v: f32| b - (v - lo) / (hi - lo) * (b - t);
    let x = |v: f32| l + v * (r - l);
    let shade = color(colors::TEXT.opacity(0.06));
    // Zones outside 0..1: where a curve overshoots.
    let mut p = hatch(Painter::new(), shade, (l, t, r - l, y(1.0) - t));
    p = hatch(p, shade, (l, y(0.0), r - l, b - y(0.0)))
        .stroke_color(color(colors::LINE))
        .line_width(1.0);
    for q in [0.25, 0.5, 0.75] {
        p = p.begin_path().move_to(x(q), t).line_to(x(q), b).stroke();
    }
    p = p
        .line_dash(&lengths([3.0, 4.0]))
        .stroke_color(color(colors::FAINT));
    for v in [0.0, 1.0] {
        p = p.begin_path().move_to(l, y(v)).line_to(r, y(v)).stroke();
    }
    p = p
        .line_dash(&[])
        .font("11px system-ui")
        .fill_color(color(colors::FAINT))
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text("1.0", 2.0, y(1.0))
        .fill_text("0", 2.0, y(0.0));
    // The curve (the native one, sampled), filled faintly beneath.
    let n = 96;
    let f = sample_easing(CURVES[selected].1, n + 1);
    p = p.begin_path().move_to(x(0.0), y(0.0));
    for (i, v) in f.iter().enumerate() {
        p = p.line_to(x(i as f32 / n as f32), y(*v));
    }
    p = p
        .line_to(x(1.0), y(0.0))
        .close_path()
        .fill_color(color(tints::ACCENT))
        .global_alpha(0.6)
        .fill()
        .global_alpha(1.0)
        .begin_path()
        .move_to(x(0.0), y(f[0]));
    for (i, v) in f.iter().enumerate().skip(1) {
        p = p.line_to(x(i as f32 / n as f32), y(*v));
    }
    p = p
        .stroke_color(color(colors::ACCENT))
        .line_width(2.0)
        .line_join(LineJoin::Round)
        .stroke();
    // The playhead and the dot, from animated values.
    let hx = px.mul(r - l).add(l);
    let hy = py
        .mul(-(b - t) / (hi - lo))
        .add(b + lo * (b - t) / (hi - lo));
    p.stroke_color(color(colors::TEXT.opacity(0.22)))
        .line_width(1.0)
        .begin_path()
        .move_to(&hx, t)
        .line_to(&hx, b)
        .stroke()
        .begin_path()
        .move_to(l, &hy)
        .line_to(&hx, &hy)
        .line_dash(&lengths([2.0, 3.0]))
        .stroke()
        .line_dash(&[])
        .fill_color(color(colors::LIGHT))
        .begin_path()
        .arc(&hx, &hy, 5.0, 0.0, TAU)
        .fill()
        .stroke_color(color(colors::ACCENT))
        .begin_path()
        .arc(&hx, &hy, 9.0, 0.0, TAU)
        .stroke()
        .fill_color(color(colors::ACCENT))
        .begin_path()
        .arc(l, &hy, 3.5, 0.0, TAU)
        .fill()
}

/// One curve plotted, with a dot that rides it: x runs linearly, y with
/// the curve, both native.
#[component]
fn EasingPlot() -> impl IntoElement {
    let selected = signal(CURVES.len() - 3);
    let (dot_x, dot_y) = (animated_value(0.0), animated_value(0.0));
    // The run going on (a new play stops it).
    let running = stored(None::<Animation>);
    // The plot's width, from its layout.
    let width = signal(0.0_f32);
    let play = move || {
        if let Some(run) = running.replace(None) {
            run.stop();
        }
        dot_x.set(0.0);
        dot_y.set(0.0);
        let run = Animation::sequence([
            Animation::delay(120.0),
            Animation::parallel([
                Animation::timing(&dot_x, 1.0, Timing::new(1100.0, Easing::Linear)),
                Animation::timing(
                    &dot_y,
                    1.0,
                    Timing::new(1100.0, CURVES[selected.get_untracked()].1),
                ),
            ]),
        ]);
        let _ = run.start();
        running.replace(Some(run));
    };
    let chips = CURVES.iter().enumerate().map(|(i, (name, _))| {
        chip(
            name,
            computed(move || selected.get() == i),
            move |_: &()| {
                selected.set(i);
                play();
            },
        )
    });
    Card::new()
        .icon(IconName::Spark)
        .title("Easing")
        .subtitle("Curves are data, evaluated natively")
        .child(
            canvas(move || draw_plot(width.get(), selected.get(), &dot_x, &dot_y))
                .h(px(PLOT))
                .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0)),
        )
        .child(
            scroll()
                .horizontal()
                .scrollbar(false)
                .child(view().flex_row().gap_2().children(chips)),
        )
        .child(Button::new("Play", move |_: &()| play()).icon(IconName::Play))
}

/// Every curve at once: ten timings in one `Animation::parallel`.
#[component]
fn EasingRace() -> impl IntoElement {
    let dots = CURVES.map(|_| animated_value(0.0));
    // How far the dots travel: the tracks' width (from the first one's
    // layout) less a dot's.
    let travel = animated_value(0.0);
    // At the end of the tracks (the next play goes back).
    let there = signal(false);
    let rows = CURVES
        .iter()
        .zip(dots.iter())
        .enumerate()
        .map(|(i, ((name, _), dot))| {
            view()
                .flex_row()
                .items_center()
                .h(px(26.0))
                .gap(px(10.0))
                .child(
                    text(*name)
                        .number_of_lines(1)
                        .w(px(84.0))
                        .text_size(px(13.0))
                        .text_color(colors::MUTED),
                )
                .child(
                    view()
                        .flex_1()
                        .h(px(12.0))
                        .justify_center()
                        .when(i == 0, |v| {
                            v.on_layout(move |frame: &Bounds<Points>| {
                                travel.set((frame.size.width.0 - 12.0).max(0.0));
                            })
                        })
                        .child(view().h(px(2.0)).rounded(px(1.0)).bg(colors::RAISED))
                        .child(
                            view()
                                .absolute()
                                .left_0()
                                .top_0()
                                .size(px(12.0))
                                .rounded(px(6.0))
                                .bg(TONES[i % TONES.len()])
                                .finish(Finish::Knob)
                                .bind_translate_x(&dot.mul(&travel)),
                        ),
                )
        })
        .collect::<Vec<_>>();
    let race = move |_: &()| {
        there.update(|t| *t = !*t);
        let to = if there.get_untracked() { 1.0 } else { 0.0 };
        let runs = dots
            .iter()
            .zip(CURVES)
            .map(|(dot, (_, easing))| Animation::timing(dot, to, Timing::new(1200.0, easing)));
        // It runs to its end natively; nothing follows it up.
        let _ = Animation::parallel(runs).start();
    };
    Card::new()
        .icon(IconName::Lists)
        .title("Side by side")
        .subtitle("Ten timings started together")
        .right(Badge::new("1.2 s"))
        .child(view().gap(px(2.0)).children(rows))
        .child(api("One group, one start", "Animated.parallel"))
        .child(
            Button::new(move || if there.get() { "Reverse" } else { "Play" }, race)
                .variant(ButtonVariant::Secondary)
                .icon(IconName::Play),
        )
}

// --- Composition -------------------------------------------------------------

/// A composed animation of [`Composition`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Run {
    Stagger,
    Sequence,
    Loop,
}

impl Run {
    fn name(self) -> &'static str {
        match self {
            Run::Stagger => "stagger",
            Run::Sequence => "sequence",
            Run::Loop => "loop",
        }
    }
}

/// `sequence`, `parallel`, `stagger` and `loop`, with stop and reset.
#[component]
fn Composition() -> impl IntoElement {
    // The tiles' vertical offsets, their turn (0..1, each tile turning its
    // own angle) and their opacity.
    let ys: Vec<AnimatedValue> = TONES.iter().map(|_| animated_value(0.0)).collect();
    let (spin, fade) = (animated_value(0.0), animated_value(1.0));
    let stagger = Animation::stagger(
        70.0,
        ys.iter().map(|y| {
            Animation::sequence([
                Animation::timing(y, -46.0, Timing::new(220.0, QUAD_OUT)),
                Animation::spring(y, 0.0, spring(320.0, 11.0)),
            ])
        }),
    );
    let sequence = Animation::sequence([
        Animation::timing(&spin, 1.0, Timing::new(520.0, CUBIC_IN_OUT)),
        Animation::delay(200.0),
        Animation::parallel([
            Animation::timing(&fade, 0.25, ms(300.0)),
            Animation::timing(&spin, 0.0, Timing::new(640.0, BACK_OUT)),
        ]),
        Animation::timing(&fade, 1.0, ms(300.0)),
    ]);
    let pulse = Animation::sequence([
        Animation::timing(&fade, 0.3, Timing::new(420.0, SIN_IN_OUT)),
        Animation::timing(&fade, 1.0, Timing::new(420.0, SIN_IN_OUT)),
    ])
    .looped(None);
    // The compositions, by [`Run`].
    let runs: Rc<[Animation]> = Rc::new([stagger, sequence, pulse]);
    // What last happened ("idle", "stagger running", "loop stopped").
    let state = signal((SharedString::from("idle"), Tone::Neutral));
    {
        let runs = runs.clone();
        cleanup(move || runs.iter().for_each(Animation::stop));
    }
    let tiles = TONES
        .iter()
        .zip(&ys)
        .enumerate()
        .map(|(i, (&color, y))| {
            let angle = (i + 1) as f32 * 36.0;
            view()
                .size(px(40.0))
                .rounded(px(12.0))
                .border_curve(BorderCurve::Continuous)
                .bg(color)
                .finish(Finish::Knob)
                .bind_opacity(&fade)
                .bind_translate_y(y)
                .bind_rotate(&spin.interpolate(&[0.0, 1.0], &[0.0, angle]))
        })
        .collect::<Vec<_>>();
    // Starts `run` (again: a start stops the run going on, which reports
    // it stopped) and reports how it ends.
    let start = {
        let runs = runs.clone();
        move |run: Run| {
            let runs = runs.clone();
            move |_: &()| {
                state.set((format!("{} running", run.name()).into(), Tone::Info));
                let end = runs[run as usize].start();
                spawn(async move {
                    let finished = end.await;
                    state.set(if finished {
                        (format!("{} finished", run.name()).into(), Tone::Accent)
                    } else {
                        (format!("{} stopped", run.name()).into(), Tone::Warn)
                    });
                });
            }
        }
    };
    let (stop, reset) = (runs.clone(), runs);
    Card::new()
        .icon(IconName::Components)
        .title("Composition")
        .subtitle("Each step starts as the last one ends")
        .right(Badge::new(move || state.with(|s| s.0.clone())).tone(move || state.with(|s| s.1)))
        .child(
            view()
                .h(px(116.0))
                .flex_row()
                .justify_center()
                .items_end()
                .gap_3()
                .pb(px(14.0))
                .child(
                    view()
                        .pointer_events(PointerEvents::None)
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom(px(14.0))
                        .border_t_1()
                        .border_color(colors::BORDER)
                        .border_dashed(),
                )
                .children(tiles),
        )
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(
                    Button::new("Stagger", start(Run::Stagger))
                        .variant(ButtonVariant::Secondary)
                        .flex_1(),
                )
                .child(
                    Button::new("Sequence", start(Run::Sequence))
                        .variant(ButtonVariant::Secondary)
                        .flex_1(),
                )
                .child(
                    Button::new("Loop", start(Run::Loop))
                        .variant(ButtonVariant::Secondary)
                        .flex_1(),
                ),
        )
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(
                    Button::new("Stop", move |_: &()| stop.iter().for_each(Animation::stop))
                        .variant(ButtonVariant::Ghost)
                        .icon(IconName::Pause)
                        .flex_1(),
                )
                .child(
                    Button::new("Reset", move |_: &()| {
                        reset.iter().for_each(Animation::reset)
                    })
                    .variant(ButtonVariant::Ghost)
                    .flex_1(),
                ),
        )
}

// --- Springs ----------------------------------------------------------------

/// The springs: label, stiffness, damping, tone.
const SPRINGS: [(&str, f32, f32, AdaptiveColor); 3] = [
    ("Gentle", 120.0, 14.0, colors::INFO),
    ("Wobbly", 180.0, 8.0, colors::WARN),
    ("Stiff", 400.0, 30.0, colors::ACCENT),
];

/// How long the plot runs.
const SPRING_MS: f32 = 1800.0;

/// The response of a unit spring from 0 to 1, `n + 1` samples over
/// [`SPRING_MS`]: the curve the graph runs, resting at 1 once it ends.
fn response(stiffness: f32, damping: f32, n: usize) -> Vec<f32> {
    let fps = n as f32 / (SPRING_MS / 1000.0);
    let mut out = sample_spring(0.0, 1.0, spring(stiffness, damping), fps);
    out.resize(n + 1, 1.0);
    out
}

/// The springs' plot, `plot` wide: their responses (from the end when not
/// `there`), each with a dot at the live value of its spring `x` (tracks
/// `width` wide) at `clock`'s time.
fn draw_springs(
    plot: f32,
    width: f32,
    there: bool,
    clock: &AnimatedValue,
    xs: &[AnimatedValue],
) -> Painter {
    let (cw, height) = (plot, 150.0);
    let (l, r, t, b) = (4.0, cw - 4.0, 10.0, height - 10.0);
    let y = |v: f32| b - v / 1.5 * (b - t);
    // A dot matrix behind, then the target.
    let mut p = Painter::new().fill_color(color(colors::LINE));
    let mut gx = l;
    while gx <= r {
        let mut gy = t;
        while gy <= b {
            p = p.fill_rect(gx, gy, 1.5, 1.5);
            gy += 12.0;
        }
        gx += 12.0;
    }
    p = p
        .line_dash(&lengths([3.0, 4.0]))
        .stroke_color(color(colors::FAINT))
        .begin_path()
        .move_to(l, y(1.0))
        .line_to(r, y(1.0))
        .stroke()
        .line_dash(&[]);
    let n = 120;
    let w = (width - 28.0).max(1.0);
    let from_end = !there;
    for ((_, k, c, tone), x) in SPRINGS.iter().zip(xs) {
        let tone = color(*tone);
        p = p.stroke_color(tone).line_width(1.75).begin_path();
        for (i, v) in response(*k, *c, n).into_iter().enumerate() {
            let v = if from_end { 1.0 - v } else { v };
            let px = l + i as f32 / n as f32 * (r - l);
            p = if i == 0 {
                p.move_to(px, y(v))
            } else {
                p.line_to(px, y(v))
            };
        }
        // The live spring value, at the clock's x.
        p = p
            .stroke()
            .fill_color(tone)
            .begin_path()
            .arc(
                &clock.mul(r - l).add(l),
                &x.div(w).mul(-(b - t) / 1.5).add(b),
                4.0,
                0.0,
                TAU,
            )
            .fill();
    }
    p
}

/// Springs with different settings, released together; the plot's dots
/// are the springs themselves.
#[component]
fn Springs() -> impl IntoElement {
    let xs = SPRINGS.map(|_| animated_value(0.0));
    let clock = animated_value(0.0);
    // The tracks' width, from the first one's layout; the plot's, from its
    // layout.
    let width = signal(0.0_f32);
    let plot = signal(0.0_f32);
    // At the end of the tracks.
    let there = signal(false);
    let tracks = SPRINGS
        .iter()
        .zip(xs.iter())
        .enumerate()
        .map(|(i, (s, x))| {
            view()
                .h(px(28.0))
                .justify_center()
                .rounded(px(14.0))
                .bg(colors::BACKGROUND)
                .finish(Finish::Track)
                .when(i == 0, |v| {
                    v.on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
                })
                .child(
                    view()
                        .absolute()
                        .left(px(2.0))
                        .top(px(2.0))
                        .size(px(24.0))
                        .rounded(px(12.0))
                        .bg(s.3)
                        .finish(Finish::Knob)
                        .bind_translate_x(x),
                )
        })
        .collect::<Vec<_>>();
    let release = move |_: &()| {
        there.update(|t| *t = !*t);
        let w = (width.get_untracked() - 28.0).max(1.0);
        clock.set(0.0);
        let to = if there.get_untracked() { w } else { 0.0 };
        let runs = std::iter::once(Animation::timing(
            &clock,
            1.0,
            Timing::new(SPRING_MS, Easing::Linear),
        ))
        .chain(
            xs.iter()
                .zip(SPRINGS)
                .map(|(x, (_, k, c, _))| Animation::spring(x, to, spring(k, c))),
        );
        let _ = Animation::parallel(runs).start();
    };
    Card::new()
        .icon(IconName::Physics)
        .title("Springs")
        .subtitle("Stiffness and damping, mass 1")
        .child(
            canvas(move || draw_springs(plot.get(), width.get(), there.get(), &clock, &xs))
                .h(px(150.0))
                .on_layout(move |frame: &Bounds<Points>| plot.set(frame.size.width.0)),
        )
        .child(
            view().flex_row().gap(px(14.0)).flex_wrap().children(
                SPRINGS
                    .iter()
                    .map(|(label, k, c, tone)| legend(*tone, *label, Some(format!("{k} / {c}")))),
            ),
        )
        .child(view().gap_2().children(tracks))
        .child(Button::new("Release", release))
}

// --- Interpolation ----------------------------------------------------------

/// The dial's size.
const D: f32 = 128.0;

/// A dial's ticks and labels.
fn dial_face() -> Painter {
    let c = D / 2.0;
    let mut p = Painter::new();
    for i in 0..=40 {
        let a = (-120.0 + i as f32 * 6.0) * PI / 180.0 - FRAC_PI_2;
        let major = i % 10 == 0;
        let r0 = c - if major { 12.0 } else { 7.0 };
        p = p
            .stroke_color(color(if major { colors::MUTED } else { colors::BORDER }))
            .line_width(if major { 1.5 } else { 1.0 })
            .begin_path()
            .move_to(c + a.cos() * r0, c + a.sin() * r0)
            .line_to(c + a.cos() * (c - 2.0), c + a.sin() * (c - 2.0))
            .stroke();
    }
    p = p
        .font("11px system-ui")
        .fill_color(color(colors::FAINT))
        .text_align(CanvasTextAlign::Center)
        .text_baseline(CanvasTextBaseline::Middle);
    for (i, label) in ["0", "1", "2"].iter().enumerate() {
        let a = (-120.0 + i as f32 * 120.0) * PI / 180.0 - FRAC_PI_2;
        p = p.fill_text(label, c + a.cos() * (c - 24.0), c + a.sin() * (c - 24.0));
    }
    p
}

/// Colors, angles and scales from one value; outside the range they
/// extend or clamp.
#[component]
fn Interpolations() -> impl IntoElement {
    // The value: 0, 1 or 2 at rest; where it goes.
    let t = animated_value(0.0);
    let at = signal(0_u32);
    let angle = t.interpolate_with(
        &[0.0, 1.0],
        AnimationOutput::Numbers(vec![0.0, 180.0]),
        Interpolation {
            extrapolate_right: Extrapolate::Extend,
            ..Interpolation::default()
        },
    );
    let figure = |label: &'static str, shape: AnyElement| {
        view().items_center().gap_2().child(shape).child(
            text(label)
                .text_size(px(11.0))
                .font_family(MONO)
                .text_color(colors::FAINT),
        )
    };
    // The extending shape's colors follow the appearance natively.
    let extend = {
        let fill = t.interpolate_colors(
            &[0.0, 1.0, 2.0],
            &[colors::INFO, colors::ACCENT, colors::DANGER],
        );
        view()
            .size(px(64.0))
            .rounded(px(16.0))
            .border_curve(BorderCurve::Continuous)
            .bind_background(&fill)
            .bind_rotate(&angle)
    };
    Card::new()
        .icon(IconName::Styles)
        .title("Interpolation")
        .subtitle("One value drives color, angle and scale")
        .right(Badge::new(move || format!("t = {}", at.get())).tone(Tone::Accent))
        .child(
            view()
                .flex_row()
                .items_center()
                .justify_between()
                .child(
                    view()
                        .size(px(D))
                        .child(canvas(dial_face).size(px(D)))
                        .child(
                            view()
                                .pointer_events(PointerEvents::None)
                                .absolute()
                                .left(px(D / 2.0 - 1.5))
                                .top(px(14.0))
                                .w(px(3.0))
                                .h(px(D - 28.0))
                                .bind_rotate(&t.interpolate(&[0.0, 2.0], &[-120.0, 120.0]))
                                .child(
                                    view()
                                        .h(px(D / 2.0 - 22.0))
                                        .rounded(px(1.5))
                                        .bg(colors::ACCENT),
                                ),
                        )
                        .child(
                            view()
                                .absolute()
                                .left(px(D / 2.0 - 6.0))
                                .top(px(D / 2.0 - 6.0))
                                .size(px(12.0))
                                .rounded(px(6.0))
                                .bg(colors::LIGHT)
                                .finish(Finish::Light),
                        ),
                )
                .child(figure("extend", extend.into_element()))
                .child(figure(
                    "clamp",
                    view()
                        .size(px(64.0))
                        .items_center()
                        .justify_center()
                        .child(
                            view()
                                .size(px(52.0))
                                .rounded(px(26.0))
                                .bg(colors::UP)
                                .bind_scale(&t.interpolate(&[0.0, 1.0], &[0.6, 1.2])),
                        )
                        .into_element(),
                )),
        )
        .child(
            segmented()
                .options(["t = 0", "t = 1", "t = 2"].map(Segment::new))
                .selected(at)
                .on_change(move |to: &u32| {
                    at.set(*to);
                    let _ = t.spring(*to as f32, spring(140.0, 16.0));
                }),
        )
        .child(
            view()
                .gap(px(6.0))
                .child(caption("Color through three stops", Some("at 0, 1 and 2")))
                .child(caption("Rotation keeps going past 1", Some("360° at 2")))
                .child(caption("Scale stops at 1.2", Some("clamp"))),
        )
}

// --- diffClamp --------------------------------------------------------------

/// The hiding header's height.
const H: f32 = 52.0;

/// A header that hides while the list scrolls up and comes back as it
/// scrolls down: `diff_clamp` of the scroll offset, natively.
#[component]
fn HidingHeader() -> impl IntoElement {
    // The scroll offset.
    let scroll_value = animated_value(0.0);
    let header = scroll_value.diff_clamp(0.0, H);
    let rows = (1..=30u32).map(|n| {
        view()
            .h(px(48.0))
            .flex_row()
            .items_center()
            .gap_3()
            .px_3()
            .rounded(px(12.0))
            .bg(colors::SURFACE)
            .border_1()
            .border_color(colors::LINE)
            .child(
                text(format!("{n:02}"))
                    .w(px(24.0))
                    .text_size(px(13.0))
                    .text_color(colors::FAINT)
                    .tabular_nums(),
            )
            .child(
                text(format!("Row {n}"))
                    .flex_1()
                    .text_size(px(15.0))
                    .text_color(colors::TEXT),
            )
            .child(
                view()
                    .w(px(40.0 + ((n * 37) % 50) as f32))
                    .h(px(4.0))
                    .rounded(px(2.0))
                    .bg(if n % 3 == 0 {
                        colors::ACCENT
                    } else {
                        colors::RAISED
                    }),
            )
    });
    Card::new()
        .icon(IconName::Scroll)
        .title("Hiding header")
        .subtitle("Hides as the list scrolls up, returns as it scrolls down")
        .child(
            view()
                .h(px(300.0))
                .rounded(px(radius::CONTROL))
                .overflow_hidden()
                .bg(colors::BACKGROUND)
                .finish(Finish::Track)
                .child(
                    scroll().flex_1().scroll_value(&scroll_value).child(
                        view()
                            .pt(px(H + 8.0))
                            .px_2()
                            .pb_2()
                            .gap(px(6.0))
                            .children(rows),
                    ),
                )
                .child(
                    view()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top_0()
                        .h(px(H))
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .px(px(14.0))
                        .bg(colors::RAISED)
                        .finish(Finish::Raised)
                        .border_b_1()
                        .border_b_color(colors::BORDER)
                        .bind_translate_y(&header.mul(-1.0))
                        .bind_opacity(&header.interpolate_with(
                            &[0.0, H],
                            AnimationOutput::Numbers(vec![1.0, 0.0]),
                            Interpolation {
                                easing: Easing::Curve(Curve::Quad, EaseMode::In),
                                ..Interpolation::default()
                            },
                        ))
                        .child(icon().name(IconName::Search).size(16.0).tint(colors::MUTED))
                        .child(
                            text("Search")
                                .flex_1()
                                .text_size(px(15.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT),
                        )
                        .child(
                            text(format!("diffClamp(0, {H})"))
                                .text_size(px(12.0))
                                .font_family(MONO)
                                .text_color(colors::FAINT),
                        ),
                ),
        )
}

// --- Layout animation -------------------------------------------------------

/// The layout animations to pick from.
const PRESETS: [(&str, LayoutAnimation); 3] = [
    // `LayoutAnimation.create(420, "spring")`.
    (
        "Spring",
        LayoutAnimation::all(LayoutTransition::new(
            LayoutCurve::Spring { damping: 0.7 },
            420.0,
        )),
    ),
    ("Ease in out", LayoutAnimation::EASE_IN_EASE_OUT),
    ("Linear", LayoutAnimation::LINEAR),
];

/// Layout changes animated natively by the next commit: moves, inserts
/// and removals.
#[component]
fn Layout() -> impl IntoElement {
    // The tiles in a column (else in a row); the layout animation chosen;
    // the tiles and the next one's number.
    let column = signal(false);
    let preset = signal(0_u32);
    let items = signal(vec![1_u32, 2, 3, 4, 5]);
    let next = stored(6_u32);
    let len = computed(move || items.with(Vec::len));
    // The next commit's layout changes animate with the preset chosen.
    let animate = move || animate_layout(PRESETS[preset.get_untracked() as usize].1);
    let tile = move |id: ReadSignal<u32>, _| {
        let id = id.get_untracked();
        view()
            .h(move || px(if column.get() { 30.0 } else { 64.0 }))
            .style_when(move || !column.get(), |s| s.w(px(50.0)).flex_grow(1.0))
            .rounded(px(12.0))
            .border_curve(BorderCurve::Continuous)
            .px(px(10.0))
            .justify_center()
            .bg(TONES[id as usize % TONES.len()])
            .finish(Finish::Knob)
            .child(
                text(id.to_string())
                    .text_size(px(13.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(ON_TONE)
                    .tabular_nums(),
            )
    };
    let flip = move |_: &()| {
        animate();
        column.update(|c| *c = !*c);
    };
    Card::new()
        .icon(IconName::Mobile)
        .title("Layout animation")
        .subtitle("Frames, inserts and removals of the next commit")
        .right(Badge::new(move || format!("{} views", len.get())))
        .child(
            segmented()
                .options(
                    PRESETS
                        .iter()
                        .map(|(label, _)| Segment::new(*label))
                        .collect::<Vec<_>>(),
                )
                .selected(preset)
                .size(SegmentedSize::Small)
                .on_change(move |i: &u32| preset.set(*i)),
        )
        .child(
            view()
                .min_h(px(64.0))
                .flex_row()
                .style_when(column, |s| s.flex_col())
                .flex_wrap()
                .gap_2()
                .child(each(items, |id| *id, tile)),
        )
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(
                    Button::new(move || if column.get() { "Row" } else { "Column" }, flip).flex_1(),
                )
                .child(
                    Button::new("Shuffle", move |_: &()| {
                        animate();
                        items.update(|items| {
                            // Fisher–Yates.
                            for i in (1..items.len()).rev() {
                                let j = ((random() * (i + 1) as f32) as usize).min(i);
                                items.swap(i, j);
                            }
                        });
                    })
                    .variant(ButtonVariant::Secondary)
                    .flex_1(),
                ),
        )
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(
                    Button::new("Add", move |_: &()| {
                        animate();
                        if len.get_untracked() < 8 {
                            let id = next.with(|next| {
                                *next += 1;
                                *next - 1
                            });
                            items.update(|items| items.push(id));
                        }
                    })
                    .variant(ButtonVariant::Secondary)
                    .icon(IconName::Plus)
                    .disabled(Prop::bind(move || len.get() >= 8))
                    .flex_1(),
                )
                .child(
                    Button::new("Remove", move |_: &()| {
                        animate();
                        if len.get_untracked() > 1 {
                            items.update(|items| {
                                items.remove(0);
                            });
                        }
                    })
                    .variant(ButtonVariant::Ghost)
                    .disabled(Prop::bind(move || len.get() <= 1))
                    .flex_1(),
                ),
        )
}

/// The demo's page.
#[component]
pub(crate) fn Animations() -> impl IntoElement {
    DemoPage::new()
        .card(hero)
        .card(easing_plot)
        .card(easing_race)
        .card(composition)
        .card(springs)
        .card(interpolations)
        .card(hiding_header)
        .card(layout)
}
