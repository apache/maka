//! `RichEditor`'s TS face in `nsh/base`: `defineSchema` / `starterSchema`
//! (the `RichSchema` class), `createRichEditor` (the `RichEditorSession`
//! class over an [`EditorSession`]), commands as data (`toggleMark`,
//! `setBlockType`, `chain`, ...), plugins as data (`history`, `keymap`,
//! `inputRules`, `markdown`, `starterKit`) and `RichEditorPlugin`, whose
//! hooks are the app's.
//!
//! Everything runs in Rust: a command resolves against the schema once
//! and runs in the kernel, plugins are the kernel's, and states cross to
//! JS as JSON only when the app asks (`editor.state`, `getJSON()`). The
//! input path (keys, typing, input rules) never calls JS; see `plugins.rs`
//! for when the app's hooks run.

mod commands;
mod extension_api;
mod extensions;
mod json;
mod plugins;

use std::sync::Arc;

use nsh_core::{
    JsonValue,
    element::{Arg, JsHost, JsIn, JsOwned, PropError, Registry, Ret, TsTypes},
    prelude::*,
};

pub(crate) use self::{
    commands::{RichCommand, RichCommandName, RichFormat},
    plugins::{RichEditorPlugin, RichPluginSpec},
};
use self::{
    commands::{doc_of, fragment_of, resolve_with},
    json::{
        AttrsJson, Content, NodeJson, SchemaSpecJson, SelectionJson, StateJson, TransactionJson,
    },
    plugins::{
        CallGuard, HookRef, KeyBindings, PluginEntry, RichDecoration, RichInputRule,
        RichInputRuleKind, RichPluginKind, decorations_json, in_js_call, resolve_plugins,
        transaction_from_json, transaction_json,
    },
};
use super::{
    commands::CommandRegistry,
    extensions::{ExtensionManager, history, starter},
    formats::{DocFormat, MarkdownFormat, MarkdownNames, PlainTextFormat},
    model::{Node, Schema, SchemaSpec},
    state::{EditorState, EditorStateConfig, PluginKey, Selection, Transaction, TransactionOrigin},
    view::{
        EditorSession, NodeViews, SessionEvent, SessionEventKind, SessionJs, SubscriptionId,
        set_session_js,
    },
};

fn attrs_json(attrs: &super::model::Attrs) -> JsonValue {
    JsonValue::Object(attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn rect_json(b: &nsh_core::prelude::Bounds<nsh_core::prelude::Points>) -> JsonValue {
    serde_json::json!({
        "x": b.origin.x.0,
        "y": b.origin.y.0,
        "width": b.size.width.0,
        "height": b.size.height.0,
    })
}

// Event listeners are the engine thread's (`Rc`), the session's listeners
// `Send + Sync`: they hold a key into this thread's table; only the
// thread that made one reaches its function, and dropping the last handle
// there releases it.
thread_local! {
    static EVENT_HOOKS: std::cell::RefCell<std::collections::HashMap<u64, Callback<JsonValue>>> =
        std::cell::RefCell::default();
}

static NEXT_EVENT_HOOK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct EventHook {
    id: u64,
    thread: std::thread::ThreadId,
}

impl EventHook {
    fn new(listener: Callback<JsonValue>) -> Self {
        let id = NEXT_EVENT_HOOK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        EVENT_HOOKS.with(|hooks| hooks.borrow_mut().insert(id, listener));
        Self {
            id,
            thread: std::thread::current().id(),
        }
    }

    fn post(&self, payload: JsonValue) {
        if std::thread::current().id() != self.thread {
            return;
        }
        let listener = EVENT_HOOKS.with(|hooks| hooks.borrow().get(&self.id).cloned());
        if let Some(listener) = listener {
            listener.post(payload);
        }
    }
}

impl Drop for EventHook {
    fn drop(&mut self) {
        if std::thread::current().id() == self.thread {
            let _ = EVENT_HOOKS.try_with(|hooks| {
                if let Ok(mut hooks) = hooks.try_borrow_mut() {
                    hooks.remove(&self.id);
                }
            });
        }
    }
}

/// Registers the classes and functions of `nsh/base`'s rich text editor,
/// and how its sessions cross to the `RichEditor` view's `editor` prop.
pub(crate) fn register(registry: &mut Registry) {
    set_session_js(SessionJs::new(session_from_js, session_to_js));
    registry
        .class::<RichSchema>()
        .class::<RichEditorSession>()
        .class::<RichEditorPlugin>()
        .module::<RichEditorApi>();
    extension_api::register(registry);
}

fn session_from_js(value: JsIn<'_>) -> Option<EditorSession> {
    let instance = <Instance<RichEditorSession> as Arg>::from_js(value).ok()?;
    instance.with(|editor| Some(editor.session.clone()))
}

fn session_to_js<'a>(
    session: &EditorSession,
    host: &'a dyn JsHost,
) -> Result<JsOwned<'a>, PropError> {
    let schema = session.state().schema().clone();
    Ret::into_js(
        Instance::new(RichEditorSession::over(session.clone(), schema)),
        host,
    )
}

// --- Schemas ---------------------------------------------------------------

/// A document schema: the node and mark types a rich text editor's
/// documents are made of, and the formats documents read from and write
/// to with it.
#[class]
pub(crate) struct RichSchema {
    schema: Schema,
}

#[class]
impl RichSchema {
    /// The names of its node types, in order (the first block type is the
    /// default one).
    #[getter]
    pub(crate) fn nodes(&self) -> Vec<String> {
        self.schema
            .node_types()
            .iter()
            .map(|t| t.name().to_owned())
            .collect()
    }

    /// The names of its mark types, in order.
    #[getter]
    pub(crate) fn marks(&self) -> Vec<String> {
        self.schema
            .mark_types()
            .iter()
            .map(|t| t.name().to_owned())
            .collect()
    }

    /// The top node type's name.
    #[getter]
    pub(crate) fn top_node(&self) -> String {
        self.schema.top_node_type().name().to_owned()
    }

    /// `content` (a string in `format`, plain text by default, or JSON)
    /// read into a document of the schema; throws when it does not fit.
    pub(crate) fn parse(
        &self,
        content: Content,
        format: Option<RichFormat>,
    ) -> Result<NodeJson, String> {
        doc_of(&self.schema, &content, format).map(|doc| NodeJson(doc.to_json()))
    }

    /// Markdown `markdown` read into a document of the schema (the starter
    /// schema's names).
    pub(crate) fn parse_markdown(&self, markdown: String) -> Result<NodeJson, String> {
        self.parse(Content::Text(markdown), Some(RichFormat::Markdown))
    }

    /// `doc` (a document of the schema) written as `format` (Markdown by
    /// default, `json` as a JSON string, `text` as plain text).
    pub(crate) fn serialize(
        &self,
        doc: NodeJson,
        format: Option<RichFormat>,
    ) -> Result<String, String> {
        let doc = Node::from_json(&self.schema, &doc.0).map_err(|e| e.to_string())?;
        serialize(&doc, format.unwrap_or(RichFormat::Markdown))
    }

    /// Checks `doc` against the schema: the document, normalized (attribute
    /// defaults filled in); throws with what does not fit.
    pub(crate) fn check(&self, doc: NodeJson) -> Result<NodeJson, String> {
        let doc = Node::from_json(&self.schema, &doc.0).map_err(|e| e.to_string())?;
        doc.check().map_err(|e| e.to_string())?;
        Ok(NodeJson(doc.to_json()))
    }
}

