//! `Editor`: the rows in view show their text and line numbers; typing
//! into the editor's input inserts at the caret and reports the text; the
//! keys of code editors move, select and edit; a controlled value replaces
//! the text; the ref searches, replaces and folds; a read-only editor
//! moves but never edits; a long text makes only the rows in view; and a
//! decoration's label shows in place of its range until the caret comes.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::editor::{
    Editor, EditorApi, EditorCommand, EditorEvent, EditorSearch, EditorSearchResult,
    EditorSelection, editor,
};
use nsh_core::{
    MountItem, NodeId, PayloadValue, PointerEvents, Size,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, Screen};

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The first text (`defaultValue`, or the parent's first `value`).
    text: String,
    /// The editor's `language`.
    language: Option<String>,
    /// The parent controls the text (`value`, set again from `onChange`).
    controlled: bool,
    /// The editor's `readOnly`.
    read_only: bool,
}

fn props(text: &str) -> HarnessProps {
    HarnessProps {
        text: text.into(),
        language: None,
        controlled: false,
        read_only: false,
    }
}

/// Selections as text: `line:column` for a caret, `anchor-head` for a
/// range, the primary last.
fn selections_text(selections: &[EditorSelection]) -> String {
    let at = |p: nsh_base::editor::EditorPosition| format!("{}:{}", p.line, p.column);
    selections
        .iter()
        .map(|s| match s.anchor == s.head {
            true => at(s.head),
            false => format!("{}-{}", at(s.anchor), at(s.head)),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// An editor of 600 × 400 at the top left (in a view `editor`), and what
/// the app heard from it: the text (`Value "…"`), how many changes, the
/// selections, the search's result, where it scrolled (`Scrolled x y
/// content-width content-height width height`) and how many times; buttons
/// run the ref's methods.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(props.text.clone());
    let changes = signal(0u32);
    let selections = signal(String::from("0:0"));
    let matches = signal(String::from("-"));
    let replaced = signal(0u32);
    let from_api = signal(String::new());
    let search = signal(None::<EditorSearch>);
    let scrolled = signal(String::from("-"));
    let scrolls = signal(0u32);
    let wrap = signal(false);
    let ed = component_ref::<Editor>();
    let api = move |f: &dyn Fn(&EditorApi)| {
        if let Some(api) = ed.api::<EditorApi>() {
            f(&api);
        }
    };
    let button = move |id: &str, f: Box<dyn Fn(&EditorApi)>| {
        view()
            .test_id(id)
            .w(px(20.0))
            .h(px(20.0))
            .on_press(move || api(&*f))
    };
    let mut el = editor()
        .language(props.language.clone().map(SharedString::from))
        .read_only(props.read_only)
        .tab_size(4u32)
        .search(move || search.get())
        .soft_wrap(move || wrap.get())
        .on_scroll(move |e: &EditorEvent| {
            if let EditorEvent::Scroll(offset, content, size) = e {
                scrolled.set(format!(
                    "{} {} {} {} {} {}",
                    offset.x.0,
                    offset.y.0,
                    content.width.0,
                    content.height.0,
                    size.width.0,
                    size.height.0
                ));
                scrolls.update(|n| *n += 1);
            }
        })
        .on_change(move |text: &SharedString| {
            value.set(text.to_string());
            changes.update(|n| *n += 1);
        })
        .on_selection_change(move |all: &Vec<EditorSelection>| selections.set(selections_text(all)))
        .on_search_change(move |r: &EditorSearchResult| {
            let current = r.current.map_or("-".to_string(), |c| c.to_string());
            matches.set(format!("{} {current}", r.count));
        })
        .component_ref(&ed)
        .size_full();
    el = match props.controlled {
        true => el.value(move || SharedString::from(value.get())),
        false => el.default_value(props.text.clone()),
    };
    view()
        .child(view().test_id("editor").w(px(600.0)).h(px(400.0)).child(el))
        // A long text would push what follows off screen: only short ones
        // show.
        .child(text(move || {
            let value = value.get();
            match value.len() < 2000 {
                true => format!("Value {value:?}"),
                false => "Value …".into(),
            }
        }))
        .child(text(move || format!("Changes {}", changes.get())))
        .child(text(move || format!("Sel {}", selections.get())))
        .child(text(move || format!("Matches {}", matches.get())))
        .child(text(move || format!("Replaced {}", replaced.get())))
        .child(text(move || format!("Api {:?}", from_api.get())))
        .child(text(move || format!("Scrolled {}", scrolled.get())))
        .child(text(move || format!("Scrolls {}", scrolls.get())))
        .child(
            view()
                .flex_row()
                .child(button(
                    "read-api",
                    Box::new(move |a| from_api.set(a.value())),
                ))
                .child(
                    view()
                        .test_id("set-parent")
                        .w(px(20.0))
                        .h(px(20.0))
                        .on_press(move || value.set("from parent\nsecond".into())),
                )
                .child(
                    view()
                        .test_id("search")
                        .w(px(20.0))
                        .h(px(20.0))
                        .on_press(move || search.set(Some(EditorSearch::new("foo")))),
                )
                .child(button(
                    "find-next",
                    Box::new(|a| a.run(EditorCommand::FindNext)),
                ))
                .child(button(
                    "replace-all",
                    Box::new(move |a| replaced.set(a.replace_all("baz".into()).count)),
                ))
                .child(button("fold-0", Box::new(|a| a.fold(0))))
                .child(button("unfold-0", Box::new(|a| a.unfold(0))))
                .child(button("to-4000", Box::new(|a| a.scroll_to_line(4000))))
                .child(button("to-2000", Box::new(|a| a.scroll_to_line(2000))))
                .child(button(
                    "to-offset",
                    Box::new(|a| a.set_scroll_offset(point(px(40.0), px(200.0)))),
                ))
                .child(
                    view()
                        .test_id("wrap")
                        .w(px(20.0))
                        .h(px(20.0))
                        .on_press(move || wrap.update(|w| *w = !*w)),
                ),
        )
}

/// The harness of `props` on a Linux desktop's headless surface (`mod` is
/// Control), shown.
fn start(props: HarnessProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            props.clone()
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Changes 0").unwrap();
    app
}

/// The app's bar theme belongs to the editor's scroll view, not its
/// one-point input sink, even when typing fills that sink.
#[test]
fn the_caret_sink_has_no_built_in_scrollbar() {
    use nsh_base::{ScrollbarLook, ScrollbarMode, ScrollbarTheme, set_scrollbar_theme};

    #[component]
    fn ThemedEditor() -> impl IntoElement {
        let mut look = ScrollbarLook::default();
        look.class = Some("absolute inset-y-0 right-0 w-[10px]".into());
        look.thumb_class = Some("w-full".into());
        look.accessibility_label = Some("Editor scroll bar".into());
        let mut theme = ScrollbarTheme::default();
        theme.mode = ScrollbarMode::Always;
        theme.vertical = Some(look);
        set_scrollbar_theme(Some(theme));
        view().w(px(600.0)).h(px(200.0)).child(
            editor()
                .accessibility_label("Code")
                .default_value("a line\n".repeat(40))
                .size_full(),
        )
    }

    #[derive(Default)]
    struct Seen {
        bars: std::collections::HashSet<NodeId>,
        scrolls: std::collections::HashSet<NodeId>,
        parents: HashMap<NodeId, NodeId>,
    }
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root::<ThemedEditor>())
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props }
                    if props.accessibility.label.as_deref() == Some("Editor scroll bar") =>
                {
                    seen.bars.insert(*id);
                }
                MountItem::ScrollConfig { id, .. } => {
                    seen.scrolls.insert(*id);
                }
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    app.type_text("label:Code", "typed into the caret sink")
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.bars.len(),
        1,
        "only the text area's vertical bar is made"
    );
    let mut at = *seen.bars.iter().next().unwrap();
    let mut in_scroll = false;
    // Component hosts can sit between the track and its scroll view.
    for _ in 0..seen.parents.len() {
        let Some(&parent) = seen.parents.get(&at) else {
            break;
        };
        if seen.scrolls.contains(&parent) {
            in_scroll = true;
            break;
        }
        at = parent;
    }
    assert!(
        in_scroll,
        "the remaining bar belongs to the editor's scroll view"
    );
}

