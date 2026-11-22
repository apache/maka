//! Tiptap's `clearDocument` plugin: when a transaction deletes the whole
//! selected document, the textblock left becomes the default one (an empty
//! heading turns back into a paragraph). Ported from `@tiptap/core`'s
//! `extensions/keymap.ts`.

use std::sync::Arc;

use super::helpers::clear_nodes;
use crate::rich_editor::{
    model::Node,
    state::{EditorState, Plugin, PluginKey, PluginSpec, Selection, Transaction},
};

/// The transaction meta that keeps [`clear_document`] from clearing after
/// a transaction (Tiptap's `preventClearDocument`).
pub const PREVENT_CLEAR_DOCUMENT: &str = "preventClearDocument";

struct ClearDocument;

impl PluginSpec for ClearDocument {
    fn key(&self) -> PluginKey {
        PluginKey::new("clearDocument")
    }

    fn append_transaction(
        &self,
        trs: &[Transaction],
        old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        if trs.iter().any(|tr| tr.get_meta("composition").is_some()) {
            return None;
        }
        let changed = trs.iter().any(|tr| tr.doc_changed()) && old.doc() != new.doc();
        if !changed
            || trs
                .iter()
                .any(|tr| tr.get_meta(PREVENT_CLEAR_DOCUMENT).is_some())
        {
            return None;
        }
        let selection = old.selection();
        let all = selection.from() == Selection::at_start(old.doc()).from()
            && selection.to() == Selection::at_end(old.doc()).to();
        if selection.empty() || !all || !is_node_empty(new.doc()) {
            return None;
        }
        let mut out = None;
        clear_nodes(new, Some(&mut |tr| out = Some(tr)));
        out.filter(|tr: &Transaction| !tr.steps.is_empty())
    }
}

/// Whether `node` holds nothing: no text, no leaf, only empty children
/// (Tiptap's `isNodeEmpty`).
pub fn is_node_empty(node: &Node) -> bool {
    if node.is_text() {
        return node.text().is_none_or(str::is_empty);
    }
    if node.is_atom() || node.is_leaf() {
        return false;
    }
    node.content().iter().all(is_node_empty)
}

/// The plugin.
pub fn clear_document() -> Plugin {
    Arc::new(ClearDocument)
}
