//! `Tree`: a tree of items for screen readers (each with its level,
//! expanded and selected states); a press selects a row and expands or
//! collapses a folder; the tree is one stop of the keyboard focus whose
//! arrows move the selection past disabled items (Right and Left expand,
//! collapse, and go to the first child and the parent; they trade places
//! in a right-to-left layout), Home and End go to the ends, Return and
//! Space expand and collapse, letters select by typeahead; the state is
//! the app's when it sets it; `revealItem`
//! expands what is above an item; the keys act on the row a hidden
//! selection is under, and the keyboard's focus shows on the first row
//! while nothing is selected; screen readers' focus follows the keys;
//! items that change keep the selection by id; and a key press or an
//! expansion costs the rows it concerns, however many items there are. On
//! macOS, where Tab stops at the tree.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{TreeApi, TreeEntry, TreeItem, button, tree};
use nsh_core::{Command, MountItem, NodeId, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// src (lib.rs, ui (tree.rs, list.rs)), docs (old.md disabled, guide.md),
/// a disabled folder `vendor` (dep.rs), README.md.
fn files() -> Vec<TreeItem> {
    vec![
        TreeItem::new("src", "src")
            .child(TreeItem::new("src/lib.rs", "lib.rs"))
            .child(
                TreeItem::new("src/ui", "ui")
                    .child(TreeItem::new("src/ui/tree.rs", "tree.rs"))
                    .child(TreeItem::new("src/ui/list.rs", "list.rs")),
            ),
        TreeItem::new("docs", "docs")
            .child(TreeItem::new("docs/old.md", "old.md").disabled(true))
            .child(TreeItem::new("docs/guide.md", "guide.md")),
        TreeItem::new("vendor", "vendor")
            .child(TreeItem::new("vendor/dep.rs", "dep.rs"))
            .disabled(true),
        TreeItem::new("README.md", "README.md"),
    ]
}

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    items: Vec<TreeItem>,
    /// The app sets `expanded` and `selected`.
    controlled: bool,
    /// The app follows the events (when it controls).
    follow: bool,
    disabled: bool,
    /// A `renderItem` drawing `▸` / `▾` before a folder's label.
    custom: bool,
    /// Nothing expanded at first (else `src`).
    collapsed: bool,
}

fn props() -> HarnessProps {
    HarnessProps {
        items: files(),
        controlled: false,
        follow: true,
        disabled: false,
        custom: false,
        collapsed: false,
    }
}

/// A button `Before`, the tree (`src` expanded at first) in a 300 × 400
/// box, its rows `focus:opacity-50`, a button `After`; what the app heard
/// as `log:…`, the selection and the expanded items as `selected:…` and
/// `expanded:…` (the app's when it controls, else the events'). F5
/// reveals `src/ui/tree.rs`, F6 `nope`; F7 toggles `disabled`; F8 adds an
/// item `new.txt` at the top, F9 takes `docs` away; F10 collapses every
/// item (when the app controls).
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let selected = signal(None::<SharedString>);
    let first: Vec<SharedString> = if props.collapsed {
        Vec::new()
    } else {
        vec![SharedString::from("src")]
    };
    let expanded = signal(first.clone());
    let items = signal(props.items.clone());
    let log = signal(Vec::<String>::new());
    let pressed = signal("none");
    let disabled = signal(props.disabled);
    let push = move |s: String| log.update(|l| l.push(s));
    let r = component_ref::<nsh_base::Tree>();
    on_key("f5", move |_| {
        if let Some(api) = r.api::<TreeApi>() {
            api.reveal_item("src/ui/tree.rs".into());
        }
    });
    on_key("f6", move |_| {
        if let Some(api) = r.api::<TreeApi>() {
            api.reveal_item("nope".into());
        }
    });
    on_key("f7", move |_| disabled.update(|d| *d = !*d));
    on_key("f8", move |_| {
        items.update(|i| i.insert(0, TreeItem::new("new", "new.txt")));
    });
    on_key("f9", move |_| {
        items.update(|i| i.retain(|i| i.id != "docs"))
    });
    on_key("f10", move |_| expanded.set(Vec::new()));
    let follow = props.follow;
    let mut el = tree()
        .items(move || items.get())
        .item_class("focus:opacity-50")
        .accessibility_label("Files")
        .disabled(disabled)
        .on_expanded_change(move |ids: &Vec<SharedString>| {
            push(format!("expanded={}", ids.join(",")));
            if follow {
                expanded.set(ids.clone());
            }
        })
        .on_selected_change(move |id: &SharedString| {
            push(format!("selected={id}"));
            if follow {
                selected.set(Some(id.clone()));
            }
        })
        .on_expand(move |id: &SharedString| push(format!("expand={id}")))
        .on_collapse(move |id: &SharedString| push(format!("collapse={id}")))
        .on_action(move |id: &SharedString| push(format!("action={id}")))
        .component_ref(&r)
        .w(px(300.0))
        .h(px(400.0));
    if props.controlled {
        el = el
            .expanded(move || Some(expanded.get()))
            .selected(move || selected.get());
    } else {
        el = el.default_expanded(first);
    }
    if props.custom {
        el = el.render_item(|e: &TreeEntry| {
            text(format!(
                "{}{}@{}",
                if e.folder { "▸" } else { "" },
                e.label,
                e.depth
            ))
        });
    }
    view()
        .child(
            button()
                .accessibility_label("Before")
                .on_press(move || pressed.set("before"))
                .child(text("Before")),
        )
        .child(el)
        .child(
            button()
                .accessibility_label("After")
                .on_press(move || pressed.set("after"))
                .child(text("After")),
        )
        .child(text(move || format!("pressed:{}", pressed.get())))
        .child(text(move || format!("log:{}", log.get().join(" "))))
        .child(text(move || {
            format!(
                "selected:{}",
                selected.get().as_deref().unwrap_or("none").to_owned()
            )
        }))
        .child(text(move || {
            format!("expanded:{}", expanded.get().join(","))
        }))
}

