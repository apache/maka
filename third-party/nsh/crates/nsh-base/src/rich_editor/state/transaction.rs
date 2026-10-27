//! Transactions, after `prosemirror-state`'s `transaction.ts`: a
//! [`Transform`] of a state's document that also carries the selection,
//! the stored marks, where it came from ([`TransactionOrigin`]), metadata
//! for plugins and whether the view scrolls to the selection.

use std::{
    any::Any,
    collections::BTreeMap,
    ops::{Deref, DerefMut},
    sync::Arc,
};

use serde_json::Value;

use super::{plugin::PluginKey, selection::Selection};
use crate::rich_editor::{
    model::{Mark, MarkType, Node, Schema, Slice},
    transform::Transform,
};

/// Where a transaction came from: history and plugins treat changes
/// differently by their source (remote changes are not undone, pasted
/// text runs no input rules, ...).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum TransactionOrigin {
    /// A command the user invoked (a key binding, a menu).
    User,
    /// Typing and the input method.
    Input,
    /// A paste.
    Paste,
    /// A drop.
    Drop,
    /// A collaborator's change (their name or id).
    Remote(String),
    /// Undo or redo.
    History,
    /// A plugin (its key's name).
    Plugin(String),
    /// The app's code.
    Api,
}

/// The meta key that turns history off for a transaction (`false`).
pub const ADD_TO_HISTORY: &str = "addToHistory";

/// The meta key [`EditorState::apply_transaction`](super::EditorState::apply_transaction)
/// sets (`true`) on transactions plugins appended.
pub const APPENDED_TRANSACTION: &str = "appendedTransaction";

/// A change to an [`EditorState`](super::EditorState): its steps (the
/// [`Transform`] it derefs to), the selection after them and what else the
/// new state takes. Make one with [`EditorState::tr`](super::EditorState::tr).
#[derive(Debug)]
pub struct Transaction {
    transform: Transform,
    schema: Schema,
    pub(super) base_revision: u64,
    /// When it was made, in milliseconds (the platform's clock; 0 where
    /// there is none, so the view sets it).
    pub time: u64,
    // The selection as of `selection_steps` steps; later steps map it.
    selection: Selection,
    selection_steps: usize,
    selection_set: bool,
    // Stored marks as of `marks_steps` steps; a later step clears them.
    stored_marks: Option<Vec<Mark>>,
    marks_steps: usize,
    marks_set: bool,
    meta: BTreeMap<String, Value>,
    meta_any: BTreeMap<String, Arc<dyn Any + Send + Sync>>,
    origin: Option<TransactionOrigin>,
    scrolled: bool,
}

impl Deref for Transaction {
    type Target = Transform;

    fn deref(&self) -> &Transform {
        &self.transform
    }
}

impl DerefMut for Transaction {
    fn deref_mut(&mut self) -> &mut Transform {
        &mut self.transform
    }
}

impl Transaction {
    pub(super) fn new(
        doc: Node,
        schema: Schema,
        selection: Selection,
        stored_marks: Option<Vec<Mark>>,
        base_revision: u64,
    ) -> Self {
        Self {
            transform: Transform::new(doc),
            schema,
            base_revision,
            time: now_ms(),
            selection,
            selection_steps: 0,
            selection_set: false,
            stored_marks,
            marks_steps: 0,
            marks_set: false,
            meta: BTreeMap::new(),
            meta_any: BTreeMap::new(),
            origin: None,
            scrolled: false,
        }
    }

    /// The transform: its steps, documents and mapping.
    pub fn transform(&self) -> &Transform {
        &self.transform
    }

    /// The schema of its documents.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// Sets [`Transaction::time`].
    pub fn set_time(&mut self, time: u64) -> &mut Self {
        self.time = time;
        self
    }

    /// The selection after its steps: the one set, mapped through the steps
    /// made since.
    pub fn selection(&self) -> Selection {
        let steps = self.transform.steps.len();
        if self.selection_steps < steps {
            let mapping = self.transform.mapping.slice(self.selection_steps, steps);
            self.selection.map(self.transform.doc(), &mapping)
        } else {
            self.selection.clone()
        }
    }

    /// Sets the selection (in the current document); clears stored marks.
    pub fn set_selection(&mut self, selection: Selection) -> &mut Self {
        self.selection = selection;
        self.selection_steps = self.transform.steps.len();
        self.selection_set = true;
        self.stored_marks = None;
        self.marks_steps = self.selection_steps;
        self.marks_set = false;
        self
    }

    /// Whether [`Transaction::set_selection`] was called.
    pub fn selection_set(&self) -> bool {
        self.selection_set
    }

    /// The marks the next typed text gets, if set (a step since clears
    /// them).
    pub fn stored_marks(&self) -> Option<&[Mark]> {
        if self.marks_steps < self.transform.steps.len() {
            return None;
        }
        self.stored_marks.as_deref()
    }

