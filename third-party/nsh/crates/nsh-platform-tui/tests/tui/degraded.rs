//! Terminals with few colors or none: the states that a ramp's bands show
//! elsewhere drawn with the standard colors at 16 and with reverse video,
//! underline and strike-through alone without colors (`NO_COLOR`).

use std::sync::Arc;

use nsh_platform_tui::{AppOptions, AppView, Bundle, ColorDepth, Input, MouseButton, MouseKind};
use ratatui_core::{
    backend::TestBackend,
    buffer::Buffer,
    style::{Color, Modifier},
    terminal::Terminal,
};

use super::app::{draw_until, mouse};

/// A surface on a terminal that shows `depth`.
fn surface_at(depth: ColorDepth) -> (AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.capabilities.colors = depth;
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    (AppView::new(options), rx)
}

fn tab() -> Input {
    Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    }
}

/// The first Cell of `word`.
fn at(buffer: &Buffer, word: &str) -> (u16, u16) {
    (0..buffer.area.height)
        .find_map(|y| {
            let row: String = (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect();
            row.find(word).map(|x| (x as u16, y))
        })
        .unwrap_or_else(|| panic!("{word} not drawn"))
}

/// Two buttons, the first selected (a toggle that is on), a disabled one, a
/// muted note and a field; `state` reports focus and hover.
const CONTROLS: &str = r##"
    import { mount, signal, View, Text } from "nsh";
    import { Input } from "nsh/base";
    const state = signal("idle");
    mount(() => <View style={{ gap: 16 }}>
        <View style={{ flexDirection: "row", gap: 16 }}>
            <View role="button" accessibilityState={{ selected: true }} onPress={() => {}}>
                <Text>Bold</Text></View>
            <View role="button" onPress={() => {}} onFocus={() => state.set("focused")}
                onMouseEnter={() => state.set("hovered")}>
                <Text style={{ color: "#a1a1aa" }}>Italic</Text></View>
            <View role="button" disabled onPress={() => {}}>
                <Text>Strike out</Text></View>
            <Text style={{ color: "#a1a1aa" }}>Muted note</Text>
        </View>
        <Input value="Ada" style={{ width: 160, height: 16 }}
            onFocus={() => state.set("field")} />
        <Text>{state()}</Text>
    </View>);
"##;

fn load(
    depth: ColorDepth,
) -> (
    AppView,
    crossbeam_channel::Receiver<()>,
    Terminal<TestBackend>,
) {
    let code = nsh_bundler::compile_module("App.tsx", CONTROLS, &[]).unwrap();
    let (mut view, rx) = surface_at(depth);
    let mut terminal = Terminal::new(TestBackend::new(60, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "idle");
    (view, rx, terminal)
}

#[test]
fn without_colors_focus_is_reversed_and_underlined_and_a_selection_reversed_alone() {
    let (mut view, rx, mut terminal) = load(ColorDepth::Monochrome);
    // Tab past the selected toggle to the second button.
    view.handle(tab());
    view.handle(tab());
    draw_until(&mut view, &mut terminal, &rx, "focused");
    let buffer = terminal.backend().buffer();
    assert!(
        buffer
            .content
            .iter()
            .all(|cell| cell.fg == Color::Reset && cell.bg == Color::Reset),
        "no colors at all"
    );
    let selected = buffer[at(buffer, "Bold")].modifier;
    assert!(
        selected.contains(Modifier::REVERSED),
        "the selection is reversed"
    );
    assert!(
        !selected.contains(Modifier::UNDERLINED),
        "and not underlined"
    );
    let focused = buffer[at(buffer, "Italic")].modifier;
    assert!(
        focused.contains(Modifier::REVERSED | Modifier::UNDERLINED),
        "the focus is reversed and underlined: {focused:?}"
    );
}

#[test]
fn at_sixteen_colors_focus_is_reversed_in_the_accent_and_a_hover_is_gray() {
    let (mut view, rx, mut terminal) = load(ColorDepth::Ansi16);
    let (x, y) = at(terminal.backend().buffer(), "Italic");
    view.handle(mouse(MouseKind::Move, x, y));
    draw_until(&mut view, &mut terminal, &rx, "hovered");
    let buffer = terminal.backend().buffer();
    let hovered = &buffer[(x, y)];
    assert_eq!(
        hovered.bg,
        Color::DarkGray,
        "the hover is the standard gray"
    );
    assert!(
        !hovered.modifier.contains(Modifier::DIM),
        "its text reads on it"
    );
    view.handle(mouse(MouseKind::Move, 59, 7));
    view.handle(tab());
    view.handle(tab());
    draw_until(&mut view, &mut terminal, &rx, "focused");
    let buffer = terminal.backend().buffer();
    let focused = &buffer[(x, y)];
    assert!(focused.modifier.contains(Modifier::REVERSED));
    assert_eq!(focused.fg, Color::Blue, "reversed in the accent");
    let selected = &buffer[at(buffer, "Bold")];
    assert!(selected.modifier.contains(Modifier::REVERSED));
    assert_ne!(
        selected.fg,
        Color::Blue,
        "a selection is plain reverse video"
    );
}

#[test]
fn a_disabled_control_is_struck_through_where_dim_is_the_only_gray() {
    for depth in [ColorDepth::Ansi16, ColorDepth::Monochrome] {
        let (_view, _rx, terminal) = load(depth);
        let buffer = terminal.backend().buffer();
        let (x, y) = at(buffer, "Strike out");
        for at in [x, x + 7, x + 9] {
            assert!(
                buffer[(at, y)]
                    .modifier
                    .contains(Modifier::CROSSED_OUT | Modifier::DIM),
                "{depth:?}: the disabled label at {at}"
            );
        }
        // The single space between its words is struck, the gap after it not.
        assert!(buffer[(x + 6, y)].modifier.contains(Modifier::CROSSED_OUT));
        assert!(!buffer[(x + 10, y)].modifier.contains(Modifier::CROSSED_OUT));
        let (mx, my) = at(buffer, "Muted note");
        assert!(
            !buffer[(mx, my)].modifier.contains(Modifier::CROSSED_OUT),
            "{depth:?}: a muted text is not"
        );
    }
    // With grays to tell them apart, dim alone.
    let (_view, _rx, terminal) = load(ColorDepth::Ansi256);
    let buffer = terminal.backend().buffer();
    assert!(
        !buffer[at(buffer, "Strike out")]
            .modifier
            .contains(Modifier::CROSSED_OUT)
    );
}

#[test]
fn a_bandless_field_is_underlined_at_rest_and_reversed_while_focused() {
    for depth in [ColorDepth::Ansi16, ColorDepth::Monochrome] {
        let (mut view, rx, mut terminal) = load(depth);
        let buffer = terminal.backend().buffer();
        let (x, y) = at(buffer, "Ada");
        // Its whole width, past its text: where it is to type in.
        for at in [x, x + 10] {
            let cell = &buffer[(at, y)];
            assert!(
                cell.modifier.contains(Modifier::UNDERLINED),
                "{depth:?}: at rest at {at}"
            );
            assert!(
                !cell.modifier.contains(Modifier::REVERSED),
                "{depth:?}: at rest at {at}"
            );
        }
        view.handle(mouse(MouseKind::Down(MouseButton::Left), x, y));
        view.handle(mouse(MouseKind::Up(MouseButton::Left), x, y));
        draw_until(&mut view, &mut terminal, &rx, "field");
        let buffer = terminal.backend().buffer();
        for at in [x, x + 10] {
            let cell = &buffer[(at, y)];
            assert!(
                cell.modifier
                    .contains(Modifier::REVERSED | Modifier::UNDERLINED),
                "{depth:?}: focused at {at}"
            );
        }
        if depth == ColorDepth::Ansi16 {
            assert_eq!(buffer[(x, y)].fg, Color::Blue, "in the accent");
        }
    }
}

/// A price tag (a green box with text in the card's color) and a meter of
/// two segments, the first filled.
const TONES: &str = r##"
    import { mount, View, Text } from "nsh";
    mount(() => <View style={{ gap: 16 }}>
        <View style={{ flexDirection: "row" }}>
            <View style={{ backgroundColor: "#16a34a", paddingHorizontal: 8 }}>
                <Text style={{ color: "#18181b" }}>41.80</Text>
            </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8, width: 160 }}>
            <View style={{ flex: 1, height: 6, borderRadius: 3, overflow: "hidden", borderWidth: 1, borderColor: "#3f3f46", backgroundColor: "#27272a" }}>
                <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
                    backgroundColor: "#dc2626", transformOrigin: "left", transform: [{ scaleX: 1 }] }} />
            </View>
            <View style={{ flex: 1, height: 6, borderRadius: 3, overflow: "hidden", borderWidth: 1, borderColor: "#3f3f46", backgroundColor: "#27272a" }}>
                <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
                    backgroundColor: "#dc2626", transformOrigin: "left", transform: [{ scaleX: 0 }] }} />
            </View>
        </View>
        <Text>ready</Text>
    </View>);