fn launch(root: Root) -> Headless {
    launch_with(root, false)
}

fn launch_with(root: Root, screen_reader: bool) -> Headless {
    launch_in(root, screen_reader, false)
}

/// [`launch_with`] in a right-to-left layout with `rtl`.
fn launch_in(root: Root, screen_reader: bool, rtl: bool) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    config.environment.screen_reader = screen_reader;
    config.environment.rtl = rtl;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

fn start(props: HarnessProps) -> Headless {
    start_with(props, false)
}

fn start_with(props: HarnessProps, screen_reader: bool) -> Headless {
    let mut app = launch_with(Root::new::<Harness>(move || props.clone()), screen_reader);
    app.wait_for("role:treeitem[src]").unwrap();
    app
}

/// [`start`] in a right-to-left layout.
fn start_rtl(props: HarnessProps) -> Headless {
    let mut app = launch_in(Root::new::<Harness>(move || props.clone()), false, true);
    app.wait_for("role:treeitem[src]").unwrap();
    app
}

/// Each view's opacity as the batches applied from now on set it: a row
/// shows the keyboard's focus (`focus:opacity-50`) at 0.5.
type Opacities = Arc<Mutex<HashMap<NodeId, f32>>>;

fn watch(app: &mut Headless) -> Opacities {
    let opacities = Opacities::default();
    let into = opacities.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item {
                into.lock().unwrap().insert(*id, style.opacity);
            }
        }
    });
    opacities
}

/// The view a press on `selector` reaches.
fn id(app: &Headless, selector: &str) -> NodeId {
    app.screen()
        .press_target(selector)
        .unwrap()
        .unwrap_or_else(|| panic!("no `{selector}`"))
}

/// Waits until the row of `label`, alone of `labels`, shows the keyboard's
/// focus.
fn see_focus_on(app: &mut Headless, opacities: &Opacities, label: &str, labels: &[&str]) {
    let ids: Vec<(&str, NodeId)> = labels
        .iter()
        .map(|&l| (l, id(app, &format!("role:treeitem[{l}]"))))
        .collect();
    let opacities = opacities.clone();
    app.wait_until(
        &format!("the focus on {label}"),
        Duration::from_secs(5),
        move |_| {
            let o = opacities.lock().unwrap();
            ids.iter()
                .all(|&(l, id)| (o.get(&id).copied().unwrap_or(1.0) < 1.0) == (l == label))
        },
    )
    .unwrap();
}

/// Waits until the row of `label` takes the screen reader's focus.
fn see_a11y_focus_on(app: &mut Headless, label: &str) {
    let row = id(app, &format!("role:treeitem[{label}]"));
    app.wait_until(
        &format!("the screen reader's focus on {label}"),
        Duration::from_secs(5),
        move |s| {
            s.commands()
                .iter()
                .any(|(id, c)| *id == row && *c == Command::AccessibilityFocus)
        },
    )
    .unwrap();
}

/// Tab from Before into the tree.
fn enter(app: &mut Headless) {
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
}

fn key(app: &mut Headless, keys: &str) {
    app.press_key(keys).unwrap();
}

fn see(app: &mut Headless, text: &str) {
    app.wait_for(&format!("text:{text}")).unwrap();
}

fn log(app: &Headless) -> String {
    app.screen()
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("log:").map(str::to_owned))
        .unwrap_or_default()
}

/// Longer than presses of a double press are apart (the headless driver's
/// 500 ms, as the platforms'): the next press is a press of its own.
fn single_press_pause(app: &mut Headless) {
    app.wait(Duration::from_millis(600)).unwrap();
}

