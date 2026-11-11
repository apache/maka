//! A menu held to its room: the popup is never taller than the room on the
//! side it goes on (`onPosition`'s `available`), so a long menu in a short
//! window scrolls its items inside it and a menu that fits only above
//! opens there at its natural size. The keys bring the item they move to
//! into view and page by the viewport; a submenu closes once its item
//! scrolls out of view. A desktop menu, on a Mac.

use nsh_base::{MenuEvent, menu, menu_item, submenu};
use nsh_core::{
    Command, Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// Items in the long menu, each 30 points high: 600 points in all.
const ITEMS: u32 = 20;

fn item(chose: Signal<String>, label: String) -> impl IntoElement {
    let chosen = label.clone();
    menu_item()
        .on_select(move || chose.set(chosen.clone()))
        .child(view().h(px(30.0)).child(text(label)))
}

/// The trigger at the window's top (0 to 30) and a menu of `ITEMS` items
/// with no gap, margin or padding: the room below is the window's height
/// less 30, and the text says whether the popup was held to it.
fn long_menu_of(with_submenu: bool) -> impl IntoElement {
    let chose = signal(String::from("none"));
    let held = signal(false);
    let mut m = menu()
        .on_position(move |e: &MenuEvent| {
            if let MenuEvent::Position(_, bounds, available) = e {
                held.set(bounds.size.height <= available.height + px(0.5));
            }
        })
        .trigger(
            view()
                .test_id("open")
                .w(px(80.0))
                .h(px(30.0))
                .child(text("Open")),
        );
    if with_submenu {
        m = m.child(
            submenu()
                .trigger(view().h(px(30.0)).child(text("More")))
                .child(item(chose, "Sub A".into())),
        );
    }
    for i in 1..=ITEMS {
        m = m.child(item(chose, format!("Item {i}")));
    }
    view()
        .child(m)
        .child(text(move || format!("chose:{}", chose.get())))
        .child(text(move || format!("held:{}", held.get())))
}

#[component]
fn LongMenu() -> impl IntoElement {
    long_menu_of(false)
}

#[component]
fn LongMenuWithSubmenu() -> impl IntoElement {
    long_menu_of(true)
}

/// A menu of eight items (240 points) whose trigger is 70 points above the
/// window's bottom: it fits only above, and the text says where it went
/// and how tall it is.
#[component]
fn LowMenu() -> impl IntoElement {
    let placed = signal(String::new());
    let mut m = menu()
        .on_position(move |e: &MenuEvent| {
            if let MenuEvent::Position(placement, bounds, _) = e {
                placed.set(format!("{placement:?} {}", bounds.size.height.0.round()));
            }
        })
        .trigger(
            view()
                .test_id("open")
                .w(px(80.0))
                .h(px(30.0))
                .child(text("Open")),
        );
    for i in 1..=8 {
        m = m.child(menu_item().child(view().h(px(30.0)).child(text(format!("Low {i}")))));
    }
    view()
        .child(text(move || format!("placed:{}", placed.get())))
        .child(view().h(px(300.0)))
        .child(m)
}

/// A desktop window `height` points high.
fn start(root: Root, height: f32) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(height)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app
}

fn scrolls(app: &Headless) -> usize {
    app.screen()
        .commands()
        .iter()
        .filter(|(_, c)| matches!(c, Command::ScrollTo { y, .. } if y.0 > 0.0))
        .count()
}

/// Opens the long menu with a press (no item focused) in a window 300
/// points high (a viewport of 270: nine items), presses `keys`, then
/// chooses the focused item.
fn choose(keys: &[&str], chosen: &str) {
    let mut app = start(Root::of::<LongMenu>(), 300.0);
    app.press("id:open").unwrap();
    app.wait_for("Item 1").unwrap();
    for key in keys {
        app.press_key(key).unwrap();
    }
    app.press_key("enter").unwrap();
    app.wait_for(&format!("text:chose:{chosen}"))
        .unwrap_or_else(|e| panic!("{keys:?}: {e}"));
}

