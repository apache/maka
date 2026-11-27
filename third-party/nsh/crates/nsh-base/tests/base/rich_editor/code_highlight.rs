//! `codeBlockHighlight`: code blocks naming a language are colored as
//! `TextView`'s fenced code is (feature `highlight`), the others stay
//! plain unless the extension gives them a language (`detect_language`,
//! then `defaultLanguage`), and an editor without the extension leaves
//! them all plain.

use std::sync::Mutex;

use nsh_base::rich_editor::{
    commands::CommandRegistry,
    extensions::{
        Extension,
        code_block::{CODE_BLOCK_HIGHLIGHT, CodeBlockHighlightOptions},
        kit,
    },
};

use super::*;

fn code_doc() -> Value {
    json!({"type": "doc", "content": [
        {"type": "codeBlock", "attrs": {"language": "rust"},
         "content": [{"type": "text", "text": "fn main() { let ok = \"héllo\"; }"}]},
        {"type": "codeBlock",
         "content": [{"type": "text", "text": "plain words"}]},
    ]})
}

fn color(app: &mut Headless, text: &str) -> nsh_core::Color {
    app.screen()
        .span_style(&format!("id:editor >> text:{text}"))
        .unwrap()
        .color
}

/// The color of `text` once the code is highlighted (off the engine
/// thread the first time), or after a while when it never is.
fn settled_color(app: &mut Headless, text: &str, plain: nsh_core::Color) -> nsh_core::Color {
    for _ in 0..100 {
        let now = color(app, text);
        if now != plain {
            return now;
        }
        app.wait(Duration::from_millis(50)).unwrap();
    }
    color(app, text)
}

#[test]
fn a_code_block_with_a_language_is_highlighted() {
    let mut app = start(code_doc());
    let plain = color(&mut app, "plain words");
    let keyword = settled_color(&mut app, "fn main", plain);
    assert_ne!(keyword, plain, "`fn` is colored");
    let title = color(&mut app, "main()");
    assert_ne!(title, plain, "`main` is colored");
    assert_ne!(keyword, title, "a keyword and a function name differ");
    // After the non-ASCII string the tokens still line up.
    assert_eq!(color(&mut app, "}"), plain);
    let string = color(&mut app, "\"héllo\"");
    assert_ne!(string, plain);
    assert_ne!(color(&mut app, "let ok"), string);
}

#[test]
fn a_language_with_a_fences_suffix_is_highlighted() {
    // Documents from other editors can keep a fence's whole info string
    // as the language: its first word names it.
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "codeBlock", "attrs": {"language": "rust,ignore"},
         "content": [{"type": "text", "text": "fn main() { let ok = 1; }"}]},
        {"type": "codeBlock", "attrs": {"language": "ts title=\"a.ts\""},
         "content": [{"type": "text", "text": "const s = \"x\";"}]},
    ]}));
    let (keyword, title) = settled_pair(&mut app, "fn main", "main()");
    assert_ne!(keyword, title, "`rust,ignore` colors the block");
    let (keyword, string) = settled_pair(&mut app, "const s", "\"x\"");
    assert_ne!(keyword, string, "`ts title=\"a.ts\"` colors the block");
}

#[test]
fn without_the_extension_code_stays_plain() {
    let mut app = start_session(
        || {
            let s = session(code_doc());
            let state = s.state();
            let plugins: Vec<_> = state
                .plugins()
                .iter()
                .filter(|p| p.key().name() != CODE_BLOCK_HIGHLIGHT)
                .cloned()
                .collect();
            let state = EditorState::create(
                EditorStateConfig::new(state.schema().clone())
                    .doc(state.doc().clone())
                    .plugins(plugins),
            )
            .unwrap();
            EditorSession::new(state, NodeViews::new())
        },
        Os::Linux,
        false,
        Idiom::Desktop,
    );
    let plain = color(&mut app, "plain words");
    app.wait(Duration::from_millis(300)).unwrap();
    assert_eq!(color(&mut app, "fn main"), plain);
    assert_eq!(color(&mut app, "main()"), plain);
}

/// A session of `doc` whose `codeBlockHighlight` plugin is `extension`'s.
fn session_highlighting(doc: Value, extension: &Extension) -> EditorSession {
    let s = session(doc);
    let state = s.state();
    let mut plugins: Vec<_> = state
        .plugins()
        .iter()
        .filter(|p| p.key().name() != CODE_BLOCK_HIGHLIGHT)
        .cloned()
        .collect();
    plugins.extend(extension.plugins(state.schema(), &CommandRegistry::builtin()));
    let state = EditorState::create(
        EditorStateConfig::new(state.schema().clone())
            .doc(state.doc().clone())
            .plugins(plugins),
    )
    .unwrap();
    EditorSession::new(state, NodeViews::new())
}