"##;

fn tones(depth: ColorDepth) -> Terminal<TestBackend> {
    let code = nsh_bundler::compile_module("App.tsx", TONES, &[]).unwrap();
    let (mut view, rx) = surface_at(depth);
    let mut terminal = Terminal::new(TestBackend::new(40, 6)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    terminal
}

#[test]
fn a_tone_fill_is_reverse_video_where_fills_are_left_out() {
    for (depth, color) in [
        (ColorDepth::Ansi16, Color::Green),
        (ColorDepth::Monochrome, Color::Reset),
    ] {
        let terminal = tones(depth);
        let buffer = terminal.backend().buffer();
        let (x, y) = at(buffer, "41.80");
        // The tag's text and its padding: one reversed block.
        for at in [x - 1, x, x + 4, x + 5] {
            let cell = &buffer[(at, y)];
            assert!(
                cell.modifier.contains(Modifier::REVERSED),
                "{depth:?}: the tag at {at}"
            );
            assert_eq!(cell.fg, color, "{depth:?}: in its color");
        }
        // The meter's filled segment is a block, the empty one and the
        // tracks (a neutral fill) are not: a segment is 9 Cells and a half
        // of the 20, on a row below the tag.
        let reversed = |columns: std::ops::Range<u16>| {
            (y + 1..buffer.area.height).any(|row| {
                columns
                    .clone()
                    .any(|column| buffer[(column, row)].modifier.contains(Modifier::REVERSED))
            })
        };
        assert!(reversed(0..4), "{depth:?}: the filled segment");
        assert!(!reversed(12..20), "{depth:?}: the empty segment");
    }
    // With the 256 colors' grays, fills are drawn as fills.
    let terminal = tones(ColorDepth::Ansi256);
    let buffer = terminal.backend().buffer();
    let (x, y) = at(buffer, "41.80");
    assert!(!buffer[(x, y)].modifier.contains(Modifier::REVERSED));
}

#[nsh_core::prelude::component]
fn Series() -> impl nsh_core::prelude::IntoElement {
    use nsh_core::prelude::*;
    // Three series on canvases of their own, as a chart's marks are: two
    // greens a few degrees apart and a dark gray.
    let line = |color: u32, y: f32| {
        canvas(
            Painter::new()
                .stroke_color(nsh_core::color::rgb(color))
                .begin_path()
                .move_to(0.0, y)
                .line_to(160.0, y)
                .stroke(),
        )
        .absolute()
        .w(px(160.0))
        .h(px(48.0))
    };
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .h(px(48.0))
                .child(line(0x16a34a, 2.0))
                .child(line(0x22c55e, 18.0))
                .child(line(0x43464c, 34.0)),
        )
        .child(text("drawn"))
}

