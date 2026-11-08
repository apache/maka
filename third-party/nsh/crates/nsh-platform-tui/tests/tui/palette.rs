//! Colors: the app's colors drawn as the terminal theme's meanings (the
//! default foreground, dim, or an accent), no fills, and text drawn with its
//! weight and decorations.

use std::sync::Arc;

use nsh_core::{platform::ColorScheme, prelude::*};
use nsh_platform_tui::{App, AppOptions, AppView, ColorDepth, Root};
use ratatui_core::{
    backend::TestBackend,
    buffer::Buffer,
    style::{Color, Modifier},
    terminal::Terminal,
};

use super::app::{draw_until, selected};

/// A surface on a terminal with `scheme`'s background that shows `depth`.
fn surface_with(
    scheme: ColorScheme,
    depth: ColorDepth,
) -> (AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.capabilities.background = scheme;
    options.capabilities.colors = depth;
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    (AppView::new(options), rx)
}

fn dim(buffer: &Buffer, x: u16, y: u16) -> bool {
    buffer[(x, y)].modifier.contains(Modifier::DIM)
}

#[component]
fn Card() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .bg(nsh_core::color::rgb(0x3b82f6))
                .child(text("ink").text_color(nsh_core::color::rgb(0x22c55e))),
        )
        .child(text("ready").text_color(nsh_core::color::rgb(0xfafafa)))
}

#[test]
fn colors_are_the_terminals_meanings_at_every_depth_and_a_fill_shows_without_surfaces() {
    for depth in [
        ColorDepth::TrueColor,
        ColorDepth::Ansi256,
        ColorDepth::Ansi16,
    ] {
        let (mut view, rx) = surface_with(ColorScheme::Dark, depth);
        let mut terminal = Terminal::new(TestBackend::new(20, 4)).unwrap();
        view.load(App::Rust(Root::new::<Card>(|| ()))).unwrap();
        draw_until(&mut view, &mut terminal, &rx, "ready");
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(0, 0)].symbol(), "i");
        assert_eq!(buffer[(0, 0)].fg, Color::Green, "an accent, {depth:?}");
        // The blue card is a surface (a fill, no line) whatever the depth:
        // without a ramp its fill in the terminal's colors, and nothing
        // past it.
        for x in [0, 9] {
            assert_ne!(
                buffer[(x, 0)].bg,
                Color::Reset,
                "its fill at {x}, {depth:?}"
            );
        }
        assert_eq!(buffer[(10, 0)].bg, Color::Reset, "past it, {depth:?}");
        assert_eq!(buffer[(0, 1)].fg, Color::Reset, "the body, {depth:?}");
        assert!(!dim(buffer, 0, 1), "{depth:?}");
        assert_eq!(buffer[(0, 1)].bg, Color::Reset);
    }
}

#[component]
fn Accents() -> impl IntoElement {
    let line =
        |label: &'static str, color: u32| text(label).text_color(nsh_core::color::rgb(color));
    view()
        .flex_1()
        .child(line("red", 0xef4444))
        .child(line("amber", 0xf59e0b))
        .child(line("teal", 0x14b8a6))
        .child(line("violet", 0x8b5cf6))
        .child(line("pink", 0xec4899))
        .child(line("muted", 0x71717a))
        .child(line("ready", 0x09090b))
}

#[test]
fn saturated_colors_take_their_hues_accent_and_low_contrast_ones_are_dim() {
    let (mut view, rx) = surface_with(ColorScheme::Dark, ColorDepth::TrueColor);
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<Accents>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let accents = [
        Color::Red,
        Color::Yellow,
        Color::Cyan,
        Color::Blue,
        Color::Magenta,
    ];
    for (y, accent) in accents.into_iter().enumerate() {
        let y = y as u16;
        assert_eq!(buffer[(0, y)].fg, accent, "row {y}");
        assert!(!dim(buffer, 0, y), "row {y}");
    }
    assert_eq!(buffer[(0, 5)].fg, Color::Reset, "secondary text");
    assert!(dim(buffer, 0, 5), "never a gray of the palette");
    assert_eq!(buffer[(0, 6)].fg, Color::Reset);
    assert!(
        !dim(buffer, 0, 6),
        "black (unstyled text) is the default foreground on a dark page too"
    );
}

#[test]
fn a_light_page_reads_dark_text_as_the_body() {
    let (mut view, rx) = surface_with(ColorScheme::Light, ColorDepth::TrueColor);
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<Accents>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 6)].fg, Color::Reset);
    assert!(!dim(buffer, 0, 6));
}

#[component]
fn Translucent() -> impl IntoElement {
    view()
        .flex_1()
        .child(text("faint").text_color(nsh_core::color::rgba(0xffffff80)))
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .opacity(0.5)
                .bg(nsh_core::color::rgb(0xffffff))
                .child(text("half").text_color(nsh_core::color::rgb(0x000000))),
        )
        .child(text("gone").text_color(nsh_core::color::rgba(0xffffff00)))
        .child(text("ready"))
}

#[test]
fn translucent_text_reads_over_its_ground_and_opacity_changes_no_color() {
    let (mut view, rx) = surface_with(ColorScheme::Dark, ColorDepth::TrueColor);
    let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
    view.load(App::Rust(Root::new::<Translucent>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert!(dim(buffer, 0, 0), "half white over black is secondary");
    assert_eq!(
        buffer[(0, 1)].fg,
        Color::Reset,
        "black read on its white fill"
    );
    assert!(!dim(buffer, 0, 1), "opacity is not a tint");
    // Without surfaces the small box is its fill in a standard color.
    assert_ne!(buffer[(0, 1)].bg, Color::Reset, "the fill shows");
    assert!(
        buffer[(0, 2)].modifier.contains(Modifier::HIDDEN),
        "a transparent color hides its text"
    );
}

#[component]
fn Emphasis() -> impl IntoElement {
    view()
        .flex_1()
        .child(text("semibold").font_weight(FontWeight::SEMIBOLD))
        .child(text("medium").font_weight(FontWeight(500)))
        .child(text("italic").italic())
        .child(text("underline").underline())
        .child(text("struck").line_through())
}

#[test]
fn weight_600_and_above_is_bold_and_style_and_decorations_stay() {
    let (mut view, rx) = surface_with(ColorScheme::Dark, ColorDepth::TrueColor);
    let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
    view.load(App::Rust(Root::new::<Emphasis>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "struck");
    let buffer = terminal.backend().buffer();
    assert!(buffer[(0, 0)].modifier.contains(Modifier::BOLD));
    assert!(!buffer[(0, 1)].modifier.contains(Modifier::BOLD));
    assert!(buffer[(0, 2)].modifier.contains(Modifier::ITALIC));
    assert!(buffer[(0, 3)].modifier.contains(Modifier::UNDERLINED));
    assert!(buffer[(0, 4)].modifier.contains(Modifier::CROSSED_OUT));
}

#[component]
fn Gradient() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .bg_linear_to_r()
                .gradient_from(nsh_core::color::rgb(0x000000))
                .gradient_to(nsh_core::color::rgb(0xffffff)),
        )
        .child(text("ready"))
}

#[test]
fn a_gradient_draws_nothing() {
    let (mut view, rx) = surface_with(ColorScheme::Dark, ColorDepth::TrueColor);
    let mut terminal = Terminal::new(TestBackend::new(20, 3)).unwrap();
    view.load(App::Rust(Root::new::<Gradient>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    for x in [0, 9] {
        assert_eq!(buffer[(x, 0)].bg, Color::Reset, "{x}");
        assert_eq!(buffer[(x, 0)].symbol(), " ", "{x}");
    }
}

/// A surface on a dark terminal whose own colors are known: its surfaces
/// are steps of them.
fn surfaces() -> (AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.capabilities.colors = ColorDepth::TrueColor;
    options.capabilities.background_color = Some([24; 3]);
    options.capabilities.foreground_color = Some([224; 3]);
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    (AppView::new(options), rx)
}

#[component]
fn Layers() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .bg(nsh_core::color::rgb(0x27272a))
                .child(text("raised")),
        )
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .bg(nsh_core::color::rgb(0x3b82f6))
                .child(text("accent").text_color(nsh_core::color::rgb(0xffffff))),
        )
        .child(text("muted").text_color(nsh_core::color::rgb(0x71717a)))
        .child(text("ready"))
}

