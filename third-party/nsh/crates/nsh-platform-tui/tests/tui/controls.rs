use nsh_core::prelude::*;
use nsh_platform_tui::{App, Handled, Input, Root};
use ratatui_core::{
    backend::TestBackend,
    style::{Color, Modifier},
    terminal::Terminal,
};

use super::app::{draw_until, draw_until_true, surface};

fn key(name: &str) -> Input {
    Input::Key {
        key: name.into(),
        modifiers: Default::default(),
        release: false,
    }
}

/// Whether the focus mark covers `(x, y)`: a reversed label, or a bold,
/// underlined one where the view is already a band.
fn focus_marked(buffer: &ratatui_core::buffer::Buffer, x: u16, y: u16) -> bool {
    let modifier = buffer[(x, y)].modifier;
    modifier.contains(Modifier::REVERSED)
        || modifier.contains(Modifier::BOLD | Modifier::UNDERLINED)
}

/// Waits for the slider's thumb (`●`) to turn the accent: the slider marks
/// its focus itself (a terminal marks no Adjustable view's), in the batch
/// that also binds its keys.
pub(super) fn wait_for_thumb_focus(
    view: &mut nsh_platform_tui::AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    idle: ratatui_core::style::Color,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if thumb_color(terminal).is_some_and(|fg| fg != idle) {
            return;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "slider focus did not render"
        );
    }
}

/// The color of the slider's thumb (`●`), if one is drawn.
pub(super) fn thumb_color(terminal: &Terminal<TestBackend>) -> Option<ratatui_core::style::Color> {
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .find(|cell| cell.symbol() == "●")
        .map(|cell| cell.fg)
}

#[component]
fn FocusGroup() -> impl IntoElement {
    let focused = signal("none");
    view().flex_1().child(
        view()
            .group()
            .child(
                view()
                    .h(px(16.0))
                    .w(px(80.0))
                    .group_focus_within(|s| s.bg(nsh_core::color::rgb(0x123456))),
            )
            .children(["first", "second"].map(|name| {
                view()
                    .h(px(16.0))
                    .w(px(80.0))
                    .focus(|s| s.bg(nsh_core::color::rgb(0xabcdef)))
                    .on_press(|_: &()| {})
                    .on_focus(move |_: &()| focused.set(name))
                    .child(text(name))
            }))
            .child(text(move || format!("focus {}", focused.get()))),
    )
}

#[test]
fn moving_back_between_controls_keeps_the_groups_focus_within_style() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 8)).unwrap();
    view.load(App::Rust(Root::new::<FocusGroup>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    for (name, backwards) in [("first", false), ("second", false), ("first", true)] {
        let mut input = key("Tab");
        if let Input::Key { modifiers, .. } = &mut input {
            modifiers.shift = backwards;
        }
        view.handle(input);
        draw_until(&mut view, &mut terminal, &rx, &format!("focus {name}"));
        let buffer = terminal.backend().buffer();
        let (row, other) = if name == "first" { (1, 2) } else { (2, 1) };
        assert!(focus_marked(buffer, 0, row), "{name} is marked");
        assert!(!focus_marked(buffer, 0, other), "only {name} is marked");
        // A row's fill is a small surface: shown at 16 colors too.
        assert_ne!(
            buffer[(0, 0)].bg,
            Color::Reset,
            "the group's focus-within fill shows"
        );
    }
}

#[component]
fn ValueControls() -> impl IntoElement {
    let checked = signal(false);
    let mixed = signal(true);
    let switched = signal(false);
    let disabled = signal(false);
    view()
        .flex_1()
        .child(
            nsh_base::checkbox()
                .checked(checked)
                .indeterminate(mixed)
                .h(px(16.0))
                .w(px(80.0))
                .flex_row()
                .indicator_class(
                    "w-2 h-4 bg-[#111111] checked:bg-[#123456] indeterminate:bg-[#abcdef]",
                )
                .on_change(move |next: &bool| {
                    checked.set(*next);
                    mixed.set(false);
                })
                .child(text("check")),
        )
        .child(
            nsh_base::switch()
                .checked(switched)
                .disabled(disabled)
                .h(px(16.0))
                .w(px(80.0))
                .flex_row()
                .track_class("w-4 h-4 bg-[#111111] checked:bg-[#123456] disabled:bg-[#abcdef]")
                .thumb_class("w-2 h-4 bg-[#333333] checked:bg-[#654321] disabled:bg-[#fedcba]")
                .on_change(move |next: &bool| switched.set(*next))
                .child(text("switch")),
        )
        .child(
            nsh_base::button()
                .h(px(16.0))
                .on_press(move |_: &()| disabled.set(true))
                .child(text("disable")),
        )
        .child(text(move || {
            format!(
                "check {} mixed {} switch {} disabled {}",
                checked.get(),
                mixed.get(),
                switched.get(),
                disabled.get()
            )
        }))
}

/// The fills of the first `width` Cells of row `y`: the terminal's own
/// background, whatever the parts' state styles fill.
fn unfilled(buffer: &ratatui_core::buffer::Buffer, y: u16, width: u16) -> bool {
    (0..width).all(|x| buffer[(x, y)].bg == Color::Reset)
}

#[test]
fn checkbox_and_switch_project_value_and_disabled_states_to_their_parts() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(64, 8)).unwrap();
    view.load(App::Rust(Root::new::<ValueControls>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "mixed true");
    // The parts' state styles fill nothing in the terminal; the controls
    // keep their behavior.
    assert!(unfilled(terminal.backend().buffer(), 0, 4));
    view.handle(key("Tab"));
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "check true mixed false");
    view.handle(key("Tab"));
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "switch true");
    assert!(unfilled(terminal.backend().buffer(), 1, 4));
    view.handle(key("Tab"));
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "disabled true");
    view.handle(key("Tab"));
    view.handle(key("Enter"));
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "check false mixed false switch true disabled true",
    );
}