#[test]
fn at_sixteen_colors_a_frames_canvas_series_take_distinct_entries() {
    let (mut view, rx) = surface_at(ColorDepth::Ansi16);
    let mut terminal = Terminal::new(TestBackend::new(24, 6)).unwrap();
    view.load(nsh_platform_tui::App::Rust(nsh_platform_tui::Root::new::<
        Series,
    >(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    // Each line's dots: rows 0, 1 and 2 of Cells (16pt a row).
    let colors: Vec<Color> = (0..3).map(|y| buffer[(5, y)].fg).collect();
    for (y, color) in colors.iter().enumerate() {
        assert_ne!(buffer[(5, y as u16)].symbol(), " ", "line {y} drawn");
        assert_ne!(*color, Color::Reset, "line {y} in a color of its own");
    }
    assert_ne!(colors[0], colors[1], "two greens told apart: {colors:?}");
    assert_ne!(colors[1], colors[2], "{colors:?}");
    assert_ne!(colors[0], colors[2], "{colors:?}");
}

/// Draws until `done` holds for the buffer, else fails with its rows.
fn draw_while(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    mut done: impl FnMut(&Buffer) -> bool,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if done(terminal.backend().buffer()) {
            return;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "{:?}",
            terminal.backend().buffer()
        );
    }
}

#[test]
fn a_chosen_control_the_keys_are_on_is_reversed_in_the_accent_not_as_its_choice() {
    let (mut view, rx, mut terminal) = load(ColorDepth::Ansi16);
    let bold = at(terminal.backend().buffer(), "Bold");
    let chosen = terminal.backend().buffer()[bold].clone();
    assert!(chosen.modifier.contains(Modifier::REVERSED));
    assert_eq!(chosen.fg, Color::Reset, "the choice is plain reverse video");
    // The first Tab goes to the chosen toggle.
    view.handle(tab());
    draw_while(&mut view, &mut terminal, &rx, |buffer| {
        buffer[bold].fg != Color::Reset
    });
    let focused = &terminal.backend().buffer()[bold];
    assert_eq!(focused.fg, Color::Blue, "the accent's reverse");
    assert!(
        focused.modifier.contains(Modifier::REVERSED),
        "{:?}",
        focused.modifier
    );
}

/// A combobox of two tags, 20 columns wide: room past each label.
#[nsh_core::prelude::component]
fn OpenTags() -> impl nsh_core::prelude::IntoElement {
    use nsh_core::prelude::*;
    view().flex_1().child(
        nsh_base::combobox()
            .items(vec![
                nsh_base::SelectItem::new("rust", "Rust"),
                nsh_base::SelectItem::new("go", "Go"),
            ])
            .placeholder("Pick")
            .accessibility_label("Tags")
            .w(px(160.0)),
    )
}

#[test]
fn at_sixteen_colors_a_popup_s_highlighted_item_is_reversed_across_its_row() {
    let (mut view, rx) = surface_at(ColorDepth::Ansi16);
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(nsh_platform_tui::App::Rust(nsh_platform_tui::Root::new::<
        OpenTags,
    >(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Pick");
    // Focused, then opened (and an item highlighted) with Down.
    view.handle(tab());
    view.handle(Input::Key {
        key: "down".into(),
        modifiers: Default::default(),
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "Go");
    let reversed = |buffer: &Buffer, x: u16, y: u16| {
        let cell = &buffer[(x, y)];
        cell.modifier.contains(Modifier::REVERSED) && cell.fg == Color::Blue
    };
    let mut highlighted = None;
    for _ in 0..50 {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let rows = ["Rust", "Go"].map(|word| at(buffer, word));
        if let Some(&(x, y)) = rows.iter().find(|&&(x, y)| reversed(buffer, x, y)) {
            highlighted = Some((x, y));
            break;
        }
        let _ = rx.recv_timeout(std::time::Duration::from_millis(100));
        // Down again, in case the first only opened the list.
        if highlighted.is_none() {
            view.handle(Input::Key {
                key: "down".into(),
                modifiers: Default::default(),
                release: false,
            });
        }
    }
    let (x, y) = highlighted.expect("an item is highlighted");
    let buffer = terminal.backend().buffer();
    // Past its label (four Cells at most), as far as the row goes.
    assert!(
        reversed(buffer, x + 6, y),
        "the highlight spans the row past its label"
    );
}

/// A neutral chip (a gray fill, its text muted), a card a few rows tall
/// of the same gray and a primary button's blue: surfaces, a fill and no
/// line, at every depth.
const SURFACES: &str = r##"
    import { mount, View, Text } from "nsh";
    mount(() => <View style={{ gap: 16 }}>
        <View style={{ flexDirection: "row", gap: 16 }}>
            <View style={{ backgroundColor: "#3f3f46", paddingHorizontal: 8 }}>
                <Text style={{ color: "#a1a1aa" }}>chip</Text>
            </View>
            <View role="button" onPress={() => {}}
                style={{ backgroundColor: "#2563eb", paddingHorizontal: 8 }}>
                <Text style={{ color: "#ffffff" }}>Save</Text>
            </View>
        </View>
        <View style={{ backgroundColor: "#3f3f46", padding: 16, width: 160 }}>
            <Text>card</Text>
            <Text>second</Text>
            <Text>third</Text>
        </View>
        <Text>ready</Text>
    </View>);
"##;

fn bandless_surfaces(depth: ColorDepth) -> Terminal<TestBackend> {
    let code = nsh_bundler::compile_module("App.tsx", SURFACES, &[]).unwrap();
    let (mut view, rx) = surface_at(depth);
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    terminal
}

#[test]
fn at_sixteen_colors_a_small_surface_is_filled_in_the_standard_colors() {
    let terminal = bandless_surfaces(ColorDepth::Ansi16);
    let buffer = terminal.backend().buffer();
    let (x, y) = at(buffer, "chip");
    // Its padding Cell before the text and the text itself: the gray.
    for at in [x - 1, x] {
        assert_eq!(buffer[(at, y)].bg, Color::DarkGray, "the chip at {at}");
    }
    let text = &buffer[(x, y)];
    assert_ne!(text.fg, Color::DarkGray, "its muted text reads on it");
    // The button in its blue: its fill, or reversed in it.
    let (sx, sy) = at(buffer, "Save");
    let save = &buffer[(sx - 1, sy)];
    assert!(
        save.bg == Color::Blue
            || save.modifier.contains(Modifier::REVERSED) && save.fg == Color::Blue,
        "the primary button in its color: {save:?}"
    );
    // The card is a panel: no fill (one gray across a panel would put
    // each muted label on a patch of its own) and no line around it.
    let (cx, cy) = at(buffer, "card");
    for (px, py) in [(cx - 1, cy), (cx + 8, cy + 1)] {
        assert_eq!(buffer[(px, py)].bg, Color::Reset, "the card at {px},{py}");
    }
    let above: String = (0..40).map(|x| buffer[(x, cy - 1)].symbol()).collect();
    assert!(!above.contains('─'), "no line: {above:?}");
}

#[test]
fn without_colors_a_small_surface_is_reversed() {
    let terminal = bandless_surfaces(ColorDepth::Monochrome);
    let buffer = terminal.backend().buffer();
    let (x, y) = at(buffer, "chip");
    for at in [x - 1, x] {
        assert!(
            buffer[(at, y)].modifier.contains(Modifier::REVERSED),
            "the chip at {at}"
        );
    }
    // A panel a few rows tall is not reversed: it would bury its text.
    let (cx, cy) = at(buffer, "card");
    assert!(!buffer[(cx, cy)].modifier.contains(Modifier::REVERSED));
}
