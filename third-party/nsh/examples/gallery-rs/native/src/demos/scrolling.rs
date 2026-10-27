//! Scrolling: paging with a parallax and an indicator driven natively by
//! the offset, snapping on a recycled list, zooming, scroll events and
//! behavior, prepending and taps with the keyboard up (as the TSX
//! gallery's `demos/Scrolling.tsx`).

use nsh_base::input;
use nsh_core::{Bounds, Points, element::View, prelude::*};

use crate::ui::{
    Badge, Button, ButtonVariant, DemoPage, Figure, Finish, Finished, IconName, Meter, Section,
    Segment, SegmentedElement, SegmentedSize, Tone, caption, code, colors, hint, lengths, press,
    radius, segmented, toggle,
};

/// The tones cards, tiles and posts cycle through.
const TONES: [Tone; 5] = [Tone::Accent, Tone::Info, Tone::Warn, Tone::Up, Tone::Danger];

/// A tone's name (TS: the `Tone` string).
fn tone_name(tone: Tone) -> &'static str {
    match tone {
        Tone::Neutral => "neutral",
        Tone::Accent => "accent",
        Tone::Info => "info",
        Tone::Warn => "warn",
        Tone::Danger => "danger",
        Tone::Up => "up",
        Tone::Down => "down",
    }
}

/// A switch row; `code` names the prop it sets; `on_change` gets the new
/// value.
fn switch_row(
    label: &'static str,
    api: Option<&'static str>,
    note: Option<&'static str>,
    value: impl Into<Prop<bool>>,
    on_change: impl Into<Listener<bool>>,
) -> View {
    let on_change: Listener<bool> = on_change.into();
    let value: Prop<bool> = value.into();
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .min_h(px(48.0))
        .child(
            view()
                .flex_1()
                .gap(px(2.0))
                .child(text(label).text_size(px(15.0)).text_color(colors::TEXT))
                .children(api.map(|api| code(api).text_size(px(12.0)).text_color(colors::FAINT)))
                .children(
                    note.map(|note| text(note).text_size(px(13.0)).text_color(colors::FAINT)),
                ),
        )
        .child(toggle().value(value).label(label).on_change(on_change))
}

/// The APIs a section shows, as code.
fn api(names: &'static str) -> impl IntoElement {
    code(names).text_size(px(12.0)).text_color(colors::FAINT)
}

