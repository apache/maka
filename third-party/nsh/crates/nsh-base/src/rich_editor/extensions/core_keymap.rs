//! The key bindings of Tiptap's core `Keymap` extension: Enter splits (or
//! leaves code and empty blocks), Backspace takes back an input rule, turns
//! an empty first textblock of the document into the default one, deletes
//! and joins, Delete deletes the empty node it is in or joins, `Mod-a`
//! selects all, and on Apple platforms the Emacs-style bindings of macOS
//! text fields. Ported from `@tiptap/core`'s `extensions/keymap.ts`.

use super::{
    helpers::{clear_nodes, delete_current_node},
    input_rules::undo_input_rule,
};
use crate::rich_editor::{
    commands::{
        BoxCommand, Dispatch, chain_commands, command, create_paragraph_near, delete_selection,
        exit_code, join_backward, join_forward, lift_empty_block, newline_in_code, select_all,
        select_node_backward, select_node_forward, select_textblock_end, select_textblock_start,
        split_block,
    },
    state::{EditorState, Selection},
};

/// Turns the empty textblock the cursor is in into the default block when
/// it is the document's first (or the only block of an isolating parent),
/// as Backspace there does in Tiptap: a heading or a code block at the top
/// of the document gives way to a paragraph before a second Backspace has
/// nothing left to join.
pub fn clear_first_textblock(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    if !selection.empty() {
        return false;
    }
    let anchor = selection.resolved_anchor();
    let parent = anchor.parent();
    if !parent.is_textblock() || !parent.text_content().is_empty() {
        return false;
    }
    let outer = if anchor.pos > 0 {
        state.doc().resolve(anchor.pos - 1).ok()
    } else {
        None
    };
    let outer = outer.as_ref().unwrap_or(anchor);
    let at_start = if outer.parent().ty().spec().isolating && outer.parent().child_count() == 1 {
        anchor.pos - anchor.parent_offset == anchor.pos
    } else {
        Selection::at_start(state.doc()).from() == anchor.pos
    };
    if !at_start || anchor.depth == 0 {
        return false;
    }
    // Already the default block: nothing to clear (and no history entry).
    let default = anchor
        .node(anchor.depth - 1)
        .content_match_at(anchor.index(anchor.depth - 1))
        .and_then(|m| m.default_type());
    if default.as_ref() == Some(parent.ty()) {
        return false;
    }
    clear_nodes(state, dispatch)
}

/// Tiptap's Backspace: undo an input rule, clear the empty first
/// textblock ([`clear_first_textblock`]), delete the selection, join
/// backward, select the node before.
pub fn backspace() -> BoxCommand {
    chain_commands(vec![
        command(undo_input_rule),
        command(clear_first_textblock),
        command(delete_selection),
        command(join_backward),
        command(select_node_backward),
    ])
}

/// Tiptap's Delete: delete the selection, the empty node the cursor is in,
/// join forward, select the node after.
pub fn delete() -> BoxCommand {
    chain_commands(vec![
        command(delete_selection),
        command(delete_current_node),
        command(join_forward),
        command(select_node_forward),
    ])
}

/// Tiptap's Enter: a newline in code, a paragraph near a selected block,
/// lifting an empty block, else splitting.
pub fn enter() -> BoxCommand {
    chain_commands(vec![
        command(newline_in_code),
        command(create_paragraph_near),
        command(lift_empty_block),
        command(split_block),
    ])
}

/// The core bindings off Apple platforms.
pub fn pc_core_keymap() -> Vec<(String, BoxCommand)> {
    let backspace = backspace();
    let delete = delete();
    vec![
        ("Enter".into(), enter()),
        ("Mod-Enter".into(), command(exit_code)),
        ("Backspace".into(), backspace.clone()),
        ("Mod-Backspace".into(), backspace.clone()),
        ("Shift-Backspace".into(), backspace),
        ("Delete".into(), delete.clone()),
        ("Mod-Delete".into(), delete),
        ("Mod-a".into(), command(select_all)),
    ]
}

/// The core bindings on Apple platforms: [`pc_core_keymap`]'s and `Ctrl-h`,
/// `Alt-Backspace`, `Ctrl-d`, `Ctrl-Alt-Backspace`, `Alt-Delete`, `Alt-d`,
/// `Ctrl-a`, `Ctrl-e`.
pub fn mac_core_keymap() -> Vec<(String, BoxCommand)> {
    let backspace = backspace();
    let delete = delete();
    let mut keymap = pc_core_keymap();
    keymap.extend([
        ("Ctrl-h".into(), backspace.clone()),
        ("Alt-Backspace".into(), backspace),
        ("Ctrl-d".into(), delete.clone()),
        ("Ctrl-Alt-Backspace".into(), delete.clone()),
        ("Alt-Delete".into(), delete.clone()),
        ("Alt-d".into(), delete),
        ("Ctrl-a".into(), command(select_textblock_start)),
        ("Ctrl-e".into(), command(select_textblock_end)),
    ]);
    keymap
}

/// The core bindings of this platform: [`mac_core_keymap`] on macOS and
/// iOS, [`pc_core_keymap`] elsewhere.
pub fn core_keymap() -> Vec<(String, BoxCommand)> {
    if cfg!(any(target_os = "macos", target_os = "ios")) {
        mac_core_keymap()
    } else {
        pc_core_keymap()
    }
}
