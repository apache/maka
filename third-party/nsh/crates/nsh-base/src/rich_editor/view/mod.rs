//! `RichEditor`: the native editing view over an [`EditorState`]
//! (`nsh/base`), after ProseMirror's `EditorView`.
//!
//! The view renders the document with primitives: a view per block (its
//! node type's part, which the app styles by name), a text per textblock
//! whose spans are its text with their marks' parts, node views
//! ([`NodeView`]) for the types the app renders itself, and the plugins'
//! decorations. Input becomes transactions natively: typed text goes
//! through plugins' `handle_text_input` (input rules) before it is
//! inserted, keys through their `handle_key_down` (keymaps) before the base
//! keymap and the view's caret movement, presses through their click hooks
//! before they select, and pastes through the clipboard hooks. The text
//! the platforms take keys, text and input methods with is an invisible
//! native input at the caret, as the code `Editor`'s. Changes go through
//! the [`EditorSession`] the view shares with the app, which hears of them
//! afterwards: the main thread never waits for JS.
//!
//! `docs/dev/rich-editor.md` has the design.

mod controller;
mod geometry;
mod keys;
mod node_view;
mod parts;
mod render;
mod session;

use std::collections::BTreeMap;

use nsh_core::prelude::*;
use serde_json::Value;

use self::controller::Rv;
pub use self::{
    node_view::{MarkView, NodeView, NodeViewCx, NodeViewEvent},
    parts::{PartStyles, RichEditorClasses, RichEditorStyles},
    session::{
        DispatchTransaction, EditorSession, EventListener, NodeViews, SESSION_TS_TYPE,
        SessionEvent, SessionEventKind, SessionJs, Subscriber, SubscriptionId, ViewGeometry,
        ViewRequest, set_session_js,
    },
};
use crate::rich_editor::state::EditorState;

/// A rich text editor over a document the schema defines.
#[derive(Clone, Copy, PartialEq, Props)]
pub struct RichEditorProps {
    /// The editor the view shows and edits, shared with the app's code
    /// (its state, commands, node views). Taken when the view is made: a
    /// new session needs a new view (a `key`).
    pub editor: Prop<Option<EditorSession>>,
    /// Without an `editor`: the schema, as JSON (ProseMirror's spec of
    /// `nodes` and `marks`; default the starter schema: paragraphs,
    /// headings, quotes, code, lists, images and the common marks).
    pub schema: Prop<Option<Value>>,
    /// Without an `editor`: the first document, as ProseMirror's JSON
    /// (default an empty document).
    pub content: Prop<Option<Value>>,
    /// Without an `editor`: the built-in behavior, by name: `"starter"`
    /// (the starter's keymap and input rules, the base keymap and the
    /// history), `"history"`, `"baseKeymap"`, `"markdown"` (Markdown
    /// shortcuts, paste and copy). Default `["starter"]`.
    pub plugins: Prop<Option<Vec<SharedString>>>,
    /// The document can be edited (default true); plugins can make it
    /// read-only too. A read-only editor still selects and copies.
    #[prop(default = true)]
    pub editable: Prop<bool>,
    /// Shown in an empty textblock (Tiptap's placeholder extension): the
    /// one the selection is in, at the document's top level, while the
    /// document can be edited (`showOnlyCurrent`, `includeChildren`,
    /// `showOnlyWhenEditable`), in the block's own typography and the
    /// `placeholder` part.
    pub placeholder: Prop<Option<SharedString>>,
    /// Placeholders by node type name (`{ heading: "Heading", paragraph:
    /// "Write…" }`), over `placeholder` for the blocks of those types.
    pub placeholders: Prop<Option<BTreeMap<String, String>>>,
    /// Placeholders show only while the document can be edited (default
    /// true).
    #[prop(default = true)]
    pub show_only_when_editable: Prop<bool>,
    /// Only the empty block the selection's anchor is in shows its
    /// placeholder (default true); `false`: every empty block.
    #[prop(default = true)]
    pub show_only_current: Prop<bool>,
    /// Empty blocks nested in others (in quotes, list items) show
    /// placeholders too (default false: the document's top level only).
    #[prop(default)]
    pub include_children: Prop<bool>,
    /// Which blocks around the selection take the `focusedNode` part while
    /// the editor has the focus (Tiptap's focus extension): `"all"` (the
    /// default: every block the selection is in), `"deepest"` (the
    /// innermost) or `"shallowest"` (the top-level one).
    pub focus_mode: Prop<Option<SharedString>>,
    /// The editor takes the focus when it appears.
    #[prop(default)]
    pub auto_focus: Prop<bool>,
    /// Classes of the editor's parts and of the document's nodes and marks
    /// (by type name), after their own styles.
    #[prop(default)]
    pub classes: Prop<RichEditorClasses>,
    /// Inline styles of the parts, over their classes.
    #[prop(default)]
    pub styles: Prop<RichEditorStyles>,
    /// What screen readers call the editor.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Tiptap's bubble menu: shown next to the selection while the app
    /// fills it (the app decides when, from the session's state: a link
    /// under the caret, a selection of text), above it, below it where
    /// there is no room, in an overlay that follows the text as it
    /// scrolls. It looks like nothing: the app's content is the menu.
    pub bubble_menu: Prop<Option<Slot>>,
    /// Where the bubble menu goes against the selection (default
    /// `"top"`; it flips to the other side without room).
    #[prop(default = Placement::Top)]
    pub bubble_menu_placement: Prop<Placement>,
    /// The gap between the selection and the bubble menu (default 8).
    #[prop(default = px(8.0))]
    pub bubble_menu_offset: Prop<Points>,
}

