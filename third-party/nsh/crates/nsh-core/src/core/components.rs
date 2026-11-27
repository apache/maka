//! Rust components in the core ([`crate::element`]): creating instances,
//! expanding their views into nodes (once: what changes later comes as
//! patches, [`super::views`]), placing JS children and slots, and routing
//! events.
//!
//! A component's host node is the root of its expansion: the root element's
//! props and styles apply to it, its other elements become nodes with odd
//! ids (JS uses even ones) owned by the host. Ops from JS on a host are
//! intercepted ([`Core::apply`]): its `class` goes after the root's styles,
//! its children are placed where the view's `Children` is. Views are made
//! at the start of a commit, so a view starts with all the props set in
//! the JS turn before.

use std::{any::Any, cell::RefCell, rc::Rc, sync::Arc};

use rustc_hash::{FxHashMap, FxHashSet};

use super::{Core, Key, Kind, NO_KEY, views::Anchor};
use crate::{
    ApplyError, Command, EdgeInsets, EventKind, EventMask, EventPayload, NodeId, Op, Prop, ROOT_ID,
    Tag, TextEngine,
    element::{
        Action, AnswerSlot, AnyInstance, AnyValue, Attrs, Child, ClipboardRead, ComponentError,
        ComponentSpec, ElKind, ElNode, Environment, Executor, FileAnswer, ImageSize, IntoElement,
        JsEvent, JsResult, ListConfig, Listener, ModuleCx, ParentElement, PlaceFn, Position, Posts,
        Reactive, Registry, Root, RustCall, RustOp, SharedString, StyleRefinement, Task, Tokens,
        caught,
        responder::ResponderEl,
        services::FetchFailure,
        view,
        virtual_list::{self, RowFn, SeparatorFn, VirtualListEl},
    },
    geometry::Points,
    list_diff::ListDiff,
    tailwind::ClassList,
};

/// Lowered styles kept for reuse (many elements have the same styles);
/// cleared when full.
const STYLE_CACHE: usize = 4096;

/// Rounds of polls and updates per run of the tasks, at most.
const MAX_TASK_ROUNDS: u32 = 64;

/// A component made by name whose part is not registered yet.
struct ByName {
    id: std::any::TypeId,
    props: Box<dyn crate::element::builder::AnyProps>,
    /// Where it was made: its context comes from there.
    owner: crate::element::Owner,
}

thread_local! {
    /// What asks the platform for the part that registers a component
    /// made by name ([`set_part_requester`]).
    static PART_REQUESTER: std::cell::Cell<Option<fn(&str)>> = const { std::cell::Cell::new(None) };
}

/// Sets what asks the platform for the code of a component made by name
/// that no UI set registers yet (a web runtime loads the side module of
/// its part, then calls its gate): it gets the component's registered
/// name. Without one, such a component shows nothing until a set
/// registers it.
#[doc(hidden)]
pub fn set_part_requester(request: fn(&str)) {
    PART_REQUESTER.with(|r| r.set(Some(request)));
}

/// What renders on a host node.
enum Inner {
    /// Nothing is registered under the name: renders nothing.
    Missing,
    Component(Box<dyn AnyInstance>),
    /// A list cell of a component's list: the component's row function
    /// wraps the row the app rendered.
    Row {
        place: PlaceFn,
        index: usize,
    },
    /// A cell of a component's own list ([`crate::element::virtual_list`]): it
    /// renders row `index` with the list's row function.
    VirtualRow {
        list: NodeId,
        index: usize,
    },
}

/// A list's row count and keys.
type Rows = (u32, Option<Rc<[u64]>>);

/// The parts of a view's list cells that show rows: the index each one's
/// content reads, and the content's owner.
type CellRows = Rc<RefCell<CellRowMap>>;

/// The index and owner of each part of a list's cells showing a row.
type CellRowMap = FxHashMap<NodeId, (CellPosition, crate::element::Owner)>;

/// A recycled cell can keep its contents after the row it showed went.
#[derive(Clone, Copy)]
struct CellPosition {
    index: crate::element::Signal<usize>,
    bound: crate::element::Signal<bool>,
}

/// A component's own list.
struct VirtualListState {
    /// The component whose view it is in (its rows' handlers are its).
    owner: NodeId,
    /// The owner of the run that made the list, if any: its rows are made
    /// under it and disposed with it. Shared with the cleanup each run
    /// registers, which disposes the rows only while the list is still
    /// that run's.
    scope: Rc<std::cell::Cell<Option<crate::element::Owner>>>,
    row: RowFn,
    count: u32,
    keys: Option<Rc<[u64]>>,
    separator: Option<SeparatorFn>,
    /// The cells, by recycling slot.
    cells: Vec<NodeId>,
    /// In a view: the live parts of its cells (cells and contents) with the
    /// index their content reads and its owner, for its rows' binding.
    rows: CellRows,
    /// The memo of a bound count or keys, which moves the cells' indices
    /// as the rows change: their positions run it before they are read.
    moves: Option<crate::element::reactive::Node>,
    /// The rows of another component's `Items` prop
    /// ([`crate::element::ComponentElement::items`]): each cell is that
    /// component's wrapper (`place`, its row function: an [`Inner::Row`])
    /// around a node rendering the row (an [`Inner::VirtualRow`], in
    /// `contents` by slot), so each part's handlers run with its own
    /// component.
    items: bool,
    place: Option<PlaceFn>,
    contents: Vec<NodeId>,
    /// Viewable rows: how long they must stay, the range reported last and
    /// the latest, and the report waiting for the time to pass.
    min_view: Option<std::time::Duration>,
    reported: Option<(u32, u32)>,
    latest: Option<(u32, u32)>,
    report: Option<Task<()>>,
}

/// Where a host's JS children are.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Placement {
    /// Out of the tree (the view has no place for them).
    None,
    /// In this node, before what the view puts after its `Children` (their
    /// anchor: a node, or a region, whose nodes may come later).
    At(NodeId, Anchor),
    /// Each in its own wrapper ([`ParentElement::children_each`]): placed
    /// by the view's region of wrappers.
    Each,
    /// Passed on as the children of the nested component hosted by this
    /// node (`<Inset>{children}</Inset>`), before the content after them
    /// (their anchor, as [`Self::At`]'s): its view places them.
    Nested(NodeId, Anchor),
}

/// A view's handlers of native events, by node, each node's in the order
/// its element was given them. A view can have thousands of nodes with
/// handlers (a rich editor's blocks, each with its layout listener), and
/// an event, a node made again and a check for a node's listener each
/// look at that node's handlers only: a list of the whole view would be
/// scanned for each, so mounting such a view would grow with its square.
#[derive(Default)]
pub(super) struct Handlers {
    by_node: FxHashMap<NodeId, Vec<(EventKind, Listener<EventPayload>)>>,
}

impl Handlers {
    /// Node `node`'s handlers, in order.
    pub(super) fn of(&self, node: NodeId) -> &[(EventKind, Listener<EventPayload>)] {
        self.by_node.get(&node).map_or(&[], Vec::as_slice)
    }

    /// Adds `listener` of `kind` to node `node`'s, after the ones it has.
    pub(super) fn push(&mut self, node: NodeId, kind: EventKind, listener: Listener<EventPayload>) {
        self.by_node.entry(node).or_default().push((kind, listener));
    }

    /// Drops node `node`'s handlers.
    pub(super) fn remove(&mut self, node: NodeId) {
        self.by_node.remove(&node);
    }

    /// Keeps the handlers of the nodes `keep` keeps.
    pub(super) fn retain_nodes(&mut self, mut keep: impl FnMut(&NodeId) -> bool) {
        self.by_node.retain(|node, _| keep(node));
    }

    /// Moves node `old`'s handlers to node `new` (a slot's target moving to
    /// another node), after the ones `new` has.
    pub(super) fn rename(&mut self, old: NodeId, new: NodeId) {
        if old == new {
            return;
        }
        if let Some(moved) = self.by_node.remove(&old) {
            self.by_node.entry(new).or_default().extend(moved);
        }
    }

    pub(super) fn clear(&mut self) {
        self.by_node.clear();
    }

    /// How many handlers there are, on all nodes.
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.by_node.values().map(Vec::len).sum()
    }
}

