//! Rust components in the core ([`crate::ui`]): creating instances,
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

use std::{any::Any, cell::RefCell, collections::VecDeque, rc::Rc, sync::Arc};

use rustc_hash::FxHashMap;

use super::{Core, Kind, NO_KEY, views::Anchor};
use crate::{
    ApplyError, Command, EdgeInsets, EventKind, EventMask, EventPayload, NodeId, Op, Prop, ROOT_ID,
    Tag, TextEngine,
    geometry::Points,
    tailwind::ClassList,
    ui::{
        Action, AnswerSlot, AnyInstance, AnyValue, Attrs, Child, ClipboardRead, ComponentError,
        ComponentSpec, ElKind, ElNode, Environment, Executor, ImageSize, IntoElement, JsEvent,
        JsResult, ListConfig, Listener, ModuleCx, ParentElement, PlaceFn, Position, Posts,
        Reactive, Registry, Root, RustCall, RustOp, SharedString, StyleRefinement, Task, Tokens,
        caught,
        responder::ResponderEl,
        view,
        virtual_list::{self, RowFn, SeparatorFn, VirtualListEl},
    },
};

/// Lowered styles kept for reuse (many elements have the same styles);
/// cleared when full.
const STYLE_CACHE: usize = 4096;

/// Rounds of polls and updates per run of the tasks, at most.
const MAX_TASK_ROUNDS: u32 = 64;

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
    /// A cell of a component's own list ([`crate::ui::virtual_list`]): it
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
type CellRows = Rc<RefCell<FxHashMap<NodeId, (crate::ui::Signal<usize>, crate::ui::Owner)>>>;