fn rows(app: &Headless) -> usize {
    app.screen().count("role:treeitem").unwrap()
}

#[test]
fn screen_readers_hear_a_tree_of_items_with_levels_and_states() {
    let app = start(props());
    let screen = app.screen();
    assert_eq!(screen.count("role:tree[Files]"), Ok(1));
    // src expanded: src, lib.rs, ui, docs, vendor, README.md.
    assert_eq!(screen.count("role:treeitem"), Ok(6));
    assert_eq!(
        screen.accessibility_level("role:treeitem[src]"),
        Ok(Some(1))
    );
    assert_eq!(
        screen.accessibility_level("role:treeitem[lib.rs]"),
        Ok(Some(2))
    );
    let state = |label: &str| {
        screen
            .accessibility_state(&format!("role:treeitem[{label}]"))
            .unwrap()
    };
    assert_eq!(state("src").expanded, Some(true));
    assert_eq!(state("docs").expanded, Some(false));
    assert_eq!(state("README.md").expanded, None);
    assert!(!state("src").selected);
    assert!(!screen.enabled("role:treeitem[vendor]").unwrap());
    assert!(screen.enabled("role:treeitem[docs]").unwrap());
}

#[test]
fn a_press_selects_a_row_and_expands_or_collapses_a_folder() {
    let mut app = start(props());
    app.press("role:treeitem[docs]").unwrap();
    app.wait_for("role:treeitem[guide.md]").unwrap();
    assert!(app.screen().selected("role:treeitem[docs]").unwrap());
    assert_eq!(
        log(&app),
        "selected=docs expanded=src,docs expand=docs",
        "the selection, then the expanded items, then the item expanded"
    );
    assert_eq!(
        app.screen().accessibility_level("role:treeitem[guide.md]"),
        Ok(Some(2))
    );
    // Another press later, not the second of a double press.
    single_press_pause(&mut app);
    app.press("role:treeitem[docs]").unwrap();
    app.wait_for_gone("role:treeitem[guide.md]", Duration::from_secs(5))
        .unwrap();
    assert!(log(&app).ends_with("expanded=src collapse=docs"));
    // A leaf is selected only.
    app.press("role:treeitem[lib.rs]").unwrap();
    see(&mut app, "selected:src/lib.rs");
    assert!(app.screen().selected("role:treeitem[lib.rs]").unwrap());
    assert!(!app.screen().selected("role:treeitem[docs]").unwrap());
}

#[test]
fn a_disabled_item_takes_no_press() {
    let mut app = start(props());
    assert!(app.press("role:treeitem[vendor]").is_err());
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "");
    assert_eq!(app.screen().count("role:treeitem[dep.rs]"), Ok(0));
}

#[test]
fn up_and_down_move_the_selection_past_disabled_rows_and_around_the_ends() {
    let mut app = start(props());
    enter(&mut app);
    // Nothing selected: Down selects the first row.
    key(&mut app, "down");
    see(&mut app, "selected:src");
    for id in ["src/lib.rs", "src/ui", "docs", "README.md", "src"] {
        key(&mut app, "down");
        see(&mut app, &format!("selected:{id}"));
    }
    // Around the start, past the disabled `vendor`.
    key(&mut app, "up");
    see(&mut app, "selected:README.md");
    key(&mut app, "up");
    see(&mut app, "selected:docs");
    assert!(app.screen().selected("role:treeitem[docs]").unwrap());
}

#[test]
fn home_and_end_go_to_the_first_and_last_enabled_row() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "end");
    see(&mut app, "selected:README.md");
    key(&mut app, "home");
    see(&mut app, "selected:src");
}

#[test]
fn right_expands_then_enters_and_left_collapses_then_leaves() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "down");
    key(&mut app, "down");
    key(&mut app, "down");
    see(&mut app, "selected:src/ui");
    // A collapsed folder expands, an expanded one goes to its first child.
    key(&mut app, "right");
    app.wait_for("role:treeitem[tree.rs]").unwrap();
    see(&mut app, "selected:src/ui");
    key(&mut app, "right");
    see(&mut app, "selected:src/ui/tree.rs");
    // A leaf: Right does nothing, Left goes to the parent.
    key(&mut app, "right");
    app.wait(Duration::from_millis(50)).unwrap();
    see(&mut app, "selected:src/ui/tree.rs");
    key(&mut app, "left");
    see(&mut app, "selected:src/ui");
    // An expanded folder collapses, then goes to its parent.
    key(&mut app, "left");
    app.wait_for_gone("role:treeitem[tree.rs]", Duration::from_secs(5))
        .unwrap();
    key(&mut app, "left");
    see(&mut app, "selected:src");
    key(&mut app, "left");
    app.wait_for_gone("role:treeitem[lib.rs]", Duration::from_secs(5))
        .unwrap();
    see(&mut app, "expanded:");
}

