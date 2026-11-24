//! A menu's typeahead: with the menu open on a desktop, a letter or digit
//! moves the keyboard focus to the next enabled item whose label or text
//! starts with it; the same letter again moves on among those items, and
//! letters typed in quick succession make a prefix, as `Select`'s list
//! matches them. Disabled items, separators and a group's title are passed
//! over; in a submenu only its own items count; a text field in the menu
//! keeps its letters; an item out of view is scrolled into it. A desktop
//! menu, on a Mac.

use std::time::Duration;

use nsh_base::{MenuListEntry, input, menu, menu_item, menu_list, menu_separator, submenu};
use nsh_core::{
    Command, Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// Longer than typeahead keeps what was typed.
const PAUSE: Duration = Duration::from_millis(1100);

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

fn trigger() -> impl IntoElement {
    view()
        .test_id("open")
        .w(px(80.0))
        .h(px(30.0))
        .child(text("Sort"))
}

fn item(chose: Signal<String>, label: &'static str) -> impl IntoElement {
    menu_item()
        .on_select(move || chose.set(label.into()))
        .child(view().h(px(30.0)).child(text(label)))
}

fn chosen(chose: Signal<String>) -> impl IntoElement {
    text(move || format!("chose:{}", chose.get()))
}

/// Newest, Oldest, Title, a separator, a group titled "Totals" (a text,
/// no item), Tags (disabled), Time, Owner, and Zone, whose name is its
/// accessibility label ("Archive") rather than its text.
#[component]
fn SortMenu() -> impl IntoElement {
    let chose = signal(String::from("none"));
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(trigger())
                .child(item(chose, "Newest"))
                .child(item(chose, "Oldest"))
                .child(item(chose, "Title"))
                .child(menu_separator())
                .child(view().h(px(24.0)).child(text("Totals")))
                .child(
                    menu_item()
                        .disabled(true)
                        .on_select(move || chose.set("Tags".into()))
                        .child(view().h(px(30.0)).child(text("Tags"))),
                )
                .child(item(chose, "Time"))
                .child(item(chose, "Owner"))
                .child(
                    menu_item()
                        .accessibility_label("Archive")
                        .on_select(move || chose.set("Zone".into()))
                        .child(view().h(px(30.0)).child(text("Zone"))),
                ),
        )
        .child(chosen(chose))
}

/// Opens the sort menu from the keyboard (the focus on Newest), presses
/// `keys` (a pause where one is `""`), then chooses the focused item.
fn choose(keys: &[&str], chosen: &str) {
    let mut app = start(nsh_testing::windowed_root::<SortMenu>(), 844.0);
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Newest").unwrap();
    for key in keys {
        match *key {
            "" => app.wait(PAUSE).unwrap(),
            key => app.press_key(key).unwrap(),
        }
    }
    app.press_key("enter").unwrap();
    app.wait_for(&format!("text:chose:{chosen}"))
        .unwrap_or_else(|e| panic!("{keys:?}: {e}"));
}

#[test]
fn a_letter_moves_the_focus_to_the_item_it_starts() {
    choose(&["t"], "Title");
    choose(&["o"], "Oldest");
    // A letter no item starts leaves the focus where it is.
    choose(&["q"], "Newest");
}

#[test]
fn the_same_letter_again_moves_on_among_the_items_it_starts() {
    // Title, Time (Totals and Tags passed over), then around to Title.
    choose(&["t", "t"], "Time");
    choose(&["t", "t", "t"], "Title");
    // After a pause, from where the focus is: Owner after Oldest.
    choose(&["o", "", "o"], "Owner");
}

#[test]
fn letters_typed_in_quick_succession_make_a_prefix() {
    choose(&["o", "w"], "Owner");
    choose(&["o", "l"], "Oldest");
    choose(&["t", "i", "m"], "Time");
    // `to` starts only the group's title, which is no item: the focus
    // stays on Title, where `t` took it.
    choose(&["t", "o"], "Title");
    // After a pause the letters start again.
    choose(&["t", "", "n"], "Newest");
}

#[test]
fn an_items_label_is_what_typeahead_matches() {
    // Zone's label is Archive: `a` reaches it, `z` does not.
    choose(&["a"], "Zone");
    choose(&["z"], "Newest");
}

#[test]
fn a_disabled_item_is_passed_over() {
    // Tags is disabled: `ta` matches nothing and the focus stays.
    choose(&["t", "a"], "Title");
}

#[test]
fn a_menu_the_pointer_opened_takes_letters_too() {
    let mut app = start(nsh_testing::windowed_root::<SortMenu>(), 844.0);
    app.press("id:open").unwrap();
    app.wait_for("Newest").unwrap();
    app.press_key("t").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Title").unwrap();
}

#[test]
fn letters_typed_ahead_go_on_from_where_the_one_before_left_the_focus() {
    let mut app = start(nsh_testing::windowed_root::<SortMenu>(), 844.0);
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Newest").unwrap();
    app.press_keys(&["t", "t", "enter"]).unwrap();
    app.wait_for("text:chose:Time").unwrap();
}

/// Share, a Sort submenu (Size, Title) and Theme.
#[component]
fn NestedMenu() -> impl IntoElement {
    let chose = signal(String::from("none"));
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(trigger())
                .child(item(chose, "Share"))
                .child(
                    submenu()
                        .trigger(view().h(px(30.0)).child(text("Sort by")))
                        .child(item(chose, "Size"))
                        .child(item(chose, "Title")),
                )
                .child(item(chose, "Theme")),
        )
        .child(chosen(chose))
}

