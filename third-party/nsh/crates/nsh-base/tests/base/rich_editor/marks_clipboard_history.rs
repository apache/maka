//! Marks (the starter's Mod-b / Mod-i), Markdown input rules, the
//! clipboard (Markdown pastes and copies) and the history, as ProseMirror
//! behaves.

use std::time::Duration;

use super::*;

/// [`start`] for documents that may hold bold text already.
fn start_any(doc: Value) -> Headless {
    let session = session(doc);
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps {
            session: Some(session.clone()),
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Sel 1-1").unwrap();
    app
}

/// Focuses the editor, the caret at the document's first position.
fn focus(app: &mut Headless) {
    app.type_text("id:editor", "").unwrap();
}

fn typed(app: &mut Headless, text: &str) {
    app.type_text("id:editor", text).unwrap();
}

fn tree(app: &mut Headless, tree: &str) {
    see(app, &format!("Tree {tree}"));
}

fn select_right(app: &mut Headless, n: usize) {
    for _ in 0..n {
        keys(app, &["shift+right"]);
    }
}

fn paste(app: &mut Headless, text: &str) {
    let mut paste = PasteEvent::default();
    paste.text = text.into();
    app.paste("id:editor", &paste).unwrap();
}

// Marks.

#[test]
fn mod_b_bolds_a_range() {
    let mut app = start(paragraphs(&["hello world"]));
    focus(&mut app);
    select_right(&mut app, 5);
    see(&mut app, "Sel 1-6");
    keys(&mut app, &["mod+b"]);
    tree(&mut app, r#"doc(paragraph(bold("hello"), " world"))"#);
    see(&mut app, "Sel 1-6");
}

#[test]
fn mod_i_italicizes_a_range() {
    let mut app = start(paragraphs(&["hello world"]));
    focus(&mut app);
    select_right(&mut app, 5);
    keys(&mut app, &["mod+i"]);
    tree(&mut app, r#"doc(paragraph(italic("hello"), " world"))"#);
}

#[test]
fn mod_b_on_a_range_partly_bold_removes_then_adds_it() {
    let mut app = start_any(
        json!({"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "he", "marks": [{"type": "bold"}]},
            {"type": "text", "text": "llo"}
        ]}]}),
    );
    tree(&mut app, r#"doc(paragraph(bold("he"), "llo"))"#);
    focus(&mut app);
    select_right(&mut app, 5);
    // ProseMirror: toggleMark's removeWhenPresent (the default) removes the
    // mark when any of the range has it; pressed again, it adds it.
    keys(&mut app, &["mod+b"]);
    tree(&mut app, r#"doc(paragraph("hello"))"#);
    keys(&mut app, &["mod+b"]);
    tree(&mut app, r#"doc(paragraph(bold("hello")))"#);
}

#[test]
fn mod_b_across_two_blocks_bolds_both() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    focus(&mut app);
    keys(&mut app, &["mod+a", "mod+b"]);
    tree(
        &mut app,
        r#"doc(paragraph(bold("ab")), paragraph(bold("cd")))"#,
    );
    see(&mut app, "Bold 2");
}

#[test]
fn mod_b_at_the_caret_bolds_what_is_typed_next() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["end", "mod+b"]);
    // ProseMirror: a stored mark, the document unchanged.
    tree(&mut app, r#"doc(paragraph("ab"))"#);
    typed(&mut app, "X");
    tree(&mut app, r#"doc(paragraph("ab", bold("X")))"#);
    see(&mut app, "Sel 4-4");
}

#[test]
fn mod_b_twice_at_the_caret_cancels() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["end", "mod+b", "mod+b"]);
    typed(&mut app, "X");
    tree(&mut app, r#"doc(paragraph("abX"))"#);
    see(&mut app, "Bold 0");
}

// The starter's `code` mark excludes every other mark (Tiptap's
// `excludes: "_"`). Typed blocks get the trailing paragraph after them.

// Markdown input rules.

#[test]
fn hashes_and_a_space_make_headings() {
    for hashes in ["#", "##", "###"] {
        let mut app = start(paragraphs(&[""]));
        typed(&mut app, &format!("{hashes} Title"));
        tree(&mut app, r#"doc(heading("Title"), paragraph)"#);
        see(&mut app, "Types heading,paragraph");
    }
}

#[test]
fn a_greater_than_sign_makes_a_quote() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "> q");
    tree(&mut app, r#"doc(blockquote(paragraph("q")), paragraph)"#);
}

#[test]
fn a_dash_or_a_star_makes_a_bullet_list() {
    for bullet in ["-", "*"] {
        let mut app = start(paragraphs(&[""]));
        typed(&mut app, &format!("{bullet} a"));
        tree(
            &mut app,
            r#"doc(bulletList(listItem(paragraph("a"))), paragraph)"#,
        );
    }
}

#[test]
fn a_number_makes_an_ordered_list_from_that_number() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "1. a");
    tree(
        &mut app,
        r#"doc(orderedList(listItem(paragraph("a"))), paragraph)"#,
    );
    see(&mut app, "1.");

    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "3. a");
    tree(
        &mut app,
        r#"doc(orderedList(listItem(paragraph("a"))), paragraph)"#,
    );
    see(&mut app, "3.");
}

