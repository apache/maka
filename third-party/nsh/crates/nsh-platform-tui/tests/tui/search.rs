use nsh_core::prelude::*;
use nsh_platform_tui::{App, AppView, Handled, Input, Modifiers, Root};
use ratatui_core::{backend::TestBackend, style::Modifier, terminal::Terminal};

use super::app::{draw_until, surface};

const BOTTOM_ROW: u16 = 9;

fn key(name: &str) -> Input {
    Input::Key {
        key: name.into(),
        modifiers: Modifiers::default(),
        release: false,
    }
}

fn ctrl(name: &str) -> Input {
    Input::Key {
        key: name.into(),
        modifiers: Modifiers {
            ctrl: true,
            ..Default::default()
        },
        release: false,
    }
}

fn type_text(view: &mut AppView, terminal: &mut Terminal<TestBackend>, text: &str) {
    for character in text.chars() {
        assert_eq!(view.handle(key(&character.to_string())), Handled::Yes);
        draw(view, terminal);
    }
}

fn draw(view: &mut AppView, terminal: &mut Terminal<TestBackend>) {
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
}

fn row(terminal: &Terminal<TestBackend>, y: u16) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.width)
        .map(|x| buffer[(x, y)].symbol())
        .collect()
}

fn underlined(terminal: &Terminal<TestBackend>) -> String {
    let buffer = terminal.backend().buffer();
    buffer
        .content
        .iter()
        .filter(|cell| cell.modifier.contains(Modifier::UNDERLINED))
        .map(|cell| cell.symbol())
        .collect()
}

fn reversed(terminal: &Terminal<TestBackend>) -> String {
    let buffer = terminal.backend().buffer();
    buffer
        .content
        .iter()
        .filter(|cell| cell.modifier.contains(Modifier::REVERSED))
        .map(|cell| cell.symbol())
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// The focused control's label: the rows whose every glyph is reversed (a
/// match is reversed too, but only its own Cells of a row). The scroll bar
/// a scroll view draws in its last column is no glyph of a row's content.
fn barred(terminal: &Terminal<TestBackend>) -> String {
    let buffer = terminal.backend().buffer();
    let area = buffer.area;
    (0..area.height)
        .filter_map(|y| {
            let cells: Vec<_> = (0..area.width)
                .map(|x| &buffer[(x, y)])
                .filter(|cell| !matches!(cell.symbol(), " " | "│" | "┃"))
                .collect();
            (!cells.is_empty()
                && cells
                    .iter()
                    .all(|cell| cell.modifier.contains(Modifier::REVERSED)))
            .then(|| cells.iter().map(|cell| cell.symbol()).collect::<String>())
        })
        .collect::<Vec<_>>()
        .join("|")
}

#[component]
fn SpatialSearch() -> impl IntoElement {
    let focused = signal("none");
    let control = move |label: &'static str, x, y| {
        view()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(64.0))
            .h(px(16.0))
            .on_press(|_: &()| {})
            .on_focus(move |_: &()| focused.set(label))
            .child(text(format!("match {label}")))
    };
    view()
        .flex_1()
        .child(control("A", 0.0, 32.0))
        .child(control("B", 80.0, 0.0))
        .child(control("C", 80.0, 16.0))
        .child(text("plain note").absolute().top(px(16.0)))
        .child(
            text(move || format!("focus {}", focused.get()))
                .absolute()
                .top(px(64.0)),
        )
}

#[test]
fn search_matches_keep_spatial_order() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<SpatialSearch>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    view.handle(ctrl("s"));
    type_text(&mut view, &mut terminal, "match");
    draw_until(&mut view, &mut terminal, &rx, "focus B");
    for label in ["C", "A"] {
        view.handle(ctrl("s"));
        draw_until(&mut view, &mut terminal, &rx, &format!("focus {label}"));
    }
}

