use nsh_core::prelude::*;
use nsh_platform_tui::{App, AppView, Handled, Input, Modifiers, Root};
use ratatui_core::{backend::TestBackend, style::Color, terminal::Terminal};

use super::app::{draw_until, surface};

#[component]
fn ScrollPage() -> impl IntoElement {
    view().flex_1().child(
        scroll()
            .absolute()
            .left(px(8.0))
            .top(px(16.0))
            .w(px(80.0))
            .h(px(32.0))
            .child(view().h(px(16.0)).flex_shrink_0().child(text("first")))
            .child(view().h(px(16.0)).flex_shrink_0().child(text("second")))
            .child(
                view()
                    .h(px(16.0))
                    .flex_shrink_0()
                    .bg(nsh_core::color::rgb(0x884422))
                    .child(text("hidden")),
            ),
    )
}

#[test]
fn scroll_content_is_visible_at_zero_offset_and_clipped_to_its_view() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<ScrollPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "second");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(1, 1)].symbol(), "f");
    assert_eq!(buffer[(1, 2)].symbol(), "s");
    assert_eq!(
        buffer[(10, 1)].symbol(),
        "┃",
        "the scroll bar's thumb on the view's right edge"
    );
    assert_eq!(buffer[(10, 2)].symbol(), "│", "its track");
    assert!(
        buffer[(10, 2)]
            .modifier
            .contains(ratatui_core::style::Modifier::DIM),
        "the track is dim"
    );
    assert!(
        !buffer[(10, 1)]
            .modifier
            .contains(ratatui_core::style::Modifier::DIM)
    );
    assert_eq!(buffer[(1, 3)].symbol(), " ");
    assert_eq!(buffer[(1, 3)].bg, Color::Reset);
}

#[component]
fn CommandScrollPage() -> impl IntoElement {
    let target = element_ref();
    let reported = signal(0);
    let selected = signal(0);
    view()
        .flex_1()
        .child(
            view()
                .h(px(16.0))
                .on_press(move |_: &()| {
                    target.scroll_to(nsh_core::Point::new(px(0.0), px(16.0)), false)
                })
                .child(text("scroll")),
        )
        .child(text(move || {
            format!("offset {} selected {}", reported.get(), selected.get())
        }))
        .child(
            scroll()
                .element_ref(&target)
                .absolute()
                .left(px(8.0))
                .top(px(32.0))
                .w(px(80.0))
                .h(px(32.0))
                .on_scroll(move |event: &ScrollEvent| reported.set(event.offset.y.0 as i32))
                .child(
                    view()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_press(move |_: &()| selected.set(1))
                        .child(text("first")),
                )
                .child(
                    view()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_press(move |_: &()| selected.set(2))
                        .child(text("second")),
                )
                .child(
                    view()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_press(move |_: &()| selected.set(3))
                        .child(text("third")),
                ),
        )
}

#[test]
fn core_scroll_commands_move_content_and_its_clipped_hit_areas() {
    use nsh_platform_tui::{Handled, MouseButton, MouseKind};

    use super::app::mouse;
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 8)).unwrap();
    view.load(App::Rust(Root::new::<CommandScrollPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "offset 0 selected 0");
    assert_eq!(terminal.backend().buffer()[(1, 2)].symbol(), "f");
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 0)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "offset 16");
    assert_eq!(terminal.backend().buffer()[(1, 2)].symbol(), "s");
    assert_eq!(terminal.backend().buffer()[(1, 3)].symbol(), "t");
    assert_eq!(terminal.backend().buffer()[(1, 4)].symbol(), " ");
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 1, 2)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "selected 2");
    assert_eq!(
        view.handle(mouse(MouseKind::Down(MouseButton::Left), 1, 4)),
        Handled::Ignored
    );
}

#[component]
fn InitialOffsets() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            scroll()
                .absolute()
                .left(px(8.0))
                .top(px(16.0))
                .w(px(24.0))
                .h(px(16.0))
                .horizontal()
                .content_offset(nsh_core::Point::new(px(8.0), px(0.0)))
                .child(text("ABCDE").w(px(40.0)).flex_shrink_0()),
        )
        .child(
            scroll()
                .absolute()
                .left(px(8.0))
                .top(px(48.0))
                .w(px(24.0))
                .h(px(32.0))
                .content_offset(nsh_core::Point::new(px(0.0), px(16.0)))
                // No bar: its column would leave the text two Cells.
                .scrollbar(false)
                .child(text("one\ntwo\nend").h(px(48.0)).flex_shrink_0()),
        )
}

