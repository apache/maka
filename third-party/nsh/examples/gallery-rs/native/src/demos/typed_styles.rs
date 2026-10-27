//! Typed styles: what Tailwind classes do, as typed style methods (as the
//! TSX gallery's `demos/Tailwind.tsx`, the same screen written with
//! `Styled`'s methods instead of class strings).
//!
//! The gallery's design built from typed styles alone: the surfaces and
//! the citrus accent are the gallery's theme colors (`colors::*`: the TSX
//! demo's `paper-*` in light appearance, `dark:` `graphite-*`), the light
//! and depth are gradients and shadows of their own (`Finish`, as the TSX
//! demo's arbitrary values), everything else is Tailwind's palette
//! (`palette::SKY.shade(500)`) and scale. A `dark:` color is an
//! [`AdaptiveColor`] (a light and a dark value, switched natively without a
//! render), a `dark:` style of anything else `.dark(|s| ..)`; `first:` /
//! `even:` / `last:` are plain Rust from the row's index, `sm:` reads the
//! window.

use nsh_base::input;
use nsh_core::{
    element::{
        AnyElement, BlendMode, BoxShadow, Image,
        palette::{
            AMBER, BLACK, BLUE, EMERALD, FUCHSIA, GREEN, Hue, INDIGO, ORANGE, PINK, RED, ROSE, SKY,
            VIOLET, WHITE, YELLOW, ZINC,
        },
    },
    prelude::*,
};

use crate::{
    assets::LOGO,
    ui::{DemoPage, Finish, Finished, IconName, MONO, colors, icon, inset_shadow, rgb_a},
};

/// The photo of the filters' card.
const PHOTO: &str = "https://picsum.photos/seed/nsh-tailwind/600/400";

/// The citrus accent as a fill (TS `bg-citrus`).
const CITRUS: u32 = 0xc8f26d;

/// The hues of the palette card.
const HUES: [Hue; 8] = [RED, ORANGE, AMBER, EMERALD, SKY, INDIGO, PINK, ZINC];
/// The shades of the palette card.
const SHADES: [u16; 5] = [100, 300, 500, 700, 900];

/// The cards, in order (the hero counts them).
const CARDS: usize = 13;

/// `light`, and `dark` in dark appearance (Tailwind's `dark:`).
fn adaptive(light: impl Into<Hsla>, dark: impl Into<Hsla>) -> AdaptiveColor {
    AdaptiveColor::new(light, dark)
}

/// `text-zinc-{light} dark:text-zinc-{dark}`.
fn zinc(light: u16, dark: u16) -> AdaptiveColor {
    adaptive(ZINC.shade(light), ZINC.shade(dark))
}

/// A box shadow outside the box (`shadow-[0_{y}px_{blur}px_{color}]`).
fn drop(y: f32, blur: f32, color: Rgba) -> BoxShadow {
    BoxShadow {
        offset_x: px(0.0),
        offset_y: px(y),
        blur: px(blur),
        spread: px(0.0),
        color: color.to_packed(),
        inset: false,
    }
}

