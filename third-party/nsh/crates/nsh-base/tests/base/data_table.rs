//! `DataTable` with rows a Rust app makes a column at a time, each of one
//! type: the texts, numbers and booleans the table shows; its column
//! handles are the pointer's alone, in a terminal too, and draw no line
//! there until the pointer is on them; a title's sort is one glyph there.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use nsh_base::{
    DataTableColumn, DataTableRows, DataTableSort, DataTableSortDirection, data_table,
    resize_handle,
};
use nsh_core::{
    Command, MountItem, NodeId, Size,
    element::Root,
    platform::{Environment, Idiom, Os},
    prelude::*,
};
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

/// The table of [`Quotes`] beside a lone resize handle (`id:lone` inside),
/// in a terminal.
#[component]
fn Handles() -> impl IntoElement {
    view().child(quotes()).child(
        view()
            .relative()
            .h(px(40.0))
            .child(resize_handle().child(view().test_id("lone").w(px(1.0)))),
    )
}

#[test]
fn a_terminals_column_handles_are_no_stops_of_tab() {
    let viewport = Size::new(px(600.0), px(300.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom: Idiom::Terminal,
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<Handles>())
    };
    let mut app = Headless::start(config).unwrap();
    // Each view's parent, test id and `focusable`.
    #[derive(Default)]
    struct Seen {
        parents: HashMap<NodeId, NodeId>,
        ids: HashMap<String, NodeId>,
        focusable: HashMap<NodeId, Option<bool>>,
    }
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                }
                MountItem::ViewProps { id, props } => {
                    if let Some(t) = props.test_id.as_deref() {
                        seen.ids.insert(t.to_owned(), *id);
                    }
                    seen.focusable.insert(*id, props.focusable);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    app.wait_for("AAPL").unwrap();
    let seen = seen.lock().unwrap();
    // The band a handle's indicator is in.
    let band = |id: &str| {
        let child = seen.ids[id];
        seen.focusable[&seen.parents[&child]]
    };
    assert_eq!(band("lone"), Some(true), "a lone handle is a stop of Tab");
    for key in ["symbol", "last", "change", "open"] {
        assert_eq!(
            band(&format!("resize:{key}")),
            Some(false),
            "the {key} column's handle is the pointer's"
        );
    }
}

/// Two quote tables in a terminal, every column sortable: the first sorted
/// by symbol ascending, the second by its last price descending.
#[component]
fn Sorted() -> impl IntoElement {
    let table = |key: &str, direction| {
        let mut sort = DataTableSort::default();
        sort.key = key.to_owned().into();
        sort.direction = direction;
        let rows = DataTableRows::new(1)
            .texts("symbol", ["AAPL"])
            .numbers("last", [231.5]);
        let sortable = |key: &str| {
            let mut c = column(key);
            c.sortable = true;
            c
        };
        data_table()
            .h(px(64.0))
            .columns(vec![sortable("symbol"), sortable("last")])
            .data(rows)
            .sort(Some(sort))
    };
    view()
        .child(table("symbol", DataTableSortDirection::Ascending))
        .child(table("last", DataTableSortDirection::Descending))
}

#[test]
fn a_terminals_titles_show_their_sort_in_one_glyph_and_no_lines_between() {
    let viewport = Size::new(px(600.0), px(300.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom: Idiom::Terminal,
            cell: Some(Size::new(px(8.0), px(16.0))),
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<Sorted>())
    };
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app.wait_for("AAPL").unwrap();
    // A sorted title's direction is one glyph, an unsorted one's a faint
    // pair's: no chevrons, no arrows of two Cells.
    for glyph in ["▲", "▼", "↕"] {
        assert!(app.shows(glyph), "a title shows {glyph}");
    }
    for gone in ["↑", "↓"] {
        assert!(!app.shows(gone), "no title shows {gone}");
    }
    // The columns' handles draw no line until the pointer is on them: the
    // titles stand apart by their spaces.
    assert!(
        !app.screen().texts().iter().any(|t| t.contains('│')),
        "no column line between the titles"
    );
}

