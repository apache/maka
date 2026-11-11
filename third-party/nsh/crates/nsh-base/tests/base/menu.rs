//! Checkable menu items: `MenuItem`'s `checked` makes an item a
//! `menuitemcheckbox` (or, with its `role`, a `menuitemradio`) that screen
//! readers hear as checked or not, whose `checked:` styles and indicator
//! part follow the value the app owns; choosing one reports `onSelect` and
//! closes the menu unless `closeOnSelect` is false; toggling one item sends
//! only that item and its indicator; opening it from the keyboard (Return,
//! Space or Down on its trigger) focuses its first enabled item, Up its
//! last, a press none, after which Down or Home focus the first enabled
//! item and Up or End the last; closing it with Escape or a choice gives
//! the focus back to its trigger. A desktop menu, on a Mac. A context menu opened
//! from the keyboard (Shift+F10 on its focused trigger, in the browser
//! and on Linux) focuses its first enabled item, one opened by the secondary button
//! none, until an arrow key.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use nsh_base::{MenuEvent, context_menu, menu, menu_item};
use nsh_core::{
    Checked, MountItem, NodeId, Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const UNCHECKED: u32 = 0x0000_ffff;
const CHECKED: u32 = 0xff00_00ff;
const ITEM_CHECKED: u32 = 0x00ff_00ff;

/// What the platform was sent: each view's test id, the background colors
/// of its styles in order, and the views each batch touched.
#[derive(Default)]
struct Seen {
    test_ids: HashMap<String, NodeId>,
    parents: HashMap<NodeId, NodeId>,
    backgrounds: HashMap<NodeId, Vec<u32>>,
    batches: Vec<Vec<NodeId>>,
}

struct App {
    app: Headless,
    seen: Arc<Mutex<Seen>>,
}

impl App {
    /// The view around the one with test id `test_id`: the item around
    /// its content, the indicator around its mark.
    fn around(&self, test_id: &str) -> NodeId {
        let seen = self.seen.lock().unwrap();
        seen.parents[&seen.test_ids[test_id]]
    }

    /// The background color the view `id` was last sent.
    fn background(&self, id: NodeId) -> Option<u32> {
        let seen = self.seen.lock().unwrap();
        seen.backgrounds.get(&id).and_then(|b| b.last().copied())
    }

    fn checked(&self, selector: &str) -> Option<Checked> {
        self.app
            .screen()
            .accessibility_state(selector)
            .unwrap()
            .checked
    }

    /// The batches sent from now on, once `step` ran.
    fn batches_of(&mut self, step: impl FnOnce(&mut Headless)) -> Vec<Vec<NodeId>> {
        let from = self.seen.lock().unwrap().batches.len();
        step(&mut self.app);
        self.seen.lock().unwrap().batches[from..].to_vec()
    }
}

fn start() -> App {
    start_with(Root::of::<ViewMenu>())
}

fn start_with(root: Root) -> App {
    start_on(root, Os::MacOs)
}

/// A desktop app on `os`.
fn start_on(root: Root, os: Os) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = os;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        let mut touched = Vec::new();
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props } => {
                    if let Some(test_id) = &props.test_id {
                        seen.test_ids.insert(test_id.to_string(), *id);
                    }
                    touched.push(*id);
                }
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                }
                MountItem::ViewStyle { id, style } => {
                    seen.backgrounds
                        .entry(*id)
                        .or_default()
                        .push(style.background_color.0);
                    touched.push(*id);
                }
                _ => {}
            }
        }
        seen.batches.push(touched);
    });
    app.first_render().unwrap();
    App { app, seen }
}

