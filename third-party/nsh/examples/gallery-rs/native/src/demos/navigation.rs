//! Navigation: screens with header options, a deep stack, a screen that
//! asks before it is left, modals of every presentation and the Android
//! back button (as the TSX gallery's `demos/Navigation.tsx`). Each pushed
//! screen shows where its safe area is.

use nsh_base::{alert_dialog, dialog, input, nav_page};
use nsh_core::{
    ModalPresentation,
    element::{AnyElement, Os, Screen},
    prelude::*,
};

use crate::{
    nav,
    ui::{
        Badge, Button, ButtonVariant, Card, DemoPage, Figure, Finish, Finished, IconName, IconTile,
        Inset, MONO, PageHeader, Section, Stat, Tone, appear, colors, hint, icon, motion, press,
        radius, tints, titled, toggle, with_header,
    },
};

/// An edge's inset.
type Edge = fn(EdgeInsets) -> f32;

/// The safe-area insets where it renders, one figure per edge.
#[component]
fn Insets(cx: Scope<NoEvent>) -> impl IntoElement {
    let edges: [(&str, Edge); 4] = [
        ("Top", |i| i.top.0),
        ("Bottom", |i| i.bottom.0),
        ("Left", |i| i.left.0),
        ("Right", |i| i.right.0),
    ];
    view().flex_row().children(edges.map(|(edge, inset)| {
        Stat::new(edge, move || format!("{} pt", inset(cx.insets()).round())).width(0.25)
    }))
}

/// Muted body text.
fn body(content: impl Into<SharedString>) -> Text {
    text(content.into())
        .text_size(px(15.0))
        .line_height(px(21.0))
        .text_color(colors::MUTED)
}

/// A screen's big title over a badge naming its option.
fn title_block(badge: impl Into<SharedString>, title: impl Into<SharedString>, size: f32) -> View {
    view()
        .gap_2()
        .child(
            view()
                .flex_row()
                .child(Badge::new(badge.into()).tone(Tone::Accent)),
        )
        .child(
            text(title.into())
                .text_size(px(size))
                .font_weight(FontWeight::BOLD)
                .letter_spacing(px(-0.5))
                .text_color(colors::TEXT),
        )
}

/// The body of a pushed screen: what it shows, then where its safe area
/// is, then `content`.
fn page(intro: &str, content: impl IntoIterator<Item = AnyElement>) -> AnyElement {
    scroll()
        .flex_1()
        .bg(colors::BACKGROUND)
        .child(
            view()
                .p_4()
                .pb(px(40.0))
                .gap_4()
                .child(appear().index(0).child(body(intro.to_owned()).px_1()))
                .child(
                    appear().index(1).child(
                        Section::new("Safe area")
                            .note("safeAreaInsets()")
                            .child(insets()),
                    ),
                )
                .child(appear().index(2).child(view().gap_4().children(content))),
        )
        .into_element()
}

/// The stars of the custom header (its header item and content both show
/// them).
#[derive(Default, Clone)]
struct Likes(u32);

/// The draft of the unsaved-changes screen (its `pop_on_back` depends on
/// it).
#[derive(Default, Clone)]
struct Draft(String);

fn large_title() -> Screen {
    let rows = (1..=20).map(|i| {
        view()
            .h(px(48.0))
            .flex_row()
            .items_center()
            .px(px(10.0))
            .when(i > 1, |v| v.border_t_1().border_t_color(colors::LINE))
            .child(
                text(format!("Row {i}"))
                    .flex_1()
                    .text_size(px(15.0))
                    .text_color(colors::TEXT),
            )
            .child(
                text(format!("{} pt", i * 48))
                    .text_size(px(13.0))
                    .text_color(colors::FAINT)
                    .tabular_nums(),
            )
    });
    // A large title on iOS only (TS: `ios={{ headerLargeTitle: true }}`):
    // elsewhere the header is the usual one.
    titled("Large title")
        .header_large_title(os() == Os::Ios)
        .child(page(
            "iOS: the title shrinks into the bar as the content scrolls.",
            [Card::new()
                .flush()
                .child(Inset::new().padding(0.0).gap(0.0).children(rows))
                .into_element()],
        ))
}

