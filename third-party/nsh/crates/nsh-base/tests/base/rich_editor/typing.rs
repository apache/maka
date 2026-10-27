//! Typing and text, as ProseMirror behaves: insertion at the caret, typing
//! over selections, stored marks, mark inclusivity at mark boundaries,
//! deletion by grapheme cluster, UTF-16 positions, input method
//! composition, the placeholder, read-only editors and typing over a
//! selected atom.

use std::time::Duration;

use nsh_core::{EventKind, EventPayload, PayloadValue};

use super::*;

fn tree(s: &str) -> String {
    format!("Tree {s}")
}

fn text_doc(content: Value) -> Value {
    json!({"type": "doc", "content": [{"type": "paragraph", "content": content}]})
}

fn bold(t: &str) -> Value {
    json!({"type": "text", "text": t, "marks": [{"type": "bold"}]})
}

fn plain(t: &str) -> Value {
    json!({"type": "text", "text": t})
}

/// Focuses the editor without typing.
fn focus(app: &mut Headless) {
    app.type_text("id:editor", "").unwrap();
}

// Inserting.

#[test]
fn typing_at_the_start_inserts_before_the_text() {
    let mut app = start(paragraphs(&["ac"]));
    focus(&mut app);
    keys(&mut app, &["home"]);
    see(&mut app, "Sel 1-1");
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("xac"))"#));
    see(&mut app, "Sel 2-2");
}

#[test]
fn typing_in_the_middle_inserts_at_the_caret() {
    let mut app = start(paragraphs(&["ac"]));
    focus(&mut app);
    keys(&mut app, &["home", "right"]);
    app.type_text("id:editor", "b").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("abc"))"#));
    see(&mut app, "Sel 3-3");
}

#[test]
fn typing_at_the_end_appends() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["end"]);
    app.type_text("id:editor", "cd").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("abcd"))"#));
    see(&mut app, "Sel 5-5");
}

#[test]
fn typing_in_the_second_block_leaves_the_first() {
    let mut app = start(paragraphs(&["one", "two"]));
    focus(&mut app);
    keys(&mut app, &["ctrl+end"]);
    app.type_text("id:editor", "!").unwrap();
    see(
        &mut app,
        &tree(r#"doc(paragraph("one"), paragraph("two!"))"#),
    );
    see(&mut app, "Sel 10-10");
}

// Typing over a selection.

#[test]
fn typing_replaces_a_selection_in_a_block() {
    let mut app = start(paragraphs(&["abcd"]));
    focus(&mut app);
    keys(&mut app, &["home", "right", "shift+right", "shift+right"]);
    see(&mut app, "Sel 2-4");
    app.type_text("id:editor", "X").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("aXd"))"#));
    see(&mut app, "Sel 3-3");
}

#[test]
fn typing_replaces_a_selection_across_blocks_and_joins_them() {
    let mut app = start(paragraphs(&["abc", "def"]));
    focus(&mut app);
    keys(&mut app, &["ctrl+home", "right"]);
    for _ in 0..5 {
        keys(&mut app, &["shift+right"]);
    }
    see(&mut app, "Sel 2-8");
    app.type_text("id:editor", "X").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("aXf"))"#));
    see(&mut app, "Types paragraph");
    see(&mut app, "Sel 3-3");
}

