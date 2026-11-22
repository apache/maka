//! Table semantics read through AppKit in an ordinary window.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use nsh_core::{element::Root, prelude::*};
use nsh_platform_macos::{
    AppOptions, AppView,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSAccessibilityElement, NSApplication, NSBackingStoreType, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSArray, NSDate, NSPoint, NSRange, NSRect, NSRunLoop, NSSize},
};

static PRESSES: AtomicUsize = AtomicUsize::new(0);
static CHANGED: AtomicBool = AtomicBool::new(false);

#[component]
fn Screen() -> impl IntoElement {
    let changed = signal(false);
    set_interval(std::time::Duration::from_millis(20), move || {
        changed.set(CHANGED.load(Ordering::SeqCst));
    });
    let cell = |id, name| {
        view()
            .test_id(id)
            .role(AccessibilityRole::Cell)
            .w(px(100.))
            .h(px(24.))
            .child(text(name))
    };
    view()
        .child(
            view()
                .test_id("table")
                .role(AccessibilityRole::Table)
                .label("Orders")
                .child(
                    view().role(AccessibilityRole::RowGroup).child(
                        view()
                            .test_id("header")
                            .role(AccessibilityRole::Row)
                            .flex_row()
                            .children(["Product", "Quantity"].map(|name| {
                                view()
                                    .test_id(name)
                                    .role(AccessibilityRole::ColumnHeader)
                                    .w(px(100.))
                                    .h(px(24.))
                                    .child(text(name))
                            })),
                    ),
                )
                .child(
                    view()
                        .role(AccessibilityRole::RowGroup)
                        .child(
                            view()
                                .test_id("first")
                                .role(AccessibilityRole::Row)
                                .label("First order")
                                .accessibility_state(AccessibilityState {
                                    selected: true,
                                    ..Default::default()
                                })
                                .flex_row()
                                .on_press(|| {
                                    PRESSES.fetch_add(1, Ordering::SeqCst);
                                })
                                .child(cell("apple", "Apple"))
                                .child(cell("three", "3").label("Three items")),
                        )
                        .child(
                            view()
                                .test_id("second")
                                .role(AccessibilityRole::Row)
                                .accessibility_elements_hidden(changed)
                                .flex_row()
                                .child(cell("pear", "Pear"))
                                .child(cell("seven", "7")),
                        ),
                ),
        )
        .child(
            view().test_id("grid").role(AccessibilityRole::Grid).child(
                view()
                    .test_id("grid-row")
                    .role(AccessibilityRole::Row)
                    .child(cell("grid-cell", "Other"))
                    .child(
                        view()
                            .test_id("nested")
                            .role(AccessibilityRole::Table)
                            .child(
                                view()
                                    .role(AccessibilityRole::Row)
                                    .child(cell("nested-cell", "Nested")),
                            ),
                    ),
            ),
        )
        .child(
            view()
                .test_id("standalone-row")
                .role(AccessibilityRole::Row)
                .label("Outside a table")
                .child(cell("standalone-cell", "Standalone")),
        )
}

fn until(mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "mount timed out");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.02));
    }
}

fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|i| i.to_string() == id)
    {
        return Some(view.retain());
    }
    view.accessibilityChildren()?
        .iter()
        .filter_map(|c| c.downcast::<NSView>().ok())
        .find_map(|v| find(&v, id))
}

