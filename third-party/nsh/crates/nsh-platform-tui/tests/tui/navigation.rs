use nsh_core::prelude::*;
use nsh_platform_tui::{App, Handled, MouseButton, MouseKind, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::app::{draw_until, mouse, surface};

#[component]
fn Pages() -> impl IntoElement {
    let pushed = signal(false);
    let hidden_presses = signal(0);
    view()
        .flex_1()
        .child(text(move || format!("hidden {}", hidden_presses.get())).h(px(16.0)))
        .child(
            nsh_base::nav_stack()
                .w(px(160.0))
                .h(px(96.0))
                .child(
                    nsh_base::nav_page()
                        .key("home")
                        .child(
                            view()
                                .h(px(16.0))
                                .on_press(move |_: &()| pushed.set(true))
                                .child(text("push HOME-tail")),
                        )
                        .child(
                            view()
                                .h(px(16.0))
                                .on_press(move |_: &()| hidden_presses.update(|n| *n += 1))
                                .child(text("hidden target")),
                        ),
                )
                .child(when(pushed, move || {
                    nsh_base::nav_page().key("top").child(
                        view()
                            .h(px(16.0))
                            .on_press(move |_: &()| pushed.set(false))
                            .child(text("top")),
                    )
                })),
        )
}

#[test]
fn a_push_conceals_the_previous_page_until_the_app_removes_the_top() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 10)).unwrap();
    view.load(App::Rust(Root::new::<Pages>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "push HOME-tail");
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 1)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "top");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 1)].symbol(), "t");
    for column in 3..20 {
        assert_eq!(buffer[(column, 1)].symbol(), " ");
    }
    assert_eq!(buffer[(0, 2)].symbol(), " ");
    assert_eq!(
        buffer[(19, 6)].symbol(),
        " ",
        "navigation containers draw no placeholder"
    );
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 2)), Handled::Ignored);
    }
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 1)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "push HOME-tail");
    assert!(
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
            .contains("hidden 0")
    );
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 2)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "hidden 1");
}

#[component]
fn HeaderSlots() -> impl IntoElement {
    let presses = signal(0);
    nsh_base::nav_stack().w(px(160.0)).h(px(96.0)).child(
        nsh_base::nav_page()
            .header(
                view()
                    .h(px(16.0))
                    .on_press(move |_: &()| presses.update(|n| *n += 1))
                    .child(text("HEADER")),
            )
            .header_left(
                view()
                    .h(px(16.0))
                    .on_press(move |_: &()| presses.set(99))
                    .child(text("LEFT")),
            )
            .header_right(text("RIGHT"))
            .header_title(text("TITLE"))
            .child(text(move || format!("presses {}", presses.get())).h(px(16.0)))
            .child(when(
                move || presses.get() > 0,
                || {
                    view()
                        .absolute()
                        .top(px(0.0))
                        .w(px(160.0))
                        .h(px(16.0))
                        .child(text("under header"))
                },
            )),
    )
}

#[test]
fn only_the_selected_header_slot_is_drawn_and_it_stays_above_content() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 10)).unwrap();
    view.load(App::Rust(Root::new::<HeaderSlots>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "presses 0");
    let buffer = terminal.backend().buffer();
    let header: String = (0..6).map(|column| buffer[(column, 0)].symbol()).collect();
    assert_eq!(header, "HEADER");
    let contents: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
    for other in ["LEFT", "RIGHT", "TITLE", "HeaderItem", "Screen", "Stack"] {
        assert!(!contents.contains(other), "unexpected {other}: {contents}");
    }
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        assert_eq!(view.handle(mouse(kind, 0, 0)), Handled::Yes);
    }
    draw_until(&mut view, &mut terminal, &rx, "presses 1");
    let buffer = terminal.backend().buffer();
    assert_eq!(
        (0..6)
            .map(|column| buffer[(column, 0)].symbol())
            .collect::<String>(),
        "HEADER"
    );
}

#[component]
fn SizedPage() -> impl IntoElement {
    let dimensions = signal(String::new());
    view()
        .flex_1()
        .child(text(move || dimensions.get()).h(px(16.0)))
        .child(
            nsh_base::nav_stack().flex_1().child(
                nsh_base::nav_page()
                    .on_layout(move |frame: &nsh_core::Bounds<nsh_core::Points>| {
                        dimensions.set(format!("{}x{}", frame.size.width.0, frame.size.height.0))
                    })
                    .child(
                        view()
                            .absolute()
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .w(px(8.0))
                            .h(px(16.0))
                            .child(text("X")),
                    ),
            ),
        )
}

#[test]
fn the_shown_screen_tracks_its_stack_size_after_resize() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 10)).unwrap();
    view.load(App::Rust(Root::new::<SizedPage>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "240x144");
    assert_eq!(terminal.backend().buffer()[(29, 9)].symbol(), "X");
    terminal.backend_mut().resize(20, 8);
    terminal
        .resize(ratatui_core::layout::Rect::new(0, 0, 20, 8))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "160x112");
    assert_eq!(terminal.backend().buffer()[(19, 7)].symbol(), "X");
}