/// A View menu: two settings that keep the menu open (the minimap's
/// disabled), a "Sort by" choice of one that closes it, and a plain item.
/// The texts say the values, how many choices were reported and how often
/// the menu closed.
#[component]
fn ViewMenu() -> impl IntoElement {
    let sidebar = signal(true);
    let sort = signal("name");
    let selects = signal(0u32);
    let closes = signal(0u32);
    let mark = |test_id: &'static str| view().test_id(test_id).size(px(6.0));
    let setting = |label: &'static str, test_id: &'static str, on: Signal<bool>, disabled: bool| {
        menu_item()
            .accessibility_label(label)
            .flex_row()
            .checked(move || Some(on.get()))
            .disabled(disabled)
            .close_on_select(false)
            .checked_style(|s| s.bg(rgb(0x00ff00)))
            .indicator_style(|s| {
                s.size(px(10.0))
                    .bg(rgb(0x0000ff))
                    .checked(|s| s.bg(rgb(0xff0000)))
            })
            .indicator(mark(if disabled {
                "minimap-mark"
            } else {
                "sidebar-mark"
            }))
            .on_select(move || {
                selects.update(|n| *n += 1);
                on.set(!on.get_untracked());
            })
            .child(view().test_id(test_id).child(text(label)))
    };
    let by = move |label: &'static str, key: &'static str| {
        menu_item()
            .accessibility_label(label)
            .role(AccessibilityRole::MenuItemRadio)
            .checked(move || Some(sort.get() == key))
            .on_select(move || {
                selects.update(|n| *n += 1);
                sort.set(key);
            })
            .child(view().test_id(key).child(text(label)))
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .on_open_change(move |e: &MenuEvent| {
                    if let MenuEvent::OpenChange(false, _) = e {
                        closes.update(|n| *n += 1);
                    }
                })
                .trigger(
                    view()
                        .test_id("view")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("View")),
                )
                .child(setting("Show sidebar", "sidebar", sidebar, false))
                .child(setting("Show minimap", "minimap", signal(false), true))
                .child(by("Name", "name"))
                .child(by("Size", "size"))
                .child(
                    menu_item()
                        .accessibility_label("About")
                        .child(view().test_id("about").child(text("About"))),
                ),
        )
        .child(text(move || format!("sidebar:{}", sidebar.get())))
        .child(text(move || format!("sort:{}", sort.get())))
        .child(text(move || format!("selects:{}", selects.get())))
        .child(text(move || format!("closes:{}", closes.get())))
}

#[test]
fn checkable_items_are_heard_checked_or_not() {
    let mut app = start();
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show sidebar").unwrap();
    let screen = app.app.screen();
    assert_eq!(screen.count("role:menuitemcheckbox"), Ok(2));
    assert_eq!(screen.count("role:menuitemradio"), Ok(2));
    assert_eq!(screen.count("role:menuitem"), Ok(1), "a plain item");
    assert_eq!(
        app.checked("role:menuitemcheckbox[Show sidebar]"),
        Some(Checked::True)
    );
    assert_eq!(
        app.checked("role:menuitemcheckbox[Show minimap]"),
        Some(Checked::False)
    );
    assert_eq!(app.checked("role:menuitemradio[Name]"), Some(Checked::True));
    assert_eq!(
        app.checked("role:menuitemradio[Size]"),
        Some(Checked::False)
    );
    assert_eq!(
        app.checked("role:menuitem[About]"),
        None,
        "no checked state"
    );
    assert!(
        !app.app
            .screen()
            .enabled("role:menuitemcheckbox[Show minimap]")
            .unwrap(),
        "a disabled setting"
    );
}

#[test]
fn the_item_and_its_indicator_show_the_value_the_app_passes() {
    let mut app = start();
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show sidebar").unwrap();
    assert_eq!(app.background(app.around("sidebar")), Some(ITEM_CHECKED));
    assert_eq!(app.background(app.around("sidebar-mark")), Some(CHECKED));
    assert_eq!(app.background(app.around("minimap-mark")), Some(UNCHECKED));
    app.app.press("text:Show sidebar").unwrap();
    app.app.wait_for("text:sidebar:false").unwrap();
    assert_eq!(
        app.checked("role:menuitemcheckbox[Show sidebar]"),
        Some(Checked::False)
    );
    assert_eq!(app.background(app.around("sidebar-mark")), Some(UNCHECKED));
    assert_ne!(app.background(app.around("sidebar")), Some(ITEM_CHECKED));
}

