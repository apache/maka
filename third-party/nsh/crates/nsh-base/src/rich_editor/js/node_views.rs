//! Node views in TS: an extension's `addNodeView` returns the app's
//! component, which renders every node of the extension's node type (an
//! atom: a stock tag, a card, a mention) with `RichNodeViewProps`.
//!
//! The component is a JS function and the editor's node views are
//! `Send + Sync`, so a [`JsNodeView`] holds only the number of its entry in
//! this thread's table. Its element is a [`Renderer`] that the component's
//! host renders with the function: the value it renders carries the node
//! as JSON and whether it is selected, never its position, so typing
//! around a node calls no JS; a change of the node or of its selection
//! updates the props in place (`Renderer::__js_fn`).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use nsh_core::{
    JsonValue,
    element::{
        CallbackHandle, Class, Instance, JsHost, JsIn, JsOwned, JsValue, PropError, Ret, TsTypes,
    },
    prelude::*,
};
use rustc_hash::FxHashMap;

use super::{
    RichEditorSession,
    json::{AttrsJson, NodeViewExtensionJson, NodeViewNodeJson},
    plugins::CallGuard,
};
use crate::rich_editor::{
    model::Node,
    view::{EditorSession, NodeView, NodeViewCx},
};

/// The prop name the editor's host renders node views under.
const PROP: &str = "nodeView";

/// The app's node view component (`addNodeView`'s result).
#[derive(Clone)]
pub(crate) struct NodeViewFn(pub(crate) Rc<dyn CallbackHandle>);

impl JsValue for NodeViewFn {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "(props: {}) => JSX.Element",
            types.class(RichNodeViewProps::DEF)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        value
            .host()
            .callback(value.raw())
            .map(NodeViewFn)
            .ok_or_else(|| value.expected("a component function"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self.0.value(host) {
            Some(v) => Ok(JsOwned::new(host, v)),
            None => Ok(JsOwned::new(host, host.undefined())),
        }
    }
}

/// What a node view of an editor needs besides its function: the
/// extension it came from, and the parts of the editor its props'
/// `editor` shares.
struct Entry {
    func: Rc<dyn CallbackHandle>,
    extension: JsonValue,
    editor: super::SessionParts,
    /// The props' state of the elements, by key, while a value holds it.
    shared: RefCell<FxHashMap<SharedString, Weak<Shared>>>,
}

impl Entry {
    /// The state of the elements of `key`: the one a value still holds,
    /// else `make`'s.
    fn shared(&self, key: &SharedString, make: impl FnOnce() -> Shared) -> Rc<Shared> {
        let mut map = self.shared.borrow_mut();
        if let Some(shared) = map.get(key).and_then(Weak::upgrade) {
            return shared;
        }
        if map.len() >= 64 && map.len().is_power_of_two() {
            map.retain(|_, shared| shared.strong_count() > 0);
        }
        let shared = Rc::new(make());
        map.insert(key.clone(), Rc::downgrade(&shared));
        shared
    }
}

thread_local! {
    /// The node views of the editors made on this thread, by number
    /// (`None` once their editor went).
    static ENTRIES: RefCell<Vec<Option<Rc<Entry>>>> = const { RefCell::new(Vec::new()) };
}

/// An app's node view, for the nodes of one type of one editor.
pub(crate) struct JsNodeView {
    index: usize,
}

impl JsNodeView {
    /// The node view rendering with `func`, for the extension `extension`
    /// (`{ name, options }`) of an editor of `editor`'s parts.
    pub(crate) fn new(func: NodeViewFn, extension: JsonValue, editor: super::SessionParts) -> Self {
        let entry = Rc::new(Entry {
            func: func.0,
            extension,
            editor,
            shared: RefCell::default(),
        });
        let index = ENTRIES.with(|entries| {
            let mut entries = entries.borrow_mut();
            match entries.iter().position(Option::is_none) {
                Some(free) => {
                    entries[free] = Some(entry);
                    free
                }
                None => {
                    entries.push(Some(entry));
                    entries.len() - 1
                }
            }
        });
        Self { index }
    }

    fn entry(&self) -> Option<Rc<Entry>> {
        ENTRIES
            .try_with(|entries| entries.borrow().get(self.index).cloned().flatten())
            .ok()
            .flatten()
    }
}

impl Drop for JsNodeView {
    fn drop(&mut self) {
        // Elsewhere (a session dropped on another thread) the entry stays:
        // the function cannot be released there anyway.
        let _ = ENTRIES.try_with(|entries| {
            if let Ok(mut entries) = entries.try_borrow_mut()
                && let Some(slot) = entries.get_mut(self.index)
            {
                *slot = None;
            }
        });
    }
}

impl NodeView for JsNodeView {
    fn create(&self, cx: &NodeViewCx, _node: &Node) -> AnyElement {
        let Some(entry) = self.entry() else {
            return view().into_element();
        };
        let (host, key) = cx.at.clone();
        // An element made again for the same node (its block's spans are,
        // as text is typed around it) shares the props' state, so its value
        // stays equal and no JS runs.
        let shared = entry.shared(&key, || Shared {
            editor: Instance::new(RichEditorSession::of_parts(
                &entry.editor,
                cx.session.clone(),
            )),
            extension: entry.extension.clone(),
            pos: Cell::new(None),
            generation: Cell::new(0),
            session: cx.session.clone(),
        });
        let generation = shared.generation.get() + 1;
        shared.generation.set(generation);
        // JS reads no Rust signal: the position is kept here as the node
        // moves (an edit before it), for `getPos` to read.
        {
            let (kept, get_pos, moves) = (shared.clone(), cx.get_pos(), cx.moves);
            effect(move || {
                if let Some(moves) = moves {
                    moves.get();
                }
                kept.pos.set(get_pos());
            });
            let kept = shared.clone();
            cleanup(move || {
                if kept.generation.get() == generation {
                    kept.pos.set(None);
                }
            });
        }
        let renderer = Renderer::__js_fn(PROP, host, entry.func.clone());
        let (node, selected) = (cx.node(), cx.selected());
        dynamic(move || {
            let value = NodeViewValue {
                node: node.with(node_json),
                selected: selected.get(),
                shared: shared.clone(),
            };
            renderer.render(key.clone(), value)
        })
        .into_element()
    }

