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
//! none, until an arrow key. One the app opens (`open` set true) goes below
//! its trigger at its first enabled item, as from the keyboard. Only Return
//! or Space on the focused item is typed ahead of a key move: a tap (one
//! that focuses its item first too) or an assistive technology's activation
//! chooses the item it is on, also while the focus the keys asked for has
//! not come (an iPad's).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use nsh_base::{
    ContextMenuEvents, MenuButtonItem, MenuEvent, context_menu, dialog, input, menu, menu_item,
};
use nsh_core::{
    Checked, Command, MountItem, NodeId, Size,
    element::Root,
    platform::{CONTEXT_MENU_COMPONENT, Idiom, Os},
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
    /// The native components mounted, by name, and the props they were
    /// last sent.
    components: HashMap<String, NodeId>,
    component_props: HashMap<(NodeId, String), Option<serde_json::Value>>,
    /// Every item sent, written out, in order.
    items: Vec<String>,
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
    start_with(nsh_testing::windowed_root::<ViewMenu>())
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
            seen.items.push(format!("{item:?}"));
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
                MountItem::Component { id, name } => {
                    seen.components.insert(name.to_string(), *id);
                }
                MountItem::ComponentProps { id, props } => {
                    for (name, value) in props {
                        seen.component_props
                            .insert((*id, name.to_string()), value.clone());
                    }
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
                        .accessibility_description("Version and license")
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
fn an_item_hands_its_description_to_screen_readers() {
    let mut app = start();
    app.app.press("id:view").unwrap();
    app.app.wait_for("Show sidebar").unwrap();
    let screen = app.app.screen();
    assert_eq!(
        screen.accessibility_description("role:menuitem[About]"),
        Ok(Some("Version and license".to_owned()))
    );
    assert_eq!(
        screen.accessibility_description("role:menuitemradio[Name]"),
        Ok(None),
        "an item without one has none"
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

/// A search field over the File menu: the field edits while the pointer
/// opens the menu. The text says the item chosen last.
#[component]
fn FieldAndMenu() -> impl IntoElement {
    let chose = signal("none");
    let item = move |label: &'static str| {
        menu_item()
            .accessibility_label(label)
            .on_select(move || chose.set(label))
            .child(text(label))
    };
    view()
        .pt(px(40.0))
        .pl(px(40.0))
        .gap(px(8.0))
        .child(input().test_id("search").w(px(160.0)).h(px(28.0)))
        .child(
            menu()
                .trigger(
                    view()
                        .test_id("file")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("File")),
                )
                .child(item("Open"))
                .child(item("Save")),
        )
        .child(text(move || format!("chose:{}", chose.get())))
}

#[test]
fn a_menu_the_pointer_opens_over_an_editing_field_takes_the_arrows() {
    let mut app = start_with(nsh_testing::windowed_root::<FieldAndMenu>());
    app.app.type_text("id:search", "ab").unwrap();
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    // Down focuses the first item, not the field's caret; Return chooses it.
    app.app.press_key("down").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("text:chose:Save").unwrap();
    assert_eq!(
        app.app.screen().input_text("id:search").unwrap(),
        Some("ab")
    );
    // Letters still go to the field while the menu is open; Home goes in.
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.type_text("id:search", "c").unwrap();
    assert_eq!(
        app.app.screen().input_text("id:search").unwrap(),
        Some("abc")
    );
    app.app.press_key("home").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("text:chose:Open").unwrap();
}

/// A menu with a filter field of its own above its items.
#[component]
fn FilteredMenu() -> impl IntoElement {
    let chose = signal("none");
    let item = move |label: &'static str| {
        menu_item()
            .accessibility_label(label)
            .on_select(move || chose.set(label))
            .child(text(label))
    };
    view()
        .pt(px(40.0))
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
                .child(input().test_id("filter").w(px(120.0)).h(px(28.0)))
                .child(item("Open"))
                .child(item("Save")),
        )
        .child(text(move || format!("chose:{}", chose.get())))
}

#[test]
fn a_field_in_the_menu_keeps_its_arrows() {
    let mut app = start_with(nsh_testing::windowed_root::<FilteredMenu>());
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.type_text("id:filter", "op").unwrap();
    // The field's caret takes them: no item gets the focus, so Return
    // chooses nothing.
    app.app.press_key("down").unwrap();
    app.app.press_key("home").unwrap();
    app.app.press_key("enter").unwrap();
    assert!(app.app.shows("chose:none"));
    assert!(app.app.shows("Open"), "still open");
}

