use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_tui::{App, AppOptions, AppView, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

#[component]
fn Counter() -> impl IntoElement {
    let count = signal(0);
    view().flex_1().bg(nsh_core::color::rgb(0x123456)).child(
        view()
            .h(px(48.0))
            .on_press(move |_: &()| count.update(|c| *c += 1))
            .child(text(move || format!("Count {}", count.get()))),
    )
}

pub(super) fn surface() -> (AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    (AppView::new(options), rx)
}

pub(super) fn draw_until(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    expected: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let contents: String = buffer.content.iter().map(|c| c.symbol()).collect();
        if contents.contains(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "expected {expected:?}, got {contents:?}"
        );
        // A passive surface wakes for the engine's batches; its animation
        // frames are deadlines the embedder draws at, as the runner does.
        let due = view
            .next_frame_deadline()
            .map_or(deadline, |due| due.min(deadline));
        let _ = rx.recv_deadline(due);
    }
}

/// Draws until no animation asks for another frame.
pub(super) fn draw_until_still(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let Some(due) = view.next_frame_deadline() else {
            return;
        };
        assert!(Instant::now() < deadline, "the animations did not finish");
        let _ = rx.recv_deadline(due.min(deadline));
    }
}

/// Draws until `done` holds for the screen, else fails with `what` and the
/// screen's dump: what an input does reaches the screen a commit later,
/// which a still frame before it does not wait for.
pub(super) fn draw_until_true(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    what: &str,
    mut done: impl FnMut(&Terminal<TestBackend>) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if done(terminal) {
            return;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "{what}:\n{}",
            super::dock::dump(terminal)
        );
    }
}

/// Draws until nothing on screen reads `gone` ([`draw_until_true`]).
pub(super) fn draw_until_gone(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    gone: &str,
) {
    let what = format!("`{gone}` still shows");
    draw_until_true(view, terminal, rx, &what, |t| {
        !super::dock::dump(t).contains(gone)
    });
}

#[test]
fn a_surface_draws_a_rust_app_into_the_embedders_buffer() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<Counter>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Count 0");
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].bg,
        ratatui_core::style::Color::Reset,
        "fills are the GUI's: the terminal keeps its own background"
    );
    view.stop();
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert!(
        !terminal
            .backend()
            .buffer()
            .content
            .iter()
            .any(|cell| cell.symbol() == "C")
    );
}

/// Marks a view selected, which draws a reversed band over its Cells: the
/// probe for where a view's Cells are, as fills draw no color.
pub(super) fn selected() -> nsh_core::AccessibilityState {
    nsh_core::AccessibilityState {
        selected: true,
        ..Default::default()
    }
}

pub(super) fn reversed(buffer: &ratatui_core::buffer::Buffer, x: u16, y: u16) -> bool {
    buffer[(x, y)]
        .modifier
        .contains(ratatui_core::style::Modifier::REVERSED)
}

/// Whether the band of a selected view, or the reversed label of a focused
/// or pressed one, covers `(x, y)`.
pub(super) fn barred(buffer: &ratatui_core::buffer::Buffer, x: u16, y: u16) -> bool {
    reversed(buffer, x, y)
}

pub(super) fn mouse(
    kind: nsh_platform_tui::MouseKind,
    column: u16,
    row: u16,
) -> nsh_platform_tui::Input {
    let mut mouse = nsh_platform_tui::MouseInput::default();
    mouse.kind = kind;
    mouse.column = column;
    mouse.row = row;
    nsh_platform_tui::Input::Mouse(mouse)
}

#[test]
fn clicking_a_child_text_presses_its_button_in_an_offset_area() {
    use nsh_platform_tui::{Handled, MouseButton, MouseKind};
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(50, 16)).unwrap();
    let area = ratatui_core::layout::Rect::new(5, 3, 40, 12);
    view.load(App::Rust(Root::new::<Counter>(|| ()))).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal.draw(|frame| view.render(frame, area)).unwrap();
        if terminal.backend().buffer()[(5, 3)].symbol() == "C" {
            break;
        }
        rx.recv_deadline(deadline).unwrap();
    }
    assert_eq!(
        view.handle(mouse(MouseKind::Down(MouseButton::Left), 0, 0)),
        Handled::Ignored
    );
    assert_eq!(
        view.handle(mouse(MouseKind::Down(MouseButton::Left), 6, 3)),
        Handled::Yes
    );
    assert_eq!(
        view.handle(mouse(MouseKind::Up(MouseButton::Left), 6, 3)),
        Handled::Yes
    );
    loop {
        terminal
            .draw(|frame| frame.render_widget(&mut view, area))
            .unwrap();
        if terminal.backend().buffer()[(11, 3)].symbol() == "1" {
            break;
        }
        rx.recv_deadline(deadline).unwrap();
    }
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), " ");
    assert_eq!(
        view.handle(mouse(MouseKind::Down(MouseButton::Left), 6, 3)),
        Handled::Yes
    );
    assert_eq!(
        view.handle(mouse(MouseKind::Up(MouseButton::Left), 0, 0)),
        Handled::Ignored
    );
    view.set_focused(false);
    assert_eq!(
        view.handle(nsh_platform_tui::Input::Key {
            key: "Enter".into(),
            modifiers: Default::default(),
            release: false
        }),
        Handled::Ignored
    );
}