#[test]
fn a_fence_makes_a_code_block_where_rules_do_not_fire() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "``` ");
    see(&mut app, "Types codeBlock,paragraph");
    typed(&mut app, "# **b** - ");
    tree(&mut app, r##"doc(codeBlock("# **b** - "), paragraph)"##);
    see(&mut app, "Bold 0");
}

#[test]
fn three_dashes_make_a_horizontal_rule() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "---");
    // `--` is an em dash first; Tiptap's rule takes `—-` as `---`.
    tree(&mut app, "doc(horizontalRule, paragraph)");
}

#[test]
fn delimiters_typed_around_text_make_marks() {
    let cases = [
        ("a **b** c", r#"doc(paragraph("a ", bold("b"), " c"))"#),
        ("a *i* c", r#"doc(paragraph("a ", italic("i"), " c"))"#),
        ("a `x` c", r#"doc(paragraph("a ", code("x"), " c"))"#),
        ("a ~~s~~ c", r#"doc(paragraph("a ", strike("s"), " c"))"#),
        (
            "a [t](https://x.y) c",
            r#"doc(paragraph("a ", link("t"), " c"))"#,
        ),
    ];
    for (text, expected) in cases {
        let mut app = start(paragraphs(&[""]));
        typed(&mut app, text);
        tree(&mut app, expected);
    }
}

#[test]
fn backspace_right_after_a_rule_restores_the_typed_text() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "# ");
    see(&mut app, "Types heading,paragraph");
    keys(&mut app, &["backspace"]);
    tree(&mut app, r##"doc(paragraph("# "), paragraph)"##);
    see(&mut app, "Sel 3-3");

    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "- ");
    see(&mut app, "Types bulletList,paragraph");
    keys(&mut app, &["backspace"]);
    tree(&mut app, r##"doc(paragraph("- "), paragraph)"##);
    see(&mut app, "Sel 3-3");
}

// The clipboard.

#[test]
fn pasted_lines_become_paragraphs() {
    let mut app = start(paragraphs(&[""]));
    paste(&mut app, "one\ntwo");
    tree(&mut app, r#"doc(paragraph("one"), paragraph("two"))"#);
    see(&mut app, "Sel 9-9");
}

#[test]
fn pasted_markdown_becomes_blocks_and_marks() {
    let mut app = start(paragraphs(&[""]));
    paste(&mut app, "# T\n\n- **a**\n- b");
    tree(
        &mut app,
        r#"doc(heading("T"), bulletList(listItem(paragraph(bold("a"))), listItem(paragraph("b"))), paragraph)"#,
    );
}

#[test]
fn a_paste_into_a_list_item_stays_in_it() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "bulletList", "content": [item("a", None)]}
    ]}));
    focus(&mut app);
    keys(&mut app, &["ctrl+end"]);
    see(&mut app, "Sel 4-4");
    paste(&mut app, "x\ny");
    // ProseMirror: the open paragraphs fit into the item's paragraph.
    tree(
        &mut app,
        r#"doc(bulletList(listItem(paragraph("ax"), paragraph("y"))), paragraph)"#,
    );
}

