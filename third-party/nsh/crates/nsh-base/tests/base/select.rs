//! `Select`: the trigger opens the list (presses, and its keys while it has
//! the keyboard focus), the keys move the highlight and choose, typeahead
//! and search find items, Escape, back and presses outside close it and
//! give the trigger the keyboard back, the highlighted row is revealed once
//! per move, screen readers hear the combobox, the listbox and its options,
//! and the value and the open state are the app's when it sets them.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{SelectEvent, SelectItem, SelectItemState, select};
use nsh_core::{
    AccessibilityRole, Bounds, Command, MountItem, NodeId, Size, ViewProps,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The items.
    items: Vec<SelectItem>,
    /// The app's value at first (`defaultValue` unless `controlled`).
    value: Option<String>,
    /// The app sets `value`.
    controlled: bool,
    /// The app sets `open`.
    controlled_open: bool,
    /// The app follows `onChange` and `onOpenChange` (when it controls).
    follow: bool,
    searchable: bool,
    disabled: bool,
    /// Open at first (`defaultOpen`).
    default_open: bool,
    /// A clear button `Clear` (labelled `Clear food`) while an item is
    /// chosen.
    cleanable: bool,
}

fn fruits() -> Vec<SelectItem> {
    vec![
        SelectItem::new("apple", "Apple").group("Fruits"),
        SelectItem::new("banana", "Banana")
            .group("Fruits")
            .disabled(true),
        SelectItem::new("blueberry", "Blueberry").group("Fruits"),
        SelectItem::new("carrot", "Carrot").group("Vegetables"),
        SelectItem::new("celery", "Celery").group("Vegetables"),
        SelectItem::new("rice", "Rice"),
    ]
}

fn many(n: usize) -> Vec<SelectItem> {
    (0..n)
        .map(|i| SelectItem::new(format!("item{i}"), format!("Item {i}")))
        .collect()
}

fn props(items: Vec<SelectItem>) -> HarnessProps {
    HarnessProps {
        items,
        value: None,
        controlled: false,
        controlled_open: false,
        follow: true,
        searchable: false,
        disabled: false,
        default_open: false,
        cleanable: false,
    }
}

/// A select of `props`' items under a 160 × 30 trigger, rows drawn as
/// `>` (highlighted), the title and ` ✓` (chosen); what the app heard as
/// `Log: …`, its value as `Value: …`; F5 replaces the items with Celery and
/// Kiwi.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(props.value.clone().map(SharedString::from));
    let open = signal(false);
    let log = signal(Vec::<String>::new());
    let push = move |s: String| log.update(|l| l.push(s));
    let items = signal(props.items.clone());
    on_key("f5", move |_| {
        items.set(vec![
            SelectItem::new("kiwi", "Kiwi"),
            SelectItem::new("celery", "Celery"),
        ])
    });
    let follow = props.follow;
    let mut el = select()
        .items(items)
        .searchable(props.searchable)
        .disabled(props.disabled)
        .default_open(props.default_open)
        .search_placeholder("Search")
        .accessibility_label("Food")
        .trigger(
            view()
                .test_id("trigger")
                .w(px(160.0))
                .h(px(30.0))
                .child(text("Pick")),
        )
        .empty(text("No match"))
        .cleanable(props.cleanable)
        .clear_button(text("Clear"))
        .clear_button_accessibility_label("Clear food")
        .render_item(|s: &SelectItemState| {
            text(format!(
                "{}{}{}",
                if s.highlighted { ">" } else { "" },
                s.title,
                if s.selected { " ✓" } else { "" }
            ))
        })
        .on_change(move |v: &Option<SharedString>| {
            push(format!("change:{}", v.as_deref().unwrap_or("none")));
            if follow {
                value.set(v.clone());
            }
        })
        .on_open_change(move |e: &SelectEvent| {
            if let SelectEvent::OpenChange(next, reason) = e {
                push(format!("openChange:{next}:{reason:?}"));
                if follow {
                    open.set(*next);
                }
            }
        })
        .on_open(move || push("open".into()))
        .on_close(move || push("close".into()))
        .on_cancel(move || push("cancel".into()))
        .w(px(200.0));
    if props.controlled {
        el = el.value(move || value.get());
    } else if let Some(v) = props.value.clone() {
        el = el.default_value(SharedString::from(v));
    }
    if props.controlled_open {
        el = el.open(move || Some(open.get()));
    }
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(el)
        .child(
            view()
                .test_id("elsewhere")
                .w(px(40.0))
                .h(px(40.0))
                .on_press(|| {}),
        )
        .child(text(move || {
            format!("Value: {}", value.get().as_deref().unwrap_or("none"))
        }))
        .child(text(move || format!("Log: {}", log.get().join(" "))))
}