/// A component's own list.
struct VirtualListState {
    /// The component whose view it is in (its rows' handlers are its).
    owner: NodeId,
    row: RowFn,
    count: u32,
    keys: Option<Rc<[u64]>>,
    separator: Option<SeparatorFn>,
    /// The cells, by recycling slot.
    cells: Vec<NodeId>,
    /// In a view: the live parts of its cells (cells and contents) with the
    /// index their content reads and its owner, for its rows' binding.
    rows: CellRows,
    /// The rows of another component's `Items` prop
    /// ([`crate::ui::ComponentElement::items`]): each cell is that
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

/// A component instance on its host node.
pub(super) struct Instance {
    inner: Inner,
    spec: Option<Arc<ComponentSpec>>,
    /// The app's `class` and `classList` on the host.
    pub(super) class: Box<str>,
    pub(super) class_list: Vec<Box<str>>,
    /// The app's classes, or the styles the view this one is in gives it:
    /// applied after the root's own.
    pub(super) user: Option<Arc<ClassList>>,
    /// Events JS listens to on the host.
    js_events: EventMask,
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
    /// The view's handlers: native events by node, and the events of
    /// nested components by their host (a handful: lists beat maps).
    pub(super) handlers: Vec<(NodeId, EventKind, Listener<EventPayload>)>,
    pub(super) event_handlers: Vec<(NodeId, Listener<dyn Any>)>,
    /// The view's parts in the touch responder, by node.
    pub(super) responders: Vec<(NodeId, Rc<ResponderEl>)>,
    /// The app's `style` on the host, applied after the root's own inline
    /// style and animated values.
    pub(super) app_style: Option<crate::StylePatch>,
    dirty: bool,
    /// The nodes of its view with bindings: what was applied last.
    pub(super) bound: FxHashMap<NodeId, super::views::BoundNode>,
    /// In a view placing its JS children one by one: them, as a signal.
    pub(super) js_kids: Option<crate::ui::Signal<Vec<NodeId>>>,
    /// A cell of a view's list: the owner of the row it shows.
    cell_owner: Option<crate::ui::Owner>,
    /// ... and the index its content reads (its [`Position`]): a cell
    /// that shows another row sets it instead of being built again.
    row_index: Option<crate::ui::Signal<usize>>,
    /// Lazy children a view passes: whether it places them, which what
    /// passes them reads.
    lazy_wanted: Option<crate::ui::Signal<bool>>,
    /// In a view: the owner where it places its JS children (a region's),
    /// which the components JS made among them are under.
    children_owner: Option<crate::ui::Owner>,
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
}

/// What a component's root takes from the components above it on its host
/// and the views that place them ([`Core::root_context`]).
pub(super) struct RootContext {
    /// Their styles, after the root's (the outer last).
    pub(super) user: Option<Arc<ClassList>>,
    /// Whether `app` is what goes after the root's inline style (else the
    /// component's own app style is).
    pub(super) combined: bool,
    /// The inline styles and animated values they give it (the inner
    /// first), then the app's style on the top host.
    pub(super) app: Option<crate::StylePatch>,
    /// JS's events on the top host.
    pub(super) js: Option<EventMask>,
    /// The insets given it (the outer wins).
    inset_padding: Option<crate::EdgeInsets>,
    inset_margin: Option<crate::EdgeInsets>,
    /// Whether any view gives it anything besides styles.
    given: bool,
}

impl RootContext {
    /// `attrs` (a root's) with the insets given it.
    pub(super) fn over(&self, mut attrs: Attrs) -> Attrs {
        if let Some(insets) = self.inset_padding {
            attrs.inset_padding = Some(insets);
        }
        if let Some(insets) = self.inset_margin {
            attrs.inset_margin = Some(insets);
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
            root: None,
            js_children,
            children_at: Placement::None,
            children_wanted: false,
            slots: Vec::new(),
            handlers: Vec::new(),
            event_handlers: Vec::new(),
            responders: Vec::new(),
            app_style,
            dirty: false,
            bound: FxHashMap::default(),
            js_kids: None,
            cell_owner: None,
            row_index: None,
            lazy_wanted: None,
            children_owner: None,
            rooted: None,
            above: None,
            fills: Vec::new(),
            given: None,
            given_changed: false,
            root_insets_applied: (None, None),
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
pub(super) type AppClass = (Option<Arc<ClassList>>, SharedString, Option<Arc<ClassList>>);

/// The node's classes: its styles lowered, and what was merged after them.
pub(super) type Classes = (Option<Arc<ClassList>>, Option<Arc<ClassList>>);

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
    /// A list's layout.
    list: ListConfig,
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
            list: ListConfig::default(),
            part,
            children: Vec::new(),
        }
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
    /// A value read ([`crate::ui::AnimatedValue::value`]).
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
    /// The image, for an image read.
    pub(super) image: Option<crate::ui::ClipboardImage>,
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
                ("uri", crate::PayloadValue::Str(u)) => uri = Some(u.clone()),
                ("width", crate::PayloadValue::Number(n)) => width = *n,
                ("height", crate::PayloadValue::Number(n)) => height = *n,
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
        answer.image = uri
            .filter(|u| u.starts_with("data:") && crate::platform::clipboard::uri_within_limit(u))
            .map(|url| crate::ui::ClipboardImage {
                url,
                size: crate::geometry::Size::new(pixels(width), pixels(height)),
            });
        answer
    }
}

/// An HTTP request of a task in flight ([`Core::fetch_event`]).
struct PendingFetch {
    /// What arrived so far.
    response: crate::ui::HttpResponse,
    answer: AnswerSlot<Result<crate::ui::HttpResponse, String>>,
}

/// The core's component state.
pub(super) struct Components {
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
    /// Expanded node -> the host of the component whose view made it.
    pub(super) owners: FxHashMap<NodeId, NodeId>,
    /// Slot nodes (`componentSlot`) -> their slot's name.
    slot_names: FxHashMap<NodeId, Arc<str>>,
    /// Slot nodes in a host -> the host.
    pub(super) slot_hosts: FxHashMap<NodeId, NodeId>,
    styles: FxHashMap<StyleRefinement, Arc<ClassList>>,
    /// The styles a component on another's host gets from each above it,
    /// merged (by the lists', which the entry keeps).
    merges: FxHashMap<(usize, usize), [Arc<ClassList>; 3]>,
    /// While a view's slot content is matched: the nested component's host
    /// and the slot (its regions are the slot's).
    pub(super) filling: Option<(NodeId, &'static str)>,
    /// The lists components place (the glue's, of `Items` props) -> the
    /// row function the component's view gave last, and the number of rows
    /// its wrappers last saw.
    lists: FxHashMap<NodeId, (PlaceFn, u32)>,
    pub(super) environment: Environment,
    /// Runs the components' async tasks and timers.
    pub(super) executor: Rc<Executor>,
    /// The status bar's settings, shared by components, modules and tasks.
    pub(super) status_bars: crate::ui::status_bar::StatusBars,
    /// Dialogs components show, by id: their answers.
    dialogs: FxHashMap<u32, AnswerSlot<i32>>,
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
            crate::picker::PickRequest,
            AnswerSlot<Vec<crate::picker::PickedFile>>,
        ),
    >,
    next_pick: u32,
    /// Calls of the embedding app's functions (`nsh/host`), by request id:
    /// their answers.
    host_calls: FxHashMap<u64, AnswerSlot<Result<crate::JsonValue, String>>>,
    next_host_call: u64,
    /// URLs being opened (`openUrl`), by request id: their answers.
    url_opens: FxHashMap<u32, AnswerSlot<bool>>,
    /// Those not handed to the engine yet ([`Core::take_url_opens`]).
    url_requests: Vec<(u32, String)>,
    next_url_open: u32,
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
    /// ([`crate::ui::ElementRef::measure`]).
    pub(super) measures: Vec<(NodeId, AnswerSlot<Option<crate::Measurement>>)>,
    /// The components' own lists, by node.
    virtual_lists: FxHashMap<NodeId, VirtualListState>,
    /// Views JS made, waiting to be in the tree to make their view.
    waiting: Vec<NodeId>,
    /// The row counts the cells of views' lists read (their positions), by
    /// list, each under a root of its own that goes with the list.
    list_counts: FxHashMap<NodeId, (crate::ui::Owner, crate::ui::Signal<usize>)>,
    /// The layouts of views' lists with bound parts, as applied last.
    pub(super) list_layouts: FxHashMap<NodeId, ListConfig>,
    /// The insets screens and modals reported (`onInsets`).
    insets: FxHashMap<NodeId, EdgeInsets>,
    /// JS listens to the back button (`BackHandler`) on the root.
    js_back: bool,
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
    pub(super) runtime: crate::ui::Runtime,
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
    /// ([`crate::ui::Renderer`]).
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
            owners: FxHashMap::default(),
            slot_names: FxHashMap::default(),
            slot_hosts: FxHashMap::default(),
            styles: FxHashMap::default(),
            merges: FxHashMap::default(),
            filling: None,
            lists: FxHashMap::default(),
            environment: Environment::default(),
            executor: Rc::new(Executor::default()),
            status_bars: Default::default(),
            dialogs: FxHashMap::default(),
            next_dialog: 1,
            image_infos: FxHashMap::default(),
            next_image_info: 1,
            clipboard_reads: FxHashMap::default(),
            url_opens: FxHashMap::default(),
            url_requests: Vec::new(),
            next_url_open: 0,
            next_clipboard_read: 1,
            picks: FxHashMap::default(),
            next_pick: 1,
            host_calls: FxHashMap::default(),
            next_host_call: 1,
            fetches: FxHashMap::default(),
            fetch_requests: Vec::new(),
            next_fetch: 1,
            animations: FxHashMap::default(),
            measures: Vec::new(),
            virtual_lists: FxHashMap::default(),
            list_counts: FxHashMap::default(),
            waiting: Vec::new(),
            list_layouts: FxHashMap::default(),
            insets: FxHashMap::default(),
            js_back: false,
            js_keymap: Arc::new(crate::keymap::Keymap::default()),
            js_keys: false,
            touch: super::touch::TouchState::default(),
            services: Default::default(),
            // Odd: JS allocates the even ids (1 is the root).
            next_id: 3,
            dirty: Vec::new(),
            props: Vec::new(),
            runtime: crate::ui::Runtime::default(),
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
    pub(super) fn lowered(&mut self, style: &StyleRefinement) -> Arc<ClassList> {
        if style.is_bound() {
            return self.lowered(&style.static_part());
        }
        if let Some(list) = self.styles.get(style) {
            return list.clone();
        }
        if self.styles.len() >= STYLE_CACHE {
            self.styles.clear();
        }
        let list = Arc::new(style.lower());
        self.styles.insert(style.clone(), list.clone());
        list
    }
}

/// The inline style of `id`: the declarations of its `Style` prop, then
/// the animated values bound to it, then (on a host) the app's style.
fn inline_style(
    id: NodeId,
    inline: Option<&crate::StylePatch>,
    animated: &[(crate::StyleDecl, crate::ui::LiveNode)],
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

fn same(a: &Option<Arc<ClassList>>, b: &Option<Arc<ClassList>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

impl<M: TextEngine> Core<M> {
    /// The components this core can render (from `nsh-base` and the
    /// like), and the design tokens their sets bring
    /// ([`Registry::tokens_from`]); set before the first op.
    pub fn set_components(&mut self, registry: Registry) {
        if let Some(Ok(tokens)) = registry.tokens(None) {
            self.set_tokens(tokens);
        }
        self.components.registry = registry;
    }

    /// `uiTheme` on the root: the app's theme file (`nsh.json`), which the
    /// UI set that reads themes makes tokens of.
    pub(super) fn set_ui_theme(&mut self, json: &str) {
        match self.components.registry.tokens(Some(json)) {
            Some(Ok(tokens)) => self.set_tokens(tokens),
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

    /// The embedding app's design tokens (`None`: the app's again): an app
    /// embedded in a native app looks like it, whatever the app sets.
    pub fn set_host_tokens(&mut self, tokens: Option<Tokens>) {
        self.components.host_tokens = tokens.map(Arc::new);
        self.tokens_changed();
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
        let font = self
            .components
            .tokens
            .font(crate::ui::FONT_SANS)
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
        let mut el = root.element().0;
        let ElKind::Component(c) = std::mem::replace(&mut el.kind, ElKind::Plain) else {
            return log::error!("the root is not a component");
        };
        let id = self.components.alloc();
        let _ = self.apply_op(Op::Create { id, tag: el.tag });
        self.create_instance_of(id, c.name, c.make, c.spec);
        if let Some(inst) = self.components.instances.get_mut(&id)
            && let Inner::Component(inner) = &mut inst.inner
        {
            inner.set_props(c.props.as_any());
        }
        let _ = self.apply_op(Op::Insert {
            parent: ROOT_ID,
            child: id,
            before: None,
        });
        self.own_direction();
    }

    /// The environment components read ([`crate::ui::ambient::window`]
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

    /// The environment components read is now `environment`.
    pub(super) fn apply_environment(&mut self, environment: Environment) {
        let _entered = self.components.runtime.enter();
        let changed = self.components.environment != environment;
        let ratio = self.components.environment.pixel_ratio;
        self.components.environment = environment;
        if ratio != environment.pixel_ratio {
            self.repick_images(ratio, environment.pixel_ratio);
        }
        if changed {
            // What reads a part that changed runs again.
            self.components.runtime.set_environment(environment);
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
        self.components.executor.set_notify(notify);
    }

    /// The tokio runtime the components' tasks are polled in the context
    /// of (their timers, IO and background work run on it).
    pub fn set_task_runtime(&mut self, runtime: tokio::runtime::Handle) {
        self.components.executor.set_runtime(runtime);
    }

    /// When the components' soonest timer is due ([`crate::ui::timer`]):
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

    /// Whether `id` is a component's host.
    pub(super) fn is_host(&self, id: NodeId) -> bool {
        self.components.instances.contains_key(&id)
    }

    /// Ops from JS on a component's host take its place; others pass
    /// (`Some`).
    pub(super) fn intercept(&mut self, op: Op) -> Result<Option<Op>, ApplyError> {
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
                    Some(root) => (root.attrs.inline.clone(), root.attrs.animated.clone()),
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
                            inst.row_index.is_some() && inst.cell_owner.is_some_and(|o| o.is_live())
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
                    match inst.row_index {
                        // A view's wrapper keeps its content.
                        Some(row) if inst.cell_owner.is_some_and(|o| o.is_live()) => {
                            row.set(index as usize);
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
                match place {
                    // Before its next JS sibling, else before what the
                    // view puts after the children.
                    Placement::At(p, anchor) => {
                        let anchor = self.anchor_node(anchor);
                        self.apply_op(Op::Insert {
                            parent: p,
                            child,
                            before: at.and(before).or(anchor),
                        })?
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
                let base = self.base_of(id);
                let own = self.components.instances[&base]
                    .root
                    .as_ref()
                    .is_some_and(|r| r.events.contains(event));
                Ok(Some(Op::Listen {
                    id,
                    event,
                    enabled: enabled || own,
                }))
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
                // dropped) instead of unwinding through the engine.
                let result = match caught(|| run(&mut cx)) {
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
                    // A task of the root: it never goes away.
                    crate::ui::task::spawn_raw(
                        &self.components.executor,
                        ROOT_ID,
                        Box::pin(async move {
                            let result = crate::ui::module::catching(future).await;
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
    pub(super) fn set_user(&mut self, host: NodeId, user: Option<Arc<ClassList>>) {
        let inst = self.components.instances.get_mut(&host).expect("host");
        if !same(&inst.user, &user) {
            inst.user = user;
            self.components.mark(host);
        }
    }

    /// Slot node `id` leaves its host.
    fn unslot(&mut self, id: NodeId) {
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
            c.place(host, crate::ui::Owner::current());
        }
        let instance = Instance::new(inner, spec, Vec::new(), app_style);
        self.components.instances.insert(host, Box::new(instance));
        self.components.mark(host);
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
            if !changed && !rendered && !failed && !woke {
                break;
            }
        }
        self.flush_renders();
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
            if let Some(boundary) = crate::ui::reactive::boundary_of(owner) {
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
                &attrs.animated,
                app,
            ));
            let applied = inst.root_insets_applied;
            let insets = (
                cx.inset_padding.or(attrs.inset_padding),
                cx.inset_margin.or(attrs.inset_margin),
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
        }
    }

    /// Whether `host` is a component that runs once, made by JS (no owner
    /// placed it), whose view is not made yet, out of the tree.
    fn waits_for_tree(&self, host: NodeId) -> bool {
        let Some(inst) = self.components.instances.get(&host) else {
            return false;
        };
        let Inner::Component(inner) = &inst.inner else {
            return false;
        };
        inst.root.is_none() && !inner.failure_owner().is_live() && !self.id_in_tree(host)
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

    /// The owner of the nearest component above `host` in the tree (its
    /// view's, or a list cell's row), else none.
    fn owner_above(&self, host: NodeId) -> crate::ui::Owner {
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
        crate::ui::Owner::detached()
    }

    /// The host of the component that runs once whose owner is `owner`, or
    /// whose view made it (a binding's own owner is under the component's).
    fn host_of_owner(&self, owner: crate::ui::Owner) -> Option<NodeId> {
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
                if inst.root.is_some() {
                    self.restyle_view(host, inst);
                    return None;
                }
                inner.adopt(self.owner_above(host));
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
                let made = std::cell::Cell::new(None);
                let build = || {
                    let at = row_position(index, count, count_signal, &made);
                    view().child(place(Child::row(), at)).into_element().0
                };
                let el = self.build_cell(host, inst, build);
                inst.row_index = made.take();
                if let (Some(list), Some(index), Some(owner)) =
                    (list, inst.row_index, inst.cell_owner)
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
                    (
                        state.count as usize,
                        state.row.clone(),
                        state.separator.clone(),
                        state.rows.clone(),
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
                        inst.row_index = None;
                        ElNode::empty_view()
                    }
                    Some((count, row, separator, rows)) => {
                        let count_signal = Some(self.list_count(list, count));
                        let made = std::cell::Cell::new(None);
                        let build = || {
                            let at = row_position(index, count, count_signal, &made);
                            let row = row(at);
                            // Between rows: after each but the last (before
                            // it, inverted), while it is not.
                            let separator = separator.map(|s| {
                                crate::ui::when(move || !at.is_last(), move || s()).into_element()
                            });
                            match separator {
                                Some(s) if inverted => view().child(s).child(row),
                                Some(s) => view().child(row).child(s),
                                None => view().child(row),
                            }
                            .into_element()
                            .0
                        };
                        let el = self.build_cell(host, inst, build);
                        inst.row_index = made.take();
                        if let (Some(index), Some(owner)) = (inst.row_index, inst.cell_owner) {
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
    /// own (the previous row's goes), made under the list component's so the
    /// row sees its context.
    fn build_cell(
        &mut self,
        cell: NodeId,
        inst: &mut Instance,
        build: impl FnOnce() -> ElNode,
    ) -> Result<ElNode, String> {
        if let Some(owner) = inst.cell_owner.take() {
            owner.dispose();
        }
        let parent = self.cell_parent_owner(cell);
        let (owner, el) = parent.run(|| crate::ui::create_root(|| caught(build)));
        inst.cell_owner = Some(owner);
        el
    }

    /// The owner of the component whose list cell `cell` is in.
    fn cell_parent_owner(&self, cell: NodeId) -> crate::ui::Owner {
        let component = self
            .list_of(cell)
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
        component.unwrap_or_else(crate::ui::Owner::detached)
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
                    e.attrs, e.style, e.classes, e.events, e.children, e.text, e.list,
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
        (old_over.inset_padding, old_over.inset_margin) = inst.root_insets_applied;
        self.apply_attrs_over(host, &attrs, &old_over, app);
        inst.root_insets_applied = (attrs.inset_padding, attrs.inset_margin);
        // Given an inline style or animated values while its own did not
        // change: they go now.
        let given_changed = std::mem::take(&mut inst.given_changed) || first;
        if cx.given
            && given_changed
            && attrs.inline == old_over.inline
            && attrs.animated == old_over.animated
        {
            let _ = self.apply_op(inline_style(
                host,
                attrs.inline.as_deref(),
                &attrs.animated,
                app,
            ));
        }
        let user = cx.user.clone();
        let top_js = cx.js;
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
        // The host listens to its component's events and to JS's.
        let js = top_js.unwrap_or(inst.js_events);
        self.apply_handlers(host, &el, old_events | js, js, inst);
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
                self.update_virtual_list(self.native_id(host), host, *list, &old_list);
                (config, Part::VirtualList)
            }
            _ => (ListConfig::default(), Part::Node),
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
                self.create_instance_of(id, c.name, c.make, c.spec);
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
            inset_padding: None,
            inset_margin: None,
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
            decls.extend(given.animated.iter().map(|(d, _)| d.clone()));
            cx.inset_padding = given.inset_padding.or(cx.inset_padding);
            cx.inset_margin = given.inset_margin.or(cx.inset_margin);
        };
        if let Some(given) = &inst.given {
            take(&mut cx, given);
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
            at = above.above;
            if let Some(given) = &given {
                take(&mut cx, given);
            }
            cx.user = self.merge_user(cx.user.take(), outer);
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
        attrs.element_ref = None;
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
        inner: Option<Arc<ClassList>>,
        outer: Option<Arc<ClassList>>,
    ) -> Option<Arc<ClassList>> {
        match (inner, outer) {
            (Some(a), Some(b)) => {
                let key = (Arc::as_ptr(&a) as usize, Arc::as_ptr(&b) as usize);
                if let Some([_, _, merged]) = self.components.merges.get(&key) {
                    return Some(merged.clone());
                }
                if self.components.merges.len() >= STYLE_CACHE {
                    self.components.merges.clear();
                }
                let merged = Arc::new(a.merged(&b));
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
                // none made no signal).
                Some(_) => {
                    if let Some(signal) = inst.lazy_wanted {
                        signal.set(wanted);
                    }
                }
                None => self.events.push(JsEvent::Children { host, wanted }),
            }
        }
    }

    /// The signal of whether the component hosted by `nested` places its
    /// lazy children, made under the current owner (the view passing them)
    /// the first time.
    fn children_wanted_signal(&mut self, nested: NodeId) -> crate::ui::Signal<bool> {
        let Some(inst) = self.components.instances.get_mut(&nested) else {
            return crate::ui::signal(false);
        };
        *inst
            .lazy_wanted
            .get_or_insert_with(|| crate::ui::signal(inst.children_wanted))
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
        if let Ok(key) = self.key(id)
            && self.nodes[key as usize].parent != NO_KEY
        {
            self.detach(key);
        }
    }

    fn apply_attrs(&mut self, id: NodeId, new: &Attrs, old: &Attrs) {
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
        if old.element_ref != new.element_ref
            && let Some(r) = &old.element_ref
        {
            r.detach(node);
        }
        if let Some(r) = &new.element_ref {
            r.attach(node);
        }
        if new.render != old.render {
            self.update_render(node, old.render.as_ref(), new.render.as_ref());
        }
        let mut props = std::mem::take(&mut self.components.props);
        new.changes(old, &mut props);
        for prop in props.drain(..) {
            let _ = self.apply_op(Op::SetProp { id, prop });
        }
        self.components.props = props;
        if new.inline != old.inline || new.animated != old.animated {
            let _ = self.apply_op(inline_style(id, new.inline.as_deref(), &new.animated, app));
        }
        if new.drawing != old.drawing
            && let Some(drawing) = &new.drawing
        {
            let _ = self.apply_op(Op::Draw {
                id,
                drawing: Box::new((**drawing).clone()),
            });
        }
    }

    /// Sets node `id`'s classes: `style` lowered, then `user` (a host's).
    pub(super) fn apply_styles(
        &mut self,
        id: NodeId,
        style: &StyleRefinement,
        old_style: &StyleRefinement,
        old: Classes,
        user: Option<Arc<ClassList>>,
    ) -> Classes {
        let own = if style == old_style {
            old.0.clone()
        } else if style.is_empty() {
            None
        } else {
            Some(self.components.lowered(style))
        };
        if !same(&own, &old.0) || !same(&user, &old.1) {
            let list = match (&own, &user) {
                (Some(a), Some(b)) => Some(Arc::new(a.merged(b))),
                (Some(a), None) => Some(a.clone()),
                (None, Some(b)) => Some(b.clone()),
                (None, None) => None,
            };
            if let Ok(key) = self.key(id) {
                self.set_class_list(key, list);
            }
        }
        (own, user)
    }

    /// [`Self::apply_styles`] for an element of a view: the app's classes
    /// it carries (`class`, [`crate::ui::Element::app_class`]) go after its
    /// own styles, then `outer` (a root's: what the views and the app give
    /// its host).
    pub(super) fn apply_el_styles(
        &mut self,
        id: NodeId,
        style: &StyleRefinement,
        old_style: &StyleRefinement,
        old: Classes,
        class: Option<&SharedString>,
        outer: Option<Arc<ClassList>>,
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
    pub(super) fn app_class_list(&mut self, class: &str) -> Arc<ClassList> {
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
    fn apply_handlers(
        &mut self,
        id: NodeId,
        el: &ElNode,
        old: EventMask,
        extra: EventMask,
        inst: &mut Instance,
    ) -> EventMask {
        let mut mask = extra;
        // A node made again (its region ran again) hears what this run
        // gives it, not also what the runs before gave it.
        if old.bits() != 0 {
            inst.handlers.retain(|(n, _, _)| *n != id);
            inst.responders.retain(|(n, _)| *n != id);
        }
        for (kind, handler) in &el.handlers {
            mask.set(*kind, true);
            inst.handlers.push((id, *kind, handler.clone()));
        }
        // The responder hears the touches the platform reports.
        if let Some(responder) = &el.responder {
            mask.set(EventKind::Touch, true);
            inst.responders.push((id, responder.clone()));
        }
        // Only the events that changed.
        let mut changed = mask.bits() ^ old.bits();
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
        let new = new.into_iter().map(|el| (None, el)).collect();
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
            self.place_before(parent, &wanted_ids, None);
        }
        out
    }

    /// Matches `new` (each made under its owner, when it has one) with the
    /// `old` elements of `parent` and applies them; releases the old ones
    /// left. The elements as applied, and where the JS children go among
    /// them.
    pub(super) fn match_children(
        &mut self,
        parent: NodeId,
        old: Vec<Expanded>,
        new: Vec<(Option<crate::ui::Owner>, ElNode)>,
        host: NodeId,
        inst: &mut Instance,
    ) -> (Vec<Expanded>, Option<usize>) {
        // `children_each`: one wrapper per JS child, keyed by it; in a view,
        // a region following them.
        let new = if new
            .iter()
            .any(|(_, e)| matches!(e.kind, ElKind::EachChild(_)))
        {
            let mut each = Vec::with_capacity(new.len() + inst.js_children.len());
            for (owner, el) in new {
                let ElKind::EachChild(place) = &el.kind else {
                    each.push((owner, el));
                    continue;
                };
                if inst.children_at != Placement::None {
                    log::error!(target: "js", "a view places its children once");
                    continue;
                }
                inst.children_at = Placement::Each;
                {
                    let children = *inst.js_kids.get_or_insert_with(|| {
                        crate::ui::signal_with(
                            inst.js_children.clone(),
                            crate::ui::SignalEquals::Never,
                        )
                    });
                    // A wrapper per child, kept while the child stays; its
                    // position follows it.
                    let place = place.clone();
                    let count = crate::ui::computed(move || children.with(Vec::len));
                    let region = crate::ui::each(
                        children,
                        |&child: &NodeId| child,
                        move |child, index| {
                            let at = Position::of(index.node(), count.node());
                            place(Child::js(child.get_untracked()), at)
                        },
                    );
                    each.push((owner, region.0));
                }
            }
            each
        } else {
            new
        };
        let mut old: Vec<Option<Expanded>> = old.into_iter().map(Some).collect();
        // Old positions stay authoritative: other branches can consume a
        // candidate too. Duplicate keys retain their original FIFO order.
        let mut keyed: FxHashMap<SharedString, VecDeque<usize>> = FxHashMap::default();
        for (index, entry) in old.iter().enumerate() {
            if let Some(key) = entry.as_ref().and_then(|entry| entry.key.as_ref()) {
                keyed.entry(key.clone()).or_default().push_back(index);
            }
        }

        let mut out = Vec::with_capacity(new.len());
        let mut placeholder = None;
        // Unkeyed elements take the next unused old element of their kind,
        // in order: an element that comes or goes (`.children(option)`)
        // does not shift its siblings onto new nodes.
        let mut cursor = 0;
        for (owner, el) in new {
            let child = |core: &mut Self| {
                core.match_child(
                    parent,
                    el,
                    host,
                    inst,
                    &mut old,
                    &mut keyed,
                    &mut out,
                    &mut placeholder,
                    &mut cursor,
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
        keyed: &mut FxHashMap<SharedString, VecDeque<usize>>,
        out: &mut Vec<Expanded>,
        placeholder: &mut Option<usize>,
        cursor: &mut usize,
    ) {
        // A slot a view fills: placed as it is (`Filled`), or in a node of
        // this view's own when the view styles it.
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
                    .map(|c| (None, c))
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
                out.push(self.reconcile_slot(prev, node, el, inst));
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
                inst.children_owner = Some(crate::ui::Owner::current());
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
                // keeps the row finds it by that key (`ElKind::Keep`).
                e.key = el.key;
                out.push(e);
            }
            // An `Each` row that stays: as it was.
            ElKind::Keep => {
                let kept = el.key.as_ref().and_then(|key| {
                    let candidates = keyed.get_mut(key)?;
                    while let Some(index) = candidates.pop_front() {
                        if old[index].is_some() {
                            return Some(index);
                        }
                    }
                    None
                });
                match kept.and_then(|at| old[at].take()) {
                    Some(e) => out.push(e),
                    None => log::error!("a kept row is gone"),
                }
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
                let old_config = prev.as_ref().map(|p| p.list).unwrap_or_default();
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
                let mut e = self.reconcile_slot(prev, node, el, inst);
                e.list = config;
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
                    Some(key) => keyed.get(key).and_then(|candidates| {
                        candidates
                            .iter()
                            .copied()
                            .find(|&index| old[index].as_ref().is_some_and(matches))
                    }),
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
                out.push(self.reconcile_node(prev, el, part, host, inst));
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

    /// Place this batch before an anchor using the current physical sibling
    /// order. The temporary lookup is refreshed only after a real insertion;
    /// Insert remains the authority for moves, aliases and invalid operations.
    pub(super) fn place_before(
        &mut self,
        parent: NodeId,
        nodes: &[NodeId],
        mut before: Option<NodeId>,
    ) {
        if nodes.is_empty() {
            return;
        }
        let order = |core: &Self, next: &mut FxHashMap<NodeId, Option<NodeId>>| {
            next.clear();
            if let Ok(parent) = core.key(parent) {
                let children = &core.nodes[parent as usize].children;
                next.reserve(children.len());
                for (index, &child) in children.iter().enumerate() {
                    next.insert(
                        core.nodes[child as usize].id,
                        children
                            .get(index + 1)
                            .map(|&next| core.nodes[next as usize].id),
                    );
                }
            }
        };
        let mut next = FxHashMap::default();
        order(self, &mut next);
        for &child in nodes.iter().rev() {
            // An absent child is not the last child, even with no anchor.
            if next.get(&child) != Some(&before)
                && self
                    .apply_op(Op::Insert {
                        parent,
                        child,
                        before,
                    })
                    .is_ok()
            {
                order(self, &mut next);
            }
            // A rejected Insert still resolves the next child's anchor in
            // the same way as the original reverse-placement sequence.
            before = Some(child);
        }
    }

    /// Slot node `node` as element `el`: its styles, props and handlers
    /// (its children are the app's JSX).
    fn reconcile_slot(
        &mut self,
        prev: Option<Expanded>,
        node: NodeId,
        mut el: ElNode,
        inst: &mut Instance,
    ) -> Expanded {
        el.resolve_once();
        let (old_attrs, old_style, old_classes, old_events) = match prev {
            Some(p) => (p.attrs, p.style, p.classes, p.events),
            None => (
                Attrs::default(),
                StyleRefinement::default(),
                (None, None),
                EventMask::default(),
            ),
        };
        self.apply_attrs(node, &el.attrs, &old_attrs);
        let classes = self.apply_el_styles(
            node,
            &el.style,
            &old_style,
            old_classes,
            el.attrs.class.as_ref(),
            None,
        );
        // Its events are the component's first (`component_event` finds it
        // by its host); the node stays JS's or the placing view's.
        let events = self.apply_handlers(node, &el, old_events, EventMask::default(), inst);
        Expanded {
            id: node,
            tag: Tag::View,
            key: None,
            text: None,
            attrs: el.attrs,
            style: el.style,
            classes,
            events,
            list: ListConfig::default(),
            part: Part::Slot,
            children: Vec::new(),
        }
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
        let old_list = prev.as_ref().map(|p| p.list).unwrap_or_default();
        let kept = prev.is_some();
        let (id, old_attrs, old_style, old_classes, old_events, old_children, old_text) = match prev
        {
            Some(p) => (
                p.id, p.attrs, p.style, p.classes, p.events, p.children, p.text,
            ),
            None => {
                let id = self.components.alloc();
                let _ = self.apply_op(Op::Create { id, tag: el.tag });
                self.components.owners.insert(id, host);
                if let ElKind::Component(c) = &el.kind {
                    self.create_instance_of(id, c.name, c.make, c.spec);
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
        let bound = bound.map(|bound| self.bind_parts(host, id, bound, &mut el));
        let (component, virtual_list) = match std::mem::replace(&mut el.kind, ElKind::Plain) {
            ElKind::Component(c) => (Some(c), None),
            ElKind::VirtualList(list) => (None, Some(list)),
            _ => (None, None),
        };
        if let Some(c) = component {
            // A nested component: its props, and the styles as the app's
            // classes of its host.
            if let Some(nested) = self.components.instances.get_mut(&id)
                && let Inner::Component(inner) = &mut nested.inner
            {
                inner.set_props(c.props.as_any());
            }
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
            inst.event_handlers
                .extend(c.on_event.into_iter().map(|listener| (id, listener)));
            // Its `ComponentRef`.
            let element_ref = el.attrs.element_ref.take();
            if old_attrs.element_ref != element_ref
                && let Some(r) = &old_attrs.element_ref
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
                    let shown = crate::ui::when(wanted, move || {
                        kids.iter()
                            .cloned()
                            .map(crate::ui::AnyElement)
                            .collect::<Vec<_>>()
                    });
                    content.push(shown.into_element().0);
                }
            }
            let children = self.reconcile_children(id, old_children, content, host, inst);
            return Expanded {
                id,
                tag: el.tag,
                key: el.key,
                text: None,
                attrs: Attrs {
                    element_ref,
                    ..Attrs::default()
                },
                style: el.style,
                classes: (None, None),
                events: EventMask::default(),
                list: ListConfig::default(),
                part,
                children,
            };
        }
        self.apply_attrs(id, &el.attrs, &old_attrs);
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
        let events = self.apply_handlers(id, &el, old_events, EventMask::default(), inst);
        let new_children = std::mem::take(&mut el.children);
        let children = self.reconcile_children(id, old_children, new_children, host, inst);
        let list = match virtual_list {
            Some(list) => {
                let config = list.config;
                self.update_virtual_list(id, host, *list, &old_list);
                config
            }
            None => ListConfig::default(),
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
            list: ListConfig::default(),
            part: Part::Raw,
            children: Vec::new(),
        }
    }

    /// A view's list of its own rows: its layout, its rows (a splice when
    /// the keys say rows came or went, then the count), and its live cells
    /// built again with the new row function (when the list is made
    /// again). A bound count or keys are a binding: a memo that, before the
    /// rows' own bindings run, moves the live cells' indices as the rows
    /// moved (dropping the content of cells whose row went) and queues the
    /// change for the list ([`Self::set_list_rows`]).
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
                row: list.row.clone(),
                count: 0,
                keys: None,
                separator: None,
                cells: Vec::new(),
                rows: CellRows::default(),
                items,
                place: None,
                contents: Vec::new(),
                min_view: None,
                reported: None,
                latest: None,
                report: None,
            });
        let cells = state.rows.clone();
        let bound = matches!(list.count, Reactive::Bound(_)) || list.keys.is_some();
        let (count, keys) = (list.count, list.keys);
        let rows = move || (count.get(), keys.as_ref().map(|k| k()));
        let (count, keys) = if bound {
            let count_signal = self.list_count(id, 0);
            let patches = self.components.patches.clone();
            let first: Rc<RefCell<Option<Rows>>> = Rc::default();
            let slot = first.clone();
            let last: RefCell<Option<Rc<[u64]>>> = RefCell::new(None);
            let made = std::cell::Cell::new(false);
            crate::ui::computed(move || {
                let (count, keys) = rows();
                let splice = match (&*last.borrow(), &keys) {
                    (Some(old), Some(new)) => crate::ui::virtual_list::splice(old, new),
                    _ => None,
                };
                last.replace(keys.clone());
                if made.replace(true) {
                    move_rows(&cells, splice, count);
                    count_signal.set(count as usize);
                    patches.borrow_mut().push(super::views::Patch::Rows {
                        list: id,
                        count,
                        keys,
                    });
                } else {
                    count_signal.set(count as usize);
                    *slot.borrow_mut() = Some((count, keys));
                }
            });
            first.take().expect("a memo runs when it is made")
        } else {
            let (count, keys) = crate::ui::untracked(rows);
            // What the cells of a view (or a view's wrappers) read.
            {
                self.list_count(id, count as usize).set(count as usize);
            }
            (count, keys)
        };
        self.send_list_rows(id, before.as_ref(), count, keys.as_ref());
        if before.is_none()
            && let Some(index) = list.initial_index
        {
            let _ = self.apply_op(Op::Command {
                id,
                command: Command::ScrollToIndex {
                    index,
                    animated: false,
                    automatic: false,
                    view_position: crate::geometry::Percentage(0.0),
                    view_offset: Points::ZERO,
                },
            });
        }
        let state = self.components.virtual_lists.get_mut(&id).expect("list");
        state.row = list.row;
        state.count = count;
        state.keys = keys;
        state.separator = list.separator;
        state.min_view = list.min_view_time;
        let marked: Vec<NodeId> = state
            .cells
            .iter()
            .chain(&state.contents)
            .copied()
            .filter(|&c| c != 0)
            .collect();
        for cell in marked {
            self.components.mark(cell);
        }
    }

    /// Sends list `id` its rows' changes from `before` (none: a new list):
    /// a splice when the keys say rows came or went, then the count.
    fn send_list_rows(
        &mut self,
        id: NodeId,
        before: Option<&Rows>,
        count: u32,
        keys: Option<&Rc<[u64]>>,
    ) {
        if let (Some((_, Some(old))), Some(new)) = (before, keys)
            && let Some((at, removed, inserted)) = crate::ui::virtual_list::splice(old, new)
        {
            let _ = self.apply_op(Op::SetProp {
                id,
                prop: Prop::Splice(at, removed, inserted),
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
        let parts: Vec<NodeId> = state
            .cells
            .iter()
            .chain(&state.contents)
            .copied()
            .filter(|&c| c != 0)
            .collect();
        for part in parts {
            let Some(inst) = self.components.instances.get_mut(&part) else {
                continue;
            };
            let Some(signal) = inst.row_index else {
                continue;
            };
            let live = inst.cell_owner.is_some_and(|o| o.is_live());
            if let Inner::VirtualRow { index, .. } | Inner::Row { index, .. } = &mut inst.inner {
                *index = if live {
                    signal.get_untracked()
                } else {
                    usize::MAX
                };
            }
            if !live {
                self.components.mark(part);
            }
        }
    }

    /// The row count the cells of list `list` read, made with `count` the
    /// first time.
    fn list_count(&mut self, list: NodeId, count: usize) -> crate::ui::Signal<usize> {
        if let Some(&(_, signal)) = self.components.list_counts.get(&list) {
            return signal;
        }
        let made = crate::ui::Owner::detached()
            .run(|| crate::ui::create_root(|| crate::ui::signal(count)));
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
                if self.current_list_bind(bind.list, slot, index) {
                    self.bind_virtual_cell(bind.list, slot as usize, index as usize);
                }
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
                        if let Some(row) = inst.row_index
                            && inst.cell_owner.is_some_and(|o| o.is_live())
                        {
                            row.set(index);
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
                state.report = Some(crate::ui::task::act_after(
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
        self.components.owners.remove(&id);
        self.forget_node_extras(id);
        // A root component's host is its view's: only the name goes.
        if self.is_alias(id) {
            self.unalias(id);
            return;
        }
        let _ = self.apply_op(Op::Release { id });
    }

    /// Frees an expanded element and what it rendered (a slot's node is
    /// JS's: it only leaves the tree).
    pub(super) fn release_expanded(&mut self, e: Expanded) {
        match e.part {
            Part::Slot => {
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
            Part::Node => {}
        }
        if let Some(r) = &e.attrs.element_ref {
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
    fn release_instance(&mut self, host: NodeId) {
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
            if let Some(r) = &root.attrs.element_ref {
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
        let handled = self.dispatch_event(id, kind, payload);
        // What views' listeners emitted reaches its listeners in this turn.
        loop {
            let emits = self.components.runtime.take_emits();
            if emits.is_empty() {
                break;
            }
            for (host, event) in emits {
                self.route_emit(host, event);
            }
        }
        handled
    }

    fn dispatch_event(&mut self, id: NodeId, kind: EventKind, payload: &EventPayload) -> bool {
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
        if matches!(kind, EventKind::HoverIn | EventKind::HoverOut) {
            self.overlay_hover(id, kind);
        }
        if self.platform_event(id, kind, payload) {
            return true;
        }
        if self.is_host(id) {
            // The component whose view makes the host's node handles them.
            let base = self.base_of(id);
            return self.handle(base, base, kind, payload);
        }
        // A component's own list reports its viewable rows as they settle.
        if kind == EventKind::ViewableItemsChange && self.components.virtual_lists.contains_key(&id)
        {
            self.viewable_changed(id, payload);
            return true;
        }
        // A slot's node: the component it is a slot of handles its events,
        // then whoever made it: the component whose view has it, or JS (the
        // app's list of an `Items` prop has the app's handlers).
        let slot_of = self.components.slot_hosts.get(&id).copied();
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
        inst.handlers
            .iter()
            .enumerate()
            .skip(from)
            .find(|(_, (n, k, _))| *n == id && *k == kind)
            .map(|(at, (_, _, l))| (at, l.clone()))
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
    /// above it shows it ([`crate::ui::catch_error`]); else it is reported.
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
        match owner.and_then(crate::ui::reactive::boundary_of) {
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

    /// What a component or a task asked of the platform.
    fn apply_action(&mut self, action: Action) {
        match action {
            Action::Command(id, command) => {
                let _ = self.apply_op(Op::Command { id, command });
            }
            Action::Dialog(mut dialog, answer) => {
                dialog.id = self.components.next_dialog;
                self.components.next_dialog += 1;
                self.components.dialogs.insert(dialog.id, answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::Dialog(Box::new(dialog)),
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
            Action::Measure(id, answer) => self.components.measures.push((id, answer)),
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
                        response: crate::ui::HttpResponse::default(),
                        answer,
                    },
                );
                self.components.fetch_requests.push((id, *request));
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
                    crate::ui::task::spawn_raw(
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
                self.components.picks.insert(id, (request, answer));
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::PickImages { id, request },
                });
            }
            Action::ReadClipboard(read) => {
                let id = self.components.next_clipboard_read;
                self.components.next_clipboard_read += 1;
                let command = match &read {
                    ClipboardRead::Text(_) => Command::ReadClipboard {
                        id,
                        has_only: false,
                    },
                    ClipboardRead::Has(_) => Command::ReadClipboard { id, has_only: true },
                    ClipboardRead::Image(_) => Command::ReadClipboardImage {
                        id,
                        has_only: false,
                    },
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
            Action::HostCall { name, args, answer } => {
                if !self.components.environment.host {
                    answer
                        .borrow_mut()
                        .deliver(Err(crate::runtime::host::NO_HOST.into()));
                    return;
                }
                let id = self.components.next_host_call;
                self.components.next_host_call += 1;
                self.components.host_calls.insert(id, answer);
                let _ = self.apply_op(Op::Command {
                    id: crate::ROOT_ID,
                    command: Command::HostCall { id, name, args },
                });
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
                    self.deny(crate::open_url::not_granted(&url));
                    return;
                }
                let id = self.components.next_url_open;
                self.components.next_url_open = id.wrapping_add(1);
                self.components.url_opens.insert(id, answer);
                self.components.url_requests.push((id, url));
            }
        }
    }

    /// Native animations that ended: the components' resolve their
    /// [`crate::ui::AnimationEnd`]s; JS's stay in `finished`.
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

    /// Moves the URLs the app asked to open (`openUrl`, [`crate::ui::open_url`])
    /// since the last call to `out`, by request id, checked and granted
    /// ([`crate::open_url`]). The engine asks the embedding app first, then
    /// answers each with [`Core::answer_open_url`] (the embedding app took
    /// it) or [`Core::open_url_on_platform`].
    pub fn take_url_opens(&mut self, out: &mut Vec<(u32, String)>) {
        out.append(&mut self.components.url_requests);
    }

    /// Answers URL request `id`: whether the URL opened.
    pub fn answer_open_url(&mut self, id: u32, opened: bool) {
        if let Some(answer) = self.components.url_opens.remove(&id) {
            answer.borrow_mut().deliver(opened);
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
                    pending.answer.borrow_mut().deliver(Err(error));
                }
                return false;
            }
        }
        true
    }

    /// Resolves clipboard read `id` with the platform's answer (an empty
    /// one when the clipboard is not granted).
    pub(super) fn answer_clipboard(&mut self, id: u32, answer: ClipboardAnswer) {
        let ClipboardAnswer {
            has,
            text,
            image,
            files,
        } = answer;
        match self.components.clipboard_reads.remove(&id) {
            Some(ClipboardRead::Text(slot)) => slot.borrow_mut().deliver(text.unwrap_or_default()),
            Some(ClipboardRead::Has(slot) | ClipboardRead::HasImage(slot)) => {
                slot.borrow_mut().deliver(has)
            }
            Some(ClipboardRead::Image(slot)) => slot
                .borrow_mut()
                .deliver(image.filter(|i| !i.url.is_empty())),
            Some(ClipboardRead::Files(slot)) => slot.borrow_mut().deliver(files),
            None => {}
        }
    }

    /// The answer to host call `id`: the host's value, or its error. A
    /// call that timed out (`runtime/host.rs`) takes none: its late answer
    /// is dropped.
    pub(super) fn answer_host(&mut self, id: u64, result: Result<crate::JsonValue, String>) {
        match self.components.host_calls.remove(&id) {
            Some(answer) if std::rc::Rc::strong_count(&answer) > 1 => {
                answer.borrow_mut().deliver(result);
            }
            _ => {
                log::debug!(target: "js", "nsh/host: dropped the answer to call {id}, which no longer waits")
            }
        }
    }

    /// Events the components handle before anything else: dialog answers
    /// (theirs never reach JS), insets of screens and modals.
    fn platform_event(&mut self, id: NodeId, kind: EventKind, payload: &EventPayload) -> bool {
        let number = |key: &str| match payload {
            EventPayload::Map(entries) => entries.iter().find_map(|(k, v)| match v {
                crate::PayloadValue::Number(n) if *k == key => Some(*n),
                _ => None,
            }),
            _ => None,
        };
        match kind {
            EventKind::Dialog => {
                let Some(dialog) = number("id") else {
                    return false;
                };
                let Some(answer) = self.components.dialogs.remove(&(dialog as u32)) else {
                    return false;
                };
                answer
                    .borrow_mut()
                    .deliver(number("index").unwrap_or(-1.0) as i32);
                true
            }
            // A view's shortcut runs here; JS's go to JS.
            EventKind::KeyCommand if id == crate::ROOT_ID => {
                let EventPayload::Value(crate::PayloadValue::Number(binding)) = payload else {
                    return false;
                };
                let binding = *binding as u32;
                if binding < crate::ui::keys::FIRST_ID {
                    return false;
                }
                if binding == super::overlay::ESCAPE_BINDING {
                    self.overlay_cancel();
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
            EventKind::Pick if id == crate::ROOT_ID => {
                let EventPayload::Picked { id: request, files } = payload else {
                    return false;
                };
                if let Some((asked, answer)) = self.components.picks.remove(request) {
                    let files = crate::picker::finish(&asked, files.clone());
                    answer.borrow_mut().deliver(files);
                }
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
            EventKind::Clipboard if id == crate::ROOT_ID => {
                let Some(request) = number("id") else {
                    return false;
                };
                let answer = ClipboardAnswer::from_payload(payload);
                self.answer_clipboard(request as u32, answer);
                true
            }
            // The host's replies; its events go on to `nsh/host`'s
            // listeners (`nsh-js`).
            EventKind::Host if id == crate::ROOT_ID => {
                let EventPayload::Json(reply) = payload else {
                    return false;
                };
                if reply.get("type").and_then(crate::JsonValue::as_str) != Some("reply") {
                    return false;
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
                    Err(reply
                        .get("error")
                        .and_then(crate::JsonValue::as_str)
                        .unwrap_or("nsh/host: the call failed")
                        .to_owned())
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
    fn back_pressed(&mut self, listener: &crate::ui::BackListener) -> bool {
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

    /// The root's shortcuts follow the views' bindings coming and going:
    /// the table JS's and theirs make, listened to while either has one.
    pub(super) fn sync_keys(&mut self) {
        let rust = {
            let mut keys = self.components.executor.keys.borrow_mut();
            if !std::mem::take(&mut keys.changed) {
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
            enabled: rust || self.components.js_keys || self.overlay_state.cancel,
        });
    }

    /// The surface's table: JS's bindings, then the views' (the newest that
    /// may fire wins, so a view's wins over JS's of the same keystroke).
    fn keymap(&self) -> Arc<crate::keymap::Keymap> {
        let keys = self.components.executor.keys.borrow();
        let overlay = self.overlay_key_binding();
        if keys.list.is_empty() && overlay.is_none() {
            return self.components.js_keymap.clone();
        }
        let bindings = self
            .components
            .js_keymap
            .bindings()
            .iter()
            .copied()
            .chain(keys.list.iter().map(|k| k.binding))
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
        event: Box<dyn crate::ui::element::AnyEvent>,
    ) {
        match self.components.owners.get(&host).copied() {
            Some(parent) => {
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
                    if !self.run_listener(parent, &listener, event.as_any()) {
                        break;
                    }
                }
            }
            None => {
                self.events.push(JsEvent::Component { host, event });
            }
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

/// Moves the live cells of a view's list as its rows moved (`splice`, now
/// `count` rows): each keeps its row, at the row's new index. A cell whose
/// row went keeps its index (the list frees it, and binds it to another row
/// before showing it again) while that is a row; past the rows, its content
/// is disposed, before its bindings could read there.
fn move_rows(cells: &CellRows, splice: Option<(u32, u32, u32)>, count: u32) {
    let parts: Vec<_> = cells
        .borrow()
        .iter()
        .map(|(&id, &(index, owner))| (id, index, owner))
        .collect();
    let mut gone = Vec::new();
    for (id, index, owner) in parts {
        if !owner.is_live() {
            gone.push(id);
            continue;
        }
        let i = index.get_untracked();
        let to = match splice {
            Some((at, removed, inserted)) => {
                let (at, removed, inserted) = (at as usize, removed as usize, inserted as usize);
                if i < at || (at..at + removed).contains(&i) {
                    i
                } else {
                    i - removed + inserted
                }
            }
            None => i,
        };
        if to < count as usize {
            index.set(to);
        } else {
            owner.dispose();
            gone.push(id);
        }
    }
    let mut cells = cells.borrow_mut();
    for id in gone {
        cells.remove(&id);
    }
}

/// The position of row `index` of `count` that a cell's content reads: in a
/// view (`count_signal`), its index a signal of the cell's (handed back in
/// `made`) and the list's count; else fixed.
fn row_position(
    index: usize,
    count: usize,
    count_signal: Option<crate::ui::Signal<usize>>,
    made: &std::cell::Cell<Option<crate::ui::Signal<usize>>>,
) -> Position {
    match count_signal {
        Some(count) => {
            let index = crate::ui::signal(index);
            made.set(Some(index));
            Position::of(index.node(), count.node())
        }
        None => Position::fixed(index, count),
    }
}

/// A pixel count a platform reports as a number (whole for what it
/// decodes).
fn pixels(n: f64) -> crate::geometry::DevicePixels {
    crate::geometry::DevicePixels(n.round() as i32)
}