fn serialize(doc: &Node, format: RichFormat) -> Result<String, String> {
    match format {
        RichFormat::Json => Ok(doc.to_json().to_string()),
        RichFormat::Markdown => MarkdownFormat::new(MarkdownNames::default())
            .serialize(doc)
            .map_err(|e| e.to_string()),
        RichFormat::Text => PlainTextFormat::default()
            .serialize(doc)
            .map_err(|e| e.to_string()),
    }
}

/// An editor's schema: a `RichSchema`, or a spec read into one. TS:
/// `RichSchema | RichSchemaSpec`.
#[derive(Debug, Clone)]
pub(crate) enum SchemaArg {
    Schema(Instance<RichSchema>),
    Spec(SchemaSpecJson),
}

impl PartialEq for SchemaArg {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Schema(a), Self::Schema(b)) => a.ptr_eq(b),
            (Self::Spec(a), Self::Spec(b)) => a == b,
            _ => false,
        }
    }
}

impl JsValue for SchemaArg {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "{} | {}",
            <Instance<RichSchema> as Arg>::ts_type(types),
            <SchemaSpecJson as JsValue>::ts_type(types)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.host().instance(value.raw()).is_some() {
            return <Instance<RichSchema> as Arg>::from_js(value).map(Self::Schema);
        }
        <SchemaSpecJson as JsValue>::from_js(value).map(Self::Spec)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Schema(schema) => Ret::into_js(schema.clone(), host),
            Self::Spec(spec) => spec.to_js(host),
        }
    }
}

impl SchemaArg {
    fn schema(&self) -> Result<Schema, String> {
        match self {
            Self::Schema(schema) => Ok(schema.with(|s| s.schema.clone())),
            Self::Spec(spec) => SchemaSpec::from_json(&spec.0).map_err(|e| e.to_string()),
        }
    }
}

// --- Editors ----------------------------------------------------------------

/// What `createRichEditor` makes an editor with.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichEditorOptions {
    /// The document schema (`defineSchema(...)`, or a spec); the starter
    /// schema when left out.
    pub(crate) schema: Option<SchemaArg>,
    /// The first document, as JSON (`schema.parse(...)`'s result).
    pub(crate) doc: Option<NodeJson>,
    /// The first content: a string in `format`, or JSON. Ignored when
    /// `doc` is given.
    pub(crate) content: Option<Content>,
    /// The format of `content` when it is a string (plain text by default).
    pub(crate) format: Option<RichFormat>,
    /// The first selection (the start of the document by default).
    pub(crate) selection: Option<SelectionJson>,
    /// The plugins, in order (their order is their priority); the starter
    /// kit (`starterKit()`) when left out, none when empty. With
    /// `extensions`, more plugins after the extensions'.
    pub(crate) plugins: Option<Vec<PluginEntry>>,
    /// The extensions (Tiptap's): `[StarterKit.configure({...}), ...]`.
    /// They make the schema (so `schema` is left out), the keymaps, rules,
    /// plugins and named commands; the core keymap comes with them.
    pub(crate) extensions: Option<Vec<extension_api::ExtensionEntry>>,
    /// Whether the user may edit the document (true by default).
    pub(crate) editable: Option<bool>,
}

/// What `history` keeps.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichHistoryOptions {
    /// How many changes it keeps (100 by default).
    pub(crate) depth: Option<usize>,
    /// Milliseconds within which changes group into one undo step (500 by
    /// default).
    pub(crate) new_group_delay: Option<f64>,
}

/// What `markdown` does; every group is on unless turned off.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichMarkdownOptions {
    /// Block shortcuts typed at a textblock's start: headings, quotes,
    /// lists, code fences, rules.
    pub(crate) block_rules: Option<bool>,
    /// Inline marks completed by their closing delimiter.
    pub(crate) inline_rules: Option<bool>,
    /// Pasted plain text that looks like Markdown is read as Markdown.
    pub(crate) paste: Option<bool>,
    /// Copies put Markdown on the clipboard as their plain text.
    pub(crate) copy_as_markdown: Option<bool>,
}

/// One live rich text editor that a `RichEditor` view and the app's code
/// share (`createRichEditor` makes one): it owns the state in Rust, runs
/// commands, takes transactions, and tells subscribers about changes.
#[class]
pub(crate) struct RichEditorSession {
    session: EditorSession,
    schema: Schema,
    /// The named commands `command(name)` runs: the built-in ones and the
    /// editor's extensions'.
    commands: Arc<CommandRegistry>,
    /// The app's `dispatchTransaction` and the subscribers' functions.
    hooks: Arc<HookRef>,
    /// Transactions handed to `dispatchTransaction`, by id, until applied.
    pending: Arc<std::sync::Mutex<Vec<(u64, Transaction)>>>,
    subscriptions: Vec<(u64, SubscriptionId)>,
}

impl Drop for RichEditorSession {
    fn drop(&mut self) {
        for (_, id) in self.subscriptions.drain(..) {
            self.session.unsubscribe(id);
        }
    }
}

/// Transactions waiting for the app's `applyTransaction` are kept up to
/// this many (older ones are dropped: the app never applied them).
const MAX_PENDING: usize = 32;

static NEXT_TR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl RichEditorSession {
    fn over(session: EditorSession, schema: Schema) -> Self {
        Self {
            session,
            schema,
            commands: CommandRegistry::builtin(),
            hooks: HookRef::new(),
            pending: Arc::default(),
            subscriptions: Vec::new(),
        }
    }

    fn command(&self, command: &RichCommand) -> Result<super::commands::BoxCommand, String> {
        resolve_with(command, &self.schema, &self.commands)
    }

    fn handles(this: &Instance<Self>) -> (EditorSession, Schema) {
        this.with(|e| (e.session.clone(), e.schema.clone()))
    }

    /// A transaction from its JSON form: the one waiting under its `id`
    /// when there is one (with its Rust metadata: history), else built from
    /// its steps against the current state.
    fn take_transaction(&self, json: &TransactionJson) -> Result<Transaction, String> {
        if let Some(id) = json.0.get("id").and_then(JsonValue::as_u64)
            && let Ok(mut pending) = self.pending.lock()
            && let Some(i) = pending.iter().position(|(p, _)| *p == id)
        {
            return Ok(pending.remove(i).1);
        }
        transaction_from_json(&self.session.state(), &json.0)
    }
}

#[class]
impl RichEditorSession {
    /// The state as JSON: the document, the selection, the stored marks and
    /// the plugins' states that have a JSON form. Made when read: read it
    /// when needed rather than on every change.
    #[getter]
    pub(crate) fn state(&self) -> StateJson {
        StateJson(self.session.state().to_json())
    }

    /// The document as JSON.
    #[getter]
    pub(crate) fn doc(&self) -> NodeJson {
        NodeJson(self.session.state().doc().to_json())
    }

    /// The selection as JSON.
    #[getter]
    pub(crate) fn selection(&self) -> SelectionJson {
        SelectionJson(self.session.state().selection().to_json())
    }

    /// How many transactions the state has applied: changes with every
    /// change.
    #[getter]
    pub(crate) fn revision(&self) -> f64 {
        self.session.state().revision() as f64
    }

