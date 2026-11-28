//! `codeBlockHighlight`: code blocks naming a language are colored as
//! `TextView`'s fenced code is (feature `highlight`), the others stay
//! plain, and an editor without the extension leaves them all plain.

use nsh_base::rich_editor::extensions::code_block::CODE_BLOCK_HIGHLIGHT;

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
