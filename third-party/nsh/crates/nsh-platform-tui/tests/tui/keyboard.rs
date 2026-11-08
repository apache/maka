use nsh_core::prelude::*;
use nsh_platform_tui::{App, Handled, Input, Modifiers, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::app::{draw_until, surface};

/// The Cell is in a focused control's reversed label (its `focus` style
/// fill is the GUI's and draws nothing).
fn focus_filled(buffer: &ratatui_core::buffer::Buffer, x: u16, y: u16) -> bool {
    buffer[(x, y)]
        .modifier
        .contains(ratatui_core::style::Modifier::REVERSED)
}

fn key(name: &str, modifiers: Modifiers) -> Input {
    Input::Key {
        key: name.into(),
        modifiers,
        release: false,
    }
}
fn ctrl(name: &str) -> Input {
    key(
        name,
        Modifiers {
            ctrl: true,
            ..Default::default()
        },
    )
}

#[component]
fn FocusPage() -> impl IntoElement {
    let focused = signal("none");
    let pressed = signal(String::new());
    let button = move |label: &'static str, x, y| {
        view()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(64.0))
            .h(px(16.0))
            .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
            .on_focus(move |_: &()| focused.set(label))
            .on_press_down(move |_: &()| pressed.update(|s| s.push('D')))
            .on_press_up(move |_: &()| pressed.update(|s| s.push('U')))
            .on_press(move |_: &()| pressed.update(|s| s.push('P')))
            .child(text(label))
    };
    view()
        .flex_1()
        .child(button("B", 80.0, 16.0))
        .child(button("A", 0.0, 16.0))
        .child(button("C", 0.0, 48.0))
        .child(
            text(move || format!("focus {} press {}", focused.get(), pressed.get()))
                .absolute()
                .top(px(80.0)),
        )
}