fn transparent() -> Screen {
    with_header(
        nav_page()
            .title("Transparent")
            .header_transparent(true)
            .header_style_with(|s| {
                s.bg(AdaptiveColor::TRANSPARENT)
                    .text_color(colors::TEXT)
                    .tint_color(colors::TEXT)
            }),
        || {
            PageHeader::new("Transparent")
                .colors(colors::TEXT, colors::TEXT)
                .transparent()
        },
    )
    .child(
        view()
            .flex_1()
            .bg(AdaptiveColor::new(rgb(0xeef3e2), rgb(0x11170c)))
            .overflow_hidden()
            .p_4()
            .pb(px(56.0))
            .justify_end()
            .gap_4()
            .child(
                view()
                    .absolute()
                    .top(px(-90.0))
                    .right(px(-70.0))
                    .size(px(320.0))
                    .rounded(px(160.0))
                    .bg(tints::ACCENT),
            )
            .child(
                view()
                    .absolute()
                    .top(px(150.0))
                    .left(px(-110.0))
                    .size(px(260.0))
                    .rounded(px(130.0))
                    .bg(tints::INFO),
            )
            .child(
                appear().index(0).child(
                    title_block("headerTransparent", "Content under the header", 30.0)
                        .gap_3()
                        .child(body(
                            "The circles start at the top of the screen; the bar and its back \
                                 button float over them.",
                        )),
                ),
            )
            .child(appear().index(1).child(Inset::new().child(insets()))),
    )
}