#[component]
fn KeyboardSlider() -> impl IntoElement {
    let value = signal(nsh_base::SliderValue::Single(60.0));
    let ended = signal(0.0);
    let presses = signal(0);
    view()
        .flex_1()
        .child(
            nsh_base::slider()
                .w(px(160.0))
                .value(move || Some(value.get()))
                .step(5.0)
                .track_class("h-8")
                .indicator_class("h-2 bg-[#123456]")
                .thumb_class("w-4 h-2 bg-[#abcdef] focus:bg-[#654321]")
                .on_change(move |next: &nsh_base::SliderValue| value.set(*next))
                .on_change_end(move |next: &nsh_base::SliderValue| ended.set(next.end())),
        )
        .child(
            nsh_base::button()
                .h(px(16.0))
                .on_press(move |_: &()| presses.update(|n| *n += 1))
                .child(text("after slider")),
        )
        .child(text(move || {
            format!(
                "value {} ended {} presses {}",
                value.get().end(),
                ended.get(),
                presses.get()
            )
        }))
}

#[test]
fn a_focused_slider_handles_arrows_pages_and_endpoints_then_releases_them_on_tab() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 8)).unwrap();
    view.load(App::Rust(Root::new::<KeyboardSlider>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "value 60");
    let idle = thumb_color(&terminal).expect("the thumb is drawn");
    view.handle(key("Tab"));
    wait_for_thumb_focus(&mut view, &mut terminal, &rx, idle);
    for (name, value) in [
        ("Right", 65),
        ("Left", 60),
        ("PageUp", 70),
        ("PageDown", 60),
        ("End", 100),
        ("Home", 0),
    ] {
        assert_eq!(view.handle(key(name)), Handled::Yes);
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("value {value} ended {value}"),
        );
    }
    view.handle(key("Tab"));
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "value 0 ended 0 presses 1");
    assert_eq!(view.handle(key("Home")), Handled::Ignored);
}

/// A slider's thumb is a mark alone: focused, it is the accent and bold,
/// with no band under it and no reverse video.
#[test]
fn a_focused_slider_s_thumb_is_the_accent_with_no_band() {
    let (mut view, rx) = super::pointer::ramp_surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 8)).unwrap();
    view.load(App::Rust(Root::new::<KeyboardSlider>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "value 60");
    let idle = thumb_color(&terminal).expect("the thumb is drawn");
    let ground = thumb(&terminal).bg;
    view.handle(key("Tab"));
    wait_for_thumb_focus(&mut view, &mut terminal, &rx, idle);
    let thumb = thumb(&terminal);
    assert_eq!(thumb.fg, Color::Blue, "in the accent");
    assert_eq!(thumb.bg, ground, "no band under it");
    assert!(thumb.modifier.contains(Modifier::BOLD));
    assert!(!thumb.modifier.contains(Modifier::REVERSED));
}

