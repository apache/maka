use nsh_core::prelude::*;
use nsh_platform_tui::{App, AppView, Handled, Input, Modifiers, MouseButton, MouseKind, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::app::{draw_until, draw_until_still, mouse, surface};

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
fn FocusFlow() -> impl IntoElement {
    let open = signal(false);
    let nested = signal(false);
    let exists = signal(true);
    let visible = signal(true);
    let backdrop = signal(false);
    let focused = signal("none");
    let root_hits = signal(0);
    let cancelled = signal(0);
    on_key("ctrl+d", move |_| exists.set(false));
    on_key("ctrl+u", move |_| visible.set(false));
    on_key("ctrl+l", move |_| backdrop.set(true));
    on_key("ctrl+r", move |_| open.set(false));
    view()
        .flex_1()
        .child(
            view()
                .h(px(16.0))
                .on_focus(move |_: &()| focused.set("before"))
                .on_blur(move |_: &()| focused.set("none"))
                .on_press(move |_: &()| root_hits.update(|n| *n += 1))
                .child(text("before")),
        )
        .child(when(exists, move || {
            view()
                .absolute()
                .top(px(16.0))
                .w(px(160.0))
                .h(px(16.0))
                .opacity(move || if visible.get() { 1.0_f32 } else { 0.0_f32 })
                .on_focus(move |_: &()| focused.set("opener"))
                .on_blur(move |_: &()| focused.set("none"))
                .on_press(move |_: &()| open.set(true))
                .child(text("opener"))
        }))
        .child(
            text(move || format!("focus {}", focused.get()))
                .absolute()
                .top(px(32.0)),
        )
        .child(
            text(move || {
                format!(
                    "exists {} visible {} root {} cancel {} backdrop {}",
                    exists.get(),
                    visible.get(),
                    root_hits.get(),
                    cancelled.get(),
                    backdrop.get()
                )
            })
            .absolute()
            .top(px(48.0)),
        )
        .child(when(open, move || {
            nsh_base::dialog()
                .pointer_events(nsh_core::PointerEvents::BoxNone)
                .close_on_backdrop_press(backdrop)
                .on_cancel(move |_: &()| cancelled.update(|n| *n += 1))
                .on_close(move |_: &()| open.set(false))
                .child(
                    view()
                        .absolute()
                        .top(px(112.0))
                        .w(px(160.0))
                        .h(px(16.0))
                        .on_focus(move |_: &()| focused.set("first"))
                        .on_blur(move |_: &()| focused.set("none"))
                        .on_press(move |_: &()| nested.set(true))
                        .child(text("first")),
                )
                .child(
                    view()
                        .absolute()
                        .top(px(96.0))
                        .w(px(160.0))
                        .h(px(16.0))
                        .on_focus(move |_: &()| focused.set("second"))
                        .on_blur(move |_: &()| focused.set("none"))
                        .on_press(move |_: &()| open.set(false))
                        .child(text("second")),
                )
                .child(when(nested, move || {
                    nsh_base::dialog()
                        .close_on_backdrop_press(false)
                        .pointer_events(nsh_core::PointerEvents::BoxNone)
                        .on_cancel(move |_: &()| cancelled.update(|n| *n += 1))
                        .on_close(move |_: &()| nested.set(false))
                        .child(
                            view()
                                .absolute()
                                .top(px(160.0))
                                .w(px(160.0))
                                .h(px(16.0))
                                .on_focus(move |_: &()| focused.set("inner"))
                                .on_blur(move |_: &()| focused.set("none"))
                                .on_press(move |_: &()| nested.set(false))
                                .child(text("inner")),
                        )
                }))
        }))
}

fn open_modal() -> (
    AppView,
    Terminal<TestBackend>,
    crossbeam_channel::Receiver<()>,
) {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
    view.load(App::Rust(Root::new::<FocusFlow>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus before");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus opener");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "focus first");
    (view, terminal, rx)
}

#[test]
fn presenting_a_modal_focuses_its_first_tree_stop_and_closing_restores_the_opener() {
    let (mut view, mut terminal, rx) = open_modal();
    assert!(!terminal.backend().cursor_visible());
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus second");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus first");
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "focus opener");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "focus first");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus second");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "focus opener");
}

#[test]
fn nested_modals_restore_focus_in_reverse_presentation_order() {
    let (mut view, mut terminal, rx) = open_modal();
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "focus inner");
    key(&mut view, "Tab", false);
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "focus first");
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "focus opener");
}