fn start_highlighting(session: EditorSession) -> Headless {
    start_session(move || session.clone(), Os::Linux, false, Idiom::Desktop)
}

/// The colors of `a` and `b` once they differ (the code highlighted, off
/// the engine thread the first time), or after a while when they never do.
fn settled_pair(app: &mut Headless, a: &str, b: &str) -> (nsh_core::Color, nsh_core::Color) {
    for _ in 0..100 {
        let pair = (color(app, a), color(app, b));
        if pair.0 != pair.1 {
            return pair;
        }
        app.wait(Duration::from_millis(50)).unwrap();
    }
    (color(app, a), color(app, b))
}

/// The languages blocks name in `session`'s document.
fn languages(session: &EditorSession) -> Vec<Value> {
    session
        .state()
        .doc()
        .content()
        .iter()
        .map(|n| n.attrs().get("language").cloned().unwrap_or(Value::Null))
        .collect()
}

fn unlabelled_doc() -> Value {
    json!({"type": "doc", "content": [
        {"type": "codeBlock", "attrs": {"language": "rust"},
         "content": [{"type": "text", "text": "fn one() {}"}]},
        {"type": "codeBlock",
         "content": [{"type": "text", "text": "fn main() { let ok = 1; }"}]},
        {"type": "codeBlock",
         "content": [{"type": "text", "text": "let x = \"s\";"}]},
    ]})
}

#[test]
fn a_block_without_a_language_takes_the_detected_one() {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let mut options = CodeBlockHighlightOptions::default();
    options.detect_language = Some({
        let asked = asked.clone();
        Arc::new(move |code: &str| {
            asked.lock().unwrap().push(code.to_owned());
            code.contains("fn ").then(|| "rust".to_owned())
        })
    });
    let session = session_highlighting(unlabelled_doc(), &kit::code_block_highlight_with(options));
    let mut app = start_highlighting(session.clone());

    let (keyword, title) = settled_pair(&mut app, "fn main", "main()");
    assert_ne!(keyword, title, "the detected language colors the block");
    // The guess is `None` for the last block, and nothing else names one:
    // it stays plain.
    app.wait(Duration::from_millis(300)).unwrap();
    assert_eq!(color(&mut app, "let x"), color(&mut app, "\"s\""));
    // The guess is the view's: the document names no language.
    assert_eq!(
        languages(&session),
        [json!("rust"), Value::Null, Value::Null]
    );
    // Asked once per unlabelled block, never for the one naming its own.
    let calls = |code: &str| asked.lock().unwrap().iter().filter(|c| *c == code).count();
    assert_eq!(calls("fn one() {}"), 0);
    assert_eq!(calls("fn main() { let ok = 1; }"), 1);
    assert_eq!(calls("let x = \"s\";"), 1);

    // A change of the code asks again, for the new code (the second
    // block's text ends at 14 + 25).
    let mut tr = session.state().tr();
    tr.insert_text(" // c", Some(39), None);
    session.dispatch(tr).unwrap();
    let edited = "fn main() { let ok = 1; } // c";
    for _ in 0..100 {
        if calls(edited) > 0 {
            break;
        }
        app.wait(Duration::from_millis(50)).unwrap();
    }
    assert_eq!(calls(edited), 1);
    let (keyword, title) = settled_pair(&mut app, "fn main", "main()");
    assert_ne!(keyword, title);
    assert_eq!(calls("fn one() {}"), 0);
}

#[test]
fn the_default_language_colors_blocks_without_one() {
    // `defaultLanguage` through `configure`, as TSX sets it; the detector
    // giving none falls back to it.
    let mut options = CodeBlockHighlightOptions::default();
    options.detect_language = Some(Arc::new(|_: &str| None));
    let extension =
        kit::code_block_highlight_with(options).configure(json!({ "defaultLanguage": "rust" }));
    let session = session_highlighting(unlabelled_doc(), &extension);
    let mut app = start_highlighting(session.clone());
    let (keyword, string) = settled_pair(&mut app, "let x", "\"s\"");
    assert_ne!(keyword, string, "the default language colors the block");
    assert_eq!(
        languages(&session),
        [json!("rust"), Value::Null, Value::Null]
    );
}

#[test]
fn the_detected_language_comes_before_the_default_one() {
    let mut options = CodeBlockHighlightOptions::default();
    options.default_language = Some("rust".into());
    // Plain text: no colors of its own.
    options.detect_language = Some(Arc::new(|_: &str| Some("txt".to_owned())));
    let session = session_highlighting(unlabelled_doc(), &kit::code_block_highlight_with(options));
    let mut app = start_highlighting(session);
    app.wait(Duration::from_millis(300)).unwrap();
    assert_eq!(color(&mut app, "let x"), color(&mut app, "\"s\""));
}
