//! Physics: a card dragged on the UI thread and released into a spring, a
//! decay or the nearest corner, with the drag's velocity; a canvas draws a
//! tether to it from the same animated values, without a render per frame
//! (as the TSX gallery's `demos/Physics.tsx`).

use std::f32::consts::TAU;

use nsh_core::{Bounds, Points, prelude::*};

use crate::ui::{
    Badge, Finish, Finished, IconName, IconTile, MONO, Segment, SegmentedSize, Stat, Tone, appear,
    colors, hint, icon, lengths, radius, rect, segmented, tints,
};

/// The card's width and height.
const CARD: f32 = 128.0;

/// How the card moves once released.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    /// Springs home.
    #[default]
    Spring,
    /// Coasts to a stop, then springs home.
    Coast,
    /// Springs to the corner the fling points at.
    Snap,
}

const MODES: [Mode; 3] = [Mode::Spring, Mode::Coast, Mode::Snap];

/// The release's spring settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Feel {
    Soft,
    #[default]
    Bouncy,
    Firm,
}

const FEELS: [Feel; 3] = [Feel::Soft, Feel::Bouncy, Feel::Firm];

impl Feel {
    /// Its stiffness and damping.
    fn spring(self) -> (f32, f32) {
        match self {
            Feel::Soft => (90.0, 12.0),
            Feel::Bouncy => (180.0, 11.0),
            Feel::Firm => (420.0, 32.0),
        }
    }
}

/// A spring of stiffness `k` and damping `c`.
const fn spring(k: f32, c: f32) -> Spring {
    Spring {
        stiffness: k,
        damping: c,
        mass: 1.0,
        velocity: None,
    }
}

/// The snap corners' distance from the middle of a stage of `stage`.
fn corners(stage: (f32, f32)) -> (f32, f32) {
    (
        (stage.0 / 2.0 - CARD / 2.0 - 14.0).max(0.0),
        (stage.1 / 2.0 - CARD / 2.0 - 14.0).max(0.0),
    )
}

/// The stage's backdrop for a stage of `stage`: a dot grid, the axes, the
/// snap corners in `mode` snap, and the tether to the card, which follows
/// the animated values `x` and `y`.
fn backdrop(stage: (f32, f32), mode: Mode, x: &AnimatedValue, y: &AnimatedValue) -> Painter {
    // The canvas fills the stage inside its 1 pt rim.
    let (width, height) = (stage.0 - 2.0, stage.1 - 2.0);
    let (mx, my) = (width / 2.0, height / 2.0);
    let mut p = Painter::new().fill_color(color(colors::LINE));
    let mut gx = 10.0;
    while gx < width {
        let mut gy = 10.0;
        while gy < height {
            p = p.fill_rect(gx, gy, 1.5, 1.5);
            gy += 16.0;
        }
        gx += 16.0;
    }
    p = p
        .line_dash(&lengths([3.0, 5.0]))
        .stroke_color(color(colors::BORDER))
        .line_width(1.0)
        .begin_path()
        .move_to(mx, 0.0)
        .line_to(mx, height)
        .move_to(0.0, my)
        .line_to(width, my)
        .stroke();
    if mode == Mode::Snap {
        let (cx, cy) = corners(stage);
        p = p.stroke_color(color(colors::FAINT));
        for sx in [-1.0, 1.0] {
            for sy in [-1.0, 1.0] {
                p = p
                    .begin_path()
                    .round_rect(
                        rect(
                            mx + sx * cx - CARD / 2.0,
                            my + sy * cy - CARD / 2.0,
                            CARD,
                            CARD,
                        ),
                        px(26.0),
                    )
                    .stroke();
            }
        }
    }
    p.line_dash(&[])
        // The tether, from animated values: it follows drags and springs
        // without a drawing of its own.
        .stroke_color(color(colors::ACCENT))
        .global_alpha(0.45)
        .line_width(1.5)
        .begin_path()
        .move_to(mx, my)
        .line_to(&x.add(mx), &y.add(my))
        .stroke()
        .global_alpha(1.0)
        .fill_color(color(colors::ACCENT))
        .begin_path()
        .arc(mx, my, 4.0, 0.0, TAU)
        .fill()
}