/// A card: an icon tile, a title and the methods it shows, over a darker
/// inset.
fn card(
    name: IconName,
    title: &'static str,
    subtitle: &'static str,
    children: impl IntoIterator<Item = AnyElement>,
) -> AnyElement {
    view()
        .rounded_2xl()
        .border_1()
        .border_color(colors::BORDER)
        .bg(colors::SURFACE)
        .p(px(5.0))
        .finish(Finish::Card)
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .px(px(11.0))
                .pb_3()
                .pt(px(11.0))
                .child(
                    view()
                        .size_10()
                        .items_center()
                        .justify_center()
                        .rounded_xl()
                        .border_1()
                        .border_color(colors::BORDER)
                        .bg(colors::RAISED)
                        .finish(Finish::Raised)
                        .child(icon().name(name).size(20.0).tint(colors::TEXT)),
                )
                .child(
                    view()
                        .flex_1()
                        .gap_0p5()
                        .child(
                            text(title)
                                .text_size(px(17.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(zinc(900, 100)),
                        )
                        .child(
                            text(subtitle)
                                .number_of_lines(2)
                                .font_family(MONO)
                                .text_xs()
                                .line_height(px(16.0))
                                .text_color(zinc(500, 400)),
                        ),
                ),
        )
        .child(
            view()
                .gap_3()
                .rounded_xl()
                .border_1()
                .border_color(colors::LINE)
                .bg(colors::INSET)
                .p_3p5()
                .finish(Finish::Inset)
                .children(children),
        )
        .into_element()
}

/// A caption under a sample.
fn label(content: impl Into<SharedString>) -> AnyElement {
    text(content.into())
        .text_center()
        .text_xs()
        .text_color(zinc(500, 400))
        .tabular_nums()
        .into_element()
}

/// A sample over its caption.
fn captioned(gap: f32, sample: impl IntoElement, caption: &'static str) -> AnyElement {
    view()
        .items_center()
        .gap(px(gap))
        .child(sample)
        .child(label(caption))
        .into_element()
}

/// The demo's page: the Tailwind demo's cards in typed styles.
#[component]
pub(crate) fn TypedStyles() -> impl IntoElement {
    let sections: [fn() -> AnyElement; CARDS] = [
        hero, stats, buttons, cards, layout, shadows, gradients, typography, effects, motion,
        lists, inputs, palette,
    ];
    DemoPage::new().cards(sections)
}

/// A gradient hero lit by a citrus glow, with a big tabular figure and two
/// badges.
fn hero() -> AnyElement {
    view()
        .overflow_hidden()
        .rounded_2xl()
        .border_1()
        .border_color(colors::BORDER)
        .bg_linear_to_br()
        .gradient_from(adaptive(WHITE, rgb(0x26282d)))
        .gradient_via(adaptive(rgb(0xfafaf8), rgb(0x18191c)))
        .gradient_to(colors::INSET)
        .p_5()
        .adaptive_shadow(
            [
                inset_shadow(1.0, 0.0, rgb(0xffffff)),
                drop(6.0, 20.0, rgb_a(0x14140a, 0.08)),
            ],
            [
                inset_shadow(1.0, 0.0, rgb_a(0xffffff, 0.08)),
                drop(10.0, 28.0, rgb_a(0x000000, 0.38)),
            ],
        )
        .child(
            view()
                .absolute()
                .right(px(-80.0))
                .top(px(-96.0))
                .size(px(288.0))
                .rounded_full()
                .bg_radial()
                .gradient_from(rgb_a(CITRUS, 0.2))
                .gradient_to(AdaptiveColor::TRANSPARENT)
                .gradient_to_position(percentage(0.7)),
        )
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap_2()
                .child(
                    view()
                        .h(px(26.0))
                        .flex_row()
                        .items_center()
                        .gap_1p5()
                        .rounded_full()
                        .bg(adaptive(BLACK.opacity(0.05), WHITE.opacity(0.1)))
                        .px_2p5()
                        .ring(px(1.0))
                        .ring_inset()
                        .ring_color(adaptive(BLACK.opacity(0.1), WHITE.opacity(0.1)))
                        .child(
                            view()
                                .size_2()
                                .items_center()
                                .justify_center()
                                .child(
                                    view()
                                        .absolute()
                                        .size_2()
                                        .rounded_full()
                                        .bg(rgb(CITRUS))
                                        .animate_ping(),
                                )
                                .child(view().size_1p5().rounded_full().bg(rgb(CITRUS))),
                        )
                        .child(
                            text("Resolved natively")
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(zinc(900, 100)),
                        ),
                )
                .child(
                    view()
                        .h(px(26.0))
                        .justify_center()
                        .rounded_full()
                        .bg(adaptive(ZINC.shade(200), WHITE.opacity(0.1)))
                        .px_2p5()
                        .child(
                            text(".dark(..)")
                                .font_family(MONO)
                                .text_xs()
                                .text_color(zinc(900, 100)),
                        ),
                ),
        )
        .child(
            text("This screen, styled with typed methods")
                .mt_6()
                .text_size(px(13.0))
                .text_color(zinc(500, 400)),
        )
        .child(
            text(CARDS.to_string())
                .text_5xl()
                .font_weight(FontWeight::SEMIBOLD)
                // `tracking-tight`: -0.025em.
                .letter_spacing(px(-1.2))
                .text_color(zinc(900, 100))
                .tabular_nums()
                .child(
                    text(" cards")
                        .text_size(px(17.0))
                        .font_weight(FontWeight::NORMAL)
                        .letter_spacing(px(0.0))
                        .text_color(zinc(500, 400)),
                ),
        )
        .child(
            text(".bg_linear_to_br() · .bg_radial() · .shadow(..)")
                .mt_2()
                .font_family(MONO)
                .text_xs()
                .text_color(ZINC.shade(500)),
        )
        .into_element()
}

