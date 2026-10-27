//! Photos: a long recycled list of rows with images (a grid of tiles in
//! the desktop layout), pull to refresh, loading more at the end, a hero
//! that fades and slides under the list and a compact bar that fades in,
//! all driven natively by the list's scroll offset (as the TSX gallery's
//! `demos/Photos.tsx`).

use std::{rc::Rc, time::Duration};

use nsh_core::prelude::*;

use crate::ui::{
    Badge, Button, ButtonVariant, Finish, Finished, IconName, Stat, Tone, bind_refresh, colors,
    columns_for, desktop, icon, pane_width, radius,
};

/// Photos loaded per page.
const PAGE: usize = 200;

/// A photo of the list.
#[derive(Debug, Clone, PartialEq)]
struct Photo {
    id: usize,
    title: String,
    author: &'static str,
    tone: Tone,
    views: usize,
}

/// `count` photos, numbered from `from`.
fn make_photos(from: usize, count: usize) -> impl Iterator<Item = Photo> {
    const AUTHORS: [&str; 5] = ["Ada", "Linus", "Grace", "Ken", "Barbara"];
    const TONES: [Tone; 5] = [Tone::Accent, Tone::Info, Tone::Warn, Tone::Up, Tone::Danger];
    const PLACES: [&str; 9] = [
        "Harbor", "Ridge", "Old town", "Dunes", "Canal", "Orchard", "Quarry", "Pier", "Meadow",
    ];
    (from..from + count).map(|id| Photo {
        id,
        title: format!("{} {id:04}", PLACES[id % PLACES.len()]),
        author: AUTHORS[id % AUTHORS.len()],
        tone: TONES[id % TONES.len()],
        views: (id * 7919) % 9800 + 120,
    })
}

/// 1234 → "1,234".
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// 1234 → "1.2k".
fn compact(n: usize) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

/// One row: the picture, its title, author and views, its number (of the
/// photo `photo` reads: a cell shows another photo through its bindings).
fn row(photo: Memo<Option<Photo>>) -> impl IntoElement {
    let field = move |f: fn(&Photo) -> String| {
        move || photo.with(|p| p.as_ref().map(f).unwrap_or_default())
    };
    crate::ui::press()
        .scale(0.985)
        .label(move || photo.with(|p| p.as_ref().map(|p| p.title.clone().into())))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .px_4()
                .h(px(76.0))
                .child(
                    image(field(|p| {
                        format!("https://picsum.photos/seed/{}/112/112", p.id)
                    }))
                    .size(px(56.0))
                    .rounded(px(radius::INSET))
                    .border_curve(BorderCurve::Continuous)
                    .border_1()
                    .border_color(colors::BORDER)
                    .bg(colors::RAISED)
                    .finish(Finish::Raised),
                )
                .child(
                    view()
                        .flex_1()
                        .gap_1()
                        .self_stretch()
                        .justify_center()
                        .border_b_1()
                        .border_b_color(colors::LINE)
                        .child(
                            text(field(|p| p.title.clone()))
                                .number_of_lines(1)
                                .text_size(px(15.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT),
                        )
                        .child(
                            view()
                                .flex_row()
                                .items_center()
                                .gap(px(6.0))
                                .child(view().size(px(6.0)).rounded(px(3.0)).bg(move || {
                                    photo
                                        .with(|p| p.as_ref().map_or(Tone::Neutral, |p| p.tone))
                                        .color()
                                }))
                                .child(
                                    text(field(|p| p.author.to_owned()))
                                        .text_size(px(13.0))
                                        .text_color(colors::MUTED),
                                )
                                .child(
                                    text(field(|p| format!("· {} views", compact(p.views))))
                                        .text_size(px(13.0))
                                        .text_color(colors::FAINT)
                                        .tabular_nums(),
                                ),
                        ),
                )
                .child(
                    text(field(|p| format!("#{}", p.id)))
                        .text_size(px(13.0))
                        .text_color(colors::FAINT)
                        .tabular_nums(),
                ),
        )
}