/// Opens the File menu with `key` on its focused trigger, then presses
/// the item the keyboard focus is on (Space).
fn open_with_key_and_choose(key: &str) -> App {
    let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
    let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
    let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
        let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
fn after_a_press_and_an_arrow_escape_leaves_the_focus_where_it_was() {
    let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Open", std::time::Duration::from_secs(2))
        .unwrap();
    // A press opened it, so the trigger never had the focus and does not
    // get it now: the arrows are not the trigger's, Up opens nothing.
    app.app.press_key("up").unwrap();
    assert!(!app.app.shows("Quit"));
}

#[test]
fn on_windows_after_a_press_and_an_arrow_escape_gives_the_focus_to_the_trigger() {
    // A press focuses a button there, as native buttons do: the trigger
    // takes the focus back, so its arrows open the menu again.
    let mut app = start_on(nsh_testing::windowed_root::<FileMenu>(), Os::Windows);
    app.app.press("id:file").unwrap();
    app.app.wait_for("Open").unwrap();
    app.app.press_key("down").unwrap();
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Open", std::time::Duration::from_secs(2))
        .unwrap();
    app.app.press_key("up").unwrap();
    app.app.wait_for("Quit").unwrap();
}

#[test]
fn after_a_press_on_the_focused_trigger_escape_gives_it_the_focus_back() {
    let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
    // Tab gave the trigger the focus before the press: it gets it back.
    app.app.press_key("tab").unwrap();
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

/// A menu whose Rename item moves the keyboard focus to a field outside
/// it, as a choice that starts editing in place does, and a Copy item that
/// moves nothing; its `open` the app's when `controlled` (the choice's
/// focus and the closing then come in one turn). The trigger and the field
/// log the focus they take.
#[derive(Clone, PartialEq, Props)]
struct RenameMenuProps {
    /// The app owns `open`, following `onOpenChange`.
    controlled: bool,
    /// The field is a text input, not a view that takes the focus.
    input: bool,
}

#[component]
fn RenameMenu(props: RenameMenuProps) -> impl IntoElement {
    let (controlled, is_input) = (props.controlled, props.input);
    let log = signal(String::from("focus"));
    let note = move |what: &'static str| log.update(|log| log.push_str(what));
    let field = element_ref();
    let open = signal(false);
    let menu = menu();
    let menu = if controlled {
        menu.open(move || Some(open.get()))
            .on_open_change(move |e: &MenuEvent| {
                if let MenuEvent::OpenChange(next, _) = e {
                    open.set(*next);
                }
            })
    } else {
        menu
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu.trigger(
                view()
                    .test_id("actions")
                    .w(px(80.0))
                    .h(px(30.0))
                    .on_focus(move |_: &()| note(" trigger"))
                    .child(text("Actions")),
            )
            .child(
                menu_item()
                    .on_select(move || field.focus())
                    .child(text("Rename")),
            )
            .child(menu_item().child(text("Copy"))),
        )
        .child(if is_input {
            input()
                .element_ref(&field)
                .test_id("field")
                .w(px(120.0))
                .h(px(30.0))
                .on_focus(move |_: &()| note(" field"))
                .into_element()
        } else {
            view()
                .element_ref(&field)
                .test_id("field")
                .focusable(true)
                .w(px(120.0))
                .h(px(30.0))
                .on_focus(move |_: &()| note(" field"))
                .into_element()
        })
        .child(text(move || log.get()))
}

#[test]
fn a_choice_that_moves_the_focus_out_of_the_menu_keeps_it_there() {
    for (controlled, input, os) in [
        (false, false, Os::MacOs),
        (true, false, Os::MacOs),
        (true, true, Os::MacOs),
        (true, true, Os::Linux),
        (false, true, Os::Linux),
    ] {
        let case = format!("controlled {controlled}, input {input}, {os:?}");
        let mut app = start_on(
            nsh_testing::windowed_root_with::<RenameMenu>(move || RenameMenuProps {
                controlled,
                input,
            }),
            os,
        );
        app.app.press_key("tab").unwrap();
        app.app.wait_for("text:focus trigger").unwrap();
        app.app.press_key("enter").unwrap();
        app.app.wait_for("Rename").unwrap();
        // Rename has the focus: choosing it moves the focus to the field,
        // and the menu closing leaves it there instead of taking it back
        // to its trigger.
        app.app.press_key("enter").unwrap();
        app.app
            .wait_for_gone("Rename", std::time::Duration::from_secs(2))
            .unwrap();
        app.app.wait(std::time::Duration::from_millis(300)).unwrap();
        assert!(
            app.app.shows("focus trigger field"),
            "{case}: the focus stayed on the field: {:?}",
            app.app.screen().texts()
        );
        // A choice that moves nothing still gives it back to the trigger.
        app.app.press_key("shift+tab").unwrap();
        app.app
            .wait_for("text:focus trigger field trigger")
            .unwrap_or_else(|e| panic!("{case}: {e}"));
        app.app.press_key("enter").unwrap();
        app.app.wait_for("Copy").unwrap();
        app.app.press_key("down").unwrap();
        app.app.press_key("enter").unwrap();
        app.app
            .wait_for_gone("Copy", std::time::Duration::from_secs(2))
            .unwrap();
        app.app
            .wait_for("text:focus trigger field trigger trigger")
            .unwrap_or_else(|e| panic!("{case}: {e}"));
    }
}

/// A More menu whose Delete item opens a dialog confirming with Return,
/// as a destructive choice asks first. The text logs what was done.
#[component]
fn DeleteMenu() -> impl IntoElement {
    let confirming = signal(false);
    let log = signal(String::from("log"));
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(
                    view()
                        .test_id("more")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("More")),
                )
                .child(
                    menu_item()
                        .on_select(move || confirming.set(true))
                        .child(text("Delete")),
                )
                .child(menu_item().child(text("Rename"))),
        )
        .child(text(move || log.get()))
        .child(when(
            move || confirming.get(),
            move || {
                on_key("enter", move |_| {
                    log.update(|log| log.push_str(" confirmed"));
                    confirming.set(false);
                });
                dialog()
                    .label("Delete the file?")
                    .child(view().child(text("Really delete?")))
            },
        ))
}