fn row_of(buffer: &Buffer, word: &str) -> u16 {
    (0..buffer.area.height)
        .find(|&y| {
            let row: String = (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect();
            row.contains(word)
        })
        .unwrap_or_else(|| panic!("{word} not drawn"))
}

#[test]
fn fills_are_steps_of_the_terminals_own_background() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
    view.load(App::Rust(Root::new::<Layers>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let raised = row_of(buffer, "raised");
    assert_eq!(
        buffer[(0, raised)].bg,
        Color::Rgb(38, 38, 38),
        "one step up"
    );
    assert_eq!(
        buffer[(9, raised)].bg,
        Color::Rgb(38, 38, 38),
        "the whole frame"
    );
    assert_eq!(buffer[(10, raised)].bg, Color::Reset);
    let accent = row_of(buffer, "accent");
    assert_eq!(
        buffer[(0, accent)].bg,
        Color::Rgb(42, 77, 135),
        "the accent tinted in, opaque: the solid share"
    );
    let muted = row_of(buffer, "muted");
    assert_eq!(
        buffer[(0, muted)].fg,
        Color::Rgb(124, 124, 124),
        "a fade, not dim"
    );
    assert!(!dim(buffer, 0, muted));
    assert_eq!(
        buffer[(0, row_of(buffer, "ready"))].bg,
        Color::Reset,
        "the page is never painted"
    );
}

#[component]
fn Ragged() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .bg(nsh_core::color::rgb(0x27272a))
                .child(text("short"))
                .child(text("a longer line")),
        )
        .child(text("ready"))
}

#[test]
fn a_filled_box_is_one_band_behind_texts_of_any_length() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 6)).unwrap();
    view.load(App::Rust(Root::new::<Ragged>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let (short, long) = (row_of(buffer, "short"), row_of(buffer, "longer"));
    for y in short..=long {
        for x in 0..20 {
            assert_eq!(
                buffer[(x, y)].bg,
                Color::Rgb(38, 38, 38),
                "the card's Cell at {x}, {y}"
            );
        }
        assert_eq!(buffer[(20, y)].bg, Color::Reset, "past the card on row {y}");
    }
}

#[component]
fn Paged() -> impl IntoElement {
    view()
        .flex_1()
        .bg(nsh_core::color::rgb(0x1c1d20))
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .bg(nsh_core::color::rgb(0x27272a))
                .child(text("card")),
        )
        .child(text("ready"))
}

#[test]
fn the_apps_page_color_is_the_terminals_background() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
    view.load(App::Rust(Root::new::<Paged>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert_eq!(
        buffer[(19, 5)].bg,
        Color::Reset,
        "the page is never painted"
    );
    assert_eq!(buffer[(0, row_of(buffer, "ready"))].bg, Color::Reset);
    let card = row_of(buffer, "card");
    assert_eq!(
        buffer[(0, card)].bg,
        Color::Rgb(38, 38, 38),
        "a step above the page"
    );
}

#[component]
fn Banded() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .accessibility_state(selected())
                .child(text("row")),
        )
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .on_press(|_: &()| {})
                .child(text("go")),
        )
        .child(text("ready"))
}

#[test]
fn selection_is_a_select_band_and_bold_and_focus_the_accent_on_surfaces() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Banded>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let select = Color::Rgb(56, 56, 56);
    assert_eq!(buffer[(0, 0)].bg, select);
    assert_eq!(buffer[(9, 0)].bg, select, "the band spans the row's frame");
    assert!(buffer[(0, 0)].modifier.contains(Modifier::BOLD));
    assert!(!buffer[(0, 0)].modifier.contains(Modifier::REVERSED));
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if terminal.backend().buffer()[(0, 1)].bg == Color::Blue {
            break;
        }
        assert!(rx.recv_deadline(deadline).is_ok(), "focus did not show");
    }
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(9, 1)].bg, Color::Blue, "the band spans the row");
    assert!(!buffer[(0, 1)].modifier.contains(Modifier::BOLD));
    assert!(!buffer[(0, 1)].modifier.contains(Modifier::REVERSED));
    assert_eq!(
        buffer[(0, 0)].bg,
        select,
        "the selection keeps its gray band"
    );
}

/// A framed card holding a button, as a menu bar's or a form's.
#[component]
fn FramedCard() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .border_1()
                .border_color(nsh_core::color::rgb(0x3f3f46))
                .py(px(16.0))
                .child(text("card"))
                .child(
                    view()
                        .w(px(80.0))
                        .h(px(16.0))
                        .on_press(|_: &()| {})
                        .child(text("go")),
                ),
        )
        .child(text("ready"))
}

/// The accent marks the focused stop alone: a card whose button has the
/// focus keeps its own line, the button showing the focus.
#[test]
fn a_card_holding_the_focused_button_keeps_its_line_out_of_the_accent() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 8)).unwrap();
    view.load(App::Rust(Root::new::<FramedCard>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let frame = |buffer: &Buffer| {
        (0..buffer.area.height)
            .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
            .filter(|&at| {
                buffer[at]
                    .symbol()
                    .chars()
                    .next()
                    .is_some_and(|c| ('\u{2500}'..='\u{257f}').contains(&c))
            })
            .map(|at| (at, buffer[at].fg, buffer[at].modifier))
            .collect::<Vec<_>>()
    };
    let rest = frame(terminal.backend().buffer());
    assert!(!rest.is_empty(), "the card draws its line");
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let go = (0..buffer.area.height)
            .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
            .find(|&at| buffer[at].symbol() == "g");
        if go.is_some_and(|at| buffer[at].bg == Color::Blue) {
            break;
        }
        assert!(rx.recv_deadline(deadline).is_ok(), "focus did not show");
    }
    let focused = frame(terminal.backend().buffer());
    for ((at, fg, _), (_, rest_fg, _)) in focused.iter().zip(&rest) {
        assert_ne!(*fg, Color::Blue, "the card's line at {at:?} in the accent");
        assert_eq!(fg, rest_fg, "the card's line at {at:?} changed");
    }
    assert_eq!(focused, rest, "the card's line as it rests");
}

/// A pagination: the current dot in the accent, the others gray; a
/// chosen thumbnail with a neutral label beside them.
#[component]
fn Dots() -> impl IntoElement {
    let dot = |symbol: &'static str, current: bool| {
        let mark = text(symbol);
        view()
            .w(px(16.0))
            .h(px(16.0))
            .role(nsh_core::AccessibilityRole::Button)
            .on_press(|_: &()| {})
            .accessibility_state(nsh_core::AccessibilityState {
                selected: current,
                ..Default::default()
            })
            .child(if current {
                mark.text_color(nsh_core::color::rgb(0x22c55e))
            } else {
                mark.text_color(nsh_core::color::rgb(0x71717a))
            })
    };
    view()
        .flex_1()
        .child(
            view()
                .flex_row()
                .child(dot("○", false))
                .child(dot("●", true))
                .child(dot("○", false)),
        )
        .child(
            view()
                .w(px(80.0))
                .h(px(16.0))
                .role(nsh_core::AccessibilityRole::Button)
                .on_press(|_: &()| {})
                .accessibility_state(selected())
                .child(text("Photo 1")),
        )
        .child(text("ready"))
}

#[test]
fn a_chosen_control_its_hue_already_tells_apart_takes_no_select_band() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Dots>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let x = (0..12)
        .find(|&x| buffer[(x, 0)].symbol() == "●")
        .unwrap_or_else(|| {
            let row: String = (0..12).map(|x| buffer[(x, 0)].symbol()).collect();
            panic!("the current dot is drawn: {row:?}")
        });
    let current = &buffer[(x, 0)];
    assert_eq!(current.fg, Color::Green, "in its accent");
    assert_eq!(current.bg, Color::Reset, "no band under the current dot");
    assert!(current.modifier.contains(Modifier::BOLD));
    assert_eq!(
        buffer[(0, 1)].bg,
        Color::Rgb(56, 56, 56),
        "a chosen label of no hue keeps its select band"
    );
}

/// An input group: the app's field box, a prefix, the field and a
/// chevron in one row; and a bare field below it.
#[component]
fn Group() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .h(px(16.0))
                .flex_row()
                .items_center()
                .bg(nsh_core::color::rgb(0x18181b))
                .child(text("$"))
                .child(nsh_base::input().flex_1().h(px(16.0)))
                .child(text("v")),
        )
        .child(nsh_base::input().w(px(80.0)).h(px(16.0)))
        .child(text("ready"))
}

#[test]
fn an_input_group_is_one_field_band_its_prefix_and_chevron_inside_it() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<Group>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let band = buffer[(5, 0)].bg;
    assert_ne!(band, Color::Reset, "the group is a band");
    assert_eq!(buffer[(0, 0)].symbol(), "$");
    let chevron = (0..24).find(|&x| buffer[(x, 0)].symbol() == "v").unwrap();
    for x in 0..=chevron {
        assert_eq!(
            buffer[(x, 0)].bg,
            band,
            "one band, its field no step of its own: {x}"
        );
    }
    assert_eq!(
        buffer[(0, 1)].bg,
        band,
        "a field alone is the same raised band"
    );
}

