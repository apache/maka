use nsh_core::{
    AccessibilityRole, Bounds, Point, Points, Size,
    canvas::{CanvasNode, CanvasTextAlign, CanvasTextBaseline, FillRule},
    prelude::*,
};
use nsh_platform_tui::{App, Root};
use ratatui_core::{
    backend::TestBackend,
    buffer::Buffer,
    style::{Color, Modifier},
    terminal::Terminal,
};

use super::app::{draw_until, mouse, surface};

const RED: u32 = 0xff0000;
const GREEN: u32 = 0x00ff00;

fn rect(x: f32, y: f32, width: f32, height: f32) -> Bounds<Points> {
    Bounds::new(Point::new(px(x), px(y)), Size::new(px(width), px(height)))
}

fn row(buffer: &Buffer, y: u16, columns: std::ops::Range<u16>) -> String {
    columns.map(|x| buffer[(x, y)].symbol()).collect()
}

#[component]
fn Shapes() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .fill_color(nsh_core::color::rgb(RED))
                    .fill_rect(0.0, 0.0, 40.0, 48.0)
                    .stroke_color(nsh_core::color::rgb(GREEN))
                    .begin_path()
                    .move_to(50.0, 2.0)
                    .line_to(160.0, 2.0)
                    .stroke()
                    .line_dash(&[px(8.0), px(8.0)])
                    .begin_path()
                    .move_to(50.0, 22.0)
                    .line_to(160.0, 22.0)
                    .stroke()
                    .fill_color(nsh_core::color::rgb(GREEN))
                    .text_align(CanvasTextAlign::Center)
                    .text_baseline(CanvasTextBaseline::Top)
                    .fill_text("Hi", 80.0, 32.0),
            )
            .label("drawing")
            .w(px(160.0))
            .h(px(48.0)),
        )
        .child(
            canvas(
                Painter::new()
                    .global_alpha(0.5)
                    .fill_color(nsh_core::color::rgb(0xffffff))
                    .fill_rect(0.0, 0.0, 16.0, 16.0),
            )
            .label("drawing")
            .w(px(64.0))
            .h(px(32.0))
            .bg(nsh_core::color::rgb(0x000000)),
        )
        .child(text("drawn"))
}

#[component]
fn Icon() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .fill_color(nsh_core::color::rgb(0xffffff))
                    .fill_rect(0.0, 0.0, 16.0, 16.0),
            )
            .w(px(16.0))
            .h(px(16.0)),
        )
        .child(text("ready"))
}

#[test]
fn icon_sized_canvases_draw_nothing() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 3)).unwrap();
    view.load(App::Rust(Root::new::<Icon>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let drawn: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert_eq!(drawn.replace(' ', ""), "ready", "{drawn:?}");
}

#[test]
fn canvas_fills_strokes_dashes_and_text_draw_in_braille_cells() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(24, 6)).unwrap();
    view.load(App::Rust(Root::new::<Shapes>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    for y in 0..3 {
        assert_eq!(
            row(buffer, y, 0..5),
            "⣿⣿⣿⣿⣿",
            "the filled rectangle, row {y}"
        );
        assert_eq!(buffer[(0, y)].fg, Color::Rgb(255, 0, 0));
    }
    assert_eq!(
        row(buffer, 0, 6..20),
        "⠉".repeat(14),
        "a line through the top dots"
    );
    assert_eq!(buffer[(6, 0)].fg, Color::Rgb(0, 255, 0));
    assert_eq!(
        row(buffer, 1, 6..12),
        "⠒ ⠒ ⠒ ",
        "a dash pattern of one Cell on, one off"
    );
    assert_eq!(
        row(buffer, 2, 9..11),
        "Hi",
        "text centered on its x, its top at y"
    );
    assert_eq!(buffer[(9, 2)].fg, Color::Rgb(0, 255, 0));
    assert_eq!(buffer[(0, 3)].symbol(), "⣿");
    assert_eq!(
        buffer[(0, 3)].fg,
        Color::Rgb(128, 128, 128),
        "globalAlpha blends the paint over the color under it"
    );
    assert_eq!(buffer[(0, 3)].bg, Color::Reset, "fills draw nothing");
    let contents: String = buffer.content.iter().map(|c| c.symbol()).collect();
    assert!(!contents.contains("Canvas"), "no placeholder is drawn");
}

#[component]
fn Clipped() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .begin_path()
                    .rect(rect(0.0, 0.0, 40.0, 32.0))
                    .clip()
                    .fill_color(nsh_core::color::rgb(RED))
                    .fill_rect(0.0, 0.0, 80.0, 32.0)
                    .stroke_color(nsh_core::color::rgb(GREEN))
                    .begin_path()
                    .move_to(0.0, 30.0)
                    .line_to(80.0, 30.0)
                    .stroke(),
            )
            .label("drawing")
            .w(px(80.0))
            .h(px(32.0)),
        )
        .child(
            canvas(
                Painter::new()
                    .fill_color(nsh_core::color::rgb(RED))
                    .begin_path()
                    .rect(rect(0.0, 0.0, 80.0, 16.0))
                    .rect(rect(16.0, 0.0, 48.0, 16.0))
                    .fill_with(FillRule::EvenOdd),
            )
            .label("drawing")
            .w(px(80.0))
            .h(px(16.0)),
        )
        .child(text("clipped"))
}

