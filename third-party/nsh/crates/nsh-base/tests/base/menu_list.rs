//! `MenuList`: a menu's items in a virtualized list. Up, Down, Home and
//! End walk every row of the list, the ones it has not made yet too
//! (scrolled to, then focused), pass over disabled rows, and go on to the
//! items around the list, a submenu's trigger among them. A desktop menu,
//! on a Mac.

use nsh_base::{MenuListEntry, menu, menu_item, menu_list, submenu};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// Rows in each list: 30 points high in a list 150 high, so five show.
const ROWS: u32 = 30;

/// Rows 3 and 27 are disabled: 27 is far from the rows made at first.
fn disabled(index: u32) -> bool {
    index == 3 || index == 27
}

/// A list of `ROWS` model rows whose choice the text shows.
fn model_rows(chose: Signal<String>) -> impl IntoElement {
    menu_list()
        .count(ROWS)
        .render_item(move |e: &MenuListEntry| {
            let index = e.index;
            menu_item()
                .disabled(disabled(index))
                .on_select(move || chose.set(format!("Row {index}")))
                .child(view().h(px(30.0)).child(text(format!("Row {index}"))))
        })
        .w(px(200.0))
        .h(px(150.0))
}

fn item(chose: Signal<String>, label: &'static str) -> impl IntoElement {
    menu_item()
        .on_select(move || chose.set(label.into()))
        .child(view().h(px(30.0)).child(text(label)))
}

/// Before, the model rows, a More submenu (Sub A), After.
#[component]
fn Models() -> impl IntoElement {
    let chose = signal(String::from("none"));
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(
                    view()
                        .test_id("open")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("Open")),
                )
                .child(item(chose, "Before"))
                .child(model_rows(chose))
                .child(
                    submenu()
                        .trigger(view().h(px(30.0)).child(text("More")))
                        .child(item(chose, "Sub A")),
                )
                .child(item(chose, "After")),
        )
        .child(text(move || format!("chose:{}", chose.get())))
}

/// Only the model rows.
#[component]
fn OnlyRows() -> impl IntoElement {
    let chose = signal(String::from("none"));
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(
                    view()
                        .test_id("open")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("Open")),
                )
                .child(model_rows(chose)),
        )
        .child(text(move || format!("chose:{}", chose.get())))
}

fn start(root: Root) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app
}

/// Opens the menu with a press (no item focused), presses `keys` one by
/// one, then chooses the focused item with `choose`; the text says what
/// was chosen.
fn choose(root: Root, keys: &[&str], choose: &str, chosen: &str) {
    let mut app = start(root);
    app.press("id:open").unwrap();
    app.wait_for("Row 0").unwrap();
    assert!(!app.shows("Row 29"), "the last row is not made yet");
    for key in keys {
        app.press_key(key).unwrap();
    }
    app.press_key(choose).unwrap();
    app.wait_for(&format!("text:chose:{chosen}"))
        .unwrap_or_else(|e| panic!("{keys:?}: {e}"));
}