#[test]
fn return_confirms_a_dialog_a_keyboard_menu_opened() {
    let mut app = start_with(nsh_testing::windowed_root::<DeleteMenu>());
    app.app.press_key("tab").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("Delete").unwrap();
    // Delete has the focus: choosing it opens the dialog as the menu
    // closes, its focus going back to the trigger under the dialog.
    app.app.press_key("enter").unwrap();
    app.app.wait_for("Really delete?").unwrap();
    app.app
        .wait_for_gone("Rename", std::time::Duration::from_secs(2))
        .unwrap();
    // Return is the dialog's, not the menu button's under it.
    app.app.press_key("enter").unwrap();
    app.app.wait_for("text:log confirmed").unwrap();
    app.app
        .wait_for_gone("Really delete?", std::time::Duration::from_secs(2))
        .unwrap();
    app.app.wait(std::time::Duration::from_millis(300)).unwrap();
    assert!(!app.app.shows("Rename"), "the menu did not open again");
}

#[test]
fn a_choice_typed_ahead_of_a_key_move_still_gives_the_focus_back_to_the_trigger() {
    // Down and Return in one batch: Down moves the focus to Copy, Return
    // chooses it, and the menu closes, all in one commit. The move into
    // the closing menu is not the app's: the focus goes back to the
    // trigger, not to an item on its way out.
    for controlled in [false, true] {
        let mut app = start_on(
            nsh_testing::windowed_root_with::<RenameMenu>(move || RenameMenuProps {
                controlled,
                input: false,
            }),
            Os::MacOs,
        );
        app.app.press_key("tab").unwrap();
        app.app.wait_for("text:focus trigger").unwrap();
        app.app.press_key("enter").unwrap();
        app.app.wait_for("Rename").unwrap();
        app.app.press_keys(&["down", "enter"]).unwrap();
        app.app
            .wait_for_gone("Copy", std::time::Duration::from_secs(2))
            .unwrap();
        app.app
            .wait_for("text:focus trigger trigger")
            .unwrap_or_else(|e| panic!("controlled {controlled}: {e}"));
    }
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
        let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
        let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
    let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
    let mut app = start_with(nsh_testing::windowed_root::<FileMenu>());
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
        let mut app = start_on(nsh_testing::windowed_root::<DocumentMenu>(), os);
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
            let mut app = start_on(nsh_testing::windowed_root::<DocumentMenu>(), os);
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
        let mut app = start_on(nsh_testing::windowed_root::<DocumentMenu>(), os);
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
    let mut app = start_on(nsh_testing::windowed_root::<DocumentMenu>(), Os::Web);
    app.app.right_click("id:doc").unwrap();
    app.app.wait_for("Rename").unwrap();
    app.app.press_key("space").unwrap();
    assert!(app.app.shows("chose:none"), "no item had the focus");
    assert!(app.app.shows("Rename"), "still open");
}

#[test]
fn after_a_secondary_click_down_focuses_the_first_enabled_item() {
    for (key, chosen) in [("down", "Rename"), ("up", "Delete")] {
        let mut app = start_on(nsh_testing::windowed_root::<DocumentMenu>(), Os::Web);
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
    let mut app = start_on(nsh_testing::windowed_root::<DocumentMenu>(), Os::Web);
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
    // macOS has no such key; Windows asks for a view's context menu
    // through UI Automation only.
    for os in [Os::MacOs, Os::Windows] {
        let mut app = start_on(nsh_testing::windowed_root::<DocumentMenu>(), os);
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
    let mut app = start_on(nsh_testing::windowed_root::<PressableRow>(), Os::Web);
    // The menu opens as the finger holds; lifting it reports no press or
    // release, while the app's own long press is still heard.
    app.app.long_press("id:row").unwrap();
    app.app.wait_for("Rename").unwrap();
    app.app.wait_for("text:p0 u0 l1").unwrap();
}

#[test]
fn a_tap_after_a_held_finger_presses_again() {
    let mut app = start_on(nsh_testing::windowed_root::<PressableRow>(), Os::Web);
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
    let mut app = start_on(nsh_testing::windowed_root::<PressableRow>(), Os::Web);
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
                pressure: 0.5,
                tilt_x: 0.0,
                tilt_y: 0.0,
            }],
            modifiers: Default::default(),
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
    let mut app = start_on(nsh_testing::windowed_root::<PressableRow>(), Os::Windows);
    hold_row(&mut app, nsh_core::PointerType::Mouse);
    assert!(
        !app.app.shows("Rename"),
        "a held mouse button opens no menu"
    );
}