/// A change of a `RichEditor`'s document. The document itself is read on
/// demand (`docJson()`), never sent with every change.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct RichEditorChange {
    /// The state's revision after the change (it counts the transactions
    /// applied).
    pub revision: u64,
}

/// A `RichEditor`'s selection, in document positions.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct RichEditorSelection {
    /// The kind: `"text"`, `"node"`, `"all"` or a custom kind's id.
    pub kind: String,
    /// Where it was started.
    pub anchor: u32,
    /// Where it was extended to (the caret).
    pub head: u32,
    /// Its start.
    pub from: u32,
    /// Its end.
    pub to: u32,
    /// Whether it selects nothing (a caret).
    pub empty: bool,
}

impl RichEditorSelection {
    pub(crate) fn of(state: &EditorState) -> Self {
        let s = state.selection();
        Self {
            kind: s.json_id().to_owned(),
            anchor: s.anchor() as u32,
            head: s.head() as u32,
            from: s.from() as u32,
            to: s.to() as u32,
            empty: s.empty(),
        }
    }
}

/// The events of a [`RichEditor`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum RichEditorEvent {
    /// The document changed.
    #[args(change)]
    Change(RichEditorChange),
    /// The selection changed.
    #[args(selection)]
    SelectionChange(RichEditorSelection),
    /// The editor took the focus.
    Focus,
    /// The editor lost the focus.
    Blur,
}

/// The methods of a [`RichEditor`]'s ref.
pub struct RichEditorApi {
    rv: Rv,
}

#[methods]
impl RichEditorApi {
    /// Takes the focus.
    pub fn focus(&self) {
        self.rv.focus();
    }

    /// Gives the focus up.
    pub fn blur(&self) {
        self.rv.blur();
    }

    /// The document, as ProseMirror's JSON.
    pub fn doc_json(&self) -> Value {
        self.rv.session.state().doc().to_json()
    }

    /// The whole state (document, selection, plugins' states), as JSON.
    pub fn state_json(&self) -> Value {
        self.rv.session.state().to_json()
    }

    /// The selection.
    pub fn selection(&self) -> RichEditorSelection {
        RichEditorSelection::of(&self.rv.session.state())
    }

    /// Replaces the document with `doc` (ProseMirror's JSON), as a change
    /// undo takes back: whether the schema allowed it.
    pub fn set_doc_json(&self, doc: Value) -> bool {
        self.rv.set_doc_json(&doc)
    }

    /// Types `text` at the selection, as typing it would (input rules
    /// included).
    pub fn insert_text(&self, text: String) {
        self.rv.text_input(&text, false);
    }

    /// Selects `anchor..head` (document positions; a node or the nearest
    /// valid place where they are no text positions).
    pub fn set_selection(&self, anchor: u32, head: u32) {
        self.rv.select_range(anchor as usize, head as usize);
    }
}

/// A rich text editor: the document of an [`EditorSession`] rendered with
/// native views (every node and mark a part the app styles by name, node
/// views for the types the app renders itself, the plugins' decorations),
/// a caret and selection, the platform's typing, input methods, keys,
/// presses, drags and clipboard turned into transactions natively.
#[component(methods = RichEditorApi)]
pub fn RichEditor(props: RichEditorProps, cx: Scope<RichEditorEvent>) -> impl IntoElement {
    let rv = Rv::new(props, cx);
    cx.methods(RichEditorApi { rv: rv.clone() });
    render::render(rv)
}
