//! Tiptap's `TrailingNode`: keeps a default block (a paragraph) at the end
//! of the document, so there is always a place to type after a last list,
//! code block or rule. Ported from `@tiptap/extensions`' `trailing-node`.

use std::sync::Arc;

use crate::rich_editor::{
    model::{Node, NodeType},
    state::{
        EditorState, EditorStateConfig, Plugin, PluginKey, PluginSpec, PluginState, Transaction,
    },
};

/// The transaction meta that keeps [`trailing_node`] from adding its node
/// after a transaction (Tiptap's `skipTrailingNode`).
pub const SKIP_TRAILING_NODE: &str = "skipTrailingNode";

/// The options of [`trailing_node`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct TrailingNodeOptions {
    /// The node type kept at the end; the document's default block (a
    /// paragraph) when `None`.
    pub node: Option<String>,
    /// The node types after which none is added (the trailing type always
    /// is one).
    pub not_after: Vec<String>,
}

struct TrailingNode {
    key: PluginKey,
    options: TrailingNodeOptions,
}

impl TrailingNode {
    fn node_type(&self, state: &EditorState) -> Option<NodeType> {
        let schema = state.schema();
        match &self.options.node {
            Some(name) => schema.node_type(name),
            None => schema
                .top_node_type()
                .content_match()
                .default_type()
                .or_else(|| schema.node_type("paragraph")),
        }
    }

    // Whether a node must be added after `doc`'s last child.
    fn needs_node(&self, state: &EditorState, doc: &Node) -> bool {
        let Some(ty) = self.node_type(state) else {
            return false;
        };
        doc.last_child().is_none_or(|last| {
            last.ty() != &ty && !self.options.not_after.iter().any(|n| n == last.ty().name())
        })
    }
}

impl PluginSpec for TrailingNode {
    fn key(&self) -> PluginKey {
        self.key.clone()
    }

    fn init_state(&self, _: &EditorStateConfig, state: &EditorState) -> Option<PluginState> {
        Some(Arc::new(self.needs_node(state, state.doc())))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        _: &EditorState,
        new: &EditorState,
    ) -> PluginState {
        if !tr.doc_changed() {
            return value.clone();
        }
        Arc::new(self.needs_node(new, tr.doc()))
    }

    fn append_transaction(
        &self,
        trs: &[Transaction],
        _: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        if trs
            .iter()
            .any(|tr| tr.get_meta(SKIP_TRAILING_NODE).is_some())
        {
            return None;
        }
        let needed = new.plugin_state(&self.key)?;
        if !*needed.downcast_ref::<bool>()? {
            return None;
        }
        let node = self
            .node_type(new)?
            .create_and_fill(None, Default::default(), vec![])?;
        let mut tr = new.tr();
        tr.insert(new.doc().content().size(), node.into()).ok()?;
        Some(tr)
    }
}

// Gives each trailing node plugin a key of its own.
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A plugin adding a node of the options' type at the end of the document
/// after any transaction that leaves it ending with another type (Tiptap
/// adds it on the first transaction too, a selection change included).
pub fn trailing_node(options: TrailingNodeOptions) -> Plugin {
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Arc::new(TrailingNode {
        key: PluginKey::new(&format!("trailingNode${id}")),
        options,
    })
}
