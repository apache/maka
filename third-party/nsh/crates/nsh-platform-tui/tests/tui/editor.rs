//! An `Editor` in a terminal: its rows and line numbers sit on absolute
//! layers over its scroll views, inside a box sized only by its column,
//! and the Cells draw their text, alone and as a dock's panel. It and a
//! `RichEditor` take the typing through their sink, a field narrower than
//! a Cell.

use std::time::{Duration, Instant};

use nsh_base::{
    dock::{DockAreaLayout, DockLayout, DockPanel, DockPlacement, DockRegion, dock_area},
    editor::editor,
    rich_editor::view::{RichEditorChange, rich_editor},
};
use nsh_core::prelude::*;
use nsh_platform_tui::{App, AppView, CursorStyle, Handled, Input, Modifiers, Root};
use ratatui_core::{
    backend::{Backend, TestBackend},
    terminal::Terminal,
};

use super::{
    app::{draw_until, mouse, surface},
    dock::dump,
};

const TEXT: &str = "let total = 42;\nreturn total;";

/// A status line over an editor that takes the rest of the column.
#[component]
fn Source() -> impl IntoElement {
    view()
        .flex_1()
        .child(text("Source"))
        .child(editor().default_value(SharedString::from(TEXT)).flex_1())
}

#[test]
fn an_editors_rows_are_drawn_in_its_column() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Source>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Source");
    draw_until(&mut view, &mut terminal, &rx, "let total = 42;");
    draw_until(&mut view, &mut terminal, &rx, "return total;");
    let text = dump(&terminal);
    let first = text.find("let total").unwrap();
    let second = text.find("return total").unwrap();
    assert!(first < second, "{text}");
}

/// The editor as the gallery shows it: the center panel of a dock area
/// with a bottom dock.
#[component]
fn DockedSource() -> impl IntoElement {
    let mut bottom = DockRegion::new(DockLayout::tabs().panel("problems"));
    bottom.size = Some(px(96.0));
    let layout = signal(
        DockAreaLayout::new(DockLayout::tabs().panel("editor"))
            .with_dock(DockPlacement::Bottom, bottom),
    );
    view().flex_1().child(
        dock_area()
            .layout(move || layout.get())
            .compact(Some(false))
            .tab_bar_class("flex-row gap-2")
            .render_tab(|tab: &nsh_base::dock::DockTab| text(format!("Tab {}", tab.panel)))
            .render_panel(|panel: &DockPanel| match panel.id.as_ref() {
                "editor" => view()
                    .flex_1()
                    .child(editor().default_value(SharedString::from(TEXT)).flex_1())
                    .into_element(),
                _ => view().flex_1().child(text("No problems")).into_element(),
            })
            .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
            .size_full(),
    )
}

#[test]
fn an_editor_in_a_dock_panel_draws_its_rows() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 20)).unwrap();
    view.load(App::Rust(Root::new::<DockedSource>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "No problems");
    draw_until(&mut view, &mut terminal, &rx, "let total = 42;");
}

fn key(name: &str) -> Input {
    Input::Key {
        key: name.into(),
        modifiers: Modifiers::default(),
        release: false,
    }
}

fn contents(terminal: &Terminal<TestBackend>) -> String {
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect()
}

/// Presses Tab until the buffer shows `expected` (the editor reporting its
/// focus), returning how many presses it took.
fn tab_until(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    expected: &str,
) -> usize {
    for presses in 1..=12 {
        assert_eq!(view.handle(key("Tab")), Handled::Yes);
        let deadline = Instant::now() + Duration::from_millis(300);
        loop {
            terminal
                .draw(|frame| view.render(frame, frame.area()))
                .unwrap();
            if contents(terminal).contains(expected) {
                return presses;
            }
            if rx.recv_deadline(deadline).is_err() {
                break;
            }
        }
    }
    panic!("Tab never reached {expected:?}: {:?}", contents(terminal));
}

/// Draws until the terminal's cursor is at `at`. The editor places its
/// sink, where the cursor is, with where its rows were measured after a
/// layout: a commit or two after the rows and the focus show.
fn draw_until_cursor(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    at: (u16, u16),
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let cursor = terminal.backend_mut().get_cursor_position().unwrap();
        if cursor == at.into() {
            return;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the cursor stayed at {cursor:?}, not {at:?}:\n{}",
            dump(terminal)
        );
    }
}