#[test]
fn a_clip_keeps_fills_and_strokes_inside_and_fill_rules_pick_the_dots() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Clipped>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "clipped");
    let buffer = terminal.backend().buffer();
    assert_eq!(row(buffer, 0, 0..10), "⣿⣿⣿⣿⣿     ");
    assert_eq!(
        row(buffer, 1, 5..10),
        "     ",
        "the stroke outside the clip is left out"
    );
    assert_eq!(
        buffer[(4, 1)].fg,
        Color::Rgb(0, 255, 0),
        "the stroke inside it is drawn"
    );
    assert_eq!(
        row(buffer, 2, 0..10),
        "⣿⣿      ⣿⣿",
        "even-odd leaves the inner rectangle out"
    );
}

const RIGHT_HALF: (f32, f32, f32, f32) = (40.0, 0.0, 40.0, 16.0);

#[component]
fn Pads() -> impl IntoElement {
    let presses = signal(0);
    let (x, y, width, height) = RIGHT_HALF;
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .fill_color(nsh_core::color::rgb(GREEN))
                    .fill_rect(x, y, width, height)
                    .node(
                        CanvasNode::new(
                            rect(x, y, width, height),
                            AccessibilityRole::Button,
                            "Right",
                        )
                        .test_id("right"),
                    ),
            )
            .label("drawing")
            .w(px(80.0))
            .h(px(16.0))
            .on_press(move || presses.update(|n| *n += 1)),
        )
        .child(text(move || format!("Pressed {}", presses.get())))
}

#[test]
fn a_press_at_a_canvas_nodes_center_reaches_the_canvas() {
    use nsh_platform_tui::{MouseButton, MouseKind};
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 3)).unwrap();
    view.load(App::Rust(Root::new::<Pads>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Pressed 0");
    // A test step presses a canvas node at its center, as a pointer there.
    let (x, y, width, height) = RIGHT_HALF;
    let column = ((x + width / 2.0) / 8.0).floor() as u16;
    let row = ((y + height / 2.0) / 16.0).floor() as u16;
    assert_eq!(terminal.backend().buffer()[(column, row)].symbol(), "⣿");
    view.handle(mouse(MouseKind::Down(MouseButton::Left), column, row));
    view.handle(mouse(MouseKind::Up(MouseButton::Left), column, row));
    draw_until(&mut view, &mut terminal, &rx, "Pressed 1");
}

/// A line through the row of a label on it.
#[component]
fn Labelled() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .stroke_color(nsh_core::color::rgb(GREEN))
                    .begin_path()
                    .move_to(0.0, 6.0)
                    .line_to(160.0, 6.0)
                    .stroke()
                    .fill_color(nsh_core::color::rgb(RED))
                    .text_align(CanvasTextAlign::Center)
                    .text_baseline(CanvasTextBaseline::Top)
                    .fill_text("20", 80.0, 0.0),
            )
            .label("chart")
            .w(px(160.0))
            .h(px(32.0)),
        )
        .child(text("drawn"))
}

#[test]
fn a_canvas_label_keeps_a_cell_clear_of_dots_each_side() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<Labelled>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    let line = row(buffer, 0, 0..20);
    let at = line.find("20").expect("the label is drawn");
    let at = line[..at].chars().count() as u16;
    assert_eq!(buffer[(at - 1, 0)].symbol(), " ", "{line}");
    assert_eq!(buffer[(at + 2, 0)].symbol(), " ", "{line}");
    assert_ne!(
        buffer[(at - 2, 0)].symbol(),
        " ",
        "the line goes on: {line}"
    );
    assert_ne!(
        buffer[(at + 3, 0)].symbol(),
        " ",
        "the line goes on: {line}"
    );
}