    /// The element follows the node: its props change in place.
    fn update(&self, _node: &Node, _decorations: &[crate::rich_editor::state::Decoration]) -> bool {
        true
    }
}

/// A node as its view's props show it: its type, attributes and text.
fn node_json(node: &Node) -> JsonValue {
    serde_json::json!({
        "type": node.ty().name(),
        "attrs": node.to_json().get("attrs").cloned().unwrap_or_else(|| serde_json::json!({})),
        "textContent": node.text_content(),
    })
}

/// What every value of one element of a node view shares.
struct Shared {
    editor: Instance<RichEditorSession>,
    extension: JsonValue,
    /// Where the node starts (`None` once its element is gone).
    pos: Cell<Option<usize>>,
    /// Which of the elements sharing it is the current one.
    generation: Cell<u64>,
    session: EditorSession,
}

/// The value a node view's element renders: the props, in Rust.
#[derive(Clone)]
pub(crate) struct NodeViewValue {
    node: JsonValue,
    selected: bool,
    shared: Rc<Shared>,
}

impl PartialEq for NodeViewValue {
    fn eq(&self, other: &Self) -> bool {
        self.selected == other.selected
            && Rc::ptr_eq(&self.shared, &other.shared)
            && self.node == other.node
    }
}

impl JsValue for NodeViewValue {
    fn ts_type(types: &mut TsTypes) -> String {
        types.class(RichNodeViewProps::DEF)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("a node view's props (made by the editor)"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Instance::new(RichNodeViewProps {
            node: self.node.clone(),
            selected: self.selected,
            shared: self.shared.clone(),
        })
        .into_js(host)
    }
}

/// What an extension's node view component (`addNodeView`) gets: the
/// node, whether a node selection holds it, the editor and the extension,
/// and functions that change the node through the editor (one undoable
/// change each). Read in a reactive place (JSX, an effect), `node` and
/// `selected` follow the node.
#[class]
pub(crate) struct RichNodeViewProps {
    node: JsonValue,
    selected: bool,
    shared: Rc<Shared>,
}

#[class]
impl RichNodeViewProps {
    /// The node: `{ type, attrs, textContent }`.
    #[getter]
    pub(crate) fn node(&self) -> NodeViewNodeJson {
        NodeViewNodeJson(self.node.clone())
    }

    /// Whether a node selection holds the node.
    #[getter]
    pub(crate) fn selected(&self) -> bool {
        self.selected
    }

    /// The editor the node is in.
    #[getter]
    pub(crate) fn editor(&self) -> Instance<RichEditorSession> {
        self.shared.editor.clone()
    }

    /// The extension that added the view: `{ name, options }`.
    #[getter]
    pub(crate) fn extension(&self) -> NodeViewExtensionJson {
        NodeViewExtensionJson(self.shared.extension.clone())
    }

    /// Where the node starts in the current document; `undefined` once it
    /// is gone.
    pub(crate) fn get_pos(&self) -> Option<f64> {
        self.shared.pos.get().map(|p| p as f64)
    }

    /// Sets the node's attributes in `attrs` (the others stay), as one
    /// change. Throws for one the node's type does not have.
    pub(crate) fn update_attributes(&self, attrs: AttrsJson) -> Result<(), String> {
        let JsonValue::Object(attrs) = attrs.0 else {
            return Err("updateAttributes takes an object of attributes".into());
        };
        let Some(pos) = self.shared.pos.get() else {
            return Ok(());
        };
        let session = &self.shared.session;
        let state = session.state();
        let node = state
            .doc()
            .node_at(pos)
            .ok_or("updateAttributes: the node is gone")?;
        for name in attrs.keys() {
            if !node.ty().spec().attrs.iter().any(|(n, _)| n == name) {
                return Err(format!(
                    "updateAttributes: `{}` has no attribute `{name}`",
                    node.ty().name()
                ));
            }
        }
        let mut tr = state.tr();
        for (name, value) in attrs {
            tr.set_node_attribute(pos, &name, value)
                .map_err(|e| e.to_string())?;
        }
        let _guard = CallGuard::enter();
        session.dispatch(tr).map_err(|e| e.to_string())
    }

    /// Deletes the node, as one change.
    pub(crate) fn delete_node(&self) -> Result<(), String> {
        let Some(pos) = self.shared.pos.get() else {
            return Ok(());
        };
        let session = &self.shared.session;
        let state = session.state();
        let Some(node) = state.doc().node_at(pos) else {
            return Ok(());
        };
        let mut tr = state.tr();
        tr.delete(pos, pos + node.node_size())
            .map_err(|e| e.to_string())?;
        let _guard = CallGuard::enter();
        session.dispatch(tr).map_err(|e| e.to_string())
    }
}