#[test]
fn right_to_left_left_expands_then_enters_and_right_collapses_then_leaves() {
    let mut app = start_rtl(props());
    enter(&mut app);
    key(&mut app, "down");
    key(&mut app, "down");
    key(&mut app, "down");
    see(&mut app, "selected:src/ui");
    // The rows run from the right: Left expands, then goes to the first
    // child.
    key(&mut app, "left");
    app.wait_for("role:treeitem[tree.rs]").unwrap();
    see(&mut app, "selected:src/ui");
    key(&mut app, "left");
    see(&mut app, "selected:src/ui/tree.rs");
    // Right goes to the parent, then collapses it.
    key(&mut app, "right");
    see(&mut app, "selected:src/ui");
    key(&mut app, "right");
    app.wait_for_gone("role:treeitem[tree.rs]", Duration::from_secs(5))
        .unwrap();
    // Up and Down keep theirs.
    key(&mut app, "up");
    see(&mut app, "selected:src/lib.rs");
    key(&mut app, "down");
    see(&mut app, "selected:src/ui");
    // The direction changes while the tree has the focus: the keys follow.
    app.set_environment("ltr", |env| env.rtl = false).unwrap();
    key(&mut app, "right");
    app.wait_for("role:treeitem[tree.rs]").unwrap();
    key(&mut app, "left");
    app.wait_for_gone("role:treeitem[tree.rs]", Duration::from_secs(5))
        .unwrap();
    see(&mut app, "selected:src/ui");
}

#[test]
fn return_and_space_expand_and_collapse_the_selected_folder() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "end");
    key(&mut app, "up");
    see(&mut app, "selected:docs");
    key(&mut app, "enter");
    app.wait_for("role:treeitem[guide.md]").unwrap();
    key(&mut app, "space");
    app.wait_for_gone("role:treeitem[guide.md]", Duration::from_secs(5))
        .unwrap();
    assert!(log(&app).ends_with("expand=docs expanded=src collapse=docs"));
}

#[test]
fn return_acts_on_a_selected_leaf_and_not_on_a_folder() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "down");
    key(&mut app, "down");
    see(&mut app, "selected:src/lib.rs");
    key(&mut app, "enter");
    app.wait_until("the action reported", Duration::from_secs(5), |s| {
        s.texts()
            .contains(&"log:selected=src selected=src/lib.rs action=src/lib.rs")
    })
    .unwrap();
    // Space on a leaf does nothing.
    key(&mut app, "space");
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(
        log(&app),
        "selected=src selected=src/lib.rs action=src/lib.rs"
    );
    // Return on a folder expands it, and does not act on it.
    key(&mut app, "up");
    see(&mut app, "selected:src");
    key(&mut app, "enter");
    app.wait_for_gone("role:treeitem[lib.rs]", Duration::from_secs(5))
        .unwrap();
    assert!(!log(&app).contains("action=src "));
    assert!(log(&app).ends_with("collapse=src"));
}

#[test]
fn a_double_press_acts_on_any_enabled_item_once() {
    let mut app = start(props());
    // A leaf: the first press selects it, the second acts on it.
    app.press("role:treeitem[lib.rs]").unwrap();
    app.press("role:treeitem[lib.rs]").unwrap();
    app.wait_until("the action reported", Duration::from_secs(5), |s| {
        s.texts()
            .contains(&"log:selected=src/lib.rs action=src/lib.rs")
    })
    .unwrap();
    // A third press of the same run acts no more.
    app.press("role:treeitem[lib.rs]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "selected=src/lib.rs action=src/lib.rs");
    // A folder: each press expands or collapses it, the second acts on it
    // after its own events.
    single_press_pause(&mut app);
    app.press("role:treeitem[docs]").unwrap();
    app.press("role:treeitem[docs]").unwrap();
    app.wait_until("the folder's action", Duration::from_secs(5), |s| {
        s.texts().iter().any(|t| t.ends_with("action=docs"))
    })
    .unwrap();
    assert!(log(&app).ends_with(
        "selected=docs expanded=src,docs expand=docs expanded=src collapse=docs action=docs"
    ));
    // Single presses far apart never act.
    single_press_pause(&mut app);
    app.press("role:treeitem[README.md]").unwrap();
    single_press_pause(&mut app);
    app.press("role:treeitem[README.md]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(log(&app).ends_with("collapse=docs action=docs selected=README.md"));
}

#[test]
fn disabled_items_and_a_disabled_tree_never_act() {
    let mut app = start(props());
    // A disabled item takes no press, double or single.
    assert!(app.press("role:treeitem[vendor]").is_err());
    assert!(app.press("role:treeitem[vendor]").is_err());
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "");
    // A disabled tree: no press, no key.
    key(&mut app, "f7");
    assert!(app.press("role:treeitem[lib.rs]").is_err());
    assert!(app.press("role:treeitem[lib.rs]").is_err());
    enter(&mut app);
    key(&mut app, "enter");
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(!log(&app).contains("action="));
}

#[test]
fn typeahead_selects_the_next_row_whose_label_starts_with_what_was_typed() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "r");
    see(&mut app, "selected:README.md");
    // `l` after a pause: lib.rs, then list.rs is hidden, so lib.rs again.
    app.wait(Duration::from_millis(1100)).unwrap();
    key(&mut app, "l");
    see(&mut app, "selected:src/lib.rs");
}

