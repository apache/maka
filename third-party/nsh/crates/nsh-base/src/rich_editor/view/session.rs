//! [`EditorSession`]: the one live editor a `RichEditor` view and the app's
//! code share. It holds the current [`EditorState`], applies transactions
//! (or hands them to the app's `dispatch_transaction`), runs commands and
//! tells subscribers about each new state. The view is one subscriber; JS's
//! class over the session is another.

use std::{
    collections::HashMap,
    fmt,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use nsh_core::{
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, TsTypes},
    prelude::*,
};
use serde_json::{Value, json};

use super::node_view::NodeView;
use crate::rich_editor::{
    commands::{BoxCommand, helpers, tiptap::FOCUS_META},
    model::Attrs,
    state::{EditorState, StateError, Transaction, TransactionOrigin},
    transform::Mapping,
};

/// What a session tells its event listeners about ([`EditorSession::on`]),
/// after the fact: Tiptap's editor events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionEventKind {
    /// The document changed (`{ revision }`).
    Update,
    /// The selection changed (`{ anchor, head, from, to, empty }`).
    SelectionUpdate,
    /// A transaction applied (`{ origin, docChanged, meta, steps }`, `meta`
    /// the keys of its metadata).
    Transaction,
    /// A view of the session took the focus (`{}`).
    Focus,
    /// The views of the session lost the focus (`{}`).
    Blur,
    /// A transaction removed content (`{ from, to, newFrom, newTo }`:
    /// positions before the transaction and where they map to after).
    Delete,
}

impl SessionEventKind {
    /// Every kind.
    pub const ALL: [SessionEventKind; 6] = [
        Self::Update,
        Self::SelectionUpdate,
        Self::Transaction,
        Self::Focus,
        Self::Blur,
        Self::Delete,
    ];

    /// Its name, Tiptap's (`update`, `selectionUpdate`, ...).
    pub fn name(self) -> &'static str {
        match self {
            Self::Update => "update",
            Self::SelectionUpdate => "selectionUpdate",
            Self::Transaction => "transaction",
            Self::Focus => "focus",
            Self::Blur => "blur",
            Self::Delete => "delete",
        }
    }

    /// The kind named `name`.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }
}

/// An event of a session: its kind and its payload, as JSON.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct SessionEvent {
    /// What happened.
    pub kind: SessionEventKind,
    /// Its details (see [`SessionEventKind`]).
    pub payload: Value,
}

/// A listener of a session's events of one kind.
pub type EventListener = Arc<dyn Fn(&SessionEvent) + Send + Sync>;

/// Where a view shows a session's document, for the queries that need
/// the screen: what a view registers with [`EditorSession::attach_geometry`].
/// Coordinates are the view's own.
pub trait ViewGeometry: Send + Sync {
    /// The caret's box at `pos`.
    fn coords_at_pos(&self, pos: usize) -> Option<Bounds<Points>>;
    /// The document position at `point`.
    fn pos_at_coords(&self, point: Point<Points>) -> Option<usize>;
    /// The box around the selection.
    fn selection_rect(&self) -> Option<Bounds<Points>>;
}

fn origin_name(origin: Option<&TransactionOrigin>) -> String {
    match origin {
        Some(TransactionOrigin::User) => "user".into(),
        Some(TransactionOrigin::Input) => "input".into(),
        Some(TransactionOrigin::Paste) => "paste".into(),
        Some(TransactionOrigin::Drop) => "drop".into(),
        Some(TransactionOrigin::Remote(who)) => format!("remote:{who}"),
        Some(TransactionOrigin::History) => "history".into(),
        Some(TransactionOrigin::Plugin(key)) => format!("plugin:{key}"),
        _ => "api".into(),
    }
}