    /// Whether the document is empty: one empty textblock or less.
    #[getter]
    pub(crate) fn is_empty(&self) -> bool {
        let state = self.session.state();
        let doc = state.doc();
        doc.content().size() == 0
            || (doc.child_count() == 1
                && doc.child(0).is_textblock()
                && doc.child(0).content().size() == 0)
    }

    /// How many changes `undo` can undo (with the `history` plugin).
    #[getter]
    pub(crate) fn undo_depth(&self) -> usize {
        history::undo_depth(&self.session.state())
    }

    /// How many undone changes `redo` can redo.
    #[getter]
    pub(crate) fn redo_depth(&self) -> usize {
        history::redo_depth(&self.session.state())
    }

    /// Whether an input method is composing (its text is not in the
    /// document until it commits).
    #[getter]
    pub(crate) fn composing(&self) -> bool {
        self.session.composing()
    }

    /// Runs `command` (`toggleMark("bold")`, `chain([...])`): whether it
    /// applied. Its transaction goes through `dispatchTransaction` when one
    /// is set.
    pub(crate) fn run(this: Instance<Self>, command: RichCommand) -> Result<bool, String> {
        let command = this.with(|e| e.command(&command))?;
        let (session, _) = Self::handles(&this);
        let _guard = CallGuard::enter();
        Ok(session.run(&command))
    }

    /// Whether `command` applies now (it changes nothing): what a toolbar
    /// enables its buttons by.
    pub(crate) fn can(&self, command: RichCommand) -> Result<bool, String> {
        let command = self.command(&command)?;
        Ok(self.session.can(&command))
    }

    /// Whether the mark or node type `name` is active at the selection
    /// (with `attrs`, for nodes: `isActive("heading", { level: 2 })`).
    pub(crate) fn is_active(
        &self,
        name: Option<String>,
        attrs: Option<AttrsJson>,
    ) -> Result<bool, String> {
        let attrs = commands::attrs_of(&attrs)?;
        Ok(self.session.is_active(name.as_deref(), attrs))
    }

    /// The attributes of the node or mark type `name` at the selection
    /// (`{}` when there is none).
    pub(crate) fn get_attributes(&self, name: String) -> JsonValue {
        attrs_json(&self.session.get_attributes(&name))
    }

    /// The range `{ from, to }` of the text marked `name` around `pos`
    /// (with `attrs`, else the first such mark's), or `null`.
    pub(crate) fn get_mark_range(
        &self,
        pos: usize,
        name: String,
        attrs: Option<AttrsJson>,
    ) -> Result<Option<JsonValue>, String> {
        let state = self.session.state();
        let ty = state
            .schema()
            .mark_type(&name)
            .ok_or_else(|| format!("the schema has no mark type `{name}`"))?;
        let at = state.doc().resolve(pos).map_err(|e| e.to_string())?;
        let attrs = commands::attrs_of(&attrs)?;
        Ok(
            crate::rich_editor::commands::get_mark_range(&at, &ty, attrs.as_ref())
                .map(|(from, to)| serde_json::json!({ "from": from, "to": to })),
        )
    }

    /// The innermost node of type `name` around the selection's start (or
    /// around `pos`): `{ pos, start, depth, node }`, or `null`.
    pub(crate) fn find_parent_node(&self, name: String, pos: Option<usize>) -> Option<JsonValue> {
        let state = self.session.state();
        let at = match pos {
            Some(pos) => state.doc().resolve(pos).ok()?,
            None => state.selection().resolved_from().clone(),
        };
        crate::rich_editor::commands::find_parent_node_closest_to_pos(&at, &|n| {
            n.ty().name() == name
        })
        .map(|found| {
            serde_json::json!({
                "pos": found.pos,
                "start": found.start,
                "depth": found.depth,
                "node": found.node.to_json(),
            })
        })
    }

    /// The node right after `pos`, as JSON, or `null`.
    pub(crate) fn node_at(&self, pos: usize) -> Option<NodeJson> {
        self.session
            .state()
            .doc()
            .node_at(pos)
            .map(|node| NodeJson(node.to_json()))
    }

    /// Position `pos` resolved: `{ pos, depth, parentOffset, parent,
    /// index, start, end, marks }` (`parent` its parent's type), or `null`
    /// out of the document.
    pub(crate) fn resolve(&self, pos: usize) -> Option<JsonValue> {
        let state = self.session.state();
        let at = state.doc().resolve(pos).ok()?;
        Some(serde_json::json!({
            "pos": at.pos,
            "depth": at.depth,
            "parentOffset": at.parent_offset,
            "parent": at.parent().ty().name(),
            "index": at.index(at.depth),
            "start": at.start(at.depth),
            "end": at.end(at.depth),
            "marks": at.marks().iter().map(|m| m.to_json()).collect::<Vec<_>>(),
        }))
    }

    /// The caret's box `{ x, y, width, height }` at `pos`, in points of
    /// the content box of the view showing the editor (its scrolling
    /// included), or `null` when none does.
    pub(crate) fn coords_at_pos(&self, pos: usize) -> Option<JsonValue> {
        self.session.coords_at_pos(pos).map(|b| rect_json(&b))
    }

    /// The document position at `{ x, y }` (points of the content box of
    /// the view showing the editor), or `null`.
    pub(crate) fn pos_at_coords(&self, coords: JsonValue) -> Option<usize> {
        let x = coords.get("x")?.as_f64()? as f32;
        let y = coords.get("y")?.as_f64()? as f32;
        self.session
            .pos_at_coords(nsh_core::prelude::point(px(x), px(y)))
    }

    /// The box around the selection, in points of the content box of the
    /// view showing the editor, or `null`.
    pub(crate) fn selection_rect(&self) -> Option<JsonValue> {
        self.session.selection_rect().map(|b| rect_json(&b))
    }

    /// Whether a view of the editor has the keyboard focus.
    #[getter]
    pub(crate) fn is_focused(&self) -> bool {
        self.session.is_focused()
    }

    /// Whether the user may edit the document in the views.
    #[getter]
    pub(crate) fn is_editable(&self) -> bool {
        self.session.is_editable()
    }

    /// Lets the user edit the document in the views, or not.
    pub(crate) fn set_editable(&self, editable: bool) {
        self.session.set_editable(editable);
    }

    /// Calls `listener` with the payload of every `event` (`update`,
    /// `selectionUpdate`, `transaction`, `focus`, `blur`, `delete`) after
    /// it happens, in JS's next turn; returns what `off` takes.
    pub(crate) fn on(
        &mut self,
        event: String,
        listener: Callback<JsonValue>,
    ) -> Result<f64, String> {
        let kind = SessionEventKind::from_name(&event)
            .ok_or_else(|| format!("no editor event `{event}`"))?;
        let handle = EventHook::new(listener);
        let id = self.session.on(
            kind,
            Arc::new(move |event: &SessionEvent| handle.post(event.payload.clone())),
        );
        self.subscriptions.push((id, id));
        Ok(id as f64)
    }

    /// Stops calling a listener `on` added.
    pub(crate) fn off(&mut self, id: f64) {
        self.unsubscribe(id);
    }

