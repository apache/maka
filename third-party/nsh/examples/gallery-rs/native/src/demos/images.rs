//! Images: resize modes, corners, tint, GIF / WebP, placeholders and fades,
//! blur, sizes and prefetching, load events (as the TSX gallery's
//! `demos/Images.tsx`).

use nsh_core::{
    Points, Size,
    element::{AnyElement, Image, ImageProgress, ImageSize},
    prelude::*,
};

use crate::{
    assets::{BOUNCE, LOGO, SPINNER},
    ui::{
        Badge, Button, ButtonVariant, Card, DemoPage, Finish, Finished, IconName, MONO, Meter,
        Tone, appear, caption, colors, radius,
    },
};

/// A fixed photo (in color), large enough to stay sharp at 3x.
const WIDE: &str = "https://picsum.photos/id/1015/1200/600";

/// Photo `id` at `w` × `h` pixels.
fn photo(id: u32, w: u32, h: u32) -> String {
    format!("https://picsum.photos/id/{id}/{w}/{h}")
}

/// A large photo (`image_size`, `prefetch_image`, progress).
fn big() -> String {
    photo(1018, 2400, 1600)
}

/// Every photo's frame: rounded, a hairline border, a raised fill while it
/// loads.
fn frame(image: Image) -> Image {
    image
        .rounded(px(radius::CONTROL))
        .border_curve(BorderCurve::Continuous)
        .border_1()
        .border_color(colors::BORDER)
        .bg(colors::RAISED)
}

/// A quiet label under a tile (`code` for API values).
fn note(content: impl Into<SharedString>, code: bool) -> AnyElement {
    text(content.into())
        .number_of_lines(1)
        .text_size(px(13.0))
        .text_color(colors::MUTED)
        .when(code, |t| t.font_family(MONO))
        .tabular_nums()
        .text_center()
        .into_element()
}

/// A tile on the inset: something centered on a raised square, a note
/// below.
fn tile(note_text: &str, code: bool, height: f32, content: impl IntoElement) -> AnyElement {
    view()
        .flex_1()
        .gap_2()
        .child(
            view()
                .h(px(height))
                .rounded(px(radius::CONTROL))
                .border_curve(BorderCurve::Continuous)
                .bg(colors::RAISED)
                .finish(Finish::Raised)
                .border_1()
                .border_color(colors::BORDER)
                .items_center()
                .justify_center()
                .child(content),
        )
        .child(note(note_text.to_owned(), code))
        .into_element()
}

/// A 2:1 image in squares, one per resize mode.
fn resize_modes() -> AnyElement {
    let rows = [
        [
            (ResizeMode::Cover, "cover"),
            (ResizeMode::Contain, "contain"),
        ],
        [
            (ResizeMode::Stretch, "stretch"),
            (ResizeMode::Center, "center"),
        ],
    ]
    .map(|row| {
        view().flex_row().gap_3().children(row.map(|(mode, name)| {
            view()
                .flex_1()
                .gap_2()
                .child(frame(image(WIDE).resize_mode(mode)).h(px(140.0)))
                .child(note(name, true))
        }))
    });
    Card::new()
        .icon(IconName::Image)
        .title("Resize modes")
        .subtitle("A 2:1 image in square frames")
        .children(rows)
        .into_element()
}

fn corners() -> AnyElement {
    let square = || frame(image(WIDE)).size(px(88.0));
    let item = |image: Image, label: &'static str| {
        view()
            .items_center()
            .gap_2()
            .child(image)
            .child(note(label, false))
    };
    Card::new()
        .icon(IconName::Styles)
        .title("Corners and borders")
        .subtitle("Radii per corner, borders on the image")
        .child(
            view()
                .flex_row()
                .justify_between()
                .child(item(square().rounded(px(44.0)), "Circle"))
                .child(item(
                    square()
                        .rounded(px(18.0))
                        .border_2()
                        .border_color(colors::ACCENT),
                    "Border",
                ))
                .child(item(
                    square()
                        .rounded(px(0.0))
                        .rounded_tl(px(40.0))
                        .rounded_br(px(40.0)),
                    "Two corners",
                )),
        )
        .into_element()
}

fn assets() -> AnyElement {
    // At its natural size (64 × 64 points: `@2x` of 128 pixels).
    let tints = [
        ("Accent", Tone::Accent),
        ("Info", Tone::Info),
        ("Danger", Tone::Danger),
    ]
    .map(|(label, tone)| tile(label, false, 76.0, image(LOGO).tint_color(tone.color())));
    Card::new()
        .icon(IconName::Star)
        .title("Assets and tint")
        .subtitle("logo@2x.png, tinted natively")
        .child(
            view()
                .flex_row()
                .gap_3()
                .child(tile("Original", false, 76.0, image(LOGO)))
                .children(tints),
        )
        .into_element()
}

