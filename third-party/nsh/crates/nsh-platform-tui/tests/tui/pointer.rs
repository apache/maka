#![cfg(feature = "js")]

use nsh_platform_tui::{Bundle, Handled, MouseKind};
use ratatui_core::{backend::TestBackend, style::Color, terminal::Terminal};

use super::app::{draw_until, mouse, reversed, surface};

#[test]
fn hover_styles_and_events_follow_the_pointer_and_clear_outside_the_surface() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r##"
        import { mount, signal, View, Text } from "nsh";
        const state = signal("idle");
        mount(() => <View>
            <View style={{ width: 80, height: 32, backgroundColor: "#123456" }}
                hoverStyle={{ backgroundColor: "#ef4444" }}
                onPress={() => {}}
                onMouseEnter={() => state.set("inside")}
                onMouseLeave={() => state.set("outside")} />
            <Text>{state()}</Text>
        </View>);
    "##,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "idle");
    // Without surfaces the small box is its fill in a standard color.
    let rest = terminal.backend().buffer()[(1, 1)].bg;
    assert_ne!(rest, Color::Reset, "the fill at rest");
    view.handle(mouse(MouseKind::Move, 1, 0));
    draw_until(&mut view, &mut terminal, &rx, "inside");
    // A hovered pressable view is a faint band: the terminal's background
    // (black here) a tenth of the way to its foreground; the app's hover
    // fill draws nothing.
    let band = Color::Rgb(26, 26, 26);
    for (x, y) in [(0, 0), (9, 1)] {
        assert_eq!(terminal.backend().buffer()[(x, y)].bg, band, "{x},{y}");
    }
    assert!(!reversed(terminal.backend().buffer(), 1, 1));
    assert_eq!(terminal.backend().buffer()[(10, 0)].bg, Color::Reset);
    view.handle(mouse(MouseKind::Move, 41, 0));
    draw_until(&mut view, &mut terminal, &rx, "outside");
    assert_eq!(terminal.backend().buffer()[(1, 1)].bg, rest, "back at rest");
}

#[test]
fn moving_off_a_hovered_view_onto_empty_cells_redraws_without_its_band() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r##"
        import { mount, View, Text } from "nsh";
        mount(() => <View>
            <View style={{ width: 80, height: 32 }} onPress={() => {}} />
            <Text>ready</Text>
        </View>);
    "##,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let band = Color::Rgb(26, 26, 26);
    assert_eq!(view.handle(mouse(MouseKind::Move, 1, 0)), Handled::Yes);
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert_eq!(terminal.backend().buffer()[(1, 0)].bg, band);
    // Onto Cells no view claims, in the surface: the hover is gone and the
    // move is used, so the embedder's loop draws the band away (nothing in
    // the app changes to wake it otherwise).
    while rx.try_recv().is_ok() {}
    assert_eq!(view.handle(mouse(MouseKind::Move, 20, 0)), Handled::Yes);
    assert!(rx.try_recv().is_ok(), "the move wakes the surface");
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert_eq!(terminal.backend().buffer()[(1, 0)].bg, Color::Reset);
    // A move that changes nothing over empty Cells stays the embedder's.
    while rx.try_recv().is_ok() {}
    assert_eq!(view.handle(mouse(MouseKind::Move, 21, 0)), Handled::Ignored);
}

#[test]
fn a_responder_keeps_its_drag_outside_the_surface_and_receives_release() {
    use nsh_platform_tui::MouseButton::Left;
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, signal, PanResponder, View, Text } from "nsh";
        const status = signal("ready");
        const responder = PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onPanResponderMove: (_, g) => status.set(`move ${g.dx},${g.dy}`),
            onPanResponderRelease: (_, g) => status.set(`end ${g.dx},${g.dy}`),
            onPanResponderTerminate: () => status.set("cancelled"),
        });
        mount(() => <View>
            <View {...responder.panHandlers} style={{ width: 80, height: 32 }}><Text>Drag</Text></View>
            <Text>{status()}</Text>
        </View>);
    "#, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    view.handle(mouse(MouseKind::Move, 42, 1));
    draw_until(&mut view, &mut terminal, &rx, "move 328,16");
    view.handle(mouse(MouseKind::Up(Left), 42, 1));
    draw_until(&mut view, &mut terminal, &rx, "end 328,16");
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    view.set_focused(false);
    draw_until(&mut view, &mut terminal, &rx, "cancelled");
}

