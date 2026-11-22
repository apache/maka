//! The languages and highlighters an app registers with its engine
//! (`register_language`, `register_highlighter`): `language` finds them by
//! name, alias, extension or path before the built-in ones, the app's
//! highlighter colors the editor's and the diff view's text, a UI set
//! registers them from its setup (`Registry::setup`), and each engine
//! keeps its own.

use std::time::Duration;

use nsh_base::{
    diff_view,
    editor::{
        EditorHighlighter, EditorLanguage, EditorText, EditorTextEdit, EditorToken, EditorTokens,
        editor, register_highlighter, register_language,
    },
};
use nsh_core::{
    Size,
    element::{Registry, Root},
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// A language of notes: `%%` comments, files `*.nts`.
static NOTES: EditorLanguage = EditorLanguage::new("Notes")
    .aliases(&["notes"])
    .extensions(&["nts"])
    .line_comment("%%")
    .tab_size(2);

/// The notes' highlighter: every `note` is a comment (italic), every
/// `done` a keyword. It highlights line by line from the first line an
/// edit touched, a line a call (so it takes several), and does not guess.
#[derive(Default)]
struct Notes {
    /// The first line that is not current.
    dirty: usize,
}

impl EditorHighlighter for Notes {
    fn edited(&mut self, edit: &EditorTextEdit) {
        self.dirty = self.dirty.min(edit.first_line);
    }

    fn highlight(
        &mut self,
        text: &EditorText,
        last_line: usize,
        _budget: Duration,
        tokens: &mut EditorTokens,
    ) -> bool {
        let mut line = String::new();
        let (mut offset, mut index) = (0, 0);
        loop {
            let newline = text.read_line(offset, &mut line);
            if index == self.dirty {
                let found = ["note", "done"].into_iter().flat_map(|word| {
                    let token = match word {
                        "note" => EditorToken::Comment,
                        _ => EditorToken::Keyword,
                    };
                    line.match_indices(word)
                        .map(move |(at, _)| (at..at + word.len(), token))
                });
                let mut found: Vec<_> = found.collect();
                found.sort_by_key(|(r, _)| r.start);
                tokens.line(index, found);
                self.dirty = match newline {
                    true => index + 1,
                    false => usize::MAX,
                };
                return self.dirty > last_line;
            }
            if !newline {
                return true;
            }
            offset += line.len();
            index += 1;
        }
    }

    fn frontier(&self) -> usize {
        self.dirty
    }
}

fn register() {
    register_language(&NOTES);
    register_highlighter("notes", || Box::new(Notes::default()));
}

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The editor's `language`.
    language: String,
    /// Its first text.
    text: String,
    /// The root registers the notes before it mounts the editor.
    register: bool,
    /// The root registers the notes' highlighter for Rust.
    rust_notes: bool,
    /// A diff view of the text against an empty one in place of the
    /// editor.
    diff: bool,
}

fn props(language: &str, text: &str) -> HarnessProps {
    HarnessProps {
        language: language.into(),
        text: text.into(),
        register: true,
        rust_notes: false,
        diff: false,
    }
}

/// An editor (or a diff view) of 600 × 300 in a view `editor`, and the
/// text the app heard (`Value "…"`).
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    if props.register {
        register();
    }
    if props.rust_notes {
        register_highlighter("rs", || Box::new(Notes::default()));
    }
    let value = signal(props.text.clone());
    let language = SharedString::from(props.language.clone());
    let shown = match props.diff {
        true => diff_view()
            .language(language)
            .old_value(SharedString::from(""))
            .new_value(SharedString::from(props.text.clone()))
            .size_full()
            .into_element(),
        false => editor()
            .language(language)
            .default_value(props.text.clone())
            .on_change(move |text: &SharedString| value.set(text.to_string()))
            .size_full()
            .into_element(),
    };
    view()
        .child(
            view()
                .test_id("editor")
                .w(px(600.0))
                .h(px(300.0))
                .child(shown),
        )
        .child(text(move || format!("Value {:?}", value.get())))
}

