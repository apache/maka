//! A `DataTable` in a terminal: its header and rows sit on absolute
//! layers inside a bordered root that grows into its column, and the
//! Cells draw its titles and values, not only its frame.

use nsh_base::{DataTableColumn, DataTableRows, data_table};
use nsh_core::prelude::*;
use nsh_platform_tui::{App, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::app::{draw_until, surface};

fn column(key: &str, title: &str) -> DataTableColumn {
    let mut c = DataTableColumn::default();
    c.key = key.to_owned().into();
    c.title = Some(title.to_owned().into());
    c
}

/// A status line over a table that takes the rest of the column, laid
/// out as the gallery's demo lays out its own.
#[component]
fn Quotes() -> impl IntoElement {
    let rows = DataTableRows::new(3)
        .texts("symbol", ["AAPL", "MSFT", "NVDA"])
        .numbers("last", [231.5, 412.0, 118.25]);
    view().flex_1().child(text("Quotes")).child(
        data_table()
            .flex_1()
            .rounded(px(8.0))
            .border_1()
            .columns(vec![column("symbol", "Symbol"), column("last", "Last")])
            .data(rows),
    )
}

#[test]
fn a_tables_header_and_rows_are_drawn_inside_its_border() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<Quotes>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Quotes");
    for shown in ["Symbol", "Last", "AAPL", "231.5", "MSFT", "NVDA"] {
        draw_until(&mut view, &mut terminal, &rx, shown);
    }
}

/// Forty rows in a table whose second column runs past its right edge.
#[component]
fn Overflowing() -> impl IntoElement {
    let names: Vec<String> = (0..40)
        .map(|i| format!("Company number {i} incorporated"))
        .collect();
    let mut name = column("name", "Name");
    name.width = Some(px(320.0));
    let mut symbol = column("symbol", "Symbol");
    symbol.width = Some(px(80.0));
    view().flex_1().child(text("Wide")).child(
        data_table().flex_1().columns(vec![symbol, name]).data(
            DataTableRows::new(40)
                .texts("symbol", (0..40).map(|i| format!("S{i}")))
                .texts("name", names),
        ),
    )
}

#[test]
fn a_column_past_the_right_edge_leaves_the_scroll_bar_its_column() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 12)).unwrap();
    view.load(App::Rust(Root::new::<Overflowing>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Company");
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..12)
        .map(|y| {
            (0..30)
                .map(|x| buffer[(x, y)].symbol().to_string())
                .collect()
        })
        .collect();
    let first = rows
        .iter()
        .position(|r| r.contains("S0"))
        .expect("the first row");
    // The rows' cells stop a Cell short of the edge, where the bar is
    // drawn on every row: a cell under it would hide it.
    for row in &rows[first..] {
        let last = row.chars().last().unwrap();
        assert!(matches!(last, '│' | '┃'), "{rows:#?}");
    }
}