#[test]
fn a_native_pan_reports_values_and_a_drag_does_not_press() {
    use nsh_platform_tui::MouseButton::Left;
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, signal, createAnimatedValue, View, Text } from "nsh";
        const x = createAnimatedValue(10), result = signal("ready"), presses = signal(0);
        mount(() => <View>
            <View pan={{x}} style={{ width: 80, height: 32 }}
                onPress={() => presses.set(presses()+1)}
                onPanStart={() => result.set("panning")}
                onPanEnd={e => result.set(`pan ${e.translation.x}:${e.value?.x}`)}><Text>Pan</Text></View>
            <Text>{result()} presses:{presses()}</Text>
        </View>);
    "#, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready presses:0");
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    view.handle(mouse(MouseKind::Move, 5, 0));
    draw_until(&mut view, &mut terminal, &rx, "panning presses:0");
    view.handle(mouse(MouseKind::Up(Left), 5, 0));
    draw_until(&mut view, &mut terminal, &rx, "pan 32:42 presses:0");
}

#[test]
fn dragging_scroll_content_reveals_later_rows_without_pressing_them() {
    use nsh_platform_tui::MouseButton::Left;
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, signal, Scroll, View, Text } from "nsh";
        const offset = signal(0), presses = signal(0);
        mount(() => <View>
            <Scroll style={{ width: 160, height: 48 }} onScroll={e => offset.set(e.offset.y)}>
                <View onPress={() => presses.set(presses()+1)}>
                    <Text style={{ height: 16 }}>first</Text><Text style={{ height: 16 }}>second</Text>
                    <Text style={{ height: 16 }}>third</Text><Text style={{ height: 16 }}>fourth</Text>
                    <Text style={{ height: 16 }}>fifth</Text>
                </View>
            </Scroll>
            <Text>offset:{offset()} presses:{presses()}</Text>
        </View>);
    "#, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "offset:0 presses:0");
    view.handle(mouse(MouseKind::Down(Left), 1, 2));
    view.handle(mouse(MouseKind::Move, 1, 0));
    view.handle(mouse(MouseKind::Up(Left), 1, 0));
    draw_until(&mut view, &mut terminal, &rx, "offset:32 presses:0");
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), "t");
}

#[test]
fn a_selection_area_copies_across_texts_and_keeps_wide_graphemes_whole() {
    use std::sync::Arc;

    use nsh_core::clipboard::{ClipboardBackend, MemoryClipboard};
    use nsh_platform_tui::{AppOptions, AppView, Input, Modifiers, MouseButton::Left};
    use ratatui_core::style::Modifier;
    let clipboard = Arc::new(MemoryClipboard::default());
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.clipboard = Some(clipboard.clone());
    options.cache = nsh_platform_tui::CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    let mut view = AppView::new(options);
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, View, Text } from "nsh";
        mount(() => <View selectable>
            <Text>A界🙂B</Text>
            <Text style={{ userSelect: "none" }}>skip</Text>
            <Text>last</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "last");
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    view.handle(mouse(MouseKind::Move, 2, 2));
    view.handle(mouse(MouseKind::Up(Left), 2, 2));
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert!(
        terminal.backend().buffer()[(1, 0)]
            .modifier
            .contains(Modifier::REVERSED)
    );
    assert!(
        !terminal.backend().buffer()[(0, 1)]
            .modifier
            .contains(Modifier::REVERSED)
    );
    view.handle(Input::Key {
        key: "c".into(),
        modifiers: Modifiers {
            ctrl: true,
            shift: true,
            ..Default::default()
        },
        release: false,
    });
    assert_eq!(clipboard.text().as_deref(), Some("界🙂B\nla"));
    view.set_focused(false);
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert!(
        !terminal.backend().buffer()[(1, 0)]
            .modifier
            .contains(Modifier::REVERSED)
    );
}

