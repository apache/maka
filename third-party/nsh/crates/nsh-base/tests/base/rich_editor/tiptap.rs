//! The starter's Tiptap behaviors on the state alone (no view): its key
//! bindings, the list keymap, the code block's keys, the trailing node and
//! clear document plugins, input rules, typography and paste rules.

use nsh_base::rich_editor::{
    commands::BoxCommand,
    extensions::{
        clear_document::clear_document,
        input_rules::input_rules,
        keymap::normalize_key_name,
        paste_rules::apply_paste_rules,
        starter,
        trailing_node::{TrailingNodeOptions, trailing_node},
        typography::{TypographyOptions, typography},
    },
    model::{Fragment, Node, Slice},
    state::{EditorState, EditorStateConfig, TextSelection},
};
use serde_json::{Value, json};

/// The document's shape: types with their children, text quoted, marks as
/// wrappers, and the attributes `level`, `start`, `checked`, `language`
/// and `textAlign` when set.
fn shape(node: &Node) -> String {
    if let Some(text) = node.text() {
        let mut out = format!("{text:?}");
        for mark in node.marks().iter().rev() {
            out = format!("{}({out})", mark.ty().name());
        }
        return out;
    }
    let mut name = node.ty().name().to_owned();
    let attrs: Vec<String> = ["level", "start", "checked", "language", "textAlign", "src"]
        .iter()
        .filter_map(|k| {
            let v = node.attrs().get(*k)?;
            (!v.is_null()).then(|| format!("{k}={v}"))
        })
        .collect();
    if !attrs.is_empty() {
        name = format!("{name}{{{}}}", attrs.join(","));
    }
    if node.child_count() == 0 {
        return name;
    }
    let children: Vec<String> = node.content().iter().map(shape).collect();
    format!("{name}({})", children.join(", "))
}

fn p(text: &str) -> Value {
    match text.is_empty() {
        true => json!({"type": "paragraph"}),
        false => json!({"type": "paragraph", "content": [{"type": "text", "text": text}]}),
    }
}

fn block(ty: &str, text: &str) -> Value {
    let mut b = p(text);
    b["type"] = json!(ty);
    b
}

fn list(ty: &str, items: &[&str]) -> Value {
    let item = if ty == "taskList" {
        "taskItem"
    } else {
        "listItem"
    };
    let content: Vec<Value> = items
        .iter()
        .map(|t| json!({"type": item, "content": [p(t)]}))
        .collect();
    json!({"type": ty, "content": content})
}

/// A state of `content` with the cursor at `at` (and `to`), with the
/// starter's input rules and the plugins `extra` makes.
fn state_with(content: Vec<Value>, at: usize, to: Option<usize>, trailing: bool) -> EditorState {
    let schema = starter::schema();
    let doc = schema
        .node_from_json(&json!({"type": "doc", "content": content}))
        .unwrap();
    let mut plugins = vec![starter::input_rules(&schema)];
    if trailing {
        plugins.push(clear_document());
        plugins.push(trailing_node(TrailingNodeOptions::default()));
    }
    let state =
        EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins)).unwrap();
    let mut tr = state.tr();
    tr.set_selection(TextSelection::create(state.doc(), at, to));
    state.apply(tr).unwrap()
}

fn state(content: Vec<Value>, at: usize) -> EditorState {
    state_with(content, at, None, false)
}

fn binding(state: &EditorState, key: &str) -> BoxCommand {
    let want = normalize_key_name(key, false).unwrap();
    starter::keymap(state.schema())
        .into_iter()
        .find(|(name, _)| normalize_key_name(name, false).unwrap() == want)
        .unwrap_or_else(|| panic!("no binding {key}"))
        .1
}

/// Runs the binding of `key`: the state after it, or `None` when it did
/// not apply.
fn press(state: &EditorState, key: &str) -> Option<EditorState> {
    let command = binding(state, key);
    let mut out = None;
    if !command(state, Some(&mut |tr| out = Some(tr))) {
        return None;
    }
    Some(match out {
        Some(tr) => state.apply(tr).unwrap(),
        None => state.clone(),
    })
}

fn pressed(state: &EditorState, key: &str) -> EditorState {
    press(state, key).unwrap_or_else(|| panic!("{key} did not apply"))
}

fn type_text(state: &EditorState, text: &str) -> EditorState {
    let (from, to) = (state.selection().from(), state.selection().to());
    let mut out = None;
    let handled = state
        .plugins()
        .iter()
        .any(|plugin| plugin.handle_text_input(state, from, to, text, &mut |tr| out = Some(tr)));
    let tr = if handled {
        out.unwrap()
    } else {
        let mut tr = state.tr();
        tr.insert_text(text, Some(from), Some(to));
        tr
    };
    state.apply(tr).unwrap()
}