#[test]
fn the_tree_is_one_stop_and_tab_comes_back_to_the_selection() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "down");
    key(&mut app, "down");
    see(&mut app, "selected:src/lib.rs");
    // One Tab leaves the tree, whatever row is selected.
    key(&mut app, "tab");
    key(&mut app, "space");
    see(&mut app, "pressed:after");
    // Back in, the keys go on from the selection.
    key(&mut app, "shift+tab");
    key(&mut app, "down");
    see(&mut app, "selected:src/ui");
}

#[test]
fn a_controlled_state_is_the_apps() {
    let mut app = start(HarnessProps {
        controlled: true,
        follow: false,
        ..props()
    });
    enter(&mut app);
    key(&mut app, "down");
    app.wait_until("the selection reported", Duration::from_secs(5), |s| {
        s.texts().contains(&"log:selected=src")
    })
    .unwrap();
    // Not followed: nothing is selected, and Down reports the same row.
    assert!(!app.screen().selected("role:treeitem[src]").unwrap());
    key(&mut app, "down");
    app.wait_until("the same row reported", Duration::from_secs(5), |s| {
        s.texts().contains(&"log:selected=src selected=src")
    })
    .unwrap();
    assert!(!app.screen().selected("role:treeitem[src]").unwrap());
    app.press("role:treeitem[docs]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(log(&app).ends_with("selected=docs expanded=src,docs expand=docs"));
    assert_eq!(app.screen().count("role:treeitem[guide.md]"), Ok(0));
}

#[test]
fn a_disabled_tree_takes_no_press_and_is_no_stop() {
    let mut app = start(HarnessProps {
        disabled: true,
        ..props()
    });
    assert!(!app.screen().enabled("role:treeitem[src]").unwrap());
    assert!(app.press("role:treeitem[docs]").is_err());
    // Before, then past the tree to After.
    enter(&mut app);
    key(&mut app, "space");
    see(&mut app, "pressed:after");
    assert_eq!(log(&app), "");
    // Enabled again.
    key(&mut app, "f7");
    app.press("role:treeitem[docs]").unwrap();
    see(&mut app, "selected:docs");
}

#[test]
fn reveal_item_expands_the_items_above_it() {
    let mut app = start(HarnessProps {
        collapsed: true,
        ..props()
    });
    key(&mut app, "f5");
    app.wait_for("role:treeitem[tree.rs]").unwrap();
    // Every collapsed item above it, in one change, the outermost first.
    assert_eq!(log(&app), "expanded=src,src/ui expand=src expand=src/ui");
    // Shown already: nothing to expand.
    key(&mut app, "f5");
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "expanded=src,src/ui expand=src expand=src/ui");
    // An unknown id does nothing.
    key(&mut app, "f6");
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "expanded=src,src/ui expand=src expand=src/ui");
}

#[test]
fn reveal_item_only_expands_the_items_above_a_shown_one() {
    // `src` is expanded: only `src/ui` is.
    let mut app = start(props());
    key(&mut app, "f5");
    app.wait_for("role:treeitem[tree.rs]").unwrap();
    assert_eq!(log(&app), "expanded=src,src/ui expand=src/ui");
}

#[test]
fn keys_on_a_hidden_selection_act_on_the_row_it_is_hidden_under() {
    let mut app = start(HarnessProps {
        controlled: true,
        ..props()
    });
    let opacities = watch(&mut app);
    enter(&mut app);
    // src/ui/tree.rs selected, then every item collapsed.
    for _ in 0..3 {
        key(&mut app, "down");
    }
    key(&mut app, "right");
    key(&mut app, "right");
    see(&mut app, "selected:src/ui/tree.rs");
    key(&mut app, "f10");
    app.wait_for_gone("role:treeitem[lib.rs]", Duration::from_secs(5))
        .unwrap();
    let before = log(&app);
    // The keyboard's focus is on `src`, the row it is hidden under.
    see_focus_on(&mut app, &opacities, "src", &["src", "docs", "README.md"]);
    // Left: `src` is collapsed and at the top: nothing (not the hidden
    // `src/ui`).
    key(&mut app, "left");
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), before);
    // Right expands `src`, then `src/ui`, under which it is now.
    key(&mut app, "right");
    app.wait_for("role:treeitem[ui]").unwrap();
    assert_eq!(log(&app), format!("{before} expanded=src expand=src"));
    see_focus_on(&mut app, &opacities, "ui", &["src", "lib.rs", "ui"]);
    key(&mut app, "right");
    app.wait_for("role:treeitem[tree.rs]").unwrap();
    assert!(log(&app).ends_with("expanded=src,src/ui expand=src/ui"));
    see_focus_on(&mut app, &opacities, "tree.rs", &["src", "ui", "tree.rs"]);
    assert!(app.screen().selected("role:treeitem[tree.rs]").unwrap());
}