/// What the views' accessibility and frames are, as mounted.
#[derive(Default)]
struct Seen {
    props: HashMap<NodeId, ViewProps>,
    frames: HashMap<NodeId, Bounds<Points>>,
    parents: HashMap<NodeId, NodeId>,
    /// The views inserted into the root view, in order.
    roots: Vec<NodeId>,
}

struct App {
    app: Headless,
    seen: Arc<Mutex<Seen>>,
}

impl std::ops::Deref for App {
    type Target = Headless;
    fn deref(&self) -> &Headless {
        &self.app
    }
}

impl std::ops::DerefMut for App {
    fn deref_mut(&mut self) -> &mut Headless {
        &mut self.app
    }
}

impl App {
    fn log(&self) -> String {
        self.app
            .screen()
            .texts()
            .into_iter()
            .find_map(|t| t.strip_prefix("Log: ").map(str::to_owned))
            .unwrap_or_default()
    }

    /// The highlighted row's title, if one shows.
    fn highlighted(&self) -> Option<String> {
        self.app.screen().texts().into_iter().find_map(|t| {
            t.strip_prefix('>')
                .map(|t| t.trim_end_matches(" ✓").to_owned())
        })
    }

    fn see(&mut self, text: &str) {
        self.app.wait_for(&format!("text:{text}")).unwrap();
    }

    fn gone(&mut self, selector: &str) {
        self.app
            .wait_for_gone(selector, Duration::from_secs(5))
            .unwrap();
    }

    fn key(&mut self, keys: &str) {
        self.app.press_key(keys).unwrap();
    }

    /// The view `selector` names that takes presses.
    fn id(&self, selector: &str) -> NodeId {
        self.app
            .screen()
            .press_target(selector)
            .unwrap()
            .unwrap_or_else(|| panic!("no `{selector}`"))
    }

    /// The view of role `role` mounted last.
    fn role_id(&self, role: AccessibilityRole) -> NodeId {
        let seen = self.seen.lock().unwrap();
        seen.props
            .iter()
            .filter(|(_, p)| p.accessibility.role == role)
            .map(|(id, _)| *id)
            .max()
            .unwrap_or_else(|| panic!("no {role:?}"))
    }

    fn trigger(&self) -> ViewProps {
        let id = self.role_id(AccessibilityRole::Combobox);
        self.seen.lock().unwrap().props[&id].clone()
    }

    /// Waits until the log ends with `end`.
    fn log_ends(&mut self, end: &str) {
        let end = end.to_owned();
        let found = self.app.wait_until(
            &format!("the log ending with `{end}`"),
            Duration::from_secs(5),
            |s| {
                s.texts()
                    .iter()
                    .any(|t| t.starts_with("Log: ") && t.ends_with(end.as_str()))
            },
        );
        if let Err(e) = found {
            panic!("{e}; the log: {}", self.log());
        }
    }

    fn sent(&self, to: NodeId, command: &Command) -> bool {
        self.app
            .screen()
            .commands()
            .iter()
            .any(|(id, c)| *id == to && c == command)
    }

    fn scrolls(&self) -> usize {
        self.app
            .screen()
            .commands()
            .iter()
            .filter(|(_, c)| matches!(c, Command::ScrollTo { .. }))
            .count()
    }

    fn open_list(&mut self) {
        self.app.press("role:combobox").unwrap();
        self.app.wait_for("role:listbox").unwrap();
    }
}

