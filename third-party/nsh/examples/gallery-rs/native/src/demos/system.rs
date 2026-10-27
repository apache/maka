//! System: the environment, the status bar, alerts and action sheets,
//! display frames and timers, the network and logs (as the TSX
//! gallery's `demos/System.tsx`).

use std::time::Duration;

use nsh_base::{AlertDialogOptions, alert_dialog, dialog};
use nsh_core::{
    animation::{Curve, EaseMode},
    element::AnyElement,
    keymap::When,
    prelude::*,
    time::Instant,
};

use crate::ui::{
    Badge, Button, ButtonVariant, Card, DemoPage, Figure, Finish, Finished, IconName, IconTile,
    Inset, MONO, Meter, Row, Segment, Stat, Tone, appear, caption, colors, icon, inset_shadow,
    legend, press, rgb_a, segmented, tints, toggle,
};

/// The status bar's styles, in the segments' order.
const BAR_STYLES: [(StatusBarStyle, &str, &str); 3] = [
    (StatusBarStyle::Light, "light", "Light"),
    (StatusBarStyle::Dark, "dark", "Dark"),
    (StatusBarStyle::Default, "auto", "Auto"),
];

/// The posts the network card asks for.
const POSTS: &str = "https://jsonplaceholder.typicode.com/posts?_limit=3";

/// The label of the action chosen, or `"dismissed"`.
fn chosen(label: Option<&str>) -> String {
    label.unwrap_or("dismissed").to_owned()
}

/// A text and the tone it shows in.
#[derive(Debug, Clone, PartialEq)]
struct Toned {
    text: String,
    tone: Tone,
}