#[component]
fn Truncated() -> impl IntoElement {
    text("ab cd ef").w(px(32.0)).number_of_lines(1)
}

#[test]
fn truncated_text_draws_the_ellipsis_in_cells() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<Truncated>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ab…");
}

/// A word at each end of the top row.
#[component]
fn Ends() -> impl IntoElement {
    view().flex_1().child(
        view()
            .flex_row()
            .child(text("start"))
            .child(view().flex_1())
            .child(text("end")),
    )
}

#[test]
fn an_app_loaded_before_the_first_draw_shows_laid_out_at_the_drawn_area() {
    // Loaded before any draw, the app starts on a surface with no size, and
    // its first layout is for no room. The engine commits that layout before
    // the first draw here, as a slow machine does: the first frame showing
    // the app must still be the layout at the terminal's area.
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 6)).unwrap();
    view.load(App::Rust(Root::new::<Ends>(|| ()))).unwrap();
    rx.recv_timeout(Duration::from_secs(5))
        .expect("the engine commits the first layout");
    // The wait provokes the order, it is not what the test waits for.
    std::thread::sleep(Duration::from_millis(200));
    draw_until(&mut view, &mut terminal, &rx, "end");
    assert_eq!(
        super::dock::find(&terminal, "end"),
        Some((37, 0)),
        "the first frame showing the app is laid out at 40 Cells\n{}",
        super::dock::dump(&terminal)
    );
}

#[component]
fn WindowSize() -> impl IntoElement {
    text(move || format!("{}x{}", window().width.0, window().height.0))
}

#[test]
fn rendering_a_new_area_resizes_the_engine_without_resize_input() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<WindowSize>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "320x192");
    terminal.backend_mut().resize(30, 10);
    terminal
        .resize(ratatui_core::layout::Rect::new(0, 0, 30, 10))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "240x160");
}

#[test]
fn appearance_callbacks_wait_for_render_and_idle_views_have_no_deadline() {
    use std::{cell::RefCell, rc::Rc};
    let (mut view, _) = surface();
    let changes = Rc::new(RefCell::new(Vec::new()));
    let recorded = changes.clone();
    let thread = std::thread::current().id();
    view.on_appearance_changed(move |appearance| {
        assert_eq!(std::thread::current().id(), thread);
        recorded.borrow_mut().push(appearance);
    });
    view.set_appearance(nsh_platform_tui::Appearance::Light);
    assert!(changes.borrow().is_empty());
    assert!(view.next_frame_deadline().is_some());
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert_eq!(&*changes.borrow(), &[nsh_platform_tui::Appearance::Light]);
    assert!(view.next_frame_deadline().is_none());
}

#[cfg(feature = "run-app")]
#[test]
fn the_standalone_loop_does_not_draw_while_idle() {
    use nsh_platform_tui::{RunEvent, run_app};
    let mut view = AppView::default();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    let mut polls = 0;
    run_app(&mut terminal, &mut view, |_| {
        polls += 1;
        Ok(if polls == 4 {
            RunEvent::Exit
        } else {
            RunEvent::Idle
        })
    })
    .unwrap();
    let next = terminal.draw(|_| {}).unwrap();
    assert_eq!(next.count, 1);
}

