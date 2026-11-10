//! Plugins, after `prosemirror-state`'s `plugin.ts`: behavior added to an
//! editor as one value whose hooks the state and the view call in the
//! plugins' order.

use std::{any::Any, fmt, sync::Arc};

use serde_json::Value;

use super::{
    decoration::DecorationSet,
    editor_state::{EditorState, EditorStateConfig},
    selection::Selection,
    transaction::Transaction,
};
use crate::rich_editor::{
    formats::DomParser,
    model::{Attrs, Node, ResolvedPos, Slice},
};

/// A view's renderer of a node or mark type, opaque to the kernel: the view
/// downcasts it to what it renders with.
pub type ViewFactory = Arc<dyn Any + Send + Sync>;

/// A plugin's state: any value, shared between the states that keep it.
pub type PluginState = Arc<dyn Any + Send + Sync>;

/// A plugin: its hooks.
pub type Plugin = Arc<dyn PluginSpec>;

/// A plugin's unique name in an editor, under which its state, its
/// metadata on transactions and its JSON are found.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PluginKey(pub Arc<str>);

impl PluginKey {
    /// A key named `name`.
    pub fn new(name: &str) -> Self {
        Self(Arc::from(name))
    }

    /// Its name.
    pub fn name(&self) -> &str {
        &self.0
    }

    /// The state of this key's plugin in `state`, if it is a `T`.
    pub fn get_state<T: Any + Send + Sync>(&self, state: &EditorState) -> Option<Arc<T>> {
        state
            .plugin_state(self)
            .and_then(|value| value.downcast::<T>().ok())
    }

    /// The plugin with this key in `state`.
    pub fn get(&self, state: &EditorState) -> Option<Plugin> {
        state
            .plugins()
            .iter()
            .find(|plugin| &plugin.key() == self)
            .cloned()
    }
}

impl fmt::Display for PluginKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A key press, as the view reports it to plugins (and keymaps match it).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct KeyEvent {
    /// The key's name: the character it types (`"a"`, `"A"`) or the name of
    /// a named key (`"Enter"`, `"ArrowLeft"`, `"Backspace"`), as the web's
    /// `KeyboardEvent.key`.
    pub key: String,
    /// Whether the platform's command modifier is held (⌘ on Apple
    /// platforms, Ctrl elsewhere).
    pub mod_key: bool,
    /// Whether Control is held.
    pub ctrl: bool,
    /// Whether Alt (Option) is held.
    pub alt: bool,
    /// Whether Shift is held.
    pub shift: bool,
    /// Whether Meta (⌘, the Windows key) is held.
    pub meta: bool,
}

impl KeyEvent {
    /// A press of `key` without modifiers.
    pub fn new(key: &str) -> Self {
        Self {
            key: key.to_owned(),
            ..Self::default()
        }
    }
}

/// A pointer press, as the view reports it to plugins' click hooks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ClickEvent {
    /// The button: 0 primary, 1 middle, 2 secondary.
    pub button: u8,
    /// Whether the platform's command modifier is held.
    pub mod_key: bool,
    /// Whether Control is held.
    pub ctrl: bool,
    /// Whether Alt (Option) is held.
    pub alt: bool,
    /// Whether Shift is held.
    pub shift: bool,
    /// Whether Meta is held.
    pub meta: bool,
    /// Whether the view shows the document read-only (its `editable` prop
    /// or the session's `setEditable`), which plugins cannot see in the
    /// state.
    pub read_only: bool,
}

/// What a plugin's view hooks get from the view. The view defines what it
/// offers; the kernel has no view.
pub trait ViewCx {}

/// A plugin's hooks; each has a default that does nothing. The state calls
/// them in the plugins' order; the view's input hooks stop at the first
/// plugin that returns `true`.
pub trait PluginSpec: Send + Sync {
    /// Its key, unique among an editor's plugins. By default the type's
    /// name, so two plugins of one type need keys of their own.
    fn key(&self) -> PluginKey {
        PluginKey::new(std::any::type_name::<Self>())
    }

