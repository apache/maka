//! `Combobox`: what differs from `Select`, whose list it shares (its keys,
//! search, sections, presentation and accessibility are `select.rs`'s
//! tests). With `multiple` a choice toggles the item and the list stays
//! open; without, it replaces the value and closes; every close confirms
//! the value once; Mod+Return confirms and closes; the query is the app's
//! when it sets one; the footer shows below the rows; the clear button
//! empties the value; screen readers hear the selected titles.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{ComboboxEvent, SelectItem, SelectItemState, combobox};
use nsh_core::{AccessibilityRole, MountItem, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The value at first (`defaultValue` unless `controlled`).
    value: Vec<String>,
    /// The app sets `value`, following `onChange`.
    controlled: bool,
    multiple: bool,
    searchable: bool,
    /// The app sets `query`, following `onQueryChange`.
    controlled_query: bool,
    /// What each opening's query starts with.
    default_query: Option<String>,
    /// A clear button `Clear` while an item is selected.
    cleanable: bool,
}

fn props() -> HarnessProps {
    HarnessProps {
        value: Vec::new(),
        controlled: false,
        multiple: false,
        searchable: false,
        controlled_query: false,
        default_query: None,
        cleanable: false,
    }
}

fn multiple() -> HarnessProps {
    HarnessProps {
        multiple: true,
        ..props()
    }
}

fn tags() -> Vec<SelectItem> {
    vec![
        SelectItem::new("rust", "Rust"),
        SelectItem::new("go", "Go").disabled(true),
        SelectItem::new("ruby", "Ruby"),
        SelectItem::new("swift", "Swift"),
    ]
}

/// A combobox of tags under a 160 × 30 trigger `Pick`, rows drawn as `>`
/// (highlighted), the title and ` ✓` (selected), a footer `Done`; the
/// app's value as `Value: …`, its query as `Query: …`, what it heard as
/// `Log: …`.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(
        props
            .value
            .iter()
            .map(|v| SharedString::from(v.clone()))
            .collect::<Vec<_>>(),
    );
    let query = signal(SharedString::default());
    let log = signal(Vec::<String>::new());
    let push = move |s: String| log.update(|l| l.push(s));
    let join = |v: &[SharedString]| {
        if v.is_empty() {
            "none".to_owned()
        } else {
            v.join(",")
        }
    };
    let controlled = props.controlled;
    let mut el = combobox()
        .items(tags())
        .multiple(props.multiple)
        .searchable(props.searchable)
        .search_placeholder("Search")
        .accessibility_label("Tags")
        .cleanable(props.cleanable)
        .clear_button(text("Clear"))
        .clear_button_accessibility_label("Clear tags")
        .footer(text("Done"))
        .trigger(
            view()
                .test_id("trigger")
                .w(px(160.0))
                .h(px(30.0))
                .child(text("Pick")),
        )
        .render_item(|s: &SelectItemState| {
            text(format!(
                "{}{}{}",
                if s.highlighted { ">" } else { "" },
                s.title,
                if s.selected { " ✓" } else { "" }
            ))
        })
        .on_change(move |v: &Vec<SharedString>| {
            push(format!("change:{}", join(v)));
            if controlled {
                value.set(v.clone());
            }
        })
        .on_confirm(move |v: &Vec<SharedString>| push(format!("confirm:{}", join(v))))
        .on_query_change(move |q: &SharedString| {
            push(format!("query:{q}"));
            query.set(q.clone());
        })
        .on_open_change(move |e: &ComboboxEvent| {
            if let ComboboxEvent::OpenChange(next, reason) = e {
                push(format!("openChange:{next}:{reason:?}"));
            }
        })
        .w(px(200.0));
    if props.controlled {
        el = el.value(move || Some(value.get()));
    } else {
        el = el.default_value(value.get_untracked());
    }
    if props.controlled_query {
        el = el.query(move || Some(query.get()));
    }
    if let Some(q) = props.default_query.clone() {
        el = el.default_query(SharedString::from(q));
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
        .child(text(move || format!("Value: {}", join(&value.get()))))
        .child(text(move || format!("Query: {}", query.get())))
        .child(text(move || format!("Log: {}", log.get().join(" "))))
}

/// The app, and what screen readers last heard as the combobox's value.
struct App(Headless, Arc<Mutex<Option<String>>>);

impl std::ops::Deref for App {
    type Target = Headless;
    fn deref(&self) -> &Headless {
        &self.0
    }
}

impl std::ops::DerefMut for App {
    fn deref_mut(&mut self) -> &mut Headless {
        &mut self.0
    }
}

impl App {
    fn log(&self) -> String {
        self.0
            .screen()
            .texts()
            .into_iter()
            .find_map(|t| t.strip_prefix("Log: ").map(str::to_owned))
            .unwrap_or_default()
    }

    fn see(&mut self, text: &str) {
        self.0.wait_for(&format!("text:{text}")).unwrap();
    }

    fn gone(&mut self, selector: &str) {
        self.0
            .wait_for_gone(selector, Duration::from_secs(5))
            .unwrap();
    }

    fn key(&mut self, keys: &str) {
        self.0.press_key(keys).unwrap();
    }

    fn open_list(&mut self) {
        self.0.press("role:combobox").unwrap();
        self.0.wait_for("role:listbox").unwrap();
    }