#[test]
fn dragging_clears_active_styles() {
    use nsh_platform_tui::MouseButton::Left;
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r##"
        import { mount, View, Text } from "nsh";
        mount(() => <View><View style={{width: 80, height: 32, backgroundColor: "#123456"}}
            activeStyle={{backgroundColor: "#ef4444"}} onPress={() => {}} /><Text>Hold</Text></View>);
    "##,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Hold");
    // Pressed is a stronger band than hovered; a drag ends the press.
    let press = Color::Rgb(46, 46, 46);
    let until = |view: &mut nsh_platform_tui::AppView,
                 terminal: &mut Terminal<TestBackend>,
                 pressed: bool| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            terminal
                .draw(|frame| view.render(frame, frame.area()))
                .unwrap();
            if (terminal.backend().buffer()[(1, 1)].bg == press) == pressed {
                break;
            }
            rx.recv_deadline(deadline).unwrap();
        }
    };
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    until(&mut view, &mut terminal, true);
    view.handle(mouse(MouseKind::Move, 4, 0));
    until(&mut view, &mut terminal, false);
    view.handle(mouse(MouseKind::Up(Left), 4, 0));
}

#[test]
fn selectable_text_still_presses_on_a_click_and_only_copies_after_a_drag() {
    use std::sync::Arc;

    use nsh_core::clipboard::{ClipboardBackend, MemoryClipboard};
    use nsh_platform_tui::{AppOptions, AppView, Input, Modifiers, MouseButton::Left};
    let clipboard = Arc::new(MemoryClipboard::default());
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.clipboard = Some(clipboard.clone());
    options.cache = nsh_platform_tui::CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    let mut view = AppView::new(options);
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, signal, View, Text } from "nsh";
        const presses = signal(0);
        mount(() => <View>
            <Text style={{userSelect: "text"}} onPress={() => presses.set(presses()+1)}>selectable</Text>
            <Text>presses:{presses()}</Text>
        </View>);
    "#, &[]).unwrap();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "presses:0");
    view.handle(mouse(MouseKind::Down(Left), 0, 0));
    view.handle(mouse(MouseKind::Up(Left), 0, 0));
    draw_until(&mut view, &mut terminal, &rx, "presses:1");
    // Another Cell, so the press is no double click (which selects by words).
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    view.handle(mouse(MouseKind::Move, 7, 0));
    view.handle(mouse(MouseKind::Up(Left), 7, 0));
    view.handle(Input::Key {
        key: "c".into(),
        modifiers: Modifiers {
            ctrl: true,
            shift: true,
            ..Default::default()
        },
        release: false,
    });
    assert_eq!(clipboard.text().as_deref(), Some("electa"));
    draw_until(&mut view, &mut terminal, &rx, "presses:1");
}

#[test]
fn a_click_on_a_pressable_span_presses_the_span_not_its_text() {
    use nsh_platform_tui::MouseButton::Left;
    let (mut view, rx) = surface();
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, signal, View, Text } from "nsh";
        const links = signal(0);
        const texts = signal(0);
        mount(() => <View>
            <Text onPress={() => texts.set(texts() + 1)}>read <Text onPress={() => links.set(links() + 1)}>the guide</Text> now</Text>
            <Text>links:{links()} texts:{texts()}</Text>
        </View>);
    "#, &[]).unwrap();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "links:0 texts:0");
    // "read the guide now": the span covers columns 5 to 13.
    view.handle(mouse(MouseKind::Down(Left), 7, 0));
    view.handle(mouse(MouseKind::Up(Left), 7, 0));
    draw_until(&mut view, &mut terminal, &rx, "links:1 texts:0");
    // Released off the span, its press does not fire; the text's does.
    view.handle(mouse(MouseKind::Down(Left), 9, 0));
    view.handle(mouse(MouseKind::Up(Left), 1, 0));
    view.handle(mouse(MouseKind::Down(Left), 16, 0));
    view.handle(mouse(MouseKind::Up(Left), 16, 0));
    draw_until(&mut view, &mut terminal, &rx, "links:1 texts:1");
}