#[test]
fn a_setting_reports_its_choice_and_keeps_the_menu_open() {
    let mut app = start();
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show sidebar").unwrap();
    app.app.press("text:Show sidebar").unwrap();
    app.app.wait_for("text:selects:1").unwrap();
    app.app.wait_for("text:sidebar:false").unwrap();
    assert!(app.app.shows("Show sidebar"), "still open");
    app.app.press("text:Show sidebar").unwrap();
    app.app.wait_for("text:sidebar:true").unwrap();
    assert_eq!(
        app.checked("role:menuitemcheckbox[Show sidebar]"),
        Some(Checked::True)
    );
    assert!(app.app.shows("closes:0"));
}

#[test]
fn a_choice_of_one_closes_the_menu_and_the_app_moves_the_check() {
    let mut app = start();
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show sidebar").unwrap();
    app.app.press("text:Size").unwrap();
    app.app.wait_for("text:sort:size").unwrap();
    app.app.wait_for("text:closes:1").unwrap();
    assert!(!app.app.shows("Show sidebar"), "closed");
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show sidebar").unwrap();
    assert_eq!(app.checked("role:menuitemradio[Size]"), Some(Checked::True));
    assert_eq!(
        app.checked("role:menuitemradio[Name]"),
        Some(Checked::False)
    );
}

#[test]
fn a_disabled_item_reports_nothing() {
    let mut app = start();
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show minimap").unwrap();
    assert!(app.app.press("text:Show minimap").is_err());
    app.app.wait_for("text:selects:0").unwrap();
}

#[test]
fn toggling_one_item_sends_only_what_it_shows() {
    let mut app = start();
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show sidebar").unwrap();
    let mut others: Vec<NodeId> = ["minimap", "name", "size", "about"]
        .into_iter()
        .map(|id| app.around(id))
        .collect();
    others.push(app.around("minimap-mark"));
    let (item, indicator) = (app.around("sidebar"), app.around("sidebar-mark"));
    let batches = app.batches_of(|app| {
        app.press("text:Show sidebar").unwrap();
        app.wait_for("text:sidebar:false").unwrap();
    });
    let touched: Vec<NodeId> = batches.into_iter().flatten().collect();
    assert!(
        touched.iter().all(|id| !others.contains(id)),
        "the other items get nothing: {touched:?}"
    );
    assert!(
        touched.contains(&item) && touched.contains(&indicator),
        "the item and its indicator: {touched:?}"
    );
    // Nothing else: not the app's mark (made once, kept), not the content.
    assert!(
        touched.iter().all(|&id| id == item || id == indicator),
        "only the item and its indicator: {touched:?}"
    );
}

/// A File menu whose first item is disabled: New (disabled), Open, Save,
/// Quit. The text says the item chosen last.
#[component]
fn FileMenu() -> impl IntoElement {
    let chose = signal("none");
    let item = move |label: &'static str, disabled: bool| {
        menu_item()
            .accessibility_label(label)
            .disabled(disabled)
            .on_select(move || chose.set(label))
            .child(text(label))
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(
                    view()
                        .test_id("file")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("File")),
                )
                .child(item("New", true))
                .child(item("Open", false))
                .child(item("Save", false))
                .child(item("Quit", false)),
        )
        .child(text(move || format!("chose:{}", chose.get())))
}

/// Opens the File menu with `key` on its focused trigger, then presses
/// the item the keyboard focus is on (Space).
fn open_with_key_and_choose(key: &str) -> App {
    let mut app = start_with(Root::of::<FileMenu>());
    app.app.press_key("tab").unwrap();
    app.app.press_key(key).unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.press_key("space").unwrap();
    app
}

#[test]
fn opening_from_the_keyboard_focuses_the_first_enabled_item() {
    for key in ["enter", "space", "down"] {
        let mut app = open_with_key_and_choose(key);
        app.app
            .wait_for("text:chose:Open")
            .unwrap_or_else(|e| panic!("{key}: {e}"));
    }
}