#[test]
fn a_paste_into_a_code_block_keeps_the_raw_text() {
    let mut app = start(json!({"type": "doc", "content": [{"type": "codeBlock"}]}));
    focus(&mut app);
    paste(&mut app, "# T\n- **a**");
    tree(&mut app, r##"doc(codeBlock("# T\n- **a**"), paragraph)"##);
    see(&mut app, "Bold 0");
}

fn paste_html(app: &mut Headless, text: &str, html: &str) {
    let mut paste = PasteEvent::default();
    paste.text = text.into();
    paste.html = html.into();
    app.paste("id:editor", &paste).unwrap();
}

#[test]
fn pasted_html_keeps_its_formatting() {
    let mut app = start(paragraphs(&[""]));
    paste_html(
        &mut app,
        "Title\nsome bold\nb",
        "<meta charset=\"utf-8\"><h2>Title</h2><p>some <strong>bold</strong></p><ul><li>b</li></ul>",
    );
    tree(
        &mut app,
        r#"doc(heading("Title"), paragraph("some ", bold("bold")), bulletList(listItem(paragraph("b"))), paragraph)"#,
    );
}

#[test]
fn pasted_google_docs_html_reads_its_styles() {
    let mut app = start(paragraphs(&[""]));
    paste_html(
        &mut app,
        "bold plain",
        "<b style=\"font-weight:normal;\" id=\"docs-internal-guid-1\"><span style=\"font-weight:700\">bold</span><span style=\"font-weight:400\"> plain</span></b>",
    );
    tree(&mut app, r#"doc(paragraph(bold("bold"), " plain"))"#);
}

#[test]
fn pasted_inline_html_merges_into_the_paragraph() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 2-2");
    paste_html(&mut app, "x", "<p><em>x</em></p>");
    tree(&mut app, r#"doc(paragraph("a", italic("x"), "b"))"#);
    see(&mut app, "Sel 3-3");
}

#[test]
fn html_pasted_into_a_code_block_is_its_text() {
    let mut app = start(json!({"type": "doc", "content": [{"type": "codeBlock"}]}));
    focus(&mut app);
    paste_html(&mut app, "a *b*", "<p>a <b>b</b></p>");
    tree(&mut app, r#"doc(codeBlock("a *b*"), paragraph)"#);
}

#[test]
fn pasted_inline_markdown_merges_into_the_paragraph() {
    let mut app = start(paragraphs(&["ab"]));
    focus(&mut app);
    keys(&mut app, &["right"]);
    paste(&mut app, "**x**");
    tree(&mut app, r#"doc(paragraph("a", bold("x"), "b"))"#);
}

#[test]
fn a_paste_replaces_the_selection() {
    let mut app = start(paragraphs(&["hello world"]));
    focus(&mut app);
    select_right(&mut app, 5);
    paste(&mut app, "bye");
    tree(&mut app, r#"doc(paragraph("bye world"))"#);
    see(&mut app, "Sel 4-4");
}

#[test]
fn copy_writes_markdown() {
    let mut app = start_any(json!({"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Head"}]},
        {"type": "paragraph", "content": [
            {"type": "text", "text": "some "},
            {"type": "text", "text": "bold", "marks": [{"type": "bold"}]},
            {"type": "text", "text": " text"}
        ]}
    ]}));
    focus(&mut app);
    keys(&mut app, &["mod+a", "mod+c"]);
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(
        app.screen().clipboard(),
        Some("## Head\n\nsome **bold** text")
    );
}

// The history.

#[test]
fn undo_and_redo_with_both_redo_keys() {
    let mut app = start(paragraphs(&["x"]));
    typed(&mut app, "abc");
    tree(&mut app, r#"doc(paragraph("abcx"))"#);
    see(&mut app, "Sel 4-4");
    keys(&mut app, &["mod+z"]);
    tree(&mut app, r#"doc(paragraph("x"))"#);
    // ProseMirror: undo restores the selection from before the change.
    see(&mut app, "Sel 1-1");
    keys(&mut app, &["mod+shift+z"]);
    tree(&mut app, r#"doc(paragraph("abcx"))"#);
    keys(&mut app, &["mod+z"]);
    tree(&mut app, r#"doc(paragraph("x"))"#);
    // Mod-y redoes off macOS.
    keys(&mut app, &["mod+y"]);
    tree(&mut app, r#"doc(paragraph("abcx"))"#);
}

#[test]
fn typing_elsewhere_starts_a_new_undo_group() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "ab");
    keys(&mut app, &["home"]);
    typed(&mut app, "c");
    tree(&mut app, r#"doc(paragraph("cab"))"#);
    keys(&mut app, &["mod+z"]);
    tree(&mut app, r#"doc(paragraph("ab"))"#);
    keys(&mut app, &["mod+z"]);
    tree(&mut app, "doc(paragraph)");
}

#[test]
fn a_pause_starts_a_new_undo_group() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "ab");
    // Transactions take the wall clock's time, not the app's manual
    // clock: the pause is real (the history's delay is 500 ms).
    std::thread::sleep(Duration::from_millis(600));
    typed(&mut app, "cd");
    tree(&mut app, r#"doc(paragraph("abcd"))"#);
    keys(&mut app, &["mod+z"]);
    tree(&mut app, r#"doc(paragraph("ab"))"#);
    see(&mut app, "Sel 3-3");
}

#[test]
fn undo_takes_back_an_enter_in_a_list() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "bulletList", "content": [item("a", None)]}
    ]}));
    focus(&mut app);
    keys(&mut app, &["ctrl+end", "enter"]);
    tree(
        &mut app,
        r#"doc(bulletList(listItem(paragraph("a")), listItem(paragraph)), paragraph)"#,
    );
    keys(&mut app, &["mod+z"]);
    tree(
        &mut app,
        r#"doc(bulletList(listItem(paragraph("a"))), paragraph)"#,
    );
    see(&mut app, "Sel 4-4");
}

#[test]
fn new_typing_clears_redo() {
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "ab");
    keys(&mut app, &["mod+z"]);
    tree(&mut app, "doc(paragraph)");
    typed(&mut app, "c");
    keys(&mut app, &["mod+shift+z"]);
    app.wait(Duration::from_millis(50)).unwrap();
    tree(&mut app, r#"doc(paragraph("c"))"#);
}