/// `scrollbarInset` keeps the editor's bars within it, as a scroll view's:
/// the vertical scroll view takes it whole; the horizontal one (no soft
/// wrap) its left, right and bottom, the left less the gutter's width,
/// which already keeps its bar that far from the editor's left.
#[test]
fn the_scroll_bars_keep_within_the_scrollbar_inset() {
    const INSET: EdgeInsets = EdgeInsets {
        top: Points(8.0),
        right: Points(4.0),
        bottom: Points(6.0),
        left: Points(12.0),
    };

    #[component]
    fn InsetEditor() -> impl IntoElement {
        let inset = signal(INSET);
        let gutter = signal(true);
        let button =
            |id: &str, f: Box<dyn Fn()>| view().test_id(id).w(px(20.0)).h(px(20.0)).on_press(f);
        view()
            .child(
                view().w(px(600.0)).h(px(200.0)).child(
                    editor()
                        .default_value("a long line ".repeat(200))
                        .line_numbers(move || gutter.get())
                        .folding(move || gutter.get())
                        .scrollbar_inset(move || inset.get())
                        .size_full(),
                ),
            )
            .child(button("no-gutter", Box::new(move || gutter.set(false))))
            .child(button(
                "clear",
                Box::new(move || inset.set(EdgeInsets::default())),
            ))
    }

    #[derive(Default)]
    struct Seen {
        horizontal: HashMap<NodeId, bool>,
        insets: HashMap<NodeId, EdgeInsets>,
    }
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root::<InsetEditor>())
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::ScrollConfig { id, horizontal, .. } => {
                    seen.horizontal.insert(*id, *horizontal);
                }
                MountItem::ScrollBehavior { id, behavior } => {
                    seen.insets.insert(*id, behavior.scrollbar_inset);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    app.run_for(Duration::from_millis(50)).unwrap();
    // The editor's scroll view along each axis: the one sent an inset.
    let (vertical_id, horizontal_id) = {
        let seen = seen.lock().unwrap();
        let of = |horizontal: bool| {
            let mut found = seen.insets.iter().filter(|(id, inset)| {
                seen.horizontal.get(id) == Some(&horizontal) && **inset != EdgeInsets::default()
            });
            let (id, _) = found.next().expect("the scroll view's inset");
            assert!(found.next().is_none(), "one scroll view per axis");
            *id
        };
        (of(false), of(true))
    };
    // The last inset each of them was sent.
    let insets = |app: &mut Headless| {
        app.run_for(Duration::from_millis(50)).unwrap();
        let seen = seen.lock().unwrap();
        (seen.insets[&vertical_id], seen.insets[&horizontal_id])
    };
    let along_the_bottom = |left: f32| EdgeInsets {
        top: px(0.0),
        left: px(left),
        ..INSET
    };

    let (vertical, horizontal) = insets(&mut app);
    assert_eq!(vertical, INSET, "the vertical bar takes the inset whole");
    assert_eq!(
        horizontal,
        along_the_bottom(0.0),
        "the gutter is wider than the left inset"
    );

    // Without a gutter the text area starts at the editor's left.
    app.press("id:no-gutter").unwrap();
    let (vertical, horizontal) = insets(&mut app);
    assert_eq!(vertical, INSET);
    assert_eq!(horizontal, along_the_bottom(12.0));

    app.press("id:clear").unwrap();
    assert_eq!(
        insets(&mut app),
        (EdgeInsets::default(), EdgeInsets::default())
    );
}