    /// Dispatches a transaction (steps against the current document, as
    /// `RichTransactionJSON`): through `dispatchTransaction` when one is
    /// set, else applied with the plugins' filters and appended
    /// transactions. Throws when a step does not apply.
    pub(crate) fn dispatch(this: Instance<Self>, tr: TransactionJson) -> Result<(), String> {
        let tr = this.with(|e| e.take_transaction(&tr))?;
        let (session, _) = Self::handles(&this);
        let _guard = CallGuard::enter();
        session.dispatch(tr).map_err(|e| e.to_string())
    }

    /// Applies `tr` to the current state and makes the result the state,
    /// bypassing `dispatchTransaction` (which calls it to commit, as
    /// ProseMirror's `view.updateState(view.state.apply(tr))`). A
    /// transaction `dispatchTransaction` got applies as it was made.
    pub(crate) fn apply_transaction(
        this: Instance<Self>,
        tr: TransactionJson,
    ) -> Result<(), String> {
        let tr = this.with(|e| e.take_transaction(&tr))?;
        let (session, _) = Self::handles(&this);
        let _guard = CallGuard::enter();
        let (state, applied) = session
            .state()
            .apply_transaction(tr)
            .map_err(|e| e.to_string())?;
        if !applied.is_empty() {
            session.commit(state, &applied);
        }
        Ok(())
    }

    /// Takes over committing transactions: `handler` gets each one (the
    /// editor's, the view's and the app's) and commits it with
    /// `applyTransaction`, or drops it; `null` hands committing back.
    /// Transactions from typing reach it in JS's next turn, so the
    /// document changes when it commits them.
    #[setter]
    pub(crate) fn set_dispatch_transaction(&mut self, handler: Option<Callback<TransactionJson>>) {
        let has = handler.is_some();
        self.hooks.update(|h| h.dispatch = handler);
        if !has {
            self.session.set_dispatch_transaction(None);
            return;
        }
        let hooks = self.hooks.clone();
        let pending = self.pending.clone();
        self.session.set_dispatch_transaction(Some(Arc::new(
            move |session: &EditorSession, tr: Transaction| {
                let Some(handler) = hooks.get().and_then(|h| h.dispatch) else {
                    // Another thread: commit as the session would.
                    if let Ok((state, applied)) = session.state().apply_transaction(tr)
                        && !applied.is_empty()
                    {
                        session.commit(state, &applied);
                    }
                    return;
                };
                let id = NEXT_TR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let json = transaction_json(&tr, Some(id));
                if let Ok(mut pending) = pending.lock() {
                    pending.push((id, tr));
                    let excess = pending.len().saturating_sub(MAX_PENDING);
                    pending.drain(..excess);
                }
                if in_js_call() {
                    if let Err(error) = handler.call(json) {
                        log::warn!("RichEditor: dispatchTransaction threw: {error}");
                    }
                } else {
                    handler.post(json);
                }
            },
        )));
    }

    /// Replaces the document with `content` (a string in `format`, plain
    /// text by default, or JSON) as one undoable change.
    pub(crate) fn set_content(
        this: Instance<Self>,
        content: Content,
        format: Option<RichFormat>,
    ) -> Result<(), String> {
        let (session, schema) = Self::handles(&this);
        let doc = doc_of(&schema, &content, format)?;
        let state = session.state();
        let mut tr = state.tr();
        tr.replace_with(0, state.doc().content().size(), doc.content().clone())
            .map_err(|e| e.to_string())?;
        tr.set_selection(Selection::at_start(tr.doc()));
        tr.set_origin(TransactionOrigin::Api);
        let _guard = CallGuard::enter();
        session.dispatch(tr).map_err(|e| e.to_string())
    }

    /// Inserts `content` (a string in `format`, plain text by default, or
    /// JSON) over the selection.
    pub(crate) fn insert_content(
        this: Instance<Self>,
        content: Content,
        format: Option<RichFormat>,
    ) -> Result<bool, String> {
        let (_, schema) = Self::handles(&this);
        // Checked here, so content that does not fit throws.
        fragment_of(&schema, &content, format)?;
        Self::run(
            this,
            RichCommand {
                command: RichCommandName::InsertContent,
                content: Some(content),
                format,
                ..RichCommand::default()
            },
        )
    }

    /// The document as JSON (ProseMirror's shape).
    pub(crate) fn get_json(&self) -> NodeJson {
        self.doc()
    }

    /// The document as Markdown (the starter schema's names).
    pub(crate) fn get_markdown(&self) -> Result<String, String> {
        serialize(self.session.state().doc(), RichFormat::Markdown)
    }

    /// The document as plain text: one line per textblock.
    pub(crate) fn get_text(&self) -> Result<String, String> {
        serialize(self.session.state().doc(), RichFormat::Text)
    }

    /// The text between positions `from` and `to` (the whole document
    /// when left out), blocks separated by `blockSeparator` (a line break
    /// by default).
    pub(crate) fn text_between(
        &self,
        from: Option<usize>,
        to: Option<usize>,
        block_separator: Option<String>,
    ) -> String {
        let state = self.session.state();
        let size = state.doc().content().size();
        let to = to.unwrap_or(size).min(size);
        let from = from.unwrap_or(0).min(to);
        state.doc().text_between(
            from,
            to,
            Some(block_separator.as_deref().unwrap_or("\n")),
            None,
        )
    }

    /// Gives a `RichEditorPlugin`'s decorations (keyed by its `key`):
    /// highlights, placeholders, widgets. They map through every change
    /// natively until set again.
    pub(crate) fn set_decorations(
        this: Instance<Self>,
        key: String,
        decorations: Vec<RichDecoration>,
    ) -> Result<(), String> {
        let (session, _) = Self::handles(&this);
        let meta = decorations_json(&decorations)?;
        let state = session.state();
        if PluginKey::new(&key).get(&state).is_none() {
            return Err(format!("the editor has no plugin with the key `{key}`"));
        }
        let mut tr = state.tr();
        tr.set_plugin_meta(&PluginKey::new(&key), meta);
        tr.set_meta(super::state::ADD_TO_HISTORY, JsonValue::Bool(false));
        tr.set_origin(TransactionOrigin::Plugin(key));
        let _guard = CallGuard::enter();
        session.dispatch(tr).map_err(|e| e.to_string())
    }

    /// Calls `listener` with the new revision after every change, from any
    /// source, in JS's next turn; returns what `unsubscribe` takes.
    pub(crate) fn subscribe(&mut self, #[args(revision)] listener: Callback<f64>) -> f64 {
        let hooks = HookRef::new();
        hooks.update(|h| h.update = Some(listener));
        let held = hooks.clone();
        let id = self.session.subscribe(Arc::new(move |state: &EditorState| {
            if let Some(listener) = held.get().and_then(|h| h.update) {
                listener.post(state.revision() as f64);
            }
        }));
        // The session's subscriber keeps the functions; this keeps the
        // pair.
        let key = id;
        self.subscriptions.push((key, id));
        drop(hooks);
        key as f64
    }

    /// Stops calling a listener `subscribe` added.
    pub(crate) fn unsubscribe(&mut self, id: f64) {
        let id = id as u64;
        if let Some(i) = self.subscriptions.iter().position(|(k, _)| *k == id) {
            let (_, subscription) = self.subscriptions.remove(i);
            self.session.unsubscribe(subscription);
        }
    }

    /// Asks the views showing the editor to take the keyboard focus.
    pub(crate) fn focus(&self) {
        self.session.focus();
    }

    /// Asks the views showing the editor to give the focus up.
    pub(crate) fn blur(&self) {
        self.session.blur();
    }