#[cfg(feature = "js")]
#[test]
fn the_counter_example_changes_value_through_terminal_mouse_input() {
    use nsh_platform_tui::{Bundle, Handled, MouseButton, MouseKind};
    let code = nsh_bundler::compile_module(
        "App.tsx",
        include_str!("../../../../examples/counter/App.tsx"),
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(80, 32)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "nsh counter");
    draw_until(&mut view, &mut terminal, &rx, "Current value");
    for (button, recent, value) in [
        ("+1", "Recent values: 1", "1"),
        ("−1", "Recent values: 2", "0"),
        ("−1", "Recent values: 3", "-1"),
    ] {
        let buffer = terminal.backend().buffer();
        let (x, y) = (0..32)
            .find_map(|y| {
                (0..79).find_map(|x| {
                    let text =
                        format!("{}{}", buffer[(x, y)].symbol(), buffer[(x + 1, y)].symbol());
                    (text == button).then_some((x, y))
                })
            })
            .unwrap_or_else(|| panic!("button {button} is visible"));
        assert_eq!(
            view.handle(mouse(MouseKind::Down(MouseButton::Left), x, y)),
            Handled::Yes
        );
        assert_eq!(
            view.handle(mouse(MouseKind::Up(MouseButton::Left), x, y)),
            Handled::Yes
        );
        draw_until(&mut view, &mut terminal, &rx, recent);
        let buffer = terminal.backend().buffer();
        assert!((0..32).any(|y| {
            (0..80)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim()
                == value
        }));
    }
}

#[cfg(feature = "js")]
#[test]
fn app_errors_are_delivered_on_the_rendering_thread() {
    use std::{cell::RefCell, rc::Rc};
    let (mut view, rx) = surface();
    let errors = Rc::new(RefCell::new(Vec::new()));
    let recorded = errors.clone();
    let thread = std::thread::current().id();
    view.on_app_error(move |error| {
        assert_eq!(std::thread::current().id(), thread);
        recorded.borrow_mut().push(error.message.clone());
    });
    view.load(nsh_platform_tui::Bundle::source(
        "throw new Error('terminal callback');".into(),
    ))
    .unwrap();
    assert!(errors.borrow().is_empty());
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while errors.borrow().is_empty() {
        rx.recv_deadline(deadline).unwrap();
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    assert!(errors.borrow()[0].contains("terminal callback"));
}

#[component]
fn Bordered() -> impl IntoElement {
    view().child(
        view()
            .w(px(48.0))
            .py(px(16.0))
            .border_1()
            .rounded(px(8.0))
            .border_color(nsh_core::color::rgb(0xffffff))
            .child(view().child(text(" "))),
    )
}

#[test]
fn rounded_borders_draw_rounded_dim_corners_and_no_fill() {
    use ratatui_core::style::{Color, Modifier};
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<Bordered>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "╭────╮");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 2)].symbol(), "╰");
    assert_eq!(buffer[(5, 2)].symbol(), "╯");
    assert_eq!(buffer[(2, 1)].bg, Color::Reset, "no fill");
    assert_eq!(buffer[(0, 0)].fg, Color::Reset);
    assert!(
        buffer[(0, 0)].modifier.contains(Modifier::DIM),
        "a neutral border is dim"
    );
}

#[cfg(feature = "js")]
#[test]
fn ellipsis_modes_keep_the_requested_end_of_the_text() {
    for (mode, expected) in [
        ("ellipsis", "abc…"),
        ("ellipsis-start", "…def"),
        ("ellipsis-middle", "ab…f"),
        ("clip", "abcd"),
    ] {
        let source = format!(
            r#"import {{ mount, Text }} from "nsh";
            mount(() => <Text style={{{{ width: 32, numberOfLines: 1, textOverflow: "{mode}" }}}}>abcdef</Text>);"#
        );
        let code = nsh_bundler::compile_module("App.tsx", &source, &[]).unwrap();
        let (mut view, rx) = surface();
        let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
        view.load(nsh_platform_tui::Bundle::source(code)).unwrap();
        draw_until(&mut view, &mut terminal, &rx, expected);
    }
}

#[component]
fn NativeLabel() -> impl IntoElement {
    nsh_core::element::native("example.label")
        .w(px(80.0))
        .h(px(16.0))
}

#[test]
fn registered_components_draw_in_their_assigned_area() {
    struct Label;
    impl nsh_platform_tui::NativeComponent for Label {
        fn render(
            &mut self,
            area: ratatui_core::layout::Rect,
            buffer: &mut ratatui_core::buffer::Buffer,
        ) {
            use ratatui_core::widgets::Widget;
            ratatui_widgets::paragraph::Paragraph::new("Native").render(area, buffer);
        }
        fn set_props(&mut self, _: &[(Arc<str>, Option<nsh_core::JsonValue>)]) {}
        fn command(&mut self, _: &nsh_core::Command) -> bool {
            false
        }
    }
    let (mut view, rx) = surface();
    assert!(
        view.register_component("nsh/reserved", Box::new(|| Box::new(Label)))
            .is_err()
    );
    view.register_component("example.label", Box::new(|| Box::new(Label)))
        .unwrap();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<NativeLabel>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Native");
}