#[test]
fn typing_over_select_all_leaves_one_paragraph() {
    let mut app = start(paragraphs(&["one", "two", "three"]));
    focus(&mut app);
    keys(&mut app, &["mod+a"]);
    app.type_text("id:editor", "x").unwrap();
    // ProseMirror: replacing an AllSelection with text fits it into the
    // default textblock.
    see(&mut app, &tree(r#"doc(paragraph("x"))"#));
    see(&mut app, "Sel 2-2");
}

#[test]
fn typed_text_over_a_bold_selection_stays_bold() {
    let mut app = start(text_doc(json!([plain("a"), bold("bc"), plain("d")])));
    focus(&mut app);
    keys(&mut app, &["home", "right", "shift+right", "shift+right"]);
    see(&mut app, "Sel 2-4");
    app.type_text("id:editor", "X").unwrap();
    // ProseMirror: insertText over a range takes the marks shared across
    // it (`marksAcross`).
    see(&mut app, &tree(r#"doc(paragraph("a", bold("X"), "d"))"#));
}

// Stored marks.

#[test]
fn mod_b_at_a_cursor_makes_the_next_text_bold() {
    let mut app = start(paragraphs(&[""]));
    app.type_text("id:editor", "a").unwrap();
    keys(&mut app, &["mod+b"]);
    app.type_text("id:editor", "b").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("a", bold("b")))"#));
    see(&mut app, "Bold 1");
    see(&mut app, "Sel 3-3");
}

#[test]
fn mod_b_twice_at_a_cursor_types_plain_text() {
    let mut app = start(paragraphs(&["a"]));
    focus(&mut app);
    keys(&mut app, &["end", "mod+b", "mod+b"]);
    app.type_text("id:editor", "b").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("ab"))"#));
}

#[test]
fn mod_b_inside_bold_text_types_plain_text() {
    let mut app = start(text_doc(json!([bold("ab")])));
    focus(&mut app);
    keys(&mut app, &["end", "mod+b"]);
    app.type_text("id:editor", "c").unwrap();
    see(&mut app, &tree(r#"doc(paragraph(bold("ab"), "c"))"#));
}

#[test]
fn moving_the_caret_drops_stored_marks() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["end", "mod+b", "left"]);
    app.type_text("id:editor", "x").unwrap();
    // ProseMirror: a selection change clears the stored marks.
    see(&mut app, &tree(r#"doc(paragraph("axb"))"#));
    see(&mut app, "Bold 0");
}

#[test]
fn stored_marks_combine_in_schema_order() {
    let mut app = start(paragraphs(&[""]));
    focus(&mut app);
    keys(&mut app, &["mod+b", "mod+i"]);
    app.type_text("id:editor", "x").unwrap();
    // ProseMirror: marks are kept sorted by their rank in the schema
    // (link, italic, bold, code) and `toString` wraps the first outermost.
    see(&mut app, &tree(r#"doc(paragraph(italic(bold("x"))))"#));
}

// Inclusivity.

#[test]
fn typing_right_after_bold_continues_bold() {
    let mut app = start(text_doc(json!([bold("ab"), plain("c")])));
    focus(&mut app);
    keys(&mut app, &["home", "right", "right"]);
    see(&mut app, "Sel 3-3");
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &tree(r#"doc(paragraph(bold("abx"), "c"))"#));
}

#[test]
fn typing_at_the_end_of_a_bold_paragraph_continues_bold() {
    let mut app = start(text_doc(json!([bold("ab")])));
    focus(&mut app);
    keys(&mut app, &["end"]);
    app.type_text("id:editor", "c").unwrap();
    see(&mut app, &tree(r#"doc(paragraph(bold("abc")))"#));
}

#[test]
fn typing_at_the_start_of_a_bold_paragraph_is_bold() {
    let mut app = start(text_doc(json!([bold("ab")])));
    focus(&mut app);
    keys(&mut app, &["home"]);
    app.type_text("id:editor", "x").unwrap();
    // ProseMirror: at a parent's start `ResolvedPos.marks()` takes the
    // marks of the node after.
    see(&mut app, &tree(r#"doc(paragraph(bold("xab")))"#));
}

#[test]
fn typing_right_before_bold_after_plain_text_is_plain() {
    let mut app = start(text_doc(json!([plain("a"), bold("b")])));
    focus(&mut app);
    keys(&mut app, &["home", "right"]);
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("ax", bold("b")))"#));
}

#[test]
fn typing_at_the_end_of_a_link_is_not_linked() {
    let mut app = start(text_doc(json!([
        plain("go "),
        {"type": "text", "text": "here", "marks": [{"type": "link", "attrs": {"href": "https://a.b"}}]}
    ])));
    focus(&mut app);
    keys(&mut app, &["end"]);
    app.type_text("id:editor", "!").unwrap();
    // ProseMirror: a mark with `inclusive: false` does not extend to text
    // typed at its end.
    see(
        &mut app,
        &tree(r#"doc(paragraph("go ", link("here"), "!"))"#),
    );
}

#[test]
fn typing_inside_a_link_is_linked() {
    let mut app = start(text_doc(json!([
        {"type": "text", "text": "ab", "marks": [{"type": "link", "attrs": {"href": "https://a.b"}}]},
        plain("c")
    ])));
    focus(&mut app);
    keys(&mut app, &["home", "right"]);
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &tree(r#"doc(paragraph(link("axb"), "c"))"#));
}

// Graphemes and UTF-16.

#[test]
fn backspace_deletes_a_skin_toned_emoji_whole() {
    let mut app = start(paragraphs(&["a👍🏽b"]));
    focus(&mut app);
    keys(&mut app, &["end"]);
    // 1 + 4 + 1 UTF-16 code units.
    see(&mut app, "Sel 7-7");
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 6-6");
    keys(&mut app, &["backspace"]);
    see(&mut app, &tree(r#"doc(paragraph("ab"))"#));
    see(&mut app, "Sel 2-2");
}

#[test]
fn delete_deletes_a_zwj_family_whole() {
    let mut app = start(paragraphs(&["x👨‍👩‍👧y"]));
    focus(&mut app);
    keys(&mut app, &["home", "right"]);
    see(&mut app, "Sel 2-2");
    keys(&mut app, &["delete"]);
    see(&mut app, &tree(r#"doc(paragraph("xy"))"#));
    see(&mut app, "Sel 2-2");
}

#[test]
fn arrows_step_over_a_zwj_family() {
    let mut app = start(paragraphs(&["x👨‍👩‍👧y"]));
    focus(&mut app);
    keys(&mut app, &["home", "right", "right"]);
    // 👨 ZWJ 👩 ZWJ 👧: 2 + 1 + 2 + 1 + 2 code units.
    see(&mut app, "Sel 10-10");
    keys(&mut app, &["shift+left"]);
    see(&mut app, "Sel 2-10");
}

#[test]
fn backspace_deletes_a_letter_with_its_combining_mark() {
    let mut app = start(paragraphs(&["ae\u{301}"]));
    focus(&mut app);
    keys(&mut app, &["end"]);
    see(&mut app, "Sel 4-4");
    keys(&mut app, &["backspace"]);
    see(&mut app, &tree(r#"doc(paragraph("a"))"#));
    see(&mut app, "Sel 2-2");
}

#[test]
fn backspace_deletes_one_cjk_character() {
    let mut app = start(paragraphs(&["中文字"]));
    focus(&mut app);
    keys(&mut app, &["end"]);
    see(&mut app, "Sel 4-4");
    keys(&mut app, &["backspace"]);
    see(&mut app, &tree(r#"doc(paragraph("中文"))"#));
    see(&mut app, "Sel 3-3");
}

#[test]
fn typed_cjk_counts_one_position_per_character() {
    let mut app = start(paragraphs(&[""]));
    app.type_text("id:editor", "你好").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("你好"))"#));
    see(&mut app, "Sel 3-3");
}

#[test]
fn typed_astral_text_counts_utf16_code_units() {
    let mut app = start(paragraphs(&[""]));
    app.type_text("id:editor", "😀a").unwrap();
    see(&mut app, &tree(r#"doc(paragraph("😀a"))"#));
    see(&mut app, "Sel 4-4");
}

#[test]
fn backspace_at_a_paragraph_start_joins_into_the_previous() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    focus(&mut app);
    keys(&mut app, &["ctrl+end", "home"]);
    see(&mut app, "Sel 5-5");
    keys(&mut app, &["backspace"]);
    see(&mut app, &tree(r#"doc(paragraph("abcd"))"#));
    see(&mut app, "Sel 3-3");
}

// Composition.

#[test]
fn composition_shows_its_text_without_changing_the_document() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["end"]);
    compose(&mut app, true, "に");
    compose(&mut app, true, "にほ");
    see(&mut app, "にほ");
    see(&mut app, &tree(r#"doc(paragraph("ab"))"#));
    see(&mut app, "Sel 3-3");
}

#[test]
fn committing_a_composition_inserts_its_text_as_one_undo_step() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["end"]);
    compose(&mut app, true, "にほん");
    app.type_text("id:editor", "日本").unwrap();
    compose(&mut app, false, "");
    see(&mut app, &tree(r#"doc(paragraph("ab日本"))"#));
    see(&mut app, "Sel 5-5");
    app.wait_for_gone("text:にほん", Duration::from_secs(5))
        .unwrap();
    keys(&mut app, &["mod+z"]);
    see(&mut app, &tree(r#"doc(paragraph("ab"))"#));
    see(&mut app, "Sel 3-3");
}

#[test]
fn a_cancelled_composition_leaves_the_document() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["end"]);
    compose(&mut app, true, "にほ");
    see(&mut app, "にほ");
    compose(&mut app, false, "");
    app.wait_for_gone("text:にほ", Duration::from_secs(5))
        .unwrap();
    see(&mut app, &tree(r#"doc(paragraph("ab"))"#));
    see(&mut app, "Sel 3-3");
}

#[test]
fn a_composition_over_a_selection_replaces_it() {
    let mut app = start(paragraphs(&["abcd"]));
    focus(&mut app);
    keys(&mut app, &["home", "right", "shift+right", "shift+right"]);
    see(&mut app, "Sel 2-4");
    compose(&mut app, true, "か");
    app.type_text("id:editor", "火").unwrap();
    compose(&mut app, false, "");
    see(&mut app, &tree(r#"doc(paragraph("a火d"))"#));
    see(&mut app, "Sel 3-3");
}

// Placeholder and read-only.

#[test]
fn the_placeholder_shows_while_the_document_is_empty() {
    let mut app = start_configured(paragraphs(&[""]), Some("Write here"), true);
    see(&mut app, "\u{200b}Write here");
    app.type_text("id:editor", "a").unwrap();
    see(&mut app, &doc("a"));
    app.wait_for_gone("text:Write here", Duration::from_secs(5))
        .unwrap();
    keys(&mut app, &["backspace"]);
    see(&mut app, &doc(""));
    see(&mut app, "\u{200b}Write here");
}

#[test]
fn the_placeholder_shows_in_the_current_empty_block() {
    // Tiptap's placeholder (`showOnlyCurrent`): the empty block with the
    // caret shows it, whatever else the document holds.
    let mut app = start_configured(paragraphs(&["", ""]), Some("Write here"), true);
    see(&mut app, "Sel 1-1");
    see(&mut app, "\u{200b}Write here");
}

#[test]
fn a_read_only_editor_ignores_typing_and_deleting() {
    let mut app = start_configured(paragraphs(&["ab"]), None, false);
    let _ = app.type_text("id:editor", "xyz");
    keys(&mut app, &["end", "backspace", "enter"]);
    let _ = app.type_text("id:editor", "q");
    app.wait(Duration::from_millis(200)).unwrap();
    see(&mut app, &doc("ab"));
    see(&mut app, "Types paragraph");
}

#[test]
fn a_read_only_editor_still_moves_the_caret() {
    let mut app = start_configured(paragraphs(&["ab"]), None, false);
    let _ = app.type_text("id:editor", "");
    keys(&mut app, &["end"]);
    see(&mut app, "Sel 3-3");
}

// Atoms.

#[test]
fn typing_over_a_selected_atom_replaces_it_with_a_paragraph() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "before"}]},
        {"type": "stock", "attrs": {"symbol": "AAPL"}}
    ]}));
    focus(&mut app);
    keys(&mut app, &["end", "right"]);
    see(&mut app, "Sel 8-9");
    app.type_text("id:editor", "x").unwrap();
    // ProseMirror: insertText over a NodeSelection of a block replaces it,
    // fitting the text into a new default textblock.
    see(
        &mut app,
        &tree(r#"doc(paragraph("before"), paragraph("x"), paragraph)"#),
    );
    see(&mut app, "Sel 10-10");
    assert!(!app.shows("Stock AAPL"));
}

#[test]
fn backspace_on_a_selected_atom_deletes_it() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "before"}]},
        {"type": "stock", "attrs": {"symbol": "AAPL"}}
    ]}));
    focus(&mut app);
    keys(&mut app, &["end", "right"]);
    see(&mut app, "Sel 8-9");
    keys(&mut app, &["backspace"]);
    // ProseMirror: deleteSelection removes the selected node.
    see(&mut app, "Types paragraph,paragraph");
    see(&mut app, &tree(r#"doc(paragraph("before"), paragraph)"#));
}

// Helpers.

/// An input method's composition in the editor's sink: started or
/// changed (`composing`) with `text`, or ended. The headless driver has
/// no composition step and does not expose an input's node id, so the
/// event goes to every node; only the sink listens to it.
fn compose(app: &mut Headless, composing: bool, text: &str) {
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::CompositionChange,
            EventPayload::Map(vec![
                ("composing", PayloadValue::Bool(composing)),
                ("text", PayloadValue::Str(text.to_owned())),
            ]),
        );
    }
    app.wait(Duration::from_millis(50)).unwrap();
}

#[derive(Clone, PartialEq, Props)]
struct ConfiguredProps {
    session: Option<EditorSession>,
    placeholder: Option<String>,
    editable: bool,
}

/// The harness's editor with a placeholder and `editable`.
#[component]
fn Configured(props: ConfiguredProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let read = {
        let session = session.clone();
        move || {
            let state = session.state();
            let doc = state.doc().clone();
            let types: Vec<String> = doc
                .content()
                .iter()
                .map(|n| n.ty().name().to_owned())
                .collect();
            let s = state.selection();
            (
                doc_text(&doc),
                types.join(","),
                format!("{}-{}", s.from(), s.to()),
            )
        }
    };
    let shown = signal(read());
    let (on_change, on_select) = (read.clone(), read);
    let mut editor = rich_editor()
        .editor(session)
        .editable(props.editable)
        .size_full()
        .on_change(move |_: &_| shown.set(on_change()))
        .on_selection_change(move |_: &_| shown.set(on_select()));
    if let Some(p) = props.placeholder.clone() {
        editor = editor.placeholder(SharedString::from(p));
    }
    view()
        .child(
            view()
                .test_id("editor")
                .w(px(600.0))
                .h(px(400.0))
                .child(editor),
        )
        .child(text(move || format!("Doc {:?}", shown.get().0)))
        .child(text(move || format!("Types {}", shown.get().1)))
        .child(text(move || format!("Sel {}", shown.get().2)))
}

fn start_configured(doc: Value, placeholder: Option<&str>, editable: bool) -> Headless {
    let types: Vec<&str> = doc["content"]
        .as_array()
        .map(|c| c.iter().filter_map(|n| n["type"].as_str()).collect())
        .unwrap_or_default();
    let ready = format!("text:Types {}", types.join(","));
    let session = session(doc);
    let placeholder = placeholder.map(str::to_owned);
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Configured>(move || ConfiguredProps {
            session: Some(session.clone()),
            placeholder: placeholder.clone(),
            editable,
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for(&ready).unwrap();
    app
}