/// Waits until a text on screen reads `text`.
fn see(app: &mut Headless, text: &str) {
    app.wait_for(&format!("text:{text}")).unwrap();
}

/// What the harness shows of text `text`.
fn value(text: &str) -> String {
    format!("Value {text:?}")
}

/// Focuses the editor, as a press into its input does (its keys are bound
/// while it has the focus).
fn focus(app: &mut Headless) {
    app.type_text("id:editor", "").unwrap();
}

fn keys(app: &mut Headless, list: &[&str]) {
    for k in list {
        app.press_key(k).unwrap();
    }
}

/// The texts on screen that start with `prefix`.
fn count_texts(app: &Headless, prefix: &str) -> usize {
    app.screen()
        .texts()
        .iter()
        .filter(|t| t.trim_start().starts_with(prefix))
        .count()
}

/// The line numbers on screen.
fn count_numbers(app: &Headless) -> usize {
    app.screen()
        .texts()
        .iter()
        .filter(|t| !t.trim().is_empty() && t.trim().parse::<u32>().is_ok())
        .count()
}

#[test]
fn a_default_value_shows_its_rows_and_line_numbers() {
    let mut app = start(props("alpha\nbeta\ngamma"));
    for shown in ["alpha", "beta", "gamma", "1", "2", "3"] {
        see(&mut app, shown);
    }
    assert!(!app.shows("4"));
    assert_eq!(count_numbers(&app), 3);
}

#[test]
fn testing_value_reads_the_document_instead_of_the_keyboard_sink() {
    let mut p = props("Hallo\nworld");
    p.controlled = true;
    let mut app = start(p);
    assert_eq!(
        app.screen().input_text("id:editor"),
        Ok(Some("Hallo\nworld"))
    );
    app.type_text("id:editor", "A").unwrap();
    assert_eq!(
        app.screen().input_text("id:editor"),
        Ok(Some("AHallo\nworld"))
    );
    app.press("id:set-parent").unwrap();
    assert_eq!(
        app.screen().input_text("id:editor"),
        Ok(Some("from parent\nsecond"))
    );
}

#[test]
fn typing_inserts_at_the_caret_and_reports_the_text() {
    let mut app = start(props("hello"));
    app.type_text("id:editor", "Hi ").unwrap();
    see(&mut app, &value("Hi hello"));
    see(&mut app, "Sel 0:3");
    see(&mut app, "Hi hello");
    // One report per character typed.
    see(&mut app, "Changes 3");
    // After a move the input starts again from nothing: still at the caret.
    keys(&mut app, &["end"]);
    app.type_text("id:editor", "!").unwrap();
    see(&mut app, &value("Hi hello!"));
}

#[test]
fn typing_the_same_text_after_moving_the_caret_inserts_it() {
    let mut app = start(props(""));
    app.type_text("id:editor", "a").unwrap();
    see(&mut app, &value("a"));
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 0:0");
    app.type_text("id:editor", "a").unwrap();
    see(&mut app, &value("aa"));
}

/// The sink's text changed to `text`, as a platform reports it. The
/// headless driver does not expose an input's node id, so the event goes to
/// every node; only the sink listens to it.
fn sink_text(app: &mut Headless, text: &str) {
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::ChangeText,
            EventPayload::Text {
                text: text.to_owned(),
                count: 0,
            },
        );
    }
    app.wait(Duration::from_millis(50)).unwrap();
}

/// The platform moved the sink's own caret to UTF-16 offset `at` of its
/// text, without a key (an input method that types a pair of brackets and
/// puts its caret between them). Sent to every node, as [`sink_text`] is.
fn sink_caret(app: &mut Headless, at: u32) {
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::SelectionChange,
            EventPayload::Map(vec![
                ("start", PayloadValue::Number(f64::from(at))),
                ("end", PayloadValue::Number(f64::from(at))),
            ]),
        );
    }
    app.wait(Duration::from_millis(50)).unwrap();
}

#[test]
fn the_caret_follows_an_input_method_that_moves_it_between_a_pair() {
    let mut app = start(props("f"));
    focus(&mut app);
    keys(&mut app, &["end"]);
    see(&mut app, "Sel 0:1");
    // The input method types both halves, then puts its caret between them.
    sink_text(&mut app, "()");
    see(&mut app, &value("f()"));
    see(&mut app, "Sel 0:3");
    sink_caret(&mut app, 1);
    see(&mut app, "Sel 0:2");
    // What it types next goes in there, with the caret after it.
    sink_text(&mut app, "(x)");
    see(&mut app, &value("f(x)"));
    see(&mut app, "Sel 0:3");
    sink_caret(&mut app, 2);
    sink_text(&mut app, "(xy)");
    see(&mut app, &value("f(xy)"));
    see(&mut app, "Sel 0:4");
}