/// The same as a Rust app: a sentence that takes presses, with a link in it.
mod linked {
    use nsh_core::prelude::*;

    #[component]
    pub(super) fn Linked() -> impl IntoElement {
        let links = signal(0);
        let texts = signal(0);
        view()
            .child(
                text("read ")
                    .child(text("the guide").on_press(move |_: &()| links.update(|n| *n += 1)))
                    .child(" now")
                    .on_press(move |_: &()| texts.update(|n| *n += 1)),
            )
            .child(text(move || {
                format!("links:{} texts:{}", links.get(), texts.get())
            }))
    }
}

#[test]
fn a_click_on_a_rust_apps_pressable_span_presses_the_span() {
    use nsh_platform_tui::{App, MouseButton::Left, Root};
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<linked::Linked>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "links:0 texts:0");
    view.handle(mouse(MouseKind::Down(Left), 7, 0));
    view.handle(mouse(MouseKind::Up(Left), 7, 0));
    draw_until(&mut view, &mut terminal, &rx, "links:1 texts:0");
    view.handle(mouse(MouseKind::Down(Left), 16, 0));
    view.handle(mouse(MouseKind::Up(Left), 16, 0));
    draw_until(&mut view, &mut terminal, &rx, "links:1 texts:1");
}

mod pressed_field {
    use nsh_core::prelude::*;

    /// A field that listens to presses, as a combobox's does, and a log of
    /// what it hears.
    #[component]
    pub(super) fn PressedField() -> impl IntoElement {
        let log = signal(String::from("log"));
        let note = move |what: &'static str| log.update(|log| log.push_str(what));
        view()
            .child(
                nsh_base::input()
                    .h(px(16.0))
                    .w(px(80.0))
                    .on_focus(move |_: &()| note(" focus"))
                    .on_press(move |_: &()| note(" press")),
            )
            .child(text(move || log.get()))
    }
}

#[test]
fn a_press_on_a_field_that_listens_to_presses_reports_it_after_the_focus_focused_or_not() {
    use nsh_platform_tui::{App, MouseButton::Left, Root};
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<pressed_field::PressedField>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "log");
    view.handle(mouse(MouseKind::Down(Left), 2, 0));
    view.handle(mouse(MouseKind::Up(Left), 2, 0));
    draw_until(&mut view, &mut terminal, &rx, "log focus press");
    // Focused already: the press alone.
    view.handle(mouse(MouseKind::Down(Left), 3, 0));
    view.handle(mouse(MouseKind::Up(Left), 3, 0));
    draw_until(&mut view, &mut terminal, &rx, "log focus press press");
    // Released off the field: no press.
    view.handle(mouse(MouseKind::Down(Left), 3, 0));
    view.handle(mouse(MouseKind::Move, 30, 3));
    view.handle(mouse(MouseKind::Up(Left), 30, 3));
    view.handle(mouse(MouseKind::Down(Left), 3, 0));
    view.handle(mouse(MouseKind::Up(Left), 3, 0));
    draw_until(&mut view, &mut terminal, &rx, "log focus press press press");
    assert!(
        !super::dock::dump(&terminal).contains("press press press press"),
        "{}",
        super::dock::dump(&terminal)
    );
}

#[test]
fn concealing_a_hovered_view_clears_hover_without_more_mouse_motion() {
    use nsh_platform_tui::MouseButton::Left;
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text } from "nsh";
        const visible = signal(true), state = signal("ready");
        mount(() => <View>
            <View style={{width: 80, height: 32, opacity: visible() ? 1 : 0}}
                onMouseEnter={() => state.set("inside")} onMouseLeave={() => state.set("left")}
                onPress={() => visible.set(false)}><Text>Hide</Text></View>
            <Text>{state()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    view.handle(mouse(MouseKind::Move, 1, 0));
    draw_until(&mut view, &mut terminal, &rx, "inside");
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    view.handle(mouse(MouseKind::Up(Left), 1, 0));
    draw_until(&mut view, &mut terminal, &rx, "left");
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), " ");
}