#[test]
fn a_focused_input_group_is_its_whole_band_brighter_in_the_accent_with_no_line_under_it() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<Group>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let rest = terminal.backend().buffer()[(0, 0)].bg;
    let lone = terminal.backend().buffer()[(0, 1)].bg;
    tab_until(
        &mut view,
        &mut terminal,
        &rx,
        "the group's focus",
        |buffer| buffer[(0, 0)].bg != rest,
    );
    let buffer = terminal.backend().buffer();
    let focus = buffer[(0, 0)].bg;
    let light = |color: Color| match color {
        Color::Rgb(r, g, b) => u16::from(r) + u16::from(g) + u16::from(b),
        other => panic!("an RGB band, not {other:?}"),
    };
    assert!(
        light(focus) > light(rest),
        "brighter: {focus:?} over {rest:?}"
    );
    assert!(
        matches!(focus, Color::Rgb(r, g, b) if b > r + 20 && b > g + 20),
        "in the focus's blue: {focus:?}"
    );
    let chevron = (0..24).find(|&x| buffer[(x, 0)].symbol() == "v").unwrap();
    for x in 0..=chevron {
        let cell = &buffer[(x, 0)];
        assert_eq!(cell.bg, focus, "the whole group: {x}");
        assert!(
            !cell.modifier.contains(Modifier::UNDERLINED),
            "no underline: {x}"
        );
    }
    assert_eq!(buffer[(0, 1)].bg, lone, "the other field stays at rest");
}

/// A filled popup labeled "Menu" over three rows of text, its box 10
/// Cells wide and 2 rows tall; on a raised panel 22 Cells wide with
/// `panel`.
fn popup_page(panel: bool) -> impl IntoElement {
    let anchor = element_ref();
    view().flex_1().child(
        view()
            .w(px(176.0))
            .when(panel, |v| v.bg(nsh_core::color::rgb(0x262626)))
            .child(view().w(px(8.0)).h(px(16.0)).element_ref(&anchor))
            .child(text("behind behind behind"))
            .child(text("behind behind behind"))
            .child(text("behind behind behind"))
            .child(
                overlay()
                    .anchor(&anchor)
                    .placement(nsh_core::overlay::Placement::Bottom)
                    .align(nsh_core::overlay::Align::Start)
                    .child(
                        view()
                            .w(px(80.0))
                            .h(px(32.0))
                            .bg(nsh_core::color::rgb(0x18181b))
                            .label("Menu")
                            .child(text("pop")),
                    ),
            )
            .child(text("ready")),
    )
}

#[component]
fn Raised() -> impl IntoElement {
    popup_page(false)
}

#[component]
fn RaisedOverPanel() -> impl IntoElement {
    popup_page(true)
}

/// Draws `root` on a 24 × 8 terminal until its popup shows: the rows, and
/// the popup's first Cell.
fn popup_on(
    (mut view, rx): (AppView, crossbeam_channel::Receiver<()>),
    root: Root,
) -> (Terminal<TestBackend>, Vec<String>, (u16, u16)) {
    let mut terminal = Terminal::new(TestBackend::new(24, 8)).unwrap();
    view.load(App::Rust(root)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "pop");
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..8)
        .map(|y| (0..24).map(|x| buffer[(x, y)].symbol()).collect())
        .collect();
    let y = row_of(buffer, "pop");
    let row = &rows[usize::from(y)];
    let x = row[..row.find("pop").unwrap()].chars().count() as u16;
    (terminal, rows, (x, y))
}

/// The Cell of the first `symbol` in the buffer.
fn glyph_at(buffer: &Buffer, symbol: &str) -> Option<(u16, u16)> {
    (0..buffer.area.height).find_map(|y| {
        (0..buffer.area.width)
            .find(|&x| buffer[(x, y)].symbol() == symbol)
            .map(|x| (x, y))
    })
}

#[test]
fn a_filled_popup_is_its_frame_alone_over_the_page_s_ground() {
    let (terminal, rows, _) = popup_on(surfaces(), Root::new::<Raised>(|| ()));
    let buffer = terminal.backend().buffer();
    let (left, top) = glyph_at(buffer, "╭").unwrap_or_else(|| panic!("framed: {rows:#?}"));
    let (right, bottom) = glyph_at(buffer, "╯").unwrap_or_else(|| panic!("framed: {rows:#?}"));
    // A box is its line or its fill: the app's fill is left out, the box
    // cleared to the page's ground, its line too, and nothing around it.
    for y in top..=bottom {
        for x in left..=right {
            assert_eq!(buffer[(x, y)].bg, Color::Reset, "({x}, {y}): {rows:#?}");
        }
    }
    if right + 1 < buffer.area.width {
        assert_eq!(buffer[(right + 1, top)].bg, Color::Reset, "{rows:#?}");
    }
    if bottom + 1 < buffer.area.height {
        assert_eq!(buffer[(left, bottom + 1)].bg, Color::Reset, "{rows:#?}");
    }
}

#[test]
fn a_popup_s_frame_over_a_raised_panel_covers_the_panel() {
    let (terminal, rows, _) = popup_on(surfaces(), Root::new::<RaisedOverPanel>(|| ()));
    let buffer = terminal.backend().buffer();
    let (left, top) = glyph_at(buffer, "╭").unwrap_or_else(|| panic!("framed: {rows:#?}"));
    // The panel's step, where the popup leaves it: its last column.
    let panel = buffer[(21, top)].bg;
    assert_ne!(panel, Color::Reset, "the panel is raised: {rows:#?}");
    // The frame is the box's edge: cleared as the box is, nothing of the
    // panel under it showing beside its line.
    let (right, bottom) = glyph_at(buffer, "╯").unwrap_or_else(|| panic!("framed: {rows:#?}"));
    for (x, y) in [(left, top), (right, top), (left, bottom), (right, top + 1)] {
        assert_eq!(buffer[(x, y)].bg, Color::Reset, "({x}, {y}): {rows:#?}");
    }
    assert_eq!(
        buffer[(left + 1, top + 1)].bg,
        Color::Reset,
        "the box is cleared to the page's ground: {rows:#?}"
    );
}

#[test]
fn a_filled_popup_is_framed_the_same_at_every_depth() {
    for depth in [
        ColorDepth::TrueColor,
        ColorDepth::Ansi256,
        ColorDepth::Ansi16,
        ColorDepth::Monochrome,
    ] {
        let (_, rows, _) = popup_on(surfaces_at(depth), Root::new::<Raised>(|| ()));
        assert!(
            rows.iter().any(|row| row.contains('╭')) && rows.iter().any(|row| row.contains('╯')),
            "{depth:?}: framed: {rows:#?}"
        );
    }
}

fn pane(name: &'static str) -> impl IntoElement {
    view()
        .w(px(88.0))
        .border_1()
        .border_color(nsh_core::color::rgb(0x3f3f46))
        .py(px(16.0))
        .child(view().accessibility_state(selected()).child(text(name)))
        .child(view().on_press(|_: &()| {}).child(text("go")))
}

#[component]
fn Panes() -> impl IntoElement {
    view()
        .flex_1()
        .child(view().flex_row().child(pane("selA")).child(pane("selB")))
        .child(text("ready"))
}

#[test]
fn the_pane_holding_the_focus_shows_its_line_and_selection_in_the_accent() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(26, 8)).unwrap();
    view.load(App::Rust(Root::new::<Panes>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let find = |buffer: &Buffer, word: &str| {
        let y = row_of(buffer, word);
        let row: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        (row.find(word).unwrap() as u16, y)
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let (x, y) = find(buffer, "selA");
        if buffer[(x, y)].bg == Color::Blue {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the focused pane's selection"
        );
    }
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..8)
        .map(|y| (0..26).map(|x| buffer[(x, y)].symbol()).collect())
        .collect();
    let (bx, by) = find(buffer, "selB");
    assert_eq!(
        buffer[(bx, by)].bg,
        Color::Rgb(56, 56, 56),
        "elsewhere gray: {rows:#?}"
    );
    let top = rows.iter().position(|r| r.contains('┌')).unwrap() as u16;
    assert_eq!(
        buffer[(0, top)].fg,
        Color::Blue,
        "the focused pane's line: {rows:#?}"
    );
    let second = rows[usize::from(top)].rfind('┌').unwrap();
    let second = rows[usize::from(top)][..second].chars().count() as u16;
    assert_eq!(
        buffer[(second, top)].fg,
        Color::Rgb(68, 68, 68),
        "{rows:#?}"
    );
}