    /// The state of the `suggestion` plugin keyed `key` (`suggestion` by
    /// default), `null` without one. Read it on `update` /
    /// `selectionUpdate` / `transaction` to show the app's list.
    pub(crate) fn suggestion(
        &self,
        key: Option<String>,
    ) -> Option<extensions::RichSuggestionState> {
        extensions::suggestion_of(&self.session.state(), key.as_deref())
    }

    /// The document's characters (Tiptap's `characters()`): in `mode`
    /// (`"textSize"`, `"nodeSize"`), else the `characterCount` plugin's
    /// mode, else `textSize`.
    pub(crate) fn characters(&self, mode: Option<String>) -> Result<usize, String> {
        let mode = mode.as_deref().map(extensions::mode_of).transpose()?;
        Ok(super::extensions::character_count::characters(
            &self.session.state(),
            mode,
        ))
    }

    /// The document's words (Unicode words).
    pub(crate) fn words(&self) -> usize {
        super::extensions::character_count::words(&self.session.state())
    }

    /// The `characterCount` plugin's limit now, `null` without one.
    #[getter]
    pub(crate) fn character_limit(&self) -> Option<usize> {
        super::extensions::character_count::character_limit(&self.session.state())
    }
}

fn named(name: &str, args: JsonValue) -> RichCommand {
    RichCommand::named(name, args)
}

fn attrs_value(attrs: Option<AttrsJson>) -> JsonValue {
    attrs.map_or(JsonValue::Null, |a| a.0)
}

// --- The functions -----------------------------------------------------------

/// The rich text editor's functions.
#[module]
pub(crate) struct RichEditorApi;

#[module(flat)]
impl RichEditorApi {
    /// A schema from its spec (ProseMirror's shape); throws with what is
    /// wrong in it.
    pub(crate) fn define_schema(spec: SchemaSpecJson) -> Result<RichSchema, String> {
        Ok(RichSchema {
            schema: SchemaSpec::from_json(&spec.0).map_err(|e| e.to_string())?,
        })
    }

    /// The starter schema: paragraphs, headings, quotes, code blocks, rules,
    /// images, hard breaks, bullet and ordered lists; bold, italic, code,
    /// links, strikethrough and underline.
    pub(crate) fn starter_schema() -> RichSchema {
        RichSchema {
            schema: starter::schema(),
        }
    }

    /// A rich text editor: its state in Rust, shown by `<RichEditor
    /// editor={...} />`.
    pub(crate) fn create_rich_editor(
        options: Option<RichEditorOptions>,
    ) -> Result<RichEditorSession, String> {
        let options = options.unwrap_or_default();
        let diagnostics = extension_api::Diagnostics::default();
        let manager = match &options.extensions {
            Some(entries) => {
                if options.schema.is_some() {
                    return Err(
                        "an editor's schema comes from its `extensions` or its `schema`, not both"
                            .into(),
                    );
                }
                let extensions = extension_api::extensions_of(entries, &diagnostics)?;
                Some(ExtensionManager::with_core(extensions).map_err(|e| e.to_string())?)
            }
            None => None,
        };
        let schema = match (&manager, &options.schema) {
            (Some(manager), _) => manager.schema().clone(),
            (None, Some(schema)) => schema.schema()?,
            (None, None) => starter::schema(),
        };
        let doc = match (&options.doc, &options.content) {
            (Some(doc), _) => Some(doc_of(&schema, &Content::Json(doc.0.clone()), None)?),
            (None, Some(content)) => Some(doc_of(&schema, content, options.format)?),
            (None, None) => None,
        };
        let plugins = match (&manager, &options.plugins) {
            (Some(manager), extra) => {
                let mut plugins = manager.plugins();
                extension_api::check(&diagnostics)?;
                if let Some(entries) = extra {
                    plugins.extend(resolve_plugins(entries, &schema)?);
                }
                plugins
            }
            (None, Some(entries)) => resolve_plugins(entries, &schema)?,
            (None, None) => starter::plugins(&schema),
        };
        let mut config = EditorStateConfig::new(schema.clone()).plugins(plugins);
        if let Some(doc) = doc {
            config = config.doc(doc.clone());
            if let Some(selection) = &options.selection {
                let selection =
                    Selection::from_json(&doc, &selection.0).map_err(|e| e.to_string())?;
                config = config.selection(selection);
            }
        }
        let state = EditorState::create(config).map_err(|e| e.to_string())?;
        let mut editor =
            RichEditorSession::over(EditorSession::new(state, NodeViews::new()), schema);
        if let Some(manager) = &manager {
            editor.commands = manager.commands().clone();
        }
        if options.editable == Some(false) {
            editor.session.set_editable(false);
        }
        Ok(editor)
    }

    /// Adds the mark `name` (with `attrs`) to the selection, or removes it
    /// where present; at a cursor, toggles it for the text typed next.
    /// With `options` (`{ extendEmptyMarkRange }`), Tiptap's `toggleMark`:
    /// removes it when active with `attrs`, from the whole marked text
    /// around a cursor when `extendEmptyMarkRange`.
    pub(crate) fn toggle_mark(
        name: String,
        attrs: Option<AttrsJson>,
        options: Option<JsonValue>,
    ) -> RichCommand {
        RichCommand {
            args: options.filter(JsonValue::is_object),
            ..RichCommand::about(RichCommandName::ToggleMark, name, attrs)
        }
    }

    /// Adds the mark `name` (with `attrs`) to the selection.
    pub(crate) fn set_mark(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        RichCommand::about(RichCommandName::SetMark, name, attrs)
    }

    /// Removes the marks of type `name` from the selection; with
    /// `{ extendEmptyMarkRange: true }`, from the whole marked text around
    /// a cursor.
    pub(crate) fn unset_mark(name: String, options: Option<JsonValue>) -> RichCommand {
        RichCommand {
            args: options.filter(JsonValue::is_object),
            ..RichCommand::about(RichCommandName::UnsetMark, name, None)
        }
    }

    /// Makes the selected textblocks nodes of type `name` (with `attrs`):
    /// `setBlockType("heading", { level: 2 })`.
    pub(crate) fn set_block_type(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        RichCommand::about(RichCommandName::SetBlockType, name, attrs)
    }

    /// Wraps the selected blocks in a node of type `name`
    /// (`wrapIn("blockquote")`).
    pub(crate) fn wrap_in(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        RichCommand::about(RichCommandName::WrapIn, name, attrs)
    }

    /// Wraps the selected blocks in a list of type `name`
    /// (`wrapInList("bulletList")`).
    pub(crate) fn wrap_in_list(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        RichCommand::about(RichCommandName::WrapInList, name, attrs)
    }

    /// Lifts the selected list items (of type `name`) out of their list.
    pub(crate) fn lift_list_item(name: String) -> RichCommand {
        RichCommand::about(RichCommandName::LiftListItem, name, None)
    }

    /// Moves the selected list items (of type `name`) into a list inside
    /// the item before them.
    pub(crate) fn sink_list_item(name: String) -> RichCommand {
        RichCommand::about(RichCommandName::SinkListItem, name, None)
    }

    /// Splits the list item (of type `name`) at the selection.
    pub(crate) fn split_list_item(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        RichCommand::about(RichCommandName::SplitListItem, name, attrs)
    }