/// A component instance on its host node.
pub(super) struct Instance {
    inner: Inner,
    spec: Option<Arc<ComponentSpec>>,
    /// The app's `class` and `classList` on the host.
    pub(super) class: Box<str>,
    pub(super) class_list: Vec<Box<str>>,
    /// The app's classes, or the styles the view this one is in gives it:
    /// applied after the root's own.
    pub(super) user: Option<std::rc::Rc<ClassList>>,
    /// Events JS listens to on the host.
    js_events: EventMask,
    /// The listeners the view this one is in gives its element
    /// (`.on_mouse_enter(..)` on a nested component's element), run by
    /// that view's component after the root's own, as JS's on a host are.
    given_handlers: Vec<(EventKind, Listener<EventPayload>)>,
    /// The events of `given_handlers`.
    given_events: EventMask,
    /// The view, expanded (its root is the host); a list cell's row as
    /// built last.
    root: Option<Expanded>,
    /// The host's JS children, in order.
    pub(super) js_children: Vec<NodeId>,
    pub(super) children_at: Placement,
    /// Lazy children (`#[prop(lazy)]`): whether JS was told to make them.
    children_wanted: bool,
    /// The glue's node of each slot the app passes.
    slots: Vec<(&'static str, NodeId)>,
    /// The view's handlers of native events, by node.
    pub(super) handlers: Handlers,
    /// The events of nested components, by their host (a handful: a list
    /// beats a map).
    pub(super) event_handlers: Vec<(NodeId, Listener<dyn Any>)>,
    /// The view's parts in the touch responder, by node.
    pub(super) responders: Vec<(NodeId, Rc<ResponderEl>)>,
    /// The app's `style` on the host, applied after the root's own inline
    /// style and animated values.
    pub(super) app_style: Option<crate::StylePatch>,
    dirty: bool,
    /// Its view is made again, in place of the one it showed (a component
    /// made by name, made when its part is registered).
    remake: bool,
    /// The nodes of its view with bindings: what was applied last. Boxed:
    /// a record is large, and a map's free slots are as large as its
    /// entries.
    pub(super) bound: FxHashMap<NodeId, Box<super::views::BoundNode>>,
    /// In a view placing its JS children one by one: them, as a signal.
    pub(super) js_kids: Option<crate::element::Signal<Vec<NodeId>>>,
    /// A cell of a view's list: the owner of the row it shows.
    cell_owner: Option<crate::element::Owner>,
    /// ... and the index its content reads (its [`Position`]): a cell
    /// that shows another row sets it instead of being built again.
    cell_position: Option<CellPosition>,
    /// Lazy children a view passes: whether it places them, which what
    /// passes them reads.
    lazy_wanted: Option<crate::element::Signal<bool>>,
    /// In a view: the owner where it places its JS children (a region's),
    /// which the components JS made among them are under.
    children_owner: Option<crate::element::Owner>,
    /// It joined a host as its children (content a view passed a nested
    /// component, `tabs().child(tab())`, or inside plain views of that
    /// content): its view waits, as one JS made does, to be in the tree
    /// under where that host's view places it, so it reads the context
    /// there.
    joined: bool,
    /// The component its view's root is, made on this host (its alias,
    /// [`Core::alias`]): its view makes the host's node.
    rooted: Option<NodeId>,
    /// On such a component: the host (or alias) whose view's root it is.
    pub(super) above: Option<NodeId>,
    /// What the view this one is in fills its slots with ([`Fill`]).
    pub(super) fills: Vec<Fill>,
    /// What the view this one is in gives its element besides styles (its
    /// inline style, animated values, insets): they apply to its root,
    /// after the root's own, as the styles do.
    pub(super) given: Option<Box<Attrs>>,
    /// `given` changed since its root last took it.
    given_changed: bool,
    /// The insets its root's node has (its own, or given it).
    pub(super) root_insets_applied: (Option<crate::EdgeInsets>, Option<crate::EdgeInsets>),
    /// The test id its root's node has (its own, or given it).
    pub(super) root_test_id_applied: Option<Arc<str>>,
}

/// The test id among `attrs`' props.
pub(super) fn test_id_of(attrs: &Attrs) -> Option<Arc<str>> {
    attrs.props.iter().find_map(|p| match p {
        Prop::TestId(id) => id.clone(),
        _ => None,
    })
}

/// `attrs` with the test id `id` in place of its own (`None`: none), as its
/// node has it.
pub(super) fn with_test_id(mut attrs: Attrs, id: &Option<Arc<str>>) -> Attrs {
    attrs.props.retain(|p| !matches!(p, Prop::TestId(_)));
    if let Some(id) = id {
        attrs.props.push(Prop::TestId(Some(id.clone())));
    }
    attrs
}

/// What a component's root takes from the components above it on its host
/// and the views that place them ([`Core::root_context`]).
pub(super) struct RootContext {
    /// Their styles, after the root's (the outer last).
    pub(super) user: Option<std::rc::Rc<ClassList>>,
    /// Whether `app` is what goes after the root's inline style (else the
    /// component's own app style is).
    pub(super) combined: bool,
    /// The inline styles and animated values they give it (the inner
    /// first), then the app's style on the top host.
    pub(super) app: Option<crate::StylePatch>,
    /// JS's events on the top host.
    pub(super) js: Option<EventMask>,
    /// The events of the listeners the views above give it (and the
    /// components whose root it is).
    pub(super) given_events: EventMask,
    /// The insets given it (the outer wins).
    inset_padding: Option<crate::EdgeInsets>,
    inset_margin: Option<crate::EdgeInsets>,
    /// The test id given it (the outer wins), over the root's own.
    test_id: Option<Arc<str>>,
    /// Whether any view gives it anything besides styles.
    given: bool,
}

impl RootContext {
    /// `attrs` (a root's) with the insets given it.
    pub(super) fn over(&self, mut attrs: Attrs) -> Attrs {
        if let Some(insets) = self.inset_padding {
            attrs.rare_mut().inset_padding = Some(insets);
        }
        if let Some(insets) = self.inset_margin {
            attrs.rare_mut().inset_margin = Some(insets);
        }
        if let Some(id) = &self.test_id {
            crate::element::host::set_in(&mut attrs.props, Prop::TestId(Some(id.clone())));
        }
        attrs
    }
}

/// What a view fills a nested component's slot with (`.fill(name, el)`, a
/// tag's slot method): nodes of that view, which the nested view places as
/// they are where it places the slot (a node of its own around them only
/// where it styles the slot). A slot JS fills has a holder node instead
/// (`Instance::slots`).
pub(super) struct Fill {
    pub(super) name: &'static str,
    /// Its parts in order: nodes, regions whose nodes come and go, and
    /// what fills the placing view's own slots.
    parts: Vec<FillPart>,
    /// The host of the view that fills it.
    from: NodeId,
    /// Where the nested view places them.
    pub(super) at: Placement,
    /// The slot of a component in the nested view whose fill places this
    /// one (`.fill(name, props.slot.place(|s| s))`): its nodes go there.
    forwarded: Option<(NodeId, &'static str)>,
}

/// A part of a [`Fill`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum FillPart {
    Node(NodeId),
    Region(u32),
    /// What fills the placing view's own slot of this name, passed on.
    Filled(&'static str),
}

impl Instance {
    fn new(
        inner: Inner,
        spec: Option<Arc<ComponentSpec>>,
        js_children: Vec<NodeId>,
        app_style: Option<crate::StylePatch>,
    ) -> Self {
        Self {
            inner,
            spec,
            class: "".into(),
            class_list: Vec::new(),
            user: None,
            js_events: EventMask::default(),
            given_handlers: Vec::new(),
            given_events: EventMask::default(),
            root: None,
            js_children,
            children_at: Placement::None,
            children_wanted: false,
            slots: Vec::new(),
            handlers: Handlers::default(),
            event_handlers: Vec::new(),
            responders: Vec::new(),
            app_style,
            dirty: false,
            remake: false,
            bound: FxHashMap::default(),
            js_kids: None,
            cell_owner: None,
            cell_position: None,
            lazy_wanted: None,
            children_owner: None,
            joined: false,
            rooted: None,
            above: None,
            fills: Vec::new(),
            given: None,
            given_changed: false,
            root_insets_applied: (None, None),
            root_test_id_applied: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Part {
    Node,
    /// A slot's node: JS's, never released by the core.
    Slot,
    /// Where the JS children are (no node of its own).
    Children,
    /// A nested component.
    Component(&'static str),
    /// A list of the component's own rows; its cells are the core's.
    VirtualList,
    /// One of the JS children (no node of its own).
    JsChild,
    /// A piece of a text's content: a raw text node.
    Raw,
    /// A region of a view's children (no node of its own:
    /// [`super::views`]).
    Region(u32),
    /// What this view fills a nested component's slot with (no node of
    /// its own: its children are the nodes).
    Fill(&'static str),
    /// Where this view places what fills its slot (no node of its own).
    Filled(&'static str),
}

/// A node's app classes ([`Components::app_classes`]): its own rules, the
/// classes, and what goes after them.
pub(super) type AppClass = (
    Option<std::rc::Rc<ClassList>>,
    SharedString,
    Option<std::rc::Rc<ClassList>>,
);

/// The node's classes: its styles lowered, and what was merged after them.
pub(super) type Classes = (
    Option<std::rc::Rc<ClassList>>,
    Option<std::rc::Rc<ClassList>>,
);

/// An element of a view, as it was applied.
pub(super) struct Expanded {
    pub(super) id: NodeId,
    pub(super) tag: Tag,
    pub(super) key: Option<SharedString>,
    /// A text's content and its raw text node.
    text: Option<(SharedString, NodeId)>,
    attrs: Attrs,
    style: StyleRefinement,
    classes: Classes,
    events: EventMask,
    /// A list's layout, when this element is a `VirtualList`.
    list: Option<Box<ListConfig>>,
    pub(super) part: Part,
    pub(super) children: Vec<Expanded>,
}

impl Expanded {
    /// A node of JS's in the view (`id` 0: the place of the children).
    pub(super) fn js(id: NodeId, part: Part) -> Self {
        Self {
            id,
            tag: Tag::View,
            key: None,
            text: None,
            attrs: Attrs::default(),
            style: StyleRefinement::default(),
            classes: (None, None),
            events: EventMask::default(),
            list: None,
            part,
            children: Vec::new(),
        }
    }
}

/// A child to match with a parent's old elements
/// ([`Core::match_children`]).
#[allow(
    clippy::large_enum_variant,
    reason = "elements are matched as they come: a box for each would allocate for every child"
)]
pub(super) enum NewChild {
    /// An element, applied under its owner when it has one.
    Made(Option<crate::element::Owner>, ElNode),
    /// The old element of this key stays as it is: of an `Each` row that
    /// was there before.
    Kept(SharedString),
}

/// The keyed old elements of a parent by key ([`Core::match_children`]),
/// indexed the first time one is looked up: a few elements are searched in
/// order, many once, so a long keyed list moved or reversed is matched in
/// linear time. Old elements are only ever taken (`None`) while matching,
/// so the index stays valid.
#[derive(Default)]
pub(super) struct OldKeys {
    /// The first old element of each key.
    first: FxHashMap<SharedString, usize>,
    /// The next old element of the same key after each one (`usize::MAX`
    /// for none).
    next: Vec<usize>,
    indexed: bool,
}

impl OldKeys {
    /// Up to this many old elements are searched rather than indexed.
    const SEARCHED: usize = 16;

    /// The first old element of key `key` left in `old` that is `ok`.
    fn find(
        &mut self,
        old: &[Option<Expanded>],
        key: &SharedString,
        ok: impl Fn(&Expanded) -> bool,
    ) -> Option<usize> {
        let is = |o: &Option<Expanded>| {
            o.as_ref()
                .is_some_and(|o| o.key.as_ref() == Some(key) && ok(o))
        };
        if old.len() <= Self::SEARCHED {
            return old.iter().position(is);
        }
        if !self.indexed {
            self.indexed = true;
            self.next = vec![usize::MAX; old.len()];
            // From the end, so each key's first is the earliest.
            for (at, o) in old.iter().enumerate().rev() {
                if let Some(k) = o.as_ref().and_then(|o| o.key.as_ref())
                    && let Some(next) = self.first.insert(k.clone(), at)
                {
                    self.next[at] = next;
                }
            }
        }
        // Those taken go from the front (duplicate keys taken in order are
        // not walked again).
        let first = self.first.get_mut(key)?;
        while *first != usize::MAX && old[*first].is_none() {
            *first = self.next[*first];
        }
        let mut at = *first;
        while at != usize::MAX {
            if is(&old[at]) {
                return Some(at);
            }
            at = self.next[at];
        }
        None
    }
}

/// Whether a slot's place only places it: no styles, props, listeners or
/// children of its own (what fills it then needs no node around it).
fn is_plain(el: &ElNode) -> bool {
    el.attrs == Attrs::default()
        && el.style.is_empty()
        && !el.is_bound()
        && el.handlers.is_empty()
        && el.responder.is_none()
        && el.children.is_empty()
        && el.text.is_none()
}

/// What a component's task waits for from the animation graph.
enum Awaited {
    /// An animation's end: whether it finished.
    End(AnswerSlot<bool>),
    /// A value read ([`crate::element::AnimatedValue::value`]).
    Value(AnswerSlot<f32>),
}

/// What the platform answered a clipboard read with (the root's
/// `Clipboard` event).
#[derive(Default)]
pub(super) struct ClipboardAnswer {
    /// Whether it holds what was asked.
    pub(super) has: bool,
    /// The text, for a text read.
    pub(super) text: Option<String>,
    /// Whether the person refused a text read (iOS's paste prompt): the
    /// clipboard holds text, but none was read.
    pub(super) denied: bool,
    /// The image, for an image read.
    pub(super) image: Option<crate::element::ClipboardImage>,
    /// The size in encoded bytes of an image over
    /// [`crate::platform::clipboard::MAX_IMAGE_BYTES`], left out of the
    /// answer.
    pub(super) too_large: Option<usize>,
    /// The files' `file:` URLs, for a files read.
    pub(super) files: Vec<String>,
}

impl ClipboardAnswer {
    pub(super) fn from_payload(payload: &EventPayload) -> ClipboardAnswer {
        let mut answer = ClipboardAnswer::default();
        let EventPayload::Map(entries) = payload else {
            return answer;
        };
        let (mut uri, mut width, mut height) = (None, 0.0, 0.0);
        for (k, v) in entries {
            match (*k, v) {
                ("has", crate::PayloadValue::Bool(b)) => answer.has = *b,
                ("text", crate::PayloadValue::Str(t)) => answer.text = Some(t.clone()),
                ("denied", crate::PayloadValue::Bool(b)) => answer.denied = *b,
                ("uri", crate::PayloadValue::Str(u)) => uri = Some(u.clone()),
                ("width", crate::PayloadValue::Number(n)) => width = *n,
                ("height", crate::PayloadValue::Number(n)) => height = *n,
                ("tooLarge", crate::PayloadValue::Number(n)) => {
                    answer.too_large = Some(*n as usize)
                }
                ("files", crate::PayloadValue::Str(f)) => {
                    answer.files = f
                        .lines()
                        .filter(|l| !l.is_empty())
                        .map(str::to_owned)
                        .collect()
                }
                _ => {}
            }
        }
        // Only an image NSH can show, a `data:` URI, and only one the VM
        // can hold (the web's player encodes its own).
        let uri = uri.filter(|u| u.starts_with("data:"));
        let bytes = uri.as_deref().map(crate::platform::clipboard::data_uri_len);
        if let Some(bytes) = bytes.filter(|&b| b > crate::platform::clipboard::MAX_IMAGE_BYTES) {
            answer.too_large = Some(bytes);
        } else {
            answer.image = uri.map(|url| crate::element::ClipboardImage {
                url,
                size: crate::geometry::Size::new(pixels(width), pixels(height)),
            });
        }
        answer
    }
}

/// An HTTP request of a task in flight ([`Core::fetch_event`]).
struct PendingFetch {
    /// What arrived so far.
    response: crate::element::HttpResponse,
    answer: AnswerSlot<Result<crate::element::HttpResponse, FetchFailure>>,
}

/// What notifications wait for ([`crate::notifications`]).
#[derive(Default)]
struct Notifications {
    /// The next request's id.
    next: u32,
    /// Permission requests waiting for the platform's answer.
    permissions: FxHashMap<u32, AnswerSlot<crate::notifications::NotificationPermission>>,
    /// Notifications waiting for the platform's answer.
    shows: FxHashMap<u32, AnswerSlot<bool>>,
    /// The platform was told to report presses.
    listening: bool,
    /// Presses no listener took yet.
    presses: std::collections::VecDeque<String>,
    /// The listener waiting for a press.
    next_press: Option<AnswerSlot<String>>,
}

/// The links that open the app ([`crate::url_scheme`]).
#[derive(Default)]
struct UrlScheme {
    /// The links the app claims: its schemes and web links.
    links: crate::url_scheme::AppLinks,
    /// Links no listener took yet, at most [`crate::url_scheme::MAX_PENDING`].
    pending: std::collections::VecDeque<String>,
    /// The listener waiting for a link.
    next: Option<AnswerSlot<String>>,
    /// Address moves no listener took yet
    /// ([`crate::url_scheme::AppUrlChange`]), kept once something listened
    /// ([`Self::hears_changes`]), at most [`crate::url_scheme::MAX_PENDING`].
    changes: std::collections::VecDeque<crate::url_scheme::AppUrlChange>,
    /// The listener waiting for an address move.
    next_change: Option<AnswerSlot<crate::url_scheme::AppUrlChange>>,
    /// Something listens to address moves: those before it are stale (the
    /// address has them), those after it wait between its answers.
    hears_changes: bool,
    /// The app's address: the last link taken, the page's on the web, or
    /// what the app set (`UrlScheme.setUrl`, `set_app_url`). The one copy,
    /// which every VM's `System` shares ([`Core::app_url_cell`]).
    address: crate::url_scheme::AppUrlCell,
}

/// The answer of a web sign-in session ([`crate::auth_session`]).
type AuthSessionAnswer = AnswerSlot<
    Result<crate::auth_session::AuthSessionOutcome, crate::auth_session::AuthSessionError>,
>;

/// The web sign-in session waiting for its end ([`crate::auth_session`]).
struct AuthSession {
    /// The request, as the platform's answers name it.
    id: u32,
    /// The callback scheme (lower case): a link of it ends the session.
    scheme: String,
    answer: AuthSessionAnswer,
    /// The URL request that opens the page in the system browser, where
    /// the platform shows no session: the browser not opening fails it.
    opening: Option<u32>,
}

/// Files the system opened the app with ([`crate::file_type`]).
#[derive(Default)]
struct OpenFiles {
    /// Files no listener took yet, at most [`crate::file_type::MAX_PENDING`].
    pending: std::collections::VecDeque<std::path::PathBuf>,
    /// The listener waiting for files.
    next: Option<AnswerSlot<Vec<std::path::PathBuf>>>,
}

/// Later launches of the app ([`crate::single_instance`]).
#[derive(Default)]
struct SecondInstances {
    /// Launches no listener took yet, at most
    /// [`crate::single_instance::MAX_PENDING`].
    pending: std::collections::VecDeque<crate::single_instance::SecondInstance>,
    /// The listener waiting for a launch.
    next: Option<AnswerSlot<crate::single_instance::SecondInstance>>,
}

/// The core's component state.
pub(super) struct Components {
    pub(super) web_evaluations: super::web_evaluation::Evaluations,
    pub(super) canvas_renders: super::canvas_render::Renders,
    registry: Registry,
    /// The specs of the components made by type (not by name from the
    /// registry), one per type.
    specs: FxHashMap<&'static str, Arc<ComponentSpec>>,
    /// The design tokens drawn with.
    pub(super) tokens: Arc<Tokens>,
    /// The app's tokens (a UI set's defaults, `nsh.json`'s theme, a Rust
    /// app's root): drawn with while the embedding app sets none
    /// ([`Core::set_host_tokens`]).
    app_tokens: Arc<Tokens>,
    /// The embedding app's tokens: win over [`Self::app_tokens`].
    host_tokens: Option<Arc<Tokens>>,
    /// Boxed: making a view (or applying its patches) takes its instance
    /// out of the map and back.
    pub(super) instances: FxHashMap<NodeId, Box<Instance>>,
    /// Hosts of components made by name whose part is not registered yet
    /// ([`crate::element::ComponentElement::by_name`]): made when it is.
    by_name: FxHashMap<NodeId, ByName>,
    /// Expanded node -> the host of the component whose view made it.
    pub(super) owners: FxHashMap<NodeId, NodeId>,
    /// Changes when reconciliation releases an expanded element or raw
    /// node. A region that only populates or retains nodes needs no sweep
    /// of its host's listeners and bindings.
    pub(super) release_generation: u64,
    /// Region hosts to clean before the next binding/event round. Several
    /// regions of one view can release nodes in the same patch batch.
    pub(super) released_hosts: FxHashSet<NodeId>,
    #[cfg(test)]
    pub(super) cleanup_work: super::views::CleanupWork,
    /// The handlers dispatches looked at to find a node's (for a probe that
    /// the count stays with the node's, whatever the view's size).
    #[cfg(test)]
    pub(super) handler_visits: std::cell::Cell<usize>,
    /// Siblings and overlays looked at to place views among them
    /// ([`Core::preceding`], `native_before_at`, `first_overlay_in`).
    #[cfg(test)]
    pub(super) placing_work: std::cell::Cell<usize>,
    /// Siblings looked at to find children's positions among them
    /// ([`Core::positions_changed`], `position_bits`).
    #[cfg(test)]
    pub(super) position_work: std::cell::Cell<usize>,
    /// Mount items looked at when views take the kind of their
    /// component's root ([`Core::retag`]).
    #[cfg(test)]
    pub(super) retag_work: std::cell::Cell<usize>,
    /// Rounds of renders in which views took the kind of their
    /// component's root ([`Core::end_retags`]).
    #[cfg(test)]
    pub(super) retag_rounds: std::cell::Cell<usize>,
    /// Slot nodes (`componentSlot`) -> their slot's name.
    slot_names: FxHashMap<NodeId, Arc<str>>,
    /// Slot nodes in a host -> the host.
    pub(super) slot_hosts: FxHashMap<NodeId, NodeId>,
    /// Slot nodes whose element gives them more than styles -> where that
    /// goes ([`super::slots`]).
    pub(super) slot_targets: FxHashMap<NodeId, super::slots::SlotTarget>,
    /// The app's elements a slot's props go to -> their slot node.
    pub(super) adopted: FxHashMap<NodeId, NodeId>,
    /// The nodes views wrap a slot's fill in (the place gives it more than
    /// itself): slot nodes as JS's are, their props going to the fill's one
    /// element ([`Core::reconcile_wrapper`]).
    pub(super) fill_holders: FxHashSet<NodeId>,
    styles: FxHashMap<StyleRefinement, std::rc::Rc<ClassList>>,
    /// The styles a component on another's host gets from each above it,
    /// merged (by the lists', which the entry keeps).
    pub(super) merges: FxHashMap<(usize, usize), [std::rc::Rc<ClassList>; 3]>,
    /// While a view's slot content is matched: the nested component's host
    /// and the slot (its regions are the slot's).
    pub(super) filling: Option<(NodeId, &'static str)>,
    /// The parents nodes moved out of and into since the order watches
    /// last looked (`core/watch.rs`), as an app's keyed reorder moves its
    /// rows: only a watch whose elements share one of them (or an ancestor
    /// of one) looks again.
    pub(super) moved: Vec<NodeId>,
    /// The lists components place (the glue's, of `Items` props) -> the
    /// row function the component's view gave last, and the number of rows
    /// its wrappers last saw.
    lists: FxHashMap<NodeId, (PlaceFn, u32)>,
    pub(super) environment: Environment,
    /// Runs the components' async tasks and timers.
    pub(super) executor: Rc<Executor>,
    /// Windows JS opened (`<Window>`) -> the owner and ref the Rust
    /// components inside them render under ([`Core::js_window_owner`]).
    js_windows: FxHashMap<NodeId, (crate::element::Owner, crate::element::desktop::WindowRef)>,
    /// What the platform last reported of the windows of the app's own:
    /// their state and title bar area, for the refs made after it.
    window_reports: FxHashMap<
        NodeId,
        (
            Option<crate::desktop::WindowState>,
            crate::geometry::Edges<Points>,
        ),
    >,
    /// The status bar's settings, shared by components, modules and tasks.
    pub(super) status_bars: crate::element::status_bar::StatusBars,
    /// Dialogs components show, by id: their answers.
    dialogs: FxHashMap<u32, AnswerSlot<crate::element::DialogReply>>,
    next_dialog: u32,
    /// Image sizes asked for (`Image.getSize`), by request id: their answers.
    image_infos: FxHashMap<u32, AnswerSlot<Result<ImageSize, String>>>,
    next_image_info: u32,
    /// Clipboard reads (`Clipboard.readText` / `hasText`), by request
    /// id: their answers.
    clipboard_reads: FxHashMap<u32, ClipboardRead>,
    next_clipboard_read: u32,
    /// Picks waiting for the platform's picker, by request.
    #[allow(clippy::type_complexity)]
    picks: FxHashMap<
        u32,
        (
            crate::picker::Pick,
            AnswerSlot<Vec<crate::picker::PickedFile>>,
        ),
    >,
    next_pick: u32,
    /// The sounds and players open, by id: where their events go.
    audio: FxHashMap<u32, crate::audio::AudioSink>,
    /// What notifications wait for ([`crate::notifications`]).
    notifications: Notifications,
    /// The links that open the app ([`crate::url_scheme`]).
    url_schemes: UrlScheme,
    second_instances: SecondInstances,
    open_files: OpenFiles,
    /// Calls of the embedding app's functions (`nsh/host`), by request id:
    /// their answers.
    host_calls:
        FxHashMap<u64, AnswerSlot<Result<crate::JsonValue, crate::host_channel::HostError>>>,
    next_host_call: u64,
    /// The calls and posts not handed to the engine yet
    /// ([`Core::take_host_requests`]).
    host_requests: Vec<crate::host_channel::HostRequest>,
    /// The host's events no Rust listener heard, until one of their names
    /// is added ([`Core::release_host_events`]).
    host_inbox: crate::host_channel::HostInbox,
    /// URLs being opened (`openUrl`), by request id: their answers.
    url_opens: FxHashMap<u32, AnswerSlot<bool>>,
    /// The clipboard writes sent to the platform waiting for its result,
    /// in the order sent ([`crate::EventKind::ClipboardWrite`]).
    pub(super) clipboard_writes:
        std::collections::VecDeque<AnswerSlot<crate::element::ClipboardWrite>>,
    /// Those not handed to the engine yet ([`Core::take_url_opens`]).
    url_requests: Vec<(u32, String)>,
    /// The language the app asked to show in (`Some(None)`: the user's
    /// again), for the engine ([`Core::take_locale_request`]).
    pub(super) locale_request: Option<Option<crate::platform::Locale>>,
    /// The language of the app's text last sent to an iOS or Android
    /// platform ([`Command::TextLocale`]).
    text_locale: Option<crate::platform::Locale>,
    /// The app listened to quit requests at the last commit: the platform
    /// was told its quit requests go to the app
    /// ([`crate::desktop::DesktopCommand::SetQuitOnRequest`]).
    asks_quit: bool,
    /// Functions for the platform's main thread, for the engine
    /// ([`Core::take_main_thread_tasks`]).
    main_thread: Vec<crate::main_thread::MainThreadTask>,
    next_url_open: u32,
    /// The app's settings pages being opened (`AppSettings.open`), by
    /// request id: their answers.
    app_settings_opens: FxHashMap<u32, AnswerSlot<Result<bool, crate::mobile::AppSettingsError>>>,
    next_app_settings_open: u32,
    /// Colors being picked on the screen, by request id: their answers.
    screen_colors: FxHashMap<u32, AnswerSlot<Option<crate::Hsla>>>,
    next_screen_color: u32,
    /// The shares waiting for the platform's answer
    /// ([`crate::EventKind::Share`]), by request.
    shares:
        FxHashMap<u32, AnswerSlot<Result<crate::share::ShareOutcome, crate::share::ShareError>>>,
    /// The web sign-in session waiting for its callback, if any.
    auth_session: Option<AuthSession>,
    /// Requests on local paths (`pick_paths`, `open_path`, ...), by
    /// request id: their answers.
    file_requests: FxHashMap<u32, FileAnswer>,
    next_file_request: u32,
    /// HTTP requests of tasks (`ui::fetch`), by request id: what arrived
    /// so far and the answer.
    fetches: FxHashMap<u32, PendingFetch>,
    /// Requests not handed to the engine's network stack yet.
    fetch_requests: Vec<(u32, crate::platform::HttpRequest)>,
    next_fetch: u32,
    /// The ends of the animations components started and the values they
    /// read, by id.
    animations: FxHashMap<crate::animation::AnimationId, Awaited>,
    /// Elements to measure once this commit is laid out
    /// ([`crate::element::ElementRef::measure`]).
    pub(super) measures: Vec<(NodeId, AnswerSlot<Option<crate::Measurement>>)>,
    /// Lists to tell where their viewports start once this commit is laid
    /// out ([`crate::element::ElementRef::measure_scroll_position`]).
    pub(super) scroll_positions: Vec<(NodeId, AnswerSlot<Option<crate::ListScrollPosition>>)>,
    /// Elements whose transitions' time to tell once this commit is
    /// styled ([`crate::element::ElementRef::transition_time`]).
    pub(super) transition_times: Vec<(NodeId, AnswerSlot<std::time::Duration>)>,
    /// Elements whose text to tell once this commit is applied
    /// ([`crate::element::ElementRef::text_content`]).
    pub(super) text_contents: Vec<(NodeId, AnswerSlot<String>)>,
    /// Presses to pass on inside elements once this commit is laid out
    /// ([`crate::element::ElementRef::press_at`]).
    pub(super) presses: Vec<(NodeId, crate::PressEvent, AnswerSlot<bool>)>,
    /// Pointers to pass on inside elements as the next commit starts
    /// ([`crate::element::ElementRef::hover_at`]); `None`: it left.
    pub(super) hovers: Vec<(NodeId, Option<crate::MouseEvent>)>,
    /// The web views' downloads ([`crate::webview::downloads`]): the
    /// sessions, their files and the platform's replies.
    pub(super) downloads: crate::webview::downloads::Downloads,
    /// The next id of a platform command answering a web view request
    /// (shared by the downloads' commands).
    next_webview_request: u64,
    /// The components' own lists, by node.
    virtual_lists: FxHashMap<NodeId, VirtualListState>,
    /// Views JS made, waiting to be in the tree to make their view.
    waiting: Vec<NodeId>,
    /// Calls of components' methods made before their view was (a ref is
    /// given as its component is made, and the view registers what the
    /// methods act on): host, promise, call; run once the view is made.
    parked_methods: Vec<(NodeId, u32, crate::element::MethodCall)>,
    /// The row counts the cells of views' lists read (their positions), by
    /// list, each under a root of its own that goes with the list.
    list_counts: FxHashMap<NodeId, (crate::element::Owner, crate::element::Signal<usize>)>,
    /// The layouts of views' lists with bound parts, as applied last.
    pub(super) list_layouts: FxHashMap<NodeId, ListConfig>,
    /// The insets screens and modals reported (`onInsets`).
    insets: FxHashMap<NodeId, EdgeInsets>,
    /// JS listens to the back button (`BackHandler`) on the root.
    js_back: bool,
    /// JS listens to the back gesture's steps (`BackHandler.on("progress",
    /// ..)`) on the root.
    js_back_progress: bool,
    /// The app's listeners follow the back gesture under way: decided as it
    /// starts, so a gesture an overlay takes stays the overlay's to its end.
    back_gesture: bool,
    /// JS's keyboard shortcuts (`nsh/keymap`: the root's `Prop::Keymap`),
    /// which the root's table joins with the views'.
    js_keymap: Arc<crate::keymap::Keymap>,
    /// JS listens to the root's `KeyCommand`.
    js_keys: bool,
    /// The touches the components hear and their responder.
    pub(super) touch: super::touch::TouchState,
    /// Display frames and the layout direction.
    pub(super) services: super::services::Services,
    next_id: NodeId,
    dirty: Vec<NodeId>,
    /// A reused buffer.
    props: Vec<Prop>,
    /// The reactive graph of the components that run once.
    pub(super) runtime: crate::element::Runtime,
    /// What their bindings queued.
    pub(super) patches: super::views::Patches,
    /// Their views' regions, by id.
    pub(super) regions: FxHashMap<u32, super::views::RegionState>,
    pub(super) next_region: u32,
    /// The JS calls Rust posts (the engine's queue, shared with the
    /// script): a call posted during a synchronous call from JS waits for
    /// its op ([`RustCall::Post`]).
    posts: Posts,
    /// What the app's JS functions render for the views
    /// ([`crate::element::Renderer`]).
    pub(super) renders: super::renders::Renders,
    /// Nodes of views with the app's classes (`Element::app_class`): their
    /// own rules, the classes and what goes after them, resolved again
    /// when the tokens change.
    pub(super) app_classes: FxHashMap<NodeId, AppClass>,
}

impl Default for Components {
    fn default() -> Self {
        Self {
            registry: Registry::default(),
            specs: FxHashMap::default(),
            tokens: Arc::new(Tokens::default()),
            app_tokens: Arc::new(Tokens::default()),
            host_tokens: None,
            instances: FxHashMap::default(),
            by_name: FxHashMap::default(),
            owners: FxHashMap::default(),
            release_generation: 0,
            released_hosts: FxHashSet::default(),
            #[cfg(test)]
            cleanup_work: Default::default(),
            #[cfg(test)]
            handler_visits: Default::default(),
            #[cfg(test)]
            placing_work: Default::default(),
            #[cfg(test)]
            position_work: Default::default(),
            #[cfg(test)]
            retag_work: Default::default(),
            #[cfg(test)]
            retag_rounds: Default::default(),
            slot_names: FxHashMap::default(),
            slot_hosts: FxHashMap::default(),
            slot_targets: FxHashMap::default(),
            adopted: FxHashMap::default(),
            fill_holders: FxHashSet::default(),
            styles: FxHashMap::default(),
            merges: FxHashMap::default(),
            filling: None,
            moved: Vec::new(),
            lists: FxHashMap::default(),
            environment: Environment::default(),
            executor: Rc::new(Executor::default()),
            js_windows: FxHashMap::default(),
            window_reports: FxHashMap::default(),
            status_bars: Default::default(),
            dialogs: FxHashMap::default(),
            next_dialog: 1,
            image_infos: FxHashMap::default(),
            next_image_info: 1,
            clipboard_reads: FxHashMap::default(),
            url_opens: FxHashMap::default(),
            clipboard_writes: Default::default(),
            url_requests: Vec::new(),
            locale_request: None,
            text_locale: None,
            asks_quit: false,
            main_thread: Vec::new(),
            next_url_open: 0,
            app_settings_opens: FxHashMap::default(),
            next_app_settings_open: 1,
            screen_colors: FxHashMap::default(),
            next_screen_color: 1,
            shares: FxHashMap::default(),
            auth_session: None,
            file_requests: FxHashMap::default(),
            next_file_request: 1,
            next_clipboard_read: 1,
            picks: FxHashMap::default(),
            next_pick: 1,
            audio: FxHashMap::default(),
            notifications: Notifications::default(),
            url_schemes: UrlScheme::default(),
            second_instances: SecondInstances::default(),
            open_files: OpenFiles::default(),
            host_calls: FxHashMap::default(),
            next_host_call: 1,
            host_requests: Vec::new(),
            host_inbox: Default::default(),
            web_evaluations: Default::default(),
            canvas_renders: Default::default(),
            fetches: FxHashMap::default(),
            fetch_requests: Vec::new(),
            next_fetch: 1,
            animations: FxHashMap::default(),
            measures: Vec::new(),
            scroll_positions: Vec::new(),
            transition_times: Vec::new(),
            text_contents: Vec::new(),
            presses: Vec::new(),
            hovers: Vec::new(),
            downloads: crate::webview::downloads::Downloads::default(),
            next_webview_request: 1,
            virtual_lists: FxHashMap::default(),
            list_counts: FxHashMap::default(),
            waiting: Vec::new(),
            parked_methods: Vec::new(),
            list_layouts: FxHashMap::default(),
            insets: FxHashMap::default(),
            js_back: false,
            js_back_progress: false,
            back_gesture: false,
            js_keymap: Arc::new(crate::keymap::Keymap::default()),
            js_keys: false,
            touch: super::touch::TouchState::default(),
            services: Default::default(),
            // Odd: JS allocates the even ids (1 is the root).
            next_id: 3,
            dirty: Vec::new(),
            props: Vec::new(),
            runtime: crate::element::Runtime::default(),
            patches: super::views::Patches::default(),
            regions: FxHashMap::default(),
            next_region: 1,
            posts: Posts::default(),
            renders: Default::default(),
            app_classes: FxHashMap::default(),
        }
    }
}

impl Components {
    /// Whether `list` is one of the components' own lists (bound in the
    /// core).
    pub(super) fn is_virtual_list(&self, list: NodeId) -> bool {
        self.virtual_lists.contains_key(&list)
    }

    pub(super) fn for_viewport(viewport: crate::Size<crate::Points>) -> Self {
        let mut components = Self::default();
        components.environment.window = viewport;
        // What components that run once read of the core.
        components.runtime.set_services(components.executor.clone());
        components
            .runtime
            .set_app_url(components.url_schemes.address.clone());
        components.runtime.set_environment(components.environment);
        components.runtime.set_tokens(components.tokens.clone());
        components
    }

    pub(super) fn alloc(&mut self) -> NodeId {
        let id = self.next_id;
        self.next_id += 2;
        id
    }

    pub(super) fn mark(&mut self, host: NodeId) {
        if let Some(inst) = self.instances.get_mut(&host)
            && !inst.dirty
        {
            inst.dirty = true;
            self.dirty.push(host);
        }
    }

    /// `style` as rules, shared between the elements that have it (its
    /// static declarations: bound parts are applied by bindings).
    pub(super) fn lowered(&mut self, style: &StyleRefinement) -> std::rc::Rc<ClassList> {
        if style.is_bound() {
            return self.lowered(&style.static_part());
        }
        if let Some(list) = self.styles.get(style) {
            return list.clone();
        }
        if self.styles.len() >= STYLE_CACHE {
            self.styles.clear();
        }
        let list = std::rc::Rc::new(style.lower());
        self.styles.insert(style.clone(), list.clone());
        list
    }
}

/// The inline style of `id`: the declarations of its `Style` prop, then
/// the animated values bound to it, then (on a host) the app's style.
fn inline_style(
    id: NodeId,
    inline: Option<&crate::StylePatch>,
    animated: &[(crate::StyleDecl, crate::element::LiveNode)],
    app: Option<&crate::StylePatch>,
) -> Op {
    let mut style = Box::<crate::Style>::default();
    let mut patch = crate::StylePatch::default();
    let inline = inline.map(|p| p.decls()).unwrap_or_default();
    let app = app.map(|p| p.decls()).unwrap_or_default();
    for decl in inline
        .iter()
        .chain(animated.iter().map(|(d, _)| d))
        .chain(app)
    {
        let _ = patch.push(&mut style, decl.clone());
    }
    Op::SetStyle { id, style, patch }
}

fn same(a: &Option<std::rc::Rc<ClassList>>, b: &Option<std::rc::Rc<ClassList>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => std::rc::Rc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

impl Components {
    /// The GPU renderer the sets registered as `name`.
    pub(super) fn gpu_renderer(&self, name: &str) -> Option<crate::gpu::GpuSource> {
        self.registry.registered_gpu_renderer(name).cloned()
    }
}

impl<M: TextEngine> Core<M> {
    /// The components this core can render (from `nsh-base` and the
    /// like), and the design tokens their sets bring
    /// ([`Registry::tokens_from`]); set before the first op. Runs the
    /// sets' setup functions ([`Registry::setup`]).
    pub fn set_components(&mut self, registry: Registry) {
        if let Some(Ok((tokens, _))) = registry.tokens(None) {
            self.set_tokens(tokens);
        }
        {
            let _entered = self.components.runtime.enter();
            registry.run_setups();
        }
        self.components.registry = registry;
    }

    /// Replaces the components of a running core with `registry`, a
    /// superset of what it had (a UI set registered after the app started:
    /// a web runtime's late `nsh_part_*`). What is mounted from then on may
    /// use the new components; the tokens stay the app's, and only the
    /// setup functions the old sets did not bring run.
    pub fn extend_components(&mut self, registry: Registry) {
        {
            let _entered = self.components.runtime.enter();
            registry.run_setups_not_in(&self.components.registry);
        }
        self.components.registry = registry;
        self.make_by_name();
    }

    /// Makes the components made by name whose part is registered now.
    fn make_by_name(&mut self) {
        if self.components.by_name.is_empty() {
            return;
        }
        let _entered = self.components.runtime.enter();
        let hosts: Vec<NodeId> = self.components.by_name.keys().copied().collect();
        for host in hosts {
            let Some(waiting) = self.components.by_name.get(&host) else {
                continue;
            };
            let still = self
                .components
                .instances
                .get(&host)
                .is_some_and(|i| matches!(i.inner, Inner::Missing));
            if !still {
                self.components.by_name.remove(&host);
                continue;
            }
            let Some((spec, mut inner)) = self.components.registry.make_type(waiting.id) else {
                continue;
            };
            let waiting = self.components.by_name.remove(&host).expect("waiting");
            inner.place(host, waiting.owner);
            inner.set_props(waiting.props.as_any());
            // Its view is made in place of the empty one it showed.
            if let Some(inst) = self.components.instances.get_mut(&host) {
                inst.inner = Inner::Component(inner);
                inst.spec = Some(spec);
                inst.remake = true;
            }
            self.components.mark(host);
        }
    }

    /// Makes `host` the host of component element `c`: by its type, or
    /// by its registered name ([`crate::element::ComponentElement::by_name`]).
    fn create_instance_for(&mut self, host: NodeId, c: &crate::element::builder::ComponentEl) {
        let Some(id) = c.by_name else {
            self.create_instance_of(host, c.name, c.make, c.spec);
            return;
        };
        if self.is_host(host) {
            return;
        }
        match self.components.registry.make_type(id) {
            Some((spec, inner)) => self.insert_instance(host, Some(spec), Inner::Component(inner)),
            None => {
                self.insert_instance(host, None, Inner::Missing);
                self.components.by_name.insert(
                    host,
                    ByName {
                        id,
                        props: c.props.clone_box(),
                        owner: crate::element::Owner::current(),
                    },
                );
                let name = crate::element::component::export_name(c.name);
                match PART_REQUESTER.with(|r| r.get()) {
                    Some(request) => request(name),
                    None => log::debug!("`{name}` waits for the part that registers it"),
                }
            }
        }
    }

    /// Sets the props of `host`'s component from its element.
    fn set_element_props(&mut self, host: NodeId, props: &dyn crate::element::builder::AnyProps) {
        if let Some(waiting) = self.components.by_name.get_mut(&host) {
            waiting.props = props.clone_box();
            return;
        }
        if let Some(inst) = self.components.instances.get_mut(&host)
            && let Inner::Component(inner) = &mut inst.inner
        {
            inner.set_props(props.as_any());
        }
    }

    /// `uiTheme` on the root: the app's theme file (`nsh.json`, `setTheme`),
    /// which the UI set that reads themes makes tokens of. What it cannot
    /// read is left out and the rest applies, so a bundle made by a newer
    /// NSH keeps its theme here.
    pub(super) fn set_ui_theme(&mut self, json: &str) {
        match self.components.registry.tokens(Some(json)) {
            Some(Ok((tokens, left_out))) => {
                for what in left_out {
                    log::warn!("theme: {what}, ignored");
                }
                self.set_tokens(tokens);
            }
            Some(Err(e)) => log::warn!("theme: {e}"),
            None => log::warn!("theme: no UI set reads themes"),
        }
    }

    /// The app's design tokens; it is drawn with them unless the
    /// embedding app set its own ([`Core::set_host_tokens`]).
    pub fn set_tokens(&mut self, tokens: Tokens) {
        self.components.app_tokens = Arc::new(tokens);
        self.tokens_changed();
    }

    /// The app's translations ([`crate::i18n`]): what `t!` and TS's `t`
    /// read from now on.
    pub fn set_translations(&mut self, translations: crate::i18n::Translations) {
        let _entered = self.components.runtime.enter();
        let stored = crate::element::global::<crate::i18n::Translations>();
        let env = self.components.environment;
        let before =
            crate::i18n::text_locale(&stored.get(), env.locale, env.locale_settings.languages);
        stored.set(translations);
        if crate::i18n::text_locale(&stored.get(), env.locale, env.locale_settings.languages)
            != before
        {
            self.localize_platform();
        }
    }

    /// Merges `map` into this surface's translations and updates menus if the
    /// selected language changed.
    pub(crate) fn add_translations(
        &mut self,
        map: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    ) {
        if map.is_empty() {
            return;
        }
        let next = {
            let _entered = self.components.runtime.enter();
            crate::element::global::<crate::i18n::Translations>()
                .get_untracked()
                .extend(map)
        };
        self.set_translations(next);
    }

    /// Re-localizes menus when translations updated in place changed the
    /// selected language.
    fn translations_changed(&mut self, before: &crate::i18n::Translations) {
        let _entered = self.components.runtime.enter();
        let current = crate::element::global::<crate::i18n::Translations>().get_untracked();
        let env = self.components.environment;
        if crate::i18n::text_locale(&current, env.locale, env.locale_settings.languages)
            != crate::i18n::text_locale(before, env.locale, env.locale_settings.languages)
        {
            self.localize_platform();
        }
    }

    /// What NSH says itself on the platform uses the same language
    /// selection as the app's text: the menus it owns (macOS, Windows) and
    /// the screen reader's state words (iOS, Android).
    fn localize_platform(&mut self) {
        use crate::platform::Os;
        let _entered = self.components.runtime.enter();
        let env = self.components.environment;
        let desktop = matches!(env.os, Os::MacOs | Os::Windows)
            && env.idiom != crate::platform::Idiom::Terminal;
        if !desktop && !matches!(env.os, Os::Ios | Os::Android) {
            return;
        }
        let translations = crate::element::global::<crate::i18n::Translations>().get();
        let locale =
            crate::i18n::text_locale(&translations, env.locale, env.locale_settings.languages);
        if !desktop {
            if self.components.text_locale != Some(locale) {
                self.components.text_locale = Some(locale);
                self.commands
                    .push((crate::ROOT_ID, Command::TextLocale(locale)));
            }
            return;
        }
        let labels = crate::desktop::MenuLabels::for_locale(
            locale,
            self.components.environment.os == crate::platform::Os::MacOs,
        );
        let _ = self.apply_op(crate::Op::Command {
            id: crate::ROOT_ID,
            command: crate::Command::Desktop(Box::new(
                crate::desktop::DesktopCommand::SetMenuLabels(Box::new(labels)),
            )),
        });
    }

    /// The language the app asked to show in since the last call
    /// (`Some(None)`: the user's again), which the engine applies to the
    /// environment it gives the core and JS.
    pub fn take_locale_request(&mut self) -> Option<Option<crate::platform::Locale>> {
        self.components.locale_request.take()
    }

    /// The functions components, tasks and module functions asked to run
    /// on the platform's main thread since the last call
    /// ([`crate::element::run_on_main_thread`]), in order: the engine hands
    /// them to its sink after the commit.
    #[doc(hidden)]
    pub fn take_main_thread_tasks(&mut self) -> Vec<crate::main_thread::MainThreadTask> {
        std::mem::take(&mut self.components.main_thread)
    }

    /// The embedding app's design tokens (`None`: the app's again): an app
    /// embedded in a native app looks like it, whatever the app sets.
    /// Text inherits its `foreground` token unless it sets its own color.
    pub fn set_host_tokens(&mut self, tokens: Option<Tokens>) {
        self.components.host_tokens = tokens.map(Arc::new);
        self.tokens_changed();
        // Embedded content inherits the host's foreground unless it sets its own.
        let classes = if self.components.host_tokens.is_some() {
            vec!["text-foreground".into()]
        } else {
            Vec::new()
        };
        self.set_classes(self.root, None, Some(classes));
    }

    /// What [`Core::tokens`] become when the root's `uiTheme` (the app's
    /// theme file) is set, with the embedding app's tokens of now: JS reads
    /// them in the turn that sends the theme, before it reaches the core.
    pub fn theme_tokens(&self) -> crate::element::ThemeTokens {
        crate::element::ThemeTokens::new(
            self.components.registry.token_source(),
            self.components.host_tokens.clone(),
        )
    }

    /// The design tokens the app is drawn with now: the app's, under the
    /// embedding app's. A new value (not the same `Arc`) when they change.
    pub fn tokens(&self) -> &Arc<Tokens> {
        &self.components.tokens
    }

    /// The tokens drawn with now: a signal of the surface, so only the
    /// bindings that read them run again, and only when they changed.
    fn tokens_changed(&mut self) {
        let tokens = match &self.components.host_tokens {
            // The app's own tokens the host's do not have stay.
            Some(host) => Arc::new(host.over(&self.components.app_tokens)),
            None => self.components.app_tokens.clone(),
        };
        if *tokens == *self.components.tokens {
            self.components.tokens = tokens;
            return;
        }
        {
            let _entered = self.components.runtime.enter();
            self.components.tokens = tokens;
            self.components
                .runtime
                .set_tokens(self.components.tokens.clone());
        }
        // The platform's own controls (menus, Android's alerts) take their
        // colors from them.
        self.commands.push((
            crate::ROOT_ID,
            Command::Tokens(self.components.tokens.clone()),
        ));
        let font = self
            .components
            .tokens
            .font(crate::element::FONT_SANS)
            .map(|f| crate::style::FontFamily::new(f));
        self.set_default_font(font);
        self.class_tokens_changed();
    }

    /// Mounts a Rust app's root component as the content of the root view;
    /// its view is made in the next commit.
    pub fn mount_root(&mut self, root: &Root) {
        if let Some(setting) = root.status_bar_ref() {
            self.components.status_bars.set_base(setting);
        }
        let _entered = self.components.runtime.enter();
        let Some(id) = self.make_component(root.element(), |_, _| {}) else {
            return log::error!("the root is not a component");
        };
        let _ = self.apply_op(Op::Insert {
            parent: ROOT_ID,
            child: id,
            before: None,
        });
        self.mount_opened_windows();
        self.own_direction();
    }

    /// Mounts what renders the windows `open_window` opens, beside the
    /// app's root (desktops): a Rust app's ([`Self::mount_root`]) or a TSX
    /// app's, whose built-in windows (the update prompt) open the same way.
    pub fn mount_opened_windows(&mut self) {
        let _entered = self.components.runtime.enter();
        if !crate::element::os().is_desktop() {
            return;
        }
        use crate::element::Component as _;
        let host = crate::element::desktop::OpenedWindowsHost::element(()).into_element();
        if let Some(host) = self.make_component(host, |_, _| {}) {
            let _ = self.apply_op(Op::Insert {
                parent: ROOT_ID,
                child: host,
                before: None,
            });
        }
    }

    /// Makes the host of component element `el` (`None`: `el` is not a
    /// component), out of the tree; `made` sees its node first, before it
    /// renders.
    pub(super) fn make_component(
        &mut self,
        el: crate::element::AnyElement,
        made: impl FnOnce(&mut Self, NodeId),
    ) -> Option<NodeId> {
        let mut el = el.0;
        let ElKind::Component(c) = std::mem::replace(&mut el.kind, ElKind::Plain) else {
            return None;
        };
        let id = self.components.alloc();
        let _ = self.apply_op(Op::Create { id, tag: el.tag });
        made(self, id);
        self.create_instance_for(id, &c);
        self.set_element_props(id, c.props.as_ref());
        Some(id)
    }

    /// How the sets make the views' built-in scroll bars.
    pub(super) fn scrollbar_source(&self) -> Option<crate::element::ScrollbarSource> {
        self.components.registry.scrollbar_source()
    }

    /// The environment components read ([`crate::element::window`]
    /// and the like), as the platform reports it: what read a part that
    /// changed runs again. `dark` is the system's: the app's
    /// appearance wins over it ([`Core::set_appearance`]).
    pub fn set_environment(&mut self, mut environment: Environment) {
        let _entered = self.components.runtime.enter();
        environment.rtl = self.surface_rtl(environment.rtl);
        self.system_dark = environment.dark;
        environment.dark = self.shown_dark();
        self.apply_environment(environment);
    }

    /// Whether the platform's performance monitor measures
    /// (`fpsEnabled()`): what read it runs again.
    pub fn set_perf_monitor(&mut self, enabled: bool) {
        self.components.runtime.set_perf_monitor(enabled);
    }

    /// What the performance monitor measured last (`perfStats()`; `None`
    /// while it does not measure): what read it runs again.
    pub fn set_perf_stats(&mut self, stats: Option<crate::platform::PerfStats>) {
        self.components.runtime.set_perf_stats(stats);
    }

    /// The displays components read ([`crate::element::desktop::displays`]),
    /// as the platform reports them: what read them runs again.
    pub fn set_displays(&mut self, displays: Arc<[crate::desktop::Display]>) {
        self.components.runtime.set_displays(displays);
    }

    /// The environment components read is now `environment`.
    pub(super) fn apply_environment(&mut self, environment: Environment) {
        let _entered = self.components.runtime.enter();
        let changed = self.components.environment != environment;
        let locale_changed = self.components.environment.locale != environment.locale;
        let language_changed = self.components.environment.idiom != environment.idiom
            || self.components.environment.os != environment.os
            || locale_changed
            || self.components.environment.locale_settings.languages
                != environment.locale_settings.languages;
        let keyboard_moved =
            self.components.environment.keyboard_height != environment.keyboard_height;
        self.keyboard_moved |= keyboard_moved;
        // The room the root view's anchored overlays keep to leaves the
        // keyboard out (`Core::overlay_area`): laid out and placed again.
        if keyboard_moved && self.root_overlay_shown() {
            self.needs_layout = true;
        }
        let ratio = self.components.environment.pixel_ratio;
        self.components.environment = environment;
        if ratio != environment.pixel_ratio {
            self.repick_images(ratio, environment.pixel_ratio);
        }
        // Frames and text measurements are rounded to device pixels.
        self.pixel_ratio_changed(environment.pixel_ratio);
        // On a grid surface, lengths and frames are put on its Cells.
        self.cell_changed(environment.cell, environment.dark);
        if changed {
            // What reads a part that changed runs again.
            self.components.runtime.set_environment(environment);
        }
        if language_changed {
            self.localize_platform();
        }
        if locale_changed {
            self.locale_changed();
        }
        // A main window that keeps its placement saves it as it changes.
        if let Some(state) = environment.window_state {
            self.keep_window_placement(crate::ROOT_ID, &state);
        }
    }

    /// The surface's size changed (the environment's window).
    pub(super) fn components_viewport(&mut self, size: crate::Size<crate::Points>) {
        let environment = Environment {
            window: size,
            ..self.components.environment
        };
        self.apply_environment(environment);
    }

    /// Drops `ops` without applying them (the script was stopped): the
    /// calls into Rust among them are not made, and the promises waiting
    /// for them reject (their replies are in the next events); a JS call
    /// parked behind one is dropped.
    pub fn discard_ops(&mut self, ops: impl IntoIterator<Item = Op>) {
        for op in ops {
            if let Op::Rust(RustOp { call, run }) = op {
                // What the call holds (a post's place: released) (its arguments: instances, callbacks)
                // goes now.
                drop_caught(run);
                self.settle(call, Err("the script stopped before the call ran".into()));
            }
        }
    }

    /// The queue of the JS calls Rust posts: the one the engine hands the
    /// script too.
    pub fn set_posts(&mut self, posts: Posts) {
        self.components.posts = posts;
    }

    /// Wakes the engine when a component's task is woken (from any
    /// thread): it then calls [`Self::run_component_tasks`].
    pub fn set_task_notify(&mut self, notify: Arc<dyn Fn() + Send + Sync>) {
        self.components.executor.set_notify(notify.clone());
        self.components.downloads.set_notify(notify);
    }

    /// Where a platform's last stop acknowledgement goes after this core's
    /// engine is gone: the engine's control handle keeps it, and the core
    /// registers its staging directories and cancel requests with it.
    #[doc(hidden)]
    pub fn set_download_cleanup(&mut self, cleanup: crate::webview::downloads::DownloadCleanup) {
        self.components.downloads.set_cleanup(cleanup);
    }

    /// The tokio runtime the components' tasks are polled in the context
    /// of (their timers, IO and background work run on it).
    pub fn set_task_runtime(&mut self, runtime: tokio::runtime::Handle) {
        self.components.executor.set_runtime(runtime);
    }

    /// When the components' soonest timer is due ([`crate::element::timer`]):
    /// the engine wakes then and runs their tasks.
    pub fn next_task_timer(&self) -> Option<crate::time::Instant> {
        self.components.executor.next_timer()
    }

    /// Runs the components' woken tasks, with the state changes they ask
    /// for, until they all wait.
    pub fn run_component_tasks(&mut self) {
        let _entered = self.components.runtime.enter();
        let executor = self.components.executor.clone();
        executor.fire_timers(crate::time::now());
        // A task that keeps waking itself cannot hold the engine.
        for _ in 0..MAX_TASK_ROUNDS {
            let polled = executor.poll_ready();
            let actions = executor.take_actions();
            if !polled && actions.is_empty() {
                return;
            }
            for action in actions {
                self.apply_action(action);
            }
            for (host, message) in executor.take_failures() {
                self.component_failed(host, message);
            }
        }
    }

    /// Whether something runs as the app quits ([`crate::element::desktop::on_app_quit`],
    /// `Application.on("quit")`): the engine gives it time to.
    pub fn has_quit_listeners(&self) -> bool {
        !self.components.executor.quit.borrow().is_empty()
    }

    /// The app quits: starts each quit listener's work, oldest first, as
    /// tasks the engine runs ([`Core::run_component_tasks`]) until
    /// [`Core::quit_pending`] is false or
    /// [`QUIT_TIMEOUT`](crate::element::desktop::QUIT_TIMEOUT) has passed.
    /// Whether any started.
    pub fn start_quit(&mut self) -> bool {
        let _entered = self.components.runtime.enter();
        let executor = self.components.executor.clone();
        let listeners = executor.quit.borrow().all();
        for listener in listeners {
            match caught(|| listener()) {
                Ok(future) => {
                    let pending = crate::element::quit::Pending::new(&executor.quitting);
                    // Detached: it runs until it ends or the engine stops.
                    drop(crate::element::task::spawn_future(&executor, async move {
                        future.await;
                        drop(pending);
                    }));
                }
                Err(message) => log::error!(target: "js", "a quit listener failed: {message}"),
            }
        }
        self.apply_actions();
        self.quit_pending()
    }

    /// The user asked to quit while the app listens to quit requests:
    /// each listener hears it, oldest first.
    fn quit_requested(&mut self) {
        let _entered = self.components.runtime.enter();
        let listeners = self.components.executor.quit_requests.borrow().all();
        for listener in listeners {
            if let Err(message) = caught(|| listener()) {
                log::error!(target: "js", "a quit request listener failed: {message}");
            }
        }
        self.apply_actions();
    }

    /// The OS asked the app to show itself: each reopen listener hears it,
    /// oldest first. The app opens or focuses the window it wants.
    #[doc(hidden)]
    pub fn reopened(&mut self) {
        let _entered = self.components.runtime.enter();
        let listeners = self.components.executor.reopens.borrow().all();
        for listener in listeners {
            if let Err(message) = caught(|| listener()) {
                log::error!(target: "js", "a reopen listener failed: {message}");
            }
        }
        self.apply_actions();
    }

    /// The app's last window went: each listener hears it, oldest first.
    pub(crate) fn last_window_closed(&mut self) {
        let _entered = self.components.runtime.enter();
        let listeners = self.components.executor.last_window_closed.borrow().all();
        for listener in listeners {
            if let Err(message) = caught(|| listener()) {
                log::error!(target: "js", "a last window closed listener failed: {message}");
            }
        }
        self.apply_actions();
    }

    /// Tells the platform whether its quit requests go to the app, when
    /// that changed since the last call (a listener came or went): whether
    /// it did.
    pub(super) fn sync_quit_requests(&mut self) -> bool {
        let asks = !self.components.executor.quit_requests.borrow().is_empty();
        if asks == self.components.asks_quit {
            return false;
        }
        self.components.asks_quit = asks;
        let _ = self.apply_op(crate::Op::Command {
            id: crate::ROOT_ID,
            command: crate::Command::Desktop(Box::new(
                crate::desktop::DesktopCommand::SetQuitOnRequest(!asks),
            )),
        });
        true
    }

    /// Whether the work quit listeners started is still running.
    pub fn quit_pending(&self) -> bool {
        self.components.executor.quitting.get() > 0
    }

    /// Whether a JS call of an `async fn` into Rust (a native module's, a
    /// class's) has not answered yet: its answer comes from elsewhere (a
    /// request made in Rust, another thread), which nothing else counts.
    pub fn async_calls_pending(&self) -> bool {
        self.components.executor.calls.get() > 0
    }

    /// Runs the closures that waited for the app's answer to the events
    /// handed to JS before this commit ([`crate::element::after_answer`]),
    /// each under its owner; one whose owner went is dropped unrun.
    pub(super) fn run_answers(&mut self) {
        let _entered = self.components.runtime.enter();
        for answer in self.components.executor.take_due_answers() {
            let crate::element::AfterAnswer { owner, f } = answer;
            let result = if owner == crate::element::Owner::detached() {
                caught(f)
            } else if owner.is_live() {
                caught(|| owner.scope(f))
            } else {
                drop_caught(f);
                continue;
            };
            if let Err(message) = result {
                match self.host_of_owner(owner) {
                    Some(host) => self.component_failed(host, message),
                    None => {
                        log::error!(target: "js", "a closure after the app's answer failed: {message}")
                    }
                }
            }
            self.apply_actions();
        }
    }

    /// Whether `id` is a component's host.
    pub(super) fn is_host(&self, id: NodeId) -> bool {
        self.components.instances.contains_key(&id)
    }

    /// Ops from JS on a component's host take its place; others pass
    /// (`Some`).
    pub(super) fn intercept(&mut self, op: Op) -> Result<Option<Op>, ApplyError> {
        // The app's elements that take a slot's props: their props combine
        // with the component's ([`super::slots`]).
        // A component's host among them takes them from its view: JS's
        // ops on it are its component's.
        if !self.components.adopted.is_empty()
            && let Op::SetProp { id, .. } | Op::Listen { id, .. } | Op::Release { id } = &op
            && self.components.adopted.contains_key(id)
            && !self.is_host(*id)
        {
            return Ok(self.js_slot_op(op));
        }
        match op {
            // The app's style on a host goes after the root's own.
            Op::SetStyle { id, patch, .. } if self.is_host(id) => {
                let inst = self.components.instances.get_mut(&id).expect("host");
                inst.app_style = (!patch.is_empty()).then_some(patch);
                // The node's own style is the view's that makes it, then
                // what is given it.
                let base = self.base_of(id);
                let cx = self.root_context_of(base).expect("a host");
                let app = if cx.combined {
                    cx.app
                } else {
                    self.components.instances[&base].app_style.clone()
                };
                let (inline, animated) = match &self.components.instances[&base].root {
                    Some(root) => (root.attrs.inline.clone(), root.attrs.animated().to_vec()),
                    None => (None, Vec::new()),
                };
                Ok(Some(inline_style(
                    id,
                    inline.as_deref(),
                    &animated,
                    app.as_ref(),
                )))
            }
            // A render's holder joins its host: placed in its placeholder.
            Op::Insert { parent, child, .. }
                if self.is_host(parent) && self.is_render_holder(child) =>
            {
                self.insert_render_holder(parent, child);
                Ok(None)
            }
            Op::Remove { parent, child }
                if self.is_host(parent) && self.is_render_holder(child) =>
            {
                self.remove_render_holder(child, false);
                Ok(None)
            }
            Op::Release { id } if self.is_render_holder(id) => {
                self.remove_render_holder(id, true);
                Ok(Some(Op::Release { id }))
            }
            // A slot's node joins its host: the view places it.
            Op::Insert { parent, child, .. }
                if self.is_host(parent) && self.components.slot_names.contains_key(&child) =>
            {
                let name = self.components.slot_names[&child].clone();
                let inst = self.components.instances.get_mut(&parent).expect("host");
                let Some(slot) = inst.spec.as_ref().and_then(|s| s.holder(&name)) else {
                    log::warn!(target: "js", "the component has no slot `{name}`");
                    self.detach_id(child);
                    return Ok(None);
                };
                inst.slots.retain(|(_, n)| *n != child);
                inst.slots.push((slot, child));
                self.components.slot_hosts.insert(child, parent);
                self.components.mark(parent);
                Ok(None)
            }
            Op::Remove { parent, child }
                if self.is_host(parent) && self.components.slot_names.contains_key(&child) =>
            {
                self.unslot(child);
                self.detach_id(child);
                Ok(None)
            }
            // A component's list gets a cell: the component wraps its rows.
            Op::Insert { parent, child, .. }
                if self.components.slot_hosts.contains_key(&parent) && self.is_list(parent) =>
            {
                self.apply_op(op)?;
                if let Some((place, _)) = self.components.lists.get(&parent).cloned() {
                    self.wrap_row(child, place);
                }
                Ok(None)
            }
            Op::Remove { parent, .. }
                if self.components.slot_hosts.contains_key(&parent) && self.is_list(parent) =>
            {
                Ok(Some(op))
            }
            // A slot filled or emptied: the component's slot prop follows
            // (it is marked).
            Op::Insert { parent, .. } | Op::Remove { parent, .. }
                if self.components.slot_hosts.contains_key(&parent) =>
            {
                let empty = |core: &Self| {
                    core.key(parent)
                        .map_or(true, |k| core.nodes[k as usize].children.is_empty())
                };
                let before = empty(self);
                self.apply_op(op)?;
                if empty(self) != before {
                    let host = self.components.slot_hosts[&parent];
                    self.components.mark(host);
                }
                // The slot's props follow its one element.
                self.retarget_slot(parent, None);
                Ok(None)
            }
            Op::Release { id } if self.components.slot_names.contains_key(&id) => {
                self.unslot(id);
                self.components.slot_names.remove(&id);
                self.components.lists.remove(&id);
                self.forget_list_count(id);
                Ok(Some(Op::Release { id }))
            }
            // The number of rows changed: the rows' wrappers may depend on
            // it (the last row). They read it from a signal; one that does
            // not bind its row is built again.
            Op::SetProp {
                id,
                prop: Prop::Count(count),
            } if self.components.lists.contains_key(&id) => {
                let key = self.key(id)?;
                self.apply_op(Op::SetProp {
                    id,
                    prop: Prop::Count(count),
                })?;
                // A splice before may have changed the list's count already.
                let seen = &mut self.components.lists.get_mut(&id).expect("list").1;
                if std::mem::replace(seen, count) != count {
                    // A view's wrappers read it.
                    if let Some(&(_, signal)) = self.components.list_counts.get(&id) {
                        signal.set(count as usize);
                    }
                    let cells: Vec<NodeId> = self.nodes[key as usize]
                        .children
                        .iter()
                        .map(|&c| self.nodes[c as usize].id)
                        .collect();
                    for cell in cells {
                        let binds = self.components.instances.get(&cell).is_some_and(|inst| {
                            inst.cell_position.is_some()
                                && inst.cell_owner.is_some_and(|o| o.is_live())
                        });
                        if !binds {
                            self.components.mark(cell);
                        }
                    }
                }
                Ok(None)
            }
            // A row cell shows another row: its wrapper's position follows
            // (one that does not bind its row is built again).
            Op::SetProp {
                id,
                prop: Prop::CellIndex(index),
            } if self.is_host(id) => {
                let inst = self.components.instances.get_mut(&id).expect("host");
                if let Inner::Row { index: current, .. } = &mut inst.inner
                    && *current != index as usize
                {
                    *current = index as usize;
                    match inst.cell_position {
                        // A view's wrapper keeps its content.
                        Some(row) if inst.cell_owner.is_some_and(|o| o.is_live()) => {
                            row.index.set(index as usize);
                            row.bound.set(true);
                        }
                        _ => self.components.mark(id),
                    }
                }
                Ok(Some(op))
            }
            Op::Insert {
                parent,
                child,
                before,
            } if self.is_host(parent) => {
                // A raw text run (`<Button>Open</Button>`) has no node
                // until a use needs one: the view places it, so it does.
                let run = self.runs.contains_key(&child);
                self.materialize_run(child)?;
                self.key(child)?;
                let inst = self.components.instances.get_mut(&parent).expect("host");
                let was_empty = inst.js_children.is_empty();
                let moved = inst.js_children.contains(&child);
                inst.js_children.retain(|&c| c != child);
                let at = before.and_then(|b| inst.js_children.iter().position(|&c| c == b));
                inst.js_children
                    .insert(at.unwrap_or(inst.js_children.len()), child);
                let place = inst.children_at;
                if let Some(children) = inst.js_kids {
                    children.set(inst.js_children.clone());
                }
                if was_empty || place == Placement::Each {
                    self.components.mark(parent);
                }
                self.join_content(child);
                match place {
                    // Before its next JS sibling, else before what the
                    // view puts after the children.
                    Placement::At(p, anchor) => {
                        let anchor = self.anchor_node(anchor);
                        self.apply_op(Op::Insert {
                            parent: p,
                            child,
                            before: at.and(before).or(anchor),
                        })?;
                        if run
                            && self
                                .key(p)
                                .is_ok_and(|k| self.nodes[k as usize].kind != Kind::Text)
                        {
                            let text = self.key(child).map_or("", |k| &self.nodes[k as usize].text);
                            log::warn!(
                                target: "js",
                                "text in a component's children is not shown: text shows in a <Text> (`<Text>{text}</Text>`)"
                            );
                        }
                    }
                    Placement::Nested(nested, anchor) => {
                        let anchor = self.anchor_node(anchor);
                        self.join_nested_at(nested, child, at.and(before).or(anchor));
                    }
                    // Its wrapper is the view's (a region of them, keyed
                    // by the child): a child moved among the others keeps
                    // its wrapper, which the region moves.
                    Placement::Each if moved => {}
                    Placement::Each => self.detach_id(child),
                    Placement::None => self.detach_id(child),
                }
                Ok(None)
            }
            Op::Remove { parent, child } if self.is_host(parent) => {
                let inst = self.components.instances.get_mut(&parent).expect("host");
                inst.js_children.retain(|&c| c != child);
                if let Some(children) = inst.js_kids {
                    children.set(inst.js_children.clone());
                }
                let place = inst.children_at;
                if inst.js_children.is_empty() || place == Placement::Each {
                    self.components.mark(parent);
                }
                self.unplace(place, child);
                Ok(None)
            }
            Op::SetProp {
                id,
                prop: Prop::Class(class),
            } if self.is_host(id) => {
                let inst = self.components.instances.get_mut(&id).expect("host");
                inst.class = class;
                self.update_user_class(id);
                Ok(None)
            }
            Op::SetProp {
                id,
                prop: Prop::ClassList(list),
            } if self.is_host(id) => {
                let inst = self.components.instances.get_mut(&id).expect("host");
                inst.class_list = list;
                self.update_user_class(id);
                Ok(None)
            }
            // The root listens to the back button while JS or a component
            // does.
            Op::Listen {
                id: crate::ROOT_ID,
                event: EventKind::BackPress,
                enabled,
            } => {
                self.components.js_back = enabled;
                let rust = !self.components.executor.back.borrow().list.is_empty();
                Ok(Some(Op::Listen {
                    id: crate::ROOT_ID,
                    event: EventKind::BackPress,
                    enabled: enabled || rust,
                }))
            }
            // The root listens to the back gesture's steps while JS or a
            // component does.
            Op::Listen {
                id: crate::ROOT_ID,
                event: EventKind::BackProgress,
                enabled,
            } => {
                self.components.js_back_progress = enabled;
                let rust = !self
                    .components
                    .executor
                    .back_progress
                    .borrow()
                    .list
                    .is_empty();
                Ok(Some(Op::Listen {
                    id: crate::ROOT_ID,
                    event: EventKind::BackProgress,
                    enabled: enabled || rust,
                }))
            }
            // The surface's shortcuts are JS's and the views'.
            Op::SetProp {
                id: crate::ROOT_ID,
                prop: Prop::Keymap(keymap),
            } => {
                self.components.js_keymap = keymap;
                Ok(Some(Op::SetProp {
                    id: crate::ROOT_ID,
                    prop: Prop::Keymap(self.keymap()),
                }))
            }
            Op::Listen {
                id: crate::ROOT_ID,
                event: EventKind::KeyCommand,
                enabled,
            } => {
                self.components.js_keys = enabled;
                let rust = !self.components.executor.keys.borrow().list.is_empty();
                Ok(Some(Op::Listen {
                    id: crate::ROOT_ID,
                    event: EventKind::KeyCommand,
                    enabled: enabled || rust,
                }))
            }
            // The component's events come from the core, not from the view.
            Op::Listen {
                id,
                event: EventKind::NativeEvent,
                ..
            } if self.is_host(id) => Ok(None),
            Op::Listen { id, event, enabled } if self.is_host(id) => {
                let inst = self.components.instances.get_mut(&id).expect("host");
                inst.js_events.set(event, enabled);
                Ok(Some(self.host_listen(id, event)))
            }
            Op::Rust(op) => {
                self.run_rust(op);
                Ok(None)
            }
            Op::Release { id } if self.is_host(id) => {
                self.release_instance(id);
                Ok(Some(Op::Release { id }))
            }
            op => Ok(Some(op)),
        }
    }

    /// Whether the host `id`'s node listens to `event` for someone outside
    /// its component's view: JS on the host, or a view above giving an
    /// element of this component (or of one whose root it is) a listener.
    fn outside_listens(&self, id: NodeId, event: EventKind) -> bool {
        let mut at = Some(self.base_of(id));
        while let Some(host) = at {
            let Some(inst) = self.components.instances.get(&host) else {
                break;
            };
            if inst.js_events.contains(event) || inst.given_events.contains(event) {
                return true;
            }
            at = inst.above;
        }
        false
    }

    /// What the host `id`'s node listens to of `event`: its root's own,
    /// the slot whose props it takes and those outside its view.
    fn host_listen(&mut self, id: NodeId, event: EventKind) -> Op {
        let outside = self.outside_listens(id, event);
        let base = self.base_of(id);
        let own = self.components.instances[&base]
            .root
            .as_ref()
            .is_some_and(|r| r.events.contains(event));
        let slot = self.target_listens(base, event, outside || own);
        Op::Listen {
            id,
            event,
            enabled: outside || own || slot,
        }
    }

    /// Gives the nested component on `id` the listeners `handlers` of the
    /// view it is in (in place of what that view gave it before): its node
    /// listens to their events as long as they are given.
    pub(super) fn set_given_handlers(
        &mut self,
        id: NodeId,
        handlers: Vec<(EventKind, Listener<EventPayload>)>,
    ) {
        let mut events = EventMask::default();
        for (kind, _) in &handlers {
            events.set(*kind, true);
        }
        let Some(inst) = self.components.instances.get_mut(&id) else {
            return;
        };
        let old = std::mem::replace(&mut inst.given_events, events);
        inst.given_handlers = handlers;
        let mut changed = old.bits() ^ events.bits();
        while changed != 0 {
            let kind = EventKind::ALL[changed.trailing_zeros() as usize];
            changed &= changed - 1;
            let op = self.host_listen(id, kind);
            let _ = self.apply_op(op);
        }
    }

    /// Runs the listeners of `kind` the views above give the host `base`
    /// (and the components whose root it is), each in the component whose
    /// view gave it; false when none was given.
    fn handle_given(&mut self, base: NodeId, kind: EventKind, payload: &EventPayload) -> bool {
        let mut listeners = Vec::new();
        let mut at = Some(base);
        while let Some(host) = at {
            let Some(inst) = self.components.instances.get(&host) else {
                break;
            };
            if inst.given_events.contains(kind)
                && let Some(&owner) = self.components.owners.get(&host)
            {
                listeners.extend(
                    inst.given_handlers
                        .iter()
                        .filter(|(k, _)| *k == kind)
                        .map(|(_, l)| (owner, l.clone())),
                );
            }
            at = inst.above;
        }
        let mut handled = false;
        for (owner, listener) in listeners {
            handled |= self.run_listener(owner, &listener, payload);
        }
        handled
    }

    /// Whether JS listens to `kind` on the host whose node `base` makes
    /// (the top one of its chain).
    fn js_listens(&self, base: NodeId, kind: EventKind) -> bool {
        let mut at = Some(base);
        while let Some(host) = at {
            let Some(inst) = self.components.instances.get(&host) else {
                break;
            };
            if inst.js_events.contains(kind) {
                return true;
            }
            at = inst.above;
        }
        false
    }

    /// The number of rows of the list cell `cell` is in.
    fn rows_of_cell(&self, cell: NodeId) -> usize {
        let Ok(key) = self.key(cell) else { return 0 };
        self.nodes
            .get(self.nodes[key as usize].parent as usize)
            .and_then(|list| list.list.as_ref())
            .map_or(0, |list| list.count as usize)
    }

    /// The number of rows of list `list`.
    fn rows_of_list(&self, list: NodeId) -> u32 {
        self.key(list)
            .ok()
            .and_then(|k| self.nodes[k as usize].list.as_ref())
            .map_or(0, |l| l.count)
    }

    /// Whether `id` is a list.
    fn is_list(&self, id: NodeId) -> bool {
        self.key(id)
            .is_ok_and(|k| self.nodes[k as usize].list.is_some())
    }

    /// Item cell `cell` of a component's list: its rows are wrapped by
    /// `place`, the row function the component's view gave last.
    fn wrap_row(&mut self, cell: NodeId, place: PlaceFn) {
        let Ok(key) = self.key(cell) else { return };
        let node = &self.nodes[key as usize];
        if !matches!(node.slot, Some(crate::CellSlot::Item(_))) {
            return;
        }
        if let Some(inst) = self.components.instances.get_mut(&cell) {
            if let Inner::Row { place: current, .. } = &mut inst.inner {
                *current = place;
            }
            self.components.mark(cell);
            return;
        }
        // The row's content is already in the cell: it moves into the
        // wrapper.
        let js_children = node
            .children
            .iter()
            .map(|&c| self.nodes[c as usize].id)
            .collect();
        let instance = Instance::new(Inner::Row { place, index: 0 }, None, js_children, None);
        self.components.instances.insert(cell, Box::new(instance));
        self.components.mark(cell);
    }

    /// Runs a call JS made into Rust, in order with the ops before it: its
    /// result settles promise `call` (in the events, in order with them).
    pub(super) fn run_rust(&mut self, op: RustOp) {
        let posts = self.components.posts.clone();
        posts.in_op(|| self.run_rust_op(op));
    }

    fn run_rust_op(&mut self, op: RustOp) {
        let RustOp { call, run } = op;
        match run {
            RustCall::Op(run) => {
                let mut cx = ModuleCx::default();
                // The app's code: a panic rejects the call (its actions are
                // dropped) instead of unwinding through the engine. It runs
                // in the graph, as a listener does: it may `spawn` and use
                // signals.
                let ran = {
                    let _entered = self.components.runtime.enter();
                    caught(|| run(&mut cx))
                };
                let result = match ran {
                    Ok(result) => {
                        for action in std::mem::take(&mut cx.actions) {
                            self.apply_action(action);
                        }
                        result
                    }
                    Err(message) => Err(message.into()),
                };
                self.apply_actions();
                self.settle(call, result);
            }
            RustCall::Task(start) => match caught(start) {
                Ok(future) => {
                    let executor = Rc::downgrade(&self.components.executor);
                    let pending =
                        crate::element::quit::Pending::new(&self.components.executor.calls);
                    // A task of the root: it never goes away.
                    crate::element::task::spawn_raw(
                        &self.components.executor,
                        ROOT_ID,
                        Box::pin(async move {
                            let result = crate::element::module::catching(future).await;
                            drop(pending);
                            match executor.upgrade() {
                                Some(executor) if call != 0 => {
                                    executor.act(Action::Return(call, result));
                                }
                                _ => {
                                    if let Err(e) = &result {
                                        log::warn!(target: "js", "an async call into Rust failed: {e}");
                                    }
                                }
                            }
                        }),
                    );
                }
                Err(message) => self.settle(call, Err(message.into())),
            },
            RustCall::Method(host, method) if self.view_pending(host) => {
                // Called from its ref, which the app gets as the component
                // is made, before its view is (`render_components`).
                self.components.parked_methods.push((host, call, method));
            }
            RustCall::Method(host, method) => {
                let mut failed = None;
                let result = match self
                    .components
                    .instances
                    .get_mut(&host)
                    .map(|i| &mut i.inner)
                {
                    Some(Inner::Component(inner)) => match caught(|| inner.call(method)) {
                        Ok(Some(result)) => result,
                        Ok(None) => {
                            Err(format!("{} has no ref of this method's type", inner.name()).into())
                        }
                        Err(message) => {
                            failed = Some(message.clone());
                            Err(message.into())
                        }
                    },
                    _ => {
                        drop_caught(method);
                        Err(format!("node {host} hosts no Rust component").into())
                    }
                };
                self.apply_actions();
                if let Some(message) = failed {
                    self.component_failed(host, message);
                }
                self.settle(call, result);
            }
            // Its place, released: the call runs there.
            RustCall::Post(place) => drop(place),
        }
    }

    /// Settles promise `call` with `result` (in the events, in order with
    /// them); 0: JS does not wait, an error is logged.
    pub(super) fn settle(&mut self, call: u32, result: JsResult) {
        if call == 0 {
            if let Err(e) = &result {
                log::warn!(target: "js", "a call into Rust failed: {e}");
            }
            drop_caught(result);
            return;
        }
        self.events.push(JsEvent::Reply { call, result });
    }

    /// The app's classes on `host` changed.
    pub(super) fn update_user_class(&mut self, host: NodeId) {
        let inst = &self.components.instances[&host];
        let mut combined = String::with_capacity(inst.class.len() + 16 * inst.class_list.len());
        combined.push_str(&inst.class);
        for name in &inst.class_list {
            combined.push(' ');
            combined.push_str(name);
        }
        let user = (!combined.trim().is_empty()).then(|| self.tailwind.get(&combined).0);
        self.set_user(host, user);
    }

    /// What goes after `host`'s own styles.
    pub(super) fn set_user(&mut self, host: NodeId, user: Option<std::rc::Rc<ClassList>>) {
        let inst = self.components.instances.get_mut(&host).expect("host");
        if !same(&inst.user, &user) {
            inst.user = user;
            self.components.mark(host);
        }
    }

    /// Slot node `id` leaves its host.
    fn unslot(&mut self, id: NodeId) {
        self.drop_slot_target(id);
        if let Some(host) = self.components.slot_hosts.remove(&id) {
            if let Some(inst) = self.components.instances.get_mut(&host) {
                inst.slots.retain(|(_, n)| *n != id);
            }
            self.components.mark(host);
        }
    }

    /// `componentSlot` on a view: it holds a slot's JSX.
    pub(super) fn set_slot_name(&mut self, id: NodeId, name: Arc<str>) {
        self.components.slot_names.insert(id, name);
    }

    /// `Prop::Component` on a view: it becomes the host of component `name`.
    pub(super) fn create_instance(&mut self, host: NodeId, name: Arc<str>) {
        if self.is_host(host) {
            return;
        }
        let (spec, inner) = match self.components.registry.make(&name) {
            Some((spec, inner)) => (Some(spec), Inner::Component(inner)),
            None => {
                self.deny(format!(
                    "no component is registered as `{name}`: it renders nothing"
                ));
                (None, Inner::Missing)
            }
        };
        self.insert_instance(host, spec, inner);
    }

    /// View `host` becomes the host of the component `make` creates (a
    /// component a view or the app's root names by type).
    pub(super) fn create_instance_of(
        &mut self,
        host: NodeId,
        name: &'static str,
        make: fn() -> Box<dyn AnyInstance>,
        spec: fn() -> ComponentSpec,
    ) {
        if self.is_host(host) {
            return;
        }
        let spec = self
            .components
            .specs
            .entry(name)
            .or_insert_with(|| Arc::new(spec()))
            .clone();
        self.insert_instance(host, Some(spec), Inner::Component(make()));
    }

    fn insert_instance(
        &mut self,
        host: NodeId,
        spec: Option<Arc<ComponentSpec>>,
        mut inner: Inner,
    ) {
        // A style JS set before the component prop.
        let app_style = self
            .key(host)
            .ok()
            .map(|k| self.nodes[k as usize].inline_style.clone())
            .filter(|p| !p.is_empty());
        // A component is made where it is (its context comes from there).
        if let Inner::Component(c) = &mut inner {
            c.place(host, crate::element::Owner::current());
        }
        let instance = Instance::new(inner, spec, Vec::new(), app_style);
        self.components.instances.insert(host, Box::new(instance));
        self.components.mark(host);
        // No box of its own while its view styles none of its layout and
        // holds one node: that node is laid out in its place, so an app's
        // `flex-1` on a component's slot (a menu's trigger) fills the
        // component's parent (#2008).
        if let Ok(k) = self.key(host) {
            self.lay_out_through(k);
        }
    }

    /// `$name` on a host: a prop of its component.
    pub(super) fn set_component_prop(
        &mut self,
        host: NodeId,
        name: &str,
        value: Option<AnyValue>,
    ) -> bool {
        let Some(inst) = self.components.instances.get_mut(&host) else {
            return false;
        };
        let Inner::Component(inner) = &mut inst.inner else {
            return true;
        };
        match inner.set_prop(name, value) {
            Ok(true) => self.components.mark(host),
            Ok(false) => {}
            Err(e) => {
                let component = inst.spec.as_ref().map_or("", |s| s.name);
                log::warn!(target: "js", "{component}: {e}");
            }
        }
        true
    }

    /// Applies what the views' bindings queued and makes the views of the
    /// components marked, until neither is left.
    pub(super) fn render_components(&mut self) {
        let _entered = self.components.runtime.enter();
        // Views' patches, then the marked components, until none is left (a
        // patch may mark a component, a view made queues patches).
        loop {
            let changed = self.drain_views();
            let rendered = self.render_dirty();
            let failed = self.report_failures();
            let woke = self.wake_waiting();
            let called = self.run_parked_methods();
            if !changed && !rendered && !failed && !woke && !called && !self.run_after_render() {
                break;
            }
        }
        self.flush_renders();
        self.end_retags();
    }

    /// Runs what waited for the commit's views ([`crate::element::after_render`]);
    /// whether there was any (what it asked for and changed renders in this
    /// round too).
    fn run_after_render(&mut self) -> bool {
        let rendered = self.components.executor.take_rendered();
        if rendered.is_empty() {
            return false;
        }
        for crate::element::AfterAnswer { f, .. } in rendered {
            if let Err(message) = caught(f) {
                log::error!(target: "js", "a closure after the views rendered failed: {message}");
            }
        }
        true
    }

    /// Node `id` goes: what the views' renders and the app's classes knew
    /// of it goes too.
    fn forget_node_extras(&mut self, id: NodeId) {
        if !self.components.renders.is_empty() {
            self.forget_render_place(id);
        }
        if !self.components.app_classes.is_empty() {
            self.components.app_classes.remove(&id);
        }
    }

    /// Sends the failures of views' code (bindings, effects, listeners) to
    /// the nearest error boundary, else to their component's; whether there
    /// were any.
    fn report_failures(&mut self) -> bool {
        let failures = self.components.runtime.take_failures();
        let any = !failures.is_empty();
        for (owner, message) in failures {
            let host = self.host_of_owner(owner);
            let component = host
                .and_then(|h| match &self.components.instances.get(&h)?.inner {
                    Inner::Component(inner) => Some(inner.name()),
                    _ => None,
                })
                .unwrap_or("a binding");
            if let Some(boundary) = crate::element::reactive::boundary_of(owner) {
                boundary.set(Some(ComponentError { component, message }));
                continue;
            }
            match host {
                Some(host) => self.component_failed(host, message),
                None => log::error!(target: "js", "a binding failed: {message}"),
            }
        }
        any
    }

    /// Makes the views of the components marked dirty (one made already
    /// takes its slots, children and styles; a list cell builds its row
    /// again); whether there were any.
    fn render_dirty(&mut self) -> bool {
        // What handles asked for since (animated values released, ...).
        for action in self.components.executor.take_actions() {
            self.apply_action(action);
        }
        if self.components.dirty.is_empty() {
            return false;
        }
        while let Some(host) = self.components.dirty.pop() {
            // A view JS made waits to be in the tree (under what places it):
            // its context comes from above it.
            if self.waits_for_tree(host) {
                if let Some(inst) = self.components.instances.get_mut(&host) {
                    inst.dirty = false;
                }
                if !self.components.waiting.contains(&host) {
                    self.components.waiting.push(host);
                }
                continue;
            }
            let Some(mut inst) = self.components.instances.remove(&host) else {
                continue;
            };
            inst.dirty = false;
            let failed = self.render(host, &mut inst);
            self.components.instances.insert(host, inst);
            if let Some(message) = failed {
                self.component_failed(host, message);
            }
        }
        true
    }

    /// Applies the root styles of the view on `host` again over the app's
    /// (or its parent's) styles, which may have changed.
    fn restyle_view(&mut self, host: NodeId, inst: &mut Instance) {
        // The component its root is applies them to the node.
        if let Some(rooted) = inst.rooted {
            if std::mem::take(&mut inst.given_changed)
                && let Some(rooted) = self.components.instances.get_mut(&rooted)
            {
                rooted.given_changed = true;
            }
            self.components.mark(rooted);
            return;
        }
        let cx = self.root_context(inst);
        let given_changed = std::mem::take(&mut inst.given_changed);
        let attrs = if let Some(node) = inst.bound.get_mut(&host) {
            let (style, classes) = (node.style.clone(), node.classes.clone());
            let class = node.attrs.class.clone();
            let classes = self.apply_el_styles(
                host,
                &style,
                &style,
                classes,
                class.as_ref(),
                cx.user.clone(),
            );
            if let Some(node) = inst.bound.get_mut(&host) {
                node.classes = classes;
                given_changed.then(|| node.attrs.clone())
            } else {
                None
            }
        } else if let Some(root) = inst.root.as_mut() {
            let (style, classes) = (root.style.clone(), root.classes.clone());
            let class = root.attrs.class.clone();
            root.classes = self.apply_el_styles(
                host,
                &style,
                &style,
                classes,
                class.as_ref(),
                cx.user.clone(),
            );
            given_changed.then(|| root.attrs.clone())
        } else {
            None
        };
        // What the views above give it changed: applied again over its
        // root's own.
        if let Some(attrs) = attrs {
            let app = if cx.combined {
                cx.app.as_ref()
            } else {
                inst.app_style.as_ref()
            };
            let _ = self.apply_op(inline_style(
                host,
                attrs.inline.as_deref(),
                attrs.animated(),
                app,
            ));
            let applied = inst.root_insets_applied;
            let own_insets = attrs.insets();
            let insets = (
                cx.inset_padding.or(own_insets.0),
                cx.inset_margin.or(own_insets.1),
            );
            if insets.0 != applied.0 {
                let _ = self.apply_op(Op::SetProp {
                    id: host,
                    prop: Prop::InsetPadding(insets.0.unwrap_or_default()),
                });
            }
            if insets.1 != applied.1 {
                let _ = self.apply_op(Op::SetProp {
                    id: host,
                    prop: Prop::InsetMargin(insets.1.unwrap_or_default()),
                });
            }
            inst.root_insets_applied = insets;
            let test_id = cx.test_id.clone().or_else(|| test_id_of(&attrs));
            if test_id != inst.root_test_id_applied {
                let _ = self.apply_op(Op::SetProp {
                    id: host,
                    prop: Prop::TestId(test_id.clone()),
                });
                inst.root_test_id_applied = test_id;
            }
        }
    }

    /// Node `id` joined a host as its children: the components in it, the
    /// node itself or inside its plain views however deep
    /// (`tabs().child(view().child(tab()))`), are `joined`, so their views
    /// wait to be placed and read the context of the host's view as a
    /// direct child does. A component's own content joins it in turn.
    fn join_content(&mut self, id: NodeId) {
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            if let Some(inst) = self.components.instances.get_mut(&id) {
                inst.joined = true;
                continue;
            }
            if let Ok(k) = self.key(id) {
                stack.extend(
                    self.nodes[k as usize]
                        .children
                        .iter()
                        .map(|&c| self.nodes[c as usize].id),
                );
            }
        }
    }

    /// Whether `host` is a component that runs once, made by JS (no owner
    /// placed it) or passed by a view as a nested component's content
    /// (`joined`), whose view is not made yet, out of the tree: the view
    /// that places it gives its context.
    fn waits_for_tree(&self, host: NodeId) -> bool {
        let Some(inst) = self.components.instances.get(&host) else {
            return false;
        };
        let Inner::Component(inner) = &inst.inner else {
            return false;
        };
        inst.root.is_none()
            && (inst.joined || !inner.failure_owner().is_live())
            && !self.id_in_tree(host)
    }

    /// Whether node `id` is in the root's tree.
    fn id_in_tree(&self, id: NodeId) -> bool {
        self.key(id).is_ok_and(|k| self.in_tree(k))
    }

    /// The views that waited for the tree and are in it now are made;
    /// whether there were any.
    fn wake_waiting(&mut self) -> bool {
        let waiting = std::mem::take(&mut self.components.waiting);
        let mut woke = false;
        for host in waiting {
            if !self.components.instances.contains_key(&host) {
                continue;
            }
            if self.id_in_tree(host) {
                self.components.mark(host);
                woke = true;
            } else {
                self.components.waiting.push(host);
            }
        }
        woke
    }

    /// Runs the calls of methods parked for components whose view is now
    /// made; whether any ran.
    fn run_parked_methods(&mut self) -> bool {
        if self.components.parked_methods.is_empty() {
            return false;
        }
        let parked = std::mem::take(&mut self.components.parked_methods);
        let mut ran = false;
        for (host, call, method) in parked {
            if self.view_pending(host) {
                self.components.parked_methods.push((host, call, method));
            } else {
                ran = true;
                self.run_rust(RustOp {
                    call,
                    run: RustCall::Method(host, method),
                });
            }
        }
        ran
    }

    /// Whether `host` hosts a component whose view is not made yet.
    fn view_pending(&self, host: NodeId) -> bool {
        self.components
            .instances
            .get(&host)
            .is_some_and(|i| matches!(&i.inner, Inner::Component(inner) if inner.owner().is_none()))
    }

    /// The owner of the nearest component above `host` in the tree (its
    /// view's, or a list cell's row), else none.
    fn owner_above(&self, host: NodeId) -> crate::element::Owner {
        let mut key = self.key(host).ok();
        while let Some(k) = key {
            let parent = self.nodes[k as usize].parent;
            if parent == NO_KEY {
                break;
            }
            key = Some(parent);
            // A component may return another component as its root. The
            // innermost one owns the content's placement context.
            let id = self.base_of(self.nodes[parent as usize].id);
            // What JS made is under a component through its JS children:
            // under where it places them.
            let owner = self
                .components
                .instances
                .get(&id)
                .and_then(|inst| match &inst.inner {
                    Inner::Component(inner) => inst
                        .children_owner
                        .filter(|o| o.is_live())
                        .or_else(|| inner.owner().filter(|o| o.is_live())),
                    _ => inst.cell_owner,
                });
            if let Some(owner) = owner {
                return owner;
            }
        }
        crate::element::Owner::detached()
    }

    /// The owner a component JS made in a window JS opened renders under
    /// when no component is above it: one per window, providing its ref,
    /// so [`crate::element::desktop::current_window`] is that window (its
    /// title bar area, its dialogs). `None` in the main window.
    fn js_window_owner(&mut self, host: NodeId) -> Option<crate::element::Owner> {
        let key = self.key(host).ok()?;
        let window = self.key_window(key);
        if window == ROOT_ID {
            return None;
        }
        if let Some((owner, _)) = self.components.js_windows.get(&window)
            && owner.is_live()
        {
            return Some(*owner);
        }
        let id = self
            .window_ids
            .iter()
            .find_map(|(id, (node, _))| (*node == window).then(|| id.clone()))?;
        let reported = self
            .components
            .window_reports
            .get(&window)
            .copied()
            .unwrap_or_default();
        let (owner, this) =
            crate::element::desktop::js_window(&id, window, &self.components.executor, reported);
        self.components.js_windows.insert(window, (owner, this));
        Some(owner)
    }

    /// The host of the component that runs once whose owner is `owner`, or
    /// whose view made it (a binding's own owner is under the component's).
    fn host_of_owner(&self, owner: crate::element::Owner) -> Option<NodeId> {
        let mut at = Some(owner);
        while let Some(owner) = at {
            let host =
                self.components
                    .instances
                    .iter()
                    .find_map(|(&host, inst)| match &inst.inner {
                        Inner::Component(inner) if inner.owner() == Some(owner) => Some(host),
                        _ => None,
                    });
            if host.is_some() {
                return host;
            }
            at = owner.parent();
        }
        None
    }

    /// The window the component that runs once under `owner` shows in (its
    /// root node), the main window's when there is none.
    fn window_of_owner(&self, owner: crate::element::Owner) -> NodeId {
        if self.window_ids.is_empty() {
            return crate::ROOT_ID;
        }
        self.host_of_owner(owner)
            .and_then(|host| self.key(host).ok())
            .map_or(crate::ROOT_ID, |key| self.key_window(key))
    }

    /// Makes `inst`'s view on `host` (once: a view made already takes its
    /// slots, children and styles), or builds a list cell's row again; what
    /// its code panicked with, if it did.
    fn render(&mut self, host: NodeId, inst: &mut Instance) -> Option<String> {
        let mut failure = None;
        let el = match &mut inst.inner {
            Inner::Component(inner) => {
                // What the app passed, as props.
                if let Some(spec) = &inst.spec {
                    for name in spec.slots() {
                        let filled = inst.slots.iter().any(|(s, node)| {
                            *s == name
                                && self
                                    .key(*node)
                                    .is_ok_and(|k| !self.nodes[k as usize].children.is_empty())
                        }) || inst
                            .fills
                            .iter()
                            .any(|f| f.name == name && !self.fill_nodes(f).is_empty());
                        inner.set_slot(name, filled);
                    }
                }
                inner.set_children(!inst.js_children.is_empty());
                // Its view is made: its props now reach what read them, and
                // the app's (or its parent's) styles may have changed.
                if inst.root.is_some() && !std::mem::take(&mut inst.remake) {
                    self.restyle_view(host, inst);
                    return None;
                }
                let owner = self.owner_above(host);
                let owner = if owner.is_live() {
                    owner
                } else {
                    self.js_window_owner(host).unwrap_or(owner)
                };
                inner.adopt(owner);
                // A view that fails shows nothing.
                caught(|| inner.view()).unwrap_or_else(|message| {
                    failure = Some(message);
                    ElNode::empty_view()
                })
            }
            // The cell itself stays the list's: the wrapper goes inside.
            Inner::Row { place, index } => {
                let (place, index) = (place.clone(), *index);
                let count = self.rows_of_cell(host);
                let list = self.list_of(host);
                // The wrapper reads its position from signals.
                let count_signal = list.map(|list| self.list_count(list, count));
                let moves = list
                    .and_then(|list| self.components.virtual_lists.get(&list))
                    .and_then(|state| state.moves);
                let made = std::cell::Cell::new(None);
                let build = || {
                    let at = row_position(index, count, count_signal, moves, &made);
                    view().child(place(Child::row(), at)).into_element().0
                };
                // The wrapper is the placing component's.
                let parent = self.list_component_owner(list);
                let el = self.build_cell(parent, inst, build);
                inst.cell_position = made.take();
                if let (Some(list), Some(index), Some(owner)) =
                    (list, inst.cell_position, inst.cell_owner)
                    && let Some(state) = self.components.virtual_lists.get(&list)
                {
                    state.rows.borrow_mut().insert(host, (index, owner));
                }
                match el {
                    Ok(el) => el,
                    Err(message) => {
                        failure = Some(message);
                        ElNode::empty_view()
                    }
                }
            }
            Inner::VirtualRow { list, index } => {
                let (list, index) = (*list, *index);
                let inverted = self
                    .key(list)
                    .ok()
                    .and_then(|k| self.nodes[k as usize].list.as_ref())
                    .is_some_and(|l| l.inverted);
                let state = self.components.virtual_lists.get(&list).map(|state| {
                    // The run that made the list went (its view goes in
                    // this commit): no row is made under it.
                    let scope = state.scope.get();
                    let gone = scope.is_some_and(|s| !s.is_live());
                    (
                        if gone { 0 } else { state.count as usize },
                        state.row.clone(),
                        state.separator.clone(),
                        state.rows.clone(),
                        scope,
                        state.moves,
                    )
                });
                match state {
                    // The row is gone (the list shrank): the cell shows
                    // nothing until the list unbinds it or binds it to a
                    // row again; the row function is never asked for a
                    // row past the end.
                    Some((count, ..)) if index >= count => {
                        if let Some(owner) = inst.cell_owner.take() {
                            owner.dispose();
                        }
                        inst.cell_position = None;
                        ElNode::empty_view()
                    }
                    Some((count, row, separator, rows, scope, moves)) => {
                        let count_signal = Some(self.list_count(list, count));
                        let made = std::cell::Cell::new(None);
                        let build = || {
                            let at = row_position(index, count, count_signal, moves, &made);
                            let row = row(at);
                            // Between rows: after each but the last (before
                            // it, inverted), while it is not.
                            let separator = separator.map(|s| {
                                crate::element::when(move || !at.is_last(), move || s())
                                    .into_element()
                            });
                            match separator {
                                Some(s) if inverted => view().child(s).child(row),
                                Some(s) => view().child(row).child(s),
                                None => view().child(row),
                            }
                            .into_element()
                            .0
                        };
                        // Under the run that made the list, also when the
                        // row is inside another component's wrapper (an
                        // `Items` prop): the list is known here, not from
                        // the cell's parent.
                        let parent = scope.unwrap_or_else(|| self.list_component_owner(Some(list)));
                        let el = self.build_cell(parent, inst, build);
                        inst.cell_position = made.take();
                        if let (Some(index), Some(owner)) = (inst.cell_position, inst.cell_owner) {
                            rows.borrow_mut().insert(host, (index, owner));
                        }
                        match el {
                            Ok(el) => el,
                            Err(message) => {
                                failure = Some(message);
                                ElNode::empty_view()
                            }
                        }
                    }
                    None => ElNode::empty_view(),
                }
            }
            Inner::Missing => ElNode::empty_view(),
        };
        // The view binds under its owner.
        let owner = match &inst.inner {
            Inner::Component(inner) => inner.owner(),
            _ => inst.cell_owner,
        };
        match owner {
            Some(owner) => owner.run(|| self.expand_root(host, inst, el)),
            None => self.expand_root(host, inst, el),
        }
        failure
    }

    /// Builds a list cell's row with `build` under an owner of the cell's
    /// own (the previous row's goes), made under `parent` so the row sees
    /// its context.
    fn build_cell(
        &mut self,
        parent: crate::element::Owner,
        inst: &mut Instance,
        build: impl FnOnce() -> ElNode,
    ) -> Result<ElNode, String> {
        if let Some(owner) = inst.cell_owner.take() {
            owner.dispose();
        }
        let (owner, el) = parent.run(|| crate::element::create_root(|| caught(build)));
        inst.cell_owner = Some(owner);
        el
    }

    /// The owner of the component whose list `list` is (its own list, or
    /// the list it places another component's `Items` in).
    fn list_component_owner(&self, list: Option<NodeId>) -> crate::element::Owner {
        let component = list
            .and_then(|list| {
                self.components
                    .virtual_lists
                    .get(&list)
                    .map(|s| s.owner)
                    .or_else(|| self.components.slot_hosts.get(&list).copied())
            })
            .and_then(|host| self.components.instances.get(&host))
            .and_then(|inst| match &inst.inner {
                Inner::Component(inner) => inner.owner(),
                _ => None,
            });
        component.unwrap_or_else(crate::element::Owner::detached)
    }

    /// The text content `new` of node `id` (of `host`'s view), its raw
    /// text node made, changed or released from `old`.
    fn reconcile_text(
        &mut self,
        id: NodeId,
        host: NodeId,
        new: Option<SharedString>,
        old: Option<(SharedString, NodeId)>,
    ) -> Option<(SharedString, NodeId)> {
        match (new, old) {
            (Some(content), Some((old, raw))) => {
                if content != old {
                    let _ = self.apply_op(Op::SetText {
                        id: raw,
                        text: content.as_str().to_owned(),
                    });
                }
                Some((content, raw))
            }
            (Some(content), None) => {
                let raw = self.components.alloc();
                let _ = self.apply_op(Op::CreateText {
                    id: raw,
                    text: content.as_str().to_owned(),
                });
                self.components.owners.insert(raw, host);
                let _ = self.apply_op(Op::Insert {
                    parent: id,
                    child: raw,
                    before: None,
                });
                Some((content, raw))
            }
            (None, Some((_, raw))) => {
                self.release_id(raw);
                None
            }
            (None, None) => None,
        }
    }

    /// Applies a view's root `el` to `host` itself (over a list cell's
    /// previous row) and expands its children. A view's root can be any
    /// element: the host becomes its node (a screen, a modal, a text, a
    /// list), holds it (a region), or is the host of a component as the
    /// root ([`Self::expand_rooted`]).
    fn expand_root(&mut self, host: NodeId, inst: &mut Instance, mut el: ElNode) {
        if matches!(el.kind, ElKind::Component(_))
            && matches!(inst.inner, Inner::Component(_))
            && inst
                .root
                .as_ref()
                .is_none_or(|r| matches!(r.part, Part::Component(_)))
        {
            return self.expand_rooted(host, inst, el);
        }
        let node = matches!(el.kind, ElKind::Plain | ElKind::VirtualList(_));
        if !node || (el.tag != Tag::View && !self.retag(host, el.tag)) {
            if node {
                log::error!(target: "js", "a component's root takes its kind only when it is first mounted; it is placed in a view");
            }
            let inner = std::mem::replace(&mut el, ElNode::new(Tag::View));
            el.children.push(inner);
        }
        if !el.children.is_empty()
            && let Some(content) = el.bound_text.take()
        {
            let mut first = ElNode::new(Tag::Text);
            first.text = Some(SharedString::default());
            first.bound_text = Some(content);
            el.text = None;
            el.children.insert(0, first);
        }
        // Bound parts are bound first: what they read now is applied with
        // the static parts.
        let applied_layout = if matches!(el.kind, ElKind::VirtualList(_)) {
            self.components.list_layouts.remove(&host)
        } else {
            None
        };
        let bound = super::views::Bound::take(&mut el).map(|bound| {
            self.bind_parts(host, host, bound, &mut el);
        });
        inst.handlers.clear();
        inst.event_handlers.clear();
        inst.responders.clear();
        let old = inst.root.take();
        let first = old.is_none();
        let old_place = std::mem::replace(&mut inst.children_at, Placement::None);
        // The root is the host itself.
        let (old_attrs, old_style, old_classes, old_events, old_children, old_text, old_list) =
            match old {
                Some(e) => (
                    e.attrs,
                    e.style,
                    e.classes,
                    e.events,
                    e.children,
                    e.text,
                    e.list.map(|l| *l).unwrap_or_default(),
                ),
                None => (
                    Attrs::default(),
                    StyleRefinement::default(),
                    (None, None),
                    EventMask::default(),
                    Vec::new(),
                    None,
                    ListConfig::default(),
                ),
            };
        // What the views above give it and the components on its host, the
        // outer last.
        let cx = self.root_context(inst);
        let app = if cx.combined {
            cx.app.as_ref()
        } else {
            inst.app_style.as_ref()
        };
        let attrs = cx.over(el.attrs.clone());
        // As it was applied: with the insets its node got.
        let mut old_over = old_attrs.clone();
        old_over.set_insets(inst.root_insets_applied);
        let old_over = with_test_id(old_over, &inst.root_test_id_applied);
        if !self.apply_target_attrs(host, &attrs, &old_over, app) {
            self.apply_attrs_over(host, &attrs, &old_over, app);
        }
        inst.root_insets_applied = attrs.insets();
        inst.root_test_id_applied = test_id_of(&attrs);
        // Given an inline style or animated values while its own did not
        // change: they go now.
        let given_changed = std::mem::take(&mut inst.given_changed) || first;
        if cx.given
            && given_changed
            && attrs.inline == old_over.inline
            && attrs.animated() == old_over.animated()
        {
            let _ = self.apply_op(inline_style(
                host,
                attrs.inline.as_deref(),
                attrs.animated(),
                app,
            ));
        }
        let user = cx.user.clone();
        let top_js = cx.js;
        let given_events = cx.given_events;
        let classes = self.apply_el_styles(
            host,
            &el.style,
            &old_style,
            old_classes,
            el.attrs.class.as_ref(),
            user,
        );
        let text = self.reconcile_text(host, host, el.text.take(), old_text);
        if bound.is_some() {
            Self::keep_bound(
                inst,
                host,
                &el.attrs,
                &el.style,
                classes.clone(),
                text.clone(),
            );
        }
        // The host listens to its component's events, JS's and those the
        // views above give it.
        let js = top_js.unwrap_or(inst.js_events) | given_events;
        self.apply_handlers(host, host, &el, old_events | js, js, inst);
        let mut events = EventMask::default();
        for (kind, _) in &el.handlers {
            events.set(*kind, true);
        }
        events.set(
            EventKind::Touch,
            events.contains(EventKind::Touch) || el.responder.is_some(),
        );
        let new_children = std::mem::take(&mut el.children);
        let children = self.reconcile_children(host, old_children, new_children, host, inst);
        let (list, part) = match std::mem::replace(&mut el.kind, ElKind::Plain) {
            ElKind::VirtualList(list) => {
                let config = list.config;
                let old_list = applied_layout.unwrap_or(old_list);
                self.update_virtual_list(self.native_id(host), host, *list, &old_list);
                (Some(Box::new(config)), Part::VirtualList)
            }
            _ => (None, Part::Node),
        };
        inst.root = Some(Expanded {
            id: host,
            tag: el.tag,
            key: None,
            text,
            attrs: el.attrs,
            style: el.style,
            classes,
            events,
            list,
            part,
            children,
        });
        self.children_placed(host, inst, old_place);
    }

    /// [`Self::expand_root`] of a view whose root is component element
    /// `el`: that component is made on `host` itself, under an alias of its
    /// node ([`Core::alias`]), and its view makes the node, with what this
    /// view gives it (props, styles, listeners, ref, content) and what the
    /// app gives this one (styles, events): no node of its own.
    fn expand_rooted(&mut self, host: NodeId, inst: &mut Instance, el: ElNode) {
        let ElKind::Component(c) = &el.kind else {
            return;
        };
        let part = Part::Component(c.name);
        inst.handlers.clear();
        inst.event_handlers.clear();
        inst.responders.clear();
        let old_place = std::mem::replace(&mut inst.children_at, Placement::None);
        let prev = match inst.root.take() {
            Some(old) if old.part == part => old,
            old => {
                if let Some(old) = old {
                    self.release_expanded(old);
                }
                let id = self.components.alloc();
                if let Err(e) = self.alias(id, host) {
                    log::error!(target: "js", "a view's root component is not made: {e:?}");
                    return;
                }
                self.components.owners.insert(id, host);
                self.create_instance_for(id, c);
                if let Some(rooted) = self.components.instances.get_mut(&id) {
                    // The app's style is the top host's.
                    rooted.app_style = None;
                    rooted.above = Some(host);
                }
                Expanded::js(id, part)
            }
        };
        inst.rooted = Some(prev.id);
        let root = self.reconcile_node(Some(prev), el, part, host, inst);
        inst.root = Some(root);
        self.children_placed(host, inst, old_place);
    }

    /// The component whose view makes host `id`'s node: its own, or the
    /// one its view's root is (as deep as roots are components).
    pub(super) fn base_of(&self, id: NodeId) -> NodeId {
        let mut at = id;
        while let Some(next) = self.components.instances.get(&at).and_then(|i| i.rooted) {
            at = next;
        }
        at
    }

    /// What `inst`'s root takes besides its own: the styles, inline styles,
    /// animated values and insets the views above give it and the
    /// components whose views' roots it is (the outer last), the app's
    /// style and JS's events on the top host.
    pub(super) fn root_context(&mut self, inst: &Instance) -> RootContext {
        let mut cx = RootContext {
            user: inst.user.clone(),
            combined: false,
            app: None,
            js: None,
            given_events: inst.given_events,
            inset_padding: None,
            inset_margin: None,
            test_id: None,
            given: false,
        };
        if inst.above.is_none() && inst.given.is_none() {
            return cx;
        }
        cx.combined = true;
        let mut decls: Vec<crate::StyleDecl> = Vec::new();
        let mut take = |cx: &mut RootContext, given: &Attrs| {
            cx.given = true;
            if let Some(inline) = &given.inline {
                decls.extend(inline.decls().iter().cloned());
            }
            if let Some(r) = &given.rare {
                decls.extend(r.animated.iter().map(|(d, _)| d.clone()));
                cx.inset_padding = r.inset_padding.or(cx.inset_padding);
                cx.inset_margin = r.inset_margin.or(cx.inset_margin);
            }
            cx.test_id = test_id_of(given).or(cx.test_id.take());
        };
        if let Some(given) = &inst.given {
            take(&mut cx, given);
        }
        // The classes the element was given in Rust (`app_class`), as the
        // app's `class` on its host.
        if let Some(class) = inst.given.as_ref().and_then(|g| g.class.clone()) {
            let given = self.app_class_list(&class);
            cx.user = self.merge_user(cx.user.take(), Some(given));
        }
        let mut app = inst.app_style.clone();
        let mut at = inst.above;
        while let Some(id) = at {
            let Some(above) = self.components.instances.get(&id) else {
                break;
            };
            let (outer, given) = (above.user.clone(), above.given.clone());
            app = above.app_style.clone();
            cx.js = Some(above.js_events);
            cx.given_events = cx.given_events | above.given_events;
            at = above.above;
            if let Some(given) = &given {
                take(&mut cx, given);
            }
            cx.user = self.merge_user(cx.user.take(), outer);
            if let Some(class) = given.and_then(|g| g.class.clone()) {
                let given = self.app_class_list(&class);
                cx.user = self.merge_user(cx.user.take(), Some(given));
            }
        }
        if let Some(app) = &app {
            decls.extend(app.decls().iter().cloned());
        }
        if !decls.is_empty() {
            let mut style = crate::Style::default();
            let mut patch = crate::StylePatch::default();
            for decl in decls {
                let _ = patch.push(&mut style, decl);
            }
            cx.app = Some(patch);
        }
        cx
    }

    /// [`Self::root_context`] of the component hosted by `host`.
    pub(super) fn root_context_of(&mut self, host: NodeId) -> Option<RootContext> {
        let inst = self.components.instances.remove(&host)?;
        let cx = self.root_context(&inst);
        self.components.instances.insert(host, inst);
        Some(cx)
    }

    /// What the view `host` is in gives its element besides styles is `attrs`:
    /// its root takes them.
    pub(super) fn set_given(&mut self, host: NodeId, mut attrs: Attrs) {
        attrs.set_element_ref(None);
        let given = (attrs != Attrs::default()).then(|| Box::new(attrs));
        let Some(inst) = self.components.instances.get_mut(&host) else {
            return;
        };
        if inst.given != given {
            inst.given = given;
            inst.given_changed = true;
            self.components.mark(host);
        }
    }

    /// `inner`'s rules, then `outer`'s (one list per pair, kept).
    pub(super) fn merge_user(
        &mut self,
        inner: Option<std::rc::Rc<ClassList>>,
        outer: Option<std::rc::Rc<ClassList>>,
    ) -> Option<std::rc::Rc<ClassList>> {
        match (inner, outer) {
            (Some(a), Some(b)) => {
                let key = (
                    std::rc::Rc::as_ptr(&a) as usize,
                    std::rc::Rc::as_ptr(&b) as usize,
                );
                if let Some([_, _, merged]) = self.components.merges.get(&key) {
                    return Some(merged.clone());
                }
                if self.components.merges.len() >= STYLE_CACHE {
                    self.components.merges.clear();
                }
                let merged = std::rc::Rc::new(a.merged(&b));
                self.components.merges.insert(key, [a, b, merged.clone()]);
                Some(merged)
            }
            (a, None) => a,
            (None, b) => b,
        }
    }

    /// Where the JS children of `host` go changed from `old_place`: they
    /// leave the tree when nothing places them, and lazy ones are asked for
    /// or dropped.
    pub(super) fn children_placed(
        &mut self,
        host: NodeId,
        inst: &mut Instance,
        old_place: Placement,
    ) {
        // No `Children` any more: the JS children leave the tree.
        if inst.children_at == Placement::None && old_place != Placement::None {
            for &child in &inst.js_children {
                self.unplace(old_place, child);
            }
        }
        // Lazy children are made while the view places them: by JS, or by
        // the view this one is in (what passes them reads a signal).
        let wanted = inst.children_at != Placement::None;
        if inst.children_wanted != wanted && inst.spec.as_ref().is_some_and(|s| s.lazy_children) {
            inst.children_wanted = wanted;
            match self.components.owners.get(&host).copied() {
                // A view's: what passes them follows (a view that passes
                // none made no signal). The run of the view that passed
                // them may be gone already, in this commit, before what it
                // made is released: a region of this component and the one
                // passing its children changed together (a menu and its
                // submenu ending their exits at once). Nothing reads its
                // signal then.
                Some(_) => {
                    if let Some(signal) = inst.lazy_wanted {
                        signal.try_set(wanted);
                    }
                }
                None => self.events.push(JsEvent::Children { host, wanted }),
            }
        }
    }

    /// The signal of whether the component hosted by `nested` places its
    /// lazy children, made under the current owner (the view passing them)
    /// the first time.
    fn children_wanted_signal(&mut self, nested: NodeId) -> crate::element::Signal<bool> {
        let Some(inst) = self.components.instances.get_mut(&nested) else {
            return crate::element::signal(false);
        };
        // Made again under this owner when the one that made it is gone
        // (the run that passed them before was disposed while the
        // component stayed).
        match inst.lazy_wanted {
            Some(signal) if signal.is_live() => signal,
            _ => {
                let signal = crate::element::signal(inst.children_wanted);
                inst.lazy_wanted = Some(signal);
                signal
            }
        }
    }

    /// JS child `child`, placed at `place`, leaves the tree (and the
    /// nested component it was passed on to).
    fn unplace(&mut self, place: Placement, child: NodeId) {
        match place {
            Placement::Nested(nested, _) if self.is_host(nested) => {
                let _ = self.intercept(Op::Remove {
                    parent: nested,
                    child,
                });
            }
            _ => self.detach_id(child),
        }
    }

    pub(super) fn detach_id(&mut self, id: NodeId) {
        self.unfold_run(id);
        if let Ok(key) = self.key(id)
            && self.nodes[key as usize].parent != NO_KEY
        {
            self.detach(key);
        }
    }

    pub(super) fn apply_attrs(&mut self, id: NodeId, new: &Attrs, old: &Attrs) {
        self.apply_attrs_over(id, new, old, None);
    }

    /// [`Self::apply_attrs`] for a host: the app's style goes after the
    /// root's (and is sent again with it).
    pub(super) fn apply_attrs_over(
        &mut self,
        id: NodeId,
        new: &Attrs,
        old: &Attrs,
        app: Option<&crate::StylePatch>,
    ) {
        // An element's ref names its node by its own id.
        let node = self.native_id(id);
        let has_rare = new.rare.is_some() || old.rare.is_some();
        if has_rare {
            let empty = crate::element::builder::RareAttrs::default();
            let nr = new.rare.as_deref().unwrap_or(&empty);
            let or = old.rare.as_deref().unwrap_or(&empty);
            if or.element_ref != nr.element_ref
                && let Some(r) = &or.element_ref
            {
                r.detach(node);
            }
            if let Some(r) = &nr.element_ref {
                r.attach(node);
            }
            if nr.render != or.render {
                self.update_render(node, or.render.as_ref(), nr.render.as_ref());
            }
        }
        let mut props = std::mem::take(&mut self.components.props);
        new.changes(old, &mut props);
        for prop in props.drain(..) {
            let _ = self.apply_op(Op::SetProp { id, prop });
        }
        self.components.props = props;
        let animated_changed = has_rare && new.animated() != old.animated();
        if new.inline != old.inline || animated_changed {
            let _ = self.apply_op(inline_style(id, new.inline.as_deref(), new.animated(), app));
        }
        if has_rare {
            let empty = crate::element::builder::RareAttrs::default();
            let nr = new.rare.as_deref().unwrap_or(&empty);
            let or = old.rare.as_deref().unwrap_or(&empty);
            if nr.drawing != or.drawing
                && let Some(drawing) = &nr.drawing
            {
                let _ = self.apply_op(Op::Draw {
                    id,
                    drawing: Box::new((**drawing).clone()),
                });
            }
            if nr.window != or.window
                && let Some(window) = &nr.window
            {
                // Opened once; then only its attributes follow (the record sends
                // what changed).
                let command = if or.window.is_none() {
                    crate::desktop::DesktopCommand::OpenWindow(Box::new(
                        crate::desktop::OpenWindow {
                            options: (**window).clone(),
                            ..Default::default()
                        },
                    ))
                } else {
                    crate::desktop::DesktopCommand::SetAttributes(Box::new(
                        window.attributes.clone(),
                    ))
                };
                let opens = or.window.is_none();
                let _ = self.apply_op(Op::Command {
                    id,
                    command: crate::Command::Desktop(Box::new(command)),
                });
                // What its ref was asked for before it existed follows its
                // opening, in order (`open_window(..)` then `focus()`).
                if opens {
                    for command in &nr.window_commands {
                        let _ = self.apply_op(Op::Command {
                            id,
                            command: crate::Command::Desktop(Box::new(command.clone())),
                        });
                    }
                }
            }
        }
    }

    /// Sets node `id`'s classes: `style` lowered, then `user` (a host's).
    pub(super) fn apply_styles(
        &mut self,
        id: NodeId,
        style: &StyleRefinement,
        old_style: &StyleRefinement,
        old: Classes,
        user: Option<std::rc::Rc<ClassList>>,
    ) -> Classes {
        let own = if style == old_style {
            old.0.clone()
        } else if style.is_empty() {
            None
        } else {
            Some(self.components.lowered(style))
        };
        if !same(&own, &old.0) || !same(&user, &old.1) {
            let list = self.merge_user(own.clone(), user.clone());
            if let Ok(key) = self.key(id) {
                self.set_class_list(key, list);
            }
        }
        (own, user)
    }

    /// [`Self::apply_styles`] for an element of a view: the app's classes
    /// it carries (`class`, [`crate::element::Element::app_class`]) go after its
    /// own styles, then `outer` (a root's: what the views and the app give
    /// its host).
    pub(super) fn apply_el_styles(
        &mut self,
        id: NodeId,
        style: &StyleRefinement,
        old_style: &StyleRefinement,
        old: Classes,
        class: Option<&SharedString>,
        outer: Option<std::rc::Rc<ClassList>>,
    ) -> Classes {
        let Some(class) = class.filter(|c| !c.trim().is_empty()) else {
            if !self.components.app_classes.is_empty() {
                self.components.app_classes.remove(&id);
            }
            return self.apply_styles(id, style, old_style, old, outer);
        };
        let app = self.app_class_list(class);
        let user = self.merge_user(Some(app), outer.clone());
        let classes = self.apply_styles(id, style, old_style, old, user);
        self.components
            .app_classes
            .insert(id, (classes.0.clone(), class.clone(), outer));
        classes
    }

    /// The rules of the app's classes `class` (the unknown ones warned of
    /// once, as a host's).
    pub(super) fn app_class_list(&mut self, class: &str) -> std::rc::Rc<ClassList> {
        let (list, fresh) = self.tailwind.get(class);
        if fresh && !list.unknown().is_empty() {
            log::warn!(
                "unknown classes: {}",
                list.unknown()
                    .iter()
                    .map(|s| &**s)
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }
        list
    }

    /// Registers `el`'s handlers for node `id` and listens to their events
    /// (plus `extra`, what JS listens to on a host); returns the mask.
    #[allow(
        clippy::too_many_arguments,
        reason = "the installed node and its owning view"
    )]
    fn apply_handlers(
        &mut self,
        host: NodeId,
        id: NodeId,
        el: &ElNode,
        old: EventMask,
        extra: EventMask,
        inst: &mut Instance,
    ) -> EventMask {
        let mut mask = extra;
        self.initialize_layout_listeners(host, id, el, old, inst);
        // A node made again (its region ran again) hears what this run
        // gives it, not also what the runs before gave it.
        if old.bits() != 0 {
            inst.handlers.remove(id);
            inst.responders.retain(|(n, _)| *n != id);
        }
        for (kind, handler) in &el.handlers {
            mask.set(*kind, true);
            inst.handlers.push(id, *kind, handler.clone());
        }
        // The responder hears the touches the platform reports.
        if let Some(responder) = &el.responder {
            mask.set(EventKind::Touch, true);
            inst.responders.push((id, responder.clone()));
        }
        // Only the events that changed (with a slot's own when the node
        // takes a slot's props: they stay).
        let own = self.target_events(id, mask);
        let mut changed = (mask.bits() ^ old.bits()) & !own.bits();
        while changed != 0 {
            let kind = EventKind::ALL[changed.trailing_zeros() as usize];
            changed &= changed - 1;
            let _ = self.apply_op(Op::Listen {
                id,
                event: kind,
                enabled: mask.contains(kind),
            });
        }
        mask
    }

    /// Queues the current frame for listeners belonging to a new region run.
    pub(super) fn initialize_layout_listeners(
        &mut self,
        host: NodeId,
        id: NodeId,
        el: &ElNode,
        old: EventMask,
        inst: &Instance,
    ) {
        // Only listeners of a new owner need the kept node's initial
        // frame. A listener passed in from outside the region stays live.
        if old.contains(EventKind::Layout)
            && let Ok(key) = self.key(id)
        {
            let frame = self.nodes[key as usize].frame;
            if !frame.origin.x.0.is_nan() {
                for (kind, listener) in &el.handlers {
                    if *kind == EventKind::Layout
                        && !inst
                            .handlers
                            .of(id)
                            .iter()
                            .any(|(k, old)| *k == *kind && old.same_owner(listener))
                    {
                        self.events.push(JsEvent::LayoutListener {
                            host,
                            id,
                            listener: listener.clone(),
                            frame,
                        });
                    }
                }
            }
        }
    }

    fn reconcile_children(
        &mut self,
        parent: NodeId,
        old: Vec<Expanded>,
        new: Vec<ElNode>,
        host: NodeId,
        inst: &mut Instance,
    ) -> Vec<Expanded> {
        if new.is_empty() && old.is_empty() {
            return Vec::new();
        }
        let new = new.into_iter().map(|el| NewChild::Made(None, el)).collect();
        let (out, placeholder) = self.match_children(parent, old, new, host, inst);
        // A region's nodes go before what follows it.
        self.set_region_anchors(&out, inst, Anchor::End);
        let nested = parent != host && self.is_host(parent);
        if nested {
            if let Some(at) = placeholder {
                let anchor = self.anchor_after(&out[at + 1..], inst, Anchor::End);
                inst.children_at = Placement::Nested(parent, anchor);
            }
            self.place_filled(&out, inst, Anchor::End, |anchor| {
                Placement::Nested(parent, anchor)
            });
            self.fill_nested(parent, &out, host, inst);
            self.join_nested(parent, &out, inst);
            return out;
        }
        if let Some(at) = placeholder {
            let anchor = self.anchor_after(&out[at + 1..], inst, Anchor::End);
            inst.children_at = Placement::At(parent, anchor);
        }
        self.place_filled(&out, inst, Anchor::End, |anchor| {
            Placement::At(parent, anchor)
        });
        // The native children in the view's order: the JS children in the
        // placeholder's place, a region's nodes in its (moves only when the
        // order changed).
        let wanted_ids: Vec<NodeId> = out
            .iter()
            .flat_map(|e| match e.part {
                Part::Children => inst.js_children.clone(),
                Part::Filled(name) => self
                    .fill_of(inst, name)
                    .map(|f| self.fill_nodes(f))
                    .unwrap_or_default(),
                Part::Region(region) => self.region_nodes(region),
                _ => vec![e.id],
            })
            .collect();
        let wanted = || wanted_ids.iter();
        // A list positions its cells itself: their order does not matter
        // (and the cells it binds are not the view's), new ones join it.
        if self.is_list(parent) {
            // (A region's nodes join it as they come.)
            for e in out.iter().filter(|e| e.id != 0) {
                let joined = self
                    .key(e.id)
                    .is_ok_and(|k| self.nodes[k as usize].parent != NO_KEY);
                if !joined {
                    let _ = self.apply_op(Op::Insert {
                        parent,
                        child: e.id,
                        before: None,
                    });
                }
            }
            return out;
        }
        let in_order = self.key(parent).is_ok_and(|k| {
            let have = &self.nodes[k as usize].children;
            have.len() == wanted().count()
                && have
                    .iter()
                    .zip(wanted())
                    .all(|(&c, &id)| self.nodes[c as usize].id == id)
        });
        if !in_order {
            // From the end, each child before the one after it: only the
            // children out of place move. Moving a native view takes it
            // out of the window for a moment, which ends its touches and
            // its focus (Android: an input that gains a sibling would lose
            // the keyboard on each keystroke).
            let ids: Vec<NodeId> = wanted().copied().collect();
            // A first fill appends them in order: no child to find its place
            // among (from the end, each would scan the ones placed already).
            let empty = self
                .key(parent)
                .is_ok_and(|k| self.nodes[k as usize].children.is_empty());
            if empty {
                for &child in &ids {
                    let _ = self.apply_op(Op::Insert {
                        parent,
                        child,
                        before: None,
                    });
                }
                return out;
            }
            self.place_before(parent, &ids, None);
        }
        out
    }

    /// Matches `new` with the `old` elements of `parent` and applies them;
    /// releases the old ones left. The elements as applied, and where the
    /// JS children go among them.
    pub(super) fn match_children(
        &mut self,
        parent: NodeId,
        old: Vec<Expanded>,
        new: Vec<NewChild>,
        host: NodeId,
        inst: &mut Instance,
    ) -> (Vec<Expanded>, Option<usize>) {
        // `children_each`: one wrapper per JS child, keyed by it; in a view,
        // a region following them.
        let new = if new.iter().any(
            |child| matches!(child, NewChild::Made(_, e) if matches!(e.kind, ElKind::EachChild(_))),
        ) {
            let mut each = Vec::with_capacity(new.len() + inst.js_children.len());
            for child in new {
                let NewChild::Made(owner, el) = child else {
                    each.push(child);
                    continue;
                };
                let ElKind::EachChild(place) = &el.kind else {
                    each.push(NewChild::Made(owner, el));
                    continue;
                };
                if inst.children_at != Placement::None {
                    log::error!(target: "js", "a view places its children once");
                    continue;
                }
                inst.children_at = Placement::Each;
                {
                    let children = *inst.js_kids.get_or_insert_with(|| {
                        crate::element::signal_with(
                            inst.js_children.clone(),
                            crate::element::SignalEquals::Never,
                        )
                    });
                    // A wrapper per child, kept while the child stays; its
                    // position follows it.
                    let place = place.clone();
                    let count = crate::element::computed(move || children.with(Vec::len));
                    let region = crate::element::each(
                        children,
                        |&child: &NodeId| child,
                        move |child, index| {
                            let at = Position::of(index.node(), count.node());
                            place(Child::js(child.get_untracked()), at)
                        },
                    );
                    each.push(NewChild::Made(owner, region.0));
                }
            }
            each
        } else {
            new
        };
        let mut old: Vec<Option<Expanded>> = old.into_iter().map(Some).collect();
        let mut out = Vec::with_capacity(new.len());
        let mut placeholder = None;
        // Unkeyed elements take the next unused old element of their kind,
        // in order: an element that comes or goes (`.children(option)`)
        // does not shift its siblings onto new nodes.
        let mut cursor = 0;
        // Where the element after the last one kept was: kept rows mostly
        // follow each other as they did, and are then found without a
        // search of all the old ones for each.
        let mut after_kept = 0;
        // The keyed old elements by key, for the rows and elements not
        // where they were (a reversed list: each would search them all).
        let mut keys = OldKeys::default();
        for child in new {
            let (owner, el) = match child {
                NewChild::Made(owner, el) => (owner, el),
                // An `Each` row that stays: as it was. (One old element
                // at most has its key, which is its row's own.)
                NewChild::Kept(key) => {
                    let is = |o: &Option<Expanded>| {
                        o.as_ref().is_some_and(|o| o.key.as_ref() == Some(&key))
                    };
                    let at = if old.get(after_kept).is_some_and(is) {
                        Some(after_kept)
                    } else {
                        keys.find(&old, &key, |_| true)
                    };
                    match at.and_then(|at| {
                        after_kept = at + 1;
                        old[at].take()
                    }) {
                        Some(e) => out.push(e),
                        None => log::error!("a kept row is gone"),
                    }
                    continue;
                }
            };
            let child = |core: &mut Self| {
                core.match_child(
                    parent,
                    el,
                    host,
                    inst,
                    &mut old,
                    &mut out,
                    &mut placeholder,
                    &mut cursor,
                    &mut keys,
                );
            };
            match owner {
                Some(owner) => owner.run(|| child(self)),
                None => child(self),
            }
        }
        // Content of a nested component (`.child`, `.fill`): it leaves and
        // joins the nested host as JS children and slots do, so the nested
        // component's view places it.
        let nested = parent != host && self.is_host(parent);
        for o in old.into_iter().flatten() {
            // What fills a slot this view placed there stays (another
            // view's): it leaves first.
            self.unplace_filled(&o, inst);
            if nested && o.part == Part::Children {
                // The JS children passed on stay (JS's): they leave.
                for &child in &inst.js_children {
                    let _ = self.intercept(Op::Remove { parent, child });
                }
            } else if nested {
                for node in self.placed(&o) {
                    self.forget_nested(parent, node);
                }
            }
            self.release_expanded(o);
        }
        (out, placeholder)
    }

    /// Matches element `el` with one of the `old` elements of `parent` and
    /// applies it (see [`Self::match_children`]).
    #[allow(clippy::too_many_arguments, reason = "the matching's state")]
    fn match_child(
        &mut self,
        parent: NodeId,
        mut el: ElNode,
        host: NodeId,
        inst: &mut Instance,
        old: &mut [Option<Expanded>],
        out: &mut Vec<Expanded>,
        placeholder: &mut Option<usize>,
        cursor: &mut usize,
        keys: &mut OldKeys,
    ) {
        // A slot a view fills: placed as it is (`Filled`), or in a node of
        // this view's own when the view gives it anything, which lays its
        // one node out through while it styles none of its layout (as JS's
        // holders: `lay_out_through`).
        let mut wrapper = false;
        if let ElKind::Slot(name) = el.kind
            && inst.fills.iter().any(|f| f.name == name)
        {
            if is_plain(&el) {
                el.kind = ElKind::Filled(name);
            } else {
                el.kind = ElKind::Plain;
                let mut filled = ElNode::new(Tag::View);
                filled.kind = ElKind::Filled(name);
                el.children = vec![filled];
                el.key.get_or_insert_with(|| format!("slot:{name}").into());
                wrapper = true;
            }
        }
        match std::mem::replace(&mut el.kind, ElKind::Plain) {
            ElKind::Filled(name) => {
                if let Some(j) = old
                    .iter()
                    .position(|o| o.as_ref().is_some_and(|o| o.part == Part::Filled(name)))
                {
                    old[j] = None;
                }
                out.push(Expanded::js(0, Part::Filled(name)));
            }
            ElKind::Fill(name) => {
                // Content of the nested component `parent`, as its children
                // are: nodes of this view, its regions bound here.
                let prev = old
                    .iter()
                    .position(|o| o.as_ref().is_some_and(|o| o.part == Part::Fill(name)))
                    .and_then(|j| old[j].take());
                let old_children = prev.map(|p| p.children).unwrap_or_default();
                let new = std::mem::take(&mut el.children)
                    .into_iter()
                    .map(|c| NewChild::Made(None, c))
                    .collect();
                let filling = self.components.filling.replace((parent, name));
                let (children, _) = self.match_children(parent, old_children, new, host, inst);
                self.components.filling = filling;
                let mut e = Expanded::js(0, Part::Fill(name));
                e.children = children;
                out.push(e);
            }
            ElKind::Slot(name) => {
                // The slot's own node, while the app passes one.
                let Some(&(_, node)) = inst.slots.iter().find(|(s, _)| *s == name) else {
                    return;
                };
                let at = old.iter().position(|o| {
                    o.as_ref()
                        .is_some_and(|o| o.part == Part::Slot && o.id == node)
                });
                let prev = at.and_then(|j| old[j].take());
                out.push(self.reconcile_slot(prev, node, el, host, inst));
            }
            ElKind::Children => {
                if placeholder.is_some() || inst.children_at != Placement::None {
                    log::error!(target: "js", "a view places its children once");
                    return;
                }
                if let Some(j) = old
                    .iter()
                    .position(|o| o.as_ref().is_some_and(|o| o.part == Part::Children))
                {
                    old[j] = None;
                }
                *placeholder = Some(out.len());
                inst.children_owner = Some(crate::element::Owner::current());
                out.push(Expanded::js(0, Part::Children));
            }
            ElKind::JsChild(id) => {
                // Taken over, not released (that would detach it).
                if let Some(j) = old.iter().position(|o| {
                    o.as_ref()
                        .is_some_and(|o| o.part == Part::JsChild && o.id == id)
                }) {
                    old[j] = None;
                }
                if inst.js_children.contains(&id) {
                    out.push(Expanded::js(id, Part::JsChild));
                }
            }
            // Expanded above.
            ElKind::EachChild(_) => {}
            // A view's region: bound, its nodes come with its patches.
            ElKind::Region(region) => {
                let id = self.bind_region(host, parent, region);
                let mut e = super::views::region_placeholder(id);
                // An `Each` row's region keeps its row's key: a run that
                // keeps the row finds it by that key (`NewChild::Kept`).
                e.key = el.key;
                out.push(e);
            }
            ElKind::List(list) => {
                // The glue's list: placed and laid out like a slot,
                // its rows wrapped by this view's row function.
                let Some(&(_, node)) = inst.slots.iter().find(|(s, _)| *s == list.name) else {
                    return;
                };
                let at = old.iter().position(|o| {
                    o.as_ref()
                        .is_some_and(|o| o.part == Part::Slot && o.id == node)
                });
                let prev = at.and_then(|j| old[j].take());
                let old_config = self
                    .components
                    .list_layouts
                    .remove(&node)
                    .or_else(|| prev.as_ref().and_then(|p| p.list.as_deref().copied()))
                    .unwrap_or_default();
                // Its bound layout is a binding.
                let parts = std::mem::take(&mut el.bound_list);
                let config = if parts.is_empty() {
                    list.config
                } else {
                    self.bind_list_layout(node, list.config, parts)
                };
                let mut props = std::mem::take(&mut self.components.props);
                config.changes(&old_config, &mut props);
                for prop in props.drain(..) {
                    let _ = self.apply_op(Op::SetProp { id: node, prop });
                }
                self.components.props = props;
                let mut e = self.reconcile_slot(prev, node, el, host, inst);
                e.list = Some(Box::new(config));
                let rows = self.rows_of_list(node);
                self.components.lists.insert(node, (list.row.clone(), rows));
                // Rows of the component whose view has this one: its
                // cells to come are wrapped too.
                if let Some(state) = self.components.virtual_lists.get_mut(&node) {
                    state.place = Some(list.row.clone());
                }
                let cells: Vec<NodeId> = match self.key(node) {
                    Ok(k) => self.nodes[k as usize]
                        .children
                        .iter()
                        .map(|&c| self.nodes[c as usize].id)
                        .collect(),
                    Err(_) => Vec::new(),
                };
                for cell in cells {
                    self.wrap_row(cell, list.row.clone());
                }
                out.push(e);
            }
            kind => {
                el.kind = kind;
                let part = match &el.kind {
                    ElKind::Component(c) => Part::Component(c.name),
                    ElKind::VirtualList(_) => Part::VirtualList,
                    ElKind::Raw => Part::Raw,
                    _ => Part::Node,
                };
                // A component made again is a new one, as in TSX: it runs
                // once, so an old instance cannot take a new element (its
                // view would keep what it made from the old props).
                let component = matches!(part, Part::Component(_));
                let matches = |o: &Expanded| !component && o.tag == el.tag && o.part == part;
                let at = match &el.key {
                    Some(k) => keys.find(old, k, matches),
                    None => {
                        let at = old[(*cursor).min(old.len())..]
                            .iter()
                            .position(|o| o.as_ref().is_some_and(|o| o.key.is_none() && matches(o)))
                            .map(|j| j + *cursor);
                        if let Some(j) = at {
                            *cursor = j + 1;
                        }
                        at
                    }
                };
                let prev = at.and_then(|j| old[j].take());
                let e = if wrapper {
                    self.reconcile_wrapper(prev, el, host, inst)
                } else {
                    self.reconcile_node(prev, el, part, host, inst)
                };
                out.push(e);
            }
        }
    }

    /// Whether `child` is content of the nested component hosted by
    /// `nested` right before `next` (the last when `next` is `None`).
    pub(super) fn nested_precedes(
        &self,
        nested: NodeId,
        child: NodeId,
        next: Option<NodeId>,
    ) -> bool {
        let Some(inst) = self.components.instances.get(&nested) else {
            return false;
        };
        let kids = &inst.js_children;
        kids.iter()
            .position(|&c| c == child)
            .is_some_and(|i| kids.get(i + 1).copied() == next)
    }

    /// Inserts `child` into the content of the nested component hosted by
    /// `nested`, before `before`, as JS inserts its children.
    pub(super) fn join_nested_at(&mut self, nested: NodeId, child: NodeId, before: Option<NodeId>) {
        if let Ok(Some(op)) = self.intercept(Op::Insert {
            parent: nested,
            child,
            before,
        }) {
            let _ = self.apply_op(op);
        }
    }

    /// Node `child` of this view, about to be released, is no longer
    /// content of the nested component hosted by `nested`: it leaves the
    /// component's children with no native removal (deleting a view
    /// detaches it, as a plain element's does).
    fn forget_nested(&mut self, nested: NodeId, child: NodeId) {
        if self.components.slot_names.remove(&child).is_some() {
            self.unslot(child);
            return;
        }
        let Some(inst) = self.components.instances.get_mut(&nested) else {
            return;
        };
        let count = inst.js_children.len();
        inst.js_children.retain(|&c| c != child);
        if inst.js_children.len() == count {
            return;
        }
        if let Some(children) = inst.js_kids {
            children.set(inst.js_children.clone());
        }
        let place = inst.children_at;
        if inst.js_children.is_empty() || place == Placement::Each {
            self.components.mark(nested);
        }
        // Passed on deeper, it leaves those components' children too.
        if let Placement::Nested(deeper, _) = place
            && self.is_host(deeper)
        {
            self.forget_nested(deeper, child);
        }
    }

    /// The content `out` of the nested component hosted by `nested`, in
    /// order: its children as the host's JS children (`js_children`, the
    /// view's own JS children, where it passes them on), its slots' holders
    /// in their slots (inserted only when that changed).
    fn join_nested(&mut self, nested: NodeId, out: &[Expanded], inst: &Instance) {
        let insert = |core: &mut Self, child: NodeId, before: Option<NodeId>| {
            if let Ok(Some(op)) = core.intercept(Op::Insert {
                parent: nested,
                child,
                before,
            }) {
                let _ = core.apply_op(op);
            }
        };
        let (slots, children): (Vec<NodeId>, Vec<NodeId>) = out
            .iter()
            .flat_map(|e| match e.part {
                Part::Children => inst.js_children.clone(),
                Part::Filled(name) => self
                    .fill_of(inst, name)
                    .map(|f| self.fill_nodes(f))
                    .unwrap_or_default(),
                // A slot's: placed by the nested view where it places it.
                Part::Fill(_) => Vec::new(),
                _ => self.placed(e),
            })
            .partition(|id| self.components.slot_names.contains_key(id));
        for slot in slots {
            if self.components.slot_hosts.get(&slot) != Some(&nested) {
                insert(self, slot, None);
            }
        }
        let same = self
            .components
            .instances
            .get(&nested)
            .is_some_and(|i| i.js_children == children);
        if !same {
            let mut before = None;
            for &child in children.iter().rev() {
                insert(self, child, before);
                before = Some(child);
            }
        }
    }

    /// The fill of slot `name` among `inst`'s.
    pub(super) fn fill_of<'a>(&self, inst: &'a Instance, name: &'static str) -> Option<&'a Fill> {
        inst.fills.iter().find(|f| f.name == name)
    }

    /// The nodes of `fill` now, in order.
    pub(super) fn fill_nodes(&self, fill: &Fill) -> Vec<NodeId> {
        self.fill_nodes_with(fill, None)
    }

    /// [`Self::fill_nodes`], with `out`'s instance for its host (one taken
    /// out of the instances while its view is reconciled).
    fn fill_nodes_with(&self, fill: &Fill, out: Option<(NodeId, &Instance)>) -> Vec<NodeId> {
        let mut nodes = Vec::with_capacity(fill.parts.len());
        for part in &fill.parts {
            match *part {
                FillPart::Node(id) => nodes.push(id),
                FillPart::Region(region) => self.fill_region_nodes(region, out, &mut nodes),
                FillPart::Filled(name) => self.passed_nodes(fill.from, name, out, &mut nodes),
            }
        }
        nodes
    }

    /// Adds the nodes of region `region` of a fill to `nodes`, what fills
    /// a slot of the region's view passed on among them.
    fn fill_region_nodes(
        &self,
        region: u32,
        out: Option<(NodeId, &Instance)>,
        nodes: &mut Vec<NodeId>,
    ) {
        let Some(state) = self.components.regions.get(&region) else {
            return;
        };
        for e in &state.children {
            match e.part {
                Part::Filled(name) => self.passed_nodes(state.host, name, out, nodes),
                Part::Region(inner) => self.fill_region_nodes(inner, out, nodes),
                _ => nodes.extend(self.placed(e)),
            }
        }
    }

    /// Adds the nodes of what fills slot `name` of the component on `host`
    /// to `nodes` (`out`: an instance taken out of the instances).
    fn passed_nodes(
        &self,
        host: NodeId,
        name: &'static str,
        out: Option<(NodeId, &Instance)>,
        nodes: &mut Vec<NodeId>,
    ) {
        let inst = match out {
            Some((h, inst)) if h == host => Some(inst),
            _ => self.components.instances.get(&host).map(|i| &**i),
        };
        if let Some(fill) = inst.and_then(|i| self.fill_of(i, name)) {
            nodes.extend(self.fill_nodes_with(fill, out));
        }
    }

    /// The slots of the view on `host` whose fills `parts` pass on (as they
    /// are, or in a region of them).
    fn passed_slots(&self, parts: &[FillPart], host: NodeId, names: &mut Vec<&'static str>) {
        fn of_region<M: TextEngine>(
            core: &Core<M>,
            region: u32,
            host: NodeId,
            names: &mut Vec<&'static str>,
        ) {
            let Some(state) = core.components.regions.get(&region) else {
                return;
            };
            for e in &state.children {
                match e.part {
                    Part::Filled(name) if state.host == host => names.push(name),
                    Part::Region(inner) => of_region(core, inner, host, names),
                    _ => {}
                }
            }
        }
        for part in parts {
            match *part {
                FillPart::Filled(name) => names.push(name),
                FillPart::Region(region) => of_region(self, region, host, names),
                FillPart::Node(_) => {}
            }
        }
    }

    /// Notes on the view on `host` (`inst`) which of its slots' fills go
    /// on into the fill of slot `name` of the nested component `nested`.
    pub(super) fn note_passed(
        &self,
        nested: NodeId,
        name: &'static str,
        host: NodeId,
        inst: &mut Instance,
    ) {
        let mut passed = Vec::new();
        if let Some(fill) = self
            .components
            .instances
            .get(&nested)
            .and_then(|t| self.fill_of(t, name))
        {
            self.passed_slots(&fill.parts, host, &mut passed);
        }
        for fill in &mut inst.fills {
            if passed.contains(&fill.name) {
                fill.forwarded = Some((nested, name));
            } else if fill.forwarded == Some((nested, name)) {
                fill.forwarded = None;
            }
        }
    }

    /// Where `out` (a view's children, or a region's, `end` after them)
    /// places what fills its slots: `place` of what follows each.
    pub(super) fn place_filled(
        &self,
        out: &[Expanded],
        inst: &mut Instance,
        end: Anchor,
        place: impl Fn(Anchor) -> Placement,
    ) {
        if inst.fills.is_empty() {
            return;
        }
        for (i, e) in out.iter().enumerate() {
            let Part::Filled(name) = e.part else {
                continue;
            };
            let at = place(self.anchor_after(&out[i + 1..], inst, end));
            if let Some(fill) = inst.fills.iter_mut().find(|f| f.name == name) {
                fill.at = at;
            }
        }
    }

    /// `e` and what it holds leave this view: what fills a slot it placed
    /// leaves its place (it stays: another view's).
    pub(super) fn unplace_filled(&mut self, e: &Expanded, inst: &mut Instance) {
        if inst.fills.is_empty() {
            return;
        }
        match e.part {
            Part::Filled(name) => {
                let Some(fill) = inst.fills.iter_mut().find(|f| f.name == name) else {
                    return;
                };
                let at = std::mem::replace(&mut fill.at, Placement::None);
                if at == Placement::None {
                    return;
                }
                let nodes = self.fill_nodes(self.fill_of(inst, name).expect("a fill"));
                for node in nodes {
                    self.unplace(at, node);
                }
            }
            Part::Region(region) => {
                let children = self
                    .components
                    .regions
                    .get_mut(&region)
                    .map(|s| std::mem::take(&mut s.children))
                    .unwrap_or_default();
                for c in &children {
                    self.unplace_filled(c, inst);
                }
                if let Some(state) = self.components.regions.get_mut(&region) {
                    state.children = children;
                }
            }
            _ => {
                for c in &e.children {
                    self.unplace_filled(c, inst);
                }
            }
        }
    }

    /// The slots the view on `host` (its instance `inst`) fills of the
    /// nested component hosted by `nested`, from its content `out`: they
    /// replace the ones before (a fill gone was released with its nodes,
    /// what was passed on and no longer is leaves its place), and go where
    /// the nested view places them.
    fn fill_nested(&mut self, nested: NodeId, out: &[Expanded], host: NodeId, inst: &mut Instance) {
        let fills: Vec<(&'static str, Vec<FillPart>)> = out
            .iter()
            .filter_map(|e| match e.part {
                Part::Fill(name) => Some((
                    name,
                    e.children
                        .iter()
                        .filter_map(|c| match c.part {
                            Part::Region(region) => Some(FillPart::Region(region)),
                            Part::Filled(name) => Some(FillPart::Filled(name)),
                            _ if c.id != 0 => Some(FillPart::Node(c.id)),
                            _ => None,
                        })
                        .collect(),
                )),
                _ => None,
            })
            .collect();
        // What fills this view's own slots goes where they are passed on.
        for fill in &mut inst.fills {
            if fill.forwarded.is_some_and(|(n, _)| n == nested) {
                fill.forwarded = None;
            }
        }
        for (name, parts) in &fills {
            let mut passed = Vec::new();
            self.passed_slots(parts, host, &mut passed);
            for fill in inst.fills.iter_mut().filter(|f| passed.contains(&f.name)) {
                fill.forwarded = Some((nested, name));
            }
        }
        let Some(target) = self.components.instances.get_mut(&nested) else {
            return;
        };
        if fills.is_empty() && target.fills.is_empty() {
            return;
        }
        let mut changed = target.fills.len() != fills.len();
        let old = std::mem::take(&mut target.fills);
        for (name, parts) in fills {
            let (at, forwarded, same) = match old.iter().find(|f| f.name == name) {
                Some(f) => (f.at, f.forwarded, f.parts == parts),
                None => (Placement::None, None, false),
            };
            changed |= !same;
            target.fills.push(Fill {
                name,
                parts,
                from: host,
                at,
                forwarded,
            });
        }
        if !changed {
            return;
        }
        // What was passed on and is no longer leaves its place (it stays:
        // the view above's); what was released went with its Delete.
        let out = Some((host, &*inst));
        let mut leaving = Vec::new();
        for fill in &old {
            let at = self.fill_place(nested, fill.name);
            let now = self
                .components
                .instances
                .get(&nested)
                .and_then(|t| self.fill_of(t, fill.name))
                .map(|f| self.fill_nodes_with(f, out))
                .unwrap_or_default();
            for node in self.fill_nodes_with(fill, out) {
                if !now.contains(&node) && self.key(node).is_ok() {
                    leaving.push((at, node));
                }
            }
        }
        for (at, node) in leaving {
            self.unplace(at, node);
        }
        // Its slot props follow (`Some` while a fill has nodes).
        self.components.mark(nested);
        let names: Vec<&'static str> = self.components.instances[&nested]
            .fills
            .iter()
            .map(|f| f.name)
            .collect();
        for name in names {
            self.place_fill_with(nested, name, Some((host, &*inst)));
        }
    }

    /// Where the nodes of the fill of slot `name` of the nested component
    /// hosted by `nested` are placed: where its view places them, or where
    /// the slot it is passed on to is.
    fn fill_place(&self, nested: NodeId, name: &'static str) -> Placement {
        let Some(fill) = self
            .components
            .instances
            .get(&nested)
            .and_then(|inst| self.fill_of(inst, name))
        else {
            return Placement::None;
        };
        match (fill.at, fill.forwarded) {
            (Placement::None, Some((deeper, slot))) => self.fill_place(deeper, slot),
            (at, _) => at,
        }
    }

    /// Puts the nodes of the fill of slot `name` of the nested component
    /// hosted by `nested` where its view places them (a region of the fill
    /// changed, or the fill), and where it passes them on to.
    pub(super) fn place_fill(&mut self, nested: NodeId, name: &'static str) {
        self.place_fill_with(nested, name, None);
    }

    /// [`Self::place_fill`], with `out`'s instance for its host (one taken
    /// out of the instances while its view is reconciled).
    fn place_fill_with(
        &mut self,
        nested: NodeId,
        name: &'static str,
        out: Option<(NodeId, &Instance)>,
    ) {
        let Some(fill) = self
            .components
            .instances
            .get(&nested)
            .and_then(|inst| self.fill_of(inst, name))
        else {
            return;
        };
        let (nodes, at, forwarded) = (self.fill_nodes_with(fill, out), fill.at, fill.forwarded);
        if let Some((deeper, slot)) = forwarded {
            // Passed on: the deeper slot's fill holds them, and its prop
            // follows.
            self.components.mark(deeper);
            self.place_fill_with(deeper, slot, out);
        }
        match at {
            Placement::At(parent, anchor) => {
                let parent_key = self.key(parent).ok();
                // An anchor that left the parent: at the end.
                let before = self.anchor_node(anchor).filter(|&a| {
                    self.key(a)
                        .is_ok_and(|k| Some(self.nodes[k as usize].parent) == parent_key)
                });
                self.place_before(parent, &nodes, before);
                // In a holder: the slot's props follow its one element.
                if self.components.fill_holders.contains(&parent) {
                    self.retarget_slot(parent, None);
                }
            }
            Placement::Nested(other, anchor) => {
                let mut before = self.anchor_node(anchor);
                for &child in nodes.iter().rev() {
                    if !self.nested_precedes(other, child, before) {
                        self.join_nested_at(other, child, before);
                    }
                    before = Some(child);
                }
            }
            _ => {}
        }
    }

    /// Place a batch before an anchor, reusing known sibling positions.
    pub(super) fn place_before(
        &mut self,
        parent: NodeId,
        nodes: &[NodeId],
        mut before: Option<NodeId>,
    ) {
        let parent_key = self.key(parent).ok();
        // Where `before` is among the parent's children (their end for
        // `None`), when known.
        let mut next = parent_key.and_then(|key| {
            let children = &self.nodes[key as usize].children;
            match before {
                Some(id) => children
                    .iter()
                    .position(|&child| self.nodes[child as usize].id == id),
                None => Some(children.len()),
            }
        });
        // Already contiguous before the anchor: every precedes check below
        // would succeed, so no child needs to move.
        if let (Some(key), Some(end)) = (parent_key, next)
            && end.checked_sub(nodes.len()).is_some_and(|start| {
                self.nodes[key as usize].children[start..end]
                    .iter()
                    .zip(nodes)
                    .all(|(&child, &id)| self.nodes[child as usize].id == id)
            })
        {
            return;
        }
        for &child in nodes.iter().rev() {
            // Looked for right before the node after it.
            let after = next;
            next = self.preceding(
                parent,
                child,
                before,
                after.and_then(|at| at.checked_sub(1)),
            );
            if next.is_none() {
                let _ = self.apply_op(Op::Insert {
                    parent,
                    child,
                    before,
                });
                // In the place `before` had, or right before it when
                // the child moved from before it: the node before it
                // is looked for next to it, so a node kept after new
                // ones is found without a search of the children.
                next = after.and_then(|at| {
                    let children = &self.nodes[parent_key? as usize].children;
                    std::iter::once(at).chain(at.checked_sub(1)).find(|&at| {
                        children
                            .get(at)
                            .is_some_and(|&c| self.nodes[c as usize].id == child)
                    })
                });
            }
            before = Some(child);
        }
    }

    /// Where `child` is among `parent`'s children when it is right before
    /// `next` (the last when `next` is `None`). `hint` is where it is expected, looked
    /// at first: nodes checked from the last to the first, each before the
    /// one after it, are found without a search of the children for each.
    /// A node not among them, as each node of a region mounted for the
    /// first time, is known from its own parent without a search either.
    pub(super) fn preceding(
        &self,
        parent: NodeId,
        child: NodeId,
        next: Option<NodeId>,
        hint: Option<usize>,
    ) -> Option<usize> {
        let k = self.key(parent).ok()?;
        if self.nodes[self.key(child).ok()? as usize].parent != k {
            return None;
        }
        let children = &self.nodes[k as usize].children;
        let id = |at: usize| children.get(at).map(|&c| self.nodes[c as usize].id);
        let at = match hint {
            Some(at) if id(at) == Some(child) => at,
            _ => {
                let at = children
                    .iter()
                    .position(|&c| self.nodes[c as usize].id == child);
                self.placing(at.map_or(children.len(), |at| at + 1));
                at?
            }
        };
        (id(at + 1) == next).then_some(at)
    }

    /// `n` more siblings or overlays looked at to place a view
    /// ([`Components::placing_work`]).
    #[cfg(test)]
    pub(super) fn placing(&self, n: usize) {
        let work = &self.components.placing_work;
        work.set(work.get() + n);
    }

    #[cfg(not(test))]
    #[inline(always)]
    pub(super) fn placing(&self, _n: usize) {}

    /// `n` more mount items looked at for views taking the kind of their
    /// component's root ([`Components::retag_work`]).
    #[cfg(test)]
    pub(super) fn retagging(&self, n: usize) {
        let work = &self.components.retag_work;
        work.set(work.get() + n);
    }

    #[cfg(not(test))]
    #[inline(always)]
    pub(super) fn retagging(&self, _n: usize) {}

    /// Slot node `node` as element `el` of `host`'s view: its styles, props
    /// and handlers (its children are the app's JSX). Its bound parts are
    /// bound as a node's of the view are; what is not a style goes to the
    /// slot's target, the app's element when the node holds one
    /// ([`super::slots`]).
    fn reconcile_slot(
        &mut self,
        prev: Option<Expanded>,
        node: NodeId,
        mut el: ElNode,
        host: NodeId,
        inst: &mut Instance,
    ) -> Expanded {
        let bound = super::views::Bound::take(&mut el);
        // What its bindings applied since it was placed is what the node
        // has (an `Expanded` keeps what was applied with it).
        let applied = inst.bound.remove(&node);
        let (old_attrs, old_style, old_classes) = match (prev, applied) {
            (Some(_), Some(a)) => (a.attrs, a.style, a.classes),
            (Some(p), None) => (p.attrs, p.style, p.classes),
            (None, _) => (Attrs::default(), StyleRefinement::default(), (None, None)),
        };
        let bound = bound.map(|bound| self.bind_parts(host, node, bound, &mut el));
        self.apply_slot_attrs(node, host, &el.attrs, &old_attrs, Some(&mut *inst));
        let classes = self.apply_el_styles(
            node,
            &el.style,
            &old_style,
            old_classes,
            el.attrs.class.as_ref(),
            None,
        );
        if bound.is_some() {
            Self::keep_bound(inst, node, &el.attrs, &el.style, classes.clone(), None);
        }
        // Its events are the component's first (`component_event` finds it
        // by its host); the node stays JS's or the placing view's.
        let events = self.apply_slot_handlers(node, host, &el, inst);
        Expanded {
            id: node,
            tag: Tag::View,
            key: None,
            text: None,
            attrs: el.attrs,
            style: el.style,
            classes,
            events,
            list: None,
            part: Part::Slot,
            children: Vec::new(),
        }
    }

    /// The node of `host`'s view element `el` wraps a slot's fill in (its
    /// one child places the fill): a slot node as JS's holders are. Its
    /// styles are its own, and it lays the fill's one node out through
    /// while they style none of its layout; the rest of what the place
    /// gives goes to that node when the fill is one element
    /// ([`super::slots`]), so its focus, keys and presses reach the
    /// component's listeners as a JS app's element's do.
    fn reconcile_wrapper(
        &mut self,
        mut prev: Option<Expanded>,
        mut el: ElNode,
        host: NodeId,
        inst: &mut Instance,
    ) -> Expanded {
        let (id, old_children) = match &mut prev {
            Some(p) => (p.id, std::mem::take(&mut p.children)),
            None => {
                let id = self.components.alloc();
                let _ = self.apply_op(Op::Create { id, tag: el.tag });
                self.components.owners.insert(id, host);
                (id, Vec::new())
            }
        };
        self.components.fill_holders.insert(id);
        // The fill first: its one element is where the rest goes.
        let children = std::mem::take(&mut el.children);
        let children = self.reconcile_children(id, old_children, children, host, inst);
        let (tag, key) = (el.tag, el.key.clone());
        let mut e = self.reconcile_slot(prev, id, el, host, inst);
        if let Ok(k) = self.key(id) {
            self.lay_out_through(k);
        }
        e.tag = tag;
        e.key = key;
        e.part = Part::Node;
        e.children = children;
        e
    }

    pub(super) fn reconcile_node(
        &mut self,
        prev: Option<Expanded>,
        mut el: ElNode,
        part: Part,
        host: NodeId,
        inst: &mut Instance,
    ) -> Expanded {
        // A text whose content is bound, with spans: the content is its
        // first span.
        if !el.children.is_empty()
            && let Some(content) = el.bound_text.take()
        {
            let mut first = ElNode::new(Tag::Text);
            first.text = Some(SharedString::default());
            first.bound_text = Some(content);
            el.text = None;
            el.children.insert(0, first);
        }
        // Bound parts are bound once the node exists, and what they read
        // now is applied with its static parts. The styles given a nested
        // component are a binding of their own (its host's styles are its
        // own and the app's).
        let nested_style = (matches!(el.kind, ElKind::Component(_)) && el.style.is_bound())
            .then(|| el.style.clone());
        // So are its bound attributes (insets).
        let nested_attrs = (matches!(el.kind, ElKind::Component(_)) && !el.bound_attrs.is_empty())
            .then(|| (el.attrs.clone(), el.bound_attrs.clone()));
        let bound = if matches!(el.kind, ElKind::Component(_)) {
            el.resolve_once();
            None
        } else {
            super::views::Bound::take(&mut el)
        };
        if matches!(el.kind, ElKind::Raw) {
            return self.reconcile_raw(prev, el, host);
        }
        // A text with spans: its own content is the first piece, as JS
        // has it.
        if !el.children.is_empty()
            && let Some(content) = el.text.take()
            && !content.is_empty()
        {
            let mut raw = ElNode::new(Tag::Text);
            raw.text = Some(content);
            raw.kind = ElKind::Raw;
            el.children.insert(0, raw);
        }
        let old_list = prev
            .as_ref()
            .and_then(|p| p.list.as_deref().copied())
            .unwrap_or_default();
        let kept = prev.is_some();
        let (id, old_attrs, old_style, old_classes, old_events, old_children, old_text) = match prev
        {
            Some(mut p) => {
                // Bindings may have changed the node since this element
                // was applied. Diff against those latest values, even
                // when the new element has no bindings.
                if let Some(applied) = inst.bound.remove(&p.id) {
                    p.attrs = applied.attrs;
                    p.style = applied.style;
                    p.classes = applied.classes;
                    p.text = applied.text;
                }
                (
                    p.id, p.attrs, p.style, p.classes, p.events, p.children, p.text,
                )
            }
            None => {
                let id = self.components.alloc();
                let _ = self.apply_op(Op::Create { id, tag: el.tag });
                self.components.owners.insert(id, host);
                if let ElKind::Component(c) = &el.kind {
                    self.create_instance_for(id, c);
                }
                (
                    id,
                    Attrs::default(),
                    StyleRefinement::default(),
                    (None, None),
                    EventMask::default(),
                    Vec::new(),
                    None,
                )
            }
        };
        // The element snapshot predates any applied layout binding patches.
        let old_list = if matches!(el.kind, ElKind::VirtualList(_)) {
            self.components.list_layouts.remove(&id).unwrap_or(old_list)
        } else {
            old_list
        };
        let bound = bound.map(|bound| self.bind_parts(host, id, bound, &mut el));
        let (component, virtual_list) = match std::mem::replace(&mut el.kind, ElKind::Plain) {
            ElKind::Component(c) => (Some(c), None),
            ElKind::VirtualList(list) => (None, Some(list)),
            _ => (None, None),
        };
        if let Some(c) = component {
            // A nested component: its props, and the styles as the app's
            // classes of its host.
            self.set_element_props(id, c.props.as_ref());
            if self.is_host(id) {
                if let Some(style) = nested_style {
                    el.style = self.bind_nested_style(id, style);
                }
                let user = (!el.style.is_empty()).then(|| self.components.lowered(&el.style));
                self.set_user(id, user);
            }
            // Made again, it hears this run's listeners only.
            if kept {
                inst.event_handlers.retain(|(n, _)| *n != id);
            }
            // The view's listeners of its node's events, after its root's.
            if self.is_host(id) {
                self.set_given_handlers(id, std::mem::take(&mut el.handlers));
            }
            inst.event_handlers
                .extend(c.on_event.into_iter().map(|listener| (id, listener)));
            // Its `ComponentRef`.
            let element_ref = el.attrs.take_element_ref();
            if old_attrs.element_ref() != element_ref.as_ref()
                && let Some(r) = old_attrs.element_ref()
            {
                r.detach(id);
            }
            if let Some(r) = &element_ref {
                r.attach(id);
            }
            // The rest goes on its root, after the root's own.
            if self.is_host(id) {
                let given = match nested_attrs {
                    Some((base, parts)) => self.bind_nested_attrs(id, base, parts),
                    None => std::mem::take(&mut el.attrs),
                };
                self.set_given(id, given);
            }
            // The content this view passes it (`.child`, `.fill`): nodes of
            // this view, inserted into its host as JS inserts its children,
            // so the nested component places them where its view says.
            // Lazy children are passed only while it places them, as JS
            // makes the app's (`$children`); slots and rows always are.
            let mut content = std::mem::take(&mut el.children);
            let is_slot = |c: &ElNode| {
                matches!(c.kind, ElKind::Fill(_))
                    || c.attrs
                        .props
                        .iter()
                        .any(|p| matches!(p, Prop::ComponentSlot(_)))
            };
            let lazy = self
                .components
                .instances
                .get(&id)
                .is_some_and(|i| i.spec.as_ref().is_some_and(|s| s.lazy_children));
            if lazy {
                // A view passes them while a signal of the nested
                // component's says it places them: a region of its own.
                let (slots, kids): (Vec<ElNode>, Vec<ElNode>) =
                    content.into_iter().partition(|c| is_slot(c));
                content = slots;
                if !kids.is_empty() {
                    let wanted = self.children_wanted_signal(id);
                    let shown = crate::element::when(wanted, move || {
                        kids.iter()
                            .cloned()
                            .map(crate::element::AnyElement)
                            .collect::<Vec<_>>()
                    });
                    content.push(shown.into_element().0);
                }
            }
            let children = self.reconcile_children(id, old_children, content, host, inst);
            let mut kept_attrs = Attrs::default();
            kept_attrs.set_element_ref(element_ref);
            return Expanded {
                id,
                tag: el.tag,
                key: el.key,
                text: None,
                attrs: kept_attrs,
                style: el.style,
                classes: (None, None),
                events: EventMask::default(),
                list: None,
                part,
                children,
            };
        }
        if !self.apply_target_attrs(id, &el.attrs, &old_attrs, None) {
            self.apply_attrs(id, &el.attrs, &old_attrs);
        }
        let classes = self.apply_el_styles(
            id,
            &el.style,
            &old_style,
            old_classes,
            el.attrs.class.as_ref(),
            None,
        );
        let text = self.reconcile_text(id, host, el.text.take(), old_text);
        if bound.is_some() {
            Self::keep_bound(
                inst,
                id,
                &el.attrs,
                &el.style,
                classes.clone(),
                text.clone(),
            );
        }
        let events = self.apply_handlers(host, id, &el, old_events, EventMask::default(), inst);
        let new_children = std::mem::take(&mut el.children);
        let children = self.reconcile_children(id, old_children, new_children, host, inst);
        let list = match virtual_list {
            Some(list) => {
                let config = list.config;
                self.update_virtual_list(id, host, *list, &old_list);
                Some(Box::new(config))
            }
            None => None,
        };
        Expanded {
            id,
            tag: el.tag,
            key: el.key,
            text,
            attrs: el.attrs,
            style: el.style,
            classes,
            events,
            list,
            part,
            children,
        }
    }

    /// A piece `el` of a text's content: its raw text node, created or
    /// changed (the view's order puts it in place).
    fn reconcile_raw(&mut self, prev: Option<Expanded>, el: ElNode, host: NodeId) -> Expanded {
        let content = el.text.unwrap_or_else(|| "".into());
        let id = match prev {
            Some(p) => {
                if p.text.as_ref().is_none_or(|(old, _)| *old != content) {
                    let _ = self.apply_op(Op::SetText {
                        id: p.id,
                        text: content.as_str().to_owned(),
                    });
                }
                p.id
            }
            None => {
                let id = self.components.alloc();
                let _ = self.apply_op(Op::CreateText {
                    id,
                    text: content.as_str().to_owned(),
                });
                self.components.owners.insert(id, host);
                id
            }
        };
        Expanded {
            id,
            tag: Tag::Text,
            key: None,
            text: Some((content, id)),
            attrs: Attrs::default(),
            style: StyleRefinement::default(),
            classes: (None, None),
            events: EventMask::default(),
            list: None,
            part: Part::Raw,
            children: Vec::new(),
        }
    }

    /// A view's list of its own rows: its layout, its rows (a splice when
    /// the keys say rows came or went, then the count), and its live cells
    /// built again with the new row function (when the list is made
    /// again). A bound count or keys are a binding: a memo that moves the
    /// live cells' indices as the rows moved (dropping the content of cells
    /// whose row went) and queues the change for the list
    /// ([`Self::set_list_rows`]). The cells' positions run it before they
    /// are read, so the rows' own bindings never read the new rows at the
    /// old indices, whichever runs first.
    fn update_virtual_list(
        &mut self,
        id: NodeId,
        owner: NodeId,
        list: VirtualListEl,
        old: &ListConfig,
    ) {
        // The static layout (its bound parts come as patches).
        let mut props = std::mem::take(&mut self.components.props);
        list.config.changes(old, &mut props);
        for prop in props.drain(..) {
            let _ = self.apply_op(Op::SetProp { id, prop });
        }
        self.components.props = props;
        let before = self
            .components
            .virtual_lists
            .get(&id)
            .map(|state| (state.count, state.keys.clone()));
        // The rows of another component's `Items` prop (its slot's node).
        let items = self.components.slot_names.contains_key(&id);
        let state = self
            .components
            .virtual_lists
            .entry(id)
            .or_insert_with(|| VirtualListState {
                owner,
                scope: Rc::default(),
                row: list.row.clone(),
                count: 0,
                keys: None,
                separator: None,
                cells: Vec::new(),
                rows: CellRows::default(),
                moves: None,
                items,
                place: None,
                contents: Vec::new(),
                min_view: None,
                reported: None,
                latest: None,
                report: None,
            });
        // The rows go with the run that made the list. A list a later run
        // keeps takes that run's owner: its cells are made again below.
        if state.scope.get() != list.scope {
            state.scope.set(list.scope);
            if let Some(scope) = list.scope {
                let rows = Rc::downgrade(&state.rows);
                let current = Rc::downgrade(&state.scope);
                scope.run(|| {
                    crate::element::cleanup(move || {
                        // A run the list has since left keeps the rows of
                        // the run it is in now.
                        if current.upgrade().is_some_and(|c| c.get() == Some(scope)) {
                            dispose_rows(&rows);
                        }
                    })
                });
            }
        }
        let cells = state.rows.clone();
        let bound = matches!(list.count, Reactive::Bound(_)) || list.keys.is_some();
        let (count, keys) = (list.count, list.keys);
        let rows = move || (count.get(), keys.as_ref().map(|k| k()));
        let mut moves = None;
        let (count, keys) = if bound {
            let count_signal = self.list_count(id, 0);
            let patches = self.components.patches.clone();
            let first: Rc<RefCell<Option<Rows>>> = Rc::default();
            let slot = first.clone();
            let last: RefCell<Option<Rc<[u64]>>> = RefCell::new(None);
            let made = std::cell::Cell::new(false);
            let memo = crate::element::computed(move || {
                let (count, keys) = rows();
                let diff = match (&*last.borrow(), &keys) {
                    (Some(old), Some(new)) => ListDiff::new(old, new),
                    _ => None,
                };
                last.replace(keys.clone());
                if made.replace(true) {
                    move_rows(&cells, diff.as_ref(), count);
                    count_signal.set(count as usize);
                    patches.borrow_mut().push(super::views::Patch::Rows {
                        list: id,
                        binding: crate::element::Owner::current(),
                        count,
                        keys,
                    });
                } else {
                    count_signal.set(count as usize);
                    *slot.borrow_mut() = Some((count, keys));
                }
            });
            moves = Some(memo.node());
            first.take().expect("a memo runs when it is made")
        } else {
            let (count, keys) = crate::element::untracked(rows);
            // What the cells of a view (or a view's wrappers) read.
            {
                self.list_count(id, count as usize).set(count as usize);
            }
            (count, keys)
        };
        self.send_list_rows(id, before.as_ref(), count, keys.as_ref());
        if before.is_none()
            && let Some(command) = list.initial_scroll
        {
            let _ = self.apply_op(Op::Command { id, command });
        }
        let state = self.components.virtual_lists.get_mut(&id).expect("list");
        state.row = list.row;
        state.count = count;
        state.keys = keys;
        state.moves = moves;
        state.separator = list.separator;
        state.min_view = list.min_view_time;
        self.sync_virtual_cells(id, true);
    }

    /// Sends list `id` its rows' changes from `before` (none: a new list):
    /// how the keys say rows came, went or moved, then the count.
    fn send_list_rows(
        &mut self,
        id: NodeId,
        before: Option<&Rows>,
        count: u32,
        keys: Option<&Rc<[u64]>>,
    ) {
        if let (Some((_, Some(old))), Some(new)) = (before, keys)
            && let Some(diff) = ListDiff::new(old, new)
        {
            let _ = self.apply_op(Op::SetProp {
                id,
                prop: Prop::ListDiff(Rc::new(diff)),
            });
        }
        if before.map(|(count, _)| *count) != Some(count) {
            let _ = self.apply_op(Op::SetProp {
                id,
                prop: Prop::Count(count),
            });
        }
    }

    /// A view's list `id` has new rows (its bound count or keys changed):
    /// sent to the list. Its cells' bindings already follow their rows
    /// ([`move_rows`]); the core takes their indices, and the cells whose row
    /// went show nothing until the list shows another row in them.
    pub(super) fn set_list_rows(&mut self, id: NodeId, count: u32, keys: Option<Rc<[u64]>>) {
        let Some(state) = self.components.virtual_lists.get(&id) else {
            return;
        };
        let before = (state.count, state.keys.clone());
        self.send_list_rows(id, Some(&before), count, keys.as_ref());
        let state = self.components.virtual_lists.get_mut(&id).expect("list");
        state.count = count;
        state.keys = keys;
        self.sync_virtual_cells(id, false);
    }

    fn sync_virtual_cells(&mut self, id: NodeId, rebuild: bool) {
        let key = self.key(id).expect("virtual list node");
        let slots = &self.nodes[key as usize].list.as_ref().expect("list").slots;
        let state = &self.components.virtual_lists[&id];
        for (slot, (&cell, &content)) in state.cells.iter().zip(&state.contents).enumerate() {
            for part in [cell, content].into_iter().filter(|&part| part != 0) {
                let Some(inst) = self.components.instances.get_mut(&part) else {
                    continue;
                };
                let remake = rebuild || !inst.cell_owner.is_some_and(|o| o.is_live());
                if let Inner::VirtualRow { index, .. } | Inner::Row { index, .. } = &mut inst.inner
                {
                    if remake {
                        // The content owner can die while the slot still has a row.
                        *index = slots[slot].requested.map_or(usize::MAX, |i| i as usize);
                    } else if let Some(position) = inst.cell_position {
                        *index = position.index.get_untracked();
                    }
                }
                if remake && !inst.dirty {
                    inst.dirty = true;
                    self.components.dirty.push(part);
                }
            }
        }
    }

    /// The row count the cells of list `list` read, made with `count` the
    /// first time.
    fn list_count(&mut self, list: NodeId, count: usize) -> crate::element::Signal<usize> {
        if let Some(&(_, signal)) = self.components.list_counts.get(&list) {
            return signal;
        }
        let made = crate::element::Owner::detached()
            .run(|| crate::element::create_root(|| crate::element::signal(count)));
        self.components.list_counts.insert(list, made);
        made.1
    }

    /// List `list` goes: so do the count its cells read and its layout.
    fn forget_list_count(&mut self, list: NodeId) {
        if let Some((owner, _)) = self.components.list_counts.remove(&list) {
            owner.dispose();
        }
        self.components.list_layouts.remove(&list);
    }

    /// Binds the cells of the components' own lists the last layout asked
    /// for (creating them as needed); false when there were none.
    pub(super) fn bind_virtual_lists(&mut self) -> bool {
        if self.components.virtual_lists.is_empty() {
            return false;
        }
        let _entered = self.components.runtime.enter();
        let mut binds = std::mem::take(&mut self.list_binds);
        let mut bound = false;
        binds.retain(|bind| {
            if !self.components.virtual_lists.contains_key(&bind.list) {
                return true;
            }
            for &(slot, index) in &bind.binds {
                self.bind_virtual_cell(bind.list, slot as usize, index as usize);
            }
            bound = true;
            false
        });
        self.list_binds = binds;
        bound
    }

    fn bind_virtual_cell(&mut self, list: NodeId, slot: usize, index: usize) {
        let state = &self.components.virtual_lists[&list];
        let owner = state.owner;
        let cell = match state.cells.get(slot).copied().filter(|&c| c != 0) {
            Some(cell) => {
                let content = state.contents.get(slot).copied().filter(|&c| c != 0);
                for part in [Some(cell), content].into_iter().flatten() {
                    if let Some(inst) = self.components.instances.get_mut(&part) {
                        match &mut inst.inner {
                            Inner::VirtualRow { index: current, .. }
                            | Inner::Row { index: current, .. } => *current = index,
                            _ => {}
                        }
                        // A view's cell keeps its content: what reads its
                        // position follows.
                        if let Some(row) = inst.cell_position
                            && inst.cell_owner.is_some_and(|o| o.is_live())
                        {
                            row.index.set(index);
                            row.bound.set(true);
                            continue;
                        }
                    }
                    self.components.mark(part);
                }
                cell
            }
            None => {
                let (items, place) = (state.items, state.place.clone());
                let cell = self.components.alloc();
                let _ = self.apply_op(Op::Create {
                    id: cell,
                    tag: Tag::Cell,
                });
                self.components.owners.insert(cell, owner);
                let _ = self.apply_op(Op::SetProp {
                    id: cell,
                    prop: Prop::Slot(crate::CellSlot::Item(slot as u32)),
                });
                let _ = self.apply_op(Op::Insert {
                    parent: list,
                    child: cell,
                    before: None,
                });
                let row = Inner::VirtualRow { list, index };
                let content = if items {
                    // The placing component's wrapper in the cell, around
                    // the row's own node (placed as a row's content is).
                    let content = self.components.alloc();
                    let _ = self.apply_op(Op::Create {
                        id: content,
                        tag: Tag::View,
                    });
                    self.components.owners.insert(content, owner);
                    let _ = self.apply_op(Op::Insert {
                        parent: cell,
                        child: content,
                        before: None,
                    });
                    let instance = Instance::new(row, None, Vec::new(), None);
                    self.components
                        .instances
                        .insert(content, Box::new(instance));
                    self.components.mark(content);
                    let place = place.unwrap_or_else(|| Rc::new(|row, _| row.into_element()));
                    // The wrapper is the placing component's.
                    let wrapper =
                        Instance::new(Inner::Row { place, index }, None, vec![content], None);
                    self.components.instances.insert(cell, Box::new(wrapper));
                    content
                } else {
                    let instance = Instance::new(row, None, Vec::new(), None);
                    self.components.instances.insert(cell, Box::new(instance));
                    0
                };
                let state = self.components.virtual_lists.get_mut(&list).expect("list");
                if state.cells.len() <= slot {
                    state.cells.resize(slot + 1, 0);
                    state.contents.resize(slot + 1, 0);
                }
                state.cells[slot] = cell;
                state.contents[slot] = content;
                self.components.mark(cell);
                cell
            }
        };
        let _ = self.apply_op(Op::SetProp {
            id: cell,
            prop: Prop::CellIndex(index as u32),
        });
    }

    /// A component's own list reported its viewable rows: they are the
    /// owner's to handle now, or once they stayed so for the minimum view
    /// time (a change meanwhile starts the wait again).
    fn viewable_changed(&mut self, list: NodeId, payload: &EventPayload) {
        let executor = self.components.executor.clone();
        let Some(state) = self.components.virtual_lists.get_mut(&list) else {
            return;
        };
        state.latest = virtual_list::viewable_range(payload, "first", "last");
        match state.min_view {
            Some(delay) => {
                state.report = Some(crate::element::task::act_after(
                    &executor,
                    state.owner,
                    delay,
                    Action::ReportViewable(list),
                ));
            }
            None => self.report_viewable(list),
        }
    }

    /// Hands list `list`'s owner the rows viewable now, unless they are the
    /// ones reported last.
    fn report_viewable(&mut self, list: NodeId) {
        let Some(state) = self.components.virtual_lists.get_mut(&list) else {
            return;
        };
        state.report = None;
        if state.latest == state.reported {
            return;
        }
        let payload = virtual_list::viewable_payload(state.latest, state.reported);
        state.reported = state.latest;
        let owner = state.owner;
        self.handle(owner, list, EventKind::ViewableItemsChange, &payload);
    }

    fn release_id(&mut self, id: NodeId) {
        self.components.release_generation = self.components.release_generation.wrapping_add(1);
        if let Some(host) = self.components.owners.remove(&id) {
            // Cells can replace/empty their static root outside a region's
            // matching pass. Their released bindings need the same sweep
            // even if the next region only populates new nodes.
            self.components.released_hosts.insert(host);
        }
        self.forget_node_extras(id);
        // A root component's host is its view's: only the name goes.
        if self.is_alias(id) {
            self.unalias(id);
            return;
        }
        // A fill's node in a holder: the slot's props follow what is left.
        let holder = if self.components.fill_holders.is_empty() {
            None
        } else {
            self.key(id)
                .ok()
                .map(|k| self.nodes[k as usize].parent)
                .filter(|&p| p != NO_KEY)
                .map(|p| self.nodes[p as usize].id)
                .filter(|p| self.components.fill_holders.contains(p))
        };
        let _ = self.apply_op(Op::Release { id });
        if let Some(holder) = holder {
            self.retarget_slot(holder, None);
        }
    }

    /// Frees an expanded element and what it rendered (a slot's node is
    /// JS's: it only leaves the tree).
    pub(super) fn release_expanded(&mut self, e: Expanded) {
        // Slot/JS nodes can lose this view's part without being deleted or
        // leaving `owners`, so count expanded releases as well as raw IDs.
        self.components.release_generation = self.components.release_generation.wrapping_add(1);
        match e.part {
            Part::Slot => {
                self.drop_slot_target(e.id);
                self.detach_id(e.id);
                return;
            }
            // The JS children are placed (or detached) by the view, and
            // what fills a slot by the view that fills it.
            Part::Children | Part::Filled(_) => return,
            // Its nodes are its children's.
            Part::Fill(_) => {
                for c in e.children {
                    self.release_expanded(c);
                }
                return;
            }
            // A JS child leaves the wrapper being released.
            Part::JsChild => {
                self.detach_id(e.id);
                return;
            }
            Part::Raw => {
                self.release_id(e.id);
                return;
            }
            // Its content is this view's, released below: deleting it
            // detaches it.
            Part::Component(_) => {
                let content: Vec<NodeId> = e.children.iter().flat_map(|c| self.placed(c)).collect();
                self.release_component(e.id, &content);
            }
            // Its nodes are the region's.
            Part::Region(region) => {
                self.release_region(region);
                return;
            }
            Part::VirtualList => self.release_virtual_list(e.id),
            // A fill's holder: its element gets its own props back.
            Part::Node => {
                if !self.components.fill_holders.is_empty()
                    && self.components.fill_holders.remove(&e.id)
                {
                    self.drop_slot_target(e.id);
                }
            }
        }
        if let Some(r) = e.attrs.rare.as_ref().and_then(|r| r.element_ref.as_ref()) {
            r.detach(e.id);
        }
        for c in e.children {
            self.release_expanded(c);
        }
        if let Some((_, raw)) = e.text {
            self.release_id(raw);
        }
        self.release_id(e.id);
    }

    /// Frees what a component made (not its host nor its JS children,
    /// which leave its view).
    pub(super) fn release_instance(&mut self, host: NodeId) {
        self.release_component(host, &[]);
    }

    /// [`Self::release_instance`], but of its JS children and slots, those
    /// in `content` are released right after (a view's content of a nested
    /// component: deleting them detaches them); the others leave its view
    /// natively (they stay: JS's, or passed on by the view).
    fn release_component(&mut self, host: NodeId, content: &[NodeId]) {
        let Some(mut inst) = self.components.instances.remove(&host) else {
            return;
        };
        // The app's element in a slot: the holder takes the slot's props.
        self.target_released(host);
        if self
            .components
            .parked_methods
            .iter()
            .any(|(h, ..)| *h == host)
        {
            let (gone, kept) = std::mem::take(&mut self.components.parked_methods)
                .into_iter()
                .partition(|(h, ..)| *h == host);
            self.components.parked_methods = kept;
            for (_, call, method) in gone {
                drop_caught(method);
                self.settle(
                    call,
                    Err(format!("node {host} hosts no Rust component").into()),
                );
            }
        }
        // Its root's (a render or classes of the app's) on the host.
        self.forget_node_extras(host);
        if let Inner::Component(inner) = &mut inst.inner {
            if let Err(message) = caught(|| inner.cleanup()) {
                log::error!(target: "js", "{} failed in its cleanup: {message}", inner.name());
            }
            self.apply_actions();
        }
        self.release_regions(host);
        self.components.runtime.forget_host(host);
        if let Some(owner) = inst.cell_owner.take() {
            owner.dispose();
        }
        for &child in &inst.js_children {
            if !content.contains(&child) {
                self.detach_id(child);
            }
        }
        for (_, node) in inst.slots {
            self.drop_slot_target(node);
            self.components.slot_hosts.remove(&node);
            if !content.contains(&node) {
                self.detach_id(node);
            }
        }
        if let Some(root) = inst.root {
            // The component its root is, with its alias.
            if matches!(root.part, Part::Component(_)) {
                self.release_expanded(root);
                return;
            }
            let node = self.native_id(host);
            if let Some(r) = root
                .attrs
                .rare
                .as_ref()
                .and_then(|r| r.element_ref.as_ref())
            {
                r.detach(node);
            }
            if root.part == Part::VirtualList {
                self.release_virtual_list(node);
            }
            if let Some((_, raw)) = root.text {
                self.release_id(raw);
            }
            for c in root.children {
                self.release_expanded(c);
            }
        }
    }

    /// Releases the component's own list `id`: its cells, and what knew of
    /// it.
    fn release_virtual_list(&mut self, id: NodeId) {
        if let Some(state) = self.components.virtual_lists.remove(&id) {
            let parts = state.contents.into_iter().chain(state.cells);
            for part in parts.filter(|&c| c != 0) {
                self.release_instance(part);
                self.release_id(part);
            }
        }
        // The rows of another component's `Items` prop: no longer its slot.
        if self.components.slot_names.remove(&id).is_some() {
            self.unslot(id);
        }
        self.components.lists.remove(&id);
        self.forget_list_count(id);
    }

    /// A native event on node `id`: true when a component handled it (its
    /// own parts' events never reach JS, which does not know them).
    pub fn component_event(&mut self, id: NodeId, kind: EventKind, payload: &EventPayload) -> bool {
        let _entered = self.components.runtime.enter();
        // A Rust text block's final layout, for its `on_text_layout`.
        let _geometry = (kind == EventKind::TextLayout)
            .then(|| self.geometries.remove(&id))
            .flatten()
            .map(crate::text::GeometryScope::enter);
        let handled = self.dispatch_event(id, kind, payload);
        self.flush_component_emits();
        handled
    }

    /// Whether node `id` has a listener for `event` (a JS handler or a Rust
    /// component's), as the platform sees it mounted. The engine skips
    /// nodes without one when it fans a key notification out.
    #[doc(hidden)]
    pub fn listens(&self, id: NodeId, event: EventKind) -> bool {
        self.key(id)
            .is_ok_and(|key| self.nodes[key as usize].mounted_events().contains(event))
    }

    /// Whether `id` or an enabled logical ancestor up to its window root
    /// hears a key transition (`KeyDown` or `KeyUp`) or has a capture rule
    /// that is not `None`. Follows the logical tree (`node.parent`), so an
    /// overlay's content finds the views it is logically in even where a
    /// backend mounts it elsewhere. No allocation: a walk per transition.
    #[doc(hidden)]
    pub fn key_interest(&self, id: NodeId) -> bool {
        let Ok(mut key) = self.key(id).map(|key| self.key_start(key)) else {
            return false;
        };
        let window = self.key_window(key);
        loop {
            let node = &self.nodes[key as usize];
            let disabled = node
                .props
                .as_ref()
                .is_some_and(|p| p.accessibility.state.disabled);
            if !disabled {
                let events = node.mounted_events();
                if events.contains(EventKind::KeyDown) || events.contains(EventKind::KeyUp) {
                    return true;
                }
                if node
                    .props
                    .as_ref()
                    .is_some_and(|p| !p.key_capture.is_none())
                {
                    return true;
                }
            }
            if node.id == window || node.parent == NO_KEY {
                return false;
            }
            key = node.parent;
        }
    }

    /// The views a key notification on `id` reaches, in order: `id`, then
    /// each enabled ancestor, up to and including the root of `id`'s window.
    /// The engine notifies every one of them (Rust and JS listeners alike)
    /// from one platform event; a native window is a keyboard boundary even
    /// when its declarative root remains in another window's logical tree.
    /// A disabled view hears nothing, and its enabled ancestors still do.
    #[doc(hidden)]
    pub fn key_path(&self, id: NodeId, out: &mut Vec<NodeId>) {
        out.clear();
        let Ok(mut key) = self.key(id).map(|key| self.key_start(key)) else {
            return;
        };
        let window = self.key_window(key);
        loop {
            let node = &self.nodes[key as usize];
            let disabled = node
                .props
                .as_ref()
                .is_some_and(|p| p.accessibility.state.disabled);
            if !disabled {
                out.push(node.id);
            }
            if node.id == window || node.parent == NO_KEY {
                return;
            }
            key = node.parent;
        }
    }

    /// Whether `id` or an enabled ancestor within its window captures the
    /// transition whose canonical shortcut stroke is `keystroke` under its
    /// mounted [`crate::KeyCapture`] rule (`captureKeys`). The platform
    /// decides before native defaults from the stroke its own shortcut
    /// vocabulary names, never from [`crate::KeyEvent`]'s `key` or `code`;
    /// `None` (a key no shortcut names) is captured only by
    /// [`crate::KeyCapture::All`]. A focused native text input keeps the
    /// keys that edit it: nothing captures them.
    #[doc(hidden)]
    pub fn key_captured(&self, id: NodeId, keystroke: Option<&crate::keymap::Keystroke>) -> bool {
        let Ok(mut key) = self.key(id).map(|key| self.key_start(key)) else {
            return false;
        };
        // A native text input owns the keys that edit it: an ancestor's
        // capture never intercepts its typing, caret or editing commands.
        if self.nodes[key as usize].kind == Kind::Input {
            return false;
        }
        let window = self.key_window(key);
        loop {
            let node = &self.nodes[key as usize];
            let disabled = node
                .props
                .as_ref()
                .is_some_and(|p| p.accessibility.state.disabled);
            if !disabled
                && node
                    .props
                    .as_ref()
                    .is_some_and(|p| p.key_capture.captures_key(keystroke))
            {
                return true;
            }
            if node.id == window || node.parent == NO_KEY {
                return false;
            }
            key = node.parent;
        }
    }

    /// Where a key transition reported at `key` starts. A backend with
    /// nothing focused in a window reports at the window's root (`ROOT_ID`,
    /// or a dialog window's root): the app's views are not its ancestors,
    /// so the transition starts at the view mounted there (the app's mount
    /// root, or the dialog's content) and bubbles from it, as a browser
    /// reports it at `document.body` (#2362). Any other node starts at
    /// itself.
    pub(super) fn key_start(&self, key: Key) -> Key {
        let node = &self.nodes[key as usize];
        if node.id != crate::ROOT_ID
            && (node.kind != Kind::Modal || self.key_window(key) != node.id)
        {
            return key;
        }
        node.children
            .iter()
            .copied()
            .find(|&child| !matches!(self.nodes[child as usize].kind, Kind::Overlay | Kind::Modal))
            .unwrap_or(key)
    }

    /// A window's staged keyboard target follows its logical children.
    pub(super) fn key_content_changed(&mut self, parent: Key) {
        let node = &self.nodes[parent as usize];
        if node.id == crate::ROOT_ID
            || (node.kind == Kind::Modal && self.key_window(parent) == node.id)
        {
            self.key_ancestry_dirty = true;
        }
    }

    /// The root of the window `key` is in, `key` itself when it is one.
    pub(super) fn key_window(&self, key: Key) -> NodeId {
        let node = &self.nodes[key as usize];
        if node.kind == Kind::Modal && self.window_ids.values().any(|(root, _)| *root == node.id) {
            node.id
        } else {
            self.window_of(key)
        }
    }

    fn flush_component_emits(&mut self) {
        // What views' listeners emitted reaches its listeners (JS hears it
        // in this turn).
        loop {
            let emits = self.components.runtime.take_emits();
            if emits.is_empty() {
                break;
            }
            for (host, event) in emits {
                self.route_emit(host, event);
            }
        }
    }

    /// Initializes one newly installed layout listener of a kept node.
    /// The engine delivers this in event order, without notifying the
    /// node's retained listeners or its JS handlers.
    #[doc(hidden)]
    pub fn component_layout(
        &mut self,
        host: NodeId,
        id: NodeId,
        listener: &Listener<EventPayload>,
        frame: crate::Bounds<Points>,
    ) {
        let _entered = self.components.runtime.enter();
        let installed = self.components.instances.get(&host).is_some_and(|inst| {
            inst.handlers
                .of(id)
                .iter()
                .any(|(kind, current)| *kind == EventKind::Layout && current.ptr_eq(listener))
        });
        if installed {
            self.run_listener(host, listener, &EventPayload::Layout(frame));
            self.flush_component_emits();
        }
    }

    fn dispatch_event(&mut self, id: NodeId, kind: EventKind, payload: &EventPayload) -> bool {
        // Before a cancelled press's release is dropped: it still ends the
        // span's press.
        self.span_state(id, kind);
        // A cancelled press's release reaches no one, JS included.
        if self.drop_cancelled_press(id, kind, payload) {
            return true;
        }
        // Touches come on the root with the listening nodes around each
        // finger: the components hear theirs, JS its own.
        if kind == EventKind::Touch && id == ROOT_ID {
            if let EventPayload::Touch(touch) = payload {
                self.overlay_touches(touch);
                self.touches(payload, touch);
            }
            return false;
        }
        // Hints follow the pointer on their anchors, whoever else listens.
        if matches!(kind, EventKind::MouseEnter | EventKind::MouseLeave) {
            let at = match payload {
                EventPayload::Mouse(mouse) => Some(mouse.page_position),
                _ => None,
            };
            self.overlay_hover(id, kind, at);
        }
        // A download event's listener gets a handle bound to the native
        // web view node the platform reported, not the component host its
        // handlers were registered on: only this dispatch can make one.
        let _target = matches!(kind, EventKind::DownloadPending | EventKind::Download)
            .then(|| crate::element::download_target(id, Rc::downgrade(&self.components.executor)));
        if self.platform_event(id, kind, payload) {
            return true;
        }
        if self.is_host(id) {
            // The component whose view makes the host's node handles them,
            // after the one whose slot's props it takes.
            let base = self.base_of(id);
            if let Some(slot) = self.adopted_host(base) {
                self.handle(slot, base, kind, payload);
            }
            let own = self.handle(base, base, kind, payload);
            // A context menu has one listener: a component showing its own
            // keeps it.
            if own && kind == EventKind::ContextMenu {
                return true;
            }
            let given = self.handle_given(base, kind, payload);
            // JS listening on the host hears it too.
            return (own || given) && !self.js_listens(base, kind);
        }
        // A component's own list reports its viewable rows as they settle.
        if kind == EventKind::ViewableItemsChange && self.components.virtual_lists.contains_key(&id)
        {
            self.viewable_changed(id, payload);
            return true;
        }
        // A slot's node: the component it is a slot of handles its events,
        // then whoever made it: the component whose view has it, or JS (the
        // app's list of an `Items` prop has the app's handlers). So does the
        // app's element that takes the slot's props, then JS.
        let slot_of = self
            .components
            .slot_hosts
            .get(&id)
            .copied()
            .or_else(|| self.adopted_host(id));
        let owner = self.components.owners.get(&id).copied();
        if let Some(host) = slot_of {
            self.handle(host, id, kind, payload);
        }
        if let Some(host) = owner
            && Some(host) != slot_of
        {
            self.handle(host, id, kind, payload);
        }
        // The core's nodes (odd ids) are the components': JS does not know
        // them.
        (slot_of.is_some() || owner.is_some()) && id % 2 == 1
    }

    /// The host of the component whose view has node `id` (for a host, the
    /// component whose view makes its node: itself, or its root
    /// component's).
    pub(super) fn host_of(&self, id: NodeId) -> Option<NodeId> {
        if self.is_host(id) {
            Some(self.base_of(id))
        } else {
            self.components.owners.get(&id).copied()
        }
    }

    /// Runs `host`'s component's handlers of `kind` on its node `id`, in
    /// the order the element was given them; false when it has none.
    fn handle(
        &mut self,
        host: NodeId,
        id: NodeId,
        kind: EventKind,
        payload: &EventPayload,
    ) -> bool {
        let id = self.base_of(id);
        let mut handled = false;
        let mut from = 0;
        while let Some((at, listener)) = self.next_handler(host, id, kind, from) {
            from = at + 1;
            // A listener may release the component: the rest go with it.
            if !self.run_listener(host, &listener, payload) {
                break;
            }
            handled = true;
        }
        handled
    }

    /// The first of `host`'s component's handlers of `kind` on its node `id`
    /// at or after index `from`, with its index: a dispatch walks them in
    /// order (an element given several listeners of one event calls them
    /// all) with no list of its own. The handlers stay as they are while it
    /// does: a view's regions change them when they are reconciled, in the
    /// commit, not as listeners run.
    pub(super) fn next_handler(
        &self,
        host: NodeId,
        id: NodeId,
        kind: EventKind,
        from: usize,
    ) -> Option<(usize, Listener<EventPayload>)> {
        let id = self.base_of(id);
        let inst = self.components.instances.get(&host)?;
        let handlers = inst.handlers.of(id);
        #[cfg(test)]
        self.components
            .handler_visits
            .set(self.components.handler_visits.get() + handlers.len().saturating_sub(from));
        handlers
            .iter()
            .enumerate()
            .skip(from)
            .find(|(_, (k, _))| *k == kind)
            .map(|(at, (_, l))| (at, l.clone()))
    }

    /// The part of `host`'s node `id` in the touch responder.
    pub(super) fn responder_el(&self, host: NodeId, id: NodeId) -> Option<Rc<ResponderEl>> {
        let id = self.base_of(id);
        self.components
            .instances
            .get(&host)?
            .responders
            .iter()
            .find(|(n, _)| *n == id)
            .map(|(_, r)| r.clone())
    }

    /// Runs `listener` of a node of `host`'s view (or of a list row of it);
    /// false when that component is gone.
    pub(super) fn run_listener<E: ?Sized + 'static>(
        &mut self,
        host: NodeId,
        listener: &Listener<E>,
        event: &E,
    ) -> bool {
        let Some(owner) = self.state_owner(host) else {
            return false;
        };
        if let Err(message) = caught(|| listener.call(event)) {
            self.component_failed(owner, message);
        }
        self.apply_actions();
        true
    }

    /// The component whose state `host`'s handlers change: its own, or for
    /// a list row the component's whose list it is.
    pub(super) fn state_owner(&self, host: NodeId) -> Option<NodeId> {
        match &self.components.instances.get(&host)?.inner {
            Inner::Component(_) => Some(host),
            Inner::VirtualRow { list, .. } => {
                self.components.virtual_lists.get(list).map(|s| s.owner)
            }
            Inner::Row { .. } => self
                .list_of(host)
                .and_then(|l| self.components.slot_hosts.get(&l))
                .copied(),
            Inner::Missing => None,
        }
    }

    /// The code of `host`'s component panicked: the nearest error boundary
    /// above it shows it ([`crate::element::catch_error`]); else it is reported.
    pub(super) fn component_failed(&mut self, host: NodeId, message: String) {
        let component = match self.components.instances.get(&host).map(|i| &i.inner) {
            Some(Inner::Component(inner)) => inner.name(),
            _ => "a list row",
        };
        let error = ComponentError { component, message };
        // The nearest error boundary of a view above it.
        let owner = self
            .components
            .instances
            .get(&host)
            .and_then(|inst| match &inst.inner {
                Inner::Component(inner) => Some(inner.failure_owner()),
                _ => inst.cell_owner,
            });
        let _entered = self.components.runtime.enter();
        match owner.and_then(crate::element::reactive::boundary_of) {
            Some(boundary) => boundary.set(Some(error)),
            None => log::error!(target: "js", "{error}"),
        }
    }

    /// The list cell `cell` is in.
    fn list_of(&self, cell: NodeId) -> Option<NodeId> {
        let key = self.key(cell).ok()?;
        let parent = self.nodes[key as usize].parent;
        (parent != NO_KEY).then(|| self.nodes[parent as usize].id)
    }

    /// Reads (`enabled` `None`) or changes whether the app launches at
    /// login: on the backend's thread when the runner gave the core one,
    /// the answer (on or not) delivered in a task here; without one the app
    /// does not launch at login, and a change fails.
    fn login_item_action(
        &mut self,
        enabled: Option<bool>,
        answer: crate::element::AnswerSlot<Result<bool, crate::desktop::LaunchAtLoginError>>,
    ) {
        use crate::desktop::{LaunchAtLoginError, LoginItemStatus};
        // Launching at login acts on the application as a whole: an app
        // declaring capabilities needs `application` to change it, and is
        // told it does not launch at login otherwise.
        if !self.access.allows_application() {
            answer.borrow_mut().deliver(match enabled {
                None => Ok(false),
                Some(_) => Err(LaunchAtLoginError::Denied),
            });
            return;
        }
        let Some(items) = self.login_item.as_mut() else {
            answer.borrow_mut().deliver(match enabled {
                None => Ok(false),
                Some(_) => Err(LaunchAtLoginError::Unavailable),
            });
            return;
        };
        let result = items.call(enabled);
        crate::element::task::spawn_raw(
            &self.components.executor,
            crate::ROOT_ID,
            Box::pin(async move {
                let result = match result.await {
                    // Nothing to change where the platform has no login
                    // item for the app (a sandboxed Linux app).
                    Ok(LoginItemStatus::Unavailable) if enabled.is_some() => {
                        Err(LaunchAtLoginError::Unavailable)
                    }
                    Ok(status) => Ok(status == LoginItemStatus::Enabled),
                    Err(error) => Err(LaunchAtLoginError::System(error)),
                };
                answer.borrow_mut().deliver(result);
            }),
        );
    }

    /// Applies what the app asks about notifications: granted and where
    /// the platform shows them, the platform answers with
    /// [`EventKind::Notification`]; otherwise the answer is given here.
    fn notification_action(&mut self, action: crate::element::NotificationAction) {
        use crate::{
            element::NotificationAction,
            notifications::{NotificationCommand, NotificationPermission},
        };
        let allowed = self.access.allows_notifications();
        let available = allowed && self.components.environment.notifications;
        let command = match action {
            NotificationAction::Permission { ask, answer } => {
                if !available {
                    answer
                        .borrow_mut()
                        .deliver(NotificationPermission::Unavailable);
                    return;
                }
                let state = &mut self.components.notifications;
                let id = state.next;
                state.next = id.wrapping_add(1);
                state.permissions.insert(id, answer);
                NotificationCommand::Permission { id, ask }
            }
            NotificationAction::Show {
                notification,
                answer,
            } => {
                if !available {
                    answer.borrow_mut().deliver(false);
                    return;
                }
                let state = &mut self.components.notifications;
                let id = state.next;
                state.next = id.wrapping_add(1);
                state.shows.insert(id, answer);
                NotificationCommand::Show { id, notification }
            }
            NotificationAction::Close(id) => {
                if !available {
                    return;
                }
                NotificationCommand::Close(id)
            }
            NotificationAction::CloseAll => {
                if !available {
                    return;
                }
                NotificationCommand::CloseAll
            }
            NotificationAction::SetBadge(count) => {
                if !allowed {
                    return;
                }
                NotificationCommand::SetBadge(count)
            }
            NotificationAction::NextPress(answer) => {
                let state = &mut self.components.notifications;
                if let Some(pressed) = state.presses.pop_front() {
                    answer.borrow_mut().deliver(pressed);
                    return;
                }
                state.next_press = Some(answer);
                if !available || state.listening {
                    return;
                }
                state.listening = true;
                NotificationCommand::Listen
            }
        };
        let _ = self.apply_op(Op::Command {
            id: crate::ROOT_ID,
            command: Command::Notification(command),
        });
    }

    /// The app's address, which the engine shares with every VM's
    /// `System` (`UrlScheme.url()` reads it there).
    #[doc(hidden)]
    pub fn app_url_cell(&self) -> crate::url_scheme::AppUrlCell {
        self.components.url_schemes.address.clone()
    }

    /// Hands `url`, a link the system gave the app, to the listener, or
    /// keeps it for the next; drops it when the app does not claim it.
    /// `page`: the address of the page the app is (the web), which needs
    /// no scheme of the app's; `quiet` only takes it as the address;
    /// `change`, an address the app moved to without making the move,
    /// goes to the change listener instead of `open`.
    fn url_scheme(
        &mut self,
        url: String,
        page: bool,
        quiet: bool,
        change: Option<crate::url_scheme::AppUrlChangeReason>,
    ) {
        let links = &mut self.components.url_schemes;
        // A file the system opened the app with (nsh.json `fileTypes`): the
        // platforms report it as a `file://` URL, the core hands it to the
        // app as a file ([`crate::file_type`]), never as a link.
        if !page && change.is_none() && crate::file_type::is_file_url(&url) {
            if !links
                .links
                .schemes()
                .iter()
                .any(|s| s == crate::file_type::FILE_SCHEME)
            {
                log::warn!("file dropped: the app declares no file types (nsh.json `fileTypes`)");
                return;
            }
            let Some(path) = crate::file_type::file_path(&url) else {
                log::warn!("file dropped: {url} is not a local file");
                return;
            };
            let files = &mut self.components.open_files;
            if let Some(answer) = files.next.take() {
                answer.borrow_mut().deliver(vec![path]);
                return;
            }
            if files.pending.len() == crate::file_type::MAX_PENDING {
                log::warn!(
                    "file dropped: {} came while nothing listened",
                    crate::file_type::MAX_PENDING
                );
                files.pending.pop_front();
            }
            files.pending.push_back(path);
            return;
        }
        let checked = if page {
            crate::url_scheme::check_page_url(&url)
        } else {
            links.links.check(&url)
        };
        if let Err(dropped) = checked {
            log::warn!("link dropped: {dropped}");
            return;
        }
        // The callback of the waiting sign-in session ends it: it is the
        // session's answer, never a link the app navigates by (nor its
        // address, which would keep the credentials it carries).
        if !page
            && change.is_none()
            && self
                .components
                .auth_session
                .as_ref()
                .is_some_and(|s| crate::auth_session::is_callback(&url, &s.scheme))
        {
            self.end_auth_session(
                None,
                Ok(crate::auth_session::AuthSessionOutcome::Completed(url)),
            );
            return;
        }
        self.components.url_schemes.address.set(url.clone());
        if quiet {
            return;
        }
        let links = &mut self.components.url_schemes;
        if let Some(reason) = change {
            if !links.hears_changes {
                return;
            }
            let change = crate::url_scheme::AppUrlChange { url, reason };
            if let Some(answer) = links.next_change.take() {
                answer.borrow_mut().deliver(change);
                return;
            }
            if links.changes.len() == crate::url_scheme::MAX_PENDING {
                links.changes.pop_front();
            }
            links.changes.push_back(change);
            return;
        }
        if let Some(answer) = links.next.take() {
            answer.borrow_mut().deliver(url);
            return;
        }
        if links.pending.len() == crate::url_scheme::MAX_PENDING {
            log::warn!(
                "link dropped: {} came while nothing listened",
                crate::url_scheme::MAX_PENDING
            );
            links.pending.pop_front();
        }
        links.pending.push_back(url);
    }

    /// The schemes the app claims (`nsh.json` `schemes`,
    /// [`crate::url_scheme`]), from the app's own resources: the links the
    /// platform reports of other schemes are dropped. None by default.
    /// [`Core::set_app_links`] sets them with the app's web links.
    pub fn set_url_schemes(&mut self, schemes: impl IntoIterator<Item = impl Into<String>>) {
        self.components.url_schemes.links.set_schemes(schemes);
    }

    /// The links the app claims (`nsh.json` `schemes` and `links`,
    /// [`crate::url_scheme::AppLinks`]), from the app's own resources: the
    /// links the platform reports that are none of them (another scheme, an
    /// `https` link of another host or path) are dropped. None by default.
    pub fn set_app_links(&mut self, links: crate::url_scheme::AppLinks) {
        self.components.url_schemes.links = links;
    }

    /// Answers what waits for the platform's [`EventKind::Notification`].
    fn notification_event(&mut self, payload: &EventPayload) {
        use crate::notifications::{NotificationEvent as Field, NotificationPermission};
        let EventPayload::Map(entries) = payload else {
            return;
        };
        let state = &mut self.components.notifications;
        let id = entries.iter().find_map(|(k, v)| match v {
            crate::PayloadValue::Number(n) if *k == Field::ID => Some(*n as u32),
            _ => None,
        });
        for (key, value) in entries {
            match (*key, value) {
                (Field::PERMISSION, crate::PayloadValue::Str(name)) => {
                    if let Some(answer) = id.and_then(|id| state.permissions.remove(&id)) {
                        let permission = NotificationPermission::from_name(name)
                            .unwrap_or(NotificationPermission::Unavailable);
                        answer.borrow_mut().deliver(permission);
                    }
                }
                (Field::SHOWN, crate::PayloadValue::Bool(shown)) => {
                    if let Some(answer) = id.and_then(|id| state.shows.remove(&id)) {
                        answer.borrow_mut().deliver(*shown);
                    }
                }
                (Field::PRESSED, crate::PayloadValue::Str(pressed)) => {
                    match state.next_press.take() {
                        Some(answer) => answer.borrow_mut().deliver(pressed.clone()),
                        None => state.presses.push_back(pressed.clone()),
                    }
                }
                _ => {}
            }
        }
    }

    /// Applies a sound's or a player's request: through the embedding
    /// app's audio stack when it gave one, else as commands on the root the
    /// platform answers with [`EventKind::Audio`].
    fn audio_action(&mut self, action: crate::element::AudioAction) {
        use crate::{
            audio::{AudioCommand, AudioError, AudioEvent},
            element::AudioAction,
        };
        let (command, sink) = match action {
            AudioAction::Available(answer) => {
                let available = match &self.audio {
                    Some(backend) => backend.available(),
                    None => self.components.environment.audio,
                };
                answer.borrow_mut().deliver(available);
                return;
            }
            AudioAction::Open { mut command, sink } => {
                debug_assert!(matches!(
                    command,
                    AudioCommand::Load { .. }
                        | AudioCommand::LoadUrl { .. }
                        | AudioCommand::Open { .. }
                ));
                let failed = |error, message: &str| AudioEvent::Failed {
                    error,
                    message: message.into(),
                };
                if !self.access.allows_audio() {
                    sink.send(failed(AudioError::NotAllowed, "sound is not granted"));
                    sink.close();
                    self.deny(
                        "sound is not granted: add `\"audio\": true` to capabilities in nsh.json"
                            .into(),
                    );
                    return;
                }
                // A sound loads what the check granted (`Access::media_url`).
                if let AudioCommand::Open { src, .. } | AudioCommand::LoadUrl { url: src, .. } =
                    &mut command
                {
                    match self.media_source(src) {
                        Some(granted) => {
                            if let Some(url) = granted {
                                *src = url.to_string();
                            }
                        }
                        None => {
                            let base = self.base_url.as_deref();
                            let capability = crate::access::media_capability(src, base);
                            let advice = crate::access::media_grant_advice(src, base);
                            // Worded without the app's text: the player's
                            // error names the capability from it.
                            sink.send(failed(
                                AudioError::NotAllowed,
                                &format!("{}{capability}", super::SOURCE_NOT_GRANTED),
                            ));
                            sink.close();
                            self.deny(format!(
                                "`{src}` is not granted by capabilities.{capability}: {advice}"
                            ));
                            return;
                        }
                    }
                }
                if self.audio.is_none() && !self.components.environment.audio {
                    sink.send(failed(AudioError::Unavailable, "nothing plays sound here"));
                    sink.close();
                    return;
                }
                self.components.audio.insert(command.id(), sink.clone());
                (command, sink)
            }
            AudioAction::Command(command) => {
                let id = command.id();
                let sink = if command.ends() {
                    self.components.audio.remove(&id)
                } else {
                    self.components.audio.get(&id).cloned()
                };
                // A command of an object that failed to open, or closed.
                let Some(sink) = sink else {
                    return;
                };
                if command.ends() {
                    sink.close();
                }
                (command, sink)
            }
        };
        match self.audio.clone() {
            Some(backend) => backend.command(command, &sink),
            None => {
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::Audio(command),
                });
            }
        }
    }

    fn apply_action(&mut self, action: Action) {
        match action {
            Action::Command(id, command) => {
                let _ = self.apply_op(Op::Command { id, command });
            }
            // Answered as the command leaves for the platform
            // (`Core::take_commands`) or when the platform reports it.
            Action::WriteClipboard(command, answer) => {
                self.components.clipboard_writes.push_back(answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command,
                });
            }
            Action::FocusBack { to, from } => self.focus_back = Some((to, from)),
            Action::FocusOrigin { to } => self.note_focus_origin(to),
            Action::Dialog(mut dialog, answer) => {
                dialog.id = self.components.next_dialog;
                self.components.next_dialog += 1;
                self.components.dialogs.insert(dialog.id, answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::Dialog(Box::new(dialog)),
                });
            }
            Action::CloseDialog(answer) => {
                // Answered already (or never shown): nothing to close.
                let Some(id) = self
                    .components
                    .dialogs
                    .iter()
                    .find_map(|(id, slot)| Rc::ptr_eq(slot, &answer).then_some(*id))
                else {
                    return;
                };
                self.components.dialogs.remove(&id);
                answer
                    .borrow_mut()
                    .deliver(crate::element::DialogReply::dismissed());
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::CloseDialog(id),
                });
            }
            Action::Return(call, result) => self.settle(call, result),
            Action::Animation(op) => {
                let _ = self.apply_op(Op::Animation(op));
            }
            Action::Animate { op, animation, end } => {
                self.components
                    .animations
                    .insert(animation, Awaited::End(end));
                let _ = self.apply_op(Op::Animation(op));
            }
            Action::ReadValue { node, value } => {
                let request = self.components.executor.next_animation_id();
                self.components
                    .animations
                    .insert(request, Awaited::Value(value));
                let _ = self.apply_op(Op::Animation(crate::animation::AnimationOp::Read {
                    node,
                    request,
                }));
            }
            Action::ReportViewable(list) => self.report_viewable(list),
            Action::Hint(overlay) => self.hint_due(overlay),
            Action::Frame(answer) => self.wait_frame(answer),
            Action::Appearance(appearance) => self.set_appearance(appearance),
            Action::Tokens(tokens) => self.set_tokens(tokens),
            Action::Translations(translations) => self.set_translations(translations),
            Action::AddTranslations(map) => self.add_translations(map),
            Action::TranslationsChanged(before) => self.translations_changed(&before),
            Action::Locale(locale) => self.components.locale_request = Some(locale),
            Action::MainThread(task) => self.components.main_thread.push(task),
            Action::BuiltInScrollbars(source, theme) => {
                self.set_builtin_scrollbars(theme.map(|theme| (source, theme)))
            }
            Action::Measure(id, answer) => self.components.measures.push((id, answer)),
            Action::MeasureScrollPosition(id, answer) => {
                self.components.scroll_positions.push((id, answer))
            }
            Action::Evaluate(node, script, timeout, answer) => {
                self.start_web_evaluation(node, script, timeout, answer)
            }
            Action::WebEvaluationTimeout(request) => self.timeout_web_evaluation(request),
            Action::CanvasRenderTimeout(id) => self.timeout_canvas_render(id),
            Action::TransitionTime(id, answer) => {
                self.components.transition_times.push((id, answer))
            }
            Action::TextContent(id, answer) => self.components.text_contents.push((id, answer)),
            Action::PressAt(id, press, answer) => self.components.presses.push((id, press, answer)),
            Action::HoverAt(id, mouse) => self.components.hovers.push((id, mouse)),
            Action::ImageInfo(uri, answer) => {
                let id = self.components.next_image_info;
                self.components.next_image_info += 1;
                self.components.image_infos.insert(id, answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::ImageInfo { id, uri },
                });
            }
            Action::Fetch(request, answer) => {
                let id = self.components.next_fetch;
                self.components.next_fetch += 1;
                self.components.fetches.insert(
                    id,
                    PendingFetch {
                        response: crate::element::HttpResponse::default(),
                        answer,
                    },
                );
                self.components.fetch_requests.push((id, *request));
            }
            Action::RegisterFont(data, answer) => {
                // The family is the answer: a font without one is refused.
                let family = crate::text::font_family(&data)
                    .and_then(|family| self.register_font(&data).map(|()| family));
                answer.borrow_mut().deliver(family);
            }
            Action::PickImages(request, answer) => {
                if !self.access.allows_picker() {
                    answer.borrow_mut().deliver(Vec::new());
                    self.deny(
                        "the picker is not granted: add `\"picker\": true` to capabilities in nsh.json"
                            .into(),
                    );
                    return;
                }
                if let Some(picker) = self.picker.clone() {
                    let picked = picker.pick_images(request);
                    crate::element::task::spawn_raw(
                        &self.components.executor,
                        crate::ROOT_ID,
                        Box::pin(async move {
                            let files = crate::picker::finish(&request, picked.await);
                            answer.borrow_mut().deliver(files);
                        }),
                    );
                    return;
                }
                let id = self.components.next_pick;
                self.components.next_pick += 1;
                self.components
                    .picks
                    .insert(id, (crate::picker::Pick::Images(request), answer));
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::PickImages { id, request },
                });
            }
            Action::PickFiles(request, answer) => {
                if !self.access.allows_picker() {
                    answer.borrow_mut().deliver(Vec::new());
                    self.deny(
                        "the picker is not granted: add `\"picker\": true` to capabilities in nsh.json"
                            .into(),
                    );
                    return;
                }
                if let Some(picker) = self.picker.clone() {
                    let picked = picker.pick_files(request.clone());
                    crate::element::task::spawn_raw(
                        &self.components.executor,
                        crate::ROOT_ID,
                        Box::pin(async move {
                            let files = crate::picker::finish_files(&request, picked.await);
                            answer.borrow_mut().deliver(files);
                        }),
                    );
                    return;
                }
                let id = self.components.next_pick;
                self.components.next_pick += 1;
                self.components
                    .picks
                    .insert(id, (crate::picker::Pick::Files(request.clone()), answer));
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::PickFiles { id, request },
                });
            }
            Action::ReadClipboard(read) => {
                let id = self.components.next_clipboard_read;
                self.components.next_clipboard_read += 1;
                let command = match &read {
                    ClipboardRead::Text(_) | ClipboardRead::CheckedText(_) => {
                        Command::ReadClipboard {
                            id,
                            has_only: false,
                        }
                    }
                    ClipboardRead::Has(_) => Command::ReadClipboard { id, has_only: true },
                    ClipboardRead::Image(_) | ClipboardRead::CheckedImage(_) => {
                        Command::ReadClipboardImage {
                            id,
                            has_only: false,
                        }
                    }
                    ClipboardRead::HasImage(_) => {
                        Command::ReadClipboardImage { id, has_only: true }
                    }
                    ClipboardRead::Files(_) => Command::ReadClipboardFiles { id },
                };
                self.components.clipboard_reads.insert(id, read);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command,
                });
            }
            // Checked here, before the engine routes them: the embedding
            // app's channel and the platform get only granted names.
            Action::HostCall { name, args, answer } => {
                use crate::host_channel::{HostError, MAX_PENDING_CALLS};
                let refused = crate::host_channel::refusal(&self.access, &name).or_else(|| {
                    (self.components.host_calls.len() >= MAX_PENDING_CALLS)
                        .then(|| HostError::TooManyCalls { name: name.clone() })
                });
                if let Some(error) = refused {
                    if !matches!(error, HostError::TooManyCalls { .. }) {
                        self.deny(error.to_string());
                    }
                    answer.borrow_mut().deliver(Err(error));
                    return;
                }
                let id = self.components.next_host_call;
                self.components.next_host_call += 1;
                self.components.host_calls.insert(id, answer);
                self.components
                    .host_requests
                    .push(crate::host_channel::HostRequest::Call { id, name, args });
            }
            Action::HostPost { name, args } => {
                if let Some(error) = crate::host_channel::refusal(&self.access, &name) {
                    self.deny(error.to_string());
                    return;
                }
                self.components
                    .host_requests
                    .push(crate::host_channel::HostRequest::Post { name, args });
            }
            // A call timed out (`runtime/host.rs`), its answer dropped: its
            // slot waits no more.
            Action::ForgetHostCalls => {
                self.components
                    .host_calls
                    .retain(|_, slot| std::rc::Rc::strong_count(slot) > 1);
            }
            Action::OpenUrl(url, answer) => {
                if let Err(refused) = crate::open_url::check_url(&url) {
                    log::warn!(target: "js", "{refused}");
                    answer.borrow_mut().deliver(false);
                    return;
                }
                if !self.access.allows_open_url(&url) {
                    answer.borrow_mut().deliver(false);
                    self.deny(crate::open_url::not_granted(&url).message().to_owned());
                    return;
                }
                let id = self.components.next_url_open;
                self.components.next_url_open = id.wrapping_add(1);
                self.components.url_opens.insert(id, answer);
                self.components.url_requests.push((id, url));
            }
            Action::OpenAppSettings(answer) => {
                use crate::mobile::AppSettingsError;
                // The app's settings page acts on the application as a
                // whole (the embedding app's, embedded): an app declaring
                // capabilities needs `application`.
                let refused = if !self.access.allows_application() {
                    Some(AppSettingsError::Denied)
                } else if !self.components.environment.app_settings {
                    Some(AppSettingsError::Unavailable)
                } else {
                    None
                };
                if let Some(error) = refused {
                    answer.borrow_mut().deliver(Err(error));
                    return;
                }
                let id = self.components.next_app_settings_open;
                self.components.next_app_settings_open = id.wrapping_add(1);
                self.components.app_settings_opens.insert(id, answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::OpenAppSettings { id },
                });
            }
            Action::AppSettingsAvailable(answer) => {
                let available =
                    self.components.environment.app_settings && self.access.allows_application();
                answer.borrow_mut().deliver(available);
            }
            Action::Audio(action) => self.audio_action(action),
            Action::Notification(action) => self.notification_action(action),
            Action::LoginItem(enabled, answer) => self.login_item_action(enabled, answer),
            Action::NextUrlSchemeOpen(answer) => {
                let links = &mut self.components.url_schemes;
                match links.pending.pop_front() {
                    Some(url) => answer.borrow_mut().deliver(url),
                    None => links.next = Some(answer),
                }
            }
            Action::NextOpenFiles(answer) => {
                let files = &mut self.components.open_files;
                if files.pending.is_empty() {
                    files.next = Some(answer);
                } else {
                    answer
                        .borrow_mut()
                        .deliver(files.pending.drain(..).collect());
                }
            }
            Action::NextSecondInstance(answer) => {
                let launches = &mut self.components.second_instances;
                match launches.pending.pop_front() {
                    Some(launch) => answer.borrow_mut().deliver(launch),
                    None => launches.next = Some(answer),
                }
            }
            Action::NextAppUrlChange(answer) => {
                let links = &mut self.components.url_schemes;
                links.hears_changes = true;
                match links.changes.pop_front() {
                    Some(change) => answer.borrow_mut().deliver(change),
                    None => links.next_change = Some(answer),
                }
            }
            Action::AppUrl(answer) => {
                let address = self.components.url_schemes.address.get();
                answer.borrow_mut().deliver(address);
            }
            Action::SetAppUrl(url, history) => {
                // Checked where the app called (`set_app_url`, `setUrl`);
                // where the app is the page, the address stays of its
                // origin (both refuse others first).
                let address = self.components.url_schemes.address.clone();
                if let Some(base) = address.page_base()
                    && !crate::url_scheme::same_origin(Some(base.as_str()), &url)
                {
                    log::warn!("set_app_url: {url} is not of the page's origin");
                    return;
                }
                // Again for `setUrl`, which wrote it as it was called: in
                // order with the page's address the core took since.
                address.set(url.clone());
                // The platform shows it: the web in its history entries,
                // iOS and macOS to the system when the app opts in
                // (Handoff).
                let command = match history {
                    crate::url_scheme::HistoryBehavior::Push => Command::PushAppUrl(url),
                    _ => Command::SetAppUrl(url),
                };
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command,
                });
            }
            Action::WebInputAvailable(answer) => {
                let available =
                    self.components.environment.web_input && self.access.allows_web_input();
                answer.borrow_mut().deliver(available);
            }
            Action::WebEvaluateAvailable(answer) => {
                let available =
                    self.components.environment.web_evaluate && self.access.allows_webviews();
                answer.borrow_mut().deliver(available);
            }
            Action::WebViewAvailable(answer) => {
                let available =
                    self.components.environment.web_views && self.access.allows_webviews();
                answer.borrow_mut().deliver(available);
            }
            Action::DownloadDecision {
                node,
                id,
                decision,
                answer,
            } => {
                let effects = self
                    .components
                    .downloads
                    .decide(node, &id, decision, answer);
                self.apply_download_effects(effects);
            }
            Action::PickScreenColor(answer) => {
                if !self.components.environment.screen_color {
                    answer.borrow_mut().deliver(None);
                    return;
                }
                let id = self.components.next_screen_color;
                self.components.next_screen_color = id.wrapping_add(1);
                self.components.screen_colors.insert(id, answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::PickScreenColor { id },
                });
            }
            Action::Share(request, answer) => self.start_share(request, answer),
            Action::ShareAvailable(answer) => {
                let available = self.components.environment.share && self.access.allows_share();
                answer.borrow_mut().deliver(available);
            }
            Action::AuthSession(request, answer) => self.start_auth_session(request, answer),
            Action::CloseAuthSession => self.close_auth_session(),
            Action::RenderCanvas(request, answer) => self.start_canvas_render(*request, answer),
            Action::FileRequest(request, answer) => {
                use crate::file_dialog::FileRequest;
                if !self.components.environment.file_requests {
                    answer.deliver(
                        Vec::new(),
                        Some("this platform has no file dialogs, file manager or trash".into()),
                    );
                    return;
                }
                if let FileRequest::OpenPath(path)
                | FileRequest::RevealPath(path)
                | FileRequest::MoveToTrash(path) = &request
                    && !path.is_absolute()
                {
                    let refused = format!("`{}` is not an absolute path", path.display());
                    log::warn!("{refused}");
                    answer.deliver(Vec::new(), Some(refused));
                    return;
                }
                let id = self.components.next_file_request;
                self.components.next_file_request = id.wrapping_add(1);
                self.components.file_requests.insert(id, answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::FileRequest {
                        id,
                        request: Box::new(request),
                    },
                });
            }
        }
    }

    /// Checks `request` and sends it to the platform's share sheet
    /// ([`crate::share`]); `answer` gets how it ended. Request ids are
    /// unique in the process, as offscreen renders' are: a sheet still
    /// open when a hot reload replaced the core must not answer the new
    /// core's request of the same number.
    fn start_share(
        &mut self,
        request: crate::share::ShareRequest,
        answer: AnswerSlot<Result<crate::share::ShareOutcome, crate::share::ShareError>>,
    ) {
        use crate::share::{ShareError, ShareOutcome};
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let refused = if !self.components.environment.share {
            Some(ShareError::unavailable("this platform has no share sheet"))
        } else if !self.access.allows_share() {
            Some(ShareError {
                code: Some(crate::element::codes::ACCESS_DENIED.into()),
                message: crate::share::NOT_GRANTED.into(),
            })
        } else {
            request.check().err().map(ShareError::failed)
        };
        if let Some(error) = refused {
            answer.borrow_mut().deliver(Err(error));
            return;
        }
        // One sheet at a time: the one still showing ends as dismissed and
        // the platform replaces it, so a sheet the platform never answered
        // cannot hold every later share back.
        for (_, earlier) in self.components.shares.drain() {
            earlier.borrow_mut().deliver(Ok(ShareOutcome::dismissed()));
        }
        // The anchor goes to the platform as a view it shows, which it
        // places the sheet at wherever that view is (a modal, a window).
        let anchor = request.anchor.filter(|&node| {
            self.key(node).is_ok_and(|key| {
                self.nodes[key as usize].created && (key == self.root || self.in_tree(key))
            })
        });
        let id = loop {
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if id != 0 {
                break id;
            }
        };
        self.components.shares.insert(id, answer);
        let _ = self.apply_op(Op::Command {
            id: crate::ROOT_ID,
            command: Command::Share {
                id,
                sheet: Box::new(crate::share::ShareSheet::new(request, anchor)),
            },
        });
    }

    /// Checks `request` and starts its sign-in session
    /// ([`crate::auth_session`]): sent to the platform where it shows
    /// sessions, opened in the system browser elsewhere; `answer` gets how
    /// it ended. Request ids are unique in the process, as shares' are.
    fn start_auth_session(
        &mut self,
        request: crate::auth_session::AuthSessionRequest,
        answer: AuthSessionAnswer,
    ) {
        use crate::auth_session::{AuthSessionError, AuthSessionOutcome, AuthSessionPage};
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let in_app = self.components.environment.auth_session;
        let scheme = request.scheme();
        let refused = if let Err(wrong) = request.check() {
            Some(AuthSessionError::failed(wrong))
        } else if !self.access.allows_open_url(&request.url) {
            let denied = crate::open_url::not_granted(&request.url);
            self.deny(denied.message().to_owned());
            Some(AuthSessionError {
                code: Some(crate::element::codes::ACCESS_DENIED.into()),
                message: denied.message().to_owned(),
            })
        } else if !in_app && !self.components.environment.scheme_links {
            // This platform hands the app no links of its schemes (the web,
            // the GPUI and terminal backends): the callback could never come
            // back.
            Some(AuthSessionError::unavailable(format!(
                "openAuthSession: no in-app sign-in here, and no link of `{scheme}:` can reach the app on this platform"
            )))
        } else if !in_app
            && !self
                .components
                .url_schemes
                .links
                .schemes()
                .contains(&scheme)
        {
            // Only a link of a scheme the app claims brings the callback
            // back to it here; without one the session could never end.
            Some(AuthSessionError::unavailable(format!(
                "openAuthSession: no in-app sign-in here, and `{scheme}:` is not a scheme the app claims (nsh.json `schemes`)"
            )))
        } else {
            None
        };
        if let Some(error) = refused {
            answer.borrow_mut().deliver(Err(error));
            return;
        }
        // One session at a time: the one still waiting ends as cancelled
        // (the platform closes it where it can), so a session whose
        // callback never came cannot hold every later one back.
        if let Some(earlier) = self.components.auth_session.take() {
            earlier
                .answer
                .borrow_mut()
                .deliver(Ok(AuthSessionOutcome::Cancelled));
        }
        let id = loop {
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if id != 0 {
                break id;
            }
        };
        let page = AuthSessionPage::new(&request);
        let opening = if in_app {
            let _ = self.apply_op(Op::Command {
                id: crate::ROOT_ID,
                command: Command::AuthSession {
                    id,
                    page: Box::new(page),
                },
            });
            None
        } else {
            // As `open_url`: the engine asks the embedding app, then the
            // platform; whether it opened comes back to `answer_open_url`.
            let open = self.components.next_url_open;
            self.components.next_url_open = open.wrapping_add(1);
            let (_, opened) = crate::element::Answer::<bool>::new();
            self.components.url_opens.insert(open, opened);
            self.components.url_requests.push((open, page.url));
            Some(open)
        };
        self.components.auth_session = Some(AuthSession {
            id,
            scheme,
            answer,
            opening,
        });
    }

    /// Closes the app's waiting sign-in session, if any: answers it as
    /// cancelled and, where the platform shows it, has the platform close
    /// it. A page in the system browser stays open: nothing closes it.
    fn close_auth_session(&mut self) {
        let Some(session) = self.components.auth_session.take() else {
            return;
        };
        session
            .answer
            .borrow_mut()
            .deliver(Ok(crate::auth_session::AuthSessionOutcome::Cancelled));
        if session.opening.is_none() {
            let _ = self.apply_op(Op::Command {
                id: crate::ROOT_ID,
                command: Command::CloseAuthSession(session.id),
            });
        }
    }

    /// Ends the waiting sign-in session `id` (any, `None`) with `result`.
    fn end_auth_session(
        &mut self,
        id: Option<u32>,
        result: Result<
            crate::auth_session::AuthSessionOutcome,
            crate::auth_session::AuthSessionError,
        >,
    ) {
        let session = &mut self.components.auth_session;
        if session
            .as_ref()
            .is_some_and(|s| id.is_none_or(|id| s.id == id))
            && let Some(session) = session.take()
        {
            session.answer.borrow_mut().deliver(result);
        }
    }

    /// Applies what the downloads ask of the core
    /// ([`crate::webview::downloads::Effect`]).
    fn apply_download_effects(&mut self, effects: Vec<crate::webview::downloads::Effect>) {
        use crate::webview::downloads::Effect;
        for effect in effects {
            match effect {
                Effect::Event {
                    node,
                    kind,
                    payload,
                } => {
                    self.events
                        .push(crate::element::JsEvent::Event(node, kind, payload));
                }
                Effect::Command {
                    node,
                    operation,
                    track,
                } => {
                    let id = self.alloc_webview_request();
                    self.components.downloads.track(id, track);
                    let _ = self.apply_op(Op::Command {
                        id: node,
                        command: Command::WebViewRequest(crate::webview::WebViewRequest {
                            id,
                            operation,
                        }),
                    });
                }
                Effect::Answer { slot, result } => slot.borrow_mut().deliver(result),
            }
        }
    }

    /// A request id no outstanding download command uses (downloads and
    /// the app's platform replies share one id space per core).
    fn alloc_webview_request(&mut self) -> u64 {
        loop {
            let id = self.components.next_webview_request;
            self.components.next_webview_request = id.wrapping_add(1);
            if !self.components.downloads.tracks(id) {
                break id;
            }
        }
    }

    /// The node `id` is released (it unmounted): its downloads are
    /// cancelled with [`crate::webview::CancelReason::Teardown`]. The
    /// sessions (and their staging files) stay until the platform confirms
    /// its writer stopped, even though the node is gone: the reply or end
    /// still reaches the core, and only then is cleanup allowed.
    pub(super) fn webview_released(&mut self, id: NodeId) {
        let effects = self.components.downloads.teardown(id);
        // The node still exists but this commit's command queue was already
        // drained: put the cancel commands straight into the batch, before
        // the node's Delete, so the platform can still stop its writer.
        for effect in effects {
            match effect {
                crate::webview::downloads::Effect::Event {
                    node,
                    kind,
                    payload,
                } => self
                    .events
                    .push(crate::element::JsEvent::Event(node, kind, payload)),
                crate::webview::downloads::Effect::Command {
                    node,
                    operation,
                    track,
                } => {
                    let request = self.alloc_webview_request();
                    self.components.downloads.track(request, track);
                    self.mount.push(crate::MountItem::Command {
                        id: node,
                        command: Command::WebViewRequest(crate::webview::WebViewRequest {
                            id: request,
                            operation,
                        }),
                    });
                }
                crate::webview::downloads::Effect::Answer { slot, result } => {
                    slot.borrow_mut().deliver(result);
                }
            }
        }
    }

    /// A platform's report of a download ([`EventKind::DownloadOffer`],
    /// `DownloadProgress`, `DownloadEnd`): consumed here, so it never
    /// reaches a listener or JS.
    fn download_event(&mut self, id: NodeId, kind: EventKind, payload: &EventPayload) -> bool {
        match kind {
            EventKind::DownloadOffer => {
                let EventPayload::Json(value) = payload else {
                    return true;
                };
                let Some(offer) = crate::webview::downloads::parse_offer(value) else {
                    log::debug!(target: "js", "web view: dropped a malformed download offer: {value}");
                    return true;
                };
                let events = self
                    .key(id)
                    .ok()
                    .map(|key| self.nodes[key as usize].events)
                    .unwrap_or_default();
                let mode = if events.contains(EventKind::DownloadPending) {
                    crate::webview::downloads::Mode::Manual
                } else if events.contains(EventKind::Download) {
                    crate::webview::downloads::Mode::Automatic
                } else {
                    crate::webview::downloads::Mode::None
                };
                let automatic =
                    crate::webview::downloads::automatic_destination(&offer.id, &offer.filename);
                // The offer's URL is the response's, after the platform
                // followed its redirects: a download from a host takes the
                // grant a page there would, so a redirect cannot carry it to
                // a host the web view may not show. One of the page's own
                // content (`data:`, `blob:`) reaches no host, and stays
                // allowed as it was.
                let refused = (!self.access.is_unrestricted()
                    && !page_content(&offer.url)
                    && !self.access.allows_webview(&offer.url))
                .then(|| super::not_granted("the download", &offer.url, "webview.hosts"));
                if let Some(message) = &refused {
                    self.deny(message.clone());
                }
                let effects = self
                    .components
                    .downloads
                    .offer(id, offer, mode, automatic, refused);
                self.apply_download_effects(effects);
            }
            EventKind::DownloadProgress => {
                // Progress is not an app event yet; the platform may still
                // report it, and it is dropped here.
            }
            EventKind::DownloadEnd => {
                let EventPayload::Json(value) = payload else {
                    return true;
                };
                let Some(end) = crate::webview::downloads::parse_end(value) else {
                    log::debug!(target: "js", "web view: dropped a malformed download end: {value}");
                    return true;
                };
                let effects = self.components.downloads.end(id, end);
                self.apply_download_effects(effects);
            }
            _ => return false,
        }
        true
    }

    /// Applies the downloads' file work and deadlines (once per commit).
    pub(super) fn poll_downloads(&mut self) {
        let effects = self.components.downloads.poll(crate::time::now());
        if !effects.is_empty() {
            self.apply_download_effects(effects);
        }
    }

    /// The downloads' listeners as a round's final masks leave them: a web
    /// view whose `onDownload` and `onDownloadPending` listeners are both
    /// gone can neither hear of its downloads nor decide their offers, so
    /// they are cancelled ([`crate::webview::CancelReason::NoListener`]).
    /// The view stays mounted, and a listener removed and added back in the
    /// same turn changes nothing: only the mask the turn ended with counts.
    pub(super) fn sync_download_listeners(&mut self) {
        let nodes = self.components.downloads.unobserved_nodes(|node| {
            self.key(node).is_ok_and(|key| {
                let events = self.nodes[key as usize].events;
                events.contains(EventKind::Download) || events.contains(EventKind::DownloadPending)
            })
        });
        for node in nodes {
            let effects = self.components.downloads.lost_listener(node);
            self.apply_download_effects(effects);
        }
    }

    /// When the downloads' next deadline is due (the engine wakes then).
    pub fn download_deadline(&self) -> Option<crate::time::Instant> {
        self.components.downloads.deadline()
    }

    /// Native animations that ended: the components' resolve their
    /// [`crate::element::AnimationEnd`]s; JS's stay in `finished`.
    pub fn animations_finished(&mut self, finished: &mut Vec<crate::animation::Finished>) {
        finished.retain(|f| match self.components.animations.remove(&f.animation) {
            Some(Awaited::End(end)) => {
                end.borrow_mut().deliver(f.finished);
                false
            }
            Some(Awaited::Value(value)) => {
                value.borrow_mut().deliver(f.value.unwrap_or_default());
                false
            }
            // JS's are even.
            None => f.animation % 2 == 0,
        });
    }

    /// The answer to image info request `id`.
    pub(super) fn answer_image_info(&mut self, id: u32, size: Result<ImageSize, String>) {
        if let Some(answer) = self.components.image_infos.remove(&id) {
            answer.borrow_mut().deliver(size);
        }
    }

    /// Moves the URLs the app asked to open (`openUrl`, [`crate::element::open_url`])
    /// since the last call to `out`, by request id, checked and granted
    /// ([`crate::open_url`]). The engine asks the embedding app first, then
    /// answers each with [`Core::answer_open_url`] (the embedding app took
    /// it) or [`Core::open_url_on_platform`].
    pub fn take_url_opens(&mut self, out: &mut Vec<(u32, String)>) {
        out.append(&mut self.components.url_requests);
    }

    /// Answers the oldest clipboard write still waiting.
    pub(super) fn answer_clipboard_write(&mut self, result: crate::element::ClipboardWrite) {
        if let Some(answer) = self.components.clipboard_writes.pop_front() {
            answer.borrow_mut().deliver(result);
        }
    }

    /// Answers URL request `id`: whether the URL opened.
    pub fn answer_open_url(&mut self, id: u32, opened: bool) {
        if let Some(answer) = self.components.url_opens.remove(&id) {
            answer.borrow_mut().deliver(opened);
        }
        if !opened
            && let Some(session) = &self.components.auth_session
            && session.opening == Some(id)
        {
            let session = session.id;
            self.end_auth_session(
                Some(session),
                Err(crate::auth_session::AuthSessionError::failed(
                    "openAuthSession: the browser did not open the sign-in page",
                )),
            );
        }
    }

    /// Hands URL request `id` to the platform, which opens `url` and
    /// reports whether it did ([`crate::EventKind::OpenUrl`] on the root).
    pub fn open_url_on_platform(&mut self, id: u32, url: String) {
        if !self.components.url_opens.contains_key(&id) {
            return;
        }
        let _ = self.apply_op(Op::Command {
            id: crate::ROOT_ID,
            command: Command::OpenUrl { id, url },
        });
    }

    /// Moves the HTTP requests tasks made (`ui::fetch`) since the last call
    /// to `start`, by request id: the engine makes them with its network
    /// stack and reports what happens with [`Core::fetch_event`]. Requests
    /// nothing waits for any more (their task ended) go to `abandoned`, for
    /// the engine to cancel.
    pub fn take_fetches(
        &mut self,
        start: &mut Vec<(u32, crate::platform::HttpRequest)>,
        abandoned: &mut Vec<u32>,
    ) {
        start.append(&mut self.components.fetch_requests);
        if self.components.fetches.is_empty() {
            return;
        }
        self.components.fetches.retain(|&id, pending| {
            // Only the slot is left: the task awaiting it is gone.
            let wanted = Rc::strong_count(&pending.answer) > 1;
            if !wanted {
                abandoned.push(id);
            }
            wanted
        });
        start.retain(|(id, _)| !abandoned.contains(id));
    }

    /// What happened to the tasks' request `id`; false when nothing waits
    /// for it any more (the task ended, or the request is over): the engine
    /// then cancels it.
    pub fn fetch_event(&mut self, id: u32, event: crate::platform::FetchEvent) -> bool {
        use crate::platform::FetchEvent;
        let Some(pending) = self.components.fetches.get_mut(&id) else {
            return false;
        };
        // Only the slot is left: the task awaiting it is gone.
        if Rc::strong_count(&pending.answer) == 1 {
            self.components.fetches.remove(&id);
            return false;
        }
        match event {
            FetchEvent::BodyWanted => {}
            FetchEvent::Head(head) => pending.response.head = head,
            FetchEvent::Data(data) => pending.response.body.extend_from_slice(&data),
            FetchEvent::End => {
                if let Some(pending) = self.components.fetches.remove(&id) {
                    pending.answer.borrow_mut().deliver(Ok(pending.response));
                }
                return false;
            }
            FetchEvent::Failed(error) => {
                if let Some(pending) = self.components.fetches.remove(&id) {
                    pending
                        .answer
                        .borrow_mut()
                        .deliver(Err(FetchFailure::Failed(error)));
                }
                return false;
            }
        }
        true
    }

    /// Fails the tasks' request `id`, which the app's capabilities do not
    /// grant: `url` is the URL refused, the request's or a redirect's (the
    /// engine checks every hop), `message` why. A task's
    /// [`fetch`](crate::element::fetch) fails with the message; a module
    /// function's call rejects with `ERR_ACCESS_DENIED`, `permission`
    /// `"network"` and `resource` the URL, as JS's `fetch` does
    /// (`registerFont`).
    pub fn fetch_refused(&mut self, id: u32, message: String, url: String) {
        if let Some(pending) = self.components.fetches.remove(&id) {
            let refused = FetchFailure::Refused { message, url };
            pending.answer.borrow_mut().deliver(Err(refused));
        }
    }

    /// Resolves clipboard read `id` with the platform's answer (an empty
    /// one when the clipboard is not granted).
    pub(super) fn answer_clipboard(&mut self, id: u32, answer: ClipboardAnswer) {
        let ClipboardAnswer {
            has,
            text,
            denied,
            image,
            too_large,
            files,
        } = answer;
        let image = image.filter(|i| !i.url.is_empty());
        match self.components.clipboard_reads.remove(&id) {
            Some(ClipboardRead::Text(slot)) => slot.borrow_mut().deliver(text.unwrap_or_default()),
            Some(ClipboardRead::CheckedText(slot)) => slot
                .borrow_mut()
                .deliver((!denied).then(|| text.unwrap_or_default())),
            Some(ClipboardRead::Has(slot) | ClipboardRead::HasImage(slot)) => {
                slot.borrow_mut().deliver(has)
            }
            Some(ClipboardRead::Image(slot)) => slot.borrow_mut().deliver(image),
            Some(ClipboardRead::CheckedImage(slot)) => slot.borrow_mut().deliver(match too_large {
                Some(bytes) => Err(bytes),
                None => Ok(image),
            }),
            Some(ClipboardRead::Files(slot)) => slot.borrow_mut().deliver(files),
            None => {}
        }
    }

    /// The answer to host call `id`: the host's value, or its error. A
    /// call that timed out ([`crate::element::host_call_with`]) takes none:
    /// its late answer is dropped.
    #[doc(hidden)]
    pub fn answer_host(
        &mut self,
        id: u64,
        result: Result<crate::JsonValue, crate::host_channel::HostError>,
    ) {
        match self.components.host_calls.remove(&id) {
            Some(answer) if std::rc::Rc::strong_count(&answer) > 1 => {
                answer.borrow_mut().deliver(result);
            }
            _ => {
                log::debug!(target: "js", "nsh/host: dropped the answer to call {id}, which no longer waits")
            }
        }
    }

    /// Moves the host calls and posts of the app's Rust and JS
    /// ([`crate::element::host_call`], [`crate::element::host_post`])
    /// since the last call to `out`, checked and granted. The engine hands
    /// each to the embedding app's channel where it is configured (its
    /// answers come with [`Core::answer_host`]), else to
    /// [`Core::host_request_on_platform`].
    #[doc(hidden)]
    pub fn take_host_requests(&mut self, out: &mut Vec<crate::host_channel::HostRequest>) {
        out.append(&mut self.components.host_requests);
    }

    /// Hands `request` to the platform's host (the web page's): a call
    /// goes out as [`Command::HostCall`], answered by the root's
    /// [`EventKind::Host`] `{ type: "reply" }`, a post as
    /// [`Command::HostPost`]. Without one ([`Environment::host`]) a call
    /// fails at once ([`crate::host_channel::HostError::Unavailable`]) and
    /// a post goes nowhere, as a channel without a handler drops it.
    ///
    /// [`Environment::host`]: crate::platform::Environment::host
    #[doc(hidden)]
    pub fn host_request_on_platform(&mut self, request: crate::host_channel::HostRequest) {
        use crate::host_channel::{HostError, HostRequest};
        let host = self.components.environment.host;
        let command = match request {
            HostRequest::Call { id, .. } if !host => {
                self.answer_host(id, Err(HostError::Unavailable));
                return;
            }
            HostRequest::Post { .. } if !host => return,
            HostRequest::Call { id, name, args } => Command::HostCall { id, name, args },
            HostRequest::Post { name, args } => Command::HostPost { name, args },
        };
        let _ = self.apply_op(Op::Command {
            id: crate::ROOT_ID,
            command,
        });
    }

    /// The host's event `event` with `data`: the components' listeners of
    /// it ([`crate::element::on_host_event`]) run, oldest first. The
    /// engine calls it for the embedding app's events; the web page's come
    /// as the root's [`EventKind::Host`] events. Without a listener of its
    /// name the event is kept until one is added
    /// ([`Core::release_host_events`]), as JS keeps the embedding app's.
    #[doc(hidden)]
    pub fn host_event(&mut self, event: &str, data: &crate::JsonValue) {
        if !self.components.executor.host_events.borrow().listens(event) {
            // Quietly: in an app whose listeners are JS's, the events no
            // Rust code listens to fill this inbox, and JS warns of its own.
            if let Some((dropped, _)) = self
                .components
                .host_inbox
                .push(event.to_owned(), data.clone())
            {
                log::debug!(target: "js", "nsh/host: no Rust listener heard \"{dropped}\"; the oldest kept event was dropped");
            }
            return;
        }
        // Those kept for a listener added since the last commit go first.
        self.deliver_kept_host_events(event);
        self.dispatch_host_event(event, data);
    }

    /// Hands the host's events kept for want of a listener
    /// ([`Core::host_event`]) to the listeners of their names added since
    /// the last call, so listeners added after the app started (once it
    /// loaded something, say) hear what came before them. The engine calls
    /// it after each commit. True when some were delivered: what their
    /// listeners changed shows in another round.
    #[doc(hidden)]
    pub fn release_host_events(&mut self) -> bool {
        let names = {
            let mut listeners = self.components.executor.host_events.borrow_mut();
            if !std::mem::take(&mut listeners.added) || self.components.host_inbox.is_empty() {
                return false;
            }
            listeners.names()
        };
        let mut delivered = false;
        for name in names {
            delivered |= self.deliver_kept_host_events(&name);
        }
        delivered
    }

    /// Hands the kept events of `event` to its listeners, oldest first,
    /// while one is there: one that stops listening leaves the rest kept
    /// for the next. True when one was delivered.
    fn deliver_kept_host_events(&mut self, event: &str) -> bool {
        let mut delivered = false;
        while self.components.executor.host_events.borrow().listens(event) {
            let Some(data) = self.components.host_inbox.pop(event) else {
                break;
            };
            self.dispatch_host_event(event, &data);
            delivered = true;
        }
        delivered
    }

    /// Runs the listeners of `event` there now with `data`, oldest first;
    /// one that panics is reported and the others still run.
    fn dispatch_host_event(&mut self, event: &str, data: &crate::JsonValue) {
        let listeners = self.components.executor.host_events.borrow().of(event);
        let _entered = self.components.runtime.enter();
        for listener in listeners {
            let result = caught(|| listener(data));
            self.apply_actions();
            if let Err(message) = result {
                log::error!(target: "js", "a listener of the host's \"{event}\" failed: {message}");
            }
        }
    }

    /// What the platform reported of window `id` reaches the ref of the
    /// Rust components in it ([`Core::js_window_owner`]); a closed window's
    /// goes.
    fn report_window(&mut self, id: NodeId, event: &crate::desktop::WindowEvent) {
        use crate::desktop::WindowEvent;
        match event {
            WindowEvent::State(state) => {
                self.components.window_reports.entry(id).or_default().0 = Some(**state);
            }
            WindowEvent::TitleBar(area) => {
                self.components.window_reports.entry(id).or_default().1 = *area;
            }
            WindowEvent::Closed { .. } => {
                self.components.window_reports.remove(&id);
                if let Some((owner, _)) = self.components.js_windows.remove(&id) {
                    let _entered = self.components.runtime.enter();
                    owner.dispose();
                }
                return;
            }
            _ => return,
        }
        if let Some((_, this)) = self.components.js_windows.get(&id) {
            let _entered = self.components.runtime.enter();
            this.report(event);
        }
    }

    /// Events the components handle before anything else: dialog answers
    /// (theirs never reach JS), insets of screens and modals.
    fn platform_event(&mut self, id: NodeId, kind: EventKind, payload: &EventPayload) -> bool {
        if matches!(
            kind,
            EventKind::DownloadOffer | EventKind::DownloadProgress | EventKind::DownloadEnd
        ) {
            return self.download_event(id, kind, payload);
        }
        let number = |key: &str| match payload {
            EventPayload::Map(entries) => entries.iter().find_map(|(k, v)| match v {
                crate::PayloadValue::Number(n) if *k == key => Some(*n),
                _ => None,
            }),
            _ => None,
        };
        match kind {
            // A window that keeps its placement saves it as it changes; the
            // event goes on to the app.
            EventKind::Window => {
                if let EventPayload::Window(event) = payload {
                    if id != ROOT_ID {
                        self.report_window(id, event);
                    }
                    match event.as_ref() {
                        crate::desktop::WindowEvent::State(state) => {
                            self.keep_window_placement(id, state);
                        }
                        // Rust listeners of the main window's; JS's hear it
                        // from the event.
                        crate::desktop::WindowEvent::ClosePress { reason }
                            if id == crate::ROOT_ID =>
                        {
                            self.components.runtime.main_close_pressed(*reason);
                        }
                        crate::desktop::WindowEvent::QuitRequest if id == crate::ROOT_ID => {
                            self.quit_requested();
                            return true;
                        }
                        _ => {}
                    }
                }
                false
            }
            EventKind::Dialog => {
                let Some(dialog) = number("id") else {
                    return false;
                };
                let Some(answer) = self.components.dialogs.remove(&(dialog as u32)) else {
                    return false;
                };
                let value = match payload {
                    EventPayload::Map(entries) => entries.iter().find_map(|(k, v)| match v {
                        crate::PayloadValue::Str(text) if *k == "value" => Some(text.clone()),
                        _ => None,
                    }),
                    _ => None,
                };
                answer.borrow_mut().deliver(crate::element::DialogReply {
                    index: number("index").unwrap_or(-1.0) as i32,
                    value,
                });
                true
            }
            // A view's shortcut runs here; JS's go to JS.
            EventKind::KeyCommand if id == crate::ROOT_ID => {
                let EventPayload::Value(crate::PayloadValue::Number(binding)) = payload else {
                    return false;
                };
                let binding = *binding as u32;
                if binding < crate::element::keys::FIRST_ID {
                    return false;
                }
                if binding == super::overlay::ESCAPE_BINDING {
                    self.overlay_escape();
                    return true;
                }
                let found = self.components.executor.keys.borrow().handler(binding);
                // A binding removed since the platform matched it.
                if let Some((text, handler)) = found {
                    let result = caught(|| handler(&text));
                    self.apply_actions();
                    if let Err(message) = result {
                        log::error!(target: "js", "a keyboard shortcut failed: {message}");
                    }
                }
                true
            }
            // A view's menu item runs here; JS's go to JS. A context menu
            // closing settles the one either side showed, so both hear it.
            EventKind::Menu if id == crate::ROOT_ID => {
                let menus = self.components.executor.menus.clone();
                let closed = matches!(payload, EventPayload::Map(entries)
                    if entries.iter().any(|(k, v)| *k == "closed" && *v == crate::PayloadValue::Bool(true)));
                if closed {
                    menus.borrow_mut().settle_popup();
                    return false;
                }
                let Some(item) = number("id").map(|n| n as u32) else {
                    return false;
                };
                if item < crate::element::menus::FIRST_ID {
                    return false;
                }
                // The platform's answer to a global shortcut's registration.
                let registered = match payload {
                    EventPayload::Map(entries) => entries.iter().find_map(|(k, v)| match v {
                        crate::PayloadValue::Bool(b) if *k == "registered" => Some(*b),
                        _ => None,
                    }),
                    _ => None,
                };
                if let Some(registered) = registered {
                    menus.borrow_mut().registered(item, registered);
                    self.apply_actions();
                    return true;
                }
                let click = menus.borrow().tray_click(item);
                if let Some(click) = click {
                    let bounds = match payload {
                        EventPayload::Map(entries) => entries.iter().find_map(|(k, v)| match v {
                            crate::PayloadValue::Bounds(b) if *k == "bounds" => Some(*b),
                            _ => None,
                        }),
                        _ => None,
                    };
                    let result = caught(|| click(bounds));
                    self.apply_actions();
                    if let Err(message) = result {
                        log::error!(target: "js", "the tray's click failed: {message}");
                    }
                    return true;
                }
                let handler = menus.borrow().handler(item);
                // An item of a menu replaced since the platform showed it.
                if let Some(handler) = handler {
                    let result = caught(|| handler());
                    self.apply_actions();
                    if let Err(message) = result {
                        log::error!(target: "js", "a menu item failed: {message}");
                    }
                }
                true
            }
            EventKind::BackPress if id == crate::ROOT_ID => {
                // The top overlay listening takes it first.
                if self.overlay_cancel() {
                    return true;
                }
                let listeners = self.components.executor.back.borrow().newest_first();
                for listener in listeners {
                    let handled = self.back_pressed(&listener);
                    if handled {
                        return true;
                    }
                }
                // JS's listeners run next (and go back when none handles
                // it).
                if self.components.js_back {
                    return false;
                }
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::Back,
                });
                true
            }
            EventKind::BackProgress if id == crate::ROOT_ID => {
                let Some(event) = crate::BackProgressEvent::from_payload(payload) else {
                    return true;
                };
                // The press of a gesture the top overlay listening to
                // `onCancel` takes is the overlay's: the app follows only
                // the gestures that start without one.
                if event.phase == crate::BackPhase::Start {
                    self.components.back_gesture = !self.overlay_state.cancel;
                }
                if !self.components.back_gesture {
                    return true;
                }
                if matches!(
                    event.phase,
                    crate::BackPhase::End | crate::BackPhase::Cancel
                ) {
                    self.components.back_gesture = false;
                }
                let listeners = self
                    .components
                    .executor
                    .back_progress
                    .borrow()
                    .newest_first();
                for listener in listeners {
                    let result = caught(|| listener(&event));
                    self.apply_actions();
                    if let Err(message) = result {
                        log::error!(target: "js", "a back progress listener failed: {message}");
                    }
                }
                // JS's listeners hear it next.
                !self.components.js_back_progress
            }
            EventKind::WebEvaluation => {
                self.answer_web_evaluation(id, payload);
                true
            }
            EventKind::ImageInfo if id == crate::ROOT_ID => {
                let Some(request) = number("id") else {
                    return false;
                };
                let error = match payload {
                    EventPayload::Map(entries) => entries.iter().find_map(|(k, v)| match v {
                        crate::PayloadValue::Str(e) if *k == "error" => Some(e.clone()),
                        _ => None,
                    }),
                    _ => None,
                };
                let size = match (number("width"), number("height"), error) {
                    (Some(width), Some(height), None) => Ok(ImageSize {
                        width: pixels(width),
                        height: pixels(height),
                    }),
                    (_, _, error) => Err(error.unwrap_or_else(|| "no size".into())),
                };
                self.answer_image_info(request as u32, size);
                true
            }
            EventKind::Audio if id == crate::ROOT_ID => {
                let EventPayload::Audio { id: object, event } = payload else {
                    return false;
                };
                // Dropped once the object is closed.
                if let Some(sink) = self.components.audio.get(object) {
                    sink.send(event.clone());
                }
                true
            }
            EventKind::Pick if id == crate::ROOT_ID => {
                let EventPayload::Picked { id: request, files } = payload else {
                    return false;
                };
                if let Some((asked, answer)) = self.components.picks.remove(request) {
                    let files = asked.finish(files.clone());
                    answer.borrow_mut().deliver(files);
                }
                true
            }
            EventKind::Notification if id == crate::ROOT_ID => {
                self.notification_event(payload);
                true
            }
            EventKind::SecondInstance if id == crate::ROOT_ID => {
                let Some(launch) = crate::single_instance::SecondInstance::from_payload(payload)
                else {
                    return false;
                };
                let launches = &mut self.components.second_instances;
                if let Some(answer) = launches.next.take() {
                    answer.borrow_mut().deliver(launch);
                } else {
                    if launches.pending.len() == crate::single_instance::MAX_PENDING {
                        launches.pending.pop_front();
                    }
                    launches.pending.push_back(launch);
                }
                true
            }
            EventKind::UrlScheme if id == crate::ROOT_ID => {
                let EventPayload::Map(entries) = payload else {
                    return false;
                };
                let url = entries.iter().find_map(|(k, v)| match v {
                    crate::PayloadValue::Str(url) if *k == crate::url_scheme::URL => Some(url),
                    _ => None,
                });
                let Some(url) = url else {
                    return false;
                };
                let flag = |key: &str| {
                    entries.iter().find_map(|(k, v)| match v {
                        crate::PayloadValue::Bool(b) if *k == key => Some(*b),
                        _ => None,
                    })
                };
                let page = flag(crate::url_scheme::PAGE).unwrap_or(false);
                let quiet = flag(crate::url_scheme::QUIET).unwrap_or(false);
                // An address move the app did not make (the web's back or
                // forward), by its reason; one of a newer platform's reasons
                // is still the address, quietly.
                let change = entries.iter().find_map(|(k, v)| match v {
                    crate::PayloadValue::Str(s) if *k == crate::url_scheme::CHANGE => {
                        Some(crate::url_scheme::AppUrlChangeReason::parse(s))
                    }
                    _ => None,
                });
                let (quiet, change) = match change {
                    Some(None) => (true, None),
                    Some(reason) => (quiet, reason),
                    None => (quiet, None),
                };
                // The page's base URL (the web), which Rust's `set_app_url`
                // resolves against.
                if let Some(base) = entries.iter().find_map(|(k, v)| match v {
                    crate::PayloadValue::Str(s) if *k == crate::url_scheme::BASE => {
                        url::Url::parse(s).ok()
                    }
                    _ => None,
                }) {
                    self.components.url_schemes.address.set_page_base(base);
                }
                self.url_scheme(url.clone(), page, quiet, change);
                true
            }
            EventKind::ClipboardWrite if id == crate::ROOT_ID => {
                let written = match payload {
                    EventPayload::Map(entries) => entries
                        .iter()
                        .any(|(k, v)| *k == "written" && *v == crate::PayloadValue::Bool(true)),
                    _ => false,
                };
                self.answer_clipboard_write(if written {
                    crate::element::ClipboardWrite::Written
                } else {
                    crate::element::ClipboardWrite::Failed
                });
                true
            }
            EventKind::OpenUrl if id == crate::ROOT_ID => {
                let Some(request) = number("id") else {
                    return false;
                };
                let opened = match payload {
                    EventPayload::Map(entries) => entries
                        .iter()
                        .any(|(k, v)| *k == "opened" && *v == crate::PayloadValue::Bool(true)),
                    _ => false,
                };
                self.answer_open_url(request as u32, opened);
                true
            }
            EventKind::OpenAppSettings if id == crate::ROOT_ID => {
                let Some(request) = number("id") else {
                    return false;
                };
                let opened = match payload {
                    EventPayload::Map(entries) => entries
                        .iter()
                        .any(|(k, v)| *k == "opened" && *v == crate::PayloadValue::Bool(true)),
                    _ => false,
                };
                if let Some(answer) = self.components.app_settings_opens.remove(&(request as u32)) {
                    answer.borrow_mut().deliver(Ok(opened));
                }
                true
            }
            EventKind::ScreenColor if id == crate::ROOT_ID => {
                let Some(request) = number("id") else {
                    return false;
                };
                let color = number("color").map(|packed| crate::Color(packed as u32).into());
                if let Some(answer) = self.components.screen_colors.remove(&(request as u32)) {
                    answer.borrow_mut().deliver(color);
                }
                true
            }
            EventKind::Share if id == crate::ROOT_ID => {
                let Some((request, result)) = crate::share::answer_from_payload(payload) else {
                    return false;
                };
                if let Some(answer) = self.components.shares.remove(&request) {
                    answer.borrow_mut().deliver(result);
                }
                true
            }
            EventKind::AuthSession if id == crate::ROOT_ID => {
                let Some((request, result)) = crate::auth_session::answer_from_payload(payload)
                else {
                    return false;
                };
                self.end_auth_session(Some(request), result);
                true
            }
            EventKind::CanvasImage if id == crate::ROOT_ID => self.answer_canvas_render(payload),
            EventKind::FileRequest if id == crate::ROOT_ID => {
                let EventPayload::FileRequest {
                    id: request,
                    paths,
                    error,
                } = payload
                else {
                    return false;
                };
                if let Some(answer) = self.components.file_requests.remove(request) {
                    answer.deliver(paths.clone(), error.clone());
                }
                true
            }
            // The platform's answer to a download command
            // ([`crate::webview::WebViewRequest`]), on the node it was sent
            // to. A reply whose writer stopped is the only thing that
            // permits cleaning a staging file.
            EventKind::WebViewReply => {
                let EventPayload::Json(reply) = payload else {
                    return false;
                };
                // JSON's numbers may come as floats (`1.0`); `1.5` is no
                // request.
                let request = reply.get("id").and_then(|id| {
                    id.as_u64().or_else(|| {
                        id.as_f64()
                            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
                            .map(|n| n as u64)
                    })
                });
                let Some(request) = request else {
                    log::debug!(target: "js", "web view: dropped a reply without a request's id: {reply}");
                    return true;
                };
                if !self.components.downloads.tracks(request) {
                    log::debug!(target: "js", "web view: dropped a reply to unknown request {request}: {reply}");
                    return true;
                }
                let result = match reply.get("ok").and_then(crate::JsonValue::as_bool) {
                    Some(true) => Ok(()),
                    _ => Err(reply
                        .get("error")
                        .and_then(crate::JsonValue::as_str)
                        .unwrap_or("the web view did not answer")
                        .to_owned()),
                };
                let effects = self.components.downloads.reply(id, request, result);
                self.apply_download_effects(effects);
                true
            }
            EventKind::Clipboard if id == crate::ROOT_ID => {
                let Some(request) = number("id") else {
                    return false;
                };
                let answer = ClipboardAnswer::from_payload(payload);
                self.answer_clipboard(request as u32, answer);
                true
            }
            // The host's replies; its events reach the components'
            // listeners, then go on to `nsh/host`'s (`nsh-js`).
            EventKind::Host if id == crate::ROOT_ID => {
                let EventPayload::Json(reply) = payload else {
                    return false;
                };
                match reply.get("type").and_then(crate::JsonValue::as_str) {
                    Some("reply") => {}
                    Some("event") => {
                        if let Some(event) = reply.get("event").and_then(crate::JsonValue::as_str) {
                            let data = reply.get("payload").cloned().unwrap_or_default();
                            self.host_event(event, &data);
                        }
                        return false;
                    }
                    _ => return false,
                }
                // JSON's numbers may come as floats (`1.0`); `1.5` is no
                // call. Ids stay within JS' safe integers.
                let call = reply.get("id").and_then(|id| {
                    id.as_u64().or_else(|| {
                        id.as_f64()
                            .filter(|n| {
                                n.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(n)
                            })
                            .map(|n| n as u64)
                    })
                });
                let Some(call) = call else {
                    log::debug!(target: "js", "nsh/host: dropped a reply without a call's id: {reply}");
                    return true;
                };
                let result = if reply.get("ok").and_then(crate::JsonValue::as_bool) == Some(true) {
                    Ok(reply.get("value").cloned().unwrap_or_default())
                } else {
                    Err(crate::host_channel::HostError::Failed(
                        reply
                            .get("error")
                            .and_then(crate::JsonValue::as_str)
                            .unwrap_or("nsh/host: the call failed")
                            .to_owned(),
                    ))
                };
                self.answer_host(call, result);
                true
            }
            EventKind::Insets => {
                let insets = EdgeInsets {
                    top: Points(number("top").unwrap_or(0.0) as f32),
                    right: Points(number("right").unwrap_or(0.0) as f32),
                    bottom: Points(number("bottom").unwrap_or(0.0) as f32),
                    left: Points(number("left").unwrap_or(0.0) as f32),
                };
                // The views reading them follow (`drain_views`).
                self.components.insets.insert(id, insets);
                // JS's screens keep them too.
                false
            }
            _ => false,
        }
    }

    /// Runs a back listener: whether it handled the press.
    fn back_pressed(&mut self, listener: &crate::element::BackListener) -> bool {
        let result = caught(|| listener());
        self.apply_actions();
        result.unwrap_or_else(|message| {
            log::error!(target: "js", "a back press listener failed: {message}");
            false
        })
    }

    /// The root listens to the back button while JS or a component does:
    /// follows the components' listeners coming and going.
    pub(super) fn sync_back(&mut self) {
        let rust = {
            let mut back = self.components.executor.back.borrow_mut();
            if !std::mem::take(&mut back.changed) {
                return;
            }
            !back.list.is_empty()
        };
        let _ = self.apply_op(Op::Listen {
            id: crate::ROOT_ID,
            event: EventKind::BackPress,
            enabled: rust || self.components.js_back || self.overlay_state.cancel,
        });
    }

    /// The root listens to the back gesture's steps while JS or a component
    /// does: follows the components' listeners coming and going.
    pub(super) fn sync_back_progress(&mut self) {
        let rust = {
            let mut progress = self.components.executor.back_progress.borrow_mut();
            if !std::mem::take(&mut progress.changed) {
                return;
            }
            !progress.list.is_empty()
        };
        let _ = self.apply_op(Op::Listen {
            id: crate::ROOT_ID,
            event: EventKind::BackProgress,
            enabled: rust || self.components.js_back_progress,
        });
    }

    /// The root's shortcuts follow the views' bindings coming and going:
    /// the table JS's and theirs make, listened to while either has one.
    pub(super) fn sync_keys(&mut self) {
        let escape_to_focus = self.focus_takes_escape();
        if escape_to_focus != self.overlay_state.escape_to_focus {
            self.overlay_state.escape_to_focus = escape_to_focus;
            self.components.executor.keys.borrow_mut().changed = true;
        }
        let rust = {
            // The windows' refs read the graph.
            let _entered = self.components.runtime.enter();
            let mut keys = self.components.executor.keys.borrow_mut();
            // A binding of a window that was not mounted yet is placed
            // once it is.
            if !std::mem::take(&mut keys.changed) && !keys.unplaced {
                return;
            }
            !keys.list.is_empty()
        };
        let keymap = self.keymap();
        let _ = self.apply_op(Op::SetProp {
            id: crate::ROOT_ID,
            prop: Prop::Keymap(keymap),
        });
        let _ = self.apply_op(Op::Listen {
            id: crate::ROOT_ID,
            event: EventKind::KeyCommand,
            enabled: rust
                || self.components.js_keys
                || self.overlay_state.cancel
                || self.overlay_state.hint_escape,
        });
    }

    /// The surface's table: JS's bindings, then the views' (the newest that
    /// may fire wins, so a view's wins over JS's of the same keystroke).
    fn keymap(&self) -> Arc<crate::keymap::Keymap> {
        let mut keys = self.components.executor.keys.borrow_mut();
        let overlay = self.overlay_key_binding();
        if keys.list.is_empty() && overlay.is_none() {
            keys.unplaced = false;
            return self.components.js_keymap.clone();
        }
        let views = {
            let _entered = self.components.runtime.enter();
            // Bindings share a few owners (a component's effect binds many):
            // each is looked up once.
            let mut known: Vec<(crate::element::Owner, NodeId)> = Vec::new();
            keys.bindings(|owner| {
                if let Some(&(_, window)) = known.iter().find(|(o, _)| *o == owner) {
                    return window;
                }
                let window = self.window_of_owner(owner);
                known.push((owner, window));
                window
            })
        };
        drop(keys);
        // JS's first, then the views', where the newest that may fire wins:
        // a focused component's keys win over the app's. Bindings
        // `OverFocused::Always` come after both, so they win over the components';
        // the overlay's Escape (a popup closing) stays last.
        let js = self.components.js_keymap.bindings();
        let bindings = js
            .iter()
            .filter(|b| !b.comes_after_views())
            .chain(views.iter().filter(|b| !b.comes_after_views()))
            .chain(js.iter().filter(|b| b.comes_after_views()))
            .chain(views.iter().filter(|b| b.comes_after_views()))
            .copied()
            .chain(overlay)
            .collect();
        Arc::new(crate::keymap::Keymap::new(bindings))
    }

    /// The insets where `host` renders: its screen's or modal's, else the
    /// surface's safe area.
    pub(super) fn insets_of(&self, host: NodeId) -> EdgeInsets {
        let safe = self.components.environment.safe_area;
        let mut key = self.key(host).ok();
        while let Some(k) = key {
            let node = &self.nodes[k as usize];
            if let Some(insets) = self.components.insets.get(&node.id) {
                return *insets;
            }
            match node.kind {
                // Not reported yet: a screen's header covers the top.
                Kind::Screen => {
                    return EdgeInsets {
                        top: Points::ZERO,
                        ..safe
                    };
                }
                Kind::Modal => return safe,
                _ => {}
            }
            key = (node.parent != NO_KEY).then_some(node.parent);
        }
        safe
    }

    /// Whether `key` or a view around it already stands clear of the
    /// software keyboard (`Prop::ClearsKeyboard`, a bottom sheet the
    /// keyboard lifts): the keyboard takes nothing more from it.
    fn clears_keyboard(&self, key: super::Key) -> bool {
        let mut key = key;
        loop {
            let node = &self.nodes[key as usize];
            if node.clears_keyboard {
                return true;
            }
            if node.parent == NO_KEY {
                return false;
            }
            key = node.parent;
        }
    }

    /// What `env` (a node's `env()` terms) comes to for `key` now: the
    /// insets of the root view it renders in ([`Self::insets_of`]) and the
    /// software keyboard's height, 0 where a view around it stands clear
    /// of the keyboard already ([`Self::clears_keyboard`]).
    pub(super) fn env_insets(
        &self,
        key: super::Key,
        env: &crate::style::EnvEdges,
    ) -> [EdgeInsets; 2] {
        use crate::style::EnvVar;
        let mut root = None;
        let mut value = |var: Option<EnvVar>| {
            let Some(var) = var else {
                return Points::ZERO;
            };
            if var == EnvVar::KeyboardInsetHeight {
                if self.clears_keyboard(key) {
                    return Points::ZERO;
                }
                return self
                    .components
                    .environment
                    .keyboard_height
                    .max(Points::ZERO);
            }
            let insets = *root.get_or_insert_with(|| self.insets_of(self.nodes[key as usize].id));
            match var {
                EnvVar::SafeAreaInsetTop => insets.top,
                EnvVar::SafeAreaInsetRight => insets.right,
                EnvVar::SafeAreaInsetBottom => insets.bottom,
                _ => insets.left,
            }
        };
        let mut edges = |vars: &[Option<EnvVar>; 4]| EdgeInsets {
            top: value(vars[0]),
            right: value(vars[1]),
            bottom: value(vars[2]),
            left: value(vars[3]),
        };
        [edges(&env.padding), edges(&env.margin)]
    }

    /// The nodes whose padding or margin uses `env()` follow the
    /// environment: restyled where what their terms come to changed (a
    /// safe area, a page's insets, the keyboard, a move to another root
    /// view). What a change of the keyboard's height moves (those terms,
    /// or the styles an app derives from `keyboardFrame()` in the same
    /// commit) animates with the keyboard, natively, unless the app
    /// configured this commit's animation itself.
    pub(super) fn sync_env(&mut self) {
        let mut keyboard_moved = std::mem::take(&mut self.keyboard_moved);
        if !self.env_styled.is_empty() {
            keyboard_moved |= self.restyle_env();
        }
        let duration = self.components.environment.keyboard_duration;
        if keyboard_moved && duration > 0.0 && self.layout_animation.is_none() {
            use crate::props::{LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition};
            self.layout_animation = Some(LayoutAnimation {
                create: None,
                update: Some(LayoutTransition {
                    curve: LayoutCurve::Keyboard,
                    property: LayoutProperty::Opacity,
                    duration_ms: duration,
                    delay_ms: 0.0,
                }),
                delete: None,
            });
        }
    }

    /// Restyles the nodes whose `env()` terms came to something else;
    /// whether the keyboard moved one of them.
    fn restyle_env(&mut self) -> bool {
        let mut ids = std::mem::take(&mut self.env_scratch);
        ids.extend(self.env_styled.iter().copied());
        let mut keyboard_moved = false;
        for &id in &ids {
            let node = self.key(id).ok().and_then(|key| {
                let env = self.nodes[key as usize].env.as_deref().copied()?;
                Some((key, env))
            });
            let Some((key, (env, applied))) = node else {
                self.env_styled.remove(&id);
                continue;
            };
            let now = self.env_insets(key, &env);
            if now == applied {
                continue;
            }
            // The edges the keyboard moves.
            let keyboard = |vars: &[Option<crate::style::EnvVar>; 4],
                            was: &EdgeInsets,
                            now: &EdgeInsets| {
                let (was, now) = (
                    [was.top, was.right, was.bottom, was.left],
                    [now.top, now.right, now.bottom, now.left],
                );
                (0..4).any(|i| {
                    vars[i] == Some(crate::style::EnvVar::KeyboardInsetHeight) && was[i] != now[i]
                })
            };
            keyboard_moved |= keyboard(&env.padding, &applied[0], &now[0])
                || keyboard(&env.margin, &applied[1], &now[1]);
            self.restyle(key);
        }
        ids.clear();
        self.env_scratch = ids;
        keyboard_moved
    }

    /// Applies what handlers, handles (element refs, animated values) and
    /// services asked for, in order.
    pub(super) fn apply_actions(&mut self) {
        for action in self.components.executor.take_actions() {
            self.apply_action(action);
        }
    }

    /// An event the component on `host` emitted: to the component whose
    /// view has it, if it handles it (a list row's handlers run with the
    /// component whose list it is), else to JS.
    pub(super) fn route_emit(
        &mut self,
        host: NodeId,
        event: Box<dyn crate::element::builder::AnyEvent>,
    ) {
        match self.components.owners.get(&host).copied() {
            Some(parent) => {
                let Some(owner) = self.state_owner(parent) else {
                    return;
                };
                // In order, found one at a time (no list per event).
                let mut from = 0;
                while let Some((at, listener)) =
                    self.components.instances.get(&parent).and_then(|inst| {
                        inst.event_handlers
                            .iter()
                            .enumerate()
                            .skip(from)
                            .find(|(_, (n, _))| *n == host)
                            .map(|(at, (_, l))| (at, l.clone()))
                    })
                {
                    from = at + 1;
                    if let Err(message) = caught(|| listener.call(event.as_any())) {
                        self.component_failed(owner, message);
                    }
                    self.apply_actions();
                }
            }
            None => self.events.push(JsEvent::Component { host, event }),
        }
    }
}