#[component]
fn Swatches() -> impl IntoElement {
    let swatch = |color: u32| {
        view()
            .w(px(16.0))
            .h(px(16.0))
            .role(AccessibilityRole::Image)
            .bg(nsh_core::color::rgb(color))
    };
    view()
        .flex_1()
        .child(
            view()
                .flex_row()
                .child(swatch(0xff0000))
                .child(swatch(0x3b82f6))
                .child(swatch(0x27272a)),
        )
        .child(
            view()
                .flex_row()
                .child(swatch(0x1e3a8a).child(text("dk")))
                .child(swatch(0xfde047).child(text("lt"))),
        )
        .child(text("ready"))
}

/// A surface with the test ramp's background and foreground that shows
/// `depth`.
fn surfaces_at(depth: ColorDepth) -> (AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.capabilities.colors = depth;
    options.capabilities.background_color = Some([24; 3]);
    options.capabilities.foreground_color = Some([224; 3]);
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    (AppView::new(options), rx)
}

fn draw_swatches(view: &mut AppView, rx: &crossbeam_channel::Receiver<()>) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(20, 4)).unwrap();
    view.load(App::Rust(Root::new::<Swatches>(|| ()))).unwrap();
    draw_until(view, &mut terminal, rx, "ready");
    terminal.backend().buffer().clone()
}

#[test]
fn a_swatch_is_its_own_color_with_text_in_black_or_white() {
    let (mut view, rx) = surfaces();
    let buffer = draw_swatches(&mut view, &rx);
    let bgs: Vec<Color> = (0..6).map(|x| buffer[(x, 0)].bg).collect();
    assert_eq!(
        bgs,
        [
            Color::Rgb(255, 0, 0),
            Color::Rgb(255, 0, 0),
            Color::Rgb(59, 130, 246),
            Color::Rgb(59, 130, 246),
            Color::Rgb(39, 39, 42),
            Color::Rgb(39, 39, 42),
        ],
        "each Cell is the app's color itself, not a ramp step or a tint"
    );
    let dark = row_of(&buffer, "dk");
    assert_eq!(
        buffer[(0, dark)].fg,
        Color::Rgb(255, 255, 255),
        "white on a dark swatch"
    );
    assert_eq!(
        buffer[(2, dark)].fg,
        Color::Rgb(0, 0, 0),
        "black on a light one"
    );

    let (mut view, rx) = surfaces_at(ColorDepth::Ansi256);
    let buffer = draw_swatches(&mut view, &rx);
    assert_eq!(
        buffer[(0, 0)].bg,
        Color::Indexed(196),
        "the nearest of 256 colors"
    );

    let (mut view, rx) = surface_with(ColorScheme::Dark, ColorDepth::TrueColor);
    let buffer = draw_swatches(&mut view, &rx);
    assert_eq!(
        buffer[(0, 0)].bg,
        Color::Rgb(255, 0, 0),
        "without surfaces a swatch is still its own color"
    );
}

#[component]
fn Ramp() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .h(px(16.0))
                .bg_linear_to_r()
                .gradient_from(nsh_core::color::rgb(0x000000))
                .gradient_to(nsh_core::color::rgb(0xffffff)),
        )
        .child(
            view()
                .w(px(160.0))
                .h(px(16.0))
                .bg(nsh_core::color::rgb(0x27272a))
                .bg_linear_to_r()
                .gradient_from(nsh_core::color::rgb(0x000000))
                .gradient_to(nsh_core::color::rgb(0xffffff))
                .child(text("finish")),
        )
        .child(text("ready"))
}

#[test]
fn a_gradient_fills_each_cell_with_its_color_there() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<Ramp>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let Color::Rgb(left, ..) = buffer[(0, 0)].bg else {
        panic!("the left Cell is filled: {:?}", buffer[(0, 0)].bg);
    };
    let Color::Rgb(right, ..) = buffer[(19, 0)].bg else {
        panic!("the right Cell is filled: {:?}", buffer[(19, 0)].bg);
    };
    assert!(left < 20 && right > 235, "black to white: {left}, {right}");
    assert_eq!(buffer[(20, 0)].bg, Color::Reset, "past the box");
    let finish = row_of(buffer, "finish");
    assert_eq!(
        buffer[(0, finish)].bg,
        Color::Rgb(38, 38, 38),
        "a gradient over a fill is its finish: the fill's step"
    );
    assert_eq!(buffer[(19, finish)].bg, buffer[(0, finish)].bg);

    let (mut view, rx) = surfaces_at(ColorDepth::Ansi256);
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<Ramp>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert!(matches!(buffer[(0, 0)].bg, Color::Indexed(_)));
    assert_ne!(
        buffer[(0, 0)].bg,
        buffer[(19, 0)].bg,
        "a ramp in 256 colors"
    );
}

#[component]
fn Fill() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view().w(px(160.0)).h(px(16.0)).child(
                view()
                    .w(px(160.0))
                    .h(px(16.0))
                    .bg(nsh_core::color::rgb(0x3b82f6))
                    .origin_left()
                    .scale_x(0.5),
            ),
        )
        .child(text("ready"))
}

#[test]
fn a_scaled_fill_takes_the_cells_of_its_scaled_box() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<Fill>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert_ne!(buffer[(0, 0)].bg, Color::Reset, "the fill from the left");
    assert_ne!(buffer[(9, 0)].bg, Color::Reset, "half of it");
    assert_eq!(
        buffer[(10, 0)].bg,
        Color::Reset,
        "the other half is not filled"
    );
}

/// A cell framed on every side, filled a step above the page, its border
/// close to its fill: one-time code cells drawn as tiles.
#[component]
fn FramedCell() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(40.0))
                .h(px(48.0))
                .border_1()
                .border_color(nsh_core::color::rgb(0x2e2e2e))
                .rounded(px(6.0))
                .bg(nsh_core::color::rgb(0x262626))
                .child(text("7")),
        )
        .child(text("ready"))
}

/// A face is a line or a fill, never both: a filled cell with a border is
/// its band, without a frame drawn around it.
#[test]
fn a_filled_framed_cell_is_its_band_without_a_frame() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(12, 6)).unwrap();
    view.load(App::Rust(Root::new::<FramedCell>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..6)
        .map(|y| (0..12).map(|x| buffer[(x, y)].symbol()).collect())
        .collect();
    assert!(
        !rows
            .iter()
            .any(|row| row.contains(['╭', '╮', '╰', '╯', '│', '─'])),
        "{rows:#?}"
    );
    let seven = (0..6u16)
        .find_map(|y| {
            (0..12u16)
                .find(|&x| buffer[(x, y)].symbol() == "7")
                .map(|x| (x, y))
        })
        .expect("the digit");
    assert_ne!(
        buffer[seven].bg,
        ratatui_core::style::Color::Reset,
        "the digit on its band: {rows:#?}"
    );
}

/// A command in a framed card: its inline list highlights an item for the
/// keys typed in its search field.
#[component]
fn CardCommand() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .border_1()
                .border_color(nsh_core::color::rgb(0x3f3f46))
                .py(px(16.0))
                .child(
                    nsh_base::command()
                        .items(vec![
                            nsh_base::CommandItem::new("a", "Alpha"),
                            nsh_base::CommandItem::new("b", "Beta"),
                        ])
                        .placeholder("Find")
                        .accessibility_label("Commands"),
                ),
        )
        .child(text("ready"))
}

#[test]
fn a_command_s_highlighted_item_in_the_focused_pane_is_a_full_row_accent_band() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<CardCommand>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let at = |buffer: &Buffer, word: &str| {
        let y = row_of(buffer, word);
        let row: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        (row[..row.find(word).unwrap()].chars().count() as u16, y)
    };
    {
        let buffer = terminal.backend().buffer();
        let (x, y) = at(buffer, "Alpha");
        assert_ne!(
            buffer[(x, y)].bg,
            Color::Blue,
            "no band before the focus comes"
        );
    }
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let (x, y) = at(buffer, "Alpha");
        if buffer[(x, y)].bg == Color::Blue {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the highlighted item's band"
        );
    }
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..10)
        .map(|y| (0..40).map(|x| buffer[(x, y)].symbol()).collect())
        .collect();
    let (_, y) = at(buffer, "Alpha");
    // The band runs to the frame's line and stops there: no Cell of it on
    // the line.
    let line = rows[usize::from(y)].rfind('│').unwrap();
    let line = rows[usize::from(y)][..line].chars().count() as u16;
    assert_eq!(
        buffer[(line - 1, y)].bg,
        Color::Blue,
        "to the frame: {rows:#?}"
    );
    assert_ne!(
        buffer[(line, y)].bg,
        Color::Blue,
        "not on the frame: {rows:#?}"
    );
    let (bx, by) = at(buffer, "Beta");
    assert_ne!(buffer[(bx, by)].bg, Color::Blue, "one band: {rows:#?}");
}