#[component]
fn SidebarSearch() -> impl IntoElement {
    let focused = signal("none");
    let control = move |label: &'static str, x, y| {
        view()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(64.0))
            .h(px(16.0))
            .on_press(|_: &()| {})
            .on_focus(move |_: &()| focused.set(label))
            .child(text(format!("go {label}")))
    };
    view()
        .flex_1()
        .child(
            view()
                .child(control("S0", 0.0, 0.0))
                .child(control("S1", 0.0, 32.0))
                .child(control("S2", 0.0, 64.0)),
        )
        .child(
            view()
                .child(control("P0", 160.0, 16.0))
                .child(text("plain note").absolute().left(px(160.0)).top(px(48.0)))
                .child(control("P1", 160.0, 80.0)),
        )
        .child(
            text(move || format!("focus {}", focused.get()))
                .absolute()
                .top(px(128.0)),
        )
}

#[test]
fn traversal_from_a_plain_text_match_continues_in_tree_order() {
    for (next, expected) in [("n", "P1"), ("p", "P0")] {
        let (mut view, rx) = surface();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        view.load(App::Rust(Root::new::<SidebarSearch>(|| ())))
            .unwrap();
        draw_until(&mut view, &mut terminal, &rx, "focus none");
        view.handle(ctrl("s"));
        type_text(&mut view, &mut terminal, "note");
        view.handle(key("Enter"));
        view.handle(ctrl(next));
        draw_until(&mut view, &mut terminal, &rx, &format!("focus {expected}"));
    }
}

#[component]
fn SearchPage() -> impl IntoElement {
    let focused = signal(-1);
    let offset = signal(0);
    let pressed = signal(-1);
    let control = move |label: String, index: i32| {
        view()
            .h(px(16.0))
            .flex_shrink_0()
            .on_focus(move |_: &()| focused.set(index))
            .on_blur(move |_: &()| focused.set(-1))
            .on_press(move |_: &()| pressed.set(index))
            .child(text(label))
    };
    view()
        .flex_1()
        .child(
            text(move || {
                format!(
                    "focus {} offset {} pressed {}",
                    focused.get(),
                    offset.get(),
                    pressed.get()
                )
            })
            .h(px(16.0)),
        )
        .child(control("before".into(), 100))
        .child(text("plain note").h(px(16.0)))
        .child(control("after".into(), 101))
        .child(
            scroll()
                .w(px(160.0))
                .h(px(64.0))
                .flex_shrink_0()
                .on_scroll(move |event: &ScrollEvent| offset.set(event.offset.y.0 as i32))
                .children((0..12).map(|index| control(format!("item {index}"), index))),
        )
        .child(text("footer line").absolute().top(px(144.0)))
}

fn open_search_page() -> (
    AppView,
    Terminal<TestBackend>,
    crossbeam_channel::Receiver<()>,
) {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<SearchPage>(|| ())))
        .unwrap();
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "focus -1 offset 0 pressed -1",
    );
    draw_until(&mut view, &mut terminal, &rx, "footer line");
    (view, terminal, rx)
}