#[test]
fn initial_offsets_clip_text_on_both_axes() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<InitialOffsets>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "BCD");
    draw_until(&mut view, &mut terminal, &rx, "two");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(1, 1)].symbol(), "B");
    assert_eq!(buffer[(3, 1)].symbol(), "D");
    assert_eq!(buffer[(4, 1)].symbol(), " ");
    assert_eq!(buffer[(1, 3)].symbol(), "t");
    assert_eq!(buffer[(1, 4)].symbol(), "e");
    assert_eq!(buffer[(1, 5)].symbol(), " ");
}

#[component]
fn SearchPanels() -> impl IntoElement {
    scroll_panels(|_| false)
}

#[component]
fn FocusPanels() -> impl IntoElement {
    scroll_panels(|_| true)
}

#[component]
fn EndpointPanels() -> impl IntoElement {
    scroll_panels(|index| index == 5 || index == 14)
}

fn scroll_panels(is_control: fn(i32) -> bool) -> impl IntoElement {
    let sidebar_offset = signal(0);
    let panel_offset = signal(0);
    let focused = signal(-1);
    view()
        .flex_1()
        .child(
            text(move || {
                format!(
                    "sidebar {} panel {} focus {}",
                    sidebar_offset.get(),
                    panel_offset.get(),
                    focused.get()
                )
            })
            .h(px(16.0)),
        )
        .child(
            view()
                .flex_row()
                .child(
                    scroll()
                        .w(px(120.0))
                        .h(px(112.0))
                        .on_scroll(move |event: &ScrollEvent| {
                            sidebar_offset.set(event.offset.y.0 as i32)
                        })
                        // Twenty rows: a text is as tall as its lines.
                        .child(
                            text(
                                std::iter::once("watchlist".to_owned())
                                    .chain((1..20).map(|row| row.to_string()))
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            )
                            .flex_shrink_0(),
                        ),
                )
                .child(
                    view()
                        .w(px(200.0))
                        .h(px(112.0))
                        .child(
                            // A scroll view's height is its maximum; the box around it
                            // is as tall as its content.
                            scroll()
                                .w_full()
                                .h(px(112.0))
                                .on_scroll(move |event: &ScrollEvent| {
                                    panel_offset.set(event.offset.y.0 as i32)
                                })
                                .children((0..20).map(|index| {
                                    view()
                                        .h(px(16.0))
                                        .flex_shrink_0()
                                        .focusable(is_control(index))
                                        .on_focus(move |_: &()| focused.set(index))
                                        .on_press(|_: &()| {})
                                        .child(text(format!("detail {index:02}")))
                                })),
                        )
                        .child(
                            view()
                                .absolute()
                                .bottom(px(0.0))
                                .w_full()
                                .bg(nsh_core::color::rgb(0x884422))
                                .child(text("trade bar"))
                                // Its second row: an empty box keeps its height.
                                .child(view().h(px(16.0))),
                        ),
                ),
        )
}

fn panel_key(view: &mut AppView, name: &str, ctrl: bool, alt: bool) {
    assert_eq!(
        view.handle(Input::Key {
            key: name.into(),
            modifiers: Modifiers {
                ctrl,
                alt,
                ..Default::default()
            },
            release: false,
        }),
        Handled::Yes
    );
}

fn search_panel(view: &mut AppView, terminal: &mut Terminal<TestBackend>, query: &str) {
    panel_key(view, "s", true, false);
    assert_eq!(view.handle(Input::Paste(query.into())), Handled::Yes);
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
}

#[test]
fn page_and_endpoint_keys_follow_the_plain_text_search_point_in_its_panel() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<SearchPanels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "sidebar 0 panel 0 focus -1");
    search_panel(&mut view, &mut terminal, "detail 00");
    for (name, ctrl, alt, offset) in [
        ("v", true, false, 112),
        ("v", false, true, 0),
        ("PageDown", false, false, 112),
        ("PageUp", false, false, 0),
        (">", false, true, 208),
        ("<", false, true, 0),
    ] {
        panel_key(&mut view, name, ctrl, alt);
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("sidebar 0 panel {offset} focus -1"),
        );
    }
}

#[test]
fn page_keys_follow_the_focused_control_in_its_panel() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<FocusPanels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "sidebar 0 panel 0 focus -1");
    panel_key(&mut view, "Tab", false, false);
    draw_until(&mut view, &mut terminal, &rx, "sidebar 0 panel 0 focus 0");
    for (name, ctrl, alt, offset, focused) in [
        ("v", true, false, 112, 7),
        ("v", false, true, 0, 0),
        ("PageDown", false, false, 112, 7),
        ("PageUp", false, false, 0, 0),
    ] {
        panel_key(&mut view, name, ctrl, alt);
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("sidebar 0 panel {offset} focus {focused}"),
        );
    }
}