/// The events a change from `old` to `new` through `applied` makes, in
/// order: per transaction its summary and the ranges it removed, then the
/// update and the selection's.
fn change_events(
    old: &EditorState,
    new: &EditorState,
    applied: &[Transaction],
) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    let event = |kind, payload| SessionEvent { kind, payload };
    for tr in applied {
        let meta: Vec<&str> = tr.meta_entries().map(|(k, _)| k).collect();
        events.push(event(
            SessionEventKind::Transaction,
            json!({
                "origin": origin_name(tr.origin()),
                "docChanged": tr.doc_changed(),
                "meta": meta,
                "steps": tr.steps.len(),
            }),
        ));
        let count = tr.mapping.maps.len();
        for (i, map) in tr.mapping.maps.iter().enumerate() {
            // `invert` takes every map of a mapping, whatever its slice
            // (as ProseMirror's), so the maps before this one are copied.
            let mut back = Mapping::new();
            for earlier in (0..i).rev() {
                back.append_map(tr.mapping.maps[earlier].invert(), None);
            }
            let forward = tr.mapping.slice(i + 1, count);
            map.for_each(|old_start, old_end, new_start, new_end| {
                if old_end > old_start {
                    events.push(event(
                        SessionEventKind::Delete,
                        json!({
                            "from": back.map(old_start, 1),
                            "to": back.map(old_end, -1),
                            "newFrom": forward.map(new_start, -1),
                            "newTo": forward.map(new_end, 1),
                        }),
                    ));
                }
            });
        }
    }
    if !old.doc().eq(new.doc()) {
        events.push(event(
            SessionEventKind::Update,
            json!({ "revision": new.revision() }),
        ));
    }
    if old.selection() != new.selection() {
        let s = new.selection();
        events.push(event(
            SessionEventKind::SelectionUpdate,
            json!({
                "anchor": s.anchor(),
                "head": s.head(),
                "from": s.from(),
                "to": s.to(),
                "empty": s.empty(),
            }),
        ));
    }
    events
}

/// What a subscriber of a session is known by ([`EditorSession::subscribe`]).
pub type SubscriptionId = u64;

/// A subscriber of a session: called with every new state.
pub type Subscriber = Arc<dyn Fn(&EditorState) + Send + Sync>;

/// The app's own commit of transactions
/// ([`EditorSession::set_dispatch_transaction`]).
pub type DispatchTransaction = Arc<dyn Fn(&EditorSession, Transaction) + Send + Sync>;

/// The node views of an editor: by node type name, what renders nodes of
/// that type ([`NodeView`]).
#[derive(Clone, Default)]
pub struct NodeViews(HashMap<String, Arc<dyn NodeView>>);

impl NodeViews {
    /// No node views: every node renders as the view's default.
    pub fn new() -> Self {
        Self::default()
    }

    /// Renders nodes of type `name` with `view` (replacing another one).
    pub fn insert(&mut self, name: impl Into<String>, view: Arc<dyn NodeView>) -> &mut Self {
        self.0.insert(name.into(), view);
        self
    }

    /// [`NodeViews::insert`], by value.
    pub fn with(mut self, name: impl Into<String>, view: Arc<dyn NodeView>) -> Self {
        self.insert(name, view);
        self
    }

    /// The view of nodes of type `name`.
    pub fn get(&self, name: &str) -> Option<&Arc<dyn NodeView>> {
        self.0.get(name)
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for NodeViews {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_set().entries(self.0.keys()).finish()
    }
}

/// What a session asks of the views showing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ViewRequest {
    /// Take the keyboard focus.
    Focus,
    /// Give the keyboard focus up.
    Blur,
}

/// A view's handler of [`ViewRequest`]s.
pub(crate) type ViewHook = Arc<dyn Fn(ViewRequest) + Send + Sync>;

struct Inner {
    state: EditorState,
    node_views: NodeViews,
    dispatch: Option<DispatchTransaction>,
    subscribers: Vec<(SubscriptionId, Subscriber)>,
    views: Vec<(SubscriptionId, ViewHook)>,
    listeners: Vec<(SubscriptionId, SessionEventKind, EventListener)>,
    geometry: Vec<(SubscriptionId, Arc<dyn ViewGeometry>)>,
}

struct Shared {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
    composing: AtomicBool,
    focused: AtomicBool,
    editable: AtomicBool,
}