/// A ring's track at 13%: a fill too faint to read as a wash.
#[component]
fn FaintTrack() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .global_alpha(0.13)
                    .fill_color(nsh_core::color::rgb(0xffffff))
                    .fill_rect(0.0, 0.0, 64.0, 32.0),
            )
            .label("drawing")
            .w(px(64.0))
            .h(px(32.0)),
        )
        .child(text("drawn"))
}

#[test]
fn a_fill_fainter_than_a_wash_is_its_outline_in_the_faintest_gray() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<FaintTrack>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    // A track's full scale shows: its outline is drawn, its inside not.
    let first = row(buffer, 0, 0..8);
    assert!(
        first.chars().all(|c| c != ' '),
        "the outline's top: {first:?}"
    );
    assert!(
        first.chars().skip(1).take(6).all(|c| c != '⣿'),
        "a hairline, not the inside: {first:?}"
    );
    assert!(
        buffer[(1, 0)].modifier.contains(Modifier::DIM),
        "in the faintest gray"
    );
}

/// A faint track under a mark that crosses it, the mark last.
#[component]
fn TrackUnderMark() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .stroke_color(nsh_core::color::rgba(0xffffff10))
                    .begin_path()
                    .move_to(0.0, 2.0)
                    .line_to(64.0, 2.0)
                    .stroke()
                    .stroke_color(nsh_core::color::rgb(0xff0000))
                    .begin_path()
                    .move_to(0.0, 0.0)
                    .line_to(64.0, 0.0)
                    .stroke()
                    .stroke_color(nsh_core::color::rgba(0xffffff10))
                    .begin_path()
                    .move_to(0.0, 4.0)
                    .line_to(64.0, 4.0)
                    .stroke(),
            )
            .label("drawing")
            .w(px(64.0))
            .h(px(16.0)),
        )
        .child(text("drawn"))
}

#[test]
fn a_faint_stroke_is_drawn_under_the_marks_it_shares_cells_with() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<TrackUnderMark>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    let cell = &buffer[(2, 0)];
    assert_ne!(cell.symbol(), " ", "the strokes are drawn");
    assert!(
        !cell.modifier.contains(Modifier::DIM),
        "the mark's ink, not the track's, even drawn before the last track"
    );
}

#[component]
fn Wash() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .global_alpha(0.3)
                    .fill_color(nsh_core::color::rgb(0xffffff))
                    .fill_rect(0.0, 0.0, 64.0, 32.0),
            )
            .label("drawing")
            .w(px(64.0))
            .h(px(32.0)),
        )
        .child(text("drawn"))
}

#[test]
fn a_translucent_fill_is_a_sparse_floor_of_dots() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Wash>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    let first = row(buffer, 0, 0..4);
    assert!(
        first.chars().all(|c| c == '⡀'),
        "one dot per Cell, not a block: {first:?}"
    );
}

/// Hatching at a few percent over a zone, and a line drawn over it.
#[component]
fn Hatched() -> impl IntoElement {
    let mut painter = Painter::new()
        .stroke_color(nsh_core::color::rgba(0xffffff0f))
        .begin_path();
    for i in (-32..64).step_by(7) {
        painter = painter
            .move_to(i as f32, 32.0)
            .line_to(i as f32 + 32.0, 0.0);
    }
    view()
        .flex_1()
        .child(
            canvas(
                painter
                    .stroke()
                    .stroke_color(nsh_core::color::rgb(GREEN))
                    .begin_path()
                    .move_to(0.0, 2.0)
                    .line_to(64.0, 2.0)
                    .stroke(),
            )
            .label("drawing")
            .w(px(64.0))
            .h(px(32.0)),
        )
        .child(text("drawn"))
}

#[test]
fn a_nearly_transparent_stroke_is_texture_in_the_faintest_gray_under_the_marks() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Hatched>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    assert!(
        row(buffer, 0, 0..4).chars().all(|c| c != ' '),
        "the line is drawn"
    );
    for x in 0..4 {
        assert!(
            !buffer[(x, 0)].modifier.contains(Modifier::DIM),
            "the line keeps its own color over the hatching"
        );
    }
    let hatching = (0..4).filter(|&x| buffer[(x, 1)].symbol() != " ");
    for x in hatching {
        assert!(
            buffer[(x, 1)].modifier.contains(Modifier::DIM),
            "the hatching is the faintest gray"
        );
    }
}