    /// Lifts the selected blocks out of their parent.
    pub(crate) fn lift() -> RichCommand {
        RichCommand::plain(RichCommandName::Lift)
    }

    /// Undoes the last change (needs the `history` plugin).
    pub(crate) fn undo() -> RichCommand {
        RichCommand::plain(RichCommandName::Undo)
    }

    /// Redoes the last undone change.
    pub(crate) fn redo() -> RichCommand {
        RichCommand::plain(RichCommandName::Redo)
    }

    /// Selects the whole document.
    pub(crate) fn select_all() -> RichCommand {
        RichCommand::plain(RichCommandName::SelectAll)
    }

    /// Types `text` over the selection (input rules do not run).
    pub(crate) fn insert_text(text: String) -> RichCommand {
        RichCommand {
            command: RichCommandName::InsertText,
            text: Some(text),
            ..RichCommand::default()
        }
    }

    /// Inserts `content` (a string in `format`, plain text by default, or
    /// JSON) over the selection.
    pub(crate) fn insert_content(content: Content, format: Option<RichFormat>) -> RichCommand {
        RichCommand {
            command: RichCommandName::InsertContent,
            content: Some(content),
            format,
            ..RichCommand::default()
        }
    }

    /// Sets attribute `attr` of the node at position `pos` to `value` (an
    /// undoable change: a resized image, a checked task).
    pub(crate) fn set_node_attribute(pos: usize, attr: String, value: JsonValue) -> RichCommand {
        RichCommand {
            command: RichCommandName::SetNodeAttribute,
            pos: Some(pos),
            attr: Some(attr),
            value: Some(value),
            ..RichCommand::default()
        }
    }

    /// Selects text from `anchor` to `head` (a cursor at `anchor` without
    /// one).
    pub(crate) fn set_text_selection(anchor: usize, head: Option<usize>) -> RichCommand {
        RichCommand {
            command: RichCommandName::SetTextSelection,
            pos: Some(anchor),
            head,
            ..RichCommand::default()
        }
    }

    /// Selects the node at position `pos`.
    pub(crate) fn set_node_selection(pos: usize) -> RichCommand {
        RichCommand {
            command: RichCommandName::SetNodeSelection,
            pos: Some(pos),
            ..RichCommand::default()
        }
    }

    /// A command by name, with its arguments: `command("splitBlock")`,
    /// `command("toggleList", { listName: "bulletList", itemName:
    /// "listItem" })`, and the commands extensions register.
    pub(crate) fn command(name: String, args: Option<JsonValue>) -> RichCommand {
        RichCommand::named(name, args.unwrap_or(JsonValue::Null))
    }

    /// Turns the selected textblocks into `name` (with `attrs`), clearing
    /// lists and wrappers around them first when needed (Tiptap's
    /// `setNode`).
    pub(crate) fn set_node(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        named(
            "setNode",
            serde_json::json!({ "name": name, "attrs": attrs_value(attrs) }),
        )
    }

    /// Turns the selected textblocks into `name`, or into `toggleName` when
    /// they are `name` already: `toggleNode("heading", "paragraph", { level:
    /// 2 })`.
    pub(crate) fn toggle_node(
        name: String,
        toggle_name: String,
        attrs: Option<AttrsJson>,
    ) -> RichCommand {
        named(
            "toggleNode",
            serde_json::json!({ "name": name, "toggleName": toggle_name, "attrs": attrs_value(attrs) }),
        )
    }

    /// Lifts the selection out of a node of `name` when one is active,
    /// else wraps it in one (`toggleWrap("blockquote")`).
    pub(crate) fn toggle_wrap(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        named(
            "toggleWrap",
            serde_json::json!({ "name": name, "attrs": attrs_value(attrs) }),
        )
    }

    /// Toggles a list of `listName` with items of `itemName`: lifts it off,
    /// turns another list into one, or wraps the selection; joins it with
    /// lists of its type next to it.
    pub(crate) fn toggle_list(
        list_name: String,
        item_name: String,
        keep_marks: Option<bool>,
        attrs: Option<AttrsJson>,
    ) -> RichCommand {
        named(
            "toggleList",
            serde_json::json!({
                "listName": list_name,
                "itemName": item_name,
                "keepMarks": keep_marks.unwrap_or(false),
                "attrs": attrs_value(attrs),
            }),
        )
    }

    /// Turns the selected blocks into paragraphs, out of what wraps them.
    pub(crate) fn clear_nodes() -> RichCommand {
        named("clearNodes", JsonValue::Null)
    }

    /// Removes every mark from the selection.
    pub(crate) fn unset_all_marks() -> RichCommand {
        named("unsetAllMarks", JsonValue::Null)
    }

    /// Extends the selection over the text marked `name` (with `attrs`)
    /// around it (before editing a link, say).
    pub(crate) fn extend_mark_range(name: String, attrs: Option<AttrsJson>) -> RichCommand {
        named(
            "extendMarkRange",
            serde_json::json!({ "name": name, "attrs": attrs_value(attrs) }),
        )
    }

    /// Merges `attrs` into the nodes or marks of type `name` in the
    /// selection.
    pub(crate) fn update_attributes(name: String, attrs: AttrsJson) -> RichCommand {
        named(
            "updateAttributes",
            serde_json::json!({ "name": name, "attrs": attrs.0 }),
        )
    }

    /// Resets the attributes `attrs` (a name or names) of the nodes or
    /// marks of type `name` in the selection to their defaults.
    pub(crate) fn reset_attributes(name: String, attrs: JsonValue) -> RichCommand {
        named(
            "resetAttributes",
            serde_json::json!({ "name": name, "attrs": attrs }),
        )
    }

    /// Deletes the innermost node of type `name` around the selection.
    pub(crate) fn delete_node(name: String) -> RichCommand {
        named("deleteNode", serde_json::json!({ "name": name }))
    }

    /// Deletes the empty node the selection is in.
    pub(crate) fn delete_current_node() -> RichCommand {
        named("deleteCurrentNode", JsonValue::Null)
    }

    /// Deletes `range` (`{ from, to }`).
    pub(crate) fn delete_range(range: JsonValue) -> RichCommand {
        named("deleteRange", range)
    }

    /// Inserts `content` (ProseMirror JSON, or text) at `position` (a
    /// position or `{ from, to }`); `options.updateSelection` (true) puts
    /// the cursor after it.
    pub(crate) fn insert_content_at(
        position: JsonValue,
        content: JsonValue,
        options: Option<JsonValue>,
    ) -> RichCommand {
        named(
            "insertContentAt",
            serde_json::json!({ "position": position, "content": content, "options": options }),
        )
    }

    /// Moves `range` (`{ from, to }`) to `targetPos`.
    pub(crate) fn cut(range: JsonValue, target_pos: usize) -> RichCommand {
        named(
            "cut",
            serde_json::json!({ "range": range, "targetPos": target_pos }),
        )
    }

    /// Sets the transaction's meta `key` to `value`.
    pub(crate) fn set_meta(key: String, value: JsonValue) -> RichCommand {
        named("setMeta", serde_json::json!({ "key": key, "value": value }))
    }

    /// Scrolls the selection into view.
    pub(crate) fn scroll_into_view() -> RichCommand {
        named("scrollIntoView", JsonValue::Null)
    }

    /// Joins the list item the selection is in with the one before.
    pub(crate) fn join_item_backward() -> RichCommand {
        named("joinItemBackward", JsonValue::Null)
    }

