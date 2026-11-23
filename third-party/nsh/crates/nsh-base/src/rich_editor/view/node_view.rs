//! Node views: native UI the app renders for the nodes of a type (a stock
//! card, an image with a caption, a math block, a task item's checkbox),
//! after ProseMirror's `NodeView`.
//!
//! A node view is registered per node type ([`super::NodeViews`], or a
//! plugin's `node_views` holding an `Arc<dyn NodeView>`) and renders every
//! node of its type: [`NodeView::create`] makes the element of one node,
//! which follows that node through [`NodeViewCx::node`] (a signal) as long
//! as [`NodeView::update`] keeps it. A node view never changes the
//! document itself: it dispatches transactions through
//! [`NodeViewCx::session`], at the position [`NodeViewCx::pos`] gives, so
//! its changes are undone, mapped and checked as any other.

use std::{cell::RefCell, fmt, rc::Rc};

use nsh_core::prelude::*;

use super::session::EditorSession;
use crate::rich_editor::{
    model::{Mark, Node},
    state::{ClickEvent, Decoration, KeyEvent},
};

/// What happened inside a node view, offered to it before the editor acts
/// ([`NodeView::handle_event`]).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum NodeViewEvent {
    /// A press on the node, where it is in the node's box.
    Press {
        /// Where, in the node's box.
        at: Point<Points>,
        /// The press's buttons and modifiers.
        click: ClickEvent,
    },
    /// A key pressed while the node is selected.
    Key(KeyEvent),
}

/// What a node view gets to render a node and act on it.
pub struct NodeViewCx {
    /// The session the node is in: what changes go through.
    pub session: EditorSession,
    get_pos: Rc<dyn Fn() -> Option<usize>>,
    node: ReadSignal<Node>,
    selected: ReadSignal<bool>,
    decorations: ReadSignal<Vec<Decoration>>,
    content: RefCell<Option<AnyElement>>,
    /// The editor's component host and the element's key among the
    /// editor's node views (stable while the node stays where it is in
    /// its block): where an app's JS node view renders.
    pub(crate) at: (nsh_core::NodeId, SharedString),
    /// What the node's position follows (the document revision): read before
    /// [`NodeViewCx::pos`] in an effect, it reruns when the node moves.
    pub(crate) moves: Option<ReadSignal<u64>>,
}

impl fmt::Debug for NodeViewCx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NodeViewCx")
            .field("pos", &(self.get_pos)())
            .finish_non_exhaustive()
    }
}

impl NodeViewCx {
    pub(crate) fn new(
        session: EditorSession,
        get_pos: Rc<dyn Fn() -> Option<usize>>,
        node: ReadSignal<Node>,
        selected: ReadSignal<bool>,
        decorations: ReadSignal<Vec<Decoration>>,
        content: Option<AnyElement>,
    ) -> Self {
        Self {
            session,
            get_pos,
            node,
            selected,
            decorations,
            content: RefCell::new(content),
            at: (0, SharedString::default()),
            moves: None,
        }
    }

    /// Rendered by the editor on node `host`, under `key`.
    pub(crate) fn rendered_at(
        mut self,
        host: nsh_core::NodeId,
        key: SharedString,
        moves: ReadSignal<u64>,
    ) -> Self {
        self.at = (host, key);
        self.moves = Some(moves);
        self
    }

    /// Where the node starts in the current document (ProseMirror's
    /// `getPos`); `None` once it is gone.
    pub fn pos(&self) -> Option<usize> {
        (self.get_pos)()
    }

    /// The node getter, to keep in the element's handlers.
    pub fn get_pos(&self) -> Rc<dyn Fn() -> Option<usize>> {
        self.get_pos.clone()
    }

    /// The node, as it changes (while [`NodeView::update`] keeps the
    /// element).
    pub fn node(&self) -> ReadSignal<Node> {
        self.node
    }

    /// Whether a node selection holds the node.
    pub fn selected(&self) -> ReadSignal<bool> {
        self.selected
    }

    /// The decorations over the node.
    pub fn decorations(&self) -> ReadSignal<Vec<Decoration>> {
        self.decorations
    }

    /// The editor's rendering of the node's content, for a view with an
    /// editable content slot ([`NodeView::editable_content_slot`]): the
    /// element puts it where the content goes. Taken once; `None` for
    /// atoms.
    pub fn take_content(&self) -> Option<AnyElement> {
        self.content.borrow_mut().take()
    }
}

/// Native UI for the nodes of one type. Every method but `create` has a
/// default.
pub trait NodeView: Send + Sync {
    /// The element of `node`: nsh primitives, components, anything. It
    /// follows the node through `cx.node()` while [`NodeView::update`]
    /// keeps it.
    fn create(&self, cx: &NodeViewCx, node: &Node) -> AnyElement;

    /// `node` replaced the node an element shows (an attribute or its
    /// content changed), under `decorations`: `true` keeps the element
    /// (it follows `cx.node()`), `false` (the default) has it made again.
    fn update(&self, node: &Node, decorations: &[Decoration]) -> bool {
        let _ = (node, decorations);
        false
    }

    /// Whether the editor renders the node's content, editable, into the
    /// element (`cx.take_content()`); `false` (the default) makes the node
    /// an atom, edited as one unit. The content's place in the element is
    /// measured again when its frame in its parent changes and when the
    /// element's size does: a part that moves the content without either
    /// (a wider marker before content in a fixed-width box) leaves the
    /// caret and presses where the content was, so let the content's box
    /// grow and shrink with it (`flex_1`).
    fn editable_content_slot(&self) -> bool {
        false
    }

    /// A node selection took a node of the view's (its element also
    /// follows `cx.selected()`).
    fn select(&self) {}

    /// The node selection left it.
    fn deselect(&self) {}

    /// An event inside a node of the view: `true` keeps it from the
    /// editor.
    fn handle_event(&self, event: &NodeViewEvent) -> bool {
        let _ = event;
        false
    }

    /// Whether changes the element makes to itself are its own, not the
    /// document's (always so for native elements: ProseMirror's
    /// `ignoreMutation` for the DOM). The default is `true`.
    fn ignore_mutation(&self) -> bool {
        true
    }

    /// An element of the view is gone (its node was deleted, or it is made
    /// again).
    fn destroy(&self) {}
}

/// Native UI for the text under the marks of one type (a mention's chip,
/// a link that previews on hover), after ProseMirror's `MarkView`.
/// Registered by a plugin's `mark_views` as an `Arc<dyn MarkView>`, by the
/// mark type's name; the outermost mark of a text with a view renders it.
pub trait MarkView: Send + Sync {
    /// The span of `text` under `mark`, in its textblock's text: a `text`
    /// span holding `text` as it is (the caret and selection place
    /// themselves by its characters), styled as the app likes.
    fn create(&self, mark: &Mark, text: &str) -> AnyElement;

    /// A piece cut from a marked text node by decorations. Source-backed views
    /// can use the original node-relative bytes and honor the decoration classes.
    fn create_piece(
        &self,
        mark: &Mark,
        text: &str,
        _source_bytes: std::ops::Range<usize>,
        _classes: &[String],
    ) -> AnyElement {
        self.create(mark, text)
    }
}
