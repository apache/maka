use nsh_core::prelude::*;
use nsh_platform_tui::{App, Root};
use ratatui_core::{
    backend::TestBackend,
    style::{Color, Modifier},
    terminal::Terminal,
};

use super::app::{draw_until, reversed, selected, surface};

/// Whether a selected view's band covers `(x, y)`: the probe for where a
/// box's Cells are, as fills draw nothing.
fn banded(buffer: &ratatui_core::buffer::Buffer, x: u16, y: u16) -> bool {
    reversed(buffer, x, y)
}

#[component]
fn Nested() -> impl IntoElement {
    view().flex_1().children([
        view()
            .absolute()
            .left(px(8.0))
            .top(px(16.0))
            .child(text("nested")),
        view().absolute().top(px(112.0)).child(text("ready")),
    ])
}

#[component]
fn NestedBorders() -> impl IntoElement {
    view().flex_1().children([
        view()
            .absolute()
            .left(px(16.0))
            .top(px(32.0))
            .w(px(96.0))
            .h(px(96.0))
            .border_1()
            .rounded(px(8.0))
            .border_color(nsh_core::color::rgb(0xffffff))
            .p(px(1.0))
            .child(
                view()
                    .flex_1()
                    .border_1()
                    .rounded(px(8.0))
                    .border_color(nsh_core::color::rgb(0xffffff))
                    .accessibility_state(selected())
                    // Two rows of content, and a canvas larger than the
                    // box beside them.
                    .child(view().w(px(8.0)).h(px(32.0)))
                    .child(
                        canvas(
                            Painter::new()
                                .fill_color(nsh_core::color::rgb(0xef4444))
                                .fill_rect(0.0, 0.0, 160.0, 160.0),
                        )
                        .label("drawing")
                        .absolute()
                        .left(px(8.0))
                        .top(px(0.0))
                        .w(px(160.0))
                        .h(px(160.0)),
                    ),
            ),
        view().absolute().top(px(144.0)).child(text("ready")),
    ])
}

#[test]
fn nested_borders_own_distinct_cells_and_clip_descendant_canvas() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 12)).unwrap();
    view.load(App::Rust(Root::new::<NestedBorders>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(2, 2)].symbol(), "╭");
    assert_eq!(buffer[(13, 7)].symbol(), "╯");
    assert_eq!(buffer[(3, 3)].symbol(), "╭");
    assert_eq!(buffer[(12, 6)].symbol(), "╯");
    assert!(
        buffer[(3, 3)].modifier.contains(Modifier::DIM),
        "a neutral border is dim"
    );
    assert!(!banded(buffer, 3, 3), "the band stays inside the border");
    assert!(banded(buffer, 4, 4), "the inner box's band");
    assert_eq!(buffer[(4, 4)].bg, Color::Reset);
    assert_eq!(buffer[(5, 5)].symbol(), "⣿");
    for y in 3..7 {
        assert_eq!(buffer[(2, y)].symbol(), "│");
        assert_eq!(buffer[(13, y)].symbol(), "│");
    }
}

#[component]
fn RoundedCoverage() -> impl IntoElement {
    view().flex_1().children([
        view()
            .absolute()
            .left(px(16.0))
            .top(px(16.0))
            .w(px(96.0))
            .h(px(96.0))
            .rounded(px(48.0))
            .accessibility_state(selected()),
        view()
            .absolute()
            .left(px(128.0))
            .top(px(16.0))
            .w(px(96.0))
            .h(px(96.0))
            .rounded_tl(px(48.0))
            .overflow_hidden()
            .child(view().h(px(96.0)).accessibility_state(selected())),
        view()
            .absolute()
            .left(px(16.0))
            .top(px(128.0))
            .w(px(80.0))
            .h(px(64.0))
            .border_1()
            .rounded_tl(px(8.0))
            .rounded_br(px(8.0))
            .py(px(16.0))
            .child(view().child(text(" ")))
            .child(view().child(text(" "))),
        view().absolute().top(px(208.0)).child(text("ready")),
    ])
}

