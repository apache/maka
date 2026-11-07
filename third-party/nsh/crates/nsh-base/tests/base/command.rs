//! `Command`: a list box of options for screen readers (checked and
//! disabled ones say so) under the app's header, search field and above
//! its footer; typing filters the items by label and keywords, sections
//! with no match go and `empty` shows when nothing matches (not while
//! `loading`); Up and Down move the highlight past disabled items and
//! around the ends, Return and a press choose, the pointer highlights,
//! Escape clears the query and then cancels; the query is the app's when
//! it sets one, and `filterable={false}` leaves every item; without a
//! search field the command is one stop with typeahead; the ref focuses,
//! highlights and counts; and a key press costs the two rows it concerns,
//! however many items there are, while a query makes only the rows in
//! view. On macOS, where Tab stops at pressables.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{CommandApi, CommandEntry, CommandItem, button, command};
use nsh_core::{Checked, Color, MountItem, NodeId, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// Two ungrouped files with shortcuts; Suggestions (Calendar, a disabled
/// Search Emoji, Calculator); Settings (Profile, found by `account`, and a
/// checked Dark Theme).
fn commands() -> Vec<CommandItem> {
    vec![
        CommandItem::new("new", "New File").shortcut("mod+n"),
        CommandItem::new("open", "Open File").shortcut("mod+shift+o"),
        CommandItem::new("calendar", "Calendar").group("Suggestions"),
        CommandItem::new("emoji", "Search Emoji")
            .group("Suggestions")
            .disabled(true),
        CommandItem::new("calculator", "Calculator").group("Suggestions"),
        CommandItem::new("profile", "Profile")
            .group("Settings")
            .keywords(["account"]),
        CommandItem::new("dark", "Dark Theme")
            .group("Settings")
            .checked(true),
    ]
}

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    items: Vec<CommandItem>,
    searchable: bool,
    filterable: bool,
    loading: bool,
    /// The app sets `query`.
    controlled: bool,
    /// The app follows `onQueryChange` (when it controls).
    follow: bool,
    /// A `renderItem` drawing `label|shortcut`.
    custom: bool,
    /// The search field labelled `Search commands` apart from the list.
    search_label: bool,
}

fn props() -> HarnessProps {
    HarnessProps {
        items: commands(),
        searchable: true,
        filterable: true,
        loading: false,
        controlled: false,
        follow: true,
        custom: false,
        search_label: false,
    }
}