#[test]
fn a_held_finger_or_pen_reported_as_a_touch_opens_the_menu() {
    for pointer_type in [nsh_core::PointerType::Touch, nsh_core::PointerType::Pen] {
        let mut app = start_on(nsh_testing::windowed_root::<PressableRow>(), Os::Windows);
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
            menu.on_open_change(move |e: &ContextMenuEvents| {
                if let ContextMenuEvents::OpenChange(next, _) = e {
                    open.set(*next);
                    changes.update(|c| c.push(if *next { 'o' } else { 'c' }));
                }
            })
            .on_position(move |e: &ContextMenuEvents| {
                if let ContextMenuEvents::Position(_, bounds, _) = e {
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
            nsh_testing::windowed_root_with::<RowMenu>(move || RowMenuProps { controlled }),
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
            nsh_testing::windowed_root_with::<RowMenu>(move || RowMenuProps { controlled }),
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

/// A document row (focusable, at (40, 100), 200 by 40) whose context menu
/// the app opens itself: a button below it sets `open`, as an app does for
/// a key of its own or for a list that has the focus while a row of it is
/// the one asked about. Its items: New (disabled), Rename, Delete. The
/// texts say where the popup was placed and the item chosen last.
#[component]
fn ShownMenu() -> impl IntoElement {
    let open = signal(false);
    let at = signal(String::from("none"));
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
            context_menu()
                .open(move || Some(open.get()))
                .on_open_change(move |e: &ContextMenuEvents| {
                    if let ContextMenuEvents::OpenChange(next, _) = e {
                        open.set(*next);
                    }
                })
                .on_position(move |e: &ContextMenuEvents| {
                    if let ContextMenuEvents::Position(_, bounds, _) = e {
                        at.set(format!("{} {}", bounds.origin.x.0, bounds.origin.y.0));
                    }
                })
                .trigger(
                    view()
                        .test_id("row")
                        .focusable(true)
                        .w(px(200.0))
                        .h(px(40.0))
                        .child(text("Row")),
                )
                .child(item("New", true))
                .child(item("Rename", false))
                .child(item("Delete", false)),
        )
        .child(
            view()
                .test_id("show")
                .focusable(true)
                .w(px(200.0))
                .h(px(40.0))
                .on_press(move || open.set(true))
                .child(text("Show")),
        )
        .child(text(move || format!("at:{}", at.get())))
        .child(text(move || format!("chose:{}", chose.get())))
}

#[test]
fn a_context_menu_the_app_opens_is_below_its_trigger_at_its_first_enabled_item() {
    for os in [Os::MacOs, Os::Linux, Os::Windows, Os::Web] {
        let mut app = start_on(nsh_testing::windowed_root::<ShownMenu>(), os);
        app.app.press("id:show").unwrap();
        app.app.wait_for("Rename").unwrap();
        // The row's bottom-left corner, not the window's top-left one.
        app.app
            .wait_for("text:at:40 140")
            .unwrap_or_else(|e| panic!("{os:?}: {e}"));
        app.app.press_key("space").unwrap();
        app.app
            .wait_for("text:chose:Rename")
            .unwrap_or_else(|e| panic!("{os:?}: {e}"));
    }
}

#[test]
fn escape_gives_the_focus_to_the_trigger_of_a_context_menu_the_app_opened() {
    let mut app = start_on(nsh_testing::windowed_root::<ShownMenu>(), Os::Linux);
    app.app.press("id:show").unwrap();
    app.app.wait_for("Rename").unwrap();
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Rename", std::time::Duration::from_secs(5))
        .unwrap();
    // The row has it: Shift+F10 opens its menu again.
    app.app.press_key("shift+f10").unwrap();
    app.app.wait_for("Rename").unwrap();
}

#[test]
fn escape_leaves_the_focus_where_it_was_after_a_context_menu_opened_by_a_press_on_a_mac() {
    let mut app = start_on(nsh_testing::windowed_root::<ShownMenu>(), Os::MacOs);
    app.app.press("id:show").unwrap();
    app.app.wait_for("Rename").unwrap();
    let focus = |app: &App| {
        let screen = app.app.screen();
        screen
            .commands()
            .iter()
            .filter(|(_, c)| *c == Command::Focus)
            .count()
    };
    let before = focus(&app);
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Rename", std::time::Duration::from_secs(5))
        .unwrap();
    // Nothing had the focus as the press opened it, as AppKit leaves it:
    // the row does not get it.
    assert_eq!(focus(&app), before, "no view takes the focus");
}

#[test]
fn a_secondary_click_moves_a_context_menu_the_app_opened_to_the_pointer() {
    let mut app = start_on(nsh_testing::windowed_root::<ShownMenu>(), Os::MacOs);
    app.app.press("id:show").unwrap();
    app.app.wait_for("text:at:40 140").unwrap();
    right_click_at(&mut app, "row", row(), point(px(50.0), px(110.0)));
    app.app.wait_for("text:at:50 110").unwrap();
    assert!(app.app.shows("Rename"), "still open");
    // Closed, then opened by the app again: at the row once more.
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for_gone("Rename", std::time::Duration::from_secs(5))
        .unwrap();
    app.app.press("id:show").unwrap();
    app.app.wait_for("text:at:40 140").unwrap();
}

/// [`ShownMenu`] on an iPad whose window is regular in width, where the
/// menu is a popup at its trigger. The harness moves the keyboard focus to
/// no view on iOS: the focus the menu asks for on its first enabled item
/// never comes, as on the iPad in #3013.
fn shown_menu_on_an_ipad() -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(834.0), px(1194.0)),
        ..EngineConfig::new(nsh_testing::windowed_root::<ShownMenu>())
    };
    config.environment.os = Os::Ios;
    config.environment.idiom = Idiom::Pad;
    config.environment.horizontal_size_class = Some(SizeClass::Regular);
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app
}

/// The view a press on the Delete item goes to.
fn delete_item(app: &Headless) -> NodeId {
    app.screen()
        .press_target("label:Delete")
        .unwrap()
        .expect("Delete takes presses")
}

#[test]
fn a_tap_chooses_its_item_while_the_focus_the_keys_asked_for_has_not_come() {
    // Opened by the app, the menu asks for the focus on Rename, as an
    // opening from the keyboard does. A tap on Delete is no Return typed
    // ahead of that focus: it chooses Delete.
    let mut app = shown_menu_on_an_ipad();
    app.press("id:show").unwrap();
    app.wait_for("Rename").unwrap();
    app.press("label:Delete").unwrap();
    app.wait_for("text:chose:Delete").unwrap();
}

#[test]
fn an_assistive_technologys_activation_chooses_its_item_while_the_focus_has_not_come() {
    // VoiceOver activates the item it is on with a press from no pointer,
    // as Return presses the focused one, but the keyboard focus is not on
    // Delete: it is no key typed ahead either.
    let mut app = shown_menu_on_an_ipad();
    app.press("id:show").unwrap();
    app.wait_for("Rename").unwrap();
    let delete = delete_item(&app);
    app.engine()
        .control()
        .dispatch_event(delete, EventKind::Press, EventPayload::None);
    app.wait_for("text:chose:Delete").unwrap();
}

#[test]
fn a_tap_that_focuses_its_item_first_still_chooses_it() {
    // A press that gives its item the keyboard focus before pressing it,
    // as a press focuses a control on Windows, a stop in a terminal and,
    // before #2783, a button on iOS: Delete has the focus as its press
    // comes, but the press is a finger's, no Return typed ahead.
    let mut app = shown_menu_on_an_ipad();
    app.press("id:show").unwrap();
    app.wait_for("Rename").unwrap();
    let delete = delete_item(&app);
    app.engine()
        .control()
        .dispatch_event(delete, EventKind::Focus, EventPayload::None);
    app.press("label:Delete").unwrap();
    app.wait_for("text:chose:Delete").unwrap();
}

/// A `flex-1` canvas-like view as a context menu's trigger, in a column
/// that fills the window (#2008).
#[component]
fn FillingTrigger() -> impl IntoElement {
    view().flex_1().child(
        context_menu()
            .trigger(view().test_id("fill").flex_1())
            .child(menu_item().child(text("Copy"))),
    )
}

#[test]
fn a_flex_1_trigger_fills_its_parent_as_without_the_menu() {
    let app = start_with(nsh_testing::windowed_root::<FillingTrigger>());
    let fill = app
        .app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.test_id.as_deref() == Some("fill"))
        .expect("the trigger is laid out");
    assert_eq!(fill.bounds.size.height, px(844.0));
    assert_eq!(fill.bounds.size.width, px(390.0));
}

