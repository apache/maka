use nsh_core::prelude::*;
use nsh_platform_tui::{App, AppView, Handled, Input, Modifiers, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::app::{draw_until, surface};

fn key(view: &mut AppView, name: &str, ctrl: bool) -> Handled {
    view.handle(Input::Key {
        key: name.into(),
        modifiers: Modifiers {
            ctrl,
            ..Default::default()
        },
        release: false,
    })
}

#[component]
fn SidebarAndPanel() -> impl IntoElement {
    let focused = signal("none");
    let button = move |label: &'static str| {
        view()
            .h(px(16.0))
            .on_focus(move |_: &()| focused.set(label))
            .on_press(|_: &()| {})
            .child(text(label))
    };
    view()
        .flex_1()
        .child(
            scroll().w(px(320.0)).h(px(64.0)).child(
                view()
                    .flex_row()
                    .child(
                        view()
                            .w(px(96.0))
                            .z_index(1)
                            .child(button("Stocks"))
                            .child(button("AI Chat"))
                            .child(button("Photos")),
                    )
                    .child(
                        view()
                            .w(px(96.0))
                            .child(button("Market"))
                            .child(button("Pause")),
                    ),
            ),
        )
        .child(text(move || format!("focused {}", focused.get())))
}

#[test]
fn traversal_finishes_the_sidebar_before_entering_the_panel_in_both_directions() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<SidebarAndPanel>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focused none");
    for (name, ctrl, shift, expected) in [
        ("n", true, false, "Stocks"),
        ("Tab", false, false, "AI Chat"),
        ("n", true, false, "Photos"),
        ("Tab", false, false, "Market"),
        ("n", true, false, "Pause"),
        ("Tab", false, false, "Stocks"),
        ("Tab", false, true, "Pause"),
        ("p", true, false, "Market"),
        ("Tab", false, true, "Photos"),
        ("p", true, false, "AI Chat"),
        ("Tab", false, true, "Stocks"),
        ("p", true, false, "Pause"),
    ] {
        assert_eq!(
            view.handle(Input::Key {
                key: name.into(),
                modifiers: Modifiers {
                    ctrl,
                    shift,
                    ..Default::default()
                },
                release: false,
            }),
            Handled::Yes
        );
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("focused {expected}"),
        );
    }
}

#[test]
fn endpoints_use_tree_order_while_horizontal_keys_move_between_columns() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<SidebarAndPanel>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focused none");
    for (name, ctrl, alt, expected) in [
        ("End", false, false, "Pause"),
        ("Home", false, false, "Stocks"),
        ("f", true, false, "Market"),
        ("b", true, false, "Stocks"),
        (">", false, true, "Pause"),
        ("<", false, true, "Stocks"),
    ] {
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
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("focused {expected}"),
        );
    }
}

#[component]
fn ReturningPage() -> impl IntoElement {
    let detail = signal(false);
    let focused = signal("none");
    let opens = signal(0);
    let visible = signal(true);
    on_key("ctrl+d", move |_| visible.set(false));
    view()
        .flex_1()
        .child(
            text(move || {
                format!(
                    "focus {} opens {} visible {}",
                    focused.get(),
                    opens.get(),
                    visible.get()
                )
            })
            .h(px(16.0)),
        )
        .child(
            nsh_base::nav_stack()
                .w(px(240.0))
                .h(px(96.0))
                .child(
                    nsh_base::nav_page()
                        .key("home")
                        .child(
                            view()
                                .h(px(16.0))
                                .on_focus(move |_: &()| focused.set("A"))
                                .on_press(|_: &()| {})
                                .child(text("home A")),
                        )
                        .child(
                            view()
                                .h(px(16.0))
                                .opacity(move || if visible.get() { 1.0_f32 } else { 0.0_f32 })
                                .on_focus(move |_: &()| focused.set("B"))
                                .on_press(move |_: &()| {
                                    opens.update(|n| *n += 1);
                                    detail.set(true);
                                })
                                .child(text("open detail")),
                        ),
                )
                .child(when(detail, move || {
                    nsh_base::nav_page()
                        .key("detail")
                        .on_dismiss(move |_: &()| detail.set(false))
                        .child(
                            view()
                                .h(px(16.0))
                                .on_focus(move |_: &()| focused.set("detail"))
                                .on_press(move |_: &()| detail.set(false))
                                .child(text("detail button")),
                        )
                })),
        )
}