#[test]
fn a_secondary_press_asks_the_nearest_listener_for_a_context_menu() {
    use nsh_platform_tui::MouseButton::Right;
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text } from "nsh";
        const at = signal("none");
        mount(() => <View>
            <View style={{ width: 80, height: 32 }}
                onContextMenu={(e) => at.set(`menu ${e.position.x},${e.position.y}`)}>
                <View style={{ width: 40, height: 16 }}><Text>Row</Text></View>
            </View>
            <Text>{at()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "none");
    view.handle(mouse(MouseKind::Down(Right), 1, 0));
    view.handle(mouse(MouseKind::Up(Right), 1, 0));
    // The Cell's middle: half a Cell past its corner.
    draw_until(&mut view, &mut terminal, &rx, "menu 12,8");
}

#[test]
fn a_context_menu_opens_at_the_pointer_and_takes_keys_and_presses_until_it_closes() {
    use nsh_platform_tui::{Input, MouseButton::Right};
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text } from "nsh";
        import { Menu } from "nsh/desktop";
        const log = signal("none");
        const show = () => Menu.popup([
            { label: "Copy", onSelect: () => log.set("copy") },
            { label: "Paste", disabled: true },
            { type: "separator" },
            { label: "Share", submenu: [{ label: "Mail", onSelect: () => log.set("mail") }] },
        ]).then(() => log.set(log() + " closed"));
        mount(() => <View>
            <View style={{ width: 80, height: 16 }} onContextMenu={show}><Text>Area</Text></View>
            <Text>{log()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let key = |name: &str| Input::Key {
        key: name.into(),
        modifiers: Default::default(),
        release: false,
    };
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "none");
    view.handle(mouse(MouseKind::Down(Right), 2, 0));
    view.handle(mouse(MouseKind::Up(Right), 2, 0));
    draw_until(&mut view, &mut terminal, &rx, "Copy");
    let buffer = terminal.backend().buffer().clone();
    // The box's corner on the pointer's Cell, its items in rows.
    assert_eq!(buffer[(2, 0)].symbol(), "╭");
    assert_eq!(buffer[(4, 1)].symbol(), "C");
    // Tab skips the disabled item and the separator; Right opens the
    // submenu, Enter chooses in it.
    assert_eq!(view.handle(key("Tab")), Handled::Yes);
    assert_eq!(view.handle(key("Tab")), Handled::Yes);
    view.handle(key("Right"));
    draw_until(&mut view, &mut terminal, &rx, "Mail");
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "mail closed");
    // A press outside the box closes it and goes no further.
    view.handle(mouse(MouseKind::Down(Right), 2, 0));
    view.handle(mouse(MouseKind::Up(Right), 2, 0));
    draw_until(&mut view, &mut terminal, &rx, "Copy");
    view.handle(mouse(
        MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        30,
        10,
    ));
    view.handle(mouse(
        MouseKind::Up(nsh_platform_tui::MouseButton::Left),
        30,
        10,
    ));
    draw_until(&mut view, &mut terminal, &rx, "mail closed closed");
}

#[test]
fn a_scroll_bar_jumps_where_its_track_is_pressed_and_its_thumb_follows_a_drag() {
    use nsh_platform_tui::MouseButton::Left;
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, Scroll, View, Text } from "nsh";
        const offset = signal(0);
        mount(() => <View>
            <Scroll style={{ width: 160, height: 64 }} onScroll={e => offset.set(e.offset.y)}>
                {Array.from({ length: 16 }, (_, i) => <Text style={{ height: 16 }}>row {i}</Text>)}
            </Scroll>
            <Text>offset:{offset()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "offset:0");
    // A 4-row track over 16 rows: a one-Cell thumb in the view's last column.
    view.handle(mouse(MouseKind::Down(Left), 19, 3));
    view.handle(mouse(MouseKind::Up(Left), 19, 3));
    draw_until(&mut view, &mut terminal, &rx, "offset:192");
    view.handle(mouse(MouseKind::Down(Left), 19, 3));
    view.handle(mouse(MouseKind::Move, 19, 0));
    draw_until(&mut view, &mut terminal, &rx, "offset:0");
    view.handle(mouse(MouseKind::Up(Left), 19, 0));
}