    /// Joins the list item the selection is in with the one after.
    pub(crate) fn join_item_forward() -> RichCommand {
        named("joinItemForward", JsonValue::Null)
    }

    /// Moves the selection to `position` (`"start"`, `"end"`, `"all"`, a
    /// position; where it is when left out) and focuses the editor's view.
    pub(crate) fn focus(position: Option<JsonValue>) -> RichCommand {
        named("focus", serde_json::json!({ "position": position }))
    }

    /// Runs `commands` one after another as one transaction, on the state
    /// each leaves; applies only when every one does (one undo step).
    pub(crate) fn chain(commands: Vec<RichCommand>) -> RichCommand {
        RichCommand {
            command: RichCommandName::Chain,
            commands: Some(commands),
            ..RichCommand::default()
        }
    }

    /// Runs the first of `commands` that applies (ProseMirror's
    /// `chainCommands`: Enter's list item split, else a block split).
    pub(crate) fn first(commands: Vec<RichCommand>) -> RichCommand {
        RichCommand {
            command: RichCommandName::First,
            commands: Some(commands),
            ..RichCommand::default()
        }
    }

    /// Undo history: `depth` changes (100 by default); changes within
    /// `newGroupDelay` milliseconds (500) undo together.
    pub(crate) fn history(options: Option<RichHistoryOptions>) -> RichPluginSpec {
        let options = options.unwrap_or_default();
        RichPluginSpec {
            plugin: RichPluginKind::History,
            depth: options.depth,
            new_group_delay: options.new_group_delay,
            ..RichPluginSpec::default()
        }
    }