#[test]
fn return_on_a_hidden_selection_expands_the_row_it_is_hidden_under() {
    let mut app = start(HarnessProps {
        controlled: true,
        ..props()
    });
    enter(&mut app);
    // `src/ui` (a collapsed folder) selected, then `src` collapsed.
    for _ in 0..3 {
        key(&mut app, "down");
    }
    see(&mut app, "selected:src/ui");
    key(&mut app, "f10");
    app.wait_for_gone("role:treeitem[ui]", Duration::from_secs(5))
        .unwrap();
    let before = log(&app);
    key(&mut app, "enter");
    app.wait_for("role:treeitem[ui]").unwrap();
    assert_eq!(log(&app), format!("{before} expanded=src expand=src"));
    assert_eq!(app.screen().count("role:treeitem[tree.rs]"), Ok(0));
}

#[test]
fn with_nothing_selected_the_focus_shows_on_the_first_row() {
    let mut app = start(props());
    let opacities = watch(&mut app);
    enter(&mut app);
    see_focus_on(
        &mut app,
        &opacities,
        "src",
        &["src", "lib.rs", "ui", "docs"],
    );
    assert_eq!(log(&app), "");
    // Down selects it; the focus moves with the selection.
    key(&mut app, "down");
    see(&mut app, "selected:src");
    see_focus_on(
        &mut app,
        &opacities,
        "src",
        &["src", "lib.rs", "ui", "docs"],
    );
    key(&mut app, "down");
    see(&mut app, "selected:src/lib.rs");
    see_focus_on(
        &mut app,
        &opacities,
        "lib.rs",
        &["src", "lib.rs", "ui", "docs"],
    );
    // Out of the tree: no row shows it.
    key(&mut app, "tab");
    see_focus_on(&mut app, &opacities, "", &["src", "lib.rs", "ui", "docs"]);
}

#[test]
fn with_nothing_selected_right_acts_on_the_row_the_focus_shows_on() {
    let mut app = start(props());
    enter(&mut app);
    // The focus shows on `src`, expanded: Right goes to its first child
    // at once, as it would with `src` selected.
    key(&mut app, "right");
    see(&mut app, "selected:src/lib.rs");
}

#[test]
fn the_screen_readers_focus_follows_the_keys() {
    let mut app = start_with(props(), true);
    enter(&mut app);
    // Into the tree: to the row the keys act on.
    see_a11y_focus_on(&mut app, "src");
    key(&mut app, "down");
    key(&mut app, "down");
    see(&mut app, "selected:src/lib.rs");
    see_a11y_focus_on(&mut app, "lib.rs");
    key(&mut app, "end");
    see(&mut app, "selected:README.md");
    see_a11y_focus_on(&mut app, "README.md");
}

#[test]
fn right_on_an_expanded_folder_goes_to_its_first_enabled_child() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "end");
    key(&mut app, "up");
    see(&mut app, "selected:docs");
    key(&mut app, "right");
    app.wait_for("role:treeitem[guide.md]").unwrap();
    // `old.md`, the first child, is disabled.
    key(&mut app, "right");
    see(&mut app, "selected:docs/guide.md");
}

#[test]
fn items_that_change_keep_the_selection_by_id() {
    let mut app = start(props());
    enter(&mut app);
    key(&mut app, "end");
    key(&mut app, "up");
    key(&mut app, "enter");
    app.wait_for("role:treeitem[guide.md]").unwrap();
    see(&mut app, "selected:docs");
    // An item before it: every node moves on by one, the lit row with it.
    key(&mut app, "f8");
    app.wait_for("role:treeitem[new.txt]").unwrap();
    let screen = app.screen();
    for label in ["new.txt", "src", "lib.rs", "ui", "guide.md", "README.md"] {
        assert!(
            !screen.selected(&format!("role:treeitem[{label}]")).unwrap(),
            "{label} is not selected"
        );
    }
    assert!(screen.selected("role:treeitem[docs]").unwrap());
    // The keys go on from it (past the disabled `old.md`).
    key(&mut app, "down");
    see(&mut app, "selected:docs/guide.md");
    // The selected item taken away: nothing is selected, Down starts over.
    key(&mut app, "f9");
    app.wait_for_gone("role:treeitem[docs]", Duration::from_secs(5))
        .unwrap();
    for label in ["new.txt", "src", "lib.rs", "ui", "README.md"] {
        assert!(
            !app.screen()
                .selected(&format!("role:treeitem[{label}]"))
                .unwrap()
        );
    }
    key(&mut app, "down");
    see(&mut app, "selected:new");
}

