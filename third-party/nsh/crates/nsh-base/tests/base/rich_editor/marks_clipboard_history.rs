//! Marks (the starter's Mod-b / Mod-i), Markdown input rules, the
//! clipboard (Markdown pastes and copies) and the history, as ProseMirror
//! behaves.

use std::time::Duration;

use super::*;

/// [`start`] for documents that may hold bold text already.
fn start_any(doc: Value) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        // Made in the engine, as `start`'s.
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            HarnessProps {
                session: Some(session(doc.clone())),
            }
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Sel 1-1").unwrap();
    app
}

/// [`start`] on a manual clock, which moves only as the test moves it.
fn start_manual(doc: Value) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            HarnessProps {
                session: Some(session(doc.clone())),
            }
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
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
    // A paragraph follows, so no trailing paragraph is appended after the
    // rule and it stays undoable.
    let mut app = start(paragraphs(&["", "x"]));
    typed(&mut app, "# ");
    see(&mut app, "Types heading,paragraph");
    keys(&mut app, &["backspace"]);
    tree(&mut app, r##"doc(paragraph("# "), paragraph("x"))"##);
    see(&mut app, "Sel 3-3");

    let mut app = start(paragraphs(&["", "x"]));
    typed(&mut app, "- ");
    see(&mut app, "Types bulletList,paragraph");
    keys(&mut app, &["backspace"]);
    tree(&mut app, r##"doc(paragraph("- "), paragraph("x"))"##);
    see(&mut app, "Sel 3-3");
}

#[test]
fn a_trailing_paragraph_appended_after_a_rule_ends_its_undo() {
    // As Tiptap's input rules plugin: any later change to the document,
    // the trailing node's appended paragraph too, forgets the rule, and
    // Backspace at the start of the heading turns it into a paragraph.
    let mut app = start(paragraphs(&[""]));
    typed(&mut app, "# ");
    see(&mut app, "Types heading,paragraph");
    keys(&mut app, &["backspace"]);
    tree(&mut app, "doc(paragraph, paragraph)");
    see(&mut app, "Sel 1-1");
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
fn dropped_text_goes_in_where_it_is_let_go() {
    let mut app = start(paragraphs(&[""]));
    app.drop_text("id:editor", "dropped", "").unwrap();
    tree(&mut app, r#"doc(paragraph("dropped"))"#);
}

#[test]
fn dropped_html_keeps_its_formatting() {
    let mut app = start(paragraphs(&[""]));
    app.drop_text(
        "id:editor",
        "some bold",
        "<p>some <strong>bold</strong></p>",
    )
    .unwrap();
    tree(&mut app, r#"doc(paragraph("some ", bold("bold")))"#);
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
    let _ = app.wait_until("the copy", Duration::from_secs(5), |s| {
        s.clipboard().is_some()
    });
    assert_eq!(
        app.screen().clipboard(),
        Some("## Head\n\nsome **bold** text")
    );
}

/// Copies the selection: the clipboard's text and HTML.
fn copied(app: &mut Headless) -> (String, String) {
    keys(app, &["mod+c"]);
    let _ = app.wait_until("the copy", Duration::from_secs(5), |s| {
        s.clipboard_item()
            .and_then(|item| item.html.as_deref())
            .is_some()
    });
    (
        app.screen().clipboard().expect("copied text").to_owned(),
        app.screen()
            .clipboard_item()
            .and_then(|item| item.html.as_deref())
            .expect("copied HTML")
            .to_owned(),
    )
}

#[test]
fn copy_writes_html_with_its_slice() {
    let mut app = start_any(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [
            {"type": "text", "text": "some "},
            {"type": "text", "text": "bold", "marks": [{"type": "bold"}]},
            {"type": "text", "text": " text"}
        ]}
    ]}));
    focus(&mut app);
    select_right(&mut app, 9);
    let (text, html) = copied(&mut app);
    assert_eq!(text, "some **bold**");
    // ProseMirror's: open in the paragraph on both sides, no context.
    assert_eq!(
        html,
        r#"<p data-pm-slice="1 1 []">some <strong>bold</strong></p>"#
    );
}