fn start_on(props: HarnessProps, os: Os, idiom: Idiom, screen_reader: bool) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = os;
    config.environment.idiom = idiom;
    config.environment.screen_reader = screen_reader;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props } => {
                    seen.props.insert(*id, (**props).clone());
                }
                MountItem::AccessibilityLabel { id, label } => {
                    if let Some(p) = seen.props.get_mut(id) {
                        p.accessibility.label = label.clone();
                    }
                }
                MountItem::Frame { id, frame } => {
                    seen.frames.insert(*id, *frame);
                }
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                    if *parent == 1 {
                        seen.roots.push(*child);
                    }
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    app.wait_for("text:Pick").unwrap();
    App { app, seen }
}

/// On a Mac: Tab stops at pressables, a pointer hovers.
fn desktop(props: HarnessProps) -> App {
    start_on(props, Os::MacOs, Idiom::Desktop, false)
}

/// On a Mac, the trigger given the keyboard focus (Tab).
fn focused(props: HarnessProps) -> App {
    let mut app = desktop(props);
    app.key("tab");
    app
}

#[test]
fn the_clear_button_clears_the_value_and_leaves_the_list_closed() {
    for controlled in [true, false] {
        let mut p = props(fruits());
        p.value = Some("apple".into());
        p.controlled = controlled;
        p.cleanable = true;
        let mut app = desktop(p);
        // While an item is chosen: a button screen readers name.
        let clear = app.id("text:Clear");
        let props = app.seen.lock().unwrap().props[&clear].clone();
        assert_eq!(props.accessibility.role, AccessibilityRole::Button);
        assert_eq!(props.accessibility.label.as_deref(), Some("Clear food"));
        app.press("text:Clear").unwrap();
        app.log_ends("change:none");
        app.gone("text:Clear");
        assert_eq!(
            app.screen().count("role:listbox").unwrap(),
            0,
            "the list stays closed"
        );
        if controlled {
            app.see("Value: none");
        }
        // Choosing again brings it back.
        app.open_list();
        app.press("text:Rice").unwrap();
        app.see("Clear");
    }
}

#[test]
fn without_cleanable_or_a_value_there_is_no_clear_button() {
    let mut p = props(fruits());
    p.value = Some("apple".into());
    let app = desktop(p);
    assert!(!app.shows("Clear"));
    let mut p = props(fruits());
    p.cleanable = true;
    let app = desktop(p);
    assert!(!app.shows("Clear"));
}

// 1. Opening.

#[test]
fn a_press_toggles_the_list() {
    let mut app = desktop(props(fruits()));
    assert!(!app.shows("Apple"));
    app.open_list();
    app.see("Apple");
    app.log_ends("openChange:true:TriggerPress open");
    app.press("role:combobox").unwrap();
    app.gone("role:listbox");
    app.log_ends("openChange:false:TriggerPress close");
}

#[test]
fn default_open_shows_the_list_at_first() {
    let open = HarnessProps {
        default_open: true,
        ..props(fruits())
    };
    let mut app = desktop(open.clone());
    app.see("Apple");
    app.log_ends("open");
    let mut app = start_on(open, Os::Ios, Idiom::Phone, false);
    app.see("Apple");
    app.wait_for("role:option[Rice]").unwrap();
    app.log_ends("open");
}

#[test]
fn down_up_return_and_space_open_it_from_the_focused_trigger() {
    for key in ["down", "up", "enter", "space"] {
        let mut app = focused(props(fruits()));
        app.key(key);
        app.wait_for("role:listbox").unwrap();
        assert!(
            app.log().contains("openChange:true:TriggerPress"),
            "{key}: {}",
            app.log()
        );
    }
}

#[test]
fn a_disabled_select_neither_opens_nor_takes_the_focus() {
    let mut app = desktop(HarnessProps {
        disabled: true,
        ..props(fruits())
    });
    assert!(app.press("role:combobox").is_err());
    assert!(!app.screen().enabled("role:combobox").unwrap());
    let trigger = app.trigger();
    assert!(trigger.accessibility.state.disabled);
    // Tab passes over it to the next stop.
    app.key("tab");
    app.key("down");
    app.wait(Duration::from_millis(100)).unwrap();
    assert!(!app.shows("Apple"));
    assert_eq!(app.log(), "");
}

