//! Components: native press feedback, a sheet opened by a pressable with press styles, layout animation, an
//! input's accessory bar, the keyboard avoiding view, modal options and
//! the environment (as the TSX gallery's `demos/Components.tsx`).

use std::hash::{BuildHasher, RandomState};

use nsh_base::{dialog, input};
use nsh_core::{
    element::{AnyElement, Idiom, Input, KeyboardDismissMode, LayoutAnimation, Orientation, Os},
    prelude::*,
};

use crate::{
    nav,
    ui::{
        self, Badge, ButtonVariant as UiVariant, DemoPage, Finish, Finished, IconName, IconTile,
        Inset, MONO, Row, Segment, SegmentedSize, Tone, appear, caption, colors, hint, icon,
        inset_shadow, press, radius, rgb_a, segmented, tints, titled, toggle,
    },
};

/// One device pixel, in points (TS: `1 / pixelRatio()`; reading it in
/// a binding follows the screen).
fn hairline() -> f32 {
    1.0 / pixel_ratio()
}

/// A dark input, 48 pt tall, lit while `focused` (its owner keeps that
/// from `on_focus` / `on_blur`).
fn field(focused: Signal<bool>) -> Input {
    input()
        .placeholder_color(|| color(colors::FAINT))
        .selection_color(|| color(colors::ACCENT))
        .h(px(48.0))
        .px(px(14.0))
        .text_size(px(15.0))
        .text_color(colors::TEXT)
        .bg(colors::INSET)
        .border_1()
        .border_color(move || {
            if focused.get() {
                colors::ACCENT
            } else {
                colors::BORDER
            }
        })
        .rounded(px(radius::CONTROL))
        .finish(Finish::Inset)
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false))
}

/// A cell of a row of equal widths.
fn cell(content: impl IntoElement) -> View {
    view().flex_1().child(content)
}

/// Muted body text, 14 pt.
fn note(content: impl Into<SharedString>) -> Text {
    text(content.into())
        .text_size(px(14.0))
        .line_height(px(20.0))
        .text_color(colors::MUTED)
}

/// A modal's or a sheet's big title over a badge.
fn title_block(badge: impl Into<SharedString>, title: &str) -> View {
    view()
        .gap_2()
        .child(
            view()
                .flex_row()
                .child(Badge::new(badge.into()).tone(Tone::Accent)),
        )
        .child(
            text(title.to_owned())
                .text_size(px(28.0))
                .font_weight(FontWeight::BOLD)
                .letter_spacing(px(-0.5))
                .text_color(colors::TEXT),
        )
}

/// A tile to press: its title, the prop it shows, something on the right.
fn tile_content(
    title: impl IntoReactive<SharedString>,
    prop: &str,
    right: Option<AnyElement>,
) -> View {
    view()
        .min_h(px(60.0))
        .flex_row()
        .items_center()
        .gap_3()
        .px_3()
        .py_2()
        .child(
            view()
                .flex_1()
                .gap(px(2.0))
                .child(text(title).text_size(px(15.0)).text_color(colors::TEXT))
                .child(
                    text(prop.to_owned())
                        .text_size(px(12.0))
                        .text_color(colors::FAINT)
                        .font_family(MONO),
                ),
        )
        .children(right)
}

/// A pressable tile: the raised highlight without its gradient, so an
/// underlay color shows.
fn tile() -> View {
    view()
        .rounded(px(radius::CONTROL))
        .border_curve(BorderCurve::Continuous)
        .border_1()
        .border_color(colors::BORDER)
        .bg(colors::SURFACE)
        .finish_shadow(Finish::Raised)
}