fn ids(elements: Option<Retained<NSArray>>) -> Vec<String> {
    elements
        .unwrap()
        .iter()
        .map(|v| {
            v.downcast::<NSView>()
                .unwrap()
                .accessibilityIdentifier()
                .unwrap()
                .to_string()
        })
        .collect()
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let _application = NSApplication::sharedApplication(mtm);
    // SAFETY: ordinary AppKit window, kept alive until the app stops.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0., 0.), NSSize::new(400., 300.)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    let app = AppView::new(
        mtm,
        AppOptions {
            size: (400, 300),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    window.orderFrontRegardless();
    app.load(Root::of::<Screen>().into());
    let root = app.view();
    until(|| find(&root, "standalone-cell").is_some());
    let get = |id| find(&root, id).unwrap_or_else(|| panic!("no {id}"));
    for (id, role) in [
        ("table", "AXTable"),
        ("grid", "AXTable"),
        ("header", "AXRow"),
        ("first", "AXRow"),
        ("standalone-row", "AXRow"),
        ("Product", "AXCell"),
        ("Quantity", "AXCell"),
        ("apple", "AXCell"),
        ("standalone-cell", "AXCell"),
    ] {
        assert_eq!(
            get(id).accessibilityRole().unwrap().to_string(),
            role,
            "{id}"
        );
    }
    let table = get("table");
    assert_eq!(table.accessibilityLabel().unwrap().to_string(), "Orders");
    assert_eq!(
        ids(table.accessibilityRows()),
        ["header", "first", "second"]
    );
    assert_eq!(
        ids(table.accessibilityVisibleRows()),
        ["header", "first", "second"]
    );
    assert_eq!(table.accessibilityRowCount(), 3);
    assert_eq!(table.accessibilityColumnCount(), 2);
    assert_eq!(ids(table.accessibilitySelectedRows()), ["first"]);
    assert_eq!(table.accessibilityVisibleColumns().unwrap().count(), 2);
    assert_eq!(
        ids(table.accessibilityVisibleCells()),
        ["Product", "Quantity", "apple", "three", "pear", "seven"]
    );
    assert_eq!(
        ids(get("three").accessibilityColumnHeaderUIElements()),
        ["Quantity"]
    );
    assert_eq!(
        ids(table.accessibilityColumnHeaderUIElements()),
        ["Product", "Quantity"]
    );
    assert_eq!(
        table
            .accessibilityHeader()
            .unwrap()
            .downcast::<NSView>()
            .unwrap(),
        get("header")
    );
    let columns = table.accessibilityColumns().unwrap();
    assert_eq!(columns.count(), 2);
    // Columns are stable objects with the same cells also reachable by row.
    assert_eq!(columns, table.accessibilityColumns().unwrap());
    for (i, expected) in [["Product", "apple", "pear"], ["Quantity", "three", "seven"]]
        .iter()
        .enumerate()
    {
        let col = columns
            .objectAtIndex(i)
            .downcast::<NSAccessibilityElement>()
            .unwrap();
        assert_eq!(col.accessibilityRole().unwrap().to_string(), "AXColumn");
        assert_eq!(col.accessibilityIndex(), i as isize);
        assert_eq!(ids(col.accessibilityChildren()), *expected);
        assert_eq!(
            col.accessibilityHeader()
                .unwrap()
                .downcast::<NSView>()
                .unwrap(),
            get(expected[0])
        );
    }
    for (id, r, c) in [
        ("Product", 0, 0),
        ("Quantity", 0, 1),
        ("apple", 1, 0),
        ("three", 1, 1),
        ("seven", 2, 1),
    ] {
        let cell = get(id);
        assert_eq!(cell.accessibilityRowIndexRange(), NSRange::new(r, 1));
        assert_eq!(cell.accessibilityColumnIndexRange(), NSRange::new(c, 1));
        assert_eq!(
            table
                .accessibilityCellForColumn_row(c as isize, r as isize)
                .unwrap()
                .downcast::<NSView>()
                .unwrap(),
            cell
        );
    }
    assert!(table.accessibilityCellForColumn_row(-1, 0).is_none());
    assert!(table.accessibilityCellForColumn_row(2, 0).is_none());
    assert_eq!(get("first").accessibilityIndex(), 1);
    assert_eq!(
        get("first").accessibilityLabel().unwrap().to_string(),
        "First order"
    );
    assert_eq!(
        get("three").accessibilityLabel().unwrap().to_string(),
        "Three items"
    );
    assert_eq!(
        get("apple").accessibilityChildren().unwrap().count(),
        1,
        "cell text remains reachable"
    );
    assert!(get("first").accessibilityPerformPress());
    until(|| PRESSES.load(Ordering::SeqCst) == 1);
    assert_eq!(ids(get("grid").accessibilityRows()), ["grid-row"]);
    assert_eq!(
        get("grid").accessibilityColumnCount(),
        1,
        "nested table excluded"
    );
    assert_eq!(
        get("nested-cell").accessibilityRowIndexRange(),
        NSRange::new(0, 1)
    );
    // Clipping changes only the visible axis, not the full row list or indices.
    window.setContentSize(NSSize::new(400., 24.));
    until(|| ids(table.accessibilityVisibleRows()) == ["header"]);
    assert_eq!(
        ids(table.accessibilityRows()),
        ["header", "first", "second"]
    );
    assert_eq!(
        ids(table.accessibilityVisibleCells()),
        ["Product", "Quantity"]
    );
    assert_eq!(
        get("seven").accessibilityRowIndexRange(),
        NSRange::new(2, 1)
    );
    window.setContentSize(NSSize::new(400., 300.));
    until(|| ids(table.accessibilityVisibleRows()).len() == 3);
    CHANGED.store(true, Ordering::SeqCst);
    until(|| ids(table.accessibilityRows()).len() == 2);
    assert_eq!(ids(table.accessibilityRows()), ["header", "first"]);
    assert_eq!(ids(table.accessibilityVisibleRows()), ["header", "first"]);
    assert_eq!(table.accessibilityRowCount(), 2);
    assert_eq!(table.accessibilityColumns().unwrap().count(), 2);
    let retained_column = columns
        .objectAtIndex(1)
        .downcast::<NSAccessibilityElement>()
        .unwrap();
    assert_eq!(
        ids(retained_column.accessibilityChildren()),
        ["Quantity", "three"]
    );
    assert_eq!(
        get("standalone-row")
            .accessibilityLabel()
            .unwrap()
            .to_string(),
        "Outside a table"
    );
    app.stop();
    window.close();
    drop(table);
    drop(root);
    drop(app);
    assert!(retained_column.accessibilityChildren().unwrap().is_empty());
    println!("table accessibility: roles, axes, headers, ranges, names, press and updates ok");
}