/// A photo in the desktop layout's grid: the picture over its title and
/// author, a fill under the pointer (of the photo `photo` reads, as
/// [`row`]).
fn tile(photo: Memo<Option<Photo>>) -> impl IntoElement {
    let field = move |f: fn(&Photo) -> String| {
        move || photo.with(|p| p.as_ref().map(f).unwrap_or_default())
    };
    crate::ui::press()
        .scale(0.97)
        .label(move || photo.with(|p| p.as_ref().map(|p| p.title.clone().into())))
        .child(
            view()
                .p(px(6.0))
                .gap_2()
                .rounded(px(radius::CARD))
                .border_curve(BorderCurve::Continuous)
                .cursor_pointer()
                // The card's fill: the gallery theme's `card` (TS `hover:bg-card`).
                .hover(|s| s.bg(colors::SURFACE))
                .child(
                    image(field(|p| {
                        format!("https://picsum.photos/seed/{}/480/360", p.id)
                    }))
                    .w_full()
                    .aspect_ratio(4.0 / 3.0)
                    .rounded(px(radius::INSET))
                    .border_curve(BorderCurve::Continuous)
                    .border_1()
                    .border_color(colors::BORDER)
                    .bg(colors::RAISED)
                    .finish(Finish::Raised),
                )
                .child(
                    view()
                        .gap(px(3.0))
                        .px_1()
                        .pb_1()
                        .child(
                            view()
                                .flex_row()
                                .items_baseline()
                                .gap_2()
                                .child(
                                    text(field(|p| p.title.clone()))
                                        .number_of_lines(1)
                                        .flex_1()
                                        .text_size(px(14.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::TEXT),
                                )
                                .child(
                                    text(field(|p| format!("#{}", p.id)))
                                        .text_size(px(12.0))
                                        .text_color(colors::FAINT)
                                        .tabular_nums(),
                                ),
                        )
                        .child(
                            view()
                                .flex_row()
                                .items_center()
                                .gap(px(6.0))
                                .child(view().size(px(6.0)).rounded(px(3.0)).bg(move || {
                                    photo
                                        .with(|p| p.as_ref().map_or(Tone::Neutral, |p| p.tone))
                                        .color()
                                }))
                                .child(
                                    text(field(|p| {
                                        format!("{} · {} views", p.author, compact(p.views))
                                    }))
                                    .number_of_lines(1)
                                    .text_size(px(12.0))
                                    .text_color(colors::MUTED),
                                ),
                        ),
                ),
        )
}

/// The list's header: a card of figures and a hint, fading out and moving
/// at half speed as the list slides over it (in the desktop layout, on
/// the grid's gutters instead of its own).
fn hero(
    count: Memo<usize>,
    refreshes: Signal<u32>,
    refreshing: Signal<bool>,
    refresh: impl Into<Listener<()>>,
    refresh_key: Option<String>,
    scroll_y: AnimatedValue,
    wide: bool,
) -> impl IntoElement {
    view()
        .when(!wide, |v| v.px_4().pt_2())
        .pb_4()
        .bind_opacity(&scroll_y.interpolate(&[0.0, 150.0], &[1.0, 0.0]))
        .bind_translate_y(&scroll_y.interpolate(&[-200.0, 0.0, 300.0], &[0.0, 0.0, 150.0]))
        .child(
            view()
                .bg(colors::SURFACE)
                .rounded(px(radius::CARD))
                .border_curve(BorderCurve::Continuous)
                .border_1()
                .border_color(colors::BORDER)
                .p_4()
                .gap_3()
                .finish(Finish::Card)
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .child(
                            view()
                                .size(px(40.0))
                                .rounded(px(12.0))
                                .border_curve(BorderCurve::Continuous)
                                .bg(colors::RAISED)
                                .border_1()
                                .border_color(colors::BORDER)
                                .items_center()
                                .justify_center()
                                .finish(Finish::Raised)
                                .child(image(crate::assets::LOGO).size(px(24.0))),
                        )
                        .child(
                            view()
                                .flex_1()
                                .gap(px(2.0))
                                .child(
                                    text("Photo stream")
                                        .text_size(px(17.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::TEXT),
                                )
                                .child(
                                    text("A recycled list of remote images")
                                        .text_size(px(13.0))
                                        .text_color(colors::MUTED),
                                ),
                        )
                        .child(Badge::new("Remote").tone(Tone::Info)),
                )
                .child(
                    text(move || grouped(count.get()))
                        .text_size(px(40.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT)
                        .tabular_nums()
                        .letter_spacing(px(-1.0))
                        .child(
                            text(" photos")
                                .text_size(px(15.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(colors::ACCENT),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .border_t_1()
                        .border_t_color(colors::LINE)
                        .pt(px(10.0))
                        .child(
                            Stat::new("Pages", move || count.get().div_ceil(PAGE).to_string())
                                .width(0.33),
                        )
                        .child(Stat::new("Per page", PAGE.to_string()).width(0.33))
                        .child(
                            Stat::new("Refreshes", move || refreshes.get().to_string())
                                .width(0.33)
                                .tone_when(move || refreshes.get() > 0, Tone::Accent),
                        ),
                ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .pt_3()
                .child(
                    icon()
                        .name(IconName::ArrowDown)
                        .size(14.0)
                        .tint(colors::FAINT),
                )
                .child(
                    text(if is_desktop() {
                        let key = refresh_key.map(|k| format!("{k} refreshes. "));
                        format!(
                            "{}Scrolling to the end loads {PAGE} more.",
                            key.unwrap_or_default()
                        )
                    } else {
                        format!("Pull to refresh. Scrolling to the end loads {PAGE} more.")
                    })
                    .flex_1()
                    .text_size(px(13.0))
                    .text_color(colors::FAINT),
                )
                // The mouse does not pull scroll views down: desktops
                // refresh here.
                .when(is_desktop(), |v| {
                    v.child(
                        Button::new(
                            move || {
                                if refreshing.get() {
                                    "Refreshing…"
                                } else {
                                    "Refresh"
                                }
                            },
                            refresh,
                        )
                        .variant(ButtonVariant::Secondary)
                        .disabled(Prop::bind(move || refreshing.get())),
                    )
                }),
        )
}

/// The demo's page.
#[component]
pub(crate) fn Photos() -> impl IntoElement {
    let photos = signal(Rc::new(make_photos(1, 1000).collect::<Vec<_>>()));
    let count = computed(move || photos.with(|p| p.len()));
    let refreshing = signal(false);
    let refreshes = signal(0_u32);
    // The refresh in progress.
    let refresh = stored(None::<Spawned<()>>);
    // The list's scroll offset, fed natively: the hero's parallax and fade
    // and the compact bar run without a binding per frame.
    let scroll_y = animated_value(0.0);
    let on_refresh = move |_: &()| {
        refreshing.set(true);
        let task = set_timeout(Duration::from_millis(800), move || {
            photos.set(Rc::new(make_photos(1, 1000).collect()));
            refreshes.update(|r| *r += 1);
            refreshing.set(false);
        });
        if let Some(old) = refresh.replace(Some(task)) {
            old.cancel();
        }
    };
    let refresh_key = bind_refresh(move || on_refresh(&()));
    let load_more = move |_: &()| {
        let from = count.get_untracked() + 1;
        log::info!("loading more after {}", from - 1);
        photos.update(|p| Rc::make_mut(p).extend(make_photos(from, PAGE)));
    };
    let header = move |wide: bool| {
        hero(
            count,
            refreshes,
            refreshing,
            on_refresh,
            refresh_key.clone(),
            scroll_y,
            wide,
        )
    };
    let footer = || {
        text(format!("Loading {PAGE} more…"))
            .text_center()
            .text_size(px(13.0))
            .text_color(colors::FAINT)
            .p_4()
    };
    // The photo a cell shows: another one as the cell is reused.
    let photo_at =
        move |at: Position| computed(move || photos.with(|p| p.get(at.index()).cloned()));
    let phone = {
        let header = header.clone();
        move || {
            virtual_list(count, move |at| row(photo_at(at)))
                .estimated_item_size(px(76.0))
                .flex_1()
                .content_padding_bottom(px(24.0))
                .scroll_value(&scroll_y)
                .refreshing(refreshing)
                .on_refresh(on_refresh)
                .on_load_more(load_more)
                .header(header(false))
                .footer(footer())
        }
    };
    // As many columns as fit, at least 200 pt each: the list follows the
    // window in place.
    let grid = move || {
        let columns = computed(|| columns_for(200.0, 8, pane_width(), 16.0));
        virtual_list(count, move |at| tile(photo_at(at)))
            .columns(columns)
            // A 4:3 picture across the column, its caption under it.
            .estimated_item_size(move || (pane_width() - 48.0) / columns.get() as f32 * 0.75 + 60.0)
            .flex_1()
            .content_padding(px(24.0))
            .row_gap(px(16.0))
            .column_gap(px(16.0))
            .scroll_value(&scroll_y)
            .refreshing(refreshing)
            .on_refresh(on_refresh)
            .on_load_more(load_more)
            .header(header(true))
            .footer(footer())
    };
    view()
        .flex_1()
        .bg(colors::BACKGROUND)
        // The shell is made again when the layout changes: read once.
        .child(if untracked(desktop) {
            grid().into_element()
        } else {
            phone().into_element()
        })
        // The compact bar fades in once the hero has scrolled away.
        .child(
            view()
                .pointer_events(PointerEvents::None)
                .absolute()
                .top_0()
                .left_0()
                .right_0()
                .h(px(44.0))
                .px_4()
                .flex_row()
                .items_center()
                .gap_2()
                .bg(colors::BACKGROUND)
                .border_b_1()
                .border_b_color(colors::BORDER)
                .bind_opacity(&scroll_y.interpolate(&[140.0, 190.0], &[0.0, 1.0]))
                .bind_translate_y(&scroll_y.interpolate(&[140.0, 190.0], &[-8.0, 0.0]))
                .child(
                    text("Photo stream")
                        .flex_1()
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT),
                )
                .child(
                    text(move || format!("{} photos", grouped(count.get())))
                        .text_size(px(13.0))
                        .text_color(colors::MUTED)
                        .tabular_nums(),
                ),
        )
}