/// `n` times `key`.
fn times(key: &'static str, n: usize) -> Vec<&'static str> {
    vec![key; n]
}

#[test]
fn down_walks_every_row_to_the_last_one() {
    // Before, then the 28 enabled rows (3 and 27 passed over): the last
    // one, never made when the menu opened.
    choose(Root::of::<Models>(), &times("down", 29), "enter", "Row 29");
}

#[test]
fn the_keys_pass_over_disabled_rows() {
    // Before, Row 0, 1, 2, then 4.
    choose(Root::of::<Models>(), &times("down", 5), "space", "Row 4");
    // Up from More: Row 29, 28, then 26.
    let mut keys = times("down", 30);
    keys.extend(times("up", 3));
    choose(Root::of::<Models>(), &keys, "space", "Row 26");
}

#[test]
fn past_the_last_row_the_items_after_the_list_follow() {
    // Down from the last row: More, then After, then around to Before.
    let mut keys = times("down", 30);
    choose(Root::of::<Models>(), &keys, "right", "none");
    keys.push("down");
    choose(Root::of::<Models>(), &keys, "space", "After");
    keys.push("down");
    choose(Root::of::<Models>(), &keys, "space", "Before");
}

#[test]
fn up_from_the_items_after_the_list_reaches_its_last_row() {
    // Up from Before goes around to After, then More, then the list's
    // last row.
    choose(
        Root::of::<Models>(),
        &["down", "up", "up", "up"],
        "space",
        "Row 29",
    );
}

#[test]
fn a_submenu_trigger_after_the_list_opens_and_gives_the_focus_back() {
    let mut app = start(Root::of::<Models>());
    app.press("id:open").unwrap();
    app.wait_for("Row 0").unwrap();
    for key in times("down", 30) {
        app.press_key(key).unwrap();
    }
    // Right on More opens it at Sub A; Left closes it, back on More.
    app.press_key("right").unwrap();
    app.wait_for("Sub A").unwrap();
    app.press_key("left").unwrap();
    app.wait_for_gone("Sub A", std::time::Duration::from_secs(5))
        .unwrap();
    // Up from More: the list's last row.
    app.press_key("up").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:chose:Row 29").unwrap();
}

#[test]
fn up_from_the_first_row_goes_around_to_the_true_last_row() {
    choose(Root::of::<OnlyRows>(), &["down", "up"], "space", "Row 29");
    // Then on up the list: 28, past 27, 26.
    choose(
        Root::of::<OnlyRows>(),
        &["down", "up", "up", "up"],
        "space",
        "Row 26",
    );
}

#[test]
fn end_and_home_go_to_the_lists_last_and_first_rows() {
    choose(Root::of::<OnlyRows>(), &["end"], "space", "Row 29");
    choose(Root::of::<OnlyRows>(), &["end", "home"], "space", "Row 0");
    // Down past the last row goes around to the first.
    choose(Root::of::<OnlyRows>(), &["end", "down"], "space", "Row 0");
}

#[test]
fn home_and_end_reach_the_items_around_the_list() {
    choose(Root::of::<Models>(), &["end"], "space", "After");
    choose(Root::of::<Models>(), &["end", "home"], "space", "Before");
}

#[test]
fn page_down_goes_a_view_at_a_time_and_stops_at_the_end() {
    // Five rows show: the first Page Down is the last row in view, then
    // each goes five rows on, to rows the list had not made, and stops at
    // the last.
    choose(Root::of::<OnlyRows>(), &["pagedown"], "space", "Row 4");
    choose(
        Root::of::<OnlyRows>(),
        &times("pagedown", 2),
        "space",
        "Row 9",
    );
    choose(
        Root::of::<OnlyRows>(),
        &times("pagedown", 6),
        "space",
        "Row 29",
    );
    choose(
        Root::of::<OnlyRows>(),
        &times("pagedown", 7),
        "space",
        "Row 29",
    );
}

#[test]
fn page_up_goes_a_view_at_a_time_and_stops_at_the_start() {
    // Page Down six times: Row 29 at the bottom, 25 to 29 in view.
    for (pages, chosen) in [(1, "Row 25"), (2, "Row 20"), (7, "Row 0")] {
        let mut keys = times("pagedown", 6);
        keys.extend(times("pageup", pages));
        choose(Root::of::<OnlyRows>(), &keys, "space", chosen);
    }
}

#[test]
fn a_page_lands_on_the_enabled_row_nearest_its_edge() {
    // Row 22 at the bottom: the next page ends at Row 27, disabled, so
    // Row 26.
    let mut keys = times("down", 22);
    keys.push("pagedown");
    choose(Root::of::<OnlyRows>(), &keys, "space", "Row 26");
    // Row 7 at the bottom shows 3 to 7: Page Up's first row in view is 3,
    // disabled, so Row 4.
    let mut keys = times("down", 7);
    keys.push("pageup");
    choose(Root::of::<OnlyRows>(), &keys, "space", "Row 4");
}

#[test]
fn pages_go_on_to_the_items_after_the_list() {
    // Row 29 at the bottom of the list: More and After are in view, so
    // the next page is After, where it stops.
    choose(
        Root::of::<Models>(),
        &times("pagedown", 6),
        "space",
        "Row 29",
    );
    choose(
        Root::of::<Models>(),
        &times("pagedown", 7),
        "space",
        "After",
    );
    choose(
        Root::of::<Models>(),
        &times("pagedown", 8),
        "space",
        "After",
    );
}

#[test]
fn the_keys_start_at_the_row_the_pointer_is_on() {
    for (keys, chosen) in [
        // Row 2, then Down past Row 3 (disabled).
        (&["down"][..], "Row 4"),
        (&["up"][..], "Row 1"),
        (&["pagedown"][..], "Row 4"),
    ] {
        let mut app = start(Root::of::<OnlyRows>());
        app.press("id:open").unwrap();
        app.wait_for("Row 0").unwrap();
        app.hover("text:Row 2").unwrap();
        for key in keys {
            app.press_key(key).unwrap();
        }
        app.press_key("space").unwrap();
        app.wait_for(&format!("text:chose:{chosen}"))
            .unwrap_or_else(|e| panic!("{keys:?}: {e}"));
    }
    // From the last row in view, Down and Page Down reach rows not made
    // yet.
    for (key, chosen) in [("down", "Row 5"), ("pagedown", "Row 9")] {
        let mut app = start(Root::of::<OnlyRows>());
        app.press("id:open").unwrap();
        app.wait_for("Row 0").unwrap();
        app.hover("text:Row 4").unwrap();
        app.press_key(key).unwrap();
        app.press_key("space").unwrap();
        app.wait_for(&format!("text:chose:{chosen}"))
            .unwrap_or_else(|e| panic!("{key}: {e}"));
    }
}

/// Panics whose message says a prop outlived its owner, on any thread
/// (the engine's: an event's handler panicking is caught there).
static DISPOSED_READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Before, a list whose rows are never made (0 high) while `show`
/// holds, After; `x` hides the list.
#[component]
fn HiddenList() -> impl IntoElement {
    let chose = signal(String::from("none"));
    let show = signal(true);
    on_key("x", move |_| show.set(false));
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(
                    view()
                        .test_id("open")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("Open")),
                )
                .child(item(chose, "Before"))
                .child(when(show, move || {
                    menu_list()
                        .count(signal(ROWS))
                        .render_item(move |e: &MenuListEntry| {
                            let index = e.index;
                            menu_item()
                                .on_select(move || chose.set(format!("Row {index}")))
                                .child(view().h(px(30.0)).child(text(format!("Row {index}"))))
                        })
                        .w(px(200.0))
                        .h(px(0.0))
                }))
                .child(item(chose, "After")),
        )
        .child(text(move || format!("chose:{}", chose.get())))
}

#[test]
fn a_list_removed_while_the_keys_wait_for_its_row_is_forgotten() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if info.to_string().contains("after its owner was disposed") {
            DISPOSED_READS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        previous(info);
    }));
    let mut app = start(Root::of::<HiddenList>());
    app.press("id:open").unwrap();
    app.wait_for("Before").unwrap();
    // Up, Up: After, then the list's last row, which it never makes, so
    // the keys wait for it.
    app.press_key("up").unwrap();
    app.press_key("up").unwrap();
    app.press_key("x").unwrap();
    app.wait(std::time::Duration::from_millis(200)).unwrap();
    // The items left are walked as before: Down from nothing focused is
    // Before.
    app.press_key("down").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:chose:Before").unwrap();
    assert_eq!(
        DISPOSED_READS.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a prop of the list was read after the list went"
    );
}