fn detail_page() -> (
    AppView,
    Terminal<TestBackend>,
    crossbeam_channel::Receiver<()>,
) {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<ReturningPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "home A");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus A");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus B");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "detail button");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus detail");
    (view, terminal, rx)
}

#[test]
fn returning_to_a_screen_restores_the_control_that_opened_the_next_page() {
    for close in ["Escape", "Enter"] {
        let (mut view, mut terminal, rx) = detail_page();
        key(&mut view, close, false);
        draw_until(&mut view, &mut terminal, &rx, "focus B");
        key(&mut view, "Enter", false);
        draw_until(&mut view, &mut terminal, &rx, "opens 2");
        draw_until(&mut view, &mut terminal, &rx, "detail button");
    }
}

#[test]
fn returning_to_a_screen_selects_its_first_control_when_the_saved_one_is_hidden() {
    let (mut view, mut terminal, rx) = detail_page();
    key(&mut view, "d", true);
    draw_until(&mut view, &mut terminal, &rx, "visible false");
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "focus A");
    assert_eq!(key(&mut view, "Enter", false), Handled::Yes);
}

#[component]
fn PagingFocus() -> impl IntoElement {
    focus_rows(px(48.0), 12)
}

#[component]
fn WheelFocus() -> impl IntoElement {
    focus_rows(px(96.0), 100)
}

fn focus_rows(height: nsh_core::Points, count: i32) -> impl IntoElement {
    let focused = signal(-1);
    let offset = signal(0);
    let pressed = signal(-1);
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
        .child(
            scroll()
                .w(px(160.0))
                .h(height)
                .on_scroll(move |event: &ScrollEvent| offset.set(event.offset.y.0 as i32))
                .children((0..count).map(|index| {
                    view()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_focus(move |_: &()| focused.set(index))
                        .on_press(move |_: &()| pressed.set(index))
                        .child(text(format!("row {index}")))
                })),
        )
}

#[test]
fn paging_keeps_the_relative_focus_row_and_endpoints_choose_first_and_last() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<PagingFocus>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus -1 offset 0");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus 0 offset 0");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus 1 offset 0");
    for (name, ctrl, expected) in [
        ("PageDown", false, "focus 4 offset 48"),
        ("Home", false, "focus 0 offset 0"),
        ("End", false, "focus 11 offset 144"),
        ("PageUp", false, "focus 8 offset 96"),
        ("v", true, "focus 11 offset 144"),
    ] {
        key(&mut view, name, ctrl);
        draw_until(&mut view, &mut terminal, &rx, expected);
    }
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "pressed 11");
}

fn wheel(view: &mut AppView, column: u16, row: u16, x: i16, y: i16, shift: bool) -> Handled {
    let mut input = nsh_platform_tui::MouseInput::default();
    input.column = column;
    input.row = row;
    input.kind = nsh_platform_tui::MouseKind::Wheel { x, y };
    input.modifiers = Modifiers {
        shift,
        ..Default::default()
    };
    view.handle(Input::Mouse(input))
}

#[test]
fn the_wheel_scrolls_the_pane_under_the_pointer_and_leaves_focus_where_it_is() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<WheelFocus>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus -1 offset 0");
    for index in 0..4 {
        key(&mut view, "Tab", false);
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            &format!("focus {index} offset 0"),
        );
    }
    assert_eq!(wheel(&mut view, 0, 2, 0, 1, false), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus 3 offset 48");
    wheel(&mut view, 0, 2, 0, 1, false);
    draw_until(&mut view, &mut terminal, &rx, "focus 3 offset 96");
    wheel(&mut view, 0, 2, 0, -1, false);
    draw_until(&mut view, &mut terminal, &rx, "focus 3 offset 48");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "focus 3 offset 48 pressed 3");
}

#[component]
fn NestedWheels() -> impl IntoElement {
    let inner = signal(0);
    let outer = signal(0);
    view()
        .flex_1()
        .child(text(move || format!("inner {} outer {}", inner.get(), outer.get())).h(px(16.0)))
        .child(
            scroll()
                .w(px(160.0))
                .h(px(48.0))
                .on_scroll(move |event: &ScrollEvent| outer.set(event.offset.y.0 as i32))
                .child(
                    scroll()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_scroll(move |event: &ScrollEvent| inner.set(event.offset.y.0 as i32))
                        .child(text("one\ntwo\nend").h(px(48.0)).flex_shrink_0()),
                )
                // Four rows: a box with content is its content's height.
                .child(view().flex_shrink_0().child(text("tail\n1\n2\n3"))),
        )
}