#[test]
fn search_reveals_a_hidden_row_in_the_middle_above_the_panel_overlay() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<SearchPanels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "sidebar 0 panel 0 focus -1");
    for (query, offset) in [("detail 10", 112), ("detail 11", 112), ("detail 02", 0)] {
        search_panel(&mut view, &mut terminal, query);
        panel_key(&mut view, "Enter", false, false);
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("sidebar 0 panel {offset} focus -1"),
        );
        draw_until(&mut view, &mut terminal, &rx, query);
        if query == "detail 10" {
            let buffer = terminal.backend().buffer();
            let row: String = (15..24).map(|x| buffer[(x, 4)].symbol()).collect();
            assert_eq!(row, "detail 10");
            assert_eq!(
                buffer[(15, 6)].symbol(),
                "t",
                "the trade bar stays fixed below the match"
            );
        }
    }
}

#[test]
fn traversal_centers_only_when_the_focused_row_leaves_the_panel_viewport() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<FocusPanels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "sidebar 0 panel 0 focus -1");
    for focused in 0..8 {
        panel_key(&mut view, "n", true, false);
        let offset = if focused == 7 { 64 } else { 0 };
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("sidebar 0 panel {offset} focus {focused}"),
        );
    }
    let buffer = terminal.backend().buffer();
    let row: String = (15..24).map(|x| buffer[(x, 4)].symbol()).collect();
    assert_eq!(row, "detail 07");
    for focused in (3..7).rev() {
        panel_key(&mut view, "p", true, false);
        let offset = if focused == 3 { 0 } else { 64 };
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("sidebar 0 panel {offset} focus {focused}"),
        );
    }
}

#[test]
fn endpoints_center_the_panels_first_and_last_controls_above_its_overlay() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<EndpointPanels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "sidebar 0 panel 0 focus -1");
    search_panel(&mut view, &mut terminal, "detail 05");
    panel_key(&mut view, "Enter", false, false);
    draw_until(&mut view, &mut terminal, &rx, "sidebar 0 panel 0 focus 5");
    for (name, alt, focused, offset) in [
        (">", true, 14, 176),
        ("<", true, 5, 32),
        ("End", false, 14, 176),
        ("Home", false, 5, 32),
    ] {
        panel_key(&mut view, name, false, alt);
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("sidebar 0 panel {offset} focus {focused}"),
        );
        let buffer = terminal.backend().buffer();
        let row: String = (15..24).map(|x| buffer[(x, 4)].symbol()).collect();
        assert_eq!(row, format!("detail {focused:02}"));
        assert_eq!(buffer[(15, 6)].symbol(), "t");
    }
}

#[component]
fn MarginReveals() -> impl IntoElement {
    let horizontal = signal(0);
    let vertical = signal(0);
    let focused = signal("none");
    view()
        .flex_1()
        .child(
            text(move || {
                format!(
                    "horizontal {} vertical {} focus {}",
                    horizontal.get(),
                    vertical.get(),
                    focused.get()
                )
            })
            .h(px(16.0)),
        )
        .child(
            scroll()
                .horizontal()
                .w(px(96.0))
                .h(px(32.0))
                .on_scroll(move |event: &ScrollEvent| horizontal.set(event.offset.x.0 as i32))
                .child(view().w(px(144.0)).flex_shrink_0())
                .child(
                    view()
                        .w(px(16.0))
                        .flex_shrink_0()
                        .on_focus(move |_: &()| focused.set("horizontal"))
                        .on_press(|_: &()| {})
                        .child(text("H")),
                )
                .child(view().w(px(160.0)).flex_shrink_0()),
        )
        .child(
            scroll()
                .w(px(160.0))
                .h(px(64.0))
                .on_scroll(move |event: &ScrollEvent| vertical.set(event.offset.y.0 as i32))
                .child(view().h(px(80.0)).flex_shrink_0())
                .child(
                    // Eight rows, taller than the viewport.
                    view()
                        .flex_shrink_0()
                        .on_focus(move |_: &()| focused.set("vertical"))
                        .on_press(|_: &()| {})
                        .child(text("tall control\n1\n2\n3\n4\n5\n6\n7")),
                )
                .child(view().h(px(160.0)).flex_shrink_0()),
        )
}