/// [`Quotes`] whose cells are chosen, the chosen cell and where the focus
/// is written under it, then a view Tab stops at.
#[component]
fn TabOut() -> impl IntoElement {
    let rows = DataTableRows::new(2)
        .texts("symbol", ["AAPL", "MSFT"])
        .numbers("last", [231.5, 412.0]);
    let chosen = signal(String::from("none"));
    let next = signal(false);
    view()
        .child(
            data_table()
                .h(px(120.0))
                .cell_selectable(true)
                .columns(vec![column("symbol"), column("last")])
                .data(rows)
                .on_selection_change(move |s: &Option<nsh_base::DataTableSelection>| {
                    if let Some(s) = s {
                        chosen.set(format!("{:?}:{:?}", s.row, s.column));
                    }
                }),
        )
        .child(
            view()
                .focusable(true)
                .on_press(|| {})
                .on_focus(move || next.set(true))
                .child(text("Next")),
        )
        .child(text(move || {
            format!("Chosen {} next {}", chosen.get(), next.get())
        }))
}

fn tab_out_on(idiom: Idiom) -> Headless {
    let viewport = Size::new(px(600.0), px(300.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom,
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<TabOut>())
    };
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    // A press on a cell chooses it and gives the table the keyboard.
    app.press("text:AAPL").unwrap();
    app.wait_for("Chosen Some(0):Some(0) next false").unwrap();
    app
}

#[test]
fn a_terminals_tab_leaves_the_table_and_the_arrows_move_between_columns() {
    let mut app = tab_out_on(Idiom::Terminal);
    app.press_key("right").unwrap();
    app.wait_for("Chosen Some(0):Some(1) next false").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("Chosen Some(0):Some(0) next false").unwrap();
    app.press_key("tab").unwrap();
    app.wait_for("Chosen Some(0):Some(0) next true").unwrap();
}

#[test]
fn a_desktops_tab_moves_the_chosen_cell_to_the_next_column() {
    let mut app = tab_out_on(Idiom::Desktop);
    app.press_key("tab").unwrap();
    app.wait_for("Chosen Some(0):Some(1) next false").unwrap();
}

/// A huge table whose visible row is reported without loading row data.
#[component]
fn HugeWebTable() -> impl IntoElement {
    let first = signal(0);
    view()
        .child(
            data_table()
                .h(px(706.0))
                .row_height(px(34.0))
                .header_height(px(34.0))
                .row_count(Some(2_000_000))
                .columns(vec![column("name")])
                .on_visible_rows_change(move |range: &nsh_base::DataTableRange| {
                    first.set(range.start);
                }),
        )
        .child(text(move || format!("First row {}", first.get())))
}