/// A row whose menu is also given as data (`items`): the system's on iOS,
/// the drawn one (Rename) elsewhere. The text says what the app heard, in
/// order.
#[component]
fn SystemMenuRow() -> impl IntoElement {
    let heard = signal(String::from("heard:"));
    let hear = move |what: String| {
        heard.update(|h| {
            h.push(' ');
            h.push_str(&what);
        })
    };
    view()
        .pt(px(100.0))
        .child(
            context_menu()
                .items(vec![
                    MenuButtonItem::new("rename", "Rename").icon("pencil"),
                    MenuButtonItem::section(
                        "",
                        [MenuButtonItem::new("delete", "Delete").destructive(true)],
                    ),
                ])
                .title("Notes.txt")
                .on_open_change(move |e: &ContextMenuEvents| {
                    if let ContextMenuEvents::OpenChange(open, reason) = e {
                        hear(format!("{open}:{reason:?}"));
                    }
                })
                .on_open(move || hear("open".into()))
                .on_select(move |id: &SharedString| hear(format!("select:{id}")))
                .on_cancel(move || hear("cancel".into()))
                .on_close(move || hear("close".into()))
                .trigger(
                    view()
                        .test_id("row")
                        .w(px(200.0))
                        .h(px(40.0))
                        .child(text("Row")),
                )
                .child(menu_item().child(text("Drawn rename"))),
        )
        .child(text(move || heard.get()))
}

/// What the system's menu reports, as the iOS backend sends it, settled.
fn system_menu_event(app: &mut App, name: &str, data: serde_json::Value) {
    let id = app.seen.lock().unwrap().components[CONTEXT_MENU_COMPONENT];
    app.app.engine().control().dispatch_event(
        id,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: name.into(),
            data,
        },
    );
    app.app.settle();
}