// 2. What opening highlights.

#[test]
fn opening_highlights_the_chosen_item_else_as_the_key_says() {
    // Nothing chosen: Down the first enabled item, Up the last, a press
    // nothing.
    let mut app = focused(props(fruits()));
    app.key("down");
    app.see(">Apple");
    let mut app = focused(props(fruits()));
    app.key("up");
    app.see(">Rice");
    let mut app = desktop(props(fruits()));
    app.open_list();
    app.see("Apple");
    assert_eq!(app.highlighted(), None);
    // A key moves it from nothing.
    app.key("down");
    app.see(">Apple");
    // The chosen item, however it opens.
    let mut app = desktop(HarnessProps {
        value: Some("celery".into()),
        ..props(fruits())
    });
    app.open_list();
    app.see(">Celery ✓");
}

// 3. Keys while open.

#[test]
fn arrows_skip_disabled_items_and_wrap_around_the_ends() {
    let mut app = focused(props(fruits()));
    app.key("down");
    app.see(">Apple");
    // Banana is disabled.
    app.key("down");
    app.see(">Blueberry");
    app.key("up");
    app.see(">Apple");
    app.key("up");
    app.see(">Rice");
    app.key("down");
    app.see(">Apple");
    app.key("end");
    app.see(">Rice");
    app.key("home");
    app.see(">Apple");
    app.key("pagedown");
    app.see(">Rice");
    app.key("pageup");
    app.see(">Apple");
}

#[test]
fn return_and_space_choose_the_highlighted_item_and_close() {
    let mut app = focused(props(fruits()));
    app.key("down");
    app.key("down");
    app.see(">Blueberry");
    app.key("enter");
    app.gone("role:listbox");
    app.see("Value: blueberry");
    app.log_ends("change:blueberry openChange:false:Select close");
    // Space too; the chosen item again closes without a change.
    app.key("down");
    app.see(">Blueberry ✓");
    app.key("space");
    app.gone("role:listbox");
    app.log_ends("openChange:true:TriggerPress open openChange:false:Select close");
    assert_eq!(app.log().matches("change:blueberry").count(), 1);
}

#[test]
fn a_disabled_item_is_not_chosen() {
    let mut app = desktop(props(fruits()));
    app.open_list();
    assert!(!app.screen().enabled("role:option[Banana]").unwrap());
    assert!(app.press("role:option[Banana]").is_err());
    assert!(app.shows("Banana"));
    assert!(!app.log().contains("change:"));
}

// 4. Closing.

#[test]
fn escape_cancels_and_gives_the_trigger_the_keyboard_back() {
    let mut app = focused(props(fruits()));
    let trigger = app.id("role:combobox");
    app.key("down");
    app.see(">Apple");
    app.key("escape");
    app.gone("role:listbox");
    app.log_ends("cancel openChange:false:Cancel close");
    assert!(app.sent(trigger, &Command::Focus));
}

#[test]
fn choosing_gives_the_trigger_the_keyboard_back() {
    let mut app = desktop(props(fruits()));
    let trigger = app.id("role:combobox");
    app.open_list();
    app.press("role:option[Carrot]").unwrap();
    app.gone("role:listbox");
    assert!(app.sent(trigger, &Command::Focus));
}

#[test]
fn a_press_outside_closes_it_and_leaves_the_focus() {
    let mut app = desktop(props(fruits()));
    let trigger = app.id("role:combobox");
    app.open_list();
    app.press("id:elsewhere").unwrap();
    app.gone("role:listbox");
    app.log_ends("cancel openChange:false:PressOutside close");
    assert!(!app.sent(trigger, &Command::Focus));
}