#[test]
fn horizontal_and_oversized_reveals_keep_the_core_margin_and_leading_edge() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<MarginReveals>(|| ())))
        .unwrap();
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "horizontal 0 vertical 0 focus none",
    );
    panel_key(&mut view, "Tab", false, false);
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "horizontal 80 vertical 0 focus horizontal",
    );
    panel_key(&mut view, "Tab", false, false);
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "horizontal 80 vertical 64 focus vertical",
    );
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(8, 1)].symbol(), "H");
    // The horizontal Scroll is its content's one row, so this one starts at row 2.
    assert_eq!(buffer[(0, 3)].symbol(), "t");
}

/// A scroll view whose offset drives a mark's translation through the
/// animation graph (as a looping carousel's runway follows its offset).
#[component]
fn ScrollValue() -> impl IntoElement {
    let offset = animated_value(0.0);
    let mut rows = scroll()
        .absolute()
        .left(px(0.0))
        .top(px(0.0))
        .w(px(80.0))
        .h(px(32.0))
        .scroll_value(&offset);
    for index in 0..12 {
        rows = rows.child(
            view()
                .h(px(16.0))
                .flex_shrink_0()
                .child(text(format!("row {index}"))),
        );
    }
    view().flex_1().child(rows).child(
        view()
            .absolute()
            .left(px(120.0))
            .top(px(0.0))
            .bind_translate_y(&offset)
            .child(text("mark")),
    )
}

#[test]
fn a_scroll_views_offset_feeds_its_bound_scroll_value() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(24, 12)).unwrap();
    view.load(App::Rust(Root::new::<ScrollValue>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "mark");
    let row_of_mark = |terminal: &Terminal<TestBackend>| {
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height).find(|&y| buffer[(15, y)].symbol() == "m")
    };
    assert_eq!(row_of_mark(&terminal), Some(0));
    let mut input = nsh_platform_tui::MouseInput::default();
    input.column = 2;
    input.row = 1;
    input.kind = nsh_platform_tui::MouseKind::Wheel { x: 0, y: 1 };
    assert_eq!(view.handle(Input::Mouse(input)), Handled::Yes);
    for _ in 0..20 {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(50));
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if row_of_mark(&terminal).is_some_and(|row| row > 0) {
            return;
        }
    }
    panic!("the mark follows the offset: {:?}", row_of_mark(&terminal));
}

#[component]
fn FocusableScrollPage() -> impl IntoElement {
    view().flex_1().child(
        scroll()
            .focusable(true)
            .absolute()
            .left(px(8.0))
            .top(px(16.0))
            .w(px(80.0))
            .h(px(32.0))
            .child(view().h(px(16.0)).flex_shrink_0().child(text("first")))
            .child(view().h(px(16.0)).flex_shrink_0().child(text("second")))
            .child(view().h(px(16.0)).flex_shrink_0().child(text("third"))),
    )
}

#[test]
fn a_focused_scroll_view_shows_its_thumb_in_the_accent() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<FocusableScrollPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "second");
    let thumb = terminal.backend().buffer()[(10, 1)].clone();
    assert_eq!(thumb.symbol(), "┃");
    assert_ne!(thumb.fg, Color::Blue, "unfocused, the thumb is plain");
    view.handle(Input::Key {
        key: "Tab".into(),
        modifiers: Modifiers::default(),
        release: false,
    });
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(10, 1)].symbol(), "┃");
    assert_eq!(
        buffer[(10, 1)].fg,
        Color::Blue,
        "focused, the thumb is the accent"
    );
    assert_ne!(buffer[(10, 2)].fg, Color::Blue, "the track keeps its look");
}

#[component]
fn CutByViewport() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            scroll().w(px(112.0)).h(px(48.0)).child(
                // A framed card inside the scroll view: its own clip stands
                // between the viewport and the text. It holds a box (a
                // bordered box of texts alone is a one-row chip).
                view()
                    .flex_shrink_0()
                    .border_1()
                    .border_color(nsh_core::color::rgb(0xffffff))
                    .child(text("top"))
                    .child(view().child(text("one two three four"))),
            ),
        )
        .child(text("ready"))
}

#[test]
fn a_text_the_viewport_cuts_below_ends_in_no_ellipsis_inside_a_card() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
    view.load(App::Rust(Root::new::<CutByViewport>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..4)
        .map(|y| {
            (0..14)
                .map(|x| buffer[(x, y)].symbol().to_string())
                .collect()
        })
        .collect();
    assert!(rows[1].contains("top"), "{rows:#?}");
    // The text's second row is below the viewport: it scrolls into view,
    // so the row shown is only cut, never ended in `…`.
    assert!(rows[2].contains("one two"), "{rows:#?}");
    assert!(!rows[2].contains('…'), "{rows:#?}");
}