#[test]
fn with_items_ios_shows_the_systems_context_menu_and_draws_none() {
    let mut app = start_on(nsh_testing::windowed_root::<SystemMenuRow>(), Os::Ios);
    {
        let seen = app.seen.lock().unwrap();
        let id = seen.components[CONTEXT_MENU_COMPONENT];
        let prop = |name: &str| seen.component_props[&(id, name.to_owned())].clone();
        assert_eq!(
            prop("items"),
            Some(serde_json::json!([
                { "id": "rename", "label": "Rename", "icon": "pencil" },
                { "id": "", "label": "", "inline": true, "items": [
                    { "id": "delete", "label": "Delete", "destructive": true },
                ] },
            ]))
        );
        assert_eq!(prop("title"), Some(serde_json::json!("Notes.txt")));
        assert_eq!(prop("disabled"), Some(serde_json::json!(false)));
    }
    // The system answers the held finger: NSH draws no menu of its own.
    hold_row(&mut app, PointerType::Touch);
    assert!(!app.app.shows("Drawn rename"), "no drawn menu");
    system_menu_event(&mut app, "open", serde_json::json!("touch"));
    app.app.wait_for("text:heard: true:LongPress open").unwrap();
    // A choice closes it with the choice; the system's later dismissal
    // reports nothing more.
    system_menu_event(&mut app, "select", serde_json::json!("delete"));
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    app.app
        .wait_for("text:heard: true:LongPress open false:Select select:delete close")
        .unwrap();
    // The secondary button's menu, dismissed without a choice.
    system_menu_event(&mut app, "open", serde_json::json!("pointer"));
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    app.app
        .wait_for(
            "text:heard: true:LongPress open false:Select select:delete close \
             true:ContextMenu open cancel false:PressOutside close",
        )
        .unwrap();
    assert!(!app.app.shows("Drawn rename"), "still no drawn menu");
}

#[test]
fn a_system_menus_choice_told_after_its_dismissal_still_reaches_the_app() {
    let mut app = start_on(nsh_testing::windowed_root::<SystemMenuRow>(), Os::Ios);
    system_menu_event(&mut app, "open", serde_json::json!("touch"));
    app.app.wait_for("text:heard: true:LongPress open").unwrap();
    // The platform tells a choice before its dismissal; one it could only
    // tell after (a handler run late) is the app's still, alone: the menu
    // had closed without one.
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    system_menu_event(&mut app, "select", serde_json::json!("rename"));
    app.app
        .wait_for("text:heard: true:LongPress open cancel false:PressOutside close select:rename")
        .unwrap();
    // The next opening starts afresh.
    system_menu_event(&mut app, "open", serde_json::json!("pointer"));
    system_menu_event(&mut app, "select", serde_json::json!("delete"));
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    app.app
        .wait_for(
            "text:heard: true:LongPress open cancel false:PressOutside close select:rename \
             true:ContextMenu open false:Select select:delete close",
        )
        .unwrap();
}

/// A system menu the app owns the `open` of, and opens ("Open it") and
/// closes ("Close it") itself.
#[component]
fn AppClosedSystemMenu() -> impl IntoElement {
    let open = signal(false);
    let heard = signal(String::from("heard:"));
    let hear = move |what: String| {
        heard.update(|h| {
            h.push(' ');
            h.push_str(&what);
        })
    };
    view()
        .pt(px(100.0))
        .child(
            context_menu()
                .items(vec![MenuButtonItem::new("rename", "Rename")])
                .open(move || Some(open.get()))
                .on_open_change(move |e: &ContextMenuEvents| {
                    if let ContextMenuEvents::OpenChange(next, reason) = e {
                        open.set(*next);
                        hear(format!("{next}:{reason:?}"));
                    }
                })
                .on_cancel(move || hear("cancel".into()))
                .on_close(move || hear("close".into()))
                .trigger(
                    view()
                        .test_id("row")
                        .w(px(200.0))
                        .h(px(40.0))
                        .child(text("Row")),
                ),
        )
        .child(
            view()
                .on_press(move || open.set(true))
                .child(text("Open it")),
        )
        .child(
            view()
                .on_press(move || open.set(false))
                .child(text("Close it")),
        )
        .child(text(move || heard.get()))
}

#[test]
fn a_system_menu_the_app_closes_reports_only_its_closing() {
    let mut app = start_on(nsh_testing::windowed_root::<AppClosedSystemMenu>(), Os::Ios);
    system_menu_event(&mut app, "open", serde_json::json!("touch"));
    app.app.wait_for("text:heard: true:LongPress").unwrap();
    // The app closes it: the platform dismisses the menu and tells.
    app.app.press("text:Close it").unwrap();
    app.app.settle();
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    // As the drawn menu: the closing (`onClose`), no user's attempt
    // (`onCancel`) and no change asked for.
    app.app
        .wait_for("text:heard: true:LongPress close")
        .unwrap();
}

/// A prop of the context menu's native component, as last sent.
fn system_menu_prop(app: &App, name: &str) -> Option<serde_json::Value> {
    let seen = app.seen.lock().unwrap();
    let id = seen.components[CONTEXT_MENU_COMPONENT];
    seen.component_props[&(id, name.to_owned())].clone()
}