    /// Sets the stored marks.
    pub fn set_stored_marks(&mut self, marks: Option<Vec<Mark>>) -> &mut Self {
        self.stored_marks = marks;
        self.marks_steps = self.transform.steps.len();
        self.marks_set = true;
        self
    }

    /// Whether [`Transaction::set_stored_marks`] (or one of the calls that
    /// change them) was called.
    pub fn stored_marks_set(&self) -> bool {
        self.marks_set && self.marks_steps == self.transform.steps.len()
    }

    /// Sets the stored marks to `marks` unless the marks at the selection
    /// already are those.
    pub fn ensure_marks(&mut self, marks: Vec<Mark>) -> &mut Self {
        let current = self.current_marks(false);
        if !Mark::same_set(&current, &marks) {
            self.set_stored_marks(Some(marks));
        }
        self
    }

    /// Adds `mark` to the stored marks (or to the marks at the head).
    pub fn add_stored_mark(&mut self, mark: &Mark) -> &mut Self {
        let marks = mark.add_to_set(&self.current_marks(true));
        self.ensure_marks(marks)
    }

    /// Removes `mark` from the stored marks (or from the marks at the head).
    pub fn remove_stored_mark(&mut self, mark: &Mark) -> &mut Self {
        let marks = mark.remove_from_set(&self.current_marks(true));
        self.ensure_marks(marks)
    }

    /// Removes every mark of `ty` from the stored marks (or from the marks
    /// at the head).
    pub fn remove_stored_mark_type(&mut self, ty: &MarkType) -> &mut Self {
        let marks = ty.remove_from_set(&self.current_marks(true));
        self.ensure_marks(marks)
    }

    // The stored marks, else the marks at the selection's head (or start).
    fn current_marks(&self, at_head: bool) -> Vec<Mark> {
        if let Some(marks) = self.stored_marks() {
            return marks.to_vec();
        }
        let selection = self.selection();
        if at_head {
            selection.resolved_head().marks()
        } else {
            selection.resolved_from().marks()
        }
    }

    /// Replaces the selection with `slice`.
    pub fn replace_selection(&mut self, slice: Slice) -> &mut Self {
        let selection = self.selection();
        selection.replace(self, slice);
        self
    }

    /// Replaces the selection with `node`, which takes the marks there
    /// first when `inherit_marks` (the stored marks, else those at the
    /// cursor or across the selection).
    pub fn replace_selection_with(&mut self, node: Node, inherit_marks: bool) -> &mut Self {
        let selection = self.selection();
        let node = if inherit_marks {
            let marks = match self.stored_marks() {
                Some(marks) => marks.to_vec(),
                None if selection.empty() => selection.resolved_from().marks(),
                None => selection
                    .resolved_from()
                    .marks_across(selection.resolved_to())
                    .unwrap_or_default(),
            };
            node.mark(marks)
        } else {
            node
        };
        selection.replace_with(self, node);
        self
    }

    /// Deletes the selection.
    pub fn delete_selection(&mut self) -> &mut Self {
        let selection = self.selection();
        selection.replace(self, Slice::empty());
        self
    }

    /// Replaces `from..to` (the selection when `from` is `None`; `to`
    /// defaults to `from`) with `text`, which takes the stored marks or
    /// those of the range. Deletes the range when `text` is empty.
    pub fn insert_text(&mut self, text: &str, from: Option<usize>, to: Option<usize>) -> &mut Self {
        let Some(from) = from else {
            if text.is_empty() {
                return self.delete_selection();
            }
            let node = self.schema.text(text, Vec::new());
            return self.replace_selection_with(node, true);
        };
        let to = to.unwrap_or(from);
        if text.is_empty() {
            let _ = self.transform.delete_range(from, to);
            return self;
        }
        let marks = match self.stored_marks() {
            Some(marks) => marks.to_vec(),
            None => match self.transform.doc().resolve(from) {
                Ok(start) if to == from => start.marks(),
                Ok(start) => match self.transform.doc().resolve(to) {
                    Ok(end) => start.marks_across(&end).unwrap_or_default(),
                    Err(_) => Vec::new(),
                },
                Err(_) => Vec::new(),
            },
        };
        let node = self.schema.text(text, marks);
        let _ = self.transform.replace_range_with(from, to, node);
        let selection = self.selection();
        if !selection.empty() {
            let end = selection.resolved_to().clone();
            self.set_selection(Selection::near(&end, 1));
        }
        self
    }

    /// Sets metadata under `key` for plugins to read.
    pub fn set_meta(&mut self, key: &str, value: Value) -> &mut Self {
        self.meta.insert(key.to_owned(), value);
        self
    }

    /// The metadata under `key`.
    pub fn get_meta(&self, key: &str) -> Option<&Value> {
        self.meta.get(key)
    }

    /// Every JSON metadata entry, by key (what a transaction's JSON form
    /// carries; [`Transaction::set_meta_any`]'s Rust values are not among
    /// them).
    pub fn meta_entries(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.meta.iter().map(|(key, value)| (key.as_str(), value))
    }

