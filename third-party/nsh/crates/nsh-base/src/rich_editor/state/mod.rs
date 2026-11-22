//! Editor states, after `prosemirror-state`: an [`EditorState`] is an
//! immutable snapshot (document, [`Selection`], stored marks, plugin states)
//! that a [`Transaction`] advances. [`Plugin`]s keep state of their own,
//! filter transactions and append transactions in their order; the view
//! asks them for [`DecorationSet`]s and gives them input first.

mod decoration;
mod editor_state;
mod plugin;
mod selection;
mod transaction;

use std::fmt;

pub use decoration::{Decoration, DecorationKind, DecorationSet};
pub use editor_state::{EditorState, EditorStateConfig};
pub use plugin::{
    ClickEvent, KeyEvent, Plugin, PluginKey, PluginSpec, PluginState, ViewCx, ViewFactory,
};
pub use selection::{
    Affinity, AllSelection, CustomBookmark, CustomSelection, GAP_CURSOR, GapCursor, NodeSelection,
    Selection, SelectionBookmark, SelectionFromJson, SelectionKind, SelectionRange,
    SelectionRegistry, TextSelection,
};
pub use transaction::{ADD_TO_HISTORY, APPENDED_TRANSACTION, Transaction, TransactionOrigin};

/// Why a state could not be made or advanced. A failed call changes nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum StateError {
    /// The document a transaction would commit breaks the schema (its
    /// content, marks or attributes); the message says where.
    Invalid(String),
    /// Plugins kept appending transactions for more rounds than
    /// [`MAX_APPEND_ROUNDS`]: their `append_transaction`s answer each other.
    AppendLoop,
    /// Two plugins share a key (the key's name).
    DuplicatePluginKey(String),
    /// The transaction was not started from this state's document.
    MismatchedTransaction,
    /// A JSON form could not be read (what was wrong).
    Json(String),
}

/// The rounds of appended transactions [`EditorState::apply_transaction`]
/// runs before it reports [`StateError::AppendLoop`].
pub const MAX_APPEND_ROUNDS: usize = 64;

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid document: {message}"),
            Self::AppendLoop => write!(
                f,
                "plugins appended transactions for more than {MAX_APPEND_ROUNDS} rounds"
            ),
            Self::DuplicatePluginKey(key) => write!(f, "two plugins have the key `{key}`"),
            Self::MismatchedTransaction => {
                write!(f, "the transaction was not started from this state")
            }
            Self::Json(message) => write!(f, "invalid editor state JSON: {message}"),
        }
    }
}

impl std::error::Error for StateError {}

#[cfg(test)]
pub(crate) mod test_util {
    //! A schema and builders the state's tests share.

    use serde_json::json;

    use super::{EditorState, EditorStateConfig, Plugin};
    use crate::rich_editor::model::{Fragment, Node, Schema, SchemaSpec};

    pub(crate) fn schema() -> Schema {
        SchemaSpec::from_json(&json!({
            "nodes": [
                ["doc", {"content": "block+"}],
                ["paragraph", {"content": "inline*", "group": "block"}],
                ["horizontal_rule", {"group": "block"}],
                ["heading", {"content": "inline*", "group": "block",
                    "attrs": {"level": {"default": 1, "validate": "number"}}}],
                ["text", {"group": "inline"}]
            ],
            "marks": [["em", {}], ["strong", {}]]
        }))
        .unwrap()
    }

    pub(crate) fn node(s: &Schema, name: &str, content: Vec<Node>) -> Node {
        s.node(name, None, Fragment::from(content), vec![]).unwrap()
    }

    pub(crate) fn p(s: &Schema, text: &str) -> Node {
        let content = if text.is_empty() {
            vec![]
        } else {
            vec![s.text(text, vec![])]
        };
        node(s, "paragraph", content)
    }

    pub(crate) fn doc(s: &Schema, content: Vec<Node>) -> Node {
        node(s, "doc", content)
    }

    pub(crate) fn state(s: &Schema, doc: Node, plugins: Vec<Plugin>) -> EditorState {
        EditorState::create(EditorStateConfig::new(s.clone()).doc(doc).plugins(plugins)).unwrap()
    }
}