/// Press feedback is native: opacity, an underlay, styles; `disabled`
/// takes no presses.
#[component]
fn PressFeedback() -> impl IntoElement {
    let last = signal("None yet");
    let disabled = signal(false);
    let pressed = move |what: &'static str| move |_: &()| last.set(what);
    ui::Card::new()
        .icon(IconName::Gestures)
        .title("Press feedback")
        .subtitle(hint(
            "Drawn natively while the finger is down",
            "Drawn natively while the button is down",
        ))
        .child(
            tile()
                .active(|s| s.opacity(0.4))
                .on_press(pressed("Fading tile"))
                .child(tile_content(
                    "Fades while pressed",
                    "activeStyle={{ opacity: 0.4 }}",
                    None,
                )),
        )
        // The underlays' colors follow the appearance.
        .child(
            tile()
                .group()
                .active(|s| s.bg(colors::RAISED))
                .on_press(pressed("Underlay tile"))
                .child(
                    tile_content(
                        "Lights up while pressed",
                        "activeStyle={{ backgroundColor }}",
                        None,
                    )
                    .group_active(|s| s.opacity(0.85)),
                ),
        )
        .child(
            tile()
                .disabled(disabled)
                .group()
                .active(|s| s.bg(tints::DANGER))
                .disabled_style(|s| s.opacity(0.4))
                .on_press(pressed("Enabled tile"))
                .child(
                    tile_content(
                        move || {
                            if disabled.get() {
                                "Takes no presses"
                            } else {
                                "Enabled"
                            }
                        },
                        "disabled + disabled:opacity-40",
                        Some(
                            Badge::new(move || if disabled.get() { "Off" } else { "On" })
                                .tone(move || {
                                    if disabled.get() {
                                        Tone::Neutral
                                    } else {
                                        Tone::Up
                                    }
                                })
                                .into_element(),
                        ),
                    )
                    .group_active(|s| s.opacity(0.85)),
                ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .child(cell(caption("Last pressed", Some(move || last.get()))))
                .child(
                    toggle()
                        .value(disabled)
                        .label("Disable the third tile")
                        .on_change(move |&on: &bool| {
                            disabled.set(on);
                        }),
                ),
        )
}

/// A pressable with press styles (TS: Tailwind's `active:`) that opens a
/// sheet.
#[component]
fn PressableSheet() -> impl IntoElement {
    let sheet = signal(false);
    let open = move |open: bool| move |_: &()| sheet.set(open);
    let modal_view = when(sheet, move || {
        dialog()
            .presentation(ModalPresentation::PageSheet)
            .animation(ModalAnimation::Slide)
            .on_cancel(open(false))
            .child(
                view().p_safe_area().flex_1().bg(colors::BACKGROUND).child(
                    view()
                        .flex_1()
                        .p_4()
                        .gap_4()
                        .child(
                            title_block("pageSheet", "A sheet").px_1().pt_2().child(
                                text(hint(
                                    "Swipe down (iOS) or press back (Android) to close.",
                                    "Press Escape or click outside the card to close.",
                                ))
                                .text_size(px(15.0))
                                .line_height(px(21.0))
                                .text_color(colors::MUTED),
                            ),
                        )
                        .child(view().flex_1())
                        .child(ui::Button::new("Close", open(false))),
                ),
            )
    });
    let (accent_light, accent_dark) = Finish::Accent.shadows();
    ui::Card::new()
        .icon(IconName::Components)
        .title("Sheet")
        .subtitle("A Tailwind active: variant opens it")
        .child(
            view()
                .role(AccessibilityRole::Button)
                .on_press(open(true))
                .adaptive_shadow(accent_light.iter().copied(), accent_dark.iter().copied())
                .h_12()
                .flex_row()
                .items_center()
                .justify_center()
                .gap_2()
                .rounded(px(12.0))
                .bg(rgb(0xc8f26d))
                .transition()
                .active(|s| s.scale(0.97).bg(rgb(0xa9d14f)))
                .child(
                    text("Open a sheet")
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::ON_ACCENT),
                ),
        )
        .child(caption(
            "Scales and darkens while pressed",
            Some("active:scale-[0.97]"),
        ))
        .child(modal_view)
}

/// Shuffles `items` in place.
fn shuffle(items: &mut [u32]) {
    // Fresh random keys each time, from the standard library.
    let random = RandomState::new();
    for i in (1..items.len()).rev() {
        let j = (random.hash_one(i) % (i as u64 + 1)) as usize;
        items.swap(i, j);
    }
}

/// The layout animation presets, with their labels.
const PRESETS: [(LayoutAnimation, &str); 3] = [
    (LayoutAnimation::SPRING, "Spring"),
    (LayoutAnimation::EASE_IN_EASE_OUT, "Ease"),
    (LayoutAnimation::LINEAR, "Linear"),
];

/// The tiles' tones, by number.
const TILE_TONES: [Tone; 5] = [Tone::Accent, Tone::Info, Tone::Warn, Tone::Up, Tone::Danger];