#[test]
fn pressing_a_field_closes_an_open_popover_as_any_press_outside_it() {
    use nsh_platform_tui::MouseButton::Left;
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text } from "nsh";
        import { Input, Popover } from "nsh/base";
        const state = signal("initial");
        mount(() => <View>
            <Popover defaultOpen onOpenChange={({ open }) => state.set(open ? "open" : "closed")}
                trigger={<View style={{ width: 80, height: 16 }}><Text>Open</Text></View>}>
                <View style={{ width: 80, height: 16 }}><Text>Panel</Text></View>
            </Popover>
            <View style={{ height: 32 }} />
            <Input style={{ width: 160, height: 16 }} />
            <Text>{state()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel");
    view.handle(mouse(MouseKind::Down(Left), 2, 3));
    view.handle(mouse(MouseKind::Up(Left), 2, 3));
    draw_until(&mut view, &mut terminal, &rx, "closed");
}

/// A surface whose terminal reports its colors, so fills are steps of the
/// ramp from its background (24) toward its foreground (224).
pub(super) fn ramp_surface() -> (nsh_platform_tui::AppView, crossbeam_channel::Receiver<()>) {
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

#[test]
fn a_hover_fill_of_the_apps_own_takes_one_step_not_the_select_band() {
    // Tabs on a raised strip, the gallery's: a faint wash while hovered.
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r##"
        import { mount, signal, View, Text } from "nsh";
        const state = signal("idle");
        mount(() => <View>
            <View style={{ flexDirection: "row", backgroundColor: "#27272a" }}>
                <View style={{ width: 80 }} onPress={() => {}}
                    hoverStyle={{ backgroundColor: "rgba(255, 255, 255, 0.05)" }}
                    onMouseEnter={() => state.set("inside")}>
                    <Text>One</Text>
                </View>
                <View style={{ width: 80 }} onPress={() => {}}><Text>Two</Text></View>
            </View>
            <Text>{state()}</Text>
        </View>);
    "##,
        &[],
    )
    .unwrap();
    let (mut view, rx) = ramp_surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "idle");
    let find = |buffer: &ratatui_core::buffer::Buffer, word: &str| {
        (0..buffer.area.height)
            .find_map(|y| {
                let row: String = (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect();
                row.find(word).map(|x| (x as u16, y))
            })
            .unwrap_or_else(|| panic!("{word} not drawn"))
    };
    let (x, y) = find(terminal.backend().buffer(), "One");
    let rest = terminal.backend().buffer()[(x, y)].bg;
    view.handle(mouse(MouseKind::Move, x, y));
    draw_until(&mut view, &mut terminal, &rx, "inside");
    // Give the hover style's commit a frame to land.
    for _ in 0..3 {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(200));
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    let buffer = terminal.backend().buffer();
    let level = |share: f32| {
        let c = (24.0 + share * 200.0).round() as u8;
        Color::Rgb(c, c, c)
    };
    // The strip is the raised step; the hovered tab one step over it (the
    // hover step), not two (the select band's).
    assert_eq!(rest, level(0.07), "the strip at rest");
    assert_eq!(buffer[(x, y)].bg, level(0.11), "the hovered tab");
    assert_eq!(buffer[find(buffer, "Two")].bg, level(0.07), "the other tab");
}

#[test]
fn a_selection_dragged_past_its_scroll_views_edge_scrolls_it_and_extends() {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use nsh_core::clipboard::{ClipboardBackend, MemoryClipboard};
    use nsh_platform_tui::{AppOptions, AppView, Input, Modifiers, MouseButton::Left};
    let clipboard = Arc::new(MemoryClipboard::default());
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.clipboard = Some(clipboard.clone());
    options.cache = nsh_platform_tui::CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    let mut view = AppView::new(options);
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, Scroll, View, Text } from "nsh";
        const offset = signal(0);
        mount(() => <View>
            <Scroll style={{ width: 160, height: 48 }} onScroll={e => offset.set(e.offset.y)}>
                <View selectable>
                    <Text>one</Text><Text>two</Text><Text>three</Text>
                    <Text>four</Text><Text>five</Text><Text>six</Text>
                </View>
            </Scroll>
            <Text>offset:{offset()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "offset:0");
    // Held below the Scroll's last row, the pointer sends nothing more: the
    // surface scrolls on its own, row by row, until the end.
    view.handle(mouse(MouseKind::Down(Left), 1, 0));
    view.handle(mouse(MouseKind::Move, 5, 3));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let contents: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        if contents.contains("offset:48") {
            break;
        }
        assert!(Instant::now() < deadline, "no autoscroll: {contents}");
        let due = view
            .next_frame_deadline()
            .expect("a held selection drag past the edge keeps scrolling");
        let _ = rx.recv_deadline(due.max(Instant::now()));
    }
    assert_eq!(terminal.backend().buffer()[(0, 2)].symbol(), "s");
    view.handle(mouse(MouseKind::Up(Left), 5, 3));
    view.handle(Input::Key {
        key: "c".into(),
        modifiers: Modifiers {
            ctrl: true,
            ..Default::default()
        },
        release: false,
    });
    assert_eq!(
        clipboard.text().as_deref(),
        Some("ne\ntwo\nthree\nfour\nfive\nsix")
    );
}