fn custom_header() -> Screen {
    let likes = global::<Likes>();
    let count = move || likes.with(|l| l.0);
    let close = || {
        text("Close")
            .text_color(colors::ON_ACCENT)
            .text_size(px(17.0))
            .font_weight(FontWeight::MEDIUM)
            .hit_slop(EdgeInsets::all(px(10.0)))
            .on_press(nav::pop)
    };
    let title = || {
        view()
            .flex_row()
            .items_center()
            .gap(px(7.0))
            .child(view().size(px(10.0)).rounded(px(5.0)).bg(colors::ON_ACCENT))
            .child(
                text("Custom title")
                    .text_color(colors::ON_ACCENT)
                    .text_size(px(17.0))
                    .font_weight(FontWeight::BOLD),
            )
    };
    let star = move || {
        view()
            .flex_row()
            .items_center()
            .gap(px(5.0))
            .hit_slop(EdgeInsets::all(px(10.0)))
            .on_press(move || likes.update(|likes| likes.0 += 1))
            .child(
                icon()
                    .name(IconName::Star)
                    .size(18.0)
                    .tint(colors::ON_ACCENT),
            )
            .child(
                text(move || count().to_string())
                    .text_color(colors::ON_ACCENT)
                    .text_size(px(17.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .tabular_nums(),
            )
    };
    with_header(
        nav_page()
            .title("Custom")
            .header_style_with(|s| {
                s.bg(colors::ACCENT_FILL)
                    .text_color(colors::ON_ACCENT)
                    .tint_color(colors::ON_ACCENT)
            })
            .header_back_visible(false)
            .header_left(close())
            .header_title(title())
            .header_right(star()),
        || {
            PageHeader::new("Custom")
                .back(false)
                .background(colors::ACCENT_FILL)
                .left(close())
                .title_element(title())
                .right(star())
        },
    )
    .child(page(
        "The header's items are views: the star on the right counts presses and re-renders \
             the header.",
        [Section::new("Header")
            .note("headerRight")
            .child(
                Figure::new(move || count().to_string())
                    .unit(move || if count() == 1 { "star" } else { "stars" }),
            )
            .into_element()],
    ))
}

fn locked() -> Screen {
    titled("No swipe back").pop_on_swipe(false).child(page(
        hint(
            "The back gesture is off on this screen: no swipe on iOS, no predictive animation \
                 on Android. The back buttons still work.",
            "The back gesture is off on this screen (touch screens only). The back button, \
                 Escape and Alt+Left still work.",
        ),
        [Section::new("Leaving")
            .note("popOnSwipe={false}")
            .child(
                view()
                    .flex_row()
                    .child(
                        Stat::new("Swipe / predictive", "Off")
                            .tone(Tone::Danger)
                            .width(0.5),
                    )
                    .child(Stat::new("Back buttons", "On").tone(Tone::Up).width(0.5)),
            )
            .into_element()],
    ))
}

/// The draft's card (the screen's `pop_on_back` follows the draft).
#[component]
fn DraftCard() -> impl IntoElement {
    let draft = global::<Draft>();
    let focused = signal(false);
    let length = computed(move || draft.with(|d| d.0.chars().count()));
    let guarded = computed(move || length.get() > 0);
    Card::new()
        .icon(IconName::Form)
        .title("Draft")
        .subtitle("popOnBack={false} + onBackPress")
        .right(
            Badge::new(move || if guarded.get() { "Guarded" } else { "Empty" }).tone(move || {
                if guarded.get() {
                    Tone::Warn
                } else {
                    Tone::Neutral
                }
            }),
        )
        .child(
            input()
                .value(move || draft.with(|d| d.0.clone()))
                .placeholder("A draft")
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
                .on_change(move |text: &str| {
                    let text = text.to_owned();
                    draft.update(|draft| draft.0 = text);
                }),
        )
        .child(
            text(move || {
                if guarded.get() {
                    format!("{} characters would be lost: back asks first", length.get())
                } else {
                    "Nothing to lose: back pops".to_owned()
                }
            })
            .text_size(px(13.0))
            .text_color(colors::MUTED),
        )
}

fn unsaved() -> Screen {
    let draft = global::<Draft>();
    titled("Unsaved changes")
        .pop_on_back(move || draft.with(|d| d.0.is_empty()))
        .on_back_press(move || {
            let answer = alert_dialog()
                .title("Discard your changes?")
                .cancel("Keep editing")
                .destructive("Discard")
                .close_on_escape(true)
                .close_on_backdrop_press(true)
                .show();
            spawn(async move {
                if answer.await == Ok(Some("Discard".into())) {
                    // TS's draft is the screen's own and goes with it.
                    draft.update(|draft| draft.0.clear());
                    nav::pop();
                }
            });
        })
        .child(page(
            hint(
                "Type something, then go back (header button, swipe, Android back): the screen \
                 asks first.",
                "Type something, then go back (header button, Escape, Alt+Left, the mouse's back \
                 button): the screen asks first.",
            ),
            [draft_card().into_element()],
        ))
}

fn faded() -> Screen {
    titled("Fade")
        .animation(ScreenAnimation::Fade)
        .child(page("This screen faded in, and fades out.", []))
}

fn instant() -> Screen {
    titled("No animation")
        .animation(ScreenAnimation::None)
        .child(page(
            "Shown without a transition, and removed without one.",
            [],
        ))
}

fn headerless() -> Screen {
    nav_page().header_visible(false).child(
        view().p_safe_area().flex_1().bg(colors::BACKGROUND).child(
            view()
                .flex_1()
                .p_4()
                .gap_4()
                .child(
                    appear().index(0).child(
                        title_block("headerVisible={false}", "No header", 30.0)
                            .px_1()
                            .pt_3()
                            .child(body(
                                "The screen owns the whole surface; its env(safe-area-inset-*) padding keeps it \
                                     clear of the status bar and the home indicator.",
                            )),
                    ),
                )
                .child(
                    appear().index(1).child(
                        Section::new("Safe area")
                            .note("env(safe-area-inset-*)")
                            .child(insets()),
                    ),
                )
                .child(view().flex_1())
                .child(Button::new("Back", |_: &()| nav::pop())),
        ),
    )
}

/// Level `depth` of a deep stack.
fn deep(depth: usize) -> impl Fn() -> Screen {
    move || {
        let deeper = move |_: &()| nav::push(format!("deep-{}", depth + 1), deep(depth + 1));
        let levels = (1..=depth).map(|level| {
            let current = level == depth;
            view()
                .size(px(32.0))
                .rounded(px(8.0))
                .items_center()
                .justify_center()
                .map(|v| {
                    if current {
                        v.bg(colors::ACCENT_FILL).finish(Finish::Accent)
                    } else {
                        v.border_1()
                            .border_color(colors::BORDER)
                            .bg(colors::RAISED)
                            .finish(Finish::Raised)
                    }
                })
                .child(
                    text(level.to_string())
                        .text_size(px(13.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .tabular_nums()
                        .text_color(if current {
                            colors::ON_ACCENT
                        } else {
                            colors::MUTED
                        }),
                )
        });
        titled(format!("Level {depth}")).child(page(
            "Every push is a native screen; popToRoot() unwinds them all at once.",
            [Card::new()
                .icon(IconName::Nav)
                .title(format!("Level {depth}"))
                .subtitle(format!("{depth} deep in the stack"))
                .child(view().flex_row().flex_wrap().gap(px(6.0)).children(levels))
                .child(
                    view()
                        .flex_row()
                        .gap_2()
                        .child(Button::new("Deeper", deeper).icon(IconName::Plus).flex_1())
                        .child(
                            Button::new("To the index", |_: &()| nav::pop_to_top())
                                .variant(ButtonVariant::Secondary)
                                .flex_1(),
                        ),
                )
                .into_element()],
        ))
    }
}

/// A row that pushes a screen: an icon, a title, the API it shows.
fn link_row(
    icon_name: IconName,
    title: &'static str,
    note: &'static str,
    first: bool,
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
            .when(!first, |v| v.border_t_1().border_t_color(colors::LINE))
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
                        text(note)
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

/// Which modal shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presented {
    FullScreen,
    PageSheet,
    FormSheet,
    Fade,
    Dialog,
    Dismissible,
}

/// The modals: what they are, their note (for the device's input), their
/// icon.
fn modals() -> [(
    Presented,
    &'static str,
    &'static str,
    &'static str,
    IconName,
); 6] {
    [
        (
            Presented::FullScreen,
            "fullScreen",
            "Full screen",
            "Slides up",
            IconName::Mobile,
        ),
        (
            Presented::PageSheet,
            "pageSheet",
            "Page sheet",
            hint("iOS sheet", "A tall centered card"),
            IconName::Components,
        ),
        (
            Presented::FormSheet,
            "formSheet",
            "Form sheet",
            hint("iOS, centered", "A smaller centered card"),
            IconName::Form,
        ),
        (Presented::Fade, "fade", "Fade", "Fades in", IconName::Spark),
        (
            Presented::Dialog,
            "dialog",
            "Dialog",
            "See-through",
            IconName::Bell,
        ),
        (
            Presented::Dismissible,
            "closeOn*",
            "Dismissible",
            hint("Swipe to close", "Escape or click outside"),
            IconName::ArrowDown,
        ),
    ]
}

/// A modal's content: what it is, its safe area, a close button.
fn modal_body(
    title: &str,
    note: &str,
    text_body: &str,
    close: impl Into<Listener<()>>,
) -> impl IntoElement {
    view().p_safe_area().flex_1().bg(colors::BACKGROUND).child(
        view()
            .flex_1()
            .p_4()
            .gap_4()
            .child(
                title_block(note.to_owned(), title.to_owned(), 28.0)
                    .px_1()
                    .pt_2()
                    .child(body(text_body.to_owned())),
            )
            .child(
                Section::new("Safe area")
                    .note("the modal's")
                    .child(insets()),
            )
            .child(view().flex_1())
            .child(Button::new("Close", close)),
    )
}

/// The demo's page: rows pushing the screens, its modals, and the Android
/// back button.
#[component]
pub(crate) fn Navigation() -> impl IntoElement {
    let sheet = signal(None::<Presented>);
    // The dialog's spring in, 0 to 1.
    let pop = animated_value(0.0);
    // The back button is intercepted, and the presses it caught.
    let intercepting = signal(false);
    let presses = signal(0_u32);
    // A listener hears the button before the stack pops it; listening only
    // while intercepting keeps Android's back gesture previewing the pop.
    effect(move || {
        if intercepting.get() {
            on_back_press(move || {
                presses.update(|p| *p += 1);
                true
            });
        }
    });
    type Make = fn() -> Screen;
    let screens: [(&str, IconName, &str, &str, Make); 8] = [
        (
            "large-title",
            IconName::Text,
            "Large title",
            "headerLargeTitle",
            large_title,
        ),
        (
            "transparent",
            IconName::Styles,
            "Transparent header",
            "headerTransparent",
            transparent,
        ),
        (
            "custom",
            IconName::Star,
            "Custom header items",
            "headerLeft / Title / Right",
            custom_header,
        ),
        (
            "headerless",
            IconName::Mobile,
            "No header",
            "headerVisible={false}",
            headerless,
        ),
        (
            "faded",
            IconName::Spark,
            "Fade in",
            "animation=\"fade\"",
            faded,
        ),
        (
            "instant",
            IconName::Play,
            "No animation",
            "animation=\"none\"",
            instant,
        ),
        (
            "locked",
            IconName::Gestures,
            "No swipe back",
            "popOnSwipe={false}",
            locked,
        ),
        (
            "unsaved",
            IconName::Form,
            "Unsaved changes",
            "popOnBack={false} + onBackPress",
            unsaved,
        ),
    ];
    let links = move || {
        let mut links: Vec<AnyElement> = screens
            .into_iter()
            .enumerate()
            .map(|(i, (key, icon_name, title, note, make))| {
                link_row(icon_name, title, note, i == 0, move |_: &()| {
                    nav::push(key, make)
                })
                .into_element()
            })
            .collect();
        links.push(
            link_row(
                IconName::Lists,
                "A deep stack",
                "push / popToRoot",
                false,
                |_: &()| nav::push(format!("deep-{}", nav::depth()), deep(1)),
            )
            .into_element(),
        );
        links
    };
    let tiles = move || {
        modals().map(|(presented, _, title, note, icon_name)| {
            press()
                .label(title)
                .on_press(move || {
                    if presented == Presented::Dialog {
                        // The dialog springs up from a little smaller each
                        // time it opens.
                        pop.set(0.0);
                        pop.spring(1.0, motion::SETTLE);
                    }
                    sheet.set(Some(presented));
                })
                .w(relative(0.485))
                .child(
                    view()
                        .min_h(px(100.0))
                        .p_3()
                        .gap_3()
                        .rounded(px(radius::INSET))
                        .border_curve(BorderCurve::Continuous)
                        .bg(colors::INSET)
                        .border_1()
                        .border_color(colors::LINE)
                        .finish(Finish::Inset)
                        .child(IconTile::new(icon_name).size(32.0))
                        .child(
                            view()
                                .gap(px(2.0))
                                .child(
                                    text(title)
                                        .text_size(px(15.0))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(colors::TEXT),
                                )
                                .child(text(note).text_size(px(13.0)).text_color(colors::FAINT)),
                        ),
                )
        })
    };
    let close = move |_: &()| sheet.set(None);
    let modal_view = dynamic(move || {
        sheet.get().map(|presented| match presented {
            Presented::FullScreen
            | Presented::PageSheet
            | Presented::FormSheet
            | Presented::Fade => {
                let presentation = match presented {
                    Presented::PageSheet => ModalPresentation::PageSheet,
                    Presented::FormSheet => ModalPresentation::FormSheet,
                    _ => ModalPresentation::FullScreen,
                };
                let (_, key, title, ..) = modals()
                    .into_iter()
                    .find(|m| m.0 == presented)
                    .expect("a modal");
                dialog()
                    .presentation(presentation)
                    .animation(if presented == Presented::Fade {
                        ModalAnimation::Fade
                    } else {
                        ModalAnimation::Slide
                    })
                    .on_cancel(close)
                    .child(modal_body(
                        title,
                        key,
                        hint(
                            "Close with the button, the back button (Android) or a swipe down \
                             (iOS sheets).",
                            if presentation == ModalPresentation::FullScreen {
                                "Close with the button or Escape."
                            } else {
                                "Close with the button, Escape or a click outside the card."
                            },
                        ),
                        close,
                    ))
                    .into_element()
            }
            Presented::Dismissible => dialog()
                .close_on_escape(true)
                .close_on_backdrop_press(true)
                .close_on_swipe(true)
                .presentation(ModalPresentation::PageSheet)
                .on_cancel(close)
                .on_close(close)
                .child(modal_body(
                    "Dismissible",
                    "closeOn*",
                    hint(
                        "Swipe it down (iOS) or press back (Android): it closes natively, then \
                         tells the app.",
                        "Press Escape or click outside: it closes natively, then tells the app.",
                    ),
                    close,
                ))
                .into_element(),
            Presented::Dialog => dialog()
                .animation(ModalAnimation::Fade)
                .on_cancel(close)
                .child(
                    view()
                        .flex_1()
                        .bg(rgba(0x0000_009e))
                        .items_center()
                        .justify_center()
                        .p_4()
                        .child(
                            view()
                                .self_stretch()
                                .bind_opacity(&pop)
                                .bind_scale(&pop.interpolate(&[0.0, 1.0], &[0.9, 1.0]))
                                .child(
                                    Card::new()
                                        .icon(IconName::Bell)
                                        .title("A dialog")
                                        .subtitle("No background + fade")
                                        .child(body(
                                            "A dialog without a background shows what is behind it; the \
                                             dialog springs in natively.",
                                        ))
                                        .child(
                                            view()
                                                .flex_row()
                                                .gap_2()
                                                .child(
                                                    Button::new("Cancel", close)
                                                        .variant(ButtonVariant::Secondary)
                                                        .flex_1(),
                                                )
                                                .child(Button::new("OK", close).flex_1()),
                                        ),
                                ),
                        ),
                )
                .into_element(),
        })
    });
    DemoPage::new()
        .card(|| {
            Card::new()
                .icon(IconName::Nav)
                .title("Native stack")
                .subtitle("Headers, transitions, the safe area")
                .right(Badge::new(hint(
                    "UIKit / View",
                    if os() == Os::Linux {
                        "GTK 4"
                    } else {
                        "Native views"
                    },
                )))
                .child(insets())
        })
        .card(move || {
            Card::new()
                .title("Screens")
                .subtitle("Screen options, pushed with nav.push")
                .flush()
                .child(Inset::new().padding(0.0).gap(0.0).children(links()))
        })
        .card(move || {
            Card::new()
                .title("Modals")
                .subtitle("Presentation styles and transitions")
                .flush()
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .justify_between()
                        .gap_y_2()
                        .children(tiles()),
                )
        })
        .card(move || {
            Card::new()
                .icon(IconName::System)
                .title("Back button")
                .subtitle(hint(
                    "Android: BackHandler",
                    "BackHandler: Escape, Alt+Left",
                ))
                .right(
                    toggle()
                        .value(intercepting)
                        .label("Intercept the back button")
                        .on_change(move |&on: &bool| {
                            intercepting.set(on);
                        }),
                )
                .child(
                    Figure::new(move || presses.get().to_string())
                        .unit(move || {
                            if presses.get() == 1 {
                                "press"
                            } else {
                                "presses"
                            }
                        })
                        .note(move || {
                            if intercepting.get() {
                                "caught"
                            } else {
                                "popped"
                            }
                        })
                        .tone(move || {
                            if intercepting.get() {
                                Tone::Warn
                            } else {
                                Tone::Accent
                            }
                        }),
                )
                .child(
                    text(move || {
                        if intercepting.get() {
                            "The handler returns true: back presses stay on \
                             this screen."
                        } else {
                            hint(
                                "Off: the back button pops this screen.",
                                "Off: Escape pops this screen, or the app's \
                                 last screen does nothing.",
                            )
                        }
                    })
                    .text_size(px(13.0))
                    .line_height(px(18.0))
                    .text_color(colors::MUTED),
                )
        })
        .child(modal_view)
}
