//! Selection and navigation on a desktop: arrows by grapheme, line, word
//! and edge, Shift extending, presses (single, double, triple, on an
//! atom), drags across blocks, and edits of a selection that spans
//! blocks.
//!
//! Positions: in `paragraphs(&["ab", "cd"])` the first paragraph's text
//! is 1..3, the second's 5..7, the document's size 8.

use super::*;

/// Focuses the editor and puts the caret at the document's start.
fn focus_start(app: &mut Headless) {
    app.type_text("id:editor", "").unwrap();
    keys(app, &["ctrl+home"]);
    see(app, "Sel 1-1");
}

#[test]
fn left_and_right_step_one_grapheme() {
    let mut app = start(paragraphs(&["abc"]));
    focus_start(&mut app);
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 2-2");
    keys(&mut app, &["right", "right"]);
    see(&mut app, "Sel 4-4");
    // At the document's end the caret stays.
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 4-4");
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 3-3");
}

#[test]
fn a_grapheme_cluster_is_one_step() {
    // "e" + a combining acute: two UTF-16 units, one grapheme.
    let mut app = start(paragraphs(&["e\u{301}x"]));
    focus_start(&mut app);
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 3-3");
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 1-1");
}

#[test]
fn arrows_cross_block_boundaries_in_one_step() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    focus_start(&mut app);
    keys(&mut app, &["right", "right"]);
    see(&mut app, "Sel 3-3");
    // ProseMirror: the end of one textblock to the start of the next is
    // one step (the positions between the blocks hold no cursor).
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 5-5");
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 3-3");
    // At the document's start the caret stays.
    keys(&mut app, &["left", "left", "left"]);
    see(&mut app, "Sel 1-1");
}

#[test]
fn up_and_down_move_between_blocks() {
    let mut app = start(paragraphs(&["abc", "def", "ghi"]));
    focus_start(&mut app);
    keys(&mut app, &["down"]);
    see(&mut app, "Sel 6-6");
    keys(&mut app, &["down"]);
    see(&mut app, "Sel 11-11");
    keys(&mut app, &["up", "up"]);
    see(&mut app, "Sel 1-1");
    // Browser: up on the first line goes to the document's start, down
    // on the last to its end.
    keys(&mut app, &["right", "up"]);
    see(&mut app, "Sel 1-1");
    keys(&mut app, &["ctrl+end", "left", "left", "down"]);
    see(&mut app, "Sel 14-14");
}

#[test]
fn up_and_down_keep_their_column() {
    let mut app = start(paragraphs(&["abc", "", "abc"]));
    focus_start(&mut app);
    keys(&mut app, &["right", "right"]);
    see(&mut app, "Sel 3-3");
    // Through an empty paragraph and back out at the same x.
    keys(&mut app, &["down"]);
    see(&mut app, "Sel 6-6");
    keys(&mut app, &["down"]);
    see(&mut app, "Sel 10-10");
}

#[test]
fn home_and_end_go_to_the_line_edges() {
    let mut app = start(paragraphs(&["abc", "defg"]));
    focus_start(&mut app);
    keys(&mut app, &["down", "right"]);
    see(&mut app, "Sel 7-7");
    keys(&mut app, &["end"]);
    see(&mut app, "Sel 10-10");
    keys(&mut app, &["home"]);
    see(&mut app, "Sel 6-6");
}

#[test]
fn ctrl_home_and_ctrl_end_go_to_the_document_edges() {
    let mut app = start(paragraphs(&["abc", "defg"]));
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["ctrl+end"]);
    see(&mut app, "Sel 10-10");
    keys(&mut app, &["ctrl+home"]);
    see(&mut app, "Sel 1-1");
    keys(&mut app, &["ctrl+shift+end"]);
    see(&mut app, "Sel 1-10");
}

#[test]
fn ctrl_left_and_right_move_by_word() {
    let mut app = start(paragraphs(&["hello big world", "next"]));
    focus_start(&mut app);
    // Browser (Windows / Linux take word ends going right as Chrome on
    // Linux does): to the end of the next word.
    keys(&mut app, &["ctrl+right"]);
    see(&mut app, "Sel 6-6");
    keys(&mut app, &["ctrl+right"]);
    see(&mut app, "Sel 10-10");
    keys(&mut app, &["ctrl+left"]);
    see(&mut app, "Sel 7-7");
    keys(&mut app, &["ctrl+right", "ctrl+right"]);
    see(&mut app, "Sel 16-16");
    // Past the last word, into the next block.
    keys(&mut app, &["ctrl+right"]);
    see(&mut app, "Sel 18-18");
}