    /// Sets metadata under a plugin's key.
    pub fn set_plugin_meta(&mut self, key: &PluginKey, value: Value) -> &mut Self {
        self.set_meta(key.name(), value)
    }

    /// The metadata under a plugin's key.
    pub fn get_plugin_meta(&self, key: &PluginKey) -> Option<&Value> {
        self.get_meta(key.name())
    }

    /// Sets metadata that is a Rust value (what JSON cannot carry: steps,
    /// mappings) under `key`.
    pub fn set_meta_any(&mut self, key: &str, value: Arc<dyn Any + Send + Sync>) -> &mut Self {
        self.meta_any.insert(key.to_owned(), value);
        self
    }

    /// The Rust value under `key`, if it is a `T`.
    pub fn get_meta_any<T: Any + Send + Sync>(&self, key: &str) -> Option<Arc<T>> {
        self.meta_any
            .get(key)
            .cloned()
            .and_then(|value| value.downcast::<T>().ok())
    }

    /// Sets where it came from.
    pub fn set_origin(&mut self, origin: TransactionOrigin) -> &mut Self {
        self.origin = Some(origin);
        self
    }

    /// Where it came from, if set.
    pub fn origin(&self) -> Option<&TransactionOrigin> {
        self.origin.as_ref()
    }

    /// Whether history records it (meta [`ADD_TO_HISTORY`], default true).
    pub fn add_to_history(&self) -> bool {
        self.get_meta(ADD_TO_HISTORY)
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    /// Sets whether history records it.
    pub fn set_add_to_history(&mut self, add: bool) -> &mut Self {
        self.set_meta(ADD_TO_HISTORY, Value::Bool(add))
    }

    /// Whether plugins appended it.
    pub fn is_appended(&self) -> bool {
        self.get_meta(APPENDED_TRANSACTION)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Asks the view to scroll the selection into view.
    pub fn scroll_into_view(&mut self) -> &mut Self {
        self.scrolled = true;
        self
    }

    /// Whether [`Transaction::scroll_into_view`] was called.
    pub fn scrolled_into_view(&self) -> bool {
        self.scrolled
    }

    /// Whether it carries no metadata (a plain change plugins need not
    /// look at twice).
    pub fn is_generic(&self) -> bool {
        self.meta.is_empty() && self.meta_any.is_empty()
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

// `SystemTime::now` panics on wasm32-unknown-unknown; the web view sets
// `time` itself.
#[cfg(target_arch = "wasm32")]
fn now_ms() -> u64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::state::{TextSelection, test_util::*};

    #[test]
    fn stored_marks_apply_to_typed_text_and_clear_on_a_step() {
        let s = schema();
        let state = state(&s, doc(&s, vec![p(&s, "ab")]), vec![]);
        let strong = s.mark("strong", None).unwrap();
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(tr.doc(), 2, None));
        tr.add_stored_mark(&strong);
        assert!(tr.stored_marks_set());
        assert_eq!(tr.stored_marks().map(<[Mark]>::len), Some(1));
        tr.insert_text("x", None, None);
        assert_eq!(tr.stored_marks(), None);
        assert!(!tr.stored_marks_set());
        let inserted = tr.doc().node_at(2).unwrap();
        assert_eq!(inserted.text(), Some("x"));
        assert_eq!(inserted.marks().len(), 1);
        assert_eq!(tr.selection().head(), 3);
    }

    #[test]
    fn setting_the_selection_clears_stored_marks() {
        let s = schema();
        let state = state(&s, doc(&s, vec![p(&s, "ab")]), vec![]);
        let mut tr = state.tr();
        tr.set_stored_marks(Some(vec![s.mark("em", None).unwrap()]));
        tr.set_selection(TextSelection::create(tr.doc(), 1, None));
        assert_eq!(tr.stored_marks(), None);
    }

    #[test]
    fn meta_origin_and_history_flags() {
        let s = schema();
        let state = state(&s, doc(&s, vec![p(&s, "")]), vec![]);
        let mut tr = state.tr();
        assert!(tr.is_generic());
        assert!(tr.add_to_history());
        tr.set_add_to_history(false)
            .set_origin(TransactionOrigin::Paste)
            .scroll_into_view();
        assert!(!tr.add_to_history());
        assert!(!tr.is_generic());
        assert_eq!(tr.origin(), Some(&TransactionOrigin::Paste));
        assert!(tr.scrolled_into_view());
        tr.set_meta_any("n", Arc::new(5_u32));
        assert_eq!(tr.get_meta_any::<u32>("n").as_deref(), Some(&5));
    }

    #[test]
    fn delete_selection_removes_the_range() {
        let s = schema();
        let state = state(&s, doc(&s, vec![p(&s, "hello")]), vec![]);
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(tr.doc(), 2, Some(4)));
        tr.delete_selection();
        assert_eq!(tr.doc().text_content(), "hlo");
        assert_eq!(tr.selection().head(), 2);
    }
}