fn type_all(state: &EditorState, text: &str) -> EditorState {
    text.chars().fold(state.clone(), |state, ch| {
        type_text(&state, &ch.to_string())
    })
}

fn assert_doc(state: &EditorState, expected: &str) {
    assert_eq!(shape(state.doc()), expected);
}

fn empty() -> EditorState {
    state(vec![p("")], 1)
}

// Key bindings.

#[test]
fn mod_alt_digits_toggle_headings_and_mod_alt_0_makes_a_paragraph() {
    let s = pressed(&state(vec![p("a")], 1), "Mod-Alt-2");
    assert_doc(&s, r#"doc(heading{level=2}("a"))"#);
    let s = pressed(&s, "Mod-Alt-2");
    assert_doc(&s, r#"doc(paragraph("a"))"#);
    let s = pressed(&pressed(&s, "Mod-Alt-1"), "Mod-Alt-0");
    assert_doc(&s, r#"doc(paragraph("a"))"#);
}

#[test]
fn mod_shift_b_toggles_a_blockquote() {
    let s = pressed(&state(vec![p("a")], 1), "Mod-Shift-b");
    assert_doc(&s, r#"doc(blockquote(paragraph("a")))"#);
    assert_doc(&pressed(&s, "Mod-Shift-b"), r#"doc(paragraph("a"))"#);
}

#[test]
fn mod_shift_8_toggles_a_bullet_list_and_7_converts_it() {
    let s = pressed(&state(vec![p("a")], 1), "Mod-Shift-8");
    assert_doc(&s, r#"doc(bulletList(listItem(paragraph("a"))))"#);
    let s = pressed(&s, "Mod-Shift-7");
    assert_doc(&s, r#"doc(orderedList{start=1}(listItem(paragraph("a"))))"#);
    let s = pressed(&s, "Mod-Shift-7");
    assert_doc(&s, r#"doc(paragraph("a"))"#);
}

#[test]
fn toggling_a_list_joins_the_list_before() {
    let s = state(vec![list("bulletList", &["a"]), p("b")], 8);
    let s = pressed(&s, "Mod-Shift-8");
    assert_doc(
        &s,
        r#"doc(bulletList(listItem(paragraph("a")), listItem(paragraph("b"))))"#,
    );
}

#[test]
fn mod_shift_9_toggles_a_task_list_and_converts_a_bullet_list() {
    let s = pressed(&state(vec![p("a")], 1), "Mod-Shift-9");
    assert_doc(
        &s,
        r#"doc(taskList(taskItem{checked=false}(paragraph("a"))))"#,
    );
    let s = pressed(&state(vec![list("bulletList", &["a"])], 3), "Mod-Shift-9");
    assert_doc(
        &s,
        r#"doc(taskList(taskItem{checked=false}(paragraph("a"))))"#,
    );
}

#[test]
fn mod_alt_c_toggles_a_code_block() {
    let s = pressed(&state(vec![p("a")], 1), "Mod-Alt-c");
    assert_doc(&s, r#"doc(codeBlock("a"))"#);
    assert_doc(&pressed(&s, "Mod-Alt-c"), r#"doc(paragraph("a"))"#);
}

#[test]
fn mark_shortcuts_toggle_tiptaps_marks() {
    for (key, mark) in [
        ("Mod-b", "bold"),
        ("Mod-i", "italic"),
        ("Mod-u", "underline"),
        ("Mod-Shift-s", "strike"),
        ("Mod-e", "code"),
        ("Mod-Shift-h", "highlight"),
        ("Mod-,", "subscript"),
        ("Mod-.", "superscript"),
    ] {
        let s = pressed(&state_with(vec![p("ab")], 1, Some(3), false), key);
        assert_doc(&s, &format!(r#"doc(paragraph({mark}("ab")))"#));
    }
}

#[test]
fn subscript_and_superscript_exclude_each_other() {
    let s = pressed(&state_with(vec![p("ab")], 1, Some(3), false), "Mod-,");
    let s = pressed(&s, "Mod-.");
    assert_doc(&s, r#"doc(paragraph(superscript("ab")))"#);
}

#[test]
fn code_excludes_other_marks() {
    let s = pressed(&state_with(vec![p("ab")], 1, Some(3), false), "Mod-b");
    let s = pressed(&s, "Mod-e");
    assert_doc(&s, r#"doc(paragraph(code("ab")))"#);
}

#[test]
fn mod_shift_e_centers_the_text() {
    let s = pressed(
        &state(vec![p("a"), block("heading", "h")], 1),
        "Mod-Shift-e",
    );
    assert_doc(
        &s,
        r#"doc(paragraph{textAlign="center"}("a"), heading{level=1}("h"))"#,
    );
    let s = pressed(&s, "Mod-Shift-j");
    assert_doc(
        &s,
        r#"doc(paragraph{textAlign="justify"}("a"), heading{level=1}("h"))"#,
    );
}

#[test]
fn shift_enter_inserts_a_hard_break_keeping_marks() {
    let s = pressed(&state_with(vec![p("ab")], 1, Some(3), false), "Mod-b");
    let mut tr = s.tr();
    tr.set_selection(TextSelection::create(s.doc(), 3, None));
    let s = s.apply(tr).unwrap();
    let s = pressed(&s, "Shift-Enter");
    let s = type_text(&s, "c");
    assert_doc(&s, r#"doc(paragraph(bold("ab"), hardBreak, bold("c")))"#);
}

#[test]
fn removed_prosemirror_bindings_are_gone() {
    let keymap = starter::keymap(&starter::schema());
    for key in [
        "Escape",
        "Mod-[",
        "Mod-]",
        "Mod-_",
        "Alt-ArrowUp",
        "Mod-BracketLeft",
    ] {
        let want = normalize_key_name(key, false).unwrap();
        assert!(
            keymap
                .iter()
                .all(|(name, _)| normalize_key_name(name, false).unwrap() != want),
            "{key} is bound"
        );
    }
}

// The core keymap.

#[test]
fn backspace_in_an_empty_first_heading_makes_a_paragraph() {
    let s = pressed(&state(vec![block("heading", ""), p("x")], 1), "Backspace");
    assert_doc(&s, r#"doc(paragraph, paragraph("x"))"#);
}

#[test]
fn backspace_in_an_empty_first_paragraph_does_nothing() {
    assert!(press(&state(vec![p(""), p("x")], 1), "Backspace").is_none());
}

#[test]
fn delete_in_an_empty_paragraph_deletes_it() {
    let s = pressed(&state(vec![p("a"), p(""), p("b")], 4), "Delete");
    assert_doc(&s, r#"doc(paragraph("a"), paragraph("b"))"#);
}

// The list keymap.

#[test]
fn backspace_at_the_start_of_an_item_lifts_it() {
    let s = pressed(
        &state(vec![list("bulletList", &["a", "b"])], 8),
        "Backspace",
    );
    assert_doc(
        &s,
        r#"doc(bulletList(listItem(paragraph("a"))), paragraph("b"))"#,
    );
}

#[test]
fn backspace_at_the_start_of_a_nested_item_outdents_it() {
    let nested = json!({"type": "listItem", "content": [p("a"), list("bulletList", &["b"])]});
    let s = state(vec![json!({"type": "bulletList", "content": [nested]})], 8);
    let s = pressed(&s, "Backspace");
    assert_doc(
        &s,
        r#"doc(bulletList(listItem(paragraph("a")), listItem(paragraph("b"))))"#,
    );
}

#[test]
fn backspace_after_a_list_joins_the_paragraph_into_its_last_item() {
    let s = pressed(
        &state(vec![list("bulletList", &["a"]), p("b")], 8),
        "Backspace",
    );
    assert_doc(&s, r#"doc(bulletList(listItem(paragraph("ab"))))"#);
    assert_eq!(s.selection().from(), 4);
}

#[test]
fn delete_at_the_end_of_an_item_joins_the_next_item() {
    let s = pressed(&state(vec![list("bulletList", &["a", "b"])], 4), "Delete");
    assert_doc(&s, r#"doc(bulletList(listItem(paragraph("ab"))))"#);
}

#[test]
fn tab_after_a_list_moves_the_paragraph_into_the_last_item() {
    let s = pressed(&state(vec![list("bulletList", &["a"]), p("b")], 8), "Tab");
    assert_doc(
        &s,
        r#"doc(bulletList(listItem(paragraph("a"), paragraph("b"))))"#,
    );
    assert_eq!(s.selection().from(), 6);
}

#[test]
fn tab_and_shift_tab_sink_and_lift_items() {
    let s = pressed(&state(vec![list("bulletList", &["a", "b"])], 8), "Tab");
    assert_doc(
        &s,
        r#"doc(bulletList(listItem(paragraph("a"), bulletList(listItem(paragraph("b"))))))"#,
    );
    let s = pressed(&s, "Shift-Tab");
    assert_doc(
        &s,
        r#"doc(bulletList(listItem(paragraph("a")), listItem(paragraph("b"))))"#,
    );
}

#[test]
fn task_items_split_and_lift() {
    let s = pressed(&state(vec![list("taskList", &["a"])], 4), "Enter");
    assert_doc(
        &s,
        r#"doc(taskList(taskItem{checked=false}(paragraph("a")), taskItem{checked=false}(paragraph)))"#,
    );
    let s = pressed(&state(vec![list("taskList", &["a", "b"])], 8), "Backspace");
    assert_doc(
        &s,
        r#"doc(taskList(taskItem{checked=false}(paragraph("a"))), paragraph("b"))"#,
    );
}

// Code blocks.

#[test]
fn backspace_at_the_start_of_a_code_block_makes_it_a_paragraph() {
    let s = pressed(&state(vec![block("codeBlock", "ab")], 1), "Backspace");
    assert_doc(&s, r#"doc(paragraph("ab"))"#);
}

#[test]
fn a_third_enter_at_the_end_of_a_code_block_leaves_it() {
    let s = state(vec![block("codeBlock", "a")], 2);
    let s = pressed(&pressed(&s, "Enter"), "Enter");
    assert_doc(&s, "doc(codeBlock(\"a\\n\\n\"))");
    let s = pressed(&s, "Enter");
    assert_doc(&s, r#"doc(codeBlock("a"), paragraph)"#);
    assert_eq!(s.selection().from(), 4);
}

#[test]
fn arrow_down_at_the_end_of_a_last_code_block_adds_a_paragraph() {
    let s = pressed(&state(vec![block("codeBlock", "a")], 2), "ArrowDown");
    assert_doc(&s, r#"doc(codeBlock("a"), paragraph)"#);
    let s = state(vec![block("codeBlock", "a"), p("b")], 2);
    let s = pressed(&s, "ArrowDown");
    assert_eq!(s.selection().from(), 4);
}

#[test]
fn arrow_up_at_the_start_of_a_first_code_block_adds_a_paragraph_before() {
    let s = pressed(&state(vec![block("codeBlock", "a")], 1), "ArrowUp");
    assert_doc(&s, r#"doc(paragraph, codeBlock("a"))"#);
    assert_eq!(s.selection().from(), 1);
}

#[test]
fn tab_does_not_indent_code_by_default() {
    assert!(press(&state(vec![block("codeBlock", "a")], 1), "Tab").is_none());
}

// Plugins.

#[test]
fn the_trailing_node_follows_a_last_list() {
    let s = state_with(vec![list("bulletList", &["a"])], 3, None, true);
    assert_doc(
        &s,
        r#"doc(bulletList(listItem(paragraph("a"))), paragraph)"#,
    );
    let s = state_with(vec![p("a")], 1, None, true);
    assert_doc(&s, r#"doc(paragraph("a"))"#);
}

#[test]
fn deleting_everything_clears_the_document_to_a_paragraph() {
    let s = state_with(vec![block("heading", "a"), p("b")], 1, Some(5), true);
    let mut tr = s.tr();
    tr.delete_selection();
    let s = s.apply(tr).unwrap();
    assert_doc(&s, r#"doc(paragraph)"#);
}

// Input rules.

#[test]
fn hashes_make_headings_of_their_level() {
    let s = type_all(&empty(), "### ");
    assert_doc(&s, "doc(heading{level=3})");
}

#[test]
fn bold_and_italic_delimiters_mark_text_keeping_the_space_before() {
    assert_doc(
        &type_all(&empty(), "a **b**"),
        r#"doc(paragraph("a ", bold("b")))"#,
    );
    assert_doc(
        &type_all(&empty(), "a __b__"),
        r#"doc(paragraph("a ", bold("b")))"#,
    );
    assert_doc(
        &type_all(&empty(), "a *b*"),
        r#"doc(paragraph("a ", italic("b")))"#,
    );
    assert_doc(
        &type_all(&empty(), "a _b_"),
        r#"doc(paragraph("a ", italic("b")))"#,
    );
    assert_doc(
        &type_all(&empty(), "~~s~~"),
        r#"doc(paragraph(strike("s")))"#,
    );
    assert_doc(
        &type_all(&empty(), "==h=="),
        r#"doc(paragraph(highlight("h")))"#,
    );
}

#[test]
fn delimiters_need_white_space_before_and_text_inside() {
    assert_doc(&type_all(&empty(), "a**b**"), r#"doc(paragraph("a**b**"))"#);
    assert_doc(&type_all(&empty(), "** **"), r#"doc(paragraph("** **"))"#);
    assert_doc(
        &type_all(&empty(), "snake_case_x"),
        r#"doc(paragraph("snake_case_x"))"#,
    );
}

#[test]
fn backticks_mark_code_keeping_the_character_before() {
    assert_doc(
        &type_all(&empty(), "a`b`"),
        r#"doc(paragraph("a", code("b")))"#,
    );
    assert_doc(&type_all(&empty(), "``b`"), r#"doc(paragraph("``b`"))"#);
}

#[test]
fn ordered_lists_start_at_the_typed_number() {
    let s = type_all(&empty(), "3. a");
    assert_doc(&s, r#"doc(orderedList{start=3}(listItem(paragraph("a"))))"#);
}

#[test]
fn brackets_make_task_items() {
    assert_doc(
        &type_all(&empty(), "[x] a"),
        r#"doc(taskList(taskItem{checked=true}(paragraph("a"))))"#,
    );
    assert_doc(
        &type_all(&empty(), "[ ] a"),
        r#"doc(taskList(taskItem{checked=false}(paragraph("a"))))"#,
    );
}

#[test]
fn fences_make_code_blocks_with_a_language() {
    assert_doc(
        &type_all(&empty(), "```rust "),
        r#"doc(codeBlock{language="rust"})"#,
    );
    assert_doc(&type_all(&empty(), "~~~ "), "doc(codeBlock)");
}

#[test]
fn rules_insert_a_horizontal_rule() {
    for typed in ["---", "___ ", "*** "] {
        assert_doc(&type_all(&empty(), typed), "doc(horizontalRule, paragraph)");
    }
}

#[test]
fn an_image_is_typed_as_markdown() {
    let s = type_all(&empty(), "a ![x](https://e.x/i.png)");
    assert_doc(
        &s,
        r#"doc(paragraph("a ", image{src="https://e.x/i.png"}))"#,
    );
}

// Typography.

#[test]
fn typography_replaces_its_sequences() {
    for (typed, expected) in [
        ("a->b", "a\u{2192}b"),
        ("(c)", "\u{00A9}"),
        ("(tm)", "\u{2122}"),
        ("1/2 ", "\u{00BD} "),
        ("2x3", "2\u{00D7}3"),
        ("!=", "\u{2260}"),
        ("<<", "\u{00AB}"),
        ("^2", "\u{00B2}"),
        ("+/-", "\u{00B1}"),
    ] {
        let s = type_all(&empty(), typed);
        assert_eq!(s.doc().text_content(), expected, "{typed}");
    }
}

#[test]
fn typography_rules_switch_off() {
    let mut options = TypographyOptions::default();
    options.right_arrow = None;
    let rules = typography(&options);
    let defaults = typography(&TypographyOptions::default());
    assert_eq!(rules.len() + 1, defaults.len());
    let schema = starter::schema();
    let s = EditorState::create(EditorStateConfig::new(schema).plugins(vec![input_rules(rules)]))
        .unwrap();
    let mut tr = s.tr();
    tr.set_selection(TextSelection::create(s.doc(), 1, None));
    let s = s.apply(tr).unwrap();
    assert_eq!(type_all(&s, "->").doc().text_content(), "->");
}

// Paste rules.

#[test]
fn paste_rules_mark_delimited_text() {
    let schema = starter::schema();
    let text = schema.text("a **b** and `c` and ==d==", vec![]);
    let paragraph = schema
        .node("paragraph", None, Fragment::from(text), vec![])
        .unwrap();
    let slice = Slice::new(Fragment::from(paragraph), 1, 1);
    let out = apply_paste_rules(&starter::paste_rule_list(&schema), slice);
    assert_eq!(
        shape(out.content.child(0)),
        r#"paragraph("a ", bold("b"), " and ", code("c"), " and ", highlight("d"))"#
    );
}

#[test]
fn paste_rules_leave_code_blocks_alone() {
    let schema = starter::schema();
    let text = schema.text("**b**", vec![]);
    let code = schema
        .node("codeBlock", None, Fragment::from(text), vec![])
        .unwrap();
    let slice = Slice::new(Fragment::from(code), 0, 0);
    let out = apply_paste_rules(&starter::paste_rule_list(&schema), slice);
    assert_eq!(shape(out.content.child(0)), r#"codeBlock("**b**")"#);
}
