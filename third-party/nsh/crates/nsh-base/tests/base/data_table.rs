//! `DataTable` with rows a Rust app makes a column at a time, each of one
//! type: the texts, numbers and booleans the table shows.

use nsh_base::{DataTableColumn, DataTableRows, data_table};
use nsh_core::{Size, element::Root, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

fn start<C: Component<Props = ()>>() -> Headless {
    let config = EngineConfig {
        viewport: Size::new(px(600.0), px(300.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

fn column(key: &str) -> DataTableColumn {
    let mut c = DataTableColumn::default();
    c.key = key.to_owned().into();
    c
}

/// Quotes: a text, two number and a boolean column.
#[component]
fn Quotes() -> impl IntoElement {
    let rows = DataTableRows::new(2)
        .texts("symbol", ["AAPL", "MSFT"])
        .numbers("last", [231.5, 412.0])
        .numbers("change", [1.2, -0.4])
        .bools("open", [true, false]);
    data_table()
        .h(px(200.0))
        .columns(vec![
            column("symbol"),
            column("last"),
            column("change"),
            column("open"),
        ])
        .data(rows)
}

#[test]
fn rows_made_in_rust_show_their_cells() {
    let mut app = start::<Quotes>();
    for shown in [
        "AAPL", "231.5", "1.2", "MSFT", "412", "-0.4", "true", "false",
    ] {
        app.wait_for(shown).unwrap();
    }
}