#[test]
fn with_items_android_opens_the_systems_popup_menu_where_the_finger_held() {
    let mut app = start_on(nsh_testing::windowed_root::<SystemMenuRow>(), Os::Android);
    assert_eq!(
        system_menu_prop(&app, "items"),
        Some(serde_json::json!([
            { "id": "rename", "label": "Rename", "icon": "pencil" },
            { "id": "", "label": "", "inline": true, "items": [
                { "id": "delete", "label": "Delete", "destructive": true },
            ] },
        ]))
    );
    assert_eq!(
        system_menu_prop(&app, "title"),
        Some(serde_json::json!("Notes.txt"))
    );
    assert_eq!(
        system_menu_prop(&app, "open"),
        Some(serde_json::json!(false))
    );
    // Android's popup menu has no opener of its own: the held finger opens
    // it through `open`, at the point it held, and NSH draws none.
    hold_row(&mut app, PointerType::Touch);
    app.app.wait_for("text:heard: true:LongPress").unwrap();
    assert!(!app.app.shows("Drawn rename"), "no drawn menu");
    assert_eq!(
        system_menu_prop(&app, "open"),
        Some(serde_json::json!(true))
    );
    assert_eq!(
        system_menu_prop(&app, "at"),
        Some(serde_json::json!({ "x": 10.0, "y": 110.0 }))
    );
    // The platform tells it shown, then the choice and its dismissal, as
    // iOS's: the opening is not reported twice.
    system_menu_event(&mut app, "open", serde_json::json!("touch"));
    system_menu_event(&mut app, "select", serde_json::json!("delete"));
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    app.app
        .wait_for("text:heard: true:LongPress open false:Select select:delete close")
        .unwrap();
    assert_eq!(
        system_menu_prop(&app, "open"),
        Some(serde_json::json!(false))
    );
}

#[test]
fn an_android_system_menu_the_app_opens_drops_below_the_trigger() {
    let mut app = start_on(
        nsh_testing::windowed_root::<AppClosedSystemMenu>(),
        Os::Android,
    );
    app.app.press("text:Open it").unwrap();
    app.app.settle();
    // No finger asked for it: no point, the menu goes below the trigger.
    assert_eq!(
        system_menu_prop(&app, "open"),
        Some(serde_json::json!(true))
    );
    assert_eq!(system_menu_prop(&app, "at"), Some(serde_json::Value::Null));
}

#[test]
fn an_android_system_menu_that_never_showed_does_not_stay_open() {
    let mut app = start_on(nsh_testing::windowed_root::<SystemMenuRow>(), Os::Android);
    hold_row(&mut app, PointerType::Touch);
    app.app.wait_for("text:heard: true:LongPress").unwrap();
    // The platform could not show it (the row left the window before the
    // menu came up): it tells the closing alone, and the menu is asked
    // closed, with no opening or closing reported.
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    app.app
        .wait_for("text:heard: true:LongPress false:Cancel")
        .unwrap();
    assert_eq!(
        system_menu_prop(&app, "open"),
        Some(serde_json::json!(false))
    );
    // The next hold asks for it again.
    hold_row(&mut app, PointerType::Touch);
    app.app
        .wait_for("text:heard: true:LongPress false:Cancel true:LongPress")
        .unwrap();
    assert_eq!(
        system_menu_prop(&app, "open"),
        Some(serde_json::json!(true))
    );
}

#[test]
fn on_the_web_a_context_menus_items_are_not_used() {
    let mut app = start_on(nsh_testing::windowed_root::<SystemMenuRow>(), Os::Web);
    assert!(
        !app.seen
            .lock()
            .unwrap()
            .components
            .contains_key(CONTEXT_MENU_COMPONENT),
        "no system menu"
    );
    hold_row(&mut app, PointerType::Touch);
    app.app.wait_for("Drawn rename").unwrap();
}

/// A row whose system menu has a preview (iOS): the text says what the app
/// heard, in order.
#[component]
fn PreviewMenuRow() -> impl IntoElement {
    let heard = signal(String::from("heard:"));
    let hear = move |what: &str| {
        heard.update(|h| {
            h.push(' ');
            h.push_str(what);
        })
    };
    view()
        .pt(px(100.0))
        .child(
            context_menu()
                .items(vec![MenuButtonItem::new("rename", "Rename")])
                .on_open_change(move |e: &ContextMenuEvents| {
                    if let ContextMenuEvents::OpenChange(open, reason) = e {
                        hear(&format!("{open}:{reason:?}"));
                    }
                })
                .on_open(move || hear("open"))
                .on_preview_press(move || hear("preview"))
                .on_close(move || hear("close"))
                .preview(
                    view()
                        .test_id("preview")
                        .w(px(300.0))
                        .h(px(120.0))
                        .child(text("Last lines")),
                )
                .trigger(
                    view()
                        .test_id("row")
                        .w(px(200.0))
                        .h(px(40.0))
                        .child(text("Row")),
                ),
        )
        .child(text(move || heard.get()))
}