#[test]
fn a_cut_writes_html_and_pastes_back_as_it_was() {
    let mut app = start_any(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [
            {"type": "text", "text": "some "},
            {"type": "text", "text": "bold", "marks": [{"type": "bold"}]}
        ]},
        {"type": "paragraph", "content": [{"type": "text", "text": "x"}]}
    ]}));
    focus(&mut app);
    keys(&mut app, &["right", "right", "right", "right", "right"]);
    select_right(&mut app, 4);
    keys(&mut app, &["mod+x"]);
    let _ = app.wait_until("the cut", Duration::from_secs(5), |s| {
        s.clipboard_item()
            .and_then(|item| item.html.as_deref())
            .is_some()
    });
    assert_eq!(
        app.screen()
            .clipboard_item()
            .and_then(|item| item.html.as_deref()),
        Some(r#"<p data-pm-slice="1 1 []"><strong>bold</strong></p>"#)
    );
    tree(&mut app, r#"doc(paragraph("some "), paragraph("x"))"#);
    let text = app.screen().clipboard().expect("cut text").to_owned();
    let html = app
        .screen()
        .clipboard_item()
        .and_then(|item| item.html.as_deref())
        .expect("cut HTML")
        .to_owned();
    paste_html(&mut app, &text, &html);
    tree(
        &mut app,
        r#"doc(paragraph("some ", bold("bold")), paragraph("x"))"#,
    );
}

#[test]
fn a_copied_mention_pastes_as_a_mention() {
    let mut app = start_any(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [
            {"type": "text", "text": "hi "},
            {"type": "mention", "attrs": {"id": "a", "label": "Alice"}},
            {"type": "text", "text": " x"}
        ]},
        {"type": "paragraph"}
    ]}));
    focus(&mut app);
    select_right(&mut app, 4);
    let (text, html) = copied(&mut app);
    keys(&mut app, &["ctrl+end"]);
    paste_html(&mut app, &text, &html);
    tree(
        &mut app,
        r#"doc(paragraph("hi ", mention, " x"), paragraph("hi ", mention))"#,
    );
}

#[test]
fn text_copied_from_the_editor_keeps_its_spaces() {
    let mut app = start_any(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "a  b"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "x"}]}
    ]}));
    focus(&mut app);
    select_right(&mut app, 4);
    let (text, html) = copied(&mut app);
    keys(&mut app, &["ctrl+end"]);
    // HTML an editor copied keeps its whitespace (ProseMirror's
    // `preserveWhitespace` for a `data-pm-slice`); other HTML collapses it.
    paste_html(&mut app, &text, &html);
    tree(&mut app, r#"doc(paragraph("a  b"), paragraph("xa  b"))"#);
}

#[test]
fn part_of_two_list_items_pastes_back_as_it_was() {
    let doc = json!({"type": "doc", "content": [
        {"type": "bulletList", "content": [item("ab", None), item("cd", None)]}
    ]});
    let mut app = start(doc);
    focus(&mut app);
    keys(&mut app, &["right"]);
    // From after `a` to after `c`, across the items.
    select_right(&mut app, 3);
    let (text, html) = copied(&mut app);
    // A paste over the same selection leaves the document as it was:
    // the slice comes back with its open depths, no list around the list.
    paste_html(&mut app, &text, &html);
    tree(
        &mut app,
        r#"doc(bulletList(listItem(paragraph("ab")), listItem(paragraph("cd"))), paragraph)"#,
    );
}

#[test]
fn text_copied_in_a_list_item_pastes_inline() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "bulletList", "content": [item("abc", None)]},
        {"type": "paragraph", "content": [{"type": "text", "text": "x"}]}
    ]}));
    focus(&mut app);
    keys(&mut app, &["right"]);
    select_right(&mut app, 1);
    let (_, html) = copied(&mut app);
    // The list and its item are the slice's context, not its content.
    assert_eq!(
        html,
        r#"<p data-pm-slice="1 1 [&quot;bulletList&quot;,null,&quot;listItem&quot;,null]">b</p>"#
    );
    keys(&mut app, &["ctrl+end"]);
    paste_html(&mut app, "b", &html);
    tree(
        &mut app,
        r#"doc(bulletList(listItem(paragraph("abc"))), paragraph("xb"))"#,
    );
}

#[test]
fn copy_with_nothing_selected_preserves_existing_clipboard() {
    let mut app = start(paragraphs(&["hello"]));
    app.set_clipboard(Some("page output".into()));
    focus(&mut app);
    keys(&mut app, &["mod+c"]);
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(app.screen().clipboard(), Some("page output"));

    select_right(&mut app, 3);
    keys(&mut app, &["mod+c"]);
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(app.screen().clipboard(), Some("hel"));
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
    let mut app = start_manual(paragraphs(&[""]));
    typed(&mut app, "ab");
    // Past the history's delay (500 ms) on the engine's clock, which
    // transactions take their time from (`Date.now()` on the web).
    app.fast_forward(Duration::from_millis(600)).unwrap();
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