/// An avatar's presence dot: a round 10pt box of a green fill pinned to
/// its corner, over a raised chip.
#[component]
fn Presence() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view().flex_row().child(
                view()
                    .w(px(32.0))
                    .h(px(32.0))
                    .rounded(px(16.0))
                    .items_center()
                    .justify_center()
                    .bg(nsh_core::color::rgb(0x333333))
                    .child(text("MC"))
                    .child(
                        view()
                            .absolute()
                            .right(px(-1.0))
                            .bottom(px(-1.0))
                            .w(px(10.0))
                            .h(px(10.0))
                            .rounded(px(5.0))
                            .bg(nsh_core::color::rgb(0x22c55e)),
                    ),
            ),
        )
        .child(text("ready"))
}

#[test]
fn a_dot_is_a_disc_in_its_color_over_what_is_under_it() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Presence>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..4)
        .map(|y| (0..12).map(|x| buffer[(x, y)].symbol()).collect())
        .collect();
    let (x, y) = (0..4)
        .flat_map(|y| (0..12).map(move |x| (x, y)))
        .find(|&(x, y)| buffer[(x, y)].symbol() == "●")
        .unwrap_or_else(|| panic!("no dot: {rows:#?}"));
    let cell = &buffer[(x, y)];
    assert_eq!(cell.fg, Color::Green, "in its color: {rows:#?}");
    let chip = buffer[(0, row_of(buffer, "MC"))].bg;
    assert_eq!(cell.bg, chip, "on the chip's band, not one of its own");
}

/// A toggle's dot that is off, gray, before its label in a row.
#[component]
fn GrayKey() -> impl IntoElement {
    view().flex_1().child(
        view()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(
                view()
                    .w(px(6.0))
                    .h(px(6.0))
                    .rounded(px(3.0))
                    .bg(nsh_core::color::rgb(0x9ca3af)),
            )
            .child(text("Lock")),
    )
}

#[test]
fn a_gray_dot_before_its_label_is_a_disc_not_a_band_cell() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(12, 3)).unwrap();
    view.load(App::Rust(Root::new::<GrayKey>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Lock");
    let buffer = terminal.backend().buffer();
    let row: String = (0..12).map(|x| buffer[(x, 0)].symbol()).collect();
    let x = (0..12)
        .find(|&x| buffer[(x, 0)].symbol() == "●")
        .unwrap_or_else(|| panic!("no dot: {row:?}"));
    assert_eq!(
        buffer[(x, 0)].bg,
        buffer[(x + 2, 0)].bg,
        "on what is under it, no band of its own: {row:?}"
    );
    assert_ne!(buffer[(x, 0)].fg, Color::Reset, "in its gray: {row:?}");
}

/// A four-digit code in two groups of framed cells (a line, no fill),
/// three Cells inside and a row high inside, a Cell apart within a group
/// and three between the groups, reporting its focus; and a disabled one
/// under it (`disabled`).
fn code_pair(disabled: bool) -> impl IntoElement {
    let focused = signal("no");
    let code = |disabled: bool| {
        nsh_base::otp_input()
            .length(4u32)
            .groups(2u32)
            .disabled(disabled)
            .app_class("flex-row gap-2")
            .group_class("flex-row gap-2 mx-2")
            .cell_class("w-10 h-12 border border-zinc-700 items-center justify-center")
    };
    view()
        .flex_1()
        .child(text(move || format!("focus {}", focused.get())))
        .child(
            view()
                .flex_row()
                .p(px(8.0))
                .child(code(false).on_focus(move || focused.set("yes"))),
        )
        .when(disabled, |v| {
            v.child(view().flex_row().p(px(8.0)).child(code(true)))
        })
}

#[component]
fn FramedCode() -> impl IntoElement {
    code_pair(false)
}

#[component]
fn FramedCodes() -> impl IntoElement {
    code_pair(true)
}

/// The Cells of the empty cells' slots (`·`), top to bottom, left to right.
fn slots(buffer: &Buffer) -> Vec<(u16, u16)> {
    (0..buffer.area.height)
        .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
        .filter(|&at| buffer[at].symbol() == "·")
        .collect()
}

#[test]
fn a_codes_cells_are_framed_boxes_with_the_digit_in_the_middle() {
    use ratatui_core::backend::Backend;
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<FramedCode>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus no");
    draw_until(&mut view, &mut terminal, &rx, "·");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let dump = super::dock::dump(&terminal);
    // The empty cells' slots: one row, each in the middle of its box,
    // six Cells from the next in a group (five of the box, one apart) and
    // eight across the groups (three apart).
    let buffer = terminal.backend().buffer();
    let page = buffer[(0, 0)].bg;
    let at = slots(buffer);
    assert_eq!(at.len(), 4, "{dump}");
    let y = at[0].1;
    assert!(at.iter().all(|&(_, sy)| sy == y), "one row: {at:?}\n{dump}");
    let steps: Vec<u16> = at.windows(2).map(|p| p[1].0 - p[0].0).collect();
    assert_eq!(
        steps,
        [6, 8, 6],
        "a Cell apart, three across the groups\n{dump}"
    );
    for &(x, y) in &at {
        let glyph = |dx: i32, dy: i32| {
            buffer[((x as i32 + dx) as u16, (y as i32 + dy) as u16)]
                .symbol()
                .to_owned()
        };
        let frame = [
            [
                glyph(-2, -1),
                glyph(-1, -1),
                glyph(0, -1),
                glyph(1, -1),
                glyph(2, -1),
            ],
            [
                glyph(-2, 0),
                glyph(-1, 0),
                glyph(0, 0),
                glyph(1, 0),
                glyph(2, 0),
            ],
            [
                glyph(-2, 1),
                glyph(-1, 1),
                glyph(0, 1),
                glyph(1, 1),
                glyph(2, 1),
            ],
        ]
        .map(|row| row.concat());
        assert_eq!(frame, ["┌───┐", "│ · │", "└───┘"], "a framed box\n{dump}");
        for dx in [-1i32, 0, 1] {
            assert_eq!(
                buffer[((x as i32 + dx) as u16, y)].bg,
                page,
                "its line only, no fill\n{dump}"
            );
        }
    }
    // Focused, the cursor is in the middle of the next cell; a digit typed
    // lands there, and the cursor moves on to the next slot.
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "focus yes");
    let cursor = terminal.backend_mut().get_cursor_position().unwrap();
    assert_eq!((cursor.x, cursor.y), at[0], "the cursor on the slot");
    view.handle(nsh_platform_tui::Input::Key {
        key: "4".into(),
        modifiers: Default::default(),
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "4");
    let buffer = terminal.backend().buffer();
    assert_eq!(
        buffer[at[0]].symbol(),
        "4",
        "{}",
        super::dock::dump(&terminal)
    );
    assert_eq!(buffer[(at[0].0 - 1, y)].symbol(), " ");
    assert_eq!(buffer[(at[0].0 + 1, y)].symbol(), " ");
    let cursor = terminal.backend_mut().get_cursor_position().unwrap();
    assert_eq!((cursor.x, cursor.y), at[1], "on the next slot");
}

#[test]
fn a_codes_next_cell_shows_focus_with_its_frame_in_the_accent() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<FramedCode>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "·");
    let corners = |buffer: &Buffer| -> Vec<(u16, u16)> {
        (0..buffer.area.height)
            .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
            .filter(|&(x, y)| buffer[(x, y)].symbol() == "┌")
            .collect()
    };
    let rest = terminal.backend().buffer()[corners(terminal.backend().buffer())[0]].fg;
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "focus yes");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let dump = super::dock::dump(&terminal);
    let buffer = terminal.backend().buffer();
    let at = corners(buffer);
    assert_eq!(at.len(), 4, "every cell keeps its frame\n{dump}");
    let (x, y) = at[0];
    // The whole frame of the next cell, its four sides, in the accent.
    for cell in [
        (x, y),
        (x + 2, y),
        (x + 4, y),
        (x, y + 1),
        (x + 4, y + 1),
        (x + 2, y + 2),
    ] {
        assert_eq!(
            buffer[cell].fg,
            Color::Blue,
            "the next cell's line in the accent\n{dump}"
        );
    }
    for &other in &at[1..] {
        assert_eq!(
            buffer[other].fg, rest,
            "the others' lines as at rest\n{dump}"
        );
    }
    for dx in 1..4 {
        assert_ne!(
            buffer[(x + dx, y + 1)].bg,
            Color::Blue,
            "nothing filled in the accent\n{dump}"
        );
    }
}