#[test]
fn the_wheel_uses_the_innermost_scroll_then_its_parent_at_the_end() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<NestedWheels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "inner 0 outer 0");
    for expected in ["inner 32 outer 0", "inner 32 outer 32"] {
        assert_eq!(wheel(&mut view, 0, 1, 0, 1, false), Handled::Yes);
        draw_until(&mut view, &mut terminal, &rx, expected);
    }
}

#[component]
fn HorizontalWheel() -> impl IntoElement {
    let offset = signal(0);
    view()
        .flex_1()
        .child(
            scroll()
                .horizontal()
                .w(px(24.0))
                .h(px(16.0))
                .on_scroll(move |event: &ScrollEvent| offset.set(event.offset.x.0 as i32))
                .child(text("ABCDEFGHIJKLMNOPQRST").w(px(160.0)).flex_shrink_0()),
        )
        .child(text(move || format!("horizontal {}", offset.get())))
}

#[test]
fn shift_wheel_and_horizontal_events_scroll_by_columns() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<HorizontalWheel>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "horizontal 0");
    assert_eq!(wheel(&mut view, 0, 0, 0, 1, true), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "horizontal 48");
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), "G");
    wheel(&mut view, 0, 0, 1, 0, false);
    draw_until(&mut view, &mut terminal, &rx, "horizontal 96");
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), "M");
    assert_eq!(
        key(&mut view, "Enter", false),
        Handled::Ignored,
        "wheel creates no focus when none existed"
    );
}

#[component]
fn DemoListNavigation() -> impl IntoElement {
    let detail = signal(false);
    let focused = signal(String::from("none"));
    let selected = signal(0);
    let opens = signal(0);
    let hide_sixth = signal(false);
    on_key("ctrl+d", move |_| hide_sixth.set(true));
    view()
        .flex_1()
        .child(
            text(move || {
                format!(
                    "focus {} opened {} times {} hidden {}",
                    focused.get(),
                    selected.get(),
                    opens.get(),
                    hide_sixth.get()
                )
            })
            .h(px(16.0)),
        )
        .child(
            nsh_base::nav_stack()
                .w(px(320.0))
                .h(px(128.0))
                .child(
                    nsh_base::nav_page().key("demos").child(
                        scroll()
                            .w(px(240.0))
                            .h(px(48.0))
                            .children((1..=20).map(move |index| {
                                view()
                                    .h(px(16.0))
                                    .flex_shrink_0()
                                    .opacity(move || {
                                        if index == 6 && hide_sixth.get() {
                                            0.0_f32
                                        } else {
                                            1.0_f32
                                        }
                                    })
                                    .on_focus(move |_: &()| focused.set(format!("row {index}")))
                                    .on_press(move |_: &()| {
                                        selected.set(index);
                                        opens.update(|n| *n += 1);
                                        detail.set(true);
                                    })
                                    .child(text(format!("demo {index}")))
                            })),
                    ),
                )
                .child(when(detail, move || {
                    nsh_base::nav_page()
                        .key("detail")
                        .on_dismiss(move |_: &()| detail.set(false))
                        .child(
                            view()
                                .h(px(16.0))
                                .on_focus(move |_: &()| focused.set("detail".into()))
                                .on_press(move |_: &()| detail.set(false))
                                .child(text("close detail")),
                        )
                })),
        )
}

/// The rows of the 30-column Scroll, its scroll bar's column left out.
fn demo_viewport(terminal: &Terminal<TestBackend>) -> Vec<String> {
    (1..4)
        .map(|row| {
            (0..29)
                .map(|column| terminal.backend().buffer()[(column, row)].symbol())
                .collect()
        })
        .collect()
}

#[test]
fn the_sixth_demo_regains_focus_and_its_scroll_position_after_returning() {
    for (back, ctrl) in [("Escape", false), ("g", true), ("Enter", false)] {
        let (mut view, rx) = surface();
        let mut terminal = Terminal::new(TestBackend::new(80, 16)).unwrap();
        view.load(App::Rust(Root::new::<DemoListNavigation>(|| ())))
            .unwrap();
        draw_until(&mut view, &mut terminal, &rx, "focus none");
        for row in 1..=6 {
            key(&mut view, "Tab", false);
            draw_until(&mut view, &mut terminal, &rx, &format!("focus row {row}"));
        }
        let before = demo_viewport(&terminal);
        assert!(before.iter().any(|line| line.trim() == "demo 6"));
        assert!(!before.iter().any(|line| line.trim() == "demo 1"));
        key(&mut view, "Enter", false);
        draw_until(&mut view, &mut terminal, &rx, "close detail");
        key(&mut view, "Tab", false);
        draw_until(&mut view, &mut terminal, &rx, "focus detail");
        key(&mut view, back, ctrl);
        draw_until(&mut view, &mut terminal, &rx, "focus row 6");
        assert_eq!(
            demo_viewport(&terminal),
            before,
            "the covered screen kept its Scroll"
        );
        key(&mut view, "Enter", false);
        draw_until(&mut view, &mut terminal, &rx, "opened 6 times 2");
    }
}