/// Views added, moved and removed with a layout animation.
#[component]
fn LayoutAnimations() -> impl IntoElement {
    let items = signal(vec![1_u32, 2, 3]);
    let next = stored(4_u32);
    let preset = signal(0_u32);
    // Changes the items, animating the layout change.
    let animate = move |change: fn(&mut Vec<u32>, Stored<u32>)| {
        move |_: &()| {
            animate_layout(PRESETS[preset.get_untracked() as usize].0);
            items.update(|items| change(items, next));
        }
    };
    let white = 0xffffff;
    let boxes = each(
        items,
        |n: &u32| *n,
        move |n, _| {
            let n = n.get_untracked();
            let tone = TILE_TONES[n as usize % TILE_TONES.len()];
            view()
                .size(px(56.0))
                .rounded(px(14.0))
                .border_curve(BorderCurve::Continuous)
                .bg(tone.tint())
                .adaptive_shadow(
                    [inset_shadow(1.0, 0.0, rgb(white))],
                    [inset_shadow(1.0, 0.0, rgb_a(white, 0.06))],
                )
                .items_center()
                .justify_center()
                .child(
                    text(n.to_string())
                        .text_size(px(17.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .tabular_nums()
                        .text_color(tone.color()),
                )
        },
    );
    ui::Card::new()
        .icon(IconName::Animation)
        .title("Layout animation")
        .subtitle("configureNext, then change the tree")
        .right(Badge::new(move || items.with(Vec::len).to_string()))
        .child(
            segmented()
                .options(
                    PRESETS
                        .iter()
                        .map(|(_, label)| Segment::new(*label))
                        .collect::<Vec<_>>(),
                )
                .selected(preset)
                .size(SegmentedSize::Small)
                .on_change(move |&i: &u32| {
                    preset.set(i);
                }),
        )
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .gap_2()
                .min_h(px(56.0))
                .child(boxes),
        )
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(cell(
                    ui::Button::new(
                        "Add",
                        animate(|items, next| {
                            items.insert(0, next.get());
                            next.with(|n| *n += 1);
                        }),
                    )
                    .icon(IconName::Plus),
                ))
                .child(cell(
                    ui::Button::new("Shuffle", animate(|items, _| shuffle(items)))
                        .variant(UiVariant::Secondary),
                ))
                .child(cell(
                    ui::Button::new(
                        "Remove",
                        animate(|items, _| {
                            if !items.is_empty() {
                                items.remove(0);
                            }
                        }),
                    )
                    .variant(UiVariant::Secondary)
                    .disabled(Prop::bind(move || items.with(Vec::is_empty))),
                )),
        )
}

/// An input with a bar over the keyboard (iOS's input accessory).
#[component]
fn Accessory() -> impl IntoElement {
    let content = signal(String::new());
    let focused = signal(false);
    let input = element_ref();
    ui::Card::new()
        .icon(IconName::Text)
        .title("Input accessory")
        .subtitle("A bar over the iOS keyboard")
        .right(Badge::new("nsh/ios"))
        .child(
            field(focused)
                .element_ref(&input)
                .value(move || content.get())
                .placeholder("Focus me")
                .input_accessory("counter")
                .on_change(move |v: &str| content.set(v.to_owned())),
        )
        .child(caption(
            if os() == Os::Android {
                "Android has no input accessories"
            } else {
                "The bar counts what you type"
            },
            Some("inputAccessoryViewID=\"counter\""),
        ))
        .child(
            input_accessory_view("counter").bg(colors::SURFACE).child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .px_4()
                    .py_2()
                    .border_t(move || px(hairline()))
                    .border_t_color(colors::BORDER)
                    .child(
                        text(move || {
                            format!("{} characters", content.with(|c| c.encode_utf16().count()))
                        })
                        .flex_1()
                        .text_size(px(13.0))
                        .text_color(colors::MUTED)
                        .tabular_nums(),
                    )
                    .child(
                        ui::Button::new("Clear", move |_: &()| content.set(String::new()))
                            .variant(UiVariant::Secondary),
                    )
                    .child(ui::Button::new("Done", move |_: &()| input.blur())),
            ),
        )
}

/// How the page makes room for the keyboard (`env(keyboard-inset-height)`
/// as a bottom padding or margin): label, what it does.
const BEHAVIORS: [(bool, &str, &str); 2] = [
    (
        false,
        "padding",
        "The bottom pads: the tinted background stays under the keyboard.",
    ),
    (
        true,
        "margin",
        "The view shrinks: its background ends at the keyboard.",
    ),
];