/// Drops `value`, which holds the app's values (a call's arguments or
/// result): a panic in their `Drop` is logged instead of unwinding
/// through the core.
fn drop_caught<T>(value: T) {
    if let Err(message) = caught(move || drop(value)) {
        log::error!(target: "js", "a value of a call into Rust panicked as it dropped: {message}");
    }
}

/// Disposes the contents of a list's cells: the run that made the list went.
fn dispose_rows(rows: &std::rc::Weak<RefCell<CellRowMap>>) {
    let Some(rows) = rows.upgrade() else {
        return;
    };
    let owners: Vec<_> = rows.borrow_mut().drain().map(|(_, (_, o))| o).collect();
    for owner in owners {
        owner.dispose();
    }
}

/// Moves the live cells of a view's list as its rows moved (`diff`, now
/// `count` rows): each keeps its row, at the row's new index. A cell whose
/// row went keeps its index, and shows the row now there, unless that row
/// came there with its own cell: then, as past the rows, its content is
/// disposed before its bindings could read there, so a row never shows in
/// two cells (`ListState::adopt_orphans` in `core/list.rs`, by the same
/// rule).
fn move_rows(cells: &CellRows, diff: Option<&ListDiff>, count: u32) {
    let parts: Vec<_> = cells
        .borrow()
        .iter()
        .map(|(&id, &(index, owner))| (id, index, owner))
        .collect();
    let mut gone = Vec::new();
    // The new index of each cell's row, `None` for a row that went.
    let moves: Vec<_> = parts
        .iter()
        .map(|&(id, index, owner)| {
            let i = index.index.get_untracked();
            let to = match diff {
                Some(d) => d.new_index(i as u32).map(|(to, _)| to as usize),
                None => Some(i),
            };
            (id, index, owner, i, to)
        })
        .collect();
    let mut taken: Vec<usize> = moves
        .iter()
        .filter(|m| m.2.is_live())
        .filter_map(|m| m.4)
        .collect();
    taken.sort_unstable();
    for (id, index, owner, i, to) in moves {
        if !owner.is_live() {
            gone.push(id);
            continue;
        }
        if to.is_none() {
            index.bound.set(false);
        }
        let to = match to {
            Some(to) => Some(to),
            // The row went: the cell reads the row now at its index, if
            // that one's cell is not there too.
            None => Some(i).filter(|i| taken.binary_search(i).is_err()),
        };
        match to {
            Some(to) if to < count as usize => index.index.set(to),
            _ => {
                owner.dispose();
                gone.push(id);
            }
        }
    }
    let mut cells = cells.borrow_mut();
    for id in gone {
        cells.remove(&id);
    }
}