#[test]
fn returning_to_a_list_reveals_its_first_control_if_the_saved_row_is_hidden() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(80, 16)).unwrap();
    view.load(App::Rust(Root::new::<DemoListNavigation>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    for row in 1..=6 {
        key(&mut view, "Tab", false);
        draw_until(&mut view, &mut terminal, &rx, &format!("focus row {row}"));
    }
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "close detail");
    key(&mut view, "d", true);
    draw_until(&mut view, &mut terminal, &rx, "hidden true");
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "focus row 1");
    assert!(
        demo_viewport(&terminal)
            .iter()
            .any(|line| line.trim() == "demo 1")
    );
}

#[test]
fn paging_from_the_first_row_advances_a_page_and_meta_end_focuses_the_last_row() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<PagingFocus>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus -1 offset 0");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus 0 offset 0");
    key(&mut view, "v", true);
    draw_until(&mut view, &mut terminal, &rx, "focus 3 offset 48");
    assert_eq!(
        (0..5)
            .map(|x| terminal.backend().buffer()[(x, 1)].symbol())
            .collect::<String>(),
        "row 3"
    );
    view.handle(Input::Key {
        key: ">".into(),
        modifiers: Modifiers {
            alt: true,
            ..Default::default()
        },
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "focus 11 offset 144");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "pressed 11");
}

#[component]
fn EndpointControls() -> impl IntoElement {
    let focused = signal("none");
    view()
        .flex_1()
        .child(text(move || format!("focused {}", focused.get())).h(px(16.0)))
        .child(
            scroll()
                .w(px(240.0))
                .h(px(48.0))
                .child(
                    view()
                        .h(px(160.0))
                        .flex_shrink_0()
                        .child(text("before controls")),
                )
                .child(
                    view()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_focus(move |_: &()| focused.set("first"))
                        .on_press(|_: &()| {})
                        .child(text("first control")),
                )
                .child(
                    view()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_focus(move |_: &()| focused.set("last"))
                        .on_press(|_: &()| {})
                        .child(text("last control")),
                )
                .child(
                    view()
                        .h(px(160.0))
                        .flex_shrink_0()
                        .child(text("after controls")),
                ),
        )
}

#[test]
fn endpoints_reveal_the_first_and_last_controls_even_with_nonfocusable_content_around_them() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<EndpointControls>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focused none");
    key(&mut view, "End", false);
    draw_until(&mut view, &mut terminal, &rx, "focused last");
    assert!(
        demo_viewport(&terminal)
            .iter()
            .any(|line| line.trim() == "last control")
    );
    key(&mut view, "Home", false);
    draw_until(&mut view, &mut terminal, &rx, "focused first");
    assert!(
        demo_viewport(&terminal)
            .iter()
            .any(|line| line.trim() == "first control")
    );
}

#[component]
fn TextOnlyPage() -> impl IntoElement {
    let offset = signal(0);
    view()
        .flex_1()
        .child(text(move || format!("offset {}", offset.get())).h(px(16.0)))
        .child(
            scroll()
                .w(px(240.0))
                .h(px(48.0))
                .on_scroll(move |event: &ScrollEvent| offset.set(event.offset.y.0 as i32))
                // Twelve rows of text: a text is as tall as its lines.
                .child(
                    text(
                        std::iter::once("plain text".to_owned())
                            .chain((1..12).map(|row| row.to_string()))
                            .collect::<Vec<_>>()
                            .join("\n"),
                    )
                    .flex_shrink_0(),
                ),
        )
}

#[test]
fn paging_a_text_only_page_scrolls_without_creating_a_focus_request() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<TextOnlyPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "offset 0");
    for (name, offset) in [
        ("PageDown", "offset 48"),
        ("End", "offset 144"),
        ("Home", "offset 0"),
    ] {
        key(&mut view, name, false);
        draw_until(&mut view, &mut terminal, &rx, offset);
        assert_eq!(key(&mut view, "Enter", false), Handled::Ignored);
    }
}