/// A button `Before`, the command (header `Header`, a search field
/// `Type a command`, footer `Footer`, `No results` while nothing matches)
/// in a 300 × 400 box, a button `After`; what the app heard as `log:…`
/// and the highlighted id as `highlighted:…`. F5 highlights `profile`, F6
/// `emoji` (disabled), F7 focuses the command, F8 logs its matched count.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let log = signal(Vec::<String>::new());
    let highlighted = signal(SharedString::from("none"));
    let query = signal(SharedString::default());
    let pressed = signal("none");
    let push = move |s: String| log.update(|l| l.push(s));
    let r = component_ref::<nsh_base::Command>();
    let api = move |f: &dyn Fn(&CommandApi)| {
        if let Some(api) = r.api::<CommandApi>() {
            f(&api);
        }
    };
    on_key("f5", move |_| api(&|a| a.highlight("profile".into())));
    on_key("f6", move |_| api(&|a| a.highlight("emoji".into())));
    on_key("f7", move |_| api(&|a| a.focus()));
    on_key("f8", move |_| {
        api(&|a| push(format!("count={}", a.matched_count())));
    });
    let follow = props.follow;
    let mut el = command()
        .items(props.items.clone())
        .searchable(props.searchable)
        .filterable(props.filterable)
        .loading(props.loading)
        .placeholder("Type a command")
        .accessibility_label("Commands")
        .header(text("Header"))
        .footer(text("Footer"))
        .empty(text("No results"))
        .on_select(move |id: &SharedString| push(format!("select={id}")))
        .on_cancel(move || push("cancel".into()))
        .on_highlight_change(move |id: &Option<SharedString>| {
            highlighted.set(id.clone().unwrap_or_else(|| "none".into()));
        })
        .on_query_change(move |q: &SharedString| {
            push(format!("query={q}"));
            if follow {
                query.set(q.clone());
            }
        })
        .component_ref(&r)
        .w(px(300.0))
        .h(px(400.0));
    if props.controlled {
        el = el.query(move || Some(query.get()));
    }
    if props.search_label {
        el = el.search_accessibility_label("Search commands");
    }
    if props.custom {
        el = el.render_item(|e: &CommandEntry| {
            text(format!(
                "{}|{}",
                e.label,
                e.shortcut_label.as_deref().unwrap_or("")
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
        .child(text(move || format!("highlighted:{}", highlighted.get())))
}

fn launch(root: Root) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

fn start(props: HarnessProps) -> Headless {
    let mut app = launch(Root::new::<Harness>(move || props.clone()));
    app.wait_for("role:option").unwrap();
    app
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

/// Waits until the log ends with `end`.
fn log_ends(app: &mut Headless, end: &str) {
    let end = end.to_owned();
    let found = app.wait_until(
        &format!("the log ending with `{end}`"),
        Duration::from_secs(5),
        |s| {
            s.texts()
                .iter()
                .any(|t| t.starts_with("log:") && t.ends_with(end.as_str()))
        },
    );
    if let Err(e) = found {
        panic!("{e}; the log: {}", log(app));
    }
}

fn options(app: &Headless) -> usize {
    app.screen().count("role:option").unwrap()
}

/// Types `text` in the search field (which takes the focus).
fn type_in(app: &mut Headless, text: &str) {
    app.type_text("text:Type a command", text).unwrap();
}

#[test]
fn screen_readers_hear_a_list_box_of_options_with_their_states() {
    let mut app = start(props());
    see(&mut app, "Header");
    see(&mut app, "Footer");
    let screen = app.screen();
    assert_eq!(screen.count("role:listbox[Commands]"), Ok(1));
    assert_eq!(screen.count("role:option"), Ok(7));
    assert_eq!(screen.count("role:header"), Ok(2));
    assert!(!screen.enabled("role:option[Search Emoji]").unwrap());
    assert!(screen.enabled("role:option[Calendar]").unwrap());
    let state = |label: &str| {
        screen
            .accessibility_state(&format!("role:option[{label}]"))
            .unwrap()
    };
    assert_eq!(state("Dark Theme").checked, Some(Checked::True));
    assert_eq!(state("Profile").checked, None);
    assert!(!screen.shows("No results"));
}

#[test]
fn screen_readers_hear_the_search_field_by_its_own_label_else_the_commands() {
    // Without its own, the search field is named as the list is.
    let app = start(props());
    assert_eq!(app.screen().count("label:Commands"), Ok(2));
    assert_eq!(app.screen().count("label:Search commands"), Ok(0));
    // With it, the field has the app's words and the list keeps its name.
    let mut app = start(HarnessProps {
        search_label: true,
        ..props()
    });
    assert_eq!(app.screen().count("role:listbox[Commands]"), Ok(1));
    assert_eq!(app.screen().count("label:Commands"), Ok(1));
    app.type_text("label:Search commands", "cal").unwrap();
    app.wait_for_gone("role:option[New File]", Duration::from_secs(5))
        .unwrap();
    assert_eq!(app.screen().count("role:option"), Ok(2));
}

#[test]
fn the_first_enabled_item_is_highlighted_at_first() {
    let mut app = start(HarnessProps {
        items: vec![
            CommandItem::new("off", "Off").disabled(true),
            CommandItem::new("on", "On"),
        ],
        ..props()
    });
    see(&mut app, "highlighted:on");
}

#[test]
fn typing_filters_by_label_and_keywords_and_drops_empty_sections() {
    let mut app = start(props());
    type_in(&mut app, "cal");
    app.wait_for_gone("role:option[New File]", Duration::from_secs(5))
        .unwrap();
    // Calendar and Calculator, under their one header.
    assert_eq!(options(&app), 2);
    assert_eq!(app.screen().count("role:header"), Ok(1));
    assert!(app.shows("Suggestions"));
    assert!(!app.shows("Settings"));
    log_ends(&mut app, "query=c query=ca query=cal");
    // A new query highlights its first match.
    see(&mut app, "highlighted:calendar");
    // A keyword.
    key(&mut app, "escape");
    type_in(&mut app, "account");
    app.wait_for_gone("role:option[Calendar]", Duration::from_secs(5))
        .unwrap();
    assert_eq!(options(&app), 1);
    see(&mut app, "highlighted:profile");
}

#[test]
fn empty_shows_while_nothing_matches_but_not_while_loading() {
    let mut app = start(props());
    type_in(&mut app, "zzz");
    see(&mut app, "No results");
    assert_eq!(options(&app), 0);
    see(&mut app, "highlighted:none");
    let mut app = start(HarnessProps {
        loading: true,
        ..props()
    });
    // Busy for screen readers. (With no rows the list stays, empty: 0
    // points tall, which the screen's model does not list.)
    assert!(
        app.screen()
            .accessibility_state("role:listbox[Commands]")
            .unwrap()
            .busy
    );
    type_in(&mut app, "zzz");
    app.wait_for_gone("role:option", Duration::from_secs(5))
        .unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(!app.shows("No results"));
}

#[test]
fn up_and_down_move_the_highlight_past_disabled_items_and_around_the_ends() {
    let mut app = start(props());
    see(&mut app, "highlighted:new");
    // The search field takes the focus, and the keys with it.
    key(&mut app, "f7");
    // Past the disabled Search Emoji, and around the end.
    for id in ["open", "calendar", "calculator", "profile", "dark", "new"] {
        key(&mut app, "down");
        see(&mut app, &format!("highlighted:{id}"));
    }
    key(&mut app, "up");
    see(&mut app, "highlighted:dark");
    key(&mut app, "pageup");
    see(&mut app, "highlighted:new");
    assert!(
        !log(&app).contains("select="),
        "moving the highlight chooses nothing"
    );
}

#[test]
fn return_and_a_press_choose_and_disabled_items_take_neither() {
    let mut app = start(props());
    // Open File, Search Emoji (disabled), Calculator, Profile.
    type_in(&mut app, "o");
    see(&mut app, "highlighted:open");
    key(&mut app, "down");
    see(&mut app, "highlighted:calculator");
    key(&mut app, "enter");
    log_ends(&mut app, "select=calculator");
    app.press("role:option[Profile]").unwrap();
    log_ends(&mut app, "select=profile");
    assert_eq!(log(&app).matches("select=").count(), 2);
    assert!(app.press("role:option[Search Emoji]").is_err());
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(!log(&app).contains("select=emoji"));
}

#[test]
fn the_pointer_highlights_the_row_it_moves_over() {
    let mut app = start(props());
    app.hover("role:option[Profile]").unwrap();
    see(&mut app, "highlighted:profile");
    // Not a disabled row.
    app.hover("role:option[Search Emoji]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    see(&mut app, "highlighted:profile");
}

#[test]
fn escape_clears_the_query_and_then_cancels() {
    let mut app = start(props());
    type_in(&mut app, "cal");
    log_ends(&mut app, "query=cal");
    key(&mut app, "escape");
    log_ends(&mut app, "query=cal query=");
    app.wait_for("role:option[New File]").unwrap();
    assert_eq!(options(&app), 7);
    // Empty: the app hears `onCancel`, and the query stays as it is.
    key(&mut app, "escape");
    log_ends(&mut app, "query=cal query= cancel");
}

#[test]
fn a_controlled_query_is_the_apps() {
    let mut app = start(HarnessProps {
        controlled: true,
        follow: false,
        ..props()
    });
    type_in(&mut app, "cal");
    app.wait_until("the query reported", Duration::from_secs(5), |s| {
        s.texts().iter().any(|t| t.starts_with("log:query=c"))
    })
    .unwrap();
    // Not followed: every item still shows.
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(options(&app), 7);
    let mut app = start(HarnessProps {
        controlled: true,
        ..props()
    });
    type_in(&mut app, "cal");
    app.wait_for_gone("role:option[New File]", Duration::from_secs(5))
        .unwrap();
    assert_eq!(options(&app), 2);
}

#[test]
fn without_filtering_every_item_shows_and_a_query_highlights_the_first() {
    let mut app = start(HarnessProps {
        filterable: false,
        ..props()
    });
    key(&mut app, "f7");
    key(&mut app, "down");
    key(&mut app, "down");
    see(&mut app, "highlighted:calendar");
    type_in(&mut app, "zzz");
    log_ends(&mut app, "query=zzz");
    see(&mut app, "highlighted:new");
    assert_eq!(options(&app), 7);
    assert!(!app.shows("No results"));
}

#[test]
fn without_a_search_field_the_command_is_one_stop_with_typeahead() {
    let mut app = start(HarnessProps {
        searchable: false,
        ..props()
    });
    assert!(!app.shows("Type a command"));
    // Before, then the command.
    key(&mut app, "tab");
    key(&mut app, "tab");
    key(&mut app, "down");
    see(&mut app, "highlighted:open");
    key(&mut app, "end");
    see(&mut app, "highlighted:dark");
    key(&mut app, "home");
    see(&mut app, "highlighted:new");
    key(&mut app, "p");
    see(&mut app, "highlighted:profile");
    key(&mut app, "space");
    log_ends(&mut app, "select=profile");
    // One Tab leaves it.
    key(&mut app, "tab");
    key(&mut app, "space");
    see(&mut app, "pressed:after");
}

#[test]
fn the_ref_focuses_highlights_and_counts() {
    let mut app = start(props());
    key(&mut app, "f5");
    see(&mut app, "highlighted:profile");
    // A disabled item: nothing.
    key(&mut app, "f6");
    app.wait(Duration::from_millis(50)).unwrap();
    see(&mut app, "highlighted:profile");
    key(&mut app, "f8");
    log_ends(&mut app, "count=7");
    // Focused, the keys go to it.
    key(&mut app, "f7");
    key(&mut app, "down");
    see(&mut app, "highlighted:dark");
    type_in(&mut app, "cal");
    key(&mut app, "f8");
    log_ends(&mut app, "count=2");
}

#[test]
fn render_item_gets_the_shortcut_as_shown_here() {
    let mut app = start(HarnessProps {
        custom: true,
        ..props()
    });
    see(&mut app, "New File|⌘N");
    see(&mut app, "Open File|⇧⌘O");
    see(&mut app, "Calendar|");
    // The row keeps its label and role for screen readers.
    assert_eq!(app.screen().count("role:option[New File]"), Ok(1));
}

#[derive(Clone, PartialEq, Props)]
struct BorderedProps {
    /// The rows' classes.
    item_class: String,
}

/// The commands, each row with the classes given, and the highlighted id
/// as `highlighted:…`.
#[component]
fn Bordered(props: BorderedProps) -> impl IntoElement {
    let highlighted = signal(SharedString::from("none"));
    view()
        .child(
            command()
                .items(commands())
                .item_class(props.item_class.clone())
                .on_highlight_change(move |id: &Option<SharedString>| {
                    highlighted.set(id.clone().unwrap_or_else(|| "none".into()));
                })
                .h(px(400.0)),
        )
        .child(text(move || format!("highlighted:{}", highlighted.get())))
}

#[test]
fn the_row_a_key_reaches_is_restyled_with_its_focus_border() {
    const RED: Color = Color(0xff0000ff);
    let mut app = launch(Root::new::<Bordered>(|| BorderedProps {
        item_class: "border border-transparent focus:border-[#ff0000] focus:bg-[#00ff00]".into(),
    }));
    app.wait_for("text:highlighted:new").unwrap();
    let styles = Arc::new(Mutex::new(Vec::<(NodeId, Color, Color)>::new()));
    let into = styles.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item {
                into.lock()
                    .unwrap()
                    .push((*id, style.borders.colors[0], style.background_color));
            }
        }
    });
    app.press_key("tab").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("text:highlighted:open").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    let styles = styles.lock().unwrap().clone();
    // The row reached: the border and the background of `focus:` in one
    // style; the row left: both back to its own.
    let reached: Vec<_> = styles.iter().filter(|(_, b, _)| *b == RED).collect();
    assert_eq!(reached.len(), 1, "{styles:?}");
    assert_eq!(reached[0].2, Color(0x00ff00ff), "{styles:?}");
    assert!(
        styles
            .iter()
            .any(|(id, b, _)| *id != reached[0].0 && b.is_transparent()),
        "{styles:?}"
    );
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
    /// How many items, in groups of 50.
    items: usize,
    /// Where its `renderItem` calls count ([`RENDERS`]).
    run: u32,
}

fn sized(items: usize) -> ManyProps {
    ManyProps {
        items,
        run: new_run(),
    }
}

/// `items` files (`File 0`, ...) in groups of 50 (`Folder 0`, ...), in a
/// 300-point command whose rows a counting `renderItem` draws.
#[component]
fn Many(props: ManyProps) -> impl IntoElement {
    let items: Vec<CommandItem> = (0..props.items)
        .map(|i| {
            CommandItem::new(format!("f{i}"), format!("File {i}"))
                .group(format!("Folder {}", i / 50))
        })
        .collect();
    let highlighted = signal(SharedString::from("none"));
    let run = props.run as usize;
    view()
        .child(
            command()
                .items(items)
                .placeholder("Search files")
                .on_highlight_change(move |id: &Option<SharedString>| {
                    highlighted.set(id.clone().unwrap_or_else(|| "none".into()));
                })
                .render_item(move |e: &CommandEntry| {
                    RENDERS.lock().unwrap()[run] += 1;
                    text(e.label.clone())
                })
                .h(px(300.0)),
        )
        .child(text(move || format!("highlighted:{}", highlighted.get())))
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
    app.wait_for("role:option[File 0]").unwrap();
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

/// What one Down costs, from `f1` to `f2`, with the search field focused.
fn cost_of_a_key(items: usize) -> Cost {
    let (mut app, measure) = measured(sized(items));
    app.press_key("tab").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("text:highlighted:f1").unwrap();
    measure(&mut app, &|app| {
        app.press_key("down").unwrap();
        app.wait_for("text:highlighted:f2").unwrap();
    })
}

/// The most mount items one Down sends: the projected focus of the row
/// left and of the row reached, no other row's (measured, for 10 items
/// and for 5000).
const KEY_ITEMS: usize = 3;

#[test]
fn a_key_press_changes_the_row_left_and_the_row_reached_only() {
    let few = cost_of_a_key(10);
    let many = cost_of_a_key(5000);
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
fn a_large_list_makes_only_the_rows_in_view_and_a_query_filters_it_natively() {
    let props = sized(5000);
    let run = props.run;
    let mut app = launch(Root::new::<Many>(move || props.clone()));
    app.wait_for("role:option[File 0]").unwrap();
    // 5000 items and 100 headers: only those near the 300-point list are
    // made, and drawn.
    let made = options(&app);
    assert!(made < 60, "{made} rows made");
    assert!(renders_of(run) < 60, "{} rows drawn", renders_of(run));
    // `File 499` and `File 4990` to `File 4999`: under two headers.
    app.type_text("text:Search files", "file 499").unwrap();
    app.wait_for_gone("role:option[File 0]", Duration::from_secs(5))
        .unwrap();
    app.wait_for("role:option[File 4999]").unwrap();
    assert_eq!(options(&app), 11);
    see(&mut app, "highlighted:f499");
    // Back to everything: as few rows again.
    app.press_key("escape").unwrap();
    app.wait_for("role:option[File 0]").unwrap();
    let after = options(&app);
    assert!(after < 60, "{after} rows made");
}