#[test]
fn shift_arrows_extend_from_a_fixed_anchor() {
    let mut app = start(paragraphs(&["abcd"]));
    focus_start(&mut app);
    keys(&mut app, &["right", "right"]);
    see(&mut app, "Sel 3-3");
    keys(&mut app, &["shift+left", "shift+left"]);
    see(&mut app, "Sel 1-3");
    // The anchor stays at 3: the head crosses it.
    keys(&mut app, &["shift+right", "shift+right", "shift+right"]);
    see(&mut app, "Sel 3-4");
}

#[test]
fn shift_down_extends_across_blocks() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    focus_start(&mut app);
    keys(&mut app, &["shift+down"]);
    see(&mut app, "Sel 1-5");
    keys(&mut app, &["shift+end"]);
    see(&mut app, "Sel 1-7");
}

#[test]
fn left_and_right_collapse_a_range_to_its_edge() {
    let mut app = start(paragraphs(&["abcd"]));
    focus_start(&mut app);
    keys(&mut app, &["right", "shift+right", "shift+right"]);
    see(&mut app, "Sel 2-4");
    // ProseMirror / browser: a range collapses to its start or end, the
    // caret moves no further.
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 2-2");
    keys(&mut app, &["shift+right", "shift+right", "right"]);
    see(&mut app, "Sel 4-4");
}

#[test]
fn mod_a_selects_everything() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    focus_start(&mut app);
    keys(&mut app, &["mod+a"]);
    // An AllSelection: 0 to the document's size.
    see(&mut app, "Sel 0-8");
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &doc("x"));
    see(&mut app, "Types paragraph");
    see(&mut app, "Sel 2-2");
}

/// A paragraph, a `stock` atom, a paragraph: `ab` 1..3, the atom 4..5,
/// `cd` 6..8.
fn with_atom() -> Value {
    json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "ab"}]},
        {"type": "stock", "attrs": {"symbol": "AAPL"}},
        {"type": "paragraph", "content": [{"type": "text", "text": "cd"}]},
    ]})
}

#[test]
fn arrows_select_a_block_atom_and_leave_it() {
    let mut app = start(with_atom());
    focus_start(&mut app);
    keys(&mut app, &["end", "right"]);
    see(&mut app, "Sel 4-5");
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 6-6");
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 4-5");
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 3-3");
}

#[test]
fn up_and_down_select_a_block_atom() {
    let mut app = start(with_atom());
    focus_start(&mut app);
    keys(&mut app, &["down"]);
    see(&mut app, "Sel 4-5");
    keys(&mut app, &["down"]);
    see(&mut app, "Sel 6-6");
}

#[test]
fn pressing_an_atom_selects_it() {
    let mut app = start(with_atom());
    focus_start(&mut app);
    app.press("text:Stock AAPL").unwrap();
    see(&mut app, "Sel 4-5");
    // Backspace deletes the selected atom.
    keys(&mut app, &["backspace"]);
    see(&mut app, "Types paragraph,paragraph");
}

#[test]
fn a_double_press_selects_a_word() {
    let mut app = start(paragraphs(&["hello big world"]));
    focus_start(&mut app);
    let at = Point::new(px(1.0), px(1.0));
    app.press_at("text:hello big world", at).unwrap();
    app.press_at("text:hello big world", at).unwrap();
    see(&mut app, "Sel 1-6");
}

#[test]
fn a_triple_press_selects_a_block_text() {
    let mut app = start(paragraphs(&["first", "hello big world"]));
    focus_start(&mut app);
    let at = Point::new(px(1.0), px(1.0));
    for _ in 0..3 {
        app.press_at("text:hello big world", at).unwrap();
    }
    see(&mut app, "Sel 8-23");
}

#[test]
#[ignore = "the headless drag is a finger, which presses inside a scroll view only once it rests; a mouse drag is checked in a real window"]
fn a_drag_selects_across_blocks() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    focus_start(&mut app);
    // From the middle of `ab` (between a and b) far right and down: the
    // end of `cd`.
    app.drag("text:ab", Point::new(px(300.0), px(40.0)))
        .unwrap();
    see(&mut app, "Sel 2-7");
}

#[test]
fn typing_replaces_a_selection_across_blocks() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    focus_start(&mut app);
    keys(
        &mut app,
        &["right", "shift+right", "shift+right", "shift+right"],
    );
    see(&mut app, "Sel 2-6");
    app.type_text("id:editor", "X").unwrap();
    see(&mut app, &doc("aXd"));
    see(&mut app, "Tree doc(paragraph(\"aXd\"))");
    see(&mut app, "Sel 3-3");
}

#[test]
fn backspace_deletes_a_selection_across_blocks() {
    let mut app = start(paragraphs(&["ab", "cd", "ef"]));
    focus_start(&mut app);
    keys(&mut app, &["right", "shift+down", "shift+down"]);
    see(&mut app, "Sel 2-10");
    keys(&mut app, &["backspace"]);
    see(&mut app, &doc("af"));
    see(&mut app, "Tree doc(paragraph(\"af\"))");
    see(&mut app, "Sel 2-2");
}