/// The one live editor a `RichEditor` view and the app's code share:
/// cheap to clone (a handle), `Send` and `Sync`. Every change goes through
/// [`EditorSession::dispatch`]; subscribers hear every new state after it.
#[derive(Clone)]
pub struct EditorSession(Arc<Shared>);

impl PartialEq for EditorSession {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for EditorSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EditorSession")
            .field("revision", &self.state().revision())
            .finish_non_exhaustive()
    }
}

impl EditorSession {
    /// A session over `state`, rendering the node types `node_views` names
    /// with their views.
    pub fn new(state: EditorState, node_views: NodeViews) -> Self {
        Self(Arc::new(Shared {
            inner: Mutex::new(Inner {
                state,
                node_views,
                dispatch: None,
                subscribers: Vec::new(),
                views: Vec::new(),
                listeners: Vec::new(),
                geometry: Vec::new(),
            }),
            next_id: AtomicU64::new(1),
            composing: AtomicBool::new(false),
            focused: AtomicBool::new(false),
            editable: AtomicBool::new(true),
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panicking subscriber never runs under the lock: the state is
        // whole whatever poisoned it.
        self.0.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The current state.
    pub fn state(&self) -> EditorState {
        self.lock().state.clone()
    }

    /// The node views.
    pub fn node_views(&self) -> NodeViews {
        self.lock().node_views.clone()
    }

    /// Replaces the node views (views made already stay until their nodes
    /// render again).
    pub fn set_node_views(&self, node_views: NodeViews) {
        self.lock().node_views = node_views;
        let state = self.state();
        self.notify(&state);
    }

    /// Commits `tr`: through the app's `dispatch_transaction` when one is
    /// set (which commits with [`EditorSession::update_state`]), else by
    /// applying it to the current state (plugins' filters and appended
    /// transactions included) and notifying the subscribers. A transaction
    /// the state refuses changes nothing.
    pub fn dispatch(&self, tr: Transaction) -> Result<(), StateError> {
        let custom = self.lock().dispatch.clone();
        if let Some(custom) = custom {
            custom(self, tr);
            return Ok(());
        }
        let (old, state, applied) = {
            let mut inner = self.lock();
            let old = inner.state.clone();
            let (state, applied) = old.apply_transaction(tr)?;
            if applied.is_empty() {
                // A filter dropped it.
                return Ok(());
            }
            inner.state = state.clone();
            (old, state, applied)
        };
        self.after_change(&old, &state, &applied);
        Ok(())
    }

    /// Makes `state` the state, as `applied` (the transactions that made
    /// it from the current one, from the app's own commit) did: notifies
    /// the subscribers and posts the events.
    pub fn commit(&self, state: EditorState, applied: &[Transaction]) {
        let old = std::mem::replace(&mut self.lock().state, state.clone());
        self.after_change(&old, &state, applied);
    }

    fn after_change(&self, old: &EditorState, state: &EditorState, applied: &[Transaction]) {
        self.notify(state);
        self.emit_all(change_events(old, state, applied));
        let focus = applied
            .iter()
            .any(|tr| tr.get_meta(FOCUS_META) == Some(&Value::Bool(true)));
        if focus {
            self.focus();
        }
    }

    /// Lets the app commit transactions itself (`None`: the session
    /// applies them again).
    pub fn set_dispatch_transaction(&self, dispatch: Option<DispatchTransaction>) {
        self.lock().dispatch = dispatch;
    }

    /// Replaces the state (from the app's `dispatch_transaction`, a loaded
    /// document, a reconfiguration) and notifies the subscribers.
    pub fn update_state(&self, state: EditorState) {
        self.commit(state, &[]);
    }

    /// Runs `command` on the current state, dispatching what it does:
    /// whether it applied.
    pub fn run(&self, command: &BoxCommand) -> bool {
        let state = self.state();
        let mut trs = Vec::new();
        let applied = command(&state, Some(&mut |tr| trs.push(tr)));
        for tr in trs {
            if let Err(e) = self.dispatch(tr) {
                log::warn!("RichEditor: a command's transaction was refused: {e}");
            }
        }
        applied
    }

    /// Whether `command` applies to the current state (it dispatches
    /// nothing).
    pub fn can(&self, command: &BoxCommand) -> bool {
        command(&self.state(), None)
    }

    /// Whether the node or mark type `name` (any, without one) is active
    /// at the selection with `attrs` (Tiptap's `isActive`: over a range,
    /// the type must cover all of it).
    pub fn is_active(&self, name: Option<&str>, attrs: Option<Attrs>) -> bool {
        helpers::is_active(&self.state(), name, &attrs.unwrap_or_default())
    }

    /// The attributes of the node or mark type `name` at the selection
    /// (Tiptap's `getAttributes`).
    pub fn get_attributes(&self, name: &str) -> Attrs {
        helpers::get_attributes(&self.state(), name)
    }

    /// Calls `listener` with every event of `kind` from now on (after the
    /// change, outside the session's lock); [`EditorSession::unsubscribe`]
    /// stops it.
    pub fn on(&self, kind: SessionEventKind, listener: EventListener) -> SubscriptionId {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        self.lock().listeners.push((id, kind, listener));
        id
    }

    /// Stops calling a listener [`EditorSession::on`] added.
    pub fn off(&self, id: SubscriptionId) {
        self.unsubscribe(id);
    }

    /// Posts `event` to its listeners.
    pub fn emit(&self, event: SessionEvent) {
        self.emit_all(vec![event]);
    }

    fn emit_all(&self, events: Vec<SessionEvent>) {
        if events.is_empty() {
            return;
        }
        let listeners: Vec<(SessionEventKind, EventListener)> = self
            .lock()
            .listeners
            .iter()
            .map(|(_, kind, l)| (*kind, l.clone()))
            .collect();
        if listeners.is_empty() {
            return;
        }
        for event in &events {
            for (kind, listener) in &listeners {
                if *kind == event.kind {
                    listener(event);
                }
            }
        }
    }

    /// Whether a view of the session has the keyboard focus.
    pub fn is_focused(&self) -> bool {
        self.0.focused.load(Ordering::Relaxed)
    }

    /// Records whether a view of the session has the focus (the views call
    /// it as theirs changes), posting `focus` or `blur` on a change.
    pub fn set_focused(&self, focused: bool) {
        if self.0.focused.swap(focused, Ordering::Relaxed) != focused {
            self.emit(SessionEvent {
                kind: if focused {
                    SessionEventKind::Focus
                } else {
                    SessionEventKind::Blur
                },
                payload: json!({}),
            });
        }
    }

    /// Whether the views let the user edit the document (true by default;
    /// the app's code edits it either way).
    pub fn is_editable(&self) -> bool {
        self.0.editable.load(Ordering::Relaxed)
    }

    /// Lets the user edit the document or not; the views hear it as a new
    /// state.
    pub fn set_editable(&self, editable: bool) {
        if self.0.editable.swap(editable, Ordering::Relaxed) != editable {
            let state = self.state();
            self.notify(&state);
        }
    }

    /// Registers where a view shows the session (the last registered
    /// answers the queries); [`EditorSession::unsubscribe`] removes it.
    pub fn attach_geometry(&self, geometry: Arc<dyn ViewGeometry>) -> SubscriptionId {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        self.lock().geometry.push((id, geometry));
        id
    }

    fn geometry(&self) -> Option<Arc<dyn ViewGeometry>> {
        self.lock().geometry.last().map(|(_, g)| g.clone())
    }

    /// The caret's box at `pos` in the view showing the session, if one
    /// is (Tiptap's `coordsAtPos`).
    pub fn coords_at_pos(&self, pos: usize) -> Option<Bounds<Points>> {
        self.geometry()?.coords_at_pos(pos)
    }

    /// The document position at `point` in the view showing the session
    /// (Tiptap's `posAtCoords`).
    pub fn pos_at_coords(&self, point: Point<Points>) -> Option<usize> {
        self.geometry()?.pos_at_coords(point)
    }

    /// The box around the selection in the view showing the session.
    pub fn selection_rect(&self) -> Option<Bounds<Points>> {
        self.geometry()?.selection_rect()
    }

    /// Calls `subscriber` with every new state from now on.
    pub fn subscribe(&self, subscriber: Subscriber) -> SubscriptionId {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        self.lock().subscribers.push((id, subscriber));
        id
    }

    /// Stops calling subscriber `id` (or a view hook).
    pub fn unsubscribe(&self, id: SubscriptionId) {
        let mut inner = self.lock();
        inner.subscribers.retain(|(i, _)| *i != id);
        inner.views.retain(|(i, _)| *i != id);
        inner.listeners.retain(|(i, _, _)| *i != id);
        inner.geometry.retain(|(i, _)| *i != id);
    }

    /// Asks the views showing the session to take the keyboard focus.
    pub fn focus(&self) {
        self.request(ViewRequest::Focus);
    }

    /// Asks the views showing the session to give the focus up.
    pub fn blur(&self) {
        self.request(ViewRequest::Blur);
    }

    /// Whether an input method is composing in a view of the session (its
    /// text is not in the document until it commits).
    pub fn composing(&self) -> bool {
        self.0.composing.load(Ordering::Relaxed)
    }

    pub(crate) fn set_composing(&self, composing: bool) {
        self.0.composing.store(composing, Ordering::Relaxed);
    }

    /// Registers a view's handler of requests.
    pub(crate) fn attach_view(&self, hook: ViewHook) -> SubscriptionId {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        self.lock().views.push((id, hook));
        id
    }

    fn request(&self, request: ViewRequest) {
        let views: Vec<ViewHook> = self.lock().views.iter().map(|(_, h)| h.clone()).collect();
        for view in views {
            view(request);
        }
    }

    fn notify(&self, state: &EditorState) {
        // Called outside the lock: subscribers read the session.
        let subscribers: Vec<Subscriber> = self
            .lock()
            .subscribers
            .iter()
            .map(|(_, s)| s.clone())
            .collect();
        for subscriber in subscribers {
            subscriber(state);
        }
    }
}

/// How an [`EditorSession`] crosses to JS and back, as the JS class over it
/// makes it: set once by that class's module ([`set_session_js`]), it is
/// what the `RichEditor`'s `session` prop decodes with.
#[derive(Clone, Copy)]
#[non_exhaustive]
pub struct SessionJs {
    /// The session a JS value holds (an instance of the class), if any.
    pub from_js: fn(JsIn<'_>) -> Option<EditorSession>,
    /// The JS object of a session.
    pub to_js: for<'a> fn(&EditorSession, &'a dyn JsHost) -> Result<JsOwned<'a>, PropError>,
}

impl SessionJs {
    /// The bridge of a JS class: `from_js` reads a session out of an
    /// instance, `to_js` makes one.
    pub fn new(
        from_js: fn(JsIn<'_>) -> Option<EditorSession>,
        to_js: for<'a> fn(&EditorSession, &'a dyn JsHost) -> Result<JsOwned<'a>, PropError>,
    ) -> Self {
        Self { from_js, to_js }
    }
}

// Code, not state: one bridge per build, the same for every engine.
static SESSION_JS: OnceLock<SessionJs> = OnceLock::new();

/// Sets how sessions cross to JS (the JS class's module calls it once; a
/// second call is ignored).
pub fn set_session_js(bridge: SessionJs) {
    let _ = SESSION_JS.set(bridge);
}

/// The TypeScript name of the JS class over [`EditorSession`].
pub const SESSION_TS_TYPE: &str = "RichEditorSession";

/// TS: the `RichEditorSession` class's instances.
impl JsValue for EditorSession {
    fn ts_type(_types: &mut TsTypes) -> String {
        SESSION_TS_TYPE.into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        SESSION_JS
            .get()
            .and_then(|bridge| (bridge.from_js)(value))
            .ok_or_else(|| value.expected(&format!("a {SESSION_TS_TYPE}")))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match SESSION_JS.get() {
            Some(bridge) => (bridge.to_js)(self, host),
            None => Ok(JsOwned::new(host, host.null())),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::rich_editor::{
        commands::command,
        extensions::starter,
        state::{EditorStateConfig, TextSelection},
    };

    fn session() -> EditorSession {
        let schema = starter::schema();
        let state = EditorState::create(
            EditorStateConfig::new(schema.clone()).plugins(starter::plugins(&schema)),
        )
        .unwrap();
        EditorSession::new(state, NodeViews::new())
    }

    #[test]
    fn dispatch_applies_and_notifies() {
        let s = session();
        let heard = Arc::new(AtomicUsize::new(0));
        let h = heard.clone();
        let id = s.subscribe(Arc::new(move |_| {
            h.fetch_add(1, Ordering::Relaxed);
        }));
        let mut tr = s.state().tr();
        tr.insert_text("hi", None, None);
        s.dispatch(tr).unwrap();
        assert_eq!(s.state().doc().text_content(), "hi");
        assert_eq!(heard.load(Ordering::Relaxed), 1);
        s.unsubscribe(id);
        let mut tr = s.state().tr();
        tr.insert_text("!", None, None);
        s.dispatch(tr).unwrap();
        assert_eq!(heard.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn the_app_can_take_over_dispatching() {
        let s = session();
        let seen = Arc::new(AtomicUsize::new(0));
        let n = seen.clone();
        s.set_dispatch_transaction(Some(Arc::new(move |session, tr| {
            n.fetch_add(1, Ordering::Relaxed);
            let next = session.state().apply(tr).unwrap();
            session.update_state(next);
        })));
        let mut tr = s.state().tr();
        tr.insert_text("x", None, None);
        s.dispatch(tr).unwrap();
        assert_eq!(seen.load(Ordering::Relaxed), 1);
        assert_eq!(s.state().doc().text_content(), "x");
    }

    #[test]
    fn commands_run_and_report_activity() {
        let s = session();
        let mut tr = s.state().tr();
        tr.insert_text("word", None, None);
        let doc = tr.transform().doc().clone();
        tr.set_selection(TextSelection::create(&doc, 1, Some(5)));
        s.dispatch(tr).unwrap();
        let bold = s.state().schema().mark_type("bold").unwrap();
        let toggle = crate::rich_editor::commands::toggle_mark(bold, None, true);
        assert!(s.can(&toggle));
        assert!(!s.is_active(Some("bold"), None));
        assert!(s.run(&toggle));
        assert!(s.is_active(Some("bold"), None));
        assert!(s.is_active(Some("paragraph"), None));
        assert!(!s.run(&command(|_, _| false)));
    }

    #[test]
    fn events_follow_changes() {
        let s = session();
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        for kind in SessionEventKind::ALL {
            let h = heard.clone();
            s.on(
                kind,
                Arc::new(move |e: &SessionEvent| h.lock().unwrap().push(e.kind.name().into())),
            );
        }
        let mut tr = s.state().tr();
        tr.insert_text("hi", None, None);
        s.dispatch(tr).unwrap();
        let mut tr = s.state().tr();
        tr.delete(1, 2).unwrap();
        s.dispatch(tr).unwrap();
        s.set_focused(true);
        s.set_focused(true);
        s.set_focused(false);
        let heard = heard.lock().unwrap().clone();
        assert_eq!(
            heard,
            [
                "transaction",
                "update",
                "selectionUpdate",
                "transaction",
                "delete",
                "update",
                "selectionUpdate",
                "focus",
                "blur"
            ]
        );
    }

    #[test]
    fn a_focus_command_asks_the_views() {
        let s = session();
        let asked = Arc::new(AtomicUsize::new(0));
        let a = asked.clone();
        s.attach_view(Arc::new(move |request| {
            if request == ViewRequest::Focus {
                a.fetch_add(1, Ordering::Relaxed);
            }
        }));
        let focus = crate::rich_editor::commands::tiptap::focus(
            crate::rich_editor::commands::tiptap::FocusPosition::End,
        );
        assert!(s.run(&focus));
        assert_eq!(asked.load(Ordering::Relaxed), 1);
        assert!(s.is_editable());
        s.set_editable(false);
        assert!(!s.is_editable());
        assert!(s.coords_at_pos(0).is_none());
    }
}