#[test]
fn arrows_move_and_shift_arrows_select() {
    let mut app = start(props("abc\ndef"));
    focus(&mut app);
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 0:1");
    keys(&mut app, &["down"]);
    see(&mut app, "Sel 1:1");
    keys(&mut app, &["shift+right"]);
    see(&mut app, "Sel 1:1-1:2");
    // Backspace deletes the selection.
    keys(&mut app, &["backspace"]);
    see(&mut app, &value("abc\ndf"));
    see(&mut app, "Sel 1:1");
    keys(&mut app, &["backspace"]);
    see(&mut app, &value("abc\nf"));
    keys(&mut app, &["up", "end"]);
    see(&mut app, "Sel 0:3");
}

#[test]
fn enter_indents_after_an_opening_bracket() {
    let mut app = start(HarnessProps {
        language: Some("rust".into()),
        ..props("fn main() {}")
    });
    focus(&mut app);
    keys(&mut app, &["end", "left", "enter"]);
    see(&mut app, &value("fn main() {\n    \n}"));
    see(&mut app, "Sel 1:4");
    // The new rows show.
    see(&mut app, "}");
    see(&mut app, "3");
}

#[test]
fn tab_indents_at_the_caret() {
    let mut app = start(props("a"));
    focus(&mut app);
    keys(&mut app, &["tab"]);
    see(&mut app, &value("    a"));
    see(&mut app, "Sel 0:4");
    keys(&mut app, &["shift+tab"]);
    see(&mut app, &value("a"));
}

#[test]
fn undo_takes_back_typing_and_redo_does_it_again() {
    let mut app = start(props("x"));
    app.type_text("id:editor", "abc").unwrap();
    see(&mut app, &value("abcx"));
    keys(&mut app, &["mod+z"]);
    see(&mut app, &value("x"));
    see(&mut app, "Sel 0:0");
    keys(&mut app, &["mod+shift+z"]);
    see(&mut app, &value("abcx"));
}

#[test]
fn mod_d_adds_the_next_occurrence_and_typing_replaces_each() {
    let mut app = start(props("foo bar foo"));
    focus(&mut app);
    keys(&mut app, &["mod+d"]);
    see(&mut app, "Sel 0:0-0:3");
    keys(&mut app, &["mod+d"]);
    see(&mut app, "Sel 0:0-0:3 0:8-0:11");
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &value("x bar x"));
    see(&mut app, "Sel 0:1 0:7");
}

#[test]
fn alt_up_moves_the_caret_s_line_up() {
    let mut app = start(props("a\nb\nc"));
    focus(&mut app);
    keys(&mut app, &["down", "down"]);
    see(&mut app, "Sel 2:0");
    keys(&mut app, &["alt+up"]);
    see(&mut app, &value("a\nc\nb"));
    see(&mut app, "Sel 1:0");
    keys(&mut app, &["alt+down"]);
    see(&mut app, &value("a\nb\nc"));
}

#[test]
fn mod_slash_comments_the_line_out_and_back_in() {
    let mut app = start(HarnessProps {
        language: Some("rust".into()),
        ..props("let a = 1;")
    });
    focus(&mut app);
    keys(&mut app, &["mod+/"]);
    see(&mut app, &value("// let a = 1;"));
    // The row reads it too (a `text:` selector starting with `/` is a
    // regular expression's).
    assert!(app.shows("// let a = 1;"));
    keys(&mut app, &["mod+/"]);
    see(&mut app, &value("let a = 1;"));
}

#[test]
fn a_controlled_value_from_the_parent_replaces_the_text() {
    let mut app = start(HarnessProps {
        controlled: true,
        ..props("first")
    });
    see(&mut app, "first");
    app.press("id:set-parent").unwrap();
    see(&mut app, "from parent");
    see(&mut app, "second");
    see(&mut app, "2");
    app.press("id:read-api").unwrap();
    see(&mut app, "Api \"from parent\\nsecond\"");
    // The parent's own value is not reported back to it.
    assert!(app.shows("Changes 0"));
    // The parent's value was an edit undo takes back, which is reported.
    focus(&mut app);
    keys(&mut app, &["mod+z"]);
    see(&mut app, &value("first"));
    see(&mut app, "Changes 1");
    keys(&mut app, &["mod+shift+z"]);
    see(&mut app, &value("from parent\nsecond"));
    // Typing goes through the parent, which sets it again.
    keys(&mut app, &["ctrl+home"]);
    see(&mut app, "Sel 0:0");
    app.type_text("id:editor", "> ").unwrap();
    see(&mut app, &value("> from parent\nsecond"));
    see(&mut app, "> from parent");
    app.press("id:read-api").unwrap();
    see(&mut app, "Api \"> from parent\\nsecond\"");
}