#[test]
fn tab_and_ctrl_keys_follow_tree_order_and_arrows_stay_spatial() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<FocusPage>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    for (input, focused, cursor) in [
        (ctrl("n"), "B", (10, 1)),
        (key("Left", Default::default()), "A", (0, 1)),
        (key("Down", Default::default()), "C", (0, 3)),
        (key("Up", Default::default()), "A", (0, 1)),
        (key("Down", Default::default()), "C", (0, 3)),
        (ctrl("p"), "A", (0, 1)),
        (key("Right", Default::default()), "B", (10, 1)),
        (key("Tab", Default::default()), "A", (0, 1)),
        (
            key(
                "Tab",
                Modifiers {
                    shift: true,
                    ..Default::default()
                },
            ),
            "B",
            (10, 1),
        ),
    ] {
        assert_eq!(view.handle(input), Handled::Yes);
        draw_until(&mut view, &mut terminal, &rx, &format!("focus {focused}"));
        assert!(!terminal.backend().cursor_visible());
        assert!(focus_filled(
            terminal.backend().buffer(),
            cursor.0,
            cursor.1
        ));
    }
    assert_eq!(view.handle(key("Enter", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "press DUP");
    assert_eq!(view.handle(key(" ", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "press DUPDUP");
    assert_eq!(
        view.handle(Input::Key {
            key: "Enter".into(),
            modifiers: Default::default(),
            release: true
        }),
        Handled::Ignored
    );
    view.set_focused(false);
    assert_eq!(view.handle(ctrl("n")), Handled::Ignored);
}

#[component]
fn ShortcutPage() -> impl IntoElement {
    let shortcuts = signal(0);
    let focus_count = signal(0);
    on_key("ctrl+n", move |_| shortcuts.update(|n| *n += 1));
    view()
        .flex_1()
        .child(
            view()
                .h(px(16.0))
                .on_press(|_: &()| {})
                .on_focus(move |_: &()| focus_count.update(|n| *n += 1))
                .child(text("button")),
        )
        .child(text(move || {
            format!("shortcuts {} focus {}", shortcuts.get(), focus_count.get())
        }))
}

#[test]
fn app_shortcuts_win_over_the_terminal_scheme() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<ShortcutPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "shortcuts 0 focus 0");
    assert_eq!(view.handle(ctrl("n")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "shortcuts 1 focus 0");
    assert_eq!(view.handle(key("Tab", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "shortcuts 1 focus 1");
}

#[component]
fn ScrollKeys() -> impl IntoElement {
    let target = element_ref();
    let offset = signal(0);
    let chosen = signal(-1);
    on_key("ctrl+r", move |_| {
        target.scroll_to(nsh_core::Point::default(), false)
    });
    view()
        .flex_1()
        .child(text(move || format!("offset {} chosen {}", offset.get(), chosen.get())).h(px(16.0)))
        .child(
            scroll()
                .element_ref(&target)
                .w(px(160.0))
                .h(px(32.0))
                .on_scroll(move |event: &ScrollEvent| offset.set(event.offset.y.0 as i32))
                .children((0..6).map(|index| {
                    view()
                        .h(px(16.0))
                        .flex_shrink_0()
                        .on_press(move |_: &()| chosen.set(index))
                        .child(text(format!("Item{index}")))
                })),
        )
}

#[test]
fn focus_reveals_scroll_content_and_page_keys_keep_the_core_offset_protocol() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<ScrollKeys>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "offset 0 chosen -1");
    for _ in 0..3 {
        assert_eq!(view.handle(ctrl("n")), Handled::Yes);
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    assert_eq!(view.handle(key("Enter", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "chosen 2");
    assert!((1..3).any(|row| terminal.backend().buffer()[(0, row)].symbol() == "I"));
    for (input, expected) in [
        (key("Home", Default::default()), "offset 0"),
        (ctrl("v"), "offset 32"),
        (key("PageUp", Default::default()), "offset 0"),
        (
            key(
                ">",
                Modifiers {
                    alt: true,
                    ..Default::default()
                },
            ),
            "offset 64",
        ),
        (
            key(
                "<",
                Modifiers {
                    alt: true,
                    ..Default::default()
                },
            ),
            "offset 0",
        ),
        (key("PageDown", Default::default()), "offset 32"),
        (
            key(
                "v",
                Modifiers {
                    alt: true,
                    ..Default::default()
                },
            ),
            "offset 0",
        ),
        (key("End", Default::default()), "offset 64"),
        (ctrl("r"), "offset 0"),
    ] {
        assert_eq!(view.handle(input), Handled::Yes);
        // Render before looking for a value that may equal the preceding frame's.
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        draw_until(&mut view, &mut terminal, &rx, expected);
    }
}

#[test]
fn arrows_move_down_a_scroll_view_and_scroll_it_to_the_next_control() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<ScrollKeys>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "offset 0 chosen -1");
    for _ in 0..3 {
        assert_eq!(view.handle(key("Down", Default::default())), Handled::Yes);
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    // Item2 was one row below the view: it scrolled into sight.
    draw_until(&mut view, &mut terminal, &rx, "offset 16");
    assert_eq!(view.handle(key(" ", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "chosen 2");
    assert_eq!(view.handle(key("Up", Default::default())), Handled::Yes);
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert_eq!(view.handle(key("Up", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "offset 0");
}

#[component]
fn ArrowSlider() -> impl IntoElement {
    let value = signal(nsh_base::SliderValue::Single(60.0));
    let presses = signal(0);
    view()
        .flex_1()
        .child(
            nsh_base::slider()
                .w(px(160.0))
                .value(move || Some(value.get()))
                .step(5.0)
                .track_class("h-8")
                .thumb_class("w-4 h-2 bg-[#abcdef] focus:bg-[#654321]")
                .on_change(move |next: &nsh_base::SliderValue| value.set(*next)),
        )
        .child(
            nsh_base::button()
                .h(px(16.0))
                .on_press(move |_: &()| presses.update(|n| *n += 1))
                .child(text("below")),
        )
        .child(text(move || {
            format!("value {} presses {}", value.get().end(), presses.get())
        }))
}

#[test]
fn a_focused_component_gets_arrows_before_spatial_focus_movement() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 8)).unwrap();
    view.load(App::Rust(Root::new::<ArrowSlider>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "value 60 presses 0");
    let idle = super::controls::thumb_color(&terminal).expect("the thumb is drawn");
    view.handle(key("Tab", Default::default()));
    super::controls::wait_for_thumb_focus(&mut view, &mut terminal, &rx, idle);
    // The slider consumes Down: its value steps and focus stays on the thumb, so the
    // button below it is not pressed by Enter.
    assert_eq!(view.handle(key("Down", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "value 55 presses 0");
    // Ctrl+F and Ctrl+B are the terminal's Right and Left: the slider's own
    // bindings of the arrows answer them, before they move the focus.
    assert_eq!(view.handle(ctrl("f")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "value 60 presses 0");
    assert_eq!(view.handle(ctrl("b")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "value 55 presses 0");
    view.handle(key("Enter", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "value 55 presses 0");
    view.handle(key("Tab", Default::default()));
    view.handle(key("Enter", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "value 55 presses 1");
}

#[component]
fn BackPage() -> impl IntoElement {
    let requests = signal(0);
    let dismisses = signal(0);
    let prevent = signal(true);
    view()
        .flex_1()
        .child(
            text(move || {
                format!(
                    "back {} dismiss {} prevent {}",
                    requests.get(),
                    dismisses.get(),
                    prevent.get()
                )
            })
            .h(px(16.0)),
        )
        .child(
            nsh_base::nav_stack()
                .w(px(160.0))
                .h(px(64.0))
                .child(nsh_base::nav_page().key("home").child(text("home")))
                .child(
                    nsh_base::nav_page()
                        .key("top")
                        .pop_on_back(move || !prevent.get())
                        .on_back_press(move |_: &()| requests.update(|n| *n += 1))
                        .on_dismiss(move |_: &()| dismisses.update(|n| *n += 1))
                        .child(
                            view()
                                .h(px(16.0))
                                .on_press(move |_: &()| prevent.set(false))
                                .child(text("allow back")),
                        ),
                ),
        )
}

#[test]
fn cancel_reports_back_requests_respects_prevent_back_and_dismisses_once() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<BackPage>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "allow back");
    assert_eq!(view.handle(key("Escape", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "back 1 dismiss 0");
    assert_eq!(view.handle(ctrl("n")), Handled::Yes);
    assert_eq!(view.handle(key("Enter", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "prevent false");
    assert_eq!(view.handle(ctrl("g")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "back 2 dismiss 1");
    draw_until(&mut view, &mut terminal, &rx, "home");
    assert_eq!(view.handle(ctrl("g")), Handled::Ignored);
}

#[component]
fn RootBack() -> impl IntoElement {
    let intercepted = signal(0);
    on_back_press(move || {
        intercepted.update(|n| *n += 1);
        true
    });
    view()
        .flex_1()
        .child(text(move || format!("intercepted {}", intercepted.get())).h(px(16.0)))
        .child(
            nsh_base::nav_stack()
                .w(px(160.0))
                .h(px(64.0))
                .child(nsh_base::nav_page().child(text("home")))
                .child(nsh_base::nav_page().child(text("still top"))),
        )
}

#[test]
fn the_app_back_handler_wins_before_a_stack_pop() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<RootBack>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "still top");
    assert_eq!(view.handle(key("Escape", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "intercepted 1");
    assert!(
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
            .contains("still top")
    );
}

#[component]
fn ModalKeys() -> impl IntoElement {
    let root_pressed = signal(0);
    let modal_pressed = signal(0);
    let cancelled = signal(0);
    let dismissed = signal(0);
    let close = signal(false);
    view()
        .flex_1()
        .child(
            view()
                .h(px(16.0))
                .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                .on_press(move |_: &()| root_pressed.update(|n| *n += 1))
                .child(text("root button")),
        )
        .child(text(move || {
            format!(
                "root {} cancelled {} dismissed {}",
                root_pressed.get(),
                cancelled.get(),
                dismissed.get()
            )
        }))
        .child(
            nsh_base::dialog()
                .close_on_escape(close)
                .on_cancel(move |_: &()| cancelled.update(|n| *n += 1))
                .on_close(move |_: &()| dismissed.update(|n| *n += 1))
                .child(
                    view()
                        .absolute()
                        .top(px(48.0))
                        .h(px(16.0))
                        .w(px(160.0))
                        .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                        .on_press(move |_: &()| {
                            modal_pressed.update(|n| *n += 1);
                            close.set(true);
                        })
                        .child(text("modal button")),
                )
                .child(
                    text(move || {
                        format!("modal {} cancel {}", modal_pressed.get(), cancelled.get())
                    })
                    .absolute()
                    .top(px(80.0)),
                ),
        )
}

#[test]
fn modal_focus_is_scoped_and_cancel_honors_close_on_escape() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(50, 10)).unwrap();
    view.load(App::Rust(Root::new::<ModalKeys>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "modal button");
    assert_eq!(view.handle(key("Escape", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "modal 0 cancel 1");
    assert_eq!(view.handle(ctrl("n")), Handled::Yes);
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    draw_focused_cell(&mut view, &mut terminal, &rx, (0, 3));
    assert!(!terminal.backend().cursor_visible());
    assert_eq!(view.handle(key("Enter", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "modal 1 cancel 1");
    assert_eq!(view.handle(ctrl("g")), Handled::Yes);
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "root 0 cancelled 2 dismissed 1",
    );
    assert_eq!(view.handle(key("Tab", Default::default())), Handled::Yes);
    assert_eq!(view.handle(key("Enter", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "root 1");
}

#[test]
fn a_known_key_repeat_does_not_refire_a_nonrepeating_app_shortcut() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<ShortcutPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "shortcuts 0 focus 0");
    view.handle(ctrl("n"));
    draw_until(&mut view, &mut terminal, &rx, "shortcuts 1 focus 0");
    assert_eq!(
        view.handle(Input::KeyRepeat {
            key: "n".into(),
            modifiers: Modifiers {
                ctrl: true,
                ..Default::default()
            }
        }),
        Handled::Yes
    );
    view.handle(key("Tab", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "shortcuts 1 focus 1");
}

#[component]
fn EditableFocus() -> impl IntoElement {
    let focus = signal("none");
    view()
        .flex_1()
        .child(
            view()
                .h(px(16.0))
                .disabled(true)
                .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                .on_press(|_: &()| {})
                .child(text("disabled")),
        )
        .child(
            nsh_base::input()
                .h(px(32.0))
                .on_focus(move |_: &()| focus.set("input")),
        )
        .child(
            view()
                .h(px(16.0))
                .focusable(false)
                .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                .on_press(|_: &()| {})
                .child(text("skip")),
        )
        .child(
            view()
                .h(px(16.0))
                .on_focus(move |_: &()| focus.set("button"))
                .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                .on_press(|_: &()| {})
                .child(text("button")),
        )
        .child(text(move || format!("focus {0}", focus.get())))
}

#[test]
fn focus_visits_editable_fields_and_skips_disabled_or_opted_out_views() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<EditableFocus>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    view.handle(ctrl("n"));
    draw_until(&mut view, &mut terminal, &rx, "focus input");
    terminal.backend_mut().assert_cursor_position((0, 1));
    // Enter submits and leaves the field; Tab goes on from it, past the
    // opted-out view, to the button.
    assert_eq!(view.handle(key("Enter", Default::default())), Handled::Yes);
    view.handle(key("Tab", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "focus button");
    assert!(!terminal.backend().cursor_visible());
    // Back to the field, past the disabled view at the top.
    view.handle(key(
        "Tab",
        Modifiers {
            shift: true,
            ..Default::default()
        },
    ));
    draw_until(&mut view, &mut terminal, &rx, "focus input");
    terminal.backend_mut().assert_cursor_position((0, 1));
}

#[component]
fn NestedBack() -> impl IntoElement {
    let app = signal(0);
    let outer = signal(0);
    let inner = signal(0);
    on_back_press(move || {
        app.update(|n| *n += 1);
        false
    });
    view()
        .flex_1()
        .child(
            text(move || format!("app{} outer{} inner{}", app.get(), outer.get(), inner.get()))
                .h(px(16.0)),
        )
        .child(
            nsh_base::nav_stack()
                .w(px(160.0))
                .h(px(96.0))
                .child(
                    nsh_base::nav_page()
                        .key("outer-base")
                        .child(text("outer base")),
                )
                .child(
                    nsh_base::nav_page()
                        .key("outer-top")
                        .on_dismiss(move |_: &()| outer.update(|n| *n += 1))
                        .child(text("outer top").h(px(16.0)))
                        .child(
                            nsh_base::nav_stack()
                                .w(px(160.0))
                                .h(px(64.0))
                                .child(
                                    nsh_base::nav_page()
                                        .key("inner-base")
                                        .child(text("inner base")),
                                )
                                .child(
                                    nsh_base::nav_page()
                                        .key("inner-top")
                                        .on_dismiss(move |_: &()| inner.update(|n| *n += 1))
                                        .child(text("inner top")),
                                ),
                        ),
                ),
        )
}

#[test]
fn an_unhandled_app_back_request_pops_the_innermost_stack_then_its_parent() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<NestedBack>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "inner top");
    view.handle(ctrl("g"));
    draw_until(&mut view, &mut terminal, &rx, "app1 outer0 inner1");
    draw_until(&mut view, &mut terminal, &rx, "inner base");
    view.handle(key("Escape", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "app2 outer1 inner1");
    draw_until(&mut view, &mut terminal, &rx, "outer base");
}

#[component]
fn TwoModals() -> impl IntoElement {
    let closed = signal(0);
    view()
        .flex_1()
        .child(text(move || format!("closed {}", closed.get())))
        .child(
            nsh_base::dialog().child(
                view()
                    .absolute()
                    .top(px(48.0))
                    .w(px(80.0))
                    .h(px(16.0))
                    .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                    .on_press(|_: &()| {})
                    .child(text("first")),
            ),
        )
        .child(
            nsh_base::dialog()
                .on_close(move |_: &()| closed.set(1))
                .child(
                    view()
                        .absolute()
                        .top(px(80.0))
                        .w(px(80.0))
                        .h(px(16.0))
                        .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                        .on_press(|_: &()| {})
                        .child(text("second")),
                ),
        )
}

#[test]
fn only_the_newest_modal_supplies_focus_candidates() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<TwoModals>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "second");
    view.handle(ctrl("n"));
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    draw_focused_cell(&mut view, &mut terminal, &rx, (0, 5));
    assert!(!terminal.backend().cursor_visible());
    view.handle(ctrl("g"));
    draw_until(&mut view, &mut terminal, &rx, "closed 1");
    view.handle(ctrl("n"));
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    draw_focused_cell(&mut view, &mut terminal, &rx, (0, 3));
    assert!(!terminal.backend().cursor_visible());
}

#[cfg(feature = "js")]
#[test]
fn enter_reports_a_press_at_the_focused_views_middle() {
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, signal, View, Text } from "nsh";
        const result = signal("waiting");
        mount(() => <View style={{ flex: 1 }}>
            <View style={{ position: "absolute", left: 16, top: 16, width: 80, height: 32 }}
                onPress={(e) => result.set(`${e.position.x},${e.position.y} at ${e.pagePosition.x},${e.pagePosition.y}`)}>
                <Text>button</Text>
            </View>
            <Text style={{ position: "absolute", top: 80 }}>{result()}</Text>
        </View>);
    "#, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(nsh_platform_tui::Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "waiting");
    view.handle(ctrl("n"));
    assert_eq!(view.handle(key("Enter", Default::default())), Handled::Yes);
    // A box with content is one row: its middle is half a row down.
    draw_until(&mut view, &mut terminal, &rx, "40,8 at 56,24");
}

#[component]
fn LaterModal() -> impl IntoElement {
    let later = signal(false);
    view()
        .flex_1()
        .child(when(later, || {
            nsh_base::dialog().child(
                view()
                    .absolute()
                    .top(px(80.0))
                    .w(px(80.0))
                    .h(px(16.0))
                    .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                    .on_press(|_: &()| {})
                    .child(text("new modal")),
            )
        }))
        .child(
            nsh_base::dialog().child(
                view()
                    .absolute()
                    .top(px(48.0))
                    .w(px(80.0))
                    .h(px(16.0))
                    .focus(|style| style.bg(nsh_core::color::rgb(0x123456)))
                    .on_press(move |_: &()| later.set(true))
                    .child(text("open modal")),
            ),
        )
}

#[test]
fn a_later_modal_takes_focus_even_when_inserted_before_the_existing_one() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<LaterModal>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "open modal");
    view.handle(ctrl("n"));
    view.handle(key("Enter", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "new modal");
    view.handle(ctrl("n"));
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    draw_focused_cell(&mut view, &mut terminal, &rx, (0, 5));
    assert!(!terminal.backend().cursor_visible());
}

#[cfg(feature = "dev")]
#[test]
fn the_diagnostics_panel_owns_repeated_keys_and_preserves_app_focus() {
    let path = std::env::temp_dir().join(format!(
        "nsh-keyboard-diagnostics-{}.log",
        std::process::id()
    ));
    std::fs::write(
        &path,
        (0..30)
            .map(|line| format!("Log{line:02}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let (mut view, rx) = surface();
    view.set_dev_log_path(path.clone());
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<FocusPage>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    view.handle(ctrl("n"));
    draw_until(&mut view, &mut terminal, &rx, "focus B");
    view.handle(ctrl("h"));
    view.handle(key("e", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "Logs and errors");
    view.handle(key("Home", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "Log00");
    view.handle(Input::KeyRepeat {
        key: "Down".into(),
        modifiers: Default::default(),
    });
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert_eq!(
        (0..5)
            .map(|x| terminal.backend().buffer()[(x, 1)].symbol())
            .collect::<String>(),
        "Log01"
    );
    view.handle(key("Escape", Default::default()));
    draw_until(&mut view, &mut terminal, &rx, "focus B");
    assert!(!terminal.backend().cursor_visible());
    assert!(focus_filled(terminal.backend().buffer(), 10, 1));
    view.stop();
    std::fs::remove_file(path).unwrap();
}

fn draw_focused_cell(
    view: &mut nsh_platform_tui::AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    at: (u16, u16),
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if focus_filled(terminal.backend().buffer(), at.0, at.1) {
            return;
        }
        rx.recv_deadline(deadline).expect("the focus style");
    }
}

#[component]
fn CursorPage() -> impl IntoElement {
    let focused = signal("none");
    view()
        .flex_1()
        .child(
            view()
                .h(px(16.0))
                .on_focus(move |_: &()| focused.set("button"))
                .on_press(|_: &()| {})
                .child(text("button")),
        )
        .child(
            nsh_base::input()
                .h(px(32.0))
                .on_focus(move |_: &()| focused.set("field")),
        )
        .child(
            nsh_base::input()
                .h(px(32.0))
                .caret(false)
                .on_focus(move |_: &()| focused.set("hidden caret")),
        )
        .child(text(move || format!("focused {}", focused.get())))
}

#[test]
fn only_an_editable_field_with_a_visible_caret_shows_the_terminal_cursor() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<CursorPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focused none");
    view.handle(ctrl("n"));
    draw_until(&mut view, &mut terminal, &rx, "focused button");
    assert!(!terminal.backend().cursor_visible());
    view.handle(ctrl("n"));
    draw_until(&mut view, &mut terminal, &rx, "focused field");
    assert!(terminal.backend().cursor_visible());
    terminal.backend_mut().assert_cursor_position((0, 1));
    view.handle(ctrl("n"));
    draw_until(&mut view, &mut terminal, &rx, "focused hidden caret");
    assert!(!terminal.backend().cursor_visible());
}

/// A wide control over a narrow one in its column, and a nearer one beside
/// that column; and a popup anchored under a trigger, open from the start.
#[component]
fn ColumnsPage() -> impl IntoElement {
    let focused = signal("none");
    let anchor = element_ref();
    let button = move |label: &'static str, x, y, w| {
        view()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(w))
            .h(px(16.0))
            .on_focus(move |_: &()| focused.set(label))
            .on_press(|_: &()| {})
            .child(text(label))
    };
    view()
        .flex_1()
        .child(button("T", 0.0, 0.0, 64.0))
        .child(button("N", 160.0, 16.0, 64.0))
        .child(button("O", 0.0, 64.0, 64.0))
        .child(
            view()
                .absolute()
                .left(px(240.0))
                .top(px(0.0))
                .w(px(64.0))
                .h(px(16.0))
                .element_ref(&anchor)
                .child(text("Open")),
        )
        .child(
            overlay()
                .anchor(&anchor)
                .placement(nsh_core::overlay::Placement::Bottom)
                .w(px(64.0))
                .child(
                    view()
                        .h(px(16.0))
                        .on_focus(move |_: &()| focused.set("P"))
                        .on_press(|_: &()| {})
                        .child(text("Item")),
                ),
        )
        .child(
            text(move || format!("focus {}", focused.get()))
                .absolute()
                .top(px(128.0)),
        )
}

#[test]
fn down_enters_an_open_popup_then_keeps_to_the_column() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 10)).unwrap();
    view.load(App::Rust(Root::new::<ColumnsPage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    // Nothing focused: the popup's item before the page's first control.
    assert_eq!(view.handle(key("Down", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus P");
    // From T, the control below in its column, past a nearer one beside it.
    assert_eq!(view.handle(ctrl("p")), Handled::Yes);
    assert_eq!(view.handle(ctrl("p")), Handled::Yes);
    assert_eq!(view.handle(ctrl("p")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus T");
    assert_eq!(view.handle(key("Down", Default::default())), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "focus O");
}

/// A control adding its label to `seen` when it takes the focus.
fn stop(label: &'static str, seen: Signal<String>) -> impl IntoElement {
    view()
        .on_focus(move |_: &()| seen.update(|s| s.push_str(&format!(" {label}"))))
        .on_press(|_: &()| {})
        .child(text(label))
}

/// A date picker open from the start between two controls: its calendar
/// takes the focus as it opens.
#[component]
fn PickerBetween() -> impl IntoElement {
    let seen = signal(String::new());
    view()
        .flex_1()
        .child(text(move || format!("seen{}.", seen.get())))
        .child(stop("Before", seen))
        .child(
            nsh_base::date_picker()
                .accessibility_label("Due")
                .default_open(true)
                .trigger(
                    view()
                        .w(px(160.0))
                        .on_focus(move |_: &()| seen.update(|s| s.push_str(" trigger")))
                        .child(text("Pick")),
                ),
        )
        .child(stop("After", seen))
}

#[test]
fn tab_stays_in_an_open_popup_until_escape_closes_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
    view.load(App::Rust(Root::new::<PickerBetween>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "28");
    // Round the calendar's controls both ways: the popup covers the page,
    // so neither its trigger nor the page's controls take the focus unseen.
    let shift = Modifiers {
        shift: true,
        ..Default::default()
    };
    for modifiers in [Modifiers::default(), shift] {
        for _ in 0..16 {
            assert_eq!(view.handle(key("Tab", modifiers)), Handled::Yes);
            terminal
                .draw(|frame| view.render(frame, frame.area()))
                .unwrap();
        }
    }
    // Escape closes it and gives the focus back to its trigger; Tab goes on.
    view.handle(key("Escape", Modifiers::default()));
    draw_until(&mut view, &mut terminal, &rx, "seen trigger.");
    view.handle(key("Tab", Modifiers::default()));
    draw_until(&mut view, &mut terminal, &rx, "seen trigger After.");
}

/// A menu whose trigger has a tall stop beside it, level with the menu's
/// items; what took the focus or was chosen, on screen.
#[component]
fn MenuBeside() -> impl IntoElement {
    let seen = signal(String::new());
    view()
        .flex_1()
        .child(text(move || format!("seen{}.", seen.get())))
        .child(
            view()
                .flex_row()
                .child(
                    nsh_base::menu()
                        .trigger(view().w(px(80.0)).child(text("File")))
                        .child(
                            nsh_base::menu_item()
                                .on_select(move || seen.update(|s| s.push_str(" chose New")))
                                .child(text("New")),
                        )
                        .child(nsh_base::menu_item().child(text("Open"))),
                )
                .child(view().w(px(80.0)))
                .child(
                    view()
                        .h(px(200.0))
                        .on_focus(move |_: &()| seen.update(|s| s.push_str(" Beside")))
                        .on_press(|_: &()| {})
                        .child(text("Beside")),
                ),
        )
}

#[test]
fn left_and_right_stay_in_an_open_menu() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    view.load(App::Rust(Root::new::<MenuBeside>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Beside");
    let none = Modifiers::default();
    // Return on the trigger opens the menu, its first item focused.
    view.handle(key("Tab", none));
    view.handle(key("Enter", none));
    draw_until(&mut view, &mut terminal, &rx, "Open");
    // The stop beside the items is level with them: Right and Left on an
    // item with no submenu leave the focus on it, the menu open.
    for name in ["Right", "Left", "Right"] {
        view.handle(key(name, none));
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    view.handle(key("Enter", none));
    draw_until(&mut view, &mut terminal, &rx, "seen chose New.");
}

/// A menu with a submenu `Recent` of two items between `New` and `Quit`;
/// what was chosen, on screen in lower case (so the items' names show only
/// in the menu).
#[component]
fn MenuWithSubmenu() -> impl IntoElement {
    let seen = signal(String::new());
    let item = move |name: &'static str| {
        nsh_base::menu_item()
            .on_select(move || {
                seen.update(|s| s.push_str(&format!(" chose {}", name.to_lowercase())))
            })
            .child(text(name))
    };
    view()
        .flex_1()
        .child(text(move || format!("seen{}.", seen.get())))
        .child(
            nsh_base::menu()
                .trigger(view().w(px(80.0)).child(text("File")))
                .child(item("New"))
                .child(
                    nsh_base::submenu()
                        .trigger(view().child(text("Recent")))
                        .child(item("Alpha"))
                        .child(item("Beta")),
                )
                .child(item("Quit")),
        )
}

#[test]
fn right_and_return_open_a_submenu_at_its_first_item_and_left_and_escape_leave_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    view.load(App::Rust(Root::new::<MenuWithSubmenu>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "File");
    let none = Modifiers::default();
    // Down changes focus on the engine thread. Wait for the focus mark
    // and key bindings to reach the surface before sending the next key.
    let down_to =
        |view: &mut nsh_platform_tui::AppView, terminal: &mut Terminal<TestBackend>, item: &str| {
            view.handle(key("Down", none));
            super::app::draw_until_true(view, terminal, &rx, item, |terminal| {
                super::dock::find(terminal, item)
                    .is_some_and(|(x, y)| super::app::reversed(terminal.backend().buffer(), x, y))
            });
        };
    // The menu opens at `New`; Down reaches the submenu's trigger, Right
    // opens it with the focus on `Alpha`, which Return chooses.
    view.handle(key("Tab", none));
    view.handle(key("Enter", none));
    draw_until(&mut view, &mut terminal, &rx, "Quit");
    down_to(&mut view, &mut terminal, "Recent");
    view.handle(key("Right", none));
    draw_until(&mut view, &mut terminal, &rx, "Alpha");
    view.handle(key("Enter", none));
    draw_until(&mut view, &mut terminal, &rx, "seen chose alpha.");
    super::app::draw_until_gone(&mut view, &mut terminal, &rx, "Quit");
    // Return on the trigger opens it too; Left closes it with the focus
    // back on the trigger, the menu open, so Right opens it again.
    view.handle(key("Enter", none));
    draw_until(&mut view, &mut terminal, &rx, "Quit");
    down_to(&mut view, &mut terminal, "Recent");
    view.handle(key("Enter", none));
    draw_until(&mut view, &mut terminal, &rx, "Alpha");
    view.handle(key("Left", none));
    super::app::draw_until_gone(&mut view, &mut terminal, &rx, "Alpha");
    assert!(
        super::dock::find(&terminal, "Quit").is_some(),
        "the menu stays open"
    );
    view.handle(key("Right", none));
    draw_until(&mut view, &mut terminal, &rx, "Alpha");
    // Escape closes only the submenu, the focus back on its trigger:
    // Return opens it again, Down and Return choose `Beta`.
    view.handle(key("Escape", none));
    super::app::draw_until_gone(&mut view, &mut terminal, &rx, "Alpha");
    assert!(
        super::dock::find(&terminal, "Quit").is_some(),
        "the menu stays open"
    );
    view.handle(key("Enter", none));
    draw_until(&mut view, &mut terminal, &rx, "Alpha");
    down_to(&mut view, &mut terminal, "Beta");
    view.handle(key("Enter", none));
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "seen chose alpha chose beta.",
    );
}

/// A paragraph with two links, and a stop after it; what the links
/// reported and where the focus came, on screen.
#[component]
fn DocumentLinks() -> impl IntoElement {
    let pressed = signal(Vec::<String>::new());
    let after = signal(false);
    view()
        .flex_1()
        .child(
            nsh_base::text_view()
                .markdown("Read [the guide](https://example.com/guide) or [the notes](#notes).")
                .on_link_press(move |e: &nsh_base::TextViewLinkPressEvent| {
                    let url = e.url.to_string();
                    pressed.update(|p| p.push(url));
                }),
        )
        .child(
            view()
                .focusable(true)
                .on_focus(move || after.set(true))
                .child(text("After")),
        )
        .child(text(move || {
            format!("Pressed: {}", pressed.get().join(" "))
        }))
        .child(text(move || format!("After focused: {}", after.get())))
}

#[test]
fn tab_reaches_a_texts_links_in_order_shows_the_focused_one_and_return_presses_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<DocumentLinks>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "the guide");
    let none = Modifiers::default();
    view.handle(key("Tab", none));
    view.handle(key("Enter", none));
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "Pressed: https://example.com/guide",
    );
    // The focused link's characters are reversed, the other's not.
    let (x, y) = super::dock::find(&terminal, "the guide").unwrap();
    assert!(focus_filled(terminal.backend().buffer(), x, y));
    let (nx, ny) = super::dock::find(&terminal, "the notes").unwrap();
    assert!(!focus_filled(terminal.backend().buffer(), nx, ny));
    view.handle(key("Tab", none));
    view.handle(key("Enter", none));
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "Pressed: https://example.com/guide #notes",
    );
    assert!(focus_filled(terminal.backend().buffer(), nx, ny));
    assert!(
        super::dock::dump(&terminal).contains("After focused: false"),
        "the links came first"
    );
    view.handle(key("Tab", none));
    draw_until(&mut view, &mut terminal, &rx, "After focused: true");
    // Back from the stop after it: the last link.
    view.handle(key(
        "Tab",
        Modifiers {
            shift: true,
            ..Default::default()
        },
    ));
    view.handle(key("Enter", none));
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "Pressed: https://example.com/guide #notes #notes",
    );
}