#[test]
fn web_desktop_wheel_offsets_are_not_amplified_by_the_table_extent() {
    let viewport = Size::new(px(1000.0), px(750.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            os: Os::Web,
            idiom: Idiom::Desktop,
            window: viewport,
            ..Default::default()
        },
        ..EngineConfig::new(Root::of::<HugeWebTable>())
    };
    let mut app = Headless::start(config).unwrap();
    let vertical = Arc::new(Mutex::new(None));
    let found = vertical.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ScrollConfig {
                id,
                horizontal: false,
                ..
            } = item
            {
                *found.lock().unwrap() = Some(*id);
            }
        }
    });
    app.first_render().unwrap();
    let id = vertical
        .lock()
        .unwrap()
        .expect("the table's vertical hit layer");
    // Wheel input has no drag-start event. Forty CSS pixels must show row
    // 1, regardless of the table's 68-million-pixel logical extent.
    app.engine()
        .control()
        .scroll(id, point(px(0.0), px(40.0)), 0);
    app.wait_for("First row 1").unwrap();
    // A quarter-pixel tail accumulates until the next row, without a
    // scaled jump to row 26 (the old desktop proportional mapping).
    app.engine()
        .control()
        .scroll(id, point(px(0.0), px(67.75)), 0);
    app.wait_for("First row 1").unwrap();
    app.engine()
        .control()
        .scroll(id, point(px(0.0), px(68.0)), 0);
    app.wait_for("First row 2").unwrap();

    let control = app.engine().control();
    control.dispatch_event(
        id,
        nsh_core::EventKind::ScrollDragStart,
        nsh_core::EventPayload::Scroll(point(px(0.0), px(68.0))),
    );
    let bottom = point(px(0.0), px(3_000_000.0 - 672.0));
    control.scroll(id, bottom, 0);
    app.wait_for("First row 1999980").unwrap();
    control.dispatch_event(
        id,
        nsh_core::EventKind::ScrollDragEnd,
        nsh_core::EventPayload::Scroll(bottom),
    );
    app.wait_for("First row 1999980").unwrap();
    // Releasing the bar preserves the last row, then local input starts
    // there. No programmatic recenter is needed at either endpoint.
    control.scroll(id, point(px(0.0), bottom.y - px(34.0)), 0);
    app.wait_for("First row 1999979").unwrap();
    control.dispatch_event(
        id,
        nsh_core::EventKind::ScrollDragStart,
        nsh_core::EventPayload::Scroll(point(px(0.0), bottom.y - px(34.0))),
    );
    control.scroll(id, Point::default(), 0);
    app.wait_for("First row 0").unwrap();
    control.dispatch_event(
        id,
        nsh_core::EventKind::ScrollDragEnd,
        nsh_core::EventPayload::Scroll(Point::default()),
    );
    control.scroll(id, point(px(0.0), px(34.0)), 0);
    app.wait_for("First row 1").unwrap();
}

#[test]
fn touch_reverse_scroll_after_settling_near_top_stays_one_to_one() {
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            os: Os::Android,
            idiom: Idiom::Phone,
            window: viewport,
            pixel_ratio: 3.0,
            ..Default::default()
        },
        ..EngineConfig::new(Root::of::<HugeWebTable>())
    };
    let mut app = Headless::start(config).unwrap();
    #[derive(Default)]
    struct Seen {
        vertical: Option<NodeId>,
        scroll_to: Vec<Points>,
    }
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::ScrollConfig {
                    id,
                    horizontal: false,
                    ..
                } => seen.vertical = Some(*id),
                MountItem::Command {
                    id,
                    command: Command::ScrollTo { y, .. },
                } if Some(*id) == seen.vertical => seen.scroll_to.push(*y),
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    let id = seen
        .lock()
        .unwrap()
        .vertical
        .expect("the table's vertical hit layer");

    let control = app.engine().control();
    // Scroll down 50 rows (50 * 34 = 1700pt) and let the gesture settle.
    let down = point(px(0.0), px(1700.0));
    control.scroll(id, down, 0);
    app.wait_for("First row 50").unwrap();
    seen.lock().unwrap().scroll_to.clear();
    control.dispatch_event(
        id,
        nsh_core::EventKind::ScrollEnd,
        nsh_core::EventPayload::Scroll(down),
    );
    assert!(app.settle(), "the scroll-end event is processed");
    app.wait_for("First row 50").unwrap();

    // Follow the native offset chosen at rest. The old mapping recenters
    // to 75pt, so a fixed 1496pt would scroll forward instead of reversing.
    let scroll_to = std::mem::take(&mut seen.lock().unwrap().scroll_to);
    let at_rest = scroll_to.last().copied().unwrap_or(down.y);
    // Reversing 68pt (2 rows) must show row 48; the old compressed top
    // interval accelerates across the content and lands on row 9 instead.
    let up = point(px(0.0), at_rest - px(68.0));
    control.scroll(id, up, 0);
    app.wait_for("First row 48").unwrap();
    assert!(
        scroll_to.is_empty(),
        "a rest within the edge reserve keeps its native offset: {scroll_to:?}"
    );
}