#[test]
fn an_id_given_twice_expands_its_first_item_once() {
    let mut app = start(HarnessProps {
        items: vec![
            TreeItem::new("src", "src"),
            TreeItem::new("x", "first").child(TreeItem::new("x/a", "a")),
            TreeItem::new("x", "second").child(TreeItem::new("x/b", "b")),
        ],
        ..props()
    });
    app.press("role:treeitem[second]").unwrap();
    app.wait_for("role:treeitem[a]").unwrap();
    // Again (later: not a double press): `x` is expanded already, nothing
    // to report (it was pushed again on each press).
    single_press_pause(&mut app);
    app.press("role:treeitem[second]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "selected=x expanded=src,x expand=x");
    see(&mut app, "expanded:src,x");
    assert_eq!(app.screen().count("role:treeitem[b]"), Ok(0));
}

#[test]
fn render_item_draws_each_row_with_its_depth() {
    let mut app = start(HarnessProps {
        custom: true,
        ..props()
    });
    see(&mut app, "▸src@0");
    see(&mut app, "lib.rs@1");
    // The row keeps its label and role for screen readers.
    assert_eq!(app.screen().count("role:treeitem[lib.rs]"), Ok(1));
}

/// The `renderItem` calls of each app (by its `run`): tests run side by
/// side, each app on an engine thread of its own.
static RENDERS: Mutex<Vec<usize>> = Mutex::new(Vec::new());

/// A new run's id, its count at zero.
fn new_run() -> u32 {
    let mut renders = RENDERS.lock().unwrap();
    renders.push(0);
    (renders.len() - 1) as u32
}

fn renders_of(run: u32) -> usize {
    RENDERS.lock().unwrap()[run as usize]
}

#[derive(Clone, PartialEq, Props)]
struct ManyProps {
    folders: usize,
    files: usize,
    /// The ids expanded at first.
    open: Vec<String>,
    /// The tree's height.
    height: f32,
    /// Where its `renderItem` calls count ([`RENDERS`]).
    run: u32,
}

fn sized(folders: usize, files: usize) -> ManyProps {
    ManyProps {
        folders,
        files,
        open: vec!["f0".into()],
        height: 300.0,
        run: new_run(),
    }
}

/// `folders` folders of `files` files each, `open` expanded, rows drawn by
/// a `renderItem` that counts its calls.
#[component]
fn Many(props: ManyProps) -> impl IntoElement {
    let items: Vec<TreeItem> = (0..props.folders)
        .map(|f| {
            TreeItem::new(format!("f{f}"), format!("Folder {f}")).children(
                (0..props.files).map(|i| TreeItem::new(format!("f{f}/{i}"), format!("File {i}"))),
            )
        })
        .collect();
    let selected = signal(SharedString::from("none"));
    let run = props.run as usize;
    view()
        .child(
            tree()
                .items(items)
                .default_expanded(
                    props
                        .open
                        .iter()
                        .map(|id| SharedString::from(id.clone()))
                        .collect::<Vec<_>>(),
                )
                .on_selected_change(move |id: &SharedString| selected.set(id.clone()))
                .render_item(move |e: &TreeEntry| {
                    RENDERS.lock().unwrap()[run] += 1;
                    text(e.label.clone())
                })
                .h(px(props.height)),
        )
        .child(text(move || format!("selected:{}", selected.get())))
}

/// What a step sent: mount items, views made, views deleted, and calls of
/// `renderItem`.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Cost {
    items: usize,
    made: usize,
    deleted: usize,
    renders: usize,
}

/// Measures what the steps given to it cost.
type Measure = Box<dyn Fn(&mut Headless, &dyn Fn(&mut Headless)) -> Cost>;

/// The app of `props` and a function that measures what the steps given
/// to it cost.
fn measured(props: ManyProps) -> (Headless, Measure) {
    let run = props.run;
    let mut app = launch(Root::new::<Many>(move || props.clone()));
    app.wait_for("role:treeitem[Folder 0]").unwrap();
    let counts = Arc::new([const { AtomicUsize::new(0) }; 3]);
    let into = counts.clone();
    app.observe(move |_, batch| {
        into[0].fetch_add(batch.items.len(), Ordering::Relaxed);
        for item in &batch.items {
            match item {
                MountItem::Create { .. } => into[1].fetch_add(1, Ordering::Relaxed),
                MountItem::Delete { .. } => into[2].fetch_add(1, Ordering::Relaxed),
                _ => 0,
            };
        }
    });
    let measure = move |app: &mut Headless, steps: &dyn Fn(&mut Headless)| {
        app.idle(Duration::from_millis(50)).unwrap();
        for c in counts.iter() {
            c.store(0, Ordering::Relaxed);
        }
        let before = renders_of(run);
        steps(app);
        app.idle(Duration::from_millis(50)).unwrap();
        Cost {
            items: counts[0].load(Ordering::Relaxed),
            made: counts[1].load(Ordering::Relaxed),
            deleted: counts[2].load(Ordering::Relaxed),
            renders: renders_of(run) - before,
        }
    };
    (app, Box::new(measure))
}