#[test]
fn a_long_menu_is_held_to_the_room_below_it() {
    let mut app = start(Root::of::<LongMenu>(), 300.0);
    app.press("id:open").unwrap();
    app.wait_for("text:held:true").unwrap();
    // Its first items show; the ones past the room are in the scroll view.
    assert!(app.shows("Item 1"));
}

#[test]
fn a_menu_that_fits_only_above_opens_there_whole() {
    let mut app = start(Root::of::<LowMenu>(), 400.0);
    app.press("id:open").unwrap();
    app.wait_for("text:placed:Top 240").unwrap();
}

#[test]
fn the_keys_bring_the_item_they_reach_into_view() {
    let mut app = start(Root::of::<LongMenu>(), 300.0);
    app.press("id:open").unwrap();
    app.wait_for("Item 1").unwrap();
    // Items 1 to 9 show: the keys move among them without scrolling.
    for _ in 0..5 {
        app.press_key("down").unwrap();
    }
    assert_eq!(scrolls(&app), 0, "an item in view is not scrolled to");
    for _ in 0..7 {
        app.press_key("down").unwrap();
    }
    assert!(scrolls(&app) > 0, "Item 12 is brought into view");
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Item 12").unwrap();
}

#[test]
fn up_from_the_first_item_goes_around_and_scrolls_to_the_last() {
    choose(&["down", "up"], "Item 20");
}

#[test]
fn page_down_and_page_up_go_a_viewport_at_a_time() {
    // A viewport of 270 points holds items 1 to 9. Focusing Item 9 scrolls
    // it 16 points (the margin kept at the edge), so the next page holds
    // items 10 to 18; then 19 and 20, where it stops. End scrolls to the
    // content's end (the margin cannot go past it): an offset of 330 shows
    // 330 to 600, so Page Up goes to the first item wholly in view, Item 12
    // (330 to 360).
    choose(&["pagedown"], "Item 9");
    choose(&["pagedown", "pagedown"], "Item 18");
    choose(&["pagedown", "pagedown", "pagedown", "pagedown"], "Item 20");
    choose(&["end", "pageup"], "Item 12");
}

#[test]
fn a_submenu_closes_once_its_item_scrolls_out_of_view() {
    let mut app = start(Root::of::<LongMenuWithSubmenu>(), 300.0);
    app.press("id:open").unwrap();
    app.wait_for("More").unwrap();
    app.press_key("down").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("Sub A").unwrap();
    app.scroll("Item 5", px(200.0)).unwrap();
    app.wait_for_gone("Sub A", std::time::Duration::from_secs(2))
        .unwrap();
    // The menu stays open.
    assert!(app.shows("Item 10"));
}

// The tenth trigger starts exactly below the first viewport; scrolling back
// to zero must close it just as scrolling past an item at the top does.
#[component]
fn SubmenuAtViewportBoundary() -> impl IntoElement {
    let chose = signal(String::from("none"));
    let mut m = menu().trigger(
        view()
            .test_id("open")
            .w(px(80.0))
            .h(px(30.0))
            .child(text("Open")),
    );
    for i in 1..=9 {
        m = m.child(item(chose, format!("Before {i}")));
    }
    m = m.child(
        submenu()
            .trigger(view().h(px(30.0)).child(text("Boundary More")))
            .child(item(chose, "Boundary Sub A".into())),
    );
    for i in 1..=10 {
        m = m.child(item(chose, format!("After {i}")));
    }
    view().child(m)
}

#[test]
fn a_submenu_closes_when_scrolling_back_to_exactly_zero() {
    let mut app = start(Root::of::<SubmenuAtViewportBoundary>(), 300.0);
    app.press("id:open").unwrap();
    app.wait_for("Before 1").unwrap();
    for _ in 0..10 {
        app.press_key("down").unwrap();
    }
    app.press_key("right").unwrap();
    app.wait_for("Boundary Sub A").unwrap();
    app.scroll("Boundary More", px(-1000.0)).unwrap();
    app.wait_for_gone("Boundary Sub A", std::time::Duration::from_secs(2))
        .unwrap();
}