/// The content of the keyboard avoiding view's screen.
#[component]
fn AvoidingPage() -> impl IntoElement {
    let behavior = signal(0_u32);
    let focused = signal(false);
    let picked = move || BEHAVIORS[behavior.get() as usize];
    view().flex_1().child(
        view()
            .style_when(move || !picked().0, |s| s.pb_keyboard())
            .style_when(move || picked().0, |s| s.mb_keyboard())
            .flex_1()
            .bg(tints::INFO)
            .child(
                view()
                    .flex_1()
                    .p_4()
                    .gap_4()
                    .child(
                        appear().index(0).child(
                            ui::Card::new()
                                .icon(IconName::Form)
                                .title(move || {
                                    format!("{}-bottom: env(keyboard-inset-height)", picked().1)
                                })
                                .subtitle("Focus the field at the bottom")
                                .child(
                                    segmented()
                                        .options(BEHAVIORS.map(|(_, label, _)| Segment::new(label)))
                                        .selected(behavior)
                                        .on_change(move |&i: &u32| {
                                            behavior.set(i);
                                        }),
                                )
                                .child(
                                    text(move || picked().2)
                                        .text_size(px(14.0))
                                        .line_height(px(20.0))
                                        .text_color(colors::MUTED),
                                ),
                        ),
                    )
                    .child(view().flex_1())
                    .child(field(focused).placeholder("Type here")),
            ),
    )
}

/// A modal's platform options.
#[component]
fn ModalOptions() -> impl IntoElement {
    let visible = signal(false);
    let translucent = signal(false);
    let show = move |shown: bool| move |_: &()| visible.set(shown);
    let modal_view = when(visible, move || {
        dialog()
            .animation(ModalAnimation::Slide)
            .status_bar_translucent(translucent)
            .supported_orientations([Orientation::Portrait, Orientation::Landscape])
            .on_cancel(show(false))
            .child(
                view()
                    .flex_1()
                    .bg(AdaptiveColor::new(rgb(0xeef5dc), rgb(0x16200d)))
                    .child(
                        view()
                            .flex_1()
                            .pt_safe_area_plus(px(16.0))
                            .pr_safe_area_plus(px(16.0))
                            .pb_safe_area_plus(px(16.0))
                            .pl_safe_area_plus(px(16.0))
                            .gap_3()
                            .child(
                                view().flex_row().pt_2().child(
                                    Badge::new(move || {
                                        if translucent.get() {
                                            "translucent"
                                        } else {
                                            "opaque bar"
                                        }
                                    })
                                    .tone(Tone::Accent),
                                ),
                            )
                            .child(
                                text("A modal")
                                    .text_size(px(28.0))
                                    .font_weight(FontWeight::BOLD)
                                    .letter_spacing(px(-0.5))
                                    .text_color(colors::TEXT),
                            )
                            .child(
                                text(move || {
                                    format!(
                                        "The olive background starts {} the status bar on \
                                         Android.",
                                        if translucent.get() { "under" } else { "below" }
                                    )
                                })
                                .text_size(px(15.0))
                                .line_height(px(21.0))
                                .text_color(colors::MUTED),
                            )
                            .child(view().flex_1())
                            .child(ui::Button::new("Close", show(false))),
                    ),
            )
    });
    ui::Card::new()
        .icon(IconName::System)
        .title("Modal options")
        .subtitle("statusBarTranslucent, orientations")
        .right(
            toggle()
                .value(translucent)
                .label("statusBarTranslucent")
                .on_change(move |&on: &bool| {
                    translucent.set(on);
                }),
        )
        .child(note(
            "Android: translucent content reaches under the status bar. iOS: this modal allows \
             portrait and landscape.",
        ))
        .child(caption(
            "statusBarTranslucent",
            Some(move || translucent.get().to_string()),
        ))
        .child(ui::Button::new("Open the modal", show(true)).variant(UiVariant::Secondary))
        .child(modal_view)
}