/// The slider's thumb Cell.
fn thumb(terminal: &Terminal<TestBackend>) -> ratatui_core::buffer::Cell {
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .find(|cell| cell.symbol() == "●")
        .unwrap()
        .clone()
}

/// A slot holding a single mark (a field's clear button): focused, its
/// `×` is the accent and bold, the Cells under it as they were.
#[component]
fn ClearSlot() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view().flex_row().child(text("query ")).child(
                view()
                    .focusable(true)
                    .on_press(|_: &()| {})
                    .px(px(8.0))
                    .child(text("×")),
            ),
        )
        .child(text("ready"))
}

#[test]
fn a_focused_mark_s_slot_recolors_its_mark_and_lays_no_band() {
    let (mut view, rx) = super::pointer::ramp_surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 4)).unwrap();
    view.load(App::Rust(Root::new::<ClearSlot>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let mark = |terminal: &Terminal<TestBackend>| {
        let buffer = terminal.backend().buffer();
        let (x, y) = (0..buffer.area.height)
            .find_map(|y| {
                (0..buffer.area.width)
                    .find(|&x| buffer[(x, y)].symbol() == "×")
                    .map(|x| (x, y))
            })
            .expect("the mark");
        (
            [x - 1, x, x + 1].map(|x| buffer[(x, y)].bg),
            buffer[(x, y)].clone(),
        )
    };
    let (rest, _) = mark(&terminal);
    view.handle(key("Tab"));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if mark(&terminal).1.fg == Color::Blue {
            break;
        }
        assert!(rx.recv_deadline(deadline).is_ok(), "the mark's focus");
    }
    let (bands, cell) = mark(&terminal);
    assert_eq!(bands, rest, "no band in the slot");
    assert!(cell.modifier.contains(Modifier::BOLD));
}

/// A slider filling a framed box edge to edge, as the gallery's cards.
#[component]
fn FramedSlider() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .border(px(1.0))
                .border_color(nsh_base::theme().border)
                .child(text("Volume"))
                .child(nsh_base::slider().value(|| Some(nsh_base::SliderValue::Single(50.0)))),
        )
        .child(text("ready"))
}

#[test]
fn a_slider_s_track_is_no_divider_of_the_box_around_it() {
    let (mut view, rx) = super::pointer::ramp_surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 8)).unwrap();
    view.load(App::Rust(Root::new::<FramedSlider>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let row = (0..8)
        .find(|&y| (0..30).any(|x| buffer[(x, y)].symbol() == "●"))
        .expect("the thumb is drawn");
    let line: String = (0..30).map(|x| buffer[(x, row)].symbol()).collect();
    // The frame's sides stay `│` beside the track: its `─` is the
    // slider's, not a rule joining them.
    assert!(!line.contains(['├', '┤']), "{line:?}");
    assert_eq!(line.matches('│').count(), 2, "{line:?}");
}

/// A toolbar of two buttons parted by a separator the app styles as a
/// hairline in its line color (the gallery's `w-px h-5 bg-border`),
/// horizontal or vertical.
fn separated_toolbar(axis: nsh_core::geometry::Axis) -> impl IntoElement {
    let line = nsh_base::theme().border;
    let separator = nsh_base::toolbar_separator().bg(line);
    let separator = match axis {
        nsh_core::geometry::Axis::Vertical => separator.h(px(1.0)).self_stretch(),
        _ => separator.w(px(1.0)).h(px(20.0)),
    };
    view().p(px(8.0)).child(
        nsh_base::toolbar()
            .axis(axis)
            .gap(px(8.0))
            .child(nsh_base::button().child(text("Undo")))
            .child(separator)
            .child(nsh_base::button().child(text("Bold"))),
    )
}

#[component]
fn RowToolbar() -> impl IntoElement {
    separated_toolbar(nsh_core::geometry::Axis::Horizontal)
}

#[component]
fn ColumnToolbar() -> impl IntoElement {
    separated_toolbar(nsh_core::geometry::Axis::Vertical)
}

#[test]
fn a_toolbar_s_hairline_separator_is_a_line_between_its_items() {
    // A row: a `│` between the items, on the ground (no band of the
    // hairline's fill).
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 4)).unwrap();
    view.load(App::Rust(Root::new::<RowToolbar>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Bold");
    let (undo, y) = super::dock::find(&terminal, "Undo").unwrap();
    let (bold, _) = super::dock::find(&terminal, "Bold").unwrap();
    let buffer = terminal.backend().buffer();
    let between: Vec<u16> = (undo + 4..bold)
        .filter(|&x| buffer[(x, y)].symbol() == "│")
        .collect();
    assert_eq!(
        between.len(),
        1,
        "one │ between the items\n{}",
        super::dock::dump(&terminal)
    );
    assert_eq!(
        buffer[(between[0], y)].bg,
        buffer[(0, y)].bg,
        "no band of the hairline's fill\n{}",
        super::dock::dump(&terminal)
    );

    // A column: a row of `─` between the items.
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 8)).unwrap();
    view.load(App::Rust(Root::new::<ColumnToolbar>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Bold");
    let (x, undo) = super::dock::find(&terminal, "Undo").unwrap();
    let (_, bold) = super::dock::find(&terminal, "Bold").unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        (undo + 1..bold).any(|y| buffer[(x, y)].symbol() == "─"),
        "a rule between the items\n{}",
        super::dock::dump(&terminal)
    );
}