#[test]
fn up_on_the_trigger_focuses_the_last_item() {
    let mut app = open_with_key_and_choose("up");
    app.app.wait_for("text:chose:Quit").unwrap();
}

#[test]
fn escape_and_a_choice_give_the_focus_back_to_the_trigger() {
    let mut app = start_with(Root::of::<FileMenu>());
    app.app.press_key("tab").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("Open").unwrap();
    // Escape closes it, and the focus, gone with its item, is the
    // trigger's again: its keys open it once more.
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Open", std::time::Duration::from_secs(2))
        .unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("Open").unwrap();
    // So does a choice.
    app.app.press_key("space").unwrap();
    app.app.wait_for("text:chose:Open").unwrap();
    app.app
        .wait_for_gone("Save", std::time::Duration::from_secs(2))
        .unwrap();
    app.app.press_key("up").unwrap();
    app.app.wait_for("Quit").unwrap();
}

#[test]
fn a_press_on_the_trigger_focuses_no_item() {
    let mut app = start_with(Root::of::<FileMenu>());
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.press_key("space").unwrap();
    assert!(app.app.shows("chose:none"), "no item had the focus");
    assert!(app.app.shows("Open"), "still open");
}

#[test]
fn after_a_press_the_arrows_home_and_end_focus_an_end_of_the_enabled_items() {
    // New is disabled: Down and Home go past it to Open. Once an item has
    // the focus, its own keys move on from it (Down twice: Save).
    for (keys, chosen) in [
        (&["down"][..], "Open"),
        (&["home"][..], "Open"),
        (&["up"][..], "Quit"),
        (&["end"][..], "Quit"),
        (&["down", "down"][..], "Save"),
        (&["up", "up"][..], "Save"),
        (&["end", "home"][..], "Open"),
    ] {
        let mut app = start_with(Root::of::<FileMenu>());
        app.app.press("id:file").unwrap();
        app.app.wait_for("Open").unwrap();
        for key in keys {
            app.app.press_key(key).unwrap();
        }
        app.app.press_key("space").unwrap();
        app.app
            .wait_for(&format!("text:chose:{chosen}"))
            .unwrap_or_else(|e| panic!("{keys:?}: {e}"));
    }
}

#[test]
fn after_a_press_and_an_arrow_escape_gives_the_focus_to_the_trigger() {
    let mut app = start_with(Root::of::<FileMenu>());
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Open", std::time::Duration::from_secs(2))
        .unwrap();
    // Closed, the arrows are the trigger's again: Up opens it at Quit.
    app.app.press_key("up").unwrap();
    app.app.wait_for("Quit").unwrap();
    app.app.press_key("space").unwrap();
    app.app.wait_for("text:chose:Quit").unwrap();
}

#[test]
fn page_down_and_page_up_go_to_the_last_and_first_enabled_items_and_stop() {
    // Every item is in view: a page is all of them. New is disabled, so
    // Page Up stops at Open; neither goes around.
    for (keys, chosen) in [
        (&["pagedown"][..], "Quit"),
        (&["pageup"][..], "Open"),
        (&["down", "pagedown"][..], "Quit"),
        (&["pagedown", "pagedown"][..], "Quit"),
        (&["end", "pageup"][..], "Open"),
        (&["pageup", "pageup"][..], "Open"),
    ] {
        let mut app = start_with(Root::of::<FileMenu>());
        app.app.press("id:file").unwrap();
        app.app.wait_for("Open").unwrap();
        for key in keys {
            app.app.press_key(key).unwrap();
        }
        app.app.press_key("space").unwrap();
        app.app
            .wait_for(&format!("text:chose:{chosen}"))
            .unwrap_or_else(|e| panic!("{keys:?}: {e}"));
    }
}