/// A small [`Segmented`] of `labels`, `selected` the index of the selected
/// one; `on_change` gets the index pressed.
fn choice(
    labels: &[&'static str],
    selected: Signal<usize>,
    on_change: impl Into<Listener<u32>>,
) -> SegmentedElement {
    let on_change: Listener<u32> = on_change.into();
    segmented()
        .options(labels.iter().map(|l| Segment::new(*l)).collect::<Vec<_>>())
        .selected(move || selected.get() as u32)
        .size(SegmentedSize::Small)
        .on_change(on_change)
}

/// A dot matrix with a low-alpha area and a dashed reference line: a
/// page's backdrop, drawn for its laid out size.
fn backdrop_painter(size: (f32, f32), tone: Tone, seed: f32) -> Painter {
    let (width, height) = size;
    let mut p = Painter::new().fill_style(color(colors::BORDER));
    let mut x = 10.0;
    while x < width {
        let mut y = 10.0;
        while y < height {
            p = p.fill_rect(x, y, 1.5, 1.5);
            y += 12.0;
        }
        x += 12.0;
    }
    // A wave, filled faintly below.
    let points: Vec<(f32, f32)> = (0..=24)
        .map(|i| {
            let i = i as f32;
            let x = i / 24.0 * width;
            let y = height
                * (0.62 - 0.18 * (i * 0.5 + seed).sin() - 0.06 * (i * 1.3 + seed * 2.0).sin());
            (x, y)
        })
        .collect();
    p = p.begin_path().move_to(0.0, height);
    for &(x, y) in &points {
        p = p.line_to(x, y);
    }
    p = p
        .line_to(width, height)
        .close_path()
        .fill_style(color(tone.tint()))
        .fill()
        .begin_path();
    for (i, &(x, y)) in points.iter().enumerate() {
        p = if i == 0 {
            p.move_to(x, y)
        } else {
            p.line_to(x, y)
        };
    }
    p.stroke_style(color(tone.color()))
        .line_width(1.5)
        .stroke()
        .line_dash(&lengths([3.0, 4.0]))
        .stroke_style(color(colors::FAINT))
        .line_width(1.0)
        .begin_path()
        .move_to(0.0, height * 0.5)
        .line_to(width, height * 0.5)
        .stroke()
}

/// The props of [`Backdrop`].
#[derive(Debug, Clone, PartialEq, Props)]
struct BackdropProps {
    /// The wave's tone.
    #[prop(default)]
    tone: Tone,
    /// The wave's phase.
    #[prop(default)]
    seed: f32,
}

/// A page's backdrop ([`backdrop`]), drawn again when its size changes.
#[component]
fn Backdrop(props: BackdropProps) -> impl IntoElement {
    let size = signal((0.0_f32, 0.0_f32));
    let (tone, seed) = (props.tone, props.seed);
    view()
        .pointer_events(PointerEvents::None)
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .bottom_0()
        .child(canvas(move || backdrop_painter(size.get(), tone, seed)).flex_1())
        .on_layout(move |frame: &Bounds<Points>| {
            size.set((frame.size.width.0, frame.size.height.0))
        })
}

/// The pages: a title, a figure, its note and tone.
const PAGES: [(&str, &str, &str, Tone); 5] = [
    ("Revenue", "48.2k", "+12 %", Tone::Accent),
    ("Sessions", "9,410", "+3 %", Tone::Info),
    ("Latency", "142", "ms p95", Tone::Warn),
    ("Uptime", "99.98", "%", Tone::Up),
    ("Errors", "17", "−40 %", Tone::Danger),
];

/// Full-width pages: one per fling; the indicator and the parallax follow
/// the offset natively.
#[component]
fn Pager() -> impl IntoElement {
    const STEP: f32 = 16.0;
    // The pages' width: the scroll view's. Until the layout tells, as wide
    // as the scroll view would be (the section's inset is 32 + 12 + 28
    // narrower than the window).
    let width = signal(untracked(window).width.0 - 72.0);
    let page = signal(0_usize);
    // The scroll offset, fed natively, and the pages' width as an animated
    // value: the offset in pages (`at`) moves the parallax and the
    // indicator without making them again when the width changes.
    let x = animated_value(0.0);
    let pages_wide = animated_value(width.get_untracked().max(1.0));
    effect(move || pages_wide.set(width.get().max(1.0)));
    let at = x.div(&pages_wide);
    let settle = move |e: &Point<Points>| {
        let width = width.get_untracked();
        if width > 0.0 {
            page.set((e.x.0 / width).round().max(0.0) as usize);
        }
    };
    let pages = PAGES
        .iter()
        .enumerate()
        .map(|(i, &(title, value, note, tone))| {
            let i_f = i as f32;
            let range = [i_f - 1.0, i_f, i_f + 1.0];
            view()
                .w(move || px(width.get()))
                .h(px(160.0))
                .overflow_hidden()
                .child(backdrop().tone(tone).seed(i_f * 1.7))
                .child(
                    view()
                        .p_4()
                        .gap_1()
                        // The text lags behind the page and fades at the edges.
                        .bind_opacity(&at.interpolate(&range, &[0.1, 1.0, 0.1]))
                        .bind_translate_x(
                            &at.interpolate(&range, &[-0.35, 0.0, 0.35]).mul(&pages_wide),
                        )
                        .child(
                            text(format!("{title} · {} of {}", i + 1, PAGES.len()))
                                .text_size(px(13.0))
                                .text_color(colors::MUTED)
                                .tabular_nums(),
                        )
                        .child(Figure::new(value).note(note).tone(tone)),
                )
        })
        .collect::<Vec<_>>();
    let last = (PAGES.len() - 1) as f32;
    view()
        .gap_3()
        .child(
            scroll()
                .horizontal()
                .paging(true)
                .scrollbar(false)
                .scroll_value(&x)
                .h(px(160.0))
                .rounded(px(radius::CONTROL))
                .bg(colors::SURFACE)
                .finish(Finish::Card)
                .border_1()
                .border_color(colors::LINE)
                .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
                .on_momentum_end(settle)
                .on_scroll_end(settle)
                .child(view().flex_row().children(pages)),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .child(
                    view()
                        .flex_row()
                        .gap(px(STEP - 8.0))
                        .children(
                            PAGES
                                .iter()
                                .map(|_| view().size(px(8.0)).rounded(px(4.0)).bg(colors::RAISED)),
                        )
                        .child(
                            view()
                                .absolute()
                                .left_0()
                                .size(px(8.0))
                                .rounded(px(4.0))
                                .bg(colors::ACCENT)
                                .bind_translate_x(
                                    &at.interpolate(&[0.0, last], &[0.0, last * STEP]),
                                ),
                        ),
                )
                .child(
                    text(move || format!("Settled on page {}", page.get() + 1))
                        .flex_1()
                        .text_right()
                        .text_size(px(13.0))
                        .text_color(colors::FAINT)
                        .tabular_nums(),
                ),
        )
}

/// The snap alignments, with their names.
const ALIGNS: [(SnapAlignment, &str); 3] = [
    (SnapAlignment::Start, "start"),
    (SnapAlignment::Center, "center"),
    (SnapAlignment::End, "end"),
];

/// Cards that snap; a fling can pass several unless limited to one.
#[component]
fn Cards() -> impl IntoElement {
    const CARD: f32 = 220.0;
    const GAP: f32 = 12.0;
    // Which of [`ALIGNS`].
    let align = signal(1_usize);
    let one_step = signal(false);
    // A cell shows other cards as it is reused: what differs between cards
    // is bound to its position.
    let cards = virtual_list(20, |at| {
        let tone = move || TONES[at.index() % TONES.len()];
        view()
            .w(px(CARD))
            .h(px(128.0))
            .rounded(px(18.0))
            .border_curve(BorderCurve::Continuous)
            .bg(colors::RAISED)
            .finish(Finish::Raised)
            .border_1()
            .border_color(colors::BORDER)
            .p_4()
            .justify_between()
            .overflow_hidden()
            .child(
                view()
                    .absolute()
                    .top_0()
                    .left_0()
                    .bottom_0()
                    .w(px(3.0))
                    .bg(move || tone().color()),
            )
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .child(
                        text(move || format!("at {} pt", at.index() as f32 * (CARD + GAP)))
                            .flex_1()
                            .text_size(px(13.0))
                            .text_color(colors::FAINT)
                            .tabular_nums(),
                    )
                    .child(Badge::new(move || tone_name(tone())).tone(tone)),
            )
            .child(
                text(move || format!("Card {}", at.index() + 1))
                    .text_size(px(24.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(colors::TEXT)
                    .tabular_nums(),
            )
    })
    .horizontal()
    .estimated_item_size(px(CARD + GAP))
    .snap_interval(px(CARD + GAP))
    .snap_alignment(move || ALIGNS[align.get()].0)
    // `decelerationRate="fast"`.
    .deceleration(0.99)
    .disable_interval_momentum(one_step)
    .scrollbar(false)
    .h(px(128.0))
    .column_gap(px(GAP))
    .content_padding_x(px(14.0));
    view()
        .gap_3()
        .child(view().mx(px(-14.0)).child(cards))
        .child(choice(&ALIGNS.map(|a| a.1), align, move |i: &u32| {
            align.set(*i as usize);
        }))
        .child(switch_row(
            "One card per fling",
            Some("disableIntervalMomentum"),
            None,
            one_step,
            move |on: &bool| one_step.set(*on),
        ))
}

/// The throttles, in milliseconds.
const THROTTLES: [u32; 3] = [0, 100, 500];

/// The drag and momentum events logged, newest first (at most 5): the
/// event, at which offset, its tone.
fn event_log(log: Signal<Vec<(&'static str, f32, Tone)>>) -> impl IntoElement {
    // The entries come and go with each drag: made again then.
    view().gap(px(6.0)).min_h(px(100.0)).child(dynamic(move || {
        log.with(|log| {
            if log.is_empty() {
                return vec![
                    text("No drags yet")
                        .text_size(px(13.0))
                        .text_color(colors::FAINT)
                        .into_element(),
                ];
            }
            log.iter()
                .enumerate()
                .map(|(i, &(name, y, tone))| {
                    view()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .h(px(20.0))
                        .opacity(1.0 - i as f32 * 0.16)
                        .child(view().size(px(8.0)).rounded(px(2.5)).bg(tone.color()))
                        .child(
                            text(name)
                                .flex_1()
                                .text_size(px(13.0))
                                .text_color(colors::MUTED),
                        )
                        .child(
                            text(format!("at {y} pt"))
                                .text_size(px(13.0))
                                .text_color(colors::FAINT)
                                .tabular_nums(),
                        )
                        .into_element()
                })
                .collect()
        })
    }))
}

/// `onScroll` (throttled), drag and momentum events, `scrollable`,
/// bounces, content insets.
#[component]
fn Events() -> impl IntoElement {
    let offset = signal(None::<ScrollEvent>);
    let log = signal(Vec::<(&'static str, f32, Tone)>::new());
    let enabled = signal(true);
    let bounces = signal(true);
    let inset = signal(false);
    // Which of [`THROTTLES`].
    let throttle = signal(1_usize);
    let note = move |name: &'static str, tone: Tone| {
        move |e: &Point<Points>| {
            log.update(|log| {
                log.insert(0, (name, e.y.0.round(), tone));
                log.truncate(5);
            });
        }
    };
    let progress = move || match offset.get() {
        Some(o) if o.content_size.height > o.size.height => {
            o.offset.y / (o.content_size.height - o.size.height)
        }
        _ => 0.0,
    };
    let rows = (1..=30).map(|i: u32| {
        view()
            .flex_row()
            .items_center()
            .gap_3()
            .h(px(32.0))
            .px_3()
            .child(
                text(i.to_string())
                    .w(px(24.0))
                    .text_size(px(12.0))
                    .text_color(colors::FAINT)
                    .tabular_nums()
                    .text_right(),
            )
            .child(
                view()
                    .h(px(4.0))
                    .rounded(px(2.0))
                    .w(relative((20 + (i * 37) % 70) as f32 / 100.0))
                    .bg(colors::RAISED),
            )
    });
    let figure = Figure::new(move || {
        offset
            .get()
            .map_or("0".to_owned(), |o| o.offset.y.0.round().to_string())
    })
    .note(move || {
        offset.get().map_or("Scroll the box".to_owned(), |o| {
            format!("/ {}", o.content_size.height.0.round())
        })
    });
    view()
        .gap_3()
        .child(
            view()
                .flex_row()
                .items_end()
                .child(view().flex_1().child(figure.unit("pt").tone(Tone::Info)))
                .child(
                    text(move || {
                        let viewport = offset
                            .get()
                            .map_or("—".to_owned(), |o| o.size.height.0.round().to_string());
                        format!("viewport {viewport} pt")
                    })
                    .text_size(px(13.0))
                    .text_color(colors::FAINT)
                    .tabular_nums()
                    .pb(px(6.0)),
                ),
        )
        .child(Meter::new(progress).tone(Tone::Info))
        .child(
            scroll()
                .h(px(180.0))
                .rounded(px(radius::CONTROL))
                .bg(colors::SURFACE)
                .finish(Finish::Card)
                .border_1()
                .border_color(colors::LINE)
                .scrollable(enabled)
                .bounces(bounces)
                .content_inset(move || {
                    if inset.get() {
                        EdgeInsets {
                            top: px(40.0),
                            bottom: px(40.0),
                            ..EdgeInsets::default()
                        }
                    } else {
                        EdgeInsets::default()
                    }
                })
                .event_throttle(move || THROTTLES[throttle.get()] as f32)
                .on_scroll(move |e: &ScrollEvent| offset.set(Some(*e)))
                .on_scroll_drag_start(note("begin drag", Tone::Accent))
                .on_scroll_drag_end(note("end drag", Tone::Warn))
                .on_momentum_start(note("momentum begin", Tone::Info))
                .on_momentum_end(note("momentum end", Tone::Up))
                .child(view().py(px(6.0)).children(rows)),
        )
        .child(event_log(log))
        .child(
            view()
                .gap_2()
                .child(caption("Scroll events at most every", Some("ms")))
                .child(choice(&["0", "100", "500"], throttle, move |i: &u32| {
                    throttle.set(*i as usize);
                })),
        )
        .child(
            view()
                .child(switch_row(
                    "Scroll enabled",
                    Some("scrollable"),
                    None,
                    enabled,
                    move |on: &bool| enabled.set(*on),
                ))
                .child(switch_row(
                    "Bounces",
                    Some("bounces"),
                    None,
                    bounces,
                    move |on: &bool| bounces.set(*on),
                ))
                .child(switch_row(
                    "Content inset",
                    None,
                    Some("40 pt at the top and bottom"),
                    inset,
                    move |on: &bool| inset.set(*on),
                )),
        )
}

/// Pinch to zoom (natively); tap a tile to zoom in on it.
#[component]
fn Zoom() -> impl IntoElement {
    let scroll_ref = element_ref();
    // The zoom, as the scroll view reports it.
    let scale = signal(1.0_f32);
    let bounces = signal(true);
    let tiles = (0..24).map(|i| {
        let tone = TONES[(i * 7) % TONES.len()];
        view()
            .w(px(74.0))
            .h(px(50.0))
            .rounded(px(10.0))
            .border_curve(BorderCurve::Continuous)
            .bg(tone.tint())
            .border_1()
            .border_color(colors::BORDER)
            .p(px(6.0))
            .justify_between()
            .on_press(move || {
                // The tile's middle, in the content's (unzoomed) points.
                let x = 6.0 + (i % 4) as f32 * 80.0 + 37.0;
                let y = 6.0 + (i / 4) as f32 * 56.0 + 25.0;
                let to = if scale.get_untracked() < 2.5 {
                    3.0
                } else {
                    1.0
                };
                scroll_ref.zoom_to(to, Some(point(px(x), px(y))), true);
            })
            .child(
                view()
                    .w(px(12.0))
                    .h(px(3.0))
                    .rounded(px(1.5))
                    .bg(tone.color()),
            )
            .child(
                text(format!("Tile {}", i + 1))
                    .text_color(colors::TEXT)
                    .text_size(px(11.0))
                    .tabular_nums(),
            )
    });
    let zoom_button = |label: &'static str, to: f32, variant: ButtonVariant| {
        view().flex_1().child(
            Button::new(label, move |_: &()| scroll_ref.zoom_to(to, None, true)).variant(variant),
        )
    };
    let note = move || {
        let scale = scale.get();
        if scale > 1.01 {
            ("zoomed in", Tone::Accent)
        } else if scale < 0.99 {
            ("zoomed out", Tone::Info)
        } else {
            ("fit", Tone::Info)
        }
    };
    view()
        .gap_3()
        .child(
            view()
                .flex_row()
                .items_end()
                .child(
                    view().flex_1().child(
                        Figure::new(move || format!("{:.2}", scale.get()))
                            .unit("×")
                            .note(move || note().0)
                            .tone(move || note().1),
                    ),
                )
                .child(
                    text("0.5× to 5×")
                        .text_size(px(13.0))
                        .text_color(colors::FAINT)
                        .tabular_nums()
                        .pb(px(6.0)),
                ),
        )
        .child(
            scroll()
                .h(px(240.0))
                .rounded(px(radius::CONTROL))
                .bg(colors::SURFACE)
                .finish(Finish::Card)
                .border_1()
                .border_color(colors::LINE)
                .zoom_range(0.5, 5.0)
                .bounces_zoom(bounces)
                .center_content(true)
                .event_throttle(50.0)
                .on_scroll(move |e: &ScrollEvent| scale.set(e.zoom_scale))
                .element_ref(&scroll_ref)
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .p(px(6.0))
                        .gap(px(6.0))
                        .children(tiles),
                ),
        )
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(zoom_button("0.5×", 0.5, ButtonVariant::Secondary))
                .child(zoom_button("1×", 1.0, ButtonVariant::Primary))
                .child(zoom_button("2×", 2.0, ButtonVariant::Secondary)),
        )
        .child(switch_row(
            "Bounces past the limits",
            Some("bouncesZoom"),
            None,
            bounces,
            move |on: &bool| bounces.set(*on),
        ))
}

/// A post of the feed.
#[derive(Debug, Clone, PartialEq)]
struct Post {
    id: u32,
    label: String,
    fresh: bool,
}

/// New items arrive at the top; the rows on screen stay where they are.
#[component]
fn Feed() -> impl IntoElement {
    // The id of the next post, and the new posts so far.
    let next = stored(0_u32);
    let fresh = stored(0_u32);
    let post = move |label: String, fresh: bool| {
        let id = next.with(|n| {
            *n += 1;
            *n - 1
        });
        Post { id, label, fresh }
    };
    let posts = signal(
        (1..=30)
            .map(|i| post(format!("Post {i}"), false))
            .collect::<Vec<_>>(),
    );
    let add = move |_: &()| {
        let added: Vec<_> = (0..3)
            .map(|_| {
                let n = fresh.with(|n| {
                    *n += 1;
                    *n
                });
                post(format!("New {n}"), true)
            })
            .collect();
        posts.update(|p| {
            p.splice(0..0, added);
        });
    };
    view()
        .gap_3()
        .child(
            virtual_list(
                move || posts.with(Vec::len),
                move |at| {
                    // A cell shows other posts as it is reused: what it
                    // shows is bound to its position.
                    let new = computed(move || posts.with(|p| p[at.index()].fresh));
                    view()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .h(px(48.0))
                        .px(px(14.0))
                        .border_b_1()
                        .border_b_color(colors::LINE)
                        .child(view().size(px(8.0)).rounded(px(4.0)).bg(move || {
                            if new.get() {
                                colors::ACCENT
                            } else {
                                colors::RAISED
                            }
                        }))
                        .child(
                            text(move || posts.with(|p| p[at.index()].label.clone()))
                                .flex_1()
                                .text_size(px(15.0))
                                .text_color(move || {
                                    if new.get() {
                                        colors::TEXT
                                    } else {
                                        colors::MUTED
                                    }
                                }),
                        )
                        .child(
                            when(new, || Badge::new("new").tone(Tone::Accent)).otherwise(
                                move || {
                                    text(move || format!("#{}", posts.with(|p| p[at.index()].id)))
                                        .text_size(px(13.0))
                                        .text_color(colors::FAINT)
                                        .tabular_nums()
                                },
                            ),
                        )
                },
            )
            .keys(move || posts.with(|p| p.iter().map(|p| p.id).collect::<Vec<_>>()))
            .estimated_item_size(px(48.0))
            .h(px(240.0))
            .rounded(px(radius::CONTROL))
            .bg(colors::SURFACE)
            .finish(Finish::Card)
            .border_1()
            .border_color(colors::LINE),
        )
        .child(caption(
            "Scroll down a little, then add",
            Some(move || format!("{} posts", posts.with(Vec::len))),
        ))
        .child(Button::new("Add 3 posts on top", add).icon(IconName::Plus))
}

/// The keyboard taps settings, with their names.
const TAPS: [(KeyboardTaps, &str); 3] = [
    (KeyboardTaps::Never, "never"),
    (KeyboardTaps::Handled, "handled"),
    (KeyboardTaps::Always, "always"),
];

/// The demo's page.
#[component]
pub(crate) fn Scrolling() -> impl IntoElement {
    // Which of [`TAPS`].
    let taps = signal(0_usize);
    let presses = signal(0_u32);
    let explained = move || match TAPS[taps.get()].0 {
        KeyboardTaps::Never => {
            "A tap outside the input only hides the keyboard; the button does not get it."
        }
        KeyboardTaps::Handled => {
            "The button gets the tap and the keyboard stays; a tap on empty space hides it."
        }
        KeyboardTaps::Always => "Taps never hide the keyboard.",
    };
    let tap_me = move || {
        press()
            .label("Count a tap")
            .on_press(move || presses.update(|p| *p += 1))
            .child(
                view()
                    .h(px(44.0))
                    .rounded(px(radius::CONTROL))
                    .border_curve(BorderCurve::Continuous)
                    .bg(colors::LIGHT)
                    .finish(Finish::Light)
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .child(
                        text(hint("Tap me", "Click me"))
                            .text_size(px(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors::ON_LIGHT),
                    )
                    .child(
                        text(move || presses.get().to_string())
                            .text_size(px(15.0))
                            .text_color(AdaptiveColor::new(rgb(0x9a9ea4), rgb(0x55595f)))
                            .tabular_nums(),
                    ),
            )
    };
    let taps_section = move || {
        Section::new("Taps with the keyboard up")
            .child(api("keyboardShouldPersistTaps"))
            .child(choice(&TAPS.map(|t| t.1), taps, move |i: &u32| {
                taps.set(*i as usize);
            }))
            .child(
                text(explained)
                    .text_color(colors::MUTED)
                    .text_size(px(13.0))
                    .line_height(px(18.0)),
            )
            .child(
                input()
                    .placeholder(hint(
                        "Type here, then tap the button",
                        "Type here, then click the button",
                    ))
                    .placeholder_color(|| color(colors::FAINT))
                    .selection_color(|| color(colors::ACCENT))
                    .h(px(44.0))
                    .text_size(px(15.0))
                    .text_color(colors::TEXT)
                    .bg(colors::SURFACE)
                    .finish(Finish::Inset)
                    .border_1()
                    .border_color(colors::BORDER)
                    .rounded(px(radius::CONTROL))
                    .px(px(14.0)),
            )
            .child(tap_me())
            .child(view().h(px(300.0)))
    };
    DemoPage::new()
        .appear(false)
        .bottom(16.0)
        .keyboard_taps(move || TAPS[taps.get()].0)
        .card(|| {
            Section::new("Paging")
                .note("5 pages")
                .child(api("pagingEnabled · scrollValue"))
                .child(pager())
        })
        .card(|| {
            Section::new("Snapping")
                .note("20 cards")
                .child(api("snapToInterval · snapToAlignment"))
                .child(cards())
        })
        .card(|| {
            Section::new("Zoom")
                .note(hint(
                    "Pinch or tap a tile",
                    "Pinch on a touchpad or click a tile",
                ))
                .child(api("maximumZoomScale · zoomTo()"))
                .child(zoom())
        })
        .card(|| {
            Section::new("Events and behavior")
                .child(api("onScroll · onScrollDragStart · onMomentumEnd"))
                .child(events())
        })
        .card(|| Section::new("Prepending keeps the position").child(feed()))
        .card(taps_section)
}