#[test]
fn in_a_submenu_only_its_items_count() {
    let mut app = start(nsh_testing::windowed_root::<NestedMenu>(), 844.0);
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Share").unwrap();
    // Into Sort by: the focus on Size. `t` is Title there, not Theme.
    app.press_key("down").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("Size").unwrap();
    app.press_key("t").unwrap();
    app.press_key("t").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Title").unwrap();
}

#[test]
fn a_submenu_starts_what_was_typed_again() {
    let mut app = start(nsh_testing::windowed_root::<NestedMenu>(), 844.0);
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Share").unwrap();
    // `s` reaches Sort by, Right opens it; `t` right after is the
    // submenu's own first letter, not a prefix `st` of the menu's.
    app.press_key("s").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("Size").unwrap();
    app.press_key("t").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Title").unwrap();
}

#[test]
fn the_menu_around_an_open_submenu_keeps_its_own_items() {
    let mut app = start(nsh_testing::windowed_root::<NestedMenu>(), 844.0);
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Share").unwrap();
    // The submenu's trigger reached by its letter (`s` again from Share,
    // which has the focus, moves on to Sort by), the submenu opened and
    // left: the keys are the menu's again, and `t` is Theme.
    app.press_key("s").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("Size").unwrap();
    app.press_key("left").unwrap();
    app.wait(PAUSE).unwrap();
    app.press_key("t").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Theme").unwrap();
}

/// A search field above Newest, Oldest and Title; the text says whether
/// the field has the focus.
#[component]
fn SearchMenu() -> impl IntoElement {
    let chose = signal(String::from("none"));
    let field = signal("none");
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(trigger())
                .child(
                    input()
                        .test_id("search")
                        .w(px(160.0))
                        .h(px(30.0))
                        .on_focus(move |_: &()| field.set("focused"))
                        .on_blur(move |_: &()| field.set("blurred")),
                )
                .child(item(chose, "Newest"))
                .child(item(chose, "Oldest"))
                .child(item(chose, "Title")),
        )
        .child(chosen(chose))
        .child(text(move || format!("field:{}", field.get())))
}

#[test]
fn a_text_field_in_the_menu_keeps_its_letters() {
    let mut app = start(nsh_testing::windowed_root::<SearchMenu>(), 844.0);
    app.press("id:open").unwrap();
    app.wait_for("Newest").unwrap();
    app.type_text("id:search", "").unwrap();
    app.wait_for("text:field:focused").unwrap();
    app.press_key("t").unwrap();
    app.wait(Duration::from_millis(300)).unwrap();
    assert!(
        app.shows("field:focused"),
        "the focus stayed in the field: {:?}",
        app.screen().texts()
    );
    // Outside the field the letters move the focus again: the pointer
    // gives Oldest the focus.
    app.hover("text:Oldest").unwrap();
    app.wait_for("text:field:blurred").unwrap();
    app.press_key("t").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Title").unwrap();
}

/// Names whose first letters differ, for the long menus.
const NAMES: [&str; 20] = [
    "Alder", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo", "Hazel", "Ivy", "Juniper",
    "Kapok", "Larch", "Maple", "Nutmeg", "Oak", "Pine", "Quince", "Rowan", "Spruce", "Teak",
];

/// The trigger at the window's top and a menu of the twenty names, 30
/// points each, in a window 300 high: nine show.
#[component]
fn LongMenu() -> impl IntoElement {
    let chose = signal(String::from("none"));
    let mut m = menu().trigger(trigger());
    for name in NAMES {
        m = m.child(item(chose, name));
    }
    view().child(m).child(chosen(chose))
}

fn scrolls(screen: &nsh_testing::Screen) -> usize {
    screen
        .commands()
        .iter()
        .filter(|(_, c)| matches!(c, Command::ScrollTo { y, .. } if y.0 > 0.0))
        .count()
}

#[test]
fn an_item_out_of_view_is_scrolled_into_it() {
    let mut app = start(nsh_testing::windowed_root::<LongMenu>(), 300.0);
    app.press("id:open").unwrap();
    app.wait_for("Alder").unwrap();
    assert_eq!(scrolls(app.screen()), 0);
    app.press_key("r").unwrap();
    app.wait_until("Rowan brought into view", Duration::from_secs(5), |s| {
        scrolls(s) > 0
    })
    .unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Rowan").unwrap();
}

/// A `MenuList` of thirty rows, five in view, named as [`NAMES`] are
/// (then `Extra 20` on).
#[component]
fn ListMenu() -> impl IntoElement {
    let chose = signal(String::from("none"));
    let name = |index: u32| match NAMES.get(index as usize) {
        Some(name) => name.to_string(),
        None => format!("Extra {index}"),
    };
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .child(
            menu().trigger(trigger()).child(
                menu_list()
                    .count(30)
                    .render_item(move |e: &MenuListEntry| {
                        let label = name(e.index);
                        let chosen = label.clone();
                        menu_item()
                            .on_select(move || chose.set(chosen.clone()))
                            .child(view().h(px(30.0)).child(text(label)))
                    })
                    .w(px(200.0))
                    .h(px(150.0)),
            ),
        )
        .child(chosen(chose))
}

#[test]
fn a_lists_row_out_of_view_is_scrolled_into_it() {
    let mut app = start(nsh_testing::windowed_root::<ListMenu>(), 844.0);
    app.press("id:open").unwrap();
    app.wait_for("Alder").unwrap();
    assert_eq!(scrolls(app.screen()), 0);
    // Ginkgo, the seventh row, is below the five in view.
    app.press_key("g").unwrap();
    app.wait_until("Ginkgo brought into view", Duration::from_secs(5), |s| {
        scrolls(s) > 0
    })
    .unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:chose:Ginkgo").unwrap();
}