#[test]
fn bands_cover_rounded_corners_and_borders_round_the_corners_that_have_a_radius() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(32, 16)).unwrap();
    view.load(App::Rust(Root::new::<RoundedCoverage>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    // A Cell is the smallest thing drawn: a band covers its whole box, the
    // corners inside its radius too, and a rounded clip clips to its box.
    for (x, y) in [
        (2, 1),
        (13, 1),
        (2, 6),
        (13, 6),
        (7, 3),
        (16, 1),
        (27, 1),
        (16, 6),
    ] {
        assert!(banded(buffer, x, y), "{x},{y}");
    }
    assert!(!banded(buffer, 1, 1), "outside the box");
    assert_eq!(buffer[(2, 8)].symbol(), "╭");
    assert_eq!(buffer[(11, 8)].symbol(), "┐");
    assert_eq!(buffer[(2, 11)].symbol(), "└");
    assert_eq!(buffer[(11, 11)].symbol(), "╯");
}

#[test]
fn search_highlights_the_text_where_its_view_is_placed() {
    use nsh_core::keymap::Modifiers;
    use nsh_platform_tui::Input;
    use ratatui_core::style::Modifier;
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 10)).unwrap();
    view.load(App::Rust(Root::new::<Nested>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    view.handle(Input::Key {
        key: "s".into(),
        modifiers: Modifiers {
            ctrl: true,
            ..Default::default()
        },
        release: false,
    });
    view.handle(Input::Key {
        key: "n".into(),
        modifiers: Default::default(),
        release: false,
    });
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert!(
        terminal.backend().buffer()[(1, 1)]
            .modifier
            .contains(Modifier::REVERSED)
    );
    assert!(
        !terminal.backend().buffer()[(2, 1)]
            .modifier
            .contains(Modifier::REVERSED)
    );
}

#[component]
fn BorderAdjacentLabels() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(200.0))
                .h(px(48.0))
                .border_b(px(1.0))
                .justify_center()
                .child(view().child(text("Title")).child(text("Description"))),
        )
        .child(text("ready"))
}

#[test]
fn a_border_adjacent_text_group_keeps_both_lines_inside_the_box() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 12)).unwrap();
    view.load(App::Rust(Root::new::<BorderAdjacentLabels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), "T");
    assert_eq!(buffer[(0, 1)].symbol(), "D");
    assert_eq!(buffer[(0, 2)].symbol(), "─");
}

#[component]
fn AnchoredTooltip() -> impl IntoElement {
    let anchor = element_ref();
    view()
        .flex_1()
        .child(
            view()
                .absolute()
                .left(px(16.0))
                .top(px(208.0))
                .w(px(80.0))
                .h(px(48.0))
                .accessibility_state(selected())
                .element_ref(&anchor),
        )
        .child(
            overlay()
                .anchor(&anchor)
                .placement(nsh_core::overlay::Placement::Bottom)
                .align(nsh_core::overlay::Align::Start)
                .offset(px(4.0))
                .child(text("tooltip")),
        )
        .child(view().absolute().top(px(400.0)).child(text("ready")))
}

#[test]
fn a_bottom_tooltip_starts_after_the_anchors_last_cell_row() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 32)).unwrap();
    view.load(App::Rust(Root::new::<AnchoredTooltip>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "tooltip");
    let buffer = terminal.backend().buffer();
    assert!(banded(buffer, 2, 15));
    assert_eq!(buffer[(2, 15)].symbol(), " ");
    assert_eq!(buffer[(2, 16)].symbol(), "t");
    assert!(!banded(buffer, 2, 16));
}

