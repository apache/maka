//! `Editor`: the rows in view show their text and line numbers; typing
//! into the editor's input inserts at the caret and reports the text; the
//! keys of code editors move, select and edit; a controlled value replaces
//! the text; the ref searches, replaces and folds; a read-only editor
//! moves but never edits; and a long text makes only the rows in view.

use std::time::Duration;

use nsh_base::editor::{
    Editor, EditorApi, EditorCommand, EditorSearch, EditorSearchResult, EditorSelection, editor,
};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

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
/// selections, the search's result; buttons run the ref's methods.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(props.text.clone());
    let changes = signal(0u32);
    let selections = signal(String::from("0:0"));
    let matches = signal(String::from("-"));
    let replaced = signal(0u32);
    let from_api = signal(String::new());
    let search = signal(None::<EditorSearch>);
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
                    Box::new(move |a| replaced.set(a.replace_all("baz".into()))),
                ))
                .child(button("fold-0", Box::new(|a| a.fold(0))))
                .child(button("unfold-0", Box::new(|a| a.unfold(0))))
                .child(button("to-4000", Box::new(|a| a.scroll_to_line(4000)))),
        )
}

/// The harness of `props` on a Linux desktop's headless surface (`mod` is
/// Control), shown.
fn start(props: HarnessProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Changes 0").unwrap();
    app
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