/// An editor reporting its focus and each change.
#[component]
fn Typed() -> impl IntoElement {
    let focused = signal("no");
    let value = signal(SharedString::from(TEXT));
    view()
        .flex_1()
        .child(text(move || format!("focus {}", focused.get())))
        .child(text(move || {
            format!(
                "typed {}",
                if value.get().contains('Q') {
                    "yes"
                } else {
                    "no"
                }
            )
        }))
        .child(
            editor()
                .default_value(SharedString::from(TEXT))
                .on_focus(move |_: &()| focused.set("yes"))
                .on_change(move |next: &SharedString| value.set(next.clone()))
                .flex_1(),
        )
}

#[test]
fn tab_enters_an_editor_and_typing_changes_its_text() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Typed>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "let total = 42;");
    // The gutter's line numbers and fold markers are no Tab stops: the
    // first Tab is the text's.
    let presses = tab_until(&mut view, &mut terminal, &rx, "focus yes");
    assert_eq!(presses, 1, "Tab stops before the editor's text");
    assert_eq!(view.handle(key("Q")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "typed yes");
}

/// A control reporting its focus as `focus <label>`.
fn stop(label: &'static str, focused: Signal<&'static str>) -> impl IntoElement {
    view()
        .on_focus(move |_: &()| focused.set(label))
        .on_press(|_: &()| {})
        .child(text(label))
}

/// An editor between two controls.
#[component]
fn Between() -> impl IntoElement {
    let focused = signal("none");
    view()
        .flex_1()
        .child(text(move || format!("focus {}", focused.get())))
        .child(stop("Before", focused))
        .child(
            editor()
                .default_value(SharedString::from(TEXT))
                .on_focus(move |_: &()| focused.set("editor"))
                .h(px(64.0)),
        )
        .child(stop("After", focused))
}

#[test]
fn one_tab_goes_from_the_control_before_an_editor_into_its_text() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Between>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    assert_eq!(tab_until(&mut view, &mut terminal, &rx, "focus Before"), 1);
    // The gutter and the rows take the pointer's presses; neither is a
    // stop of its own, so the next Tab is the text's.
    assert_eq!(tab_until(&mut view, &mut terminal, &rx, "focus editor"), 1);
}

#[test]
fn escape_then_tab_leaves_an_editor_for_the_next_control() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Between>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    tab_until(&mut view, &mut terminal, &rx, "focus editor");
    // With one caret and nothing selected the editor leaves Escape to
    // the page, which takes the focus out of the field; Tab then goes on
    // after the editor, not from the top.
    assert_eq!(view.handle(key("Escape")), Handled::Yes);
    assert_eq!(view.handle(key("Tab")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus After");
}

/// A rich editor between two controls.
#[component]
fn RichBetween() -> impl IntoElement {
    let focused = signal("none");
    view()
        .flex_1()
        .child(text(move || format!("focus {}", focused.get())))
        .child(stop("Before", focused))
        .child(
            rich_editor()
                .on_focus(move |_: &()| focused.set("editor"))
                .h(px(64.0)),
        )
        .child(stop("After", focused))
}

#[test]
fn escape_then_tab_leaves_a_rich_editor_for_the_next_control() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<RichBetween>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    tab_until(&mut view, &mut terminal, &rx, "focus editor");
    // Escape nothing takes, with nothing selected, blurs the editor.
    assert_eq!(view.handle(key("Escape")), Handled::Yes);
    let deadline = Instant::now() + Duration::from_secs(5);
    while view.handle(key("Tab")) == Handled::Yes {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let text = contents(&terminal);
        if text.contains("focus After") {
            return;
        }
        assert!(
            !text.contains("focus Before"),
            "Tab started from the top: {text:?}"
        );
        assert!(
            Instant::now() < deadline,
            "Tab never left the editor: {text:?}"
        );
        let _ = rx.recv_deadline(Instant::now() + Duration::from_millis(100));
    }
    panic!("Tab was not used");
}

#[test]
fn an_editors_caret_is_the_terminal_cursor() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Typed>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "let total = 42;");
    let width = terminal.backend().buffer().area.width as usize;
    let cell = |terminal: &Terminal<TestBackend>, needle: &str| {
        let at = contents(terminal).find(needle).unwrap();
        ((at % width) as u16, (at / width) as u16)
    };
    let start = cell(&terminal, "let total");
    tab_until(&mut view, &mut terminal, &rx, "focus yes");
    // The sink sits at the caret, the text's start: the terminal's bar is
    // on the `l` of `let`, and nsh-base draws no caret of its own.
    draw_until_cursor(&mut view, &mut terminal, &rx, start);
    assert_eq!(view.cursor_style(), CursorStyle::Bar);
    assert_eq!(terminal.backend().buffer()[start].symbol(), "l");
    // Typing moves it with the caret, after the `Q`.
    assert_eq!(view.handle(key("Q")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "Qlet total");
    draw_until_cursor(&mut view, &mut terminal, &rx, (start.0 + 1, start.1));
}