/// The platform, the pixel ratio and the screen reader.
#[component]
fn PlatformInfo() -> impl IntoElement {
    // Announcements made.
    let announced = stored(0_u32);
    // The note the reader's focus moves to.
    let note_ref = element_ref();
    let os = os();
    let (major, minor) = os_version();
    // A string on iOS ("17.5"), the API level on Android (as TS's).
    let version = if os == Os::Android {
        major.to_string()
    } else {
        format!("{major}.{minor}")
    };
    let idiom = idiom();
    let branch = match os {
        Os::Ios => "ios branch",
        Os::Android => "android branch",
        _ => "",
    };
    let idiom_name = match idiom {
        Idiom::Phone => "phone",
        Idiom::Pad => "pad",
        Idiom::Mac => "mac",
        Idiom::Tv => "tv",
        Idiom::Desktop => "desktop",
    };
    let rows: [(&str, Reactive<SharedString>); 8] = [
        ("platform.os", os.name().into_reactive()),
        ("platform.version", version.into_reactive()),
        (
            "platform.idiom / catalyst",
            format!("{idiom_name} / {}", idiom == Idiom::Mac).into_reactive(),
        ),
        ("platform.select", branch.into_reactive()),
        (
            "pixelRatio()",
            (|| pixel_ratio().to_string()).into_reactive(),
        ),
        (
            "10.3 on whole pixels",
            (|| round_to_nearest_pixel(px(10.3)).0.to_string()).into_reactive(),
        ),
        (
            "screenReaderEnabled()",
            (|| screen_reader().to_string()).into_reactive(),
        ),
        (
            "reduceMotion()",
            (|| reduce_motion().to_string()).into_reactive(),
        ),
    ];
    let rows = rows.into_iter().enumerate().map(|(i, (name, value))| {
        Row::new(i == 0)
            .child(
                text(name)
                    .number_of_lines(1)
                    .flex_1()
                    .text_size(px(12.0))
                    .text_color(colors::MUTED)
                    .font_family(MONO),
            )
            .child(
                text(value)
                    .number_of_lines(1)
                    .text_size(px(14.0))
                    .text_color(colors::TEXT)
                    .tabular_nums(),
            )
    });
    ui::Card::new()
        .icon(IconName::Spark)
        .title("Platform")
        .subtitle("platform, pixelRatio, announce")
        .right(Badge::new(os.name()).tone(Tone::Accent))
        .child(view().children(rows))
        .child(view().h(move || px(hairline())).bg(colors::ACCENT))
        .child(caption(
            "The line above is one device pixel tall",
            Some(move || format!("{:.3} pt", hairline())),
        ))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(cell(ui::Button::new("Announce", move |_: &()| {
                    let n = announced.with(|n| {
                        *n += 1;
                        *n
                    });
                    announce_for_accessibility(format!("Announcement {n}"));
                })))
                .child(cell(
                    ui::Button::new("Focus the note", move |_: &()| {
                        note_ref.set_accessibility_focus();
                    })
                    .variant(UiVariant::Secondary),
                )),
        )
        .child(
            text(
                "With VoiceOver or TalkBack on, the buttons above speak and move the reader here.",
            )
            .text_size(px(13.0))
            .line_height(px(18.0))
            .text_color(colors::FAINT)
            .element_ref(&note_ref),
        )
}

/// A row that pushes a screen.
fn link_row(
    icon_name: IconName,
    title: &'static str,
    prop: &'static str,
    on_press: impl Into<Listener<()>>,
) -> impl IntoElement {
    let on_press: Listener<()> = on_press.into();
    press().scale(0.98).label(title).on_press(on_press).child(
        view()
            .min_h(px(60.0))
            .flex_row()
            .items_center()
            .gap_3()
            .px(px(10.0))
            .py_2()
            .child(IconTile::new(icon_name).size(34.0))
            .child(
                view()
                    .flex_1()
                    .gap(px(2.0))
                    .child(
                        text(title)
                            .text_size(px(15.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(colors::TEXT),
                    )
                    .child(
                        text(prop)
                            .number_of_lines(1)
                            .text_size(px(12.0))
                            .text_color(colors::FAINT)
                            .font_family(MONO),
                    ),
            )
            .child(
                icon()
                    .name(IconName::Chevron)
                    .size(14.0)
                    .tint(colors::FAINT),
            ),
    )
}

/// The demo's page.
#[component]
pub(crate) fn Components() -> impl IntoElement {
    let avoiding = || {
        ui::Card::new()
            .title("Keyboard avoidance")
            .subtitle("Content outside scroll views")
            .flush()
            .child(Inset::new().padding(0.0).gap(0.0).child(link_row(
                IconName::Form,
                "Keyboard inset",
                "padding / margin",
                |_: &()| {
                    nav::push("keyboard-avoiding", || {
                        titled("Keyboard inset").child(avoiding_page())
                    });
                },
            )))
    };
    DemoPage::new()
        .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
        .card(press_feedback)
        .card(pressable_sheet)
        .card(layout_animations)
        .card(accessory)
        .card(avoiding)
        .card(modal_options)
        .card(platform_info)
}