#[component]
fn AnchorsOnEverySide() -> impl IntoElement {
    use nsh_core::overlay::{Align, Placement};
    let moved = signal(false);
    view()
        .flex_1()
        .children(
            [
                Placement::Top,
                Placement::Bottom,
                Placement::Left,
                Placement::Right,
            ]
            .into_iter()
            .enumerate()
            .map(|(index, side)| {
                let anchor = element_ref();
                view()
                    .child(
                        view()
                            .absolute()
                            .left(px(40.0 + index as f32 * 80.0))
                            .top(move || px(if moved.get() { 96.0 } else { 64.0 }))
                            .w(px(8.0))
                            .h(px(16.0))
                            .element_ref(&anchor),
                    )
                    .child(
                        overlay()
                            .anchor(&anchor)
                            .placement(side)
                            .align(Align::Start)
                            .offset(px(0.0))
                            .child(text("X")),
                    )
            }),
        )
        .child(
            view()
                .absolute()
                .top(px(160.0))
                .on_press(move |_: &()| moved.set(true))
                .child(text(move || if moved.get() { "moved" } else { "move" })),
        )
}

#[test]
fn overlays_follow_moving_anchors_on_all_four_sides() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(50, 16)).unwrap();
    view.load(App::Rust(Root::new::<AnchorsOnEverySide>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "move");
    for row in [4, 6] {
        let buffer = terminal.backend().buffer();
        for (x, y) in [(5, row - 1), (15, row + 1), (24, row), (36, row)] {
            assert_eq!(buffer[(x, y)].symbol(), "X", "overlay {x},{y}");
        }
        if row == 4 {
            for key in ["Tab", "Enter"] {
                view.handle(nsh_platform_tui::Input::Key {
                    key: key.into(),
                    modifiers: Default::default(),
                    release: false,
                });
            }
            draw_until(&mut view, &mut terminal, &rx, "moved");
        }
    }
}

#[component]
fn CrowdedCard() -> impl IntoElement {
    let phase = signal(0u32);
    view()
        .flex_1()
        .child(
            view()
                .absolute()
                .left(px(16.0))
                .top(move || px(96.0 + phase.get() as f32))
                .w(px(240.0))
                .border_1()
                .p(px(5.0))
                .child(
                    view()
                        .pt(px(11.0))
                        .pb(px(12.0))
                        .gap(px(2.0))
                        .child(text("Heading"))
                        .child(text("Description")),
                )
                .child(
                    view()
                        .border_1()
                        .p(px(14.0))
                        .child(view().children((0..4).map(|i| {
                            view().py(px(6.0)).child(
                                view()
                                    .gap(px(2.0))
                                    .child(text(format!("Body {i}")))
                                    .child(text(format!("Detail {i}"))),
                            )
                        }))),
                ),
        )
        .child(
            view()
                .absolute()
                .top(px(600.0))
                .on_press(move |_: &()| phase.update(|value| *value += 1))
                .child(text(move || format!("ready{}", phase.get()))),
        )
}

#[test]
fn fitting_a_card_header_does_not_let_the_next_inset_erase_its_subtitle() {
    use std::sync::Arc;

    use nsh_platform_tui::{AppOptions, AppView, CellSize};
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.cells = CellSize::new(px(8.0), px(24.0)).unwrap();
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(40, 30)).unwrap();
    view.load(App::Rust(Root::new::<CrowdedCard>(|| ())))
        .unwrap();
    for phase in 0..24 {
        draw_until(&mut view, &mut terminal, &rx, &format!("ready{phase}"));
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        for expected in [
            "Heading",
            "Description",
            "Body 0",
            "Detail 0",
            "Body 1",
            "Detail 1",
            "Body 2",
            "Detail 2",
            "Body 3",
            "Detail 3",
        ] {
            assert!(
                text.contains(expected),
                "phase {phase}: missing {expected}: {text}"
            );
        }
        if phase == 0 {
            view.handle(nsh_platform_tui::Input::Key {
                key: "Tab".into(),
                modifiers: Default::default(),
                release: false,
            });
        }
        view.handle(nsh_platform_tui::Input::Key {
            key: "Enter".into(),
            modifiers: Default::default(),
            release: false,
        });
    }
}