/// A label under a canvas drawn after it, as a ring's value in its middle.
#[component]
fn Under() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(160.0))
                .h(px(32.0))
                .child(text("49").absolute().top(px(0.0)).left(px(64.0)))
                .child(
                    canvas(
                        Painter::new()
                            .fill_color(nsh_core::color::rgb(GREEN))
                            .fill_rect(0.0, 0.0, 160.0, 16.0),
                    )
                    .label("ring")
                    .absolute()
                    .top(px(0.0))
                    .left(px(0.0))
                    .w(px(160.0))
                    .h(px(32.0)),
                ),
        )
        .child(text("drawn"))
}

#[test]
fn a_canvas_over_a_text_leaves_it_and_a_cell_each_side_clear() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<Under>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    let line = row(buffer, 0, 0..20);
    assert_eq!(row(buffer, 0, 7..11), " 49 ", "{line}");
    assert_eq!(row(buffer, 0, 5..7), "⣿⣿", "the fill goes on: {line}");
    assert_eq!(row(buffer, 0, 11..13), "⣿⣿", "the fill goes on: {line}");
}

/// A filled card over a canvas, as a photo card over a stage's dots.
#[component]
fn Covered() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .w(px(96.0))
                .h(px(32.0))
                .child(
                    canvas(
                        Painter::new()
                            .fill_color(nsh_core::color::rgb(GREEN))
                            .fill_rect(0.0, 0.0, 96.0, 32.0),
                    )
                    .label("dots")
                    .absolute()
                    .top(px(0.0))
                    .left(px(0.0))
                    .w(px(96.0))
                    .h(px(32.0)),
                )
                .child(
                    view()
                        .absolute()
                        .top(px(0.0))
                        .left(px(32.0))
                        .w(px(32.0))
                        .h(px(32.0))
                        .bg(nsh_core::color::rgb(0x27272a))
                        .border_1()
                        .border_color(nsh_core::color::rgb(0x52525b)),
                ),
        )
        .child(text("drawn"))
}

#[test]
fn an_opaque_box_over_a_canvas_hides_its_dots() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(16, 4)).unwrap();
    view.load(App::Rust(Root::new::<Covered>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    assert_eq!(row(buffer, 0, 0..4), "⣿⣿⣿⣿", "the dots beside it");
    assert!(
        row(buffer, 0, 4..8)
            .chars()
            .all(|c| !('\u{2801}'..='\u{28ff}').contains(&c)),
        "no dots under the box: {:?}",
        row(buffer, 0, 0..12)
    );
    assert_eq!(row(buffer, 0, 8..12), "⣿⣿⣿⣿", "the dots past it");
}

/// A plot's rising line in a box with a Cell of padding each side, and a
/// mark after the box.
#[component]
fn PaddedPlot() -> impl IntoElement {
    let rows = nsh_core::element::Rows::from_columns(3, [("value".into(), vec![1.0, 2.0, 3.0])]);
    view()
        .flex_1()
        .child(
            view()
                .flex_row()
                .child(
                    view().px(px(8.0)).child(
                        nsh_base::plot::plot()
                            .data(rows)
                            .y(nsh_core::element::RowAccessor::key("value"))
                            .w(px(128.0))
                            .h(px(32.0))
                            .stroke_width(px(2.0))
                            .child(
                                nsh_base::plot::line()
                                    .curve(nsh_base::plot::Curve::Linear)
                                    .stroke_color(nsh_core::color::rgb(GREEN)),
                            ),
                    ),
                )
                .child(text("|")),
        )
        .child(text("drawn"))
}

#[test]
fn a_plots_marks_stay_inside_the_plot_and_off_its_padding() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    view.load(App::Rust(Root::new::<PaddedPlot>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let buffer = terminal.backend().buffer();
    let braille = |x: u16, y: u16| {
        buffer[(x, y)]
            .symbol()
            .chars()
            .next()
            .is_some_and(|c| ('\u{2801}'..='\u{28ff}').contains(&c))
    };
    // The padding Cell, the plot's 16 Cells, the padding Cell, the mark.
    assert_eq!(buffer[(18, 0)].symbol(), "|", "{:?}", row(buffer, 0, 0..24));
    let drawn = |x: u16| (0..2).any(|y| braille(x, y));
    assert!(
        drawn(1),
        "the line starts at the plot's left: {:?}",
        row(buffer, 1, 0..24)
    );
    assert!(
        drawn(16),
        "and reaches its right: {:?}",
        row(buffer, 0, 0..24)
    );
    for x in [0, 17] {
        assert!(
            !drawn(x),
            "no dot in the padding at column {x}: {:?} / {:?}",
            row(buffer, 0, 0..24),
            row(buffer, 1, 0..24)
        );
    }
}

/// A dot matrix of 1.5pt squares and a 1pt rule, neither holding a dot's
/// center.
#[component]
fn Specks() -> impl IntoElement {
    let mut painter = Painter::new().fill_color(nsh_core::color::rgb(0xffffff));
    for x in [8.0, 24.0, 40.0, 56.0] {
        painter = painter.fill_rect(x - 0.75, 7.25, 1.5, 1.5);
    }
    view()
        .flex_1()
        .child(
            canvas(painter.fill_rect(0.0, 20.5, 64.0, 1.0))
                .label("drawing")
                .w(px(64.0))
                .h(px(32.0)),
        )
        .child(text("drawn"))
}

#[test]
fn fills_smaller_than_a_dot_take_the_dots_under_them() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Specks>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    // Each square is one dot, every other Cell, in one phase.
    let specks = row(buffer, 0, 0..8);
    assert_eq!(specks, " ⠄ ⠄ ⠄ ⠄", "one dot per square: {specks:?}");
    // The rule is a line of dots across the canvas.
    let rule = row(buffer, 1, 0..8);
    assert!(
        rule.chars().all(|c| c != ' '),
        "the rule shows in every Cell: {rule:?}"
    );
}

/// A guide's dashes of 3 points, gaps of 5: under a dot each, as the
/// physics demo's crosshair draws them.
#[component]
fn FineDashes() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            canvas(
                Painter::new()
                    .stroke_color(nsh_core::color::rgb(GREEN))
                    .line_dash(&[px(3.0), px(5.0)])
                    .begin_path()
                    .move_to(22.0, 0.0)
                    .line_to(22.0, 44.0)
                    .move_to(40.0, 22.0)
                    .line_to(160.0, 22.0)
                    .stroke(),
            )
            .label("drawing")
            .w(px(160.0))
            .h(px(48.0)),
        )
        .child(text("drawn"))
}