/// The harness of `props` on a Linux desktop's headless surface, with
/// `ui_sets`, shown.
fn start_with(props: HarnessProps, ui_sets: Vec<Registry>) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(600.0)),
        ui_sets,
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:/^Value /").unwrap();
    app
}

fn start(props: HarnessProps) -> Headless {
    start_with(props, Vec::new())
}

/// Whether the editor shows `word` in italic (a comment's color).
fn italic(app: &Headless, word: &str) -> bool {
    app.screen()
        .span_style(&format!("id:editor >> text:{word}"))
        .is_ok_and(|style| style.italic)
}

/// Waits until the editor shows `word` as a comment.
fn see_comment(app: &mut Headless, word: &str) {
    app.wait_until(
        &format!("{word} highlighted"),
        Duration::from_secs(5),
        |screen| {
            screen
                .span_style(&format!("id:editor >> text:{word}"))
                .is_ok_and(|style| style.italic)
        },
    )
    .unwrap();
}

#[test]
fn the_apps_highlighter_colors_a_registered_language() {
    let mut app = start(props("notes", "plain note\nall done"));
    see_comment(&mut app, "note");
    // `done` is a keyword: colored, not as the plain text around it.
    app.wait_until("done highlighted", Duration::from_secs(5), |screen| {
        let color = |word: &str| {
            screen
                .span_style(&format!("id:editor >> text:{word}"))
                .map(|style| style.color)
        };
        matches!((color("done"), color("all")), (Ok(done), Ok(all)) if done != all)
    })
    .unwrap();
    let screen = app.screen();
    assert!(!italic(&app, "plain"));
    let done = screen.span_style("id:editor >> text:done").unwrap();
    let all = screen.span_style("id:editor >> text:all").unwrap();
    assert_ne!(done.color, all.color);
    assert!(!done.italic);
}

#[test]
fn a_registered_language_is_found_by_extension_and_edits_by_its_rules() {
    let mut app = start(props("drafts/today.nts", "a note"));
    see_comment(&mut app, "note");
    // Its line comment is `%%`.
    app.type_text("id:editor", "").unwrap();
    app.press_key("mod+/").unwrap();
    app.wait_for(&format!("text:Value {:?}", "%% a note"))
        .unwrap();
    // The edited line is highlighted again: `note` moved and stays a
    // comment.
    see_comment(&mut app, "note");
}

#[test]
fn the_apps_highlighter_replaces_the_built_in_one_of_a_built_in_language() {
    // Registered by extension: Rust's highlighter is the app's.
    let mut app = start(HarnessProps {
        register: false,
        rust_notes: true,
        ..props("main.rs", "fn note() {}")
    });
    see_comment(&mut app, "note");
}

#[test]
fn a_diff_view_highlights_a_registered_language() {
    let mut app = start(HarnessProps {
        diff: true,
        ..props("notes", "one note\n")
    });
    see_comment(&mut app, "note");
}

#[test]
fn a_ui_set_registers_its_languages_in_its_setup() {
    let mut set = Registry::ui_set("test/notes");
    set.setup(register);
    let mut app = start_with(
        HarnessProps {
            register: false,
            ..props("notes", "a note")
        },
        vec![set],
    );
    see_comment(&mut app, "note");
}

#[test]
fn each_engine_keeps_its_own_languages() {
    let mut registered = start(props("notes", "a note"));
    let mut other = start(HarnessProps {
        register: false,
        ..props("notes", "a note")
    });
    see_comment(&mut registered, "note");
    other.wait(Duration::from_millis(200)).unwrap();
    // Plain text in the engine that registered nothing: no highlighting,
    // no `%%` comments.
    assert!(!italic(&other, "note"));
    other.type_text("id:editor", "").unwrap();
    other.press_key("mod+/").unwrap();
    other.wait(Duration::from_millis(50)).unwrap();
    assert!(other.shows(&format!("Value {:?}", "a note")));
}