/// One phase of a finger on the row, settled.
fn touch_row(app: &mut App, phase: nsh_core::TouchPhase) {
    let row = app.seen.lock().unwrap().test_ids["row"];
    let event = EventPayload::Touch(Box::new(nsh_core::TouchEvent {
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
            pointer_type: PointerType::Touch,
            pressure: 0.5,
            tilt_x: 0.0,
            tilt_y: 0.0,
        }],
        modifiers: Default::default(),
        activated: None,
    }));
    app.app
        .engine()
        .control()
        .dispatch_event(nsh_core::ROOT_ID, EventKind::Touch, event);
    app.app.settle();
}

/// The preview's laid out size, while it is made.
fn preview_size(app: &App) -> Option<(f32, f32)> {
    app.app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.test_id.as_deref() == Some("preview"))
        .map(|n| (n.bounds.size.width.0, n.bounds.size.height.0))
}

#[test]
fn a_system_menus_preview_is_made_under_a_finger_and_kept_while_the_menu_is_up() {
    let mut app = start_on(nsh_testing::windowed_root::<PreviewMenuRow>(), Os::Ios);
    {
        let seen = app.seen.lock().unwrap();
        let id = seen.components[CONTEXT_MENU_COMPONENT];
        assert_eq!(
            seen.component_props[&(id, "preview".to_owned())],
            Some(serde_json::json!(true))
        );
    }
    // Nothing is made for rows nobody touches.
    assert_eq!(preview_size(&app), None);
    // A finger down: made, at its own size, out of sight, before the
    // system asks for it.
    touch_row(&mut app, nsh_core::TouchPhase::Start);
    assert_eq!(preview_size(&app), Some((300.0, 120.0)));
    assert!(!app.app.shows("Last lines"), "out of sight");
    // The system takes the touch over and shows the menu: the preview stays.
    system_menu_event(&mut app, "open", serde_json::json!("touch"));
    touch_row(&mut app, nsh_core::TouchPhase::Cancel);
    app.app.wait(std::time::Duration::from_secs(2)).unwrap();
    assert_eq!(preview_size(&app), Some((300.0, 120.0)));
    // A press on it closes the menu as a choice does, and it goes.
    system_menu_event(&mut app, "previewPress", serde_json::Value::Null);
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    app.app
        .wait_for("text:heard: true:LongPress open false:Select preview close")
        .unwrap();
    assert_eq!(preview_size(&app), None);
}

#[test]
fn a_system_menus_preview_goes_after_a_tap_that_opened_no_menu() {
    let mut app = start_on(nsh_testing::windowed_root::<PreviewMenuRow>(), Os::Ios);
    touch_row(&mut app, nsh_core::TouchPhase::Start);
    touch_row(&mut app, nsh_core::TouchPhase::End);
    assert!(preview_size(&app).is_some(), "kept a moment");
    app.app
        .wait(std::time::Duration::from_millis(1100))
        .unwrap();
    assert_eq!(preview_size(&app), None);
    // A preview press told after the dismissal still reaches the app.
    system_menu_event(&mut app, "open", serde_json::json!("touch"));
    system_menu_event(&mut app, "close", serde_json::Value::Null);
    system_menu_event(&mut app, "previewPress", serde_json::Value::Null);
    app.app
        .wait_for("text:heard: true:LongPress open false:PressOutside close preview")
        .unwrap();
}

#[test]
fn without_a_preview_a_system_menu_makes_none() {
    let mut app = start_on(nsh_testing::windowed_root::<SystemMenuRow>(), Os::Ios);
    {
        let seen = app.seen.lock().unwrap();
        let id = seen.components[CONTEXT_MENU_COMPONENT];
        assert_eq!(
            seen.component_props[&(id, "preview".to_owned())],
            Some(serde_json::json!(false))
        );
    }
    let before = app.app.screen().layout_nodes().len();
    touch_row(&mut app, nsh_core::TouchPhase::Start);
    assert_eq!(app.app.screen().layout_nodes().len(), before);
}

/// A row with a context menu and no `items`, as before they existed.
#[component]
fn DrawnOnlyRow() -> impl IntoElement {
    view().pt(px(100.0)).child(
        context_menu()
            .trigger(
                view()
                    .test_id("row")
                    .w(px(200.0))
                    .h(px(40.0))
                    .child(text("Row")),
            )
            .child(menu_item().child(text("Drawn rename"))),
    )
}

#[test]
fn without_items_ios_mounts_what_the_other_platforms_do() {
    // Off iOS a context menu without `items` is made as it was before they
    // existed; on iOS it must send the platform the same items too (views,
    // listeners, the drawn menu), with no system menu, as it renders and
    // as a held finger opens it.
    let mounted = |os| {
        let mut app = start_on(nsh_testing::windowed_root::<DrawnOnlyRow>(), os);
        hold_row(&mut app, PointerType::Touch);
        app.app.wait_for("Drawn rename").unwrap();
        let seen = app.seen.lock().unwrap();
        assert!(seen.components.is_empty(), "{os:?}: no native component");
        seen.items.clone()
    };
    let ios = mounted(Os::Ios);
    assert!(!ios.is_empty());
    assert_eq!(ios, mounted(Os::Android));
}
