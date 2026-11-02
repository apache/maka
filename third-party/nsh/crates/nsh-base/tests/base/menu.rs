//! Checkable menu items: `MenuItem`'s `checked` makes an item a
//! `menuitemcheckbox` (or, with its `role`, a `menuitemradio`) that screen
//! readers hear as checked or not, whose `checked:` styles and indicator
//! part follow the value the app owns; choosing one reports `onSelect` and
//! closes the menu unless `closeOnSelect` is false; toggling one item sends
//! only that item and its indicator. A desktop menu, on a Mac.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use nsh_base::{MenuEvent, menu, menu_item};
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
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<ViewMenu>())
    };
    config.environment.os = Os::MacOs;
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