/// Where `word` is first drawn in `terminal`.
fn word_at(terminal: &Terminal<TestBackend>, word: &str) -> (u16, u16) {
    super::dock::find(terminal, word)
        .unwrap_or_else(|| panic!("{word} not drawn\n{}", super::dock::dump(terminal)))
}

#[test]
fn a_pressable_container_keeps_its_texts_weights_and_shows_focus_with_a_rail() {
    use ratatui_core::style::Modifier;
    // A gauge (a pressable box of three rows on a light fill that stands
    // out from its card) and a one-row button on the same fill.
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r##"
        import { mount, View, Text } from "nsh";
        mount(() => <View style={{ padding: 16, backgroundColor: "#27272a" }}>
            <View style={{ padding: 16, backgroundColor: "#d4d4d8" }} onPress={() => {}}>
                <Text style={{ color: "#18181b" }}>Groceries</Text>
                <Text style={{ color: "#18181b" }}>half spent</Text>
                <Text style={{ color: "#18181b" }}>of the budget</Text>
            </View>
            <View style={{ backgroundColor: "#d4d4d8" }} onPress={() => {}}>
                <Text style={{ color: "#18181b" }}>Go</Text>
            </View>
        </View>);
    "##,
        &[],
    )
    .unwrap();
    let (mut view, rx) = ramp_surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Groceries");
    let bold = |terminal: &Terminal<TestBackend>, word: &str| {
        let (x, y) = word_at(terminal, word);
        terminal.backend().buffer()[(x, y)]
            .modifier
            .contains(Modifier::BOLD)
    };
    assert!(
        !bold(&terminal, "Groceries"),
        "a container's text keeps its weight\n{}",
        super::dock::dump(&terminal)
    );
    assert!(bold(&terminal, "Go"), "a one-row button's label is bold");
    // Focused, the container shows a rail down its leading column.
    view.handle(nsh_platform_tui::Input::Key {
        key: "Tab".into(),
        modifiers: Default::default(),
        release: false,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let (x, y) = word_at(&terminal, "Groceries");
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        if (0..x).any(|left| buffer[(left, y)].symbol() == "▎") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no focus rail\n{}",
            super::dock::dump(&terminal)
        );
        let _ = rx.recv_timeout(std::time::Duration::from_millis(100));
    }
    assert!(
        !bold(&terminal, "Groceries"),
        "focus leaves its text's weight"
    );
}