fn animated() -> AnyElement {
    Card::new()
        .icon(IconName::Animation)
        .title("Animated GIF and WebP")
        .subtitle("Decoded and played natively")
        .child(
            view()
                .flex_row()
                .gap_3()
                .child(tile("bounce.gif", true, 96.0, image(BOUNCE)))
                .child(tile("spinner.webp", true, 96.0, image(SPINNER)))
                .child(tile(
                    "Scaled, round",
                    false,
                    96.0,
                    image(BOUNCE).size(px(48.0)).rounded(px(24.0)),
                )),
        )
        .into_element()
}

/// Network images behind a placeholder, fading in; "Reload" asks for
/// images that are not cached yet (`seed` counts the loads).
fn placeholders(seed: Signal<u32>) -> AnyElement {
    // A new size per reload: a URL not in the cache yet.
    let images = [(1043, 0u32), (1080, 300), (1069, 1000)].map(|(id, ms)| {
        view()
            .flex_1()
            .gap_2()
            .child(
                frame(
                    image(move || {
                        let side = 600 + seed.get();
                        photo(id, side, side)
                    })
                    .placeholder(LOGO)
                    .fade_duration(ms as f32)
                    .resize_mode(ResizeMode::Cover),
                )
                .h(px(100.0)),
            )
            .child(note(format!("{ms} ms"), false))
    });
    let reload = move |_: &()| seed.update(|s| *s += 1);
    Card::new()
        .icon(IconName::Photos)
        .title("Placeholder and fade")
        .subtitle("A placeholder, then a fade")
        .right(Button::new("Reload", reload).variant(ButtonVariant::Secondary))
        .child(view().flex_row().gap_3().children(images))
        .child(caption("Loads", Some(move || seed.get().to_string())))
        .into_element()
}

fn blur() -> AnyElement {
    let images = [0u32, 2, 6, 16].map(|r| {
        view()
            .flex_1()
            .gap_2()
            .child(frame(image(WIDE).blur_radius(r as f32)).h(px(76.0)))
            .child(note(
                if r == 0 {
                    "None".to_owned()
                } else {
                    format!("{r} pt")
                },
                false,
            ))
    });
    Card::new()
        .icon(IconName::Spark)
        .title("Blur radius")
        .subtitle("blurRadius, applied while decoding")
        .child(view().flex_row().gap_2().children(images))
        .into_element()
}

/// The large image: its size, its prefetch, its download.
fn info() -> AnyElement {
    // The large image shows; what `image_size` and `prefetch_image`
    // answered for it.
    let show = signal(false);
    let size = signal(SharedString::from("—"));
    let prefetched = signal(SharedString::from("—"));
    // The large image's download progress, 0 to 1, and its load.
    let progress = signal(0.0_f64);
    let status = signal("not shown");
    // The waits for `image_size`'s and `prefetch_image`'s answers: a
    // new press replaces the last one's.
    let sizing = stored(None::<Spawned<()>>);
    let prefetching = stored(None::<Spawned<()>>);
    let get_size = move |_: &()| {
        let answer = image_size(big());
        let wait = spawn(async move {
            size.set(match answer.await {
                Ok(ImageSize { width, height }) => format!("{}×{} px", width.0, height.0).into(),
                Err(error) => error.into(),
            });
        });
        if let Some(last) = sizing.replace(Some(wait)) {
            last.cancel();
        }
    };
    let prefetch = move |_: &()| {
        prefetched.set("loading…".into());
        let loaded = prefetch_image(big());
        let wait = spawn(async move {
            let loaded = loaded.await;
            prefetched.set(if loaded { "in memory" } else { "failed" }.into());
        });
        if let Some(last) = prefetching.replace(Some(wait)) {
            last.cancel();
        }
    };
    let toggle = move |_: &()| show.update(|s| *s = !*s);
    let shown = when(show, move || {
        appear().index(0).child(
            frame(image(big()))
                .h(px(170.0))
                .on_load_start(move || status.set("loading"))
                .on_progress(move |e: &ImageProgress| {
                    progress.set(e.loaded / e.total.max(1.0));
                })
                .on_load(move |_: &Size<Points>| {
                    status.set(if progress.get_untracked() == 0.0 {
                        "loaded (no download)"
                    } else {
                        "loaded"
                    });
                    progress.set(1.0);
                }),
        )
    })
    .otherwise(|| note("Prefetch, then show: no download, no progress", false));
    Card::new()
        .icon(IconName::Search)
        .title("Size, prefetch, progress")
        .subtitle("Image.getSize · Image.prefetch · onProgress")
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(
                    Button::new("Size", get_size)
                        .variant(ButtonVariant::Secondary)
                        .flex_1(),
                )
                .child(
                    Button::new("Prefetch", prefetch)
                        .variant(ButtonVariant::Secondary)
                        .flex_1(),
                )
                // The button's label and look follow `show`.
                .child(
                    Button::new(move || if show.get() { "Hide" } else { "Show" }, toggle)
                        .variant(move || {
                            if show.get() {
                                ButtonVariant::Secondary
                            } else {
                                ButtonVariant::Accent
                            }
                        })
                        .flex_1(),
                ),
        )
        .child(
            view()
                .gap_2()
                .child(caption("getSize", Some(size)))
                .child(caption("prefetch", Some(prefetched)))
                .child(caption(
                    "onProgress",
                    Some(move || {
                        format!("{}% · {}", (progress.get() * 100.0).round(), status.get())
                    }),
                ))
                .child(Meter::new(move || progress.get() as f32).tone(move || {
                    if progress.get() >= 1.0 {
                        Tone::Up
                    } else {
                        Tone::Accent
                    }
                })),
        )
        .child(shown)
        .into_element()
}