#[test]
fn the_keys_start_at_the_item_the_pointer_is_on() {
    // The pointer on Save, the third item: Down goes on to Quit, Up back
    // to Open, Space chooses Save itself.
    for (key, chosen) in [("down", "Quit"), ("up", "Open"), ("space", "Save")] {
        let mut app = start_with(Root::of::<FileMenu>());
        app.app.press("id:file").unwrap();
        app.app.wait_for("Open").unwrap();
        app.app.hover("label:Save").unwrap();
        app.app.press_key(key).unwrap();
        if key != "space" {
            app.app.press_key("space").unwrap();
        }
        app.app
            .wait_for(&format!("text:chose:{chosen}"))
            .unwrap_or_else(|e| panic!("{key}: {e}"));
    }
}

#[test]
fn the_pointer_moves_on_from_the_item_the_keys_reached() {
    // Down three times reaches Quit; the pointer then on Open: Down is
    // Save, the item after Open.
    let mut app = start_with(Root::of::<FileMenu>());
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("down").unwrap();
    app.app.hover("label:Open").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("space").unwrap();
    app.app.wait_for("text:chose:Save").unwrap();
}

#[test]
fn the_pointer_leaving_the_items_leaves_none_for_the_keys() {
    // The pointer on Save, then off the menu: the item it left is no
    // longer the keys' start, so Down goes to the first enabled item.
    let mut app = start_with(Root::of::<FileMenu>());
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.hover("label:Save").unwrap();
    app.app.hover("id:file").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("space").unwrap();
    app.app.wait_for("text:chose:Open").unwrap();
}

/// A document whose context menu's first item is disabled: New
/// (disabled), Rename, Delete. The text says the item chosen last and how
/// the last `onContextMenu` of a plain view beside it came.
#[component]
fn DocumentMenu() -> impl IntoElement {
    let chose = signal("none");
    let asked = signal(String::from("none"));
    let item = move |label: &'static str, disabled: bool| {
        menu_item()
            .accessibility_label(label)
            .disabled(disabled)
            .on_select(move || chose.set(label))
            .child(text(label))
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            context_menu()
                .trigger(
                    view()
                        .test_id("doc")
                        .focusable(true)
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("Document")),
                )
                .child(item("New", true))
                .child(item("Rename", false))
                .child(item("Delete", false)),
        )
        .child(
            view()
                .test_id("plain")
                .focusable(true)
                .w(px(60.0))
                .h(px(20.0))
                .on_context_menu(move |e: &ContextMenuEvent| {
                    let by = e.pointer_type.map_or("keyboard", PointerType::name);
                    asked.set(format!(
                        "{by} {} {}",
                        e.position.x.0.round(),
                        e.position.y.0.round()
                    ));
                }),
        )
        .child(text(move || format!("chose:{}", chose.get())))
        .child(text(move || format!("asked:{}", asked.get())))
}

#[test]
fn shift_f10_opens_a_context_menu_at_its_first_enabled_item() {
    for os in [Os::Web, Os::Linux] {
        let mut app = start_on(Root::of::<DocumentMenu>(), os);
        app.app.press_key("tab").unwrap();
        app.app.press_key("shift+f10").unwrap();
        app.app.wait_for("Rename").unwrap();
        app.app.press_key("space").unwrap();
        app.app.wait_for("text:chose:Rename").unwrap();
    }
}

#[test]
fn the_arrow_keys_move_between_enabled_items_and_wrap_around() {
    for os in [Os::Web, Os::Linux] {
        // Down past Delete wraps to Rename (New is disabled); Up from
        // there goes back to Delete; Home and End go to the ends.
        for (keys, chosen) in [
            (&["down"][..], "Delete"),
            (&["down", "down"][..], "Rename"),
            (&["up"][..], "Delete"),
            (&["end", "home"][..], "Rename"),
            (&["end"][..], "Delete"),
        ] {
            let mut app = start_on(Root::of::<DocumentMenu>(), os);
            app.app.press_key("tab").unwrap();
            app.app.press_key("shift+f10").unwrap();
            app.app.wait_for("Rename").unwrap();
            for key in keys {
                app.app.press_key(key).unwrap();
            }
            app.app.press_key("space").unwrap();
            app.app.wait_for(&format!("text:chose:{chosen}")).unwrap();
        }
    }
}