#[test]
fn on_touch_screens_a_sheet_closes_on_its_backdrop_and_back() {
    let mut app = start_on(props(fruits()), Os::Ios, Idiom::Phone, false);
    let before = app.seen.lock().unwrap().roots.len();
    app.open_list();
    app.wait(Duration::from_millis(400)).unwrap();
    app.see("Apple");
    app.log_ends("openChange:true:TriggerPress open");
    // The backdrop, then the sheet, over the root view.
    let backdrop = app.seen.lock().unwrap().roots[before];
    app.press(&format!("view:{backdrop}")).unwrap();
    app.gone("role:listbox");
    app.log_ends("cancel openChange:false:BackdropPress close");
    // The back button.
    app.open_list();
    app.wait(Duration::from_millis(400)).unwrap();
    app.back().unwrap();
    app.gone("role:listbox");
    app.log_ends("cancel openChange:false:Cancel close");
    // A press chooses (no press-down on touch screens).
    app.open_list();
    app.wait(Duration::from_millis(400)).unwrap();
    app.press("role:option[Rice]").unwrap();
    app.gone("role:listbox");
    app.log_ends("change:rice openChange:false:Select close");
}

// 5. The pointer.

#[test]
fn the_pointer_highlights_only_when_it_moves_and_a_press_chooses() {
    let mut app = desktop(props(fruits()));
    app.open_list();
    app.hover("role:option[Celery]").unwrap();
    app.see(">Celery");
    // A key moves on; the pointer, still where it was, keeps nothing.
    app.key("down");
    app.see(">Rice");
    app.hover("role:option[Celery]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(app.highlighted().as_deref(), Some("Rice"));
    // Over a disabled item: nothing.
    app.hover("role:option[Banana]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(app.highlighted().as_deref(), Some("Rice"));
    app.press("role:option[Carrot]").unwrap();
    app.gone("role:listbox");
    app.see("Value: carrot");
}

// 6. Search.

#[test]
fn search_filters_the_items_and_their_sections() {
    let mut app = desktop(HarnessProps {
        searchable: true,
        ..props(fruits())
    });
    app.open_list();
    app.type_text("Search", "ER").unwrap();
    // Case-insensitive; sections keep their matches; the first match is
    // highlighted.
    app.see(">Blueberry");
    app.see("Celery");
    app.see("Fruits");
    app.see("Vegetables");
    assert!(!app.shows("Apple"));
    assert!(!app.shows("Rice"));
    // The keys move in the matches while the field edits.
    app.key("down");
    app.see(">Celery");
    app.type_text("text:ER", "zz").unwrap();
    app.see("No match");
    assert!(!app.shows("Fruits"));
    // Escape closes; the next opening starts with every item again.
    app.key("escape");
    app.gone("role:listbox");
    app.open_list();
    app.see("Apple");
    app.see("Rice");
    assert!(!app.shows("No match"));
    app.type_text("Search", "ric").unwrap();
    app.see(">Rice");
    app.key("enter");
    app.gone("role:listbox");
    app.see("Value: rice");
}

// 7. Typeahead.

#[test]
fn typeahead_jumps_to_the_next_title_starting_with_what_was_typed() {
    let mut app = focused(props(fruits()));
    app.key("down");
    app.see(">Apple");
    app.key("c");
    app.see(">Carrot");
    app.key("c");
    app.see(">Celery");
    // Typed on, `ccr` matches nothing: the highlight stays.
    app.key("r");
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(app.highlighted().as_deref(), Some("Celery"));
    // A pause starts again; Banana is disabled.
    app.wait(Duration::from_millis(1100)).unwrap();
    app.key("b");
    app.see(">Blueberry");
    app.wait(Duration::from_millis(1100)).unwrap();
    app.key("r");
    app.see(">Rice");
}

#[test]
fn typeahead_on_the_closed_trigger_chooses() {
    let mut app = focused(props(fruits()));
    app.key("c");
    app.wait_until("carrot chosen", Duration::from_secs(5), |s| {
        s.shows("Value: carrot")
    })
    .unwrap();
    assert!(!app.shows("Apple"), "it stays closed");
    app.key("c");
    app.see("Value: celery");
    assert_eq!(app.log(), "change:carrot change:celery");
}

// 8. Revealing the highlighted row.

#[test]
fn the_highlighted_row_is_revealed_once_when_it_is_not_in_view() {
    let mut app = focused(props(many(200)));
    app.key("down");
    app.see(">Item 0");
    let before = app.scrolls();
    app.key("end");
    app.see(">Item 199");
    let after = app.scrolls();
    assert!(after > before, "End scrolled to the last row");
    // Up stays in view: no scroll.
    app.key("up");
    app.see(">Item 198");
    assert_eq!(app.scrolls(), after);
    app.key("home");
    app.see(">Item 0");
    assert!(app.scrolls() > after);
    // A page is the rows in view.
    app.key("pagedown");
    let page: usize = app
        .highlighted()
        .and_then(|t| t.strip_prefix("Item ")?.parse().ok())
        .unwrap();
    assert!(page > 5 && page < 100, "a page of {page}");
}

#[test]
fn opening_reveals_the_chosen_item() {
    let mut app = desktop(HarnessProps {
        value: Some("item150".into()),
        ..props(many(200))
    });
    app.open_list();
    app.see(">Item 150 ✓");
}

#[test]
fn a_long_list_makes_only_the_rows_in_view() {
    let mut app = desktop(props(many(5000)));
    app.open_list();
    app.see("Item 0");
    let rows = app.screen().count("role:option").unwrap();
    assert!(rows > 5 && rows < 300, "{rows} rows made");
}

// 9. Presentation.

#[test]
fn on_the_desktops_the_popup_is_at_the_trigger_as_wide_and_within_the_window() {
    let mut app = desktop(props(many(200)));
    app.open_list();
    app.see("Item 0");
    app.wait(Duration::from_millis(100)).unwrap();
    let list = app.role_id(AccessibilityRole::Listbox);
    let trigger = app.role_id(AccessibilityRole::Combobox);
    let seen = app.seen.lock().unwrap();
    let popup = seen.parents[&list];
    assert!(seen.roots.contains(&popup), "an overlay of the root view");
    let frame = seen.frames[&popup];
    // Below the trigger (its 160 × 30 view at 40, 100), at its start.
    assert_eq!(frame.origin.x, px(40.0));
    assert_eq!(frame.origin.y, px(130.0));
    // As wide as the trigger: filled from Rust, the combobox is the view
    // the select makes around the app's element, which its column
    // stretches to the select's 200 (a TSX trigger is the app's element
    // itself: the engine's `a_base_select_on_a_desktop_…`). Its rows have
    // no width of their own.
    assert_eq!(seen.frames[&trigger].size.width, px(200.0));
    assert_eq!(frame.size.width, px(200.0), "{frame:?}");
    // Never past the window: its rows scroll.
    assert!(frame.origin.y + frame.size.height <= px(844.0), "{frame:?}");
}

// 10. Accessibility.

#[test]
fn screen_readers_hear_a_combobox_a_listbox_and_its_options() {
    let mut app = desktop(HarnessProps {
        value: Some("carrot".into()),
        ..props(fruits())
    });
    let trigger = app.trigger();
    assert_eq!(trigger.accessibility.role, AccessibilityRole::Combobox);
    assert_eq!(trigger.accessibility.label.as_deref(), Some("Food"));
    assert_eq!(trigger.accessibility.state.expanded, Some(false));
    assert_eq!(
        trigger
            .accessibility
            .value
            .as_ref()
            .and_then(|v| v.text.as_deref()),
        Some("Carrot")
    );
    app.open_list();
    app.see(">Carrot ✓");
    assert_eq!(app.trigger().accessibility.state.expanded, Some(true));
    assert!(app.screen().matches("role:listbox").unwrap());
    assert!(app.screen().selected("role:option[Carrot]").unwrap());
    assert!(!app.screen().selected("role:option[Apple]").unwrap());
    assert!(!app.screen().enabled("role:option[Banana]").unwrap());
    let header = app.screen().count("role:header").unwrap();
    assert_eq!(header, 2);
}

#[test]
fn a_keys_highlight_takes_the_screen_readers_focus() {
    let mut app = start_on(props(fruits()), Os::MacOs, Idiom::Desktop, true);
    app.key("tab");
    app.key("down");
    app.see(">Apple");
    app.key("down");
    app.see(">Blueberry");
    let row = app.id("role:option[Blueberry]");
    app.wait_until("the focus", Duration::from_secs(5), |s| {
        s.commands()
            .iter()
            .any(|(id, c)| *id == row && *c == Command::AccessibilityFocus)
    })
    .unwrap();
}

#[test]
fn while_searching_the_highlight_is_announced() {
    let mut app = start_on(
        HarnessProps {
            searchable: true,
            ..props(fruits())
        },
        Os::MacOs,
        Idiom::Desktop,
        true,
    );
    app.open_list();
    app.type_text("Search", "cel").unwrap();
    app.see(">Celery");
    app.wait_until("the announcement", Duration::from_secs(5), |s| {
        s.commands()
            .iter()
            .any(|(_, c)| matches!(c, Command::Announce(m) if m == "Celery"))
    })
    .unwrap();
    // The search field keeps the focus: no row takes it.
    assert!(
        !app.screen()
            .commands()
            .iter()
            .any(|(_, c)| *c == Command::AccessibilityFocus)
    );
}

// 11. Controlled and not.

#[test]
fn a_controlled_value_is_the_apps() {
    // The app does not follow: the choice is reported, the value stays.
    let mut app = focused(HarnessProps {
        controlled: true,
        follow: false,
        value: Some("rice".into()),
        ..props(fruits())
    });
    app.key("down");
    app.see(">Rice ✓");
    app.key("home");
    app.key("enter");
    app.gone("role:listbox");
    app.log_ends("change:apple openChange:false:Select close");
    app.see("Value: rice");
    app.key("down");
    app.see(">Rice ✓");
    // `null`: nothing is chosen.
    let mut app = desktop(HarnessProps {
        controlled: true,
        value: None,
        ..props(fruits())
    });
    assert!(app.trigger().accessibility.value.is_none());
    app.open_list();
    app.see("Apple");
    assert!(!app.screen().texts().iter().any(|t| t.ends_with('✓')));
}

#[test]
fn an_uncontrolled_value_starts_at_the_default_and_follows_choices() {
    let mut app = desktop(HarnessProps {
        controlled: false,
        follow: false,
        value: Some("apple".into()),
        ..props(fruits())
    });
    app.open_list();
    app.see(">Apple ✓");
    app.press("role:option[Rice]").unwrap();
    app.gone("role:listbox");
    app.open_list();
    app.see(">Rice ✓");
}

#[test]
fn a_controlled_open_state_is_the_apps() {
    // The app does not follow: the request is reported, it stays closed.
    let mut app = desktop(HarnessProps {
        controlled_open: true,
        follow: false,
        ..props(fruits())
    });
    app.press("role:combobox").unwrap();
    app.log_ends("openChange:true:TriggerPress");
    app.wait(Duration::from_millis(100)).unwrap();
    assert!(!app.shows("Apple"));
    assert_eq!(app.log(), "openChange:true:TriggerPress");
    // It follows: open, and closed by a choice.
    let mut app = desktop(HarnessProps {
        controlled_open: true,
        ..props(fruits())
    });
    app.open_list();
    app.press("role:option[Apple]").unwrap();
    app.gone("role:listbox");
    app.log_ends("change:apple openChange:false:Select close");
}

// 12. Items replaced while open.

#[test]
fn the_highlight_follows_its_item_when_the_items_change() {
    let mut app = focused(props(fruits()));
    app.key("down");
    app.key("c");
    app.key("c");
    app.see(">Celery");
    // Celery is second now: still highlighted.
    app.key("f5");
    app.see("Kiwi");
    app.see(">Celery");
    // Gone: the first enabled item.
    let mut app = focused(props(fruits()));
    app.key("down");
    app.see(">Apple");
    app.key("f5");
    app.see(">Kiwi");
}