#[component]
fn PaddedLabel() -> impl IntoElement {
    let count = signal(0);
    view().flex_1().child(
        view()
            .absolute()
            .left(px(8.0))
            .top(px(224.0))
            .w(px(40.0))
            .py(px(12.0))
            .accessibility_state(selected())
            .on_press(move |_: &()| count.update(|count| *count += 1))
            .child(text(move || format!("Tap {}", count.get()))),
    )
}

#[test]
fn absolute_edges_place_a_one_row_control_and_its_hit_cells() {
    use nsh_platform_tui::{Handled, MouseButton, MouseKind};

    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(100, 34)).unwrap();
    view.load(App::Rust(Root::new::<PaddedLabel>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Tap 0");
    let buffer = terminal.backend().buffer();
    // At (8, 224) points, 40 wide: columns 1 to 5 of row 14; its 12pt of
    // vertical padding take no rows, a control being its label row.
    for column in 1..6 {
        assert!(barred(buffer, column, 14), "the bar on the text row");
        assert!(!barred(buffer, column, 13) && !barred(buffer, column, 15));
    }
    assert_eq!(buffer[(1, 14)].symbol(), "T");
    assert!(!barred(buffer, 0, 14) && !barred(buffer, 6, 14));
    for (column, row) in [(1, 13), (1, 15), (0, 14), (6, 14)] {
        assert_eq!(
            view.handle(mouse(MouseKind::Down(MouseButton::Left), column, row)),
            Handled::Ignored
        );
        assert_eq!(
            view.handle(mouse(MouseKind::Up(MouseButton::Left), column, row)),
            Handled::Ignored
        );
    }
    for (count, column) in [(1, 1), (2, 5)] {
        assert_eq!(
            view.handle(mouse(MouseKind::Down(MouseButton::Left), column, 14)),
            Handled::Yes
        );
        assert_eq!(
            view.handle(mouse(MouseKind::Up(MouseButton::Left), column, 14)),
            Handled::Yes
        );
        draw_until(&mut view, &mut terminal, &rx, &format!("Tap {count}"));
    }
}

#[component]
fn NegativeHalfCell() -> impl IntoElement {
    view().flex_1().child(
        view()
            .absolute()
            .left(px(-4.0))
            .top(px(-8.0))
            .w(px(8.0))
            .h(px(16.0))
            .accessibility_state(selected())
            .child(text("X")),
    )
}

#[test]
fn negative_half_cell_edges_round_towards_the_positive_direction() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 8)).unwrap();
    view.load(App::Rust(Root::new::<NegativeHalfCell>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "X");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), "X");
    assert!(barred(buffer, 0, 0));
    assert!(!barred(buffer, 1, 0));
    assert!(!barred(buffer, 0, 1));
}

#[component]
fn ReportedOs() -> impl IntoElement {
    view().child(text(format!("os {:?}", os())))
}

#[test]
fn the_surface_reports_the_machines_operating_system() {
    let expected = if cfg!(target_os = "macos") {
        "os MacOs"
    } else if cfg!(target_os = "windows") {
        "os Windows"
    } else {
        "os Linux"
    };
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 4)).unwrap();
    view.load(App::Rust(Root::new::<ReportedOs>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, expected);
}

#[cfg(feature = "js")]
#[test]
fn apps_read_the_terminal_idiom_the_real_os_and_the_desktop_module() {
    let expected = if cfg!(target_os = "macos") {
        "macos terminal true d"
    } else if cfg!(target_os = "windows") {
        "windows terminal true d"
    } else {
        "linux terminal true d"
    };
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, platform, Text } from "nsh";
        import { isAvailable } from "nsh/desktop";
        mount(() => (
          <Text>{`${platform.os} ${platform.idiom} ${isAvailable} ${platform.select({ mobile: "m", desktop: "d" })}`}</Text>
        ));
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 4)).unwrap();
    view.load(nsh_platform_tui::Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, expected);
}

/// A label in the theme's `primary`, read from the tokens.
#[component]
fn Primary() -> impl IntoElement {
    view().child(text("Brand").text_color(|| {
        nsh_core::element::tokens()
            .color("primary")
            .unwrap_or_default()
    }))
}

#[test]
fn a_rust_roots_theme_tokens_color_its_views() {
    let red = nsh_core::color::rgb(0xd43a4a);
    let mut tokens = nsh_core::element::Tokens::default();
    tokens.set_color("primary", red.into());
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 2)).unwrap();
    view.load(App::Rust(Root::new::<Primary>(|| ()).tokens(tokens)))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Brand");
    // The tokens' red is the accent of its hue; the default theme's
    // `primary` is a near-black ink, the terminal's own foreground.
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].fg,
        ratatui_core::style::Color::Red
    );
    view.stop();
}