/// A grid of figures, each with a tinted note.
fn stats() -> AnyElement {
    let stats = [
        (
            "Swatches",
            (HUES.len() * SHADES.len()).to_string(),
            format!("{} hues × {} shades", HUES.len(), SHADES.len()),
            colors::ACCENT,
        ),
        (
            "Gradients",
            "4".to_owned(),
            "Linear, radial, conic".to_owned(),
            adaptive(EMERALD.shade(600), EMERALD.shade(400)),
        ),
        (
            "Animations",
            "4".to_owned(),
            "Spin, ping, pulse, bounce".to_owned(),
            adaptive(SKY.shade(600), SKY.shade(400)),
        ),
        (
            "Class strings",
            "0".to_owned(),
            "Typed, checked by rustc".to_owned(),
            adaptive(AMBER.shade(600), AMBER.shade(400)),
        ),
    ];
    let tiles = stats.map(|(label, value, note, tone)| {
        view()
            .gap_1()
            .rounded(px(10.0))
            .border_1()
            .border_color(colors::LINE)
            .finish_fill(Finish::Card)
            .p_3()
            .adaptive_shadow(
                [inset_shadow(1.0, 0.0, rgb(0xffffff))],
                [inset_shadow(1.0, 0.0, rgb_a(0xffffff, 0.05))],
            )
            .child(text(label).text_xs().text_color(ZINC.shade(500)))
            .child(
                text(value)
                    .text_size(px(26.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .letter_spacing(px(-0.65))
                    .text_color(zinc(900, 100))
                    .tabular_nums(),
            )
            .child(
                text(note)
                    .number_of_lines(1)
                    .text_xs()
                    .tabular_nums()
                    .text_color(tone),
            )
    });
    let legend = [
        (adaptive(rgb(CITRUS), rgb(CITRUS)), "Palette"),
        (EMERALD.shade(400).into(), "Gradients"),
        (SKY.shade(400).into(), "Motion"),
        (AMBER.shade(400).into(), "Checks"),
    ]
    .map(|(color, name): (AdaptiveColor, &str)| {
        view()
            .flex_row()
            .items_center()
            .gap_1p5()
            .child(view().size_2p5().rounded(px(3.0)).bg(color))
            .child(text(name).text_size(px(13.0)).text_color(zinc(500, 400)))
    });
    card(
        IconName::Stocks,
        "Stat grid",
        ".grid().grid_cols(2).gap_2()",
        [
            view()
                .grid()
                .grid_cols(2)
                .gap_2()
                .children(tiles)
                .into_element(),
            view()
                .flex_row()
                .flex_wrap()
                .gap_x_4()
                .gap_y_2()
                .children(legend)
                .into_element(),
        ],
    )
}

/// Buttons: press states without a render, transitions, disabled.
fn buttons() -> AnyElement {
    // The first button's presses; the third button is disabled.
    let count = signal(0_u32);
    let busy = signal(false);
    let pressed = view()
        .h_11()
        .flex_row()
        .items_center()
        .justify_center()
        .rounded(px(10.0))
        .bg(zinc(900, 100))
        .finish(Finish::Light)
        .transition()
        .duration(150.0)
        .active(|s| s.scale(0.97).opacity(0.9))
        .on_press(move || count.update(|n| *n += 1))
        .child(
            text(move || format!("Pressed {}×", count.get()))
                .text_size(px(15.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(adaptive(WHITE, ZINC.shade(900))),
        );
    let reset = view()
        .h_11()
        .flex_1()
        .items_center()
        .justify_center()
        .rounded(px(10.0))
        .border_1()
        .border_color(colors::BORDER)
        .bg(colors::RAISED)
        .finish(Finish::Raised)
        .transition()
        .active(|s| s.scale(0.95).opacity(0.8))
        .on_press(move || count.set(0))
        .child(
            text("Reset")
                .text_size(px(15.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(zinc(900, 100)),
        );
    let disable = view()
        .h_11()
        .flex_1()
        .items_center()
        .justify_center()
        .rounded(px(10.0))
        .bg(rgb(CITRUS))
        .finish(Finish::Accent)
        .transition()
        .active(|s| s.scale(0.95))
        .hover(|s| s.opacity(0.9))
        .disabled(busy)
        .disabled_style(|s| s.opacity(0.4))
        .on_press(move || busy.update(|b| *b = !*b))
        .child(
            text(move || if busy.get() { "Disabled" } else { "Disable me" })
                .text_size(px(15.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(colors::ON_ACCENT),
        );
    let enable = view()
        .min_h(px(44.0))
        .justify_center()
        .self_start()
        .rounded_lg()
        .px_1()
        .active(|s| s.bg(adaptive(BLACK.opacity(0.05), WHITE.opacity(0.05))))
        .on_press(move || busy.set(false))
        .child(
            text("Enable again")
                .text_sm()
                .text_color(colors::ACCENT)
                .underline()
                .text_decoration_dotted()
                .underline_offset(px(4.0)),
        );
    card(
        IconName::Components,
        "Buttons",
        ".active(..) .hover(..) .transition() .disabled_style(..)",
        [
            pressed.into_element(),
            view()
                .flex_row()
                .gap_2()
                .child(reset)
                .child(disable)
                .into_element(),
            enable.into_element(),
        ],
    )
}

/// Cards: a group press row, tinted badges, an inner ring.
fn cards() -> AnyElement {
    let group = view()
        .group()
        .flex_row()
        .items_center()
        .gap_3()
        .rounded_xl()
        .finish_fill(Finish::Raised)
        .p_3()
        .shadow_md()
        .shadow_color(adaptive(BLACK.opacity(0.1), BLACK.opacity(0.4)))
        .ring(px(1.0))
        .ring_inset()
        .ring_color(adaptive(BLACK.opacity(0.05), WHITE.opacity(0.1)))
        .transition_transform()
        .duration(200.0)
        .active(|s| s.scale(0.98))
        .child(image(LOGO).size_12().rounded(px(10.0)))
        .child(
            view()
                .flex_1()
                .gap_0p5()
                .child(
                    text("Group press")
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(zinc(900, 100)),
                )
                .child(
                    text("Press the card: this line changes color")
                        .text_size(px(13.0))
                        .text_color(zinc(500, 400))
                        .group_active(|s| s.text_color(colors::ACCENT)),
                ),
        )
        .child(
            text("›")
                .text_2xl()
                .text_color(zinc(400, 600))
                .transition_transform()
                .group_active(|s| s.translate_x(px(4.0))),
        );
    let tinted = |hue: Hue, label: &'static str| {
        view()
            .h(px(26.0))
            .justify_center()
            .rounded_full()
            .px_2p5()
            .bg(adaptive(
                hue.shade(500).opacity(0.15),
                hue.shade(400).opacity(0.15),
            ))
            .child(
                text(label)
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(adaptive(hue.shade(700), hue.shade(400))),
            )
    };
    let outline = view()
        .h(px(26.0))
        .justify_center()
        .rounded_full()
        .px_2p5()
        .border_1()
        .border_color(adaptive(ROSE.shade(500), ROSE.shade(400)))
        .child(
            text("Outline")
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(adaptive(ROSE.shade(600), ROSE.shade(400))),
        );
    card(
        IconName::Styles,
        "Cards and badges",
        ".group_active(..) .ring_inset() .shadow_md()",
        [
            group.into_element(),
            view()
                .flex_row()
                .flex_wrap()
                .gap_2()
                .child(tinted(EMERALD, "Filled"))
                .child(tinted(SKY, "Live"))
                .child(tinted(AMBER, "Pending"))
                .child(outline)
                .into_element(),
        ],
    )
}

/// Flex rows, a grid and a breakpoint (the window's width).
fn layout() -> AnyElement {
    let violet = |alpha: f32| {
        view()
            .h_12()
            .rounded_lg()
            .bg(VIOLET.shade(500).opacity(alpha))
    };
    card(
        IconName::Lists,
        "Flex, grid, breakpoints",
        ".flex_grow(2.0) .col_span(2) .row_span(2) sm:",
        [
            view()
                .flex_row()
                .gap_2()
                .child(
                    view()
                        .h_10()
                        .flex_1()
                        .rounded_lg()
                        .bg(SKY.shade(400).opacity(0.2)),
                )
                .child(
                    view()
                        .h_10()
                        .flex_1()
                        .flex_grow(2.0)
                        .rounded_lg()
                        .bg(SKY.shade(400).opacity(0.5)),
                )
                .child(view().size_10().rounded_lg().bg(SKY.shade(400)))
                .into_element(),
            view()
                .grid()
                .grid_cols(3)
                .gap_2()
                .child(
                    view()
                        .col_span(2)
                        .h_12()
                        .items_center()
                        .justify_center()
                        .rounded_lg()
                        .border_1()
                        .border_color(VIOLET.shade(400).opacity(0.4))
                        .bg(VIOLET.shade(500).opacity(0.15))
                        .child(
                            text("col-span-2")
                                .font_family(MONO)
                                .text_xs()
                                .text_color(adaptive(VIOLET.shade(600), VIOLET.shade(300))),
                        ),
                )
                .child(violet(0.25))
                .child(violet(0.35))
                .child(
                    view()
                        .row_span(2)
                        .items_center()
                        .justify_center()
                        .rounded_lg()
                        .bg(VIOLET.shade(500))
                        .child(
                            text("row-span-2")
                                .font_family(MONO)
                                .text_size(px(11.0))
                                .text_color(WHITE),
                        ),
                )
                .child(violet(0.45))
                .child(violet(0.55))
                .child(violet(0.7))
                .into_element(),
            view()
                .flex_col()
                .gap_2()
                .style_when(|| window().width.0 >= 640.0, |s| s.flex_row())
                .child(
                    view()
                        .h_8()
                        .flex_1()
                        .rounded_lg()
                        .bg(AMBER.shade(400).opacity(0.3)),
                )
                .child(
                    view()
                        .h_8()
                        .flex_1()
                        .rounded_lg()
                        .bg(AMBER.shade(400).opacity(0.6)),
                )
                .into_element(),
            label("The last row is a column on phones and a row from 640 pt up (sm:)."),
        ],
    )
}

/// The shadow presets, an inset shadow, a ring, an outline, a glow.
fn shadows() -> AnyElement {
    type Shadow = fn(View) -> View;
    let sizes: [(&str, Shadow); 5] = [
        ("sm", |v| v.shadow_sm()),
        ("md", |v| v.shadow_md()),
        ("lg", |v| v.shadow_lg()),
        ("xl", |v| v.shadow_xl()),
        ("2xl", |v| v.shadow_2xl()),
    ];
    let tile = || view().size_12().rounded_xl();
    card(
        IconName::Spark,
        "Shadows, rings, outlines",
        ".shadow_*() .ring(..) .outline(..) .inset_shadow_*()",
        [
            view()
                .flex_row()
                .justify_between()
                .px_1()
                .py_2()
                .children(sizes.map(|(name, shadow)| {
                    captioned(
                        8.0,
                        shadow(tile().bg(colors::RAISED)).shadow_color(BLACK),
                        name,
                    )
                }))
                .into_element(),
            view()
                .flex_row()
                .justify_between()
                .px_1()
                .pb_1()
                .child(captioned(
                    8.0,
                    tile()
                        .bg(adaptive(rgb(0xf0f0ec), BLACK))
                        .inset_shadow_sm()
                        .inset_shadow_color(adaptive(BLACK.opacity(0.1), WHITE.opacity(0.1)))
                        .ring(px(1.0))
                        .ring_inset()
                        .ring_color(adaptive(BLACK.opacity(0.05), WHITE.opacity(0.1))),
                    "Inset",
                ))
                .child(captioned(
                    8.0,
                    tile()
                        .bg(colors::RAISED)
                        .ring(px(2.0))
                        .ring_color(SKY.shade(400))
                        .ring_offset(px(2.0))
                        .ring_offset_color(colors::INSET),
                    "Ring",
                ))
                .child(captioned(
                    8.0,
                    tile()
                        .rounded_full()
                        .bg(colors::RAISED)
                        .outline(px(2.0))
                        .outline_offset(px(2.0))
                        .outline_dashed()
                        .outline_color(PINK.shade(400)),
                    "Outline",
                ))
                .child(captioned(
                    8.0,
                    tile()
                        .bg(EMERALD.shade(400))
                        .shadow_lg()
                        .shadow_color(EMERALD.shade(400).opacity(0.5)),
                    "Glow",
                ))
                .into_element(),
        ],
    )
}

/// Linear, angled, radial and conic gradients.
fn gradients() -> AnyElement {
    let tile = || view().size_16().rounded_2xl();
    card(
        IconName::Canvas,
        "Gradients",
        ".bg_linear_*() .bg_radial() .bg_conic(..)",
        [view()
            .flex_row()
            .justify_between()
            .child(captioned(
                8.0,
                tile()
                    .bg_linear_to_r()
                    .gradient_from(SKY.shade(400))
                    .gradient_to(BLUE.shade(600)),
                "Linear",
            ))
            .child(captioned(
                8.0,
                tile()
                    .bg_linear(deg(45.0))
                    .gradient_from(ROSE.shade(400))
                    .gradient_via(FUCHSIA.shade(500))
                    .gradient_to(INDIGO.shade(500)),
                "45°",
            ))
            .child(captioned(
                8.0,
                tile()
                    .bg_radial()
                    .gradient_from(YELLOW.shade(200))
                    .gradient_to(ORANGE.shade(500)),
                "Radial",
            ))
            .child(captioned(
                8.0,
                tile()
                    .bg_conic(deg(0.0))
                    .gradient_from(RED.shade(500))
                    .gradient_via(GREEN.shade(500))
                    .gradient_to(RED.shade(500)),
                "Conic",
            ))
            .into_element()],
    )
}

/// Sizes, weights, families, decorations, truncation, a text shadow.
fn typography() -> AnyElement {
    let body = zinc(700, 300);
    card(
        IconName::Text,
        "Typography",
        ".font_weight(..) .letter_spacing(..) .text_decoration_*() .number_of_lines(..)",
        [
            text("Display")
                .text_3xl()
                .font_weight(FontWeight::BLACK)
                // `tracking-tight`: -0.025em.
                .letter_spacing(px(-0.75))
                .text_color(zinc(900, 100))
                .into_element(),
            text("Light, large and relaxed")
                .text_lg()
                .font_weight(FontWeight::LIGHT)
                .text_color(body)
                .into_element(),
            text("Serif italic")
                .font_family("serif")
                .text_lg()
                .italic()
                .text_color(body)
                .into_element(),
            text("font-mono 0123456789")
                .font_family(MONO)
                .text_sm()
                .text_color(body)
                .tabular_nums()
                .into_element(),
            view()
                .flex_row()
                .flex_wrap()
                .gap_x_4()
                .gap_y_1()
                .text_size(px(15.0))
                .text_color(zinc(800, 200))
                .child(
                    text("wavy")
                        .underline()
                        .text_decoration_wavy()
                        .text_decoration_color(ROSE.shade(400)),
                )
                .child(
                    text("double")
                        .underline()
                        .text_decoration_double()
                        .text_decoration_color(SKY.shade(400)),
                )
                .child(
                    text("dashed")
                        .underline()
                        .text_decoration_dashed()
                        .text_decoration_thickness(px(2.0)),
                )
                .child(
                    text("struck")
                        .line_through()
                        .text_decoration_color(ZINC.shade(500)),
                )
                .child(
                    text("caps")
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .uppercase()
                        // `tracking-widest`: 0.1em.
                        .letter_spacing(px(1.2))
                        .text_color(colors::ACCENT),
                )
                .into_element(),
            text(
                "number_of_lines(1): a single line that is far too long to fit in the card cut \
                 with an ellipsis",
            )
            .number_of_lines(1)
            .text_size(px(13.0))
            .text_color(ZINC.shade(500))
            .into_element(),
            text(
                "number_of_lines(2): Text is laid out once on the engine thread and drawn on the \
                 main thread; typed styles reach it through the same style path as everything \
                 else, so the third line of this paragraph never shows.",
            )
            .number_of_lines(2)
            .text_size(px(13.0))
            // `leading-relaxed`: 1.625 × 13 pt.
            .line_height(px(21.125))
            .text_color(ZINC.shade(500))
            .into_element(),
            text("text_shadow_md()")
                .self_start()
                .rounded_md()
                .bg(SKY.shade(500))
                .px_2()
                .text_xl()
                .font_weight(FontWeight::BOLD)
                .text_color(WHITE)
                .text_shadow_md()
                .into_element(),
        ],
    )
}

/// Filters on a photo, backdrop blur and blending.
fn effects() -> AnyElement {
    type Filter = fn(Image) -> Image;
    let filters: [(&str, Filter); 5] = [
        ("None", |i| i),
        ("grayscale", |i| i.grayscale(1.0)),
        ("sepia", |i| i.sepia(1.0)),
        ("blur-sm", |i| i.blur(8.0)),
        ("brightness-50", |i| i.brightness(0.5)),
    ];
    card(
        IconName::Photos,
        "Filters and blur",
        ".grayscale(..) .sepia(..) .blur(..) .backdrop_blur(..) .mix_blend_mode(..)",
        [
            view()
                .flex_row()
                .justify_between()
                .children(filters.map(|(name, filter)| {
                    captioned(6.0, filter(image(PHOTO).size_14().rounded_xl()), name)
                }))
                .into_element(),
            view()
                .h_32()
                .overflow_hidden()
                .rounded_xl()
                .child(image(PHOTO).absolute().inset_0().size_full())
                .child(
                    view()
                        .absolute()
                        .left_3()
                        .right_3()
                        .bottom_3()
                        .rounded_lg()
                        .border_1()
                        .border_color(WHITE.opacity(0.1))
                        .bg(BLACK.opacity(0.4))
                        .px_3()
                        .py_2()
                        .backdrop_blur(12.0)
                        .child(
                            text(".backdrop_blur(12.0) over black at 40%")
                                .text_size(px(13.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(WHITE),
                        ),
                )
                .child(
                    view()
                        .absolute()
                        .right_3()
                        .top_3()
                        .size_10()
                        .rounded_full()
                        .bg(YELLOW.shade(300))
                        .mix_blend_mode(BlendMode::Multiply),
                )
                .into_element(),
        ],
    )
}

/// Spinning, pinging, pulsing and bouncing, and a fixed transform.
fn motion() -> AnyElement {
    card(
        IconName::Animation,
        "Animations and transforms",
        ".animate_*() .rotate(..) .skew_x(..) .scale(..)",
        [view()
            .flex_row()
            .items_center()
            .justify_between()
            .px_1()
            .py_2()
            .child(captioned(
                10.0,
                view()
                    .size_8()
                    .rounded_lg()
                    .bg(VIOLET.shade(500))
                    .animate_spin(),
                "Spin",
            ))
            .child(captioned(
                10.0,
                view()
                    .size_8()
                    .items_center()
                    .justify_center()
                    .child(
                        view()
                            .absolute()
                            .size_4()
                            .rounded_full()
                            .bg(SKY.shade(400))
                            .animate_ping(),
                    )
                    .child(view().size_4().rounded_full().bg(SKY.shade(400))),
                "Ping",
            ))
            .child(captioned(
                10.0,
                view()
                    .h_8()
                    .w_14()
                    .rounded_lg()
                    .bg(adaptive(rgb(0xe2e2dd), rgb(0x24262a)))
                    .animate_pulse(),
                "Pulse",
            ))
            .child(captioned(
                10.0,
                view()
                    .size_8()
                    .rounded_full()
                    .bg(ORANGE.shade(400))
                    .animate_bounce(),
                "Bounce",
            ))
            .child(captioned(
                10.0,
                view()
                    .size_8()
                    .rotate(deg(12.0))
                    .skew_x(deg(6.0))
                    .scale(0.9)
                    .rounded_lg()
                    .bg(EMERALD.shade(400)),
                "Transform",
            ))
            .into_element()],
    )
}

/// Rows styled by their place: `first:`, `even:`, `last:` from the index.
fn lists() -> AnyElement {
    let items = ["Inbox", "Drafts", "Sent", "Archive", "Trash"];
    let count = items.len();
    card(
        IconName::Lists,
        "Structural variants",
        "first / even / last from the index, .active(..)",
        [view()
            .overflow_hidden()
            .rounded_xl()
            .border_1()
            .border_color(colors::LINE)
            .children(items.iter().enumerate().map(|(i, item)| {
                // `even:` is the 2nd, 4th, ... child.
                let (first, even, last) = (i == 0, i % 2 == 1, i + 1 == count);
                view()
                    .min_h_12()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .when(!first, |v| v.border_t_1().border_t_color(colors::LINE))
                    .px_3p5()
                    .when(even, |v| {
                        v.bg(adaptive(BLACK.opacity(0.03), WHITE.opacity(0.05)))
                    })
                    .when(last, |v| v.bg(ROSE.shade(500).opacity(0.1)))
                    .active(|s| s.bg(rgb_a(CITRUS, 0.1)))
                    .child(text(*item).text_size(px(15.0)).text_color(if last {
                        adaptive(ROSE.shade(600), ROSE.shade(300))
                    } else {
                        zinc(800, 200)
                    }))
                    .child(text("›").text_base().text_color(zinc(400, 600)))
            }))
            .into_element()],
    )
}

/// An input with focus, placeholder and caret colors.
fn inputs() -> AnyElement {
    card(
        IconName::Form,
        "Inputs",
        ".focus(..) .placeholder_color(..) .selection_color(..)",
        [
            input()
                .placeholder("Focus me")
                .placeholder_color(|| color(zinc(400, 600)))
                .selection_color(|| color(colors::ACCENT))
                .h_11()
                .rounded(px(10.0))
                .border_1()
                .border_color(colors::BORDER)
                .bg(colors::SURFACE)
                .px_3p5()
                .finish_shadow(Finish::Inset)
                .text_size(px(15.0))
                .text_color(zinc(900, 100))
                .focus(|s| {
                    s.border_color(colors::ACCENT)
                        .ring(px(2.0))
                        .ring_color(adaptive(rgb_a(CITRUS, 0.4), rgb_a(CITRUS, 0.25)))
                })
                .into_element(),
            label(
                "Focus adds a border and a ring; the placeholder and caret colors are typed props \
                 too.",
            ),
        ],
    )
}

/// Five shades of eight hues.
fn palette() -> AnyElement {
    card(
        IconName::Image,
        "Palette",
        ".bg(palette::SKY.shade(500))",
        [view()
            .gap_1p5()
            .children(HUES.map(|hue| {
                view()
                    .flex_row()
                    .items_center()
                    .gap_1p5()
                    .child(text(hue.name()).w_16().text_xs().text_color(zinc(500, 400)))
                    .children(
                        SHADES.map(|shade| view().h_6().flex_1().rounded_md().bg(hue.shade(shade))),
                    )
            }))
            .into_element()],
    )
}