/// A surface whose terminal's colors are known (the app's fills drawn as
/// bands), as a terminal with surfaces.
fn banded_surface() -> (nsh_platform_tui::AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = nsh_platform_tui::AppOptions::default();
    options.capabilities.colors = nsh_platform_tui::ColorDepth::TrueColor;
    options.capabilities.background_color = Some([24; 3]);
    options.capabilities.foreground_color = Some([224; 3]);
    options.wake = Some(std::sync::Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    (nsh_platform_tui::AppView::new(options), rx)
}

fn trigger_tags() -> Vec<nsh_base::SelectItem> {
    vec![
        nsh_base::SelectItem::new("rust", "Rust"),
        nsh_base::SelectItem::new("go", "Go"),
    ]
}

/// An app's trigger band, as a gallery's: a fill with a Cell of padding at
/// its start and `marks` Cells free at its end for the terminal's marks
/// (a slot of three each: three, six with the clear).
fn trigger_band(word: &'static str, marks: f32) -> View {
    view()
        .w(px(160.0))
        .pl(px(8.0))
        .pr(px(8.0 * marks))
        .bg(nsh_base::theme().secondary)
        .child(text(word))
}

/// One trigger of each kind, a blank row apart, after a muted and an
/// accent sample: base's own select (its placeholder `Own`), a select
/// with the app's band and a value to clear (`Band`), a combobox with a
/// value to clear (`Go`), a date picker with the app's band (`Date`) and a
/// disabled one (`Off`).
#[component]
fn Triggers() -> impl IntoElement {
    let sample = |word: &'static str, color: AdaptiveColor| text(word).text_color(color);
    view()
        .flex_1()
        .gap(px(16.0))
        .child(
            view()
                .flex_row()
                .gap(px(8.0))
                .child(sample("Muted", nsh_base::theme().muted_foreground))
                .child(sample("Accent", nsh_base::terminal::ACCENT.into())),
        )
        .child(
            view().flex_row().child(
                nsh_base::select()
                    .items(trigger_tags())
                    .placeholder("Own")
                    .accessibility_label("Own"),
            ),
        )
        .child(
            view().flex_row().child(
                nsh_base::select()
                    .items(trigger_tags())
                    .default_value(SharedString::from("go"))
                    .cleanable(true)
                    .accessibility_label("Band")
                    .trigger(trigger_band("Band", 6.0)),
            ),
        )
        .child(
            nsh_base::combobox()
                .items(trigger_tags())
                .default_value(vec![SharedString::from("go")])
                .cleanable(true)
                .accessibility_label("Box")
                .w(px(160.0)),
        )
        .child(
            view().flex_row().child(
                nsh_base::date_picker()
                    .accessibility_label("Date")
                    .trigger(trigger_band("Date", 3.0)),
            ),
        )
        .child(
            view().flex_row().child(
                nsh_base::date_picker()
                    .accessibility_label("Off")
                    .disabled(true)
                    .trigger(trigger_band("Off", 3.0)),
            ),
        )
}

/// The glyphs (not blank) of row `y` from `from` on, with their columns.
fn glyphs_after(terminal: &Terminal<TestBackend>, y: u16, from: u16) -> Vec<(u16, String)> {
    let buffer = terminal.backend().buffer();
    (from..buffer.area.width)
        .filter(|&x| buffer[(x, y)].symbol() != " ")
        .map(|x| (x, buffer[(x, y)].symbol().to_owned()))
        .collect()
}

#[test]
fn a_trigger_s_marks_sit_in_slots_of_three_cells_at_its_band_s_end_muted() {
    let (mut view, rx) = banded_surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<Triggers>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Off");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let dump = super::dock::dump(&terminal);
    let find = |word: &str| {
        super::dock::find(&terminal, word).unwrap_or_else(|| panic!("{word:?} shows\n{dump}"))
    };
    let buffer = terminal.backend().buffer();
    let muted = buffer[find("Muted")].fg;
    let ground = buffer[(0, find("Muted").1)].bg;
    // `(column, glyph)` of what follows `word` on its row.
    let marks = |word: &str| {
        let (x, y) = find(word);
        (
            y,
            glyphs_after(&terminal, y, x + word.chars().count() as u16),
        )
    };

    // Base's own select: one blank Cell, then `▾`, the row's last glyph,
    // a blank Cell after it.
    let (y, own) = marks("Own");
    let (x, _) = find("Own");
    assert_eq!(
        own,
        vec![(x + 4, "▾".to_owned())],
        "`Own ▾`, nothing after\n{dump}"
    );
    assert_eq!(buffer[(x + 4, y)].fg, muted, "the ▾ muted\n{dump}");

    // The app's band: `× ▾` in it, each the middle of a slot of three
    // Cells, so three apart, `▾` on the Cell before the band's last, which
    // is blank as its first is, both muted.
    for (word, expected) in [("Band", &["×", "▾"][..]), ("Date", &["▾"][..])] {
        let (y, found) = marks(word);
        let (start, _) = find(word);
        let band = buffer[(start, y)].bg;
        assert_ne!(band, ground, "{word}: a band of its own\n{dump}");
        let glyphs: Vec<&str> = found.iter().map(|(_, g)| g.as_str()).collect();
        assert_eq!(glyphs, expected, "{word}: its marks\n{dump}");
        if let [(clear, _), (arrow, _)] = found.as_slice() {
            assert_eq!(arrow - clear, 3, "{word}: slots side by side\n{dump}");
        }
        let (arrow, _) = *found.last().unwrap();
        assert_eq!(buffer[(arrow, y)].bg, band, "{word}: ▾ in the band\n{dump}");
        assert!(
            buffer[(arrow + 1, y)].bg == band && buffer[(arrow + 1, y)].symbol() == " ",
            "{word}: a blank Cell of the band after ▾\n{dump}"
        );
        assert_ne!(
            buffer[(arrow + 2, y)].bg,
            band,
            "{word}: ▾ on the Cell before the band's last\n{dump}"
        );
        assert_eq!(
            buffer[(arrow - 1, y)].symbol(),
            " ",
            "{word}: a blank Cell before ▾\n{dump}"
        );
        for &(x, _) in &found {
            assert_eq!(buffer[(x, y)].fg, muted, "{word}: its marks muted\n{dump}");
        }
    }

    // The combobox: its value, then `× ▾` in their slots, both muted, `▾`
    // the last glyph, a blank Cell after it in the box.
    let (y, found) = marks("Go");
    let glyphs: Vec<&str> = found.iter().map(|(_, g)| g.as_str()).collect();
    assert_eq!(glyphs, ["×", "▾"], "the combobox's marks\n{dump}");
    assert_eq!(found[1].0 - found[0].0, 3, "slots side by side\n{dump}");
    assert_eq!(
        found[1].0,
        find("Go").0 + 18,
        "▾ on the box's Cell before its last\n{dump}"
    );
    for &(x, _) in &found {
        assert_eq!(
            buffer[(x, y)].fg,
            muted,
            "the combobox's marks muted\n{dump}"
        );
    }

    // Disabled: its ▾ dims with its text.
    let (y, found) = marks("Off");
    let (arrow, _) = found[0];
    assert_eq!(found.len(), 1, "a disabled date picker's ▾\n{dump}");
    assert_eq!(
        buffer[(arrow, y)].fg,
        buffer[find("Off")].fg,
        "dim with its text\n{dump}"
    );
    assert_ne!(buffer[(arrow, y)].fg, muted, "dimmer than at rest\n{dump}");
}

/// A combobox with a value to clear, `Go`.
#[component]
fn ClearableBox() -> impl IntoElement {
    view().flex_1().child(
        nsh_base::combobox()
            .items(trigger_tags())
            .default_value(vec![SharedString::from("go")])
            .cleanable(true)
            .accessibility_label("Box")
            .w(px(160.0)),
    )
}

/// A press on `(x, y)` with the left button.
fn press_at(view: &mut nsh_platform_tui::AppView, x: u16, y: u16) {
    use nsh_platform_tui::{MouseButton, MouseKind};
    view.handle(super::app::mouse(MouseKind::Down(MouseButton::Left), x, y));
    view.handle(super::app::mouse(MouseKind::Up(MouseButton::Left), x, y));
}

#[test]
fn a_mark_s_slot_takes_a_press_on_the_cells_either_side_of_it() {
    let (mut view, rx) = banded_surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<ClearableBox>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Go");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let dump = super::dock::dump(&terminal);
    let (x, y) = super::dock::find(&terminal, "Go").unwrap();
    let found = glyphs_after(&terminal, y, x + 2);
    let [(clear, _), (arrow, _)] = found.as_slice() else {
        panic!("× and ▾\n{dump}");
    };
    let (clear, arrow) = (*clear, *arrow);
    // The blank Cell after `▾` opens the list.
    press_at(&mut view, arrow + 1, y);
    draw_until(&mut view, &mut terminal, &rx, "Rust");
    // The one before it closes it again.
    press_at(&mut view, arrow - 1, y);
    draw_until_true(
        &mut view,
        &mut terminal,
        &rx,
        "the list closed by the ▾'s slot",
        |t| super::dock::find(t, "Rust").is_none(),
    );
    // The blank Cell before `×` clears the value.
    press_at(&mut view, clear - 1, y);
    draw_until_true(
        &mut view,
        &mut terminal,
        &rx,
        "the value cleared by the ×'s slot",
        |t| super::dock::find(t, "Go").is_none(),
    );
}

/// An open select with the app's band, under an accent sample.
#[component]
fn OpenTrigger() -> impl IntoElement {
    view()
        .flex_1()
        .child(text("Accent").text_color(nsh_base::terminal::ACCENT))
        .child(
            view().flex_row().child(
                nsh_base::select()
                    .items(trigger_tags())
                    .accessibility_label("Band")
                    .default_open(true)
                    .trigger(trigger_band("Band", 3.0)),
            ),
        )
}

#[test]
fn an_open_trigger_s_mark_is_in_the_accent_and_shows_on_its_band() {
    let (mut view, rx) = banded_surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<OpenTrigger>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Rust");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let dump = super::dock::dump(&terminal);
    let (accent, _) = super::dock::find(&terminal, "Accent").unwrap();
    let (x, y) = super::dock::find(&terminal, "Band").unwrap();
    let found = glyphs_after(&terminal, y, x + 4);
    assert_eq!(found.len(), 1, "one ▾ after the trigger's text\n{dump}");
    let cell = &terminal.backend().buffer()[(found[0].0, y)];
    assert_eq!(cell.symbol(), "▾", "{dump}");
    assert_eq!(
        cell.fg,
        terminal.backend().buffer()[(accent, 0)].fg,
        "in the accent while open\n{dump}"
    );
    assert_ne!(cell.fg, cell.bg, "and seen on its band\n{dump}");
}