#[test]
fn escape_gives_the_focus_back_to_a_context_menus_trigger() {
    for os in [Os::Web, Os::Linux] {
        let mut app = start_on(Root::of::<DocumentMenu>(), os);
        app.app.press_key("tab").unwrap();
        app.app.press_key("shift+f10").unwrap();
        app.app.wait_for("Rename").unwrap();
        app.app.press_key("escape").unwrap();
        app.app
            .wait_for_gone("Rename", std::time::Duration::from_secs(5))
            .unwrap();
        // The trigger has it again: the same key opens the menu again.
        app.app.press_key("shift+f10").unwrap();
        app.app.wait_for("Rename").unwrap();
    }
}

#[test]
fn a_secondary_click_opens_a_context_menu_with_no_item_focused() {
    let mut app = start_on(Root::of::<DocumentMenu>(), Os::Web);
    app.app.right_click("id:doc").unwrap();
    app.app.wait_for("Rename").unwrap();
    app.app.press_key("space").unwrap();
    assert!(app.app.shows("chose:none"), "no item had the focus");
    assert!(app.app.shows("Rename"), "still open");
}

#[test]
fn after_a_secondary_click_down_focuses_the_first_enabled_item() {
    for (key, chosen) in [("down", "Rename"), ("up", "Delete")] {
        let mut app = start_on(Root::of::<DocumentMenu>(), Os::Web);
        app.app.right_click("id:doc").unwrap();
        app.app.wait_for("Rename").unwrap();
        app.app.press_key(key).unwrap();
        app.app.press_key("space").unwrap();
        app.app
            .wait_for(&format!("text:chose:{chosen}"))
            .unwrap_or_else(|e| panic!("{key}: {e}"));
    }
}

#[test]
fn the_keyboard_asks_for_a_menu_at_the_bottom_start_corner_with_no_pointer() {
    let mut app = start_on(Root::of::<DocumentMenu>(), Os::Web);
    app.app.right_click("id:plain").unwrap();
    app.app.wait_for("text:asked:mouse 30 10").unwrap();
    // Tab: the document, then the plain view.
    app.app.press_key("tab").unwrap();
    app.app.press_key("tab").unwrap();
    app.app.press_key("shift+f10").unwrap();
    app.app.wait_for("text:asked:keyboard 0 20").unwrap();
}

#[test]
fn shift_f10_opens_no_context_menu_elsewhere() {
    // macOS has no such key; Windows gives views no keyboard focus to
    // start from.
    for os in [Os::MacOs, Os::Windows] {
        let mut app = start_on(Root::of::<DocumentMenu>(), os);
        app.app.press_key("tab").unwrap();
        app.app.press_key("tab").unwrap();
        app.app.press_key("shift+f10").unwrap();
        assert!(app.app.shows("asked:none"), "{os:?}: no context menu");
        assert!(!app.app.shows("Rename"), "{os:?}: no menu open");
    }
}

/// A row that opens a context menu and also takes presses, long presses
/// and their releases; the text counts each.
#[component]
fn PressableRow() -> impl IntoElement {
    let presses = signal(0);
    let ups = signal(0);
    let longs = signal(0);
    view()
        .pt(px(100.0))
        .child(
            context_menu()
                .trigger(
                    view()
                        .test_id("row")
                        .w(px(200.0))
                        .h(px(40.0))
                        .on_press(move || presses.update(|n| *n += 1))
                        .on_press_up(move || ups.update(|n| *n += 1))
                        .on_long_press(move || longs.update(|n| *n += 1))
                        .child(text("Row")),
                )
                .child(menu_item().child(text("Rename"))),
        )
        .child(text(move || {
            format!("p{} u{} l{}", presses.get(), ups.get(), longs.get())
        }))
}