/// A page pushed over another with a two-row header and a scroll view of
/// sixty rows and an end mark under it.
#[component]
fn PushedScroll() -> impl IntoElement {
    nsh_base::nav_stack()
        .flex_1()
        .child(nsh_base::nav_page().key("home").child(text("home")))
        .child(
            nsh_base::nav_page()
                .key("top")
                .header(
                    view()
                        .h(px(32.0))
                        .child(text("HEADER"))
                        .child(text("HEADER 2")),
                )
                .child(
                    scroll()
                        .flex_1()
                        .children((0..60).map(|row| text(format!("row {row}"))))
                        .child(text("THE END")),
                ),
        )
}

/// The text of `row`, without the scroll bar's column and trailing blanks.
fn line(terminal: &Terminal<TestBackend>, row: u16) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.width - 1)
        .map(|x| buffer[(x, row)].symbol())
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Wheels the page's scroll view down until its end shows.
///
/// It waits for the push to settle first: while the page still slides in, a
/// wheel at its Cells may land on the screen under it, which does not scroll.
/// Then it wheels again for as long as the end does not show, so a wheel the
/// engine had not taken yet does not make it miss the end.
fn wheel_to_the_end(
    view: &mut nsh_platform_tui::AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    super::app::draw_until_still(view, terminal, rx);
    loop {
        for _ in 0..60 {
            view.handle(mouse(MouseKind::Wheel { x: 0, y: 1 }, 2, 5));
        }
        super::app::draw_until_still(view, terminal, rx);
        let rows = terminal.backend().buffer().area.height;
        if line(terminal, rows - 1) == "THE END" {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the page never scrolled to its end"
        );
        let _ = rx.recv_timeout(std::time::Duration::from_millis(20));
    }
}

/// The page shows the end of its content on its last row, with the header
/// on its two first.
fn ends_on_the_last_row(terminal: &Terminal<TestBackend>, rows: u16) {
    assert_eq!(line(terminal, 0), "HEADER");
    assert_eq!(line(terminal, 1), "HEADER 2");
    assert_eq!(
        line(terminal, rows - 1),
        "THE END",
        "nothing blank below it"
    );
    assert_eq!(line(terminal, rows - 2), "row 59");
    // Every row between the header and the end is content.
    let first = 60 - (rows as i32 - 3);
    assert_eq!(line(terminal, 2), format!("row {first}"));
}

#[test]
fn a_pushed_page_with_a_header_scrolls_exactly_to_its_end() {
    for rows in [30, 45] {
        let (mut view, rx) = surface();
        let mut terminal = Terminal::new(TestBackend::new(100, rows)).unwrap();
        view.load(App::Rust(Root::new::<PushedScroll>(|| ())))
            .unwrap();
        draw_until(&mut view, &mut terminal, &rx, "row 0");
        assert_eq!(line(&terminal, 2), "row 0", "{rows} rows");
        wheel_to_the_end(&mut view, &mut terminal, &rx);
        ends_on_the_last_row(&terminal, rows);
    }
}

#[test]
fn a_terminal_made_taller_pulls_a_scrolled_page_back_to_its_end() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    view.load(App::Rust(Root::new::<PushedScroll>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "row 0");
    wheel_to_the_end(&mut view, &mut terminal, &rx);
    ends_on_the_last_row(&terminal, 30);
    terminal.backend_mut().resize(100, 45);
    terminal
        .resize(ratatui_core::layout::Rect::new(0, 0, 100, 45))
        .unwrap();
    draw_until_ends(&mut view, &mut terminal, &rx, 45);
    ends_on_the_last_row(&terminal, 45);
    // And back: the end stays on the last row.
    terminal.backend_mut().resize(100, 30);
    terminal
        .resize(ratatui_core::layout::Rect::new(0, 0, 100, 30))
        .unwrap();
    // Shorter, the offset stays and the end is below: wheeling reaches it.
    wheel_to_the_end(&mut view, &mut terminal, &rx);
    ends_on_the_last_row(&terminal, 30);
}

/// Draws until the terminal of `rows` rows shows the page's end on its last
/// row: the resize, the relayout and the pulled-back offset each take a
/// batch, which may come after a frame with no animation left.
fn draw_until_ends(
    view: &mut nsh_platform_tui::AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    rows: u16,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        super::app::draw_until_still(view, terminal, rx);
        if terminal.backend().buffer().area.height == rows
            && line(terminal, rows - 1) == "THE END"
            && line(terminal, rows - 2) == "row 59"
        {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the page never ended on row {rows}: {:?}",
            (0..rows).map(|row| line(terminal, row)).collect::<Vec<_>>()
        );
        let _ = rx.recv_timeout(std::time::Duration::from_millis(20));
    }
}