    /// Waits until the log ends with `end`.
    fn log_ends(&mut self, end: &str) {
        let end = end.to_owned();
        let found = self.0.wait_until(
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
}

/// On a Mac (a pointer, Tab stops at pressables).
fn start(props: HarnessProps) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    let heard = Arc::new(Mutex::new(None));
    let into = heard.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewProps { props, .. } = item
                && props.accessibility.role == AccessibilityRole::Combobox
            {
                *into.lock().unwrap() = props
                    .accessibility
                    .value
                    .as_ref()
                    .and_then(|v| v.text.as_deref().map(str::to_owned));
            }
        }
    });
    app.first_render().unwrap();
    app.wait_for("text:Pick").unwrap();
    App(app, heard)
}

#[test]
fn with_multiple_a_choice_toggles_the_item_and_the_list_stays_open() {
    for controlled in [false, true] {
        let mut app = start(HarnessProps {
            controlled,
            ..multiple()
        });
        app.open_list();
        app.press("role:option[Rust]").unwrap();
        app.see("Rust ✓");
        app.press("role:option[Swift]").unwrap();
        app.see("Swift ✓");
        assert_eq!(app.screen().count("role:listbox").unwrap(), 1, "still open");
        app.log_ends("change:rust change:rust,swift");
        // Again: out of the value.
        app.press("role:option[Rust]").unwrap();
        app.log_ends("change:swift");
        assert!(!app.shows("Rust ✓"));
        if controlled {
            app.see("Value: swift");
        }
        // Return toggles the highlighted item, and the list stays open.
        app.key("home");
        app.see(">Rust");
        app.key("enter");
        app.see(">Rust ✓");
        app.log_ends("change:swift,rust");
        assert_eq!(app.screen().count("role:listbox").unwrap(), 1);
    }
}

#[test]
fn without_multiple_a_choice_replaces_the_value_and_closes() {
    let mut app = start(HarnessProps {
        value: vec!["rust".into()],
        controlled: true,
        ..props()
    });
    app.open_list();
    app.see(">Rust ✓");
    app.press("role:option[Ruby]").unwrap();
    app.gone("role:listbox");
    app.see("Value: ruby");
    app.log_ends("change:ruby openChange:false:Select confirm:ruby");
    // The selected item again: no change, the list closes.
    app.open_list();
    app.press("role:option[Ruby]").unwrap();
    app.gone("role:listbox");
    assert_eq!(app.log().matches("change:ruby").count(), 1);
}

#[test]
fn every_close_confirms_the_value_once() {
    let mut app = start(multiple());
    // Escape, with a change.
    app.open_list();
    app.press("role:option[Swift]").unwrap();
    app.key("escape");
    app.gone("role:listbox");
    app.log_ends("change:swift openChange:false:Cancel confirm:swift");
    // A press outside, with none.
    app.open_list();
    app.press("id:elsewhere").unwrap();
    app.gone("role:listbox");
    app.log_ends("openChange:false:PressOutside confirm:swift");
    // The trigger.
    app.open_list();
    app.press("role:combobox").unwrap();
    app.gone("role:listbox");
    app.log_ends("openChange:false:TriggerPress confirm:swift");
    assert_eq!(app.log().matches("confirm:").count(), 3);
}

#[test]
fn mod_return_confirms_and_closes() {
    let mut app = start(multiple());
    app.open_list();
    app.press("role:option[Rust]").unwrap();
    app.key("cmd+enter");
    app.gone("role:listbox");
    app.log_ends("change:rust openChange:false:Select confirm:rust");
}

#[test]
fn the_query_is_the_apps_when_it_sets_one() {
    let mut app = start(HarnessProps {
        searchable: true,
        controlled_query: true,
        ..multiple()
    });
    app.open_list();
    app.type_text("text:Search", "ru").unwrap();
    app.see("Query: ru");
    app.log_ends("query:r query:ru");
    // The app's query filters the rows.
    app.wait_for("role:option[Ruby]").unwrap();
    assert_eq!(app.screen().count("role:option").unwrap(), 2);
}

#[test]
fn each_opening_starts_from_the_default_query() {
    let mut app = start(HarnessProps {
        searchable: true,
        default_query: Some("sw".into()),
        ..multiple()
    });
    app.open_list();
    app.see("Swift");
    assert!(!app.shows("Rust"));
    app.type_text("text:sw", "x").unwrap();
    app.gone("role:option[Swift]");
    app.key("escape");
    app.gone("role:listbox");
    app.open_list();
    app.see("Swift");
    assert!(!app.shows("Rust"));
}

#[test]
fn the_footer_shows_below_the_rows() {
    let mut app = start(multiple());
    assert!(!app.shows("Done"));
    app.open_list();
    app.see("Done");
}

#[test]
fn the_clear_button_empties_the_value() {
    let mut app = start(HarnessProps {
        value: vec!["rust".into(), "swift".into()],
        controlled: true,
        cleanable: true,
        ..multiple()
    });
    app.see("Clear");
    app.press("text:Clear").unwrap();
    app.log_ends("change:none");
    app.see("Value: none");
    app.gone("text:Clear");
    assert_eq!(app.screen().count("role:listbox").unwrap(), 0);
}

#[test]
fn screen_readers_hear_the_selected_titles() {
    let mut app = start(HarnessProps {
        value: vec!["rust".into(), "swift".into()],
        ..multiple()
    });
    assert_eq!(app.1.lock().unwrap().as_deref(), Some("Rust, Swift"));
    app.open_list();
    assert!(app.screen().selected("role:option[Rust]").unwrap());
    assert!(!app.screen().selected("role:option[Ruby]").unwrap());
}