/// What one Down costs, from `f0/0` to `f0/1`.
fn cost_of_a_key(folders: usize, files: usize) -> Cost {
    let (mut app, measure) = measured(sized(folders, files));
    app.press_key("tab").unwrap();
    app.press_key("down").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("text:selected:f0/0").unwrap();
    measure(&mut app, &|app| {
        app.press_key("down").unwrap();
        app.wait_for("text:selected:f0/1").unwrap();
    })
}

/// What one press costs, selecting `File 3` while `File 1` is.
fn cost_of_a_press(folders: usize, files: usize) -> Cost {
    let (mut app, measure) = measured(sized(folders, files));
    app.press("role:treeitem[File 1]").unwrap();
    app.wait_for("text:selected:f0/1").unwrap();
    measure(&mut app, &|app| {
        app.press("role:treeitem[File 3]").unwrap();
        app.wait_for("text:selected:f0/3").unwrap();
    })
}

/// The most mount items one Down sends: the states of the row left and of the
/// row reached (accessibility and projected), no other row's (measured,
/// for 18 items and for 10 200).
const KEY_ITEMS: usize = 3;

/// The most mount items one press on a row sends, for any number of items
/// (measured, for 18 items and for 10 200).
const PRESS_ITEMS: usize = 8;

#[test]
fn a_key_press_changes_the_row_left_and_the_row_reached_only() {
    let few = cost_of_a_key(3, 5);
    let many = cost_of_a_key(200, 50);
    assert_eq!(
        few, many,
        "the cost of a key press does not grow with the items"
    );
    assert_eq!(
        (few.made, few.deleted),
        (0, 0),
        "a key press makes and deletes no view"
    );
    assert_eq!(few.renders, 0, "a key press calls no `renderItem`");
    assert!(few.items <= KEY_ITEMS, "{} mount items", few.items);
}

#[test]
fn a_press_changes_the_row_left_and_the_row_pressed_only() {
    let few = cost_of_a_press(3, 5);
    let many = cost_of_a_press(200, 50);
    assert_eq!(
        few, many,
        "the cost of a press does not grow with the items"
    );
    assert_eq!(
        (few.made, few.deleted),
        (0, 0),
        "a press on a file makes and deletes no view"
    );
    assert_eq!(few.renders, 0, "a press calls no `renderItem`");
    assert!(few.items <= PRESS_ITEMS, "{} mount items", few.items);
}

/// What expanding `Folder 1` (of `files` files) costs, in a tree tall
/// enough for every row.
fn cost_of_expanding(files: usize) -> Cost {
    let (mut app, measure) = measured(ManyProps {
        open: Vec::new(),
        height: 800.0,
        ..sized(3, files)
    });
    measure(&mut app, &|app| {
        app.press("role:treeitem[Folder 1]").unwrap();
        app.wait_for("role:treeitem[File 0]").unwrap();
    })
}

#[test]
fn expanding_makes_the_rows_of_the_children_only() {
    let three = cost_of_expanding(3);
    let six = cost_of_expanding(6);
    // Each child's row is drawn once; no other row is drawn again.
    assert_eq!((three.renders, six.renders), (3, 6));
    // The views made are the children's rows, as many for each: the
    // folder's row and the others keep theirs.
    assert!(three.made > 0);
    assert_eq!(
        six.made,
        2 * three.made,
        "the views made grow with the children only"
    );
    assert_eq!((three.deleted, six.deleted), (0, 0), "no row is deleted");
}

#[test]
fn a_large_tree_makes_only_the_rows_in_view() {
    let props = sized(200, 50);
    let mut app = launch(Root::new::<Many>(move || props.clone()));
    app.wait_for("role:treeitem[Folder 0]").unwrap();
    // 10 200 items, 249 rows shown (Folder 0's 50 files): only those near
    // the 300-point viewport are made.
    let shown = rows(&app);
    assert!(shown < 60, "{shown} rows made");
    // Collapsing Folder 0 shows the folders, as few.
    app.press("role:treeitem[Folder 0]").unwrap();
    app.wait_for_gone("role:treeitem[File 0]", Duration::from_secs(5))
        .unwrap();
    let after = rows(&app);
    assert!(after < 60, "{after} rows made");
}