#[test]
fn a_bar_filled_out_of_a_sunken_track_stands_apart_from_the_box_around_it() {
    // A gauge's track, darker than the gauge, and its fill, lighter than
    // the track: a step back up would be the gauge's own.
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r##"
        import { mount, View, Text } from "nsh";
        mount(() => <View style={{ padding: 16, backgroundColor: "#3f3f46" }}>
            <Text>Gauge</Text>
            <View style={{ height: 10, width: 160, backgroundColor: "#27272a" }}>
                <View style={{ height: 10, width: 80, backgroundColor: "#52525b" }} />
            </View>
        </View>);
    "##,
        &[],
    )
    .unwrap();
    let (mut view, rx) = ramp_surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Gauge");
    let (x, y) = word_at(&terminal, "Gauge");
    let buffer = terminal.backend().buffer();
    let around = buffer[(x, y)].bg;
    let (filled, track) = (buffer[(x, y + 1)].bg, buffer[(x + 15, y + 1)].bg);
    assert_ne!(track, around, "the track is a step of its own");
    assert_ne!(filled, track, "the fill differs from the track");
    assert_ne!(
        filled,
        around,
        "the fill differs from the box around the track\n{}",
        super::dock::dump(&terminal)
    );
}

#[test]
fn a_focused_one_row_field_is_its_band_brighter_with_no_line_under_it() {
    use nsh_platform_tui::MouseButton::Left;
    // Hopper's: the app shows focus with its border's color, which a box
    // one row tall cannot draw.
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r##"
        import { mount, signal, View, Text } from "nsh";
        import { Input } from "nsh/base";
        const state = signal("blurred");
        mount(() => <View>
            <Input value="120" style={{ width: 160, height: 16, borderWidth: 1,
                    borderColor: "#3f3f46", backgroundColor: "#27272a" }}
                onFocus={() => state.set("focused")} />
            <Text>{state()}</Text>
        </View>);
    "##,
        &[],
    )
    .unwrap();
    let (mut view, rx) = ramp_surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "blurred");
    let (x, y) = word_at(&terminal, "120");
    let rest = {
        let buffer = terminal.backend().buffer();
        assert!(
            !buffer[(x, y)]
                .modifier
                .contains(ratatui_core::style::Modifier::UNDERLINED),
            "no mark at rest"
        );
        [buffer[(x, y)].bg, buffer[(x + 10, y)].bg]
    };
    view.handle(mouse(MouseKind::Down(Left), x, y));
    view.handle(mouse(MouseKind::Up(Left), x, y));
    draw_until(&mut view, &mut terminal, &rx, "focused");
    let buffer = terminal.backend().buffer();
    let light = |color: Color| match color {
        Color::Rgb(r, g, b) => u16::from(r) + u16::from(g) + u16::from(b),
        other => panic!("an RGB band, not {other:?}"),
    };
    // The whole row, the text and the blank Cells after it: a brighter
    // band, no line under it and no ring around it.
    for (at, rest) in [x, x + 10].into_iter().zip(rest) {
        let cell = &buffer[(at, y)];
        assert!(
            light(cell.bg) > light(rest),
            "brighter at {at}: {:?} over {rest:?}",
            cell.bg
        );
        assert!(
            !cell
                .modifier
                .contains(ratatui_core::style::Modifier::UNDERLINED),
            "no underline at {at}"
        );
    }
    let row: String = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    assert!(
        !row.contains(['│', '─', '▁', '_']),
        "no line or ring: {row:?}"
    );
    for row in [y.saturating_sub(1), y + 1] {
        let line: String = (0..40).map(|x| buffer[(x, row)].symbol()).collect();
        assert!(!line.contains(['─', '▔', '▁']), "no line beside: {line:?}");
    }
    // The caret shows where the keys go: the terminal's cursor, on the
    // field's row.
    assert!(terminal.backend().cursor_visible(), "the cursor is drawn");
    let caret =
        ratatui_core::backend::Backend::get_cursor_position(terminal.backend_mut()).unwrap();
    assert_eq!(caret.y, y, "on the field's row");
    assert!((x..x + 20).contains(&caret.x), "in the field: {caret:?}");
}
