//! Editing commands, a port of `prosemirror-commands` ([`base`]'s) and
//! `prosemirror-schema-list` ([`list`]'s).
//!
//! A command looks at an [`EditorState`] and answers whether it applies;
//! given a `dispatch`, it also makes its [`Transaction`] and hands it over.
//! Called without one it changes nothing, so menus and key bindings ask
//! whether a command is enabled with the same code that runs it. The
//! commands read only the state: where ProseMirror asks the view whether
//! the cursor is at a visual end of its textblock, these check the
//! position in the document.

pub mod base;
pub mod helpers;
pub mod list;
pub mod registry;
pub mod tiptap;

use std::sync::Arc;

pub use base::{
    SplitAs, ToggleMarkOptions, auto_join, base_keymap, create_paragraph_near, delete_selection,
    exit_code, join_backward, join_down, join_forward, join_text_backward, join_text_forward,
    join_textblock_backward, join_textblock_forward, join_up, lift, lift_empty_block,
    mac_base_keymap, newline_in_code, pc_base_keymap, select_all, select_node_backward,
    select_node_forward, select_parent_node, select_textblock_end, select_textblock_start,
    set_block_type, split_block, split_block_as, split_block_keep_marks, toggle_mark,
    toggle_mark_with, wrap_in,
};
pub use helpers::{
    MarkRange, NodeEmptyOptions, ParentNode, can_join_items_at, find_parent_node,
    find_parent_node_closest_to_pos, get_attributes, get_mark_attributes, get_mark_range,
    get_marks_between, get_node_attributes, get_text_between, is_active, is_at_end_of_node,
    is_at_start_of_node, is_node_empty, object_includes, selection_to_insertion_end,
};
pub use list::{
    lift_list_item, sink_list_item, split_list_item, split_list_item_keep_marks, wrap_in_list,
    wrap_range_in_list,
};
pub use registry::{CommandFactory, CommandRegistry};

use crate::rich_editor::{
    model::{Attrs, MarkType, NodeType},
    state::{EditorState, Selection, Transaction},
};

/// Where a command hands its transaction; `None` asks only whether the
/// command applies.
pub type Dispatch<'a> = Option<&'a mut dyn FnMut(Transaction)>;

/// A command: whether it applies to the state, dispatching its
/// transaction when given a [`Dispatch`].
pub type Command = dyn Fn(&EditorState, Dispatch<'_>) -> bool + Send + Sync;

/// A shared command, what keymaps and [`chain_commands`] hold.
pub type BoxCommand = Arc<Command>;

/// Wraps a command function as a [`BoxCommand`].
pub fn command(
    f: impl Fn(&EditorState, Dispatch<'_>) -> bool + Send + Sync + 'static,
) -> BoxCommand {
    Arc::new(f)
}

/// A command that runs `commands` in order until one applies.
pub fn chain_commands(commands: Vec<BoxCommand>) -> BoxCommand {
    Arc::new(move |state: &EditorState, mut dispatch: Dispatch<'_>| {
        for command in &commands {
            // Reborrow the dispatch for each try: the first that applies uses it.
            let tried = match &mut dispatch {
                Some(dispatch) => command(state, Some(&mut **dispatch)),
                None => command(state, None),
            };
            if tried {
                return true;
            }
        }
        false
    })
}

/// Runs `commands` in turn, each on the state the ones before left, and
/// dispatches their steps (with the transactions plugins appended to
/// them) as one transaction: applies only when every one does (Tiptap's
/// `chain`, all or nothing).
pub fn chain(commands: Vec<BoxCommand>) -> BoxCommand {
    command(move |state: &EditorState, dispatch: Dispatch<'_>| {
        let mut current = state.clone();
        let mut whole = state.tr();
        for command in &commands {
            let mut made: Option<Transaction> = None;
            if !command(&current, Some(&mut |tr| made = Some(tr))) {
                return false;
            }
            let Some(tr) = made else { continue };
            let (selection_set, stored_set, scrolled) = (
                tr.selection_set(),
                tr.stored_marks_set(),
                tr.scrolled_into_view(),
            );
            let selection = tr.selection().to_json();
            let stored = tr.stored_marks().map(<[_]>::to_vec);
            let meta: Vec<(String, serde_json::Value)> = tr
                .meta_entries()
                .map(|(k, v)| (k.to_owned(), v.clone()))
                .collect();
            let Ok((next, applied)) = current.apply_transaction(tr) else {
                return false;
            };
            if applied.is_empty() {
                return false;
            }
            for tr in &applied {
                for step in &tr.steps {
                    if whole.step(step.boxed_clone()).is_err() {
                        return false;
                    }
                }
            }
            if selection_set || applied.len() > 1 {
                let json = if applied.len() > 1 {
                    next.selection().to_json()
                } else {
                    selection
                };
                match Selection::from_json(whole.doc(), &json) {
                    Ok(selection) => {
                        whole.set_selection(selection);
                    }
                    Err(_) => return false,
                }
            }
            if stored_set {
                whole.set_stored_marks(stored);
            }
            for (key, value) in meta {
                whole.set_meta(&key, value);
            }
            if scrolled {
                whole.scroll_into_view();
            }
            current = next;
        }
        if let Some(dispatch) = dispatch {
            dispatch(whole);
        }
        true
    })
}