#[test]
fn a_search_finds_its_matches_and_replace_all_replaces_them() {
    let mut app = start(props("foo bar foo\nfoo"));
    app.press("id:search").unwrap();
    see(&mut app, "Matches 3 -");
    app.press("id:find-next").unwrap();
    see(&mut app, "Matches 3 0");
    see(&mut app, "Sel 0:0-0:3");
    app.press("id:find-next").unwrap();
    see(&mut app, "Matches 3 1");
    see(&mut app, "Sel 0:8-0:11");
    app.press("id:replace-all").unwrap();
    see(&mut app, "Replaced 3");
    see(&mut app, &value("baz bar baz\nbaz"));
    see(&mut app, "Matches 0 -");
    see(&mut app, "baz bar baz");
}

#[test]
fn folding_through_the_ref_hides_the_rows_under_a_line() {
    let mut app = start(props("fn a() {\n    one\n    two\n}\nend"));
    see(&mut app, "one");
    app.press("id:fold-0").unwrap();
    app.wait_for_gone("text:one", Duration::from_secs(5))
        .unwrap();
    assert!(!app.shows("two"));
    // The line that closes the block and those after it stay, and the
    // gutter numbers them as they are.
    assert!(app.shows("}"));
    assert!(app.shows("end"));
    assert!(!app.shows("2") && !app.shows("3"));
    assert!(app.shows("4") && app.shows("5"));
    app.press("id:unfold-0").unwrap();
    see(&mut app, "one");
    see(&mut app, "two");
    see(&mut app, "2");
}

#[test]
fn a_read_only_editor_moves_but_does_not_edit() {
    let mut app = start(HarnessProps {
        read_only: true,
        ..props("locked")
    });
    app.type_text("id:editor", "x").unwrap();
    keys(&mut app, &["backspace", "enter", "tab", "mod+/", "right"]);
    see(&mut app, "Sel 0:1");
    app.wait(Duration::from_millis(100)).unwrap();
    assert!(app.shows(&value("locked")));
    assert!(app.shows("Changes 0"));
    assert!(app.shows("locked"));
}

/// Scrolling far moves the rows already made to the lines it shows (their
/// text and place), rather than making the views of new rows and deleting
/// the old ones: a window of rows moves by a screen or more at a time, and
/// hundreds of views made and deleted in one frame dropped it.
#[test]
fn scrolling_far_shows_the_new_rows_in_the_views_already_made() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let text: Vec<String> = (0..5000).map(|i| format!("line {i}")).collect();
    let mut app = start(props(&text.join("\n")));
    see(&mut app, "line 0");
    // The first move into the text makes the rows above the viewport,
    // which the top has none of.
    app.press("id:to-4000").unwrap();
    see(&mut app, "line 4000");
    let made = Arc::new(AtomicUsize::new(0));
    let counter = made.clone();
    app.observe(move |_, batch| {
        let creates = batch
            .items
            .iter()
            .filter(|item| matches!(item, nsh_core::MountItem::Create { .. }))
            .count();
        counter.fetch_add(creates, Ordering::Relaxed);
    });
    app.press("id:to-2000").unwrap();
    see(&mut app, "line 2000");
    see(&mut app, "2001");
    assert!(!app.shows("line 4000"));
    let made = made.load(Ordering::Relaxed);
    assert!(made < 10, "{made} views made to scroll");
}

#[test]
fn a_long_text_makes_only_the_rows_in_view() {
    let text: Vec<String> = (0..5000).map(|i| format!("line {i}")).collect();
    let mut app = start(props(&text.join("\n")));
    see(&mut app, "line 0");
    // 400 points of 20-point rows (40 before the viewport is known) and a
    // viewport and a half ahead.
    let rows = count_texts(&app, "line ");
    assert!((20..150).contains(&rows), "{rows} rows made");
    let numbers = count_numbers(&app);
    assert!((20..150).contains(&numbers), "{numbers} line numbers made");
    assert!(!app.shows("line 4999"));
    app.press("id:to-4000").unwrap();
    see(&mut app, "line 4000");
    see(&mut app, "4001");
    assert!(!app.shows("line 0"));
    let rows = count_texts(&app, "line ");
    assert!(
        (20..150).contains(&rows),
        "{rows} rows made after scrolling"
    );
}

/// What the editor reported last (`onScroll`): `[x, y, content width,
/// content height, width, height]`, `None` before it reported.
fn scrolled(screen: &Screen) -> Option<[f32; 6]> {
    let line = screen
        .texts()
        .iter()
        .find_map(|t| t.trim().strip_prefix("Scrolled ").map(str::to_string))
        .filter(|s| s != "-")?;
    let values: Vec<f32> = line.split(' ').map(|v| v.parse().unwrap()).collect();
    values.try_into().ok()
}

/// How many times the editor reported where it scrolled.
fn scrolls(app: &Headless) -> u32 {
    app.screen()
        .texts()
        .iter()
        .find_map(|t| t.trim().strip_prefix("Scrolls "))
        .expect("the count shows")
        .parse()
        .unwrap()
}

/// Waits for a report `done` accepts and gives it: a report follows the
/// layout or the scroll it tells of, not a fixed time.
fn wait_scrolled(app: &mut Headless, what: &str, done: impl Fn(&[f32; 6]) -> bool) -> [f32; 6] {
    app.wait_until(what, Duration::from_secs(5), |s| {
        scrolled(s).is_some_and(|r| done(&r))
    })
    .unwrap_or_else(|e| panic!("{e}; reported: {:?}", scrolled(app.screen())));
    scrolled(app.screen()).unwrap()
}