#[test]
fn a_disabled_codes_frames_and_slots_are_dimmer_than_at_rest() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<FramedCodes>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "·");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let dump = super::dock::dump(&terminal);
    let buffer = terminal.backend().buffer();
    let at = slots(buffer);
    assert_eq!(at.len(), 8, "two codes of four\n{dump}");
    let (on, off) = (at[0], at[4]);
    assert!(off.1 > on.1, "the disabled code under the other\n{dump}");
    let light = |c: Color| match c {
        Color::Rgb(r, g, b) => u32::from(r) + u32::from(g) + u32::from(b),
        other => panic!("a color of the ramp: {other:?}\n{dump}"),
    };
    for (what, dy) in [("line", -1i32), ("slot", 0)] {
        let cell = |(x, y): (u16, u16)| {
            let at = if dy == 0 {
                (x, y)
            } else {
                (x - 2, (y as i32 + dy) as u16)
            };
            buffer[at].fg
        };
        assert_ne!(cell(off), cell(on), "the disabled {what} dims\n{dump}");
        assert!(
            light(cell(off)) <= light(cell(on)),
            "the disabled {what} no brighter than at rest\n{dump}"
        );
    }
}

#[test]
fn a_codes_hidden_field_draws_none_of_what_is_typed() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<FramedCode>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus no");
    let key = |key: &str| nsh_platform_tui::Input::Key {
        key: key.into(),
        modifiers: Default::default(),
        release: false,
    };
    view.handle(key("Tab"));
    draw_until(&mut view, &mut terminal, &rx, "focus yes");
    for digit in ["4", "7"] {
        view.handle(key(digit));
    }
    draw_until(&mut view, &mut terminal, &rx, "7");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    // Each digit once, in its cell: the field under the next cell, which
    // holds the code too, shows none of it (not even as hidden Cells).
    let buffer = terminal.backend().buffer();
    for digit in ["4", "7"] {
        let at: Vec<(u16, u16)> = (0..buffer.area.height)
            .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
            .filter(|&at| buffer[at].symbol() == digit)
            .collect();
        assert_eq!(
            at.len(),
            1,
            "{digit} once, in its cell: {at:?}\n{}",
            super::dock::dump(&terminal)
        );
    }
    let hidden = (0..buffer.area.height)
        .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
        .filter(|&at| {
            buffer[at]
                .modifier
                .contains(ratatui_core::style::Modifier::HIDDEN)
                && buffer[at].symbol() != " "
        })
        .count();
    assert_eq!(
        hidden,
        0,
        "no hidden glyphs\n{}",
        super::dock::dump(&terminal)
    );
}

/// A pane whose selected row holds a shortcut's key chip, a fill of its own.
#[component]
fn ChipRow() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .border_1()
                .border_color(nsh_core::color::rgb(0x3f3f46))
                .py(px(16.0))
                .child(
                    view()
                        .flex_row()
                        .justify_between()
                        .accessibility_state(selected())
                        .child(text("Inbox"))
                        .child(
                            view()
                                .px(px(4.0))
                                .bg(nsh_core::color::rgb(0x333333))
                                .child(text("K1")),
                        ),
                )
                .child(view().on_press(|_: &()| {}).child(text("go"))),
        )
        .child(text("ready"))
}

#[test]
fn an_accent_band_spans_its_whole_row_over_a_child_s_fill() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(30, 8)).unwrap();
    view.load(App::Rust(Root::new::<ChipRow>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let y = row_of(buffer, "Inbox");
        let row: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        let x = row[..row.find("Inbox").unwrap()].chars().count() as u16;
        if buffer[(x, y)].bg == Color::Blue {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the selected row's band"
        );
    }
    let buffer = terminal.backend().buffer();
    let y = row_of(buffer, "Inbox");
    let row: Vec<&str> = (0..buffer.area.width)
        .map(|x| buffer[(x, y)].symbol())
        .collect();
    let left = row.iter().position(|&s| s == "│").unwrap() as u16;
    let right = row.iter().rposition(|&s| s == "│").unwrap() as u16;
    for x in left + 1..right {
        assert_eq!(
            buffer[(x, y)].bg,
            Color::Blue,
            "column {x} of the row on the band: {row:?}"
        );
    }
}

/// A selected row's olive fill as light as the muted gray, a muted size on
/// it, and the same size on the page.
#[component]
fn FadedOnBand() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .bg(nsh_core::color::rgb(0x565f44))
                .child(text("3.8 KB").text_color(nsh_core::color::rgb(0x71717a))),
        )
        .child(text("1.4 KB").text_color(nsh_core::color::rgb(0x71717a)))
        .child(text("ready"))
}

#[test]
fn a_fade_as_light_as_its_band_reads_at_full_strength() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(16, 4)).unwrap();
    view.load(App::Rust(Root::new::<FadedOnBand>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let band = row_of(buffer, "3.8");
    let page = row_of(buffer, "1.4");
    assert_ne!(buffer[(0, band)].bg, Color::Reset, "the row's band");
    assert_eq!(
        buffer[(0, band)].fg,
        Color::Reset,
        "full strength on the band"
    );
    assert_ne!(buffer[(0, page)].fg, Color::Reset, "muted on the page");
}

/// A selected row's translucent tint (the app's accent at a quarter), a
/// faint size on it, and the same size on the page.
#[component]
fn FadedOnTint() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .bg(nsh_core::color::rgba(0xc8f26d40))
                .child(text("3.8 KB").text_color(nsh_core::color::rgb(0x52525b))),
        )
        .child(text("1.4 KB").text_color(nsh_core::color::rgb(0x52525b)))
        .child(text("ready"))
}

/// CIE L* of a Cell's color, the terminal's own colors for `Reset`.
fn cell_lightness(color: Color, reset: u8) -> f32 {
    let [r, g, b] = match color {
        Color::Rgb(r, g, b) => [r, g, b],
        _ => [reset; 3],
    };
    let linear = |c: u8| {
        let c = f32::from(c) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    if y > 216.0 / 24389.0 {
        116.0 * y.cbrt() - 16.0
    } else {
        y * 24389.0 / 27.0
    }
}

#[test]
fn a_fade_on_a_translucent_tint_reads_against_the_band_drawn_there() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(16, 4)).unwrap();
    view.load(App::Rust(Root::new::<FadedOnTint>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let band = row_of(buffer, "3.8");
    let cell = &buffer[(0, band)];
    assert_ne!(cell.bg, Color::Reset, "the row's tint");
    let apart = (cell_lightness(cell.fg, 224) - cell_lightness(cell.bg, 24)).abs();
    assert!(
        apart >= 15.0,
        "the size reads on its tint: {cell:?}, {apart}"
    );
}

/// A sidebar with only its right line: its first row, the box's top,
/// holds a selected toggle button (the gallery's "Sidebar").
#[component]
fn SidebarToggle() -> impl IntoElement {
    view()
        .flex_1()
        .flex_row()
        .child(
            view()
                .w(px(120.0))
                .border_r_1()
                .border_color(nsh_core::color::rgb(0x3f3f46))
                .child(
                    view()
                        .on_press(|_: &()| {})
                        .accessibility_state(selected())
                        .child(text("Sidebar")),
                )
                .child(text("Inbox")),
        )
        .child(text("ready"))
}

#[test]
fn a_selected_button_on_the_accent_band_reads_in_the_band_s_contrast() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(30, 6)).unwrap();
    view.load(App::Rust(Root::new::<SidebarToggle>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let at = |buffer: &Buffer| {
        let y = row_of(buffer, "Sidebar");
        let row: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        (
            row[..row.find("Sidebar").unwrap()].chars().count() as u16,
            y,
        )
    };
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        if buffer[at(buffer)].bg == Color::Blue {
            break;
        }
        assert!(rx.recv_deadline(deadline).is_ok(), "the button's band");
    }
    let buffer = terminal.backend().buffer();
    let (x, y) = at(buffer);
    for x in x..x + 7 {
        assert_eq!(buffer[(x, y)].bg, Color::Blue);
        assert_ne!(
            buffer[(x, y)].fg,
            Color::Blue,
            "column {x}: the label reads on its band"
        );
    }
}

/// Tabs once and draws until `shown` holds of the buffer.
fn tab_until(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    what: &str,
    shown: impl Fn(&Buffer) -> bool,
) {
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if shown(terminal.backend().buffer()) {
            return;
        }
        assert!(rx.recv_deadline(deadline).is_ok(), "{what}");
    }
}