/// Whether the marks of `ty` apply at the selection: the stored marks or
/// those at an empty selection's cursor, else whether the selected range
/// has one.
pub fn is_mark_active(state: &EditorState, ty: &MarkType) -> bool {
    let selection = state.selection();
    if selection.empty() {
        let marks = match state.stored_marks() {
            Some(marks) => marks.to_vec(),
            None => selection.resolved_from().marks(),
        };
        return ty.is_in_set(&marks).is_some();
    }
    selection
        .ranges()
        .iter()
        .any(|range| state.doc().range_has_mark(range.from.pos, range.to.pos, ty))
}

/// Whether the selection is inside a node of `ty` (with `attrs`, when
/// given): its innermost such ancestor, or the selected node.
pub fn is_node_active(state: &EditorState, ty: &NodeType, attrs: Option<&Attrs>) -> bool {
    let selection = state.selection();
    let matches = |node: &crate::rich_editor::model::Node| {
        node.ty() == ty
            && attrs.is_none_or(|attrs| attrs.iter().all(|(k, v)| node.attrs().get(k) == Some(v)))
    };
    if let Some(node) = selection.as_node()
        && matches(node.node())
    {
        return true;
    }
    let from = selection.resolved_from();
    let to = selection.resolved_to();
    let shared = from.shared_depth(to.pos);
    (0..=shared).rev().any(|depth| matches(from.node(depth)))
}

#[cfg(test)]
pub(crate) mod test_util {
    use crate::rich_editor::{
        extensions::starter,
        model::{Fragment, Node, Schema},
        state::{EditorState, EditorStateConfig, Selection, TextSelection},
    };

    pub(crate) fn schema() -> Schema {
        starter::schema()
    }

    pub(crate) fn n(s: &Schema, name: &str, content: Vec<Node>) -> Node {
        s.node(name, None, Fragment::from(content), vec![]).unwrap()
    }

    pub(crate) fn t(s: &Schema, text: &str) -> Node {
        s.text(text, vec![])
    }

    pub(crate) fn p(s: &Schema, text: &str) -> Node {
        if text.is_empty() {
            n(s, "paragraph", vec![])
        } else {
            n(s, "paragraph", vec![t(s, text)])
        }
    }

    pub(crate) fn state(doc: Node, anchor: usize, head: usize) -> EditorState {
        let selection = TextSelection::create(&doc, anchor, Some(head));
        with_selection(doc, selection)
    }

    pub(crate) fn with_selection(doc: Node, selection: Selection) -> EditorState {
        let schema = doc.ty().schema().clone();
        EditorState::create(EditorStateConfig::new(schema).doc(doc).selection(selection)).unwrap()
    }

    // Runs `command`, applying its transaction; `None` when it does not
    // apply. Also checks that asking without a dispatch agrees.
    pub(crate) fn apply(
        state: &EditorState,
        command: &dyn Fn(&EditorState, super::Dispatch<'_>) -> bool,
    ) -> Option<EditorState> {
        let can = command(state, None);
        let mut out = None;
        let applied = command(state, Some(&mut |tr| out = Some(tr)));
        assert_eq!(can, applied, "dry run and run agree");
        applied.then(|| state.apply(out.expect("a dispatched transaction")).unwrap())
    }
}