/// The editor reports where its text is scrolled, the content's size and
/// the viewport's (`onScroll`): once laid out, on a scroll, on the ref's
/// `setScrollOffset`, and when soft wrap stops the sideways scrolling;
/// nothing when nothing moved. An app draws a line or a fade at an edge
/// the text scrolls under from it.
#[test]
fn the_editor_reports_where_its_text_is_scrolled() {
    let mut lines: Vec<String> = (0..100).map(|i| format!("line {i}")).collect();
    lines[0] = format!("wide {}", "word ".repeat(60));
    let mut app = start(props(&lines.join("\n")));
    see(&mut app, "line 1");
    // Once laid out: at the top left, the viewport the editor's box, the
    // content taller (100 rows) and wider (the long line) than it.
    let first = wait_scrolled(&mut app, "the first layout", |r| {
        r[2] > 640.0 && r[3] >= 2000.0
    });
    let content_h = first[3];
    assert_eq!(
        [first[0], first[1], first[4], first[5]],
        [0.0, 0.0, 600.0, 400.0],
        "{first:?}"
    );
    // The user scrolls down.
    app.scroll("id:editor", px(100.0)).unwrap();
    wait_scrolled(&mut app, "the scroll down", |r| {
        r[0] == 0.0 && r[1] == 100.0
    });
    // The ref scrolls both ways at once.
    app.press("id:to-offset").unwrap();
    let moved = wait_scrolled(&mut app, "the ref's offset", |r| {
        r[0] == 40.0 && r[1] == 200.0
    });
    assert_eq!(&moved[2..], &first[2..], "the sizes stay");
    // Nothing moved (a search that matches nothing; the text read back
    // would take the screen's height and push the buttons off it):
    // nothing more is reported.
    let before = scrolls(&app);
    app.press("id:search").unwrap();
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(scrolls(&app), before);
    // Wrapped, the text no longer scrolls sideways: the content is as wide
    // as the viewport, and taller (the long line takes several rows).
    app.press("id:wrap").unwrap();
    let wrapped = wait_scrolled(&mut app, "the wrapped content", |r| {
        r[0] == 0.0 && r[2] == 600.0 && r[3] > content_h
    });
    assert_eq!(wrapped[4..], [600.0, 400.0], "{wrapped:?}");
}

/// The top of the row reading `text`, as laid out.
fn row_top(app: &Headless, text: &str) -> f32 {
    app.screen()
        .layout_nodes()
        .iter()
        .find(|n| n.text.as_ref().is_some_and(|t| t.text.text == text))
        .map(|n| n.bounds.origin.y.0)
        .unwrap_or_else(|| panic!("no row reads {text:?}"))
}

/// The rows grow with the user's text size, as the texts drawn in them do:
/// measured in the app's font alone, a row drawn larger would run over the
/// next one.
#[test]
fn rows_follow_the_user_s_text_size() {
    let mut app = start(props("alpha\nbeta\ngamma"));
    see(&mut app, "gamma");
    let pitch = row_top(&app, "beta") - row_top(&app, "alpha");
    assert_eq!(pitch, 20.0);
    app.set_environment("fontScale", |env| env.font_scale = 1.25)
        .unwrap();
    app.wait(std::time::Duration::from_millis(200)).unwrap();
    let pitch = row_top(&app, "beta") - row_top(&app, "alpha");
    assert_eq!(pitch, 25.0);
}

#[test]
fn the_rows_text_lets_the_pointer_through_to_the_scroll_views() {
    // The rows are drawn over the scroll views: a finger or a wheel on a
    // row's glyphs reaches the scroll views below, as on blank space, so a
    // view from the row's text up takes no pointer.
    #[derive(Default)]
    struct Seen {
        texts: HashMap<NodeId, String>,
        pointer: HashMap<NodeId, PointerEvents>,
        parents: HashMap<NodeId, NodeId>,
    }
    let text = props("alpha\nbeta\ngamma");
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            text.clone()
        }))
    };
    config.environment.os = Os::Ios;
    config.environment.idiom = Idiom::Phone;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Text { id, text, .. } => {
                    seen.texts.insert(*id, text.text.clone());
                }
                MountItem::ViewProps { id, props } => {
                    seen.pointer.insert(*id, props.pointer_events);
                }
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    see(&mut app, "beta");
    let seen = seen.lock().unwrap();
    let (&row, _) = seen
        .texts
        .iter()
        .find(|(_, t)| t.as_str() == "beta")
        .expect("the row's text was made");
    let mut at = Some(row);
    let mut blocked = false;
    while let Some(id) = at {
        if seen.pointer.get(&id) == Some(&PointerEvents::None) {
            blocked = true;
            break;
        }
        at = seen.parents.get(&id).copied();
    }
    assert!(blocked, "the row's text takes the pointer");
}

/// The harness on `os` with a manual clock, the editor focused, and a
/// count of the mount items it sends from then on.
fn start_idle(os: Os) -> (Headless, Arc<Mutex<usize>>) {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            props("abc")
        }))
    };
    config.environment.os = os;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Changes 0").unwrap();
    focus(&mut app);
    app.run_for(Duration::from_millis(100)).unwrap();
    let items = Arc::new(Mutex::new(0usize));
    let seen = items.clone();
    app.observe(move |_, batch| *seen.lock().unwrap() += batch.items.len());
    (app, items)
}

