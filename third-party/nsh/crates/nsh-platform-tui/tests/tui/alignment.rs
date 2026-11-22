//! Alignment on the Cell grid: what lines up in points lines up in Cells.

use nsh_core::prelude::*;
use nsh_platform_tui::{App, Root};
use ratatui_core::{backend::TestBackend, buffer::Buffer, terminal::Terminal};

use super::app::{draw_until, surface};

/// The first and last-plus-one columns of `word` on each row it appears on.
fn spans(buffer: &Buffer, word: &str) -> Vec<(u16, u16, u16)> {
    (0..buffer.area.height)
        .filter_map(|y| {
            let row: String = (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect();
            let start = row.find(word)?;
            let start = row[..start].chars().count() as u16;
            Some((y, start, start + word.chars().count() as u16))
        })
        .collect()
}

fn dump(buffer: &Buffer) -> String {
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn left(buffer: &Buffer, word: &str) -> u16 {
    let found = spans(buffer, word);
    assert_eq!(found.len(), 1, "{word:?}: {found:?}\n{}", dump(buffer));
    found[0].1
}

fn right(buffer: &Buffer, word: &str) -> u16 {
    let found = spans(buffer, word);
    assert_eq!(found.len(), 1, "{word:?}: {found:?}");
    found[0].2
}

#[component]
fn Ledger() -> impl IntoElement {
    let rows = [
        ("Open", "47.92"),
        ("Volume", "1.03M"),
        ("Turnover", "45.56M"),
        ("Low", "955.3K"),
    ];
    view()
        .flex_1()
        .pt(px(5.0))
        .child(
            view()
                .ml(px(13.0))
                .w(px(141.0))
                .children(rows.map(|(name, value)| {
                    view()
                        .h(px(18.0))
                        .flex_row()
                        .justify_between()
                        .items_center()
                        .child(text(name))
                        .child(text(value))
                })),
        )
        .child(view().ml(px(5.0)).pl(px(8.0)).child(text("Section")))
        .child(text("ready").absolute().top(px(200.0)))
}

#[test]
fn equal_point_x_is_one_column_and_right_aligned_values_share_their_right_edge() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 14)).unwrap();
    view.load(App::Rust(Root::new::<Ledger>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let names = ["Open", "Volume", "Turnover", "Low", "Section"];
    let lefts: Vec<_> = names.iter().map(|name| left(buffer, name)).collect();
    assert!(lefts.iter().all(|&x| x == lefts[0]), "{lefts:?}");
    let rights: Vec<_> = ["47.92", "1.03M", "45.56M", "955.3K"]
        .iter()
        .map(|value| right(buffer, value))
        .collect();
    assert!(rights.iter().all(|&x| x == rights[0]), "{rights:?}");
}

#[component]
fn StatsGrid() -> impl IntoElement {
    let columns = |labels: [&'static str; 4]| {
        view()
            .flex_row()
            .h(px(18.0))
            .children(labels.map(|label| view().flex_1().child(text(label))))
    };
    view()
        .flex_1()
        .px(px(13.0))
        .w(px(330.0))
        .child(columns(["Open", "Prev", "Avg", "Amp"]))
        .child(columns(["47.92", "48.20", "47.69", "6.93%"]))
        .child(columns(["Volume", "Turnover", "120d", "Low"]))
        .child(columns(["955.3K", "45.56M", "53.14", "47.32"]))
        .child(text("ready").absolute().top(px(160.0)))
}

#[test]
fn values_start_in_their_headings_columns() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(44, 12)).unwrap();
    view.load(App::Rust(Root::new::<StatsGrid>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    for column in [
        ["Open", "47.92", "Volume", "955.3K"],
        ["Prev", "48.20", "Turnover", "45.56M"],
        ["Avg", "47.69", "120d", "53.14"],
        ["Amp", "6.93%", "Low", "47.32"],
    ] {
        let lefts: Vec<_> = column.iter().map(|word| left(buffer, word)).collect();
        assert!(
            lefts.iter().all(|&x| x == lefts[0]),
            "{column:?}: {lefts:?}"
        );
    }
}

#[component]
fn CenteredRow() -> impl IntoElement {
    view()
        .flex_1()
        .children([0.0, 5.0, 11.0].map(|top| {
            view()
                .absolute()
                .top(px(top * 4.0))
                .left(px(top * 30.0))
                .h(px(36.0))
                .flex_row()
                .items_center()
                .gap(px(10.0))
                .child(
                    canvas(Painter::new().fill_rect(0.0, 0.0, 17.0, 17.0))
                        .label("icon")
                        .w(px(17.0))
                        .h(px(17.0)),
                )
                .child(text("label"))
                .child(text("[x]").text_size(px(11.0)))
        }))
        .child(text("ready").absolute().top(px(160.0)))
}

#[test]
fn siblings_centered_on_a_row_share_it_and_icons_take_no_cells() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(App::Rust(Root::new::<CenteredRow>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    let buffer = terminal.backend().buffer();
    let labels = spans(buffer, "label");
    let marks = spans(buffer, "[x]");
    assert_eq!(labels.len(), 3, "{labels:?}");
    // Each row starts at its inset in whole Cells (0, 150 and 330 points);
    // the icon is left out, so the label starts the row.
    for (((y, start, _), (mark_y, ..)), left) in labels.iter().zip(&marks).zip([0, 19, 41]) {
        assert_eq!(y, mark_y, "{}", dump(buffer));
        assert_eq!(*start, left, "the label starts its row\n{}", dump(buffer));
    }
}