/// Whether the braille Cell's dot at `column` (0, 1) and `row` (0 to 3)
/// is set.
fn braille_dot(symbol: &str, column: usize, row: usize) -> bool {
    const BITS: [[u32; 4]; 2] = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]];
    let code = symbol.chars().next().map_or(0, u32::from);
    (0x2800..=0x28ff).contains(&code) && (code - 0x2800) & BITS[column][row] != 0
}

/// The lengths of the runs of set and unset dots in `dots`, from its first
/// set one to its last.
fn runs(dots: &[bool]) -> (Vec<usize>, Vec<usize>) {
    let first = dots.iter().position(|&d| d).unwrap();
    let last = dots.iter().rposition(|&d| d).unwrap();
    let (mut on, mut off) = (Vec::new(), Vec::new());
    let mut at = first;
    while at <= last {
        let lit = dots[at];
        let length = dots[at..=last].iter().take_while(|&&d| d == lit).count();
        if lit {
            on.push(length)
        } else {
            off.push(length)
        }
        at += length;
    }
    (on, off)
}

#[test]
fn dashes_shorter_than_a_dot_draw_as_dashes_not_as_a_dotted_line() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(24, 6)).unwrap();
    view.load(App::Rust(Root::new::<FineDashes>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "drawn");
    let buffer = terminal.backend().buffer();
    // Along the row at y = 22 (Cell row 1, dot row 1) from x = 40, and the
    // column at x = 22 (Cell 2, its right dots) to y = 44.
    let across: Vec<bool> = (10..40)
        .map(|dot| braille_dot(buffer[(dot / 2, 1)].symbol(), dot as usize % 2, 1))
        .collect();
    let down: Vec<bool> = (0..12)
        .map(|dot| braille_dot(buffer[(2, dot / 4)].symbol(), 1, dot as usize % 4))
        .collect();
    for (line, dots) in [("across", across), ("down", down)] {
        let (on, off) = runs(&dots);
        assert!(on.len() >= 2, "{line}: several dashes: {dots:?}");
        assert!(
            on.iter().all(|&length| length >= 2),
            "{line}: each dash two dots at least: {on:?}"
        );
        assert!(
            off.iter().all(|&length| length >= 2),
            "{line}: and each gap: {off:?}"
        );
    }
}