#[component]
fn AdjacentLabels() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .absolute()
                .left(px(16.0))
                .top(px(16.0))
                .flex_row()
                .gap(px(2.0))
                .child(text("All"))
                .child(text("22"))
                .child(text("Up")),
        )
        .child(
            view()
                .absolute()
                .left(px(16.0))
                .top(px(48.0))
                .flex_row_reverse()
                .gap(px(2.0))
                .child(text("All"))
                .child(text("22"))
                .child(text("Up")),
        )
        .child(
            view()
                .absolute()
                .left(px(16.0))
                .top(px(80.0))
                .flex_row()
                .child(text("All"))
                .child(text("22")),
        )
        .child(
            view()
                .absolute()
                .left(px(16.0))
                .top(px(128.0))
                .w(px(80.0))
                .h(px(32.0))
                .border_1()
                .flex_row()
                .items_center()
                .gap(px(2.0))
                .child(text("All"))
                .child(text("22"))
                .child(text("Up")),
        )
        .child(
            view()
                .absolute()
                .left(px(16.0))
                .top(px(176.0))
                .w(px(128.0))
                .h(px(32.0))
                .border_1()
                .items_center()
                .justify_center()
                .child(
                    view()
                        .absolute()
                        .left(px(24.0))
                        .top(px(3.0))
                        .w(px(80.0))
                        .h(px(26.0))
                        .border_1()
                        .rounded(px(8.0))
                        .accessibility_state(selected()),
                )
                .child(
                    view()
                        .flex_row()
                        .gap(px(2.0))
                        .child(text("All"))
                        .child(text("22")),
                ),
        )
        .child(view().absolute().top(px(112.0)).child(text("ready")))
}

#[test]
fn positive_gaps_between_sibling_labels_keep_a_cell_in_either_row_direction() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 14)).unwrap();
    view.load(App::Rust(Root::new::<AdjacentLabels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let row = |y| (0..40).map(|x| buffer[(x, y)].symbol()).collect::<String>();
    let all = (0..14).map(row).collect::<Vec<_>>().join("\n");
    assert!(row(1).contains("All 22 Up"), "{all}");
    assert!(row(3).contains("Up 22 All"), "{}", row(3));
    assert!(row(5).contains("All22"), "{}", row(5));
    // A box of text has no border: its labels are its first row.
    assert!(row(8).contains("All 22 Up"), "{}", row(8));
    // Centered in its 2 rows, rounded down to the first.
    assert!(row(11).contains("All 22"), "{all}");
}

#[component]
fn AdjacentCanvasLabels() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .fill_color(nsh_core::color::rgb(0xffffff))
                    .text_baseline(nsh_core::canvas::CanvasTextBaseline::Top)
                    .fill_text("09:09", 0.0, 0.0)
                    .fill_text("10:15", 42.0, 0.0)
                    .fill_text("10:15", 42.0, 32.0)
                    .fill_text("09:09", 0.0, 32.0)
                    .fill_text("09:09", 0.0, 64.0)
                    .fill_text("10:15", 40.0, 64.0),
            )
            .label("drawing")
            .absolute()
            .left(px(16.0))
            .top(px(16.0))
            .w(px(200.0))
            .h(px(96.0)),
        )
        .child(view().absolute().top(px(128.0)).child(text("ready")))
}

#[test]
fn positive_gaps_between_canvas_labels_keep_a_cell_without_spacing_graphemes() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<AdjacentCanvasLabels>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let row = |y| (0..40).map(|x| buffer[(x, y)].symbol()).collect::<String>();
    assert!(row(1).contains("09:09 10:15"), "{}", row(1));
    assert!(row(3).contains("09:09 10:15"), "{}", row(3));
    assert!(row(5).contains("09:0910:15"), "{}", row(5));
}