    /// Key bindings: commands by key name (`"Mod-b"`: Cmd-B on Apple
    /// platforms, Ctrl-B elsewhere; `"Shift-Enter"`, `"Alt-ArrowUp"`).
    pub(crate) fn keymap(bindings: KeyBindings) -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::Keymap,
            bindings: Some(bindings),
            ..RichPluginSpec::default()
        }
    }

    /// The base key bindings: Enter, Backspace, Delete, select all and the
    /// platform's text editing keys.
    pub(crate) fn base_keymap() -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::BaseKeymap,
            ..RichPluginSpec::default()
        }
    }

    /// The starter schema's key bindings: marks (`Mod-b`, `Mod-i`, ...),
    /// headings, lists, code blocks, hard breaks.
    pub(crate) fn starter_keymap() -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::StarterKeymap,
            ..RichPluginSpec::default()
        }
    }

    /// Input rules: text typed before the cursor that matches a rule turns
    /// into what the rule makes. Backspace right after one undoes it.
    pub(crate) fn input_rules(rules: Vec<RichInputRule>) -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::InputRules,
            rules: Some(rules),
            ..RichPluginSpec::default()
        }
    }

    /// Markdown as you type (block shortcuts, inline marks), Markdown paste
    /// and Markdown copy; each group on unless `options` turn it off.
    pub(crate) fn markdown(options: Option<RichMarkdownOptions>) -> RichPluginSpec {
        let options = options.unwrap_or_default();
        RichPluginSpec {
            plugin: RichPluginKind::Markdown,
            block_rules: options.block_rules,
            inline_rules: options.inline_rules,
            paste: options.paste,
            copy_as_markdown: options.copy_as_markdown,
            ..RichPluginSpec::default()
        }
    }

    /// The starter kit: the starter schema's input rules and key bindings,
    /// the base key bindings and the history.
    pub(crate) fn starter_kit() -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::StarterKit,
            ..RichPluginSpec::default()
        }
    }

    /// A rule replacing the text that matches `pattern` with
    /// `replacement` (`textRule("->$", "→")`).
    pub(crate) fn text_rule(pattern: String, replacement: String) -> RichInputRule {
        RichInputRule {
            rule: RichInputRuleKind::Text,
            pattern: Some(pattern),
            replacement: Some(replacement),
            ..RichInputRule::default()
        }
    }

    /// A rule giving the text between delimiters the mark `name`
    /// (`markRule("\\*\\*([^*]+)\\*\\*$", "bold")`; the last group is the
    /// text).
    pub(crate) fn mark_rule(
        pattern: String,
        name: String,
        attrs: Option<AttrsJson>,
    ) -> RichInputRule {
        RichInputRule {
            rule: RichInputRuleKind::Mark,
            pattern: Some(pattern),
            name: Some(name),
            attrs,
            ..RichInputRule::default()
        }
    }

    /// A rule wrapping the textblock in a node of type `name` when its
    /// start matches (`wrappingRule("^\\s*>\\s$", "blockquote")`).
    pub(crate) fn wrapping_rule(
        pattern: String,
        name: String,
        attrs: Option<AttrsJson>,
    ) -> RichInputRule {
        RichInputRule {
            rule: RichInputRuleKind::Wrapping,
            pattern: Some(pattern),
            name: Some(name),
            attrs,
            ..RichInputRule::default()
        }
    }

    /// A rule making the textblock a node of type `name` when its start
    /// matches (`textblockRule("^```$", "codeBlock")`).
    pub(crate) fn textblock_rule(
        pattern: String,
        name: String,
        attrs: Option<AttrsJson>,
    ) -> RichInputRule {
        RichInputRule {
            rule: RichInputRuleKind::Textblock,
            pattern: Some(pattern),
            name: Some(name),
            attrs,
            ..RichInputRule::default()
        }
    }

    /// Typographic rules: smart quotes, `...` to an ellipsis, `--` to an em
    /// dash.
    pub(crate) fn typography_rules() -> Vec<RichInputRule> {
        [
            RichInputRuleKind::SmartQuotes,
            RichInputRuleKind::Ellipsis,
            RichInputRuleKind::EmDash,
        ]
        .into_iter()
        .map(|rule| RichInputRule {
            rule,
            ..RichInputRule::default()
        })
        .collect()
    }

    /// The starter schema's Markdown-like rules: `# ` headings, `> `
    /// quotes, `- ` and `1. ` lists, three backticks for code, `---`
    /// rules, `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`.
    pub(crate) fn markdown_rules() -> Vec<RichInputRule> {
        vec![RichInputRule {
            rule: RichInputRuleKind::Starter,
            ..RichInputRule::default()
        }]
    }

    /// Tiptap's Link behavior for the `link` mark: URLs linked as they are
    /// typed and pasted, a URL pasted over a selection links it, a press on
    /// a link with Mod (or while the editor is not editable) opens it.
    pub(crate) fn link(options: Option<extensions::RichLinkOptions>) -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::Link,
            link: Some(options.unwrap_or_default()),
            ..RichPluginSpec::default()
        }
    }

    /// Tiptap's CharacterCount: counts characters and words (the editor's
    /// `characters()` / `words()`) and keeps the document within `limit`,
    /// trimming pasted content to fit.
    pub(crate) fn character_count(
        options: Option<extensions::RichCharacterCountOptions>,
    ) -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::CharacterCount,
            character_count: Some(options.unwrap_or_default()),
            ..RichPluginSpec::default()
        }
    }

    /// Tiptap's Suggestion: follows a trigger (`@`) typed before the cursor;
    /// the editor's `suggestion(key)` gives its range and query for the
    /// app's list, Escape dismisses it.
    pub(crate) fn suggestion(options: Option<extensions::RichSuggestionOptions>) -> RichPluginSpec {
        RichPluginSpec {
            plugin: RichPluginKind::Suggestion,
            suggestion: Some(options.unwrap_or_default()),
            ..RichPluginSpec::default()
        }
    }

    /// `schema` with Tiptap's mention node: an inline atom with `id`,
    /// `label` and `mentionSuggestionChar`, its text `@label`.
    pub(crate) fn with_mention(
        schema: SchemaArg,
        options: Option<extensions::RichMentionOptions>,
    ) -> Result<RichSchema, String> {
        Ok(RichSchema {
            schema: extensions::with_mention(&schema.schema()?, &options.unwrap_or_default())?,
        })
    }

    /// Links the selection (Tiptap's `setLink`); refused for a URI whose
    /// protocol is not allowed (`javascript:`).
    pub(crate) fn set_link(attrs: AttrsJson) -> RichCommand {
        named("setLink", attrs.0)
    }

    /// Links the selection, or unlinks the link around it.
    pub(crate) fn toggle_link(attrs: Option<AttrsJson>) -> RichCommand {
        named("toggleLink", attrs_value(attrs))
    }

    /// Removes the link around the selection (the whole link at a cursor).
    pub(crate) fn unset_link() -> RichCommand {
        named("unsetLink", JsonValue::Null)
    }

    /// The `characterCount` plugin's limit from now on (`null` for none).
    pub(crate) fn set_character_limit(limit: Option<usize>) -> RichCommand {
        named("setCharacterLimit", serde_json::json!({ "limit": limit }))
    }

    /// Replaces the active suggestion (trigger and query) of the plugin
    /// keyed `key` with `content` (text or JSON), the cursor after it.
    pub(crate) fn replace_suggestion(content: Content, key: Option<String>) -> RichCommand {
        let content = match content {
            Content::Text(text) => JsonValue::String(text),
            Content::Json(json) => json,
        };
        named(
            "replaceSuggestion",
            serde_json::json!({ "content": content, "key": key }),
        )
    }

    /// Dismisses the active suggestion of the plugin keyed `key` (what
    /// Escape does).
    pub(crate) fn exit_suggestion(key: Option<String>) -> RichCommand {
        named("exitSuggestion", serde_json::json!({ "key": key }))
    }

    /// Replaces `range` (a suggestion's) with a mention of `id` labeled
    /// `label` and a space (Tiptap's Mention command).
    pub(crate) fn insert_mention(
        range: extensions::RichRange,
        id: String,
        label: Option<String>,
        name: Option<String>,
    ) -> RichCommand {
        named(
            "insertMention",
            serde_json::json!({
                "range": { "from": range.from, "to": range.to },
                "id": id,
                "label": label,
                "name": name,
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        commands::{RichCommand, RichCommandName, doc_of, resolve},
        json::Content,
        plugins::{KeyBindings, RichPluginKind, RichPluginSpec, plugins_of},
        *,
    };

    fn editor(markdown: &str) -> EditorSession {
        let schema = starter::schema();
        let doc = doc_of(
            &schema,
            &Content::Text(markdown.into()),
            Some(RichFormat::Markdown),
        )
        .unwrap();
        let state = EditorState::create(
            EditorStateConfig::new(schema.clone())
                .doc(doc)
                .plugins(starter::plugins(&schema)),
        )
        .unwrap();
        EditorSession::new(state, NodeViews::new())
    }

    fn run(session: &EditorSession, command: RichCommand) -> bool {
        let schema = session.state().schema().clone();
        session.run(&resolve(&command, &schema).unwrap())
    }

    #[test]
    fn commands_resolve_and_run() {
        let session = editor("Hello world");
        let select = RichCommand {
            command: RichCommandName::SetTextSelection,
            pos: Some(1),
            head: Some(6),
            ..RichCommand::default()
        };
        assert!(run(&session, select));
        let bold = RichCommand::about(RichCommandName::ToggleMark, "bold".into(), None);
        assert!(run(&session, bold));
        assert!(session.is_active(Some("bold"), None));
        assert!(run(&session, RichCommand::plain(RichCommandName::Undo)));
        assert!(!session.is_active(Some("bold"), None));
        // Named commands, by Tiptap's names.
        assert!(run(
            &session,
            RichCommand::named(
                "setNode",
                serde_json::json!({"name": "heading", "attrs": {"level": 2}})
            )
        ));
        assert!(session.is_active(Some("heading"), None));
        assert!(run(
            &session,
            RichCommand::named("splitBlock", JsonValue::Null)
        ));
        assert!(
            resolve(
                &RichCommand::named("nope", JsonValue::Null),
                &session.state().schema().clone()
            )
            .is_err()
        );
    }

    #[test]
    fn unknown_types_are_errors() {
        let schema = starter::schema();
        let command = RichCommand::about(RichCommandName::ToggleMark, "nope".into(), None);
        assert!(resolve(&command, &schema).is_err());
    }

    #[test]
    fn a_chain_is_one_transaction_and_all_or_nothing() {
        let session = editor("Hello");
        let revision = session.state().revision();
        let chain = RichCommand {
            command: RichCommandName::Chain,
            commands: Some(vec![
                RichCommand::plain(RichCommandName::SelectAll),
                RichCommand {
                    command: RichCommandName::InsertText,
                    text: Some("Replaced".into()),
                    ..RichCommand::default()
                },
            ]),
            ..RichCommand::default()
        };
        assert!(run(&session, chain));
        assert_eq!(session.state().revision(), revision + 1);
        assert_eq!(session.state().doc().text_content(), "Replaced");
        let failing = RichCommand {
            command: RichCommandName::Chain,
            commands: Some(vec![
                RichCommand::plain(RichCommandName::SelectAll),
                RichCommand::about(RichCommandName::SinkListItem, "listItem".into(), None),
            ]),
            ..RichCommand::default()
        };
        assert!(!run(&session, failing));
        assert_eq!(session.state().doc().text_content(), "Replaced");
    }

    #[test]
    fn transactions_round_trip_as_json() {
        let session = editor("ab");
        let state = session.state();
        let mut tr = state.tr();
        tr.insert_text("x", Some(2), Some(2));
        tr.set_meta("custom", json!(1));
        let json = transaction_json(&tr, None);
        assert_eq!(json.0["steps"].as_array().unwrap().len(), 1);
        assert_eq!(json.0["meta"]["custom"], json!(1));
        let back = transaction_from_json(&state, &json.0).unwrap();
        assert_eq!(state.apply(back).unwrap().doc().text_content(), "axb");
    }

    #[test]
    fn plugin_specs_resolve() {
        let schema = starter::schema();
        let keymap = RichPluginSpec {
            plugin: RichPluginKind::Keymap,
            bindings: Some(KeyBindings(vec![(
                "Mod-b".into(),
                RichCommand::about(RichCommandName::ToggleMark, "bold".into(), None),
            )])),
            ..RichPluginSpec::default()
        };
        assert_eq!(plugins_of(&keymap, &schema).unwrap().len(), 1);
        let bad = RichPluginSpec {
            plugin: RichPluginKind::Keymap,
            bindings: Some(KeyBindings(vec![(
                "Mod-b".into(),
                RichCommand::about(RichCommandName::ToggleMark, "missing".into(), None),
            )])),
            ..RichPluginSpec::default()
        };
        assert!(plugins_of(&bad, &schema).is_err());
    }
}