/// The mount items sent while the clock runs `secs` seconds.
fn items_over(app: &mut Headless, items: &Mutex<usize>, secs: u64) -> usize {
    *items.lock().unwrap() = 0;
    app.run_for(Duration::from_secs(secs)).unwrap();
    *items.lock().unwrap()
}

#[test]
fn the_carets_stop_blinking_after_ten_idle_seconds_on_linux() {
    let (mut app, items) = start_idle(Os::Linux);
    assert!(items_over(&mut app, &items, 2) > 0, "the carets blink");
    app.run_for(Duration::from_secs(9)).unwrap();
    assert_eq!(items_over(&mut app, &items, 3), 0, "still blinking");
    // A key shows them blinking again.
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &value("xabc"));
    app.run_for(Duration::from_millis(100)).unwrap();
    assert!(
        items_over(&mut app, &items, 2) > 0,
        "the carets blink again"
    );
}

#[test]
fn the_carets_blink_for_good_on_macos() {
    let (mut app, items) = start_idle(Os::MacOs);
    app.run_for(Duration::from_secs(11)).unwrap();
    assert!(items_over(&mut app, &items, 3) > 0);
}

#[test]
fn auto_focus_focuses_the_caret_sink_on_mount() {
    #[component]
    fn AutoFocused() -> impl IntoElement {
        let value = signal(String::new());
        let focused = signal(0u32);
        view()
            .w(px(400.0))
            .h(px(200.0))
            .child(
                editor()
                    .auto_focus(true)
                    .default_value("")
                    .on_focus(move || focused.update(|n| *n += 1))
                    .on_change(move |text: &SharedString| value.set(text.to_string()))
                    .size_full(),
            )
            .child(text(move || format!("Focused {}", focused.get())))
            .child(text(move || format!("Value {:?}", value.get())))
    }

    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(250.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root::<AutoFocused>())
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    let auto_focused_inputs = Arc::new(Mutex::new(0usize));
    let seen = auto_focused_inputs.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::Input { config, .. } = item
                && config.auto_focus
            {
                *seen.lock().unwrap() += 1;
            }
        }
    });
    app.first_render().unwrap();
    assert_eq!(
        *auto_focused_inputs.lock().unwrap(),
        1,
        "autoFocus should configure the caret sink input on first mount"
    );
    app.press_key("a").unwrap();
    see(&mut app, &value("a"));
    see(&mut app, "Focused 1");
}

#[test]
fn auto_focus_cancelled_before_mount_does_not_focus() {
    #[component]
    fn ToggledBeforeMount() -> impl IntoElement {
        let auto = signal(true);
        let value = signal(String::new());
        let ed = editor()
            .auto_focus(move || auto.get())
            .default_value("")
            .on_change(move |text: &SharedString| value.set(text.to_string()))
            .size_full();
        auto.set(false);
        view()
            .w(px(400.0))
            .h(px(200.0))
            .child(ed)
            .child(text(move || format!("Value {:?}", value.get())))
    }

    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(250.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root::<ToggledBeforeMount>())
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    let auto_focused_inputs = Arc::new(Mutex::new(0usize));
    let seen = auto_focused_inputs.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::Input { config, .. } = item
                && config.auto_focus
            {
                *seen.lock().unwrap() += 1;
            }
        }
    });
    app.first_render().unwrap();
    app.run_for(Duration::from_millis(50)).unwrap();
    assert_eq!(*auto_focused_inputs.lock().unwrap(), 0);
    app.press_key("a").unwrap();
    see(&mut app, &value(""));
}

/// A replacing decoration shows its label in place of its range's text;
/// the text comes back while the caret touches the range, and the label
/// when the caret leaves it. The document keeps the text throughout.
#[test]
fn a_label_shows_in_place_of_its_range_until_the_caret_touches_it() {
    use nsh_base::editor::{EditorDecoration, EditorPosition, EditorRange};

    #[component]
    fn Labeled() -> impl IntoElement {
        let mut due = EditorDecoration::default();
        due.range = EditorRange::new(EditorPosition::new(0, 4), EditorPosition::new(0, 15));
        due.label = Some("Tomorrow".into());
        due.label_class = Some("px-1 rounded bg-muted".into());
        view().test_id("editor").w(px(600.0)).h(px(200.0)).child(
            editor()
                .default_value("due @2026-11-25 ok\nnext")
                .decorations(vec![due])
                .size_full(),
        )
    }

    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root::<Labeled>())
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    see(&mut app, "Tomorrow");
    let source = |app: &Headless| {
        app.screen()
            .texts()
            .iter()
            .any(|t| t.contains("2026-11-25"))
    };
    assert!(!source(&app), "the range's text is not drawn");
    focus(&mut app);
    // At the range's start the caret touches it: its text shows.
    keys(&mut app, &["right", "right", "right", "right"]);
    see(&mut app, "due @2026-11-25 ok");
    assert!(!app.shows("Tomorrow"));
    // On the next line, the label again.
    keys(&mut app, &["down"]);
    see(&mut app, "Tomorrow");
    assert!(!source(&app));
    assert_eq!(
        app.screen().input_text("id:editor"),
        Ok(Some("due @2026-11-25 ok\nnext"))
    );
}