/// The Cell where `word` starts.
fn cell_of(buffer: &Buffer, word: &str) -> (u16, u16) {
    let y = row_of(buffer, word);
    let row: String = (0..buffer.area.width)
        .map(|x| buffer[(x, y)].symbol())
        .collect();
    (row[..row.find(word).unwrap()].chars().count() as u16, y)
}

/// A pressable whose only child is a chip of its own fill (the list
/// demo's "Jump to 60"), and a swatch: a pressable holding nothing but a
/// color.
#[component]
fn CoveredControls() -> impl IntoElement {
    view()
        .flex_1()
        .bg(nsh_core::color::rgb(0x222222))
        .child(
            view().on_press(|_: &()| {}).child(
                view()
                    .flex_row()
                    .px(px(8.0))
                    .bg(nsh_core::color::rgb(0x3a3a3a))
                    .child(text("Jump")),
            ),
        )
        .child(
            view().flex_row().child(text("color ")).child(
                view().on_press(|_: &()| {}).child(
                    view()
                        .w(px(32.0))
                        .h(px(16.0))
                        .role(AccessibilityRole::Image)
                        .bg(nsh_core::color::rgb(0x22c55e)),
                ),
            ),
        )
        .child(text("ready"))
}

/// A control all of whose Cells are its children's fills shows focus on
/// them: a chip with a label takes the focus band, a swatch (a color, no
/// glyph) a `◆` in its middle in the color that reads on it. Neither is
/// underlined.
#[test]
fn a_control_covered_by_its_children_s_fills_shows_focus_on_them() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
    view.load(App::Rust(Root::new::<CoveredControls>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let chip = {
        let buffer = terminal.backend().buffer();
        buffer[cell_of(buffer, "Jump")].bg
    };
    tab_until(
        &mut view,
        &mut terminal,
        &rx,
        "the chip's focus",
        |buffer| buffer[cell_of(buffer, "Jump")].bg != chip,
    );
    let buffer = terminal.backend().buffer();
    let (x, y) = cell_of(buffer, "Jump");
    let band = buffer[(x, y)].bg;
    assert_ne!(band, Color::Reset, "the chip's focus band");
    for x in x..x + 4 {
        assert_eq!(buffer[(x, y)].bg, band, "one band under the label");
        assert!(!buffer[(x, y)].modifier.contains(Modifier::UNDERLINED));
    }
    // The swatch: a color and no glyph, its focus a mark in its middle.
    let swatch = |buffer: &Buffer| {
        let (x, y) = cell_of(buffer, "color ");
        (x + 6, y)
    };
    let color = buffer[swatch(buffer)].bg;
    let middle = |buffer: &Buffer| {
        let (x, y) = swatch(buffer);
        (x + 1, y)
    };
    assert_eq!(buffer[middle(buffer)].symbol(), " ");
    tab_until(
        &mut view,
        &mut terminal,
        &rx,
        "the swatch's focus",
        |buffer| buffer[middle(buffer)].symbol() == "◆",
    );
    let buffer = terminal.backend().buffer();
    let mark = &buffer[middle(buffer)];
    // Not the accent, which a blue swatch would hide: the color that
    // reads on the green, as a chosen swatch's check.
    assert_eq!(mark.fg, Color::Rgb(0, 0, 0));
    assert!(mark.modifier.contains(Modifier::BOLD));
    let (x, y) = swatch(buffer);
    for x in x..x + 4 {
        assert_eq!(buffer[(x, y)].bg, color, "the swatch keeps its color");
        assert!(!buffer[(x, y)].modifier.contains(Modifier::UNDERLINED));
    }
    assert_eq!(
        buffer[cell_of(buffer, "Jump")].bg,
        chip,
        "the chip's focus left with it"
    );
}

/// A framed box of swatches: the chosen one (selected) first.
#[component]
fn ChosenSwatch() -> impl IntoElement {
    let swatch = |color: u32| {
        view().on_press(|_: &()| {}).child(
            view()
                .w(px(24.0))
                .h(px(16.0))
                .role(AccessibilityRole::Image)
                .bg(nsh_core::color::rgb(color)),
        )
    };
    view()
        .flex_1()
        .child(
            view()
                .border_1()
                .border_color(nsh_core::color::rgb(0x3f3f46))
                .flex_row()
                .child(text("color "))
                .child(swatch(0x3b82f6).accessibility_state(selected()))
                .child(text(" "))
                .child(swatch(0x22c55e)),
        )
        .child(text("ready"))
}

#[test]
fn a_selected_swatch_in_the_focused_pane_keeps_its_color() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 6)).unwrap();
    view.load(App::Rust(Root::new::<ChosenSwatch>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let chosen = |buffer: &Buffer| {
        let (x, y) = cell_of(buffer, "color ");
        (x + 6, y)
    };
    let color = terminal.backend().buffer()[chosen(terminal.backend().buffer())].bg;
    assert_ne!(color, Color::Blue, "its own color, not the accent");
    {
        // Unfocused, the chosen swatch shows a check in its middle, in a
        // color that reads on it; the other has none.
        let buffer = terminal.backend().buffer();
        let (x, y) = chosen(buffer);
        let check = &buffer[(x + 1, y)];
        assert_eq!(check.symbol(), "✓", "the chosen swatch's check");
        assert_eq!(check.bg, color);
        assert_ne!(check.fg, color);
        let row: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        assert_eq!(row.matches('✓').count(), 1, "only the chosen one: {row}");
    }
    tab_until(
        &mut view,
        &mut terminal,
        &rx,
        "the chosen swatch's focus",
        |buffer| {
            buffer[chosen(buffer)]
                .modifier
                .contains(Modifier::UNDERLINED)
        },
    );
    let buffer = terminal.backend().buffer();
    let (x, y) = chosen(buffer);
    let check = buffer[(x + 1, y)].fg;
    for x in x..x + 3 {
        assert_eq!(
            buffer[(x, y)].bg,
            color,
            "the chosen swatch keeps its color in the focused pane"
        );
        // The accent's own blue: the underline is the color that reads
        // on it, the check's.
        assert_eq!(buffer[(x, y)].underline_color, check);
        assert_ne!(buffer[(x, y)].underline_color, color);
    }
}

/// A framed bar of toggles, the first on (a toolbar's Bold).
#[component]
fn ToggleBar() -> impl IntoElement {
    let toggle = |label: &'static str, on: bool| {
        view()
            .on_press(|_: &()| {})
            .accessibility_state(nsh_core::AccessibilityState {
                pressed: on.then_some(nsh_core::Checked::True),
                ..Default::default()
            })
            .child(text(label))
    };
    view()
        .flex_1()
        .child(
            view()
                .border_1()
                .border_color(nsh_core::color::rgb(0x3f3f46))
                .flex_row()
                .gap(px(8.0))
                .child(toggle("Bold", true))
                .child(toggle("Italic", false)),
        )
        .child(text("ready"))
}

#[test]
fn a_toggle_that_is_on_is_bold_on_a_gray_band_and_the_focus_is_the_accent() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(24, 6)).unwrap();
    view.load(App::Rust(Root::new::<ToggleBar>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let at = |buffer: &Buffer, word: &str| buffer[cell_of(buffer, word)].clone();
    let gray = at(terminal.backend().buffer(), "Bold").bg;
    tab_until(&mut view, &mut terminal, &rx, "Bold's focus", |buffer| {
        at(buffer, "Bold").bg == Color::Blue
    });
    let bold = at(terminal.backend().buffer(), "Bold");
    assert!(bold.modifier.contains(Modifier::BOLD), "on, and focused");
    // The focus moves on: the toggle that is on keeps its gray band and
    // bold in the focused pane, never the accent; the focused one, off,
    // takes the accent without bold.
    tab_until(&mut view, &mut terminal, &rx, "Italic's focus", |buffer| {
        at(buffer, "Italic").bg == Color::Blue
    });
    let buffer = terminal.backend().buffer();
    let bold = at(buffer, "Bold");
    assert_ne!(bold.bg, Color::Blue, "on is not the accent");
    assert_eq!(bold.bg, gray, "on keeps its gray band");
    assert!(bold.modifier.contains(Modifier::BOLD));
    assert!(!at(buffer, "Italic").modifier.contains(Modifier::BOLD));
}

/// A color area's grid: an adjustable view whose picked Cell is `◆` on a
/// color.
#[component]
fn AreaMark() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .focusable(true)
                .accessible(true)
                .role(AccessibilityRole::Adjustable)
                .flex_row()
                .child(
                    view()
                        .w(px(8.0))
                        .role(AccessibilityRole::Image)
                        .bg(nsh_core::color::rgb(0x3b82f6))
                        .child(text(" ")),
                )
                .child(
                    view()
                        .w(px(8.0))
                        .role(AccessibilityRole::Image)
                        .bg(nsh_core::color::rgb(0x2563eb))
                        .child(text("◆")),
                ),
        )
        .child(text("ready"))
}