/// The demo's page.
#[component]
pub(crate) fn Physics() -> impl IntoElement {
    // The drag's translation (the drag moves it natively).
    let (x, y) = (animated_value(0.0), animated_value(0.0));
    // The pulse: 0 at rest, 1 at its peak; and 1 while the card is held.
    let (pressed, lift) = (animated_value(0.0), animated_value(0.0));
    let mode = signal(Mode::default());
    let feel = signal(Feel::default());
    // The stage's size, from its layout.
    let stage = signal((0.0_f32, 0.0_f32));
    // How often the card was let go, the last release's speed (points per
    // second) and the corner the last snap went to.
    let releases = signal(0_u32);
    let speed = signal(0.0_f32);
    let corner = signal("—");
    // The pulse running.
    let pulse = stored(None::<Spawned<()>>);

    // Springs `v` to `to` with the feel chosen, starting at `velocity`.
    let settle = move |v: &AnimatedValue, to: f32, velocity: f32| {
        let (k, c) = feel.get_untracked().spring();
        let _ = v.spring(
            to,
            Spring {
                velocity: Some(velocity),
                ..spring(k, c)
            },
        );
    };
    let release = move |e: &PanEvent| {
        let _ = lift.spring(0.0, spring(300.0, 24.0));
        releases.update(|r| *r += 1);
        speed.set(e.velocity_x.hypot(e.velocity_y).round());
        match mode.get_untracked() {
            Mode::Spring => {
                settle(&x, 0.0, e.velocity_x);
                settle(&y, 0.0, e.velocity_y);
                corner.set("—");
            }
            Mode::Coast => {
                // Coast with the release velocity, then spring home
                // unless grabbed again.
                for (v, velocity) in [(x, e.velocity_x), (y, e.velocity_y)] {
                    let end = v.decay(Some(velocity), 0.992);
                    spawn(async move {
                        if end.await {
                            settle(&v, 0.0, 0.0);
                        }
                    });
                }
                corner.set("—");
            }
            Mode::Snap => {
                // Where the fling would carry it, then the nearest
                // corner.
                let px = e.value_x.unwrap_or(0.0) + e.velocity_x * 0.2;
                let py = e.value_y.unwrap_or(0.0) + e.velocity_y * 0.2;
                let (cx, cy) = corners(stage.get_untracked());
                settle(&x, if px < 0.0 { -cx } else { cx }, e.velocity_x);
                settle(&y, if py < 0.0 { -cy } else { cy }, e.velocity_y);
                corner.set(match (py < 0.0, px < 0.0) {
                    (true, true) => "top left",
                    (true, false) => "top right",
                    (false, true) => "bottom left",
                    (false, false) => "bottom right",
                });
            }
        }
    };
    let grab = move |_: &PanEvent| {
        let _ = lift.spring(1.0, spring(400.0, 26.0));
    };
    let tap = move |_: &()| {
        if let Some(running) = pulse.replace(None) {
            running.cancel();
        }
        pulse.replace(Some(spawn(async move {
            let _ = pressed.timing(1.0, 120.0, Easing::EaseOut).await;
            let _ = pressed.timing(0.0, 320.0, Easing::EaseInOut).await;
        })));
    };
    let reset = move |_: &()| {
        releases.set(0);
        speed.set(0.0);
        corner.set("—");
        settle(&x, 0.0, 0.0);
        settle(&y, 0.0, 0.0);
    };
    // The card's color: `pressed` runs from the accent to the info color
    // (theme colors: they follow the appearance natively).
    let fill = pressed.interpolate_colors(&[0.0, 1.0], &[colors::ACCENT_FILL, colors::INFO]);
    let fast = computed(move || speed.get() > 1500.0);
    view()
        .flex_1()
        .p_4()
        .gap_3()
        .bg(colors::BACKGROUND)
        .child(
            appear().index(0).child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .child(IconTile::new(IconName::Physics).tint(colors::ACCENT))
                    .child(
                        view()
                            .flex_1()
                            .gap(px(2.0))
                            .child(
                                text("Drag and release")
                                    .text_size(px(17.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(colors::TEXT),
                            )
                            .child(
                                text(hint(
                                    "Tap to pulse, long press to reset",
                                    "Click to pulse, press and hold to reset",
                                ))
                                .number_of_lines(1)
                                .text_size(px(13.0))
                                .text_color(colors::MUTED),
                            ),
                    )
                    .child(Badge::new("UI thread").tone(Tone::Accent)),
            ),
        )
        .child(
            view()
                .flex_1()
                .overflow_hidden()
                .rounded(px(radius::CARD))
                .border_curve(BorderCurve::Continuous)
                .border_1()
                .border_color(colors::BORDER)
                .bg(colors::INSET)
                .finish(Finish::Inset)
                .items_center()
                .justify_center()
                .on_layout(move |frame: &Bounds<Points>| {
                    stage.set((frame.size.width.0, frame.size.height.0))
                })
                .child(
                    canvas(move || backdrop(stage.get(), mode.get(), &x, &y))
                        .pointer_events(PointerEvents::None)
                        .absolute()
                        .inset_0(),
                )
                .child(
                    view()
                        .pointer_events(PointerEvents::None)
                        .absolute()
                        .size(px(CARD))
                        .rounded(px(30.0))
                        .bg(tints::ACCENT)
                        .bind_opacity(&lift)
                        .bind_translate_x(&x)
                        .bind_translate_y(&y)
                        .bind_scale(&lift.interpolate(&[0.0, 1.0], &[1.0, 1.32])),
                )
                .child(
                    view()
                        .size(px(CARD))
                        .rounded(px(30.0))
                        .border_curve(BorderCurve::Continuous)
                        .items_center()
                        .justify_center()
                        .gap_2()
                        .role(AccessibilityRole::Button)
                        .label("Draggable card")
                        .pan_values(Some(&x), Some(&y))
                        .bind_background(&fill)
                        // The accent's highlight and glow; the color itself
                        // animates.
                        .finish_shadow(Finish::Accent)
                        .bind_translate_x(&x)
                        .bind_translate_y(&y)
                        .bind_scale(&pressed.interpolate(&[0.0, 1.0], &[1.0, 1.12]))
                        .bind_scale(&lift.interpolate(&[0.0, 1.0], &[1.0, 1.06]))
                        .bind_rotate(&x.interpolate(&[-200.0, 200.0], &[-14.0, 14.0]))
                        .on_pan_start(grab)
                        .on_pan_end(release)
                        .on_press(tap)
                        .on_long_press(reset)
                        .child(
                            icon()
                                .name(IconName::Gestures)
                                .size(28.0)
                                .tint(colors::ON_ACCENT),
                        )
                        .child(
                            text("Drag me")
                                .text_color(colors::ON_ACCENT)
                                .text_size(px(15.0))
                                .font_weight(FontWeight::BOLD),
                        ),
                ),
        )
        .child(
            view()
                .bg(colors::SURFACE)
                .finish(Finish::Card)
                .rounded(px(radius::CARD))
                .border_curve(BorderCurve::Continuous)
                .border_1()
                .border_color(colors::BORDER)
                .p_3()
                .gap_3()
                .child(
                    segmented()
                        .options(["Spring", "Coast", "Snap"].map(Segment::new))
                        .selected(move || {
                            MODES.iter().position(|m| *m == mode.get()).unwrap_or(0) as u32
                        })
                        .on_change(move |i: &u32| {
                            mode.set(MODES[*i as usize]);
                        }),
                )
                .child(
                    segmented()
                        .options(["Soft", "Bouncy", "Firm"].map(Segment::new).to_vec())
                        .selected(move || {
                            FEELS.iter().position(|f| *f == feel.get()).unwrap_or(0) as u32
                        })
                        .size(SegmentedSize::Small)
                        .on_change(move |i: &u32| {
                            feel.set(FEELS[*i as usize]);
                        }),
                )
                .child(
                    view()
                        .flex_row()
                        .px_1()
                        .child(Stat::new("Releases", move || releases.get().to_string()).width(0.3))
                        // Fast releases are toned.
                        .child(
                            Stat::new("Speed", move || format!("{} pt/s", speed.get()))
                                .width(0.34)
                                .tone_when(fast, Tone::Warn),
                        )
                        .child(
                            Stat::new(
                                move || {
                                    if mode.get() == Mode::Snap {
                                        "Corner"
                                    } else {
                                        "Spring"
                                    }
                                },
                                move || {
                                    if mode.get() == Mode::Snap {
                                        corner.get().to_owned()
                                    } else {
                                        let (k, c) = feel.get().spring();
                                        format!("{k} / {c}")
                                    }
                                },
                            )
                            .width(0.36),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .items_baseline()
                        .gap_2()
                        .px_1()
                        .child(
                            text(move || match mode.get() {
                                Mode::Spring => "Springs home with the release velocity",
                                Mode::Coast => "Coasts to a stop, then springs home",
                                Mode::Snap => "Springs to the corner the fling points at",
                            })
                            .flex_1()
                            .text_size(px(13.0))
                            .text_color(colors::MUTED),
                        )
                        .child(
                            text(move || {
                                if mode.get() == Mode::Coast {
                                    "decay"
                                } else {
                                    "spring"
                                }
                            })
                            .text_size(px(12.0))
                            .font_family(MONO)
                            .text_color(colors::FAINT),
                        ),
                ),
        )
}