/// A row made again keeps a label's box only for the same label: a kept
/// box first hears the frame it was last laid out at, which for another
/// label's box would report that label's width as this one's. A new label
/// for the same range is a new box, and shows.
#[test]
fn a_label_box_is_kept_only_for_the_same_label() {
    use nsh_base::editor::{EditorDecoration, EditorPosition, EditorRange};

    #[component]
    fn Relabeled() -> impl IntoElement {
        let later = signal(false);
        let decorations = move || {
            let mut due = EditorDecoration::default();
            due.range = EditorRange::new(EditorPosition::new(0, 4), EditorPosition::new(0, 15));
            due.label = Some(if later.get() { "Next week" } else { "Tomorrow" }.into());
            vec![due]
        };
        view()
            .child(
                view().test_id("editor").w(px(600.0)).h(px(200.0)).child(
                    editor()
                        .default_value("due @2026-11-25 ok\nnext")
                        .decorations(decorations)
                        .size_full(),
                ),
            )
            .child(
                view()
                    .test_id("later")
                    .w(px(20.0))
                    .h(px(20.0))
                    .on_press(move || later.set(true)),
            )
    }

    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root::<Relabeled>())
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    see(&mut app, "Tomorrow");
    let source = "label:@2026-11-25";
    let first = app.screen().id(source).unwrap();
    // Typing at the line's end, away from the range (which the app's
    // decorations keep), makes the row again with the same label: the same
    // box.
    focus(&mut app);
    keys(&mut app, &["end"]);
    app.type_text("id:editor", "!").unwrap();
    app.run_for(Duration::from_millis(50)).unwrap();
    assert_eq!(
        app.screen().input_text("id:editor"),
        Ok(Some("due @2026-11-25 ok!\nnext"))
    );
    assert!(app.shows("Tomorrow"));
    assert_eq!(app.screen().id(source), Ok(first));
    // Another label over the range: shown, in a box of its own.
    app.press("id:later").unwrap();
    see(&mut app, "Next week");
    assert!(!app.shows("Tomorrow"));
    let now = app.screen().id(source).expect("the new label's box");
    assert_ne!(now, first);
}

/// A text color as a Rust app types it (`StyleRefinement`), not as
/// declarations.
fn typed_color(color: u32) -> nsh_core::element::Style {
    nsh_core::element::StyleRefinement::default()
        .text_color(rgb(color))
        .into()
}

/// Component `C` on a Linux desktop's headless surface, shown once
/// `text` is.
fn start_component<C: Component<Props = ()>>(text: &str) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root::<C>())
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    see(&mut app, text);
    app
}

/// Typed part styles reach a line number of one part and the caret's,
/// which takes `lineNumber` then `activeLineNumber`, the later winning.
#[test]
fn typed_part_styles_reach_line_numbers_of_one_part_and_of_two() {
    use nsh_base::{editor::EditorStyles, text_view::PartStyle};
    use nsh_core::Color;

    #[component]
    fn Numbered() -> impl IntoElement {
        let mut styles = EditorStyles::default();
        styles.line_number = Some(PartStyle(typed_color(0xff0000)));
        styles.active_line_number = Some(PartStyle(typed_color(0x0000ff)));
        view().test_id("editor").w(px(600.0)).h(px(200.0)).child(
            editor()
                .default_value("abc\ndef")
                .styles(styles)
                .size_full(),
        )
    }

    let app = start_component::<Numbered>("def");
    let color = |selector: &str| app.screen().span_style(selector).unwrap().color;
    assert_eq!(color("id:editor >> text:1"), Color(0x0000_ffff));
    assert_eq!(color("id:editor >> text:2"), Color(0xff00_00ff));
}

/// Typed decoration styles reach their range's text (`style`) and their
/// lines' rows (`lineStyle`), whose text takes their color; where two
/// decorations cover the same text or line, the later one wins.
#[test]
fn typed_decoration_styles_reach_their_text_and_rows_the_later_winning() {
    use nsh_base::editor::{EditorDecoration, EditorPosition, EditorRange};
    use nsh_core::Color;

    #[component]
    fn Decorated() -> impl IntoElement {
        let range = |line, from, to| {
            EditorRange::new(
                EditorPosition::new(line, from),
                EditorPosition::new(line, to),
            )
        };
        let text = |line, from, to, color| {
            let mut d = EditorDecoration::default();
            d.range = range(line, from, to);
            d.style = Some(typed_color(color));
            d
        };
        let row = |line, color| {
            let mut d = EditorDecoration::default();
            d.range = range(line, 0, 3);
            d.line_style = Some(typed_color(color));
            d
        };
        view().test_id("editor").w(px(600.0)).h(px(200.0)).child(
            editor()
                .default_value("abc and xyz\ndef\nghi")
                .decorations(vec![
                    text(0, 0, 3, 0xff0000),
                    text(0, 8, 11, 0xff0000),
                    text(0, 8, 11, 0x0000ff),
                    row(1, 0x00ff00),
                    row(2, 0x00ff00),
                    row(2, 0x0000ff),
                ])
                .size_full(),
        )
    }

    let app = start_component::<Decorated>("ghi");
    let color = |selector: &str| app.screen().span_style(selector).unwrap().color;
    assert_eq!(color("id:editor >> text:abc"), Color(0xff00_00ff));
    assert_ne!(color("id:editor >> text: and "), Color(0xff00_00ff));
    assert_eq!(color("id:editor >> text:xyz"), Color(0x0000_ffff));
    assert_eq!(color("id:editor >> text:def"), Color(0x00ff_00ff));
    assert_eq!(color("id:editor >> text:ghi"), Color(0x0000_ffff));
}