#[test]
fn a_click_on_a_characters_cell_puts_the_caret_before_it() {
    use nsh_platform_tui::{MouseButton::Left, MouseKind};
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Typed>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "let total = 42;");
    let width = terminal.backend().buffer().area.width as usize;
    let at = contents(&terminal).find("let total").unwrap() + 5;
    let (x, y) = ((at % width) as u16, (at / width) as u16);
    // The `o` of `total`: the caret stands on its Cell, before it, as a
    // terminal's cursor does (not after it, the nearer edge of its center).
    view.handle(mouse(MouseKind::Down(Left), x, y));
    view.handle(mouse(MouseKind::Up(Left), x, y));
    draw_until(&mut view, &mut terminal, &rx, "focus yes");
    terminal.backend_mut().assert_cursor_position((x, y));
    assert_eq!(view.handle(key("Q")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "let tQotal");
}

/// A rich editor (an empty document) reporting its focus and changes.
#[component]
fn RichTyped() -> impl IntoElement {
    let focused = signal("no");
    let changes = signal(0u32);
    view()
        .flex_1()
        .child(text(move || {
            format!("focus {} changes {}", focused.get(), changes.get())
        }))
        .child(
            rich_editor()
                .on_focus(move |_: &()| focused.set("yes"))
                .on_change(move |_: &RichEditorChange| changes.update(|n| *n += 1))
                .flex_1(),
        )
}

#[test]
fn tab_enters_a_rich_editor_and_typing_changes_its_document() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<RichTyped>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus no changes 0");
    tab_until(&mut view, &mut terminal, &rx, "focus yes");
    assert_eq!(view.handle(key("Q")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "changes 1");
    draw_until(&mut view, &mut terminal, &rx, "Q");
}

/// A four-digit code in a row of framed cells, reporting its focus.
#[component]
fn Code() -> impl IntoElement {
    let focused = signal("no");
    view()
        .flex_1()
        .child(text(move || format!("focus {}", focused.get())))
        .child(
            view().flex_row().child(
                nsh_base::otp_input()
                    .length(4u32)
                    .group_class("flex-row gap-2")
                    .cell_class("w-12 h-12 border items-center justify-center")
                    .on_focus(move || focused.set("yes")),
            ),
        )
}

#[test]
fn a_codes_next_cell_holds_the_terminal_cursor() {
    use ratatui_core::backend::Backend;
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Code>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus no");
    tab_until(&mut view, &mut terminal, &rx, "focus yes");
    // The hidden field is the sink: the cursor stands where the next
    // digit goes, so the digit typed lands under it.
    let first = terminal.backend_mut().get_cursor_position().unwrap();
    assert!(first.y > 0, "on the cells' row, under the status line");
    assert_eq!(view.handle(key("2")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "2");
    assert_eq!(
        terminal.backend().buffer()[(first.x, first.y)].symbol(),
        "2",
        "{}",
        dump(&terminal)
    );
    let second = terminal.backend_mut().get_cursor_position().unwrap();
    assert_eq!(second.y, first.y);
    assert!(
        second.x > first.x + 1,
        "on the next cell: {first:?} {second:?}"
    );
    assert_eq!(view.handle(key("7")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "7");
    assert_eq!(
        terminal.backend().buffer()[(second.x, second.y)].symbol(),
        "7",
        "{}",
        dump(&terminal)
    );
}

#[test]
fn a_click_on_a_codes_cells_gives_it_the_keys() {
    use nsh_platform_tui::{MouseButton::Left, MouseKind};
    use ratatui_core::backend::Backend;
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Code>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus no");
    // The last cell's frame: its field is a Cell wide, at the first cell,
    // so the press lands on the cells alone.
    let buffer = terminal.backend().buffer();
    let width = buffer.area.width as usize;
    // A Cell's index, not a byte's: the frames' corners are wider in UTF-8.
    let at = buffer
        .content
        .iter()
        .rposition(|c| matches!(c.symbol(), "╭" | "┌"))
        .expect("the cells' frames");
    let (x, y) = ((at % width) as u16 + 1, (at / width) as u16 + 1);
    view.handle(mouse(MouseKind::Down(Left), x, y));
    view.handle(mouse(MouseKind::Up(Left), x, y));
    draw_until(&mut view, &mut terminal, &rx, "focus yes");
    let cursor = terminal.backend_mut().get_cursor_position().unwrap();
    assert!(
        cursor.x < x,
        "on the first cell, the next to fill: {cursor:?}"
    );
    assert_eq!(view.handle(key("5")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "5");
}