#[test]
fn removing_two_open_modals_restores_the_page_focus() {
    let (mut view, mut terminal, rx) = open_modal();
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "focus inner");
    key(&mut view, "r", true);
    draw_until(&mut view, &mut terminal, &rx, "focus opener");
}

#[test]
fn a_removed_or_hidden_opener_is_not_restored() {
    for (command, status) in [("d", "exists false"), ("u", "visible false")] {
        let (mut view, mut terminal, rx) = open_modal();
        key(&mut view, command, true);
        draw_until(&mut view, &mut terminal, &rx, status);
        key(&mut view, "Escape", false);
        draw_until(&mut view, &mut terminal, &rx, "cancel 1");
        // The removed modal's listeners cannot update the app's old focus label.
        assert_eq!(key(&mut view, "Enter", false), Handled::Ignored);
        key(&mut view, "Tab", false);
        draw_until(&mut view, &mut terminal, &rx, "focus before");
    }
}

#[test]
fn outside_mouse_presses_do_not_pass_through_a_modal_with_box_none() {
    let (mut view, mut terminal, rx) = open_modal();
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 0)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "root 0 cancel 1");
    draw_until(&mut view, &mut terminal, &rx, "focus first");
    key(&mut view, "l", true);
    draw_until(&mut view, &mut terminal, &rx, "backdrop true");
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 0)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "focus opener");
    draw_until(&mut view, &mut terminal, &rx, "root 0 cancel 2");
}

#[component]
fn EmptyModal() -> impl IntoElement {
    let open = signal(false);
    let focused = signal("none");
    let presses = signal(0);
    view()
        .flex_1()
        .child(
            view()
                .h(px(16.0))
                .on_focus(move |_: &()| focused.set("opener"))
                .on_blur(move |_: &()| focused.set("none"))
                .on_press(move |_: &()| {
                    presses.update(|n| *n += 1);
                    open.set(true);
                })
                .child(text("opener")),
        )
        .child(text(move || {
            format!("focus {} presses {}", focused.get(), presses.get())
        }))
        .child(when(open, move || {
            nsh_base::dialog()
                .on_close(move |_: &()| open.set(false))
                .child(text("empty modal").absolute().top(px(64.0)))
        }))
}

#[test]
fn an_empty_modal_clears_focus_and_keeps_navigation_off_the_page() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<EmptyModal>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focus none presses 0");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "focus opener");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "focus none presses 1");
    assert_eq!(key(&mut view, "Tab", false), Handled::Yes);
    assert_eq!(key(&mut view, "Enter", false), Handled::Yes);
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "focus opener presses 1");
    assert!(!terminal.backend().cursor_visible());
}