#[test]
fn control_s_finds_text_forward_focuses_and_reveals_it_and_repeats_to_the_next_match() {
    let (mut view, mut terminal, rx) = open_search_page();
    assert_eq!(reversed(&terminal), "");
    assert_eq!(barred(&terminal), "");
    assert_eq!(view.handle(ctrl("s")), Handled::Yes);
    draw(&mut view, &mut terminal);
    assert_eq!(row(&terminal, BOTTOM_ROW).trim_end(), "/");
    type_text(&mut view, &mut terminal, "item 1");
    draw_until(&mut view, &mut terminal, &rx, "focus 1 offset 0");
    assert_eq!(row(&terminal, BOTTOM_ROW).trim_end(), "/item 1");
    assert_eq!(reversed(&terminal), "item 1");
    assert_eq!(barred(&terminal), "item1", "the focused control");
    assert_eq!(
        underlined(&terminal),
        "",
        "a match inside a bar is reversed too"
    );
    for (expected, focused) in [
        ("focus 10 offset 128", "item 10"),
        ("focus 11 offset 128", "item 11"),
        ("focus 1 offset 0", "item 1"),
    ] {
        assert_eq!(view.handle(ctrl("s")), Handled::Yes);
        draw_until(&mut view, &mut terminal, &rx, expected);
        assert_eq!(
            barred(&terminal),
            focused.replace(' ', ""),
            "in its focused control"
        );
        assert_eq!(
            reversed(&terminal),
            focused,
            "the match, inside the reversed focused control"
        );
    }
    assert_eq!(view.handle(key("Enter")), Handled::Yes);
    draw(&mut view, &mut terminal);
    assert!(row(&terminal, BOTTOM_ROW).starts_with("footer line"));
    assert_eq!(
        reversed(&terminal),
        "item 1",
        "no match once the search ends, only the focused control"
    );
    assert_eq!(barred(&terminal), "item1", "the focused control");
    assert_eq!(view.handle(key("Enter")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus 1 offset 0 pressed 1");
}

#[test]
fn control_r_searches_backward_and_cancel_restores_focus_and_scrolling() {
    for cancel in [key("Escape"), ctrl("g")] {
        let (mut view, mut terminal, rx) = open_search_page();
        for _ in 0..5 {
            view.handle(ctrl("n"));
            draw(&mut view, &mut terminal);
        }
        draw_until(&mut view, &mut terminal, &rx, "focus 2 offset 0");
        assert_eq!(view.handle(ctrl("r")), Handled::Yes);
        draw(&mut view, &mut terminal);
        assert_eq!(row(&terminal, BOTTOM_ROW).trim_end(), "?");
        type_text(&mut view, &mut terminal, "item");
        draw_until(&mut view, &mut terminal, &rx, "focus 2 offset 0");
        for expected in [
            "focus 1 offset 0",
            "focus 0 offset 0",
            "focus 11 offset 128",
        ] {
            assert_eq!(view.handle(ctrl("r")), Handled::Yes);
            draw_until(&mut view, &mut terminal, &rx, expected);
        }
        assert_eq!(view.handle(cancel), Handled::Yes);
        draw_until(&mut view, &mut terminal, &rx, "focus 2 offset 0");
        assert!(row(&terminal, BOTTOM_ROW).starts_with("footer line"));
        assert_eq!(reversed(&terminal), "item 2", "only the focused control");
        assert_eq!(barred(&terminal), "item2", "the focused control");
    }
}

#[test]
fn a_match_in_plain_text_takes_focus_away_and_traversal_continues_from_it() {
    let (mut view, mut terminal, rx) = open_search_page();
    view.handle(ctrl("n"));
    draw_until(&mut view, &mut terminal, &rx, "focus 100");
    view.handle(ctrl("s"));
    draw(&mut view, &mut terminal);
    type_text(&mut view, &mut terminal, "Note");
    assert_eq!(row(&terminal, BOTTOM_ROW).trim_end(), "/Note");
    assert_eq!(barred(&terminal), "before", "the focused control");
    draw_until(&mut view, &mut terminal, &rx, "focus 100");
    for _ in 0..4 {
        assert_eq!(view.handle(key("Backspace")), Handled::Yes);
    }
    type_text(&mut view, &mut terminal, "note");
    draw_until(&mut view, &mut terminal, &rx, "focus -1");
    assert_eq!(reversed(&terminal), "note");
    assert_eq!(barred(&terminal), "", "focus left the control");
    assert_eq!(
        underlined(&terminal),
        "",
        "a match in plain text is only reversed"
    );
    assert_eq!(view.handle(key("Enter")), Handled::Yes);
    assert_eq!(view.handle(ctrl("n")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus 101");
}

#[test]
fn another_terminal_key_ends_the_search_and_takes_its_own_action() {
    let (mut view, mut terminal, rx) = open_search_page();
    view.handle(ctrl("s"));
    draw(&mut view, &mut terminal);
    type_text(&mut view, &mut terminal, "after");
    draw_until(&mut view, &mut terminal, &rx, "focus 101");
    assert_eq!(view.handle(ctrl("n")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus 0");
    assert!(row(&terminal, BOTTOM_ROW).starts_with("footer line"));
}