/// The picked Cell of a focused color area stands on the accent, bold:
/// the focus's one look, not a reversed mark.
#[test]
fn a_color_area_s_picked_cell_stands_on_the_accent_while_it_has_the_focus() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<AreaMark>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let mark = |buffer: &Buffer| buffer[cell_of(buffer, "◆")].clone();
    assert_ne!(mark(terminal.backend().buffer()).bg, Color::Blue);
    tab_until(
        &mut view,
        &mut terminal,
        &rx,
        "the picked Cell's focus",
        |buffer| mark(buffer).bg == Color::Blue,
    );
    let cell = mark(terminal.backend().buffer());
    assert!(cell.modifier.contains(Modifier::BOLD));
    assert!(!cell.modifier.contains(Modifier::REVERSED));
    assert_ne!(cell.fg, Color::Blue, "the mark reads on the accent");
}

/// A palette row of pale tints (Tailwind's `red-100` and `sky-100`, leaf
/// boxes), and a card of the same pale red holding text.
#[component]
fn PaleTints() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .flex_row()
                .child(
                    view()
                        .w(px(32.0))
                        .h(px(16.0))
                        .bg(nsh_core::color::rgb(0xfee2e2)),
                )
                .child(
                    view()
                        .w(px(32.0))
                        .h(px(16.0))
                        .bg(nsh_core::color::rgb(0xe0f2fe)),
                ),
        )
        .child(
            view()
                .bg(nsh_core::color::rgb(0xfee2e2))
                .child(text("card")),
        )
        .child(text("ready"))
}

#[test]
fn a_pale_leaf_box_keeps_its_hue_and_a_pale_card_is_a_step() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(16, 6)).unwrap();
    view.load(App::Rust(Root::new::<PaleTints>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert_eq!(
        buffer[(0, 0)].bg,
        Color::Rgb(0xfe, 0xe2, 0xe2),
        "red-100 is its own color"
    );
    assert_eq!(
        buffer[(4, 0)].bg,
        Color::Rgb(0xe0, 0xf2, 0xfe),
        "sky-100 is its own color"
    );
    let card = buffer[(0, row_of(buffer, "card"))].bg;
    let Color::Rgb(r, g, b) = card else {
        panic!("the card is a step of the ramp: {card:?}");
    };
    assert!(
        r == g && g == b,
        "a card holding text is a gray step: {card:?}"
    );
}

/// A carousel's thumbnails: pressables three rows tall (containers),
/// the first one the selected photo.
#[component]
fn Thumbnails() -> impl IntoElement {
    let thumb = |label: &'static str, chosen: bool| {
        // A carousel's thumbnail: its picture keeps it three rows tall (a
        // box of text alone would be a one-row control), its label drawn
        // over the picture.
        let mut thumb = view()
            .w(px(64.0))
            .h(px(48.0))
            .label(label)
            .on_press(|_: &()| {})
            .child(image("missing.png").flex_1());
        if chosen {
            thumb = thumb.accessibility_state(selected());
        }
        thumb
    };
    view()
        .flex_1()
        .bg(nsh_core::color::rgb(0x222222))
        .child(
            view()
                .flex_row()
                .child(thumb("One", true))
                .child(thumb("Two", false)),
        )
        .child(text("ready"))
}

#[test]
fn a_selected_container_shows_focus_with_its_label_underlined() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
    view.load(App::Rust(Root::new::<Thumbnails>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let underlined = |buffer: &Buffer, word: &str| {
        let (x, y) = cell_of(buffer, word);
        (x..x + 3).all(|x| buffer[(x, y)].modifier.contains(Modifier::UNDERLINED))
    };
    let at_rest = {
        let buffer = terminal.backend().buffer();
        assert!(!underlined(buffer, "One"), "unfocused, the label is plain");
        buffer[cell_of(buffer, "One")].bg
    };
    // The selected one already stands on the select band: the focus
    // underlines its label.
    tab_until(
        &mut view,
        &mut terminal,
        &rx,
        "the selected one's focus",
        |buffer| underlined(buffer, "One"),
    );
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[cell_of(buffer, "One")].bg, at_rest, "its band stays");
    // The other takes a band of its own: no underline.
    tab_until(
        &mut view,
        &mut terminal,
        &rx,
        "the other one's focus",
        |buffer| {
            !underlined(buffer, "One") && buffer[cell_of(buffer, "Two")].bg != buffer[(19, 0)].bg
        },
    );
    assert!(!underlined(terminal.backend().buffer(), "Two"));
}

/// A panel of its own color over the whole screen with an open popup of `kind`
/// under a trigger: a combobox's list, a select's, a menu, a calendar.
fn open_over_panel(kind: &str) -> AnyElement {
    let items = || {
        vec![
            nsh_base::SelectItem::new("rust", "Rust"),
            nsh_base::SelectItem::new("go", "Go"),
        ]
    };
    let popup: AnyElement = match kind {
        "combobox" => nsh_base::combobox()
            .items(items())
            .placeholder("Pick")
            .accessibility_label("Tags")
            .default_open(true)
            .w(px(160.0))
            .into_element(),
        "select" => nsh_base::select()
            .items(items())
            .accessibility_label("Tags")
            .default_open(true)
            .w(px(160.0))
            .into_element(),
        "menu" => nsh_base::menu()
            .default_open(true)
            .trigger(view().child(text("View")))
            .child(
                nsh_base::menu_item()
                    .accessibility_label("About")
                    .child(text("About")),
            )
            .into_element(),
        // The app's panel for its popup, as the lists' are: a box the
        // terminal frames.
        _ => nsh_base::date_picker()
            .accessibility_label("Due")
            .default_open(true)
            .popup_class("bg-[#18181b]")
            .trigger(view().w(px(160.0)).child(text("Pick")))
            .into_element(),
    };
    // One row short of the screen: a fill over all of it is the app's
    // page, the terminal's background, never a raised panel.
    let mut panel = view()
        .flex_1()
        .mb(px(16.0))
        .bg(nsh_core::color::rgb(0x402020))
        .child(popup);
    // Rows of the panel's text under where the popup opens.
    for _ in 0..12 {
        panel = panel.child(text("behind behind behind behind behind behind"));
    }
    panel.into_element()
}

#[component]
fn ComboboxOverPanel() -> impl IntoElement {
    open_over_panel("combobox")
}

#[component]
fn SelectOverPanel() -> impl IntoElement {
    open_over_panel("select")
}

#[component]
fn MenuOverPanel() -> impl IntoElement {
    open_over_panel("menu")
}

#[component]
fn PickerOverPanel() -> impl IntoElement {
    open_over_panel("picker")
}

#[test]
fn every_cell_of_a_popup_s_box_and_frame_covers_the_page_under_it() {
    for (name, root, shown) in [
        ("combobox", Root::new::<ComboboxOverPanel>(|| ()), "Go"),
        ("select", Root::new::<SelectOverPanel>(|| ()), "Go"),
        ("menu", Root::new::<MenuOverPanel>(|| ()), "About"),
        ("date picker", Root::new::<PickerOverPanel>(|| ()), "28"),
    ] {
        let (mut view, rx) = surfaces();
        let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
        view.load(App::Rust(root)).unwrap();
        draw_until(&mut view, &mut terminal, &rx, shown);
        let buffer = terminal.backend().buffer();
        let rows: Vec<String> = (0..24)
            .map(|y| (0..60).map(|x| buffer[(x, y)].symbol()).collect())
            .collect();
        let (left, top) =
            glyph_at(buffer, "╭").unwrap_or_else(|| panic!("{name}: framed: {rows:#?}"));
        let (right, bottom) =
            glyph_at(buffer, "╯").unwrap_or_else(|| panic!("{name}: framed: {rows:#?}"));
        assert_ne!(
            buffer[(59, 22)].bg,
            Color::Reset,
            "{name}: the panel is raised: {rows:#?}"
        );
        // Its line and the Cells inside it, the last column by the line
        // included: the terminal's background where the box shows no
        // band of its own, never the panel's.
        for y in top..=bottom {
            for x in left..=right {
                let cell = &buffer[(x, y)];
                if cell.symbol() == " " || x == left || x == right || y == top || y == bottom {
                    assert_ne!(
                        cell.bg,
                        buffer[(59, 22)].bg,
                        "{name}: ({x}, {y}) shows the panel under it: {rows:#?}"
                    );
                }
            }
        }
    }
}