/// The posts of a JSON array of `{ id, title }`.
fn parse_posts(body: &str) -> Result<Vec<(u64, String)>, String> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let posts = value.as_array().ok_or("not an array")?;
    Ok(posts
        .iter()
        .map(|post| {
            (
                post["id"].as_u64().unwrap_or_default(),
                post["title"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect())
}

/// A thin rule between the parts of a card.
fn rule() -> AnyElement {
    view().h(px(1.0)).bg(colors::LINE).into_element()
}

/// A small label above a figure.
fn label(content: &'static str) -> Text {
    text(content).text_size(px(12.0)).text_color(colors::MUTED)
}

/// The window drawn to scale, with the safe area insets and the keyboard
/// shaded (bound: it follows the window, the insets and the keyboard).
fn safe_area_diagram() -> AnyElement {
    let width = 76.0;
    let band = move |pt: f32| {
        px((pt * width / window().width.max(px(1.0)).0)
            .round()
            .max(0.0))
    };
    view()
        .w(px(width))
        .h(move || px((window().height * width / window().width.max(px(1.0))).round()))
        .rounded(px(14.0))
        .border_curve(BorderCurve::Continuous)
        .border(px(1.5))
        .border_color(colors::BORDER)
        .bg(colors::SURFACE)
        .finish_fill(Finish::Card)
        .adaptive_shadow(
            [inset_shadow(1.0, 0.0, rgb(0xffffff))],
            [inset_shadow(1.0, 0.0, rgb_a(0xffffff, 0.06))],
        )
        .overflow_hidden()
        .child(view().h(move || band(safe_area().top.0)).bg(tints::INFO))
        .child(
            view()
                .flex_1()
                .m(px(6.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(colors::LINE)
                .border_dashed(),
        )
        .child(view().h(move || band(keyboard_height().0)).bg(tints::WARN))
        .child(view().h(move || band(safe_area().bottom.0)).bg(tints::INFO))
        .into_element()
}

/// The environment: every value is read in a binding.
fn environment() -> AnyElement {
    type Edge = fn(EdgeInsets) -> f32;
    let insets: [(&str, Edge); 4] = [
        ("Top", |i| i.top.0),
        ("Right", |i| i.right.0),
        ("Bottom", |i| i.bottom.0),
        ("Left", |i| i.left.0),
    ];
    let insets = insets.map(|(label, value)| {
        Stat::new(label, move || value(safe_area()).round().to_string()).width(0.25)
    });
    let keyboard_stat =
        || Stat::new("Keyboard", || format!("{} pt", keyboard_height().0.round())).width(0.5);
    Card::new()
        .icon(IconName::System)
        .title("Environment")
        .subtitle("Updates when the window, insets or keyboard change")
        .right(Badge::new("Live").tone(Tone::Up))
        .child(
            view()
                .flex_row()
                .gap_4()
                .items_center()
                .child(
                    view()
                        .flex_1()
                        .gap_3()
                        .child(
                            view().gap(px(2.0)).child(label("Window")).child(
                                Figure::new(|| {
                                    let window = window();
                                    format!(
                                        "{} × {}",
                                        window.width.0.round(),
                                        window.height.0.round()
                                    )
                                })
                                .unit("pt"),
                            ),
                        )
                        .child(
                            view()
                                .flex_row()
                                .child(
                                    when(
                                        || keyboard_height() > px(0.0),
                                        move || keyboard_stat().tone(Tone::Warn),
                                    )
                                    .otherwise(keyboard_stat),
                                )
                                .child(
                                    Stat::new("Font scale", || format!("{:.2}×", font_scale()))
                                        .width(0.5),
                                ),
                        ),
                )
                .child(safe_area_diagram()),
        )
        .child(rule())
        .child(
            view()
                .gap_1()
                .child(caption("Safe area insets", Some("pt")))
                .child(view().flex_row().children(insets)),
        )
        .child(rule())
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_4()
                .child(legend(colors::INFO, "Safe area", None::<&str>))
                .child(legend(colors::WARN, "Keyboard", None::<&str>))
                .child(view().flex_1())
                .child(
                    Badge::new(|| {
                        if dark() {
                            "Dark scheme"
                        } else {
                            "Light scheme"
                        }
                    })
                    .tone(|| if dark() { Tone::Info } else { Tone::Warn })
                    .outline(),
                ),
        )
        .into_element()
}

/// The status bar: its style (following the appearance until one is
/// picked) and whether it is hidden, shown by a dialog's `status_bar`
/// while it is open (over the page's).
#[component]
fn StatusBarCard() -> impl IntoElement {
    // The style the user picked.
    let picked = signal(None::<usize>);
    let hidden = signal(false);
    let open = signal(false);
    // Until one is picked, the style follows the appearance (light text
    // on the dark page).
    let index = computed(move || picked.get().unwrap_or(if dark() { 0 } else { 1 }));
    let preview = when(open, move || {
        // The background its content is for.
        let backdrop = move || match index.get() {
            0 => AdaptiveColor::from(rgb(0x101113)),
            1 => AdaptiveColor::from(rgb(0xf4f4f2)),
            _ => colors::BACKGROUND,
        };
        let ink = move || {
            if index.get() == 0 {
                AdaptiveColor::from(rgb(0xffffff))
            } else {
                AdaptiveColor::from(rgb(0x111214))
            }
        };
        dialog()
            .animation(ModalAnimation::Fade)
            .status_bar(move || {
                StatusBarSetting::default()
                    .foreground(BAR_STYLES[index.get()].0)
                    .hidden(hidden.get())
                    .animated(true)
            })
            .on_cancel(move || open.set(false))
            .child(
                view()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_4()
                    .bg(backdrop)
                    .child(
                        text(move || {
                            format!(
                                "statusBar: {{ foreground: \"{}\", hidden: {} }}",
                                BAR_STYLES[index.get()].1,
                                hidden.get()
                            )
                        })
                        .text_size(px(13.0))
                        .text_color(ink)
                        .font_family(MONO),
                    )
                    .child(Button::new("Close", move |_: &()| open.set(false))),
            )
    });
    Card::new()
        .icon(IconName::Mobile)
        .title("Status bar")
        .subtitle("A dialog's statusBar: over the page's while it is open")
        .child(
            segmented()
                .options(BAR_STYLES.map(|(_, _, label)| Segment::new(label)))
                .selected(move || index.get() as u32)
                .on_change(move |&i: &u32| {
                    picked.set(Some(i as usize));
                }),
        )
        .child(
            Row::new(false)
                .child(
                    view()
                        .flex_1()
                        .gap(px(2.0))
                        .child(text("Hidden").text_size(px(15.0)).text_color(colors::TEXT))
                        .child(
                            text(move || format!("foreground: \"{}\"", BAR_STYLES[index.get()].1))
                                .text_size(px(12.0))
                                .text_color(colors::MUTED)
                                .font_family(MONO),
                        ),
                )
                .child(
                    toggle()
                        .value(hidden)
                        .label("Hide the status bar")
                        .on_change(move |&on: &bool| {
                            hidden.set(on);
                        }),
                ),
        )
        .child(Button::new("Preview", move |_: &()| open.set(true)).icon(IconName::Mobile))
        .child(preview)
}

/// A tappable row with an icon tile, a title, a detail and a chevron.
fn action_row(
    first: bool,
    name: IconName,
    tint: AdaptiveColor,
    title: &'static str,
    detail: &'static str,
    on_press: impl Into<Listener<()>>,
) -> AnyElement {
    let on_press: Listener<()> = on_press.into();
    press()
        .scale(0.98)
        .label(title)
        .on_press(on_press)
        .child(
            Row::new(first)
                .child(IconTile::new(name).tint(tint).size(34.0))
                .child(
                    view()
                        .flex_1()
                        .gap(px(1.0))
                        .py_2()
                        .child(text(title).text_size(px(15.0)).text_color(colors::TEXT))
                        .child(text(detail).text_size(px(12.0)).text_color(colors::MUTED)),
                )
                .child(
                    icon()
                        .name(IconName::Chevron)
                        .size(14.0)
                        .tint(colors::FAINT),
                ),
        )
        .into_element()
}

/// System dialogs; the last answer pops in.
#[component]
fn Dialogs() -> impl IntoElement {
    // What the last dialog answered.
    let answer = signal(None::<Toned>);
    // Pops the answer in each time it changes.
    let pop = animated_value(1.0);
    let owner = Owner::current();
    // Shows `dialog`, then what `answered` makes of the label chosen (none:
    // dismissed), popping it in.
    let ask = move |dialog: AlertDialogOptions, answered: fn(Option<&str>) -> Toned| {
        let chosen = dialog.show();
        owner.run(|| {
            spawn(async move {
                let label = chosen.await.ok().flatten();
                answer.set(Some(answered(label.as_deref())));
                pop.set(0.85);
                pop.spring(
                    1.0,
                    Spring {
                        stiffness: 380.0,
                        damping: 18.0,
                        ..Spring::default()
                    },
                );
            })
        });
    };
    let alert = move |_: &()| {
        let dialog = alert_dialog()
            .title("Saved")
            .description("Your changes were saved.")
            .action("OK");
        ask(dialog, |_| Toned {
            text: "OK".to_owned(),
            tone: Tone::Up,
        });
    };
    let confirm = move |_: &()| {
        let dialog = alert_dialog()
            .title("Delete the photo?")
            .description("This cannot be undone.")
            .cancel("Cancel")
            .destructive("Delete")
            .close_on_escape(true)
            .close_on_backdrop_press(true);
        ask(dialog, |label| Toned {
            tone: if label == Some("Delete") {
                Tone::Danger
            } else {
                Tone::Neutral
            },
            text: chosen(label),
        });
    };
    let three = move |_: &()| {
        let dialog = alert_dialog()
            .title("Update available")
            .description("Install it now?")
            .action("Later")
            .cancel("Never")
            .action("Install");
        ask(dialog, |label| Toned {
            tone: if label == Some("Install") {
                Tone::Info
            } else {
                Tone::Neutral
            },
            text: chosen(label),
        });
    };
    let sheet = move |_: &()| {
        let dialog = alert_dialog()
            .title("Share the photo")
            .action_sheet()
            .cancel("Cancel")
            .action("Copy link")
            .action("Save")
            .destructive("Delete");
        // Dismissing the sheet is its cancel action (as `ActionSheet.show`
        // answers).
        ask(dialog, |label| Toned {
            tone: if label == Some("Delete") {
                Tone::Danger
            } else {
                Tone::Accent
            },
            text: label.unwrap_or("Cancel").to_owned(),
        });
    };
    let shown = when(
        move || answer.with(Option::is_some),
        move || {
            view().bind_scale(&pop).child(
                Badge::new(move || {
                    answer.with(|a| a.as_ref().map(|a| a.text.clone()).unwrap_or_default())
                })
                .tone(move || answer.with(|a| a.as_ref().map_or(Tone::Neutral, |a| a.tone))),
            )
        },
    )
    .otherwise(|| {
        text("None yet")
            .text_size(px(13.0))
            .text_color(colors::FAINT)
    });
    Card::new()
        .icon(IconName::Bell)
        .title("Alerts and sheets")
        .subtitle("Alert · ActionSheet")
        .flush()
        .child(
            Inset::new()
                .gap(0.0)
                .padding(12.0)
                .child(action_row(
                    true,
                    IconName::Check,
                    colors::UP,
                    "Alert",
                    "One button",
                    alert,
                ))
                .child(action_row(
                    false,
                    IconName::Bell,
                    colors::DANGER,
                    "Confirm",
                    "Cancel and destructive buttons",
                    confirm,
                ))
                .child(action_row(
                    false,
                    IconName::Star,
                    colors::INFO,
                    "Three buttons",
                    "Resolves to the index pressed",
                    three,
                ))
                .child(action_row(
                    false,
                    IconName::Lists,
                    colors::ACCENT,
                    "Action sheet",
                    "Title, cancel and destructive options",
                    sheet,
                )),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(10.0))
                .px(px(11.0))
                .pt_3()
                .pb(px(11.0))
                .min_h(px(44.0))
                .child(
                    text("Answer")
                        .flex_1()
                        .text_size(px(13.0))
                        .text_color(colors::MUTED),
                )
                .child(shown),
        )
}

/// Display frames counted while asked, and an interval's ticks.
#[component]
fn FramesAndTimers() -> impl IntoElement {
    // Seconds since the page opened, counted by an interval.
    let ticks = signal(0_u32);
    // Flashes the beat dot once per tick (the fade runs natively).
    let beat = animated_value(0.0);
    set_interval(Duration::from_secs(1), move || {
        ticks.update(|t| *t += 1);
        beat.set(1.0);
        beat.timing(0.0, 700.0, Easing::Curve(Curve::Quad, EaseMode::Out));
    });
    // Counts the display frames while it runs ("Count frames").
    let frames = stored(None::<Spawned<()>>);
    let running = signal(false);
    // Frames since `since`, and when they started.
    let counted = stored((0_u32, None::<Instant>));
    // Frames per second, over the last second.
    let fps = signal(0_u32);
    let owner = Owner::current();
    // A frame began at `at`: once a second, the rate.
    let frame = move |at: Instant| {
        let rate = counted.with(|(count, since)| {
            *count += 1;
            let start = *since.get_or_insert(at);
            let elapsed = at.saturating_duration_since(start).as_secs_f64();
            (elapsed >= 1.0).then(|| {
                let rate = (f64::from(*count) / elapsed).round() as u32;
                *count = 0;
                *since = Some(at);
                rate
            })
        });
        if let Some(rate) = rate {
            fps.set(rate);
        }
    };
    // Starts or stops counting frames: a task awaits each display frame
    // (TS: `requestAnimationFrame` asking again from its callback).
    let toggle_frames = move |_: &()| {
        if let Some(task) = frames.replace(None) {
            task.cancel();
            running.set(false);
            return;
        }
        counted.replace((0, Some(Instant::now())));
        let task = owner.run(|| {
            spawn(async move {
                loop {
                    frame(next_frame().await);
                }
            })
        });
        frames.replace(Some(task));
        running.set(true);
    };
    Card::new()
        .icon(IconName::Animation)
        .title("Frames and timers")
        .subtitle("requestAnimationFrame · setInterval")
        .child(
            view()
                .flex_row()
                .gap_3()
                .child(
                    view()
                        .flex_1()
                        .gap(px(2.0))
                        .child(label("Frame rate"))
                        .child(
                            Figure::new(move || {
                                if running.get() {
                                    fps.get().to_string()
                                } else {
                                    "–".to_owned()
                                }
                            })
                            .unit("fps")
                            .note(move || if running.get() { "live" } else { "stopped" })
                            .tone(move || {
                                if running.get() {
                                    Tone::Up
                                } else {
                                    Tone::Neutral
                                }
                            }),
                        ),
                )
                .child(view().w(px(1.0)).bg(colors::LINE))
                .child(
                    view()
                        .flex_1()
                        .gap(px(2.0))
                        .child(
                            view()
                                .flex_row()
                                .items_center()
                                .gap(px(6.0))
                                .child(label("Interval ticks"))
                                .child(
                                    view()
                                        .size(px(7.0))
                                        .rounded(px(3.5))
                                        .bg(colors::ACCENT)
                                        .bind_opacity(&beat.interpolate(&[0.0, 1.0], &[0.25, 1.0]))
                                        .bind_scale(&beat.interpolate(&[0.0, 1.0], &[1.0, 1.6])),
                                ),
                        )
                        .child(
                            Figure::new(move || ticks.get().to_string())
                                .note("every 1 s")
                                .tone(Tone::Accent),
                        ),
                ),
        )
        .child(
            view()
                .gap_2()
                .child(caption(
                    "Share of 120 fps",
                    Some(move || {
                        if running.get() {
                            format!("{}%", (f64::from(fps.get()) / 120.0 * 100.0).round())
                        } else {
                            "–".to_owned()
                        }
                    }),
                ))
                .child(
                    Meter::new(move || {
                        if running.get() {
                            fps.get() as f32 / 120.0
                        } else {
                            0.0
                        }
                    })
                    .tone(Tone::Up)
                    .marker(0.5),
                ),
        )
        .child(
            Button::new(
                move || {
                    if running.get() {
                        "Stop counting frames"
                    } else {
                        "Count frames"
                    }
                },
                toggle_frames,
            )
            .icon(move || {
                if running.get() {
                    IconName::Pause
                } else {
                    IconName::Play
                }
            }),
        )
}

/// Three posts loaded over HTTP, and a log line.
#[component]
fn Network() -> impl IntoElement {
    // Loads once asked, and again on each press after (TS: `resource`): it
    // keeps the posts while it loads again, and a failure next to them. The
    // request goes with the engine's network stack (TS: `fetch`): the
    // platform's, or the browser's on the web.
    let asked = signal(false);
    let result = resource(
        move || asked.get().then_some(()),
        |(), _| async move {
            let started = Instant::now();
            let response = fetch(POSTS).await?;
            let (code, posts) = (response.status(), parse_posts(&response.text())?);
            let ms = started.elapsed().as_millis();
            Ok::<_, String>((code, posts, ms))
        },
    );
    // The posts loaded: id and title.
    let posts = computed(move || {
        result
            .with(|r| r.map(|(_, posts, _)| posts.clone()))
            .unwrap_or_default()
    });
    // How the last request went.
    let status = computed(move || {
        if result.loading() {
            return Some(Toned {
                text: "loading…".to_owned(),
                tone: Tone::Neutral,
            });
        }
        if let Some(error) = result.error() {
            return Some(Toned {
                text: error,
                tone: Tone::Danger,
            });
        }
        result.with(|r| {
            r.map(|(code, _, ms)| Toned {
                text: format!("HTTP {code} · {ms} ms"),
                tone: if (200..300).contains(code) {
                    Tone::Up
                } else {
                    Tone::Danger
                },
            })
        })
    });
    // A request is in progress.
    let loading = computed(move || result.loading());
    let load = move |_: &()| {
        if asked.get_untracked() {
            result.refetch();
        } else {
            asked.set(true);
        }
    };
    let list = when(
        move || posts.with(Vec::is_empty),
        || {
            caption(
                "Three posts from jsonplaceholder.typicode.com",
                None::<&str>,
            )
        },
    )
    .otherwise(move || {
        view().child(each(
            move || {
                posts.with(|p| {
                    p.iter()
                        .cloned()
                        .enumerate()
                        .collect::<Vec<(usize, (u64, String))>>()
                })
            },
            |(_, (id, _))| *id,
            |post, _| {
                let i = post.with_untracked(|(i, _)| *i);
                appear().index(i as u32).child(
                    Row::new(i == 0)
                        .child(
                            text(move || post.with(|(_, (id, _))| format!("#{id}")))
                                .w(px(28.0))
                                .text_size(px(13.0))
                                .text_color(colors::ACCENT)
                                .tabular_nums(),
                        )
                        .child(
                            text(move || post.with(|(_, (_, title))| title.clone()))
                                .number_of_lines(1)
                                .flex_1()
                                .text_size(px(15.0))
                                .text_color(colors::TEXT),
                        ),
                )
            },
        ))
    });
    let status_row = dynamic(move || {
        status.get().map(|status| {
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(
                    view()
                        .size(px(7.0))
                        .rounded(px(3.5))
                        .bg(status.tone.color()),
                )
                .child(
                    text(status.text)
                        .number_of_lines(2)
                        .flex_1()
                        .text_size(px(13.0))
                        .text_color(status.tone.color())
                        .tabular_nums(),
                )
        })
    });
    Card::new()
        .icon(IconName::Search)
        .title("Network and logs")
        .subtitle("fetch · log::info!")
        .child(list)
        .child(status_row)
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(
                    Button::new(
                        move || {
                            if loading.get() {
                                "Loading…"
                            } else {
                                "fetch()"
                            }
                        },
                        load,
                    )
                    .icon(IconName::ArrowDown)
                    .disabled(loading)
                    .flex_1(),
                )
                .child(
                    Button::new("log::info!", |_: &()| {
                        log::info!(target: "gallery", "hello from the gallery");
                    })
                    .variant(ButtonVariant::Secondary)
                    .flex_1(),
                ),
        )
        .child(
            text("log::info! shows in the terminal of nsh run.")
                .text_size(px(12.0))
                .text_color(colors::FAINT),
        )
}

/// App-level shortcuts: bound while the demo shows (the component's own).
#[component]
fn Shortcuts() -> impl IntoElement {
    let count = signal(0_u32);
    let on = signal(false);
    let last = signal(SharedString::default());
    on_key("mod+k", move |k| {
        count.update(|c| *c += 1);
        last.set(k.to_owned().into());
    });
    on_key("mod+shift+l", move |k| {
        on.update(|on| *on = !*on);
        last.set(k.to_owned().into());
    });
    on_key_with(
        "mod+backspace",
        KeyOptions {
            when: When::NotEditing,
            ..KeyOptions::default()
        },
        move |k| {
            count.set(0);
            last.set(k.to_owned().into());
        },
    );
    let keys = [
        (key_label("mod+k"), "Counts"),
        (key_label("mod+shift+l"), "Switches the light"),
        (key_label("mod+backspace"), "Resets (not while typing)"),
    ];
    Card::new()
        .icon(IconName::Bell)
        .title("Keyboard shortcuts")
        .subtitle("on_key · desktop")
        .child(
            view().children(keys.into_iter().enumerate().map(|(i, (key, what))| {
                Row::new(i == 0)
                    .child(
                        text(key)
                            .w(px(120.0))
                            .text_size(px(14.0))
                            .text_color(colors::ACCENT)
                            .font_family(MONO),
                    )
                    .child(
                        text(what)
                            .flex_1()
                            .text_size(px(15.0))
                            .text_color(colors::TEXT),
                    )
            })),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(
                    Badge::new(move || if on.get() { "Light on" } else { "Light off" })
                        .tone(move || if on.get() { Tone::Up } else { Tone::Neutral }),
                )
                .child(view().flex_1().child(caption(
                    move || format!("Counted {}", count.get()),
                    Some(move || {
                        let last = last.get();
                        if last.is_empty() { "–".into() } else { last }
                    }),
                ))),
        )
}

/// The demo's page.
#[component]
pub(crate) fn System() -> impl IntoElement {
    DemoPage::new()
        .card(environment)
        .card(status_bar_card)
        .card(dialogs)
        .card(frames_and_timers)
        .card(shortcuts)
        .card(network)
}