#[test]
fn a_held_finger_opens_the_menu_and_presses_nothing() {
    let mut app = start_on(Root::of::<PressableRow>(), Os::Web);
    // The menu opens as the finger holds; lifting it reports no press or
    // release, while the app's own long press is still heard.
    app.app.long_press("id:row").unwrap();
    app.app.wait_for("Rename").unwrap();
    app.app.wait_for("text:p0 u0 l1").unwrap();
}

#[test]
fn a_tap_after_a_held_finger_presses_again() {
    let mut app = start_on(Root::of::<PressableRow>(), Os::Web);
    app.app.long_press("id:row").unwrap();
    app.app.wait_for("Rename").unwrap();
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Rename", std::time::Duration::from_secs(5))
        .unwrap();
    app.app.press("id:row").unwrap();
    app.app.wait_for("text:p1 u1 l1").unwrap();
}

#[test]
fn a_tap_on_a_context_menus_trigger_still_presses() {
    let mut app = start_on(Root::of::<PressableRow>(), Os::Web);
    app.app.press("id:row").unwrap();
    app.app.wait_for("text:p1 u1 l0").unwrap();
    assert!(!app.app.shows("Rename"), "a tap opens no menu");
}

/// Holds a pointer of `pointer_type` still on the row for longer than a
/// long press, as a platform reports it: a touch on the root with the row
/// listening.
fn hold_row(app: &mut App, pointer_type: nsh_core::PointerType) {
    let row = app.seen.lock().unwrap().test_ids["row"];
    let touch = |phase| {
        EventPayload::Touch(Box::new(nsh_core::TouchEvent {
            phase,
            timestamp: 0.0,
            points: vec![nsh_core::TouchPoint {
                id: 1,
                target: row,
                path: if phase == nsh_core::TouchPhase::Start {
                    vec![row]
                } else {
                    Vec::new()
                },
                page: point(px(10.0), px(110.0)),
                location: point(px(10.0), px(10.0)),
                changed: true,
                pointer_type,
            }],
            activated: None,
        }))
    };
    let control = app.app.engine().control();
    control.dispatch_event(
        nsh_core::ROOT_ID,
        EventKind::Touch,
        touch(nsh_core::TouchPhase::Start),
    );
    app.app.wait(std::time::Duration::from_millis(600)).unwrap();
}

#[test]
fn a_held_mouse_button_opens_no_context_menu() {
    // Desktops report the mouse as a touch too: holding its button still
    // is a slow click or the start of a drag, not a request for a menu.
    let mut app = start_on(Root::of::<PressableRow>(), Os::Windows);
    hold_row(&mut app, nsh_core::PointerType::Mouse);
    assert!(
        !app.app.shows("Rename"),
        "a held mouse button opens no menu"
    );
}

#[test]
fn a_held_finger_or_pen_reported_as_a_touch_opens_the_menu() {
    for pointer_type in [nsh_core::PointerType::Touch, nsh_core::PointerType::Pen] {
        let mut app = start_on(Root::of::<PressableRow>(), Os::Windows);
        hold_row(&mut app, pointer_type);
        app.app.wait_for("Rename").unwrap();
    }
}

#[derive(Clone, PartialEq, Props)]
struct RowMenuProps {
    /// The app owns `open`, following `onOpenChange`.
    controlled: bool,
}