/// Two images' load events: one that loads, one that cannot.
fn events() -> AnyElement {
    // The load events of the first image, what it reported, and what
    // the image that cannot load reported.
    let events = signal(Vec::<&'static str>::new());
    let loaded = signal("…".to_owned());
    let failed = signal(SharedString::from("Loading…"));
    let log = move |line: &'static str| move |_: &()| events.update(|e| e.push(line));
    let thumb = |image: Image| frame(image).w(px(96.0)).h(px(64.0));
    let loads = thumb(image(photo(1084, 600, 400)))
        .on_load_start(log("onLoadStart"))
        .on_load(move |size: &Size<Points>| {
            events.update(|e| e.push("onLoad"));
            loaded.set(format!("{}×{}", size.width.0, size.height.0));
        })
        .on_error(move |message: &str| loaded.set(message.to_owned()))
        .on_load_end(log("onLoadEnd"));
    let fails = thumb(image("https://example.invalid/missing.png"))
        .on_error(move |message: &str| failed.set(message.to_owned().into()))
        .absolute()
        .left(px(-1.0))
        .top(px(-1.0))
        .border(px(0.0));
    let label = |host: &'static str, status: AnyElement| {
        view()
            .flex_1()
            .gap_1()
            .child(text(host).text_size(px(15.0)).text_color(colors::TEXT))
            .child(status)
    };
    let badges = dynamic(move || {
        events.with(|events| {
            if events.is_empty() {
                vec![note("No load events yet", false)]
            } else {
                events
                    .iter()
                    .map(|&e| {
                        Badge::new(e)
                            .tone(if e == "onLoad" {
                                Tone::Up
                            } else {
                                Tone::Neutral
                            })
                            .into_element()
                    })
                    .collect()
            }
        })
    });
    Card::new()
        .icon(IconName::Bell)
        .title("Events")
        .subtitle("Load start, load, error, load end")
        .child(
            view()
                .flex_row()
                .gap_3()
                .items_center()
                .child(loads)
                .child(label(
                    "picsum.photos",
                    text(move || format!("Loaded, {} px", loaded.get()))
                        .text_size(px(13.0))
                        .text_color(colors::UP)
                        .tabular_nums()
                        .into_element(),
                )),
        )
        .child(
            view()
                .flex_row()
                .gap_3()
                .items_center()
                .border_t_1()
                .border_t_color(colors::LINE)
                .pt_3()
                .child(
                    view()
                        .w(px(96.0))
                        .h(px(64.0))
                        .rounded(px(radius::CONTROL))
                        .border_curve(BorderCurve::Continuous)
                        .border_1()
                        .border_color(colors::DANGER.opacity(0.4))
                        .bg(colors::RAISED)
                        .items_center()
                        .justify_center()
                        .child(fails)
                        .child(text("×").text_size(px(20.0)).text_color(colors::DANGER)),
                )
                .child(label(
                    "example.invalid",
                    text(failed)
                        .number_of_lines(3)
                        .text_size(px(13.0))
                        .text_color(colors::DANGER)
                        .into_element(),
                )),
        )
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .gap_2()
                .items_center()
                .child(badges),
        )
        .into_element()
}

/// The demo's page.
#[component]
pub(crate) fn Images() -> impl IntoElement {
    // Asks for images that are not cached yet ("Reload").
    let seed = signal(1_u32);
    DemoPage::new()
        .columns(3)
        .card(resize_modes)
        .card(corners)
        .card(assets)
        .card(animated)
        .card(move || placeholders(seed))
        .card(blur)
        .card(info)
        .card(events)
}