    /// Its state in a new editor state (which holds the earlier plugins'
    /// states already). `None`: it keeps no state.
    fn init_state(&self, config: &EditorStateConfig, state: &EditorState) -> Option<PluginState> {
        let _ = (config, state);
        None
    }

    /// Its state after `tr`, which made `new` (holding the earlier
    /// plugins' new states) from `old`.
    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        old: &EditorState,
        new: &EditorState,
    ) -> PluginState {
        let _ = (tr, old, new);
        value.clone()
    }

    /// Its state's JSON form, kept by [`EditorState::to_json`] under its key.
    fn state_to_json(&self, value: &PluginState) -> Option<Value> {
        let _ = value;
        None
    }

    /// Its state read back from its JSON form.
    fn state_from_json(
        &self,
        config: &EditorStateConfig,
        json: &Value,
        state: &EditorState,
    ) -> Option<PluginState> {
        let _ = (config, json, state);
        None
    }

    /// Whether `tr` may be applied to `state`: `false` drops it.
    fn filter_transaction(&self, tr: &Transaction, state: &EditorState) -> bool {
        let _ = (tr, state);
        true
    }

    /// A transaction to apply after `trs` (the ones this plugin has not
    /// seen yet) made `new` from `old`.
    fn append_transaction(
        &self,
        trs: &[Transaction],
        old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        let _ = (trs, old, new);
        None
    }

    /// Handles a key press; `true` when it did.
    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, event, dispatch);
        false
    }

    /// Handles `text` typed over `from..to`; `true` when it did (the view
    /// then inserts nothing).
    fn handle_text_input(
        &self,
        state: &EditorState,
        from: usize,
        to: usize,
        text: &str,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, from, to, text, dispatch);
        false
    }

    /// Handles a paste of `slice`; `true` when it did.
    fn handle_paste(
        &self,
        state: &EditorState,
        slice: &Slice,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, slice, dispatch);
        false
    }

    /// Handles a key press that types a character (after
    /// [`PluginSpec::handle_key_down`] passed on it); `true` when it did.
    fn handle_key_press(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, event, dispatch);
        false
    }

    /// Handles a click on `node` (starting at `node_pos`), called for each
    /// node around `pos` from the innermost out; `direct` for the node
    /// clicked itself. `true` when it did.
    #[allow(
        clippy::too_many_arguments,
        reason = "ProseMirror's handleClickOn arguments"
    )]
    fn handle_click_on(
        &self,
        state: &EditorState,
        pos: usize,
        node: &Node,
        node_pos: usize,
        event: &ClickEvent,
        direct: bool,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, pos, node, node_pos, event, direct, dispatch);
        false
    }

    /// Handles a click at `pos`; `true` when it did.
    fn handle_click(
        &self,
        state: &EditorState,
        pos: usize,
        event: &ClickEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, pos, event, dispatch);
        false
    }

    /// As [`PluginSpec::handle_click_on`], for a double click.
    #[allow(
        clippy::too_many_arguments,
        reason = "ProseMirror's handleClickOn arguments"
    )]
    fn handle_double_click_on(
        &self,
        state: &EditorState,
        pos: usize,
        node: &Node,
        node_pos: usize,
        event: &ClickEvent,
        direct: bool,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, pos, node, node_pos, event, direct, dispatch);
        false
    }

    /// Handles a double click at `pos`; `true` when it did.
    fn handle_double_click(
        &self,
        state: &EditorState,
        pos: usize,
        event: &ClickEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, pos, event, dispatch);
        false
    }

    /// As [`PluginSpec::handle_click_on`], for a triple click.
    #[allow(
        clippy::too_many_arguments,
        reason = "ProseMirror's handleClickOn arguments"
    )]
    fn handle_triple_click_on(
        &self,
        state: &EditorState,
        pos: usize,
        node: &Node,
        node_pos: usize,
        event: &ClickEvent,
        direct: bool,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, pos, node, node_pos, event, direct, dispatch);
        false
    }

    /// Handles a triple click at `pos`; `true` when it did.
    fn handle_triple_click(
        &self,
        state: &EditorState,
        pos: usize,
        event: &ClickEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, pos, event, dispatch);
        false
    }

    /// Handles a drop of `slice` at `pos` (`moved` when dragged from this
    /// editor, which then deletes the source); `true` when it did.
    fn handle_drop(
        &self,
        state: &EditorState,
        slice: &Slice,
        pos: usize,
        moved: bool,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let _ = (state, slice, pos, moved, dispatch);
        false
    }

    /// Changes pasted or dropped content before it is inserted (each
    /// plugin's in turn).
    fn transform_pasted(&self, state: &EditorState, slice: Slice) -> Slice {
        let _ = state;
        slice
    }

    /// Changes pasted plain text before it is parsed (`plain`: pasted as
    /// plain text explicitly).
    fn transform_pasted_text(&self, state: &EditorState, text: String, plain: bool) -> String {
        let _ = (state, plain);
        text
    }

    /// Changes pasted HTML before it is parsed (each plugin's in turn).
    fn transform_pasted_html(&self, state: &EditorState, html: String) -> String {
        let _ = state;
        html
    }

    /// The parser pasted HTML is read with, instead of the schema's
    /// ([`DomParser::from_schema`]); the first plugin with one wins.
    fn clipboard_parser(&self, state: &EditorState) -> Option<DomParser> {
        let _ = state;
        None
    }

    /// The plain text a copy of `slice` puts on the clipboard; the first
    /// plugin with one wins.
    fn clipboard_text_serializer(&self, state: &EditorState, slice: &Slice) -> Option<String> {
        let _ = (state, slice);
        None
    }

    /// The content pasted plain `text` becomes at `context`; the first
    /// plugin with one wins.
    fn clipboard_text_parser(
        &self,
        state: &EditorState,
        text: &str,
        context: &ResolvedPos,
        plain: bool,
    ) -> Option<Slice> {
        let _ = (state, text, context, plain);
        None
    }

    /// The selection a pointer selection from `anchor` to `head` makes;
    /// `None` for the default (a text selection).
    fn create_selection_between(
        &self,
        state: &EditorState,
        anchor: &ResolvedPos,
        head: &ResolvedPos,
    ) -> Option<Selection> {
        let _ = (state, anchor, head);
        None
    }

    /// Whether the content can be edited; any plugin's `Some(false)` makes
    /// it read-only.
    fn editable(&self, state: &EditorState) -> Option<bool> {
        let _ = state;
        None
    }

    /// Attributes for the editor's root (classes, accessibility); the
    /// view merges every plugin's.
    fn attributes(&self, state: &EditorState) -> Option<Attrs> {
        let _ = state;
        None
    }

    /// Renderers of node types by name, for the view.
    fn node_views(&self) -> Vec<(String, ViewFactory)> {
        Vec::new()
    }

    /// Renderers of mark types by name, for the view.
    fn mark_views(&self) -> Vec<(String, ViewFactory)> {
        Vec::new()
    }

    /// Scrolls the selection into view itself; `true` when it did.
    fn handle_scroll_to_selection(&self, state: &EditorState) -> bool {
        let _ = state;
        false
    }

    /// Decorations to draw over `state`.
    fn decorations(&self, state: &EditorState) -> Option<DecorationSet> {
        let _ = state;
        None
    }

    /// The view was created with `state`.
    fn view_created(&self, cx: &mut dyn ViewCx, state: &EditorState) {
        let _ = (cx, state);
    }

    /// The view moved from `old` to `state`.
    fn view_updated(&self, cx: &mut dyn ViewCx, state: &EditorState, old: &EditorState) {
        let _ = (cx, state, old);
    }

    /// The view is going away.
    fn view_destroyed(&self, cx: &mut dyn ViewCx) {
        let _ = cx;
    }
}