/// A system dialog takes every key and press until answered; its answer
/// resolves `AlertDialog.show` with the chosen action.
#[cfg(feature = "js")]
#[test]
fn system_dialogs_are_answered_with_keys_and_presses() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, Text } from "nsh";
        import { AlertDialog } from "nsh/base";
        const shown = signal("waiting");
        setTimeout(async () => {
          const { action: a } = await AlertDialog.show({
            title: "Delete the photo?",
            actions: [
              { label: "Cancel", role: "cancel", id: "cancel" },
              { label: "Delete", role: "destructive", id: "delete" },
            ],
          });
          shown.set(`a ${a}`);
          const { action: b } = await AlertDialog.show({
            presentation: "actionSheet",
            actions: [{ label: "Share", id: "share" }, { label: "Copy", id: "copy" }],
          });
          shown.set(`a ${a} b ${b}`);
          const { action: c } = await AlertDialog.show({ title: "Saved", actions: [{ label: "Done", id: "done" }] });
          shown.set(`a ${a} b ${b} c ${c}`);
        }, 0);
        mount(() => <Text>{shown()}</Text>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    view.load(nsh_platform_tui::Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Delete the photo?");
    // Left moves from the destructive button to the cancel one; Enter chooses it.
    assert_eq!(key(&mut view, "Left", false), Handled::Yes);
    assert_eq!(key(&mut view, "Enter", false), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "a cancel");
    draw_until(&mut view, &mut terminal, &rx, "Copy");
    // An action sheet's rows: Down to the second, Space chooses it.
    key(&mut view, "Down", false);
    key(&mut view, " ", false);
    draw_until(&mut view, &mut terminal, &rx, "b copy");
    draw_until(&mut view, &mut terminal, &rx, "Done");
    // A press on a button chooses it.
    let (x, y) = {
        let buffer = terminal.backend().buffer();
        let width = buffer.area.width;
        let index = (0..buffer.content.len())
            .find(|&i| {
                (0..4).all(|k| {
                    buffer.content.get(i + k).map(|c| c.symbol()) == Some(&"Done"[k..k + 1])
                })
            })
            .expect("the dialog's button is drawn");
        (index as u16 % width, index as u16 / width)
    };
    view.handle(mouse(MouseKind::Down(MouseButton::Left), x, y));
    view.handle(mouse(MouseKind::Up(MouseButton::Left), x, y));
    draw_until(&mut view, &mut terminal, &rx, "a cancel b copy c done");
}

/// A page with an opener, a sheet it opens with a stop inside, and a stop
/// after; the stops the focus came to, on screen.
#[component]
fn SheetFocus() -> impl IntoElement {
    let open = signal(false);
    let seen = signal(String::new());
    let stop = move |name: &'static str| {
        view()
            .h(px(16.0))
            .on_focus(move |_: &()| seen.update(|s| s.push_str(&format!(" {name}"))))
            .on_press(move |_: &()| {
                if name == "opener" {
                    open.set(true);
                }
            })
            .child(text(name))
    };
    view()
        .flex_1()
        .child(text(move || format!("seen{}.", seen.get())))
        .child(stop("opener"))
        .child(stop("after"))
        .child(
            nsh_base::sheet()
                .open(move || Some(open.get()))
                .side(nsh_core::overlay::Placement::Right)
                .on_open_change(move |_: &nsh_base::SheetEvent| open.set(false))
                .popup_style(|s| s.w(px(160.0)))
                .child(stop("inside")),
        )
}

#[test]
fn escape_in_a_sheet_gives_the_focus_back_to_where_it_came_from() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
    view.load(App::Rust(Root::new::<SheetFocus>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "after");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "seen opener.");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "inside");
    // Its backdrop covers the page: Tab goes into the sheet and stays in
    // it, as in a modal.
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "seen opener inside.");
    key(&mut view, "Tab", false);
    draw_until_still(&mut view, &mut terminal, &rx);
    let screen: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(screen.contains("seen opener inside."), "{screen:?}");
    // The sheet goes with the focus in it: the opener has it again, and
    // Tab goes on from there.
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "seen opener inside opener.");
    key(&mut view, "Tab", false);
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "seen opener inside opener after.",
    );
}

#[test]
fn escape_closing_a_sheet_before_the_focus_went_in_gives_it_back_to_the_opener() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
    view.load(App::Rust(Root::new::<SheetFocus>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "after");
    key(&mut view, "Tab", false);
    draw_until(&mut view, &mut terminal, &rx, "seen opener.");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "inside");
    draw_until_still(&mut view, &mut terminal, &rx);
    // Closed at once: the backdrop covered the opener, which takes the
    // focus back as the sheet goes, and Enter opens it again.
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &rx, "seen opener opener.");
    key(&mut view, "Enter", false);
    draw_until(&mut view, &mut terminal, &rx, "inside");
}

#[test]
fn a_press_on_a_stop_focuses_it_and_tab_goes_on_from_there() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
    view.load(App::Rust(Root::new::<SheetFocus>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "after");
    // The press is on the stop's text: the stop around it takes the focus.
    let (x, y) = {
        let buffer = terminal.backend().buffer();
        let width = buffer.area.width;
        let cells: Vec<&str> = buffer.content.iter().map(|c| c.symbol()).collect();
        let row = (0..buffer.area.height)
            .find(|&y| {
                let line: String = cells[(y * width) as usize..((y + 1) * width) as usize].concat();
                line.trim_start().starts_with("after")
            })
            .expect("the stop after");
        let line: String = cells[(row * width) as usize..((row + 1) * width) as usize].concat();
        let x = line.find("after").unwrap() as u16;
        (x + 1, row)
    };
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        view.handle(mouse(kind, x, y));
    }
    draw_until(&mut view, &mut terminal, &rx, "seen after.");
    // Shift+Tab goes back from it, not from the end of the page.
    view.handle(Input::Key {
        key: "Tab".into(),
        modifiers: Modifiers {
            shift: true,
            ..Default::default()
        },
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "seen after opener.");
}