/// A row with a context menu (Rename) at (40, 100), 200 by 40, the menu's
/// state its own or the app's; another row below it that takes presses
/// and secondary clicks of its own. The texts say where the popup was
/// placed and how often the app heard it open and close.
#[component]
fn RowMenu(props: RowMenuProps) -> impl IntoElement {
    let open = signal(false);
    let at = signal(String::from("none"));
    let changes = signal(String::new());
    let menu = context_menu();
    let menu = if props.controlled {
        menu.open(move || Some(open.get()))
    } else {
        menu
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu.on_open_change(move |e: &MenuEvent| {
                if let MenuEvent::OpenChange(next, _) = e {
                    open.set(*next);
                    changes.update(|c| c.push(if *next { 'o' } else { 'c' }));
                }
            })
            .on_position(move |e: &MenuEvent| {
                if let MenuEvent::Position(_, bounds, _) = e {
                    at.set(format!("{} {}", bounds.origin.x.0, bounds.origin.y.0));
                }
            })
            .trigger(
                view()
                    .test_id("row")
                    .w(px(200.0))
                    .h(px(40.0))
                    .child(text("Row")),
            )
            .child(
                menu_item()
                    .accessibility_label("Rename")
                    .child(text("Rename")),
            ),
        )
        .child(
            view()
                .test_id("other")
                .w(px(200.0))
                .h(px(40.0))
                .on_press(|| {})
                .on_context_menu(|_: &ContextMenuEvent| {})
                .child(text("Other")),
        )
        .child(text(move || format!("at:{}", at.get())))
        .child(text(move || format!("changes:{}", changes.get())))
}

/// The mouse's secondary button at `page` over the view with test id
/// `test_id`, laid out at `origin`, as the platforms report it.
fn right_click_at(app: &mut App, test_id: &str, origin: Point<Points>, page: Point<Points>) {
    let id = app.seen.lock().unwrap().test_ids[test_id];
    let event = ContextMenuEvent::new(
        point(page.x - origin.x, page.y - origin.y),
        page,
        Default::default(),
        Some(PointerType::Mouse),
    );
    app.app.engine().control().dispatch_event(
        id,
        EventKind::ContextMenu,
        EventPayload::ContextMenu(event),
    );
    app.app.settle();
}

/// Where the row with the menu is.
fn row() -> Point<Points> {
    point(px(40.0), px(100.0))
}

/// Where the other row is.
fn other() -> Point<Points> {
    point(px(40.0), px(140.0))
}

#[test]
fn a_secondary_click_on_the_trigger_of_an_open_context_menu_opens_it_there() {
    for controlled in [false, true] {
        let mut app = start_on(
            Root::new::<RowMenu>(move || RowMenuProps { controlled }),
            Os::MacOs,
        );
        right_click_at(&mut app, "row", row(), point(px(50.0), px(110.0)));
        app.app.wait_for("Rename").unwrap();
        app.app.wait_for("text:at:50 110").unwrap();
        // Again on the row, somewhere else: the menu goes there, open.
        right_click_at(&mut app, "row", row(), point(px(200.0), px(130.0)));
        app.app.wait_for("text:at:200 130").unwrap();
        assert!(
            app.app.shows("Rename"),
            "controlled {controlled}: still open"
        );
        // And again on the same spot.
        right_click_at(&mut app, "row", row(), point(px(200.0), px(130.0)));
        app.app.idle(std::time::Duration::from_millis(300)).unwrap();
        assert!(
            app.app.shows("Rename"),
            "controlled {controlled}: still open"
        );
        assert_eq!(
            app.app.screen().count("Rename").unwrap(),
            1,
            "controlled {controlled}: one menu"
        );
    }
}

#[test]
fn a_secondary_click_or_a_press_outside_an_open_context_menu_closes_it() {
    for controlled in [false, true] {
        let mut app = start_on(
            Root::new::<RowMenu>(move || RowMenuProps { controlled }),
            Os::MacOs,
        );
        right_click_at(&mut app, "row", row(), point(px(50.0), px(110.0)));
        app.app.wait_for("Rename").unwrap();
        right_click_at(&mut app, "other", other(), point(px(50.0), px(150.0)));
        app.app
            .wait_for_gone("Rename", std::time::Duration::from_secs(5))
            .unwrap();
        right_click_at(&mut app, "row", row(), point(px(50.0), px(110.0)));
        app.app.wait_for("Rename").unwrap();
        app.app.press("id:other").unwrap();
        app.app
            .wait_for_gone("Rename", std::time::Duration::from_secs(5))
            .unwrap();
        app.app.wait_for("text:changes:ococ").unwrap();
    }
}