/// The position of row `index` of `count` that a cell's content reads: in a
/// view (`count_signal`), its index a signal of the cell's (handed back in
/// `made`) and the list's count, both written by the list's memo `moves`
/// when its rows are bound; else fixed.
fn row_position(
    index: usize,
    count: usize,
    count_signal: Option<crate::element::Signal<usize>>,
    moves: Option<crate::element::reactive::Node>,
    made: &std::cell::Cell<Option<CellPosition>>,
) -> Position {
    match count_signal {
        Some(count) => {
            let index = crate::element::signal(index);
            let bound = crate::element::signal(true);
            made.set(Some(CellPosition { index, bound }));
            Position::bound(index.node(), count.node(), bound.node(), moves)
        }
        None => Position::fixed(index, count),
    }
}

/// A pixel count a platform reports as a number (whole for what it
/// decodes).
fn pixels(n: f64) -> crate::geometry::DevicePixels {
    crate::geometry::DevicePixels(n.round() as i32)
}

/// Whether `url` names content of the page itself (`data:`, `blob:`), which
/// a download takes from the page rather than from a host.
fn page_content(url: &str) -> bool {
    let scheme = url.split(':').next().unwrap_or_default();
    url.contains(':')
        && (scheme.eq_ignore_ascii_case("data") || scheme.eq_ignore_ascii_case("blob"))
}
